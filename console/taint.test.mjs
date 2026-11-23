import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet } from './fleet.mjs';
import { createMcpServers, mcpSettings } from './mcpServers.mjs';
import { createUsage } from './usage.mjs';
import { keptIds } from './sessions.mjs';
import { TAINT_MESSAGE } from './taint.mjs';

const PROD = mcpSettings({ WOODSHED_PROD_MCP_URL: 'https://prod-mcp.test/mcp', WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://console.test');

function setup({ lockDown = async () => ({ host: '127.0.0.1', termPort: 11, statusPort: 12, shellPort: 13, locked: true }), docker = null, homes = null, settings = PROD, servers = [], databases = null, usage = null, status = { state: 'done' }, checkpoint = { tainted: true } } = {}) {
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
  if (servers.length) store.state.mcpServers = servers;
  const mcpServers = createMcpServers({ store, settings, lockdown: () => ({ available: true }) });
  const fleet = createFleet({
    config, store, launcher, github: {}, now: () => clock, homes, mcpServers, appShares, egress, databases, usage,
    statusd: async (session, method, path, opts) => {
      calls.statusd.push({ id: session.id, method, path, body: opts?.body ?? null });
      return path === '/status' ? status : path === '/checkpoint' ? checkpoint : { tainted: true };
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
  assert.deepEqual(JSON.parse(joel.WOODSHED_MCP_SERVERS), [{ name: 'woodshed-prod', production: true }]);
  for (const env of [ana, shared, codex]) assert.equal(env.WOODSHED_MCP_SERVERS, undefined);
});

test('ordinary servers go to the sessions they name, a shared session only when they say so, and never to a tainted one', async (t) => {
  quietly(t);
  const servers = [
    { name: 'docs', url: 'https://docs.test/mcp', production: false, shared: true, people: '*', repos: '*', auth: 'none' },
    { name: 'tracker', url: 'https://tracker.test/mcp', production: false, shared: false, people: ['ana'], repos: ['o/r'], auth: 'oidc', audience: 'tracker' },
  ];
  const { fleet, calls } = setup({ servers });
  await runningPrivate(fleet);
  await runningPrivate(fleet, { startedBy: 'ana', owner: 'ana' });
  await fleet.createSession({ kind: 'issue', number: 7, title: 'i', startedBy: 'joel', trigger: 'label', prompt: 'p' });
  await fleet.createSession({ kind: 'pr', number: 9, title: 'QA', startedBy: 'joel', trigger: 'qa', branch: 'a/c', qa: { base: 'main', sha: 'a'.repeat(40), heading: '## QA', commentId: null } });
  const [joel, ana, shared, qa] = calls.started.map((c) => JSON.parse(c.env.WOODSHED_MCP_SERVERS ?? '[]').map((s) => s.name));
  assert.deepEqual(joel, ['woodshed-prod', 'docs']);
  assert.deepEqual(ana, ['docs', 'tracker'], 'ana is not allowed production, and is the tracker\'s');
  assert.deepEqual(shared, ['docs']);
  assert.deepEqual(qa, [], 'a QA run executes the pull request\'s code: it gets none');
  const session = fleet.sessions().find((s) => s.owner === 'joel');
  await fleet.taint(session);
  Object.assign(session, { status: 'stopped', stoppedAt: '2026-11-19T11:00:00.000Z' });
  await fleet.resumePrivate({ owner: 'joel', id: session.id });
  assert.deepEqual(JSON.parse(calls.started.at(-1).env.WOODSHED_MCP_SERVERS), [{ name: 'woodshed-prod', production: true }]);
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

test('a tainted session\'s usage is gone from the Usage page at its taint, and none is kept after, by status read or stop', async (t) => {
  quietly(t);
  const ledger = { state: {}, save() {} };
  const usage = createUsage(ledger, { now: () => Date.parse('2026-11-19T10:00:00.000Z') });
  const report = [{ agent: 'claude', billing: 'plan', since: '2026-11-19T09:00:00Z', days: { '2026-11-19': { 'claude-opus-5-5': { input: 7, output: 7 } } } }];
  const { fleet } = setup({ usage, status: { state: 'done', tokenUsage: report }, checkpoint: { committed: false, head: 'abc', tokenUsage: report } });
  const session = await runningPrivate(fleet);
  session.title = 'MARKER title';
  await fleet.tick();
  assert.ok(ledger.state.tokenUsage[session.id], 'an untainted session\'s is kept');
  await fleet.taint(session, { why: 'production MCP call' });
  assert.deepEqual(ledger.state.tokenUsage, {}, 'what it reported before the lockdown goes with it');
  await fleet.tick();
  await fleet.stop(session, 'stopped from the console', { by: 'joel' });
  assert.deepEqual(ledger.state.tokenUsage, {});
  assert.ok(!JSON.stringify(usage.summary({ login: 'joel', admin: true, everyone: true })).includes('MARKER'));
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

test('what a session has open that its lockdown would not close is cut before the lockdown runs', async (t) => {
  quietly(t);
  const order = [];
  const { fleet } = setup({ lockDown: async () => { order.push('lockDown'); return null; } });
  fleet.onLocking((id) => order.push(`cut ${id}`));
  fleet.onLocking(() => { throw new Error('one cut failing stops nothing'); });
  const session = await runningPrivate(fleet);
  await fleet.taint(session);
  assert.deepEqual(order, [`cut ${session.id}`, 'lockDown']);
});

test('a home queued for deletion while the retry sweep awaits storage stays queued', async (t) => {
  quietly(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const homes = { async remove(name) { if (name === 'joel/sessions/first') await gate; else throw new Error('S3 is down'); }, async get() { return null; } };
  const { fleet, store } = setup({ homes });
  store.state.taintedHomesPending = [{ id: 'first', name: 'joel/sessions/first' }];
  const sweep = fleet.tick();
  await new Promise((r) => setTimeout(r, 20));
  store.state.taintedHomesPending = [...store.state.taintedHomesPending, { id: 'second', name: 'joel/sessions/second' }];
  release();
  await sweep;
  assert.deepEqual(store.state.taintedHomesPending.map((h) => h.id), ['second']);
});

test('a My Woodshed session that may use production works on databases of its own, kept while it is listed, never its owner\'s', async (t) => {
  quietly(t);
  const copied = [];
  const databases = { available: true, async createForSession(id) { copied.push(id); }, async sweep() {} };
  const { fleet, store } = setup({ databases });
  const joel = await runningPrivate(fleet);
  const ana = await runningPrivate(fleet, { startedBy: 'ana', owner: 'ana' });
  assert.equal(joel.ownDatabases, true);
  assert.equal(ana.ownDatabases, undefined, 'one who may not use production keeps working on their own databases');
  assert.deepEqual(copied, [joel.id]);
  Object.assign(joel, { status: 'stopped' });
  Object.assign(ana, { status: 'stopped' });
  const kept = keptIds(store.state.sessions);
  assert.ok(kept.has(joel.id), 'kept for its Resume until it is removed');
  assert.ok(!kept.has(ana.id));
});

test('a session started before it could use production is never tainted, whatever the servers say now', async (t) => {
  quietly(t);
  const { fleet, store, calls } = setup({ settings: mcpSettings({}, 'https://console.test') });
  const session = await runningPrivate(fleet);
  assert.equal(session.mayUseProduction, undefined);
  // An admin adds a production server listing its owner while it runs.
  store.state.mcpServers = [{ name: 'orders', url: 'https://orders.test', production: true, shared: false, people: ['joel'], repos: '*', auth: 'oidc', audience: 'woodshed-prod-mcp' }];
  await assert.rejects(fleet.taint(session), (err) => err.shown && /started before it could use production/.test(err.message));
  assert.equal(calls.lockDowns.length, 0);
  assert.equal(session.taintedAt, undefined);
});
