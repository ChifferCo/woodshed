import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspect } from 'node:util';

import { createMembers } from './members.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import {
  ENV_SOURCES_TIMEOUT_MS, createRepoSettings, installationEnvName, installationInstructionsName, personalEnvName, personalInstructionsName, repoSettingsRoute,
} from './repoSettings.mjs';
import { createUserSettings } from './userSettings.mjs';
import { createHandler } from './server.mjs';
import { createInstallation } from './installation.mjs';
import { group, note, pill, row } from './settingsMarkup.mjs';
import { parseProject } from '../shared/project.mjs';

// Every value a test saves carries one of these: none may ever reach a log line.
const SECRET_MARK = 'zq9-not-for-logs';
const INSTALLATION_ENV = `API_URL=http://api.test\nAPI_TOKEN=inst-${SECRET_MARK}\nLOG_LEVEL=warn\n`;
const OWN_ENV = `LOG_LEVEL=debug\nAPI_TOKEN=mine-${SECRET_MARK}\n`;
const INSTRUCTIONS = `Run the unit tests before pushing (${SECRET_MARK}).\n`;

const PROJECTS = [
  { name: 'app', repo: 'acme/app', default: true },
  { name: 'tools', repo: 'acme/tools', default: false },
];
const FILES = {
  app: parseProject({
    version: 1, env: { NODE_ENV: 'development' }, rules: '.woodshed/rules.md',
    envFiles: [
      { path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info', 'FEATURE_X=off'], overrides: ['PORT={{PORT}}', 'ANTHROPIC_API_KEY={{ANTHROPIC_API_KEY?}}'] },
      { path: 'web/.env.local' },
    ],
  }),
  tools: parseProject({ version: 1, envFiles: [{ path: 'web/.env.local' }] }),
};

function memorySecrets(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async read(name) { return values.has(name) ? values.get(name) : null; },
    async save(name, value) { values.set(name, value); },
    async remove(name) { values.delete(name); },
  };
}

function setup({ state = {}, secrets = memorySecrets(), files = FILES, envSources = null, envSourcesTimeoutMs = undefined } = {}) {
  const store = { state: { sessions: [], ...state }, save() {} };
  const config = { projects: PROJECTS, repo: 'acme/app' };
  const readerOf = (name) => ({
    async repoLayer() {
      if (files[name] instanceof Error) throw files[name];
      const project = files[name];
      return { envFiles: project?.envFiles ?? [], env: project?.env ?? {}, rules: project?.rules ?? null, setup: project?.setup ?? null };
    },
  });
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const repoSettings = createRepoSettings({ store, secrets, config, readerOf, now: () => (clock += 1000), envSources, envSourcesTimeoutMs });
  return { store, secrets, config, repoSettings };
}

// Every console line while `fn` runs, as the log would print it.
async function captureLog(fn) {
  const lines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

test('the four names: the installation\'s by repo, a person\'s under their own login', () => {
  assert.equal(installationEnvName('app', 'api-env'), 'repos/app/env/api-env');
  assert.equal(installationInstructionsName('app'), 'repos/app/instructions');
  assert.equal(personalEnvName('Mia-Dev', 'app', 'web-env-local'), 'users/mia-dev/repos/app/env/web-env-local');
  assert.equal(personalInstructionsName('mia-dev', 'app'), 'users/mia-dev/repos/app/instructions');
});

test('a save keeps the value in the store, and state.json its date, size and key names alone', async () => {
  const { store, secrets, repoSettings } = setup();
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV.replace(/\n/g, '\r\n'), by: 'mia-dev' });
  await repoSettings.saveInstallation({ project: 'app', text: INSTRUCTIONS, by: 'mia-dev' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: OWN_ENV });

  assert.equal(secrets.values.get('repos/app/env/api-env'), INSTALLATION_ENV, 'Windows line endings made Unix ones');
  assert.equal(secrets.values.get('repos/app/instructions'), INSTRUCTIONS);
  assert.equal(secrets.values.get('users/sam-ops/repos/app/env/api-env'), OWN_ENV);
  assert.ok(!JSON.stringify(store.state).includes(SECRET_MARK), 'no value in state.json');
  assert.deepEqual(store.state.repoSettings.app.env['api-env'], {
    savedAt: '2026-11-12T10:00:01.000Z', by: 'mia-dev', bytes: Buffer.byteLength(INSTALLATION_ENV), keys: ['API_URL', 'API_TOKEN', 'LOG_LEVEL'],
  });
  assert.deepEqual(store.state.people['sam-ops'].repos.app.env['api-env'].keys, ['LOG_LEVEL', 'API_TOKEN']);

  const view = await repoSettings.view('app', { login: 'sam-ops' });
  const api = view.envFiles.find((f) => f.key === 'api-env');
  assert.deepEqual(api.wiring, { overrides: ['PORT', 'ANTHROPIC_API_KEY'], optional: ['ANTHROPIC_API_KEY'], env: ['NODE_ENV'] });
  assert.deepEqual(api.table.map((row) => [row.key, row.wins]), [
    ['LOG_LEVEL', 'personal'], ['FEATURE_X', 'repo'], ['API_URL', 'installation'], ['API_TOKEN', 'personal'], ['PORT', 'session'], ['ANTHROPIC_API_KEY', 'session'],
  ]);
  assert.equal(view.instructions.installation.bytes, Buffer.byteLength(INSTRUCTIONS));
  assert.equal(view.instructions.personal, null);
  assert.equal(view.projectFile.rules, '.woodshed/rules.md');
  assert.ok(!JSON.stringify(view).includes(SECRET_MARK), 'a view never carries a value');
  const other = await repoSettings.view('app', { login: 'ana-k' });
  assert.equal(other.envFiles.find((f) => f.key === 'api-env').personal, null, 'nobody sees another person\'s records');

  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: '  \n' });
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false, 'saving nothing clears');
  assert.equal(store.state.people['sam-ops'].repos, undefined);
});

test('env files that name one secret are one key, with every path, one set of values and each file\'s own defaults and overrides', async () => {
  const shared = parseProject({
    version: 1, envFiles: [
      { path: 'api/.env', secret: 'app-env', defaults: ['LOG_LEVEL=info'], overrides: ['PORT=8080', 'SQL_URL={{PG_URL}}'] },
      { path: 'worker/.env', secret: 'app-env', overrides: ['ROLE=worker', 'SQL_URL={{PG_URL}}'] },
      { path: 'web/.env.local', overrides: ['PORT=5173'] },
    ],
  });
  const { secrets, repoSettings } = setup({ files: { ...FILES, app: shared } });
  await repoSettings.saveInstallation({ project: 'app', key: 'app-env', text: 'LOG_LEVEL=warn\nAPI_TOKEN=x\n', by: 'mia-dev' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'app-env', text: 'API_TOKEN=mine\n' });
  assert.deepEqual([...secrets.values.keys()], ['repos/app/env/app-env', 'users/sam-ops/repos/app/env/app-env'], 'one value a layer for both files');

  const view = await repoSettings.view('app', { login: 'sam-ops' });
  assert.deepEqual(view.envFiles.map((f) => [f.key, f.paths]), [['app-env', ['api/.env', 'worker/.env']], ['web-env-local', ['web/.env.local']]]);
  const app = view.envFiles[0];
  assert.deepEqual(app.files.map((f) => [f.path, f.defaults, f.wiring.overrides]), [['api/.env', ['LOG_LEVEL=info'], ['PORT', 'SQL_URL']], ['worker/.env', [], ['ROLE', 'SQL_URL']]]);
  assert.equal(app.installation.bytes, Buffer.byteLength('LOG_LEVEL=warn\nAPI_TOKEN=x\n'));
  assert.deepEqual(app.table.map((row) => [row.key, row.setBy.join(' '), row.wins, row.path ?? null]), [
    ['LOG_LEVEL', 'repo installation', 'installation', 'api/.env'], ['LOG_LEVEL', 'installation', 'installation', 'worker/.env'],
    ['API_TOKEN', 'installation personal', 'personal', null], ['PORT', 'session', 'session', 'api/.env'], ['SQL_URL', 'session', 'session', null],
    ['ROLE', 'session', 'session', 'worker/.env'],
  ], 'one row where the files agree, one a file naming its path where they differ');
  assert.deepEqual(view.envFiles[1].table.map((row) => row.path ?? null), [null], 'a key of one file names no path');
  assert.deepEqual((await repoSettings.forSession({ id: 'a1', project: 'app', owner: 'sam-ops' })).envFiles, {
    'app-env': { installation: 'LOG_LEVEL=warn\nAPI_TOKEN=x\n', personal: 'API_TOKEN=mine\n' },
  }, 'a session is handed the key once: it writes it to each path');
});

test('a value is kept only for an env file the project file names, and instructions holding a credential are refused', async () => {
  const { secrets, repoSettings } = setup({ files: { ...FILES, tools: new Error('GitHub did not answer') } });
  await assert.rejects(repoSettings.saveInstallation({ project: 'app', key: 'old-env', text: 'A=1', by: 'mia-dev' }), { status: 404, message: /has no env file with the key old-env/ });
  await assert.rejects(repoSettings.saveInstallation({ project: 'app', key: '../x', text: 'A=1', by: 'mia-dev' }), { status: 400 });
  await assert.rejects(repoSettings.saveInstallation({ project: 'nope', key: 'api-env', text: 'A=1', by: 'mia-dev' }), { status: 404 });
  await assert.rejects(repoSettings.saveOwn({ login: 'sam-ops', project: 'tools', key: 'web-env-local', text: 'A=1' }), { status: 409, message: /could not be read/ });
  await assert.rejects(repoSettings.saveInstallation({ project: 'app', text: 'Use sk-ant-api03-abcdefghijklmnop to call it.', by: 'mia-dev' }), { message: /put secrets in an env file's values instead/ });
  await assert.rejects(repoSettings.saveOwn({ login: 'sam-ops', project: 'app', text: 'x'.repeat(17 * 1024) }), { message: /at most 16 KB/ });
  assert.equal(secrets.values.size, 0);
  const unread = await repoSettings.view('tools');
  assert.deepEqual([unread.projectFile.read, unread.envFiles], [false, []], 'an unreadable file says so');
});

test('a record whose secret is gone reads as none and is dropped; one the file no longer names is listed and removed for everyone', async () => {
  const { store, secrets, repoSettings } = setup();
  await repoSettings.saveInstallation({ project: 'app', key: 'web-env-local', text: 'PUBLIC_X=1', by: 'mia-dev' });
  secrets.values.delete('repos/app/env/web-env-local');
  assert.equal(await repoSettings.installationText({ project: 'app', key: 'web-env-local', by: 'mia-dev' }), null);
  assert.equal(store.state.repoSettings.app, undefined, 'the record follows the store');

  store.state.repoSettings = { app: { env: { 'old-env': { savedAt: 'x', by: 'mia-dev', bytes: 4, keys: ['A'] } } } };
  store.state.people = { 'sam-ops': { repos: { app: { env: { 'old-env': { savedAt: 'x', bytes: 4, keys: ['A'] } } } } } };
  secrets.values.set('repos/app/env/old-env', 'A=1\n');
  secrets.values.set('users/sam-ops/repos/app/env/old-env', 'A=2\n');
  const view = await repoSettings.view('app');
  assert.deepEqual(view.unnamed.map((u) => u.key), ['old-env']);
  await assert.rejects(repoSettings.removeUnnamed({ project: 'app', key: 'api-env', by: 'mia-dev' }), { status: 409 });
  await repoSettings.removeUnnamed({ project: 'app', key: 'old-env', by: 'mia-dev' });
  assert.equal(secrets.values.size, 0);
  assert.deepEqual([store.state.repoSettings.app, store.state.people['sam-ops'].repos], [undefined, undefined]);
});

test('a session gets its own project\'s values; only a private one its owner\'s, and an ask session nothing', async () => {
  const { repoSettings } = setup();
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
  await repoSettings.saveInstallation({ project: 'app', text: INSTRUCTIONS, by: 'mia-dev' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: OWN_ENV });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'web-env-local', text: 'PUBLIC_DEBUG=1\n' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', text: 'Answer in French.\n' });
  await repoSettings.saveInstallation({ project: 'tools', key: 'web-env-local', text: 'TOOLS=1\n', by: 'mia-dev' });

  assert.deepEqual(await repoSettings.forSession({ id: 'a1', project: 'app', owner: 'sam-ops' }), {
    project: 'app',
    envFiles: { 'api-env': { installation: INSTALLATION_ENV, personal: OWN_ENV }, 'web-env-local': { installation: null, personal: 'PUBLIC_DEBUG=1\n' } },
    instructions: { installation: INSTRUCTIONS, personal: 'Answer in French.\n' },
    personalFor: 'sam-ops',
  });
  const shared = { project: 'app', envFiles: { 'api-env': { installation: INSTALLATION_ENV, personal: null } }, instructions: { installation: INSTRUCTIONS, personal: null }, personalFor: null };
  assert.deepEqual(await repoSettings.forSession({ id: 'b2', project: 'app', owner: null }), shared, 'a shared session: no one\'s own layer');
  assert.deepEqual(await repoSettings.forSession({ id: 'c3', project: 'app', owner: 'sam-ops', qa: { number: 4 } }), shared, 'nor a QA session');
  assert.equal(await repoSettings.forSession({ id: 'd4', project: 'app', kind: 'ask' }), null);
  assert.deepEqual((await repoSettings.forSession({ id: 'e5', project: 'tools', owner: 'sam-ops' })).envFiles, { 'web-env-local': { installation: 'TOOLS=1\n', personal: null } });
  assert.equal((await repoSettings.forSession({ id: 'f6', repo: 'acme/app' })).project, 'app', 'a record from before projects is on its repo\'s');
});

test('forget deletes a removed repo\'s values, the installation\'s and everyone\'s, and leaves the other repos\'', async () => {
  const { store, secrets, repoSettings } = setup();
  await repoSettings.saveInstallation({ project: 'tools', key: 'web-env-local', text: 'A=1', by: 'mia-dev' });
  await repoSettings.saveInstallation({ project: 'tools', text: 'Be brief.', by: 'mia-dev' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'tools', key: 'web-env-local', text: 'B=1' });
  await repoSettings.saveOwn({ login: 'ana-k', project: 'tools', text: 'Be kind.' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: 'C=1' });

  await repoSettings.forget('tools');
  assert.deepEqual([...secrets.values.keys()], ['users/sam-ops/repos/app/env/api-env']);
  assert.equal(store.state.repoSettings.tools, undefined);
  assert.equal(store.state.people['ana-k'].repos, undefined);
  assert.ok(store.state.people['sam-ops'].repos.app);

  await repoSettings.forgetPerson('sam-ops');
  assert.equal(secrets.values.size, 0, 'Remove My Woodshed takes theirs for every repo');
});

// The routes behind the pages, over HTTP, as three people: an admin, a member who writes to tools, one who does not.
async function startConsole(t, { secrets: initial = memorySecrets(), people = {}, repoPage = null, envSources = null } = {}) {
  const state = {
    people,
    members: {
      'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true },
      'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' },
      'ana-k': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' },
    },
  };
  const { store, secrets, config, repoSettings } = setup({ state, secrets: initial, envSources });
  const members = createMembers({ store });
  const userSettings = createUserSettings({ store, secrets });
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const fullConfig = { ...config, host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const githubFor = (project) => ({ canWrite: async (login) => project.name !== 'tools' || login !== 'ana-k' });
  const handle = createHandler({
    config: fullConfig, fleet: { sessions: () => [], find: () => null }, auth, members, repoSettings, userSettings,
    projectAccess: createProjectAccess({ config: fullConfig, githubFor }), repoPage,
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  function call(login, method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method, path,
        headers: { host: `localhost:${port}`, cookie: `woodshed_session=${login}`, ...(method === 'POST' && { origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/json' }), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { call, store, secrets };
}

test('Console settings → a repo\'s settings are an admin\'s; My settings\' a writer\'s own; no value ever logged', async (t) => {
  const { call, secrets } = await startConsole(t);
  let lines;
  const results = {};
  lines = await captureLog(async () => {
    results.adminSave = await call('mia-dev', 'POST', '/api/console-settings/repos/tools/env/web-env-local', { text: INSTALLATION_ENV });
    results.adminInstructions = await call('mia-dev', 'POST', '/api/console-settings/repos/tools/instructions', { text: INSTRUCTIONS });
    results.adminRead = await call('mia-dev', 'GET', '/api/console-settings/repos/tools/env/web-env-local');
    results.adminView = await call('mia-dev', 'GET', '/api/console-settings/repos/tools');
    results.memberAdminRead = await call('sam-ops', 'GET', '/api/console-settings/repos/tools/env/web-env-local');
    results.memberAdminWrite = await call('sam-ops', 'POST', '/api/console-settings/repos/tools/env/web-env-local', { text: 'X=1' });
    results.ownSave = await call('sam-ops', 'POST', '/api/my/repos/tools/env/web-env-local', { text: OWN_ENV });
    results.ownRead = await call('sam-ops', 'GET', '/api/my/repos/tools/env/web-env-local');
    results.ownInstructions = await call('sam-ops', 'POST', '/api/my/repos/tools/instructions', { text: INSTRUCTIONS });
    results.ownView = await call('sam-ops', 'GET', '/api/my/repos/tools');
    results.list = await call('sam-ops', 'GET', '/api/my/repos');
    results.adminOwnRead = await call('mia-dev', 'GET', '/api/my/repos/tools/env/web-env-local');
    results.cannotRead = await call('ana-k', 'GET', '/api/my/repos/tools/env/web-env-local');
    results.cannotView = await call('ana-k', 'GET', '/api/my/repos/tools');
    results.cannotWrite = await call('ana-k', 'POST', '/api/my/repos/tools/instructions', { text: 'x' });
    results.anaList = await call('ana-k', 'GET', '/api/my/repos');
    results.crossOrigin = await call('sam-ops', 'POST', '/api/my/repos/tools/env/web-env-local', { text: 'X=1' }, { origin: 'https://evil.example' });
    results.noHeader = await call('mia-dev', 'POST', '/api/console-settings/repos/tools/instructions', { text: 'x' }, { 'x-woodshed': '0' });
    results.refusedInstructions = await call('sam-ops', 'POST', '/api/my/repos/tools/instructions', { text: `Use ghp_${'a'.repeat(36)} for it.` });
    results.unknownKey = await call('mia-dev', 'POST', '/api/console-settings/repos/tools/env/api-env', { text: 'X=1' });
  });

  assert.equal(results.adminSave.status, 200);
  assert.deepEqual(results.adminRead, { status: 200, body: { text: INSTALLATION_ENV } });
  assert.deepEqual(results.adminView.body.envFiles.map((f) => [f.key, f.path, f.installation?.keys]), [['web-env-local', 'web/.env.local', ['API_URL', 'API_TOKEN', 'LOG_LEVEL']]]);
  assert.equal(results.adminView.body.envFiles[0].personal, undefined, 'the admin page has no one\'s own layer');
  assert.equal(results.memberAdminRead.status, 403);
  assert.equal(results.memberAdminWrite.status, 403);
  assert.equal(results.ownSave.status, 200);
  assert.deepEqual(results.ownRead, { status: 200, body: { text: OWN_ENV, installation: INSTALLATION_ENV } }, 'a writer reads the installation\'s values');
  assert.equal(results.ownView.body.instructions.personal.bytes, Buffer.byteLength(INSTRUCTIONS));
  assert.deepEqual(results.list.body.repos, [
    { project: 'app', repo: 'acme/app', envFiles: [], instructions: false, files: 0 },
    { project: 'tools', repo: 'acme/tools', envFiles: ['web-env-local'], instructions: true, files: 0 },
  ]);
  assert.deepEqual(results.adminOwnRead, { status: 200, body: { text: '', installation: INSTALLATION_ENV } }, 'an admin reads their own layer, never sam\'s');
  for (const name of ['cannotRead', 'cannotView', 'cannotWrite']) assert.equal(results[name].status, 403, name);
  assert.deepEqual(results.anaList.body.repos.map((r) => r.project), ['app']);
  assert.equal(results.list.body.defaultProject, 'app', 'the repo My settings opens on');
  assert.equal(results.crossOrigin.status, 403);
  assert.equal(results.noHeader.status, 403);
  assert.equal(results.refusedInstructions.status, 400);
  assert.equal(results.unknownKey.status, 404);
  assert.equal(secrets.values.get('users/sam-ops/repos/tools/env/web-env-local'), OWN_ENV);
  assert.equal(secrets.values.has('users/ana-k/repos/tools/instructions'), false);

  const leaked = lines.filter((line) => line.includes(SECRET_MARK) || line.includes('ghp_aaaa'));
  assert.deepEqual(leaked, [], 'no saved value in any log line');
  assert.ok(lines.some((l) => l.includes('repoSettings: installation values saved') && l.includes("'API_TOKEN'")), 'key names are logged');
  assert.ok(lines.some((l) => l.includes('repoSettings: installation values shown') && l.includes('mia-dev')));
  assert.ok(lines.some((l) => l.includes('repoSettings: refused, cannot write to the repo') && l.includes('ana-k')));
});

test('the session hand-out logs keys and layers, never a value', async () => {
  const { repoSettings } = setup();
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', text: INSTRUCTIONS });
  const lines = await captureLog(() => repoSettings.forSession({ id: 'a1', project: 'app', owner: 'sam-ops' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /repoSettings: handed out/);
  assert.match(lines[0], /installation: \[ 'api-env' \]/);
  assert.ok(!lines[0].includes(SECRET_MARK));
});

test('the routes: each path names one, and nothing else is one', () => {
  assert.deepEqual(repoSettingsRoute('/api/console-settings/repos/app/env/api-env/remove'), { scope: 'admin', project: 'app', key: 'api-env', remove: true, instructions: false });
  assert.deepEqual(repoSettingsRoute('/api/my/repos/app/instructions'), { scope: 'my', project: 'app', key: null, remove: false, instructions: true, files: false });
  assert.deepEqual(repoSettingsRoute('/api/my/repos'), { scope: 'my', project: null, key: null, remove: false, instructions: false, files: false });
  assert.deepEqual(repoSettingsRoute('/api/my/repos/app/files'), { scope: 'my', project: 'app', key: null, remove: false, instructions: false, files: true });
  assert.deepEqual(repoSettingsRoute('/api/my/own-files'), { scope: 'my', project: null, key: null, remove: false, instructions: false, files: true, oldFiles: true });
  for (const path of ['/api/console-settings/projects/repos', '/api/my/repos/app/env', '/api/my/repos/app/env/a/remove', '/api/my/reposx', '/api/my/repos/app/files/x', '/api/my/own-filesx']) assert.equal(repoSettingsRoute(path), null, path);
});


test('the old route of an env file\'s own lines is gone: /api/my/files names tmux-conf and the dotfiles alone, and an old own-lines secret is never read', async (t) => {
  const secrets = memorySecrets({ 'api-env': 'API_URL=http://legacy\n', 'users/sam-ops/api-env': `OLD=${SECRET_MARK}\n` });
  const { call } = await startConsole(t, { secrets, people: { 'sam-ops': { files: { 'api-env': '2026-10-01T00:00:00.000Z' } } } });
  const old = await call('sam-ops', 'GET', '/api/my/files/api-env');
  assert.notEqual(old.status, 200);
  assert.ok(!JSON.stringify(old.body).includes(SECRET_MARK));
  const saved = await call('sam-ops', 'POST', '/api/my/files/api-env', { text: 'X=1\n' });
  assert.notEqual(saved.status, 200);
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false, 'nothing lands in repo settings the old way');
  assert.equal((await call('sam-ops', 'POST', '/api/my/files/tmux-conf', { text: 'set -g mouse on\n' })).status, 200, 'tmux-conf stays My settings\' own');
});

test('a session is handed repo settings alone: an old Terraform env file secret in the store is never copied in', async () => {
  const secrets = memorySecrets({ 'api-env': 'API_URL=http://legacy\n' });
  const { repoSettings } = setup({ secrets });
  assert.deepEqual((await repoSettings.forSession({ id: 's1', project: 'app', owner: null })).envFiles, {});
  assert.equal(secrets.values.has('repos/app/env/api-env'), false);
  assert.equal((await repoSettings.view('app')).envFiles[0].legacy, undefined, 'the view names no Terraform secret');
});

test('a person\'s own whole files are kept for each repo apart, by path, and a session gets its own repo\'s alone', async () => {
  const { repoSettings, secrets, store } = setup();
  const lines = await captureLog(async () => {
    assert.deepEqual(await repoSettings.ownFiles({ login: 'sam-ops', project: 'app' }), {}, 'none yet');
    assert.deepEqual(await repoSettings.saveOwnFile({ login: 'Sam-Ops', project: 'app', path: ' app/.env.production ', text: `NOTION_TOKEN=${SECRET_MARK}\r\n` }),
      { 'app/.env.production': `NOTION_TOKEN=${SECRET_MARK}\n` });
    await repoSettings.saveOwnFile({ login: 'sam-ops', project: 'app', path: '.mcp.local.json', text: '{}' });
    await repoSettings.saveOwnFile({ login: 'sam-ops', project: 'tools', path: 'app/.env.production', text: `TOOLS=${SECRET_MARK}` });
  });
  assert.deepEqual(JSON.parse(secrets.values.get('users/sam-ops/repos/app/files')), { 'app/.env.production': `NOTION_TOKEN=${SECRET_MARK}\n`, '.mcp.local.json': '{}' });
  assert.deepEqual(JSON.parse(secrets.values.get('users/sam-ops/repos/tools/files')), { 'app/.env.production': `TOOLS=${SECRET_MARK}` }, 'one path, a different text a repo');
  assert.deepEqual((await repoSettings.view('app', { login: 'sam-ops' })).files, [
    { path: '.mcp.local.json', savedAt: '2026-11-12T10:00:02.000Z' },
    { path: 'app/.env.production', savedAt: '2026-11-12T10:00:01.000Z' },
  ], 'a save keeps the others\' times');
  assert.equal((await repoSettings.view('app')).files, undefined, 'the admin\'s page has no one\'s files');
  assert.equal(repoSettings.summary('sam-ops', { name: 'app', repo: 'acme/app' }).files, 2);
  assert.equal(JSON.stringify(store.state).includes(SECRET_MARK), false, 'state.json never holds the text');
  assert.deepEqual(lines.filter((l) => l.includes(SECRET_MARK)), [], 'nor does the log');
  assert.ok(lines.some((l) => l.includes('repoSettings: own file saved') && l.includes("'app/.env.production'")));

  assert.deepEqual(await repoSettings.filesForSession({ id: 'a1', project: 'tools', owner: 'sam-ops' }), { 'app/.env.production': `TOOLS=${SECRET_MARK}` });
  assert.deepEqual(Object.keys(await repoSettings.filesForSession({ id: 'a2', repo: 'acme/app', owner: 'sam-ops' })), ['app/.env.production', '.mcp.local.json']);
  for (const session of [{ id: 's', project: 'app' }, { id: 'q', project: 'app', owner: 'sam-ops', qa: { pr: 1 } }, { id: 'k', project: 'app', owner: 'sam-ops', kind: 'ask' }, { id: 'm', project: 'app', owner: 'mia-dev' }]) {
    assert.deepEqual(await repoSettings.filesForSession(session), {}, session.id);
  }

  await repoSettings.saveOwnFile({ login: 'sam-ops', project: 'tools', path: 'app/.env.production', text: '  ' });
  assert.equal(secrets.values.has('users/sam-ops/repos/tools/files'), false, 'the last one removed takes the value with it');
  assert.equal(store.state.people['sam-ops'].repos.tools, undefined);
  await repoSettings.forgetPerson('sam-ops');
  assert.deepEqual([...secrets.values.keys()], [], 'Remove My Woodshed deletes them');
});

test('an own file is refused for a bad path, an env file of its own repo, an unread project file or past the store\'s limit', async () => {
  const unread = Object.assign(new Error('GitHub did not answer'), {});
  const { repoSettings } = setup({ files: { ...FILES, tools: unread } });
  for (const [file, message] of [['/etc/passwd', /leading/], ['../x', /\.\./], ['.git/config', /git's own/], ['a b', /letters/], ['api/.env', /one of acme\/app's env files/]]) {
    await assert.rejects(repoSettings.saveOwnFile({ login: 'sam-ops', project: 'app', path: file, text: 'x' }), (err) => err.shown && message.test(err.message), file);
  }
  await assert.rejects(repoSettings.saveOwnFile({ login: 'sam-ops', project: 'tools', path: 'api/.env', text: 'x' }), (err) => err.status === 409 && /could not be read/.test(err.message), 'not checked, so not kept');
  await assert.rejects(repoSettings.saveOwnFile({ login: 'sam-ops', project: 'nope', path: 'a', text: 'x' }), (err) => err.status === 404);
  await assert.rejects(repoSettings.saveOwnFile({ login: 'sam-ops', project: 'app', path: 'big', text: 'x'.repeat(70_000) }), /over the 64 KB this console's secret store holds/);
  for (let i = 0; i < 20; i += 1) await repoSettings.saveOwnFile({ login: 'sam-ops', project: 'app', path: `f${i}`, text: 'x' });
  await assert.rejects(repoSettings.saveOwnFile({ login: 'sam-ops', project: 'app', path: 'f20', text: 'x' }), /20 files a repo at most/);

  const roomy = memorySecrets();
  roomy.maxValueBytes = 1_048_576;
  const big = setup({ secrets: roomy }).repoSettings;
  assert.equal((await big.view('app', { login: 'sam-ops' })).filesMaxBytes, 1_048_576);
  assert.equal((await big.saveOwnFile({ login: 'sam-ops', project: 'app', path: 'big', text: 'x'.repeat(70_000) })).big.length, 70_000);
});

test('own files from before they were per repo move into the default project once, and never over files already there', async () => {
  const at = '2026-10-01T00:00:00.000Z';
  const secrets = memorySecrets({
    'users/sam-ops/own-files': JSON.stringify({ 'app/.env.production': `A=${SECRET_MARK}` }),
    'users/mia-dev/own-files': JSON.stringify({ old: 'x', both: 'old' }),
    'users/mia-dev/repos/app/files': JSON.stringify({ new: 'y', both: 'new' }),
    'users/ana-k/own-files': JSON.stringify({ big: 'x'.repeat(40_000) }),
    'users/ana-k/repos/app/files': JSON.stringify({ mine: 'y'.repeat(40_000) }),
  });
  const people = {
    'sam-ops': { ownFiles: { 'app/.env.production': at } },
    'mia-dev': { ownFiles: { old: at, both: at }, repos: { app: { files: { new: at, both: at } } } },
    'ana-k': { ownFiles: { big: at }, repos: { app: { files: { mine: at } } } },
  };
  const { repoSettings, store } = setup({ state: { people }, secrets });

  const lines = await captureLog(async () => assert.deepEqual(await repoSettings.moveOwnFiles(), { moved: 2, kept: 1, failed: 0 }));
  assert.deepEqual(await repoSettings.ownFiles({ login: 'sam-ops', project: 'app' }), { 'app/.env.production': `A=${SECRET_MARK}` });
  assert.deepEqual((await repoSettings.view('app', { login: 'sam-ops' })).files, [{ path: 'app/.env.production', savedAt: at }]);
  assert.deepEqual(await repoSettings.ownFiles({ login: 'mia-dev', project: 'app' }), { new: 'y', both: 'new', old: 'x' }, 'the old paths are added, theirs win');
  assert.deepEqual((await repoSettings.view('app', { login: 'mia-dev' })).files.map((f) => f.path), ['both', 'new', 'old']);
  assert.deepEqual(Object.keys(await repoSettings.ownFiles({ login: 'ana-k', project: 'app' })), ['mine'], 'together over 64 KB: theirs alone');
  assert.ok(lines.some((l) => l.includes('ana-k') && l.includes("leftOut: [ 'big' ]")), 'and the log names what was left out');
  assert.deepEqual([...secrets.values.keys()].filter((k) => k.endsWith('/own-files')), [], 'the old values are deleted');
  assert.equal(store.state.people['sam-ops'].ownFiles, undefined);
  assert.deepEqual(await repoSettings.ownFiles({ login: 'sam-ops', project: 'tools' }), {}, 'never another repo\'s');
  assert.deepEqual(lines.filter((l) => l.includes(SECRET_MARK)), []);
  assert.deepEqual(await repoSettings.moveOwnFiles(), { moved: 0, kept: 0, failed: 0 }, 'a second start finds nothing');

  const failing = memorySecrets({ 'users/sam-ops/own-files': '{"a":"b"}' });
  failing.save = async () => { throw new Error('AccessDeniedException'); };
  const second = setup({ state: { people: { 'sam-ops': { ownFiles: { a: at } } } }, secrets: failing });
  await captureLog(async () => assert.deepEqual(await second.repoSettings.moveOwnFiles(), { moved: 0, kept: 0, failed: 1 }));
  assert.equal(failing.values.has('users/sam-ops/own-files'), true, 'kept, for the next start');
  assert.deepEqual(second.store.state.people['sam-ops'].ownFiles, { a: at });
});

test('My settings reads and saves own files for a repo the person can write to, and the old route is the default project\'s', async (t) => {
  const { call, secrets } = await startConsole(t);
  const results = {};
  const lines = await captureLog(async () => {
    results.save = await call('sam-ops', 'POST', '/api/my/repos/tools/files', { path: 'app/.env.production', text: `T=${SECRET_MARK}`, login: 'ana-k' });
    results.read = await call('sam-ops', 'GET', '/api/my/repos/tools/files');
    results.other = await call('sam-ops', 'GET', '/api/my/repos/app/files');
    results.cannotRead = await call('ana-k', 'GET', '/api/my/repos/tools/files');
    results.cannotWrite = await call('ana-k', 'POST', '/api/my/repos/tools/files', { path: 'a', text: 'x' });
    results.crossOrigin = await call('sam-ops', 'POST', '/api/my/repos/tools/files', { path: 'a', text: 'x' }, { origin: 'https://evil.example' });
    results.badPath = await call('sam-ops', 'POST', '/api/my/repos/tools/files', { path: '../x', text: 'x' });
    results.oldSave = await call('sam-ops', 'POST', '/api/my/own-files', { path: '.mcp.local.json', text: '{}' });
    results.oldRead = await call('sam-ops', 'GET', '/api/my/own-files');
    results.tooBig = await call('sam-ops', 'POST', '/api/my/repos/app/files', { path: 'big', text: 'x'.repeat(300_000) });
  });
  assert.equal(results.save.status, 200);
  assert.deepEqual(results.save.body.files, { 'app/.env.production': `T=${SECRET_MARK}` });
  assert.deepEqual(results.save.body.view.files.map((f) => f.path), ['app/.env.production'], 'the repo\'s view comes with the answer');
  assert.deepEqual(results.read.body, { files: { 'app/.env.production': `T=${SECRET_MARK}` } });
  assert.deepEqual(results.other.body, { files: {} }, 'the other repo has none');
  assert.equal(secrets.values.has('users/ana-k/repos/tools/files'), false, 'never the login a body names');
  for (const name of ['cannotRead', 'cannotWrite', 'crossOrigin']) assert.equal(results[name].status, 403, name);
  assert.equal(results.badPath.status, 400);
  assert.equal(results.oldSave.status, 200);
  assert.equal(results.oldSave.body.view.login, 'sam-ops', 'the old page gets My settings\' view, as it did');
  assert.deepEqual(JSON.parse(secrets.values.get('users/sam-ops/repos/app/files')), { '.mcp.local.json': '{}' });
  assert.deepEqual(results.oldRead.body, { files: { '.mcp.local.json': '{}' } });
  assert.equal(results.tooBig.status, 413, 'past what the store could hold, even escaped');
  assert.deepEqual(lines.filter((l) => l.includes(SECRET_MARK)), []);
});

test('a program\'s own groups for a repo\'s page come with the admin\'s view, and one that fails adds none', async (t) => {
  const asked = [];
  let answer = (repo) => group({ label: 'Project file' }, row({ id: 'project-file', title: `${repo.repo}'s file`, pill: pill('Drafted', 'work') }));
  const { call } = await startConsole(t, { repoPage: async (repo) => { asked.push(repo); return answer(repo); } });
  const view = await call('mia-dev', 'GET', '/api/console-settings/repos/tools', undefined, { 'x-org': 'acme' });
  assert.equal(view.status, 200);
  assert.match(view.body.host.html, /<div class="set-group"><h2 class="set-group-label">Project file<\/h2>/, 'its markup, as it made it');
  assert.deepEqual(view.body.host.scripts, [], 'no script it did not name');
  assert.equal(asked.at(-1).name, 'tools');
  assert.equal(asked.at(-1).headers['x-org'], 'acme', 'the request\'s headers, so the program knows whose it is');
  assert.ok(asked.at(-1).repo, 'and the repo');
  // A save answers with the view too, so the page keeps the program's groups.
  const saved = await call('mia-dev', 'POST', '/api/console-settings/repos/tools/instructions', { text: 'Be brief.' });
  assert.match(saved.body.host.html, /Project file/);
  // With the scripts that make its groups work: paths on the console's address alone.
  answer = (repo) => ({ markup: group({ label: 'Session data' }, row({ id: 'd', title: repo.name })), scripts: ['/assets/upload.js', 'https://x.test/a.js', '//x.test/b.js', '/\\x.test/c.js', 7] });
  const withScripts = await call('mia-dev', 'GET', '/api/console-settings/repos/tools');
  assert.match(withScripts.body.host.html, /Session data/);
  assert.deepEqual(withScripts.body.host.scripts, ['/assets/upload.js']);
  const quiet = [];
  answer = () => { throw new Error('the database is away'); };
  const original = console.warn;
  console.warn = (...args) => quiet.push(args);
  try {
    const failed = await call('mia-dev', 'GET', '/api/console-settings/repos/tools');
    assert.equal(failed.status, 200, 'the page is still shown');
    assert.equal(failed.body.host, null);
    answer = () => ({ html: '<script>' });
    assert.equal((await call('mia-dev', 'GET', '/api/console-settings/repos/tools')).body.host, null, 'anything but markup is none');
    answer = () => '<div class="set-group">tools</div>';
    assert.equal((await call('mia-dev', 'GET', '/api/console-settings/repos/tools')).body.host, null, 'nor a string, which settingsMarkup.mjs did not escape');
  } finally {
    console.warn = original;
  }
  assert.deepEqual(quiet.map((a) => a[0]), Array(3).fill('repoSettings: the program\'s groups not given'));
  answer = () => null;
  assert.equal((await call('mia-dev', 'GET', '/api/console-settings/repos/tools')).body.host, null, 'none for this repo');
  assert.equal((await call('sam-ops', 'GET', '/api/console-settings/repos/tools')).status, 403, 'still an admin\'s alone');
});

// A program's own source of env files' installation values, a made-up secret manager: `files` by env file key.
const VAULT_ENV = `API_URL=http://vault.test\nAPI_TOKEN=vault-${SECRET_MARK}\n`;
function vault(files) {
  const asked = { view: [], forSession: [] };
  return {
    asked,
    async view(args) {
      asked.view.push(args);
      return Object.fromEntries(Object.entries(files).map(([key, f]) => [key, { label: 'Vault', on: f.on, keys: f.keys, markup: note(`Vault for ${key}`) }]));
    },
    async forSession(args) {
      asked.forSession.push(args);
      return Object.fromEntries(Object.entries(files).filter(([, f]) => f.on).map(([key, f]) => [key, f.text]));
    },
  };
}

test('an env file whose source is on hands the session the source\'s text in place of the typed one, which stays kept', async () => {
  const envSources = vault({ 'api-env': { on: true, keys: ['API_URL', 'API_TOKEN'], text: VAULT_ENV }, 'web-env-local': { on: true, keys: ['PUBLIC_URL'], text: 'PUBLIC_URL=http://web.test\r\n' } });
  const { repoSettings, secrets } = setup({ envSources });
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: OWN_ENV });
  let answer;
  const lines = await captureLog(async () => { answer = await repoSettings.forSession({ id: 'a1', project: 'app', owner: 'sam-ops' }); });
  assert.deepEqual(answer.envFiles, {
    'api-env': { installation: VAULT_ENV, personal: OWN_ENV },
    'web-env-local': { installation: 'PUBLIC_URL=http://web.test\n', personal: null },
  }, 'the source\'s text, a file with no typed record included, and the person\'s own untouched');
  assert.deepEqual(envSources.asked.forSession, [{ name: 'app', repo: 'acme/app', session: { id: 'a1', owner: 'sam-ops' } }]);
  assert.equal(secrets.values.get('repos/app/env/api-env'), INSTALLATION_ENV, 'the typed value is still kept');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /repoSettings: handed out/);
  assert.match(lines[0], /fromSource: \[ 'api-env', 'web-env-local' \]/);
  assert.ok(!lines.join('\n').includes(SECRET_MARK), 'no value in the log');
  assert.equal(await repoSettings.forSession({ id: 'd4', project: 'app', kind: 'ask' }), null, 'an ask session gets nothing');
  assert.equal(envSources.asked.forSession.length, 1, 'and the source is not asked for it');
});

test('a source that is off, or names no file, leaves the typed values; text that cannot be used leaves the layer with none', async () => {
  const off = vault({ 'api-env': { on: false, keys: [], text: VAULT_ENV } });
  const first = setup({ envSources: off });
  await first.repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
  const lines = await captureLog(async () => {
    assert.deepEqual((await first.repoSettings.forSession({ id: 'a1', project: 'app', owner: null })).envFiles, { 'api-env': { installation: INSTALLATION_ENV, personal: null } });
  });
  assert.match(lines[0], /fromSource: \[\]/);

  let given = { 'api-env': 7, 'web-env-local': `BIG=${'x'.repeat(70_000)}`, 'Not A Key': 'A=1', tools: '  \n' };
  const bad = setup({ envSources: { view: async () => null, forSession: async () => given } });
  await bad.repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
  let answer;
  const warned = await captureLog(async () => { answer = await bad.repoSettings.forSession({ id: 'b2', project: 'app', owner: null }); });
  assert.deepEqual(answer.envFiles, {
    'api-env': { installation: null, personal: null }, 'web-env-local': { installation: null, personal: null }, tools: { installation: null, personal: null },
  }, 'none, never the typed text: the page says it is not used while the source is on');
  const refusals = warned.filter((l) => l.includes('repoSettings: env source text refused, the installation layer handed out as none'));
  assert.equal(refusals.length, 1, 'one line, counting them');
  assert.match(refusals[0], /refused: 3,\s+notAKey: 1,\s+notText: 1,\s+tooLarge: 1/);
  assert.ok(!refusals[0].includes('api-env') && !refusals[0].includes('Not A Key'), 'and naming none: a key is the program\'s text');
  assert.match(warned.at(-1), /fromSource: \[ 'api-env', 'web-env-local' \],\s+fromSourceUnnamed: 1/, 'the project file\'s env files by name; one it does not name is handed on and counted');

  // A hook that throws, or answers no object, says nothing of which sources are on.
  const thrown = Object.assign(new TypeError(`the vault is away\n${SECRET_MARK}`), { code: 'ECONNREFUSED' });
  for (const [fail, said] of [[() => { throw thrown; }, /why: 'the hook threw',\s+error: 'TypeError',\s+code: 'ECONNREFUSED'/], [() => 'api-env', /why: 'answered string, not an object by env file key'/]]) {
    const failing = setup({ envSources: { view: async () => null, forSession: async () => fail() } });
    await failing.repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
    const lines = await captureLog(async () => { answer = await failing.repoSettings.forSession({ id: 'c3', project: 'app', owner: null }); });
    assert.deepEqual(answer.envFiles, { 'api-env': { installation: INSTALLATION_ENV, personal: null } });
    assert.match(lines[0], /repoSettings: env sources not read, the typed values handed out/);
    assert.match(lines[0], said);
    assert.ok(!lines.join('\n').includes(SECRET_MARK));
  }
});

// What a program's hook may hold by mistake: its secret manager's error quoting a token, a value under the wrong name.
const LEAK = `sk-live-${SECRET_MARK}`;

test('nothing a program\'s source wrote reaches the log: not a thrown message, an error\'s name or code, a key or an entry', async () => {
  const typed = async (repoSettings) => repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: 'API_URL=http://typed.test\n', by: 'mia-dev' });
  const leaky = Object.assign(new Error(`401 from the vault: token ${LEAK} was refused`), { name: `Vault ${LEAK}`, code: LEAK });
  const forSession = [
    () => { throw leaky; },
    () => { throw LEAK; },
    () => LEAK,
    () => [LEAK],
    // As keys: one in an env file key's shape, one not. As entries: text too large, and what is no text.
    () => ({ [`token-${SECRET_MARK}`]: 7, [LEAK]: 'A=1', [`TOKEN=${LEAK}`]: `A=${LEAK}`, 'api-env': { token: LEAK }, 'web-env-local': `A=${LEAK}${'x'.repeat(70_000)}` }),
  ];
  for (const answer of forSession) {
    const { repoSettings } = setup({ envSources: { view: async () => null, forSession: async () => answer() } });
    const lines = await captureLog(async () => {
      await typed(repoSettings);
      await repoSettings.forSession({ id: 'a1', project: 'app', owner: null });
    });
    assert.ok(lines.some((l) => /repoSettings: env source(s not read| text refused)/.test(l)), 'the failure is logged');
    assert.ok(!lines.join('\n').includes(SECRET_MARK), `forSession ${String(answer).slice(0, 40)}: ${lines.filter((l) => l.includes(SECRET_MARK)).join(' | ').replaceAll(SECRET_MARK, '<the secret>')}`);
  }
  const view = [
    () => { throw leaky; },
    () => LEAK,
    () => ({ 'api-env': LEAK }),
    () => ({ 'api-env': { label: LEAK.repeat(3), on: true } }),
    () => ({ 'api-env': { label: 'Vault', on: true, keys: [`API_TOKEN=${LEAK}`] } }),
    () => ({ 'api-env': { label: 'Vault', on: true, markup: `<p>${LEAK}</p>` } }),
    () => ({ [LEAK]: { label: 'Vault', on: true }, 'api-env': { label: 'Vault', on: 'yes', keys: 7 } }),
  ];
  for (const answer of view) {
    const { repoSettings } = setup({ envSources: { view: async () => answer(), forSession: async () => null } });
    const lines = await captureLog(async () => { await repoSettings.view('app'); });
    assert.equal(lines.filter((l) => l.includes('repoSettings: the program\'s env sources not given')).length, 1, 'the failure is logged');
    assert.ok(!lines.join('\n').includes(SECRET_MARK), `view ${String(answer).slice(0, 40)}: ${lines.filter((l) => l.includes(SECRET_MARK)).join(' | ').replaceAll(SECRET_MARK, '<the secret>')}`);
  }
  // What the lines do say: the kind of thing that was wrong, in the console's words, and an error's class where it is a name.
  const said = setup({ envSources: { view: async () => ({ 'api-env': { label: '', on: true } }), forSession: async () => { throw Object.assign(new RangeError(LEAK), { code: 'ERR_VAULT_AWAY' }); } } });
  const lines = await captureLog(async () => {
    await said.repoSettings.view('app');
    await said.repoSettings.forSession({ id: 'a1', project: 'app', owner: null });
  });
  assert.match(lines[0], /the program's env sources not given \{\s+project: 'app',\s+why: 'a label is not 1 to 40 characters',\s+key: 'api-env'\s+\}/);
  assert.match(lines[1], /env sources not read, the typed values handed out \{\s+sessionId: 'a1',\s+project: 'app',\s+why: 'the hook threw',\s+error: 'RangeError',\s+code: 'ERR_VAULT_AWAY'\s+\}/);
});

test('a source that does not answer in time costs the session its source, not its start: the typed values are handed out', async () => {
  let asked = 0;
  const hung = { view: async () => null, forSession: () => { asked += 1; return new Promise(() => {}); } };
  const { repoSettings } = setup({ envSources: hung, envSourcesTimeoutMs: 20 });
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: INSTALLATION_ENV, by: 'mia-dev' });
  let answer;
  const started = Date.now();
  const lines = await captureLog(async () => { answer = await repoSettings.forSession({ id: 'a1', project: 'app', owner: null }); });
  assert.ok(Date.now() - started < 5000, 'answered, not hung');
  assert.equal(asked, 1);
  assert.deepEqual(answer.envFiles, { 'api-env': { installation: INSTALLATION_ENV, personal: null } });
  assert.match(lines[0], /repoSettings: env sources not read, the typed values handed out/);
  assert.match(lines[0], /why: 'no answer in 20 ms'/);
  assert.match(lines.at(-1), /fromSource: \[\]/);
  assert.ok(ENV_SOURCES_TIMEOUT_MS < 15_000, 'under the 15 s a session waits for its repo settings (session/entrypoint.sh)');
  // One that answers late and then fails is no unhandled rejection, and one in time is used.
  const slow = setup({ envSources: { view: async () => null, forSession: () => new Promise((_, reject) => { setTimeout(() => reject(new Error('late')), 40); }) }, envSourcesTimeoutMs: 10 });
  await captureLog(async () => { await slow.repoSettings.forSession({ id: 'b2', project: 'app', owner: null }); });
  await new Promise((r) => { setTimeout(r, 60); });
  const quick = setup({ envSources: { view: async () => null, forSession: async () => ({ 'api-env': VAULT_ENV }) }, envSourcesTimeoutMs: 1000 });
  let handed;
  await captureLog(async () => { handed = await quick.repoSettings.forSession({ id: 'c3', project: 'app', owner: null }); });
  assert.equal(handed.envFiles['api-env'].installation, VAULT_ENV);
});

test('the views say which env files have a source, and the table\'s installation layer is the source\'s keys while it is on', async (t) => {
  const envSources = vault({ 'api-env': { on: true, keys: ['API_URL', 'VAULT_ONLY'], text: VAULT_ENV }, 'web-env-local': { on: false, keys: ['IGNORED'], text: '' }, 'not-in-the-file': { on: true, keys: [], text: '' } });
  const { call } = await startConsole(t, { envSources });
  await call('mia-dev', 'POST', '/api/console-settings/repos/app/env/api-env', { text: INSTALLATION_ENV });
  const admin = (await call('mia-dev', 'GET', '/api/console-settings/repos/app', undefined, { 'x-org': 'acme' })).body;
  const [api, web] = admin.envFiles;
  assert.deepEqual(api.source, { label: 'Vault', on: true, keys: ['API_URL', 'VAULT_ONLY'], html: '<p class="form-note">Vault for api-env</p>', scripts: [] });
  assert.deepEqual(web.source, { label: 'Vault', on: false, keys: [], html: '<p class="form-note">Vault for web-env-local</p>', scripts: [] }, 'off: its keys are not the session\'s');
  assert.deepEqual(api.installation.keys, ['API_URL', 'API_TOKEN', 'LOG_LEVEL'], 'the typed record stays');
  const set = Object.fromEntries(api.table.map((r) => [r.key, r.setBy]));
  assert.ok(set.VAULT_ONLY.includes('installation') && set.API_URL.includes('installation'), 'the source\'s keys');
  assert.ok(!set.API_TOKEN, 'a typed key the source does not set reaches no session');
  assert.deepEqual(set.LOG_LEVEL, ['repo'], 'nor wins over the repo\'s default');
  const asked = envSources.asked.view.at(-1);
  assert.deepEqual({ name: asked.name, repo: asked.repo, keys: asked.keys }, { name: 'app', repo: 'acme/app', keys: ['api-env', 'web-env-local'] }, 'asked of the keys the project file names');
  assert.equal(asked.headers['x-org'], 'acme', 'with the request\'s headers');
  assert.equal(admin.envFiles.length, 2, 'a key the project file does not name adds no file');

  const mine = (await call('sam-ops', 'GET', '/api/my/repos/app')).body;
  assert.deepEqual(mine.envFiles[0].source, { label: 'Vault', on: true, keys: ['API_URL', 'VAULT_ONLY'] }, 'My settings: never the program\'s controls');
  assert.ok(mine.envFiles[0].table.some((r) => r.key === 'VAULT_ONLY'));
});

test('a source that throws or answers badly adds nothing to the views, and no hook leaves them as they were', async (t) => {
  let answer = () => { throw new Error('the vault is away'); };
  const { call } = await startConsole(t, { envSources: { view: async (args) => answer(args), forSession: async () => null } });
  const plain = await startConsole(t);
  const expected = (await plain.call('mia-dev', 'GET', '/api/console-settings/repos/app')).body;
  const bad = [
    answer,
    () => 'api-env',
    () => ({ 'api-env': { label: '', on: true } }),
    () => ({ 'api-env': { label: 'x'.repeat(41), on: true } }),
    () => ({ 'api-env': { label: 'Vault', on: true, keys: [`API_TOKEN=${SECRET_MARK}`] } }),
    () => ({ 'api-env': { label: 'Vault', on: true, keys: 'API_URL' } }),
    () => ({ 'api-env': { label: 'Vault', on: true, markup: '<p>Vault</p>' } }),
  ];
  const lines = await captureLog(async () => {
    for (const next of bad) {
      answer = next;
      assert.deepEqual((await call('mia-dev', 'GET', '/api/console-settings/repos/app')).body, expected);
    }
  });
  assert.equal(lines.filter((l) => l.includes('repoSettings: the program\'s env sources not given')).length, bad.length);
  assert.ok(!lines.join('\n').includes(SECRET_MARK), 'a name that was a value by mistake is not logged');
  answer = () => null;
  assert.deepEqual((await call('mia-dev', 'GET', '/api/console-settings/repos/app')).body, expected, 'none for this repo');
  answer = () => ({ 'api-env': { label: ' Vault ', on: 'yes', scripts: ['/assets/vault.js', 'https://x.test/a.js'] } });
  assert.deepEqual((await call('mia-dev', 'GET', '/api/console-settings/repos/app')).body.envFiles[0].source, { label: 'Vault', on: false, keys: [] }, 'on is true alone, and no markup carries no scripts');
});

test('envSources is view and forSession, both functions, or the installation is not made', async () => {
  const base = { config: {}, store: { state: {} }, provider: {} };
  await assert.rejects(createInstallation({ ...base, envSources: async () => null }), /envSources needs view and forSession/);
  await assert.rejects(createInstallation({ ...base, envSources: { view: async () => null } }), /envSources needs view and forSession/);
  assert.throws(() => setup({ envSources: { forSession: async () => null } }), /envSources needs view and forSession/);
});
