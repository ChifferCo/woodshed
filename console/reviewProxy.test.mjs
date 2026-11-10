import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createReviewProxy, isReviewPath, reviewTarget } from './reviewProxy.mjs';

test('the page and its calls map to the session\'s statusd, and nothing else does', () => {
  const t = (p) => reviewTarget(new URL(p, 'http://c'));
  assert.deepEqual(t('/review?session=claude-0a1b2c3d&embed=1'), { id: '0a1b2c3d', path: '/shed-review/review' });
  assert.deepEqual(t('/reviews/claude-0a1b2c3d/explain/abc-1?x=1'), { id: '0a1b2c3d', path: '/shed-review/reviews/claude-0a1b2c3d/explain/abc-1?x=1' });
  assert.deepEqual(t('/reviews/claude-0a1b2c3d'), { id: '0a1b2c3d', path: '/shed-review/reviews/claude-0a1b2c3d' });
  assert.equal(t('/review'), null);
  assert.equal(t('/review?session=0a1b2c3d'), null);
  assert.equal(t('/reviews/claude-0a1b2c3d/../../etc'), null);
  assert.equal(t('/reviews/claude-xyz/diff'), null);
  assert.equal(isReviewPath('/reviews/claude-0a1b2c3d'), true);
  assert.equal(isReviewPath('/api/sessions'), false);
});

// A statusd that records what it was asked and answers a page for /review.
async function setup(t, { session }) {
  const seen = [];
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.endsWith('/review')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<html>page</html>');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => statusd.listen(0, '127.0.0.1', r));
  const port = statusd.address().port;
  const proxy = createReviewProxy({
    findFor: (id, login) => (id === '0a1b2c3d' && login === 'me' ? session(port) : null),
  });
  const front = http.createServer((req, res) => proxy(req, res, new URL(req.url, 'http://c'), 'me'));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  t.after(() => { statusd.close(); front.close(); });
  const call = (method, path, { body, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${front.address().port}${path}`, { method, body, headers });
  return { seen, call };
}

const running = (port) => ({ id: '0a1b2c3d', status: 'running', token: 'tok', endpoint: { host: '127.0.0.1', statusPort: port } });

test('the page is forwarded with the session\'s token and may be framed by the console', async (t) => {
  const { seen, call } = await setup(t, { session: running });
  const res = await call('GET', '/review?session=claude-0a1b2c3d&embed=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(await res.text(), '<html>page</html>');
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.auth]), [['GET', '/shed-review/review', 'Bearer tok']]);
});

test('PATCH and DELETE are forwarded with their body, and JSON gets no framing header', async (t) => {
  const { seen, call } = await setup(t, { session: running });
  const res = await call('PATCH', '/reviews/claude-0a1b2c3d/title', { body: '{"title":"t"}', headers: { 'content-type': 'application/json' } });
  assert.equal(res.headers.get('content-security-policy'), null);
  await call('DELETE', '/reviews/claude-0a1b2c3d/comments', { body: '{"id":"c"}', headers: { 'content-type': 'application/json' } });
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.body]), [
    ['PATCH', '/shed-review/reviews/claude-0a1b2c3d/title', '{"title":"t"}'],
    ['DELETE', '/shed-review/reviews/claude-0a1b2c3d/comments', '{"id":"c"}'],
  ]);
});

test('a write from another site never reaches the session', async (t) => {
  const { seen, call } = await setup(t, { session: running });
  const res = await call('POST', '/reviews/claude-0a1b2c3d/merge', { body: '{}', headers: { origin: 'https://evil.example', 'content-type': 'application/json' } });
  assert.equal(res.status, 403);
  assert.equal(seen.length, 0);
});

test('a session the person cannot see is 404, one that is not running is 409, an odd verb is 405', async (t) => {
  const stopped = await setup(t, { session: () => ({ id: '0a1b2c3d', status: 'stopped', endpoint: null }) });
  assert.equal((await stopped.call('GET', '/reviews/claude-0a1b2c3d')).status, 409);
  assert.equal((await stopped.call('PUT', '/reviews/claude-0a1b2c3d')).status, 405);
  const other = await setup(t, { session: running });
  assert.equal((await other.call('GET', '/reviews/claude-ffffffff')).status, 404);
  assert.equal((await other.call('GET', '/review')).status, 404);
});
