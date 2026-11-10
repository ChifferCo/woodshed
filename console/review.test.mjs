import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createReviewSource, shapeReview } from './review.mjs';
import { createHandler } from './server.mjs';

const COMPARE = {
  ahead_by: 3,
  behind_by: 1,
  html_url: 'https://github.com/o/r/compare/master...woodshed/12-0a1b2c3d',
  commits: [{ sha: 'aaaaaaaaaaaaaaaa' }, { sha: 'bbbbbbbbbbbbbbbb' }],
  files: [
    { filename: 'a/new.mjs', status: 'added', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' },
    { filename: 'b/moved.mjs', previous_filename: 'b/old.mjs', status: 'renamed', additions: 0, deletions: 0 },
    { filename: 'c/big.txt', status: 'modified', additions: 500, deletions: 2, patch: Array.from({ length: 450 }, (_, i) => `+${i}`).join('\n') },
  ],
};

test('shapeReview keeps what the tab shows, and cuts a long patch', () => {
  const review = shapeReview(COMPARE, { base: 'master', branch: 'woodshed/12-0a1b2c3d' });
  assert.equal(review.head, 'bbbbbbbbbb', 'the newest commit');
  assert.deepEqual([review.aheadBy, review.behindBy, review.additions, review.deletions], [3, 1, 503, 2]);
  assert.equal(review.url, COMPARE.html_url);
  assert.deepEqual(review.files[0], { path: 'a/new.mjs', previousPath: null, status: 'added', additions: 3, deletions: 0, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c', truncated: false });
  assert.equal(review.files[1].previousPath, 'b/old.mjs');
  assert.equal(review.files[1].patch, null, 'GitHub sends no patch for a rename without changes, or a binary file');
  assert.equal(review.files[2].patch.split('\n').length, 400);
  assert.equal(review.files[2].truncated, true);
  assert.deepEqual(shapeReview(null, { base: 'master', branch: 'x' }).files, []);
});

test('the review source says why there is nothing to read, and caches per head', async () => {
  const asked = [];
  let clock = 0;
  const github = {
    defaultBranch: async () => 'master',
    compare: async (base, head) => {
      asked.push(`${base}...${head}`);
      if (head === 'unpushed') throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
      if (head === 'flaky') throw new Error('connect ETIMEDOUT');
      return COMPARE;
    },
  };
  const reviewFor = createReviewSource({ github, now: () => clock });

  await assert.rejects(reviewFor({ branch: null }), (err) => err.shown && /no branch yet/.test(err.message));
  await assert.rejects(reviewFor({ branch: 'x;rm -rf' }), (err) => err.shown);
  await assert.rejects(reviewFor({ branch: 'unpushed' }), (err) => err.shown && /GitHub has no unpushed yet/.test(err.message));
  await assert.rejects(reviewFor({ branch: 'flaky' }), (err) => !err.shown);

  assert.equal((await reviewFor({ branch: 'woodshed/12-0a1b2c3d', head: 'h1' })).aheadBy, 3);
  await reviewFor({ branch: 'woodshed/12-0a1b2c3d', head: 'h1' });
  assert.equal(asked.filter((a) => a.endsWith('0a1b2c3d')).length, 1, 'the same head within 30 seconds is read once');
  await reviewFor({ branch: 'woodshed/12-0a1b2c3d', head: 'h2' });
  clock = 31_000;
  await reviewFor({ branch: 'woodshed/12-0a1b2c3d', head: 'h2' });
  assert.equal(asked.filter((a) => a.endsWith('0a1b2c3d')).length, 3, 'a new head, and an old answer, are read again');
});

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/sessions/<id>/review answers with the review, or why there is none, behind sign-in', async (t) => {
  const sessions = [
    { id: '0a1b2c3d', status: 'running', branch: 'woodshed/12-0a1b2c3d' },
    { id: '11111111', status: 'stopped', branch: 'unpushed' },
    { id: '22222222', status: 'running', branch: 'flaky' },
  ];
  const fleet = { sessions: () => sessions, find: (id) => sessions.find((s) => s.id === id) ?? null };
  const config = { host: '127.0.0.1', publicUrl: 'http://localhost', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const review = async (s) => {
    if (s.branch === 'unpushed') throw Object.assign(new Error('GitHub has no unpushed yet'), { shown: true });
    if (s.branch === 'flaky') throw new Error('connect ETIMEDOUT');
    return { branch: s.branch, files: [] };
  };
  let signedIn = false;
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => (signedIn ? { login: 'octo' } : null) };
  const handle = createHandler({ config, fleet, review, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());

  assert.equal((await get(port, '/api/sessions/0a1b2c3d/review')).status, 401);
  signedIn = true;
  assert.deepEqual(await get(port, '/api/sessions/0a1b2c3d/review'), { status: 200, body: { branch: 'woodshed/12-0a1b2c3d', files: [] } });
  assert.deepEqual(await get(port, '/api/sessions/11111111/review'), { status: 409, body: { error: 'GitHub has no unpushed yet' } });
  assert.deepEqual(await get(port, '/api/sessions/22222222/review'), { status: 502, body: { error: 'GitHub did not answer: try again in a moment' } });
  assert.equal((await get(port, '/api/sessions/ffffffff/review')).status, 404);
});
