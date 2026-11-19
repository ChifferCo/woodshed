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
// git, as the route runs it, with one failure on demand: `write-tree` refused while WOODSHED_TEST_FAIL_WRITE_TREE=1.
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(BIN, 'git'), `#!/bin/sh
if [ "$WOODSHED_TEST_FAIL_WRITE_TREE" = 1 ]; then
  for a in "$@"; do [ "$a" = write-tree ] && { echo "fatal: injected write-tree failure" >&2; exit 128; }; done
fi
exec ${REAL_GIT} "$@"
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.WOODSHED_REVIEWS = path.join(DIR, 'reviews');

const { handleReviewRequest, failedQaRecord, removeReviewSession } = await import('./index.mjs');
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
  // A Q&A a restart cut off is still 'running' on disk with no run going: a first ask keeps it too.
  const qaFile = path.join(process.env.WOODSHED_REVIEWS, session, 'qa.json');
  const saved = JSON.parse(fs.readFileSync(qaFile, 'utf8'));
  fs.writeFileSync(qaFile, JSON.stringify({ ...saved, status: 'running', phase: 'answering' }));
  const cutOff = await call('POST', `/reviews/${session}/qa?first=1`);
  assert.deepEqual([cutOff.body.kept, readQa(session).startedAt], [true, done.startedAt]);
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

  // Two copies counting the same free space: with room for one above the floor, a second is refused while the first
  // still holds its share.
  const roomForOne = () => 512 * 1024 * 1024 + 1024 * 1024;
  const one = await makeSnapshot({ ...opts, maxTotalBytes: 4 * 1024 * 1024, free: roomForOne });
  assert.equal(one.ok, true, one.error);
  const two = await makeSnapshot({ ...opts, maxTotalBytes: 4 * 1024 * 1024, free: roomForOne });
  assert.deepEqual([two.ok, /too little room left/.test(two.error)], [false, true]);
  removeSnapshot(one.dir);
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

// Every write of a copy is inside its failure path: a submodule's folder that cannot be made fails the copy and
// removes it at once, rather than leaving it for the stale sweep.
test('a submodule folder that cannot be made fails the copy and leaves nothing behind', async () => {
  const repo = path.join(DIR, 'submodule');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},vendor/lib`);
  git('commit', '-q', '-m', 'with a submodule');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const copies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('woodshed-qa-claude-c3c3c3c3-'));
  const ok = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-c3c3c3c3', free: () => Infinity });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(fs.statSync(path.join(ok.dir, 'vendor/lib')).isDirectory(), true);
  removeSnapshot(ok.dir);
  const realMkdirSync = fs.mkdirSync;
  fs.mkdirSync = (p, ...rest) => {
    if (String(p).endsWith('vendor/lib')) throw new Error('EACCES: injected');
    return realMkdirSync(p, ...rest);
  };
  let failed;
  try {
    failed = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-c3c3c3c3', free: () => Infinity });
  } finally {
    fs.mkdirSync = realMkdirSync;
  }
  assert.deepEqual([failed.ok, /EACCES: injected/.test(failed.error)], [false, true]);
  assert.deepEqual(copies(), [], 'the failed copy was removed at once');
  assert.equal(reservedSnapshotBytes(), 0);

  // And when the partial copy will not go either, the error says so (runQa logs it), and its room stays reserved.
  const realRmSync = fs.rmSync;
  fs.mkdirSync = (p, ...rest) => {
    if (String(p).endsWith('vendor/lib')) throw new Error('EACCES: injected');
    return realMkdirSync(p, ...rest);
  };
  fs.rmSync = (p, ...rest) => {
    if (String(p).includes('woodshed-qa-claude-c3c3c3c3-')) throw new Error('EBUSY: injected');
    return realRmSync(p, ...rest);
  };
  let stuck;
  try {
    stuck = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-c3c3c3c3', free: () => Infinity });
  } finally {
    fs.mkdirSync = realMkdirSync;
    fs.rmSync = realRmSync;
  }
  assert.match(stuck.error, /its partial copy could not be removed: .*woodshed-qa-claude-c3c3c3c3-/);
  assert.ok(reservedSnapshotBytes() > 0, 'still reserved while it is on disk');
  removeSnapshot(stuck.error.split('could not be removed: ')[1]);
  assert.equal(reservedSnapshotBytes(), 0);
});

// Room is counted as the disk takes it, a block per file at the least: 300 files of 10 bytes are 3 KB of content and
// over 1 MB of disk, and a 1 MB total refuses them.
test('a tree of many small files is counted for the room it takes on disk', async () => {
  const repo = path.join(DIR, 'small-files');
  fs.mkdirSync(path.join(repo, 'f'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  for (let i = 0; i < 300; i += 1) fs.writeFileSync(path.join(repo, 'f', `${i}.txt`), `ten bytes${i % 10}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const got = await makeSnapshot({ repoDir: repo, treeish: git('rev-parse', 'HEAD^{tree}'), session: 'claude-d4d4d4d4', maxTotalBytes: 1024 * 1024, free: () => Infinity });
  assert.deepEqual([got.ok, /past the 1 MB a copy may take/.test(got.error)], [false, true]);
  assert.equal(reservedSnapshotBytes(), 0);
});

// Folders take room too. 200 empty-ish files in 200 folders of their own count twice what the files alone would.
test('every folder in the copy is counted for its block', async () => {
  const repo = path.join(DIR, 'many-folders');
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q');
  for (let i = 0; i < 200; i += 1) {
    fs.mkdirSync(path.join(repo, `d${i}`));
    fs.writeFileSync(path.join(repo, `d${i}`, 'x'), `${i}`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'tree');
  const tree = git('rev-parse', 'HEAD^{tree}');
  // 200 files are 800 KB of blocks; with their 200 folders, 1.6 MB.
  const got = await makeSnapshot({ repoDir: repo, treeish: tree, session: 'claude-e5e5e5e5', maxTotalBytes: 1024 * 1024, free: () => Infinity });
  assert.deepEqual([got.ok, /past the 1 MB a copy may take/.test(got.error)], [false, true]);
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

// A tree that could not be recorded when the review was taken is said as that, with git's reason, not taken for a
// review from before trees were recorded, whose advice (press Re-review) would meet the same failure again.
test('a review whose tree could not be recorded says why, not to press Re-review', async () => {
  const session = 'claude-f6f6f6f6';
  makeReview(session, path.join(DIR, 'no-tree'), '2026-11-19T17:00:00.000Z');
  const review = JSON.parse(fs.readFileSync(path.join(process.env.WOODSHED_REVIEWS, session, 'session.json'), 'utf8'));
  writeSessionReview({ session, review: { ...review, snapshot: null, snapshotError: 'git write-tree failed: error: invalid object' } });
  await call('POST', `/reviews/${session}/qa`);
  const qa = await until(() => (readQa(session)?.status === 'failed' ? readQa(session) : null));
  assert.match(qa.error, /was not recorded when this review was taken \(git write-tree failed: error: invalid object\)/);
  assert.doesNotMatch(qa.error, /press Re-review/);
});

// Through the real route: a review taken when git would not write the tree records why and logs it, and a Re-review
// that can records the tree and holds it with a ref of its own, which removing the review lets go.
test('the worktree review records its tree and holds it with a ref, or records why it could not', async () => {
  const session = 'claude-a7a7a7a7';
  const origin = path.join(DIR, 'origin.git');
  const wt = path.join(DIR, 'route-wt');
  const g = (cwd, ...args) => execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  execFileSync(REAL_GIT, ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync(REAL_GIT, ['clone', '-q', origin, wt], { stdio: 'ignore' });
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\n');
  g(wt, 'add', '-A');
  g(wt, 'commit', '-q', '-m', 'base');
  g(wt, 'push', '-q', 'origin', 'HEAD:main');
  g(wt, 'remote', 'set-head', 'origin', 'main');
  g(wt, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
  const logs = [];
  const ctx = {
    reqId: 't', repoRoot: wt, worktreePathFor: () => wt, log: (event, fields) => logs.push([event, fields]),
    json: (res, status, body) => { res.status = status; res.body = body; },
  };
  const post = async () => {
    const res = {};
    await handleReviewRequest({ method: 'POST', url: `/reviews/${session}`, headers: {} }, res, ctx);
    return res;
  };
  const record = () => JSON.parse(fs.readFileSync(path.join(process.env.WOODSHED_REVIEWS, session, 'session.json'), 'utf8'));
  const heldRefs = () => g(wt, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/woodshed-qa/${session}/`).split('\n').filter(Boolean);
  const held = () => { const refs = heldRefs(); return refs.length === 1 ? refs[0].split(' ')[1] : refs.length ? refs : null; };

  process.env.WOODSHED_TEST_FAIL_WRITE_TREE = '1';
  let failedTake;
  try { failedTake = await post(); } finally { delete process.env.WOODSHED_TEST_FAIL_WRITE_TREE; }
  assert.equal(failedTake.status, 200, JSON.stringify(failedTake.body));
  assert.equal(record().snapshot, null);
  assert.match(record().snapshotError, /git write-tree failed: fatal: injected write-tree failure/);
  assert.ok(logs.some(([e, f]) => e === 'review.snapshot_not_recorded' && /injected/.test(f.error)), 'logged');
  assert.equal(held(), null);

  const retaken = await post();
  assert.equal(retaken.status, 200, JSON.stringify(retaken.body));
  assert.match(record().snapshot, /^[0-9a-f]{40}$/);
  assert.equal(record().snapshotError, null);
  assert.equal(held(), record().snapshot, 'the ref holds the recorded tree');
  assert.equal(g(wt, 'cat-file', '-t', record().snapshot), 'tree');

  // Two Re-reviews at once, over different trees: whichever writes the record last, its tree is the one held, and
  // only that one.
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  const [x, y] = await Promise.all([post(), (async () => { fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n'); return post(); })()]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.equal(held(), record().snapshot, 'the tree the record names is held, and no other');

  await removeReviewSession({ ctx, sessionName: session });
  assert.equal(held(), null, 'removing the review lets the tree go');
});

// The rule overlapping Re-reviews rely on, without their timing: every tree is held by a ref of its own, and pruning
// keeps exactly the one named, whatever order the holds came in.
test('trees are held one ref each, and pruning keeps only the one named', async () => {
  const { holdTree, pruneHeldTrees } = await import('./worktree.mjs');
  const repo = path.join(DIR, 'held');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...args) => execFileSync(REAL_GIT, ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  g('init', '-q');
  const tree = (text) => { fs.writeFileSync(path.join(repo, 'f.txt'), text); g('add', '-A'); return g('write-tree'); };
  const a = tree('a\n');
  const b = tree('b\n');
  const refs = () => g('for-each-ref', '--format=%(objectname)', 'refs/woodshed-qa/claude-b8b8b8b8/').split('\n').filter(Boolean).sort();
  // A single ref by the session's name, from before, must not block the per-tree ones.
  g('update-ref', 'refs/woodshed-qa/claude-b8b8b8b8', a);
  assert.equal((await holdTree({ worktreePath: repo, sessionName: 'claude-b8b8b8b8', treeSha: b })).ok, true);
  assert.equal((await holdTree({ worktreePath: repo, sessionName: 'claude-b8b8b8b8', treeSha: a })).ok, true);
  assert.deepEqual(refs(), [a, b].sort(), 'both held, in whatever order they came');
  assert.deepEqual(await pruneHeldTrees({ worktreePath: repo, sessionName: 'claude-b8b8b8b8', keep: b }), { ok: true, released: 1 });
  assert.deepEqual(refs(), [b]);
  assert.deepEqual(await pruneHeldTrees({ worktreePath: repo, sessionName: 'claude-b8b8b8b8' }), { ok: true, released: 1 });
  assert.deepEqual(refs(), []);
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
