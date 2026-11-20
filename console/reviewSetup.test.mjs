import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ALL_PERMISSIONS, MANIFEST_PERMISSIONS, WOODSHED_MAIN, fakeGitHub } from './bin/devReviewSetup.mjs';
import {
  QA_WORKFLOW, REQUEST_TTL_MS, REVIEW_WORKFLOW, appGitHub, createReviewSetup, createReviewSetupApi, missingPermissions, parseRequest,
  qaWorkflow, reviewSetupRoute, reviewWorkflow,
} from './reviewSetup.mjs';
import { createSessionApi } from './sessionApi.mjs';

const TEAM_KEY = 'sk-ant-api03-TEAMKEY-never-shown-0123456789';
const { privateKey: APP_KEY } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

// Everything the console printed while `fn` ran, so a test can say the key never reached a log.
async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(saved)) console[name] = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

function setup({ repos = { 'acme/game': { admins: ['ann'], writers: ['bob'] } }, teamKey = TEAM_KEY, clock = { t: Date.parse('2026-11-20T10:00:00Z') } } = {}) {
  const gh = fakeGitHub(repos);
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  let n = 0;
  const reviewSetup = createReviewSetup({
    store, github: appGitHub({ appId: '42', privateKey: APP_KEY, fetchImpl: gh.fetch, now: () => clock.t }),
    teamKey: async () => teamKey, publicUrl: 'https://console.example', newId: () => `${(n += 1)}`.padStart(12, 'a'), now: () => clock.t,
  });
  return { gh, store, reviewSetup, clock };
}

const SESSION = { id: 'abcd1234', title: 'Set up acme/game', owner: 'ann', status: 'running', token: 'session-token-1' };

test('a request is a repo, whether QA comes and where it runs, and a ref, as the script\'s flags are', () => {
  assert.deepEqual(parseRequest({ repo: 'acme/game' }), { repo: 'acme/game', qa: 'none', ref: null });
  assert.deepEqual(parseRequest({ repo: 'acme/game', qa: true }), { repo: 'acme/game', qa: 'actions', ref: null });
  assert.deepEqual(parseRequest({ repo: 'acme/game', qaRunner: 'woodshed', ref: 'v1.2.3' }), { repo: 'acme/game', qa: 'woodshed', ref: 'v1.2.3' });
  for (const bad of [{}, { repo: 'acme' }, { repo: 'acme/game/x' }, { repo: '../x/y' }]) assert.throws(() => parseRequest(bad), /owner\/name/);
  assert.throws(() => parseRequest({ repo: 'a/b', qaRunner: 'lambda' }), /actions or woodshed/);
  assert.throws(() => parseRequest({ repo: 'a/b', ref: 'main;rm -rf' }), /ref must be/);
  assert.throws(() => parseRequest({ repo: 'a/b', ref: '../../x' }), /ref must be/);
  assert.deepEqual(reviewSetupRoute('/api/review-setup/aaaaaaaaaaa1/approve'), { id: 'aaaaaaaaaaa1', action: 'approve' });
  assert.equal(reviewSetupRoute('/api/review-setup/x/approve'), null);
});

test('the workflows are the ones scripts/enable-review.sh writes, byte for byte', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written = path.join(dir, 'written');
  fs.mkdirSync(path.join(dir, 'bin'));
  // A gh that saves what the script writes, and answers the few reads it makes.
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
args=("$@")
case "$*" in
  "auth status"*) exit 0 ;;
  "repo view "*) echo main ; exit 0 ;;
  "secret list"*) echo "ANTHROPIC_API_KEY x" ; exit 0 ;;
esac
if [[ "$*" == *--method\\ PUT*contents* ]]; then
  for ((i=0; i<\${#args[@]}; i++)); do
    case "\${args[i]}" in repos/*/contents/*) p="\${args[i]#*/contents/}" ;; content=*) c="\${args[i]#content=}" ;; esac
  done
  mkdir -p "${written}/$(dirname "$p")"; printf '%s' "$c" | base64 -d > "${written}/$p"; exit 0
fi
[[ "$*" == api*contents* ]] && exit 1
exit 0
`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(import.meta.dirname, '..', 'scripts', 'enable-review.sh'), 'acme/game', '--qa', '--ref', 'deadbeefcafe'], {
    encoding: 'utf8', env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(reviewWorkflow('deadbeefcafe'), fs.readFileSync(path.join(written, REVIEW_WORKFLOW), 'utf8'));
  assert.equal(qaWorkflow('deadbeefcafe'), fs.readFileSync(path.join(written, QA_WORKFLOW), 'utf8'));
});

test('a session asks, an admin of the repo approves, and the console applies it with its App and key', async () => {
  const { gh, reviewSetup } = setup();
  const { request, created } = await reviewSetup.create(parseRequest({ repo: 'acme/game', qa: true }), { session: SESSION });
  assert.equal(created, true);
  const status = reviewSetup.statusOf(request);
  assert.deepEqual([status.status, status.ref, status.url], ['pending', WOODSHED_MAIN, 'https://console.example/review-setup/aaaaaaaaaaa1']);
  assert.deepEqual(request.by, { session: 'abcd1234', title: 'Set up acme/game', person: 'ann', private: true });

  const page = await reviewSetup.view(request, 'ann', { consoleAdmin: true });
  assert.deepEqual(page.canApprove, { ok: true, why: null });
  assert.deepEqual(page.plan.steps.map((s) => [s.key, s.change]), [
    ['review-workflow', true], ['qa-workflow', true], ['qa-label', true], ['approvals', true], ['secret', true],
  ]);
  assert.match(page.plan.steps[0].text, new RegExp(`review\\.yml@${WOODSHED_MAIN}`), 'the page shows the exact file, pinned');
  assert.equal(page.plan.setsKey, true);

  const { lines } = await captureLogs(() => reviewSetup.approve(request, 'ann', { consoleAdmin: true }));
  assert.equal(request.status, 'applied', request.why);
  const repo = gh.repos['acme/game'];
  assert.equal(repo.files.get(REVIEW_WORKFLOW).text, reviewWorkflow(WOODSHED_MAIN));
  assert.equal(repo.files.get(QA_WORKFLOW).text, qaWorkflow(WOODSHED_MAIN));
  assert.ok(repo.labels.has('woodshed-qa'));
  assert.deepEqual(repo.workflow, { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }, 'the default level is kept');
  assert.equal(gh.openSecret('acme/game', 'ANTHROPIC_API_KEY'), TEAM_KEY, 'GitHub holds the team key, sealed to the repo');
  assert.deepEqual(request.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(request.history.map((h) => [h.what, h.by]), [['asked', 'session abcd1234'], ['approved', 'ann'], ['applied', 'ann']]);

  const commit = gh.calls.find((c) => c.method === 'PUT' && c.path.endsWith('woodshed-review.yml'));
  assert.match(JSON.parse(commit.body).message, /^ci: enable Woodshed review\n\nApproved by @ann on the Woodshed console \(request aaaaaaaaaaa1\)\.$/);
  // The token the console wrote with was narrowed to the steps' needs, and asked for nothing else.
  const minted = gh.calls.filter((c) => c.path.endsWith('/access_tokens')).map((c) => JSON.parse(c.body).permissions);
  assert.ok(minted.some((p) => p.workflows === 'write' && p.secrets === 'write' && p.administration === 'write' && !p.pull_requests));

  const everything = [
    ...gh.calls.map((c) => c.body), ...lines, JSON.stringify(reviewSetup.statusOf(request)),
    JSON.stringify(await reviewSetup.view(request, 'ann', { consoleAdmin: true })),
  ].join('\n');
  assert.ok(!everything.includes(TEAM_KEY), 'the key is in no call, log line or answer');
  assert.ok(!everything.includes(Buffer.from(TEAM_KEY).toString('base64')), 'nor its base64');
  assert.ok(lines.some((l) => l.includes('reviewSetup: Anthropic key set as an Actions secret')));
});

test('an App made from the console\'s manifest is told plainly what it lacks, and nothing is written', async () => {
  const { gh, reviewSetup } = setup({ repos: { 'acme/game': { admins: ['ann'], permissions: MANIFEST_PERMISSIONS } } });
  const { request } = await reviewSetup.create(parseRequest({ repo: 'acme/game' }), { login: 'ann' });
  const page = await reviewSetup.view(request, 'ann', { consoleAdmin: true });
  assert.equal(page.canApprove.ok, false);
  assert.match(page.canApprove.why, /lacks Workflows: write, Administration: write, Secrets: write\. Add them in the App's settings on GitHub/);
  assert.deepEqual(page.plan.steps.find((s) => s.key === 'review-workflow').missing, ['Workflows: write']);
  await assert.rejects(reviewSetup.approve(request, 'ann', { consoleAdmin: true }), (err) => err.status === 409 && /Workflows: write/.test(err.message));
  assert.equal(request.status, 'pending', 'it waits for the App to be given them');
  assert.ok(!gh.calls.some((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens')), 'no write was tried');
  assert.deepEqual(missingPermissions({ contents: 'read' }, { contents: 'write', metadata: 'read' }), ['Contents: write', 'Metadata: read']);
});

test('only an admin of the repo approves, and the team key needs a console admin too', async () => {
  const { reviewSetup } = setup({ repos: { 'acme/game': { admins: ['ann'], writers: ['bob'] }, 'acme/keyed': { admins: ['ann'], secrets: ['ANTHROPIC_API_KEY'] } } });
  const { request } = await reviewSetup.create(parseRequest({ repo: 'acme/game' }), { session: SESSION });
  assert.match((await reviewSetup.view(request, 'bob', { consoleAdmin: true })).canApprove.why, /Only an admin of acme\/game on GitHub may approve this, and @bob is not one/);
  assert.match((await reviewSetup.view(request, 'eve', { consoleAdmin: true })).canApprove.why, /@eve is not one/);
  assert.match((await reviewSetup.view(request, 'ann', { consoleAdmin: false })).canApprove.why, /console's own Anthropic key .* a console admin approves it/);
  assert.match((await reviewSetup.view(request, null, { consoleAdmin: true })).canApprove.why, /no sign-in/);
  await assert.rejects(reviewSetup.approve(request, 'bob', { consoleAdmin: true }), (err) => err.status === 403);
  assert.equal(request.status, 'pending');

  // A repo that has its own key keeps it, and then a repo admin alone approves.
  const keyed = (await reviewSetup.create(parseRequest({ repo: 'acme/keyed' }), { session: SESSION })).request;
  const page = await reviewSetup.view(keyed, 'ann', { consoleAdmin: false });
  assert.equal(page.plan.setsKey, false);
  assert.match(page.plan.steps.find((s) => s.key === 'secret').what, /already set on acme\/keyed, and is left as it is/);
  await reviewSetup.approve(keyed, 'ann', { consoleAdmin: false });
  assert.equal(keyed.status, 'applied');
  assert.equal(keyed.steps.find((s) => s.key === 'secret').state, 'kept');
});

test('no team key, the App not installed, or a branch rule: each is said, and a failure says which step', async () => {
  const noKey = setup({ teamKey: null });
  const a = (await noKey.reviewSetup.create(parseRequest({ repo: 'acme/game' }), { login: 'ann' })).request;
  assert.match((await noKey.reviewSetup.view(a, 'ann', { consoleAdmin: true })).canApprove.why, /no Anthropic key to set: an admin sets anthropic-api-key/);

  const missing = setup({ repos: { 'acme/game': { installed: false } } });
  const b = (await missing.reviewSetup.create(parseRequest({ repo: 'acme/game' }), { login: 'ann' })).request;
  assert.match((await missing.reviewSetup.view(b, 'ann', { consoleAdmin: true })).canApprove.why, /not installed on acme\/game/);

  const ruled = setup({ repos: { 'acme/game': { admins: ['ann'], protectedBranch: true } } });
  const c = (await ruled.reviewSetup.create(parseRequest({ repo: 'acme/game' }), { login: 'ann' })).request;
  await ruled.reviewSetup.approve(c, 'ann', { consoleAdmin: true });
  assert.equal(c.status, 'failed');
  assert.match(c.why, /^Add \.github\/workflows\/woodshed-review\.yml on main: GitHub refused writing .* HTTP 409 Repository rule violations found \(a rule on main may refuse the App's commits\)$/);
  assert.deepEqual(c.steps.map((s) => s.state), ['failed', 'next', 'next']);
});

test('the session runner removes CI\'s QA workflow and writes none, and what is already so is left', async () => {
  const { gh, reviewSetup } = setup({
    repos: { 'acme/game': { admins: ['ann'], files: { [QA_WORKFLOW]: 'old', [REVIEW_WORKFLOW]: reviewWorkflow('v1') }, labels: ['woodshed-qa'], canApprove: true } },
  });
  const { request } = await reviewSetup.create(parseRequest({ repo: 'acme/game', qaRunner: 'woodshed', ref: 'v1' }), { login: 'ann' });
  const page = await reviewSetup.view(request, 'ann', { consoleAdmin: true });
  assert.deepEqual(page.plan.steps.map((s) => [s.key, s.change]), [
    ['review-workflow', false], ['qa-workflow-removed', true], ['qa-label', false], ['approvals', false], ['secret', true],
  ]);
  await reviewSetup.approve(request, 'ann', { consoleAdmin: true });
  assert.equal(request.status, 'applied', request.why);
  assert.ok(!gh.repos['acme/game'].files.has(QA_WORKFLOW));
  assert.ok(!gh.calls.some((c) => c.method === 'PUT' && c.path.includes('/contents/')), 'the review workflow was already this');
});

test('who may ask: not a question, QA run, review or tainted session; the same ask twice is one request; a few at once', async () => {
  const { reviewSetup } = setup();
  const options = parseRequest({ repo: 'acme/game' });
  for (const session of [{ ...SESSION, kind: 'ask' }, { ...SESSION, qa: { number: 1 } }, { ...SESSION, review: { number: 1 } }]) {
    await assert.rejects(reviewSetup.create(options, { session }), (err) => err.status === 403 && /cannot ask for changes/.test(err.message));
  }
  await assert.rejects(reviewSetup.create(options, { session: { ...SESSION, taintedAt: '2026-11-20T09:00:00Z' } }), /production data/);
  const first = await reviewSetup.create(options, { session: SESSION });
  const again = await reviewSetup.create(options, { session: SESSION });
  assert.equal(again.created, false);
  assert.equal(again.request, first.request);
  for (const name of ['b', 'c', 'd', 'e']) await reviewSetup.create(parseRequest({ repo: `acme/${name}` }), { session: SESSION });
  await assert.rejects(reviewSetup.create(parseRequest({ repo: 'acme/f' }), { session: SESSION }), (err) => err.status === 429);
});

test('a request expires after a day, can be withdrawn, and one cut off mid-apply is failed at the next start', async () => {
  const { reviewSetup, clock, store } = setup();
  const { request } = await reviewSetup.create(parseRequest({ repo: 'acme/game' }), { session: SESSION });
  clock.t += REQUEST_TTL_MS + 1;
  assert.equal(reviewSetup.find(request.id).status, 'refused');
  assert.match(request.why, /^expired/);
  await assert.rejects(reviewSetup.approve(request, 'ann', { consoleAdmin: true }), (err) => err.status === 409);

  const other = (await reviewSetup.create(parseRequest({ repo: 'acme/other' }), { login: 'ann' })).request;
  reviewSetup.refuse(other, 'ann', 'not yet');
  assert.equal(other.why, 'withdrawn by @ann: not yet');

  store.state.reviewSetups.push({ ...other, id: 'bbbbbbbbbbbb', status: 'applying', history: [] });
  createReviewSetup({ store, github: null, teamKey: async () => null, publicUrl: 'x' });
  assert.equal(store.state.reviewSetups.at(-1).status, 'failed');
  assert.match(store.state.reviewSetups.at(-1).why, /console stopped while applying/);
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('the session API: a session asks and follows its own request, and never another\'s', async (t) => {
  const { reviewSetup } = setup();
  const other = { ...SESSION, id: 'ffff0000', token: 'session-token-2' };
  const api = createSessionApi({ fleet: { sessions: () => [SESSION, other] }, tokens: null, reviewSetup });
  const base = await serve(t, (req, res) => api(req, res));
  const post = (p, body, token = SESSION.token) => fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const made = await post('/review-setup', { repo: 'acme/game', qa: true });
  assert.equal(made.status, 201);
  const { id, status, url } = await made.json();
  assert.deepEqual([status, url], ['pending', `https://console.example/review-setup/${id}`]);
  assert.equal((await post('/review-setup/status', { id })).status, 200);
  assert.equal((await post('/review-setup/status', { id }, other.token)).status, 404);
  assert.equal((await post('/review-setup', { repo: 'acme/game' }, 'nobody')).status, 401);
  assert.equal((await post('/review-setup', { repo: 'nope' })).status, 400);

  await reviewSetup.approve(reviewSetup.find(id), 'ann', { consoleAdmin: true });
  const answer = await (await post('/review-setup/status', { id })).json();
  assert.equal(answer.status, 'applied');
  assert.ok(!JSON.stringify(answer).includes(TEAM_KEY));
});

test('the signed-in API: anyone asks and reads; the page\'s approve answers with the outcome', async (t) => {
  const { reviewSetup } = setup();
  const handle = createReviewSetupApi({ reviewSetup });
  const base = await serve(t, (req, res) => {
    const url = new URL(req.url, 'http://x');
    handle(req, res, { route: reviewSetupRoute(url.pathname), login: req.headers['x-login'] || null, admin: req.headers['x-admin'] === '1' });
  });
  const call = (p, { method = 'GET', body, login = 'ann', admin = true } = {}) => fetch(`${base}${p}`, {
    method, headers: { 'x-login': login, 'x-admin': admin ? '1' : '0' }, body: body && JSON.stringify(body),
  });
  const made = await call('/api/review-setup', { method: 'POST', body: { repo: 'acme/game' }, login: 'bob', admin: false });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  assert.equal((await (await call('/api/review-setup')).json()).requests[0].id, id);
  assert.equal((await call(`/api/review-setup/${id}/approve`, { method: 'POST', body: {}, login: 'bob', admin: false })).status, 403);
  assert.equal((await call(`/api/review-setup/${id}/refuse`, { method: 'POST', body: {}, login: 'eve', admin: false })).status, 403, 'a stranger refuses nothing');
  const approved = await (await call(`/api/review-setup/${id}/approve`, { method: 'POST', body: {} })).json();
  assert.equal(approved.status, 'applied');
  assert.equal((await call('/api/review-setup/aaaaaaaaaaa9')).status, 404);
});
