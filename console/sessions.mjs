// What the console decides about sessions, kept free of I/O so it can be tested
// on its own: which trigger does what, which queued session starts next, and
// when a running one has to stop.

import { randomBytes } from 'node:crypto';

import { ASK_DEFAULTS, spanText } from './consoleSettings.mjs';

/** Sessions that still hold, or are waiting for, one of the slots. */
export const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running', 'stopping']);

const SLOT_STATUSES = new Set(['starting', 'running', 'stopping']);

// A question from Slack (asks.mjs) is a short read of the code: it takes none of the shared slots, which hold work
// that runs for hours, and waits in a line of its own. Its limits are Console settings (ASK_DEFAULTS until set). The
// line's key is one no GitHub login can be.
const ASK_LINE = Symbol('ask');

/** @returns {boolean}  whether the session answers a question from Slack */
export function isAsk(session) {
  return session.kind === 'ask';
}

/** @returns {boolean}  whether the session holds, or waits for, one of the shared slots */
function takesSharedSlot(session) {
  return !session.owner && !isAsk(session);
}

/** The start steps a session's entrypoint reports, in order. The console adds `machine` itself, before them. */
export const START_STEPS = ['container', 'settings', 'home', 'branch', 'databases', 'env', 'claude'];

const CLAUDE_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const APP_STATES = new Set(['running', 'api-down', 'frontend-down', 'starting', 'stopping', 'failed', 'stopped']);

/** @returns {string} 8 hex characters, also ttyd's base path and part of the branch name */
export function newSessionId() {
  return randomBytes(4).toString('hex');
}

/**
 * A session's page, as a link that leaves the console: a GitHub comment, a Slack post, the session's own SESSION_URL.
 * In a multi-tenant console it names the session's org (`?org=`), which switches whoever opens it there (hosted.mjs).
 * @param {string} publicUrl
 * @param {string} id
 * @param {string|null} [org]
 * @returns {string}
 */
export function sessionLink(publicUrl, id, org = null) {
  return `${publicUrl}/s/${id}${org ? `?org=${encodeURIComponent(org)}` : ''}`;
}

/** @returns {string} 32 hex characters, the session's statusd and ttyd secret */
export function newSessionToken() {
  return randomBytes(16).toString('hex');
}

/**
 * @param {string} body  a GitHub comment
 * @returns {{text: string}|null}  null unless the comment starts with `/woodshed`;
 *   `text` is everything after the command, possibly empty
 */
export function parseCommand(body) {
  if (typeof body !== 'string') return null;
  const match = /^\s*\/woodshed(?:[ \t]+|\r?\n|$)([\s\S]*)$/i.exec(body);
  return match ? { text: match[1].trim() } : null;
}

/** @returns {number|null}  the number of a pull request URL that ends at its number, and nothing else */
export function pullNumber(prUrl) {
  const match = /\/pull\/(\d+)$/.exec(prUrl ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * @param {object[]} sessions
 * @returns {Set<string>}  the sessions whose databases stay: every active one, and each stopped shared one still kept
 */
export function keptIds(sessions) {
  return new Set(sessions.filter((s) => ACTIVE_STATUSES.has(s.status) || (s.kept && !s.owner)).map((s) => s.id));
}

/**
 * Decides what a label or a `/woodshed` comment does. A label starts sessions on issues only: on a pull request
 * the task would be its own description, and the session would push to its branch, so a pull request takes a
 * `/woodshed <what to do>` comment instead. A shared session is found by its issue, or by the pull request it opened.
 * One that stopped but still keeps its conversation is resumed rather than started again.
 *
 * @param {{sessions: object[], number: number, trigger: 'label'|'comment', kind?: 'issue'|'pr', text?: string}} args
 * @returns {{action: 'ignore', reason: string}
 *   | {action: 'send', sessionId: string}
 *   | {action: 'resume', sessionId: string}
 *   | {action: 'start', resumeBranch: string|null}}
 */
export function routeTrigger({ sessions, number, trigger, kind = 'issue', text = '' }) {
  if (trigger === 'label' && kind === 'pr') return { action: 'ignore', reason: 'a label on a pull request starts nothing: comment /woodshed <what to do>' };
  // A private session on the same issue is someone's own: GitHub can neither type into it nor resume its branch.
  const shared = sessions.filter((s) => !s.owner);
  const forTarget = shared.filter((s) => s.number === number || pullNumber(s.prUrl) === number);
  const active = forTarget.find((s) => ACTIVE_STATUSES.has(s.status));
  if (active) {
    if (active.status === 'stopping') return { action: 'ignore', reason: 'its session is stopping' };
    if (trigger === 'label') return { action: 'ignore', reason: 'already has an active session' };
    if (!text) return { action: 'ignore', reason: 'no message to send' };
    return { action: 'send', sessionId: active.id };
  }
  const kept = forTarget.filter((s) => s.kept).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (kept) return { action: 'resume', sessionId: kept.id };
  const previous = shared
    .filter((s) => s.number === number && s.branch && s.kind === 'issue')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return { action: 'start', resumeBranch: previous?.branch ?? null };
}

/**
 * A shared session, started from GitHub, is open to everyone signed in. A private one, started from My Woodshed,
 * has an `owner` and is open to that login alone.
 * @param {{owner?: string|null}} session
 * @param {string|null} login  who is asking; null where the console has no sign-in
 * @returns {boolean}
 */
export function canSee(session, login) {
  return !session.owner || session.owner === login;
}

/**
 * @param {object[]} sessions
 * @param {string} owner
 * @returns {number}  the owner's private sessions with a Fargate task: a session waiting in line has none yet
 */
export function activePrivateCount(sessions, owner) {
  return sessions.filter((s) => s.owner === owner && SLOT_STATUSES.has(s.status)).length;
}

/**
 * What a private session works on, from the New session form's optional field: `#123` or `123` an issue or a pull
 * request (GitHub says which), `PR #123` a pull request, anything else a branch name.
 * @param {string} text
 * @param {{defaultBranch?: string|null}} [opts]  the repo's default branch, which a session does not work on directly
 * @returns {{kind: 'task'}|{kind: 'number', number: number, pr: boolean}|{kind: 'branch', branch: string}}
 * @throws {Error}  with a message the page shows, for a branch name git would refuse
 */
export function parseWorkOn(text, { defaultBranch = null } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return { kind: 'task' };
  const number = /^(pr\s*)?#?(\d+)$/i.exec(value);
  if (number) return { kind: 'number', number: Number(number[2]), pr: Boolean(number[1]) };
  const pr = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)\/?$/.exec(value);
  if (pr) return { kind: 'number', number: Number(pr[2]), pr: pr[1] === 'pull' };
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(value) || /(^|\/)\.|\.\.|\/\/|\/$|\.lock$|^-/.test(value) || value === defaultBranch) {
    throw Object.assign(new Error(`${value} is not a branch name a session can work on`), { shown: true });
  }
  return { kind: 'branch', branch: value };
}

// What the New session form may pick, as `claude --model`, `--effort` and `--permission-mode` take them. Empty is
// the session image's default: claude's own model and effort, and auto mode, as GitHub's sessions run.
export const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'plan', 'default'];

// The agent a private session runs. Codex takes its model and reasoning effort as `codex --model` and
// `-c model_reasoning_effort=`; its permission modes are the entrypoint's mapping onto codex's sandbox and approval flags.
export const AGENTS = ['claude', 'codex'];
export const CODEX_MODELS = ['', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];
export const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];
export const CODEX_PERMISSION_MODES = ['auto', 'plan', 'default'];

/**
 * @param {{agent?: unknown, model?: unknown, effort?: unknown, permissionMode?: unknown}} picked
 * @returns {{agent: string, model: string, effort: string, permissionMode: string}}
 * @throws {Error}  with a message the page shows, for a value the form does not offer for that agent
 */
export function sessionOptions({ agent = 'claude', model = '', effort = '', permissionMode = 'auto' }) {
  const pick = (value, allowed, what) => {
    const v = String(value ?? '');
    if (!allowed.includes(v)) throw Object.assign(new Error(`${what} must be one of ${allowed.filter(Boolean).join(', ')}`), { shown: true });
    return v;
  };
  const chosen = pick(agent || 'claude', AGENTS, 'the agent');
  const codex = chosen === 'codex';
  return {
    agent: chosen,
    model: pick(model, codex ? CODEX_MODELS : MODELS, 'the model'),
    effort: pick(effort, codex ? CODEX_EFFORTS : EFFORTS, 'the effort'),
    permissionMode: pick(permissionMode || 'auto', codex ? CODEX_PERMISSION_MODES : PERMISSION_MODES, 'the permission mode'),
  };
}

/**
 * Three kinds of line: shared sessions wait for one of the shared slots, each person's My Woodshed sessions for one
 * of their own, and questions from Slack for one of theirs. None of them takes another's.
 * @param {object[]} sessions
 * @param {{maxRunning: number, maxPrivate: number, maxAsks?: number}} limits  shared sessions at once, each person's own
 *   at once, and questions at once
 * @returns {object[]}  the queued sessions that may start now, oldest first
 */
export function sessionsToStart(sessions, { maxRunning, maxPrivate, maxAsks = ASK_DEFAULTS.maxAsks }, now = Date.now()) {
  const queued = sessions
    .filter((s) => s.status === 'queued' && !waitsForRetry(s, now))
    .sort((a, b) => lineSince(a).localeCompare(lineSince(b)));
  const free = new Map([
    [null, maxRunning - sharedRunningCount(sessions)],
    [ASK_LINE, maxAsks - sessions.filter((s) => isAsk(s) && SLOT_STATUSES.has(s.status)).length],
  ]);
  return queued.filter((s) => {
    const key = isAsk(s) ? ASK_LINE : s.owner ?? null;
    if (!free.has(key)) free.set(key, maxPrivate - activePrivateCount(sessions, key));
    if (free.get(key) <= 0) return false;
    free.set(key, free.get(key) - 1);
    return true;
  });
}

/** @returns {boolean}  a queued session the provider had no room for, whose next try is not due yet (the page's copy: waitsForRetry) */
export function waitsForRetry(s, now = Date.now()) {
  return Boolean(s.retryAt) && Date.parse(s.retryAt) > now;
}

/** @returns {string}  when the session joined the line: only a private Resume sets `queuedAt`, to join at the back, and it lasts until the next Resume */
function lineSince(s) {
  return s.queuedAt ?? s.createdAt;
}

/** @returns {number}  shared sessions holding a slot */
export function sharedRunningCount(sessions) {
  return sessions.filter((s) => takesSharedSlot(s) && SLOT_STATUSES.has(s.status)).length;
}

// The page reads these reasons (public/common.js, PAUSE_REASON_RE and START_TIMEOUT_REASON) to tell a pause from a
// failed start: change one there too.
/**
 * @param {object} session
 * @param {number} now  epoch ms
 * @param {{idleMs: number, lifetimeMs: number, startTimeoutMs: number, askIdleMs?: number, askLifetimeMs?: number}} limits
 *   `askIdleMs` and `askLifetimeMs` are a question's own, in place of the other two
 * @returns {string|null}  why the session has to stop, or null
 */
export function stopReason(session, now, limits) {
  const { startTimeoutMs } = limits;
  const idleMs = isAsk(session) ? limits.askIdleMs ?? ASK_DEFAULTS.idleMs : limits.idleMs;
  const lifetimeMs = isAsk(session) ? limits.askLifetimeMs ?? ASK_DEFAULTS.lifetimeMs : limits.lifetimeMs;
  const startedAt = Date.parse(session.startedAt);
  if (session.status === 'starting' && now - startedAt > startTimeoutMs) return 'did not start in time';
  if (session.status !== 'running') return null;
  if (now - startedAt > lifetimeMs) return `ran for ${spanText(lifetimeMs)}`;
  if (now - Date.parse(session.lastActiveAt) > idleMs) return `idle for ${spanText(idleMs)}`;
  return null;
}

// A port, or null: a statusd from an image before it reported them gives none.
function portFrom(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/**
 * @returns {{frontend: boolean, backend: boolean, frontendPort: number|null, backendPort: number|null}|null}  which of
 *   the app's servers answer, and on which of the project file's ports, if statusd said
 */
function appServersFrom(servers) {
  if (typeof servers?.frontend !== 'boolean' || typeof servers?.backend !== 'boolean') return null;
  return { frontend: servers.frontend, backend: servers.backend, frontendPort: portFrom(servers.frontendPort), backendPort: portFrom(servers.backendPort) };
}

// Numbers only, and in range: the answer is the session's own.
function usageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const number = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const out = {
    cpuPercent: number(usage.cpuPercent, 100_000),
    memoryBytes: number(usage.memoryBytes, 2 ** 50),
    memoryLimitBytes: number(usage.memoryLimitBytes, 2 ** 50),
    cores: number(usage.cores, 1024),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function isoOrNull(v) {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
}

function planWindowFrom(w) {
  if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  return { usedPercent: Math.min(100, Math.max(0, w.usedPercent)), resetsAt: isoOrNull(w.resetsAt) };
}

/**
 * @param {object} usage  statusd's `planUsage` (session/planUsage.mjs)
 * @returns {{asOf: string|null, fiveHour: object|null, sevenDay: object|null}|null}  in range, or null
 */
export function planUsageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = { asOf: isoOrNull(usage.asOf), fiveHour: planWindowFrom(usage.fiveHour), sevenDay: planWindowFrom(usage.sevenDay) };
  return out.fiveHour || out.sevenDay ? out : null;
}

/**
 * Folds one statusd answer into a session. Only a working claude counts as
 * activity: a session parked on a question for an hour is idle.
 *
 * @param {object} session
 * @param {{state: string, lastMessage?: object|null, branch?: string, head?: string, prUrl?: string|null, app?: string, appServers?: {frontend: boolean, backend: boolean, frontendPort?: number|null, backendPort?: number|null},
 *          editor?: boolean, redis?: boolean,
 *          usage?: {cpuPercent: number|null, memoryBytes: number|null, memoryLimitBytes: number|null, cores: number|null},
 *          planUsage?: object}} status
 * @param {string} nowIso
 * @returns {object}  the fields to update
 */
export function statusUpdate(session, status, nowIso) {
  // statusd runs as the same user as claude, so its answer is only as trusted as the session.
  const prUrl = typeof status.prUrl === 'string' && status.prUrl.startsWith(`https://github.com/${session.repo}/pull/`)
    ? status.prUrl
    : null;
  const update = {
    state: status.state,
    shells: Number.isInteger(status.shells) && status.shells > 0 ? Math.min(status.shells, 99) : 0,
    lastMessage: status.lastMessage ?? session.lastMessage ?? null,
    branch: status.branch || session.branch,
    head: status.head || session.head,
    prUrl: prUrl || session.prUrl || null,
    app: APP_STATES.has(status.app) ? status.app : null,
    // Claude's own id for the conversation, which Resume hands back to `claude --resume`.
    claudeSession: CLAUDE_SESSION_RE.test(status.claudeSession ?? '') ? status.claudeSession : session.claudeSession ?? null,
    appServers: appServersFrom(status.appServers),
    // The project file turns the editor on and the image has it: Editor ↗ shows, and the console lets it through.
    editor: status.editor === true,
    // The project uses Redis, so the session started one: Data ▾ offers it. An image from before statusd said so
    // still ran it.
    redis: status.redis !== false,
    usage: usageFrom(status.usage),
    // Only a private session's plan is its viewer's own. The last reading stays after the session stops, for the
    // owner's other sessions to show until a newer one comes.
    planUsage: session.owner ? planUsageFrom(status.planUsage) ?? session.planUsage ?? null : null,
    checkedAt: nowIso,
  };
  if (session.status === 'starting') {
    update.status = 'running';
    update.lastActiveAt = nowIso;
  }
  if (status.state === 'working') update.lastActiveAt = nowIso;
  return update;
}

/**
 * @param {object} session
 * @returns {object}  the session as the browser sees it: no token, no endpoint
 */
export function publicSession({ token, terminalToken, endpoint, pendingMessages, ...rest }) {
  // A session whose image predates the Terminal tab has no shell ttyd to open.
  return { ...rest, pendingMessages: pendingMessages?.length ?? 0, hasShell: Boolean(endpoint?.shellPort) };
}
