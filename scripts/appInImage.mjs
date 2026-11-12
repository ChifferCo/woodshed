// Run the actual session image/entrypoint against a public sample repo and real console modules. Only the model
// and personal settings are fixtures: no credentials, AWS, production data, git pushes or paid model calls.
// Build session/Dockerfile for octocat/Hello-World at /work/Hello-World, then:
//   node scripts/appInImage.mjs <image>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createFleet, callStatusd } from '../console/fleet.mjs';
import { createSavedApps } from '../console/savedApps.mjs';
import { createSessionApi } from '../console/sessionApi.mjs';
import { openStore } from '../console/store.mjs';
import { createDockerLauncher } from '../providers/local/dockerLauncher.mjs';
import { sessionOverrides } from '../providers/aws/ecsLauncher.mjs';

const image = process.argv[2];
if (!image) throw new Error('usage: node scripts/appInImage.mjs <session image built for octocat/Hello-World>');
const exec = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-image-smoke-'));
fs.chmodSync(root, 0o755); // The image's uid 1000 reads only the mounted fixture files.
const agentFile = path.join(root, 'agent');
fs.writeFileSync(agentFile, '#!/bin/bash\n[ "${1:-}" != plugin ] || exit 0\nprintf "fixture agent ready\\n❯\\n"\nwhile IFS= read -r line; do printf "%s\\n" "$line" >> /tmp/fixture-agent-input; printf "❯\\n"; done\n', { mode: 0o755 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function docker(...args) {
  const { stdout, stderr } = await exec('docker', args, { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  return (stdout + (args[0] === 'logs' ? stderr : '')).trim();
}
const launched = new Set();
const printed = new Set();
let projectMount = null;
let failNextPull = false;
let restartTimer;
let apiHandler;
const api = http.createServer((req, res) => {
  if (req.url === '/app-config' && failNextPull) {
    failNextPull = false;
    console.log('image proof: closing the console listener during app-config pull');
    req.socket.destroy();
    api.closeAllConnections();
    api.close();
    restartTimer = setTimeout(() => api.listen(port, '0.0.0.0', () => console.log('image proof: console listener restarted')), 1500);
    return;
  }
  apiHandler(req, res).catch((err) => {
    console.error('image proof: API failed', err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise((resolve) => api.listen(0, '0.0.0.0', resolve));
const port = api.address().port;
const userSettings = {
  claudeToken: async () => 'image-smoke-fixture-not-a-token',
  ownFiles: async () => ({}),
  gitIdentity: () => ({ name: 'Image Fixture', email: 'fixture@example.com' }),
};
const config = {
  repo: 'octocat/Hello-World', label: 'woodshed', publicUrl: 'http://console.example', maxRunning: 4, maxPrivatePerPerson: 4,
  limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 180_000 }, sessionEnv: {}, ghToken: null,
};
// The fleet's per-session environment goes through the ECS allowlist too. The console URL is a task-definition
// setting there. The Docker launcher still runs the image's real entrypoint, user, init and published ports.
const local = createDockerLauncher({
  image, memory: '2g', cpus: '2',
  run: async (args, env) => {
    if (args[0] === 'run') {
      launched.add(args[args.indexOf('--name') + 1]);
      args = [args[0], '--mount', `type=bind,source=${agentFile},target=/fixture-agent,readonly`,
        ...(projectMount ? ['--mount', `type=bind,source=${projectMount},target=/work/Hello-World/.woodshed/project.yaml,readonly`] : []), ...args.slice(1)];
    }
    const result = await exec('docker', args, { env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  },
});
local.refFor = (id) => `woodshed-app-smoke-${id}`;
const launcher = { ...local, start: (id, env) => local.start(id, {
  ...Object.fromEntries(sessionOverrides(env).map(({ name, value }) => [name, value])),
  WOODSHED_CONSOLE_URL: `http://host.docker.internal:${port}`,
  WOODSHED_REAL_CLAUDE: '/fixture-agent', // Deterministic model stand-in; records the real tmux prompt, executes nothing.
}) };
let store;
let fleet;
function openConsole() {
  store = openStore(path.join(root, 'state'));
  fleet = createFleet({ config, store, launcher, github: {}, userSettings });
  apiHandler = createSessionApi({ fleet, userSettings, savedApps: createSavedApps({ store, config }) });
}
openConsole();

function app(text) {
  const code = 'import http from "node:http";const text=Buffer.from(process.argv[1],"base64").toString();for(const port of [3001,9000])http.createServer((req,res)=>res.end(text)).listen(port,"127.0.0.1",()=>console.log("fixture listening on "+port));';
  // Keep response text out of JavaScript and shell source; base64 is one shell-safe argument.
  const response = Buffer.from(text).toString('base64');
  return {
    start: `nohup node --input-type=module -e '${code}' '${response}' >/tmp/fixture-app.log 2>&1 & echo $! >/tmp/fixture-app.pid; for i in 1 2 3 4 5; do curl -fsS http://127.0.0.1:3001/ >/dev/null && curl -fsS http://127.0.0.1:9000/ >/dev/null && exit 0; sleep 1; done; exit 1`,
    stop: 'kill "$(cat /tmp/fixture-app.pid)"; for i in 1 2 3 4 5; do if ! curl -fsS http://127.0.0.1:3001/ >/dev/null 2>&1 && ! curl -fsS http://127.0.0.1:9000/ >/dev/null 2>&1; then exit 0; fi; sleep 1; done; exit 1',
    frontendPort: 3001, backendPort: 9000, logs: { app: '/tmp/fixture-app.log' }, howToProve: 'Both ports answer with the fixture text.',
  };
}
async function inSession(session, ...args) {
  return docker('exec', session.ref, ...args);
}
async function writeJson(session, file, value) {
  await inSession(session, 'node', '-e', 'require("fs").writeFileSync(process.argv[1],process.argv[2])', file, JSON.stringify(value));
}
async function until(check, label) {
  let last;
  for (let i = 0; i < 150; i++) {
    try { const result = await check(); if (result) return result; } catch (err) { last = err.message; }
    await sleep(1000);
  }
  throw new Error(`${label} never became ready${last ? `: ${last}` : ''}`);
}
async function startSession(label, owner = null) {
  const s = await fleet.createSession({ kind: 'task', title: label, startedBy: 'fixture', trigger: 'manual', owner, prompt: 'Wait for the image smoke check.' });
  assert.ok(s.endpoint, s.error || 'the Docker launcher returned no endpoint');
  const status = await until(async () => {
    const status = await callStatusd(s, 'GET', '/status');
    return (await inSession(s, 'tmux', 'capture-pane', '-p', '-t', 'claude')).includes('fixture agent ready') && status;
  }, label);
  Object.assign(s, { status: 'running', state: 'done', app: status.app, appSetupSupported: status.appSetupSupported });
  store.save();
  const log = await docker('logs', s.ref);
  assert.match(log, /Claude started/);
  assert.match(log, /statusd: listening/);
  console.log(`image proof: ${label} completed the real entrypoint; app=${status.app}`);
  return s;
}
async function runApp(s, text) {
  await fleet.startApp(s);
  await until(async () => (await callStatusd(s, 'GET', '/status')).app === 'running', 'app');
  for (const port of [3001, 9000]) assert.equal(await inSession(s, 'curl', '-fsS', `http://127.0.0.1:${port}/`), text);
  // Wait for the command's readiness check to exit, rather than testing Stop's interruption of a pending Start.
  await until(async () => /app start finished[\s\S]*?exitCode: 0/.test(await docker('logs', s.ref)), 'start command');
  await fleet.stopApp(s);
  const stopped = await until(async () => {
    const status = await callStatusd(s, 'GET', '/status');
    return status.app === 'stopped' && status;
  }, 'stop command');
  assert.equal(stopped.appServers.frontend, false);
  assert.equal(stopped.appServers.backend, false);
  console.log(`image proof: ${s.title}: both ports returned ${JSON.stringify(text)}, then both closed`);
}
async function clean(s, head) {
  assert.equal(await inSession(s, 'git', 'status', '--porcelain'), '');
  assert.equal(await inSession(s, 'git', 'rev-parse', 'HEAD'), head);
  console.log(`image proof: ${s.title}: clean checkout and unchanged HEAD`);
}
async function finish(s) {
  console.log(`image proof: container log for ${s.title}\n${await docker('logs', s.ref)}`);
  printed.add(s.ref);
  await launcher.stop(s.ref);
  launched.delete(s.ref);
  Object.assign(s, { status: 'stopped', endpoint: null });
  store.save();
}
try {
  console.log('image proof: image', await docker('image', 'inspect', '--format', '{{.Id}}', image));
  const first = await startSession('set up app', 'fixture-one');
  assert.equal(first.app, 'none');
  const head = await inSession(first, 'git', 'rev-parse', 'HEAD');
  await fleet.setupApp(first, { destination: 'repository' });
  await until(async () => (await inSession(first, 'cat', '/tmp/fixture-agent-input')).includes('Leave the changes uncommitted'), 'repository prompt');
  await fleet.setupApp(first);
  await until(async () => (await inSession(first, 'cat', '/tmp/fixture-agent-input')).includes('Save for This Woodshed'), 'woodshed prompt');
  // Stub the model's discovery output; run its actual commands and helper inside the real image before saving.
  const saved = app('saved app works');
  await inSession(first, 'bash', '-c', saved.start);
  for (const port of [3001, 9000]) assert.equal(await inSession(first, 'curl', '-fsS', `http://127.0.0.1:${port}/`), 'saved app works');
  await inSession(first, 'bash', '-c', saved.stop);
  await writeJson(first, '/tmp/app.json', saved);
  for (const action of ['check', 'save']) console.log(await inSession(first, 'node', '/opt/woodshed/session/appConfig.mjs', action, '/tmp/app.json'));
  await runApp(first, 'saved app works');
  await clean(first, head);
  await finish(first);

  // Recreate the console modules from disk, then start a genuinely new container and owner with no saved home/cache.
  openConsole();
  const second = await startSession('reuse after console restart', 'fixture-two');
  assert.equal(second.app, 'stopped');
  await runApp(second, 'saved app works');
  await clean(second, head);
  await finish(second);

  projectMount = path.join(root, 'project.yaml');
  fs.writeFileSync(projectMount, JSON.stringify({ version: 1, app: app('repository app wins') }));
  const third = await startSession('repository precedence');
  await runApp(third, 'repository app wins');
  assert.equal(await inSession(third, 'git', 'rev-parse', 'HEAD'), head);
  assert.match(await inSession(third, 'git', 'status', '--porcelain'), /\?\? \.woodshed\//);
  await finish(third);
  projectMount = null;

  failNextPull = true;
  const fourth = await startSession('console restart during startup');
  assert.match(await docker('logs', fourth.ref), /appConfig: console did not answer, retrying/);
  await runApp(fourth, 'saved app works');
  await clean(fourth, head);
  await finish(fourth);
  console.log('image proof: PASS — setup, clean reuse, repository precedence and startup retry in the actual session image');
} finally {
  for (const ref of launched) {
    if (!printed.has(ref)) console.log(`image proof: failed container log\n${await docker('logs', ref).catch(() => 'unavailable')}`);
    await launcher.stop(ref);
  }
  clearTimeout(restartTimer);
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
