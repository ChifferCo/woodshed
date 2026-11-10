import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';

import { loadConfig } from './config.mjs';
import { createHandler } from './server.mjs';
import { createTlsAskHandler, isLoopback, startTlsAsk, tlsAskVerdict } from './tlsAsk.mjs';

const config = {
  publicUrl: 'https://woodshed.203-0-113-10.sslip.io',
  extraHosts: ['203.0.113.10', 'Other.Example.com'],
  appDomain: 'woodshed.203-0-113-10.sslip.io',
};
const sessions = () => [{ id: '0a1b2c3d' }, { id: 'aaaa1111', status: 'stopped' }, { id: 'dead0001', cleanedAt: '2026-11-01T00:00:00Z' }];
const verdict = (domain) => tlsAskVerdict({ domain, ...config, sessionIds: new Set(['0a1b2c3d', 'aaaa1111']) });

test('tlsAskVerdict allows the console host, the extra hosts and a known session app', () => {
  assert.deepEqual(verdict('woodshed.203-0-113-10.sslip.io'), { allowed: true, why: 'console host' });
  assert.deepEqual(verdict('WOODSHED.203-0-113-10.sslip.io.'), { allowed: true, why: 'console host' });
  assert.deepEqual(verdict('other.example.com'), { allowed: true, why: 'extra host' });
  assert.deepEqual(verdict('0a1b2c3d.woodshed.203-0-113-10.sslip.io'), { allowed: true, why: 'session' });
  assert.deepEqual(verdict('aaaa1111.woodshed.203-0-113-10.sslip.io'), { allowed: true, why: 'session' }, 'a stopped session still counts');
});

test('tlsAskVerdict refuses unknown ids, other domains and malformed names', () => {
  for (const domain of [
    'ffff0000.woodshed.203-0-113-10.sslip.io', // no such session
    'x.0a1b2c3d.woodshed.203-0-113-10.sslip.io', 'a.woodshed.203-0-113-10.sslip.io', '0a1b2c3d.woodshed.203-0-113-10.sslip.io.evil',
    '0a1b2c3d.other.example.com', 'evil.example', 'sslip.io', '203-0-113-10.sslip.io',
    '', null, undefined, ['woodshed.203-0-113-10.sslip.io'], '0a1b2c3d.woodshed.203-0-113-10.sslip.io:443',
    'woodshed.203-0-113-10.sslip.io/x', '*.woodshed.203-0-113-10.sslip.io', 'a..b', `${'a'.repeat(64)}.example.com`, 'a b.example.com',
  ]) {
    assert.deepEqual(verdict(domain), { allowed: false, why: 'unknown' }, String(domain));
  }
  const noApps = tlsAskVerdict({ domain: '0a1b2c3d.woodshed.203-0-113-10.sslip.io', ...config, appDomain: '', sessionIds: new Set(['0a1b2c3d']) });
  assert.equal(noApps.allowed, false, 'no app domain, no session names');
});

test('isLoopback takes only the machine itself', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(address), true, address);
  for (const address of ['10.0.0.1', '203.0.113.10', '::ffff:10.0.0.1', '0.0.0.0', '::', 'fe80::1', '', undefined]) assert.equal(isLoopback(address), false, String(address));
});

// A request as node hands one to the handler, with only what it reads.
function call(handler, { url, method = 'GET', remoteAddress = '127.0.0.1', headers = {} }) {
  const res = { status: null, writeHead(status) { this.status = status; }, end() {} };
  handler({ url, method, headers, socket: { remoteAddress } }, res);
  return res.status;
}

function quietly(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('the handler answers 200 only for a loopback GET of an allowed name, and logs refusals at most once a minute', () => {
  let clock = 0;
  const handler = createTlsAskHandler({ config, sessions, now: () => clock });
  const ask = (domain, more = {}) => call(handler, { url: `/tls-ask?domain=${encodeURIComponent(domain)}`, ...more });
  const lines = quietly(() => {
    assert.equal(ask('woodshed.203-0-113-10.sslip.io'), 200);
    assert.equal(ask('0a1b2c3d.woodshed.203-0-113-10.sslip.io'), 200);
    assert.equal(ask('0a1b2c3d.woodshed.203-0-113-10.sslip.io', { remoteAddress: '::ffff:127.0.0.1' }), 200);
    assert.equal(ask('dead0001.woodshed.203-0-113-10.sslip.io'), 403, 'a deleted session no longer counts');
    assert.equal(ask('ffff0000.woodshed.203-0-113-10.sslip.io'), 403);
    assert.equal(ask('0a1b2c3d.woodshed.203-0-113-10.sslip.io', { remoteAddress: '203.0.113.10' }), 403, 'not from loopback');
    // What a public request would look like if a proxy were pointed at this port by mistake.
    assert.equal(ask('0a1b2c3d.woodshed.203-0-113-10.sslip.io', { headers: { 'x-forwarded-for': '203.0.113.9' } }), 403);
    assert.equal(ask('0a1b2c3d.woodshed.203-0-113-10.sslip.io', { headers: { forwarded: 'for=203.0.113.9' } }), 403);
    assert.equal(call(handler, { url: '/tls-ask' }), 403, 'no domain');
    assert.equal(call(handler, { url: '/tls-ask?domain=woodshed.203-0-113-10.sslip.io', method: 'POST' }), 405);
    assert.equal(call(handler, { url: '/other?domain=woodshed.203-0-113-10.sslip.io' }), 404);
    clock += 61_000;
    assert.equal(ask('evil.example'), 403);
  });
  const asked = lines.filter(([message]) => message === 'tls: certificate asked').map(([, meta]) => meta);
  assert.deepEqual(asked.map(({ allowed, why }) => [allowed, why]), [
    [true, 'console host'], [true, 'session'], [true, 'session'],
    [false, 'unknown'], // the first refusal; the next five fall in the same minute and are counted
    [false, 'unknown'],
  ]);
  assert.equal(asked.at(-1).refused, 6, 'the refusals counted since the last line, this one included');
});

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function status(port, domain, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/tls-ask?domain=${domain}`, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

test('startTlsAsk listens on loopback only, and not at all without a port', async (t) => {
  t.mock.method(console, 'log', () => {});
  assert.equal(await startTlsAsk({ config: { ...config, tlsAskPort: null }, sessions }), null);
  const server = await startTlsAsk({ config: { ...config, tlsAskPort: await freePort() }, sessions });
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(await status(server.address().port, '0a1b2c3d.woodshed.203-0-113-10.sslip.io'), 200);
  assert.equal(await status(server.address().port, 'ffff0000.woodshed.203-0-113-10.sslip.io'), 403);
});

test('WOODSHED_CLOUD_TLS_ASK_PORT is off unless set, and must be a port', () => {
  const base = { GH_TOKEN: 'x' };
  assert.equal(loadConfig(base).tlsAskPort, null);
  assert.equal(loadConfig({ ...base, WOODSHED_CLOUD_TLS_ASK_PORT: '7692' }).tlsAskPort, 7692);
  assert.throws(() => loadConfig({ ...base, WOODSHED_CLOUD_TLS_ASK_PORT: 'nope' }), /not a port/);
});

// Caddy reaches the console's own port from loopback, so a public request for /tls-ask must find nothing there, even
// on a console with no sign-in, the most open it gets.
test('the console\'s own port does not answer the question', async (t) => {
  const fleet = { sessions, find: () => null };
  const handle = createHandler({ config: { ...config, host: '127.0.0.1', repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } }, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());
  const viaCaddy = { 'x-forwarded-for': '203.0.113.9' };
  assert.equal(await status(port, '0a1b2c3d.woodshed.203-0-113-10.sslip.io', { ...viaCaddy, host: 'woodshed.203-0-113-10.sslip.io' }), 404);
  // On an app's name the path goes to that session's app, which is not running here.
  assert.equal(await status(port, '0a1b2c3d.woodshed.203-0-113-10.sslip.io', { ...viaCaddy, host: '0a1b2c3d.woodshed.203-0-113-10.sslip.io' }), 404);
});
