import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createReviewHost } from '../session/reviewShed/host.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from './isolatedEnv.mjs';

test('bulk resolution rechecks both pages of the reviewed PR and resolves only eligible displayed threads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-conversations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnv();
  env.PATH = `${root}:${env.PATH}`;
  env.WOODSHED_REVIEWS = path.join(root, 'reviews');
  delete env.GH_TOKEN;
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo], { env });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/project.git'], { env });
  const statePath = path.join(root, 'state.json');
  const thread = (id, options = {}, state = 'SUBMITTED') => ({
    id, path: 'src/app.mjs', line: 10, isResolved: false, isOutdated: false, viewerCanResolve: true,
    comments: { nodes: [{ state, body: id, author: { login: 'reviewer' } }] },
    ...options,
  });
  const pages = [
    [thread('first'), thread('read-only', { viewerCanResolve: false }),
      thread('already-resolved', { isResolved: true }), thread('pending', {}, 'PENDING')],
    [thread('outdated', { isOutdated: true, line: null, originalLine: 7 })],
  ];
  const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
  const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  save({ pages, mutations: [] });

  fs.writeFileSync(path.join(root, 'gh'), String.raw`#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(process.env.HC_TERMINAL_ID, undefined);
assert.equal(process.env.HC_TERMINAL_SOCKET, undefined);
assert.equal(process.env.HC_SESSION, 'test');
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const [api, graphql, ...args] = process.argv.slice(2);
const credential = process.env.GH_TOKEN || (state.disconnected ? 'installation' : 'personal');
if (api === 'auth' && graphql === 'token') {
  console.log(credential);
  process.exit(0);
}
if (api === 'api' && graphql === 'user') {
  if (credential !== 'personal') process.exit(1);
  console.log('octocat');
  process.exit(0);
}
assert.deepEqual([api, graphql], ['api', 'graphql']);
const fields = {};
for (let i = 0; i < args.length; i += 2) {
  const [key, ...parts] = args[i + 1].split('=');
  if (key.startsWith('id')) assert.equal(args[i], '-f');
  fields[key] = parts.join('=');
}
let data;
if (fields.query.includes('reviewThreads')) {
  assert.deepEqual([fields.owner, fields.repo, fields.pr], ['example', 'project', '42']);
  assert.ok(fields.cursor === undefined || fields.cursor === 'next-page');
  const second = fields.cursor === 'next-page';
  if (state.disconnectOnRead) {
    state.disconnectOnRead = false;
    state.disconnected = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  if (second && state.disconnected && !state.mutations.length) assert.equal(process.env.GH_TOKEN, 'personal');
  data = { repository: { pullRequest: { state: 'OPEN', reviewThreads: {
    nodes: state.pages[second ? 1 : 0],
    pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next-page' },
  } } } };
} else {
  const selections = [...fields.query.matchAll(/(id\d+):resolveReviewThread\(input:\{threadId:\$(id\d+)\}\)/g)];
  assert.ok(selections.length, 'expected at least one resolution');
  data = {};
  const ids = [];
  for (const [, alias, variable] of selections) {
    assert.equal(alias, variable);
    const id = fields[variable];
    const thread = state.pages.flat().find((t) => t.id === id);
    assert.ok(thread, 'the mutation must name a thread on this PR');
    ids.push(id);
    if (id === state.unconfirmed) continue;
    thread.isResolved = true;
    data[alias] = { thread: { isResolved: true } };
  }
  state.mutations.push(ids);
  state.writeCredential = credential;
  fs.writeFileSync(statePath, JSON.stringify(state));
}
console.log(JSON.stringify({ data }));
`, { mode: 0o755 });

  // The route spawns Git and gh itself. Give this test worker's route the
  // same isolated environment as the setup commands.
  const originalEnv = process.env;
  process.env = env;
  t.after(() => { process.env = originalEnv; });
  const { handleReviewRequest } = await import('../shared/review/index.mjs');
  const { writeSessionReview } = await import('../shared/review/store.mjs');
  const session = 'claude-1234abcd';
  writeSessionReview({ session, review: { kind: 'pr', pr: 42 } });

  const { ghAccount } = await import('../shared/review/github.mjs');
  const host = createReviewHost({
    repoDir: repo, sessionId: '1234abcd', sessionKind: 'private', checkoutBranch: async () => '',
    load: async () => ({
      ghAccount, handleReviewRequest, ensureWorktreeReview: async () => ({ ok: true }),
      startReviewAnalysisIfNone: () => false, startReviewQaIfNone: () => false,
    }),
  });
  const server = http.createServer((req, res) => host.handle(req, res).catch(() => { res.writeHead(500); res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/shed-review/reviews/${session}`;
  async function call(method, payload, suffix = '/conversations') {
    const response = await fetch(base + suffix, {
      method, body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }

  assert.equal((await call('GET', undefined, '')).status, 200);
  assert.equal(await ghAccount(), 'octocat');
  const listed = await call('GET');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.threads.map(({ id, canResolve }) => [id, canResolve]),
    [['first', true], ['read-only', false], ['outdated', true]]);
  assert.equal(listed.body.threads[2].outdated, true);
  assert.equal(listed.body.threads[2].line, 7);
  for (const body of [{}, { ids: [] }]) {
    assert.equal((await call('POST', body)).status, 400);
  }
  assert.deepEqual(read().mutations, []);

  const fresh = read();
  fresh.disconnectOnRead = true;
  fresh.pages[1].push(thread('new-since-listing'));
  save(fresh);
  const ids = [...listed.body.threads.map((thread) => thread.id), 'unknown', 'already-resolved', 'pending'];
  assert.deepEqual(await call('POST', { ids }), { status: 200, body: { ok: true } });
  assert.deepEqual(read().mutations, [['first', 'outdated']]);
  assert.equal(read().writeCredential, 'personal', 'mutation retained the verified credential when the default switched');
  assert.equal((await call('POST', { ids: ['new-since-listing'] })).status, 403);
  assert.deepEqual(read().mutations, [['first', 'outdated']], 'a new POST after disconnect sends no mutation');

  const remaining = await call('GET');
  assert.equal(remaining.status, 200);
  assert.deepEqual(remaining.body.threads.map((thread) => thread.id), ['read-only', 'new-since-listing']);

  // Reconnect and leave the final alias unconfirmed in a second batch.
  const large = read();
  const batch = Array.from({ length: 51 }, (_, i) => thread('batch-' + i));
  const batchIds = batch.map((t) => t.id);
  Object.assign(large, { disconnected: false, pages: [batch.slice(0, 50), batch.slice(50)], unconfirmed: batchIds.at(-1) });
  save(large);
  const partial = await call('POST', { ids: batchIds });
  assert.equal(partial.status, 502);
  assert.equal(partial.body.reason, 'unconfirmed-resolution');
  assert.deepEqual(read().mutations.slice(1), [batchIds.slice(0, 50), batchIds.slice(50)]);
  const afterPartial = await call('GET');
  assert.deepEqual(afterPartial.body.threads.map((t) => t.id), [batchIds.at(-1)]);
});
