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
  assert.match(out.stdout, /Started session eb7082e2: CSV export\n {2}https:\/\/console\.example\/s\/eb7082e2\n/);
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
