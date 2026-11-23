import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createReviewHost } from './host.mjs';

// A stand-in for the shed's module: it answers what the host passes its ctx, which is the host's whole contract.
function fakeShed({ account, created = false, hasAnalysis = false, qaThrows = false }) {
  const calls = [];
  const analyses = [];
  const qas = [];
  return {
    calls,
    analyses,
    qas,
    load: async () => ({
      ghAccount: async () => account,
      ensureWorktreeReview: async () => ({ ok: true, created }),
      startReviewAnalysisIfNone: ({ sessionName }) => {
        if (hasAnalysis) return false;
        analyses.push(sessionName);
        return true;
      },
      startReviewQaIfNone: ({ sessionName }) => {
        if (qaThrows) throw new Error('qa.json unreadable');
        qas.push(sessionName);
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

test('opening the review starts the Q&A with the analysis, once in the container, whether or not the analysis is there', async (t) => {
  const fresh = fakeShed({ account: 'a', created: true });
  const callFresh = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: fresh.load }));
  await callFresh('GET', '/shed-review/reviews/claude-0a1b2c3d/qa');
  assert.deepEqual(fresh.qas, [], 'reading the Q&A is not opening the review');
  await callFresh('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual([fresh.analyses, fresh.qas], [['claude-0a1b2c3d'], ['claude-0a1b2c3d']]);
  await callFresh('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual(fresh.qas, ['claude-0a1b2c3d'], 'a reload or a second viewer asks the shed for nothing more');

  // An analysis from an earlier open: the Q&A is still the shed's to start or keep (it keeps one this diff has).
  const done = fakeShed({ account: 'a', created: false, hasAnalysis: true });
  const callDone = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'shared', load: done.load }));
  await callDone('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.deepEqual([done.analyses, done.qas], [[], ['claude-0a1b2c3d']]);
});

test('a Q&A that cannot be started on opening is logged, and the review still opens', async (t) => {
  const broken = fakeShed({ account: 'a', created: true, qaThrows: true });
  const call = await serve(t, createReviewHost({ repoDir: '/w', sessionId: '0a1b2c3d', sessionKind: 'private', load: broken.load }));
  const warn = t.mock.method(console, 'warn', () => {});
  const status = await call('GET', '/shed-review/reviews/claude-0a1b2c3d');
  assert.equal(status.status, 200);
  assert.deepEqual(broken.analyses, ['claude-0a1b2c3d'], 'the analysis still started');
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'review: Q&A not started on opening'));
});
