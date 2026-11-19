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
const { makeSnapshot, removeSnapshot, sweepStaleSnapshots, reservedSnapshotBytes } = await import('./qa.mjs');

// A worktree review of a real checkout, whose snapshot is the commit made here: what the diff was taken from.
function makeReview(session, worktree, createdAt = '2026-11-19T10:00:00.000Z', { aTxt, attributes } = {}) {
  fs.mkdirSync(worktree, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', worktree, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  if (!fs.existsSync(path.join(worktree, '.git'))) git('init', '-q');
  if (aTxt !== undefined) fs.writeFileSync(path.join(worktree, 'a.txt'), aTxt);
  if (attributes !== undefined) fs.writeFileSync(path.join(worktree, '.gitattributes'), attributes);
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
  // export-ignore too: a copy made by `git archive` would leave a.txt out, though the diff may show it.
  makeReview(session, worktree, '2026-11-19T14:00:00.000Z', { aTxt: 'as the diff has it\n', attributes: 'a.txt export-ignore\n' });
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'edited after the diff was taken\n');
  await call('POST', `/reviews/${session}/qa`);
  const qa = await until(() => { const q = readQa(session); return q?.status === 'ready' || q?.status === 'failed' ? q : null; });
  assert.equal(qa.status, 'ready', qa.error);
  for (const item of qa.items) assert.match(item.answer, /a\.txt: as the diff has it$/, item.id);
  // The copy is gone once the run is.
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`woodshed-qa-${session}-`)), []);
});

// The page asks by itself on the tab's first opening. That ask must not replace a Q&A this diff already has: a tab
// opened late, as another tab's run finished, would pay to throw that one away. Ask again is the one that replaces.
test('a first-open ask keeps the Q&A the diff already has; Ask again replaces it', async () => {
  const session = 'claude-9d9d9d9d';
  makeReview(session, path.join(DIR, 'keep'), '2026-11-19T16:00:00.000Z');
  await call('POST', `/reviews/${session}/qa`);
  const done = await until(() => (readQa(session)?.status === 'ready' ? readQa(session) : null));
  const first = await call('POST', `/reviews/${session}/qa?first=1`);
  assert.deepEqual([first.body.status, first.body.kept], ['ready', true]);
  assert.equal(readQa(session).startedAt, done.startedAt, 'the same run, nothing new paid for');
  const again = await call('POST', `/reviews/${session}/qa`);
  assert.equal(again.body.status, 'running');
  await until(() => (readQa(session)?.status === 'ready' && readQa(session).startedAt !== done.startedAt));
});

// The copy is the tree's bytes as git stores them, which is what the diff compares. A smudge filter configured in the
// checkout (what checkout-index applies) and export-ignore (what git archive honours) must change nothing in it, and a
// symlink must not point out of it.
test('the copy is the tree as git stores it: no checkout filters, no export rules, no links out', async () => {
  const repo = path.join(DIR, 'raw');
  fs.mkdirSync(path.join(repo, 'deep/er'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'lower case, as committed\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'a.txt export-ignore filter=upper\n');
  fs.writeFileSync(path.join(repo, 'deep/er/b.mjs'), 'export const b = 1;\n');
  fs.symlinkSync('/etc/hostname', path.join(repo, 'link'));
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  git('config', 'filter.upper.smudge', 'tr a-z A-Z');
  const snap = await makeSnapshot({ repoDir: repo, treeish: git('rev-parse', 'HEAD^{tree}'), session: 'claude-abababab' });
  assert.equal(snap.ok, true, snap.error);
  try {
    assert.equal(fs.readFileSync(path.join(snap.dir, 'a.txt'), 'utf8'), 'lower case, as committed\n');
    assert.equal(fs.readFileSync(path.join(snap.dir, 'deep/er/b.mjs'), 'utf8'), 'export const b = 1;\n');
    assert.equal(fs.lstatSync(path.join(snap.dir, 'link')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(snap.dir, 'link'), 'utf8'), '/etc/hostname');
  } finally {
    removeSnapshot(snap.dir);
  }
});

// Streamed to disk a chunk at a time: a large blob, an empty one and many small ones, across every chunk boundary,
// come out byte for byte. And a listing the runner cut off fails the copy rather than leaving it short.
test('the copy streams blobs of any size intact, and a cut-off listing fails it', async () => {
  const repo = path.join(DIR, 'big');
  fs.mkdirSync(path.join(repo, 'many'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const big = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7 + (i >> 11)) & 0xff;
  fs.writeFileSync(path.join(repo, 'big.bin'), big);
  fs.writeFileSync(path.join(repo, 'empty.txt'), '');
  for (let i = 0; i < 300; i += 1) fs.writeFileSync(path.join(repo, 'many', `f${i}.txt`), `file ${i}\n`.repeat(i % 7));
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const snap = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-cdcdcdcd', maxFileBytes: 64 * 1024 * 1024 });
  assert.equal(snap.ok, true, snap.error);
  try {
    assert.equal(snap.files, 302);
    assert.ok(fs.readFileSync(path.join(snap.dir, 'big.bin')).equals(big), 'the large blob is intact');
    assert.equal(fs.readFileSync(path.join(snap.dir, 'empty.txt'), 'utf8'), '');
    for (const i of [0, 1, 6, 150, 299]) {
      assert.equal(fs.readFileSync(path.join(snap.dir, 'many', `f${i}.txt`), 'utf8'), `file ${i}\n`.repeat(i % 7));
    }
  } finally {
    removeSnapshot(snap.dir);
  }
  const copies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('woodshed-qa-claude-cdcdcdcd-')).sort();
  const before = copies();
  const cut = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-cdcdcdcd', listMaxBytes: 100 });
  assert.deepEqual([cut.ok, /more files than/.test(cut.error)], [false, true]);
  assert.deepEqual(copies(), before, 'the failed copy left no folder');
});

// A copy cannot fill the host's /tmp: a file past the per-file limit becomes a note saying so, and a tree whose files
// still come to more than the total is refused before anything is written.
test('the copy leaves a large file as a note, and refuses a tree past its total', async () => {
  const repo = path.join(DIR, 'limits');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  fs.writeFileSync(path.join(repo, 'small.txt'), 'kept\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const snap = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-dededede', maxFileBytes: 1024 * 1024 });
  assert.equal(snap.ok, true, snap.error);
  try {
    assert.deepEqual([snap.files, snap.skipped], [1, 1]);
    assert.equal(fs.readFileSync(path.join(snap.dir, 'small.txt'), 'utf8'), 'kept\n');
    assert.match(fs.readFileSync(path.join(snap.dir, 'huge.bin'), 'utf8'), /^\(Not copied for the Q&A: 3072 KB/);
  } finally {
    removeSnapshot(snap.dir);
  }
  const over = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-dededede', maxTotalBytes: 1024 * 1024 });
  assert.deepEqual([over.ok, /past the 1 MB a copy may take/.test(over.error)], [false, true]);
});

// Git allows a file name that is not UTF-8. Decoded as text, two such names can come out as the same string, and one
// file silently overwrites the other in the copy. Kept as bytes, each lands at its own name.
test('file names that are not UTF-8 are copied by their bytes, each to its own file', async () => {
  const repo = path.join(DIR, 'bytes');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const nameA = Buffer.from([0x66, 0xff, 0x2e, 0x74, 0x78, 0x74]); // f\xff.txt
  const nameB = Buffer.from([0x66, 0xfe, 0x2e, 0x74, 0x78, 0x74]); // f\xfe.txt
  fs.writeFileSync(Buffer.concat([Buffer.from(repo + '/'), nameA]), 'first\n');
  fs.writeFileSync(Buffer.concat([Buffer.from(repo + '/'), nameB]), 'second\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const snap = await makeSnapshot({ repoDir: repo, treeish: git('rev-parse', 'HEAD^{tree}'), session: 'claude-fafafafa' });
  assert.equal(snap.ok, true, snap.error);
  try {
    assert.equal(snap.files, 2);
    assert.equal(fs.readFileSync(Buffer.concat([Buffer.from(snap.dir + '/'), nameA]), 'utf8'), 'first\n');
    assert.equal(fs.readFileSync(Buffer.concat([Buffer.from(snap.dir + '/'), nameB]), 'utf8'), 'second\n');
  } finally {
    removeSnapshot(snap.dir);
  }
});

// The total is for every copy on disk at once, not each: several sessions asking together would otherwise each take
// it. And a copy that would leave the disk too little room is refused, whatever else is writing there.
test('copies on disk together stay within the total, and a copy needs room left on the disk', async () => {
  const repo = path.join(DIR, 'shared-budget');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'part.bin'), Buffer.alloc(700 * 1024, 2));
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const tree = git('rev-parse', 'HEAD^{tree}');
  // free is stubbed, so the budget checks do not depend on the disk the tests run on.
  const opts = { repoDir: repo, treeish: tree, session: 'claude-a1a1a1a1', maxTotalBytes: 1024 * 1024, free: () => Infinity };
  const first = await makeSnapshot(opts);
  assert.equal(first.ok, true, first.error);
  const second = await makeSnapshot(opts);
  assert.deepEqual([second.ok, /other Q&A copies on this machine hold/.test(second.error)], [false, true]);
  removeSnapshot(first.dir);
  assert.equal(reservedSnapshotBytes(), 0, 'the deleted copy gave its room back');
  const third = await makeSnapshot(opts);
  assert.equal(third.ok, true, third.error);
  removeSnapshot(third.dir);
  // 100 KB above the 512 MB that must stay free: this 700 KB copy would go below it.
  const cramped = await makeSnapshot({ ...opts, free: () => 512 * 1024 * 1024 + 100 * 1024 });
  assert.deepEqual([cramped.ok, /too little room left/.test(cramped.error)], [false, true]);
  assert.equal(reservedSnapshotBytes(), 0);

  // A copy that could not be deleted still fills the disk: its share stays reserved, and removeSnapshot does not throw.
  const stuck = await makeSnapshot(opts);
  assert.equal(stuck.ok, true, stuck.error);
  const held = reservedSnapshotBytes();
  assert.ok(held > 0);
  assert.equal(removeSnapshot(stuck.dir, { rm: () => { throw new Error('EBUSY'); } }), false);
  assert.equal(reservedSnapshotBytes(), held, 'still reserved while the copy is on disk');
  assert.equal((await makeSnapshot(opts)).ok, false, 'so the next copy is refused');
  assert.equal(removeSnapshot(stuck.dir), true);
  assert.equal(reservedSnapshotBytes(), 0);
});

// writeSync may write fewer bytes than asked. What it leaves must be written again, not skipped, or a file in a copy
// reported whole is shorter than its blob.
test('a short write is finished, not skipped: every file comes out whole', async () => {
  const repo = path.join(DIR, 'short-writes');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const body = Buffer.from('0123456789abcdef'.repeat(4096));
  fs.writeFileSync(path.join(repo, 'a.txt'), body);
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const realWriteSync = fs.writeSync;
  fs.writeSync = (fd, buf, offset, length, ...rest) => realWriteSync(fd, buf, offset, Math.min(length, 7), ...rest);
  let snap;
  try {
    snap = await makeSnapshot({ repoDir: repo, treeish: git('rev-parse', 'HEAD^{tree}'), session: 'claude-b2b2b2b2' });
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.equal(snap.ok, true, snap.error);
  try {
    assert.ok(fs.readFileSync(path.join(snap.dir, 'a.txt')).equals(body), 'the file is as long as its blob');
  } finally {
    removeSnapshot(snap.dir);
  }
});

test('copies a restart left behind are swept at the next copy, and a live one is not', () => {
  const tmp = fs.mkdtempSync(path.join(DIR, 'tmp-'));
  const stale = path.join(tmp, 'woodshed-qa-claude-12345678-old');
  const live = path.join(tmp, 'woodshed-qa-claude-12345678-new');
  const other = path.join(tmp, 'someone-elses-folder');
  for (const d of [stale, live, other]) fs.mkdirSync(d);
  const old = new Date(Date.now() - 4 * 60 * 60_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(other, old, old);
  assert.equal(sweepStaleSnapshots({ tmp }), 1);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['someone-elses-folder', 'woodshed-qa-claude-12345678-new']);
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
