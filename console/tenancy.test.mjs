// The pieces a multi-tenant console (hosted.mjs) builds each tenant from: its store over the host's, its config from
// the host's settings, its GitHub tokens from the host's source, and the tenant on every line it logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tenantConfig } from './config.mjs';
import { createInProcessBroker } from './githubBroker.mjs';
import { openServiceStore } from './store.mjs';
import { installTenantLog, runAs, withTenantField } from './tenantLog.mjs';

const PROCESS = { host: '127.0.0.1', port: 7690, publicUrl: 'https://console.example/', appDomain: 'Apps.Example', sessionApi: { host: '10.8.0.1', port: 7691 } };
const config = (settings) => tenantConfig({ process: PROCESS, tenant: { id: 'acme', settings }, stateDir: '/var/tmp/acme', githubSource: { token: async () => ({}) } });

test('a tenant\'s config is the defaults, the process\'s settings and the host\'s for the tenant, checked', () => {
  const c = config({
    projects: [{ name: 'web', repo: 'acme/web' }, { name: 'api', repo: 'acme/api' }], sessionApiUrl: 'http://10.8.0.1:7691/',
    sessionEnv: { PGHOST: 'db' }, maxRunning: 2, limits: { idleMs: 60_000 }, label: 'agent',
  });
  assert.deepEqual(c.projects.map((p) => [p.name, p.default]), [['web', true], ['api', false]], 'the first is the default');
  assert.deepEqual(c.sessionEnv, { PGHOST: 'db', WOODSHED_CONSOLE_URL: 'http://10.8.0.1:7691' });
  assert.deepEqual([c.maxRunning, c.limits.idleMs, c.limits.lifetimeMs, c.label], [2, 60_000, 8 * 3_600_000, 'agent']);
  assert.deepEqual([c.publicUrl, c.appDomain, c.org, c.requireSignIn, c.githubApp, c.ghToken, c.localLogin], ['https://console.example', 'apps.example', 'acme', true, null, null, null]);
  assert.ok(c.githubBroker.source, 'the host\'s token source');
  for (const [settings, why] of [
    [{ projects: [{ name: 'Web', repo: 'acme/web' }] }, /settings\.projects\[0\]: name/],
    [{ sessionApiUrl: 'ftp://x' }, /http\(s\)/],
    [{ maxRunning: -1 }, /maxRunning must be a positive number/],
    [{ limits: { idleHours: 1 } }, /settings\.limits\.idleHours is not a setting/],
    [{ sessionEnv: { A: 1 } }, /settings\.sessionEnv\.A must be a string/],
    [{ homesBucket: 'x' }, /homesBucket is not a setting a tenant has/],
    [{ envFiles: [{ secret: 'api-env', path: 'a,b' }] }, /no comma/],
  ]) assert.throws(() => config(settings), why);
  assert.deepEqual(config({ envFiles: [{ secret: 'api-env', path: 'api/.env' }] }).envFiles, [{ secret: 'api-env', path: 'api/.env' }]);
});

test('the host\'s store is loaded once, and every save writes the whole state in order, the latest once', async () => {
  const written = [];
  let release;
  const store = await openServiceStore({
    load: async () => ({ sessions: [{ id: 'a' }], people: { x: 1 } }),
    save: async (state) => { written.push(state); if (written.length === 1) await new Promise((r) => { release = r; }); },
  });
  assert.deepEqual(store.state, { sessions: [{ id: 'a' }], github: null, people: { x: 1 } });
  store.state.sessions.push({ id: 'b' });
  store.save();
  store.state.sessions.push({ id: 'c' });
  store.save();
  store.state.sessions.push({ id: 'd' });
  store.save();
  release();
  await store.flush();
  assert.deepEqual(written.map((s) => s.sessions.map((x) => x.id).join('')), ['ab', 'abcd'], 'the two while one was writing went as one');
  written[1].sessions.push({ id: 'z' });
  assert.equal(store.state.sessions.length, 4, 'the host got a copy');
});

test('a save the host refused is tried again, and a closed store saves nothing more', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  let fail = true;
  const written = [];
  const store = await openServiceStore({ load: async () => null, save: async (state) => { if (fail) throw new Error('down'); written.push(state); } }, { retryMs: 10 });
  store.save();
  await store.flush();
  assert.equal(written.length, 0);
  fail = false;
  await new Promise((r) => setTimeout(r, 30));
  await store.flush();
  assert.equal(written.length, 1, 'the retry wrote it');
  await store.close();
  store.state.sessions.push({ id: 'late' });
  store.save();
  await store.flush();
  assert.equal(written.length, 1);
  await assert.rejects(openServiceStore({ load: async () => [], save: async () => {} }), /not a state object/);
});

test('every line names the tenant whose work it is, however far from where the work started', async () => {
  const lines = [];
  const uninstall = installTenantLog({ sink: { log: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a) } });
  try {
    console.log('outside');
    await runAs('acme', async () => {
      await new Promise((r) => setTimeout(r, 1));
      console.log('fleet: tick', { id: 'a' });
      setTimeout(() => console.warn('later'), 1);
    });
    runAs('globex', () => console.error('error', 'two', 'args'));
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    uninstall();
  }
  assert.deepEqual(lines, [
    ['outside', { tenant: null }],
    ['fleet: tick', { id: 'a', tenant: 'acme' }],
    ['error', 'two', 'args', { tenant: 'globex' }],
    ['later', { tenant: 'acme' }],
  ]);
  assert.deepEqual(withTenantField(['m', new Error('x')], 't').at(-1), { tenant: 't' }, 'an error is not taken for fields');
});

test('the host\'s token source is narrowed and cached as the HTTP broker is', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const asked = [];
  const broker = createInProcessBroker({
    source: {
      async token({ repo, permissions }) {
        asked.push({ repo, permissions });
        if (repo === 'acme/wide') return { token: 'ghs_wide', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: 'write', workflows: 'write' } };
        if (repo === 'acme/down') throw new Error('host down');
        return { token: `ghs_${repo}`, expiresAt: Date.now() + 3_600_000, permissions };
      },
    },
  });
  const source = broker.tokenSource({ repo: 'acme/app', permissions: { contents: 'write' }, label: 'sessions' });
  assert.equal((await source.token()).token, 'ghs_acme/app');
  await source.token();
  assert.equal(asked.length, 1, 'cached until near its expiry');
  await assert.rejects(broker.tokenSource({ repo: 'acme/wide', permissions: { contents: 'write' }, label: 'sessions' }).token(), /more than was asked: workflows/);
  await assert.rejects(broker.tokenSource({ repo: 'acme/down', label: 'console' }).token(), /the host gave no GitHub token \(console\): host down/);
});
