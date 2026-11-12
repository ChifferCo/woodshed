#!/usr/bin/env node
// Runs QA of a pull request in the real session image, as askInImage.mjs runs a question: the fleet builds a QA
// session's env, sessionOverrides filters it as ECS does, and the task definition's variables are added. The console's
// real session API and Anthropic proxy answer the container on the host, but the report is kept here instead of being
// written to the pull request. Prints the container's log and the report, then removes the container.
//
//   node providers/aws/bin/qaInImage.mjs <image> <pull request number>
//
// Needs what askInImage.mjs needs: Docker, the image, `gh auth token` and ANTHROPIC_API_KEY. WOODSHED_REPO names the
// repo the pull request is on (default: Woodshed's own, whose dev console is the app). The project file is this
// checkout's. Nothing is posted to GitHub.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createAnthropicProxy } from '../../../console/anthropicProxy.mjs';
import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import { loadProject } from '../../../shared/project.mjs';
import { leakPattern, taskDefinitionEnv } from './askInImageEnv.mjs';

const [IMAGE, NUMBER] = process.argv.slice(2);
if (!IMAGE || !/^\d+$/.test(NUMBER ?? '')) {
  console.error('usage: qaInImage.mjs <image> <pull request number>');
  process.exit(2);
}
const PORT = 7697;
const CONTAINER = 'woodshed-qa-in-image';
const REPORT_WAIT_MS = 45 * 60_000;
const REPO = path.resolve(import.meta.dirname, '../../..');
const PROJECT = loadProject(REPO);
const TASK_DEFINITION_ENV = taskDefinitionEnv({ project: PROJECT, port: PORT });
const repoName = envValue(process.env, 'REPO') || 'ChifferCo/woodshed';

function teamKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  console.error('set ANTHROPIC_API_KEY: the console\'s Anthropic proxy answers the container with it');
  process.exit(2);
}

function pullRequest() {
  const raw = execFileSync('gh', ['pr', 'view', NUMBER, '-R', repoName, '--json', 'title,headRefName,headRefOid,baseRefName'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

// What handleQaLabel creates, without its checks or the running comment.
async function qaEnv(pull) {
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
    repo: repoName, label: 'woodshed', publicUrl: 'https://woodshed.example', maxRunning: 5,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const databases = { available: false, async createForSession() {}, async sweep() {} };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, databases, statusd: async () => ({}) });
  await fleet.createSession({
    kind: 'pr', number: Number(NUMBER), title: `QA: ${pull.title}`, startedBy: 'qaInImage', trigger: 'qa', branch: pull.headRefName,
    qa: { base: pull.baseRefName, sha: pull.headRefOid, heading: '## QA', check: 'QA', commentId: null },
  });
  return { fleet, overrides: sessionOverrides(started[0]) };
}

function serve(fleet, onReport) {
  const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const handle = createSessionApi({
    // The report is kept here: fleet.qaFinished would write it into the pull request's QA comment.
    fleet: { ...fleet, async qaFinished(_session, result) { onReport(result); } },
    tokens: { token: async () => { throw new Error('a QA session must get the read-only token'); } },
    askTokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) },
    anthropic: createAnthropicProxy({ teamKey: teamKey() }),
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  return new Promise((resolve) => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const pull = pullRequest();
const { fleet, overrides } = await qaEnv(pull);
console.log('qaInImage: passed to the task', overrides.map((o) => o.name).join(' '));
let report = null;
const server = await serve(fleet, (result) => { report = result; });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-in-image-'));
const envFile = path.join(dir, 'task.env');
const lines = [...Object.entries(TASK_DEFINITION_ENV).map(([k, v]) => `${k}=${v}`), ...overrides.map((o) => `${o.name}=${o.value}`)];
fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
try {
  docker('rm', '-f', CONTAINER);
  docker('run', '-d', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', '--env-file', envFile, IMAGE, 'session');
  fs.rmSync(dir, { recursive: true });
  const until = Date.now() + REPORT_WAIT_MS;
  while (!report && Date.now() < until && docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() === 'true') {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log(`\n--- container log\n${execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })}`);
  const running = docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() === 'true';
  const leaked = running
    ? docker('exec', CONTAINER, 'bash', '-c', `tmux show-environment -g 2>/dev/null | grep -c -E '${leakPattern({ project: PROJECT })}' || true`).trim()
    : 'unknown, the container exited';
  console.log(`--- secrets left in claude's environment: ${leaked}`);
  if (running) console.log(`--- claude's pane\n${docker('exec', CONTAINER, 'tmux', 'capture-pane', '-p', '-S', '-200', '-t', 'claude')}`);
  console.log(report ? `--- report: ${JSON.stringify(report.verdict)} costUsd=${report.costUsd} sha=${report.sha}\n${report.report}`
    : `--- NO REPORT: open the terminal with \`docker exec -it ${CONTAINER} tmux attach -t claude\``);
  process.exitCode = report && leaked === '0' ? 0 : 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  if (report) docker('rm', '-f', CONTAINER);
  server.close();
}
