import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createMcpServers, headerSecretName, mcpSettings } from './mcpServers.mjs';
import { createHandler } from './server.mjs';
import { IDENTITY_HEADER, createTrustedIdentity, signIdentity } from './trustedIdentity.mjs';

const quietly = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

function fakeSecrets() {
  const values = new Map();
  return { values, async save(name, value) { values.set(name, value); }, async read(name) { return values.get(name) ?? null; }, async remove(name) { values.delete(name); } };
}

const NONE = mcpSettings({}, 'https://console.test');
const ENV = mcpSettings({ WOODSHED_PROD_MCP_URL: 'https://prod.test/mcp', WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: '*' }, 'https://console.test');

test('an admin adds, changes and removes servers in state.json, and a header\'s value only in the secret store', async (t) => {
  quietly(t);
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  const secrets = fakeSecrets();
  const servers = createMcpServers({ store, settings: ENV, secrets, lockdown: () => ({ available: true }), now: () => Date.parse('2026-11-19T10:00:00Z') });
  await servers.save({ server: { name: 'tracker', url: 'https://tracker.test/mcp', auth: 'header', header: 'X-Api-Key', shared: true }, by: 'ana' });
  await servers.setHeader({ name: 'tracker', value: 'key-123', by: 'ana' });
  assert.equal(secrets.values.get(headerSecretName('tracker')), 'key-123');
  assert.ok(!JSON.stringify(store.state).includes('key-123'), 'never in state.json');
  const view = servers.view();
  assert.deepEqual(view.servers.map((s) => [s.name, s.source, s.headerSet]), [['woodshed-prod', 'environment', false], ['tracker', 'console', true]]);
  assert.ok(!JSON.stringify(view).includes('key-123'), 'never in what the page or a program reads');
  assert.equal(view.jwks, 'https://console.test/.well-known/jwks.json');
  assert.equal(await servers.headerValue(servers.get('tracker')), 'key-123');

  // A change that keeps the header keeps its value; one that drops it deletes the secret.
  await servers.save({ server: { name: 'tracker', url: 'https://tracker.test/v2', auth: 'header', header: 'x-api-key', shared: true }, by: 'ana' });
  assert.equal(servers.get('tracker').headerSavedAt, '2026-11-19T10:00:00.000Z');
  await servers.save({ server: { name: 'tracker', url: 'https://tracker.test/v2', auth: 'oidc', shared: true }, by: 'ana' });
  assert.equal(secrets.values.size, 0);
  await assert.rejects(servers.setHeader({ name: 'tracker', value: 'x', by: 'ana' }), /adds no header/);

  await assert.rejects(servers.save({ server: { name: 'woodshed-prod', url: 'https://x.test' }, by: 'ana' }), /environment/);
  await assert.rejects(servers.remove({ name: 'woodshed-prod', by: 'ana' }), (err) => err.status === 409);
  await servers.remove({ name: 'tracker', by: 'ana' });
  assert.deepEqual(store.state.mcpServers, []);
  await assert.rejects(servers.remove({ name: 'tracker', by: 'ana' }), (err) => err.status === 404);
});

test('a production server is refused where no session can be locked down, and left out of what sessions get', async (t) => {
  quietly(t);
  const store = { state: {}, save() {} };
  const servers = createMcpServers({ store, settings: ENV, lockdown: () => ({ available: false, why: 'it has no session API' }) });
  await assert.rejects(servers.save({ server: { name: 'orders', url: 'https://orders.test', production: true, people: ['joel'] }, by: 'ana' }), /cannot: it has no session API/);
  await servers.save({ server: { name: 'docs', url: 'https://docs.test' }, by: 'ana' });
  assert.deepEqual(servers.forSession({ id: 'p', owner: 'joel' }, 'o/r'), [{ name: 'docs', production: false }], 'not even the environment\'s');
  assert.deepEqual(servers.view().production, { available: false, why: 'it has no session API' });
  await assert.rejects(servers.save({ server: { name: 'h', url: 'https://h.test', auth: 'header' }, by: 'ana' }), /no secret store/);
});

test('an embedding program keeps the list itself: each change goes to it, and what it answers is the list', async (t) => {
  quietly(t);
  const kept = new Map([['docs', { name: 'docs', url: 'https://docs.test', shared: true }], ['broken', { name: 'Bad Name', url: 'x' }]]);
  const calls = [];
  const host = {
    async list() { return [...kept.values()]; },
    async save({ server, by }) { calls.push(['save', server.name, by]); kept.set(server.name, server); },
    async remove({ name, by }) { calls.push(['remove', name, by]); kept.delete(name); },
  };
  const store = { state: {}, save() { throw new Error('nothing goes to state.json'); } };
  const servers = createMcpServers({ store, settings: NONE, host, lockdown: () => ({ available: true }) });
  await servers.load();
  assert.deepEqual(servers.list().map((s) => [s.name, s.source]), [['docs', 'host']], 'one it sent that does not check is left out');
  await servers.save({ server: { name: 'orders', url: 'https://orders.test', production: true, people: '*' }, by: 'ana' });
  await servers.remove({ name: 'docs', by: 'ana' });
  assert.deepEqual(calls, [['save', 'orders', 'ana'], ['remove', 'docs', 'ana']]);
  assert.deepEqual(servers.list().map((s) => s.name), ['orders']);
  assert.equal(store.state.mcpServers, undefined);
});

// The API as a hosting program calls it: behind its proxy's identity header, as an owner.
const SECRET = 'the-hosts-identity-secret-0123456789abcdef';
const identity = (login, role) => ({ [IDENTITY_HEADER]: signIdentity({ secret: SECRET, login, role, exp: Date.now() + 60_000 }) });

function send(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: 'console.example', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the API behind the card: an owner reads and changes the list, a member is refused, and no value comes back', async (t) => {
  quietly(t);
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5,
    limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'woodshed.example', launcher: { kind: 'docker' }, localLogin: 'local', trustedIdentitySecret: SECRET,
  };
  const store = { state: {}, save() {} };
  const secrets = fakeSecrets();
  const mcpServers = createMcpServers({ store, settings: NONE, secrets, lockdown: () => ({ available: true }) });
  const handle = createHandler({ config, fleet: { sessions: () => [] }, trusted: createTrustedIdentity({ secret: SECRET }), mcpServers });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const write = { origin: 'https://console.example', 'x-woodshed': '1', 'content-type': 'application/json' };
  const path = '/api/console-settings/mcp-servers';

  assert.equal((await send(port, { path, headers: identity('sam', 'member') })).status, 403);
  assert.equal((await send(port, { method: 'POST', path, headers: { ...write, ...identity('sam', 'member') }, body: { server: { name: 'x', url: 'https://x.test' } } })).status, 403);

  const owner = identity('ana', 'owner');
  const added = await send(port, { method: 'POST', path, headers: { ...write, ...owner }, body: { server: { name: 'tracker', url: 'https://tracker.test', auth: 'header' } } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.servers.map((s) => [s.name, s.auth, s.headerSet, s.updatedBy]), [['tracker', 'header', false, 'ana']]);
  const header = await send(port, { method: 'POST', path: `${path}/header`, headers: { ...write, ...owner }, body: { name: 'tracker', value: 'Bearer key-123' } });
  assert.equal(header.body.servers[0].headerSet, true);
  assert.ok(!JSON.stringify(header.body).includes('key-123'));
  const bad = await send(port, { method: 'POST', path, headers: { ...write, ...owner }, body: { server: { name: 'x', url: 'ftp://x' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /http\(s\)/);
  assert.deepEqual((await send(port, { path, headers: owner })).body.servers.map((s) => s.name), ['tracker']);
  const removed = await send(port, { method: 'POST', path: `${path}/remove`, headers: { ...write, ...owner }, body: { name: 'tracker' } });
  assert.deepEqual(removed.body.servers, []);
  assert.equal(secrets.values.size, 0);
});

test('a saved header value never follows its server to another origin: it must be typed again', async (t) => {
  quietly(t);
  const store = { state: {}, save() {} };
  const secrets = fakeSecrets();
  const servers = createMcpServers({ store, settings: NONE, secrets, lockdown: () => ({ available: true }) });
  await servers.save({ server: { name: 'h', url: 'https://a.test/mcp', auth: 'header' }, by: 'ana' });
  await servers.setHeader({ name: 'h', value: 'k-1', by: 'ana' });
  await servers.save({ server: { name: 'h', url: 'https://a.test/v2', auth: 'header' }, by: 'ana' });
  assert.equal(await servers.headerValue(servers.get('h')), 'k-1', 'same origin: kept');
  await servers.save({ server: { name: 'h', url: 'https://b.test/mcp', auth: 'header' }, by: 'ana' });
  assert.equal(servers.get('h').headerSavedAt, null);
  assert.equal(await servers.headerValue(servers.get('h')), null);
  assert.equal(secrets.values.size, 0, 'the old value is deleted');
});

test('an edited server keeps its place in the list', async (t) => {
  quietly(t);
  const servers = createMcpServers({ store: { state: {}, save() {} }, settings: NONE, lockdown: () => ({ available: true }) });
  for (const name of ['a', 'b', 'c']) await servers.save({ server: { name, url: `https://${name}.test` }, by: 'ana' });
  await servers.save({ server: { name: 'a', url: 'https://a2.test' }, by: 'ana' });
  assert.deepEqual(servers.list().map((s) => s.name), ['a', 'b', 'c']);
});
