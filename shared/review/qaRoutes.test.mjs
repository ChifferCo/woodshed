// node --test review/qaRoutes.test.mjs
//
// The Q&A's routes, from POST /qa to the tree saved on disk, and Discard in the middle of a run.
//
// `claude` is a stand-in first on the PATH, and what it answers is fixed: the newcomer (the run with --system-prompt)
// asks two questions, then one follow-up about the first answer it was shown, and the answerer answers every id the
// prompt lists. So this proves the rounds, the ids, the parents and what is written when, never the quality of a
// question; README.md's warning about stubbing `claude` is about the second, which only a real run shows. A run under
// a `slow` worktree sleeps instead, for Discard to land on.

import { execFileSync } from 'node:child_process';
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
  if (!argv.includes('--system-prompt')) {
    // The answerer quotes a.txt from the folder it runs in, so a test can see which copy of the code it read.
    let seen = '';
    try { seen = require('node:fs').readFileSync('a.txt', 'utf8').trim(); } catch {}
    out = { answers: ids.map((id) => ({ id, answer: 'Answer to ' + id + '.' + (seen ? ' a.txt: ' + seen : '') })) };
  }
  else if (!ids.length) out = { questions: ['What is a webhook?', 'Why retry?'] };
  else out = { questions: [{ about: ids[0], question: 'What does that word mean?' }] };
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.001, structured_output: out }));
}
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.WOODSHED_REVIEWS = path.join(DIR, 'reviews');

const { handleReviewRequest, failedQaRecord } = await import('./index.mjs');
const { writeSessionReview, writeDiff, readQa } = await import('./store.mjs');

// A worktree review of a real checkout, whose snapshot is the commit made here: what the diff was taken from.
function makeReview(session, worktree, createdAt = '2026-11-19T10:00:00.000Z', { aTxt } = {}) {
  fs.mkdirSync(worktree, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', worktree, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  if (!fs.existsSync(path.join(worktree, '.git'))) git('init', '-q');
  if (aTxt !== undefined) fs.writeFileSync(path.join(worktree, 'a.txt'), aTxt);
  fs.writeFileSync(path.join(worktree, 'src.mjs'), `// ${createdAt}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'snapshot');
  const snapshot = git('rev-parse', 'HEAD');
  writeSessionReview({
    session,
    review: { kind: 'worktree', worktree, headSha: snapshot, snapshot, createdAt, meta: { title: 'Retry webhooks', body: 'They give up.' } },
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

test('a page asking about a diff that was replaced is refused, and nothing is started', async () => {
  const session = 'claude-4e4e4e4e';
  makeReview(session, path.join(DIR, 'fast'), '2026-11-19T12:00:00.000Z');
  const stale = await call('POST', `/reviews/${session}/qa?forDiff=${encodeURIComponent('2026-11-19T10:00:00.000Z')}`);
  assert.deepEqual([stale.status, stale.body.code], [409, 'other-diff']);
  assert.equal(readQa(session), null, 'no run was started');
  const current = await call('POST', `/reviews/${session}/qa?forDiff=${encodeURIComponent('2026-11-19T12:00:00.000Z')}`);
  assert.equal(current.body.status, 'running');
  await until(() => readQa(session)?.status === 'ready');
});

// What a crashed run writes. A crash before the first save must still say which diff it failed for, or GET /qa reads
// it as another diff's and the failure is hidden; and a file left from an older diff must never be relabelled as this
// one's, or its answers show against code they are not about.
test('a crashed run leaves a failure for its own diff, and never takes over another diff\'s answers', () => {
  const review = { createdAt: '2026-11-19T12:00:00.000Z' };
  const err = new Error('ENOSPC: no space left');
  assert.deepEqual(failedQaRecord({ saved: null, review, err }),
    { items: [], forDiff: review.createdAt, status: 'failed', phase: null, error: 'ENOSPC: no space left' });
  const older = { forDiff: '2026-11-19T10:00:00.000Z', status: 'ready', items: [{ id: 'q1', answer: 'about old code' }] };
  assert.deepEqual(failedQaRecord({ saved: older, review, err }).items, []);
  const own = { forDiff: review.createdAt, status: 'running', items: [{ id: 'q1', answer: 'kept' }] };
  assert.deepEqual(failedQaRecord({ saved: own, review, err }).items, own.items);
});

test('the diff says which review it belongs to, read with it', async () => {
  const session = 'claude-6a6a6a6a';
  makeReview(session, path.join(DIR, 'fast'), '2026-11-19T13:00:00.000Z');
  const got = await call('GET', `/reviews/${session}/diff`);
  assert.equal(got.body.createdAt, '2026-11-19T13:00:00.000Z');
});

// The answers are about the diff on screen. Edits made in the session after the diff was taken must not reach them,
// or an answer quotes code the diff beside it does not have.
test('the answerer reads the code the diff was taken from, not edits made in the checkout since', async () => {
  const session = 'claude-7b7b7b7b';
  const worktree = path.join(DIR, 'pinned');
  makeReview(session, worktree, '2026-11-19T14:00:00.000Z', { aTxt: 'as the diff has it\n' });
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'edited after the diff was taken\n');
  await call('POST', `/reviews/${session}/qa`);
  const qa = await until(() => { const q = readQa(session); return q?.status === 'ready' || q?.status === 'failed' ? q : null; });
  assert.equal(qa.status, 'ready', qa.error);
  for (const item of qa.items) assert.match(item.answer, /a\.txt: as the diff has it$/, item.id);
  // The copy is gone once the run is.
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`woodshed-qa-${session}-`)), []);
});

test('a worktree review with no snapshot fails before anything is asked', async () => {
  const session = 'claude-8c8c8c8c';
  makeReview(session, path.join(DIR, 'old'), '2026-11-19T15:00:00.000Z');
  const review = JSON.parse(fs.readFileSync(path.join(process.env.WOODSHED_REVIEWS, session, 'session.json'), 'utf8'));
  delete review.snapshot;
  writeSessionReview({ session, review });
  await call('POST', `/reviews/${session}/qa`);
  const qa = await until(() => (readQa(session)?.status === 'failed' ? readQa(session) : null));
  assert.match(qa.error, /press Re-review/);
  assert.deepEqual(qa.items, []);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
