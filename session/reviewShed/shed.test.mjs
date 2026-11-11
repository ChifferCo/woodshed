import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The host over the shed's real review code and a real git checkout. No claude and no gh on the path: nothing here
// may need either to open the page, which is the property this pins.
process.env.WOODSHED_REVIEWS = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-state-'));
process.env.PATH = '/usr/bin:/bin';
// A Woodshed session exports these; the fixtures' repos are on master and the host is not review-only.
delete process.env.DEFAULT_BRANCH;
delete process.env.REVIEW_ONLY;
const { createReviewHost } = await import('./host.mjs');

function checkout(t, { dirty }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-checkout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { stdio: 'pipe' });
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote]);
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'remote', 'set-head', 'origin', 'master');
  git(repo, 'checkout', '-q', '-b', 'work');
  if (dirty) fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 2;\nexport const b = 3;\n');
  return repo;
}

async function serve(t, repoDir, sessionId) {
  const host = createReviewHost({ repoDir, sessionId, sessionKind: 'shared' });
  const server = http.createServer((req, res) => host.handle(req, res).then((done) => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/shed-review`;
  // The JSON of a call, or the response itself for the page.
  return (p) => fetch(base + p).then((r) => (r.headers.get('content-type')?.startsWith('application/json') ? r.json() : r));
}

test('opening the review of a checkout with changes makes the review, with its diff, and starts no analysis', async (t) => {
  const get = await serve(t, checkout(t, { dirty: true }), 'aaaaaaa1');
  const status = await get('/reviews/claude-aaaaaaa1');
  assert.equal(status.ok, true);
  assert.equal(status.kind, 'worktree');
  assert.equal(status.status, 'unknown', 'no analysis was started');
  assert.equal(status.livePr, null);
  const diff = await get('/reviews/claude-aaaaaaa1/diff');
  assert.deepEqual(diff.files.map((f) => f.path), ['a.mjs']);
  assert.equal(diff.files[0].language, 'c');
});

test('a checkout with nothing to review says so instead of opening an empty page', async (t) => {
  const get = await serve(t, checkout(t, { dirty: false }), 'bbbbbbb2');
  const status = await get('/reviews/claude-bbbbbbb2');
  assert.equal(status.ok, false);
  assert.match(status.error, /nothing to review/);
});

test('the page served is the shed\'s own, byte for byte', async (t) => {
  const { REVIEW_HTML } = await import('../../shared/review/page.mjs');
  const get = await serve(t, checkout(t, { dirty: true }), 'ccccccc3');
  const res = await get('/review?session=claude-ccccccc3');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), REVIEW_HTML);
});
