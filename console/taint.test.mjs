import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet } from './fleet.mjs';
import { TAINT_MESSAGE } from './taint.mjs';

const PROD = { url: 'https://prod-mcp.test/mcp', people: new Set(['joel']), repos: new Set(['o/r']), issuer: 'https://console.test', removeAfterMs: 24 * 3_600_000 };

function setup({ lockDown = async () => ({ host: '127.0.0.1', termPort: 11, statusPort: 12, shellPort: 13, locked: true }), docker = null, homes = null, prodMcp = PROD } = {}) {
  let clock = Date.parse('2026-11-19T10:00:00.000Z');
  const calls = { lockDowns: [], statusd: [], started: [], cleared: [], homesRemoved: [] };
  const launcher = {
    kind: 'fake',
    refFor: (id) => `c-${id}`,
    async start(id, env) { calls.started.push({ id, env }); return { ref: `c-${id}`, host: '127.0.0.1', termPort: 1, statusPort: 2, shellPort: 3, docker }; },
    async taskState() { return { alive: true }; },
    async logTail() { return 'SECRET ROW FROM PROD'; },
    async stop() {},
    lockDown: async (ref, opts) => {
      calls.lockDowns.push({ ref, ...opts });
      return lockDown(ref, opts);
    },
  };
  const config = {
    projects: [{ name: 'r', repo: 'o/r', default: true }], label: 'woodshed', publicUrl: 'https://console.test', maxRunning: 5,
    limits: { idleMs: 100 * 3_600_000, lifetimeMs: 100 * 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: { WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691' }, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const store = { state: { sessions: [], github: null }, saves: 0, save() { this.saves += 1; } };
  const appShares = { clearSession: (id) => calls.cleared.push(id) };
  const egress = { sessionUrl: 'http://host.docker.internal:7693', caPem: async () => '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----' };
  const fleet = createFleet({
    config, store, launcher, github: {}, now: () => clock, homes, prodMcp, appShares, egress,
    statusd: async (session, method, path, opts) => {
      calls.statusd.push({ id: session.id, method, path, body: opts?.body ?? null });
      return path === '/status' ? { state: 'done' } : { tainted: true };
    },
  });
  return { fleet, store, calls, advance: (ms) => { clock += ms; } };
}

async function runningPrivate(fleet, opts = {}) {
  const session = await fleet.createSession({ kind: 'task', number: null, title: 't', startedBy: 'joel', trigger: 'my-woodshed', prompt: 'p', owner: 'joel', ...opts });
  Object.assign(session, { status: 'running' });
  return session;
}

const quietly = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

test('an eligible private session is handed the MCP server and nothing else of production; others get neither', async (t) => {
  quietly(t);
  const { fleet, calls } = setup();
  await runningPrivate(fleet);
  await runningPrivate(fleet, { startedBy: 'ana', owner: 'ana' });
  await fleet.createSession({ kind: 'issue', number: 7, title: 'i', startedBy: 'joel', trigger: 'label', prompt: 'p' });
  await runningPrivate(fleet, { options: { agent: 'codex' } });
  const [joel, ana, shared, codex] = calls.started.map((c) => c.env);
  assert.equal(joel.WOODSHED_PROD_MCP, '1');
  assert.equal(joel.WOODSHED_TAINTED, undefined);
  assert.equal(joel.WOODSHED_EGRESS_PROXY, undefined, 'a launcher that can lock a running session down needs no proxy before the taint');
  for (const env of [ana, shared, codex]) assert.equal(env.WOODSHED_PROD_MCP, undefined);
});

test('taint locks the session down before it marks it, ends its shares, tells its statusd, and is one-way', async (t) => {
  quietly(t);
  const { fleet, calls } = setup();
  const session = await runningPrivate(fleet);
  let lockedWhileLocking = null;
  const locking = fleet.taint(session, { why: 'production MCP call' });
  lockedWhileLocking = fleet.isLocked(session);
  await locking;
  assert.equal(lockedWhileLocking, true, 'the egress proxy holds it to the lockdown from the moment it starts');
  assert.equal(calls.lockDowns.length, 1);
  assert.equal(calls.lockDowns[0].ref, session.ref);
  assert.equal(calls.lockDowns[0].egressUrl, 'http://host.docker.internal:7693');
  assert.match(session.taintedAt, /^2026-11-19T10:00:00/);
  assert.deepEqual(session.endpoint, { host: '127.0.0.1', termPort: 11, statusPort: 12, shellPort: 13, docker: null, locked: true }, 'the gateway is the way in now');
  assert.deepEqual(calls.cleared, [session.id]);
  await new Promise((r) => setImmediate(r));
  const told = calls.statusd.find((c) => c.path === '/taint');
  assert.deepEqual(told.body, { proxy: 'http://host.docker.internal:7693', ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----', message: TAINT_MESSAGE });
  assert.ok(session.taintNoticedAt);
  await fleet.taint(session);
  assert.equal(calls.lockDowns.length, 1, 'a tainted session is not locked down again');
});

test('a lockdown that fails refuses, and leaves the session untainted and unlocked', async (t) => {
  quietly(t);
  const { fleet, calls } = setup({ lockDown: async () => { throw new Error('docker said no'); } });
  const session = await runningPrivate(fleet);
  await assert.rejects(fleet.taint(session), (err) => err.shown && /could not be locked down: docker said no/.test(err.message));
  assert.equal(session.taintedAt, undefined);
  assert.equal(fleet.isLocked(session), false);
  assert.deepEqual(calls.cleared, []);
});

test('calls at once share one lockdown', async (t) => {
  quietly(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const { fleet, calls } = setup({ lockDown: async () => { await gate; return null; } });
  const session = await runningPrivate(fleet);
  const all = Promise.all([fleet.taint(session), fleet.taint(session), fleet.taint(session)]);
  release();
  await all;
  assert.equal(calls.lockDowns.length, 1);
});

test('a session holding the machine\'s Docker is never locked down: its root could undo it', async (t) => {
  quietly(t);
  const { fleet, calls } = setup({ docker: 'host' });
  const session = await runningPrivate(fleet);
  session.endpoint = { ...session.endpoint, docker: 'host' };
  await assert.rejects(fleet.taint(session), /machine's Docker socket/);
  assert.equal(calls.lockDowns.length, 0);
  assert.equal(session.taintedAt, undefined);
});

test('a resumed tainted session starts locked down, on its own home, and is not told again', async (t) => {
  quietly(t);
  const { fleet, store, calls } = setup();
  const session = await runningPrivate(fleet);
  await fleet.taint(session);
  Object.assign(session, { status: 'stopped', stoppedAt: '2026-11-19T11:00:00.000Z', taintNoticedAt: null });
  await fleet.resumePrivate({ owner: 'joel', id: session.id });
  const env = calls.started.at(-1).env;
  assert.equal(env.WOODSHED_TAINTED, '1');
  assert.equal(env.WOODSHED_PROD_MCP, '1');
  assert.equal(env.WOODSHED_EGRESS_PROXY, 'http://host.docker.internal:7693');
  assert.ok(session.taintedAt, 'Resume never untaints');
  assert.ok(session.taintNoticedAt, 'its entrypoint sets the lockdown up: statusd needs no notice');
  assert.ok(store.saves > 0);
});

test('a tainted session is removed with everything it kept once it has been stopped for the installation\'s time', async (t) => {
  quietly(t);
  const removed = [];
  const homes = { async remove(name) { removed.push(name); }, async get() { return null; } };
  const { fleet, store, advance } = setup({ homes });
  const session = await runningPrivate(fleet);
  await fleet.taint(session);
  Object.assign(session, { status: 'stopped', stoppedAt: '2026-11-19T10:00:00.000Z' });
  const untainted = await runningPrivate(fleet);
  Object.assign(untainted, { status: 'stopped', stoppedAt: '2026-11-19T10:00:00.000Z' });
  advance(23 * 3_600_000);
  await fleet.tick();
  assert.ok(store.state.sessions.includes(session), 'kept for its Resume until then');
  advance(2 * 3_600_000);
  await fleet.tick();
  assert.ok(!store.state.sessions.includes(session));
  assert.deepEqual(removed, [`joel/sessions/${session.id}`]);
  assert.ok(store.state.sessions.includes(untainted), 'an untainted one stays as before');
});

test('a tainted session\'s home that would not delete is tried again until it goes', async (t) => {
  quietly(t);
  let failing = true;
  const tried = [];
  const homes = { async remove(name) { tried.push(name); if (failing) throw new Error('S3 is down'); }, async get() { return null; } };
  const { fleet, store, advance } = setup({ homes });
  const session = await runningPrivate(fleet);
  await fleet.taint(session);
  Object.assign(session, { status: 'stopped' });
  await fleet.removePrivateSession({ owner: 'joel', id: session.id });
  assert.deepEqual(store.state.taintedHomesPending.map((h) => h.id), [session.id]);
  failing = false;
  advance(11 * 60_000);
  await fleet.tick();
  assert.deepEqual(store.state.taintedHomesPending, []);
  assert.equal(tried.length, 2);
});

test('a tainted session gets no Remote Control, and its container\'s log is never read into the console\'s', async (t) => {
  quietly(t);
  const { fleet } = setup();
  const session = await runningPrivate(fleet);
  session.endpoint = { host: '127.0.0.1', termPort: 1, statusPort: 2 };
  await fleet.taint(session);
  await assert.rejects(fleet.startClaudeLogin(session), /Remote Control is off/);
});
