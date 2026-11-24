import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

import { OP, acceptFor, createFrameReader, encodeFrame } from '../shared/wsFrames.mjs';
import { basicAuth, handleTerminalRequest, handleTerminalUpgrade, offerWithoutClientContext, parseTerminalPath, takeFirstMessage } from './terminalProxy.mjs';

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

  const res = await fetch(`http://127.0.0.1:${proxyPort}/term/0a1b2c3d/`, { headers: { cookie: 'a=b' } });
  assert.equal(await res.text(), 'ok');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.deepEqual(seen, { url: '/term/0a1b2c3d/', authorization: basicAuth('secret'), cookie: undefined });

  const missing = await fetch(`http://127.0.0.1:${proxyPort}/term/ffffffff/`);
  assert.equal(missing.status, 404);
});

test("ttyd's /token never reaches the browser: the console gives the terminal its credential itself", async (t) => {
  const asked = [];
  const ttyd = http.createServer((req, res) => {
    asked.push(req.url);
    res.end(JSON.stringify({ token: Buffer.from('woodshed:secret').toString('base64') }));
  });
  const ttydPort = await listen(ttyd);
  const sessions = { '0a1b2c3d': { host: '127.0.0.1', termPort: ttydPort, statusPort: 1, shellPort: ttydPort, terminalToken: 'secret', sessionToken: 'other' } };
  const proxy = http.createServer((req, res) => { handleTerminalRequest(req, res, { targetFor: (id) => sessions[id] ?? null }); });
  const proxyPort = await listen(proxy);
  t.after(() => { ttyd.close(); proxy.close(); });

  for (const path of ['/term/0a1b2c3d/token', '/shell/0a1b2c3d/token', '/term/0a1b2c3d/token?x=1']) {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(await res.text(), /secret|d29vZHNoZWQ6c2VjcmV0/, path);
  }
  assert.deepEqual(asked, [], 'ttyd was never asked');
});

const CREDENTIAL = Buffer.from('woodshed:secret').toString('base64');
const hello = (body) => encodeFrame(OP.binary, Buffer.from(JSON.stringify(body)));

test('the first message is the console\'s: its credential, the size the browser asked for, then the rest as it came', () => {
  const typed = encodeFrame(OP.binary, Buffer.from('0ls\r'));
  const sent = Buffer.concat([hello({ AuthToken: 'the browser\'s guess', columns: 120, rows: 40 }), typed]);
  const { forward } = takeFirstMessage(sent, CREDENTIAL);
  const messages = [];
  createFrameReader((m) => messages.push(m))(forward);
  assert.equal(messages.length, 2);
  assert.deepEqual(JSON.parse(messages[0].payload.toString()), { AuthToken: CREDENTIAL, columns: 120, rows: 40 });
  assert.ok(forward.subarray(forward.length - typed.length).equals(typed), 'what came after passes byte for byte');
});

test('the first message waits until it is all there, lets a ping go first, and refuses what no terminal sends', () => {
  const first = hello({ columns: 90, rows: 30 });
  for (let cut = 0; cut < first.length; cut++) assert.equal(takeFirstMessage(first.subarray(0, cut), CREDENTIAL), null, `${cut} bytes`);

  const ping = encodeFrame(OP.ping, Buffer.from('p'));
  const { forward } = takeFirstMessage(Buffer.concat([ping, first]), CREDENTIAL);
  const messages = [];
  createFrameReader((m) => messages.push(m))(forward);
  assert.deepEqual(messages.map((m) => m.opcode), [OP.ping, OP.text]);

  const odd = takeFirstMessage(hello({ columns: -3, rows: 'tall' }), CREDENTIAL);
  const sized = [];
  createFrameReader((m) => sized.push(m))(odd.forward);
  assert.deepEqual(JSON.parse(sized[0].payload.toString()), { AuthToken: CREDENTIAL, columns: 80, rows: 24 });

  // A browser that compresses its messages (permessage-deflate) sets RSV1 on them: each inflates on its own.
  const deflated = zlib.deflateRawSync(Buffer.from(JSON.stringify({ columns: 132, rows: 50 })), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, -4);
  const compressed = encodeFrame(OP.binary, deflated);
  compressed[0] |= 0x40;
  const fromCompressed = [];
  createFrameReader((m) => fromCompressed.push(m))(takeFirstMessage(compressed, CREDENTIAL).forward);
  assert.deepEqual(JSON.parse(fromCompressed[0].payload.toString()), { AuthToken: CREDENTIAL, columns: 132, rows: 50 }, 'sent on uncompressed');

  const rsv2 = hello({});
  rsv2[0] |= 0x20;
  assert.throws(() => takeFirstMessage(rsv2, CREDENTIAL), /RSV2/);
  assert.throws(() => takeFirstMessage(encodeFrame(OP.binary, Buffer.from('not json')), CREDENTIAL), /not JSON/);
  assert.throws(() => takeFirstMessage(encodeFrame(OP.binary, Buffer.alloc(5000, 0x20)), CREDENTIAL), /larger/);
  assert.throws(() => takeFirstMessage(encodeFrame(OP.binary, Buffer.from('{}'), { mask: false }), CREDENTIAL), /unmasked/);
});

test('a browser\'s compression offer asks for each of its messages compressed on its own, and nothing else changes', () => {
  assert.equal(offerWithoutClientContext('permessage-deflate; client_max_window_bits'), 'permessage-deflate; client_no_context_takeover; client_max_window_bits');
  assert.equal(offerWithoutClientContext('permessage-deflate'), 'permessage-deflate; client_no_context_takeover');
  assert.equal(offerWithoutClientContext('permessage-deflate; client_no_context_takeover'), 'permessage-deflate; client_no_context_takeover');
  assert.equal(offerWithoutClientContext('x-webkit-deflate-frame, permessage-deflate'), 'x-webkit-deflate-frame, permessage-deflate; client_no_context_takeover');
  assert.equal(offerWithoutClientContext(undefined), undefined);
});

test('through the proxy, ttyd gets the console\'s first message and then the browser\'s bytes', async (t) => {
  const received = [];
  let gotAll;
  const done = new Promise((resolve) => { gotAll = resolve; });
  const ttyd = net.createServer((conn) => {
    let head = Buffer.alloc(0);
    let read = null;
    conn.on('data', (chunk) => {
      if (read) return read(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const request = head.subarray(0, end).toString();
      const key = /sec-websocket-key: (\S+)/i.exec(request)[1];
      received.push({ request: request.split('\r\n')[0], authorization: /authorization: (.+)/i.exec(request)?.[1], extensions: /sec-websocket-extensions: (.+)/i.exec(request)?.[1] });
      conn.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Protocol: tty\r\n\r\n`);
      read = createFrameReader((m) => {
        received.push(m.payload.toString());
        if (received.length === 3) gotAll();
      });
      const rest = head.subarray(end + 4);
      if (rest.length) read(rest);
    });
  });
  const ttydPort = await listen(ttyd);
  const sessions = { '0a1b2c3d': { host: '127.0.0.1', termPort: ttydPort, statusPort: 1, terminalToken: 'secret', sessionToken: 'other' } };
  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => handleTerminalUpgrade(req, socket, head, { targetFor: (id) => sessions[id] ?? null }));
  const proxyPort = await listen(proxy);
  t.after(() => { ttyd.close(); proxy.close(); });

  const client = net.connect(proxyPort, '127.0.0.1');
  t.after(() => client.destroy());
  await new Promise((resolve) => client.on('connect', resolve));
  client.write(['GET /term/0a1b2c3d/ws HTTP/1.1', 'Host: console.example', 'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol: tty',
    'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits', '', ''].join('\r\n'));
  const answer = await new Promise((resolve) => client.once('data', (d) => resolve(d.toString().split('\r\n')[0])));
  assert.equal(answer, 'HTTP/1.1 101 Switching Protocols');
  // The size, then a keystroke, split mid-frame as a network may.
  const sent = Buffer.concat([hello({ columns: 100, rows: 30 }), encodeFrame(OP.binary, Buffer.from('0q'))]);
  client.write(sent.subarray(0, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.write(sent.subarray(5));
  await done;

  assert.deepEqual(received[0], { request: 'GET /term/0a1b2c3d/ws HTTP/1.1', authorization: basicAuth('secret'),
    extensions: 'permessage-deflate; client_no_context_takeover; client_max_window_bits' });
  assert.deepEqual(JSON.parse(received[1]), { AuthToken: CREDENTIAL, columns: 100, rows: 30 });
  assert.equal(received[2], '0q');
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
