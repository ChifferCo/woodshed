import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { RESTART_EXIT_CODE, appManifest, applyStored, createGitHubAppSetup, manifestPostUrl, supervisorOf } from './githubAppSetup.mjs';
import { defaultProject } from './projects.mjs';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { githubApp: null, publicUrl: 'https://woodshed.example.com', repo: 'Acme/widgets' };

function memorySecrets() {
  const values = new Map();
  return {
    values,
    async list() { return [...values.keys()].map((name) => ({ name, set: true })); },
    async read(name) { return values.get(name) ?? null; },
    async save(name, value) { values.set(name, value); },
  };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
function setup(fetchImpl, { secrets = memorySecrets(), cfg = config, state = {}, supervisor = null, exit = () => assert.fail('exited') } = {}) {
  const store = { state, save() {} };
  return { store, secrets, api: createGitHubAppSetup({ store, secrets, config: cfg, fetchImpl, now: () => 1_000_000, supervisor, exit }) };
}

test('the manifest asks for the sign-in callback and no webhook, and goes to the owner\'s organization', () => {
  const m = appManifest({ publicUrl: config.publicUrl, repo: defaultProject(config).repo });
  assert.deepEqual(m.callback_urls, ['https://woodshed.example.com/auth/callback']);
  assert.equal(m.redirect_url, 'https://woodshed.example.com/setup/github/created');
  assert.equal(m.hook_attributes, undefined);
  assert.equal(m.default_permissions.contents, 'write');
  assert.match(manifestPostUrl({ repo: 'Acme/widgets', state: 's', ownerType: 'Organization' }), /^https:\/\/github\.com\/organizations\/Acme\/settings\/apps\/new\?state=s$/);
  assert.match(manifestPostUrl({ repo: 'Acme/widgets', state: 's', ownerType: 'User' }), /^https:\/\/github\.com\/settings\/apps\/new/);
});

test('the manifest asks for no account permission, which GitHub refuses in a manifest', () => {
  const m = appManifest({ publicUrl: config.publicUrl, repo: defaultProject(config).repo });
  for (const name of ['email_addresses', 'followers', 'git_ssh_keys', 'gpg_keys', 'profile', 'starring']) {
    assert.equal(m.default_permissions[name], undefined, name);
  }
});

test('a manifest code is only taken for a state this console started, and keeps the key and client secret in the store', async () => {
  const calls = [];
  const { api, store, secrets } = setup(async (url) => {
    calls.push(url);
    return json(201, { id: 77, slug: 'woodshed-acme', pem: privateKey, client_id: 'Iv1.x', client_secret: 'shh' });
  });
  await assert.rejects(api.completeManifest({ code: 'abcdef0123456789', state: 'forged' }), /not opened from the console/);
  assert.equal(calls.length, 0, 'nothing is sent to GitHub for a state we never issued');
  const state = new URL(api.startManifest({}).url).searchParams.get('state');
  await api.completeManifest({ code: 'abcdef0123456789', state });
  assert.equal(secrets.values.get('github-app-key'), privateKey.trim());
  assert.equal(secrets.values.get('github-app-client-secret'), 'shh');
  assert.equal(store.state.githubAppSetup.appId, '77');
  assert.equal(JSON.stringify(store.state).includes('shh'), false, 'no secret in state.json');
  await assert.rejects(api.completeManifest({ code: 'abcdef0123456789', state }), /not opened from the console/, 'a state works once');
});

test('pasting an App checks the ID and key with GitHub before keeping anything', async () => {
  const bad = setup(async () => json(401, { message: 'A JSON web token could not be decoded' }));
  await assert.rejects(bad.api.saveManual({ appId: '77', privateKey }), /did not accept/);
  assert.equal(bad.secrets.values.size, 0);
  await assert.rejects(bad.api.saveManual({ appId: 'abc', privateKey }), /App ID/);
  await assert.rejects(bad.api.saveManual({ appId: '77', privateKey: 'not a key' }), /PEM/);
  const good = setup(async () => json(200, { slug: 'mine', events: [], client_id: 'Iv1.y' }));
  await good.api.saveManual({ appId: '77', privateKey, installationId: '5' });
  assert.equal(good.store.state.githubAppSetup.installationId, '5');
  assert.ok(good.secrets.values.has('github-app-key'));
});

test('the installation is looked up on the repo, and "not installed yet" is an answer, not an error', async () => {
  const { api: api2, store: store2, secrets } = setup(async (url) => {
    if (url.endsWith('/repos/Acme/widgets/installation')) return json(404, { message: 'Not Found' });
    return json(200, { slug: 'mine' });
  });
  await api2.saveManual({ appId: '77', privateKey });
  assert.deepEqual(await api2.findInstallation(), { installed: false });
  assert.equal(store2.state.githubAppSetup.installationId, undefined);
  assert.ok(secrets.values.size);
});

test('an installation found is checked by minting a token, then saved', async () => {
  const { api, store } = setup(async (url) => {
    if (url.endsWith('/installation')) return json(200, { id: 4242 });
    if (url.endsWith('/access_tokens')) return json(201, { token: 't', expires_at: '2030-01-01T00:00:00Z' });
    return json(200, { slug: 'mine' });
  });
  await api.saveManual({ appId: '77', privateKey });
  assert.deepEqual(await api.findInstallation(), { installed: true, installationId: '4242' });
  assert.equal(store.state.githubAppSetup.installationId, '4242');
  assert.equal((await api.view()).needsRestart, true);
});

test('replacing the App drops the old App\'s installation, keeping the same App\'s', async () => {
  const { api, store } = setup(async () => json(200, { slug: 'mine' }));
  await api.saveManual({ appId: '77', privateKey, installationId: '5' });
  await api.saveManual({ appId: '77', privateKey });
  assert.equal(store.state.githubAppSetup.installationId, '5');
  await api.saveManual({ appId: '88', privateKey });
  assert.equal(store.state.githubAppSetup.installationId, undefined);
});

test('a console with an App in force, or no secret store, cannot be set up here', async () => {
  const withApp = setup(async () => json(200, {}), { cfg: { ...config, githubApp: { appId: '1' } } });
  assert.throws(() => withApp.api.startManifest({}), /already runs/);
  const none = createGitHubAppSetup({ store: { state: {}, save() {} }, secrets: null, config });
  assert.equal(none.available(), false);
});

test('a secrets manager not chosen yet is refused before GitHub is asked for anything', async () => {
  const secrets = { ...memorySecrets(), configured: () => false };
  const asked = [];
  const { api } = setup(async (url) => { asked.push(url); return json(200, {}); }, { secrets });
  assert.throws(() => api.startManifest({}), /choose one on the Secrets page/);
  await assert.rejects(api.completeManifest({ code: 'abc123abc123', state: 'x' }), /choose one on the Secrets page/);
  assert.deepEqual(asked, []);
});

test('on the next start a saved App is the console\'s own, unless the environment names one', () => {
  const store = { state: { githubAppSetup: { appId: '77', installationId: '4242' } } };
  const applied = applyStored({ config: { ...config, ghToken: 'x' }, store, secrets: {} });
  assert.deepEqual(applied.githubApp, { appId: '77', installationId: '4242', keyFile: null, keyFromSecret: true });
  assert.equal(applied.ghToken, null);
  const env = { ...config, githubApp: { appId: '9' } };
  assert.equal(applyStored({ config: env, store, secrets: {} }), env);
  assert.equal(applyStored({ config, store: { state: { githubAppSetup: { appId: '77' } } }, secrets: {} }).githubApp, null, 'no installation yet');
});

test('a supervisor is systemd\'s INVOCATION_ID or the setting, and the setting at 0 wins', () => {
  assert.equal(supervisorOf({}), null, 'a plain node in a shell');
  assert.equal(supervisorOf({ INVOCATION_ID: 'abc' }), 'systemd');
  assert.equal(supervisorOf({ WOODSHED_SUPERVISED: '1' }), 'setting');
  assert.equal(supervisorOf({ WOODSHED_SUPERVISED: '0', INVOCATION_ID: 'abc' }), null);
});

const installed = () => ({ githubAppSetup: { appId: '77', installationId: '4242' } });

test('Restart is offered only when supervised and an App is stored but not in force', async () => {
  const view = (opts) => setup(async () => json(200, {}), opts).api.view();
  assert.equal((await view({ state: installed(), supervisor: 'systemd' })).canRestart, true);
  assert.equal((await view({ state: installed(), supervisor: null })).canRestart, false, 'nothing would start it again');
  assert.equal((await view({ state: { githubAppSetup: { appId: '77' } }, supervisor: 'systemd' })).canRestart, false, 'not installed yet');
  assert.equal((await view({ state: installed(), supervisor: 'systemd', cfg: { ...config, githubApp: { appId: '77' } } })).canRestart, false, 'already in force');
});

test('Restart answers first, then exits non-zero once, however many clicks', async () => {
  const codes = [];
  let exited;
  const done = new Promise((resolve) => { exited = resolve; });
  const { api } = setup(async () => json(200, {}), { state: installed(), supervisor: 'systemd', exit: (code) => { codes.push(code); exited(); } });
  assert.deepEqual(api.restart({ by: 'mia-dev' }), { restarting: true });
  assert.deepEqual(codes, [], 'the answer goes out before the process does');
  assert.equal((await api.view()).restarting, true);
  api.restart({ by: 'mia-dev' });
  await done;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(codes, [RESTART_EXIT_CODE]);
  assert.notEqual(RESTART_EXIT_CODE, 0, 'Restart=on-failure restarts only a non-zero exit');
});

test('Restart is refused unsupervised, before the App is installed, or with an App in force', () => {
  const restart = (opts) => setup(async () => json(200, {}), opts).api.restart({ by: 'mia-dev' });
  assert.throws(() => restart({ state: installed() }), /nothing would start this console again/);
  assert.throws(() => restart({ state: { githubAppSetup: { appId: '77' } }, supervisor: 'setting' }), /install it first/);
  assert.throws(() => restart({ state: installed(), supervisor: 'setting', cfg: { ...config, githubApp: { appId: '77' } } }), /already runs/);
});
