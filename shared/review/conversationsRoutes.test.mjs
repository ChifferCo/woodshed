import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../../test/isolatedEnv.mjs';

test('bulk resolution rechecks both pages of the reviewed PR and resolves only eligible displayed threads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-conversations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnv();
  env.PATH = `${root}:${env.PATH}`;
  env.WOODSHED_REVIEWS = path.join(root, 'reviews');
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
    thread.isResolved = true;
    ids.push(id);
    data[alias] = { thread: { isResolved: true } };
  }
  state.mutations.push(ids);
  fs.writeFileSync(statePath, JSON.stringify(state));
}
console.log(JSON.stringify({ data }));
`, { mode: 0o755 });

  // The route spawns Git and gh itself. Give this test worker's route the
  // same isolated environment as the setup commands.
  const originalEnv = process.env;
  process.env = env;
  t.after(() => { process.env = originalEnv; });
  const { handleReviewRequest } = await import('./index.mjs');
  const { writeSessionReview } = await import('./store.mjs');
  const session = 'claude-1234abcd';
  writeSessionReview({ session, review: { kind: 'pr', pr: 42 } });

  async function call(method, payload) {
    const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]);
    req.method = method;
    req.url = `/reviews/${session}/conversations`;
    const res = {};
    assert.equal(await handleReviewRequest(req, res, {
      repoRoot: repo, reqId: 'test', log() {},
      json: (res, status, body) => Object.assign(res, { status, body }),
    }), true);
    return res;
  }

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
  fresh.pages[1].push(thread('new-since-listing'));
  save(fresh);
  const ids = [...listed.body.threads.map((thread) => thread.id), 'unknown', 'already-resolved', 'pending'];
  assert.deepEqual(await call('POST', { ids }), { status: 200, body: { ok: true } });
  assert.deepEqual(read().mutations, [['first', 'outdated']]);

  const remaining = await call('GET');
  assert.equal(remaining.status, 200);
  assert.deepEqual(remaining.body.threads.map((thread) => thread.id), ['read-only', 'new-since-listing']);
});
