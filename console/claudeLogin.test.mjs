// The console's keeping of a person's full Claude login and its lease (claudeLogin.mjs), through userSettings.mjs over
// an in-memory secret store. Every value here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkClaudeLogin } from './claudeLogin.mjs';
import { createUserSettings } from './userSettings.mjs';

const ACCESS = 'fake-access-zq81';
const REFRESH = 'fake-refresh-zq82';

function fakeLogin({ access = ACCESS, refresh = REFRESH, expiresAt = Date.parse('2026-11-17T18:00:00Z') } = {}) {
  return { accessToken: access, refreshToken: refresh, expiresAt, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], rateLimitTier: 'default' };
}

function memorySecrets() {
  const values = new Map();
  return {
    values,
    async read(name) { return values.get(name) ?? null; },
    async save(name, value) { values.set(name, value); },
    async remove(name) { values.delete(name); },
  };
}

// Everything the console logs while `fn` runs, as one string.
async function logsOf(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

function setUp({ live = ['aaaa1111', 'bbbb2222'] } = {}) {
  const store = { state: { people: { octocat: { claudeTokenAt: '2026-11-01T00:00:00.000Z' } } }, save() {} };
  const secrets = memorySecrets();
  let clock = Date.parse('2026-11-17T10:00:00Z');
  const userSettings = createUserSettings({ store, secrets, now: () => clock });
  const running = new Set(live);
  const isLive = (id) => running.has(id);
  return { store, secrets, logins: userSettings.claudeLogin, userSettings, isLive, running, tick: (ms) => { clock += ms; } };
}

test('checkClaudeLogin keeps the login alone and refuses anything that is not one, without the value in the error', () => {
  const file = { claudeAiOauth: fakeLogin(), mcpOAuth: { slack: { accessToken: 'fake-mcp-zq83' } } };
  assert.deepEqual(checkClaudeLogin(JSON.stringify(file)), { claudeAiOauth: fakeLogin() }, 'MCP logins stay in the home');
  for (const bad of ['{', '{}', { claudeAiOauth: { ...fakeLogin(), refreshToken: '' } }, { claudeAiOauth: { ...fakeLogin(), expiresAt: 'soon' } }, { claudeAiOauth: { ...fakeLogin(), scopes: 'all' } }]) {
    assert.throws(() => checkClaudeLogin(bad), (err) => err.shown && !err.message.includes('zq8'));
  }
});

test('take: none saved, then given with a new generation, then held while that session runs, and free once it ended', async () => {
  const { logins, isLive, running, secrets } = setUp();
  assert.deepEqual(await logins.take('octocat', { sessionId: 'aaaa1111', isLive }), { status: 'none' });

  const fresh = await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: fakeLogin() } });
  assert.deepEqual(fresh, { kept: true, generation: 1 });
  assert.deepEqual(JSON.parse(secrets.values.get('users/octocat/claude-login')), { claudeAiOauth: fakeLogin() });

  assert.deepEqual(await logins.take('octocat', { sessionId: 'bbbb2222', isLive }), { status: 'held', heldBy: 'aaaa1111' });
  running.delete('aaaa1111');
  const taken = await logins.take('octocat', { sessionId: 'bbbb2222', isLive });
  assert.deepEqual(taken, { status: 'given', generation: 2, claudeAiOauth: fakeLogin() }, 'a crashed holder holds nothing');
  assert.equal(logins.view('octocat', { isLive }).heldBy, 'bbbb2222');
});

test('write-back: kept from the holder with its generation and a later expiry; refused when stale', async () => {
  const { logins, isLive, secrets, running } = setUp();
  await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: fakeLogin() } });
  const later = fakeLogin({ refresh: 'fake-refresh-2', expiresAt: Date.parse('2026-11-18T02:00:00Z') });

  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 7, value: { claudeAiOauth: later } }), { kept: false, why: 'not the holder' }, 'wrong generation');
  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'bbbb2222', generation: 1, value: { claudeAiOauth: later } }), { kept: false, why: 'not the holder' }, 'another session');
  const older = fakeLogin({ refresh: 'fake-refresh-0', expiresAt: Date.parse('2026-11-17T12:00:00Z') });
  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 1, value: { claudeAiOauth: older } }), { kept: false, why: 'not newer' });
  assert.deepEqual(JSON.parse(secrets.values.get('users/octocat/claude-login')).claudeAiOauth, fakeLogin(), 'nothing stale written');

  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 1, value: { claudeAiOauth: later } }), { kept: true, generation: 1 });
  assert.equal(JSON.parse(secrets.values.get('users/octocat/claude-login')).claudeAiOauth.refreshToken, 'fake-refresh-2');

  // Session B takes it once A ended; A's copy, refreshed later still, can no longer replace B's.
  running.delete('aaaa1111');
  const taken = await logins.take('octocat', { sessionId: 'bbbb2222', isLive });
  const fromA = fakeLogin({ refresh: 'fake-refresh-a', expiresAt: Date.parse('2026-11-18T09:00:00Z') });
  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 1, value: { claudeAiOauth: fromA } }), { kept: false, why: 'not the holder' });
  const fromB = fakeLogin({ refresh: 'fake-refresh-b', expiresAt: Date.parse('2026-11-18T10:00:00Z') });
  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'bbbb2222', generation: taken.generation, value: { claudeAiOauth: fromB } }), { kept: true, generation: 2 });
});

test('release frees the lease for its holder alone, and the fleet frees it when the session ends', async () => {
  const { logins, isLive } = setUp();
  await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: fakeLogin() } });
  assert.equal(await logins.release('octocat', { sessionId: 'bbbb2222', generation: 1 }), false);
  assert.equal(await logins.release('octocat', { sessionId: 'aaaa1111', generation: 0 }), false);
  assert.equal(await logins.release('octocat', { sessionId: 'aaaa1111', generation: 1 }), true);
  assert.equal(logins.view('octocat', { isLive }).heldBy, null);
  assert.equal((await logins.take('octocat', { sessionId: 'bbbb2222', isLive })).status, 'given', 'while A still runs');

  assert.equal(await logins.sessionEnded('octocat', 'aaaa1111'), false, 'not the holder any more');
  assert.equal(await logins.sessionEnded('octocat', 'bbbb2222'), true);
  assert.equal(logins.view('octocat', { isLive }).heldBy, null);
});

test('Forget and Remove My Woodshed take the login and its lease, and a holder cannot write it back', async () => {
  const { logins, isLive, secrets, userSettings, store } = setUp();
  await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: fakeLogin() } });
  await logins.forget('octocat');
  assert.equal(secrets.values.has('users/octocat/claude-login'), false);
  assert.deepEqual(logins.view('octocat', { isLive }), { saved: false, savedAt: null, refreshedAt: null, heldBy: null });
  const later = fakeLogin({ expiresAt: Date.parse('2026-11-18T02:00:00Z') });
  assert.deepEqual(await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 1, value: { claudeAiOauth: later } }), { kept: false, why: 'not the holder' });
  assert.equal(secrets.values.has('users/octocat/claude-login'), false);

  await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: later } });
  await userSettings.removeAll('octocat');
  assert.equal(secrets.values.has('users/octocat/claude-login'), false);
  assert.equal(store.state.people.octocat, undefined);
});

test('the state and the logs carry ids, dates and the generation, never a token', async () => {
  const { logins, isLive, store, running } = setUp();
  const logs = await logsOf(async () => {
    await logins.take('octocat', { sessionId: 'aaaa1111', isLive });
    await logins.writeBack('octocat', { sessionId: 'aaaa1111', fresh: true, value: { claudeAiOauth: fakeLogin() } });
    await logins.take('octocat', { sessionId: 'bbbb2222', isLive });
    await logins.writeBack('octocat', { sessionId: 'aaaa1111', generation: 1, value: { claudeAiOauth: fakeLogin({ expiresAt: 1 }) } });
    running.delete('aaaa1111');
    await logins.take('octocat', { sessionId: 'bbbb2222', isLive });
    await logins.release('octocat', { sessionId: 'bbbb2222', generation: 2 });
    await logins.forget('octocat');
    assert.throws(() => checkClaudeLogin({ claudeAiOauth: { accessToken: ACCESS } }));
  });
  assert.match(logs, /claudeLogin: taken/);
  for (const value of [ACCESS, REFRESH]) {
    assert.ok(!logs.includes(value), 'no token in the logs');
    assert.ok(!JSON.stringify(store.state).includes(value), 'no token in the state');
  }
});
