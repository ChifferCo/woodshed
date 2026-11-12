#!/usr/bin/env node
// Runs a private session's start from this branch inside a running Woodshed session, beside the live one, so a change to
// how a session starts can be proven from the session that made it. It needs no Docker: a session already runs in the
// session image, so the start uses the image's own bash, curl, jq, node, tmux, ttyd and claude.
//
//   node session/startInSession.mjs [--console-away <seconds>] [--timeout <seconds>] [--keep]
//
// What it runs: the pushed branch's session/entrypoint.sh, with the environment the fleet builds for a private session,
// filtered as the ECS launcher filters it, against the console's real session API on loopback, with a made-up owner.
// Everything the start writes goes to a scratch folder (WOODSHED_TMP, HOME, TMUX_TMPDIR, its own checkout), and every
// port it opens is moved by WOODSHED_PORT_OFFSET, so the live session is left as it was: the run checks that it was.
// --console-away N drops every connection to the console for the start's first N seconds (`Empty reply from server`,
// what a console being redeployed gives) and the start must wait it out.
//
// It is not the real image check. What it does not prove is printed first and last (LIMITS), and goes in the pull
// request with the log.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { createClaudeSettings } from '../console/claudeSettings.mjs';
import { createFleet } from '../console/fleet.mjs';
import { createSessionApi } from '../console/sessionApi.mjs';
import { sessionOverrides } from '../providers/aws/ecsLauncher.mjs';
import { isMain } from '../shared/isMain.mjs';
import { loadProject, usesVariable } from '../shared/project.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
// Where the image keeps its own copies (session/Dockerfile).
export const IMAGE_SESSION_DIR = '/opt/woodshed/session';
// The files the image copies from session/ to somewhere else than /opt/woodshed, and which this run therefore uses as
// the image has them, not as the branch has them.
export const IMAGE_ONLY = [
  { file: 'Dockerfile', what: 'the image itself (session/Dockerfile)' },
  { file: 'gh.sh', what: '/usr/local/bin/gh (session/gh.sh)' },
  { file: 'tmux.conf', what: '~/.tmux.conf (session/tmux.conf)' },
];
const PORT_OFFSET = 100;
// The made-up owner's Claude token: claude opens on it and cannot call Anthropic, so the run spends nothing.
const DUMMY_CLAUDE_TOKEN = 'sk-ant-oat01-start-in-session-not-a-token';
const OWNER = 'start-in-session';

/**
 * What this run does not prove, for the pull request. `imageOnlyChanged` names the IMAGE_ONLY files this branch has
 * differently from the image: the run does not cover them, and says so first.
 * @param {{imageOnlyChanged?: string[], project?: {databases?: unknown[]}}} [args]
 * @returns {string[]}
 */
export function limits({ imageOnlyChanged = [] } = {}) {
  const changed = IMAGE_ONLY.filter((f) => imageOnlyChanged.includes(f.file));
  return [
    ...changed.map((f) => `NOT COVERED: this branch changes ${f.what}, and this run uses the image's copy. Build the image from this branch and run providers/aws/bin/askInImage.mjs to prove it.`),
    'The image is the one this session runs in, as last deployed: only the branch\'s session/ and shared/ scripts are new. A change to the Dockerfile, a system package or claude\'s version is not tried.',
    'It runs beside a live session, not as a container\'s first process under /dev/init: signals and the container\'s exit are not tried.',
    'The environment is the fleet\'s for a private session, filtered as ECS filters it, but ECS, Fargate and the task definition are not involved: no IAM, network or secret injection.',
    'The console is a stand-in: the real session API on loopback with a made-up owner (no own env lines, no saved Claude home, no databases), not the deployed console.',
    'No databases, Redis or app are started, and claude opens on a dummy token: it is asked nothing.',
  ];
}

/**
 * The IMAGE_ONLY files that differ between the branch's session/ and the image's.
 * @param {string} branchSessionDir
 * @param {string} [imageSessionDir]
 * @returns {string[]}
 */
export function imageOnlyChanges(branchSessionDir, imageSessionDir = IMAGE_SESSION_DIR) {
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  return IMAGE_ONLY.map((f) => f.file).filter((file) => read(path.join(branchSessionDir, file)) !== read(path.join(imageSessionDir, file)));
}

/**
 * Why this project's start cannot be run here, or null. Databases and Redis would need ports and data of their own.
 * @param {ReturnType<typeof loadProject>} project
 * @returns {string|null}
 */
export function refusal(project) {
  if (project.databases?.length) return 'the project file has databases, which a start beside a live session cannot copy or start';
  if (usesVariable(project, 'REDIS_URL')) return 'the project uses Redis, which a start beside a live session cannot start on its own port';
  return null;
}

function git(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * The live session's files under /tmp that the run wrote into: any that changed since `sinceMs` and holds one of the
 * run's own `marks` (its session id, token or scratch folder). The live session keeps writing its own meanwhile, so a
 * change alone says nothing.
 * @param {number} sinceMs
 * @param {string[]} marks
 * @returns {string[]}
 */
export function liveFilesTouched(sinceMs, marks, dir = '/tmp') {
  const touched = [];
  const visit = (file, name) => {
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry), path.join(name, entry));
      return;
    }
    if (stat.mtimeMs < sinceMs || stat.size > 4_000_000) return;
    let text = '';
    try { text = fs.readFileSync(file, 'latin1'); } catch { return; }
    if (marks.some((m) => m && text.includes(m))) touched.push(name);
  };
  for (const name of fs.readdirSync(dir)) {
    if (/^(woodshed-|ttyd|redis-commander|openvscode|pgweb|mongo-express|uploads$)/.test(name)) visit(path.join(dir, name), name);
  }
  return touched;
}

function banner(lines, heading) {
  console.log(`\n=== ${heading} ===`);
  for (const line of lines) console.log(`- ${line}`);
  console.log('');
}

function parseArgs(argv) {
  const args = { consoleAway: 0, timeout: 300, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--console-away') args.consoleAway = Number(argv[++i]);
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
    else if (argv[i] === '--keep') args.keep = true;
    else throw new Error(`unknown argument ${argv[i]} (expected --console-away <seconds>, --timeout <seconds> or --keep)`);
  }
  if (!(args.consoleAway >= 0 && args.consoleAway <= 50)) throw new Error('--console-away takes 0 to 50 seconds: a session waits about 40');
  if (!(args.timeout > 0)) throw new Error('--timeout takes a number of seconds');
  return args;
}

// The console's real session API, on a fleet with a fake launcher that records the environment it is handed.
async function standInConsole({ repo, branch, port, ghToken, gitIdentity }) {
  const started = [];
  const launcher = {
    kind: 'fake',
    refFor: (id) => `c-${id}`,
    async start(id, env) { started.push(env); return { ref: `c-${id}`, host: '127.0.0.1', termPort: 7681 + PORT_OFFSET, statusPort: 7682 + PORT_OFFSET }; },
    async taskState() { return { alive: true }; },
    async logTail() { return ''; },
    async stop() {},
  };
  const config = {
    repo, label: 'woodshed', publicUrl: 'https://woodshed.example', maxRunning: 5, maxPrivatePerPerson: 3,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000,
  };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, statusd: async () => ({}) });
  const session = await fleet.createSession({
    kind: 'task', number: null, title: 'startInSession', startedBy: OWNER, owner: OWNER, trigger: 'my-woodshed',
    prompt: 'startInSession: a start check, nothing to do.', branch,
  });
  const homes = new Map();
  const settingsObjects = new Map();
  const claudeSettings = createClaudeSettings({
    store: {
      getText: async (key) => settingsObjects.get(key) ?? null,
      putText: async (key, text) => { settingsObjects.set(key, text); },
      removeKey: async (key) => { settingsObjects.delete(key); },
    },
  });
  const handle = createSessionApi({
    fleet,
    tokens: { token: async () => ({ token: ghToken, expiresAt: Date.now() + 50 * 60_000 }) },
    userSettings: {
      claudeToken: async () => DUMMY_CLAUDE_TOKEN,
      ownFiles: async () => ({}),
      ownWholeFiles: async () => ({}),
      gitIdentity: () => gitIdentity,
      codexAuth: async () => null,
      view: () => ({ setUp: true }),
      noteHome() {},
    },
    // Nothing saved yet, as for a first session; a save is taken and counted.
    homes: {
      async get() { return null; },
      async put(name, req) { let bytes = 0; for await (const chunk of req) bytes += chunk.length; homes.set(name, bytes); return bytes; },
      async copy() {},
    },
    claudeSettings,
  });
  let awayUntil = 0;
  const calls = [];
  const server = http.createServer((req, res) => {
    const away = Date.now() < awayUntil;
    calls.push({ at: Date.now(), path: req.url, away });
    if (away) return req.socket.destroy();
    handle(req, res).catch((err) => { if (!res.headersSent) { res.writeHead(500); res.end(String(err?.message)); } });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    env: Object.fromEntries(sessionOverrides(started[0]).map((o) => [o.name, o.value])),
    session,
    calls,
    awayFor(ms) { awayUntil = Date.now() + ms; },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(IMAGE_SESSION_DIR)) throw new Error(`no ${IMAGE_SESSION_DIR}: run this inside a Woodshed session, which is the session image`);
  for (const bin of ['tmux', 'ttyd', 'claude', 'jq', 'curl']) {
    try { execFileSync('bash', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); } catch { throw new Error(`${bin} is not on the PATH: run this inside a Woodshed session`); }
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const remote = git(['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0];
  if (remote !== head) throw new Error(`push ${branch} first: the start fetches it from GitHub, which has ${remote ? remote.slice(0, 7) : 'no such branch'}, not ${head.slice(0, 7)}`);
  const dirty = git(['status', '--porcelain', '--', 'session', 'shared']);
  if (dirty) console.log(`startInSession: WARNING, uncommitted changes in session/ or shared/ are not in this run, which uses ${head.slice(0, 7)} as pushed`);
  const origin = git(['remote', 'get-url', 'origin']);
  const repoSlug = origin.replace(/^https:\/\/([^/@]*@)?github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'start-in-session-'));
  const dirs = Object.fromEntries(['home', 'tmp', 'tmux', 'bin'].map((d) => [d, path.join(scratch, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { mode: 0o700 });
  const checkout = path.join(scratch, 'checkout');
  git(['clone', '--quiet', '--no-hardlinks', '--branch', branch, REPO, checkout]);
  git(['remote', 'set-url', 'origin', `https://github.com/${repoSlug}.git`], checkout);

  const project = loadProject(checkout);
  const refused = refusal(project);
  if (refused) throw new Error(`this project's start cannot run beside a live session: ${refused}`);
  const imageOnlyChanged = imageOnlyChanges(path.join(checkout, 'session'));
  const LIMITS = limits({ imageOnlyChanged });
  banner(LIMITS, 'What this run does not prove');

  for (let p = 7681; p <= 7688; p += 1) {
    if (!(await portFree(p + PORT_OFFSET))) throw new Error(`port ${p + PORT_OFFSET} is taken: another start in session still running? (--keep leaves one up)`);
  }
  // The branch's gh wrapper, ahead of the image's /usr/local/bin/gh, which would ask the image's githubToken.sh.
  fs.copyFileSync(path.join(checkout, 'session/gh.sh'), path.join(dirs.bin, 'gh'));
  fs.chmodSync(path.join(dirs.bin, 'gh'), 0o755);

  const ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const gitIdentity = { name: git(['config', 'user.name']) || 'Start In Session', email: git(['config', 'user.email']) || 'start-in-session@example.com' };
  const consolePort = await freePort();
  const realLog = console.log;
  const realWarn = console.warn;
  const standIn = await standInConsole({ repo: repoSlug, branch, port: consolePort, ghToken, gitIdentity });
  console.log = (...a) => realLog('[console]', ...a);
  console.warn = (...a) => realWarn('[console]', ...a);

  // A fresh environment: nothing of the live session's (its token, its Anthropic variables, its tmux) reaches the start.
  const env = {
    PATH: `${dirs.bin}:${process.env.PATH}`, LANG: process.env.LANG ?? 'C.UTF-8', TERM: 'xterm-256color',
    HOME: dirs.home, USER: process.env.USER ?? 'node', TMPDIR: dirs.tmp, TMUX_TMPDIR: dirs.tmux,
    REPO_DIR: checkout, WOODSHED_TMP: dirs.tmp, UPLOADS_DIR: path.join(dirs.tmp, 'uploads'),
    WOODSHED_SESSION_DIR: path.join(checkout, 'session'), WOODSHED_SHARED_DIR: path.join(checkout, 'shared'),
    WOODSHED_PORT_OFFSET: String(PORT_OFFSET),
    WOODSHED_CONSOLE_URL: `http://127.0.0.1:${consolePort}`,
    ...standIn.env,
  };
  if (args.consoleAway) {
    standIn.awayFor(args.consoleAway * 1000);
    realLog(`startInSession: the console drops every connection for the start's first ${args.consoleAway} s`);
  }
  realLog(`startInSession: starting ${branch} at ${head.slice(0, 7)} (session ${standIn.session.id}, ports ${7681 + PORT_OFFSET}-${7688 + PORT_OFFSET}, scratch ${scratch})`);
  const startedAt = Date.now();
  // Outside the scratch folder, which a passed run removes.
  const logFile = path.join(os.tmpdir(), `start-in-session-${standIn.session.id}.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn('bash', [path.join(checkout, 'session/entrypoint.sh'), 'session'], { cwd: checkout, env, detached: true, stdio: ['ignore', out, out] });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  let text = '';
  let shown = 0;
  let outcome = null;
  while (!outcome) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    text = fs.readFileSync(logFile, 'utf8');
    for (const line of text.slice(shown).split('\n').filter(Boolean)) realLog(`[start] ${line}`);
    shown = text.length;
    if (/statusd: listening/.test(text)) outcome = { ok: true };
    else if (/\] ERROR: /.test(text)) outcome = { ok: false, why: 'the start logged an ERROR' };
    else if (exited) outcome = { ok: false, why: `the start exited (${exited.code ?? exited.signal}) before statusd listened` };
    else if (Date.now() - startedAt > args.timeout * 1000) outcome = { ok: false, why: `statusd was not listening after ${args.timeout} s` };
  }
  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;

  const tmuxEnv = (cmd) => { try { return execFileSync('tmux', cmd, { env: { ...env, TMUX: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  const leaked = tmuxEnv(['show-environment', '-g']).split('\n').filter((l) => /^(GH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=/.test(l)).map((l) => l.split('=')[0]);
  const touched = liveFilesTouched(startedAt - 1000, [standIn.env.SESSION_ID, standIn.env.SESSION_TOKEN, scratch]);
  const dropped = standIn.calls.filter((c) => c.away).length;

  if (!args.keep) {
    tmuxEnv(['kill-server']);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  standIn.close();
  console.log = realLog;
  console.warn = realWarn;

  const checks = [
    [outcome.ok, outcome.ok ? `the start reached statusd in ${seconds} s` : `the start failed: ${outcome.why}`],
    [!args.consoleAway || dropped > 0, args.consoleAway ? `the console dropped ${dropped} connection(s) in its first ${args.consoleAway} s, and the start waited them out` : 'the console answered throughout (no --console-away)'],
    [leaked.length === 0, leaked.length ? `left in claude's environment: ${leaked.join(', ')}` : 'no GitHub or Anthropic token left in claude\'s environment'],
    [touched.length === 0, touched.length ? `the live session's files changed during the run: ${touched.join(', ')}` : 'the live session\'s /tmp files were left as they were'],
  ];
  realLog('\n=== Result ===');
  for (const [ok, what] of checks) realLog(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  banner(LIMITS, 'What this run does not prove (put these in the pull request with the log)');
  const passed = checks.every(([ok]) => ok);
  realLog(passed ? `startInSession: PASSED, within the limits above. Log: ${logFile}` : `startInSession: FAILED. Log: ${logFile}`);
  if (args.keep) realLog(`startInSession: left running (--keep): statusd on ${7682 + PORT_OFFSET}; stop it with TMUX_TMPDIR=${dirs.tmux} tmux kill-server; kill -- -${child.pid}`);
  else if (passed) fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(passed ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`startInSession: ${err.message}`);
    process.exit(2);
  });
}
