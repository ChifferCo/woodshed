#!/usr/bin/env node
// agentInImage.mjs's copy for a review session whose reviewers are Grok Build and OpenCode on the pull request author's
// own sign-in (console/reviewAgents.mjs): the whole entrypoint runs in the real session image with the environment ECS
// would give it (the fleet builds the review's env, the ECS launcher's allowlist filters it, the task definition's
// variables are added), and the console's real session API, with its real review agent proxy (reviewAgentProxy.mjs),
// answers it from here. The author's sign-ins are made up: an xAI key for Grok Build (or, with IN_IMAGE_GROK_VIA=login, a
// `grok login`, whose upstream's model list makes grok take its turns on /v1/responses and offer xAI's x_search there),
// an Anthropic API key in OpenCode's auth.json (or, with IN_IMAGE_OPENCODE_PROVIDER=openai, an OpenAI one). The proxy
// sends each model call to a recording stand-in upstream on this computer (modelStandIn.mjs), never to xAI, Anthropic or
// OpenAI, which answers each agent's first turn with a tool call and the next with a closing line, so each reviewer ends
// without a verdict. It prints the fields of every body (names, never values, and of tools[] only each tool's type):
// what the proxy's body scope (console/reviewAgentScope.mjs) allows. The review's report is kept here, never sent to
// GitHub. Passes when each reviewer started in review mode and reached the
// console's proxy with the session's token alone, the proxy sent its calls on with the made-up sign-in in its place,
// each agent took a turn after its tool call, and the proxy refused none of their bodies:
//
//   node woodshed/providers/aws/bin/reviewInImage.mjs <image> [pull request number]
//   IN_IMAGE_MODELS=grok=grok-build,opencode=anthropic/claude-sonnet-4-5 IN_IMAGE_BRANCH_REVIEW_SH=1 node … (model picks; this checkout's review.sh)
//
// Needs Docker, and `gh` on this computer to read the pull request's branch and commit, here. The container runs the pull
// request's code and the reviewers read what anyone who can push to it wrote, so it is handed no GitHub credential of
// yours (as agentsInImage.mjs): its session API hands out a placeholder, and a stand-in `gh` put in the container
// ahead of the image's checks the pull request out from the public repo's pull ref by git alone (GitHub's GraphQL,
// which `gh pr checkout` asks, takes no call without a token). The review's own `gh` reads of the pull request's
// discussion fail, which it takes as no context. For a private repo, IN_IMAGE_GH_TOKEN gives the token to hand out
// instead, and the image's own `gh` checks out: a fine-grained one that can only read that repo (Contents and Pull
// requests: read), never `gh auth token`. REPO names the repo (owner/name, default this one), which an
// image with no checkout clones at start; IN_IMAGE_CONSOLE_HOST the address the container reaches this computer at
// (default host.docker.internal).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sessionOverrides } from '../ecsLauncher.mjs';
import { createFleet } from '../../../console/fleet.mjs';
import { createSessionApi } from '../../../console/sessionApi.mjs';
import { createReviewAgentProxy, isReviewAgentPath, reviewAgentTokenOf } from '../../../console/reviewAgentProxy.mjs';
import agentsRegistry from '../../../shared/agents.cjs';
import { envValue } from '../../../shared/envNames.mjs';
import { taskDefinitionEnv } from './askInImageEnv.mjs';
import { modelStandIn } from './modelStandIn.mjs';

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
const OPENCODE_PROVIDER = process.env.IN_IMAGE_OPENCODE_PROVIDER === 'openai' ? 'openai' : 'anthropic';
const OPENCODE_KEY = OPENCODE_PROVIDER === 'openai' ? 'sk-reviewInImage-not-a-real-key' : 'sk-ant-reviewInImage-not-a-real-key';
// A login is what `grok login` saves (grokModels.mjs, credentialOf), with an expiry ahead: a review never uses one without.
const GROK_VIA = process.env.IN_IMAGE_GROK_VIA === 'login' ? 'login' : 'key';
const GROK_SECRET = GROK_VIA === 'login' ? 'grok-login-reviewInImage-not-a-real-access' : 'xai-reviewInImage-not-a-real-key-0123456789';
const SIGN_INS = {
  grok: GROK_VIA === 'login'
    ? JSON.stringify({ 'https://auth.x.ai::reviewInImage': { key: GROK_SECRET, refresh_token: 'reviewInImage-not-a-real-refresh', expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString() } })
    : GROK_SECRET,
  opencode: JSON.stringify({ [OPENCODE_PROVIDER]: { type: 'api', key: OPENCODE_KEY } }),
};
const GH_TOKEN = process.env.IN_IMAGE_GH_TOKEN || null;
// The author's model picks (REVIEW_MODELS, as `grok=grok-build,opencode=anthropic/claude-sonnet-4-5`), which the review passes
// to each reviewer's --model, and IN_IMAGE_BRANCH_REVIEW_SH=1 to run this checkout's session/review.sh in place of the one
// the image was built with, for a change to it that no image has yet.
const MODELS = agentsRegistry.parseReviewModels(process.env.IN_IMAGE_MODELS || '') ?? (() => { console.error('IN_IMAGE_MODELS must be reviewer=model words, such as grok=grok-build'); process.exit(2); })();
const BRANCH_REVIEW_SH = process.env.IN_IMAGE_BRANCH_REVIEW_SH === '1';
// With no token, the start's `gh pr checkout <n> --force` by git from the pull ref; anything else to the image's gh,
// which holds only the placeholder.
const STAND_IN_GH = `#!/bin/bash
if [ "$1 $2" = "pr checkout" ]; then
  git fetch --quiet origin "+refs/pull/$3/head:refs/heads/pr-$3" && git checkout --quiet --force "pr-$3"
  exit $?
fi
exec /usr/local/bin/gh "$@"
`;

// The stand-in keeps which header carried a credential and whether it was the made-up sign-in, never a header's value,
// so nothing printed below can hold a key.
const inspect = (req) => {
  const { authorization, 'x-api-key': apiKey } = req.headers;
  return {
    carried: [authorization && 'authorization', apiKey && 'x-api-key'].filter(Boolean),
    grokKey: authorization === `Bearer ${GROK_SECRET}`,
    opencodeKey: (OPENCODE_PROVIDER === 'openai' ? authorization === `Bearer ${OPENCODE_KEY}` : apiKey === OPENCODE_KEY),
  };
};

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
      agents: ['grok', 'opencode'], ...(Object.keys(MODELS).length ? { models: MODELS } : {}), ownSignIns: { grok: { login: AUTHOR, via: GROK_VIA }, opencode: { login: AUTHOR, provider: OPENCODE_PROVIDER } },
    },
  });
  return { fleet, overrides: sessionOverrides(started[0]) };
}

const proxyCalls = [];
const reports = [];
function serve(fleet, up) {
  const ghToken = GH_TOKEN || 'in-image-no-github-token';
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
    opencodeUpstreams: { anthropic: `${up}/anthropic`, openai: `${up}/openai` },
  });
  // A review reads GitHub with the session API's read-only token: here a placeholder, or IN_IMAGE_GH_TOKEN's read-only
  // one, never this computer's own login.
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

// What the proxy refused of a body, from its own log line (which names the field, never its value).
const bodyRefusals = [];
const warn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).startsWith('reviewAgentProxy: refused, a body')) bodyRefusals.push(args[1]);
  warn(...args);
};
// A turn after a tool call: its result is in the body.
const afterToolCall = (c) => c.fields.some((f) => /\.tool_call_id:|\{type=tool_result\}|\{type=function_call_output\}/.test(f));
const { server: up, url: upUrl, calls: upstreamCalls } = await modelStandIn(inspect);
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
  if (!GH_TOKEN) {
    // /usr/local/sbin is ahead of the image's /usr/local/bin on the session's PATH.
    const standIn = path.join(dir, 'gh');
    fs.writeFileSync(standIn, STAND_IN_GH, { mode: 0o755 });
    docker('cp', standIn, `${CONTAINER}:/usr/local/sbin/gh`);
  }
  if (BRANCH_REVIEW_SH) docker('cp', path.join(import.meta.dirname, '../../../session/review.sh'), `${CONTAINER}:/opt/woodshed/session/review.sh`);
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
  const leaked = [...Object.values(SIGN_INS), GROK_SECRET].some((v) => env.includes(v)) || /xai-reviewInImage|sk-ant-reviewInImage|sk-reviewInImage/.test(docker('exec', '-u', 'node', CONTAINER, 'bash', '-c', 'grep -rl "reviewInImage-not-a-real" /home/node /tmp /work 2>/dev/null || true'));
  console.log('--- calls the console\'s proxy got', JSON.stringify(proxyCalls));
  console.log('--- calls the stand-in upstream got (which header carried a credential, and whether it was the made-up sign-in)', JSON.stringify(upstreamCalls));
  console.log('--- the fields of each body the stand-in upstream got (names, the value of each type and boolean, and of tools[] each type)');
  // Of tools[], only each tool's type: their names, descriptions and schemas are the agent's own, and many.
  const toolTypes = (c) => [...new Set(c.fields.filter((f) => /^\.tools\[\]/.test(f)).map((f) => /^\.tools\[\](\{type=[^}]*\})?/.exec(f)[0]))];
  for (const c of upstreamCalls.filter((x) => x.method === 'POST')) console.log(`${c.url}\n  ${[...c.fields.filter((f) => !/^\.tools\[\]/.test(f)), ...toolTypes(c)].join('\n  ')}`);
  console.log('--- bodies the proxy refused', JSON.stringify(bodyRefusals));
  console.log('--- the report', reports[0] ? JSON.stringify(JSON.parse(reports[0]).conclusion) : 'none');
  const grokCalls = upstreamCalls.filter((c) => c.url.startsWith(GROK_VIA === 'login' ? '/grok-login/v1/' : '/xai/v1/'));
  const grokPosts = grokCalls.filter((c) => c.method === 'POST');
  const opencodeCalls = upstreamCalls.filter((c) => c.url.startsWith(`/${OPENCODE_PROVIDER}/v1/`));
  const afterTool = (calls) => calls.some(afterToolCall);
  const checks = {
    'the review started in review mode': /mode: review|SESSION_MODE=review|Review of pull request/.test(logOf() + pane),
    'grok started in review mode': /Grok Build reviews on the author's own sign-in/.test(pane),
    'opencode started in review mode': new RegExp(`OpenCode reviews on the author's own ${OPENCODE_PROVIDER} key`).test(pane),
    ...Object.fromEntries(['grok', 'opencode'].filter((id) => MODELS[id]).map((id) => [`${id} was run on the model picked, ${MODELS[id]}`, pane.includes(`the model ${MODELS[id]} the author picked`)])),
    'every call reached the console\'s proxy with the session\'s token alone': proxyCalls.length > 0 && proxyCalls.every((c) => c.sessionToken),
    'grok\'s first model call reached the console\'s proxy': proxyCalls.some((c) => c.url.startsWith('/grok/v1/')),
    [`the proxy sent grok's calls on with the made-up ${GROK_VIA === 'login' ? 'login, to the login\'s upstream' : 'xAI key'}`]: grokCalls.length > 0 && grokCalls.every((c) => c.grokKey),
    // On a login's model list its turns go to /v1/responses, where it offers x_search unless review.sh removes it.
    ...(GROK_VIA === 'login' ? { 'grok took its turns on /v1/responses, as on a login': grokPosts.length > 1 && grokPosts.every((c) => c.url.endsWith('/responses')) } : {}),
    'no provider tool reached the upstream, only functions': upstreamCalls.every((c) => toolTypes(c).every((t) => t === '.tools[]' || t === '.tools[]{type=function}')),
    [`the proxy sent opencode's calls on with the made-up ${OPENCODE_PROVIDER} key`]: opencodeCalls.length > 0 && opencodeCalls.every((c) => c.opencodeKey),
    'grok took a turn after its tool call, through the proxy\'s body scope': afterTool(grokCalls),
    'opencode took a turn after its tool call, through the proxy\'s body scope': afterTool(opencodeCalls),
    'the proxy refused no body the agents sent': bodyRefusals.length === 0,
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
