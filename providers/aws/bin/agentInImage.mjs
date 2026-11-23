#!/usr/bin/env node
// askInImage.mjs's copy for a private session on Grok Build, Antigravity or OpenCode (shared/agents.cjs): the whole
// entrypoint runs in the real session image with the environment ECS would give it (the fleet builds the session's env
// from New session's options, the ECS launcher's allowlist filters it, the task definition's variables are added), and
// the console's real session API answers it from here with a stand-in owner: a made-up sign-in for the agent (the agent
// opens, and its first call to its provider fails), no databases, no Claude home, and Agent terminal tmux. Prints the
// container's log as the start goes, until the agent is open or the start failed, then the agent's pane, and passes
// when the agent runs in the pane with the session's first message in it:
//
//   node woodshed/providers/aws/bin/agentInImage.mjs <image> <grok|antigravity|opencode> [entrypoint.sh]
//
// `entrypoint.sh` is copied over the image's, to try a start change before the image is built. Needs Docker and
// `gh auth token`, whose token the session's git fetches with: the container is removed with a kill, so statusd's stop
// never pushes. REPO names the repo (owner/name), which an image with no checkout clones at start; IN_IMAGE_CONSOLE_HOST
// the address the container reaches this computer at (default host.docker.internal).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import agents from '../../../shared/agents.cjs';
import { taskDefinitionEnv } from './askInImageEnv.mjs';

const [IMAGE, AGENT, ENTRYPOINT] = process.argv.slice(2);
if (!IMAGE || !agents.OWN_SIGN_IN_AGENTS.includes(AGENT)) {
  console.error(`usage: agentInImage.mjs <image> <${agents.OWN_SIGN_IN_AGENTS.join('|')}> [entrypoint.sh]`);
  process.exit(2);
}
const PORT = 7698;
const CONTAINER = `woodshed-agent-in-image-${AGENT}`;
const START_WAIT_MS = 10 * 60_000;
const HOST = process.env.IN_IMAGE_CONSOLE_HOST || 'host.docker.internal';
const PROMPT = 'Say hello from agentInImage, then stop.';
// Made up, in the shape each agent's own sign-in check takes (shared/agents.cjs, checkSignIn): none reaches a provider.
const SIGN_INS = {
  grok: 'xai-agentInImage-not-a-real-key-0123456789',
  antigravity: 'AIzaSyAgentInImageNotARealKey0123456789',
  opencode: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-agentInImage-not-a-real-key' } }),
};
const REPO = envValue(process.env, 'REPO') || 'ChifferCo/woodshed';

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
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, statusd: async () => ({}) });
  await fleet.createSession({
    kind: 'task', number: null, title: 'agentInImage', startedBy: 'in-image', trigger: 'my-woodshed', owner: 'in-image',
    prompt: PROMPT, options: { agent: AGENT, model: '', effort: '', permissionMode: 'auto' },
  });
  return { fleet, overrides: sessionOverrides(started[0]) };
}

function serve(fleet) {
  const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const handle = createSessionApi({
    fleet,
    tokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) },
    userSettings: {
      claudeToken: async () => null,
      agentAuth: async (login, id) => (id === AGENT ? SIGN_INS[id] : null),
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
console.log('agentInImage: passed to the task', overrides.map((o) => o.name).join(' '));
const server = await serve(fleet);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-in-image-'));
const envFile = path.join(dir, 'task.env');
const taskEnv = { ...taskDefinitionEnv({ port: PORT }), WOODSHED_CONSOLE_URL: `http://${HOST}:${PORT}` };
const passed = new Set(overrides.map((o) => o.name));
// An image with no checkout clones the repo the console names, as the fleet does for a repo no image holds.
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
  docker('rm', '-f', CONTAINER);
  // --init: ECS's init as PID 1 (ecs.tf, initProcessEnabled), which reaps what the start hands it.
  docker('create', '--init', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', '--env-file', envFile, IMAGE, 'session');
  fs.rmSync(dir, { recursive: true });
  if (ENTRYPOINT) docker('cp', ENTRYPOINT, `${CONTAINER}:/opt/woodshed/session/entrypoint.sh`);
  docker('start', CONTAINER);
  console.log(`--- container log (session ${overrides.find((o) => o.name === 'SESSION_ID')?.value}, agent ${AGENT})`);
  const until = Date.now() + START_WAIT_MS;
  let log = '';
  while (Date.now() < until && !/Claude started|ERROR/.test(log)) {
    if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() !== 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log = printNew();
  }
  // The agent takes a few seconds to open and draw the first message.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  log = printNew();
  const command = docker('exec', '-u', 'node', CONTAINER, 'tmux', 'display', '-p', '-t', 'claude', '#{pane_current_command}').trim();
  const pane = docker('exec', '-u', 'node', CONTAINER, 'tmux', 'capture-pane', '-p', '-J', '-S', '-200', '-t', 'claude');
  console.log(`--- the agent's pane (its command: ${command})\n${pane.replace(/\n{3,}/g, '\n\n')}`);
  const ok = /Claude started/.test(log) && agents.agent(AGENT).processNames.includes(command) && pane.includes(PROMPT);
  console.log(ok ? `--- PASSED: ${agents.agent(AGENT).product} runs in the session's pane with its first message`
    : '--- FAILED: no agent in the pane with the first message (the log and pane above say why)');
  process.exitCode = ok ? 0 : 1;
  console.log(`docker rm -f ${CONTAINER} when done`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}
