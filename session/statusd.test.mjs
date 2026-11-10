import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { appState, claudeState, handleUpgrade, isAuthorized, memoryPeakMb, paneState, parseSendBody, homeArchiveArgs, homeChangedSince, lastInterruptAt, openToolCalls } from './statusd.mjs';
import { fixtureApp, fixtureProject } from '../shared/projectFixture.mjs';

const RULE = '─'.repeat(40);

test('isAuthorized refuses everything when no token is configured', () => {
  assert.equal(isAuthorized(undefined, ''), false);
  assert.equal(isAuthorized('Bearer ', ''), false);
});

test('isAuthorized requires the exact bearer token when one is configured', () => {
  assert.equal(isAuthorized('Bearer s3cret', 's3cret'), true);
  assert.equal(isAuthorized('Bearer wrong', 's3cret'), false);
  assert.equal(isAuthorized(undefined, 's3cret'), false);
  assert.equal(isAuthorized('Bearer s3cret-and-more', 's3cret'), false);
});

test('paneState reads a working claude from its footer', () => {
  assert.equal(paneState(`output\n${RULE}\n❯ \n${RULE}\n  esc to interrupt`), 'working');
});

test('paneState reads a claude sitting at its prompt as done', () => {
  assert.equal(paneState(`output\n${RULE}\n❯ \n${RULE}\n  ? for shortcuts`), 'done');
});

test('paneState reads a finished turn with a suggested prompt as done, in whichever mode', () => {
  for (const mode of ['auto mode on', 'bypass permissions on', 'accept edits on']) {
    const pane = `output\n${RULE}\n❯ rerun it but wait for the page to load first\n${RULE}\n  ⏵⏵ ${mode} (shift+tab to cycle)`;
    assert.equal(paneState(pane), 'done', mode);
  }
});

test('paneState still reads a working turn in auto mode as working', () => {
  const pane = `output\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt`;
  assert.equal(paneState(pane), 'working');
});

test('paneState reads a bare shell as not-running', () => {
  assert.equal(paneState('node@task:/work/app$ '), 'not-running');
  assert.equal(paneState(''), 'not-running');
});

// Records as Claude Code 2.1.311 wrote them. The api-request-blob repeats the text and is not the interrupt.
const INTERRUPT_MID_TURN = '{"type":"user","timestamp":"2026-10-27T10:45:50.591Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}';
const INTERRUPT_ON_DIALOG = '{"type":"user","timestamp":"2026-10-27T10:47:12.366Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}';
const REQUEST_BLOB = '{"type":"api-request-blob","timestamp":null,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]\\n"}]}}';
const OPEN_PANE = `output\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;

const T = Date.parse('2026-10-27T10:46:22.176Z');

// Every call reads the same session a minute after its last hook, unless a test says otherwise.
function state(overrides) {
  return claudeState({
    paneText: OPEN_PANE, hook: null, interruptedAt: null, transcriptAt: T, openTools: 0, now: T + 60_000, startedAt: T - 10 * 60_000,
    ...overrides,
  });
}

function rec(type, content) {
  return JSON.stringify({ type, message: { role: type, content } });
}

test('openToolCalls counts the calls since the last prompt that have no result yet', () => {
  // A parallel batch: a quick Read came back, a long npm test did not.
  const batch = [
    rec('user', 'run the tests'),
    rec('assistant', [{ type: 'tool_use', id: 'read' }, { type: 'tool_use', id: 'test' }]),
    rec('user', [{ type: 'tool_result', tool_use_id: 'read' }]),
  ];
  const whole = { partial: false };
  assert.equal(openToolCalls(batch.join('\n'), whole), 1);
  assert.equal(openToolCalls([...batch, rec('user', [{ type: 'tool_result', tool_use_id: 'test' }])].join('\n'), whole), 0);
  // A call left open before the last prompt does not count.
  assert.equal(openToolCalls([rec('assistant', [{ type: 'tool_use', id: 'old' }]), rec('user', 'next')].join('\n'), whole), 0);
  // The quick call's large result filled the tail, so the long call beside it, and the prompt, are cut off.
  assert.equal(openToolCalls(batch.slice(2).join('\n'), { partial: true }), null);
  assert.equal(openToolCalls(batch.join('\n'), { partial: true }), 1);
});

test('lastInterruptAt finds the last Esc, mid-turn or on a dialog', () => {
  assert.equal(lastInterruptAt([INTERRUPT_MID_TURN, REQUEST_BLOB].join('\n')), Date.parse('2026-10-27T10:45:50.591Z'));
  assert.equal(lastInterruptAt([INTERRUPT_MID_TURN, INTERRUPT_ON_DIALOG].join('\n')), Date.parse('2026-10-27T10:47:12.366Z'));
  assert.equal(lastInterruptAt(REQUEST_BLOB), null);
});

test('claudeState reads the hooks, whatever the pane draws', () => {
  // The pane has no "esc to interrupt", which is how every working session read as done.
  assert.deepEqual(state({ hook: { state: 'working', event: 'UserPromptSubmit', at: T } }), { state: 'working', source: 'hook' });
  assert.deepEqual(state({ hook: { state: 'needs-you', event: 'PermissionRequest', at: T } }), { state: 'needs-you', source: 'hook' });
});

test('claudeState reads an Esc after the last hook as done, and a new prompt after it as working', () => {
  // Esc fires no hook, so without the transcript a cut-short turn would read as working, or needs-you, for good.
  const interruptedAt = Date.parse('2026-10-27T10:47:12.366Z');
  const before = { state: 'needs-you', event: 'PermissionRequest', at: interruptedAt - 7000 };
  assert.deepEqual(state({ hook: before, interruptedAt }), { state: 'done', source: 'interrupt' });
  const after = { state: 'working', event: 'PreToolUse', at: interruptedAt + 5000 };
  assert.deepEqual(state({ hook: after, interruptedAt }), { state: 'working', source: 'hook' });
});

test('claudeState reads a prompt or a tool result that went silent as done, but not a long tool call', () => {
  // Esc before the first word of a reply: the prompt or the tool result is written, then nothing, and no interrupt
  // record.
  for (const event of ['UserPromptSubmit', 'PostToolUse']) {
    const hook = { state: 'working', event, at: T };
    assert.deepEqual(state({ hook, transcriptAt: T + 1000, now: T + 4 * 60_000 }), { state: 'working', source: 'hook' }, event);
    assert.deepEqual(state({ hook, transcriptAt: T + 1000, now: T + 7 * 60_000 }), { state: 'done', source: 'silent' }, event);
  }
  // The quick call of a parallel batch finished last, and the long one still runs.
  const quick = { state: 'working', event: 'PostToolUse', at: T };
  assert.deepEqual(state({ hook: quick, openTools: 1, transcriptAt: T, now: T + 30 * 60_000 }), { state: 'working', source: 'hook' });
  assert.deepEqual(state({ hook: quick, openTools: null, transcriptAt: T, now: T + 30 * 60_000 }), { state: 'working', source: 'hook' });
  const tool = { state: 'working', event: 'PreToolUse', at: T };
  assert.deepEqual(state({ hook: tool, transcriptAt: T, now: T + 30 * 60_000 }), { state: 'working', source: 'hook' });
});

test('claudeState reads a claude still opening as starting, then as exited if it never opens', () => {
  // In a real session claude opened 16 s after statusd, and until then the console showed "Waiting for input".
  const shell = 'node@task:/work/app$ ';
  assert.deepEqual(state({ paneText: shell, now: T + 16_000, startedAt: T }), { state: 'starting', source: 'pane' });
  assert.deepEqual(state({ paneText: shell, now: T + 3 * 60_000, startedAt: T }), { state: 'not-running', source: 'pane' });
  const hook = { state: 'done', event: 'Stop', at: T + 10_000 };
  assert.deepEqual(state({ paneText: shell, hook, now: T + 16_000, startedAt: T }), { state: 'not-running', source: 'pane' });
});

test('claudeState falls back to the pane before a hook fires, and when claude has exited', () => {
  assert.deepEqual(state({}), { state: 'done', source: 'pane' });
  const hook = { state: 'working', event: 'PreToolUse', at: T };
  assert.deepEqual(state({ paneText: 'node@task:/work/app$ ', hook }), { state: 'not-running', source: 'pane' });
});

test('parseSendBody returns the text', () => {
  assert.equal(parseSendBody('{"text":"plan approved"}'), 'plan approved');
});

test('parseSendBody rejects bodies that are not JSON or have no text', () => {
  assert.throws(() => parseSendBody('plan approved'), /JSON/);
  assert.throws(() => parseSendBody('{"text":"  "}'), /non-empty/);
  assert.throws(() => parseSendBody('{"text":42}'), /non-empty/);
});

test('parseSendBody rejects text over the limit', () => {
  assert.throws(() => parseSendBody(JSON.stringify({ text: 'x'.repeat(8001) })), /at most/);
});

test('memoryPeakMb reads the first cgroup file that reports a peak', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-'));
  const v1 = path.join(dir, 'memory.max_usage_in_bytes');
  await fs.writeFile(v1, `${3 * 1024 * 1024 * 1024}\n`);
  assert.equal(await memoryPeakMb([path.join(dir, 'memory.peak'), v1]), 3072);
  assert.equal(await memoryPeakMb([path.join(dir, 'missing')]), null);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('statusd forwards the Redis, Postgres, Mongo and editor paths with the token checked and dropped', async (t) => {
  let seen;
  const viewer = http.createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization };
    res.end('viewer');
  });
  const viewerPort = await listen(viewer);
  const port = await freePort();
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-viewers-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, '.woodshed'));
  await fs.writeFile(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ env: { REDIS_URL: 'redis://127.0.0.1:6379' }, editor: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./statusd.mjs', import.meta.url))], {
    env: {
      ...process.env, SESSION_TOKEN: 'sess', STATUSD_PORT: String(port), REPO_DIR: repo, REDIS_VIEWER_PORT: String(viewerPort),
      PG_VIEWER_PORT: String(viewerPort), MONGO_VIEWER_PORT: String(viewerPort), MONGO_COPY_VIEWER_PORT: String(viewerPort),
      CODE_EDITOR_PORT: String(viewerPort),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => { child.kill(); viewer.close(); });
  await new Promise((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); }));

  const url = `http://127.0.0.1:${port}/redis/0a1b2c3d/apiv2/server/info`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(seen, undefined);
  const res = await fetch(url, { headers: { authorization: 'Bearer sess' } });
  assert.equal(await res.text(), 'viewer');
  assert.deepEqual(seen, { url: '/redis/0a1b2c3d/apiv2/server/info', authorization: undefined });
  for (const path of ['/pg/0a1b2c3d/api/objects', '/mongo/0a1b2c3d/db/woodshed_mia/', '/mongo-copy/0a1b2c3d/db/woodshed_mia__restore/', '/__woodshed/code/']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401, path);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: 'Bearer sess' } })).text(), 'viewer');
    assert.deepEqual(seen, { url: path, authorization: undefined });
  }

  await new Promise((resolve) => viewer.close(resolve));
  const down = await fetch(url, { headers: { authorization: 'Bearer sess' } });
  assert.deepEqual([down.status, await down.json()], [502, { error: 'the Redis viewer is not running' }]);
  const pgDown = await fetch(`http://127.0.0.1:${port}/pg/0a1b2c3d/`, { headers: { authorization: 'Bearer sess' } });
  assert.deepEqual(await pgDown.json(), { error: 'the Postgres viewer is not running' });
});

const UP = { frontend: true, backend: true };
const DOWN = { frontend: false, backend: false };

test('appState: both servers up is running, whoever started them; otherwise the last start decides', () => {
  assert.equal(appState(UP, null), 'running');
  assert.equal(appState(UP, { exitCode: 1 }), 'running');
  assert.equal(appState(UP, { exitCode: null }), 'running', 'up before the start script has finished');
  assert.equal(appState(DOWN, { exitCode: null }), 'starting');
  assert.equal(appState(DOWN, { exitCode: 1 }), 'failed');
  assert.equal(appState(DOWN, { exitCode: 0 }), 'stopped', 'started, then stopped since');
  assert.equal(appState(DOWN, null), 'stopped');
});

test('appState: half an app says which half is down, after the shed', () => {
  assert.equal(appState({ frontend: true, backend: false }, null), 'api-down');
  assert.equal(appState({ frontend: false, backend: true }, null), 'frontend-down');
  assert.equal(appState({ frontend: false, backend: true }, { exitCode: null }), 'starting', 'the frontend compiles after the backend is healthy');
});

test('appState: a stop in progress outranks everything, and a start it interrupted is not a failure', () => {
  assert.equal(appState(UP, { exitCode: null }, { exitCode: null }), 'stopping');
  assert.equal(appState(DOWN, { exitCode: 143, stopped: true }, { exitCode: 0 }), 'stopped');
  assert.equal(appState(UP, null, { exitCode: 0 }), 'running', 'servers the stop did not own still answer');
});

// statusd against a checkout whose project file's app runs a serve.sh that records what it was asked and, for
// start, never finishes. Without `app`, the checkout has no project file. `project` sets other fields, and `env` statusd's.
async function statusdWithApp(t, { app = true, project = {}, env = {} } = {}) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-app-'));
  const calls = path.join(repo, 'calls');
  await fs.mkdir(path.join(repo, 'scripts'));
  await fs.writeFile(path.join(repo, 'scripts/serve.sh'),
    `echo "$1" >> '${calls}'\nif [ "$1" = start ]; then exec sleep 60; fi\n`);
  if (app) {
    await fs.mkdir(path.join(repo, '.woodshed'));
    await fs.writeFile(path.join(repo, '.woodshed/project.yaml'),
      fixtureProject({ app: fixtureApp({ start: 'bash scripts/serve.sh start', stop: 'bash scripts/serve.sh stop' }), ...project }));
  }
  // /status reads the branch and head, so the checkout has to be a repository with a commit.
  const git = (...args) => promisify(execFile)('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  await git('init', '-q', '-b', 'woodshed/test');
  await git('commit', '-q', '--allow-empty', '-m', 'init');
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./statusd.mjs', import.meta.url))], {
    env: { ...process.env, SESSION_TOKEN: 'sess', STATUSD_PORT: String(port), REPO_DIR: repo, APP_PORT: String(await freePort()), APP_API_PORT: String(await freePort()), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); }));
  const call = (method, route, token = 'sess') => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { repo, git, call, calls: async () => (await fs.readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}

test('statusd probes and reports the project file\'s own ports, and none with no app', async (t) => {
  const [frontendPort, backendPort] = [await freePort(), await freePort()];
  const project = { app: fixtureApp({ start: 'true', frontendPort, backendPort }) };
  const { call } = await statusdWithApp(t, { project, env: { APP_PORT: '', APP_API_PORT: '' } });
  assert.deepEqual((await call('GET', '/status')).body.appServers, { frontend: false, backend: false, frontendPort, backendPort });

  const server = net.createServer().listen(frontendPort, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  assert.equal((await call('GET', '/status')).body.appServers.frontend, true);

  const none = await statusdWithApp(t, { app: false, env: { APP_PORT: '', APP_API_PORT: '' } });
  assert.deepEqual((await none.call('GET', '/status')).body.appServers, { frontend: false, backend: false, frontendPort: null, backendPort: null });
});

test('statusd stops the app with the token only, a start still waiting on its health checks included', async (t) => {
  const { call, calls } = await statusdWithApp(t);
  assert.equal((await call('POST', '/app/stop', 'wrong')).status, 401);
  assert.deepEqual(await calls(), []);

  assert.deepEqual((await call('POST', '/app/start')).body, { started: true, app: 'starting' });
  const during = (await call('GET', '/status')).body;
  assert.deepEqual([during.app, during.appServers.frontend, during.appServers.backend], ['starting', false, false]);

  assert.deepEqual((await call('POST', '/app/stop')).body, { stopping: true, app: 'stopping' });
  let after;
  for (let i = 0; i < 50; i++) {
    after = (await call('GET', '/status')).body.app;
    if (after !== 'stopping') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(after, 'stopped', 'the interrupted start does not read as failed');
  assert.deepEqual(await calls(), ['start', 'stop']);
  assert.equal((await call('POST', '/app/start')).body.started, true, 'a new start is allowed once the stop is done');
});

test('GET /diff answers the checkout against master with the token only, uncommitted work included', async (t) => {
  const { repo, git, call } = await statusdWithApp(t, { app: false, env: { DEFAULT_BRANCH: 'master' } });
  // The checkout's first commit stands for master; no origin answers the fetch, so the one it has is used.
  await git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  await fs.writeFile(path.join(repo, 'new.txt'), 'hello\n');

  assert.equal((await call('GET', '/diff', 'wrong')).status, 401);
  const { status, body } = await call('GET', '/diff');
  assert.equal(status, 200);
  assert.equal(body.base, 'master');
  assert.equal(body.baseFetched, false);
  assert.equal(body.uncommitted, true);
  assert.deepEqual(body.files.map((f) => [f.path, f.status, f.additions]), [['new.txt', 'added', 1], ['scripts/serve.sh', 'added', 2]]);
  assert.equal(body.files[0].patch, '@@ -0,0 +1 @@\n+hello');
  assert.equal((await git('status', '--porcelain')).stdout.includes('A '), false, 'nothing was staged');
});

test('a project with no app never runs a start or a stop', async (t) => {
  const { call, calls } = await statusdWithApp(t, { app: false });
  assert.deepEqual((await call('POST', '/app/start')).body, { started: false, app: 'stopped' });
  assert.deepEqual((await call('POST', '/app/stop')).body, { stopping: false, app: 'stopped' });
  assert.deepEqual(await calls(), []);
});

test('Redis is offered only when the project uses REDIS_URL, as the entrypoint starts it', async (t) => {
  const uses = await statusdWithApp(t, { project: { env: { REDIS_URL: 'redis://127.0.0.1:6379' } } });
  assert.equal((await uses.call('GET', '/status')).body.redis, true);
  const none = await statusdWithApp(t);
  assert.equal((await none.call('GET', '/status')).body.redis, false);
  assert.deepEqual(await none.call('GET', '/redis/0a1b2c3d/'), { status: 404, body: { error: 'this session has no Redis: its project uses none' } });
  const ask = await statusdWithApp(t, { project: { env: { REDIS_URL: 'redis://127.0.0.1:6379' } }, env: { SESSION_MODE: 'ask' } });
  assert.equal((await ask.call('GET', '/status')).body.redis, false, 'a question from Slack starts no Redis');
});

test('the editor is offered when the project file turns it on and the image has it, and refused when it is off', async (t) => {
  const on = await statusdWithApp(t, { project: { editor: true }, env: { CODE_EDITOR_BIN: process.execPath } });
  assert.equal((await on.call('GET', '/status')).body.editor, true);
  const notInImage = await statusdWithApp(t, { project: { editor: true }, env: { CODE_EDITOR_BIN: '/nonexistent/openvscode-server' } });
  assert.equal((await notInImage.call('GET', '/status')).body.editor, false, 'an image built with the editor left out');
  const off = await statusdWithApp(t, { project: { editor: false }, env: { CODE_EDITOR_BIN: process.execPath } });
  const leftOut = await statusdWithApp(t, { app: false, env: { CODE_EDITOR_BIN: process.execPath } });
  assert.equal((await leftOut.call('GET', '/status')).body.editor, false, 'a repo with no project file, or one without the field');
  assert.equal((await off.call('GET', '/status')).body.editor, false);
  assert.deepEqual(await off.call('GET', '/__woodshed/code/'), { status: 404, body: { error: 'the project file turns the editor off' } });
});

// A raw HTTP upgrade through handleUpgrade to a stand-in frontend that answers 101 and echoes.
function upgradeThrough({ token, headers }) {
  return new Promise((resolve, reject) => {
    const app = net.createServer((socket) => {
      socket.once('data', (request) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        const seen = String(request);
        socket.write(`saw:${/x-woodshed-app:/i.test(seen) ? 'token' : 'no-token'},${/authorization: Bearer app-token/i.test(seen) ? 'app-auth' : 'no-app-auth'}`);
        socket.pipe(socket);
      });
    });
    app.listen(0, '127.0.0.1', () => {
      const proxy = http.createServer();
      proxy.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, { token: 'tok', port: app.address().port }));
      proxy.listen(0, '127.0.0.1', () => {
        const client = net.connect(proxy.address().port, '127.0.0.1', () => {
          const lines = ['GET /_next/webpack-hmr HTTP/1.1', 'Host: 0a1b2c3d.woodshed.example', 'Upgrade: websocket', 'Connection: Upgrade',
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
          client.write(`${lines.join('\r\n')}\r\n\r\n`);
        });
        let got = '';
        let pinged = false;
        client.on('data', (chunk) => {
          got += chunk;
          if (!pinged && /saw:\S/.test(got)) {
            pinged = true;
            client.write('ping');
          }
          if (got.includes('ping') || got.startsWith('HTTP/1.1 401')) client.end();
        });
        client.on('close', () => {
          proxy.close();
          app.close();
          resolve(got);
        });
        client.on('error', reject);
      });
    });
  });
}

test('handleUpgrade passes an app websocket through without the session token, and refuses one without it', async () => {
  const through = await upgradeThrough({ token: 'tok', headers: { 'x-woodshed-app': 'Bearer tok', authorization: 'Bearer app-token' } });
  assert.match(through, /^HTTP\/1\.1 101/);
  assert.match(through, /saw:no-token,app-auth/, 'the session token never reaches the app; the app keeps its own Authorization');
  assert.match(through, /ping/, 'bytes flow both ways');
  assert.match(await upgradeThrough({ token: 'tok', headers: { 'x-woodshed-app': 'Bearer wrong' } }), /^HTTP\/1\.1 401/);
  assert.match(await upgradeThrough({ token: 'tok', headers: { authorization: 'Bearer tok' } }), /^HTTP\/1\.1 401/, 'the statusd token in Authorization does not open the app');
});

test('the Claude home archive leaves caches out and keeps logins, memory, transcripts and plugins', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await mkdtemp(path.join(os.tmpdir(), 'woodshed-home-'));
  for (const dir of ['.claude/projects/-work-app', '.claude/statsig', '.claude/plugins/cache/x', '.claude/shell-snapshots']) await mkdir(path.join(home, dir), { recursive: true });
  await writeFile(path.join(home, '.claude/projects/-work-app/abc.jsonl'), '{}');
  await writeFile(path.join(home, '.claude/.credentials.json'), '{}');
  await writeFile(path.join(home, '.claude/statsig/cache'), 'x');
  await writeFile(path.join(home, '.claude/plugins/cache/x/plugin.json'), '{}');
  await writeFile(path.join(home, '.claude.json'), '{}');
  const archive = path.join(home, 'out.tgz');
  const args = homeArchiveArgs(home, ['.claude', '.claude.json']);
  execFileSync('tar', args, { stdio: ['ignore', (await import('node:fs')).openSync(archive, 'w'), 'inherit'] });
  const listed = execFileSync('tar', ['tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(listed.includes('.claude/.credentials.json'));
  assert.ok(listed.includes('.claude/projects/-work-app/abc.jsonl'));
  assert.ok(listed.includes('.claude.json'));
  assert.ok(listed.includes('.claude/plugins/cache/x/plugin.json'), 'a plugin\'s files, so a Resume need not fetch it again');
  assert.ok(!listed.some((f) => /statsig|shell-snapshots/.test(f)), listed.join(' '));
});

test('homeChangedSince sees a new, changed or deleted file it would save, and nothing in the caches it leaves out', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-home-'));
  const old = new Date(Date.now() - 60 * 60_000);
  const files = ['.claude/projects/-work-app/abc.jsonl', '.claude/.credentials.json', '.claude/statsig/cache', '.claude.json'];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await fs.writeFile(path.join(home, file), '{}');
  }
  async function age() {
    for (const file of files) await fs.utimes(path.join(home, file), old, old).catch(() => {});
    for (const dir of ['.claude', '.claude/projects', '.claude/projects/-work-app', '.claude/statsig']) await fs.utimes(path.join(home, dir), old, old);
  }
  await age();
  const since = Date.now() - 60_000;
  assert.equal(await homeChangedSince(home, since), false, 'a restored home, untouched');

  await fs.writeFile(path.join(home, '.claude/statsig/cache'), 'new');
  await fs.utimes(path.join(home, '.claude/statsig'), old, old);
  assert.equal(await homeChangedSince(home, since), false, 'only a cache it leaves out changed');

  await fs.appendFile(path.join(home, '.claude/projects/-work-app/abc.jsonl'), '\n{}');
  assert.equal(await homeChangedSince(home, since), true, 'a transcript grew');
  await age();

  await fs.rm(path.join(home, '.claude/.credentials.json'));
  assert.equal(await homeChangedSince(home, since), true, 'a login was removed');
  await age();

  await fs.writeFile(path.join(home, '.claude.json'), '{"x":1}');
  assert.equal(await homeChangedSince(home, since), true, '.claude.json changed');

  assert.equal(await homeChangedSince(path.join(home, 'nobody'), since), false, 'no home at all');
});

// A raw upgrade through handleUpgrade to a stand-in editor that answers 101 and says what it was sent.
function editorUpgrade(headers, { editorOn = true } = {}) {
  return new Promise((resolve, reject) => {
    const editor = net.createServer((socket) => {
      socket.once('data', (request) => {
        const seen = String(request);
        socket.end(`HTTP/1.1 101 Switching Protocols\r\n\r\nsaw:${seen.split('\r\n')[0]}|${/authorization:/i.test(seen) ? 'token' : 'no-token'}`);
      });
    });
    editor.listen(0, '127.0.0.1', () => {
      const proxy = http.createServer();
      proxy.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, { token: 'tok', port: 1, editorPort: editor.address().port, editorOn }));
      proxy.listen(0, '127.0.0.1', () => {
        const client = net.connect(proxy.address().port, '127.0.0.1', () => {
          const lines = ['GET /__woodshed/code/?reconnectionToken=r HTTP/1.1', 'Host: statusd', 'Upgrade: websocket', 'Connection: Upgrade',
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
          client.write(`${lines.join('\r\n')}\r\n\r\n`);
        });
        let got = '';
        client.on('data', (chunk) => { got += chunk; });
        client.on('close', () => { proxy.close(); editor.close(); resolve(got); });
        client.on('error', reject);
      });
    });
  });
}

test('handleUpgrade passes the editor\'s websocket through with the statusd token checked and dropped', async () => {
  assert.match(await editorUpgrade({ authorization: 'Bearer tok' }), /saw:GET \/__woodshed\/code\/\?reconnectionToken=r HTTP\/1\.1\|no-token/);
  assert.match(await editorUpgrade({ authorization: 'Bearer wrong' }), /^HTTP\/1\.1 401/);
  assert.match(await editorUpgrade({}), /^HTTP\/1\.1 401/);
  assert.match(await editorUpgrade({ authorization: 'Bearer tok' }, { editorOn: false }), /^HTTP\/1\.1 404/, 'the project file turns it off');
});
