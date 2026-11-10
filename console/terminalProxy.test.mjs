import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { basicAuth, handleTerminalRequest, parseTerminalPath } from './terminalProxy.mjs';

test('parseTerminalPath accepts only an 8-hex session id, on either terminal', () => {
  assert.deepEqual(parseTerminalPath('/term/0a1b2c3d/'), { app: 'term', id: '0a1b2c3d' });
  assert.deepEqual(parseTerminalPath('/term/0a1b2c3d/ws'), { app: 'term', id: '0a1b2c3d' });
  assert.deepEqual(parseTerminalPath('/term/0a1b2c3d'), { app: 'term', id: '0a1b2c3d' });
  assert.deepEqual(parseTerminalPath('/shell/0a1b2c3d/ws'), { app: 'shell', id: '0a1b2c3d' });
  assert.equal(parseTerminalPath('/redis/0a1b2c3d/'), null, 'Redis is no terminal');
  assert.equal(parseTerminalPath('/term/../etc/'), null);
  assert.equal(parseTerminalPath('/term/0A1B2C3D/'), null);
  assert.equal(parseTerminalPath('/api/sessions'), null);
});

test('basicAuth matches ttyd --credential woodshed:<token>', () => {
  assert.equal(basicAuth('t0k'), `Basic ${Buffer.from('woodshed:t0k').toString('base64')}`);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('the proxy adds the session credentials and drops the browser cookie', async (t) => {
  let seen;
  const ttyd = http.createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie };
    res.end('ok');
  });
  const ttydPort = await listen(ttyd);
  const sessions = { '0a1b2c3d': { host: '127.0.0.1', termPort: ttydPort, statusPort: 1, terminalToken: 'secret', sessionToken: 'other' } };
  const proxy = http.createServer((req, res) => {
    if (!handleTerminalRequest(req, res, { targetFor: (id) => sessions[id] ?? null })) res.end('not ours');
  });
  const proxyPort = await listen(proxy);
  t.after(() => { ttyd.close(); proxy.close(); });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/term/0a1b2c3d/token`, { headers: { cookie: 'a=b' } });
  assert.equal(await res.text(), 'ok');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.deepEqual(seen, { url: '/term/0a1b2c3d/token', authorization: basicAuth('secret'), cookie: undefined });

  const missing = await fetch(`http://127.0.0.1:${proxyPort}/term/ffffffff/`);
  assert.equal(missing.status, 404);
});

test('a Redis viewer request goes to statusd with the session token, and another site is refused', async (t) => {
  let seen;
  const statusd = http.createServer((req, res) => {
    seen = { url: req.url, method: req.method, authorization: req.headers.authorization, cookie: req.headers.cookie };
    res.end('viewer');
  });
  const statusPort = await listen(statusd);
  const sessions = { '0a1b2c3d': { host: '127.0.0.1', termPort: 1, statusPort, terminalToken: 'term', sessionToken: 'sess' } };
  const proxy = http.createServer((req, res) => {
    if (!handleTerminalRequest(req, res, { targetFor: (id) => sessions[id] ?? null })) res.end('not ours');
  });
  const proxyPort = await listen(proxy);
  t.after(() => { statusd.close(); proxy.close(); });

  const res = await fetch(`http://127.0.0.1:${proxyPort}/redis/0a1b2c3d/apiv2/keys`, {
    method: 'POST', headers: { cookie: 'a=b', authorization: 'Bearer from-browser', 'sec-fetch-site': 'same-origin' }, body: '{}',
  });
  assert.equal(await res.text(), 'viewer');
  assert.deepEqual(seen, { url: '/redis/0a1b2c3d/apiv2/keys', method: 'POST', authorization: 'Bearer sess', cookie: undefined });

  seen = null;
  for (const site of ['cross-site', 'same-site']) {
    const refused = await fetch(`http://127.0.0.1:${proxyPort}/redis/0a1b2c3d/apiv2/keys`, { method: 'POST', headers: { 'sec-fetch-site': site } });
    assert.equal(refused.status, 403);
    const framed = await fetch(`http://127.0.0.1:${proxyPort}/term/0a1b2c3d/`, { headers: { 'sec-fetch-site': site } });
    assert.equal(framed.status, 403);
  }
  assert.equal(seen, null);

  const typed = await fetch(`http://127.0.0.1:${proxyPort}/redis/0a1b2c3d/`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(await typed.text(), 'viewer');
  assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/redis/ffffffff/`)).status, 404);

  // A private session's own database viewers go the same way, through its statusd.
  for (const app of ['pg', 'mongo', 'mongo-copy']) {
    const viewer = await fetch(`http://127.0.0.1:${proxyPort}/${app}/0a1b2c3d/`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(await viewer.text(), 'viewer', app);
    assert.deepEqual([seen.url, seen.authorization], [`/${app}/0a1b2c3d/`, 'Bearer sess']);
    assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/${app}/0a1b2c3d/`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  }
  const gone = await fetch(`http://127.0.0.1:${proxyPort}/pg/ffffffff/`);
  assert.deepEqual([gone.status, await gone.text()], [404, 'no Postgres viewer for that session\n']);
});

test('the Terminal tab reaches the shell ttyd with the terminal credential, and an older session has none', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    res.end('shell');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const port = upstream.address().port;
  const sessions = {
    '0a1b2c3d': { host: '127.0.0.1', termPort: 1, statusPort: 2, shellPort: port, terminalToken: 'tt', sessionToken: 'st' },
    '11111111': { host: '127.0.0.1', termPort: 1, statusPort: 2, terminalToken: 'tt', sessionToken: 'st' },
  };
  const proxy = http.createServer((req, res) => { handleTerminalRequest(req, res, { targetFor: (id) => sessions[id] ?? null }); });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const res = await fetch(`${base}/shell/0a1b2c3d/`);
  assert.equal(await res.text(), 'shell');
  assert.deepEqual(seen, [{ path: '/shell/0a1b2c3d/', authorization: basicAuth('tt') }]);
  const old = await fetch(`${base}/shell/11111111/`);
  assert.equal(old.status, 404, 'a session from an image before the Terminal tab');
});
