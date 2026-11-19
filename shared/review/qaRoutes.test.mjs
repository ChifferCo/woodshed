// node --test review/qaRoutes.test.mjs
//
// The Q&A's routes, from POST /qa to the tree saved on disk, and Discard in the middle of a run.
//
// `claude` is a stand-in first on the PATH, and what it answers is fixed: the newcomer (the run with --system-prompt)
// asks two questions, then one follow-up about the first answer it was shown, and the answerer answers every id the
// prompt lists. So this proves the rounds, the ids, the parents and what is written when, never the quality of a
// question; README.md's warning about stubbing `claude` is about the second, which only a real run shows. A run under
// a `slow` worktree sleeps instead, for Discard to land on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'review-qa-routes-'));
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (process.cwd().endsWith('slow')) setTimeout(() => {}, 60_000);
else {
  const prompt = argv[argv.indexOf('-p') + 1];
  const ids = [...prompt.matchAll(/^--- id: (\\S+)$/gm)].map((m) => m[1]);
  let out;
  if (!argv.includes('--system-prompt')) out = { answers: ids.map((id) => ({ id, answer: 'Answer to ' + id + '.' })) };
  else if (!ids.length) out = { questions: ['What is a webhook?', 'Why retry?'] };
  else out = { questions: [{ about: ids[0], question: 'What does that word mean?' }] };
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.001, structured_output: out }));
}
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.WOODSHED_REVIEWS = path.join(DIR, 'reviews');

const { handleReviewRequest } = await import('./index.mjs');
const { writeSessionReview, writeDiff, readQa } = await import('./store.mjs');

function makeReview(session, worktree, createdAt = '2026-11-19T10:00:00.000Z') {
  fs.mkdirSync(worktree, { recursive: true });
  writeSessionReview({
    session,
    review: { kind: 'worktree', worktree, headSha: 'abc123', createdAt, meta: { title: 'Retry webhooks', body: 'They give up.' } },
  });
  writeDiff({ session, diff: { files: [{ path: 'src/a.mjs', additions: 3, deletions: 1, status: 'modified', hunks: [] }] } });
}

async function call(method, url) {
  const res = { status: 0, body: null };
  const ctx = {
    reqId: 'test', log: () => {},
    json: (_res, status, body) => { res.status = status; res.body = body; },
  };
  await handleReviewRequest({ method, url, headers: {} }, {}, ctx);
  return res;
}

async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = check();
    if (got) return got;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting');
}

test('POST /qa runs the rounds and saves the tree: questions, a follow-up, its follow-up, each answered', async () => {
  const session = 'claude-2c2c2c2c';
  makeReview(session, path.join(DIR, 'fast'));
  assert.deepEqual((await call('GET', `/reviews/${session}/qa`)).body.qa, null);
  const started = await call('POST', `/reviews/${session}/qa`);
  assert.deepEqual([started.status, started.body.status], [200, 'running']);
  // A second press while it runs joins it rather than starting another.
  assert.equal((await call('POST', `/reviews/${session}/qa`)).body.status, 'running');

  const qa = await until(() => { const q = readQa(session); return q?.status === 'ready' ? q : null; });
  assert.deepEqual(
    qa.items.map((i) => [i.id, i.parent, i.depth, i.answer]),
    [
      ['q1', null, 1, 'Answer to q1.'],
      ['q2', null, 1, 'Answer to q2.'],
      ['q1.1', 'q1', 2, 'Answer to q1.1.'],
      ['q1.1.1', 'q1.1', 3, 'Answer to q1.1.1.'],
    ],
  );
  assert.equal(qa.stoppedEarly, null);
  assert.ok(qa.costUsd > 0);
  assert.equal((await call('GET', `/reviews/${session}/qa`)).body.qa.items.length, 4);

  // A re-review takes a new diff. Its delete of qa.json can fail (it is only logged), so a Q&A left on disk is read
  // as none against the diff that replaced the one it answered about.
  makeReview(session, path.join(DIR, 'fast'), '2026-11-19T11:00:00.000Z');
  assert.equal(readQa(session).items.length, 4, 'the file is still there');
  assert.equal((await call('GET', `/reviews/${session}/qa`)).body.qa, null);
});

test('Discard during a run stops it, and nothing it was doing is written back', async () => {
  const session = 'claude-3d3d3d3d';
  makeReview(session, path.join(DIR, 'slow'));
  await call('POST', `/reviews/${session}/qa`);
  await until(() => readQa(session)?.status === 'running');

  assert.equal((await call('POST', `/reviews/${session}/discard`)).status, 200);
  assert.equal(readQa(session), null);
  // The cancelled newcomer's process closes after the discard; its round must not write the tree back.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(readQa(session), null);
  assert.equal((await call('GET', `/reviews/${session}/qa`)).body.qa, null);
  // And the session can be asked again.
  assert.equal((await call('POST', `/reviews/${session}/qa`)).body.status, 'running');
  await call('POST', `/reviews/${session}/discard`);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
