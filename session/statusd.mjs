// statusd: the only port the console talks to inside a session task.
//
//   GET  /status      what claude is doing, its last message, the branch, its head and its PR, and what the
//                     container uses (usage.mjs), and how much of the owner's Claude plan is used (planUsage.mjs)
//   GET  /applog      the end of the app's logs: its start, the backend's and the frontend's
//   GET  /diff        the checkout against its merge base with the default branch, uncommitted work included, as one
//                     plain unified diff (sessionDiff.mjs)
//   /shed-review/...   the Review tab: the shed's own review page and server (reviewShed/), reached through the console's
//                     /review and /reviews/claude-<id>/...
//   POST /send        {"text": "..."} typed into claude's pane, then Enter
//   POST /claude-login  types woodshed-login at the Terminal tab's prompt
//   POST /checkpoint  commit whatever is uncommitted and push the branch, after saving the Claude home
//                     (~/.claude and ~/.claude.json) to the console, for the session's next run
//
// A private session also keeps its owner's shared Claude settings in step with their other sessions, every
// SYNC_EVERY_MS (settingsSync.mjs).
//                     An ask session (SESSION_MODE=ask) only saves its home: it is on the default branch and pushes nothing
//   ANY  /redis/<id>/* forwarded to redis-commander, which listens on loopback only
//   ANY  /pg/<id>/*    forwarded to pgweb, and /mongo/<id>/* to mongo-express: a private session's own databases,
//                      also on loopback only (startDbViewers in entrypoint.sh)
//   ANY  /__woodshed/code/*  forwarded to openvscode-server, the console's Editor, websockets too; loopback only.
//                      statusd starts it on the first request (codeEditor.mjs). Not in an ask session. The console
//                      sends these for `<id>.<app domain>/__woodshed/code/`, with this token in Authorization
//   POST /app/start   start the repo's app (the project file's app.start) in the background
//   POST /app/stop    stop it (app.stop), a start still in progress included
//   POST /upload?name=<file>&pane=agent|terminal   the body saved under /tmp/uploads, and its path typed at that
//                     pane's prompt with no Enter (terminalFiles.mjs)
//   GET  /image?path=<path>   a picture a terminal path names, inside the repo, the uploads or claude's scratchpad
//   POST /scroll      {"steps": -3, "pane": "agent"}   a phone's swipe, as tmux's wheel would take it
//   ANY  with `x-woodshed-app: Bearer <SESSION_TOKEN>`, any path, websockets too: forwarded to the
//        app's frontend on 127.0.0.1, at the project file's app.frontendPort. The console sends these for `<id>.<app domain>`. The token
//        has its own header because the app's requests carry an Authorization header of their own
//
// Reachable only from the console's security group, and every request must
// also carry `Authorization: Bearer <SESSION_TOKEN>`. Without a token it does
// not start: a session's terminal and its branch must never be open by default.

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, openSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { classifyPane, parseTranscriptTail } from '../shared/sessionState.mjs';
import { STATE_FILE } from './hookState.mjs';
import { STOP_TIMEOUT_MS, SYNC_EVERY_MS, exchange, readState, syncOnce, writeState } from './settingsSync.mjs';
import { imageFor, saveUpload, scrollPane, typePaths } from './terminalFiles.mjs';
import { readUsage, usageBetween } from './usage.mjs';
import { readPlanUsage } from './planUsage.mjs';
import { classifyCodexPane } from './codexState.mjs';
import { createReviewHost } from './reviewShed/host.mjs';
import { createCodeEditor } from './codeEditor.mjs';
import { readSessionDiff } from './sessionDiff.mjs';
import { ENGINE_NAMES, viewersOf } from '../shared/databases/index.mjs';
import { expandPath, loadProject, usesVariable } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';

const run = promisify(execFile);

const PORT = Number(process.env.STATUSD_PORT || 7682);
// Each viewer serves under its own prefix, so a path passes through unchanged.
// Redis's, then each database engine's (shared/databases/), such as pgweb on /pg/<id>/. A test moves one with
// <ROUTE>_VIEWER_PORT (PG_VIEWER_PORT, MONGO_COPY_VIEWER_PORT).
const viewerPort = (route, port) => Number(process.env[`${route.toUpperCase().replace(/-/g, '_')}_VIEWER_PORT`] || port);
const VIEWERS = {
  redis: { port: viewerPort('redis', 7683), name: 'Redis' },
  ...Object.fromEntries(viewersOf(ENGINE_NAMES).map((v) => [v.route, { port: viewerPort(v.route, v.port), name: v.name }])),
};
const VIEWER_RE = new RegExp(`^/(${Object.keys(VIEWERS).join('|')})/[0-9a-f]{8}(?:/|$)`);
const EDITOR = { port: Number(process.env.CODE_EDITOR_PORT || 7688), name: 'editor' };
const EDITOR_BIN = process.env.CODE_EDITOR_BIN || '/opt/openvscode-server/bin/openvscode-server';
// The editor's base path. It is served on the session's app name, so the path needs no session id.
const EDITOR_RE = /^\/__woodshed\/code(?:\/|$)/;
const REPO_DIR = process.env.REPO_DIR || process.cwd();

// The project file (woodshed/shared/project.mjs): the app, how to start and stop it, its ports and its logs, and whether
// the session has an editor. Read once, from the checkout the entrypoint made; a file that does not parse leaves the
// session without Start app or the editor rather than without statusd.
function readProject() {
  try {
    return loadProject(REPO_DIR);
  } catch (err) {
    console.warn('statusd: project file not read, no app or editor', { message: err.message });
    return null;
  }
}
const PROJECT = readProject();
const PROJECT_APP = PROJECT?.app ?? null;
// No app, no ports: nothing is probed or proxied.
const APP_PORT = Number(process.env.APP_PORT || PROJECT_APP?.frontendPort) || null;
const APP_API_PORT = Number(process.env.APP_API_PORT || PROJECT_APP?.backendPort) || null;
const APP_HEADER = 'x-woodshed-app';
const APP_LOG = '/tmp/woodshed-app.log';
const SERVER_LOGS = Object.entries(PROJECT_APP?.logs ?? {}).map(([name, file]) => [name, expandPath(file, { repoDir: REPO_DIR })]);
const APP_LOG_TAIL_BYTES = 48 * 1024;
const APP_PROBE_MS = 500;
const TOKEN = process.env.SESSION_TOKEN || '';
const TMUX_TARGET = 'claude';
const PR_CACHE_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEND_CHARS = 8000;
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
// What claude writes when Esc ends a turn, mid-turn ("…by user]") or on a dialog ("…by user for tool use]").
const INTERRUPT_RECORD = '[Request interrupted by user';
const SILENT_TURN_MS = 5 * 60_000;
// Claude opened 16 s after statusd in a real session; this leaves room for a slow MCP server.
const STARTING_MS = 2 * 60_000;
// The container's start too: the entrypoint execs statusd, and the task ends when it does, so it never restarts.
const STARTED_AT = Date.now();
// The hooks after which claude's next sign of life is a reply written to the transcript.
const WAITING_ON_REPLY = new Set(['UserPromptSubmit', 'PostToolUse']);
const CONSOLE_URL = process.env.WOODSHED_CONSOLE_URL || '';
const ASK = process.env.SESSION_MODE === 'ask';
// The entrypoint starts Redis and its viewer only for a project whose env mentions REDIS_URL (startRedisIfUsed), so
// Data ▾ offers Redis only then.
const REDIS = !ASK && PROJECT !== null && usesVariable(PROJECT, 'REDIS_URL');
const CODEX = process.env.AGENT === 'codex';
const CODEX_AUTH_FILE = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
// The copy the entrypoint was given, to tell whether this session refreshed the login.
const CODEX_GIVEN_FILE = path.join(os.homedir(), '.config/woodshed/codex-auth');
// What a Claude home keeps across sessions: logins (MCP OAuth in .credentials.json), memory, settings, transcripts,
// and the installed plugins' files, which are a few MB and much slower to fetch from GitHub again. Caches and
// per-machine state are rebuilt in a moment, and only make the archive bigger.
const HOME_EXCLUDES = ['.claude/statsig', '.claude/shell-snapshots', '.claude/ide', '.claude/debug', '.claude/downloads'];
// The whole save, not each read: the console gives a checkpoint 90 s, and the push after this needs some of it.
const HOME_SAVE_TIMEOUT_MS = 30_000;
// A task that ends without a checkpoint (a crash, Fargate taking it back) loses at most this much of the home.
// Keep it above HOME_SAVE_TIMEOUT_MS: periodicSave tracks one periodic save, so two must never overlap.
const HOME_SAVE_EVERY_MS = 5 * 60_000;
// Sessions start in auto mode, so a mode footer is on screen while claude is open, whichever mode
// someone has cycled to since.
const MODE_FOOTER = /(auto mode|bypass permissions|accept edits|plan mode) on/;
// cgroup v2 names it memory.peak; v1, which Fargate uses, memory.max_usage_in_bytes. Both count file
// cache the kernel can reclaim, so this is an upper bound on what the session needs.
const MEMORY_PEAK_FILES = ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes'];

/**
 * @param {string|undefined} header
 * @param {string} token
 * @returns {boolean}
 */
export function isAuthorized(header, token) {
  if (!token || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * @param {string} paneText  raw `tmux capture-pane -p` output
 * @returns {'working'|'needs-you'|'done'|'not-running'}  not-running = the pane
 *   holds a shell: claude has not opened yet, or it has exited
 */
export function paneState(paneText) {
  const state = classifyPane(paneText);
  if (state) return state;
  // classifyPane wants an empty composer line to call a turn done, but claude
  // greys a suggested next prompt into it after most turns.
  return typeof paneText === 'string' && MODE_FOOTER.test(paneText) ? 'done' : 'not-running';
}

/**
 * @param {string} raw  request body
 * @returns {string}  the text to type
 */
export function parseSendBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('body must be JSON');
  }
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string');
  if (text.length > MAX_SEND_CHARS) throw new Error(`text must be at most ${MAX_SEND_CHARS} characters`);
  return text;
}

/**
 * @param {string[]} files  cgroup files holding the peak in bytes; the first readable one wins
 * @returns {Promise<number|null>}  the container's peak memory in MB, or null when no cgroup reports it
 */
export async function memoryPeakMb(files = MEMORY_PEAK_FILES) {
  for (const file of files) {
    const bytes = Number((await fs.readFile(file, 'utf8').catch(() => '')).trim());
    if (bytes > 0) return Math.round(bytes / 1024 / 1024);
  }
  return null;
}

async function git(...args) {
  const { stdout } = await run('git', ['-C', REPO_DIR, ...args]);
  return stdout.trim();
}

let prCache = { at: 0, url: null };

async function prUrl() {
  if (ASK) return null;
  if (Date.now() - prCache.at < PR_CACHE_MS) return prCache.url;
  let url = null;
  try {
    const { stdout } = await run('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], { cwd: REPO_DIR });
    url = stdout.trim() || null;
  } catch {
    // No PR for this branch yet, which is the normal state for most of a session.
  }
  prCache = { at: Date.now(), url };
  return url;
}

// Claude names a project's transcript folder after its path, with every / and . as -.
function transcriptDir() {
  return path.join(os.homedir(), '.claude', 'projects', REPO_DIR.replace(/[/.]/g, '-'));
}

// The transcript claude writes to now. Its name is claude's own session id, which `claude --resume` takes.
async function newestTranscript() {
  const dir = transcriptDir();
  let files;
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const stats = await Promise.all(files.map(async (name) => ({ name, stat: await fs.stat(path.join(dir, name)) })));
  return stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0] ?? null;
}

async function transcriptTail() {
  const dir = transcriptDir();
  const newest = await newestTranscript();
  if (!newest) return null;
  const handle = await fs.open(path.join(dir, newest.name));
  try {
    const start = Math.max(0, newest.stat.size - TRANSCRIPT_TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(newest.stat.size - start), position: start });
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), partial: start > 0, writtenAt: newest.stat.mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} tailText  the tail of a transcript
 * @returns {number|null}  when the last turn was cut short with Esc, mid-turn or on a dialog, in ms
 */
export function lastInterruptAt(tailText) {
  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(INTERRUPT_RECORD)) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map((b) => b?.text) : [];
    const at = Date.parse(rec?.timestamp);
    if (rec?.type === 'user' && !Number.isNaN(at) && texts.some((t) => typeof t === 'string' && t.startsWith(INTERRUPT_RECORD))) return at;
  }
  return null;
}

/**
 * @param {string} tailText  the tail of a transcript
 * @param {{partial: boolean}} opts  partial: the tail starts mid-file, so a walk that runs off its start has not
 *   seen the whole turn
 * @returns {number|null}  tool calls since the last prompt with no result yet: still running, in parallel with the
 *   last one to finish, or a subagent at work. null when the tail ends before the prompt does: one large tool
 *   result can fill it, and the call it ran beside may be further back
 */
export function openToolCalls(tailText, { partial }) {
  const results = new Set();
  let open = 0;
  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (rec?.type === 'user') {
      if (!Array.isArray(content)) return open;
      const resultIds = content.filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id);
      if (!resultIds.length) return open;
      resultIds.forEach((id) => results.add(id));
    } else if (rec?.type === 'assistant' && Array.isArray(content)) {
      open += content.filter((b) => b?.type === 'tool_use' && !results.has(b.id)).length;
    }
  }
  return partial ? null : open;
}

async function hookState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    // No hook has fired yet, or claude started from an image without them.
    return null;
  }
}

/**
 * What claude is doing, from its own hooks. The pane only says whether claude is open at all, and stands in until
 * the first hook fires.
 * @param {{paneText: string, hook: {state: string, event: string, at: number}|null,
 *          interruptedAt: number|null, transcriptAt: number|null, openTools: number|null, now: number,
 *          startedAt: number}} params  transcriptAt: when the transcript was last written, in ms. openTools: from
 *   openToolCalls; null, unknown, counts as open. startedAt: when statusd started, with the container
 * @returns {{state: 'starting'|'working'|'needs-you'|'done'|'not-running',
 *            source: 'pane'|'hook'|'interrupt'|'silent'}}
 */
export function claudeState({ paneText, hook, interruptedAt, transcriptAt, openTools, now, startedAt }) {
  const pane = paneState(paneText);
  // SessionStart writes the state file as claude opens, so with no file and no claude on screen it is still opening,
  // its first prompt queued behind it. Not for ever: a claude that never opens has exited.
  if (pane === 'not-running' && !hook && now - startedAt < STARTING_MS) return { state: 'starting', source: 'pane' };
  if (pane === 'not-running' || !hook?.state) return { state: pane, source: 'pane' };
  if (hook.state !== 'done' && interruptedAt !== null && interruptedAt >= hook.at) return { state: 'done', source: 'interrupt' };
  // Esc before the first word of a reply writes no interrupt record either: the prompt or the tool result, then
  // nothing. A turn that is going writes to the transcript, or has a tool call open: the last PostToolUse can be
  // the quick one of a parallel batch.
  const lastSign = Math.max(hook.at, transcriptAt ?? 0);
  const silent = WAITING_ON_REPLY.has(hook.event) && openTools === 0 && now - lastSign > SILENT_TURN_MS;
  if (silent) return { state: 'done', source: 'silent' };
  return { state: hook.state, source: 'hook' };
}

// A server is up when its port accepts a connection, whoever started it: claude often does.
function listening(port) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(APP_PROBE_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function appServers() {
  const [frontend, backend] = await Promise.all([listening(APP_PORT), listening(APP_API_PORT)]);
  return { frontend, backend, frontendPort: APP_PORT, backendPort: APP_API_PORT };
}

let appStart = null;
let appStop = null;

/**
 * After the shed's app line: up, half up, or why not.
 * @param {{frontend: boolean, backend: boolean}} servers  which of the app's ports accept connections
 * @param {{exitCode: number|null, stopped?: boolean}|null} start  the last start this statusd ran, if any
 * @param {{exitCode: number|null}|null} stop  the last stop this statusd ran, if any
 * @returns {'running'|'api-down'|'frontend-down'|'starting'|'stopping'|'failed'|'stopped'}
 */
export function appState(servers, start, stop = null) {
  if (stop && stop.exitCode === null) return 'stopping';
  if (servers.frontend && servers.backend) return 'running';
  if (start && start.exitCode === null) return 'starting';
  // The page loads, and every call under it fails.
  if (servers.frontend) return 'api-down';
  if (servers.backend) return 'frontend-down';
  if (start && start.exitCode !== 0 && !start.stopped) return 'failed';
  return 'stopped';
}

async function appStatus() {
  const servers = await appServers();
  return { app: appState(servers, appStart, appStop), appServers: servers };
}

// The project's own start or stop command: the project file's `app.start` or `app.stop`.
function runAppCommand(command) {
  const out = openSync(APP_LOG, 'a');
  return spawn('bash', ['-c', command], { cwd: REPO_DIR, detached: true, stdio: ['ignore', out, out] });
}

// The start command waits until the servers are healthy, then leaves them running on their own.
async function startApp() {
  if (!PROJECT_APP) {
    console.log('statusd: app start skipped, the project has no app');
    return { started: false, app: (await appStatus()).app };
  }
  if ((appStart && appStart.exitCode === null) || (appStop && appStop.exitCode === null)) {
    console.log('statusd: app start skipped', { starting: appStart?.exitCode === null, stopping: appStop?.exitCode === null });
    return { started: false, app: (await appStatus()).app };
  }
  const child = runAppCommand(PROJECT_APP.start);
  const start = { exitCode: null, startedAt: Date.now(), pid: child.pid, stopped: false };
  appStart = start;
  child.on('exit', (code) => {
    start.exitCode = code ?? 1;
    console.log('statusd: app start finished', { exitCode: start.exitCode, stopped: start.stopped, seconds: Math.round((Date.now() - start.startedAt) / 1000) });
  });
  child.on('error', (err) => {
    start.exitCode = 1;
    console.warn('statusd: app start could not run', { message: err.message });
  });
  child.unref();
  console.log('statusd: app starting', { log: APP_LOG });
  return { started: true, app: (await appStatus()).app };
}

// The stop command stops what the start started, as the project's commands decide: servers claude ran some other way
// may keep running.
async function stopApp() {
  if (!PROJECT_APP?.stop) {
    console.log('statusd: app stop skipped, the project has no stop command');
    return { stopping: false, app: (await appStatus()).app };
  }
  if (appStop && appStop.exitCode === null) return { stopping: false, app: 'stopping' };
  // A start still waiting on its health checks would otherwise go on to report the servers this stops as failed.
  // Its servers run in sessions of their own (setsid), so this stops the script and leaves them to the stop below.
  if (appStart && appStart.exitCode === null) {
    appStart.stopped = true;
    try {
      process.kill(-appStart.pid, 'SIGTERM');
      console.log('statusd: app start interrupted', { pid: appStart.pid });
    } catch (err) {
      console.warn('statusd: app start could not be interrupted', { message: err.message });
    }
  }
  const child = runAppCommand(PROJECT_APP.stop);
  const stop = { exitCode: null, startedAt: Date.now() };
  appStop = stop;
  child.on('exit', async (code) => {
    stop.exitCode = code ?? 1;
    const left = await appServers();
    const log = left.frontend || left.backend ? console.warn : console.log;
    log('statusd: app stop finished', { exitCode: stop.exitCode, frontendStillUp: left.frontend, backendStillUp: left.backend });
  });
  child.on('error', (err) => {
    stop.exitCode = 1;
    console.warn('statusd: app stop could not run', { message: err.message });
  });
  child.unref();
  console.log('statusd: app stopping', { log: APP_LOG });
  return { stopping: true, app: 'stopping' };
}

let lastState = null;

// Codex writes no hooks: its pane is all there is, and a pane with no codex on it is starting or has ended.
function codexState(paneText) {
  const state = classifyCodexPane(paneText);
  if (state) return { state, source: 'pane' };
  return { state: Date.now() - STARTED_AT < STARTING_MS ? 'starting' : 'not-running', source: 'pane' };
}

// ChatGPT's refresh token rotates, so the sign-in saved on My settings stops working once a session used it. The
// console keeps the copy only for an owner who saved one, and says 409 to anyone else.
async function keepCodexAuth() {
  if (!CODEX || !CONSOLE_URL || process.env.SESSION_KIND !== 'private') return;
  try {
    const [body, given] = await Promise.all([fs.readFile(CODEX_AUTH_FILE, 'utf8'), fs.readFile(CODEX_GIVEN_FILE, 'utf8').catch(() => null)]);
    // Only a login this session refreshed goes back: another session's newer one must not be written over by a stale copy.
    if (given === null || given.startsWith('sk-') || JSON.stringify(JSON.parse(given)) === JSON.stringify(JSON.parse(body))) {
      console.log('statusd: Codex sign-in unchanged, not sent back');
      return;
    }
    const res = await fetch(`${CONSOLE_URL}/codex-auth`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body, signal: AbortSignal.timeout(10_000) });
    console.log('statusd: Codex sign-in sent back', { status: res.status });
  } catch (err) {
    console.warn('statusd: Codex sign-in not sent back', { message: err?.message });
  }
}

async function status() {
  let pane = '';
  try {
    pane = (await run('tmux', ['capture-pane', '-p', '-t', TMUX_TARGET])).stdout;
  } catch (err) {
    console.warn('statusd: capture-pane failed', { message: err?.message });
  }
  const tail = CODEX ? null : await transcriptTail().catch((err) => {
    console.warn('statusd: reading the transcript failed', { message: err?.message });
    return null;
  });
  const hook = CODEX ? null : await hookState();
  const { state, source } = CODEX ? codexState(pane) : claudeState({
    paneText: pane,
    hook,
    interruptedAt: tail ? lastInterruptAt(tail.text) : null,
    transcriptAt: tail?.writtenAt ?? null,
    // With no transcript at all, nothing can be open: the silent rule then works from the hook's time alone.
    openTools: tail ? openToolCalls(tail.text, { partial: tail.partial }) : 0,
    now: Date.now(),
    startedAt: STARTED_AT,
  });
  if (state !== lastState) console.log('statusd: claude state changed', { from: lastState, to: state, source });
  lastState = state;
  return {
    sessionId: process.env.SESSION_ID || null,
    state,
    editor: hasEditor(),
    redis: REDIS,
    // Only a finished turn has shells that matter: they are what it is still waiting on.
    shells: state === 'done' ? hook?.shells ?? 0 : 0,
    lastMessage: tail ? parseTranscriptTail(tail.text, { partial: tail.partial }).message : null,
    claudeSession: CODEX ? null : (await newestTranscript().catch(() => null))?.name.replace(/\.jsonl$/, '') ?? null,
    branch: await git('branch', '--show-current'),
    head: await git('rev-parse', '--short', 'HEAD'),
    prUrl: await prUrl(),
    usage: await usage(),
    planUsage: await readPlanUsage().catch(planUsageFailed),
    ...(await appStatus()),
  };
}

// Once per reason, not on every status read: the console asks every few seconds.
let planUsageError = null;
function planUsageFailed(error) {
  if (error.message !== planUsageError) console.log('statusd: plan usage not read', { error: error.message });
  planUsageError = error.message;
  return null;
}

// A sample within 2 s of the last gives the last answer back, without moving the baseline: the console's quick
// checks while a session starts come every second.
let usageSample = null;
let usageAnswer = null;
async function usage() {
  const next = { ...(await readUsage()), at: Date.now() };
  if (usageSample && next.at - usageSample.at < 2000) return usageAnswer;
  usageAnswer = usageBetween(usageSample, next);
  usageSample = next;
  return usageAnswer;
}

async function tail(file) {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, APP_LOG_TAIL_BYTES);
    const { buffer } = await handle.read({ buffer: Buffer.alloc(length), position: size - length });
    // Cut to a whole first line, unless the file is all there.
    const text = buffer.toString('utf8');
    return { text: size > length ? text.slice(text.indexOf('\n') + 1) : text, bytes: size };
  } finally {
    await handle.close();
  }
}

async function appLogs() {
  const files = [['start', APP_LOG], ...SERVER_LOGS];
  return { logs: await Promise.all(files.map(async ([name, file]) => ({ name, ...((await tail(file)) ?? { text: null, bytes: 0 }) }))) };
}

// Types woodshed-login at the Terminal tab's prompt, for the console's Sign in button: a login needs a terminal to paste
// the code into, and nothing else may be typed there through this route.
async function startClaudeLogin() {
  // ttyd creates the shell session when the Terminal tab first connects, which may not have happened yet. The tab then
  // attaches to this one (`new-session -A -s shell`).
  await run('tmux', ['has-session', '-t', '=shell']).catch(() => run('tmux', ['new-session', '-d', '-s', 'shell', '-c', REPO_DIR]));
  await run('tmux', ['send-keys', '-t', 'shell', '-l', 'woodshed-login']);
  await run('tmux', ['send-keys', '-t', 'shell', 'Enter']);
  console.log('statusd: Claude login started in the terminal');
}

async function send(text) {
  // Codex reads a fast run of keys as a paste and swallows an Enter that lands inside it, so a message of about 100
  // characters or more sat unsent (measured on codex 0.167.0). A bracketed paste ends before the Enter arrives.
  if (CODEX) {
    await run('tmux', ['set-buffer', '-b', 'woodshed-send', '--', text]);
    await run('tmux', ['paste-buffer', '-p', '-d', '-b', 'woodshed-send', '-t', TMUX_TARGET]);
  } else await run('tmux', ['send-keys', '-t', TMUX_TARGET, '-l', text]);
  await run('tmux', ['send-keys', '-t', TMUX_TARGET, 'Enter']);
  console.log('statusd: text sent to claude', { chars: text.length, paste: CODEX });
}

// The Claude home, as a gzipped tar streamed to the console's session API: a private session's for its owner alone,
// a shared session's for its own next run.
export function homeArchiveArgs(home, entries) {
  return ['czf', '-', '-C', home, ...HOME_EXCLUDES.map((e) => `--exclude=${e}`), ...entries];
}

/**
 * Whether anything the home archive keeps changed after `sinceMs`. A folder's own time catches a file deleted from it.
 * Stops at the first change, so a busy home costs a few reads.
 */
export async function homeChangedSince(home, sinceMs) {
  const skipped = new Set(HOME_EXCLUDES.map((e) => path.join(home, e)));
  const json = await fs.lstat(path.join(home, '.claude.json')).catch(() => null);
  if (json && json.mtimeMs > sinceMs) return true;
  const dirs = [path.join(home, '.claude')];
  while (dirs.length) {
    const dir = dirs.pop();
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs > sinceMs) return true;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (skipped.has(full)) continue;
      if (entry.isDirectory()) {
        dirs.push(full);
        continue;
      }
      const file = await fs.lstat(full).catch(() => null);
      if (file && file.mtimeMs > sinceMs) return true;
    }
  }
  return false;
}

async function saveHome(why, signal) {
  const home = os.homedir();
  const entries = [];
  for (const entry of ['.claude', '.claude.json']) {
    if (await fs.stat(path.join(home, entry)).catch(() => null)) entries.push(entry);
  }
  if (!entries.length) return { saved: false };
  if (signal?.aborted) throw new Error('given up for the save at stop');
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', homeArchiveArgs(home, entries), { stdio: ['ignore', 'pipe', 'inherit'] });
    let bytes = 0;
    tar.stdout.on('data', (chunk) => { bytes += chunk.length; });
    const req = http.request(`${CONSOLE_URL}/home?why=${why}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/gzip' },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        clearTimeout(deadline);
        if (res.statusCode === 200) resolve({ saved: true, bytes });
        else reject(new Error(`the console answered ${res.statusCode}`));
      });
    });
    const deadline = setTimeout(() => {
      tar.kill();
      req.destroy(new Error(`not saved within ${HOME_SAVE_TIMEOUT_MS / 1000} s`));
    }, HOME_SAVE_TIMEOUT_MS);
    req.on('error', (err) => { clearTimeout(deadline); reject(err); });
    tar.on('error', (err) => { clearTimeout(deadline); reject(err); });
    const giveUp = () => {
      tar.kill();
      req.destroy(new Error('given up for the save at stop'));
    };
    signal?.addEventListener('abort', giveUp, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', giveUp));
    tar.stdout.pipe(req);
  });
}

// One save at a time, so the one at stop always lands after any periodic save begun before it.
let homeSaving = Promise.resolve();
// A periodic save queued or in flight. The stop gives it up instead of waiting: the push after the stop's own save
// needs the time, and an upload cut short leaves the console's last whole copy in place.
let periodicSave = null;
// Restored files keep the times they were saved with, so a home nobody has touched since the start is not sent again.
let homeSavedFrom = STARTED_AT;
// Set by the checkpoint: a periodic save after it could write back a home Remove My Woodshed has just deleted.
let homeSavesOver = false;

function saveHomeInTurn(why) {
  if (why === 'stop') periodicSave?.abort();
  const controller = why === 'periodic' ? new AbortController() : null;
  if (controller) periodicSave = controller;
  const next = homeSaving.then(async () => {
    const from = Date.now();
    const saved = await saveHome(why, controller?.signal).catch((err) => {
      console.warn('statusd: Claude home not saved', { why, message: err?.message });
      return { saved: false };
    });
    if (periodicSave === controller) periodicSave = null;
    if (!saved.saved) return saved;
    homeSavedFrom = from;
    console.log('statusd: Claude home saved', { why, bytes: saved.bytes });
    return saved;
  });
  homeSaving = next;
  return next;
}

async function saveHomeIfChanged() {
  if (homeSavesOver) return;
  const changed = await homeChangedSince(os.homedir(), homeSavedFrom);
  // Again: a checkpoint may have begun during the scan.
  if (changed && !homeSavesOver) await saveHomeInTurn('periodic');
}

// Carries on from the version the entrypoint pulled before claude started.
let settingsState = null;
// The round in flight, which the stop waits for, and whether the stop has had its last one.
let settingsRound = null;
let settingsOver = false;

function syncSettings(timeoutMs) {
  if (settingsOver) return Promise.resolve();
  settingsRound ??= settingsRoundOnce(timeoutMs).finally(() => { settingsRound = null; });
  return settingsRound;
}

async function settingsRoundOnce(timeoutMs) {
  settingsState ??= await readState();
  const result = await syncOnce({
    home: os.homedir(), state: settingsState, live: true, send: (body) => exchange({ consoleUrl: CONSOLE_URL, token: TOKEN, body, timeoutMs }),
  });
  if (!result) return;
  const moved = result.sent + result.removed + result.written + result.deleted;
  settingsState = result.state;
  if (!moved) return;
  await writeState(settingsState);
  console.log('statusd: shared Claude settings synced', {
    version: settingsState.version, sent: result.sent, removed: result.removed, written: result.written, deleted: result.deleted,
  });
}

// A change made since the last round would otherwise be in the saved home only, and the next start's pull of the
// older shared copy would write over it. Before the home is saved, so it holds what the round brought back too.
async function lastSettingsRound() {
  if (!CONSOLE_URL || process.env.SESSION_KIND !== 'private' || settingsOver) return;
  try {
    await settingsRound?.catch(() => {});
    await syncSettings(STOP_TIMEOUT_MS);
  } catch (err) {
    console.warn('statusd: shared Claude settings not synced at the stop', { message: err?.message });
  } finally {
    settingsOver = true;
  }
}

async function checkpoint() {
  homeSavesOver = true;
  await keepCodexAuth();
  await lastSettingsRound();
  // Before the push, which can fail: the home is worth keeping either way.
  const home = CONSOLE_URL ? await saveHomeInTurn('stop') : { saved: false };
  if (ASK) {
    console.log('statusd: an ask session pushes nothing');
    return { committed: false, head: await git('rev-parse', '--short', 'HEAD'), homeSaved: home.saved };
  }
  await git('add', '-A');
  const staged = await git('diff', '--cached', '--name-only');
  if (staged) await git('commit', '-m', 'WIP: Woodshed checkpoint before stop');
  await git('push', '-u', 'origin', 'HEAD');
  console.log('statusd: checkpoint pushed', { committed: Boolean(staged) });
  return { committed: Boolean(staged), head: await git('rev-parse', '--short', 'HEAD'), homeSaved: home.saved };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const codeEditor = createCodeEditor({
  bin: EDITOR_BIN,
  port: EDITOR.port, repoDir: REPO_DIR, listening,
});

// Whether the console offers Editor ↗: the project file turns it on, and the image has it (the image workflow leaves it
// out when the built commit's project file says false).
function hasEditor() {
  return !ASK && PROJECT?.editor === true && existsSync(EDITOR_BIN);
}

async function forwardToEditor(req, res) {
  if (ASK) return reply(res, 404, { error: 'a question from Slack has no editor' });
  if (PROJECT?.editor !== true) {
    console.log('statusd: editor refused, the project file turns it off', { read: Boolean(PROJECT) });
    return reply(res, 404, { error: 'the project file turns the editor off' });
  }
  if (!(await codeEditor.ensure())) return reply(res, 502, { error: 'the editor is not running' });
  forwardToViewer(req, res, EDITOR, () => codeEditor.forget());
}

// The bearer token checked in handle() is the viewer's only guard, so it never listens beyond loopback.
function forwardToViewer(req, res, viewer, onUnreachable) {
  const { authorization, ...headers } = req.headers;
  const upstream = http.request({ host: '127.0.0.1', port: viewer.port, method: req.method, path: req.url, headers }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    console.warn('statusd: viewer unreachable', { viewer: viewer.name, message: err.message });
    onUnreachable?.();
    if (res.headersSent) return res.destroy();
    reply(res, 502, { error: `the ${viewer.name} viewer is not running` });
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

function appHeaders(headers) {
  const { [APP_HEADER]: token, ...rest } = headers;
  return rest;
}

// The console answers for a stopped app itself; this header tells it the app, not statusd, is down.
function forwardToApp(req, res) {
  if (!APP_PORT) {
    res.writeHead(503, { 'content-type': 'application/json', [APP_HEADER]: 'down' });
    return res.end(JSON.stringify({ error: 'the project has no app' }));
  }
  const upstream = http.request({ host: '127.0.0.1', port: APP_PORT, method: req.method, path: req.url, headers: appHeaders(req.headers) }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    if (err.code !== 'ECONNREFUSED') console.warn('statusd: app unreachable', { message: err.message });
    res.writeHead(503, { 'content-type': 'application/json', [APP_HEADER]: 'down' });
    res.end(JSON.stringify({ error: 'the app is not running' }));
  });
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * Websockets for the app (Next's hot reload, the agent's live updates), after the same two checks, and for the
 * editor, with the statusd token in Authorization as its other requests carry it.
 */
export function handleUpgrade(req, socket, head, { token = TOKEN, port = APP_PORT, editorPort = EDITOR.port, editorOn = !ASK && PROJECT?.editor === true } = {}) {
  if (!(APP_HEADER in req.headers) && EDITOR_RE.test(new URL(req.url || '/', 'http://statusd').pathname)) {
    if (!isAuthorized(req.headers.authorization, token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    // The console checks this too; the same rule as forwardToEditor, so the socket is no way around the switch.
    if (!editorOn) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const { authorization, ...headers } = req.headers;
    return pipeUpgrade(req, socket, head, editorPort, headers);
  }
  if (!isAuthorized(req.headers[APP_HEADER], token)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  if (!port) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }
  pipeUpgrade(req, socket, head, port, appHeaders(req.headers));
}

function pipeUpgrade(req, socket, head, port, headers) {
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      for (const v of [value].flat()) lines.push(`${key}: ${v}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  socket.on('error', drop);
  socket.on('close', () => upstream.destroy());
}

async function uploadReply(req, res) {
  const url = new URL(req.url, 'http://statusd');
  const pane = url.searchParams.get('pane');
  try {
    const saved = await saveUpload(req, { name: url.searchParams.get('name') });
    if (pane === 'agent' || pane === 'terminal') await typePaths(run, [saved.path], pane);
    console.log('statusd: file uploaded', { bytes: saved.bytes, typed: pane || null });
    return reply(res, 200, saved);
  } catch (err) {
    if (err.shown) return reply(res, err.status, { error: err.message });
    throw err;
  }
}

function imageReply(req, res) {
  const requested = new URL(req.url, 'http://statusd').searchParams.get('path');
  const found = imageFor(requested, { repoDir: REPO_DIR });
  if (!found) return reply(res, 404, { error: 'no such image' });
  // Screenshots are written over in place, so never a cached copy.
  res.writeHead(200, { 'content-type': found.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  const stream = createReadStream(found.file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const reviewHost = createReviewHost({ repoDir: REPO_DIR, sessionId: process.env.SESSION_ID || '' });

async function handle(req, res) {
  if (APP_HEADER in req.headers) {
    if (!isAuthorized(req.headers[APP_HEADER], TOKEN)) return reply(res, 401, { error: 'unauthorized' });
    return forwardToApp(req, res);
  }
  if (!isAuthorized(req.headers.authorization, TOKEN)) return reply(res, 401, { error: 'unauthorized' });
  const { pathname } = new URL(req.url, 'http://statusd');
  if (EDITOR_RE.test(pathname)) return forwardToEditor(req, res);
  const viewer = VIEWER_RE.exec(pathname)?.[1];
  if (viewer === 'redis' && !REDIS) return reply(res, 404, { error: 'this session has no Redis: its project uses none' });
  if (viewer) return forwardToViewer(req, res, VIEWERS[viewer]);
  const route = `${req.method} ${pathname}`;
  if (route === 'GET /status') return reply(res, 200, await status());
  if (route === 'POST /send') {
    let text;
    try {
      text = parseSendBody(await readBody(req));
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    await send(text);
    return reply(res, 200, { ok: true });
  }
  if (route === 'POST /claude-login') {
    await startClaudeLogin();
    return reply(res, 200, { ok: true });
  }
  if (route === 'POST /checkpoint') return reply(res, 200, await checkpoint());
  if (route === 'POST /upload') return uploadReply(req, res);
  if (route === 'GET /applog') return reply(res, 200, await appLogs());
  if (route === 'GET /diff') {
    const diff = await readSessionDiff({ repoDir: REPO_DIR });
    return diff.ok ? reply(res, 200, diff) : reply(res, diff.status, { error: diff.error });
  }
  if (pathname.startsWith('/shed-review/')) return (await reviewHost.handle(req, res)) || reply(res, 404, { error: 'not found' });
  if (route === 'GET /image') return imageReply(req, res);
  if (route === 'POST /scroll') {
    try {
      const { steps, pane } = JSON.parse((await readBody(req)) || '{}');
      return reply(res, 200, { via: await scrollPane(run, { steps, pane }) });
    } catch (err) {
      if (err.shown || err instanceof SyntaxError) return reply(res, 400, { error: err.message });
      throw err;
    }
  }
  if (route === 'POST /app/start') return reply(res, 200, await startApp());
  if (route === 'POST /app/stop') return reply(res, 200, await stopApp());
  return reply(res, 404, { error: 'not found' });
}

function main() {
  if (!TOKEN) {
    console.error('statusd: SESSION_TOKEN is not set, refusing to start');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('statusd: request failed', { url: req.url, message: err?.message });
      if (!res.headersSent) reply(res, 500, { error: err?.message || 'internal error' });
    });
  });
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));
  server.listen(PORT, () => console.log('statusd: listening', { port: PORT }));
  if (CONSOLE_URL) {
    setInterval(() => saveHomeIfChanged().catch((err) => {
      console.warn('statusd: Claude home check failed', { message: err?.message });
    }), HOME_SAVE_EVERY_MS);
  }
  if (CONSOLE_URL && process.env.SESSION_KIND === 'private') {
    setInterval(() => syncSettings().catch((err) => {
      console.warn('statusd: shared Claude settings not synced', { message: err?.message });
    }), SYNC_EVERY_MS);
  }
  // The container's init passes the stop on as SIGTERM. Without one, statusd is PID 1, which ignores SIGTERM without
  // a handler: ECS would wait 30s to kill it.
  process.on('SIGTERM', async () => {
    console.log('statusd: stopping', { memoryPeakMb: await memoryPeakMb() });
    process.exit(0);
  });
}

if (isMain(import.meta.url)) main();
