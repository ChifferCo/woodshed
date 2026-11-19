import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createMcpServers, mcpSettings } from './mcpServers.mjs';
import { createMcpTester } from './mcpTest.mjs';
import { createOidcIssuer, verifyJwt } from './oidcIssuer.mjs';
import { createHandler } from './server.mjs';
import { IDENTITY_HEADER, createTrustedIdentity, signIdentity } from './trustedIdentity.mjs';

const quietly = (t) => {
  const logged = [];
  t.mock.method(console, 'log', (...args) => { logged.push(args); });
  t.mock.method(console, 'warn', (...args) => { logged.push(args); });
  t.mock.method(console, 'error', (...args) => { logged.push(args); });
  return logged;
};

function fakeSecrets() {
  const values = new Map();
  return { values, async save(name, value) { values.set(name, value); }, async read(name) { return values.get(name) ?? null; }, async remove(name) { values.delete(name); } };
}

// A body no answer may ever carry back: the fake server puts it in every answer.
const SECRET_BODY = 'body-only-the-server-sees-7f3a';

/**
 * A made-up MCP server on loopback. `mode`: json, sse (with a session id it then requires), or refuse (401).
 * @returns {Promise<{url: string, calls: object[]}>}
 */
async function fakeMcp(t, { mode = 'json', tools = 3, capabilities = { tools: {} } } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'refuse') {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        return res.end(JSON.stringify({ error: SECRET_BODY }));
      }
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      if (!body?.id) { res.writeHead(202); return res.end(); }
      if (mode === 'sse' && body.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-42') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'no session' } }));
      }
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities, serverInfo: { name: 'fake-mcp', version: '1.2.3' }, instructions: SECRET_BODY }
        : { tools: Array.from({ length: tools }, (_, i) => ({ name: `tool${i}`, description: SECRET_BODY })) };
      const message = { jsonrpc: '2.0', id: body.id, result };
      if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...(body.method === 'initialize' && { 'mcp-session-id': 'sess-42' }) });
        // A notification first, then the answer; the stream stays open, as a server's may.
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: SECRET_BODY } })}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        return undefined;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(message));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/mcp?tenant=acme`, calls };
}

function keyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'key.pem');
}

const NONE = mcpSettings({}, 'https://console.test');
const servers = (secrets = null) => createMcpServers({ store: { state: {}, save() {} }, settings: NONE, secrets, lockdown: () => ({ available: true }) });

test('a JSON answer: initialize, initialized, tools/list counted, the server\'s query kept, nothing of the body back', async (t) => {
  const logged = quietly(t);
  const mcp = await fakeMcp(t);
  const tester = createMcpTester({ servers: servers() });
  const answer = await tester.run({ server: { name: 'docs', url: mcp.url }, by: 'ana' });
  assert.equal(answer.ok, true);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.serverInfo, { name: 'fake-mcp', version: '1.2.3' });
  assert.equal(answer.tools, 3);
  assert.equal(typeof answer.ms, 'number');
  assert.deepEqual(mcp.calls.map((c) => c.body?.method ?? c.method), ['initialize', 'notifications/initialized', 'tools/list']);
  const init = mcp.calls[0];
  assert.equal(init.url, '/mcp?tenant=acme');
  assert.equal(init.headers.accept, 'application/json, text/event-stream');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.authorization, undefined, 'auth none adds nothing');
  assert.deepEqual(init.body.params, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'woodshed-console', version: 'test' } });
  assert.equal(mcp.calls[2].headers['mcp-protocol-version'], '2025-06-18');
  assert.ok(!JSON.stringify(answer).includes(SECRET_BODY));
  assert.ok(!JSON.stringify(logged).includes(SECRET_BODY));
  assert.deepEqual(logged.find((l) => l[0] === 'mcpServers: server tested')[1], { name: 'docs', host: new URL(mcp.url).host, ok: true, status: 200, by: 'ana' });
});

test('an SSE answer: the session id is carried to tools/list and the session deleted after', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t, { mode: 'sse', tools: 5 });
  const answer = await createMcpTester({ servers: servers() }).run({ server: { name: 'docs', url: mcp.url }, by: 'ana' });
  assert.deepEqual(answer, { ok: true, status: 200, serverInfo: { name: 'fake-mcp', version: '1.2.3' }, tools: 5, ms: answer.ms });
  assert.deepEqual(mcp.calls.map((c) => [c.body?.method ?? c.method, c.headers['mcp-session-id'] ?? null]),
    [['initialize', null], ['notifications/initialized', 'sess-42'], ['tools/list', 'sess-42'], ['DELETE', 'sess-42']]);
});

test('a server with no tools capability is not asked for its tools', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t, { capabilities: {} });
  const answer = await createMcpTester({ servers: servers() }).run({ server: { name: 'docs', url: mcp.url }, by: 'ana' });
  assert.equal(answer.ok, true);
  assert.equal(answer.tools, null);
  assert.ok(!mcp.calls.some((c) => c.body?.method === 'tools/list'));
});

test('header auth: a typed value over the saved one, the saved one without, and a sentence with neither', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t);
  const secrets = fakeSecrets();
  const list = servers(secrets);
  const tester = createMcpTester({ servers: list });
  const tracker = { name: 'tracker', url: mcp.url, auth: 'header', header: 'X-Api-Key', shared: true };

  const none = await tester.run({ server: tracker, by: 'ana' });
  assert.equal(none.ok, false);
  assert.equal(none.status, null);
  assert.match(none.error, /x-api-key header has no value yet/);
  assert.equal(mcp.calls.length, 0, 'nothing is sent without it');

  await list.save({ server: tracker, by: 'ana' });
  await list.setHeader({ name: 'tracker', value: 'saved-key', by: 'ana' });
  const typed = await tester.run({ server: tracker, value: 'typed-key', by: 'ana' });
  assert.equal(typed.ok, true);
  assert.equal(mcp.calls.at(-1).headers['x-api-key'], 'typed-key');
  const saved = await tester.run({ name: 'tracker', by: 'ana' });
  assert.equal(saved.ok, true);
  assert.ok(mcp.calls.slice(-3).every((c) => c.headers['x-api-key'] === 'saved-key'));
  // An edited server keeps the saved value only while its header's name stays.
  const renamed = await tester.run({ server: { ...tracker, header: 'x-other' }, by: 'ana' });
  assert.match(renamed.error, /x-other header has no value yet/);
  assert.ok(![none, typed, saved, renamed].some((a) => /saved-key|typed-key/.test(JSON.stringify(a))));
  await assert.rejects(tester.run({ server: tracker, value: 'a\nb', by: 'ana' }), (err) => err.shown && err.status === 400);
});

test('oidc auth: a token for the server\'s audience, subject console:test, the test\'s own claims and no session', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t);
  const issuer = createOidcIssuer({ issuer: 'https://c.test', keyFile: keyFile(t) });
  const kept = servers();
  // Not saved yet: tested with no token, so none can be caught at an address an admin typed.
  const unsaved = await createMcpTester({ servers: kept, issuer }).run({ server: { name: 'orders', url: mcp.url, production: true, people: ['joel'] }, by: 'ana' });
  assert.equal(unsaved.ok, true);
  assert.equal(mcp.calls[0].headers.authorization, undefined);
  await kept.save({ server: { name: 'orders', url: mcp.url, production: true, people: ['joel'] }, by: 'ana' });
  const before = mcp.calls.length;
  const answer = await createMcpTester({ servers: kept, issuer }).run({ name: 'orders', by: 'ana' });
  assert.equal(answer.ok, true, 'a production server is tested though no session could be locked down here');
  const token = mcp.calls[before].headers.authorization.replace(/^Bearer /, '');
  const checked = verifyJwt(token, await issuer.jwks());
  assert.ok(checked);
  assert.equal(checked.payload.aud, 'woodshed-prod-mcp');
  assert.equal(checked.payload.sub, 'console:test');
  assert.equal(checked.payload.iss, 'https://c.test');
  assert.equal(checked.payload.test, true);
  assert.equal(checked.payload.by, 'ana');
  assert.equal(checked.payload.session_id, undefined);
  assert.ok(!JSON.stringify(answer).includes(token));

  // The saved name at another address, or with another audience, is not the saved server: no token.
  const elsewhere = await fakeMcp(t);
  await createMcpTester({ servers: kept, issuer }).run({ server: { name: 'orders', url: elsewhere.url, production: true, people: ['joel'] }, by: 'ana' });
  await createMcpTester({ servers: kept, issuer }).run({ server: { name: 'orders', url: mcp.url, production: true, people: ['joel'], audience: 'other' }, by: 'ana' });
  assert.equal(elsewhere.calls[0].headers.authorization, undefined);
  assert.equal(mcp.calls.at(-1).headers.authorization, undefined);
  // The edited form of the saved server, unchanged, is: the page sends it so.
  const from = mcp.calls.length;
  await createMcpTester({ servers: kept, issuer }).run({ server: { name: 'orders', url: mcp.url, production: true, people: ['joel'] }, by: 'ana' });
  assert.match(mcp.calls[from].headers.authorization, /^Bearer /);

  // The environment's server, by its name, as stored.
  const env = mcpSettings({ WOODSHED_PROD_MCP_URL: mcp.url, WOODSHED_PROD_MCP_PEOPLE: 'joel' }, 'https://c.test');
  const withEnv = createMcpServers({ store: { state: {}, save() {} }, settings: env, lockdown: () => ({ available: false, why: 'none' }) });
  assert.equal((await createMcpTester({ servers: withEnv, issuer }).run({ name: 'woodshed-prod', by: 'ana' })).ok, true);
  assert.equal(verifyJwt(mcp.calls.at(-1).headers.authorization.slice(7), await issuer.jwks()).payload.aud, 'woodshed-prod-mcp');
});

test('a refusal, an unreachable host and an unknown name each come back as what to do', async (t) => {
  const logged = quietly(t);
  const refusing = await fakeMcp(t, { mode: 'refuse' });
  const issuer = createOidcIssuer({ issuer: 'https://c.test', keyFile: keyFile(t) });
  const kept = servers();
  const tester = createMcpTester({ servers: kept, issuer });
  const unsigned = await tester.run({ server: { name: 'orders', url: refusing.url, auth: 'oidc', audience: 'orders-api' }, by: 'ana' });
  assert.equal(unsigned.status, 401);
  assert.match(unsigned.error, /no token: the console signs one only for a saved server/);
  await kept.save({ server: { name: 'orders', url: refusing.url, auth: 'oidc', audience: 'orders-api' }, by: 'ana' });
  const refused = await tester.run({ name: 'orders', by: 'ana' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 401);
  assert.match(refused.error, /did not accept what the console added/);
  assert.match(refused.error, /https:\/\/c\.test\/\.well-known\/jwks\.json/);
  assert.match(refused.error, /orders-api/);
  assert.ok(!JSON.stringify(refused).includes(SECRET_BODY));

  // A port nothing listens on.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const { port } = closed.address();
  await new Promise((r) => closed.close(r));
  const away = await tester.run({ server: { name: 'gone', url: `http://127.0.0.1:${port}/mcp?key=in-the-query` }, by: 'ana' });
  assert.deepEqual(away, { ok: false, status: null, error: `The console could not reach 127.0.0.1:${port}: nothing is listening on that port.` });
  assert.ok(!JSON.stringify(logged).includes('in-the-query'), 'the log names the host, never the query');

  // One that never answers: the test gives up at its timeout.
  const silent = http.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => { silent.closeAllConnections(); silent.close(); });
  const slow = await createMcpTester({ servers: servers(), timeoutMs: 200 }).run({ server: { name: 'slow', url: `http://127.0.0.1:${silent.address().port}` }, by: 'ana' });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /did not answer within/);

  await assert.rejects(tester.run({ name: 'nope', by: 'ana' }), (err) => err.status === 404);
  await assert.rejects(tester.run({ server: { name: 'x', url: 'ftp://x' }, by: 'ana' }), (err) => err.status === 400);
});

test('an answer that is not an MCP server\'s, or a JSON-RPC error, says so', async (t) => {
  quietly(t);
  let answer = (res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html>${SECRET_BODY}</html>`); };
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => answer(res)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const tester = createMcpTester({ servers: servers() });
  const html = await tester.run({ server: { name: 'web', url }, by: 'ana' });
  assert.equal(html.ok, false);
  assert.match(html.error, /answered, but not as an MCP server/);
  answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unsupported protocol version' } })); };
  const rpc = await tester.run({ server: { name: 'web', url }, by: 'ana' });
  assert.equal(rpc.error, `127.0.0.1:${server.address().port} refused the console's initialize call: Unsupported protocol version.`);
  answer = (res) => { res.writeHead(404); res.end(); };
  assert.match((await tester.run({ server: { name: 'web', url }, by: 'ana' })).error, /no MCP endpoint at that path.*\/mcp\?/);
  assert.ok(![html, rpc].some((a) => JSON.stringify(a).includes(SECRET_BODY)));
});

// The API as a hosting program calls it: behind its proxy's identity header, as an owner.
const SECRET = 'the-hosts-identity-secret-0123456789abcdef';
const identity = (login, role) => ({ [IDENTITY_HEADER]: signIdentity({ secret: SECRET, login, role, exp: Date.now() + 60_000 }) });

function send(port, { method = 'GET', path: where, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: where, headers: { host: 'console.example', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the test API: an owner tests a saved or an edited server, a member is refused, and no value comes back', async (t) => {
  const logged = quietly(t);
  const mcp = await fakeMcp(t);
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5,
    limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example', launcher: { kind: 'docker' }, localLogin: 'local', trustedIdentitySecret: SECRET,
  };
  const secrets = fakeSecrets();
  const mcpServers = servers(secrets);
  await mcpServers.save({ server: { name: 'tracker', url: mcp.url, auth: 'header' }, by: 'ana' });
  await mcpServers.setHeader({ name: 'tracker', value: 'Bearer key-123', by: 'ana' });
  const handle = createHandler({ config, fleet: { sessions: () => [] }, trusted: createTrustedIdentity({ secret: SECRET }), mcpServers });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const write = { origin: 'https://console.example', 'x-woodshed': '1', 'content-type': 'application/json' };
  const where = '/api/console-settings/mcp-servers/test';

  assert.equal((await send(port, { method: 'POST', path: where, headers: { ...write, ...identity('sam', 'member') }, body: { name: 'tracker' } })).status, 403);
  const owner = identity('ana', 'owner');
  assert.equal((await send(port, { method: 'POST', path: where, headers: { ...owner, 'content-type': 'application/json' }, body: { name: 'tracker' } })).status, 403, 'no x-woodshed header');
  assert.equal(mcp.calls.length, 0);

  const saved = await send(port, { method: 'POST', path: where, headers: { ...write, ...owner }, body: { name: 'tracker' } });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...saved.body, ms: 0 }, { ok: true, status: 200, serverInfo: { name: 'fake-mcp', version: '1.2.3' }, tools: 3, ms: 0 });
  assert.equal(mcp.calls[0].headers.authorization, 'Bearer key-123');
  const edited = await send(port, { method: 'POST', path: where, headers: { ...write, ...owner }, body: { server: { name: 'tracker', url: mcp.url, auth: 'header' }, value: 'Bearer typed' } });
  assert.equal(edited.body.ok, true);
  assert.equal(mcp.calls.at(-1).headers.authorization, 'Bearer typed');
  assert.equal(mcpServers.get('tracker').updatedBy, 'ana', 'a test saves nothing');

  const bad = await send(port, { method: 'POST', path: where, headers: { ...write, ...owner }, body: { server: { name: 'x', url: 'ftp://x' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /http\(s\)/);
  assert.equal((await send(port, { method: 'POST', path: where, headers: { ...write, ...owner }, body: { name: 'nope' } })).status, 404);
  assert.equal((await send(port, { method: 'POST', path: where, headers: { ...write, ...owner }, body: {} })).status, 400);
  const everything = JSON.stringify([saved, edited, logged]);
  for (const secret of ['key-123', 'Bearer typed', SECRET_BODY]) assert.ok(!everything.includes(secret), `${secret} never in an answer or the log`);
});

test('the console never calls a link-local address, the instance metadata\'s among them, by address or by name', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { createMcpServers, mcpSettings, isLinkLocal } = await import('./mcpServers.mjs');
  const { createMcpTester } = await import('./mcpTest.mjs');
  const servers = createMcpServers({ store: { state: {} }, settings: mcpSettings({}, 'https://c.test'), lockdown: () => ({ available: true }) });
  const called = [];
  const lookup = (host, opts, cb) => cb(Object.assign(new Error(`${host} resolves to 169.254.169.254, a link-local address the console never calls`), { code: 'ELINKLOCAL' }));
  const tester = createMcpTester({ servers, fetch: async (url) => { called.push(url); throw new Error('called'); }, lookup });
  for (const url of ['http://169.254.169.254/latest', 'http://[fd00:ec2::254]/', 'http://metadata.test/mcp']) {
    const answer = await tester.run({ server: { name: 'x', url }, by: 'ana' });
    assert.equal(answer.ok, false, url);
    assert.match(answer.error, /link-local/, url);
  }
  assert.deepEqual(called, []);
  for (const a of ['169.254.169.254', 'fe80::1', 'fd00:ec2::254', '::ffff:169.254.1.1']) assert.equal(isLinkLocal(a), true, a);
  for (const a of ['127.0.0.1', '10.0.0.5', '93.184.216.34', 'fd00::1']) assert.equal(isLinkLocal(a), false, a);
});

test('the handshake must end well: a server that refuses notifications/initialized is no green test', async (t) => {
  quietly(t);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (body.method === 'initialize') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x', version: '1' } } }));
      res.writeHead(401).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const answer = await createMcpTester({ servers: servers() }).run({ server: { name: 'nt', url: `http://127.0.0.1:${server.address().port}/mcp` }, by: 'ana' });
  assert.equal(answer.ok, false);
  assert.equal(answer.status, 401);
});

test('a saved header value goes only to its saved address\'s origin', async (t) => {
  quietly(t);
  const home = await fakeMcp(t);
  const other = await fakeMcp(t);
  const secrets = { configured: () => true, async save() {}, async read() { return 'Bearer saved-value'; }, async remove() {} };
  const store = { state: { mcpServers: [{ name: 'h', url: home.url, production: false, shared: false, people: '*', repos: '*', auth: 'header', audience: null, header: 'authorization', headerSavedAt: 'x' }] }, save() {} };
  const kept = createMcpServers({ store, settings: NONE, secrets, lockdown: () => ({ available: true }) });
  const away = await createMcpTester({ servers: kept }).run({ server: { name: 'h', url: other.url, auth: 'header' }, by: 'ana' });
  assert.match(away.error, /no value yet/);
  assert.equal(other.calls.length, 0);
  assert.equal((await createMcpTester({ servers: kept }).run({ server: { name: 'h', url: home.url, auth: 'header' }, by: 'ana' })).ok, true);
  assert.equal(home.calls[0].headers.authorization, 'Bearer saved-value');
});
