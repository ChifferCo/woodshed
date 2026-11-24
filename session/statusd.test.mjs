import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isolatedEnv } from '../test/isolatedEnv.mjs';
import { AGENT_PANE_FORMAT, sendNotAfter, sendWithinMs, stillThePull, appState, branchPullsQuery, createBranchPulls, createPrLookup, githubRepoOf, isAgentCommand, prLookupKey, sendAgentOnly, claudeState, handleUpgrade, isAuthorized, memoryPeakMb, paneState, parseAnswerBody, parseSendBody, pickApp, homeArchiveArgs, homeChangedSince, lastInterruptAt, openToolCalls, typingError, typingSteps, typeableText } from './statusd.mjs';
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

test('paneState reads a finished turn with a suggested prompt as done, in whichever mode', async () => {
  for (const mode of ['auto mode on', 'bypass permissions on', 'accept edits on']) {
    const pane = `output\n${RULE}\n❯ rerun it but wait for the page to load first\n${RULE}\n  ⏵⏵ ${mode} (shift+tab to cycle)`;
    assert.equal(paneState(pane), 'done', mode);
  }
  // Captured live from claude 2.1.328 started with --permission-mode default: its footer says manual mode, and the
  // greyed suggestion fills the composer. Read as not-running, the Chat tab said `Claude exited`.
  const manual = await fs.readFile(new URL('../shared/__fixtures__/pane-done-manual-mode.txt', import.meta.url), 'utf8');
  assert.equal(paneState(manual), 'done');
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
      ...isolatedEnv(), SESSION_TOKEN: 'sess', STATUSD_PORT: String(port), REPO_DIR: repo, REDIS_VIEWER_PORT: String(viewerPort),
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
  assert.equal(appState(UP, { exitCode: null }, null, { hasApp: false }), 'none', 'no app in the project file: nothing to start');
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
    env: { ...isolatedEnv(), SESSION_TOKEN: 'sess', STATUSD_PORT: String(port), REPO_DIR: repo, APP_PORT: String(await freePort()), APP_API_PORT: String(await freePort()), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); }));
  const call = (method, route, token = 'sess', body = undefined, headers = null) => fetch(`http://127.0.0.1:${port}${route}`, {
    method, body, headers: headers ?? { authorization: `Bearer ${token}` },
  }).then(async (r) => {
    const text = await r.text();
    return headers ? { status: r.status, text } : { status: r.status, body: JSON.parse(text) };
  });
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

test('pickApp: the app a name picks, the default with none, and an error naming the apps for any other', () => {
  const apps = [{ name: 'web' }, { name: 'admin' }];
  assert.equal(pickApp(apps, undefined), apps[0]);
  assert.equal(pickApp(apps, ''), apps[0]);
  assert.equal(pickApp(apps, 'admin'), apps[1]);
  assert.throws(() => pickApp(apps, 'mobile'), (err) => err.status === 400 && /no app named "mobile": the project's apps are web, admin/.test(err.message));
  assert.throws(() => pickApp(apps, 3), (err) => err.status === 400);
});

// Two apps that each serve their own name on their own two ports, as a real app's servers would, and log that they did.
const SERVE = `import fs from 'node:fs';
import http from 'node:http';
const [name, log, ...ports] = process.argv.slice(2);
fs.writeFileSync(\`pids/\${name}.pid\`, String(process.pid));
for (const port of ports) http.createServer((req, res) => res.end(\`\${name} on \${port}\`)).listen(Number(port), '127.0.0.1');
fs.appendFileSync(log, \`\${name} listening\\n\`);
process.on('SIGTERM', () => process.exit(0));
`;

test('with several apps, one runs at a time: starting another stops the first, and Open app and the logs follow it', async (t) => {
  const [webPort, adminPort, apiPort] = [await freePort(), await freePort(), await freePort()];
  const one = (name, frontendPort) => ({
    name, label: name === 'web' ? 'Web app' : null, ...fixtureApp({
      start: `echo start ${name} >> calls && exec node scripts/serve.mjs ${name} logs/${name}.log ${frontendPort} ${apiPort}`,
      stop: `echo stop ${name} >> calls && kill $(cat pids/${name}.pid)`, frontendPort, backendPort: apiPort, logs: { [name]: `logs/${name}.log` },
    }),
  });
  const project = { app: null, apps: [one('web', webPort), one('admin', adminPort)] };
  const { repo, call } = await statusdWithApp(t, { project, env: { APP_PORT: '', APP_API_PORT: '' } });
  await fs.writeFile(path.join(repo, 'scripts/serve.mjs'), SERVE);
  await fs.mkdir(path.join(repo, 'pids'));
  await fs.mkdir(path.join(repo, 'logs'));
  t.after(async () => {
    for (const name of ['web', 'admin']) {
      const pid = Number(await fs.readFile(path.join(repo, `pids/${name}.pid`), 'utf8').catch(() => ''));
      if (pid) try { process.kill(pid); } catch {}
    }
  });
  const start = (app) => call('POST', '/app/start', 'sess', app === undefined ? undefined : JSON.stringify({ app }));
  const until = async (want) => {
    let body;
    for (let i = 0; i < 100; i++) {
      body = (await call('GET', '/status')).body;
      if (want(body)) return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`never reached: ${JSON.stringify({ app: body.app, appName: body.appName })}`);
  };
  const opened = () => call('GET', '/', null, undefined, { 'x-woodshed-app': 'Bearer sess' });

  // Before a start, the default is the one statusd would run, and the list is the project's.
  const before = (await call('GET', '/status')).body;
  assert.deepEqual([before.appName, before.apps, before.app], ['web', [{ name: 'web', label: 'Web app' }, { name: 'admin', label: 'admin' }], 'stopped']);
  assert.deepEqual((await start('mobile')), { status: 400, body: { error: 'no app named "mobile": the project\'s apps are web, admin' } });

  assert.equal((await start()).body.started, true, 'no name starts the default');
  let now = await until((b) => b.app === 'running');
  assert.deepEqual([now.appName, now.appServers.frontendPort], ['web', webPort]);
  assert.equal((await opened()).text, `web on ${webPort}`);
  assert.deepEqual((await call('GET', '/applog')).body.logs.map((l) => l.name), ['start', 'web']);

  assert.equal((await start('admin')).body.started, true);
  now = await until((b) => b.app === 'running' && b.appName === 'admin');
  assert.equal(now.appServers.frontendPort, adminPort);
  assert.equal((await opened()).text, `admin on ${adminPort}`, 'Open app goes to the app that runs now');
  assert.equal(await listeningOn(webPort), false, 'the web app was stopped first');
  const logs = (await call('GET', '/applog')).body.logs;
  assert.deepEqual(logs.map((l) => l.name), ['start', 'admin'], 'the App log follows the running app');
  assert.match(logs[0].text, /# Woodshed: starting web\n[\s\S]*# Woodshed: starting admin\n/);
  assert.equal(logs[1].text, 'admin listening\n');
  assert.deepEqual((await fs.readFile(path.join(repo, 'calls'), 'utf8')).trim().split('\n'), ['start web', 'stop web', 'start admin']);

  assert.equal((await start('web')).body.started, true, 'and back');
  now = await until((b) => b.app === 'running' && b.appName === 'web');
  assert.equal((await opened()).text, `web on ${webPort}`);
  assert.equal(await listeningOn(adminPort), false);
});

test('Stop app while a switch waits on the running app\'s stop keeps the next one from starting', async (t) => {
  const slowStop = (name) => ({ name, ...fixtureApp({ start: `echo start ${name} >> calls`, stop: `echo stop ${name} >> calls; sleep 1` }) });
  // The next app has no stop of its own: Stop app still cancels the switch.
  const project = { app: null, apps: [slowStop('web'), { ...slowStop('admin'), stop: null }] };
  const { repo, call } = await statusdWithApp(t, { project });
  assert.equal((await call('POST', '/app/start')).body.started, true);
  for (let i = 0; i < 50 && (await call('GET', '/status')).body.app === 'starting'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await call('POST', '/app/start', 'sess', JSON.stringify({ app: 'admin' }))).body, { started: true, app: 'stopping' });
  assert.deepEqual((await call('POST', '/app/stop')).body, { stopping: false, app: 'stopping' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual((await fs.readFile(path.join(repo, 'calls'), 'utf8')).trim().split('\n'), ['start web', 'stop web']);
  assert.equal((await call('GET', '/status')).body.appName, 'admin', 'the pick is kept: Start app starts it');
});

// Two apps on their own frontend ports and one shared backend, with servers the test starts itself, as claude would from
// a shell. The checkout's start command only records that it ran.
async function statusdWithTwoApps(t, { apps = ['web', 'admin'], shareFrontend = false } = {}) {
  const [webPort, adminPort, extraPort, apiPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const ports = { web: webPort, admin: shareFrontend ? webPort : adminPort, extra: extraPort };
  const one = (name) => ({ name, ...fixtureApp({ start: `echo start ${name} >> calls; sleep 60`, stop: null, frontendPort: ports[name], backendPort: apiPort }) });
  const { call, calls } = await statusdWithApp(t, { project: { app: null, apps: apps.map(one) }, env: { APP_PORT: '', APP_API_PORT: '' } });
  const listen = async (port) => {
    const server = net.createServer().listen(port, '127.0.0.1');
    t.after(() => server.close());
    await new Promise((resolve) => server.once('listening', resolve));
  };
  return { call, calls, ports, listen };
}

test('with the default app down and another app\'s frontend listening, statusd follows that app', async (t) => {
  const { call, ports, listen } = await statusdWithTwoApps(t);
  assert.equal((await call('GET', '/status')).body.appName, 'web', 'nothing listens: the default stays');
  await listen(ports.admin);
  const body = (await call('GET', '/status')).body;
  assert.deepEqual([body.appName, body.appServers.frontendPort, body.appServers.frontend], ['admin', ports.admin, true]);
  assert.equal((await call('GET', '/status')).body.appName, 'admin', 'and it is kept');
});

test('statusd keeps the app when several others listen, or when the port is shared with the current one', async (t) => {
  const many = await statusdWithTwoApps(t, { apps: ['web', 'admin', 'extra'] });
  await many.listen(many.ports.admin);
  await many.listen(many.ports.extra);
  assert.equal((await many.call('GET', '/status')).body.appName, 'web');

  const shared = await statusdWithTwoApps(t, { shareFrontend: true });
  await shared.listen(shared.ports.web);
  assert.equal((await shared.call('GET', '/status')).body.appName, 'web');
});

test('statusd keeps the app while a Start app of its own is going', async (t) => {
  const { call, ports, listen } = await statusdWithTwoApps(t);
  await listen(ports.admin);
  assert.equal((await call('POST', '/app/start')).body.started, true);
  const body = (await call('GET', '/status')).body;
  assert.deepEqual([body.appName, body.app], ['web', 'starting']);
});

test('with one app, statusd never looks elsewhere', async (t) => {
  const { call, ports, listen } = await statusdWithTwoApps(t, { apps: ['web'] });
  await listen(ports.admin);
  const body = (await call('GET', '/status')).body;
  assert.deepEqual([body.appName, body.appServers.frontend], ['web', false]);
});

function listeningOn(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

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

test('GET /transcript answers the newest entries of claude\'s transcript for the repo, with the token only', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { repo, call } = await statusdWithApp(t, { app: false, env: { HOME: home } });
  const dir = path.join(home, '.claude', 'projects', repo.replace(/[/.]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  const turn = (type, text) => JSON.stringify({ type, message: { role: type, content: [{ type: 'text', text }] } });
  await fs.writeFile(path.join(dir, 'abc.jsonl'), [turn('user', 'Fix it'), turn('assistant', 'Fixed.')].join('\n'));

  assert.equal((await call('GET', '/transcript', 'wrong')).status, 401);
  const { status, body } = await call('GET', '/transcript?limit=1');
  assert.equal(status, 200);
  assert.equal(body.agent, 'claude');
  assert.deepEqual(body.entries, [{ role: 'assistant', text: 'Fixed.', at: null }]);
  assert.equal(body.partial, true);
});

test('a project with no app says none, and never runs a start or a stop', async (t) => {
  const { call, calls } = await statusdWithApp(t, { app: false });
  assert.equal((await call('GET', '/status')).body.app, 'none');
  assert.deepEqual((await call('POST', '/app/start')).body, { started: false, app: 'none' });
  assert.deepEqual((await call('POST', '/app/stop')).body, { stopping: false, app: 'none' });
  assert.deepEqual(await calls(), []);
});

test('an app written into the project file after the start is read at the next Start app', async (t) => {
  const { repo, call, calls } = await statusdWithApp(t, { app: false });
  assert.equal((await call('GET', '/status')).body.app, 'none');
  await fs.mkdir(path.join(repo, '.woodshed'));
  await fs.writeFile(path.join(repo, '.woodshed/project.yaml'),
    fixtureProject({ app: fixtureApp({ start: 'bash scripts/serve.sh start', stop: 'bash scripts/serve.sh stop' }) }));
  assert.deepEqual((await call('POST', '/app/start')).body, { started: true, app: 'starting' });
  assert.equal((await call('GET', '/status')).body.app, 'starting');
  assert.deepEqual(await calls(), ['start']);
});

test('statusd reports the engines whose viewers the entrypoint started, and nothing when it was not told', async (t) => {
  const told = await statusdWithApp(t, { env: { WOODSHED_DB_VIEWERS: 'postgres mongo mysql' } });
  assert.deepEqual((await told.call('GET', '/status')).body.viewers, ['postgres', 'mongo']);
  const none = await statusdWithApp(t, { env: { WOODSHED_DB_VIEWERS: '' } });
  assert.deepEqual((await none.call('GET', '/status')).body.viewers, [], 'a session with no database of its own');
  // Taken out of this test's own environment: run in a session, it would be that session's.
  const untold = await statusdWithApp(t, { env: { WOODSHED_DB_VIEWERS: undefined } });
  assert.equal('viewers' in (await untold.call('GET', '/status')).body, false);
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

// One raw upgrade to statusd's handleUpgrade at `path`, and what came back before it closed.
function rawUpgradeTo(path, headers, { port = null } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, { token: 'tok', port }));
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1', () => {
        const lines = [`GET ${path} HTTP/1.1`, 'Host: statusd', 'Connection: Upgrade', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
        client.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
      let got = Buffer.alloc(0);
      client.on('data', (chunk) => { got = Buffer.concat([got, chunk]); });
      client.on('close', () => {
        server.close();
        resolve(got);
      });
      client.on('error', reject);
    });
  });
}

test('handleUpgrade sends /exec, with the session token, to the exec pipe, and never an app\'s request', async () => {
  const line = Buffer.from('echo routed').toString('base64');
  const exec = { upgrade: 'woodshed-tunnel', 'x-woodshed-exec': line };
  const ran = await rawUpgradeTo('/exec', { ...exec, authorization: 'Bearer tok' });
  assert.match(ran.toString('latin1'), /^HTTP\/1\.1 101/);
  assert.ok(ran.includes(Buffer.from('routed\n')), 'the line ran');
  assert.match((await rawUpgradeTo('/exec', { ...exec, authorization: 'Bearer wrong' })).toString(), /^HTTP\/1\.1 401/);
  // An app's request carries the token in x-woodshed-app: it goes to the app, here none (503), never to the pipe.
  assert.match((await rawUpgradeTo('/exec', { ...exec, 'x-woodshed-app': 'Bearer tok' })).toString(), /^HTTP\/1\.1 503/);
});

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

test('Sign in for Remote Control types /woodshed:remote-control into claude, or woodshed-login at the Terminal tab without the command', async (t) => {
  // A tmux server of the test's own, never the session's: claude's pane and the Terminal tab's keep what is typed.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-login-'));
  const tmuxEnv = { ...isolatedEnv(), TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => promisify(execFile)('tmux', args, { env: tmuxEnv });
  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  // claude's pane: claude at its prompt (standInClaude); the shell's: each line it is sent, written down.
  await fs.writeFile(path.join(dir, 'claude.cjs'), standInClaude(path.join(dir, 'claude.typed')));
  await tmux('new-session', '-d', '-s', 'claude', `${process.execPath} ${path.join(dir, 'claude.cjs')}`);
  await tmux('new-session', '-d', '-s', 'shell', `bash --norc -c 'while IFS= read -r l; do echo "$l" >> ${dir}/shell.typed; done'`);
  for (let i = 0; i < 50 && !/auto mode on/.test((await tmux('capture-pane', '-p', '-t', 'claude')).stdout); i++) await new Promise((r) => setTimeout(r, 100));
  const flags = path.join(dir, 'flags');
  const stateFile = path.join(dir, 'state.json');
  const setState = (state) => fs.writeFile(stateFile, JSON.stringify({ state, event: state === 'done' ? 'Stop' : 'PreToolUse', at: Date.now(), shells: 0 }));
  await setState('done');
  const { call } = await statusdWithApp(t, { env: { TMUX: '', TMUX_TMPDIR: dir, WOODSHED_CLAUDE_FLAGS_FILE: flags, WOODSHED_CLAUDE_STATE_FILE: stateFile } });
  const typed = (name) => fs.readFile(path.join(dir, `${name}.typed`), 'utf8').catch(() => '');
  const until = async (name, text) => {
    for (let i = 0; i < 50 && !(await typed(name)).includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  };

  assert.equal((await call('POST', '/claude-login', 'wrong')).status, 401);
  assert.deepEqual((await call('POST', '/claude-login')).body, { ok: true, where: 'terminal' }, 'claude started without the plugin: an older image');
  await until('shell', 'woodshed-login');
  assert.equal(await typed('shell'), 'woodshed-login\n');

  await fs.writeFile(flags, ' --settings /x/claudeHooks.json --plugin-dir /x/claudePlugin');
  // Mid-turn, a prompt could open under the command's Enter: it waits for the turn's end, typing nothing.
  await setState('working');
  const busy = await call('POST', '/claude-login');
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /claude is working: sign in once its turn ends/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await typed('claude'), '', 'nothing typed mid-turn');
  await setState('done');
  assert.deepEqual((await call('POST', '/claude-login')).body, { ok: true, where: 'agent' });
  await until('claude', '/woodshed:remote-control');
  assert.equal(await typed('claude'), '/woodshed:remote-control\n');
  assert.equal(await typed('shell'), 'woodshed-login\n', 'nothing more at the Terminal tab');
});

test('POST /interrupt sends Esc to the agent\'s pane, which ends its turn, with the token only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-interrupt-'));
  const tmuxEnv = { ...isolatedEnv(), TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => promisify(execFile)('tmux', args, { env: tmuxEnv });
  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  // Each key the pane gets, one a line, as bash quotes it: Esc is $'\E'.
  await tmux('new-session', '-d', '-s', 'claude', `bash --norc -c 'stty raw -echo; while IFS= read -r -n1 -d "" c; do printf "%q\\n" "$c" >> ${dir}/keys; done'`);
  const { call } = await statusdWithApp(t, { env: { TMUX: '', TMUX_TMPDIR: dir } });
  const keys = () => fs.readFile(path.join(dir, 'keys'), 'utf8').catch(() => '');

  assert.equal((await call('POST', '/interrupt', 'wrong')).status, 401);
  assert.deepEqual((await call('POST', '/interrupt')).body, { ok: true });
  for (let i = 0; i < 50 && !(await keys()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await keys(), "$'\\E'\n", 'Esc and nothing else');
});

test('parseAnswerBody takes a question\'s picks or an approval\'s decision, and nothing else', () => {
  const q = { question: 'Which colour?', options: ['Red', 'Blue'], pick: 1 };
  assert.deepEqual(parseAnswerBody(JSON.stringify({ kind: 'question', questions: [q], extra: 'x' })), { kind: 'question', questions: [q] });
  assert.deepEqual(parseAnswerBody(JSON.stringify({ kind: 'approval', decision: 'deny', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Do you want to proceed?' })),
    { kind: 'approval', decision: 'deny', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  for (const bad of [
    'nope', '{}', JSON.stringify({ kind: 'question', questions: [] }),
    JSON.stringify({ kind: 'question', questions: [{ ...q, pick: 2 }] }),
    JSON.stringify({ kind: 'question', questions: [{ ...q, pick: '1' }] }),
    JSON.stringify({ kind: 'question', questions: Array(5).fill(q) }),
    JSON.stringify({ kind: 'approval', decision: 'yes', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    JSON.stringify({ kind: 'approval', decision: 'approve', title: 't', detail: [] }),
    JSON.stringify({ kind: 'approval', decision: 'approve', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    JSON.stringify({ kind: 'keys', keys: 'Enter' }),
  ]) assert.throws(() => parseAnswerBody(bad), undefined, bad);
});

// The stand-in picker (shared/__fixtures__/claudePicker.mjs) in a tmux pane of the test's own, where statusd reads
// and types as in a session: what it picked is written to a file once the picker closes.
async function pickerPane(t, spec) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-answer-'));
  const tmuxEnv = { ...isolatedEnv(), TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => promisify(execFile)('tmux', args, { env: tmuxEnv });
  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const picker = fileURLToPath(new URL('../shared/__fixtures__/claudePicker.mjs', import.meta.url));
  await tmux('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '40', `${process.execPath} ${picker} ${dir}/spec.json ${dir}/answers.json`);
  const shown = async () => (await tmux('capture-pane', '-p', '-t', 'claude')).stdout;
  for (let i = 0; i < 50 && !/Esc to cancel/.test(await shown()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  // claude's hooks say it asks, in a state file of the test's own: the default one is the machine's own claude's.
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ state: 'needs-you', event: 'PermissionRequest', at: Date.now(), shells: 0 }));
  const { call } = await statusdWithApp(t, { env: { TMUX: '', TMUX_TMPDIR: dir, WOODSHED_CLAUDE_STATE_FILE: path.join(dir, 'state.json') } });
  return {
    call, tmux,
    answers: async () => JSON.parse(await fs.readFile(path.join(dir, 'answers.json'), 'utf8').catch(() => 'null')),
  };
}

test('GET /prompt says a pane it could not read is unread, not one that asks nothing', async (t) => {
  const { call, tmux } = await pickerPane(t, { questions: [{ question: 'Which colour?', header: 'Colour', options: ['Red', 'Green'] }] });
  assert.equal((await call('GET', '/prompt')).body.prompt?.kind, 'question');
  await tmux('kill-server');
  const unread = await call('GET', '/prompt');
  assert.equal(unread.status, 503);
  assert.equal(unread.body.why, 'pane-unread');
  assert.equal(unread.body.prompt, undefined);
});

test('POST /answer picks each question\'s option and submits, in a real tmux pane, with the token only', async (t) => {
  const spec = { questions: [
    { question: 'Which colour do you prefer?', header: 'Colour', options: ['Red', 'Green', 'Blue'] },
    { question: 'Which size do you want?', header: 'Size', options: ['Small', 'Medium', 'Large'] },
  ] };
  const { call, tmux, answers } = await pickerPane(t, spec);
  const prompt = (await call('GET', '/prompt')).body.prompt;
  assert.deepEqual(prompt, { kind: 'question', step: 'question', question: 'Which colour do you prefer?', multiSelect: false, options: ['Red', 'Green', 'Blue'], questions: 2 });
  const body = (picks) => JSON.stringify({ kind: 'question', questions: spec.questions.map((q, i) => ({ question: q.question, options: q.options, descriptions: q.options.map((o) => `${o} is one of the options`), pick: picks[i] })) });

  assert.equal((await call('POST', '/answer', 'wrong', body([1, 2]))).status, 401);
  assert.equal((await call('GET', '/prompt', 'wrong')).status, 401);
  // The person moved the highlight in the TUI tab first: the moves count from where it is.
  await tmux('send-keys', '-t', 'claude', 'Down', 'Down');
  const wrong = await call('POST', '/answer', 'sess', JSON.stringify({ kind: 'question', questions: [{ question: 'Which size do you want?', options: ['Small', 'Medium', 'Large'], pick: 0 }] }));
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.why, 'other-question');
  assert.equal(await answers(), null, 'nothing picked');

  assert.deepEqual((await call('POST', '/answer', 'sess', body([1, 2]))).body, { ok: true });
  assert.deepEqual(await answers(), { answers: ['Green', 'Large'] });
  assert.deepEqual((await call('GET', '/prompt')).body, { prompt: null });

  const again = await call('POST', '/answer', 'sess', body([1, 2]));
  assert.equal(again.status, 409, 'answered already: the pane has no question');
  assert.equal(again.body.why, 'no-picker');
});

test('POST /answer approves or denies the approval on screen, and refuses one the page did not show', async (t) => {
  const spec = { approval: { title: 'Do you want to proceed?', what: 'Write the date', command: 'date > now.txt' } };
  const { call, answers } = await pickerPane(t, spec);
  const prompt = (await call('GET', '/prompt')).body.prompt;
  const { key, ...shown } = prompt;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(shown, { kind: 'approval', agent: 'claude', complete: true, what: 'Bash command', title: 'Do you want to proceed?', detail: ['Write the date', 'date > now.txt'], approve: 'Yes', deny: 'No' });
  // Another approval's key: what the page showed when the pane asked something else.
  const other = await call('POST', '/answer', 'sess', JSON.stringify({ kind: 'approval', decision: 'approve', key: 'b'.repeat(64) }));
  assert.equal(other.status, 409);
  assert.equal(other.body.why, 'other-approval');
  assert.equal(await answers(), null);
  assert.equal((await call('POST', '/answer', 'sess', '{"kind":"keys"}')).status, 400);
  assert.deepEqual((await call('POST', '/answer', 'sess', JSON.stringify({ kind: 'approval', decision: 'deny', key }))).body, { ok: true });
  assert.deepEqual(await answers(), { approval: 'No' });
});

test('POST /send types nothing while the pane shows an approval or a question: its Enter would answer it', async (t) => {
  // Found with the real codex 0.167: a message sent while it showed its approval was swallowed, and its Enter approved
  // the command, the highlighted Yes.
  const { call, answers } = await pickerPane(t, { approval: { title: 'Do you want to proceed?', what: 'Write the date', command: 'date > now.txt' } });
  const sent = await call('POST', '/send', 'sess', JSON.stringify({ text: 'run the tests next' }));
  assert.equal(sent.status, 409);
  assert.equal(sent.body.why, 'prompt-open');
  assert.match(sent.body.error, /waiting for an approval/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await answers(), null, 'nothing approved');
  assert.equal((await call('GET', '/prompt')).body.prompt?.kind, 'approval', 'still asking');
});

test('POST /send refuses while claude\'s question picker is open', async (t) => {
  const { call, answers } = await pickerPane(t, { questions: [{ question: 'Which colour do you prefer?', header: 'Colour', options: ['Red', 'Green'] }] });
  const sent = await call('POST', '/send', 'sess', JSON.stringify({ text: 'Red please' }));
  assert.equal(sent.status, 409);
  assert.match(sent.body.error, /asking a question/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await answers(), null, 'nothing picked');
});

test('POST /send types nothing when the pane cannot be read, which may be showing a prompt', async (t) => {
  // No tmux server in this TMUX_TMPDIR: capture-pane fails, as it would for a moment while tmux is busy.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-unread-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { call } = await statusdWithApp(t, { env: { TMUX: '', TMUX_TMPDIR: dir } });
  const sent = await call('POST', '/send', 'sess', JSON.stringify({ text: 'go on' }));
  assert.equal(sent.status, 503);
  assert.equal(sent.body.why, 'pane-unread');
  assert.doesNotMatch(JSON.stringify(sent.body), /go on/, 'the reply carries no text of the message');
});

// A stand-in claude at its prompt: its mode footer, and each line it is sent written to a file.
// A stand-in claude at its prompt, in raw mode as claude is: its box between rules, what is typed shown in it (its hint
// dim when empty), each Enter writing the box's line to `file`. `screen` draws a fixed screen instead. `menuOnInput`
// brings a menu up as soon as text goes in, before its Enter, as a prompt opening mid-typing would.
function standInClaude(file, { screen = null, menuOnInput = false } = {}) {
  return `const fs = require('fs');
const custom = ${JSON.stringify(screen)};
let line = '';
let shown = false;
const rule = '\\x1b[38;5;244m${'─'.repeat(40)}\\x1b[39m';
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + (custom ?? ('stand-in claude\\n' + rule + '\\n❯\\u00a0' + (line || '\\x1b[2mTry "fix lint"\\x1b[0m') + '\\n' + rule + '\\n  ⏵⏵ auto mode on (shift+tab to cycle)\\n' + (shown ? '\\n  Pick one\\n  ❯ 1. Yes\\n    2. No\\n  Enter to confirm · Esc to cancel\\n' : ''))));
process.stdin.setRawMode(true);
draw();
process.stdin.on('data', (d) => {
  for (const ch of d.toString()) {
    if (ch === '\\r') { fs.appendFileSync(${JSON.stringify(file)}, line + '\\n'); line = ''; }
    else if (ch === '\\x15') { line = ''; shown = false; }
    else { line += ch; if (${menuOnInput}) shown = true; }
  }
  draw();
});
`;
}

// claude at its prompt: its box between two rules, the box's hint dim, and its mode footer.
const CLAUDE_IDLE = `\n\x1b[38;5;244m${'─'.repeat(60)}\x1b[39m\n❯\u00a0\x1b[2mTry "fix lint errors"\x1b[0m\n\x1b[38;5;244m${'─'.repeat(60)}\x1b[39m\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;

async function promptPane(t, state, { screen = CLAUDE_IDLE, menuOnInput = false, env = {}, asClaude = false, inShell = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-held-'));
  const tmuxEnv = { ...isolatedEnv(), TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => promisify(execFile)('tmux', args, { env: tmuxEnv });
  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const lines = path.join(dir, 'lines.txt');
  const script = path.join(dir, 'claude.cjs');
  await fs.writeFile(script, standInClaude(lines, { screen: screen === CLAUDE_IDLE ? null : screen, menuOnInput }));
  // asClaude: run as a program named claude, as the real agent's pane shows it to tmux (pane_current_command).
  const program = asClaude ? path.join(dir, 'claude') : process.execPath;
  if (asClaude) await fs.symlink(process.execPath, program);
  // inShell: claude as the child of the pane's shell, which stays when it stops, as in a session.
  const command = inShell ? `bash --norc -c '${program} ${script}; exec bash --norc'` : `${program} ${script}`;
  await tmux('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '20', command);
  const stateFile = path.join(dir, 'state.json');
  const setState = (s) => fs.writeFile(stateFile, JSON.stringify({ state: s, event: s === 'done' ? 'Stop' : 'PreToolUse', at: Date.now(), shells: 0 }));
  await setState(state);
  for (let i = 0; i < 50 && !/auto mode on|esc to interrupt/.test((await tmux('capture-pane', '-p', '-t', 'claude')).stdout); i++) await new Promise((r) => setTimeout(r, 100));
  const { call } = await statusdWithApp(t, { env: { TMUX: '', TMUX_TMPDIR: dir, WOODSHED_CLAUDE_STATE_FILE: stateFile, ...env } });
  return { call, setState, tmux, dir, program, script, stateFile, got: async () => (await fs.readFile(lines, 'utf8').catch(() => '')) };
}


test('a failed typing call is said again without the message it typed', async () => {
  // As execFile rejects: its message quotes the whole command line, the private draft with it.
  const failed = await promisify(execFile)('tmux', ['-S', '/nonexistent/socket', 'send-keys', '-t', 'claude', '-l', 'my secret draft']).catch((err) => err);
  assert.match(failed.message, /my secret draft/, 'the raw error has it');
  const said = typingError(failed);
  assert.equal(said.typing, true);
  assert.doesNotMatch(said.message, /secret|draft|send-keys/);
  assert.match(said.message, /^tmux could not type the message \(exit \d+\)$/);
  assert.doesNotMatch(JSON.stringify({ ...said, message: said.message }), /secret/);
});




const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, tries = 60) {
  for (let i = 0; i < tries && !(await check()); i++) await pause(100);
}

test('POST /send types nothing while the agent works, and says busy for the console to send it later', async (t) => {
  // A prompt opens only mid-turn, between any last look at the pane and an Enter: so mid-turn, no Enter at all. The
  // console holds it in its saved pendingMessages (fleet.mjs), kept across a stop mid-turn.
  const { call, setState, got } = await promptPane(t, 'working');
  const sent = await call('POST', '/send', 'sess', JSON.stringify({ text: 'hello busy' }));
  assert.equal(sent.status, 409);
  assert.equal(sent.body.why, 'working');
  assert.equal(sent.body.busy, true);
  await pause(1000);
  assert.equal(await got(), '', 'nothing typed while it works');
  await setState('done');
  assert.equal((await call('POST', '/send', 'sess', JSON.stringify({ text: 'hello again' }))).status, 200);
  await until(async () => (await got()) === 'hello again\n');
  assert.equal(await got(), 'hello again\n');
});

test('a second message before the agent took the first is busy, rather than landing in the turn the first began', async (t) => {
  const { call, setState, got } = await promptPane(t, 'done');
  const send = (text) => call('POST', '/send', 'sess', JSON.stringify({ text }));
  assert.equal((await send('one')).status, 200);
  const second = await send('two');
  assert.equal(second.status, 409);
  assert.equal(second.body.why, 'working');
  await until(async () => (await got()) === 'one\n');
  // The agent took it, a turn that ends: back at its prompt, the next goes in.
  await setState('working');
  await pause(300);
  await setState('done');
  assert.equal((await send('two')).status, 200);
  await until(async () => (await got()) === 'one\ntwo\n');
  assert.equal(await got(), 'one\ntwo\n');
});

test('a stale hook that says done is not enough when claude\'s screen shows its turn running: busy, nothing typed', async (t) => {
  const rule = '─'.repeat(60);
  const running = `\n${rule}\n❯ \n${rule}\n  ✻ Working… (12s · esc to interrupt)\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
  const { call, got } = await promptPane(t, 'done', { screen: running });
  const sent = await call('POST', '/send', 'sess', JSON.stringify({ text: 'not into this turn' }));
  assert.equal(sent.status, 409);
  assert.equal(sent.body.why, 'working');
  await pause(1000);
  assert.equal(await got(), '', 'no text, no Enter, while the screen shows the turn');
});

test('text left in the box with no Enter blocks the next message until the agent takes it, so two never join', async (t) => {
  // A menu comes up as the text goes in: no Enter, the text sits in the box (typed), and the next send is busy.
  const { call, setState, got } = await promptPane(t, 'done', { menuOnInput: true });
  const first = await call('POST', '/send', 'sess', JSON.stringify({ text: 'first' }));
  assert.equal(first.status, 409);
  assert.equal(first.body.typed, true, 'it went in, with no Enter');
  const second = await call('POST', '/send', 'sess', JSON.stringify({ text: 'second' }));
  assert.equal(second.status, 409);
  assert.equal(second.body.why, 'box-in-use', 'not typed onto the end of the first');
  await pause(500);
  assert.equal(await got(), '', 'no Enter for either');
  // A hook firing does not empty the box: an edited or kept draft still blocks, until the box is empty.
  await setState('working');
  await pause(300);
  await setState('done');
  assert.equal((await call('POST', '/send', 'sess', JSON.stringify({ text: 'third' }))).body.why, 'box-in-use');
});

test('a draft emptied in the TUI tab no longer blocks the next message', async (t) => {
  // No hook fires and no turn starts when someone clears the box: the box read empty from the screen is the sign.
  const { call, tmux, got } = await promptPane(t, 'done', { menuOnInput: true });
  assert.equal((await call('POST', '/send', 'sess', JSON.stringify({ text: 'first' }))).body.typed, true);
  assert.equal((await call('POST', '/send', 'sess', JSON.stringify({ text: 'second' }))).body.why, 'box-in-use');
  await tmux('send-keys', '-t', 'claude', 'C-u');
  await pause(300);
  const after = await call('POST', '/send', 'sess', JSON.stringify({ text: 'second' }));
  assert.equal(after.status, 409, 'its menu came up again as this went in: no Enter');
  assert.equal(after.body.typed, true, 'the box empty: typed this time');
  assert.equal(await got(), '', 'and no Enter for any of them');
});

test('the status says when text waits in the agent\'s box at its prompt, for Chat to say so', async (t) => {
  const idle = await promptPane(t, 'done');
  assert.equal((await idle.call('GET', '/status')).body.boxText, false, 'only its dim hint: empty');
  const rule = '─'.repeat(60);
  const draft = await promptPane(t, 'done', { screen: `\n${rule}\n❯ half a note\n${rule}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n` });
  assert.equal((await draft.call('GET', '/status')).body.boxText, true);
});

test('a message is typed so no agent folds it into a paste: claude in short runs with Ctrl-J between lines, codex in short pastes', () => {
  const long = 'abcdefghij'.repeat(120);
  const claude = typingSteps(`${long}\nsecond line\n\nlast`, 'claude');
  assert.ok(claude.every((s) => s.keys === undefined || [...s.keys].length <= 50), 'never more than 50 characters at once');
  assert.equal(claude.filter((s) => s.key === 'C-j').length, 3, 'a newline for each line after the first, an empty one too');
  assert.ok(!claude.some((s) => s.key === 'Enter'), 'no Enter while typing');
  assert.equal(claude.filter((s) => s.keys).map((s) => s.keys).join(''), `${long}second linelast`);
  assert.ok(claude.every((s) => s.pauseMs >= 20));
  const codex = typingSteps(long, 'codex');
  assert.deepEqual(codex.map((s) => [...s.paste].length), [400, 400, 400]);
  assert.equal(codex.map((s) => s.paste).join(''), long);
  // A character outside the basic plane is never split across two runs.
  const emoji = '🙂'.repeat(60);
  assert.equal(typingSteps(emoji, 'claude').map((s) => s.keys).join(''), emoji);
});

test('before typing, the box is read on the screen alone: an old frame in the scrollback is not the box', async (t) => {
  // claude's inline mode leaves earlier frames above the screen. Here an empty box scrolled off the top, and the screen
  // now shows no box (its footer, nothing to type into): no box, so nothing goes in.
  const grey = (x) => `\x1b[38;5;244m${x}\x1b[39m`;
  const old = `${grey('─'.repeat(40))}\n❯ \x1b[2mTry "x"\x1b[0m\n${grey('─'.repeat(40))}\n`;
  const filler = Array.from({ length: 60 }, (_, i) => `● line ${i} of an answer`).join('\n');
  const { call, got } = await promptPane(t, 'done', { screen: `${old}${filler}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n` });
  const sent = await call('POST', '/send', 'sess', JSON.stringify({ text: 'not into nothing' }));
  assert.equal(sent.status, 409);
  assert.equal(sent.body.why, 'box-in-use', 'no box on the screen: refused before any key');
  assert.equal(await got(), '');
});

test('a typing call that fails after part of the text went in says so, for nothing to send all of it again', () => {
  const failed = Object.assign(new Error('Command failed: tmux send-keys -l secret'), { code: 1 });
  assert.equal(typingError(failed, true).partial, true);
  assert.equal(typingError(failed).partial, false);
  assert.doesNotMatch(typingError(failed, true).message, /secret/);
});

test('a message\'s control characters are not typed: an ESC would be the Escape key, a NUL cannot pass tmux', () => {
  assert.equal(typeableText('line one\r\nline two\rthree'), 'line one\nline two\nthree');
  assert.equal(typeableText('a\u0000b\u001b[2Jc\u007fd\te'), 'ab[2Jcd\te');
  assert.equal(parseSendBody(JSON.stringify({ text: 'hi\u0000 there' })), 'hi there');
  assert.throws(() => parseSendBody(JSON.stringify({ text: '\u0000\u001b' })), /non-empty/, 'nothing left to type: refused, and the fleet drops it');
});

test('parseAnswerBody keeps the options\' descriptions, which tell a wrapped label from its description', () => {
  const q = { question: 'Which?', options: ['A long label', 'B'], descriptions: ['what A does', ''], pick: 0 };
  assert.deepEqual(parseAnswerBody(JSON.stringify({ kind: 'question', questions: [q] })).questions[0].descriptions, ['what A does', '']);
  const mismatched = { ...q, descriptions: ['only one'] };
  assert.equal(parseAnswerBody(JSON.stringify({ kind: 'question', questions: [mismatched] })).questions[0].descriptions, undefined, 'not one each: left out');
});

test('the status says nothing of the box it cannot see: mid-turn, under a dialog, never taken as emptied', async (t) => {
  const working = await promptPane(t, 'working');
  const busy = (await working.call('GET', '/status')).body;
  assert.equal(busy.boxText, null, 'mid-turn: not looked at');
  assert.equal(busy.safeSend, true, 'it says it sends with the guards');
  // A screen with a dialog and no box on it: nothing known of the box under it.
  const dialog = await promptPane(t, 'done', { screen: '\n  Pick one\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n  ⏵⏵ auto mode on (shift+tab to cycle)\n' });
  assert.equal((await dialog.call('GET', '/status')).body.boxText, null);
});

test('the pull request lookup is kept per branch, and a checkout during it leaves nothing kept', async () => {
  let clock = 0;
  let branch = 'woodshed/joel-1';
  const urls = { 'woodshed/joel-1': 'https://github.com/o/r/pull/9', other: null };
  let lookups = 0;
  let checkoutDuringLookup = null;
  const prUrl = createPrLookup({
    branch: async () => branch,
    lookup: async () => {
      lookups += 1;
      const url = urls[branch];
      if (checkoutDuringLookup) { branch = checkoutDuringLookup; checkoutDuringLookup = null; }
      return url;
    },
    now: () => clock,
    cacheMs: 60_000,
  });
  assert.equal(await prUrl(), 'https://github.com/o/r/pull/9');
  assert.equal(await prUrl(), 'https://github.com/o/r/pull/9');
  assert.equal(lookups, 1, 'kept');
  branch = 'other';
  assert.equal(await prUrl(), null, 'another branch is looked up at once');
  assert.equal(lookups, 2);
});

test('a checkout during the pull request lookup says nothing and keeps nothing for either branch', async () => {
  let branch = 'woodshed/joel-1';
  const urls = { 'woodshed/joel-1': 'https://github.com/o/r/pull/9', 'feature/ana': 'https://github.com/o/r/pull/12' };
  let lookups = 0;
  let checkout = 'feature/ana';
  const prUrl = createPrLookup({
    branch: async () => branch,
    lookup: async () => {
      lookups += 1;
      const url = urls[branch];
      if (checkout) { branch = checkout; checkout = null; }
      return url;
    },
    now: () => 0,
    cacheMs: 60_000,
  });
  assert.equal(await prUrl(), null, 'the answer may be either branch\'s');
  assert.equal(await prUrl(), 'https://github.com/o/r/pull/12', 'the new branch is looked up, not given the old one\'s');
  assert.equal(lookups, 2);
});

test('a branch set to track another remote branch is looked up again', async () => {
  let upstream = 'origin/woodshed/joel-1';
  let lookups = 0;
  const prUrl = createPrLookup({
    branch: async () => `woodshed/joel-1 ${upstream}`,
    lookup: async () => { lookups += 1; return upstream === 'origin/woodshed/joel-1' ? 'https://github.com/o/r/pull/9' : 'https://github.com/o/r/pull/12'; },
    now: () => 0,
    cacheMs: 60_000,
  });
  assert.equal(await prUrl(), 'https://github.com/o/r/pull/9');
  upstream = 'fork/feature';
  assert.equal(await prUrl(), 'https://github.com/o/r/pull/12');
  assert.equal(lookups, 2);
});

test('the pull request lookup is kept for the branch, its upstream and its remote\'s URL', async () => {
  const repo = { branch: 'woodshed/joel-1', upstream: 'origin/woodshed/joel-1', url: 'https://github.com/o/r.git' };
  const gitRun = async (...args) => {
    if (args[0] === 'branch') return repo.branch;
    if (args[0] === 'rev-parse') { if (!repo.upstream) throw new Error('no upstream'); return repo.upstream; }
    if (args[0] === 'ls-remote') { if (!repo.url) throw new Error('no remote'); return repo.url; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const first = await prLookupKey(gitRun);
  repo.url = 'https://github.com/fork/r.git';
  const repointed = await prLookupKey(gitRun);
  repo.upstream = 'fork/feature';
  const retracked = await prLookupKey(gitRun);
  assert.equal(new Set([first, repointed, retracked]).size, 3, 'each change is another key');
  Object.assign(repo, { upstream: null, url: null });
  assert.equal((await prLookupKey(gitRun)).trim(), 'woodshed/joel-1', 'no upstream or remote: the branch alone');
});

test('the pull requests of every local branch are read, not only the one checked out', async () => {
  const url = (n) => `https://github.com/o/r/pull/${n}`;
  let clock = 0;
  let reads = 0;
  let local = [{ name: 'feature/docs', sha: 'c3' }, { name: 'feature/api', sha: 'b2' }, { name: 'woodshed/joel-1', sha: 'a1' }];
  const asked = [];
  const branchPulls = createBranchPulls({
    branches: async () => local,
    pullsOf: async (names) => {
      reads += 1;
      asked.push(names);
      return [
        { branch: 'feature/docs', url: url(14), headSha: 'c3', fork: false },
        { branch: 'woodshed/joel-1', url: url(9), headSha: 'a1', fork: false },
        { branch: 'feature/api', url: url(12), headSha: 'b2', fork: false },
        // An older pull request that used the name, whose commits the branch does not have, and a fork's of that name.
        { branch: 'feature/api', url: url(3), headSha: 'old', fork: false },
        { branch: 'feature/api', url: url(13), headSha: 'b2', fork: true },
      ];
    },
    isAncestor: async (sha, branch) => local.some((b) => b.name === branch && b.sha === sha),
    now: () => clock,
    cacheMs: 60_000,
  });
  assert.deepEqual(await branchPulls(), [url(9), url(12), url(14)], 'the lowest number first');
  assert.deepEqual(asked[0], ['feature/docs', 'feature/api', 'woodshed/joel-1']);
  await branchPulls();
  assert.equal(reads, 1, 'kept while the branches are as they were');
  local = [{ name: 'feature/more', sha: 'd4' }, ...local];
  await branchPulls();
  assert.equal(reads, 2, 'a new branch is read at once');
  clock = 61_000;
  await branchPulls();
  assert.equal(reads, 3, 'and again after a minute');
});

test('a failed read of the branches\' pull requests is kept a minute, with the last good list', async () => {
  let fail = true;
  let reads = 0;
  let clock = 0;
  let local = [{ name: 'a', sha: '1' }];
  const failing = createBranchPulls({
    branches: async () => local,
    pullsOf: async () => { reads += 1; if (fail) throw new Error('gh: HTTP 502'); return [{ branch: 'a', url: 'https://github.com/o/r/pull/2', headSha: local[0].sha, fork: false }]; },
    isAncestor: async () => true,
    now: () => clock,
    cacheMs: 60_000,
  });
  assert.deepEqual(await failing(), []);
  fail = false;
  assert.deepEqual(await failing(), [], 'not asked again at the next status read');
  assert.equal(reads, 1);
  clock = 61_000;
  assert.deepEqual(await failing(), ['https://github.com/o/r/pull/2'], 'asked again after its minute');
  fail = true;
  local = [{ name: 'a', sha: '2' }];
  assert.deepEqual(await failing(), ['https://github.com/o/r/pull/2'], 'a later failure keeps the last good list');
  assert.equal(reads, 3, 'a new commit asks at once');
  await failing();
  assert.equal(reads, 3);
  const none = createBranchPulls({ branches: async () => [], pullsOf: async () => { reads += 1; return []; }, isAncestor: async () => true, now: () => 0 });
  assert.deepEqual(await none(), []);
  assert.equal(reads, 3, 'no branch asks nothing');
});

test('the branches\' pull requests are asked for in one query, of the repo the remote names', () => {
  assert.deepEqual(githubRepoOf('https://github.com/o/r.git\n'), { owner: 'o', name: 'r' });
  assert.deepEqual(githubRepoOf('git@github.com:o/r.name'), { owner: 'o', name: 'r.name' });
  assert.equal(githubRepoOf('/srv/git/r.git'), null);
  const { query, variables } = branchPullsQuery(['woodshed/joel-1', 'x"y']);
  assert.deepEqual(variables, { b0: 'woodshed/joel-1', b1: 'x"y' }, 'names go as variables, never into the query');
  assert.match(query, /^query\(\$owner: String!, \$name: String!, \$b0: String!, \$b1: String!\)/);
  assert.match(query, /b1: pullRequests\(first: 5, [^)]*headRefName: \$b1\)/);
  assert.ok(!query.includes('x"y'));
});

test('a send marked agentOnly types only while claude or codex runs in the pane', () => {
  assert.equal(sendAgentOnly('{"text":"hi","agentOnly":true}'), true);
  assert.equal(sendAgentOnly('{"text":"hi"}'), false);
  assert.equal(sendAgentOnly('{"text":"hi","agentOnly":"yes"}'), false);
  for (const command of ['claude', 'codex', 'claude\n']) assert.equal(isAgentCommand(command), true, command);
  for (const command of ['bash', 'zsh', 'sh', 'node', '', null]) assert.equal(isAgentCommand(command), false, String(command));
});

test('tmux\'s test of the pane, which types only into claude or codex, is true for them alone', { skip: spawnSync('tmux', ['-V']).status !== 0 && 'no tmux here' }, (t) => {
  // A tmux server of its own, so no session's panes are touched.
  const socket = `woodshed-test-${process.pid}`;
  const tmux = (...args) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  t.after(() => tmux('kill-server'));
  assert.equal(tmux('new-session', '-d', '-s', 'probe', 'sleep 30').status, 0);
  const shown = (format) => tmux('display', '-p', '-t', 'probe', format).stdout.trim();
  // The pane shows tmux itself until sleep has started.
  for (let i = 0; i < 100 && shown('#{pane_current_command}') !== 'sleep'; i += 1) spawnSync('sleep', ['0.05']);
  assert.equal(shown('#{pane_current_command}'), 'sleep');
  assert.equal(shown(AGENT_PANE_FORMAT), '0', 'sleep is not the agent');
  for (const name of ['claude', 'codex']) assert.ok(AGENT_PANE_FORMAT.includes(`#{==:#{pane_current_command},${name}}`), name);
});

test('a Chat message sent while the lockdown restarts claude is refused as busy, and goes in once, after claude is back', async (t) => {
  const taintDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-taint-'));
  t.after(() => fs.rm(taintDir, { recursive: true, force: true }));
  // What the reopen types in place of session/bin/claude: the stand-in again, and its hooks as claude's fire on the
  // lockdown's message: working a moment after it opens, then done.
  const launcher = path.join(taintDir, 'claude-launch');
  const flags = path.join(taintDir, 'flags');
  const { call, tmux, got, program, script, stateFile, setState } = await promptPane(t, 'done', {
    asClaude: true, inShell: true, env: { WOODSHED_TAINT_DIR: taintDir, WOODSHED_CLAUDE_BIN: launcher, WOODSHED_CLAUDE_FLAGS_FILE: flags },
  });
  const hook = (state) => `${process.execPath} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ state: process.argv[2], event: "x", at: Date.now(), shells: 0 }))' ${stateFile} ${state}`;
  await fs.writeFile(launcher, `#!/bin/sh\n( sleep 1.5; ${hook('working')}; sleep 1.5; ${hook('done')} ) &\nexec ${program} ${script}\n`, { mode: 0o755 });
  const send = () => call('POST', '/send', 'sess', JSON.stringify({ text: 'during the restart' }));
  const paneCommand = async () => (await tmux('display', '-p', '-t', 'claude', '#{pane_current_command}')).stdout.trim();
  await setState('done');

  assert.deepEqual((await call('POST', '/taint', 'sess', '{}')).body, { tainted: true, egress: false });
  // The old claude is stopped: the pane is its shell, and the reopen holds the pane from before that.
  for (let i = 0; i < 100 && (await paneCommand()) === 'claude'; i++) await new Promise((r) => setTimeout(r, 50));
  const during = await send();
  assert.deepEqual([during.status, during.body.why, during.body.busy], [409, 'typing', true], 'busy: the console holds it');
  assert.doesNotMatch((await tmux('capture-pane', '-p', '-t', 'claude')).stdout, /during the restart/, 'nothing typed into the shell');

  // The console tries again after each status read: busy until the new claude has taken the lockdown's message and
  // finished its turn, then typed in, once.
  let answer = during;
  const tries = [];
  for (let i = 0; i < 60 && answer.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    answer = await send();
    tries.push(answer.body.why ?? answer.status);
  }
  assert.equal(answer.status, 200, `typed in at last (tries: ${tries.join(', ')})`);
  assert.equal(await paneCommand(), 'claude', 'into the new claude');
  for (let i = 0; i < 50 && !(await got()).includes('during the restart'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await got()).match(/during the restart/g)?.length, 1, 'once');
  assert.match(await fs.readFile(path.join(taintDir, 'tainted'), 'utf8'), /"at"/, 'the taint\'s files in the test\'s folder');
});

// A stand-in hc for a session whose claude runs in Herdr: its terminal `claude` is the test's own tmux pane of that name,
// so the stand-in claude and the waits are the tmux test's. It answers what statusd's Herdr adapter calls (agentPane.mjs,
// hcPane): get, read, keys and send, each with its options before `--`, and records every call.
async function standInHc(dir) {
  const file = path.join(dir, 'hc');
  const calls = path.join(dir, 'hc-calls');
  await fs.writeFile(file, `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [command, options, [terminal, ...rest]] = [argv[0], argv.slice(1, sep), argv.slice(sep + 1)];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([command, ...options, '--', terminal, ...rest]) + '\\n');
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' });
const KEYS = { enter: 'Enter', esc: 'Escape', up: 'Up', down: 'Down', space: 'Space', tab: 'Tab', backspace: 'BSpace' };
if (command === 'get') {
  const [pid, name] = tmux('display', '-p', '-t', terminal, '#{pane_pid} #{pane_current_command}').trim().split(' ');
  console.log(JSON.stringify({ address: 't1', name: terminal, pid: Number(pid), status: null, foreground: { pid: 0, name, argv: [name], cwd: '' } }));
} else if (command === 'read') {
  console.log(JSON.stringify({ text: tmux('capture-pane', '-p', '-t', terminal), complete: true, how: 'screen' }));
} else if (command === 'keys') {
  tmux('send-keys', '-t', terminal, ...rest.map((k) => KEYS[k] ?? k.replace(/^ctrl\\+/, 'C-')));
  console.log('{"turn":1}');
} else if (command === 'send') {
  tmux('send-keys', '-t', terminal, '-l', rest[0]);
  tmux('send-keys', '-t', terminal, 'Enter');
  console.log('{"turn":1}');
} else {
  process.exit(2);
}
`, { mode: 0o755 });
  return { file, calls: async () => (await fs.readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

test('in Herdr, the lockdown stops claude, starts the locked-down one through hc, and a Chat message sent meanwhile goes in once', { skip: spawnSync('tmux', ['-V']).status !== 0 && 'no tmux here' }, async (t) => {
  const taintDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-taint-'));
  t.after(() => fs.rm(taintDir, { recursive: true, force: true }));
  const launcher = path.join(taintDir, 'claude-launch');
  const flags = path.join(taintDir, 'flags');
  const hc = await standInHc(taintDir);
  const { call, tmux, got, program, script, stateFile, setState } = await promptPane(t, 'done', {
    asClaude: true, inShell: true,
    env: { WOODSHED_TERMINAL: 'herdr', WOODSHED_HC_BIN: hc.file, WOODSHED_TAINT_DIR: taintDir, WOODSHED_CLAUDE_BIN: launcher, WOODSHED_CLAUDE_FLAGS_FILE: flags },
  });
  const hook = (state) => `${process.execPath} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ state: process.argv[2], event: "x", at: Date.now(), shells: 0 }))' ${stateFile} ${state}`;
  await fs.writeFile(launcher, `#!/bin/sh\n( sleep 1.5; ${hook('working')}; sleep 1.5; ${hook('done')} ) &\nexec ${program} ${script}\n`, { mode: 0o755 });
  const send = () => call('POST', '/send', 'sess', JSON.stringify({ text: 'during the restart' }));
  const paneCommand = async () => (await tmux('display', '-p', '-t', 'claude', '#{pane_current_command}')).stdout.trim();
  const panePid = (await tmux('display', '-p', '-t', 'claude', '#{pane_pid}')).stdout.trim();
  const oldClaude = Number(spawnSync('pgrep', ['-P', panePid], { encoding: 'utf8' }).stdout.trim().split('\n')[0]);
  assert.ok(oldClaude > 0, 'the running claude, under the pane\'s shell');
  await setState('done');

  assert.deepEqual((await call('POST', '/taint', 'sess', '{}')).body, { tainted: true, egress: false });
  for (let i = 0; i < 100 && (await paneCommand()) === 'claude'; i++) await new Promise((r) => setTimeout(r, 50));
  const during = await send();
  assert.deepEqual([during.status, during.body.why, during.body.busy], [409, 'typing', true], 'busy: the console holds it');

  let answer = during;
  const tries = [];
  for (let i = 0; i < 60 && answer.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    answer = await send();
    tries.push(answer.body.why ?? answer.status);
  }
  assert.equal(answer.status, 200, `typed in at last (tries: ${tries.join(', ')})`);
  assert.equal(await paneCommand(), 'claude', 'into the new claude');
  assert.throws(() => process.kill(oldClaude, 0), 'the old claude was stopped');
  for (let i = 0; i < 50 && !(await got()).includes('during the restart'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await got()).match(/during the restart/g)?.length, 1, 'once');

  const calls = await hc.calls();
  const sends = calls.filter((c) => c[0] === 'send').map((c) => c.at(-1));
  assert.ok(calls.some((c) => c[0] === 'get' && c.at(-1) === 'claude'), 'the shell under claude, from hc');
  const reopen = sends.find((text) => text.startsWith(`${launcher} `));
  assert.ok(reopen, 'the locked-down claude started through hc');
  assert.match(reopen, /"\$\(cat \S+message\.md\)"$/, 'with the lockdown\'s message');
  assert.equal(sends.filter((text) => text === 'during the restart').length, 1, 'the Chat message through hc, once');
  for (const c of calls) assert.ok(c.indexOf('--') > 0 && c.indexOf('--') < c.length - 1, `options before -- in ${JSON.stringify(c)}`);
});

test('POST /send with agentOnly types into a running agent and never into a shell, with the token only', { skip: spawnSync('tmux', ['-V']).status !== 0 && 'no tmux here' }, async (t) => {
  // A stand-in gh answering `gh pr view` with the pull request in the file it names, for the check just before typing.
  const ghDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-gh-'));
  t.after(() => fs.rm(ghDir, { recursive: true, force: true }));
  const bin = path.join(ghDir, 'bin');
  await fs.mkdir(bin);
  const current = path.join(ghDir, 'current-pr');
  const onPull = (url, { state = 'OPEN', head = 'abc1234def' } = {}) => fs.writeFile(current, JSON.stringify({ url, state, headRefOid: head }));
  await onPull('https://github.com/o/r/pull/9');
  await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh\ncat ${current}\n`, { mode: 0o755 });
  // The stand-in claude at its prompt, named claude as the real one's pane shows it; its hooks say it is done.
  const { call, tmux, setState, got, program, script } = await promptPane(t, 'done', { asClaude: true, env: { PATH: `${bin}:${process.env.PATH}` } });
  const send = (body, token) => call('POST', '/send', token, JSON.stringify(body));
  // Taken: a hook since its Enter, as claude's own would fire, so the next one may go in.
  const taken = async () => { await new Promise((r) => setTimeout(r, 20)); await setState('done'); };

  // The agent exited: its pane is a shell, which would run the text.
  await tmux('respawn-pane', '-k', '-t', 'claude', 'bash --norc');
  for (let i = 0; i < 50 && (await tmux('display', '-p', '-t', 'claude', '#{pane_current_command}')).stdout.trim() !== 'bash'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await send({ text: 'git push', agentOnly: true }, 'wrong')).status, 401);
  const refused = await send({ text: 'git push', agentOnly: true });
  assert.deepEqual([refused.status, refused.body.error], [409, 'the agent is not running in its pane']);
  assert.doesNotMatch((await tmux('capture-pane', '-p', '-t', 'claude')).stdout, /git push/, 'the shell got nothing');

  // claude again, at its prompt: typed in, as any message, between turns.
  await tmux('respawn-pane', '-k', '-t', 'claude', `${program} ${script}`);
  for (let i = 0; i < 50 && !/auto mode on/.test((await tmux('capture-pane', '-p', '-t', 'claude')).stdout); i++) await new Promise((r) => setTimeout(r, 100));
  await setState('done');
  const sent = await send({ text: 'The review asks for changes', agentOnly: true });
  assert.deepEqual([sent.status, sent.body], [200, { ok: true }]);
  for (let i = 0; i < 50 && !(await got()).includes('The review asks'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await got(), 'The review asks for changes\n');
  assert.equal((await call('GET', '/status')).body.agentOnlySend, true);
  await taken();

  // About a pull request: typed only while the branch checked out is on it, open and on the same commit, read afresh.
  const forNine = { text: 'Fix PR 9', agentOnly: true, prUrl: 'https://github.com/o/r/pull/9', headSha: 'abc1234def' };
  for (const [why, url, opts] of [
    ['another pull request', 'https://github.com/o/r/pull/12', {}],
    ['a newer commit', 'https://github.com/o/r/pull/9', { head: 'fff9999' }],
    ['closed', 'https://github.com/o/r/pull/9', { state: 'CLOSED' }],
  ]) {
    await onPull(url, opts);
    const refusedPr = await send(forNine);
    assert.deepEqual([refusedPr.status, refusedPr.body.error], [409, 'the branch checked out is not on that pull request now'], why);
  }
  // GitHub slower than the caller waits: nothing typed, so its try again cannot type it twice.
  await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh\nsleep 1\ncat ${current}\n`, { mode: 0o755 });
  await onPull('https://github.com/o/r/pull/9');
  const late = await send({ ...forNine, withinMs: 200 });
  assert.deepEqual([late.status, late.body.error], [409, 'too late: the caller has stopped waiting']);
  // A request that spent its time in transit: its caller's deadline passed before statusd even got it.
  const delayed = await send({ ...forNine, withinMs: 20_000, notAfter: Date.now() - 1 });
  assert.deepEqual([delayed.status, delayed.body.error], [409, 'too late: the caller has stopped waiting']);
  // A checkout while gh answers: its answer may be the old branch's, so nothing is typed.
  await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh\ngit -C "$REPO_DIR" checkout -q -b "other-$$"\ncat ${current}\n`, { mode: 0o755 });
  const raced = await send(forNine);
  assert.deepEqual([raced.status, raced.body.error], [409, 'the branch checked out is not on that pull request now']);
  await fs.writeFile(path.join(bin, 'gh'), `#!/bin/sh\ncat ${current}\n`, { mode: 0o755 });
  await onPull('https://github.com/O/R/pull/9');
  // Mid-turn it waits, as any message: busy, for the console to try again at its next check.
  await setState('working');
  const busy = await send(forNine);
  assert.deepEqual([busy.status, busy.body.why], [409, 'working']);
  await setState('done');
  assert.equal((await send(forNine)).status, 200);
  for (let i = 0; i < 50 && !(await got()).includes('Fix PR 9'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await got(), 'The review asks for changes\nFix PR 9\n', 'only the one on its pull request, once');
  await taken();

  // Once the stop's checkpoint has started, nothing guarded is typed.
  await call('POST', '/checkpoint');
  const stopping = await send(forNine);
  assert.deepEqual([stopping.status, stopping.body.error], [409, 'the session is stopping']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await got(), 'The review asks for changes\nFix PR 9\n');
});
test('a branch pointed at another pull request\'s ref, which @{u} cannot name, is another lookup key', async (t) => {
  // A real repository, configured as gh pr checkout leaves a pull request's branch.
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-prkey-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const git = async (...args) => (await promisify(execFile)('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  await git('init', '-q', '-b', 'feat');
  await git('commit', '-q', '--allow-empty', '-m', 'x');
  await git('remote', 'add', 'origin', 'https://github.com/o/r.git');
  await git('config', 'branch.feat.remote', 'origin');
  await git('config', 'branch.feat.merge', 'refs/pull/9/head');
  const nine = await prLookupKey(git);
  await git('config', 'branch.feat.merge', 'refs/pull/12/head');
  const twelve = await prLookupKey(git);
  assert.notEqual(nine, twelve);
  assert.match(twelve, /refs\/pull\/12\/head/);
});

test('a guarded send\'s pull request must be the same one, open, on the same commit', () => {
  const wanted = { url: 'https://github.com/o/r/pull/9', headSha: 'abc1234' };
  const pull = { url: 'https://github.com/O/r/pull/9', state: 'OPEN', headRefOid: 'abc1234def567' };
  assert.equal(stillThePull(pull, wanted), true);
  assert.equal(stillThePull({ ...pull, headRefOid: 'fff' }, wanted), false);
  assert.equal(stillThePull({ ...pull, state: 'MERGED' }, wanted), false);
  assert.equal(stillThePull({ ...pull, url: 'https://github.com/o/r/pull/10' }, wanted), false);
  assert.equal(stillThePull(null, wanted), false);
  assert.equal(stillThePull({ ...pull, headRefOid: 'fff' }, { ...wanted, headSha: null }), true, 'no commit named: the pull request alone');
});

test('a guarded send names how long it may still be typed, a minute at most', () => {
  assert.equal(sendWithinMs('{"text":"x","withinMs":20000}'), 20000);
  assert.equal(sendWithinMs('{"text":"x","withinMs":999999}'), 60000);
  for (const raw of ['{"text":"x"}', '{"text":"x","withinMs":0}', '{"text":"x","withinMs":"20"}', 'nope']) assert.equal(sendWithinMs(raw), null, raw);
});

test('a guarded send carries its caller\'s own deadline', () => {
  assert.equal(sendNotAfter('{"text":"x","notAfter":1700000000000}'), 1700000000000);
  for (const raw of ['{"text":"x"}', '{"text":"x","notAfter":"soon"}', '{"text":"x","notAfter":-1}', 'nope']) assert.equal(sendNotAfter(raw), null, raw);
});

// An agent started beside the session's own (agents.mjs) through statusd's routes, in a real tmux: the stand-in picker
// stands in for its claude, and is asked and answered on that agent's routes, never the session's own pane.
test('an agent beside the session\'s own starts in its own tmux session, and its question is read and answered on its routes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-agents-'));
  const tmuxEnv = { ...isolatedEnv(), TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => promisify(execFile)('tmux', args, { env: tmuxEnv });
  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const spec = { questions: [{ question: 'Which colour?', header: 'Colour', options: ['Red', 'Green', 'Blue'] }] };
  await fs.writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const picker = fileURLToPath(new URL('../shared/__fixtures__/claudePicker.mjs', import.meta.url));
  // The agent's `claude`, whatever flags it is given: the picker, which writes what was picked.
  await fs.mkdir(path.join(dir, 'bin'));
  await fs.writeFile(path.join(dir, 'bin', 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${picker}' '${dir}/spec.json' '${dir}/answers.json'\n`, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'flags'), '');
  // The session's own pane, which nothing here may type into.
  await tmux('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '40', 'sleep 600');
  const { call } = await statusdWithApp(t, { env: {
    TMUX: '', TMUX_TMPDIR: dir, SESSION_KIND: 'private', SESSION_MODE: '', WOODSHED_AGENT_BIN: path.join(dir, 'bin'), WOODSHED_AGENT_CLAUDE_FLAGS_FILE: path.join(dir, 'flags'),
    WOODSHED_CODEX_READY_FILE: path.join(dir, 'no-codex'), WOODSHED_AGENT_STATE_DIR: dir, WOODSHED_CLAUDE_STATE_FILE: path.join(dir, 'own-state.json'),
  } });

  assert.equal((await call('POST', '/agents', 'wrong', '{}')).status, 401);
  const started = await call('POST', '/agents', 'sess', JSON.stringify({ agent: 'claude', model: 'opus' }));
  assert.equal(started.status, 200);
  assert.equal(started.body.agent.id, 'agent-2');
  assert.equal((await call('POST', '/agents', 'sess', JSON.stringify({ agent: 'codex' }))).status, 409, 'no codex home in this session');
  const shown = async () => (await tmux('capture-pane', '-p', '-t', '=agent-2:')).stdout;
  for (let i = 0; i < 50 && !/Esc to cancel/.test(await shown()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await tmux('ls')).stdout.includes('agent-2:'), 'its own tmux session');

  const prompt = (await call('GET', '/agents/agent-2/prompt', 'sess')).body.prompt;
  assert.equal(prompt?.question, 'Which colour?');
  assert.equal((await call('GET', '/prompt', 'sess')).body.prompt, null, 'the session\'s own pane asks nothing');
  assert.equal((await call('GET', '/agents/agent-9/prompt', 'sess')).status, 404);
  const options = ['Red', 'Green', 'Blue'];
  const answer = { kind: 'question', questions: [{ question: 'Which colour?', options, descriptions: options.map((o) => `${o} is one of the options`), pick: 2 }] };
  assert.deepEqual((await call('POST', '/agents/agent-2/answer', 'sess', JSON.stringify(answer))).body, { ok: true });
  let picked = null;
  for (let i = 0; i < 50 && !picked; i++) {
    picked = JSON.parse(await fs.readFile(path.join(dir, 'answers.json'), 'utf8').catch(() => 'null'));
    if (!picked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(JSON.stringify(picked).includes('Blue'), JSON.stringify(picked));

  assert.deepEqual((await call('POST', '/agents/agent-2/stop', 'sess', '{}')).body, { stopped: 'agent-2' });
  assert.deepEqual((await call('GET', '/agents', 'sess')).body, { agents: [] });
  assert.ok((await tmux('ls')).stdout.includes('claude:'), 'the session\'s own is still there');
});

// A Codex agent beside claude on its owner's own sign-in (agents.mjs, codexBeside): written into codex's home as the
// start brings it, and sent back at the stop's checkpoint once codex refreshed it, even after the agent was stopped.
test('a Codex agent beside claude gets the sign-in its start brings, and the stop sends a refreshed one back', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-codex-beside-'));
  const tmuxEnv = { ...isolatedEnv(), TMUX: '', TMUX_TMPDIR: dir };
  const tmux = (...args) => promisify(execFile)('tmux', args, { env: tmuxEnv });
  const posted = [];
  const consoleServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      posted.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const consolePort = await listen(consoleServer);
  t.after(async () => {
    consoleServer.close();
    await tmux('kill-server').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const home = path.join(dir, 'home');
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(path.join(dir, 'bin'));
  await fs.writeFile(path.join(dir, 'bin', 'codex'), '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'codex-ready'), '');
  await tmux('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '40', 'sleep 600');
  const { call } = await statusdWithApp(t, { env: {
    TMUX: '', TMUX_TMPDIR: dir, HOME: home, CODEX_HOME: codexHome, SESSION_KIND: 'private', SESSION_MODE: '', AGENT: '',
    WOODSHED_CONSOLE_URL: `http://127.0.0.1:${consolePort}`, WOODSHED_AGENT_BIN: path.join(dir, 'bin'),
    WOODSHED_AGENT_CLAUDE_FLAGS_FILE: path.join(dir, 'flags'), WOODSHED_CODEX_READY_FILE: path.join(dir, 'codex-ready'),
    WOODSHED_AGENT_STATE_DIR: dir, WOODSHED_CLAUDE_STATE_FILE: path.join(dir, 'own-state.json'),
  } });

  const login = '{"last_refresh":"2026-11-23T10:00:00Z","tokens":{"refresh_token":"rt"}}';
  const started = await call('POST', '/agents', 'sess', JSON.stringify({ agent: 'codex', codexAuth: login }));
  assert.equal(started.status, 200);
  assert.equal(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'), login, 'the sign-in the start brought');
  assert.equal(((await fs.stat(path.join(codexHome, 'auth.json'))).mode & 0o777), 0o600);
  assert.ok(!posted.some((p) => p.url === '/codex-sign-in'), 'nothing asked of the console for it');
  // codex refreshes its ChatGPT login as it runs; then the person stops the agent.
  const refreshed = '{"last_refresh":"2026-11-23T11:00:00Z","tokens":{"refresh_token":"rt2"}}';
  await fs.writeFile(path.join(codexHome, 'auth.json'), refreshed);
  assert.deepEqual((await call('POST', '/agents/agent-2/stop', 'sess', '{}')).body, { stopped: 'agent-2' });

  await call('POST', '/checkpoint');
  const back = posted.filter((p) => p.url === '/codex-auth');
  assert.equal(back.length, 1, 'the refreshed sign-in goes back once');
  assert.equal(back[0].body, refreshed);
});

// The same, where the session's agent runs in Herdr: the agent beside it is a Herdr terminal of its own on the session's
// core (the test's scratch one, isolatedEnv), driven through hc, and gone once stopped.
test('in Herdr, an agent beside the session\'s own is a Herdr terminal of its own, asked and answered through hc', { skip: spawnSync('hc', ['--version'], { env: isolatedEnv() }).status !== 0 && 'no hc here' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusd-agents-hc-'));
  const hc = (...args) => promisify(execFile)('hc', args, { env: isolatedEnv(), cwd: dir });
  t.after(async () => {
    await hc('kill', '--json', '--', 'agent-2').catch(() => {});
    await hc('rm', '--json', '--', 'agent-2').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const spec = { questions: [{ question: 'Which colour?', header: 'Colour', options: ['Red', 'Green', 'Blue'] }] };
  await fs.writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec));
  const picker = fileURLToPath(new URL('../shared/__fixtures__/claudePicker.mjs', import.meta.url));
  await fs.mkdir(path.join(dir, 'bin'));
  // Records the variable the start put before it, then is the picker.
  await fs.writeFile(path.join(dir, 'bin', 'claude'), `#!/bin/sh\necho "$WOODSHED_CLAUDE_STATE_FILE" > '${dir}/state-file'\nexec '${process.execPath}' '${picker}' '${dir}/spec.json' '${dir}/answers.json'\n`, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'flags'), '');
  const { call } = await statusdWithApp(t, { env: {
    WOODSHED_TERMINAL: 'herdr', SESSION_KIND: 'private', SESSION_MODE: '', WOODSHED_AGENT_BIN: path.join(dir, 'bin'),
    WOODSHED_AGENT_CLAUDE_FLAGS_FILE: path.join(dir, 'flags'), WOODSHED_CODEX_READY_FILE: path.join(dir, 'no-codex'), WOODSHED_AGENT_STATE_DIR: dir,
  } });

  const started = await call('POST', '/agents', 'sess', JSON.stringify({ agent: 'claude' }));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const terminal = JSON.parse((await hc('get', '--json', '--', 'agent-2')).stdout);
  assert.equal(terminal.name, 'agent-2');
  assert.equal(terminal.parent ?? null, null, 'no parent: it outlives nothing');
  const shown = async () => JSON.parse((await hc('read', '--json', '--', 'agent-2')).stdout).text;
  for (let i = 0; i < 80 && !/Esc to cancel/.test(await shown()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fs.readFile(path.join(dir, 'state-file'), 'utf8')).trim(), path.join(dir, 'woodshed-agent-2-state.json'), 'its hooks write its own state file');

  assert.equal((await call('GET', '/agents/agent-2/prompt', 'sess')).body.prompt?.question, 'Which colour?');
  const options = ['Red', 'Green', 'Blue'];
  const answer = { kind: 'question', questions: [{ question: 'Which colour?', options, descriptions: options.map((o) => `${o} is one of the options`), pick: 1 }] };
  assert.deepEqual((await call('POST', '/agents/agent-2/answer', 'sess', JSON.stringify(answer))).body, { ok: true });
  let picked = null;
  for (let i = 0; i < 50 && !picked; i++) {
    picked = JSON.parse(await fs.readFile(path.join(dir, 'answers.json'), 'utf8').catch(() => 'null'));
    if (!picked) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(JSON.stringify(picked).includes('Green'), JSON.stringify(picked));
  assert.equal((await call('POST', '/scroll', 'sess', JSON.stringify({ steps: -3, pane: 'agent-2' }))).status, 409, 'Herdr\'s client scrolls it');

  assert.deepEqual((await call('POST', '/agents/agent-2/stop', 'sess', '{}')).body, { stopped: 'agent-2' });
  await assert.rejects(hc('get', '--json', '--', 'agent-2'), 'its terminal is gone');

  // A message from Chat goes in through hc's own send, once the agent is at its prompt: the dev console's stand-in claude.
  const standIn = fileURLToPath(new URL('../console/bin/devChatAgent.mjs', import.meta.url));
  const records = path.join(dir, 'records');
  await fs.writeFile(path.join(dir, 'bin', 'claude'), `#!/bin/sh
exec '${process.execPath}' '${standIn}' claude '${records}' "$PWD" "$@"
`, { mode: 0o755 });
  assert.equal((await call('POST', '/agents', 'sess', JSON.stringify({ agent: 'claude' }))).status, 200);
  for (let i = 0; i < 80 && !/auto mode on/.test(await shown()); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const sent = await call('POST', '/agents/agent-2/send', 'sess', JSON.stringify({ text: 'hello from Chat', id: 'msg-00000001' }));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  let typed = false;
  for (let i = 0; i < 100 && !typed; i++) {
    const files = await fs.readdir(records).catch(() => []);
    for (const f of files) if ((await fs.readFile(path.join(records, f), 'utf8')).includes('hello from Chat')) typed = true;
    if (!typed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(typed, 'the agent got the message');
  assert.deepEqual((await call('GET', '/agents', 'sess')).body.agents[0].deliveredIds, ['msg-00000001']);
  await call('POST', '/agents/agent-2/stop', 'sess', '{}');
});
