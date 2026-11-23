// The agents started beside a session's own (agents.mjs): what a start takes, the command line it types, how a codex's
// own rollout is found, and what a start asks of tmux, with a stand-in tmux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_EXTRA_AGENTS, commandLine, createAgents, openRollout, startOptions } from './agents.mjs';
import { readSessionTranscript } from './sessionTranscript.mjs';

test('a start takes claude or codex, names a model or effort only as a name, and a mode the agent has', () => {
  assert.deepEqual(startOptions({}), { agent: 'claude', model: '', effort: '', permissionMode: 'auto', prompt: '' });
  assert.deepEqual(startOptions({ agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'plan', prompt: '  look  ' }),
    { agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'plan', prompt: 'look' });
  for (const body of [
    { agent: 'bash' },
    { model: 'opus; rm -rf /' },
    { model: '$(id)' },
    { effort: 'high"' },
    { agent: 'codex', permissionMode: 'acceptEdits' },
    { prompt: 'x'.repeat(8001) },
    { prompt: 42 },
  ]) assert.throws(() => startOptions(body), (err) => err.status === 400, JSON.stringify(body).slice(0, 60));
});

test('the command line is the agent, the session\'s flags, its own choices, and the first message read from its file', () => {
  const where = { bin: '/opt/woodshed/session/bin', uploadsDir: '/tmp/uploads' };
  assert.equal(
    commandLine({ agent: 'claude', model: 'opus', effort: 'high', permissionMode: 'plan' }, { ...where, claudeFlags: ' --settings /h.json\n', conversation: 'c0ffee', promptFile: '/tmp/p.md' }),
    '/opt/woodshed/session/bin/claude --settings /h.json --session-id c0ffee --permission-mode plan --model opus --effort high "$(cat /tmp/p.md)"');
  assert.equal(commandLine({ agent: 'claude', model: '', effort: '', permissionMode: 'default' }, where), '/opt/woodshed/session/bin/claude');
  assert.equal(
    commandLine({ agent: 'codex', model: 'gpt-5.5', effort: 'low', permissionMode: 'auto' }, where),
    '/opt/woodshed/session/bin/codex --add-dir /tmp/uploads --sandbox danger-full-access --ask-for-approval on-request --model gpt-5.5 -c model_reasoning_effort=\\"low\\"');
  // codex refuses an added folder while its sandbox is read-only.
  assert.equal(commandLine({ agent: 'codex', model: '', effort: '', permissionMode: 'plan' }, where), '/opt/woodshed/session/bin/codex --sandbox read-only --ask-for-approval on-request');
});

test('a codex\'s own rollout is the one its process holds open', async (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('no /proc here');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-agents-'));
  const day = path.join(home, 'sessions', '2026', '11', '23');
  fs.mkdirSync(day, { recursive: true });
  const mine = path.join(day, 'rollout-2026-11-23T10-00-00-aaaa.jsonl');
  fs.writeFileSync(path.join(day, 'rollout-2026-11-23T11-00-00-bbbb.jsonl'), '{}\n');
  const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(mine)}, 'a'); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  try {
    let found = null;
    for (let i = 0; i < 50 && !found; i++) {
      found = await openRollout(0, home, { descendants: async () => [holder.pid] });
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(found, mine, 'the held one, though another is newer');
    assert.equal(await openRollout(0, path.join(home, 'elsewhere'), { descendants: async () => [holder.pid] }), null, 'only under its own sessions folder');
  } finally {
    holder.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the session\'s own agent skips what the others claimed, and an agent reads its own record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-agents-'));
  const line = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() })}\n`;
  try {
    fs.writeFileSync(path.join(dir, 'own.jsonl'), line('the session\'s own'));
    fs.writeFileSync(path.join(dir, 'other.jsonl'), line('another agent\'s'));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'own.jsonl'), old, old);
    const read = (opts) => readSessionTranscript({ agent: 'claude', claudeDir: dir, codexHome: dir, ...opts });
    assert.equal((await read({})).entries[0].text, 'another agent\'s', 'the newest, with nothing claimed');
    assert.equal((await read({ skip: new Set(['other.jsonl']) })).entries[0].text, 'the session\'s own');
    assert.equal((await read({ file: path.join(dir, 'other.jsonl') })).entries[0].text, 'another agent\'s');
    assert.deepEqual((await read({ file: null })).entries, [], 'an agent with no record yet shows none, never another\'s');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A tmux that keeps each session's typed line, and draws claude's empty prompt for each.
function standInTmux() {
  const calls = [];
  const typed = new Map();
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const at = args.indexOf('-t');
    const target = at === -1 ? null : args[at + 1];
    if (args[0] === 'send-keys' && args.includes('-l')) typed.set(target, (typed.get(target) ?? '') + args.at(-1));
    if (args[0] === 'capture-pane') return { stdout: '' };
    if (args[0] === 'display') return { stdout: '4242\n' };
    return { stdout: '' };
  };
  return { run, calls, typed };
}

function agentsWith(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-agents-'));
  fs.writeFileSync(path.join(dir, 'flags'), ' --settings /opt/woodshed/session/claudeHooks.json');
  const tmux = standInTmux();
  const agents = createAgents({
    run: tmux.run, repoDir: '/work/repo', bin: '/opt/woodshed/session/bin', claudeDir: path.join(dir, 'claude'), codexHome: path.join(dir, 'codex'),
    claudeFlagsFile: path.join(dir, 'flags'), codexReady: async () => true, stateDir: dir, openRollout: async () => null,
    log: { log() {}, warn() {} }, ...overrides,
  });
  return { agents, tmux, dir };
}

test('a start makes a tmux session of its own, points its hooks at its own file, and types the agent in', async () => {
  const given = [];
  const { agents, tmux, dir } = agentsWith({ codexEnv: async (codexAuth) => { given.push(codexAuth); return { env: { WOODSHED_CODEX_AUTH: 'key' } }; } });
  try {
    const claude = await agents.start({ agent: 'claude', model: 'opus', prompt: 'review it' });
    assert.equal(claude.id, 'agent-2');
    assert.equal(claude.agent, 'claude');
    assert.equal(claude.model, 'opus');
    const made = tmux.calls.find((c) => c[1] === 'new-session');
    assert.deepEqual(made.slice(1, 4), ['new-session', '-d', '-s']);
    assert.ok(made.includes(`WOODSHED_CLAUDE_STATE_FILE=${path.join(dir, 'woodshed-agent-2-state.json')}`));
    assert.ok(tmux.calls.some((c) => c[1] === 'set-option' && c.includes('=agent-2:') && c.includes('remain-on-exit')));
    const line = tmux.typed.get('=agent-2:');
    assert.match(line, /^\/opt\/woodshed\/session\/bin\/claude --settings \S+ --session-id [0-9a-f-]{36} --permission-mode auto --model opus "\$\(cat \S+woodshed-agent-2-prompt\.md\)"$/);
    assert.equal(fs.readFileSync(path.join(dir, 'woodshed-agent-2-prompt.md'), 'utf8'), 'review it\n');
    const conversation = /--session-id (\S+)/.exec(line)[1];
    assert.ok(agents.claimed().claude.has(`${conversation}.jsonl`), 'its transcript is never the session\'s own');

    const codex = await agents.start({ agent: 'codex', codexAuth: 'sk-own' });
    assert.deepEqual(given, ['sk-own'], 'the sign-in the console sent with the start');
    assert.equal(codex.id, 'agent-3');
    assert.ok(tmux.calls.find((c) => c[1] === 'new-session' && c.includes('agent-3')).includes('WOODSHED_CODEX_AUTH=key'), 'its sign-in, as statusd set it up');
    assert.equal(agents.ranCodex(), true);
    await agents.stop('agent-3');
    assert.equal(agents.ranCodex(), true, 'a codex stopped before its Chat was ever read still sends its sign-in back');
    await agents.start({ agent: 'codex' });

    await agents.start({});
    await assert.rejects(agents.start({}), (err) => err.status === 409 && /at most 3/.test(err.message));
    assert.equal((await agents.list()).length, MAX_EXTRA_AGENTS);

    await agents.stop('agent-2');
    assert.ok(tmux.calls.some((c) => c[1] === 'kill-session' && c.includes('=agent-2')));
    assert.deepEqual((await agents.list()).map((a) => a.id), ['agent-3', 'agent-4'], 'agent-3 again, in its slot');
    assert.ok(agents.claimed().claude.has(`${conversation}.jsonl`), 'a stopped one\'s record stays claimed');
    assert.equal((await agents.start({})).id, 'agent-2', 'the lowest id free');
    await assert.rejects(agents.transcript('agent-9'), (err) => err.status === 404);
  } finally {
    await agents.stopAll('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no agent starts once the session is tainted, and the lockdown stops every one', async () => {
  let tainted = false;
  const { agents, tmux, dir } = agentsWith({ tainted: () => tainted });
  try {
    await agents.start({});
    tainted = true;
    await assert.rejects(agents.start({}), (err) => err.status === 409 && /production data/.test(err.message));
    await agents.stopAll('tainted');
    assert.deepEqual(await agents.list(), []);
    assert.ok(tmux.calls.some((c) => c[1] === 'kill-session' && c.includes('=agent-2')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an image that wrote no flags for it, or a session with no codex home, says so rather than start one', async () => {
  const { agents, dir } = agentsWith({ claudeFlagsFile: '/nonexistent/flags', codexReady: async () => false });
  try {
    await assert.rejects(agents.start({ agent: 'claude' }), (err) => err.status === 409 && /start a new session/.test(err.message));
    await assert.rejects(agents.start({ agent: 'codex' }), (err) => err.status === 409 && /codex is not set up/.test(err.message));
    assert.deepEqual(await agents.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a message to an agent mid-turn is held, and typed in once it is back at its prompt', async () => {
  const { agents, dir } = agentsWith();
  try {
    const a = await agents.start({});
    // The stand-in's pane shows nothing an agent draws: never at its prompt, so the message waits.
    const sent = await agents.send(a.id, 'hello', 'msg-00000001');
    assert.deepEqual(sent, { ok: true, held: true });
    assert.deepEqual((await agents.list())[0].heldIds, ['msg-00000001']);
  } finally {
    await agents.stopAll('test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex start that fails once its sign-in is in place takes the sign-in back', async () => {
  const taken = [];
  const { agents, dir } = agentsWith({
    run: async (cmd, args) => { if (args[0] === 'new-session') throw new Error('tmux: server exited'); return { stdout: '' }; },
    codexEnv: async () => ({ env: {}, undo: async () => { taken.push('undone'); } }),
  });
  try {
    await assert.rejects(agents.start({ agent: 'codex', codexAuth: 'sk-own' }), /server exited/);
    assert.deepEqual(taken, ['undone']);
    assert.deepEqual(await agents.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a codex agent\'s rollout is claimed as the list is read, so the session\'s own never falls back to it', async () => {
  const { agents, dir } = agentsWith({ openRollout: async () => '/home/node/.codex/sessions/2026/11/23/rollout-x.jsonl' });
  try {
    await agents.start({ agent: 'codex' });
    await agents.list();
    await agents.stop('agent-2');
    assert.ok(agents.claimed().codex.has('/home/node/.codex/sessions/2026/11/23/rollout-x.jsonl'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
