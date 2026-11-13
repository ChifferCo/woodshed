import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createReviewHost } from './host.mjs';

// A stand-in for the shed's module: it answers what the host passes its ctx, which is the host's whole contract.
function fakeShed({ account, created = false, hasAnalysis = false }) {
  const calls = [];
  const analyses = [];
  return {
    calls,
    analyses,
    load: async () => ({
      ghAccount: async () => account,
      ensureWorktreeReview: async () => ({ ok: true, created }),
      startReviewAnalysisIfNone: ({ sessionName }) => {
        if (hasAnalysis) return false;
        analyses.push(sessionName);
        return true;
      },
      handleReviewRequest: async (req, res, ctx) => {
        calls.push({ url: req.url, method: req.method, repoRoot: ctx.repoRoot, worktree: ctx.worktreePathFor('claude-0a1b2c3d') });
        if (req.url.startsWith('/review?') || req.url === '/review') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>page</html>');
          return true;
        }
        ctx.json(res, 200, { ok: true, status: 'ready', livePr: { number: 7 }, ghAccount: account, kind: 'worktree' });
        return true;
      },
    }),
  };
}

async function serve(t, host) {
  const server = http.createServer((req, res) => host.handle(req, res).then((done) => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return (method, path, body) => fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {} });
}

test('a private session with a person behind gh keeps the pull request and may write', async (t) => {
  const shed = fakeShed({ account: 'octocat' });
  const call = await serve(t, createReviewHost({ repoDir: '/work/x', sessionId: '0a1b2c3d', sessionKind: 'private', load: shed.load }));
  const status = await (await call('GET', '/shed-review/reviews/claude-0a1b2c3d')).json();
  assert.equal(status.livePr.number, 7);
  assert.equal((await call('POST', '/shed-review/reviews/claude-0a1b2c3d/submit', { event: 'comment' })).status, 200);
  assert.deepEqual(shed.calls[0], { url: '/reviews/claude-0a1b2c3d', method: 'GET', repoRoot: '/work/x', worktree: '/work/x' });
});

test('a shared session is read-only: no pull request on the page, and a write is refused before the shed sees it', async (t) => {
  const shed = fakeShed({ account: 'the-app' });
  const call = await serve(t, createReviewHost({ repoDir: '/work/x', sessionId: '0a1b2c3d', sessionKind: 'shared', load: shed.load }));
  const status = await (await call('GET', '/shed-review/reviews/claude-0a1b2c3d')).json();
  assert.equal(status.livePr, null);
  assert.equal(status.ghAccount, null);
  const refused = await call('POST', '/shed-review/reviews/claude-0a1b2c3d/merge', { subject: 's' });
  assert.equal(refused.status, 403);
  assert.equal(shed.calls.length, 1, 'only the status call reached the shed');
  assert.equal((await call('POST', '/shed-review/reviews/claude-0a1b2c3d/chat', { question: 'q' })).status, 200);
});

test('a private session whose gh is the App is read-only too', async (t) => {
  const call = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: fakeShed({ account: null }).load }));
  assert.equal((await (await call('GET', '/shed-review/reviews/claude-0a1b2c3d')).json()).livePr, null);
  assert.equal((await call('PATCH', '/shed-review/reviews/claude-0a1b2c3d/title', { title: 't' })).status, 403);
});

test('another session\'s review, and a path outside the prefix, are not answered', async (t) => {
  const call = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: fakeShed({ account: 'a' }).load }));
  assert.equal((await call('GET', '/shed-review/reviews/claude-ffffffff')).status, 404);
  assert.equal((await call('GET', '/review')).status, 404);
  assert.equal((await call('GET', '/shed-review/review?session=claude-0a1b2c3d')).status, 200);
});

test('a session without an id answers nothing, rather than every session\'s review', async (t) => {
  const call = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '', sessionKind: 'private', load: fakeShed({ account: 'a' }).load }));
  assert.equal((await call('GET', '/shed-review/reviews/claude-0a1b2c3d')).status, 404);
  assert.equal((await call('GET', '/shed-review/review?session=claude-0a1b2c3d')).status, 404);
});

test('opening the review starts the analysis once, in any session, and only when it has none', async (t) => {
  const fresh = fakeShed({ account: 'a', created: true });
  const callFresh = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: fresh.load }));
  await callFresh('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual(fresh.analyses, ['claude-0a1b2c3d']);
  await callFresh('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual(fresh.analyses, ['claude-0a1b2c3d'], 'a reload, or a Discard since, is not run again');

  // A review taken before, by an earlier open, still has no analysis: the first open in this container runs it.
  const taken = fakeShed({ account: 'the-app', created: false });
  const callTaken = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'shared', load: taken.load }));
  await callTaken('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual(taken.analyses, ['claude-0a1b2c3d']);

  const done = fakeShed({ account: 'a', created: false, hasAnalysis: true });
  const callDone = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: done.load }));
  await callDone('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual(done.analyses, [], 'an analysis already there, or one that failed, is left as it is');

  const diffOnly = fakeShed({ account: 'a', created: true });
  const callDiff = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: diffOnly.load }));
  await callDiff('GET', '/shed-review/reviews/claude-0a1b2c3d/diff');
  assert.deepEqual(diffOnly.analyses, [], 'only the page\'s status read is an opening');
});
