// What the console decides about sessions, kept free of I/O so it can be tested
// on its own: which trigger does what, which queued session starts next, and
// when a running one has to stop.

import { randomBytes } from 'node:crypto';

import { ASK_DEFAULTS, spanText } from './consoleSettings.mjs';
import { ENGINE_NAMES } from '../shared/databases/index.mjs';
import agents from '../shared/agents.cjs';

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

/** @returns {boolean}  whether the session runs QA on a pull request (qaSessions.mjs), rather than working on it */
export function isQa(session) {
  return Boolean(session.qa);
}

/** @returns {boolean}  whether the session reviews a pull request (review runner `woodshed`), rather than working on it */
export function isReview(session) {
  return Boolean(session.review);
}

/** @returns {boolean}  whether the session holds, or waits for, one of the shared slots */
function takesSharedSlot(session) {
  return !session.owner && !isAsk(session);
}

/** The start steps a session's entrypoint reports, in order. The console adds `machine` itself, before them. */
export const START_STEPS = ['container', 'settings', 'home', 'branch', 'databases', 'env', 'claude'];

const CLAUDE_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// `none`: the project file has no app, so the page offers Set up app instead of Start app.
export const APP_STATES = new Set(['running', 'api-down', 'frontend-down', 'starting', 'stopping', 'failed', 'stopped', 'none']);

/** @returns {string} 8 hex characters, also ttyd's base path and part of the branch name */
export function newSessionId() {
  return randomBytes(4).toString('hex');
}

/**
 * A session's page, as a link that leaves the console: a GitHub comment, a Slack post, the session's own SESSION_URL.
 * @param {string} publicUrl
 * @param {string} id
 * @param {Record<string, string>|null} [linkQuery]  `config.linkQuery`: what whatever serves the console in front of
 *   it needs on its links to route them, carried as query parameters
 * @returns {string}
 */
export function sessionLink(publicUrl, id, linkQuery = null) {
  const query = linkQueryString(linkQuery);
  return `${publicUrl}/s/${id}${query ? `?${query}` : ''}`;
}

/** @returns {string}  `config.linkQuery` as a query string, empty with none */
export function linkQueryString(linkQuery) {
  if (!linkQuery || typeof linkQuery !== 'object') return '';
  return new URLSearchParams(Object.entries(linkQuery).filter(([, v]) => typeof v === 'string' && v)).toString();
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

/** @returns {string|null}  the `owner/name` of a pull request's URL on GitHub */
export function pullRepo(prUrl) {
  return /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+$/.exec(String(prUrl ?? ''))?.[1] ?? null;
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
  // A private session with databases of its own (one that may use production) keeps them while it is on the list.
  return new Set(sessions.filter((s) => ACTIVE_STATUSES.has(s.status) || (s.kept && !s.owner) || (s.owner && s.ownDatabases)).map((s) => s.id));
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
  // A private session on the same issue is someone's own: GitHub can neither type into it nor resume its branch. A QA
  // or review session on the same pull request tests or reviews it, and is no session to send work to.
  const shared = sessions.filter((s) => !s.owner && !isQa(s) && !isReview(s));
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
 * Decides what the QA label on a pull request does: start a QA session, unless one is already testing it. A QA session
 * is never resumed: each label tests the branch as it is then.
 * @param {{sessions: object[], number: number}} args
 * @returns {{action: 'ignore', reason: string}|{action: 'start'}}
 */
export const QA_ALREADY_RUNNING = 'QA is already running on it';

export function routeQa({ sessions, number }) {
  const running = sessions.find((s) => isQa(s) && s.number === number && ACTIVE_STATUSES.has(s.status));
  return running ? { action: 'ignore', reason: QA_ALREADY_RUNNING } : { action: 'start' };
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

// The agent a private session runs (shared/agents.cjs). Codex takes its model and reasoning effort as `codex --model` and
// `-c model_reasoning_effort=`; its permission modes are the entrypoint's mapping onto codex's sandbox and approval flags.
// Codex's models and efforts are OpenAI's catalog's (codexModels.mjs), which the console checks a start against: here
// only their shape, since both end up on codex's command line. Grok Build and OpenCode take a model name of the
// registry's shape (OpenCode's is `provider/model`), an effort from the registry's list, and the permission modes the
// entrypoint maps onto each one's own flags.
export const AGENTS = agents.AGENT_IDS;
export const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CODEX_EFFORT_RE = /^[a-z]{1,16}$/;
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
  const shaped = (value, re, what) => {
    const v = String(value ?? '');
    if (v && !re.test(v)) throw Object.assign(new Error(`${what} is not a Codex ${what.replace('the ', '')} name`), { shown: true });
    return v;
  };
  if (chosen !== 'claude' && !codex) {
    const a = agents.agent(chosen);
    const m = String(model ?? '');
    if (!agents.modelShapeOk(chosen, m)) throw Object.assign(new Error(`the model is not a name ${a.product} takes`), { shown: true });
    return {
      agent: chosen,
      model: m,
      effort: pick(effort, a.efforts ?? [''], 'the effort'),
      permissionMode: pick(permissionMode || 'auto', a.permissionModes, 'the permission mode'),
    };
  }
  return {
    agent: chosen,
    model: codex ? shaped(model, CODEX_MODEL_RE, 'the model') : pick(model, MODELS, 'the model'),
    effort: codex ? shaped(effort, CODEX_EFFORT_RE, 'the effort') : pick(effort, EFFORTS, 'the effort'),
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

// What a launcher's progress (its optional `progress(sessionId)`, providers/README.md) may hold: it is shown as it
// is, so each value is a string of a size the page lays out, and a step in a state the page does not know is dropped.
const WAIT_STATES = new Set(['done', 'current', 'pending', 'failed']);
const WAIT_STEPS_KEPT = 20;
const WAIT_LABEL_CHARS = 80;
const WAIT_NOTE_CHARS = 200;

function waitText(value, chars) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/**
 * @param {{steps?: {label: string, state: string, note?: string|null, at?: string|null}[]}|null} progress  a
 *   launcher's answer
 * @returns {{steps: {label: string, state: 'done'|'current'|'pending'|'failed', note: string|null, at: string|null}[]}|null}
 *   the steps the session page shows while the session waits, in order; null for none
 */
export function waitProgressFrom(progress) {
  if (!Array.isArray(progress?.steps)) return null;
  const steps = progress.steps
    .filter((step) => WAIT_STATES.has(step?.state) && waitText(step.label, WAIT_LABEL_CHARS))
    .slice(0, WAIT_STEPS_KEPT)
    .map((step) => {
      const at = typeof step.at === 'string' ? Date.parse(step.at) : NaN;
      return {
        label: waitText(step.label, WAIT_LABEL_CHARS),
        state: step.state,
        note: waitText(step.note, WAIT_NOTE_CHARS),
        at: Number.isFinite(at) ? new Date(at).toISOString() : null,
      };
    });
  return steps.length ? { steps } : null;
}

/** @returns {string}  when the session joined the line: only a private Resume sets `queuedAt`, to join at the back, and it lasts until the next Resume */
function lineSince(s) {
  return s.queuedAt ?? s.createdAt;
}

/** @returns {number}  shared sessions holding a slot */
export function sharedRunningCount(sessions) {
  return sessions.filter((s) => takesSharedSlot(s) && SLOT_STATUSES.has(s.status)).length;
}

/** How long one Extend pushes a session's pause or stop back. */
export const EXTEND_MS = 60 * 60_000;
/** How close a pause or stop must be for Extend: the page shows the countdown and the button from then. */
export const EXTEND_WINDOW_MS = 15 * 60_000;

/**
 * When a running session pauses or stops by itself, and why: the sooner of its idle pause and its lifetime, each held
 * back to `extendedUntil` while that is from this run (an Extend). A question's limits are its own.
 * @param {object} session
 * @param {{idleMs: number, lifetimeMs: number, askIdleMs?: number, askLifetimeMs?: number}} limits
 * @returns {{at: number, why: 'idle'|'lifetime', ms: number}|null}  `ms` is the limit it reaches
 */
export function pauseAt(session, limits) {
  if (session.status !== 'running') return null;
  const idleMs = isAsk(session) ? limits.askIdleMs ?? ASK_DEFAULTS.idleMs : limits.idleMs;
  const lifetimeMs = isAsk(session) ? limits.askLifetimeMs ?? ASK_DEFAULTS.lifetimeMs : limits.lifetimeMs;
  const startedAt = Date.parse(session.startedAt);
  const activeAt = Date.parse(session.lastActiveAt);
  // An Extend from an earlier run counts for nothing once the session is resumed.
  const held = Date.parse(session.extendedUntil);
  const hold = Number.isFinite(held) && Date.parse(session.extendedAt) >= startedAt ? held : -Infinity;
  const ends = [
    { at: Math.max(startedAt + lifetimeMs, hold), why: 'lifetime', ms: lifetimeMs },
    // A session statusd has not yet reported on has no idle clock.
    Number.isFinite(activeAt) && { at: Math.max(activeAt + idleMs, hold), why: 'idle', ms: idleMs },
  ].filter((end) => end && Number.isFinite(end.at));
  if (!ends.length) return null;
  // Held to the same time by an Extend, the one that was due first says why: an idle session extended past its
  // lifetime still pauses for being idle.
  const due = (end) => (end.why === 'lifetime' ? startedAt + lifetimeMs : activeAt + idleMs);
  return ends.reduce((a, b) => (b.at < a.at || (b.at === a.at && due(b) < due(a)) ? b : a));
}

/**
 * A session's own pause and stop, set on its page, over the limits it would otherwise run on.
 * @param {{idleMs: number, lifetimeMs: number}} limits
 * @param {{idleHours?: number, lifetimeHours?: number}|null|undefined} own  the session's `limits`
 */
export function withSessionLimits(limits, own) {
  if (!own) return limits;
  return {
    ...limits,
    ...(own.idleHours ? { idleMs: own.idleHours * 3_600_000 } : {}),
    ...(own.lifetimeHours ? { lifetimeMs: own.lifetimeHours * 3_600_000 } : {}),
  };
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
  const startedAt = Date.parse(session.startedAt);
  if (session.status === 'starting' && now - startedAt > startTimeoutMs) return 'did not start in time';
  const end = pauseAt(session, limits);
  if (!end || now <= end.at) return null;
  // An Extend makes the stop later than the limit: the reason says how long it really ran or waited.
  const from = end.why === 'lifetime' ? startedAt : Date.parse(session.lastActiveAt);
  const span = Math.max(end.ms, end.at - from);
  return end.why === 'lifetime' ? `ran for ${spanText(span)}` : `idle for ${spanText(span)}`;
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

// As shared/project.mjs names an app; a label is the project's own words, kept short for a menu.
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_APPS = 20;
const MAX_APP_LABEL = 60;

/**
 * @returns {{name: string, label: string}[]|null}  the apps Start app can pick, as statusd listed them; null from a
 *   statusd from before several apps, which runs its one app
 */
/** Whether the session runs codex: a Codex session, or a private one whose owner started a Codex agent in it
 * (fleet.allowAgent): its owner's Codex sign-in and the team's OpenAI key are for it as for a Codex session. */
export function runsCodex(session) {
  // Never once the session has seen production data: a Codex session cannot, and a claude session's Codex agent stops.
  return session.options?.agent === 'codex' || (Boolean(session.owner) && !session.taintedAt && (session.extraAgents ?? []).includes('codex'));
}

const AGENT_STATES = new Set(['starting', 'working', 'needs-you', 'done', 'not-running']);
const MESSAGE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The agents statusd says run beside the session's own (session/agents.mjs), as the page reads them: each one's id,
 * agent, model, effort, permission mode, state, and the page's ids of the messages it holds or typed in. Null from a
 * session that cannot start any (an older image, a shared session), which the page then offers none to.
 * @param {unknown} agents  statusd's `agents`
 * @returns {object[]|null}
 */
export function agentsFrom(agents) {
  if (!Array.isArray(agents)) return null;
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && MESSAGE_ID_RE.test(id)).slice(-20) : []);
  const name = (value) => (typeof value === 'string' && AGENT_NAME_RE.test(value) ? value : null);
  return agents.filter((a) => /^agent-[2-9]$/.test(a?.id ?? '') && AGENTS.includes(a.agent)).slice(0, 3).map((a) => ({
    id: a.id,
    agent: a.agent,
    model: name(a.model),
    effort: name(a.effort),
    permissionMode: name(a.permissionMode),
    startedAt: typeof a.startedAt === 'string' && !Number.isNaN(Date.parse(a.startedAt)) ? a.startedAt : null,
    state: AGENT_STATES.has(a.state) ? a.state : null,
    heldIds: ids(a.heldIds),
    deliveredIds: ids(a.deliveredIds),
    refusedIds: ids(a.refusedIds),
    leftInBox: typeof a.leftInBox?.id === 'string' && MESSAGE_ID_RE.test(a.leftInBox.id) ? { id: a.leftInBox.id } : null,
  }));
}

export function appsFrom(apps) {
  if (!Array.isArray(apps)) return null;
  const valid = apps.slice(0, MAX_APPS).filter((a) => APP_NAME_RE.test(a?.name ?? ''));
  return valid.map((a) => ({ name: a.name, label: typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, MAX_APP_LABEL) : a.name }));
}

// Numbers only, and in range: the answer is the session's own.
function usageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const number = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const out = {
    cpuPercent: number(usage.cpuPercent, 100_000),
    memoryBytes: number(usage.memoryBytes, 2 ** 50),
    memoryLimitBytes: number(usage.memoryLimitBytes, 2 ** 50),
    memoryPeakBytes: number(usage.memoryPeakBytes, 2 ** 50),
    cores: number(usage.cores, 1024),
    diskUsedBytes: number(usage.diskUsedBytes, 2 ** 60),
    diskTotalBytes: number(usage.diskTotalBytes, 2 ** 60),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function isoOrNull(v) {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
}

// Grok Build names its one allowance a week or a month and how long that period is (session/grokPlanUsage.mjs).
const PLAN_WINDOW_LABELS = new Set(['Week', 'Month']);
const PLAN_WINDOW_SHORTS = new Set(['wk', 'mo']);
const PLAN_SPAN_MAX_MS = 400 * 86400_000;

function planWindowFrom(w) {
  if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const out = { usedPercent: Math.min(100, Math.max(0, w.usedPercent)), resetsAt: isoOrNull(w.resetsAt) };
  if (PLAN_WINDOW_LABELS.has(w.label)) out.label = w.label;
  if (PLAN_WINDOW_SHORTS.has(w.short)) out.short = w.short;
  if (typeof w.spanMs === 'number' && Number.isFinite(w.spanMs) && w.spanMs > 0 && w.spanMs <= PLAN_SPAN_MAX_MS) out.spanMs = w.spanMs;
  return out;
}

/**
 * @param {object} usage  statusd's `planUsage` (session/planUsage.mjs, codexPlanUsage.mjs, grokPlanUsage.mjs)
 * @returns {{asOf: string|null, fiveHour: object|null, sevenDay: object|null}|null}  in range, or null
 */
export function planUsageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = { asOf: isoOrNull(usage.asOf), fiveHour: planWindowFrom(usage.fiveHour), sevenDay: planWindowFrom(usage.sevenDay) };
  // Claude's reading carries no agent; any other agent's says whose it is (the meter names it).
  if (usage.agent !== 'claude' && agents.isAgent(usage.agent)) out.agent = usage.agent;
  return out.fiveHour || out.sevenDay ? out : null;
}

const MAX_PR_URLS = 20;

/**
 * Which of Woodshed's own runs are at work on each pull request now: a review or QA session the console started on
 * it, waiting in line or running. A pull request's checks say nothing of them until they report, so its chip would
 * show a tick while its review is still being written.
 * @param {object[]} sessions  every session, whoever may see it: a run says only that it is at work
 * @returns {(prUrl: string) => ('review'|'qa')[]}  the runs on that pull request, review first
 */
export function woodshedRunsOn(sessions) {
  const runs = new Map();
  for (const s of sessions) {
    if (!ACTIVE_STATUSES.has(s.status) || !s.repo || !Number.isInteger(s.number) || !(isReview(s) || isQa(s))) continue;
    const key = `https://github.com/${s.repo}/pull/${s.number}`.toLowerCase();
    runs.set(key, { ...runs.get(key), [isReview(s) ? 'review' : 'qa']: true });
  }
  return (prUrl) => {
    const found = runs.get(String(prUrl ?? '').toLowerCase());
    return ['review', 'qa'].filter((kind) => found?.[kind]);
  };
}

/** @returns {string[]}  the session's pull requests, oldest first; one from before the list is its only `prUrl` */
export function prUrlsOf(session) {
  if (Array.isArray(session?.prUrls) && session.prUrls.length) return session.prUrls;
  return session?.prUrl ? [session.prUrl] : [];
}

/**
 * The session's list with what its statusd reports now: the pull request of the branch checked out, and those of its
 * other branches and those claude opened elsewhere (`prUrls`, from a statusd that reads them). Oldest first: on one
 * repo the lowest number first, and one on another repo where it was first seen, since numbers of two repos say
 * nothing of which came first. A new one on another repo is the newest.
 */
function withPrUrls(session, reported) {
  const repoOf = (url) => (pullRepo(url) ?? '').toLowerCase();
  const list = [];
  // Each one found goes before the first of its repo with a higher number, else last.
  for (const url of new Set([...prUrlsOf(session), ...reported.filter(Boolean)])) {
    const at = list.findIndex((other) => repoOf(other) === repoOf(url) && pullNumber(other) > pullNumber(url));
    if (at < 0) list.push(url);
    else list.splice(at, 0, url);
  }
  return list.slice(-MAX_PR_URLS);
}

/**
 * Folds one statusd answer into a session. Only a working claude counts as
 * activity: a session parked on a question for an hour is idle.
 *
 * @param {object} session
 * @param {{state: string, lastMessage?: object|null, branch?: string, head?: string, prUrl?: string|null, app?: string, appServers?: {frontend: boolean, backend: boolean, frontendPort?: number|null, backendPort?: number|null},
 *          editor?: boolean, redis?: boolean, viewers?: string[],
 *          usage?: {cpuPercent: number|null, memoryBytes: number|null, memoryLimitBytes: number|null, memoryPeakBytes?: number|null,
 *                   cores: number|null, diskUsedBytes?: number|null, diskTotalBytes?: number|null},
 *          planUsage?: object}} status
 * @param {string} nowIso
 * @returns {object}  the fields to update
 */
export function statusUpdate(session, status, nowIso, { repos = [] } = {}) {
  // statusd runs as the same user as claude, so its answer is only as trusted as the session.
  const prUrl = typeof status.prUrl === 'string' && status.prUrl.startsWith(`https://github.com/${session.repo}/pull/`)
    ? status.prUrl
    : null;
  // The pull requests of its other branches, a worktree's included, and those claude opened from another clone, on
  // its own repo or another of the console's projects (session/openedPulls.mjs): a repo the console has not is left
  // out, since the console reads each one's state with its own token. `prUrl` stays the checked-out branch's alone.
  const known = new Set([session.repo, ...repos].filter(Boolean).map((r) => r.toLowerCase()));
  const otherPrUrls = (Array.isArray(status.prUrls) ? status.prUrls.slice(-MAX_PR_URLS) : [])
    .filter((url) => typeof url === 'string' && known.has(pullRepo(url)?.toLowerCase()) && pullNumber(url));
  const update = {
    state: status.state,
    shells: Number.isInteger(status.shells) && status.shells > 0 ? Math.min(status.shells, 99) : 0,
    lastMessage: status.lastMessage ?? session.lastMessage ?? null,
    branch: status.branch || session.branch,
    head: status.head || session.head,
    prUrl: prUrl || session.prUrl || null,
    // The pull request statusd reported last, on any repo, or null for none on the branch it is on now (or a failed
    // lookup): while it is not the watched one, the watch of a My Woodshed session's pull request waits (fleet.mjs,
    // prListening), though `prUrl` keeps the last on its own repo. A statusd that sends no `prUrl` leaves it as it was.
    reportedPrUrl: typeof status.prUrl === 'string' && status.prUrl ? status.prUrl.slice(0, 300)
      : 'prUrl' in status ? null : session.reportedPrUrl,
    // Whether its statusd types only into a running agent when asked (`agentOnly`): an older image's would type into
    // the shell an exited agent leaves, so its private session's pull request is not watched.
    agentOnlySend: status.agentOnlySend === true,
    // Every pull request the session has reported, oldest first: a session can open another after one merged, or
    // several from branches of their own.
    prUrls: withPrUrls(session, [...otherPrUrls, prUrl]),
    app: APP_STATES.has(status.app) ? status.app : null,
    // The agents a person started beside its own, for the page's switch over Chat and TUI.
    agents: agentsFrom(status.agents),
    // Claude's own id for the conversation, which Resume hands back to `claude --resume`.
    claudeSession: CLAUDE_SESSION_RE.test(status.claudeSession ?? '') ? status.claudeSession : session.claudeSession ?? null,
    appServers: appServersFrom(status.appServers),
    // Which of the project's apps runs, or would run, and the ones Start app can pick. One of them, or none.
    apps: appsFrom(status.apps),
    appName: appsFrom(status.apps)?.some((a) => a.name === status.appName) ? status.appName : null,
    // The project file turns the editor on and the image has it: Editor ↗ shows, and the console lets it through.
    editor: status.editor === true,
    // Text waits in the agent's box at its prompt, unsent: Chat says so, and points at the TUI tab.
    boxText: status.boxText === true,
    // statusd sends with the guards: between turns, into an empty box, never into a prompt. One from before them types
    // blind, so the console sends through it only while its agent is plainly idle (fleet.mjs, canType).
    safeSend: status.safeSend === true,
    // The project uses Redis, so the session started one: Open ▾ offers it. An image from before statusd said so
    // still ran it.
    redis: status.redis !== false,
    // The engines whose viewers the session runs (its entrypoint's startDbViewers), which Open ▾ offers. Null from an
    // image before statusd said so: the page falls back to the databases the console makes.
    viewers: Array.isArray(status.viewers) ? ENGINE_NAMES.filter((name) => status.viewers.includes(name)) : null,
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
// The start token's hash too (sessionStarts.mjs): a page never needs it.
export function publicSession({ token, terminalToken, startTokenHash, endpoint, pendingMessages, reportedPrUrl, agentOnlySend, ...rest }) {
  // A session whose image predates the Terminal tab has no shell ttyd to open.
  // The page's ids of the messages held, never their text: a send whose answer it lost can tell it is still held.
  const heldIds = (pendingMessages ?? []).filter((m) => m && typeof m === 'object' && m.id).map((m) => m.id);
  // A public QA run's secret opens its videos to anyone: the page has the comment's links, never the key to them.
  // Its run log is read on request (GET /api/sessions/<id>/qa-log), not carried in every list: the page gets `hasLog`.
  const qa = rest.qa ? (({ share, log, ...own }) => ({ ...own, ...(log ? { hasLog: true } : {}) }))(rest.qa) : rest.qa;
  return { ...rest, ...(qa ? { qa } : {}), pendingMessages: pendingMessages?.length ?? 0, heldIds, hasShell: Boolean(endpoint?.shellPort) };
}
