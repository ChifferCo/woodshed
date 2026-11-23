#!/usr/bin/env node
// herdrParentInImage.mjs's copy for the agents a private session's owner starts beside its own (session/agents.mjs):
// a private claude session's whole start runs in the real session image with the environment ECS would give it (the
// fleet builds its env, the ECS launcher's allowlist filters it, the task definition's variables are added), and the
// console's real session API answers it from here with a stand-in owner: a dummy Claude token (claude opens and is never
// asked anything that needs it), no databases, no Claude home. The agents are started on statusd's own route, as the
// console would with no Codex sign-in saved: the Codex agent runs on the team key.
// Once claude is up it checks, inside the container:
//   - the start wrote the extra agents' claude flags and made codex's home (`configureCodex beside`)
//   - statusd's POST /agents starts a claude and a codex, each in a tmux session of its own, and GET /agents lists them
//   - the TUI tab's ttyd, run as the entrypoint runs it, attaches to the agent the URL names (`?arg=agent-2`), and to
//     the session's own without one, through the same websocket the browser's ttyd page opens
// and prints PASSED or FAILED with the container's log.
//
//   node woodshed/providers/aws/bin/agentsInImage.mjs <image>
//
// The checkout's session/ and shared/ are copied over the image's, to try a start change before the image is built.
// Needs Docker and `gh auth token`, whose token the session's git fetches with: the container is removed with a kill,
// so statusd's stop never pushes. REPO names the image's repo (owner/name); IN_IMAGE_CONSOLE_HOST the address the
// container reaches this computer at (default host.docker.internal: from a container beside it, its own address on
// their network).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import { taskDefinitionEnv } from './askInImageEnv.mjs';

const [IMAGE] = process.argv.slice(2);
if (!IMAGE) {
  console.error('usage: agentsInImage.mjs <image>');
  process.exit(2);
}
const PORT = 7699;
const CONTAINER = 'woodshed-agents-in-image';
const START_WAIT_MS = 10 * 60_000;
const HOST = process.env.IN_IMAGE_CONSOLE_HOST || 'host.docker.internal';
const WOODSHED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The agent's first message, which its pane shows: how the TUI's websocket tells it from the session's own.
const MARK = 'agents-in-image-marker';

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
  const config = {
    repo: envValue(process.env, 'REPO') || 'example-org/example-repo', label: 'woodshed', publicUrl: 'https://woodshed.example', maxRunning: 5,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, statusd: async () => ({}) });
  await fleet.createSession({
    kind: 'task', number: null, title: 'agentsInImage', startedBy: 'in-image', trigger: 'my-woodshed', owner: 'in-image',
    prompt: 'Say hello, then stop.', options: { agent: 'claude', model: '', effort: '', permissionMode: 'auto' },
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

// Run inside the container with its own environment: statusd's routes, then the TUI's websocket as a browser opens it.
const CHECK = `
const token = process.env.SESSION_TOKEN;
const term = process.env.TERMINAL_TOKEN || token;
const call = async (method, route, body) => {
  const res = await fetch('http://127.0.0.1:7682' + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
// ttyd's own client: the websocket at <base>/ws with the page's query, its first message the credential and size.
function tui(query) {
  return new Promise((resolve) => {
    // The Basic credential on the upgrade, as the console's proxy adds it to the browser's (console/terminalProxy.mjs).
    const ws = new WebSocket('ws://127.0.0.1:7681/term/' + process.env.SESSION_ID + '/ws' + query,
      { protocols: ['tty'], headers: { authorization: 'Basic ' + Buffer.from('woodshed:' + term).toString('base64') } });
    ws.binaryType = 'arraybuffer';
    let seen = '';
    ws.onopen = () => ws.send(JSON.stringify({ AuthToken: Buffer.from('woodshed:' + term).toString('base64'), columns: 160, rows: 40 }));
    ws.onmessage = (e) => {
      const data = Buffer.from(e.data);
      if (data[0] === 0x30) seen += data.subarray(1).toString('utf8');
    };
    setTimeout(() => { ws.close(); resolve(seen); }, 6000);
  });
}
const out = {};
out.started = [await call('POST', '/agents', { agent: 'claude', model: 'sonnet', prompt: '${MARK}' }), await call('POST', '/agents', { agent: 'codex', permissionMode: 'plan' })]
  .map((r) => ({ status: r.status, id: r.body.agent?.id ?? null, agent: r.body.agent?.agent ?? null, error: r.body.error ?? null }));
await new Promise((r) => setTimeout(r, 15000));
out.listed = (await call('GET', '/agents')).body.agents?.map((a) => ({ id: a.id, agent: a.agent, model: a.model, permissionMode: a.permissionMode, state: a.state }));
out.statusAgents = ((await call('GET', '/status')).body.agents ?? []).length;
const agentScreen = await tui('?arg=agent-2');
const ownScreen = await tui('');
out.tuiAgent = { bytes: agentScreen.length, hasMark: agentScreen.includes('${MARK}') };
out.tuiOwn = { bytes: ownScreen.length, hasMark: ownScreen.includes('${MARK}'), hasOwnPrompt: ownScreen.includes('Say hello') };
console.log(JSON.stringify(out));
`;

const { fleet, overrides } = await privateEnv();
console.log('agentsInImage: passed to the task', overrides.map((o) => o.name).join(' '));
const server = await serve(fleet);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-image-'));
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
  // The checkout's session and shared code over the image's: the start as this branch would ship it.
  docker('cp', `${path.join(WOODSHED, 'session')}/.`, `${CONTAINER}:/opt/woodshed/session/`);
  docker('cp', `${path.join(WOODSHED, 'shared')}/.`, `${CONTAINER}:/opt/woodshed/shared/`);
  docker('start', CONTAINER);
  console.log(`--- container log (session ${overrides.find((o) => o.name === 'SESSION_ID')?.value})`);
  const until = Date.now() + START_WAIT_MS;
  let log = '';
  while (Date.now() < until && !/Claude started|ERROR/.test(log)) {
    if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() !== 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log = printNew();
  }
  // statusd listens once the start hands over to it.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  log = printNew();
  const files = docker('exec', CONTAINER, 'sh', '-c', 'for f in /tmp/woodshed-agent-claude-flags /tmp/woodshed-codex-ready; do [ -e "$f" ] && echo "$f: there" || echo "$f: missing"; done; ps -eo args | grep -m1 "[t]tyd --writable --url-arg" | sed "s/--credential [^ ]*/--credential <hidden>/"');
  console.log(`--- the start's files and the TUI's ttyd\n${files}`);
  // Not execFileSync: the session API here answers the session (its git's token) while the check runs.
  const checked = (await promisify(execFile)('docker', ['exec', CONTAINER, 'node', '--input-type=module', '-e', CHECK], { encoding: 'utf8' })).stdout.trim();
  console.log(`--- statusd's /agents and the TUI's websocket\n${checked}`);
  const tmux = docker('exec', CONTAINER, 'tmux', 'ls');
  console.log(`--- tmux sessions\n${tmux}`);
  log = printNew();
  const out = JSON.parse(checked.split('\n').at(-1));
  const passed = /statusd: Codex agent beside claude set up \{ own: false \}/.test(log)
    && /\/tmp\/woodshed-agent-claude-flags: there/.test(files) && /\/tmp\/woodshed-codex-ready: there/.test(files) && /woodshed-attach/.test(files)
    && out.started.every((s) => s.status === 200) && out.listed?.length === 2 && out.statusAgents === 2
    && /^agent-2:/m.test(tmux) && /^agent-3:/m.test(tmux) && /^claude:/m.test(tmux)
    && out.tuiAgent.hasMark && !out.tuiOwn.hasMark && out.tuiOwn.bytes > 0;
  console.log(passed ? '--- PASSED: the start wrote what the agents need, statusd started a claude and a codex beside its own, and the TUI attaches to each'
    : '--- FAILED: see above');
  process.exitCode = passed ? 0 : 1;
  console.log(`docker rm -f ${CONTAINER} when done`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
}
