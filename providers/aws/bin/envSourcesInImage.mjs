#!/usr/bin/env node
// askInImage.mjs's copy for a console whose embedding program gives an env file's installation values from a source of
// its own (console/installation.mjs, `envSources`): a private claude session's whole start runs in the real session
// image, with this checkout's session/ and shared/ copied over the image's, and the console's real session API and real
// repo settings (console/repoSettings.mjs) answer it from here. The console keeps typed values for two env files, and a
// made-up source, "Vault", is on for one of them. Prints the console's lines and the container's log as the start goes,
// then the names of the variables in each written env file, never a value, and passes when the file whose source is on
// holds the source's variables and not the typed ones, and the other its typed one:
//
//   node woodshed/providers/aws/bin/envSourcesInImage.mjs <image>
//
// Needs Docker. The session clones REPO (owner/name, default octocat/Hello-World): a public repo with no project file
// of its own, so the installation's file for it, written here and named by WOODSHED_PROJECT_FILES_DIR, is the session's,
// with the two env files. The container is handed no GitHub login of yours and a made-up Claude token, so claude opens
// and its first call fails: the env files are written before it. IN_IMAGE_CONSOLE_HOST is the address the container
// reaches this computer at (default host.docker.internal), and IN_IMAGE_NETWORK the Docker network to put it on, where
// this computer is itself a container on one. The container is removed with a kill, so statusd's stop never pushes.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { defaultProject } from '../../../console/projects.mjs';
import { createRepoSettings } from '../../../console/repoSettings.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import { parseProject } from '../../../shared/project.mjs';
import { taskDefinitionEnv } from './askInImageEnv.mjs';

const [IMAGE] = process.argv.slice(2);
if (!IMAGE) {
  console.error('usage: envSourcesInImage.mjs <image>');
  process.exit(2);
}
const PORT = 7697;
const CONTAINER = 'woodshed-env-sources-in-image';
const START_WAIT_MS = 10 * 60_000;
const HOST = process.env.IN_IMAGE_CONSOLE_HOST || 'host.docker.internal';
const NETWORK = process.env.IN_IMAGE_NETWORK || null;
const WOODSHED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO = envValue(process.env, 'REPO') || 'octocat/Hello-World';
// The installation's project file for the repo, and the same as the console reads it.
const ENV_FILES = [{ path: 'api/.env', defaults: ['LOG_LEVEL=info'] }, { path: 'worker/.env' }];
const PROJECT_YAML = 'version: 1\nenvFiles:\n  - path: api/.env\n    defaults:\n      - LOG_LEVEL=info\n  - path: worker/.env\n';
// Made up, all of it. What an admin typed for each env file, and what the source holds for the one it is on for.
const TYPED = { 'api-env': 'API_URL=http://typed.example\nSENTRY_DSN=typed-made-up\n', 'worker-env': 'QUEUE=typed-made-up\n' };
const VAULT = { 'api-env': 'API_URL=https://api.vault.example\nAPI_TOKEN=vault-made-up\nQUEUE_URL=https://queue.vault.example\n' };
const namesIn = (text) => text.split('\n').filter(Boolean).map((line) => line.split('=')[0]);
// What each written file must name: the repo's default and the source's, never the typed SENTRY_DSN; and the typed one.
const EXPECTED = { 'api/.env': ['LOG_LEVEL', ...namesIn(VAULT['api-env'])], 'worker/.env': namesIn(TYPED['worker-env']) };

async function privateEnv() {
  const started = [];
  const launcher = {
    kind: 'fake',
    refFor: (id) => `c-${id}`,
    async start(id, env) { started.push(env); return { ref: `c-${id}`, host: '127.0.0.1', termPort: 1, statusPort: 2 }; },
    async taskState() { return { alive: true }; },
    async logTail() { return ''; },
    async stop() {},
  };
  // As in AWS: no GH_TOKEN and no Anthropic key for sessions.
  const config = {
    repo: REPO, label: 'woodshed', publicUrl: 'https://woodshed.example', maxRunning: 5,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const store = { state: { sessions: [], github: null }, save() {} };
  const fleet = createFleet({ config, store, launcher, github: {}, statusd: async () => ({}) });
  await fleet.createSession({
    kind: 'task', number: null, title: 'envSourcesInImage', startedBy: 'in-image', trigger: 'my-woodshed', owner: 'in-image',
    prompt: 'Say hello, then stop.', options: { agent: 'claude', model: '', effort: '', permissionMode: 'auto' },
  });
  return { fleet, config, store, overrides: sessionOverrides(started[0]) };
}

// The console's real repo settings over a store in memory, with a program's source on for one env file.
async function repoSettingsWithSource({ config, store }) {
  const values = new Map();
  const secrets = {
    async read(name) { return values.get(name) ?? null; },
    async save(name, value) { values.set(name, value); },
    async remove(name) { values.delete(name); },
  };
  const { envFiles } = parseProject({ version: 1, envFiles: ENV_FILES });
  const repoSettings = createRepoSettings({
    store, secrets, config,
    readerOf: () => ({ repoLayer: async () => ({ envFiles, env: {}, rules: null, setup: null }) }),
    envSources: {
      async view() { return null; },
      async forSession() { return VAULT; },
    },
  });
  const project = defaultProject(config).name;
  for (const [key, text] of Object.entries(TYPED)) await repoSettings.saveInstallation({ project, key, text, by: 'in-image' });
  return repoSettings;
}

function serve(fleet, repoSettings) {
  const ghToken = process.env.IN_IMAGE_GH_TOKEN || 'in-image-no-github-token';
  const handle = createSessionApi({
    fleet, repoSettings,
    tokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) },
    userSettings: {
      claudeToken: async () => 'in-image-dummy-token',
      codexAuth: async () => null,
      ownFiles: async () => ({}),
      gitIdentity: () => ({ name: null, email: null }),
      terminal: () => 'tmux',
    },
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  return new Promise((resolve) => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const logOf = () => execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Run inside the container: the names each written env file sets, in the clone the start made. Never a value.
const NAMES = `
for file in api/.env worker/.env; do
  path=$(ls -d /work/*/"$file" 2>/dev/null | head -1)
  printf '%s:' "$file"
  [ -z "$path" ] || grep -v '^[[:space:]]*#' "$path" | grep '=' | cut -d= -f1 | tr '\\n' ' ' | sed 's/^/ /; s/ $//'
  echo
done`;

const { fleet, config, store, overrides } = await privateEnv();
console.log('envSourcesInImage: typed values kept for', Object.entries(TYPED).map(([key, text]) => `${key} (${namesIn(text).join(' ')})`).join(', '),
  '· the source is on for', Object.entries(VAULT).map(([key, text]) => `${key} (${namesIn(text).join(' ')})`).join(', '));
const repoSettings = await repoSettingsWithSource({ config, store });
console.log('envSourcesInImage: passed to the task', overrides.map((o) => o.name).join(' '));
const server = await serve(fleet, repoSettings);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sources-in-image-'));
const envFile = path.join(dir, 'task.env');
const [owner, name] = REPO.split('/');
fs.mkdirSync(path.join(dir, 'project-files', owner), { recursive: true });
fs.writeFileSync(path.join(dir, 'project-files', owner, `${name}.yaml`), PROJECT_YAML, { mode: 0o644 });
const taskEnv = { ...taskDefinitionEnv({ port: PORT }), WOODSHED_CONSOLE_URL: `http://${HOST}:${PORT}`, WOODSHED_PROJECT_FILES_DIR: '/opt/woodshed-project-files' };
const passed = new Set(overrides.map((o) => o.name));
// The session works in a clone of the repo the console names, as the fleet names one no image holds.
if (!passed.has('PROJECT_REPO')) overrides.push({ name: 'PROJECT_REPO', value: REPO });
const lines = [...Object.entries(taskEnv).map(([k, v]) => `${k}=${v}`), ...overrides.map((o) => `${o.name}=${o.value}`)];
fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
let printed = 0;
const printNew = () => {
  const log = logOf();
  process.stdout.write(log.slice(printed));
  printed = log.length;
  return log;
};
try {
  try { docker('rm', '-f', CONTAINER); } catch { /* none to remove */ }
  // --init: ECS's init as PID 1 (ecs.tf, initProcessEnabled), which reaps what the start hands it.
  docker('create', '--init', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', ...(NETWORK ? ['--network', NETWORK] : []), '--env-file', envFile, IMAGE, 'session');
  // This checkout's start over the image's, so a change is tried before the image is built; and the project file.
  docker('cp', `${path.join(WOODSHED, 'session')}/.`, `${CONTAINER}:/opt/woodshed/session/`);
  docker('cp', `${path.join(WOODSHED, 'shared')}/.`, `${CONTAINER}:/opt/woodshed/shared/`);
  docker('cp', path.join(dir, 'project-files'), `${CONTAINER}:/opt/woodshed-project-files`);
  docker('start', CONTAINER);
  console.log(`--- container log (session ${overrides.find((o) => o.name === 'SESSION_ID')?.value})`);
  const until = Date.now() + START_WAIT_MS;
  let log = '';
  while (Date.now() < until && !/Claude started|ERROR/.test(log)) {
    if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() !== 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log = printNew();
  }
  log = printNew();
  const running = docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() === 'true';
  const names = running ? docker('exec', '-u', 'node', CONTAINER, 'bash', '-c', NAMES).trim() : '';
  console.log(`--- the variables each written env file names\n${names || '(the container had stopped)'}`);
  const written = Object.fromEntries(names.split('\n').filter(Boolean).map((line) => [line.split(':')[0], line.split(':')[1].trim().split(' ').filter(Boolean)]));
  const ok = /Claude started/.test(log) && Object.entries(EXPECTED).every(([file, wanted]) => JSON.stringify(written[file]) === JSON.stringify(wanted));
  console.log(ok ? '--- PASSED: the env file whose source is on names the source\'s variables, not the typed ones; the other its typed one'
    : `--- FAILED: expected ${JSON.stringify(EXPECTED)} (the log above says why)`);
  process.exitCode = ok ? 0 : 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  try { docker('rm', '-f', CONTAINER); } catch { /* already gone */ }
  server.close();
}
