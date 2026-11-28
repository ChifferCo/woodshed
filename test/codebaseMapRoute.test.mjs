import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnv } from './isolatedEnv.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'review-map-route-'));
process.env.WOODSHED_REVIEWS = path.join(DIR, 'reviews');

const { handleReviewRequest } = await import('../shared/review/index.mjs');
const { writeSessionReview, writeDiff } = await import('../shared/review/store.mjs');

const AUTHOR = ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

async function callMap(session) {
  const res = { status: 0, body: null };
  const ctx = {
    reqId: 'test',
    log: () => {},
    json: (_res, status, body) => { res.status = status; res.body = body; },
  };
  await handleReviewRequest({ method: 'GET', url: `/reviews/${session}/map`, headers: {} }, {}, ctx);
  return res;
}

test('GET /reviews/<session>/map returns 404 without a review, 200 with a review, and refreshes cache on new take', async (t) => {
  t.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  const missing = await callMap('claude-00000001');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);

  const worktree = path.join(DIR, 'wt');
  fs.mkdirSync(path.join(worktree, 'src', 'app'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', worktree], { env: isolatedEnv() });
  fs.writeFileSync(path.join(worktree, 'src', 'app', 'index.mjs'), 'export const v = 1;\n', 'utf8');
  execFileSync('git', [...AUTHOR, '-C', worktree, 'add', '-A'], { env: isolatedEnv() });
  execFileSync('git', [...AUTHOR, '-C', worktree, 'commit', '-q', '-m', 'init'], { env: isolatedEnv() });
  const headSha = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { env: isolatedEnv(), encoding: 'utf8' }).trim();

  const session = 'claude-aabbccdd';
  writeSessionReview({
    session,
    review: { kind: 'worktree', worktree, headSha, createdAt: '2026-11-28T01:00:00Z', meta: { title: 'Test' } },
  });
  writeDiff({
    session,
    diff: { files: [{ path: 'src/app/index.mjs', status: 'modified', additions: 1, deletions: 0, hunks: [{}] }] },
  });

  const first = await callMap(session);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.changedFiles, 1);
  assert.ok(first.body.modules.some((m) => m.id === 'src/app'));

  // Add a new file on disk without advancing createdAt/headSha -> cache serves the first take.
  fs.mkdirSync(path.join(worktree, 'src', 'extra'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'extra', 'more.mjs'), 'export const x = 2;\n', 'utf8');
  const cached = await callMap(session);
  assert.equal(cached.status, 200);
  assert.equal(cached.body.modules.some((m) => m.id === 'src/extra'), false);

  // Advance createdAt to represent a new take -> cache key changes and rebuilds with the new module.
  writeSessionReview({
    session,
    review: { kind: 'worktree', worktree, headSha, createdAt: '2026-11-28T02:00:00Z', meta: { title: 'Test' } },
  });
  const refreshed = await callMap(session);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.modules.some((m) => m.id === 'src/extra'), true);
});
