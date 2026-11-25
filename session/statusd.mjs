// statusd: the only port the console talks to inside a session task.
//
//   GET  /status      what claude is doing, its last message, the branch, its head and its PR, and what the
//                     container uses (usage.mjs), and how much of the owner's plan is used (planUsage.mjs, codexPlanUsage.mjs, grokPlanUsage.mjs)
//   GET  /applog      the end of the app's logs: its start, the backend's and the frontend's
//   GET  /diff        the checkout against its merge base with the default branch, uncommitted work included, as one
//                     plain unified diff (sessionDiff.mjs)
//   /shed-review/...   the Review tab: the shed's own review page and server (reviewShed/), reached through the console's
//                     /review and /reviews/claude-<id>/...
//   POST /send        {"text": "...", "agentOnly"?: true} typed into the agent's pane, then Enter, only at its prompt
//                     between turns; 409 while the pane shows a question or an approval, which the Enter would answer;
//                     with agentOnly, also a 409 unless claude or codex is what runs in the pane
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
//                     pane's prompt with no Enter (terminalFiles.mjs); `typed` false where it could not be (Herdr)
//   GET  /image?path=<path>   a picture a terminal path names, inside the repo, the uploads or claude's scratchpad
//   POST /scroll      {"steps": -3, "pane": "agent"}   a swipe or wheel the browser's own scrollback did not take
//   GET  /transcript?limit=<n>&since=<writtenAt>   the conversation so far from the agent's own record of it, for the
//                     console's Chat tab: what was asked, said and run (sessionTranscript.mjs). With `since`, only
//                     {unchanged: true} while nothing was written after it
//   POST /interrupt   Esc typed into the agent's pane (Ctrl+C into Grok Build's, which Esc never stops): every agent
//                     stops its turn on it
//   GET  /agents      the agents started beside the session's own (agents.mjs), each with its state: a private coding
//                     session's on Claude Code or Codex alone, 404 anywhere else
//   POST /agents      {"agent": "claude"|"codex", "model", "effort", "permissionMode", "prompt"} starts another, in a tmux
//                     session of its own in the same checkout; 409 once the session is tainted, or with three running
//   POST /agents/with-claude-token   starts Claude beside Grok Build or OpenCode with the owner's claudeToken
//   ANY  /agents/<id>/transcript|send|interrupt|prompt|answer|stop   as the routes of the same names, for that agent:
//                     its own record of its conversation, a message typed into its pane (held while it works, and typed
//                     once it is back at its prompt), Esc, what it asks and the answer; stop ends it
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
import { appendFileSync, createReadStream, existsSync, openSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { parseTranscriptTail } from '../shared/sessionState.mjs';
import { STATE_FILE } from './hookState.mjs';
import { readOpened } from './openedPulls.mjs';
import { STOP_TIMEOUT_MS, SYNC_EVERY_MS, exchange, readState, syncOnce, writeState } from './settingsSync.mjs';
import { imageFor, saveUpload, scrollPane, typePaths } from './terminalFiles.mjs';
import { readDisk, readUsage, usageBetween } from './usage.mjs';
import { readPlanUsage } from './planUsage.mjs';
import { readCodexPlanUsage } from './codexPlanUsage.mjs';
import { readGrokPlanUsage } from './grokPlanUsage.mjs';
import { TAINTED_CLAUDE_FLAGS, applyTaint, isTaintSetUp, isTainted, markTaintSetUp } from './taint.mjs';
import { lastInterruptAt, openToolCalls, paneState, stateReader } from './agentState.mjs';
import { AGENT_ID_RE, createAgents, openRollout } from './agents.mjs';
import { agentPane } from './agentPane.mjs';
import { Refusal, answerApproval, answerQuestions, composerEmpty, composerText, draftInBox, readPrompt, typeMessage, typingSteps } from './panePrompt.mjs';
import { createReviewHost } from './reviewShed/host.mjs';
import { createCodeEditor } from './codeEditor.mjs';
import { readSessionDiff } from './sessionDiff.mjs';
import { ownClaudeTranscript, readSessionTranscript } from './sessionTranscript.mjs';
import { ENGINE_NAMES, viewersOf } from '../shared/databases/index.mjs';
import { expandPath, loadProject, usesVariable } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';
import { createRequire } from 'node:module';
import { EXEC_PATH, handleExecUpgrade } from './execPipe.mjs';

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
const PR_CACHE_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SEND_CHARS = 8000;
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
// The container's start too: the entrypoint execs statusd, and the task ends when it does, so it never restarts.
const STARTED_AT = Date.now();
const CONSOLE_URL = process.env.WOODSHED_CONSOLE_URL || '';
const ASK = process.env.SESSION_MODE === 'ask';
// A QA session (session/qa.sh) tests a pull request's branch and changes nothing on it: it pushes nothing, and the
// pull request it tests is not one it opened. Its run is working while QA_RUNNING is there, and done after.
const QA = process.env.SESSION_MODE === 'qa';
const QA_RUNNING = '/tmp/qa-running';
// The entrypoint starts Redis and its viewer only for a project whose env mentions REDIS_URL (startRedisIfUsed), so
// Open ▾ offers Redis only then.
const REDIS = !ASK && PROJECT !== null && usesVariable(PROJECT, 'REDIS_URL');
// The engines whose viewers the entrypoint started (startDbViewers), so Open ▾ offers this session's own: none for a
// session with no database, null where no entrypoint said (an ask session, a test), which reports nothing.
const DB_VIEWERS = process.env.WOODSHED_DB_VIEWERS == null ? null
  : process.env.WOODSHED_DB_VIEWERS.split(/\s+/).filter((name) => ENGINE_NAMES.includes(name));
// The session's agent (shared/agents.cjs): claude unless the console started it on another (AGENT).
const AGENTS = createRequire(import.meta.url)('../shared/agents.cjs');
const AGENT = AGENTS.isAgent(process.env.AGENT) ? process.env.AGENT : 'claude';
const CLAUDE = AGENT === 'claude';
const CODEX = AGENT === 'codex';
const GROK = AGENT === 'grok';
// The agents whose input box statusd reads from the screen (panePrompt.mjs, composerText): claude's and codex's. The
// others' boxes are not read: a message to them is typed only between turns, with no prompt on screen, as for any.
const READS_BOX = CLAUDE || CODEX;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_AUTH_FILE = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
// The copy the entrypoint was given, to tell whether this session refreshed the login.
const CODEX_GIVEN_FILE = path.join(os.homedir(), '.config/woodshed/codex-auth');
// The own sign-in of Grok Build or OpenCode, which refresh a login whose refresh token works once: where the agent keeps
// it, and the copy the entrypoint was given (configureGrok, configureOpencode). An API key never changes, so none goes
// back.
const OWN_AUTH_FILES = {
  grok: path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'auth.json'),
  opencode: path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json'),
};
const AGENT_GIVEN_FILE = path.join(os.homedir(), '.config/woodshed/agent-auth');
// What a Claude home keeps across sessions: logins (MCP OAuth in .credentials.json), memory, settings, transcripts,
// and the installed plugins' files, which are a few MB and much slower to fetch from GitHub again. Caches and
// per-machine state are rebuilt in a moment, and only make the archive bigger.
const HOME_EXCLUDES = ['.claude/statsig', '.claude/shell-snapshots', '.claude/ide', '.claude/debug', '.claude/downloads'];
// The whole save, not each read: the console gives a checkpoint 90 s, and the push after this needs some of it.
const HOME_SAVE_TIMEOUT_MS = 30_000;
// A task that ends without a checkpoint (a crash, Fargate taking it back) loses at most this much of the home.
// Keep it above HOME_SAVE_TIMEOUT_MS: periodicSave tracks one periodic save, so two must never overlap.
const HOME_SAVE_EVERY_MS = 5 * 60_000;
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

// The readers of the agent's state, and the pane they read: statusd's tests and older callers import them from here.
export { claudeState, lastInterruptAt, openToolCalls, paneState } from './agentState.mjs';
export { AGENT_PANE_FORMAT } from './agentPane.mjs';

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
 * @param {string} raw  request body, already accepted by parseSendBody
 * @returns {boolean}  whether the text may only be typed while the agent runs in its pane (`agentOnly`), never into
 *   the shell it leaves behind
 */
export function sendAgentOnly(raw) {
  try {
    return JSON.parse(raw)?.agentOnly === true;
  } catch {
    return false;
  }
}

/**
 * @param {string} raw  request body, already accepted by parseSendBody
 * @returns {{url: string, headSha: string|null}|null}  the pull request an agentOnly text is about (`prUrl`, and the
 *   commit `headSha`): it is typed only while the branch checked out has that one, open and on that commit, read
 *   afresh just before
 */
export function sendForPr(raw) {
  try {
    const body = JSON.parse(raw);
    const url = body?.prUrl;
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) return null;
    const headSha = typeof body.headSha === 'string' && /^[0-9a-f]{7,40}$/i.test(body.headSha) ? body.headSha : null;
    return { url, headSha };
  } catch {
    return null;
  }
}

/**
 * @param {{url?: string, state?: string, headRefOid?: string}|null} pull  `gh pr view`'s answer for the branch checked out
 * @param {{url: string, headSha: string|null}} wanted
 * @returns {boolean}  whether it is still the pull request the text is about: the same one, open, on the same commit
 */
export function stillThePull(pull, wanted) {
  if (!pull || !samePrUrl(pull.url, wanted.url) || pull.state !== 'OPEN') return false;
  return !wanted.headSha || String(pull.headRefOid ?? '').toLowerCase().startsWith(wanted.headSha.toLowerCase());
}

/**
 * @param {string} raw  request body, already accepted by parseSendBody
 * @returns {number|null}  how long after statusd got it a guarded text may still be typed (`withinMs`, at most a
 *   minute): its caller gives up and tries again after that, so typing it later would type it twice
 */
export function sendWithinMs(raw) {
  try {
    const ms = JSON.parse(raw)?.withinMs;
    return Number.isInteger(ms) && ms > 0 ? Math.min(ms, 60_000) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} raw  request body, already accepted by parseSendBody
 * @returns {number|null}  the time, in ms since the epoch, after which a guarded text is no longer typed (`notAfter`):
 *   its caller's own deadline, which time in transit counts toward
 */
export function sendNotAfter(raw) {
  try {
    const at = JSON.parse(raw)?.notAfter;
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

/** @returns {boolean}  whether two pull request URLs are the same pull request (GitHub's owner and name ignore case) */
export function samePrUrl(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

// What tmux names the pane's command while an agent runs in it (shared/agents.cjs); the shell left after one exits is
// not one.
const AGENT_COMMANDS = new Set(AGENTS.PROCESS_NAMES);

/** @returns {boolean}  whether tmux's `pane_current_command` is the agent's */
export function isAgentCommand(command) {
  return AGENT_COMMANDS.has(String(command ?? '').trim());
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

/**
 * The pull request of the branch checked out now, kept a minute for that branch (with its upstream and remote URL)
 * only, so a checkout of another branch, the branch set to track another, or its remote pointed elsewhere, is reported
 * at the next read. A checkout during the lookup leaves its answer unkept and unsaid: it may be either
 * branch's.
 * @param {{branch: () => Promise<string|null>, lookup: () => Promise<string|null>, now?: () => number, cacheMs?: number}} deps
 * @returns {() => Promise<string|null>}
 */
export function createPrLookup({ branch, lookup, now = Date.now, cacheMs = PR_CACHE_MS }) {
  let cache = { at: -Infinity, url: null, branch: null };
  return async function prUrl() {
    const before = await branch().catch(() => null);
    if (now() - cache.at < cacheMs && before === cache.branch) return cache.url;
    let url = null;
    try {
      url = (await lookup()) || null;
    } catch {
      // No PR for this branch yet, which is the normal state for most of a session.
    }
    const after = await branch().catch(() => null);
    if (after !== before) return null;
    cache = { at: now(), url, branch: before };
    return url;
  };
}

/**
 * What a pull request lookup is kept for: the branch, its upstream, that remote's URL and the branch's own remote and
 * merge settings, since a branch set to track another remote branch or pull request's ref, or a remote pointed at
 * another repo, has another pull request.
 * @param {(...args: string[]) => Promise<string>} gitRun
 * @returns {Promise<string>}
 */
export async function prLookupKey(gitRun) {
  const branch = await gitRun('branch', '--show-current');
  return [
    branch,
    await gitRun('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').catch(() => ''),
    await gitRun('ls-remote', '--get-url').catch(() => ''),
    // What the branch merges from and where, as `gh pr checkout` sets them: a pull request's ref
    // (`refs/pull/<n>/head`) is no remote-tracking branch, so @{u} names none of them.
    ...(branch ? [
      await gitRun('config', '--get', `branch.${branch}.remote`).catch(() => ''),
      await gitRun('config', '--get', `branch.${branch}.merge`).catch(() => ''),
      await gitRun('config', '--get', `branch.${branch}.pushRemote`).catch(() => ''),
    ] : []),
  ].join(' ');
}

const BRANCH_PULLS_MAX_BRANCHES = 20;

/**
 * The pull requests of every local branch of the checkout, not only the one checked out: a branch a session opened a
 * pull request from in a git worktree, or pushed and left for the next, is never the branch `gh pr view` asks about.
 * A worktree's branches are the checkout's own. One GraphQL call for all of them, kept `cacheMs` while the branches and
 * their commits stay as they were. A pull request counts only when it is from this repo's own branch of that name and
 * its head commit is on the local branch, so an older pull request that once used the name is not taken for it.
 * A failed read gives the last good list and is kept `cacheMs` too: the console keeps what it was told before.
 * @param {{branches: () => Promise<{name: string, sha: string}[]>, pullsOf: (names: string[]) => Promise<{branch: string, url: string, headSha: string, fork: boolean}[]>,
 *          isAncestor: (sha: string, branch: string) => Promise<boolean>, now?: () => number, cacheMs?: number}} deps
 *   `branches` is the local branches without the default one, the newest commit first
 * @returns {() => Promise<string[]>}  their pull requests' URLs, the lowest number first
 */
export function createBranchPulls({ branches, pullsOf, isAncestor, now = Date.now, cacheMs = PR_CACHE_MS }) {
  let cache = { at: -Infinity, key: null, urls: [] };
  let said = null;
  return async function branchPulls() {
    let key = null;
    try {
      const local = (await branches()).slice(0, BRANCH_PULLS_MAX_BRANCHES);
      key = local.map((b) => `${b.name} ${b.sha}`).join('\n');
      if (now() - cache.at < cacheMs && key === cache.key) return cache.urls;
      const urls = [];
      for (const pull of local.length ? await pullsOf(local.map((b) => b.name)) : []) {
        if (pull.fork || !/\/pull\/\d+$/.test(pull.url ?? '')) continue;
        if (await isAncestor(pull.headSha, pull.branch).catch(() => false)) urls.push(pull.url);
      }
      const number = (url) => Number(url.split('/').pop());
      cache = { at: now(), key, urls: [...new Set(urls)].sort((a, b) => number(a) - number(b)) };
      said = null;
      return cache.urls;
    } catch (err) {
      // Asked at every status read: each reason is said once.
      const message = String(err?.message ?? err).split('\n')[0];
      if (message !== said) console.warn('statusd: pull requests of the other branches not read', { message });
      said = message;
      // Kept for its minute as a good answer is, with the last good list: a call GitHub refuses (a rate limit on a
      // token the sessions share) is not made again at every status read. Changed branches ask again at once.
      cache = { at: now(), key, urls: cache.urls };
      return cache.urls;
    }
  };
}

/**
 * @param {string} remoteUrl  the checkout's remote, as `git ls-remote --get-url` gives it
 * @returns {{owner: string, name: string}|null}  the GitHub repo it names
 */
export function githubRepoOf(remoteUrl) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(remoteUrl ?? '').trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

/**
 * @param {string[]} names  branch names
 * @returns {{query: string, variables: Record<string, string>}}  one aliased `pullRequests` per branch
 */
export function branchPullsQuery(names) {
  const fields = names.map((_, i) => `b${i}: pullRequests(first: 5, orderBy: {field: CREATED_AT, direction: DESC}, headRefName: $b${i}) { nodes { url headRefName headRefOid isCrossRepository } }`);
  const declared = names.map((_, i) => `$b${i}: String!`).join(', ');
  return {
    query: `query($owner: String!, $name: String!, ${declared}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`,
    variables: Object.fromEntries(names.map((branch, i) => [`b${i}`, branch])),
  };
}

async function localBranches() {
  const defaultBranch = (await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')).replace(/^origin\//, '');
  const refs = await git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short) %(objectname)', 'refs/heads');
  return refs.split('\n').filter(Boolean).map((line) => {
    const at = line.lastIndexOf(' ');
    return { name: line.slice(0, at), sha: line.slice(at + 1) };
  }).filter((b) => b.name !== defaultBranch);
}

async function ghBranchPulls(names) {
  const repo = githubRepoOf(await git('ls-remote', '--get-url'));
  if (!repo) return [];
  const { query, variables } = branchPullsQuery(names);
  const fields = Object.entries({ owner: repo.owner, name: repo.name, ...variables }).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
  const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query}`, ...fields], { cwd: REPO_DIR, maxBuffer: 4 * 1024 * 1024 });
  return Object.values(JSON.parse(stdout).data?.repository ?? {}).flatMap((found) => found?.nodes ?? [])
    .map((pull) => ({ branch: pull.headRefName, url: pull.url, headSha: pull.headRefOid, fork: pull.isCrossRepository === true }));
}

const lookupBranchPulls = createBranchPulls({
  branches: localBranches,
  pullsOf: ghBranchPulls,
  isAncestor: async (sha, branch) => { await git('merge-base', '--is-ancestor', sha, `refs/heads/${branch}`); return true; },
});

// The checkout's branches' pull requests, then those claude opened from anywhere else (openedPulls.mjs): the console
// keeps the ones on a repo of its projects.
async function prUrls() {
  if (ASK || QA) return [];
  return [...new Set([...await lookupBranchPulls(), ...readOpened()])];
}

const ghPrUrl = async () => (await run('gh', ['pr', 'view', '--json', 'url', '--jq', '.url'], { cwd: REPO_DIR })).stdout.trim();
const lookupPrUrl = createPrLookup({ branch: () => prLookupKey(git), lookup: ghPrUrl });
// The pull request of the branch checked out, read afresh for a guarded send.
const ghPullNow = async () => JSON.parse((await run('gh', ['pr', 'view', '--json', 'url,state,headRefOid'], { cwd: REPO_DIR })).stdout);

async function prUrl() {
  if (ASK || QA) return null;
  return lookupPrUrl();
}

// Claude names a project's transcript folder after its path, with every / and . as -.
function transcriptDir() {
  return path.join(os.homedir(), '.claude', 'projects', REPO_DIR.replace(/[/.]/g, '-'));
}

// When the entrypoint began restoring the Claude home (restoreHome in entrypoint.sh), in ms: a transcript last written
// before it came with the home, from an earlier session of the owner's, and is not this one's. 0 when nothing was
// restored, or the entrypoint wrote no time. WOODSHED_HOME_RESTORED_FILE moves it, for the dev console's chat sessions
// (console/bin/devChatSession.mjs), each with a statusd of its own; the fleet never sets it, so it is in no
// PER_SESSION_ENV (providers/aws/ecsLauncher.mjs).
export const HOME_RESTORED_FILE = process.env.WOODSHED_HOME_RESTORED_FILE || '/tmp/woodshed-home-restored-from';
export function readHomeRestoredFrom(file = HOME_RESTORED_FILE) {
  try {
    const ms = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0;
  }
}
const OWN_TRANSCRIPTS = { writtenFrom: readHomeRestoredFrom(), resume: process.env.RESUME_SESSION || null };

// The transcript claude writes to now, in this session (ownClaudeTranscript). Its name is claude's own session id,
// which `claude --resume` takes.
async function newestTranscript() {
  return ownClaudeTranscript(transcriptDir(), { ...OWN_TRANSCRIPTS, skip: agents?.claimed().claude });
}

// The agents a person starts beside the session's own (agents.mjs): in a private coding session alone, never a shared
// one, a question, a QA run or a review. The entrypoint writes the claude flags they start with, and says when codex is
// set up (configureCodex). WOODSHED_AGENT_BIN, WOODSHED_AGENT_CLAUDE_FLAGS_FILE, WOODSHED_CODEX_READY_FILE and
// WOODSHED_AGENT_STATE_DIR move them
// for the dev console's made-up sessions (console/bin/devChatSession.mjs): the fleet never sets them, so they are in no
// PER_SESSION_ENV (providers/aws/ecsLauncher.mjs).
const CODEX_READY_FILE = process.env.WOODSHED_CODEX_READY_FILE || '/tmp/woodshed-codex-ready';
const agents = process.env.SESSION_KIND === 'private' && !ASK && !QA && process.env.SESSION_MODE !== 'review' ? createAgents({
  run,
  repoDir: REPO_DIR,
  bin: process.env.WOODSHED_AGENT_BIN || path.join(import.meta.dirname, 'bin'),
  claudeDir: transcriptDir(),
  codexHome: CODEX_HOME,
  claudeFlagsFile: process.env.WOODSHED_AGENT_CLAUDE_FLAGS_FILE || '/tmp/woodshed-agent-claude-flags',
  codexReady: async () => existsSync(CODEX_READY_FILE),
  codexEnv: codexBeside,
  claudeEnv: AGENTS.agent(AGENT).teamCredential ? undefined : claudeBeside,
  uploadsDir: process.env.UPLOADS_DIR || '/tmp/uploads',
  stateDir: process.env.WOODSHED_AGENT_STATE_DIR || '/tmp',
  tainted: () => tainted(),
  // Where the session's own agent runs, the agents beside it run too: tmux, or Herdr (agentPane.mjs).
  terminal: process.env.WOODSHED_TERMINAL === 'herdr' ? 'herdr' : 'tmux',
  hcBin: process.env.WOODSHED_HC_BIN || 'hc',
}) : null;

// Start Claude with the owner's own token. Hold it outside every saved home and pass only its filename to the pane.
async function claudeBeside(token) {
  if (!token) throw Object.assign(new Error('save your Claude token on My settings first, then start Claude from the console'), { status: 409 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-extra-claude-'));
  const file = path.join(dir, 'token');
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {
    console.warn('statusd: could not remove an extra Claude token file');
  });
  try {
    await fs.writeFile(file, token, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { env: { WOODSHED_CLAUDE_AUTH: 'own', WOODSHED_CLAUDE_TOKEN_FILE: file }, undo: cleanup, cleanup };
}

// An extra Codex agent: its sign-in, the owner's own from My settings when they saved one, which the console sends
// with the start (console/server.mjs, agentAction) and nothing here asks for, written into codex's home as configureCodex
// writes it; with none, the console's proxy and the team key (session/bin/codex). In a Codex session codex has its own.
// A start that fails after it takes back a sign-in it wrote.
async function codexBeside(given) {
  if (CODEX) return { env: {} };
  const authFile = path.join(CODEX_HOME, 'auth.json');
  if (existsSync(authFile)) {
    console.log('statusd: Codex agent beside claude set up', { own: true, already: true });
    return { env: { WOODSHED_CODEX_AUTH: '' } };
  }
  if (!given) {
    console.log('statusd: Codex agent beside claude set up', { own: false });
    return { env: { WOODSHED_CODEX_AUTH: 'key' } };
  }
  const body = given.startsWith('sk-') ? JSON.stringify({ OPENAI_API_KEY: given.trim() }) : given;
  await fs.writeFile(authFile, body, { mode: 0o600, flag: 'wx' });
  // The copy given, for the stop to tell whether this session refreshed it (keepCodexAuth).
  await fs.mkdir(path.dirname(CODEX_GIVEN_FILE), { recursive: true });
  await fs.writeFile(CODEX_GIVEN_FILE, given, { mode: 0o600 });
  console.log('statusd: Codex agent beside claude set up', { own: true });
  return {
    env: { WOODSHED_CODEX_AUTH: '' },
    undo: async () => {
      await fs.rm(authFile, { force: true });
      await fs.rm(CODEX_GIVEN_FILE, { force: true });
      console.log('statusd: Codex sign-in taken back, the agent did not start');
    },
  };
}

// The rollout the session's own codex writes to: the one its process holds open, and with none open (it exited, or has
// not opened one yet) the newest no agent beside it claimed.
async function ownRollout() {
  if (!agents) return undefined;
  const held = await agentIo().shellPid().then((pid) => openRollout(pid, CODEX_HOME)).catch(() => null);
  return held ?? undefined;
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

async function hookState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    // No hook has fired yet, or claude started from an image without them.
    return null;
  }
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

// The terminal the agent runs in, tmux's pane or Herdr's (agentPane.mjs), as the entrypoint chose it (WOODSHED_TERMINAL).
let agentPaneIo = null;
const agentIo = () => (agentPaneIo ??= agentPane(run));
const TERMINAL = process.env.WOODSHED_TERMINAL === 'herdr' ? 'herdr' : 'tmux';
// The readers of what the agent is doing (agentState.mjs): its own, and Herdr's when it runs in Herdr.
const readAgent = stateReader({ qa: QA, agent: AGENT, terminal: TERMINAL });

// ChatGPT's refresh token rotates, so the sign-in saved on My settings stops working once a session used it. The
// console keeps the copy only for an owner who saved one, and says 409 to anyone else.
async function keepCodexAuth() {
  // An extra Codex agent in a session that has since seen production data sends nothing back (the console refuses
  // it too): its sign-in file is the session's to write.
  if (!(CODEX || (agents?.ranCodex() && !tainted())) || !CONSOLE_URL || process.env.SESSION_KIND !== 'private') return;
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

// Grok Build's and OpenCode's refreshed login, sent back for My settings to keep, as codex's is: a refresh token they
// used here works once, so the copy saved there stops working. Only a login this session refreshed goes back, never a
// key, and never over a newer one (the console keeps only its owner's own, and says 409 to anyone else).
// The header naming the sign-in the session was given (shared/agents.cjs, signInDigest), as sessionApi.mjs reads it.
export const GIVEN_SIGN_IN_HEADER = 'x-woodshed-given-sign-in';

async function keepAgentAuth() {
  const file = OWN_AUTH_FILES[AGENT];
  if (!file || !CONSOLE_URL || process.env.SESSION_KIND !== 'private') return;
  const name = AGENTS.agent(AGENT).product;
  try {
    const [body, given] = await Promise.all([fs.readFile(file, 'utf8'), fs.readFile(AGENT_GIVEN_FILE, 'utf8').catch(() => null)]);
    if (!changedLogin(given, body)) {
      console.log(`statusd: ${name} sign-in unchanged, not sent back`);
      return;
    }
    // Which sign-in it was given: the console keeps the refresh only while that is still the one it holds.
    const headers = { authorization: `Bearer ${TOKEN}`, [GIVEN_SIGN_IN_HEADER]: AGENTS.signInDigest(given) };
    const res = await fetch(`${CONSOLE_URL}/agent-auth`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    console.log(`statusd: ${name} sign-in sent back`, { status: res.status });
  } catch (err) {
    console.warn(`statusd: ${name} sign-in not sent back`, { message: err?.message });
  }
}

/**
 * Whether the login file now differs from the one the session was given, which was a login (JSON), not a key.
 * @param {string|null} given  the entrypoint's copy of what the console handed out
 * @param {string} now  the agent's file now
 */
export function changedLogin(given, now) {
  if (given === null || !given.trim().startsWith('{')) return false;
  try {
    return JSON.stringify(JSON.parse(given)) !== JSON.stringify(JSON.parse(now));
  } catch {
    return false;
  }
}

/**
 * The agent's state, from its hooks, its record and its pane, as the console's status read has it.
 * @param {{strict?: boolean}} [opts]  strict: a pane that cannot be read throws, rather than reading as empty
 * @returns {Promise<{state: string, source: string, pane: string, tail: object|null, hook: object|null}>}
 */
async function agentState({ strict = false } = {}) {
  let paneText = '';
  try {
    paneText = await agentIo().capture();
  } catch (err) {
    if (strict) throw err;
    console.warn('statusd: capture-pane failed', { message: err?.message, terminal: TERMINAL });
  }
  // Herdr's own word on the agent in its terminal, when it runs there. One it could not give says nothing: the agent's
  // own reader stands alone.
  const herdrStatus = TERMINAL === 'herdr' && !QA ? await agentIo().agent().catch((err) => {
    console.warn('statusd: Herdr\'s status for the agent not read', { message: err?.message });
    return null;
  }) : null;
  const tail = !CLAUDE ? null : await transcriptTail().catch((err) => {
    console.warn('statusd: reading the transcript failed', { message: err?.message });
    return null;
  });
  // Grok Build reports through the same hook file as claude (hookState.mjs).
  const hook = CLAUDE || AGENT === 'grok' ? await hookState() : null;
  // For the agents read from their screens and their own words: whether their program runs at all, which a shell left
  // behind would otherwise not say. claude's and codex's readers read that from their screens.
  const agentOpen = CLAUDE || CODEX || QA ? null : await agentIo().agentRunning().catch(() => null);
  const { state, source } = readAgent({
    paneText,
    qaRunning: QA && existsSync(QA_RUNNING),
    herdrStatus,
    hook,
    interruptedAt: tail ? lastInterruptAt(tail.text) : null,
    transcriptAt: tail?.writtenAt ?? null,
    // With no transcript at all, nothing can be open: the silent rule then works from the hook's time alone.
    openTools: tail ? openToolCalls(tail.text, { partial: tail.partial }) : 0,
    now: Date.now(),
    startedAt: STARTED_AT,
    agentOpen,
  });
  if (state !== lastState) console.log('statusd: claude state changed', { from: lastState, to: state, source });
  lastState = state;
  return { state, source, pane: paneText, tail, hook };
}

// The plan meter's reading for the session's agent: Claude Code's status line, Codex's rollouts, Grok Build's billing
// line in ~/.grok/logs/unified.jsonl. OpenCode keeps only costs, so it has none.
async function readAgentPlanUsage() {
  if (CLAUDE) return readPlanUsage();
  if (CODEX) return readCodexPlanUsage();
  if (GROK) return readGrokPlanUsage();
  return null;
}

async function status() {
  const { state, tail, hook } = await agentState();
  // Text waiting in the agent's box at its prompt: a draft in the TUI tab, or a message left there unsent. Chat says so.
  // true or false only when the box was found on the screen; null when nothing can be said of it (mid-turn, a dialog over
  // it, a pane that could not be read), for the console never to take an unseen box as emptied.
  let boxText = null;
  // A draft is told from claude's dim suggestion by its colours, which Herdr's read does not keep.
  if (state === 'done' && !QA && READS_BOX && agentIo().colours) {
    try {
      const text = composerText(await captureBox(), AGENT);
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
    ...(DB_VIEWERS ? { viewers: DB_VIEWERS } : {}),
    // Only a finished turn has shells that matter: they are what it is still waiting on.
    shells: state === 'done' ? hook?.shells ?? 0 : 0,
    lastMessage: tail ? parseTranscriptTail(tail.text, { partial: tail.partial }).message : null,
    claudeSession: !CLAUDE ? null : (await newestTranscript().catch(() => null))?.name.replace(/\.jsonl$/, '') ?? null,
    // The agents beside the session's own, for the page's switch over Chat and TUI. Left out where none can start.
    ...(agents ? { agents: await agents.list().catch(() => []) } : {}),
    branch: await git('branch', '--show-current'),
    head: await git('rev-parse', '--short', 'HEAD'),
    prUrl: await prUrl(),
    // The pull requests of every local branch, worktrees' included: the card shows each (console/sessions.mjs).
    prUrls: await prUrls(),
    // POST /send takes agentOnly: the console types a private session's review feedback only into a statusd that does.
    agentOnlySend: true,
    usage: await usage(),
    planUsage: await readAgentPlanUsage().catch(planUsageFailed),
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
  if (!CLAUDE) return false;
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
  if (tainted()) throw Object.assign(new Error('this session has seen production data, so Remote Control is off'), { status: 409 });
  if (await hasRemoteControlCommand()) {
    // Typed as a message is: one thing at a time, and only between turns, when no prompt can open under its Enter.
    if (!paneLock.take('login')) throw new Error('a message is going in to claude: sign in once it has');
    try {
      const now = await agentState({ strict: true });
      const { state } = now;
      const working = state === 'working' || (state === 'done' && !atPrompt(now));
      if (working || (state !== 'done' && state !== 'needs-you')) throw new Error(`claude is ${working ? 'working' : `not at its prompt (${state})`}: sign in once its turn ends`);
      if (!lastTaken(state, now.hook, now.pane)) throw new Error('claude has not started on the last message yet: sign in once its turn ends');
      if (agentIo().colours && !(await boxEmpty())) throw new Error('claude\'s box holds text, unsent: send or clear it in the TUI tab first');
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
  // Grok Build cancels its turn on Ctrl+C, and never on Esc; every other agent stops on Esc.
  await agentIo().keys(AGENT === 'grok' ? 'C-c' : 'Escape');
  console.log('statusd: agent interrupted');
}

async function capturePane() {
  return agentIo().capture();
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
  const io = {
    capture: capturePane,
    keys: async (...keys) => { await agentIo().keys(...keys); },
    agent: AGENT,
    // OpenCode's pick shows only as a colour (panePrompt.mjs, opencodeHighlight): a read with them, where the pane has them.
    ...(agentIo().colours ? { colored: () => agentIo().capture({ ansi: true }) } : {}),
    // Grok Build's rows are picked by their number, typed as text: only where the terminal types text (tmux).
    ...(agentIo().typesText ? { literal: async (text) => { await agentIo().literal(text); } } : {}),
  };
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

// How a message is typed (typingSteps) is panePrompt.mjs's, shared with the extra agents (agents.mjs): statusd's tests
// import it from here.
export { typingSteps };

/**
 * A failed tmux call that typed a message, said again without the message: execFile's own error quotes the command
 * line, and what someone typed never goes in a log or a reply.
 * @returns {Error & {typing: true}}
 */
export function typingError(err, partial = false) {
  return Object.assign(new Error(`${TERMINAL} could not type the message (exit ${Number.isInteger(err?.code) ? err.code : 'unknown'})`), { typing: true, partial });
}

// The agent's pane, for typeMessage (panePrompt.mjs): read it, type into it, press Enter.
const paneIo = {
  capture: () => capturePane(),
  async type(text) {
    // A failed call's error quotes its command line, the message's text with it: it is said again without it, since
    // what someone typed never goes in a log.
    let done = 0;
    try {
      for (const step of typingSteps(text, AGENT)) {
        if (step.paste !== undefined) await agentIo().paste(step.paste);
        else if (step.keys !== undefined) await agentIo().literal(step.keys);
        else await agentIo().keys(step.key);
        done++;
        await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
      }
    } catch (err) {
      // Part of it may be in the box already: said so, for nothing to send the whole of it again.
      throw typingError(err, done > 0);
    }
  },
  enter: () => agentIo().keys('Enter'),
  // What the box holds, read with its colours: only the text typed, before the Enter.
  // A long draft runs off the top of the screen, so the box is read with scrollback enough to hold all of it.
  // Only claude's and codex's boxes are read (READS_BOX): for the others the look for a prompt before and after the text
  // stands alone.
  ...(READS_BOX ? { box: async (text = '') => composerText(await captureBox(text.split('\n').length + 100), AGENT) } : {}),
};

/**
 * A message typed in and sent, never into a prompt (typeMessage). Throws when the pane could not be read.
 * @returns {Promise<{sent: true}|{sent: false, kind: string, typed: boolean}>}
 */
async function send(text) {
  // hc types text only as a paste with its Enter, and only while the agent says it is idle: its own send, which also
  // holds for a person's draft in an attached client, stands for typeMessage's reads of the box.
  const done = agentIo().typesText ? await typeMessage(paneIo, text) : await sendThroughHerdr(text);
  if (done.sent) lastSent = { at: Date.now(), seenWorking: false };
  if (done.sent) console.log('statusd: text sent to claude', { chars: text.length, paste: !CLAUDE, agent: AGENT });
  else console.log('statusd: text not sent, a prompt is open', { kind: done.kind, typed: done.typed, chars: text.length });
  return done;
}

async function sendThroughHerdr(text) {
  const done = await agentIo().send(text);
  if (done.sent) return done;
  console.log('statusd: Herdr did not send the message', { why: done.why, kind: done.kind ?? null });
  // A prompt on screen is said as typeMessage says it, blocked (hc's word for one) as an approval; anything else (not
  // idle, not at its prompt, a draft held past hc's wait) is nothing typed.
  if (done.why === 'prompt-open') return { sent: false, kind: done.kind, typed: false };
  return { sent: false, kind: done.why === 'blocked' ? null : 'herdr', typed: false };
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
  return agentIo().capture({ ansi: true, back });
}

async function boxEmpty() {
  const colored = await captureBox();
  // A prompt on screen is typeMessage's to refuse, as the prompt it is. No box found at all is no place to type.
  if (readPrompt(colored.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) return true;
  // Grok Build's and OpenCode's: a draft seen there holds the message back; a box this cannot read is taken as empty, as
  // it was before it was read (draftInBox).
  if (AGENT === 'grok' || AGENT === 'opencode') return draftInBox(colored, AGENT) !== true;
  // A box statusd does not read is taken as empty: the agent is at its prompt between turns, with no prompt on screen.
  if (!READS_BOX) return true;
  return composerEmpty(colored, AGENT) === true;
}

// At its prompt between turns: its state says done, and, for claude, whose state is its hooks', its screen agrees. A
// stale hook can say done while the pane shows a turn running ("esc to interrupt") or a dialog: neither is the time
// for an Enter. codex's state is its pane's already.
function atPrompt({ state, pane }) {
  if (state !== 'done') return false;
  if (!CLAUDE) return true;
  const shown = paneState(pane);
  return shown !== 'working' && shown !== 'needs-you';
}

function lastTaken(state, hook, pane) {
  if (!lastSent) return true;
  if (state !== 'done' || (CLAUDE && paneState(pane) === 'working')) lastSent.seenWorking = true;
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
// Set once the stop's checkpoint starts: guarded sends (agentOnly) type nothing from then on.
let stopping = false;

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
// Where the sync keeps what it last synced: the session's fixed path, or a test's own (statusd.test.mjs), which must
// never write the one of the session it runs in.
const SETTINGS_STATE_FILE = process.env.WOODSHED_SETTINGS_STATE_FILE || undefined;

function syncSettings(timeoutMs) {
  // A tainted session's settings stay its own: the console refuses them, so nothing is sent.
  if (settingsOver || tainted()) return Promise.resolve();
  settingsRound ??= settingsRoundOnce(timeoutMs).finally(() => { settingsRound = null; });
  return settingsRound;
}

async function settingsRoundOnce(timeoutMs) {
  settingsState ??= await readState(SETTINGS_STATE_FILE);
  const result = await syncOnce({
    home: os.homedir(), state: settingsState, live: true, send: (body) => exchange({ consoleUrl: CONSOLE_URL, token: TOKEN, body, timeoutMs }),
  });
  if (!result) return;
  const moved = result.sent + result.removed + result.written + result.deleted;
  settingsState = result.state;
  if (!moved) return;
  await writeState(settingsState, SETTINGS_STATE_FILE);
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

// keepRunningOnFailure: a hand-off's checkpoint (console/handoff.mjs), which the console stops the session after only
// when the push went through. When it fails the session runs on as before: its sends and home saves start again, and
// its work stays in the checkout, committed.
async function checkpoint({ keepRunningOnFailure = false } = {}) {
  const before = { homeSavesOver, stopping, settingsOver };
  homeSavesOver = true;
  // The session is stopping: a guarded send still checking GitHub types nothing now.
  stopping = true;
  try {
    return await checkpointNow();
  } catch (err) {
    if (keepRunningOnFailure) {
      // Each as it was before: the last settings round (lastSettingsRound) turned the sync off too. A taint since keeps
      // it off.
      homeSavesOver = before.homeSavesOver;
      stopping = before.stopping;
      settingsOver = before.settingsOver || tainted();
      console.warn('statusd: checkpoint failed, the session runs on', { message: String(err?.message ?? err).split('\n')[0] });
    }
    throw err;
  }
}

async function checkpointNow() {
  await keepCodexAuth();
  await keepAgentAuth();
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
// A test's own folder for every file of the taint, and the claude its reopen starts (statusd.test.mjs): set by no
// launcher, so a session's are the fixed paths below. A test that wrote those would taint the machine it runs on.
const TAINT_DIR = process.env.WOODSHED_TAINT_DIR || null;
const inTaintDir = (name) => path.join(TAINT_DIR, name);
const TAINT_FILES = TAINT_DIR
  ? { marker: inTaintDir('tainted'), setUp: inTaintDir('set-up'), envFile: inTaintDir('egress.env'), bundle: inTaintDir('egress-ca.pem'), claudeJson: inTaintDir('claude.json'), profiles: [], mcpConfig: inTaintDir('mcp.json') }
  : {};
const RULES_FILE = TAINT_DIR ? inTaintDir('rules.md') : '/tmp/woodshed-rules.md';
const TAINT_MESSAGE_FILE = TAINT_DIR ? inTaintDir('message.md') : '/tmp/woodshed-taint-message.md';
const CLAUDE_BIN = process.env.WOODSHED_CLAUDE_BIN || path.join(import.meta.dirname, 'bin', 'claude');
const tainted = () => isTainted(TAINT_FILES.marker);
// How long claude's turn may run before it is reopened anyway, and how long it has to stop.
const TAINT_TURN_WAIT_MS = 5 * 60_000;
let tainting = null;

async function taint({ proxy = null, ca = null, message = '' }) {
  // Done only once every step below was: a setup that failed partway is finished by the console's next notice.
  if (isTaintSetUp(TAINT_FILES.setUp)) return { already: true };
  const { egress, variables } = await applyTaint({ proxy, ca, token: TOKEN, env: process.env, repoDir: REPO_DIR, files: TAINT_FILES });
  // statusd's own git (the stop's checkpoint push) goes out the same way.
  Object.assign(process.env, variables);
  settingsOver = true;
  const rules = await fs.readFile(RULES_FILE, 'utf8').catch(() => '');
  if (!rules.includes('This session has seen production data')) await fs.appendFile(RULES_FILE, await fs.readFile(path.join(import.meta.dirname, 'tainted.md'), 'utf8'));
  const flags = await fs.readFile(CLAUDE_FLAGS_FILE, 'utf8').catch(() => '');
  // First: --disallowedTools takes several values, so the flag after it must be another flag, never the message.
  if (!flags.includes('--strict-mcp-config')) await fs.writeFile(CLAUDE_FLAGS_FILE, `${TAINTED_CLAUDE_FLAGS}${flags.trimEnd()}`);
  await fs.writeFile(TAINT_MESSAGE_FILE, String(message || 'This session has seen production data and is now locked down.'));
  await markTaintSetUp(TAINT_FILES.setUp);
  // The agents beside the session's own are not reopened on the console's proxy: they stop.
  await agents?.stopAll('tainted');
  console.log('statusd: tainted', { egress, reopens: CLAUDE });
  if (CLAUDE) tainting ??= reopenClaude().catch((err) => console.warn('statusd: claude not reopened after the taint', { message: err?.message }));
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
  const claude = await childrenOf(await agentIo().shellPid());
  for (const pid of claude) process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100 && claude.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  for (const pid of claude.filter(alive)) process.kill(pid, 'SIGKILL');
  const flags = (await fs.readFile(CLAUDE_FLAGS_FILE, 'utf8').catch(() => TAINTED_CLAUDE_FLAGS)).trim();
  const resume = conversation && /^[0-9a-f-]{36}$/.test(conversation) ? ` --resume ${conversation}` : '';
  await agentIo().line(`${CLAUDE_BIN} ${flags}${resume} "$(cat ${TAINT_MESSAGE_FILE})"`);
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
  // The exec pipe, from the console for the session's person (execPipe.mjs): never an app's request.
  if (!(APP_HEADER in req.headers) && String(req.url || '/').split('?')[0] === EXEC_PATH) {
    return handleExecUpgrade(req, socket, head, { isAuthorized: (header) => isAuthorized(header, token), cwd: REPO_DIR, tainted, ask: ASK });
  }
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
    // Herdr types no text without an Enter, so a file dropped on the agent there is saved and not typed in here: the
    // answer says so (`typed: false`), and the page types its path through the terminal's own connection, as a paste.
    // The Terminal tab's shell is tmux's always.
    // An agent beside the session's own (agents.mjs) is in tmux always, under its own name.
    const typed = pane === 'terminal' || (pane === 'agent' && agentIo().typesText) || (agents && TERMINAL === 'tmux' && AGENT_ID_RE.test(pane ?? '')) ? pane : null;
    if (typed) await typePaths(run, [saved.path], typed);
    console.log('statusd: file uploaded', { bytes: saved.bytes, typed });
    return reply(res, 200, { ...saved, typed: Boolean(typed) });
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

// The Review tab's analysis runs on claude or codex (shared/review/jobs.mjs): a session on another agent leaves it on
// claude's defaults, which run on its owner's Claude token when they saved one.
const reviewHost = createReviewHost({
  repoDir: REPO_DIR, sessionId: process.env.SESSION_ID || '',
  ...(CLAUDE || CODEX ? { agent: process.env.AGENT, model: process.env.MODEL, effort: process.env.EFFORT } : {}),
});

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
    const receivedAt = Date.now();
    let text;
    let raw;
    try {
      raw = await readBody(req);
      text = parseSendBody(raw);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    // A message meant for the agent (the console's review feedback for a My Woodshed session) never reaches the shell
    // of one that exited, nor an agent on another pull request, nor goes in after its caller stopped waiting.
    const agentOnly = sendAgentOnly(raw);
    const within = agentOnly ? sendWithinMs(raw) : null;
    const notAfter = agentOnly ? sendNotAfter(raw) : null;
    const tooLate = () => Boolean((within && Date.now() - receivedAt > within) || (notAfter && Date.now() > notAfter));
    if (agentOnly) {
      const forPr = sendForPr(raw);
      // The branch is read on both sides of the lookup: a checkout during it makes its answer another branch's.
      const keyBefore = forPr ? await prLookupKey(git).catch(() => null) : null;
      const pullNow = forPr ? await ghPullNow().catch(() => null) : null;
      const keyAfter = forPr ? await prLookupKey(git).catch(() => null) : null;
      if (forPr && (keyBefore === null || keyBefore !== keyAfter || !stillThePull(pullNow, forPr))) {
        console.log('statusd: text not sent, the branch is not on its pull request now');
        return reply(res, 409, { error: 'the branch checked out is not on that pull request now' });
      }
      // GitHub was slow: its caller has given up on this request by now, and will send it again.
      if (stopping) {
        console.log('statusd: text not sent, the session is stopping');
        return reply(res, 409, { error: 'the session is stopping' });
      }
      if (tooLate()) {
        console.log('statusd: text not sent, too late for its caller', { ms: Date.now() - receivedAt });
        return reply(res, 409, { error: 'too late: the caller has stopped waiting' });
      }
    }
    // A prompt on screen takes the Enter after the text as its answer: the highlighted option, often Yes. No Enter is
    // sent then (typeMessage), nor mid-turn, when a prompt can open at any moment, nor while a pane that could not be
    // read may be showing one. The console holds what it sends (fleet.mjs) and sends it again later.
    const agentName = AGENTS.agent(AGENT).command;
    // OpenCode quits on a message of `exit`, `quit` or `:q` alone (its prompt's own words): never one sent from the page.
    if (AGENT === 'opencode' && /^\s*(exit|quit|:q)\s*$/i.test(text)) {
      return reply(res, 409, { why: 'refused', error: 'OpenCode quits on that word alone: type it in the TUI tab if that is what you mean' });
    }
    // Busy: nothing typed, and the console sends it again once the agent is back at its prompt (fleet.mjs).
    const busy = (why, error) => {
      console.log('statusd: text not sent, the agent is busy', { why, chars: text.length });
      return reply(res, 409, { why, busy: true, error });
    };
    if (!paneLock.take('send')) return busy('typing', `something else is going in to ${agentName}: this goes after it`);
    // An agent that exited leaves a shell: said so first, whatever else the pane shows.
    const agentInPane = () => agentIo().agentRunning();
    const notRunning = () => {
      console.log('statusd: text not sent, the agent is not running in its pane');
      return reply(res, 409, { error: 'the agent is not running in its pane' });
    };
    let done;
    try {
      if (agentOnly && !(await agentInPane())) return notRunning();
      const now = await agentState({ strict: true });
      const { state } = now;
      if (agentIo().colours && !(await boxEmpty())) {
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
      // Last, just before typing: the agent still runs in its pane, and its caller still waits.
      if (agentOnly) {
        if (!(await agentInPane())) return notRunning();
        if (stopping) {
          console.log('statusd: text not sent, the session is stopping');
          return reply(res, 409, { error: 'the session is stopping' });
        }
        if (tooLate()) {
          console.log('statusd: text not sent, too late for its caller', { ms: Date.now() - receivedAt });
          return reply(res, 409, { error: 'too late: the caller has stopped waiting' });
        }
      }
      done = await send(text);
    } catch (err) {
      const message = String(err?.message ?? err).split('\n')[0];
      if (err?.typing) {
        console.warn(`statusd: text not sent, ${TERMINAL} could not type it`, { chars: text.length, partial: err.partial, message });
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
      const agent = AGENTS.agent(AGENT).command;
      const ask = done.kind === 'question' ? `${agent} is asking a question` : done.kind === 'menu' ? `${agent} shows a menu to pick from` : `${agent} is waiting for an approval`;
      if (done.kind === 'herdr') {
        return reply(res, 409, { why: 'not-at-prompt', typed: false, error: `Herdr did not type it: ${agent} was not idle, or someone's draft is in its box. Nothing was sent` });
      }
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
  if (pathname === '/agents' || pathname.startsWith('/agents/')) return agentsReply(req, res, route, pathname);
  if (route === 'GET /prompt') {
    // A pane that could not be read is not one that asks nothing: said so, for the page to send the person to the TUI tab.
    let pane;
    try {
      pane = await capturePane();
    } catch (err) {
      console.warn('statusd: prompt not read, the pane could not be read', { message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 503, { why: 'pane-unread', error: `${AGENTS.agent(AGENT).command}'s terminal could not be read` });
    }
    return reply(res, 200, promptReply(readPrompt(pane, AGENT)));
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
  if (route === 'POST /checkpoint') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}') ?? {};
    } catch {
      return reply(res, 400, { error: 'the body is not JSON' });
    }
    return reply(res, 200, await checkpoint({ keepRunningOnFailure: body.keepRunningOnFailure === true }));
  }
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
    const claimed = agents?.claimed();
    const read = await readSessionTranscript({
      agent: AGENT,
      home: os.homedir(),
      claudeDir: transcriptDir(),
      ...OWN_TRANSCRIPTS,
      root: REPO_DIR,
      codexHome: CODEX_HOME,
      skip: CODEX ? claimed?.codex : CLAUDE ? claimed?.claude : undefined,
      ...(CODEX ? { file: await ownRollout() } : {}),
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
      // The TUI tab is a Herdr client then, which takes the wheel itself: there is no tmux pane of the agent's to scroll.
      if (TERMINAL === 'herdr' && ((pane ?? 'agent') === 'agent' || AGENT_ID_RE.test(pane ?? ''))) return reply(res, 409, { error: 'the agent runs in Herdr, whose client scrolls it' });
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

// The agents beside the session's own (agents.mjs): list and start them, and each one's Chat routes.
async function agentsReply(req, res, route, pathname) {
  if (!agents) return reply(res, 404, { error: 'this session runs no other agents: only a private coding session does' });
  if (route === 'GET /agents') return reply(res, 200, { agents: await agents.list() });
  try {
    if (route === 'POST /agents' || route === 'POST /agents/with-claude-token') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return reply(res, 400, { error: 'body must be JSON' });
      }
      if (route === 'POST /agents/with-claude-token' && (body?.agent !== 'claude' || AGENTS.agent(AGENT).teamCredential)) {
        return reply(res, 400, { error: 'this route starts Claude beside Grok Build or OpenCode' });
      }
      if (route === 'POST /agents' && body?.agent === 'claude' && !AGENTS.agent(AGENT).teamCredential) {
        return reply(res, 409, { error: 'start Claude from a console that can pass your Claude token' });
      }
      return reply(res, 200, { agent: await agents.start(body) });
    }
    const [, , id, action] = pathname.split('/');
    if (!AGENT_ID_RE.test(id ?? '') || pathname.split('/').length !== 4) return reply(res, 404, { error: 'not found' });
    const op = `${req.method} ${action}`;
    if (op === 'GET transcript') {
      const params = new URL(req.url, 'http://statusd').searchParams;
      const since = Number(params.get('since'));
      return reply(res, 200, await agents.transcript(id, {
        limit: Number(params.get('limit')) || undefined,
        since: params.get('since') && Number.isFinite(since) ? since : undefined,
      }));
    }
    if (op === 'POST send') {
      let text;
      let raw;
      try {
        raw = await readBody(req);
        text = parseSendBody(raw);
      } catch (err) {
        return reply(res, 400, { error: err.message });
      }
      const messageId = JSON.parse(raw)?.id;
      const done = await agents.send(id, text, typeof messageId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(messageId) ? messageId : undefined);
      return done.ok ? reply(res, 200, done) : reply(res, done.status, { error: done.error, ...(done.typed && { typed: true }) });
    }
    if (op === 'POST interrupt') {
      await agents.interrupt(id);
      return reply(res, 200, { ok: true });
    }
    if (op === 'GET prompt') return reply(res, 200, promptReply(await agents.prompt(id)));
    if (op === 'POST answer') {
      let body;
      try {
        body = parseAnswerBody(await readBody(req));
      } catch (err) {
        return reply(res, 400, { error: err.message });
      }
      const done = await agents.answer(id, body);
      return reply(res, done.status, done.body);
    }
    if (op === 'POST stop') return reply(res, 200, await agents.stop(id));
    return reply(res, 404, { error: 'not found' });
  } catch (err) {
    if (err.status) return reply(res, err.status, { error: err.message });
    throw err;
  }
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
