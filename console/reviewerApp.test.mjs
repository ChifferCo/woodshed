import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { REVIEWER_KEY_SECRET, createReviewerApp, reviewerManifest } from './reviewerApp.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { githubApp: { appId: '1' }, publicUrl: 'https://woodshed.example.com', repo: 'Acme/widgets' };
const SHA = 'a'.repeat(40);

function memorySecrets() {
  const values = new Map();
  return { values, async read(name) { return values.get(name) ?? null; }, async save(name, value) { values.set(name, value); } };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

function setup(fetchImpl, { state = {}, secrets = memorySecrets() } = {}) {
  const store = { state, save() {} };
  return { store, secrets, reviewer: createReviewerApp({ store, secrets, config, fetchImpl, now: () => 1_000_000 }) };
}

test('the reviewer manifest asks for pull requests and nothing a session could use to push or sign people in', () => {
  const m = reviewerManifest({ publicUrl: config.publicUrl, repo: config.repo });
  assert.deepEqual(m.default_permissions, { pull_requests: 'write', metadata: 'read' });
  assert.equal(m.redirect_url, 'https://woodshed.example.com/setup/github/reviewer-created');
  assert.equal(m.callback_urls, undefined, 'no sign-in');
  assert.ok(m.name.length <= 34);
});

test('a manifest code is only taken for a state the console started, and keeps the key in the store and the slug in state', async () => {
  const { reviewer, store, secrets } = setup(async () => json(201, { id: 88, slug: 'woodshed-reviewer-acme', pem: privateKey }));
  assert.equal(reviewer.configured(), false);
  await assert.rejects(reviewer.completeManifest({ code: 'abcdef0123456789', state: 'forged' }), /not opened from the console/);
  const state = new URL(reviewer.startManifest({}).url).searchParams.get('state');
  await reviewer.completeManifest({ code: 'abcdef0123456789', state });
  assert.equal(secrets.values.get(REVIEWER_KEY_SECRET), privateKey.trim());
  assert.deepEqual(store.state.reviewerApp, { appId: '88', slug: 'woodshed-reviewer-acme' });
  assert.equal(JSON.stringify(store.state).includes('PRIVATE KEY'), false, 'no key in state.json');
  assert.deepEqual([reviewer.configured(), reviewer.login()], [true, 'woodshed-reviewer-acme[bot]']);
  assert.equal((await reviewer.view()).installUrl, 'https://github.com/apps/woodshed-reviewer-acme/installations/new');
});

test('a review is submitted as the reviewer App, on its installation for the repo, at the reviewed commit', async () => {
  const calls = [];
  const secrets = memorySecrets();
  secrets.values.set(REVIEWER_KEY_SECRET, privateKey);
  const { reviewer } = setup(async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization ?? '' });
    if (url.endsWith('/repos/Acme/widgets/installation')) return json(200, { id: 55 });
    if (url.endsWith('/app/installations/55/access_tokens')) return json(201, { token: 'ghs_reviewer', expires_at: '2030-01-01T00:00:00Z' });
    return json(200, { id: 999 });
  }, { state: { reviewerApp: { appId: '88', slug: 'rev' } }, secrets });
  const id = await reviewer.submitReview({ repo: 'Acme/widgets', number: 7, event: 'APPROVE', body: '## Claude review — APPROVE', sha: SHA });
  assert.equal(id, 999);
  const token = calls.find((c) => c.url.endsWith('/access_tokens'));
  assert.deepEqual(token.body, { repositories: ['widgets'], permissions: { pull_requests: 'write' } }, 'the token can only review, on this repo');
  const review = calls.at(-1);
  assert.equal(review.url, 'https://api.github.com/repos/Acme/widgets/pulls/7/reviews');
  assert.deepEqual(review.body, { commit_id: SHA, event: 'APPROVE', body: '## Claude review — APPROVE' });
  assert.equal(review.auth, 'Bearer ghs_reviewer');
});

test('a review is refused, not sent as anyone else, when the reviewer App has no key or is not installed on the repo', async () => {
  const noKey = setup(async () => assert.fail('nothing is asked of GitHub'), { state: { reviewerApp: { appId: '88', slug: 'rev' } } });
  await assert.rejects(noKey.reviewer.submitReview({ repo: 'Acme/widgets', number: 7, event: 'APPROVE', body: 'x', sha: SHA }), /not set up/);
  const secrets = memorySecrets();
  secrets.values.set(REVIEWER_KEY_SECRET, privateKey);
  const notInstalled = setup(async () => json(404, { message: 'Not Found' }), { state: { reviewerApp: { appId: '88', slug: 'rev' } }, secrets });
  await assert.rejects(notInstalled.reviewer.submitReview({ repo: 'Acme/widgets', number: 7, event: 'APPROVE', body: 'x', sha: SHA }), /not installed on Acme\/widgets/);
});
