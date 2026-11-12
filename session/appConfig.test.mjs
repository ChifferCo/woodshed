import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { appConfig } from './appConfig.mjs';
import { loadProject } from '../shared/project.mjs';
import { fixtureApp, fixtureProject } from '../shared/projectFixture.mjs';
import { createSavedApps } from '../console/savedApps.mjs';
import { createSessionApi } from '../console/sessionApi.mjs';
import { openStore } from '../console/store.mjs';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-app-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.woodshed'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app']);
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), 'version: 1\neditor: true\n');
  const storeDir = path.join(dir, 'store');
  const store = openStore(storeDir);
  const session = { id: 'aaaaaaaa', token: 'test-token', status: 'running', repo: 'acme/app' };
  const sessions = [session, { id: 'bbbbbbbb', token: 'other-token', status: 'running', repo: 'acme/other' }];
  const config = { projects: [{ name: 'app', repo: 'acme/app', default: true }, { name: 'other', repo: 'acme/other' }] };
  const savedApps = createSavedApps({ store, config });
  const handler = createSessionApi({ fleet: { sessions: () => sessions }, savedApps });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { REPO_DIR: repo, SESSION_TOKEN: session.token, WOODSHED_CONSOLE_URL: `http://127.0.0.1:${server.address().port}`, WOODSHED_APP_CONFIG_FILE: path.join(dir, 'first.json') };
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify(fixtureApp()));
  async function request(route, body, token = session.token) {
    return fetch(`${env.WOODSHED_CONSOLE_URL}${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { dir, repo, storeDir, config, session, sessions, savedApps, env, file, request };
}

test('saving is authorized by the setup choice, scoped to the session repo, and validates app-only settings', async (t) => {
  const f = await setup(t);
  assert.equal((await f.request('/app-config', {}, 'wrong')).status, 401);
  assert.equal((await f.request('/app-config/save', { app: fixtureApp() })).status, 403);
  f.session.appSetupDestination = 'repository';
  assert.equal((await f.request('/app-config/save', { app: fixtureApp() })).status, 403);
  f.session.appSetupDestination = 'woodshed';
  assert.equal((await f.request('/app-config/save', { app: { start: 'true' } })).status, 400);
  assert.equal((await f.request('/app-config/save', { app: fixtureApp(), repo: 'acme/other' })).status, 400);
  assert.equal((await f.request('/app-config/save', { app: fixtureApp({ env: { BAD: 'value' } }) })).status, 400);
  assert.equal((await f.request('/app-config/save', { app: fixtureApp({ start: 'x'.repeat(70_000) }) })).status, 413);
  assert.equal((await f.request('/app-config/save', { app: fixtureApp() })).status, 200);
  assert.equal((await f.request('/app-config/save', { app: fixtureApp() })).status, 200, 'same save can be retried');
  assert.equal((await f.request('/app-config/save', { app: fixtureApp({ start: 'different' }) })).status, 409, 'a concurrent setup cannot replace the saved app');
  assert.equal((await (await f.request('/app-config', {}, 'other-token')).json()).app, null);
  for (const kind of ['ask', 'qa']) {
    f.session.kind = kind;
    f.session.qa = kind === 'qa' ? {} : null;
    assert.equal((await f.request('/app-config/save', { app: fixtureApp() })).status, 403);
  }
  f.session.status = 'stopped';
  assert.equal((await f.request('/app-config', {})).status, 401);
});

test('a saved app survives a console restart, reaches a fresh session, and leaves the repo untouched', async (t) => {
  const f = await setup(t);
  const before = execFileSync('git', ['-C', f.repo, 'status', '--porcelain'], { encoding: 'utf8' });
  f.session.appSetupDestination = 'woodshed';
  assert.deepEqual(await appConfig('check', f.file, { env: f.env }), { checked: true });
  await appConfig('save', f.file, { env: f.env });
  const restarted = createSavedApps({ store: openStore(f.storeDir), config: f.config });
  assert.deepEqual(restarted.read(f.session).app, fixtureApp());
  f.sessions.push({ id: 'cccccccc', status: 'running', token: 'fresh-token', repo: 'acme/app' });
  const env = { ...f.env, SESSION_TOKEN: 'fresh-token', WOODSHED_APP_CONFIG_FILE: path.join(f.dir, 'second.json') };
  await appConfig('pull', null, { env });
  const project = loadProject(f.repo, { savedAppFile: env.WOODSHED_APP_CONFIG_FILE });
  assert.equal(project.appFrom, 'woodshed');
  assert.deepEqual(project.app, fixtureApp());
  assert.equal(project.editor, true, 'other project fields are retained');
  assert.equal(execFileSync('git', ['-C', f.repo, 'status', '--porcelain'], { encoding: 'utf8' }), before);
  const own = fixtureApp({ frontendPort: 4567 });
  fs.writeFileSync(path.join(f.repo, '.woodshed/project.yaml'), fixtureProject({ app: own }));
  assert.deepEqual(loadProject(f.repo, { savedAppFile: env.WOODSHED_APP_CONFIG_FILE }).app, own, 'repository app wins');
  await assert.rejects(appConfig('save', f.file, { env }), /project already defines an app/);
  fs.writeFileSync(path.join(f.repo, '.woodshed/project.yaml'), 'version: 1\n');
  fs.writeFileSync(env.WOODSHED_APP_CONFIG_FILE, JSON.stringify({ repo: 'acme/other', app: fixtureApp() }));
  assert.equal(loadProject(f.repo, { savedAppFile: env.WOODSHED_APP_CONFIG_FILE }).app, null, 'a cache from another repo is ignored');
  await assert.rejects(appConfig('pull', null, { env: { ...env, SESSION_TOKEN: 'other-token' } }), /another repository/);
});

test('pull retries a disconnect, a proxy error and a truncated response; permanent refusals are not retried', async (t) => {
  const f = await setup(t);
  let calls = 0;
  let refuse = false;
  let unavailable = false;
  const server = http.createServer((req, res) => {
    calls++;
    if (refuse) { res.writeHead(403); res.end('{"error":"refused"}'); }
    else if (unavailable) { res.writeHead(503); res.end('unavailable'); }
    else if (calls === 1) req.socket.destroy();
    else if (calls === 2) { res.writeHead(502); res.end('<html>restarting</html>'); }
    else if (calls === 3) res.end('{"repo":');
    else res.end(JSON.stringify({ repo: 'acme/app', app: fixtureApp() }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...f.env, WOODSHED_CONSOLE_URL: `http://127.0.0.1:${server.address().port}` };
  const retry = { retryDelayMs: 1, maxAttempts: 4 };
  await appConfig('pull', null, { env, retry });
  assert.equal(calls, 4);
  assert.deepEqual(loadProject(f.repo, { savedAppFile: env.WOODSHED_APP_CONFIG_FILE }).app, fixtureApp());
  refuse = true;
  await assert.rejects(appConfig('pull', null, { env, retry }), /refused/);
  assert.equal(calls, 5, '4xx fails immediately, without retries');
  refuse = false;
  unavailable = true;
  await assert.rejects(appConfig('pull', null, { env, retry: { ...retry, maxAttempts: 2 } }), /503/);
  assert.equal(calls, 7, 'a persistent outage stops at the retry limit');
});
