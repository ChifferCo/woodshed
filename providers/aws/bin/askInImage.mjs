#!/usr/bin/env node
// Runs a question from Slack in the real session image, with the environment ECS would give it: the fleet builds the
// session's env, the ECS launcher's allowlist (sessionOverrides) filters it, and the task definition's variables are
// added, with dummy values for its secrets. The console's real session API and Anthropic proxy answer the container,
// on the host. Prints the container's log and the answer it posted, then removes the container.
//
//   node woodshed/providers/aws/bin/askInImage.mjs <image> [question]
//
// Needs Docker, the image (the installation's ECR `<name_prefix>-session` repository, from Terraform's
// `ecr_repositories` output, with `:latest`, after `aws ecr get-login-password | docker login`; or a tag built
// locally), `gh auth token` for a GitHub token, and ANTHROPIC_API_KEY in the environment. Nothing
// reaches Slack. WOODSHED_INSTALL_SECRET_PAIRS, as the console's (`secret=VARIABLE` pairs, from its compose.yml), adds
// the installation's install secrets to the task definition's, with dummy values; without it there are none.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createAnthropicProxy } from '../../../console/anthropicProxy.mjs';
import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { installSecrets } from '../../../console/config.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import { loadProject } from '../../../shared/project.mjs';
import { leakPattern, taskDefinitionEnv } from './askInImageEnv.mjs';

const IMAGE = process.argv[2];
if (!IMAGE) {
  console.error('usage: askInImage.mjs <image> [question]: the image is the installation\'s session image (Terraform\'s ecr_repositories output, :latest) or a local tag');
  process.exit(2);
}
const QUESTION = process.argv[3] || 'What happens when someone adds the woodshed label to a pull request?';
const PORT = 7697;
const CONTAINER = 'woodshed-ask-in-image';
const ANSWER_WAIT_MS = 10 * 60_000;
const REPO = path.resolve(import.meta.dirname, '../../../..');

// As in AWS: the task definition's own variables, its secrets those of the env files the repo's project file lists and
// the installation's install secrets.
const PROJECT = loadProject(REPO);
const INSTALL_SECRETS = installSecrets(process.env, PROJECT.envFiles.filter((file) => file.secret));
const TASK_DEFINITION_ENV = taskDefinitionEnv({ project: PROJECT, installSecrets: INSTALL_SECRETS, port: PORT });

function teamKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  console.error('set ANTHROPIC_API_KEY: the console\'s Anthropic proxy answers the container with it');
  process.exit(2);
}

async function askEnv() {
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
  const databases = { available: true, async createForSession() { throw new Error('an ask session must not get databases'); }, async sweep() {} };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, databases, statusd: async () => ({}) });
  await fleet.createSession({
    kind: 'ask', number: null, title: QUESTION, startedBy: 'slack:U1', trigger: 'slack', prompt: QUESTION,
    slack: { channel: 'C1', threadTs: '1.1', user: 'U1', name: 'askInImage' },
  });
  return { fleet, overrides: sessionOverrides(started[0]) };
}

function serve(fleet, onAnswer) {
  const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const handle = createSessionApi({
    fleet,
    tokens: { token: async () => { throw new Error('an ask session must get the read-only token'); } },
    askTokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) },
    asks: { async answer(_session, text) { onAnswer(text); return true; } },
    anthropic: createAnthropicProxy({ teamKey: teamKey() }),
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  return new Promise((resolve) => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const { fleet, overrides } = await askEnv();
console.log('askInImage: passed to the task', overrides.map((o) => o.name).join(' '));
let answer = null;
const server = await serve(fleet, (text) => { answer = text; });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-in-image-'));
const envFile = path.join(dir, 'task.env');
const lines = [...Object.entries(TASK_DEFINITION_ENV).map(([k, v]) => `${k}=${v}`), ...overrides.map((o) => `${o.name}=${o.value}`)];
fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
try {
  docker('rm', '-f', CONTAINER);
  docker('run', '-d', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', '--env-file', envFile, IMAGE, 'session');
  fs.rmSync(dir, { recursive: true });
  const until = Date.now() + ANSWER_WAIT_MS;
  while (!answer && Date.now() < until && docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() === 'true') {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  // `docker logs` prints the container's stderr on its own stderr, and the entrypoint's errors go there.
  console.log(`\n--- container log\n${execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })}`);
  // A start that died leaves nothing to look inside.
  const running = docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() === 'true';
  const leaked = running
    ? docker('exec', CONTAINER, 'bash', '-c', `tmux show-environment -g 2>/dev/null | grep -c -E '${leakPattern({ project: PROJECT, installSecrets: INSTALL_SECRETS })}' || true`).trim()
    : 'unknown, the container exited';
  console.log(`--- secrets left in claude's environment: ${leaked}`);
  console.log(answer ? `--- answer posted (${answer.length} chars)\n${answer}`
    : running ? `--- NO ANSWER: open the terminal with \`docker exec -it ${CONTAINER} tmux attach -t claude\``
      : `--- NO ANSWER: the container exited (${docker('inspect', '-f', '{{.State.ExitCode}}', CONTAINER).trim()}); its log is above`);
  process.exitCode = answer && leaked === '0' ? 0 : 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  if (answer) docker('rm', '-f', CONTAINER);
  server.close();
}
