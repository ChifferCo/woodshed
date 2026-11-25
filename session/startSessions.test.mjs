import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describe, parseArgs, run } from './startSessions.mjs';

const TOKEN = `wst_${'a'.repeat(64)}`;

function io({ answers = [], files = {}, env = { WOODSHED_CONSOLE_URL: 'http://10.8.0.1:7691/' } } = {}) {
  const out = { stdout: '', stderr: '', calls: [] };
  const queue = [...answers];
  return {
    out,
    args: {
      env,
      stdout: { write: (t) => { out.stdout += t; } },
      stderr: { write: (t) => { out.stderr += t; } },
      tokenFile: '/tmp/token',
      readFile: (p) => {
        if (p in files) return files[p];
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      stdin: async () => 'Prompt from stdin',
      sleep: async () => {},
      fetch: async (url, init) => {
        out.calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
        const [status, body] = queue.shift() ?? [500, null];
        return { status, json: async () => body };
      },
    },
  };
}

const started = { id: 'eb7082e2', title: 'CSV export', status: 'queued', branch: 'woodshed/joel-eb7082e2', url: 'https://console.example/s/eb7082e2' };

test('new reads the prompt from a file and posts it with its options, on the start token', async () => {
  const { out, args } = io({ files: { '/tmp/token': `${TOKEN}\n`, '/tmp/brief.md': 'Add CSV export.\nDone when it downloads.' }, answers: [[201, { session: started }]] });
  const code = await run({ ...args, argv: ['new', '--prompt-file', '/tmp/brief.md', '--branch', 'joel/csv', '--name', 'CSV export', '--repo', 'api'] });
  assert.equal(code, 0);
  assert.deepEqual(out.calls, [{
    url: 'http://10.8.0.1:7691/sessions', method: 'POST', auth: `Bearer ${TOKEN}`,
    body: { prompt: 'Add CSV export.\nDone when it downloads.', branch: 'joel/csv', project: 'api', name: 'CSV export' },
  }]);
  assert.match(out.stdout, /Started session eb7082e2: CSV export, as part of this session's work\n {2}https:\/\/console\.example\/s\/eb7082e2\n/);
  assert.match(out.stdout, /waiting in line/);
});

test('the prompt may be words or stdin, and is required', async () => {
  const words = io({ files: { '/tmp/token': TOKEN }, answers: [[201, { session: started }]] });
  await run({ ...words.args, argv: ['new', 'Fix', 'the', 'export'] });
  assert.equal(words.out.calls[0].body.prompt, 'Fix the export');
  const piped = io({ files: { '/tmp/token': TOKEN }, answers: [[201, { session: started }]] });
  await run({ ...piped.args, argv: ['new', '-'] });
  assert.equal(piped.out.calls[0].body.prompt, 'Prompt from stdin');
  const none = io({ files: { '/tmp/token': TOKEN } });
  assert.equal(await run({ ...none.args, argv: ['new'] }), 1);
  assert.match(none.out.stderr, /first prompt/);
  assert.equal(none.out.calls.length, 0);
});

test('--agent takes every agent New session offers, Grok Build and OpenCode too, and nothing else', async () => {
  for (const agent of ['claude', 'codex', 'grok', 'opencode']) {
    const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [[201, { session: { ...started, agent } }]] });
    assert.equal(await run({ ...args, argv: ['new', '--agent', agent, 'Fix', 'it'] }), 0, agent);
    assert.equal(out.calls[0].body.agent, agent);
  }
  const { out, args } = io({ files: { '/tmp/token': TOKEN } });
  assert.equal(await run({ ...args, argv: ['new', '--agent', 'gemini', 'Fix', 'it'] }), 1);
  assert.match(out.stderr, /--agent is claude, codex, grok, opencode/);
  assert.equal(out.calls.length, 0);
  assert.match(describe({ ...started, agent: 'grok' }).join('\n'), /^ {2}branch woodshed\/joel-eb7082e2, grok$/m);
});

test('without a start token it says why, and calls nothing', async () => {
  const { out, args } = io();
  assert.equal(await run({ ...args, argv: ['list'] }), 1);
  assert.match(out.stderr, /only a My Woodshed session can/);
  assert.equal(out.calls.length, 0);
});

test('list and get say how each is doing; the console\'s refusal is said as it is', async () => {
  const one = { ...started, status: 'running', state: 'done', prUrl: 'https://github.com/o/r/pull/7', lastMessage: 'Opened the PR.\nmore' };
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [[200, { sessions: [one] }], [404, { error: 'no session aaaa0000 that this session started' }]] });
  assert.equal(await run({ ...args, argv: ['list'] }), 0);
  assert.equal(out.stdout, `${describe(one).join('\n')}\n`);
  assert.match(out.stdout, /eb7082e2 {2}running, done {2}CSV export\n.*\n {2}branch woodshed\/joel-eb7082e2, PR https:\/\/github.com\/o\/r\/pull\/7\n {2}last: Opened the PR\.\n$/);
  assert.equal(await run({ ...args, argv: ['get', 'aaaa0000'] }), 1);
  assert.equal(out.stderr, 'woodshed-session: no session aaaa0000 that this session started\n');
});

test('parseArgs takes options before or after the words, and -- ends them', () => {
  assert.deepEqual(parseArgs(['new', '--branch', 'b', 'do', 'it', '--json']), { command: 'new', args: ['do', 'it'], flags: { json: true, branch: 'b' } });
  assert.deepEqual(parseArgs(['new', '--', '--not-an-option']).args, ['--not-an-option']);
  assert.throws(() => parseArgs(['new', '--wat']), /unknown option/);
  assert.throws(() => parseArgs(['new', '--branch']), /needs a value/);
});

test('send types a message in, and --wait prints what the other session said after it', async () => {
  const child = { ...started, id: 'c0c0c0c0', status: 'running', state: 'done', title: 'Move invoice totals' };
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [
    [200, { sent: true, sentAt: '2026-11-24T12:00:00.000Z', session: child }],
    [200, { session: child, waiting: true }],
    [200, { session: { ...child, lastMessage: 'Totals are in cents.' } }],
    [200, { entries: [{ role: 'user', text: 'Use cents', at: '2026-11-24T12:00:01.000Z' }, { role: 'assistant', text: 'Totals are in cents.', at: '2026-11-24T12:03:00.000Z' }] }],
  ] });
  assert.equal(await run({ ...args, argv: ['send', 'c0c0c0c0', 'Use', 'cents', '--wait'] }), 0);
  assert.deepEqual(out.calls.map((c) => `${c.method} ${c.url.replace('http://10.8.0.1:7691', '')}`), [
    'POST /sessions/c0c0c0c0/messages', 'GET /sessions/c0c0c0c0/wait?for=reply', 'GET /sessions/c0c0c0c0/wait?for=reply',
    'GET /sessions/c0c0c0c0/transcript?limit=50&since=2026-11-24T12%3A00%3A00.000Z',
  ]);
  assert.deepEqual(out.calls[0].body, { text: 'Use cents' });
  assert.match(out.stdout, /^Sent to session c0c0c0c0\n/);
  assert.match(out.stdout, /\[said 12:03\] Totals are in cents\.\n$/);
  assert.doesNotMatch(out.stdout, /Use cents\n/, 'what it was asked is left out of the answer');
});

test('reply answers the session that started this one, and says when none did', async () => {
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [[200, { sessions: [], startedFrom: { id: 'aaaa0001' } }], [200, { held: true, session: { status: 'running', state: 'working' } }]] });
  assert.equal(await run({ ...args, argv: ['reply', 'Done:', 'totals', 'are', 'in', 'cents'] }), 0);
  assert.equal(out.calls[1].url, 'http://10.8.0.1:7691/sessions/aaaa0001/messages');
  assert.deepEqual(out.calls[1].body, { text: 'Done: totals are in cents' });
  assert.match(out.stdout, /^Held for session aaaa0001: it gets it once it is at its prompt \(running, working\)/);

  const orphan = io({ files: { '/tmp/token': TOKEN }, answers: [[200, { sessions: [], startedFrom: null }]] });
  assert.equal(await run({ ...orphan.args, argv: ['reply', 'hi'] }), 1);
  assert.match(orphan.out.stderr, /no session started this one/);
});

test('read prints the conversation, wait says when nothing took up a message, stop and resume say the state', async () => {
  const child = { ...started, id: 'c0c0c0c0', status: 'running', state: 'done' };
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [
    [200, { entries: [{ role: 'user', text: 'Move the totals', at: '2026-11-24T11:00:00.000Z' }, { role: 'assistant', text: 'Done.', at: '2026-11-24T11:02:00.000Z' }] }],
    [200, { session: child, noReply: true }],
    [200, { session: { ...child, status: 'stopped' } }],
  ] });
  assert.equal(await run({ ...args, argv: ['read', 'c0c0c0c0', '--last', '2'] }), 0);
  assert.match(out.stdout, /^\[asked 11:00\] Move the totals\n\[said 11:02\] Done\.\n/);
  assert.equal(await run({ ...args, argv: ['wait', 'c0c0c0c0', '--reply'] }), 0);
  assert.match(out.stdout, /it did not take up what was sent/);
  assert.equal(await run({ ...args, argv: ['stop', 'c0c0c0c0'] }), 0);
  assert.match(out.stdout, /c0c0c0c0 {2}stopped/);
  assert.deepEqual(out.calls.map((c) => `${c.method} ${c.url.replace('http://10.8.0.1:7691', '')}`), [
    'GET /sessions/c0c0c0c0/transcript?limit=50', 'GET /sessions/c0c0c0c0/wait?for=reply', 'POST /sessions/c0c0c0c0/stop',
  ]);
});

test('rename names this session, or another when given its id', async () => {
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [[200, { session: { id: 'aaaa0001', title: 'Billing page' } }], [200, { session: { id: 'c0c0c0c0', title: 'Totals in cents' } }]] });
  assert.equal(await run({ ...args, argv: ['rename', 'Billing', 'page'] }), 0);
  assert.equal(await run({ ...args, argv: ['rename', 'c0c0c0c0', 'Totals', 'in', 'cents'] }), 0);
  assert.deepEqual(out.calls.map((c) => [c.url.replace('http://10.8.0.1:7691', ''), c.body.name]), [['/rename', 'Billing page'], ['/sessions/c0c0c0c0/rename', 'Totals in cents']]);
  assert.match(out.stdout, /^Renamed aaaa0001: Billing page\nRenamed c0c0c0c0: Totals in cents\n$/);
});

test('a session that has seen production data is said to be so, with no last line', () => {
  const lines = describe({ id: 'c0c0c0c0', status: 'running', state: 'done', title: 'Prod check', url: 'https://console.example/s/c0c0c0c0', lastMessage: null, tainted: true });
  assert.deepEqual(lines.slice(2), ['  has seen production data: what it says stays on the console']);
});

test('new --separate asks for work of its own, and says so', async () => {
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [[201, { session: { ...started, separate: true } }]] });
  assert.equal(await run({ ...args, argv: ['new', '--separate', 'Audit', 'the', 'refund', 'flow'] }), 0);
  assert.deepEqual(out.calls[0].body, { prompt: 'Audit the refund flow', separate: true });
  assert.match(out.stdout, /^Started session eb7082e2: CSV export, on its own\n/);
});

test('agent new --wait starts a helper beside this session\'s agent, waits for it to work and answer, and prints what it said', async () => {
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const later = new Date(Date.now() + 60_000).toISOString();
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [
    [200, { agent: { id: 'agent-2', agent: 'claude' } }],
    [200, { agents: [{ id: 'agent-2', state: 'idle', heldIds: [] }] }],
    [200, { entries: [] }],
    [200, { agents: [{ id: 'agent-2', state: 'working', heldIds: [] }] }],
    [200, { agents: [{ id: 'agent-2', state: 'done', heldIds: [] }] }],
    [200, { entries: [{ role: 'user', text: 'Look into the flaky test', at: sentAt }, { role: 'tool', text: 'npm test', at: later }, { role: 'assistant', text: 'It races on the clock: fixed with a fake timer.', at: later }] }],
  ] });
  assert.equal(await run({ ...args, argv: ['agent', 'new', 'Look', 'into', 'the', 'flaky', 'test', '--wait'] }), 0);
  assert.deepEqual(out.calls.map((c) => `${c.method} ${c.url.replace('http://10.8.0.1:7691', '')}`), [
    'POST /agents', 'GET /agents', 'GET /agents/agent-2/transcript?limit=20', 'GET /agents', 'GET /agents', 'GET /agents/agent-2/transcript?limit=50',
  ]);
  assert.deepEqual(out.calls[0].body, { prompt: 'Look into the flaky test' });
  assert.match(out.stdout, /^Started agent-2: claude, beside this session's own agent, in this checkout\nagent-2 {2}done\n\[said \d\d:\d\d\] It races on the clock: fixed with a fake timer\.\n$/);
});

test('agent list, send, read and stop', async () => {
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [
    [200, { agents: [{ id: 'agent-2', state: 'working', agent: 'codex', model: 'gpt-5' }] }],
    [200, { ok: true, held: true }],
    [200, { entries: [{ role: 'user', text: 'Write the tests', at: null }, { role: 'assistant', text: 'Wrote 3.', at: null }] }],
    [200, { ok: true }],
  ] });
  assert.equal(await run({ ...args, argv: ['agent', 'list'] }), 0);
  assert.equal(await run({ ...args, argv: ['agent', 'send', 'agent-2', 'Also', 'rounding'] }), 0);
  assert.equal(await run({ ...args, argv: ['agent', 'read', 'agent-2', '--last', '2'] }), 0);
  assert.equal(await run({ ...args, argv: ['agent', 'stop', 'agent-2'] }), 0);
  assert.equal(out.stdout, 'agent-2  working  codex gpt-5\nHeld for agent-2: it gets it once its turn ends\n[asked] Write the tests\n[said] Wrote 3.\nStopped agent-2\n');
  assert.deepEqual(out.calls[1].body, { text: 'Also rounding' });
  assert.equal(await run({ ...args, argv: ['agent', 'send', 'claude', 'x'] }), 1);
  assert.match(out.stderr, /give the agent's id/);
});

test('send --wait prints the other session\'s reply; a wait on one waiting on this says so; reply never waits; --help anywhere', async () => {
  const child = { ...started, id: 'c0c0c0c0', status: 'running', state: 'working', title: 'README summary' };
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [
    [200, { sent: true, sentAt: '2026-11-24T17:10:00.000Z', session: child }],
    [200, { session: child, reply: { text: 'Developers or customers?', at: '2026-11-24T17:11:00.000Z' } }],
    [200, { session: { ...child, id: 'aaaa0001', title: 'Repo tour' }, waitingOnYou: true }],
    [200, { sessions: [], startedFrom: { id: 'aaaa0001' } }],
    [200, { sent: true, answeredWait: true, session: { id: 'aaaa0001' } }],
  ] });
  assert.equal(await run({ ...args, argv: ['send', 'c0c0c0c0', 'Ask', 'me', 'first', '--wait'] }), 0);
  assert.match(out.stdout, /\[replied 17:11\] Developers or customers\?\n$/);
  assert.equal(out.calls.filter((c) => c.url.includes('/transcript')).length, 0, 'the reply is the answer: nothing else to read');
  assert.equal(await run({ ...args, argv: ['wait', 'aaaa0001', '--reply'] }), 0);
  assert.match(out.stdout, /it is waiting on this session: answer it with woodshed-session send aaaa0001 "<answer>"/);
  const before = out.stdout.length;
  assert.equal(await run({ ...args, argv: ['reply', 'Customers.'] }), 0);
  assert.doesNotMatch(out.stdout.slice(before), /Wait for it with/, 'a reply may be what the other waits for: never waited on');
  const help = io();
  assert.equal(await run({ ...help.args, argv: ['new', '--help'] }), 0);
  assert.match(help.out.stdout, /^Usage: woodshed-session <command>/);
  assert.equal(help.out.calls.length, 0);
});

test('agent --wait sees a turn too short to be seen working by what it wrote since', async () => {
  const later = new Date(Date.now() + 60_000).toISOString();
  const { out, args } = io({ files: { '/tmp/token': TOKEN }, answers: [
    [200, { ok: true }],
    [200, { agents: [{ id: 'agent-2', state: 'done', heldIds: [] }] }],
    [200, { entries: [{ role: 'assistant', text: 'Yes: 42.', at: later }] }],
    [200, { entries: [{ role: 'user', text: 'Is it 42?', at: later }, { role: 'assistant', text: 'Yes: 42.', at: later }] }],
  ] });
  assert.equal(await run({ ...args, argv: ['agent', 'send', 'agent-2', 'Is', 'it', '42?', '--wait'] }), 0);
  assert.doesNotMatch(out.stdout, /did not take it up/);
  assert.match(out.stdout, /\[said \d\d:\d\d\] Yes: 42\.\n$/);
});
