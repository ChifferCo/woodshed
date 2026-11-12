import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspect } from 'node:util';

import { createMembers } from './members.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import {
  createRepoSettings, installationEnvName, installationInstructionsName, legacyFileRoute, personalEnvName, personalInstructionsName, repoSettingsRoute,
} from './repoSettings.mjs';
import { createUserSettings } from './userSettings.mjs';
import { writeEnvFiles, writtenLines } from '../shared/project.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from './server.mjs';
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
      { path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info', 'FEATURE_X=off'], lines: ['PORT={{PORT}}', 'ANTHROPIC_API_KEY={{ANTHROPIC_API_KEY?}}'] },
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

function setup({ state = {}, secrets = memorySecrets(), files = FILES, envFiles = [] } = {}) {
  const store = { state: { sessions: [], ...state }, save() {} };
  const config = { projects: PROJECTS, repo: 'acme/app', envFiles };
  const readerOf = (name) => ({
    async repoLayer() {
      if (files[name] instanceof Error) throw files[name];
      const project = files[name];
      return { envFiles: project?.envFiles ?? [], env: project?.env ?? {}, rules: project?.rules ?? null, setup: project?.setup ?? null };
    },
  });
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const repoSettings = createRepoSettings({ store, secrets, config, readerOf, now: () => (clock += 1000) });
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
  assert.deepEqual(api.wiring, { lines: ['PORT', 'ANTHROPIC_API_KEY'], optional: ['ANTHROPIC_API_KEY'], env: ['NODE_ENV'] });
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
  await repoSettings.saveInstallation({ project: 'app', key: 'web-env-local', text: 'NEXT_PUBLIC_X=1', by: 'mia-dev' });
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
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'web-env-local', text: 'NEXT_PUBLIC_DEBUG=1\n' });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', text: 'Answer in French.\n' });
  await repoSettings.saveInstallation({ project: 'tools', key: 'web-env-local', text: 'TOOLS=1\n', by: 'mia-dev' });

  assert.deepEqual(await repoSettings.forSession({ id: 'a1', project: 'app', owner: 'sam-ops' }), {
    project: 'app',
    envFiles: { 'api-env': { installation: INSTALLATION_ENV, personal: OWN_ENV }, 'web-env-local': { installation: null, personal: 'NEXT_PUBLIC_DEBUG=1\n' } },
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

test('the copy at start moves the legacy env files and own lines into the new names, never over a value there, and twice changes nothing', async () => {
  const secrets = memorySecrets({
    'api-env': 'API_URL=http://legacy\n', 'web-env': 'NEXT_PUBLIC_A=1\n', 'users/sam-ops/api-env': 'LOG_LEVEL=debug\n',
    'repos/app/env/web-env': 'NEXT_PUBLIC_A=2\n', 'users/ana-k/api-env': 'A=1\n',
  });
  const state = { people: { 'sam-ops': { files: { 'api-env': '2026-10-01T00:00:00.000Z', 'tmux-conf': '2026-10-01T00:00:00.000Z' } }, 'ana-k': { files: { 'api-env': null } } } };
  const envFiles = [{ secret: 'api-env', path: 'api/.env' }, { secret: 'web-env', path: 'web/.env.local' }, { secret: 'empty-env', path: 'x/.env' }];
  const { store, repoSettings } = setup({ state, secrets, envFiles });

  assert.deepEqual(await repoSettings.migrate(), { copied: 1, ownCopied: 1, kept: 1, none: 1, done: 0, failed: 0 });
  assert.equal(secrets.values.get('repos/app/env/api-env'), 'API_URL=http://legacy\n');
  assert.equal(secrets.values.get('repos/app/env/web-env'), 'NEXT_PUBLIC_A=2\n', 'the value already there stays');
  assert.equal(secrets.values.get('users/sam-ops/repos/app/env/api-env'), 'LOG_LEVEL=debug\n');
  assert.equal(secrets.values.has('users/ana-k/repos/app/env/api-env'), false, 'lines cleared on My settings are not copied back');
  assert.equal(secrets.values.get('api-env'), 'API_URL=http://legacy\n', 'the legacy secret stays, for the fallback');
  assert.deepEqual(store.state.repoSettingsMigration, { copiedAt: '2026-11-12T10:00:01.000Z', from: 'terraform env_files', files: { 'api-env': '2026-11-12T10:00:01.000Z' } });
  assert.deepEqual(store.state.repoSettings.app.env['api-env'].by, 'terraform env_files');

  const before = { state: structuredClone(store.state), secrets: new Map(secrets.values) };
  assert.deepEqual(await repoSettings.migrate(), { copied: 0, ownCopied: 0, kept: 2, none: 1, done: 1, failed: 0 });
  assert.deepEqual(store.state, before.state, 'a second start changes no record');
  assert.deepEqual(secrets.values, before.secrets, 'nor any value');
});

test('a copy that fails is tried again at the next start, and the others go ahead', async () => {
  const secrets = memorySecrets({ 'api-env': 'A=1\n', 'web-env': 'B=1\n' });
  const save = secrets.save;
  secrets.save = async (name, value) => {
    if (name.endsWith('/api-env')) throw new Error('AccessDeniedException');
    return save(name, value);
  };
  const { repoSettings } = setup({ secrets, envFiles: [{ secret: 'api-env', path: 'api/.env' }, { secret: 'web-env', path: 'web/.env' }] });
  assert.deepEqual(await repoSettings.migrate(), { copied: 1, ownCopied: 0, kept: 0, none: 0, done: 0, failed: 1 });
  secrets.save = save;
  assert.deepEqual(await repoSettings.migrate(), { copied: 1, ownCopied: 0, kept: 0, none: 0, done: 1, failed: 0 });
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
async function startConsole(t, { envFiles = [], secrets: initial = memorySecrets(), people = {} } = {}) {
  const state = {
    people,
    members: {
      'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true },
      'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' },
      'ana-k': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' },
    },
  };
  const { store, secrets, config, repoSettings } = setup({ state, envFiles, secrets: initial });
  const members = createMembers({ store });
  const userSettings = createUserSettings({ store, secrets, envFiles });
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
    projectAccess: createProjectAccess({ config: fullConfig, githubFor }),
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
    { project: 'app', repo: 'acme/app', envFiles: [], instructions: false },
    { project: 'tools', repo: 'acme/tools', envFiles: ['web-env-local'], instructions: true },
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
  assert.deepEqual(repoSettingsRoute('/api/my/repos/app/instructions'), { scope: 'my', project: 'app', key: null, remove: false, instructions: true });
  assert.deepEqual(repoSettingsRoute('/api/my/repos'), { scope: 'my', project: null, key: null, remove: false, instructions: false });
  for (const path of ['/api/console-settings/projects/repos', '/api/my/repos/app/env', '/api/my/repos/app/env/a/remove', '/api/my/reposx']) assert.equal(repoSettingsRoute(path), null, path);
});

test('the old route of an env file\'s own lines is the default project\'s repo settings, in its old shape', async (t) => {
  const secrets = memorySecrets({ 'api-env': `API_URL=http://legacy\nLEGACY=${SECRET_MARK}\n`, 'users/sam-ops/api-env': `OLD=${SECRET_MARK}\n` });
  const people = { 'sam-ops': { files: { 'api-env': '2026-10-01T00:00:00.000Z' } } };
  const { call, store } = await startConsole(t, { envFiles: [{ secret: 'api-env', path: 'api/.env' }], secrets, people });
  const results = {};
  const lines = await captureLog(async () => {
    results.before = await call('sam-ops', 'GET', '/api/my/files/api-env');
    results.save = await call('sam-ops', 'POST', '/api/my/files/api-env', { text: OWN_ENV });
    results.saved = new Map(secrets.values);
    results.view = await call('sam-ops', 'GET', '/api/my/repos/app');
    await call('mia-dev', 'POST', '/api/console-settings/repos/app/env/api-env', { text: INSTALLATION_ENV });
    results.after = await call('sam-ops', 'GET', '/api/my/files/api-env');
    results.reset = await call('sam-ops', 'POST', '/api/my/files/api-env/reset', {});
    results.notText = await call('sam-ops', 'POST', '/api/my/files/api-env', {});
    results.getReset = await call('sam-ops', 'GET', '/api/my/files/api-env/reset');
    results.noHeader = await call('sam-ops', 'POST', '/api/my/files/api-env', { text: 'X=1' }, { 'x-woodshed': '0' });
    results.tmux = await call('sam-ops', 'POST', '/api/my/files/tmux-conf', { text: 'set -g mouse on\n' });
  });

  assert.equal(results.before.status, 200);
  assert.deepEqual(results.before.body, {
    key: 'api-env', label: 'api/.env', text: '', custom: false, sharedText: `API_URL=http://legacy\nLEGACY=${SECRET_MARK}\n`, editable: true,
    appended: ['PORT', 'ANTHROPIC_API_KEY', 'NODE_ENV'],
  }, 'with no installation value yet, the shared text is the Terraform secret sessions still read');
assert.equal(results.save.status, 200);
  assert.equal(results.saved.get('users/sam-ops/repos/app/env/api-env'), OWN_ENV, 'an edit the old way lands in the new name');
  assert.equal(results.saved.has('users/sam-ops/api-env'), false, 'and the old own lines go, so a session never falls back to them');
  assert.equal(store.state.people['sam-ops'].files['api-env'], null);
  assert.deepEqual(results.view.body.envFiles.find((f) => f.key === 'api-env').personal.keys, ['LOG_LEVEL', 'API_TOKEN']);
  assert.equal(results.after.body.text, OWN_ENV);
  assert.equal(results.after.body.custom, true);
  assert.equal(results.after.body.sharedText, INSTALLATION_ENV, 'the installation\'s repo settings, once there');
  assert.equal(results.reset.status, 200);
  assert.equal(results.reset.body.custom, false);
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false, 'reset clears the new name');
  assert.equal(results.notText.status, 400);
  assert.equal(results.getReset.status, 405);
  assert.equal(results.noHeader.status, 403);
  assert.equal(results.tmux.status, 200, 'tmux-conf stays My settings\' own');
  assert.equal(secrets.values.get('users/sam-ops/tmux-conf'), 'set -g mouse on\n');
  assert.deepEqual(lines.filter((line) => line.includes(SECRET_MARK)), [], 'no value in any log line');
  assert.ok(lines.some((l) => l.includes('repoSettings: old own lines route, saved to repo settings') && l.includes('sam-ops')));
  assert.ok(lines.some((l) => l.includes('repoSettings: legacy own lines removed, repo settings hold them now')));
});

test('the old route is refused to someone who cannot write to the default project, as the new one is', async () => {
  const { repoSettings, config } = setup({ envFiles: [{ secret: 'api-env', path: 'api/.env' }] });
  const { createRepoSettingsApi } = await import('./repoSettings.mjs');
  const api = createRepoSettingsApi({ repoSettings, config, projectAccess: { view: async () => ({ projects: [] }), forStart: async () => null } });
  const res = { status: 0, writeHead(code) { this.status = code; }, end() {} };
  const lines = await captureLog(() => api({ method: 'GET', resume() {} }, res, { route: legacyFileRoute('/api/my/files/api-env', config), login: 'ana-k' }));
  assert.equal(res.status, 403);
  assert.ok(lines.some((l) => l.includes('repoSettings: refused, cannot write to the repo')));
});

test('saving or clearing your own values for a legacy env file drops its old own lines, so a Clear stays cleared after a start', async () => {
  const secrets = memorySecrets({ 'users/sam-ops/api-env': 'OLD=1\n' });
  const state = { people: { 'sam-ops': { files: { 'api-env': '2026-10-01T00:00:00.000Z' } } } };
  const { store, repoSettings } = setup({ state, secrets, envFiles: [{ secret: 'api-env', path: 'api/.env' }] });
  await repoSettings.migrate();
  assert.equal(secrets.values.get('users/sam-ops/repos/app/env/api-env'), 'OLD=1\n', 'copied at start');

  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: '' });
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false);
  assert.equal(secrets.values.has('users/sam-ops/api-env'), false);
  await repoSettings.migrate();
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false, 'the next start copies nothing back');
  assert.equal(store.state.people['sam-ops'].files['api-env'], null);

  const other = setup({ secrets: memorySecrets({ 'users/sam-ops/web-env-local': 'A=1\n' }), state: { people: { 'sam-ops': { files: { 'web-env-local': 'x' } } } } });
  await other.repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'web-env-local', text: 'B=2\n' });
  assert.equal(other.secrets.values.get('users/sam-ops/web-env-local'), 'A=1\n', 'a key no Terraform pair names is left alone');
});

test('a clear that cannot drop the old own lines fails, rather than let them come back', async () => {
  const secrets = memorySecrets({ 'users/sam-ops/api-env': 'OLD=1\n' });
  const remove = secrets.remove;
  secrets.remove = async (name) => { if (name === 'users/sam-ops/api-env') throw new Error('store down'); return remove.call(secrets, name); };
  const state = { people: { 'sam-ops': { files: { 'api-env': 'x' } } } };
  const { repoSettings } = setup({ state, secrets, envFiles: [{ secret: 'api-env', path: 'api/.env' }] });
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: 'NEW=1\n' });
  assert.equal(secrets.values.get('users/sam-ops/repos/app/env/api-env'), 'NEW=1\n', 'a save goes ahead: its value is what sessions read');
  await assert.rejects(repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: '' }), /store down/);
});

test('each Terraform env file\'s secret says where it moved, and whether Repo settings hold it now', async () => {
  const secrets = memorySecrets({ 'api-env': 'A=1\n' });
  const { repoSettings } = setup({ secrets, envFiles: [{ secret: 'api-env', path: 'api/.env' }, { secret: 'web-env', path: 'web/.env.local' }] });
  await repoSettings.migrate();
  assert.deepEqual(repoSettings.legacyState('api-env'), {
    secret: 'api-env', path: 'api/.env', project: 'app', repo: 'acme/app', key: 'api-env', copiedAt: '2026-11-12T10:00:01.000Z', saved: true,
  });
  assert.equal(repoSettings.legacyState('web-env').saved, false, 'nothing to copy: sessions still read the secret');
  assert.equal(repoSettings.legacyState('anthropic-api-key'), null);
});

test('the old route names a Terraform env file only; tmux-conf and anything else stay userSettings\'', () => {
  const config = { envFiles: [{ secret: 'api-env', path: 'api/.env' }] };
  assert.deepEqual(legacyFileRoute('/api/my/files/api-env', config), { scope: 'legacy', project: null, key: 'api-env', reset: false, instructions: false, remove: false });
  assert.equal(legacyFileRoute('/api/my/files/api-env/reset', config).reset, true);
  for (const path of ['/api/my/files/tmux-conf', '/api/my/files/web-env', '/api/my/files/api-env/x']) assert.equal(legacyFileRoute(path, config), null, path);
});

test('an installation value the start copied, once cleared, stays cleared after the next starts, and sessions read the Terraform secret again', async () => {
  const secrets = memorySecrets({ 'api-env': 'API_URL=http://legacy\n' });
  const envFiles = [{ secret: 'api-env', path: 'api/.env' }];
  const { store, repoSettings } = setup({ secrets, envFiles });
  await repoSettings.migrate();
  assert.equal(secrets.values.get('repos/app/env/api-env'), 'API_URL=http://legacy\n');

  const lines = await captureLog(() => repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: '', by: 'mia-dev' }));
  assert.ok(lines.some((l) => l.includes('repoSettings: legacy copy turned off for a cleared value')));
  assert.deepEqual(Object.keys(store.state.repoSettingsMigration.cleared), ['api-env'], 'a date by name, no value');
  assert.ok(!JSON.stringify(store.state).includes('legacy'), 'no value in state.json');
  // Two more starts of the console.
  assert.deepEqual(await repoSettings.migrate(), { copied: 0, ownCopied: 0, kept: 0, none: 0, done: 1, failed: 0 });
  await repoSettings.migrate();
  assert.equal(secrets.values.has('repos/app/env/api-env'), false, 'still cleared');
  assert.equal(repoSettings.legacyState('api-env').saved, false, 'the Secrets page offers Replace again');

  // A session: the console hands out no installation value, so the env file is the Terraform secret's, with the warning.
  const settings = await repoSettings.forSession({ id: 's1', project: 'app', owner: null });
  assert.equal(settings.envFiles['api-env'], undefined);
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleared-'));
  const project = { envFiles: [{ path: 'api/.env', key: 'api-env', secret: 'api-env', defaults: [], lines: [] }] };
  const written = writeEnvFiles({ project, repoDir, env: { API_ENV: 'API_URL=http://legacy\n' }, settings: { ...settings, envFiles: {} } });
  assert.match(fs.readFileSync(path.join(repoDir, 'api/.env'), 'utf8'), /API_URL=http:\/\/legacy/);
  assert.ok(writtenLines({ written, settings, project }).some((l) => /WARNING: api\/\.env from the legacy env file secret api-env/.test(l)));
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('an installation value saved before the copy ran, then cleared, is not copied in either', async () => {
  const secrets = memorySecrets({ 'api-env': 'A=1\n' });
  const { repoSettings } = setup({ secrets, envFiles: [{ secret: 'api-env', path: 'api/.env' }] });
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: 'B=2\n', by: 'mia-dev' });
  await repoSettings.saveInstallation({ project: 'app', key: 'api-env', text: '', by: 'mia-dev' });
  await repoSettings.migrate();
  assert.equal(secrets.values.has('repos/app/env/api-env'), false);
});

test('a person\'s own value cleared after the copy stays cleared after the next start', async () => {
  const secrets = memorySecrets({ 'users/sam-ops/api-env': 'OLD=1\n' });
  const state = { people: { 'sam-ops': { files: { 'api-env': 'x' } } } };
  const { repoSettings } = setup({ state, secrets, envFiles: [{ secret: 'api-env', path: 'api/.env' }] });
  await repoSettings.migrate();
  await repoSettings.saveOwn({ login: 'sam-ops', project: 'app', key: 'api-env', text: '' });
  await repoSettings.migrate();
  assert.equal(secrets.values.has('users/sam-ops/repos/app/env/api-env'), false);
  assert.equal((await repoSettings.forSession({ id: 's2', project: 'app', owner: 'sam-ops' })).envFiles['api-env'], undefined);
});
