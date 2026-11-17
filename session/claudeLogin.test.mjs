// The session's side of the kept Claude login (claudeLogin.mjs), against a stand-in for the console's routes, in a
// folder of the test's own: never the session's own ~/.claude. Every value is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fingerprint, readLease, release, sendBackIfChanged, storeFresh, take } from './claudeLogin.mjs';

function fakeLogin(refresh, expiresAt) {
  return { accessToken: `fake-access-${refresh}`, refreshToken: `fake-refresh-${refresh}`, expiresAt, scopes: ['user:inference'] };
}

async function setUp(t, answers = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-login-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'home/.claude/.credentials.json');
  const leaseFile = path.join(dir, 'lease.json');
  const calls = [];
  const call = async (route, body) => {
    calls.push({ route, body });
    return answers[route]?.(body) ?? { status: 404, body: null };
  };
  return { file, leaseFile, calls, opts: { file, leaseFile, call } };
}

test('take writes the saved login beside the MCP logins, mode 600, with the lease; held and none leave the file alone', async (t) => {
  let answer = { status: 'given', generation: 4, claudeAiOauth: fakeLogin('one', 1000) };
  const { file, leaseFile, opts } = await setUp(t, { '/claude-login/take': () => ({ status: 200, body: answer }) });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ mcpOAuth: { slack: { accessToken: 'fake-mcp' } } }));

  assert.deepEqual(await take(opts), { status: 'given' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { mcpOAuth: { slack: { accessToken: 'fake-mcp' } }, claudeAiOauth: fakeLogin('one', 1000) });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(leaseFile)).mode & 0o777, 0o600);
  const lease = await readLease(leaseFile);
  assert.deepEqual(lease, { generation: 4, ...fingerprint(fakeLogin('one', 1000)) });
  assert.ok(!JSON.stringify(lease).includes('fake-refresh'), 'the lease file holds a hash, not the token');

  await fs.rm(file);
  answer = { status: 'held', heldBy: 'bbbb2222' };
  assert.deepEqual(await take(opts), { status: 'held', heldBy: 'bbbb2222' });
  answer = { status: 'none' };
  assert.deepEqual(await take(opts), { status: 'none' });
  await assert.rejects(fs.stat(file), 'nothing written');
});

test('take is unavailable from a console without the routes, or that does not answer', async (t) => {
  const { opts } = await setUp(t, { '/claude-login/take': () => ({ status: 0, body: null }) });
  assert.deepEqual(await take(opts), { status: 'unavailable', code: 0 });
  const older = await setUp(t);
  assert.deepEqual(await take(older.opts), { status: 'unavailable', code: 404 });
});

test('a fresh sign-in is sent as one and takes the lease', async (t) => {
  const { file, leaseFile, calls, opts } = await setUp(t, { '/claude-login': () => ({ status: 200, body: { generation: 2 } }) });
  assert.deepEqual(await storeFresh(opts), { stored: false, code: null }, 'nothing signed in yet');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: fakeLogin('new', 5000), mcpOAuth: { x: {} } }));
  assert.deepEqual(await storeFresh(opts), { stored: true, generation: 2 });
  assert.deepEqual(calls.at(-1), { route: '/claude-login', body: { fresh: true, claudeAiOauth: fakeLogin('new', 5000) } }, 'the login alone, never the MCP logins');
  assert.equal((await readLease(leaseFile)).generation, 2);
});

test('statusd\'s check sends the login back only when its refresh token or expiry changed, and stops once refused', async (t) => {
  let code = 200;
  const { file, leaseFile, calls, opts } = await setUp(t, { '/claude-login': () => ({ status: code, body: { generation: 3 } }), '/claude-login/release': () => ({ status: 200, body: { released: true } }) });
  assert.equal(await sendBackIfChanged(opts), 'no-lease');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: fakeLogin('one', 1000) }));
  await fs.writeFile(leaseFile, JSON.stringify({ generation: 3, ...fingerprint(fakeLogin('one', 1000)) }));
  assert.equal(await sendBackIfChanged(opts), 'unchanged');
  assert.equal(calls.length, 0);

  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: fakeLogin('two', 1000) }));
  assert.equal(await sendBackIfChanged(opts), 'sent', 'a new refresh token, the same expiry');
  assert.deepEqual(calls.at(-1), { route: '/claude-login', body: { generation: 3, claudeAiOauth: fakeLogin('two', 1000) } });
  assert.equal(await sendBackIfChanged(opts), 'unchanged', 'the lease file follows what was sent');

  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: fakeLogin('two', 2000) }));
  assert.equal(await sendBackIfChanged(opts), 'sent', 'a new expiry');

  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: fakeLogin('three', 3000) }));
  code = 409;
  assert.equal(await sendBackIfChanged(opts), 'refused');
  assert.equal(await readLease(leaseFile), null);
  assert.equal(await sendBackIfChanged(opts), 'no-lease', 'another session holds it now: nothing more is sent');
  assert.equal(await release(opts), 'no-lease');
});

test('release gives the lease up with its generation and forgets it', async (t) => {
  const { leaseFile, calls, opts } = await setUp(t, { '/claude-login/release': () => ({ status: 200, body: { released: true } }) });
  await fs.writeFile(leaseFile, JSON.stringify({ generation: 5, refreshHash: 'x', expiresAt: 1 }));
  assert.equal(await release(opts), 'released');
  assert.deepEqual(calls, [{ route: '/claude-login/release', body: { generation: 5 } }]);
  assert.equal(await readLease(leaseFile), null);
});
