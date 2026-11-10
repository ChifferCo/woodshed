import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { handleEditorRequest, handleEditorUpgrade, isEditorPath, isFromAnotherSite } from './editorProxy.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('isEditorPath takes the editor\'s base path and nothing beside it', () => {
  assert.ok(isEditorPath('/__woodshed/code'));
  assert.ok(isEditorPath('/__woodshed/code/stable-abc/static/out/vs/code/browser/workbench/workbench.js'));
  assert.ok(!isEditorPath('/__woodshed/codex'));
  assert.ok(!isEditorPath('/__woodshed/auth'));
  assert.ok(!isEditorPath('/code/0a1b2c3d/'));
});

test('isFromAnotherSite lets a page be opened from the console, and nothing else from another site', () => {
  const ask = (method, headers) => isFromAnotherSite({ method, headers });
  assert.equal(ask('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }), false);
  assert.equal(ask('GET', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }), false, 'a typed URL');
  assert.equal(ask('GET', {}), false, 'not a browser');
  assert.equal(ask('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }), false, 'Editor ↗ from the console');
  assert.equal(ask('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }), true, 'a fetch from a sibling session\'s app');
  assert.equal(ask('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }), true);
  assert.equal(ask('POST', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }), true, 'a form posted from another site');
});

test('a request goes to statusd with its token and no cookie, keeps the editor\'s CSP, and another site is refused', async (t) => {
  let seen = null;
  const statusd = http.createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie ?? null };
    res.writeHead(200, { 'content-security-policy': "default-src 'self'" });
    res.end('workbench');
  });
  const statusPort = await listen(statusd);
  let target = { host: '127.0.0.1', statusPort, sessionToken: 'sess' };
  const proxy = http.createServer((req, res) => handleEditorRequest(req, res, { id: '0a1b2c3d', target }));
  const port = await listen(proxy);
  t.after(() => { statusd.close(); proxy.close(); });
  const base = `http://127.0.0.1:${port}/__woodshed/code/`;

  const res = await fetch(base, { headers: { cookie: '__Host-woodshed_app=x', authorization: 'Bearer from-browser', 'sec-fetch-site': 'same-origin' } });
  assert.equal(await res.text(), 'workbench');
  assert.deepEqual(seen, { url: '/__woodshed/code/', authorization: 'Bearer sess', cookie: null });
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self', frame-ancestors 'self'", 'two policies, each enforced');

  seen = null;
  for (const site of ['cross-site', 'same-site']) {
    const refused = await fetch(base, { method: 'POST', headers: { 'sec-fetch-site': site }, body: '{}' });
    assert.equal(refused.status, 403, `${site}: a sibling session's app is same-site`);
  }
  assert.equal(seen, null);

  target = null;
  const gone = await fetch(base);
  assert.deepEqual([gone.status, await gone.text()], [404, 'no editor for that session\n']);
});

// A raw upgrade through handleEditorUpgrade to a stand-in statusd that answers 101 and says what it was sent.
function upgrade({ origin, target = true }) {
  return new Promise((resolve, reject) => {
    const statusd = net.createServer((socket) => {
      socket.once('data', (request) => {
        const seen = String(request);
        socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nsaw:${/authorization: Bearer sess/i.test(seen) ? 'token' : 'no-token'}|${/cookie:/i.test(seen) ? 'cookie' : 'no-cookie'}`);
      });
    });
    statusd.listen(0, '127.0.0.1', () => {
      const proxy = http.createServer();
      proxy.on('upgrade', (req, socket, head) => handleEditorUpgrade(req, socket, head, {
        id: '0a1b2c3d', target: target ? { host: '127.0.0.1', statusPort: statusd.address().port, sessionToken: 'sess' } : null,
      }));
      proxy.listen(0, '127.0.0.1', () => {
        const client = net.connect(proxy.address().port, '127.0.0.1', () => {
          const lines = ['GET /__woodshed/code/?reconnectionToken=r HTTP/1.1', 'Host: 0a1b2c3d.apps.example', 'Upgrade: websocket', 'Connection: Upgrade', 'Cookie: __Host-woodshed_app=x'];
          if (origin) lines.push(`Origin: ${origin}`);
          client.write(`${lines.join('\r\n')}\r\n\r\n`);
        });
        let got = '';
        client.on('data', (chunk) => { got += chunk; });
        client.on('close', () => { proxy.close(); statusd.close(); resolve(got); });
        client.on('error', reject);
      });
    });
  });
}

test('the editor\'s websocket needs its own origin, and reaches statusd with the token and no cookie', async () => {
  assert.match(await upgrade({ origin: 'https://0a1b2c3d.apps.example' }), /saw:token\|no-cookie/);
  assert.match(await upgrade({ origin: 'https://ffffffff.apps.example' }), /^HTTP\/1\.1 403/, 'another session\'s app');
  assert.match(await upgrade({ origin: 'https://apps.example' }), /^HTTP\/1\.1 403/, 'the console');
  assert.match(await upgrade({ origin: 'https://0a1b2c3d.apps.example', target: false }), /^HTTP\/1\.1 404/);
});
