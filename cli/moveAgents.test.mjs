import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify, claudeProjectDir, commandLine, codexConversations, conversationInArgv, findConversations, rewriteConversation } from './moveAgents.mjs';

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
  assert.deepEqual(commandLine(['node', 'server.js', '']), ['node', 'server.js']);
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
