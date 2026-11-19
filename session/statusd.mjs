// statusd: the only port the console talks to inside a session task.
//
//   GET  /status      what claude is doing, its last message, the branch, its head and its PR, and what the
//                     container uses (usage.mjs), and how much of the owner's Claude plan is used (planUsage.mjs)
//   GET  /applog      the end of the app's logs: its start, the backend's and the frontend's
//   GET  /diff        the checkout against its merge base with the default branch, uncommitted work included, as one
//                     plain unified diff (sessionDiff.mjs)
//   /shed-review/...   the Review tab: the shed's own review page and server (reviewShed/), reached through the console's
//                     /review and /reviews/claude-<id>/...
//   POST /send        {"text": "..."} typed into claude's pane, then Enter; 409 (why: prompt-open) while the pane shows
//                     a question or an approval, which the Enter would answer
//   POST /claude-login  types /woodshed:remote-control into claude, or woodshed-login at the Terminal tab's prompt where
//                       claude has no such command: {"where": "agent"|"terminal"}
//   POST /checkpoint  commit whatever is uncommitted and push the branch, after saving the Claude home
//                     (~/.claude and ~/.claude.json) to the console, for the session's next run
//   POST /taint       {"proxy", "ca", "message"}: the console locked this session down (console/mcpRelay.mjs). Every tool
//                     is pointed at the console's egress proxy, the settings sync stops, the rules gain tainted.md, and
//                     claude reopens its conversation on the console's Anthropic proxy once its turn ends, with
//                     `message` as what it reads first (taint.mjs)
//
// A private session also keeps its owner's shared Claude settings in step with their other sessions, every
// SYNC_EVERY_MS (settingsSync.mjs).
//                     An ask session (SESSION_MODE=ask) only saves its home: it is on the default branch and pushes nothing;
//                     nor does a QA session (SESSION_MODE=qa), which tests a pull request's branch and changes nothing
//   ANY  /redis/<id>/* forwarded to redis-commander, which listens on loopback only
//   ANY  /pg/<id>/*    forwarded to pgweb, and /mongo/<id>/* to mongo-express: a private session's own databases,
//                      also on loopback only (startDbViewers in entrypoint.sh)
//   ANY  /__woodshed/code/*  forwarded to openvscode-server, the console's Editor, websockets too; loopback only.
//                      statusd starts it on the first request (codeEditor.mjs). Not in an ask session. The console
//                      sends these for `<id>.<app domain>/__woodshed/code/`, with this token in Authorization
//   POST /app/start   start the repo's app (the project file's app.start) in the background; {"app": "<name>"} picks
//                     one of several (`apps`), the default without it, after stopping the one running
//   POST /app/stop    stop it (app.stop), a start still in progress included
//   POST /upload?name=<file>&pane=agent|terminal   the body saved under /tmp/uploads, and its path typed at that
//                     pane's prompt with no Enter (terminalFiles.mjs)
//   GET  /image?path=<path>   a picture a terminal path names, inside the repo, the uploads or claude's scratchpad
//   POST /scroll      {"steps": -3, "pane": "agent"}   a swipe or wheel the browser's own scrollback did not take
//   GET  /transcript?limit=<n>&since=<writtenAt>   the conversation so far from the agent's own record of it, for the
//                     console's Chat tab: what was asked, said and run (sessionTranscript.mjs). With `since`, only
//                     {unchanged: true} while nothing was written after it
//   POST /interrupt   Esc typed into the agent's pane: claude and codex both stop their turn on it
//   GET  /prompt      what the agent's pane asks now, read from the screen (panePrompt.mjs): claude's AskUserQuestion
//                     picker, or an approval (claude's permission dialog, codex's approval), or {prompt: null}
//   POST /answer      the Chat tab's answer to it, typed as keys only once the pane shows that same prompt, and checked
//                     again after each key (panePrompt.mjs); 409 with the reason when the pane is not what was answered:
//                     {"kind": "question", "questions": [{"question", "options": [...], "descriptions": [...], "pick": <index>}]}
//                     or {"kind": "approval", "decision": "approve"|"deny", "key"}, the key GET /prompt gave
//   ANY  with `x-woodshed-app: Bearer <SESSION_TOKEN>`, any path, websockets too: forwarded to the
//        app's frontend on 127.0.0.1, at the project file's app.frontendPort (the running app's, of several). The console sends these for `<id>.<app domain>`. The token
//        has its own header because the app's requests carry an Authorization header of their own
//
// Reachable only from the console's security group, and every request must
// also carry `Authorization: Bearer <SESSION_TOKEN>`. Without a token it does
// not start: a session's terminal and its branch must never be open by default.

import { createPaneLock, reopenUnderLock } from './paneLock.mjs';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { appendFileSync, createReadStream, existsSync, openSync } from 'node:fs';
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
import { readDisk, readUsage, usageBetween } from './usage.mjs';
import { readPlanUsage } from './planUsage.mjs';
import { readCodexPlanUsage } from './codexPlanUsage.mjs';
import { TAINTED_CLAUDE_FLAGS, applyTaint, isTaintSetUp, isTainted, markTaintSetUp } from './taint.mjs';
import { classifyCodexPane } from './codexState.mjs';
import { Refusal, answerApproval, answerQuestions, composerEmpty, composerText, readPrompt, typeMessage } from './panePrompt.mjs';
import { createReviewHost } from './reviewShed/host.mjs';
import { createCodeEditor } from './codeEditor.mjs';
import { readSessionDiff } from './sessionDiff.mjs';
import { readSessionTranscript } from './sessionTranscript.mjs';
import { ENGINE_NAMES, viewersOf } from '../shared/databases/index.mjs';
import { expandPath, loadProject, usesVariable } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';

const run = promisify(execFile);

const PORT = Number(process.env.STATUSD_PORT || 7682);
// Every interface in a session, where the console reaches it from another host. STATUSD_HOST is the dev console's
// alone (console/bin/devChatSession.mjs), to keep a made-up session's statusd on loopback: the fleet never sets it, so
// it is in no PER_SESSION_ENV.
const HOST = process.env.STATUSD_HOST || undefined;
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
// The project's apps (`apps` in shared/project.mjs: a file's one `app` is a list of one) and the one statusd runs: the
// default until a Start app picks another, then the last one picked. One runs at a time, so only its ports are probed
// and proxied, and only its logs read. No app, no ports: nothing is probed or proxied. A project with no app yet is read
// again (refreshApp), so an app Set up app had claude write starts from Start app in the same session; the apps it
// already has are kept as they were read.
let PROJECT_APPS = [];
let CURRENT_APP = null;
let APP_PORT = null;
let APP_API_PORT = null;
let SERVER_LOGS = [];

// APP_PORT and APP_API_PORT (a test's) stand in for whichever app's ports.
function portsOf(app) {
  return { frontendPort: Number(process.env.APP_PORT || app?.frontendPort) || null, backendPort: Number(process.env.APP_API_PORT || app?.backendPort) || null };
}

function useApp(app) {
  CURRENT_APP = app ?? null;
  ({ frontendPort: APP_PORT, backendPort: APP_API_PORT } = portsOf(CURRENT_APP));
  SERVER_LOGS = Object.entries(CURRENT_APP?.logs ?? {}).map(([name, file]) => [name, expandPath(file, { repoDir: REPO_DIR })]);
}

function useApps(apps) {
  PROJECT_APPS = apps ?? [];
  useApp(PROJECT_APPS[0]);
}
useApps(PROJECT?.apps);
const APP_HEADER = 'x-woodshed-app';
const APP_LOG = '/tmp/woodshed-app.log';
// The console asks for /status every few seconds: a project with no app is read again at most this often, and on
// each Start app.
const APP_REREAD_MS = 10_000;
let appReadAt = Date.now();
let appReadError = null;

function refreshApp({ force = false } = {}) {
  if (PROJECT_APPS.length || (!force && Date.now() - appReadAt < APP_REREAD_MS)) return;
  appReadAt = Date.now();
  let apps = [];
  try {
    apps = loadProject(REPO_DIR).apps;
  } catch (err) {
    // Asked every few seconds: each reason is said once, so a file claude wrote that does not parse is in the log.
    if (err.message !== appReadError) console.warn('statusd: project file not read again, still no app', { message: err.message });
    appReadError = err.message;
    return;
  }
  if (!apps.length) return;
  useApps(apps);
  console.log('statusd: the project file has an app now', { apps: apps.length, frontendPort: APP_PORT, backendPort: APP_API_PORT });
}
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
// A QA session (session/qa.sh) tests a pull request's branch and changes nothing on it: it pushes nothing, and the
// pull request it tests is not one it opened. Its run is working while QA_RUNNING is there, and done after.
const QA = process.env.SESSION_MODE === 'qa';
const QA_RUNNING = '/tmp/qa-running';
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
// A mode footer is on screen while claude is open, whichever mode the session started in or someone has cycled to
// since: default mode's reads `⏸ manual mode on` (Claude Code 2.1.328).
const MODE_FOOTER = /(auto mode|bypass permissions|accept edits|plan mode|manual mode) on/;
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
/** Text as it can be typed: CRLF and CR made newlines, every other control character but the tab left out. */
export function typeableText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

export function parseSendBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('body must be JSON');
  }
  // Control characters are not text to type: an ESC would reach the agent as the Escape key, and tmux cannot pass a NUL.
  // A CRLF is a newline; the rest are left out.
  const text = typeof body?.text === 'string' ? typeableText(body.text) : body?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string');
  if (text.length > MAX_SEND_CHARS) throw new Error(`text must be at most ${MAX_SEND_CHARS} characters`);
  return text;
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_ANSWER_TEXT = 1000;

const filled = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

/**
 * POST /answer's body, checked to its shape: what the page answers and the prompt it saw.
 * @param {string} raw
 * @returns {{kind: 'question', questions: {question: string, options: string[], pick: number}[]}
 *   |{kind: 'approval', decision: 'approve'|'deny', title: string, detail: string[]}}
 */
export function parseAnswerBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('body must be JSON');
  }
  if (body?.kind === 'question') {
    const list = body.questions;
    if (!Array.isArray(list) || !list.length || list.length > MAX_QUESTIONS) throw new Error(`questions must be 1 to ${MAX_QUESTIONS} questions`);
    const questions = list.map((q) => {
      const options = q?.options;
      if (!filled(q?.question, MAX_ANSWER_TEXT) || !Array.isArray(options) || !options.length || options.length > MAX_OPTIONS
        || !options.every((o) => filled(o, MAX_ANSWER_TEXT)) || !Number.isInteger(q.pick) || q.pick < 0 || q.pick >= options.length) {
        throw new Error('each question needs its text, its options and the index of the one picked');
      }
      const descriptions = Array.isArray(q.descriptions) && q.descriptions.length === options.length
        && q.descriptions.every((d) => typeof d === 'string' && d.length <= MAX_ANSWER_TEXT) ? { descriptions: [...q.descriptions] } : {};
      return { question: q.question, options: [...options], ...descriptions, pick: q.pick };
    });
    return { kind: 'question', questions };
  }
  if (body?.kind === 'approval') {
    if (body.decision !== 'approve' && body.decision !== 'deny') throw new Error('decision must be approve or deny');
    // The approval's key from GET /prompt: the hash of exactly what it asks (panePrompt.mjs, approvalKey).
    if (typeof body.key !== 'string' || !/^[0-9a-f]{64}$/.test(body.key)) throw new Error('an approval needs the key GET /prompt gave');
    return { kind: 'approval', decision: body.decision, key: body.key };
  }
  throw new Error('kind must be question or approval');
}

/**
 * What GET /prompt tells the page: enough to show the prompt and answer it, nothing of the rest of the screen.
 * @param {ReturnType<typeof readPrompt>} prompt
 */
export function promptReply(prompt) {
  if (!prompt) return { prompt: null };
  if (prompt.kind === 'approval') {
    const { agent, key, complete, what, title, detail, options, approve, deny } = prompt;
    return { prompt: { kind: 'approval', agent, key, complete, what, title, detail, approve: options[approve].label, deny: options[deny].label } };
  }
  if (prompt.step === 'review') return { prompt: { kind: 'question', step: 'review' } };
  return {
    prompt: {
      kind: 'question', step: 'question', question: prompt.question, multiSelect: prompt.multiSelect,
      options: prompt.options.map((o) => o.label), questions: prompt.tabs.questions.length,
    },
  };
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
  if (ASK || QA) return null;
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

async function serversOf(app) {
  const { frontendPort, backendPort } = portsOf(app);
  const [frontend, backend] = await Promise.all([listening(frontendPort), listening(backendPort)]);
  return { frontend, backend, frontendPort, backendPort };
}

function appServers() {
  return serversOf(CURRENT_APP);
}

let appStart = null;
let appStop = null;
// While Start app of another app waits on the running one's stop: Stop app in that time keeps it from starting.
let appSwitch = null;

/**
 * After the shed's app line: up, half up, or why not.
 * @param {{frontend: boolean, backend: boolean}} servers  which of the app's ports accept connections
 * @param {{exitCode: number|null, stopped?: boolean}|null} start  the last start this statusd ran, if any
 * @param {{exitCode: number|null}|null} stop  the last stop this statusd ran, if any
 * @param {{hasApp?: boolean}} [opts]  whether the project file has an app at all
 * @returns {'running'|'api-down'|'frontend-down'|'starting'|'stopping'|'failed'|'stopped'|'none'}
 */
export function appState(servers, start, stop = null, { hasApp = true } = {}) {
  // The project file says nothing of an app: Set up app, not Start app.
  if (!hasApp) return 'none';
  if (stop && stop.exitCode === null) return 'stopping';
  if (servers.frontend && servers.backend) return 'running';
  if (start && start.exitCode === null) return 'starting';
  // The page loads, and every call under it fails.
  if (servers.frontend) return 'api-down';
  if (servers.backend) return 'frontend-down';
  if (start && start.exitCode !== 0 && !start.stopped) return 'failed';
  return 'stopped';
}

// Claude may start an app of its own from the shell, other than the one statusd runs. When the current app's frontend
// is down and exactly one other app's frontend answers (on a port the current app does not use), that is the app
// running: follow it, so its ports, Open app and logs are the right ones. Never while a Start or Stop of ours is
// going, and never when it is not clear which app runs.
async function followRunningApp(servers) {
  if (PROJECT_APPS.length < 2 || servers.frontend) return null;
  if ((appStart && appStart.exitCode === null) || (appStop && appStop.exitCode === null) || appSwitch) return null;
  const others = PROJECT_APPS.filter((app) => app !== CURRENT_APP && portsOf(app).frontendPort && portsOf(app).frontendPort !== servers.frontendPort);
  const up = (await Promise.all(others.map(async (app) => ((await listening(portsOf(app).frontendPort)) ? app : null)))).filter(Boolean);
  const ports = new Set(up.map((app) => portsOf(app).frontendPort));
  if (up.length !== 1 || ports.size !== 1) return null;
  // A Start or Stop may have begun while the probes ran.
  if ((appStart && appStart.exitCode === null) || (appStop && appStop.exitCode === null) || appSwitch) return null;
  console.log('statusd: app running is not the one picked, following it', { from: CURRENT_APP?.name, to: up[0].name });
  useApp(up[0]);
  appStart = null;
  appStop = null;
  return up[0];
}

async function appStatus() {
  refreshApp();
  let servers = await appServers();
  if (await followRunningApp(servers)) servers = await appServers();
  return { app: appState(servers, appStart, appStop, { hasApp: Boolean(CURRENT_APP) }), appServers: servers };
}

// Which app runs, and the ones Start app can pick: a console from before several apps reads neither.
function appsStatus() {
  return { appName: CURRENT_APP?.name ?? null, apps: PROJECT_APPS.map(({ name, label }) => ({ name, label })) };
}

// The project's own start or stop command: the project file's `app.start` or `app.stop`.
function runAppCommand(command) {
  const out = openSync(APP_LOG, 'a');
  return spawn('bash', ['-c', command], { cwd: REPO_DIR, detached: true, stdio: ['ignore', out, out] });
}

/**
 * The app Start app was asked for: by its name, or the default (the first) with none.
 * @param {unknown} name  the request's `app`
 * @returns {object}  the app
 * @throws {Error}  with `status` 400, for a name that is none of them
 */
export function pickApp(apps, name) {
  if (name === undefined || name === null || name === '') return apps[0];
  const app = typeof name === 'string' ? apps.find((a) => a.name === name) : null;
  if (!app) throw Object.assign(new Error(`no app named ${JSON.stringify(name)}: the project's apps are ${apps.map((a) => a.name).join(', ')}`), { status: 400 });
  return app;
}

// The start command waits until the servers are healthy, then leaves them running on their own. One app runs at a
// time: starting another stops the running one first, with its own stop command.
async function startApp(name) {
  refreshApp({ force: true });
  if (!CURRENT_APP) {
    console.log('statusd: app start skipped, the project has no app');
    return { started: false, app: (await appStatus()).app };
  }
  const app = pickApp(PROJECT_APPS, name);
  // Another app's start still going is stopped like a running one: only the same app's start is waited for.
  if ((app === CURRENT_APP && appStart && appStart.exitCode === null) || (appStop && appStop.exitCode === null)) {
    console.log('statusd: app start skipped', { app: app.name, starting: appStart?.exitCode === null, stopping: appStop?.exitCode === null });
    return { started: false, app: (await appStatus()).app };
  }
  if (app === CURRENT_APP) {
    runStart(app);
    return { started: true, app: (await appStatus()).app };
  }
  const from = CURRENT_APP;
  const fromServers = await serversOf(from);
  // Whatever of it may still run: what this statusd started, or servers claude started some other way.
  const fromRan = Boolean(appStart) || fromServers.frontend || fromServers.backend;
  interruptStart();
  useApp(app);
  appStart = null;
  appStop = null;
  console.log('statusd: app switched', { from: from.name, to: app.name, stopFirst: fromRan && Boolean(from.stop) });
  if (!fromRan || !from.stop) {
    if (fromRan) console.warn('statusd: the running app has no stop command, starting the next beside it', { from: from.name, to: app.name });
    runStart(app);
    return { started: true, app: (await appStatus()).app };
  }
  const pending = { to: app.name, cancelled: false };
  appSwitch = pending;
  runStop(from, () => {
    if (appSwitch === pending) appSwitch = null;
    if (pending.cancelled) return console.log('statusd: app switch cancelled by Stop app', { to: app.name });
    runStart(app);
  });
  return { started: true, app: (await appStatus()).app };
}

function runStart(app) {
  // One log for every start: with several apps, a line says which one each start is.
  if (PROJECT_APPS.length > 1) appendFileSync(APP_LOG, `\n# Woodshed: starting ${app.name}\n`);
  const child = runAppCommand(app.start);
  const start = { exitCode: null, startedAt: Date.now(), pid: child.pid, stopped: false };
  appStart = start;
  child.on('exit', (code) => {
    start.exitCode = code ?? 1;
    console.log('statusd: app start finished', { app: app.name, exitCode: start.exitCode, stopped: start.stopped, seconds: Math.round((Date.now() - start.startedAt) / 1000) });
  });
  child.on('error', (err) => {
    start.exitCode = 1;
    console.warn('statusd: app start could not run', { app: app.name, message: err.message });
  });
  child.unref();
  console.log('statusd: app starting', { app: app.name, log: APP_LOG });
}

// The stop command stops what the start started, as the project's commands decide: servers claude ran some other way
// may keep running.
async function stopApp() {
  // First: during a switch the app named is already the next one, whose own stop has nothing to do with this.
  if (appStop && appStop.exitCode === null) {
    if (appSwitch) appSwitch.cancelled = true;
    return { stopping: false, app: 'stopping' };
  }
  if (!CURRENT_APP?.stop) {
    console.log('statusd: app stop skipped, the project has no stop command');
    return { stopping: false, app: (await appStatus()).app };
  }
  interruptStart();
  runStop(CURRENT_APP);
  return { stopping: true, app: 'stopping' };
}

// A start still waiting on its health checks would otherwise go on to report the servers a stop stops as failed.
// Its servers run in sessions of their own (setsid), so this stops the script and leaves them to the stop after it.
function interruptStart() {
  if (!appStart || appStart.exitCode !== null) return;
  appStart.stopped = true;
  try {
    process.kill(-appStart.pid, 'SIGTERM');
    console.log('statusd: app start interrupted', { pid: appStart.pid });
  } catch (err) {
    console.warn('statusd: app start could not be interrupted', { message: err.message });
  }
}

function runStop(app, then) {
  const child = runAppCommand(app.stop);
  const stop = { exitCode: null, startedAt: Date.now() };
  appStop = stop;
  let done = false;
  const finish = async (code) => {
    if (done) return;
    done = true;
    stop.exitCode = code;
    const left = await serversOf(app);
    const log = left.frontend || left.backend ? console.warn : console.log;
    log('statusd: app stop finished', { app: app.name, exitCode: stop.exitCode, frontendStillUp: left.frontend, backendStillUp: left.backend });
    then?.();
  };
  child.on('exit', (code) => finish(code ?? 1));
  child.on('error', (err) => {
    console.warn('statusd: app stop could not run', { app: app.name, message: err.message });
    finish(1);
  });
  child.unref();
  console.log('statusd: app stopping', { app: app.name, log: APP_LOG });
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

/**
 * The agent's state, from its hooks, its record and its pane, as the console's status read has it.
 * @param {{strict?: boolean}} [opts]  strict: a pane that cannot be read throws, rather than reading as empty
 * @returns {Promise<{state: string, source: string, pane: string, tail: object|null, hook: object|null}>}
 */
async function agentState({ strict = false } = {}) {
  let pane = '';
  try {
    pane = (await run('tmux', ['capture-pane', '-p', '-t', TMUX_TARGET])).stdout;
  } catch (err) {
    if (strict) throw err;
    console.warn('statusd: capture-pane failed', { message: err?.message });
  }
  const tail = CODEX ? null : await transcriptTail().catch((err) => {
    console.warn('statusd: reading the transcript failed', { message: err?.message });
    return null;
  });
  const hook = CODEX ? null : await hookState();
  const { state, source } = QA ? { state: existsSync(QA_RUNNING) ? 'working' : 'done', source: 'qa' } : CODEX ? codexState(pane) : claudeState({
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
  return { state, source, pane, tail, hook };
}

async function status() {
  const { state, tail, hook } = await agentState();
  // Text waiting in the agent's box at its prompt: a draft in the TUI tab, or a message left there unsent. Chat says so.
  // true or false only when the box was found on the screen; null when nothing can be said of it (mid-turn, a dialog over
  // it, a pane that could not be read), for the console never to take an unseen box as emptied.
  let boxText = null;
  if (state === 'done' && !QA) {
    try {
      const text = composerText(await captureBox(), CODEX ? 'codex' : 'claude');
      if (text !== null) boxText = text !== '';
    } catch {
      // No pane to read: nothing to say about its box.
    }
  }
  return {
    // This statusd sends only between turns, into an empty box, never into a prompt (POST /send): the console sends
    // through an older one only when its agent is plainly idle.
    safeSend: true,
    boxText,
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
    planUsage: await (CODEX ? readCodexPlanUsage() : readPlanUsage()).catch(planUsageFailed),
    ...(await appStatus()),
    ...appsStatus(),
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
  const next = { ...(await readUsage()), ...(await readDisk(REPO_DIR)), at: Date.now() };
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

// Where /woodshed:remote-control is: claude was started with Woodshed's plugin (claudeFlags in entrypoint.sh).
const CLAUDE_FLAGS_FILE = process.env.WOODSHED_CLAUDE_FLAGS_FILE || '/tmp/woodshed-claude-flags';
async function hasRemoteControlCommand() {
  if (CODEX) return false;
  try {
    return (await fs.readFile(CLAUDE_FLAGS_FILE, 'utf8')).includes('--plugin-dir');
  } catch {
    return false;
  }
}

// For the console's Sign in button. claude's own command signs in in the conversation, and reopens it with Remote
// Control on (session/claudePlugin, session/bin/woodshed-login); a claude without it gets woodshed-login typed at the
// Terminal tab's prompt, where the code is pasted. Nothing else may be typed through this route.
async function startClaudeLogin() {
  // The console refuses it too: Remote Control would carry what the session saw to claude.ai.
  if (isTainted()) throw Object.assign(new Error('this session has seen production data, so Remote Control is off'), { status: 409 });
  if (await hasRemoteControlCommand()) {
    // Typed as a message is: one thing at a time, and only between turns, when no prompt can open under its Enter.
    if (!paneLock.take('login')) throw new Error('a message is going in to claude: sign in once it has');
    try {
      const now = await agentState({ strict: true });
      const { state } = now;
      const working = state === 'working' || (state === 'done' && !atPrompt(now));
      if (working || (state !== 'done' && state !== 'needs-you')) throw new Error(`claude is ${working ? 'working' : `not at its prompt (${state})`}: sign in once its turn ends`);
      if (!lastTaken(state, now.hook, now.pane)) throw new Error('claude has not started on the last message yet: sign in once its turn ends');
      if (!(await boxEmpty())) throw new Error('claude\'s box holds text, unsent: send or clear it in the TUI tab first');
      const done = await send('/woodshed:remote-control');
      if (!done.sent) throw new Error(done.typed ? 'the command is in claude\'s box, not sent: send it from the TUI tab' : 'claude is asking something: answer it first, then sign in again');
    } finally {
      paneLock.release('login');
    }
    console.log('statusd: Claude login started in claude');
    return { where: 'agent' };
  }
  // ttyd creates the shell session when the Terminal tab first connects, which may not have happened yet. The tab then
  // attaches to this one (`new-session -A -s shell`).
  await run('tmux', ['has-session', '-t', '=shell']).catch(() => run('tmux', ['new-session', '-d', '-s', 'shell', '-c', REPO_DIR]));
  await run('tmux', ['send-keys', '-t', 'shell', '-l', 'woodshed-login']);
  await run('tmux', ['send-keys', '-t', 'shell', 'Enter']);
  console.log('statusd: Claude login started in the terminal');
  return { where: 'terminal' };
}

async function interrupt() {
  await run('tmux', ['send-keys', '-t', TMUX_TARGET, 'Escape']);
  console.log('statusd: agent interrupted');
}

async function capturePane() {
  return (await run('tmux', ['capture-pane', '-p', '-t', TMUX_TARGET])).stdout;
}

// One answer at a time: two typed into one picker would each check a screen the other is changing.
let answering = false;

/**
 * Types the Chat tab's answer into the agent's pane, once the pane shows the prompt it answers (panePrompt.mjs).
 * The log says which picks, never their text.
 * @returns {Promise<{status: number, body: object}>}
 */
async function answer(body) {
  if (answering) return { status: 409, body: { error: 'another answer is being typed: wait a moment' } };
  answering = true;
  const io = { capture: capturePane, keys: async (...keys) => { await run('tmux', ['send-keys', '-t', TMUX_TARGET, ...keys]); } };
  try {
    if (body.kind === 'question') {
      const { moves } = await answerQuestions(io, body.questions);
      console.log('statusd: answer typed', { kind: 'question', questions: body.questions.length, picks: body.questions.map((q) => q.pick + 1), moves });
    } else {
      const { moves, agent } = await answerApproval(io, body);
      console.log('statusd: answer typed', { kind: 'approval', decision: body.decision, agent, moves });
    }
    return { status: 200, body: { ok: true } };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    console.log('statusd: answer refused', { kind: body.kind, why: err.why, typed: err.typed });
    return { status: 409, body: { error: err.message, why: err.why, typed: err.typed } };
  } finally {
    answering = false;
  }
}

// How a message is typed so the agent shows it in its box as it is, never folded into a `[Pasted …]` placeholder
// (measured on claude 2.1.328 and codex 0.167): claude folds a fast burst (1200 characters at once, or several lines),
// and shows the same text typed 50 characters at a time, 20 ms apart, with Ctrl-J for each new line (a newline, not
// an Enter). codex swallows an Enter landing in a fast run of plain keys, so it gets bracketed pastes, which it folds
// over about 1000 characters: 400 at a time.
const CLAUDE_CHUNK = 50;
const CODEX_PASTE = 400;

/**
 * @returns {({keys: string}|{paste: string}|{key: string}) & {pauseMs: number}}[]
 */
export function typingSteps(text, agent) {
  const steps = [];
  if (agent === 'codex') {
    const chars = [...text];
    for (let i = 0; i < chars.length; i += CODEX_PASTE) steps.push({ paste: chars.slice(i, i + CODEX_PASTE).join(''), pauseMs: 50 });
    return steps;
  }
  text.split('\n').forEach((line, n) => {
    if (n > 0) steps.push({ key: 'C-j', pauseMs: 20 });
    const chars = [...line];
    for (let i = 0; i < chars.length; i += CLAUDE_CHUNK) steps.push({ keys: chars.slice(i, i + CLAUDE_CHUNK).join(''), pauseMs: 20 });
  });
  return steps;
}

/**
 * A failed tmux call that typed a message, said again without the message: execFile's own error quotes the command
 * line, and what someone typed never goes in a log or a reply.
 * @returns {Error & {typing: true}}
 */
export function typingError(err, partial = false) {
  return Object.assign(new Error(`tmux could not type the message (exit ${Number.isInteger(err?.code) ? err.code : 'unknown'})`), { typing: true, partial });
}

// The agent's pane, for typeMessage (panePrompt.mjs): read it, type into it, press Enter.
const paneIo = {
  capture: () => capturePane(),
  async type(text) {
    // A failed call's error quotes its command line, the message's text with it: it is said again without it, since
    // what someone typed never goes in a log.
    let done = 0;
    try {
      for (const step of typingSteps(text, CODEX ? 'codex' : 'claude')) {
        if (step.paste !== undefined) {
          await run('tmux', ['set-buffer', '-b', 'woodshed-send', '--', step.paste]);
          await run('tmux', ['paste-buffer', '-p', '-d', '-b', 'woodshed-send', '-t', TMUX_TARGET]);
        } else if (step.keys !== undefined) await run('tmux', ['send-keys', '-t', TMUX_TARGET, '-l', step.keys]);
        else await run('tmux', ['send-keys', '-t', TMUX_TARGET, step.key]);
        done++;
        await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
      }
    } catch (err) {
      // Part of it may be in the box already: said so, for nothing to send the whole of it again.
      throw typingError(err, done > 0);
    }
  },
  enter: () => run('tmux', ['send-keys', '-t', TMUX_TARGET, 'Enter']),
  // What the box holds, read with its colours: only the text typed, before the Enter.
  // A long draft runs off the top of the screen, so the box is read with scrollback enough to hold all of it.
  box: async (text = '') => composerText(await captureBox(text.split('\n').length + 100), CODEX ? 'codex' : 'claude'),
};

/**
 * A message typed in and sent, never into a prompt (typeMessage). Throws when the pane could not be read.
 * @returns {Promise<{sent: true}|{sent: false, kind: string, typed: boolean}>}
 */
async function send(text) {
  const done = await typeMessage(paneIo, text);
  if (done.sent) lastSent = { at: Date.now(), seenWorking: false };
  if (done.sent) console.log('statusd: text sent to claude', { chars: text.length, paste: CODEX });
  else console.log('statusd: text not sent, a prompt is open', { kind: done.kind, typed: done.typed, chars: text.length });
  return done;
}

// A message goes in only between turns. A prompt (an approval, a question) only ever opens mid-turn, so one could open
// between any last look at the pane and the Enter that sends a message, and take that Enter as its answer; at its
// prompt between turns the agent asks nothing of itself. Mid-turn, /send says busy and types nothing: the console
// holds the message in its saved pendingMessages (console/fleet.mjs) and sends it again once the agent is back at its
// prompt, so a session that stops mid-turn keeps it for its resume.
// When nothing says the agent took a message (no hook fired, a turn too short to be seen), the next goes this long after.
const TAKEN_MS = 20_000;
// One thing typed into the pane at a time: a message, Sign in's command. Set before any await, so a check and the
// claim cannot be split.
// Whatever types into the agent's pane, one at a time (paneLock.mjs).
const paneLock = createPaneLock();
// The last message sent, until the agent is seen taking it: a hook since its Enter, a pane seen working, or TAKEN_MS.
let lastSent = null;
// Nothing is typed into an input box that holds text: a draft someone is writing in the TUI tab, or one left with no
// Enter (a prompt came up, the Enter failed). Its own text would be sent with the message, or the message typed onto
// its end. The box is read from the screen with its colours (composerEmpty, panePrompt.mjs), so an edited draft still
// counts and the box's own suggestion, drawn dim, does not.
// The pane with its colours: the screen alone, or with `back` lines of scrollback over it. Only the read after typing
// needs scrollback, to see a draft taller than the screen whole; everywhere else the screen alone is read, since the
// agent's old frames and dialogs above it are not what it shows now.
async function captureBox(back = 0) {
  const scroll = back > 0 ? ['-S', String(-Math.min(back, 10_000))] : [];
  return (await run('tmux', ['capture-pane', '-e', '-p', ...scroll, '-t', TMUX_TARGET])).stdout;
}

async function boxEmpty() {
  const colored = await captureBox();
  // A prompt on screen is typeMessage's to refuse, as the prompt it is. No box found at all is no place to type.
  if (readPrompt(colored.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) return true;
  return composerEmpty(colored, CODEX ? 'codex' : 'claude') === true;
}

// At its prompt between turns: its state says done, and, for claude, whose state is its hooks', its screen agrees. A
// stale hook can say done while the pane shows a turn running ("esc to interrupt") or a dialog: neither is the time
// for an Enter. codex's state is its pane's already.
function atPrompt({ state, pane }) {
  if (state !== 'done') return false;
  if (CODEX) return true;
  const shown = paneState(pane);
  return shown !== 'working' && shown !== 'needs-you';
}

function lastTaken(state, hook, pane) {
  if (!lastSent) return true;
  if (state !== 'done' || (!CODEX && paneState(pane) === 'working')) lastSent.seenWorking = true;
  if (lastSent.seenWorking || (hook?.at ?? 0) > lastSent.at || Date.now() - lastSent.at > TAKEN_MS) {
    lastSent = null;
    return state === 'done' || state === 'needs-you';
  }
  return false;
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
  // A tainted session's settings stay its own: the console refuses them, so nothing is sent.
  if (settingsOver || isTainted()) return Promise.resolve();
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
  if (ASK || QA) {
    console.log('statusd: a session that changes no branch pushes nothing', { mode: process.env.SESSION_MODE });
    return { committed: false, head: await git('rev-parse', '--short', 'HEAD'), homeSaved: home.saved };
  }
  await git('add', '-A');
  const staged = await git('diff', '--cached', '--name-only');
  if (staged) await git('commit', '-m', 'WIP: Woodshed checkpoint before stop');
  await git('push', '-u', 'origin', 'HEAD');
  console.log('statusd: checkpoint pushed', { committed: Boolean(staged) });
  return { committed: Boolean(staged), head: await git('rev-parse', '--short', 'HEAD'), homeSaved: home.saved };
}

// The session's side of its taint (taint.mjs), then claude reopened on the console's proxy. Answers at once: the
// reopening waits for claude's turn to end.
const RULES_FILE = '/tmp/woodshed-rules.md';
const TAINT_MESSAGE_FILE = '/tmp/woodshed-taint-message.md';
const CLAUDE_BIN = path.join(import.meta.dirname, 'bin', 'claude');
// How long claude's turn may run before it is reopened anyway, and how long it has to stop.
const TAINT_TURN_WAIT_MS = 5 * 60_000;
let tainting = null;

async function taint({ proxy = null, ca = null, message = '' }) {
  // Done only once every step below was: a setup that failed partway is finished by the console's next notice.
  if (isTaintSetUp()) return { already: true };
  const { egress, variables } = await applyTaint({ proxy, ca, token: TOKEN, env: process.env, repoDir: REPO_DIR });
  // statusd's own git (the stop's checkpoint push) goes out the same way.
  Object.assign(process.env, variables);
  settingsOver = true;
  const rules = await fs.readFile(RULES_FILE, 'utf8').catch(() => '');
  if (!rules.includes('This session has seen production data')) await fs.appendFile(RULES_FILE, await fs.readFile(path.join(import.meta.dirname, 'tainted.md'), 'utf8'));
  const flags = await fs.readFile(CLAUDE_FLAGS_FILE, 'utf8').catch(() => '');
  // First: --disallowedTools takes several values, so the flag after it must be another flag, never the message.
  if (!flags.includes('--strict-mcp-config')) await fs.writeFile(CLAUDE_FLAGS_FILE, `${TAINTED_CLAUDE_FLAGS}${flags.trimEnd()}`);
  await fs.writeFile(TAINT_MESSAGE_FILE, String(message || 'This session has seen production data and is now locked down.'));
  await markTaintSetUp();
  console.log('statusd: tainted', { egress, reopens: !CODEX });
  if (!CODEX) tainting ??= reopenClaude().catch((err) => console.warn('statusd: claude not reopened after the taint', { message: err?.message }));
  return { tainted: true, egress };
}

// The processes a pid started, from /proc: claude, under the pane's shell.
async function childrenOf(pid) {
  const found = [];
  for (const entry of await fs.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const ppid = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
    if (ppid === String(pid)) found.push(Number(entry));
  }
  return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function reopenClaude() {
  const since = Date.now();
  while (Date.now() - since < TAINT_TURN_WAIT_MS && (await hookState())?.state === 'working') await new Promise((r) => setTimeout(r, 1_000));
  // One at a time with whatever else types into the pane (a Chat message, the login command): one already going in
  // finishes first, and one sent while claude is down and coming back is refused as busy, for the console to hold,
  // until the new claude has taken the lockdown's message (paneLock.mjs).
  const ready = await reopenUnderLock({ lock: paneLock, restart: restartClaude, hookState, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  if (!ready) console.warn('statusd: the reopened claude was not seen working, the pane let go of anyway');
}

async function restartClaude() {
  const conversation = (await newestTranscript())?.name.replace(/\.jsonl$/, '') ?? null;
  const panePid = (await run('tmux', ['display', '-p', '-t', TMUX_TARGET, '#{pane_pid}'])).stdout.trim();
  const claude = await childrenOf(panePid);
  for (const pid of claude) process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100 && claude.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  for (const pid of claude.filter(alive)) process.kill(pid, 'SIGKILL');
  const flags = (await fs.readFile(CLAUDE_FLAGS_FILE, 'utf8').catch(() => TAINTED_CLAUDE_FLAGS)).trim();
  const resume = conversation && /^[0-9a-f-]{36}$/.test(conversation) ? ` --resume ${conversation}` : '';
  await run('tmux', ['send-keys', '-t', TMUX_TARGET, '-l', `${CLAUDE_BIN} ${flags}${resume} "$(cat ${TAINT_MESSAGE_FILE})"`]);
  await run('tmux', ['send-keys', '-t', TMUX_TARGET, 'Enter']);
  console.log('statusd: claude reopened on the console\'s proxy, tainted', { conversation: Boolean(resume), stopped: claude.length });
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

// Whether the console offers Editor ↗: the project file turns it on, and the image has it (the deploy workflow's session job leaves it
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
    // A prompt on screen takes the Enter after the text as its answer: the highlighted option, often Yes. No Enter is
    // sent then (typeMessage), nor mid-turn, when a prompt can open at any moment, nor while a pane that could not be
    // read may be showing one. The console holds what it sends (fleet.mjs) and sends it again later.
    const agentName = CODEX ? 'codex' : 'claude';
    // Busy: nothing typed, and the console sends it again once the agent is back at its prompt (fleet.mjs).
    const busy = (why, error) => {
      console.log('statusd: text not sent, the agent is busy', { why, chars: text.length });
      return reply(res, 409, { why, busy: true, error });
    };
    if (!paneLock.take('send')) return busy('typing', `something else is going in to ${agentName}: this goes after it`);
    let done;
    try {
      const now = await agentState({ strict: true });
      const { state } = now;
      if (!(await boxEmpty())) {
        return busy('box-in-use', `${agentName}'s box holds text, unsent: send or clear it in the TUI tab, and this goes after it`);
      }
      // Mid-turn (its state, or its screen behind a stale hook), or the last message not yet taken (its turn may be
      // starting): it waits, to go in between turns.
      if (state === 'working' || (state === 'done' && !atPrompt(now)) || !lastTaken(state, now.hook, now.pane)) {
        return busy('working', `${agentName} is working: this goes in when its turn ends`);
      }
      if (state !== 'done' && state !== 'needs-you') {
        return reply(res, 409, { why: 'not-at-prompt', error: `${agentName} is not at its prompt (${state}), so nothing was typed` });
      }
      done = await send(text);
    } catch (err) {
      const message = String(err?.message ?? err).split('\n')[0];
      if (err?.typing) {
        console.warn('statusd: text not sent, tmux could not type it', { chars: text.length, partial: err.partial, message });
        // Part of it went in: it is in the box, unsent, like a message a prompt cut off, and is not to be sent again.
        if (err.partial) {
          return reply(res, 409, { why: 'partly-typed', typed: true, error: 'part of the message went into the agent\'s box before typing failed: it is not sent. Send or clear it in the TUI tab' });
        }
        return reply(res, 500, { why: 'not-typed', error: 'the message could not be typed into the agent\'s terminal' });
      }
      console.warn('statusd: text not sent, the pane could not be read', { chars: text.length, message });
      return reply(res, 503, { why: 'pane-unread', error: 'the agent\'s terminal could not be read, so it was not sent: try again' });
    } finally {
      paneLock.release('send');
    }
    if (!done.sent) {
      const agent = CODEX ? 'codex' : 'claude';
      const ask = done.kind === 'question' ? `${agent} is asking a question` : done.kind === 'menu' ? `${agent} shows a menu to pick from` : `${agent} is waiting for an approval`;
      if (done.kind === 'box') {
        return reply(res, 409, { why: 'prompt-open', typed: true, error: `someone typed into ${agent}'s box as this went in: both are there, not sent. Send or clear them in the TUI tab` });
      }
      return reply(res, 409, {
        why: 'prompt-open', typed: done.typed,
        error: done.typed && !done.kind
          ? `${agent}'s terminal could not be read again once this was typed: it is in ${agent}'s box, not sent. Send it from the TUI tab`
          : done.typed
          ? `${ask}, which came up as this was typed: it is in ${agent}'s box, not sent. Answer it, then send it from the TUI tab`
          : `${ask}: ${done.kind === 'question' ? 'answer it' : done.kind === 'menu' ? 'pick in the TUI tab' : 'approve or deny it'} first, then send this`,
      });
    }
    return reply(res, 200, { ok: true });
  }
  if (route === 'POST /interrupt') {
    await interrupt();
    return reply(res, 200, { ok: true });
  }
  if (route === 'GET /prompt') {
    // A pane that could not be read is not one that asks nothing: said so, for the page to send the person to the TUI tab.
    let pane;
    try {
      pane = await capturePane();
    } catch (err) {
      console.warn('statusd: prompt not read, the pane could not be read', { message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 503, { why: 'pane-unread', error: `${CODEX ? 'codex' : 'claude'}'s terminal could not be read` });
    }
    return reply(res, 200, promptReply(readPrompt(pane)));
  }
  if (route === 'POST /answer') {
    let body;
    try {
      body = parseAnswerBody(await readBody(req));
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    const done = await answer(body);
    return reply(res, done.status, done.body);
  }
  if (route === 'POST /claude-login') {
    try {
      return reply(res, 200, { ok: true, ...(await startClaudeLogin()) });
    } catch (err) {
      // An open prompt would take the command's Enter; a pane that could not be read might be showing one. A refusal
      // with a status of its own (a session that has seen production data) keeps it.
      return reply(res, err.status ?? 409, { error: err.message });
    }
  }
  if (route === 'POST /taint') {
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      return reply(res, 400, { error: 'not JSON' });
    }
    return reply(res, 200, await taint(body));
  }
  if (route === 'POST /checkpoint') return reply(res, 200, await checkpoint());
  if (route === 'POST /upload') return uploadReply(req, res);
  if (route === 'GET /applog') return reply(res, 200, await appLogs());
  if (route === 'GET /diff') {
    const diff = await readSessionDiff({ repoDir: REPO_DIR });
    return diff.ok ? reply(res, 200, diff) : reply(res, diff.status, { error: diff.error });
  }
  if (route === 'GET /transcript') {
    const params = new URL(req.url, 'http://statusd').searchParams;
    const limit = params.get('limit');
    const since = Number(params.get('since'));
    const read = await readSessionTranscript({
      agent: CODEX ? 'codex' : 'claude',
      claudeDir: transcriptDir(),
      root: REPO_DIR,
      codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(params.get('since') && Number.isFinite(since) ? { since } : {}),
    }).catch((err) => {
      console.warn('statusd: transcript not read', { message: err?.message });
      return null;
    });
    return read ? reply(res, 200, read) : reply(res, 500, { error: 'the transcript could not be read' });
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
  if (route === 'POST /app/start') {
    // A console from before several apps sends no body: the default app.
    let name;
    try {
      name = JSON.parse((await readBody(req)) || '{}')?.app;
    } catch {
      return reply(res, 400, { error: 'body must be JSON' });
    }
    try {
      return reply(res, 200, await startApp(name));
    } catch (err) {
      if (err.status === 400) return reply(res, 400, { error: err.message });
      throw err;
    }
  }
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
  server.listen(PORT, HOST, () => console.log('statusd: listening', { port: PORT }));
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
