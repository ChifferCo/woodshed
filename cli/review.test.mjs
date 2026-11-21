import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { fakeGitHub, MANIFEST_PERMISSIONS } from '../console/bin/devReviewSetup.mjs';
import { createCliSignIn } from '../console/cliSignIn.mjs';
import { appGitHub, createReviewSetup } from '../console/reviewSetup.mjs';
import { createHandler } from '../console/server.mjs';
import { createCredentials } from './credentials.mjs';
import { approvalPage, exitFor, outcomeOf } from './review.mjs';
import { EXIT, main } from './woodshed.mjs';

const TEAM_KEY = 'sk-ant-api03-TEAMKEY-never-shown-0123456789';
const { privateKey: APP_KEY } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

// A console with the command line's sign-in and the review setup on a made-up GitHub, bob signed in on this computer
// with woodshed login's token, and ann, an admin of acme/game, in a browser. `whileWaiting` runs at each of the
// command's sleeps, as the approver's browser beside the wait; each sleep moves the clock.
async function consoleFor(t, { repos = { 'acme/game': { admins: ['ann'], writers: ['bob'] } }, withApp = true, fetchFor = null } = {}) {
  const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
  const now = () => clock.t;
  const store = { state: {}, save() {} };
  const cli = createCliSignIn({ store, now });
  const gh = fakeGitHub(repos, { now });
  let handle = null;
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://localhost:${server.address().port}`;
  const config = {
    host: '127.0.0.1', publicUrl: origin, extraHosts: [], repo: 'acme/app', label: 'woodshed', consoleName: 'Acme Woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  let n = 0;
  const reviewSetup = withApp ? createReviewSetup({
    store, github: appGitHub({ appId: '42', privateKey: APP_KEY, fetchImpl: gh.fetch, now }), teamKey: async () => TEAM_KEY,
    publicUrl: origin, newId: () => `${(n += 1)}`.padStart(12, 'a'), now,
  }) : null;
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null) };
  handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, cli, reviewSetup });

  // bob's computer, signed in as woodshed login leaves it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const signIn = (login) => {
    const { deviceCode, userCode } = cli.start({ name: 'bob-laptop' });
    cli.decide({ code: userCode, login, approve: true });
    const { token, id } = cli.poll(deviceCode);
    const kept = credentials.save(origin, token);
    fs.writeFileSync(path.join(dir, 'woodshed', 'cli.json'), JSON.stringify({ current: origin, consoles: { [origin]: { login, store: kept.kind, tokenId: id } } }));
    return { token, id };
  };

  // ann's browser on the request's page: what it shows, then its buttons.
  const page = (p, { method = 'GET', body } = {}) => fetch(`${origin}${p}`, {
    method, headers: { cookie: 'woodshed_session=ann', ...(method === 'POST' ? { 'x-woodshed': '1', origin, 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  const browser = {
    approve: async (id) => page(`/api/review-setup/${id}/approve`, { method: 'POST', body: { digest: (await page(`/api/review-setup/${id}`)).plan.digest } }),
    refuse: (id, reason) => page(`/api/review-setup/${id}/refuse`, { method: 'POST', body: { reason } }),
  };

  const sent = [];
  const run = async (args, { whileWaiting = null } = {}) => {
    let out = '';
    let err = '';
    let sleeps = 0;
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      sleep: async (ms) => { clock.t += ms; sleeps += 1; await whileWaiting?.(sleeps); }, now, platform: 'test', credentials,
      fetch: async (url, init) => {
        sent.push({ url: String(url), headers: init.headers });
        return (fetchFor ?? fetch)(url, init);
      },
    });
    return { code, out, err, sleeps, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  return { origin, run, signIn, browser, store, gh, clock, cli, sent, dir };
}

const requestId = (c) => c.store.state.reviewSetups.at(-1).id;

test('enable asks as the signed-in person, prints the approval page, and waits until it is applied', async (t) => {
  const c = await consoleFor(t);
  c.signIn('bob');
  const run = await c.run(['review', 'enable', 'acme/game'], { whileWaiting: (i) => (i === 3 ? c.browser.approve(requestId(c)) : null) });
  assert.equal(run.code, EXIT.done, run.err);
  const id = requestId(c);
  assert.match(run.out, new RegExp(`An admin of acme/game approves it at:\\n  ${c.origin}/review-setup/${id}\\n`));
  assert.match(run.out, /Waiting for the approval/);
  assert.match(run.out, /done +Add \.github\/workflows\/woodshed-review\.yml on main \(commit [0-9a-f]{7}\)/);
  assert.match(run.out, /Applied: Woodshed's review is on for acme\/game\./);
  assert.deepEqual(c.store.state.reviewSetups[0].by, { login: 'bob' });
  assert.ok(c.gh.repos['acme/game'].files.has('.github/workflows/woodshed-review.yml'), 'the console wrote it, with its own App');
  assert.ok(!run.out.includes(TEAM_KEY) && !run.err.includes(TEAM_KEY), 'the key reaches no output');
  for (const s of c.sent) assert.ok(!('origin' in s.headers), 'the command line never sends an Origin');
});

test('--json says each change: requested, status, each step, done', async (t) => {
  const c = await consoleFor(t);
  c.signIn('bob');
  const run = await c.run(['review', 'enable', '--qa-runner', 'woodshed', 'acme/game', '--json'], { whileWaiting: (i) => (i === 1 ? c.browser.approve(requestId(c)) : null) });
  assert.equal(run.code, EXIT.done, run.err);
  const events = run.lines.map((l) => l.event);
  assert.equal(events[0], 'requested');
  assert.equal(run.lines[0].created, true);
  assert.equal(run.lines[0].qa, 'woodshed');
  assert.equal(run.lines[0].url, `${c.origin}/review-setup/${requestId(c)}`);
  assert.equal(events.at(-1), 'done');
  assert.equal(run.lines.at(-1).outcome, 'applied');
  assert.ok(run.lines.at(-1).steps.length > 0, 'bob can write to the repo, so he reads each step');
  assert.ok(run.lines.every((l) => typeof l === 'object'), 'nothing but JSON on stdout');
  assert.ok(!JSON.stringify(run.lines).includes(TEAM_KEY));
});

test('--no-wait returns at once with 2 and the link; status --wait follows it later', async (t) => {
  const c = await consoleFor(t);
  c.signIn('bob');
  const asked = await c.run(['review', 'enable', '--no-wait', 'acme/game']);
  assert.equal(asked.code, EXIT.waiting);
  assert.equal(asked.sleeps, 0);
  const id = requestId(c);
  assert.match(asked.out, new RegExp(`/review-setup/${id}`));
  assert.match(asked.out, new RegExp(`woodshed review status ${id} --wait`));

  const again = await c.run(['review', 'enable', '--no-wait', 'acme/game', '--json']);
  assert.equal(again.lines[0].created, false, 'asking again answers the request already waiting');
  assert.equal(again.lines[0].id, id);

  const shown = await c.run(['review', 'status', id]);
  assert.equal(shown.code, EXIT.waiting, 'pending is waiting on a person');
  assert.match(shown.out, /Status: +pending/);
  assert.match(shown.out, /Approving it would, on main:/);
  assert.match(shown.out, /Only an admin of acme\/game|admin of the repo/i);

  const followed = await c.run(['review', 'status', id, '--wait'], { whileWaiting: (i) => (i === 2 ? c.browser.approve(id) : null) });
  assert.equal(followed.code, EXIT.done, followed.err);
  assert.match(followed.out, /Applied/);
});

test('refused by an approver is 3, withdrawn too; expired is 2', async (t) => {
  const c = await consoleFor(t, { repos: { 'acme/game': { admins: ['ann'], writers: ['bob'] }, 'acme/tools': { admins: ['ann'], writers: ['bob'] } } });
  c.signIn('bob');
  const refused = await c.run(['review', 'enable', 'acme/game'], { whileWaiting: (i) => (i === 1 ? c.browser.refuse(requestId(c), 'not this repo') : null) });
  assert.equal(refused.code, EXIT.refused);
  assert.match(refused.out, /Refused: refused by @ann: not this repo/);

  const expired = await c.run(['review', 'enable', 'acme/tools', '--json'], { whileWaiting: (i) => { if (i === 1) c.clock.t += 25 * 3_600_000; } });
  assert.equal(expired.code, EXIT.waiting);
  assert.equal(expired.lines.at(-1).outcome, 'expired');
  assert.equal(outcomeOf({ status: 'refused', decidedBy: 'console' }), 'expired');
  assert.equal(exitFor({ status: 'refused', decidedBy: 'ann' }, EXIT), EXIT.refused);
  assert.equal(exitFor({ status: 'failed' }, EXIT), EXIT.failed);
  assert.equal(exitFor({ status: 'applying' }, EXIT), EXIT.waiting);
});

test('a failed request is 1, and says which step and why to someone who can write to the repo', async (t) => {
  const c = await consoleFor(t, { repos: { 'acme/game': { admins: ['ann'], writers: ['bob'], protectedBranch: true } } });
  c.signIn('bob');
  const run = await c.run(['review', 'enable', 'acme/game'], { whileWaiting: (i) => (i === 1 ? c.browser.approve(requestId(c)) : null) });
  assert.equal(run.code, EXIT.failed);
  assert.match(run.out, /Failed: .*woodshed-review\.yml/);
  assert.match(run.out, /a rule on main may refuse the App's commits/);
  assert.match(run.out, new RegExp(`See ${c.origin}/review-setup/`));
});

test('list shows your requests; status --json carries the plan; an id that is not one is refused here', async (t) => {
  const c = await consoleFor(t, { repos: { 'acme/game': { admins: ['ann'], writers: ['bob'] }, 'acme/old': { admins: ['bob'], permissions: MANIFEST_PERMISSIONS } } });
  c.signIn('bob');
  const empty = await c.run(['review', 'list']);
  assert.equal(empty.code, EXIT.done);
  assert.match(empty.out, /no review yet/);
  await c.run(['review', 'enable', '--no-wait', 'acme/game']);
  await c.run(['review', 'enable', '--no-wait', '--qa', 'acme/old']);
  const list = await c.run(['review', 'list']);
  assert.equal(list.code, EXIT.done);
  assert.match(list.lines[0], /^ID +STATUS +QA +ASKED +REPO$/);
  assert.match(list.lines[1], /^aaaaaaaaaaa2 +pending +actions +2026-11-20 10:00 +acme\/old$/, 'newest first');
  assert.match(list.lines[2], /^aaaaaaaaaaa1 +pending +none/);
  const listed = await c.run(['review', 'list', '--json']);
  assert.deepEqual(listed.lines[0].requests.map((r) => r.repo), ['acme/old', 'acme/game']);

  const blocked = await c.run(['review', 'status', 'aaaaaaaaaaa2', '--json']);
  assert.equal(blocked.code, EXIT.waiting);
  assert.equal(blocked.lines[0].canApprove.ok, false);
  assert.match(blocked.lines[0].canApprove.why, /lacks Workflows: write/);
  assert.ok(blocked.lines[0].plan.steps.some((s) => s.text?.includes('uses: ChifferCo/woodshed/.github/workflows/review.yml@')), 'the exact files, for an agent to show');

  const bad = await c.run(['review', 'status', '../../api/my']);
  assert.equal(bad.code, EXIT.failed);
  assert.match(bad.err, /not a request's id/);
  assert.ok(!c.sent.some((s) => s.url.includes('/api/my')), 'nothing was sent for it');
  const unknown = await c.run(['review', 'status', 'bbbbbbbbbbbb']);
  assert.equal(unknown.code, EXIT.failed);
  assert.match(unknown.err, /no request bbbbbbbbbbbb that you can see/);
});

test('not signed in, or the sign-in ended, is 2; a console\'s refusal 3; a console from before review 1', async (t) => {
  const c = await consoleFor(t);
  const out = await c.run(['review', 'list', '--console', c.origin]);
  assert.equal(out.code, EXIT.waiting);
  assert.match(out.err, /not signed in/);

  const { id } = c.signIn('bob');
  c.cli.revoke('bob', id);
  const ended = await c.run(['review', 'enable', 'acme/game']);
  assert.equal(ended.code, EXIT.waiting);
  assert.match(ended.err, /sign-in to .* ended/);

  c.signIn('bob');
  const badRepo = await c.run(['review', 'enable', 'not-a-repo']);
  assert.equal(badRepo.code, EXIT.failed);
  assert.match(badRepo.err, /not owner\/repo/);
  const badRef = await c.run(['review', 'enable', '--ref', 'session-branch', 'acme/game']);
  assert.equal(badRef.code, EXIT.failed);
  assert.match(badRef.err, /not a commit of Woodshed's main/);
  for (let i = 0; i < 5; i++) await c.run(['review', 'enable', '--no-wait', `acme/game${i}`]);
  const tooMany = await c.run(['review', 'enable', '--no-wait', 'acme/more', '--json']);
  assert.equal(tooMany.code, EXIT.refused);
  assert.deepEqual(Object.keys(tooMany.lines[0]).sort(), ['error', 'event', 'status']);
  assert.match(tooMany.lines[0].error, /already wait for approval/);
});

test('a console with no App refuses with 3; one from before woodshed review fails with 1', async (t) => {
  const noApp = await consoleFor(t, { withApp: false });
  noApp.signIn('bob');
  const refused = await noApp.run(['review', 'enable', 'acme/game']);
  assert.equal(refused.code, EXIT.refused);
  assert.match(refused.err, /no GitHub App of its own/);

  // A console from before: the review routes do not take the token, /api/cli/me does.
  const before = await consoleFor(t, {
    fetchFor: (url, init) => (new URL(url).pathname.startsWith('/api/review-setup') ? Promise.resolve(new Response(JSON.stringify({ error: 'sign in' }), { status: 401 })) : fetch(url, init)),
  });
  before.signIn('bob');
  const old = await before.run(['review', 'enable', 'acme/game']);
  assert.equal(old.code, EXIT.failed);
  assert.match(old.err, /from before woodshed review/);
});

test('the approval page printed is always this console\'s', () => {
  const origin = 'https://console.example';
  assert.equal(approvalPage(origin, 'aaaaaaaaaaa1', 'https://console.example/review-setup/aaaaaaaaaaa1?org=acme'), 'https://console.example/review-setup/aaaaaaaaaaa1?org=acme');
  assert.equal(approvalPage(origin, 'aaaaaaaaaaa1', 'https://evil.example/review-setup/aaaaaaaaaaa1'), 'https://console.example/review-setup/aaaaaaaaaaa1');
  assert.equal(approvalPage(origin, 'aaaaaaaaaaa1', 'https://console.example/elsewhere'), 'https://console.example/review-setup/aaaaaaaaaaa1');
  assert.equal(approvalPage(origin, 'aaaaaaaaaaa1', 'https://user:pw@console.example/review-setup/aaaaaaaaaaa1'), 'https://console.example/review-setup/aaaaaaaaaaa1');
  assert.equal(approvalPage(origin, '../x', null), null);
});

test('text the console sends reaches the terminal without escape codes', async (t) => {
  const c = await consoleFor(t);
  c.signIn('bob');
  await c.run(['review', 'enable', '--no-wait', 'acme/game']);
  await c.browser.refuse(requestId(c), 'no\u001b]0;pwned\u0007 ‮thanks');
  const shown = await c.run(['review', 'status', requestId(c)]);
  assert.equal(shown.code, EXIT.refused);
  assert.ok(!/[\u001b\u0007‮]/.test(shown.out), shown.out);
});
