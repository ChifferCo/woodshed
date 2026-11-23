import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { billingOf, tokenCounter, usageSources } from './tokenUsage.mjs';

const SINCE = Date.parse('2026-11-20T10:00:00Z');

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'token-usage-'));
}

const answer = (id, at, usage, model = 'claude-opus-5-5') => JSON.stringify({
  type: 'assistant', timestamp: at, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'never read' }], usage },
});

test('claude: each answer counts once, by its day and model, and only since the session began', async () => {
  const dir = await scratch();
  const project = path.join(dir, '-work-repo');
  await fs.mkdir(path.join(project, 'abc', 'subagents'), { recursive: true });
  const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 } };
  await fs.writeFile(path.join(project, 'abc.jsonl'), [
    // An earlier session's answer, which the restored home brought.
    answer('msg_old', '2026-11-19T09:00:00Z', { input_tokens: 999, output_tokens: 999 }),
    // One answer over two lines (a thinking block, then text), the first with the output so far.
    answer('msg_1', '2026-11-20T11:00:00Z', { ...usage, output_tokens: 3 }),
    answer('msg_1', '2026-11-20T11:00:01Z', usage),
    JSON.stringify({ type: 'user', timestamp: '2026-11-20T11:01:00Z', message: { role: 'user', content: 'hi' } }),
    answer('msg_2', '2026-11-21T00:30:00Z', { input_tokens: 1, output_tokens: 2, speed: 'fast' }),
    // Claude Code's own placeholder for an answer it never got.
    answer('msg_3', '2026-11-21T00:31:00Z', { input_tokens: 0, output_tokens: 0 }, '<synthetic>'),
    '',
  ].join('\n'));
  await fs.writeFile(path.join(project, 'abc', 'subagents', 'agent-1.jsonl'),
    `${answer('msg_sub', '2026-11-21T01:00:00Z', { input_tokens: 5, output_tokens: 5 }, 'claude-haiku-5-5')}\n`);
  const counter = tokenCounter({ since: SINCE, agent: 'claude', claudeDir: dir });
  const first = await counter.read();
  assert.equal(first.since, '2026-11-20T10:00:00.000Z');
  assert.deepEqual(first.days, {
    '2026-11-20': { 'claude-opus-5-5': { input: 10, cacheWrite5m: 200, cacheWrite1h: 300, cacheRead: 1000, output: 7 } },
    '2026-11-21': {
      'claude-opus-5-5:fast': { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 2 },
      'claude-haiku-5-5': { input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 5 },
    },
  });

  // Read again from where it stopped: a line written since, and nothing counted twice.
  await fs.appendFile(path.join(project, 'abc.jsonl'), `${answer('msg_4', '2026-11-21T02:00:00Z', { input_tokens: 4, output_tokens: 6 })}\n`);
  const second = await counter.read();
  assert.deepEqual(second.days['2026-11-21']['claude-opus-5-5'], { input: 4, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 6 });
  assert.equal(second.days['2026-11-20']['claude-opus-5-5'].output, 7);
});

test('claude: a line cut off mid-write is read once it is whole', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'p', 'a.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const line = answer('msg_1', '2026-11-20T11:00:00Z', { input_tokens: 3, output_tokens: 4 });
  await fs.writeFile(file, line.slice(0, 40));
  const counter = tokenCounter({ since: SINCE, agent: 'claude', claudeDir: dir });
  assert.deepEqual((await counter.read()).days, {});
  await fs.appendFile(file, `${line.slice(40)}\n`);
  assert.equal((await counter.read()).days['2026-11-20']['claude-opus-5-5'].output, 4);
});

const codexLine = (type, payload, at) => JSON.stringify({ timestamp: at, type, payload });
const total = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 1, total_tokens: input + output });

test('codex: the running total is split by model, with cached input as cache reads, a repeated total counted once', async () => {
  const dir = await scratch();
  const day = path.join(dir, '2026', '11', '20');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, 'rollout-2026-11-20T09-00-00-x.jsonl'), [
    codexLine('session_meta', { id: 'x' }, '2026-11-20T09:00:00Z'),
    codexLine('turn_context', { model: 'gpt-6.1-sol' }, '2026-11-20T09:00:00Z'),
    // Before the session began: moves the total, counts nothing.
    codexLine('event_msg', { type: 'token_count', info: { total_token_usage: total(100, 0, 10), last_token_usage: total(100, 0, 10) } }, '2026-11-20T09:30:00Z'),
    codexLine('event_msg', { type: 'token_count', info: { total_token_usage: total(300, 150, 30), last_token_usage: total(200, 150, 20) } }, '2026-11-20T10:30:00Z'),
    codexLine('event_msg', { type: 'token_count', info: { total_token_usage: total(300, 150, 30), last_token_usage: total(200, 150, 20) } }, '2026-11-20T10:30:01Z'),
    // A rate limit reading alone.
    codexLine('event_msg', { type: 'token_count', info: null, rate_limits: {} }, '2026-11-20T10:31:00Z'),
    codexLine('turn_context', { model: 'gpt-6-luna' }, '2026-11-20T11:00:00Z'),
    codexLine('event_msg', { type: 'token_count', info: { total_token_usage: total(400, 150, 35), last_token_usage: total(100, 0, 5) } }, '2026-11-20T11:00:05Z'),
    '',
  ].join('\n'));
  const { days } = await tokenCounter({ since: SINCE, agent: 'codex', codexDir: dir }).read();
  assert.deepEqual(days, {
    '2026-11-20': {
      'gpt-6.1-sol': { input: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 150, output: 20 },
      'gpt-6-luna': { input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 5 },
    },
  });
});

test('what pays: a Claude plan or own token is a plan, the team key a key; codex by its sign-in', () => {
  assert.equal(billingOf({ WOODSHED_CLAUDE_AUTH: 'own' }, 'claude', null), 'plan');
  assert.equal(billingOf({ WOODSHED_CLAUDE_AUTH: 'plan' }, 'claude', null), 'plan');
  assert.equal(billingOf({ WOODSHED_CLAUDE_AUTH: 'key' }, 'claude', null), 'key');
  assert.equal(billingOf({}, 'claude', null), 'key');
  assert.equal(billingOf({ WOODSHED_CODEX_AUTH: 'key' }, 'codex', null), 'key');
  assert.equal(billingOf({}, 'codex', { OPENAI_API_KEY: 'sk-x' }), 'key');
  assert.equal(billingOf({}, 'codex', { OPENAI_API_KEY: null, tokens: { access_token: 'x' } }), 'plan');
  assert.equal(billingOf({}, 'codex', null), 'key');
});

test('no transcripts yet is no usage, not an error', async () => {
  const { days } = await tokenCounter({ since: SINCE, agent: 'claude', claudeDir: path.join(os.tmpdir(), 'no-such-dir-xyz') }).read();
  assert.deepEqual(days, {});
});

test('what is counted: the agent, and in a review its codex from the home that review gave it', () => {
  const home = '/home/node';
  assert.deepEqual(usageSources({}, home), [{ agent: 'claude', claudeDir: '/home/node/.claude/projects' }]);
  assert.deepEqual(usageSources({ AGENT: 'codex', CODEX_HOME: '/x/codex' }, home),
    [{ agent: 'codex', codexDir: '/x/codex/sessions', codexAuthFile: '/x/codex/auth.json' }]);
  assert.deepEqual(usageSources({ SESSION_MODE: 'review', REVIEW_AGENTS: 'claude' }, home).map((s) => s.agent), ['claude'], 'claude alone reviews');
  const chatgpt = usageSources({ SESSION_MODE: 'review', REVIEW_AGENTS: 'codex', REVIEW_CODEX_AUTH: 'chatgpt' }, home);
  assert.deepEqual(chatgpt[1], { agent: 'codex', codexDir: '/home/node/.codex-review/sessions', codexAuthFile: '/home/node/.codex-review/auth.json', billing: 'plan' },
    'the author\'s ChatGPT login, in review.sh\'s own home');
  const key = usageSources({ SESSION_MODE: 'review', REVIEW_AGENTS: 'claude codex', REVIEW_CODEX_AUTH: 'key' }, home);
  assert.deepEqual(key.map((s) => `${s.agent} ${s.codexDir ?? s.claudeDir} ${s.billing ?? ''}`),
    ['claude /home/node/.claude/projects ', 'codex /home/node/.codex/sessions key']);
  assert.equal(usageSources({ SESSION_MODE: 'review', REVIEW_AGENTS: 'codex', REVIEW_CODEX_AUTH: 'chatgpt', REVIEW_CODEX_HOME: '/r' }, home)[1].codexDir, '/r/sessions');
});

test('a character cut between two reads of a file is read whole', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'p', 'a.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  // The model name carries a three-byte character; the first write stops inside it.
  const bytes = Buffer.from(`${answer('msg_1', '2026-11-20T11:00:00Z', { input_tokens: 3, output_tokens: 4 }, 'claude-opus-5-5\u2603')}\n`);
  const cut = bytes.indexOf(Buffer.from('\u2603')) + 1;
  await fs.writeFile(file, bytes.subarray(0, cut));
  const counter = tokenCounter({ since: SINCE, agent: 'claude', claudeDir: dir });
  await counter.read();
  await fs.appendFile(file, bytes.subarray(cut));
  assert.deepEqual(Object.keys((await counter.read()).days['2026-11-20']), ['claude-opus-5-5\u2603']);
});
