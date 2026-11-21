import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify, claudeProjectDir, commandLine, codexConversations, conversationInArgv, findConversations, rewriteConversation, shownCommand, withoutStateHooks } from './moveAgents.mjs';

const UUID = (n) => `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-move-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A Claude conversation for a folder, last written at `mtimeMs`.
function claudeConversation(claudeDir, cwd, id, mtimeMs, records = [{ type: 'user', cwd, sessionId: id }]) {
  const dir = path.join(claudeDir, 'projects', claudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('Claude\'s folder name is the folder with every character but letters and digits as a dash', () => {
  assert.equal(claudeProjectDir('/Users/mia/code/my_app.v2'), '-Users-mia-code-my-app-v2');
  assert.equal(claudeProjectDir('/home/node/work/app'), '-home-node-work-app');
});

test('a terminal is an agent by its program or its status record, a shell by its foreground, else a program', () => {
  const t = (fg, extra = {}) => ({ address: 't1', argv: ['/bin/zsh', '-l'], cwd: '/w', foreground: fg, ...extra });
  assert.deepEqual(classify(t({ name: 'claude', argv: ['claude', '--resume', UUID(1)], cwd: '/w/app', pid: 4 }, { status: { state: 'idle', app: 'claude-code' } })),
    { kind: 'agent', agent: 'claude', argv: ['claude', '--resume', UUID(1)], cwd: '/w/app', state: 'idle' });
  assert.equal(classify(t({ name: 'node', argv: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], cwd: '/w', pid: 4 })).agent, 'claude');
  assert.equal(classify(t({ name: 'codex', argv: ['codex'], cwd: '/w', pid: 4 })).agent, 'codex');
  assert.equal(classify(t({ name: 'zsh', argv: ['-zsh'], cwd: '/w', pid: 4 })).kind, 'shell');
  const dev = classify(t({ name: 'npm', argv: ['npm', 'run', 'dev'], cwd: '/w/app', pid: 4 }));
  assert.deepEqual([dev.kind, dev.argv, dev.cwd], ['process', ['npm', 'run', 'dev'], '/w/app']);
  assert.equal(classify({ address: 't2', argv: ['sleep', '5'], cwd: '/w', foreground: null }).kind, 'process', 'with no foreground, the terminal\'s own program');
  // npm sets its own title, which the OS then gives as its whole command line in the first word (measured on macOS).
  assert.deepEqual(classify(t({ name: 'npm', argv: ['npm run dev', '', '', ''], cwd: '/w', pid: 4 })).argv, ['npm', 'run', 'dev']);
  assert.deepEqual(commandLine(['npm run dev']), ['npm', 'run', 'dev']);
  assert.deepEqual(commandLine(['node', 'build.js', '--prefix', '']), ['node', 'build.js', '--prefix', ''], 'an empty argument of its own is kept');
  assert.deepEqual(commandLine(['/bin/sh']), ['/bin/sh']);
});

test('a command line names its conversation by --resume, -r, --session-id, or codex resume', () => {
  assert.equal(conversationInArgv(['claude', '--resume', UUID(1)]), UUID(1));
  assert.equal(conversationInArgv(['claude', `--session-id=${UUID(2)}`]), UUID(2));
  assert.equal(conversationInArgv(['claude', '-r', UUID(3), 'go']), UUID(3));
  assert.equal(conversationInArgv(['codex', 'resume', UUID(4)]), UUID(4));
  assert.equal(conversationInArgv(['claude', '--resume']), null, 'the picker, with no id');
  assert.equal(conversationInArgv(['claude', 'fix', 'the', 'bug']), null);
});

test('each agent gets its own conversation: by label, by command line, by its last turn, and the newest only when it is alone', (t) => {
  const claudeDir = path.join(home(t), '.claude');
  const env = { CLAUDE_CONFIG_DIR: claudeDir };
  const now = Date.parse('2026-11-20T10:00:00Z');
  claudeConversation(claudeDir, '/w/app', UUID(1), now - 60_000);
  claudeConversation(claudeDir, '/w/app', UUID(2), now - 600_000);
  claudeConversation(claudeDir, '/w/app', UUID(3), now - 3_600_000);
  claudeConversation(claudeDir, '/w/other', UUID(4), now - 7_200_000);
  const agent = (address, extra) => ({ address, agent: 'claude', cwd: '/w/app', labels: {}, argv: ['claude'], statusMs: null, ...extra });
  const found = findConversations([
    agent('t1', { labels: { 'claude.session': UUID(3) } }),
    agent('t2', { argv: ['claude', '--resume', UUID(1)] }),
    agent('t3', { statusMs: now - 600_000 + 4000 }),
    agent('t4', { cwd: '/w/other' }),
  ], { env, now });
  assert.deepEqual(Object.fromEntries([...found].map(([a, c]) => [a, [c.id, c.from]])), {
    t1: [UUID(3), 'label'], t2: [UUID(1), 'command line'], t3: [UUID(2), 'last turn'], t4: [UUID(4), 'newest'],
  });

  const guessing = findConversations([agent('t1'), agent('t2')], { env, now });
  assert.match(guessing.get('t1').error, /which of \/w\/app's 3 claude conversations is its own cannot be told: label it, hc label t1 claude.session=<id>/);
  const same = findConversations([agent('t1', { statusMs: now - 60_000 }), agent('t2', { statusMs: now - 59_000 })], { env, now });
  assert.match(same.get('t1').error, /t1 and t2 would both get conversation/);
  const lone = findConversations([agent('t1')], { env, now, peers: [agent('t1'), agent('t2')] });
  assert.match(lone.get('t1').error, /cannot be told/, 'moved alone, but another agent there stays: no guess');
  const missing = findConversations([agent('t9', { cwd: '/w/none' })], { env, now });
  assert.equal(missing.get('t9').error, `no claude conversation for /w/none in ${claudeDir}`);
  const gone = findConversations([agent('t9', { labels: { 'claude.session': UUID(8) } })], { env, now });
  assert.match(gone.get('t9').error, new RegExp(`its conversation ${UUID(8)} \\(from its label\\) is not in`));
});

test('a Codex conversation is found by the folder its first record names', (t) => {
  const codexDir = path.join(home(t), '.codex');
  const now = Date.parse('2026-11-20T10:00:00Z');
  const day = path.join(codexDir, 'sessions', '2026', '11', '20');
  fs.mkdirSync(day, { recursive: true });
  const write = (name, cwd, id) => fs.writeFileSync(path.join(day, name), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n{"type":"turn_context","payload":{"cwd":"${cwd}"}}\n`);
  write(`rollout-2026-11-20T09-00-00-${UUID(5)}.jsonl`, '/w/app', UUID(5));
  write(`rollout-2026-11-20T09-30-00-${UUID(6)}.jsonl`, '/w/other', UUID(6));
  const found = codexConversations(codexDir, '/w/app', { now });
  assert.deepEqual(found.map((c) => [c.id, c.relative]), [[UUID(5), `2026/11/20/rollout-2026-11-20T09-00-00-${UUID(5)}.jsonl`]]);
});

test('a conversation\'s folders are said as the session\'s, under the checkout only, and everything else is kept byte for byte', () => {
  const text = [
    JSON.stringify({ type: 'user', cwd: '/Users/mia/app/services/api', message: { content: 'look at /Users/mia/app/x' } }),
    JSON.stringify({ type: 'assistant', cwd: '/private/tmp/app' }),
    JSON.stringify({ type: 'user', cwd: '/Users/mia/apple' }),
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/mia/app', id: UUID(1) } }),
    'not json {',
    '',
  ].join('\n');
  const out = rewriteConversation(text, { from: ['/Users/mia/app', '/private/tmp/app'], to: '/home/node/work/app' }).split('\n');
  assert.equal(JSON.parse(out[0]).cwd, '/home/node/work/app/services/api');
  assert.equal(JSON.parse(out[0]).message.content, 'look at /Users/mia/app/x', 'what was said is history, and stays');
  assert.equal(JSON.parse(out[1]).cwd, '/home/node/work/app');
  assert.equal(out[2], JSON.stringify({ type: 'user', cwd: '/Users/mia/apple' }), 'a folder beside the checkout is not in it');
  assert.equal(JSON.parse(out[3]).payload.cwd, '/home/node/work/app');
  assert.equal(out[4], 'not json {');
  assert.equal(out[5], '');
});

test('a labelled Codex conversation is found however long ago it began', (t) => {
  const codexDir = path.join(home(t), '.codex');
  const old = path.join(codexDir, 'sessions', '2025', '01', '02');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, `rollout-2025-01-02T09-00-00-${UUID(7)}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: UUID(7), cwd: '/w/app' } })}\n`);
  const found = findConversations([{ address: 't1', agent: 'codex', cwd: '/w/app', labels: { 'codex.session': UUID(7) }, argv: ['codex'], statusMs: null }], { env: { CODEX_HOME: codexDir }, now: Date.parse('2026-11-20T10:00:00Z') });
  assert.deepEqual([found.get('t1').id, found.get('t1').relative], [UUID(7), `2025/01/02/rollout-2025-01-02T09-00-00-${UUID(7)}.jsonl`]);
});

test('a second claude in a session keeps the session\'s permissions and ready gate, and only the state hooks go', () => {
  const settings = JSON.parse(fs.readFileSync(new URL('../session/claudeHooks.json', import.meta.url), 'utf8'));
  const kept = withoutStateHooks(settings);
  assert.deepEqual(kept.permissions, settings.permissions);
  assert.ok(kept.permissions.ask.includes('Bash(gh pr merge:*)'));
  assert.deepEqual(kept.hooks, { PreToolUse: [settings.hooks.PreToolUse.find((m) => /readyGate/.test(m.hooks[0].command))] });
  assert.ok(!JSON.stringify(kept).includes('hookState'));
});

test('a program\'s command line is shown with what may be a credential hidden', () => {
  assert.equal(shownCommand(['npm', 'run', 'dev']), 'npm run dev');
  assert.equal(shownCommand(['node', 'server.js', '--api-key', 'abc123', '--token=xyz', 'DB_PASSWORD=hunter2', '--port', '3000']),
    'node server.js --api-key … --token=… DB_PASSWORD=… --port 3000');
  assert.equal(shownCommand(['curl', 'ghp_x'], (w) => w.startsWith('ghp_')), 'curl …');
  assert.equal(shownCommand(['echo', 'two words']), "echo 'two words'");
  assert.equal(shownCommand(['curl', '-H', 'Authorization: Bearer abc.def', '-u', 'me:pw', 'https://x']), 'curl -H Authorization: … -u … https://x');
  assert.equal(shownCommand(['python', '-u', 'server.py']), 'python -u server.py', 'python\'s -u is no user');
  assert.equal(shownCommand(['curl', '-ume:pw', '--user=me:pw', 'https://x']), 'curl -u… --user… https://x');
  assert.equal(shownCommand(['curl', 'https://me:hunter2@api.example.com/x', '-U', 'p:q']), 'curl https://me:…@api.example.com/x -U …');
});

test('a Codex conversation is told the model provider the session\'s codex runs on', () => {
  const text = `${JSON.stringify({ type: 'session_meta', payload: { id: UUID(1), cwd: '/w/app', model_provider: 'openai' } })}\n${JSON.stringify({ type: 'turn_context', payload: { cwd: '/w/app' } })}\n`;
  const [meta, turn] = rewriteConversation(text, { from: ['/w/app'], to: '/work/app', codexProvider: 'woodshed' }).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(meta.payload, { id: UUID(1), cwd: '/work/app', model_provider: 'woodshed' });
  assert.deepEqual(turn.payload, { cwd: '/work/app' });
});
