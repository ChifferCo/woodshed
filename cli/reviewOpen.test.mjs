import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { createCredentials } from './credentials.mjs';
import { findTarget, parseReviewTarget } from './reviewOpen.mjs';
import { stripAnsi, width } from './reviewView.mjs';
import { parsePullUrl } from './sessions.mjs';
import { EXIT, main } from './woodshed.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const T0 = Date.parse('2026-11-20T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS = {
  ok: true, session: 'claude-aaaa0001', kind: 'worktree', branch: 'woodshed/aaaa0001', baseRef: 'main', headSha: 'abcdef0123456789',
  createdAt: iso(T0), status: 'ready', ghAccount: 'mia-dev',
  meta: { title: 'Work in progress', headRefName: 'woodshed/aaaa0001', baseRefName: 'main', headRefOid: 'abcdef0123456789', additions: 3, deletions: 1, commits: 1, dirtyFiles: 0 },
  livePr: { number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Fix the login bug', state: 'open', review: 'pending', checks: { pass: 2, fail: 0, pending: 0, total: 2 } },
  review: {
    overview: 'The login now **redirects** back to `next`.',
    decisions: [{ title: 'Only same-site `next` values', why: 'An open redirect otherwise.', files: ['src/login.mjs'] }],
    architecture: 'One function.',
    groups: [{ title: 'The redirect', why: 'Start here.', files: [{ path: 'src/login.mjs', preamble: 'Reads next.', role: 'core' }] }],
  },
};
const DIFF = {
  ok: true, createdAt: iso(T0),
  files: [
    { path: 'README.md', status: 'modified', additions: 1, deletions: 0, hunks: [{ lines: [{ type: 'add', oldNo: null, newNo: 1, text: 'Login: see docs.' }] }] },
    { path: 'src/login.mjs', status: 'modified', additions: 2, deletions: 1, hunks: [{ lines: [
      { type: 'ctx', oldNo: 1, newNo: 1, text: 'export function login(req) {' },
      { type: 'del', oldNo: 2, newNo: null, text: '  return redirect("/");' },
      { type: 'add', oldNo: null, newNo: 2, text: `  return redirect(safe(req.query.next) ?? "/"); // ${'x'.repeat(120)}` },
      { type: 'add', oldNo: null, newNo: 3, text: '\x1b]0;pwned\x07}' },
    ] }] },
  ],
};

// A session's statusd as the shed's review answers it, recording each call.
async function fakeStatusd(t) {
  const seen = [];
  const chat = [];
  const qaItems = [
    { id: 'q1', parent: null, depth: 1, question: 'What is `next`?', answer: 'The page to go back to.' },
    { id: 'q2', parent: null, depth: 1, question: 'Why only same-site?', answer: 'An open redirect otherwise.' },
    { id: 'q3', parent: 'q2', depth: 2, question: 'What is an open redirect?', answer: 'A link that sends you anywhere.' },
  ];
  const answers = new Map(Object.entries({
    'GET ': () => STATUS,
    'GET /diff': () => DIFF,
    'GET /comments': () => ({ ok: true, prId: 'PR_1', headSha: 'abcdef0123456789', reviewId: null, description: { author: 'mia-dev', body: 'Fixes #3.' }, comments: [], threads: [], said: [] }),
    'GET /chat': () => ({ ok: true, messages: chat, running: null }),
    'GET /qa': () => ({ ok: true, qa: { status: 'ready', forDiff: iso(T0), items: qaItems } }),
    // The shed writes the question at once, waiting for its answer, after the others under its parent.
    'POST /qa/ask': (body) => {
      const item = { id: `q${qaItems.length + 1}`, parent: body.parent, question: body.question, asking: true, mine: true };
      qaItems.push(item);
      return { ok: true, item };
    },
    'POST /qa': () => ({ ok: true }),
    'POST /comments': () => ({ ok: true, reviewId: 'PRR_1' }),
    'POST /submit': () => ({ ok: true, event: 'approve', pr: 12 }),
    'PATCH /title': (body) => ({ ok: true, title: body.title }),
    'GET /merge': () => ({ ok: true, reviewedSha: 'abcdef0123456789', blocker: null, readiness: { reviewDecision: 'APPROVED', headSha: 'abcdef0123456789', baseRef: 'main', mergeState: 'CLEAN', checks: { pass: 2, fail: 0, pending: 0, total: 2 }, mergeQueue: false } }),
    'POST /merge': () => ({ ok: true, queued: false, pr: 12, sha: '1234567890', baseRef: 'main' }),
    'POST /chat': (body) => {
      // The shed writes a turn to the transcript once it is answered.
      chat.push({ role: 'user', text: body.question }, { role: 'assistant', text: 'It reads `next`.', steps: 1, durationMs: 2000 });
      return { ok: true, askId: 'ask-1', status: 'running' };
    },
    'GET /explain/ask-1': () => ({ ok: true, status: 'ready', answer: { text: 'It reads next.' } }),
  }));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const [, review, pr] = /^\/shed-review\/reviews\/(claude-[0-9a-f]{8}(?:-pr(\d+))?)/.exec(req.url) ?? [];
      const section = req.url.replace(/^\/shed-review\/reviews\/claude-[0-9a-f]{8}(?:-pr\d+)?/, '').split('?')[0];
      const body = raw ? JSON.parse(raw) : null;
      const pulls = String(req.headers['x-woodshed-pulls'] ?? '');
      seen.push({ method: req.method, section, review, pulls, auth: req.headers.authorization, body });
      const reply = (code, answer) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      };
      // As session/reviewShed/host.mjs answers another pull request's review: #12 is the branch checked out, so its
      // review is the checkout's; any other must be one the console named.
      if (pr) {
        const checkout = review.replace(/-pr\d+$/, '');
        const checkedOut = checkout === 'claude-abab0006' ? 17 : 12;
        if (Number(pr) === checkedOut) return reply(200, { ok: false, status: 'checkout', review: checkout, error: `#${pr} is the branch checked out` });
        if (!pulls.split(',').includes(pr)) return reply(404, { ok: false, error: `#${pr} is not one of this session's pull requests` });
        if (req.method === 'GET' && section === '') {
          return reply(200, { ...STATUS, session: review, kind: 'pr', pr: Number(pr), branch: null,
            meta: { ...STATUS.meta, number: Number(pr), url: `https://github.com/acme/app/pull/${pr}`, title: `Pull request ${pr}` },
            livePr: { ...STATUS.livePr, number: Number(pr), url: `https://github.com/acme/app/pull/${pr}`, title: `Pull request ${pr}` },
            reviews: [{ review: checkout, number: checkedOut, checkout: true }, { review, number: Number(pr), checkout: false }] });
        }
      }
      const answer = answers.get(`${req.method} ${section}`);
      const known = typeof answer === 'function';
      reply(known ? 200 : 404, known ? answer(body) : { ok: false, error: 'not found' });
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { port, seen };
}

// The console's real handler and sign-in, over mia-dev's sessions and others', signed in as mia-dev.
async function consoleFor(t) {
  const statusd = await fakeStatusd(t);
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now: () => T0, canWrite: async () => true });
  const endpoint = { host: '127.0.0.1', statusPort: statusd.port };
  const base = { repo: 'acme/app', project: 'app', createdAt: iso(T0), startedAt: iso(T0), options: { agent: 'claude' }, token: 'statusd-secret', kind: 'task' };
  const sessions = [
    { ...base, id: 'aaaa0001', owner: 'mia-dev', title: 'Fix the login bug', status: 'running', state: 'done', endpoint, prUrl: 'https://github.com/acme/app/pull/12' },
    { ...base, id: 'bbbb0002', owner: 'mia-dev', title: 'Paused one', status: 'stopped', stopReason: 'idle for 2 h' },
    { ...base, id: 'cccc0003', owner: null, kind: 'pr', title: 'Shared work', status: 'running', state: 'done', assignee: 'mia-dev', kept: true, endpoint, prUrl: 'https://github.com/acme/app/pull/13' },
    { ...base, id: 'dddd0004', owner: 'mia-dev', title: 'Saw production', status: 'running', state: 'done', endpoint, taintedAt: iso(T0), prUrl: 'https://github.com/acme/app/pull/14' },
    { ...base, id: 'eeee0005', owner: 'octocat', title: 'Octocat\'s', status: 'running', state: 'done', endpoint, prUrl: 'https://github.com/acme/app/pull/15' },
    // Opened #11, then #17 on another branch, checked out now: #17 is its checkout's review, and #11 has one of its own.
    { ...base, id: 'abab0006', owner: 'mia-dev', title: 'Replaced its pull request', status: 'running', state: 'done', endpoint,
      prUrl: 'https://github.com/acme/app/pull/17', prUrls: ['https://github.com/acme/app/pull/11', 'https://github.com/acme/app/pull/17'] },
    // #16 on two repos.
    { ...base, id: 'abab0007', owner: 'mia-dev', title: 'On app', status: 'running', state: 'done', endpoint, prUrl: 'https://github.com/acme/app/pull/16' },
    { ...base, id: 'abab0008', owner: 'mia-dev', repo: 'acme/tools', title: 'On tools', status: 'running', state: 'done', endpoint, prUrl: 'https://github.com/acme/tools/pull/16' },
    // The console's review of #40: it did not open #40, so #40 still has no session of hers.
    { ...base, id: 'abab0009', owner: null, kind: 'pr', number: 40, trigger: 'review', startedBy: 'mia-dev', title: 'Review: #40', status: 'running', state: 'working', review: { base: 'main', sha: 'abc' } },
  ];
  const fleet = {
    sessions: () => sessions,
    find: (id) => sessions.find((s) => s.id === id) ?? null,
    limitsOf: () => ({ idleMs: 3_600_000, lifetimeMs: 12 * 3_600_000 }),
    pauseOf: () => null,
  };
  const chips = { 'https://github.com/acme/app/pull/12': { number: 12, title: 'Fix the login bug', state: 'open', review: 'approved', checks: { pass: 2, fail: 0, pending: 0, total: 2 } } };
  const prChips = { view: (url) => chips[url] ?? null, refresh: async () => {}, stale: () => [] };
  const github = {
    openPullsFor: async () => [
      { number: 12, title: 'Fix the login bug', branch: 'woodshed/aaaa0001', why: 'yours', draft: false, checks: null },
      { number: 40, title: 'A pull request with no session', branch: 'fix/x', why: 'yours', draft: true, checks: { pass: 0, fail: 1, pending: 0, total: 1 } },
      { number: 41, title: 'Someone else\'s, waiting on mine', branch: 'y', why: 'review', draft: false, checks: null },
    ],
  };
  const projectAccess = { view: async () => ({ projects: [{ name: 'app', repo: 'acme/app' }], defaultProject: 'app', saved: false }), forStart: async () => ({ name: 'app', repo: 'acme/app' }) };
  const userSettings = { view: () => ({}), refresh: async () => {}, limitsFor: () => ({ idleMs: 3_600_000, lifetimeMs: 12 * 3_600_000 }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, cli, userSettings, projectAccess, prChips, github });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const run = async (args, { tty = false, stdin = { isTTY: false }, stdout = null } = {}) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, stdout: stdout ?? { write: (s) => { out += s; }, isTTY: tty }, stdin, stderr: { write: (s) => { err += s; } },
      sleep: async () => {}, now: () => T0, hostname: 'mia-laptop', platform: 'test', credentials,
      openBrowser: (url) => { cli.decide({ code: new URL(url).searchParams.get('code'), login: 'mia-dev', approve: true }); },
    });
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const signed = await run(['login', '--console', origin]);
  assert.equal(signed.code, EXIT.done, signed.err);
  return { origin, run, seen: statusd.seen, sessions };
}

test('a review target is a session id, or a pull request by number or URL', () => {
  assert.deepEqual(parseReviewTarget(['aaaa0001']), { id: 'aaaa0001' });
  assert.deepEqual(parseReviewTarget(['12']), { number: 12, repo: null });
  assert.deepEqual(parseReviewTarget(['#12']), { number: 12, repo: null });
  assert.deepEqual(parseReviewTarget(['pr', '12']), { number: 12, repo: null });
  assert.deepEqual(parseReviewTarget(['https://github.com/Acme/App/pull/12']), { number: 12, repo: 'acme/app' });
  assert.equal(parseReviewTarget(['aaaa000']), null);
  assert.equal(parseReviewTarget(['https://example.com/acme/app/pull/12']), null);
  // The console's addresses exactly, a pasted one with its slash or fragment, and nothing else; never slow on a long one.
  assert.deepEqual(parsePullUrl('https://github.com/acme/app/pull/12'), { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12' });
  assert.equal(parsePullUrl('https://github.com/acme/app/pull/12/'), null);
  assert.equal(parsePullUrl('https://github.com/acme/app/pull/12#x', { loose: true }).number, 12);
  for (const odd of ['http://github.com/acme/app/pull/12', 'https://github.com:444/acme/app/pull/12', 'https://u@github.com/acme/app/pull/12',
    'https://github.com/acme/app/issues/12', 'https://github.com/acme/app/pull/12/files', 'https://github.com/a/b/c/pull/1', null]) {
    assert.equal(parsePullUrl(odd, { loose: true }), null, String(odd));
  }
  const started = Date.now();
  assert.equal(parsePullUrl(`https://github.com/${'a'.repeat(50_000)}/pull/1`), null);
  assert.equal(parsePullUrl(`https://github.com/a/${'.'.repeat(300)}`), null);
  assert.ok(Date.now() - started < 100);
  const sessions = [
    { id: 'aaaa0001', owner: 'mia-dev', status: 'stopped', prUrl: 'https://github.com/acme/app/pull/12' },
    { id: 'aaaa0002', owner: 'mia-dev', status: 'running', prs: [{ url: 'https://github.com/acme/app/pull/12' }] },
    { id: 'cccc0003', owner: null, status: 'running', prUrl: 'https://github.com/acme/other/pull/12' },
  ];
  assert.equal(findTarget({ number: 12, repo: null }, sessions, 'mia-dev').session.id, 'aaaa0002', 'your running one first');
  assert.deepEqual(findTarget({ number: 12, repo: 'acme/other' }, sessions, 'mia-dev').others.map((s) => s.id), ['cccc0003']);
});

test('session list shows each session\'s pull request as the chips read it, how to review it, and your pull requests with no session', async (t) => {
  const c = await consoleFor(t);
  const text = await c.run(['session', 'list']);
  assert.equal(text.code, EXIT.done, text.err);
  assert.match(text.out, /aaaa0001 .*Fix the login bug\n +#12 open · approved · checks 2 passing\n +review it: woodshed review aaaa0001\n/);
  assert.match(text.out, /cccc0003 .*Shared work\n +#13 not read yet\n(?! +review it)/, 'a shared session\'s has no review hint');
  assert.doesNotMatch(text.out, /woodshed review dddd0004/, 'nor one that saw production data');
  assert.match(text.out, /Your open pull requests with no session:\n {2}#40 draft · checks 1 of 1 failing {2}acme\/app {2}A pull request with no session\n/);
  assert.doesNotMatch(text.out, /#41/, 'only your own pull requests, not those waiting on your review');
  assert.doesNotMatch(text.out.split('with no session')[1], /#12 /, 'a pull request with a session is listed with it');

  const [json] = (await c.run(['session', 'list', '--json'])).lines;
  const mine = json.sessions.find((s) => s.id === 'aaaa0001');
  assert.deepEqual(mine.pullRequest, { number: 12, repo: 'acme/app', url: 'https://github.com/acme/app/pull/12', title: 'Fix the login bug', state: 'open', review: 'approved', checks: { pass: 2, fail: 0, pending: 0, total: 2 } });
  assert.equal(mine.reviewCommand, 'woodshed review aaaa0001');
  assert.equal(json.sessions.find((s) => s.id === 'cccc0003').reviewCommand, null);
  assert.deepEqual(json.pullRequests.map((p) => [p.number, p.state, p.project]), [[40, 'draft', 'app']], 'a review of #40 did not open it');
});

test('review --json prints the analysis and the diff in reading order, through the console with the session\'s own token', async (t) => {
  const c = await consoleFor(t);
  for (const target of ['aaaa0001', '12', 'https://github.com/acme/app/pull/12']) {
    const got = await c.run(['review', target, '--json']);
    assert.equal(got.code, EXIT.done, got.err);
    const { review } = got.lines[0];
    assert.equal(review.session, 'aaaa0001');
    assert.equal(review.pullRequest.number, 12);
    assert.equal(review.pullRequest.url, 'https://github.com/acme/app/pull/12');
    assert.match(review.analysis.overview, /redirects/);
    assert.deepEqual(review.diff.groups.map((g) => [g.title, g.files.map((f) => f.path)]), [['The redirect', ['src/login.mjs']], [null, ['README.md']]]);
  }
  assert.ok(c.seen.length);
  assert.ok(c.seen.every((s) => s.auth === 'Bearer statusd-secret'), 'statusd sees the session\'s token, never the command line\'s');
  assert.doesNotMatch((await c.run(['review', 'aaaa0001', '--json'])).out, /\x1b/, 'no escape code in --json');
  // No terminal: the same, as text.
  const plain = await c.run(['review', 'aaaa0001']);
  assert.equal(plain.code, EXIT.done, plain.err);
  assert.match(plain.out, /^Review: Fix the login bug \(#12, open, https:\/\/github\.com\/acme\/app\/pull\/12\)\n/);
  assert.doesNotMatch(plain.out, /\x1b/, 'no escape code with no terminal');
  assert.match(plain.out, /Files, in reading order\n {2}The redirect\n {4}src\/login\.mjs {2}\+2 −1 {2}core\n {4}README\.md/);
});

test('review refuses a session that is not your own, one that saw production data, and says how to review a pull request with none', async (t) => {
  const c = await consoleFor(t);
  const shared = await c.run(['review', 'cccc0003']);
  assert.equal(shared.code, EXIT.refused);
  assert.match(shared.err, /cccc0003 is a shared session: woodshed review opens your own My Woodshed sessions only/);
  assert.equal((await c.run(['review', '13'])).code, EXIT.refused);
  const tainted = await c.run(['review', 'dddd0004']);
  assert.equal(tainted.code, EXIT.refused);
  assert.match(tainted.err, /seen production data/);
  const others = await c.run(['review', 'eeee0005']);
  assert.equal(others.code, EXIT.failed, 'another person\'s private session is not one you can see');
  const none = await c.run(['review', '40']);
  assert.equal(none.code, EXIT.failed);
  assert.match(none.err, /No session of yours has pull request #40\. Start one on it: woodshed session new --branch 40/);
  assert.match((await c.run(['review', 'nonsense'])).err, /takes a session id/);
  const both = await c.run(['review', '16']);
  assert.equal(both.code, EXIT.refused);
  assert.match(both.err, /#16 is on more than one of your sessions' repos \(acme\/app, acme\/tools\): give its URL/);
  assert.equal(c.seen.length, 0, 'nothing refused reached a session');
  // By its URL it is one: #16 is not its checkout's, so it opens #16's own review.
  const byUrl = await c.run(['review', 'https://github.com/acme/app/pull/16', '--json']);
  assert.equal(byUrl.code, EXIT.done, byUrl.err);
  assert.equal(byUrl.lines[0].review.pullRequest.number, 16);
  assert.ok(c.seen.some((x) => x.review === 'claude-abab0007-pr16'));
  assert.ok(c.seen.every((x) => x.method === 'GET'), 'nothing was written');
});

test('review of a session with more than one pull request opens the one asked for, and names the others', async (t) => {
  const c = await consoleFor(t);
  // #11 is not the branch checked out: its own review, which posts to #11.
  const older = await c.run(['review', '11', '--json']);
  assert.equal(older.code, EXIT.done, older.err);
  const { review } = older.lines[0];
  assert.equal(review.pullRequest.number, 11);
  assert.equal(review.kind, 'pr');
  assert.deepEqual(review.otherPullRequests, [{ number: 17, checkout: true, url: 'https://github.com/acme/app/pull/17' }]);
  const asked = c.seen.filter((x) => x.review?.startsWith('claude-abab0006'));
  assert.ok(asked.length && asked.every((x) => x.review === 'claude-abab0006-pr11'), 'only #11\'s review was read');
  assert.equal(asked[0].pulls, '11,17', 'the console names the session\'s pull requests to statusd');
  // #17 is the branch checked out: the checkout's review, not a second one of it.
  c.seen.length = 0;
  const current = await c.run(['review', '17', '--json']);
  assert.equal(current.code, EXIT.done, current.err);
  assert.equal(current.lines[0].review.kind, 'worktree');
  assert.deepEqual(c.seen.map((x) => `${x.review}${x.section}`), ['claude-abab0006-pr17', 'claude-abab0006', 'claude-abab0006/diff'],
    'asked for #17, statusd sends it to its checkout\'s review');
  const text = await c.run(['review', '11']);
  assert.match(text.out, /The session's other pull requests, each with a review of its own:\n {2}#17 \(checked out\): woodshed review https:\/\/github\.com\/acme\/app\/pull\/17/);
});

// A terminal: keys typed into stdin, frames read off stdout.
function terminal() {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(on) { this.raw = on; }, resume() {}, pause() {} });
  let screen = '';
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: (s) => { screen += s; return true; } });
  return { stdin, stdout, screen: () => screen, clear: () => { screen = ''; }, type: (s) => stdin.emit('data', Buffer.from(s)) };
}

async function until(test, what) {
  for (let i = 0; i < 1000; i += 1) {
    if (test()) return;
    await wait(10);
  }
  assert.fail(`never: ${what}`);
}

test('the review on a terminal: every frame fits 80 columns, and a comment, a verdict, a rename and a merge go to the shed as the page sends them', async (t) => {
  const c = await consoleFor(t);
  const term = terminal();
  const done = c.run(['review', 'aaaa0001'], { stdin: term.stdin, stdout: term.stdout });
  const lastFrame = () => term.screen().split('\x1b[H').at(-1).replace(/\x1b\[[0-9;]*m/g, '').replace(/\u00a0/g, ' ');
  // A failure part way leaves no review running, whose timers would keep the test from ending.
  t.after(() => term.type('q'));
  await until(() => / 1 Overview │ 2 Q&A │ 3 Discussion │ 4 Files changed │ 5 Chat /.test(lastFrame()), 'the first frame: the tabs by number and name, with no counts');
  assert.ok(lastFrame().includes('\x1b]8;;https://github.com/acme/app/pull/12\x1b\\#12\x1b]8;;\x1b\\'), 'the header\'s #12 links to the pull request');
  assert.equal(term.stdin.raw, true);
  assert.match(term.screen(), /\x1b\[\?1049h/, 'an alternate screen');
  const said = (method, section) => c.seen.filter((s) => s.method === method && s.section === section);

  term.type('4');
  const rows = () => lastFrame().split('\r\n').map((l) => l.replace(/\x1b\[K/g, '').trimEnd());
  await until(() => rows().join('\n').includes('The redirect\nStart here.\n▸ src/login.mjs core +2 −1\n  Reads next.\n\nEverything else\n▸ README.md +1 −0'),
    'Files changed lists every file in the analysis\'s order, each with what it does');
  assert.match(lastFrame(), /Enter open {2}i chat about it/);
  // Chat about the file: Chat, with its path in the box, as the page's Send to the conversation does.
  term.type('j');
  term.type('i');
  await until(() => /Ask: README\.md/.test(lastFrame()), 'a chat about the file');
  term.type('\x1b');
  term.type('4');
  term.type('k\r');
  await until(() => /File 1 of 2 \(Esc: all files\) · The redirect/.test(lastFrame()), 'its diff, opened');
  assert.doesNotMatch(lastFrame(), /\x1b\]0;pwned/, 'no escape code from the diff reaches the terminal');
  term.type('jj');
  term.type('c');
  term.type('Why not URL()?');
  await until(() => /Comment on src\/login\.mjs:2: Why not URL\(\)\?/.test(lastFrame()), 'the comment box');
  term.type('\r');
  await until(() => said('POST', '/comments').length === 1, 'the comment');
  await until(() => /Added to your draft review/.test(lastFrame()), 'the comment, done');
  assert.deepEqual(said('POST', '/comments')[0].body, {
    mode: 'draft', prId: 'PR_1', headSha: 'abcdef0123456789', reviewId: null, path: 'src/login.mjs', line: 2, startLine: null, side: 'new', body: 'Why not URL()?',
  });

  term.type('s');
  await until(() => /Submit review on #12/.test(lastFrame()), 'the submit sheet');
  term.type('\t');
  // A paste the terminal delivers in pieces: its newline is not Enter, so nothing is posted until Enter is typed.
  term.type('\x1b[200~Looks right,\r');
  term.type('and tested\x1b[20');
  term.type('1~');
  await wait(50);
  assert.equal(said('POST', '/submit').length, 0, 'a newline in a paste posts nothing');
  assert.match(lastFrame(), /Comment: Looks right,⏎and tested/);
  term.type('\x15LGTM\r');
  await until(() => said('POST', '/submit').length === 1, 'the verdict');
  await until(() => /Approved on #12\. m merges it\./.test(lastFrame()), 'the verdict, done');
  assert.deepEqual(said('POST', '/submit')[0].body, { event: 'approve', body: 'LGTM' });

  term.type('t');
  await until(() => /Title: Fix the login bug/.test(lastFrame()), 'the rename sheet');
  term.type('\x15fix: keep next on login\r');
  await until(() => said('PATCH', '/title').length === 1, 'the rename');
  await until(() => /Renamed on GitHub\./.test(lastFrame()), 'the rename, done');
  assert.deepEqual(said('PATCH', '/title')[0].body, { title: 'fix: keep next on login' });

  term.type('m');
  await until(() => /Head is abcdef01, the commit this review read/.test(lastFrame()), 'the merge sheet, from GitHub\'s read');
  term.type('\r');
  await until(() => said('POST', '/merge').length === 1, 'the merge');
  assert.deepEqual(said('POST', '/merge')[0].body, { subject: 'fix: keep next on login (#12)' });
  await until(() => /Merged #12 into main as 12345678/.test(lastFrame()), 'what the merge did');

  // Q&A: every question folded; one opens at a time, with its follow-ups, and a follow-up goes under the one chosen.
  term.type('2');
  await until(() => rows().includes('▸ Why only same-site? 1 follow-up'), 'the folded questions');
  assert.ok(!lastFrame().includes('The page to go back to.'), 'no answer shows until its question opens');
  term.type('\r');
  await until(() => rows().includes('▾ What is next?') && lastFrame().includes('The page to go back to.'), 'the first one open');
  term.type('j\r');
  await until(() => rows().includes('▾ Why only same-site?') && rows().includes('  ▸ What is an open redirect?'), 'the second one open, with its follow-up');
  assert.ok(!lastFrame().includes('The page to go back to.'), 'the first one closed: one at a time');
  // A question is asked where the cursor is: on a question, a follow-up under it.
  term.type('i');
  await until(() => /Follow up on "Why only same-site\?": /.test(lastFrame()), 'the follow-up box');
  term.type('Which hosts count?\r');
  await until(() => said('POST', '/qa/ask').length === 1, 'the follow-up');
  await until(() => /Asked\. It waits for its answer under the question it follows/.test(lastFrame()), 'the follow-up, done');
  await until(() => rows().includes('  ▸ Which hosts count? ⋯ being answered'), 'the follow-up, waiting where it was asked');
  // The last row asks one of your own, at the end.
  term.type('G');
  term.type('\r');
  await until(() => /Your question: /.test(lastFrame()), 'a question of your own');
  term.type('Is there a test?\r');
  await until(() => said('POST', '/qa/ask').length === 2, 'the question of your own');
  assert.deepEqual(said('POST', '/qa/ask')[1].body, { parent: null, question: 'Is there a test?', forDiff: iso(T0) });
  assert.deepEqual(said('POST', '/qa/ask')[0].body, { parent: 'q2', question: 'Which hosts count?', forDiff: iso(T0) });

  term.type('5\r');
  term.type('What does it read?\r');
  await until(() => /It reads next\.[\s\S]*1 step · 2s/.test(lastFrame()), 'the answer');
  assert.deepEqual(said('POST', '/chat')[0].body, { question: 'What does it read?' });

  for (const frame of term.screen().split('\x1b[H').slice(1)) {
    for (const line of stripAnsi(frame).split('\r\n')) assert.ok(width(line) <= 80, `wider than 80 columns: ${line}`);
  }
  term.type('q');
  const out = await done;
  assert.equal(out.code, EXIT.done, out.err);
  assert.equal(term.stdin.raw, false, 'the terminal is given back');
  assert.match(term.screen(), /\x1b\[\?1049l$/);
});
