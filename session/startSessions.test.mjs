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
