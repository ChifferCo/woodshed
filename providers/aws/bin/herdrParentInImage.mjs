#!/usr/bin/env node
// askInImage.mjs's copy for a private session started with `woodshed session new --herdr --parent`: the whole
// entrypoint runs in the real session image with the environment ECS would give it (the fleet builds the session's env
// with herdrParent, the ECS launcher's allowlist filters it, the task definition's variables are added), and the
// console's real session API answers it from here with a stand-in owner: a dummy Claude token (claude opens and is
// never asked anything), no databases, no Claude home, and Agent terminal set to tmux, which --parent overrides.
// Prints the container's log as the start goes, until the agent's terminal is there or the start failed, then leaves
// the container running for the other half, the person's Herdr making that terminal (cli/hc.mjs, startAgentTerminal):
//
//   node woodshed/providers/aws/bin/herdrParentInImage.mjs <image> [entrypoint.sh]
//   # then, from a terminal in this computer's Herdr:
//   hc machine add --name woodshed-<id> --via 'docker exec -i woodshed-herdr-parent-in-image sh -c'
//
// `entrypoint.sh` is copied over the image's, to try a start change before the image is built. Needs Docker and
// `gh auth token`, whose token the session's git fetches with: the container is removed with a kill, so statusd's stop
// never pushes. REPO names the image's repo (owner/name); IN_IMAGE_CONSOLE_HOST the address the container reaches this
// computer at (default host.docker.internal: from a container beside it, its own address on their network).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import { taskDefinitionEnv } from './askInImageEnv.mjs';

const [IMAGE, ENTRYPOINT] = process.argv.slice(2);
if (!IMAGE) {
  console.error('usage: herdrParentInImage.mjs <image> [entrypoint.sh]');
  process.exit(2);
}
const PORT = 7698;
const CONTAINER = 'woodshed-herdr-parent-in-image';
const START_WAIT_MS = 10 * 60_000;
const HOST = process.env.IN_IMAGE_CONSOLE_HOST || 'host.docker.internal';

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
    repo: envValue(process.env, 'REPO') || 'example-org/example-repo', label: 'woodshed', publicUrl: 'https://woodshed.example', maxRunning: 5,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, statusd: async () => ({}) });
  await fleet.createSession({
    kind: 'task', number: null, title: 'herdrParentInImage', startedBy: 'in-image', trigger: 'my-woodshed', owner: 'in-image',
    prompt: 'Say hello, then stop.', options: { agent: 'claude', model: '', effort: '', permissionMode: 'auto' }, herdrParent: true,
  });
  return { fleet, overrides: sessionOverrides(started[0]) };
}

function serve(fleet) {
  const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const handle = createSessionApi({
    fleet,
    tokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) },
    userSettings: {
      claudeToken: async () => 'in-image-dummy-token',
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

const { fleet, overrides } = await privateEnv();
console.log('herdrParentInImage: passed to the task', overrides.map((o) => o.name).join(' '));
const server = await serve(fleet);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-parent-in-image-'));
const envFile = path.join(dir, 'task.env');
const taskEnv = { ...taskDefinitionEnv({ port: PORT }), WOODSHED_CONSOLE_URL: `http://${HOST}:${PORT}` };
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
  docker('rm', '-f', CONTAINER);
  // --init: ECS's init as PID 1 (ecs.tf, initProcessEnabled), which reaps what the start hands it.
  docker('create', '--init', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', '--env-file', envFile, IMAGE, 'session');
  fs.rmSync(dir, { recursive: true });
  if (ENTRYPOINT) docker('cp', ENTRYPOINT, `${CONTAINER}:/opt/woodshed/session/entrypoint.sh`);
  docker('start', CONTAINER);
  console.log(`--- container log (session ${overrides.find((o) => o.name === 'SESSION_ID')?.value})`);
  const until = Date.now() + START_WAIT_MS;
  let log = '';
  while (Date.now() < until && !/Agent's terminal made by its parent|no parent made the agent's terminal|ERROR/.test(log)) {
    if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() !== 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log = printNew();
  }
  printNew();
  const ps = docker('exec', CONTAINER, 'sh', '-c', 'ps -eo pid,ppid,stat,args | awk \'$1 == 1 || /statusd/ || $3 ~ /^Z/\' | grep -v awk || true');
  console.log(`--- processes (the init as pid 1, statusd, and any zombie)\n${ps}`);
  console.log(`--- the agent's terminal\n${docker('exec', CONTAINER, 'sh', '-c', 'hc get --json claude | jq -c "{parent, die_with_parent, keep, cwd}"; hc read claude | grep -m1 "bin/claude" || true')}`);
  console.log(`docker rm -f ${CONTAINER} when done`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}
