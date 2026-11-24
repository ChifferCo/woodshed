#!/usr/bin/env node
// agentInImage.mjs's copy for a review session whose reviewers are Grok Build and OpenCode on the pull request author's
// own sign-in (console/reviewAgents.mjs): the whole entrypoint runs in the real session image with the environment ECS
// would give it (the fleet builds the review's env, the ECS launcher's allowlist filters it, the task definition's
// variables are added), and the console's real session API, with its real review agent proxy (reviewAgentProxy.mjs),
// answers it from here. The author's sign-ins are made up: an xAI key for Grok Build, an Anthropic API key in OpenCode's
// auth.json. The proxy sends each model call to a recording stand-in upstream on this computer, never to xAI or
// Anthropic, which answers the model list and refuses each turn, so each reviewer ends without a verdict. The review's
// report is kept here, never sent to GitHub. Passes when each reviewer started in review mode and reached the console's
// proxy with the session's token alone, and the proxy sent its calls on with the made-up sign-in in its place:
//
//   node woodshed/providers/aws/bin/reviewInImage.mjs <image> [pull request number]
//
// Needs Docker and `gh auth token`, whose token the session's git and gh read the pull request with (nothing is written
// to GitHub). REPO names the repo (owner/name, default this one), which an image with no checkout clones at start;
// IN_IMAGE_CONSOLE_HOST the address the container reaches this computer at (default host.docker.internal).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { createReviewAgentProxy, isReviewAgentPath, reviewAgentTokenOf } from '../../../console/reviewAgentProxy.mjs';
import { envValue } from '../../../shared/envNames.mjs';
import { taskDefinitionEnv } from './askInImageEnv.mjs';

const [IMAGE, NUMBER = '335'] = process.argv.slice(2);
if (!IMAGE || !/^\d+$/.test(NUMBER)) {
  console.error('usage: reviewInImage.mjs <image> [pull request number]');
  process.exit(2);
}
const PORT = 7699;
const CONTAINER = 'woodshed-review-in-image';
const START_WAIT_MS = 10 * 60_000;
const HOST = process.env.IN_IMAGE_CONSOLE_HOST || 'host.docker.internal';
const REPO = envValue(process.env, 'REPO') || 'ChifferCo/woodshed';
const AUTHOR = 'in-image';
// Made up, in the shape each agent's own sign-in check takes (shared/agents.cjs, checkSignIn): none reaches a provider.
const SIGN_INS = {
  grok: 'xai-reviewInImage-not-a-real-key-0123456789',
  opencode: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-reviewInImage-not-a-real-key' } }),
};
const OPENCODE_KEY = JSON.parse(SIGN_INS.opencode).anthropic.key;

// The stand-in for xAI's and Anthropic's APIs: records each call, answers a model list, refuses each turn. It keeps
// which header carried a credential and whether it was the made-up sign-in, never a header's value, so nothing printed
// below can hold a key.
const upstreamCalls = [];
function upstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const { authorization, 'x-api-key': apiKey } = req.headers;
      upstreamCalls.push({
        method: req.method,
        url: req.url,
        carried: [authorization && 'authorization', apiKey && 'x-api-key'].filter(Boolean),
        grokKey: authorization === `Bearer ${SIGN_INS.grok}`,
        opencodeKey: apiKey === OPENCODE_KEY,
      });
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'grok-build', object: 'model', owned_by: 'xai' }] }));
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'the stand-in upstream refuses every turn' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function reviewEnv() {
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
    repo: REPO, label: 'woodshed', publicUrl: 'https://woodshed.example', maxRunning: 5,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, statusd: async () => ({}) });
  const pull = JSON.parse(execFileSync('gh', ['pr', 'view', NUMBER, '-R', REPO, '--json', 'headRefName,headRefOid,baseRefName'], { encoding: 'utf8' }));
  // What fleet.startReviewNow records for a review whose author picked Grok Build and OpenCode, on their own sign-ins.
  await fleet.createSession({
    kind: 'pr', number: Number(NUMBER), title: 'Review: reviewInImage', startedBy: AUTHOR, trigger: 'review', branch: pull.headRefName,
    review: {
      base: pull.baseRefName, sha: pull.headRefOid, heading: '## Claude review', author: null, check: null, commentId: null,
      agents: ['grok', 'opencode'], ownSignIns: { grok: { login: AUTHOR, via: 'key' }, opencode: { login: AUTHOR, provider: 'anthropic' } },
    },
  });
  return { fleet, overrides: sessionOverrides(started[0]) };
}

const proxyCalls = [];
const reports = [];
function serve(fleet, up) {
  const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const userSettings = {
    claudeToken: async () => null,
    ownFiles: async () => ({}),
    gitIdentity: () => ({ name: null, email: null }),
    terminal: () => 'tmux',
    usesOwnAgentForReviews: (login) => login === AUTHOR,
    agentAuth: async (login, id) => (login === AUTHOR ? SIGN_INS[id] ?? null : null),
  };
  const reviewAgentProxy = createReviewAgentProxy({
    userSettings,
    grokUpstreams: { key: `${up}/xai/v1`, login: `${up}/grok-login/v1` },
    opencodeUpstreams: { anthropic: `${up}/anthropic` },
  });
  // A review reads GitHub with the session API's read-only token: here, this computer's own, used only to read.
  const tokens = { token: async () => ({ token: ghToken, expiresAt: Date.now() + 3_600_000 }) };
  const handle = createSessionApi({ fleet, tokens, askTokens: tokens, userSettings, reviewAgentProxy });
  const token = fleet.sessions()[0].token;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://console').pathname;
    if (isReviewAgentPath(pathname)) proxyCalls.push({ method: req.method, url: req.url, sessionToken: reviewAgentTokenOf(req.headers) === token });
    // The verdict is kept here: the real route would submit it on GitHub.
    if (pathname === '/review-report') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { reports.push(body); res.writeHead(204).end(); });
      return;
    }
    handle(req, res);
  });
  return new Promise((resolve) => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const logOf = () => execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const up = await upstream();
const upUrl = `http://127.0.0.1:${up.address().port}`;
const { fleet, overrides } = await reviewEnv();
console.log('reviewInImage: passed to the task', overrides.map((o) => o.name).join(' '));
const server = await serve(fleet, upUrl);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-in-image-'));
const envFile = path.join(dir, 'task.env');
const taskEnv = { ...taskDefinitionEnv({ port: PORT }), WOODSHED_CONSOLE_URL: `http://${HOST}:${PORT}` };
const passed = new Set(overrides.map((o) => o.name));
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
  docker('create', '--init', '--name', CONTAINER, '--add-host', 'host.docker.internal:host-gateway', '--env-file', envFile, IMAGE, 'session');
  fs.rmSync(dir, { recursive: true });
  docker('start', CONTAINER);
  console.log(`--- container log (review session ${overrides.find((o) => o.name === 'SESSION_ID')?.value} of #${NUMBER})`);
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until && !reports.length) {
    if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() !== 'true') break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    printNew();
  }
  printNew();
  if (docker('inspect', '-f', '{{.State.Running}}', CONTAINER).trim() !== 'true') throw new Error('the session stopped before its review reported: its log above says why');
  const pane = docker('exec', '-u', 'node', CONTAINER, 'tmux', 'capture-pane', '-p', '-J', '-S', '-200', '-t', 'claude');
  console.log(`--- the review's pane\n${pane.replace(/\n{3,}/g, '\n\n')}`);
  const env = docker('exec', '-u', 'node', CONTAINER, 'bash', '-c', 'tmux show-environment -t claude; cat /proc/1/environ | tr "\\0" "\\n"');
  const leaked = Object.values(SIGN_INS).some((v) => env.includes(v)) || /xai-reviewInImage|sk-ant-reviewInImage/.test(docker('exec', '-u', 'node', CONTAINER, 'bash', '-c', 'grep -rl "reviewInImage-not-a-real" /home/node /tmp /work 2>/dev/null || true'));
  console.log('--- calls the console\'s proxy got', JSON.stringify(proxyCalls));
  console.log('--- calls the stand-in upstream got (which header carried a credential, and whether it was the made-up sign-in)', JSON.stringify(upstreamCalls));
  console.log('--- the report', reports[0] ? JSON.stringify(JSON.parse(reports[0]).conclusion) : 'none');
  const grokCalls = upstreamCalls.filter((c) => c.url.startsWith('/xai/v1/'));
  const opencodeCalls = upstreamCalls.filter((c) => c.url.startsWith('/anthropic/v1/'));
  const checks = {
    'the review started in review mode': /mode: review|SESSION_MODE=review|Review of pull request/.test(logOf() + pane),
    'grok started in review mode': /Grok Build reviews on the author's own sign-in/.test(pane),
    'opencode started in review mode': /OpenCode reviews on the author's own anthropic key/.test(pane),
    'every call reached the console\'s proxy with the session\'s token alone': proxyCalls.length > 0 && proxyCalls.every((c) => c.sessionToken),
    'grok\'s first model call reached the console\'s proxy': proxyCalls.some((c) => c.url.startsWith('/grok/v1/')),
    'the proxy sent grok\'s calls on with the made-up xAI key': grokCalls.length > 0 && grokCalls.every((c) => c.grokKey),
    'the proxy sent opencode\'s calls on with the made-up Anthropic key': opencodeCalls.length > 0 && opencodeCalls.every((c) => c.opencodeKey),
    'no made-up sign-in is anywhere in the session': !leaked,
    'the review reported': reports.length === 1,
  };
  for (const [what, ok] of Object.entries(checks)) console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? '--- PASSED: Grok Build and OpenCode review on the author\'s sign-in, which only the console\'s proxy holds' : '--- FAILED (the log and pane above say why)');
  process.exitCode = ok ? 0 : 1;
  console.log(`docker rm -f ${CONTAINER} when done`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
  up.close();
}
