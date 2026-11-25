// The console's engine: it turns GitHub triggers into sessions, starts them
// when a slot is free, keeps their status fresh from statusd, and stops them
// at their limits. A shared session that stopped keeps its conversation and
// databases, so it can be resumed, until its pull request has been merged or
// closed for a few days. Everything it talks to is passed in, so the tests can
// run it against fakes.

import { withDefaultReview } from './defaultReview.mjs';
import { DEFAULT_CONSOLE_NAME } from './config.mjs';
import { DEFAULT_RETENTION, spanText } from './consoleSettings.mjs';
import { labelTriggers, commandTriggers, rememberSeen } from './github.mjs';
import { privateSessionHomeName, sharedHomeName } from './homes.mjs';
import { createIssueTracking } from './issueTracking.mjs';
import { createPrAnnouncer } from './prAnnouncer.mjs';
import { finishedComment, runningComment } from './qaSessions.mjs';
import { QA_RECORDING_DAYS, newRecordingSecret, opensPublicVideo, qaPublicVideoPath, qaVideoPath } from './qaRecordings.mjs';
import { reviewDoneComment, reviewEndedComment, reviewHeading, reviewRunningComment } from './reviewSessions.mjs';
import { reviewVerdict } from './pullGates.mjs';
import { blockerText } from './databaseGate.mjs';
import { GAVE_UP_TEXT } from './prMessages.mjs';
import { allProjects, defaultProject, projectFor, projectNamed } from './projects.mjs';
import { TAINT_MESSAGE } from './taint.mjs';
import { HANDOFF_FILE, handoffDocument, handoffNote, handoffPrompt } from './handoff.mjs';
import { mayStartSessions, newStartToken, startTokenHash } from './sessionStarts.mjs';
import { checkLimits } from './userSettings.mjs';
import {
  ACTIVE_STATUSES, APP_STATES, activePrivateCount, isAsk, isQa, isReview, keptIds, newSessionId, newSessionToken, sessionLink,
  parseWorkOn, pullNumber, pullRepo, QA_ALREADY_RUNNING, routeQa, routeTrigger, sessionOptions, sessionsToStart, statusUpdate, stopReason, waitProgressFrom, waitsForRetry,
  EXTEND_MS, EXTEND_WINDOW_MS, pauseAt, withSessionLimits,
} from './sessions.mjs';
import logins from './public/logins.cjs';
import agents from '../shared/agents.cjs';
const { findLogin, sameLogin } = logins;

const CHECKPOINT_TIMEOUT_MS = 90_000;
// Reading a session's conversation for a hand-off: a long one is megabytes of transcript to read and shape.
const HANDOFF_READ_TIMEOUT_MS = 20_000;
// How long the repos a session's owner may start on are kept, for the pull requests it reports (reportableRepos).
const STARTABLE_KEEP_MS = 60_000;
const STATUS_TIMEOUT_MS = 5_000;
// How long statusd may take to type a private session's review feedback after getting it (it reads GitHub first).
const GUARDED_SEND_WITHIN_MS = 20_000;
// The quick look at a starting session: statusd answers at once on the same network, or is not up yet.
const STARTING_STATUS_TIMEOUT_MS = 1_500;
// After the agent opened, a start the console has not reached in this long is logged (noteUnreached): it takes a second
// or two.
const UNREACHED_AFTER_MS = 30_000;
// Comments are re-read from a minute before the last poll: GitHub's `since`
// filters on updated_at, which can trail the moment a comment shows up.
const COMMENT_OVERLAP_MS = 60_000;
const LABEL_DEDUPE_MS = 2 * 60_000;
const RECENT_LABELS_KEPT = 50;
// A receive is a 20-second long poll; two missed in a row means the queue is not being read.
const WEBHOOKS_FRESH_MS = 60_000;
const TITLE_CHARS = 80;
// How often a stopped shared session's pull request is read, to see whether it merged or closed.
const PR_STATE_CHECK_MS = 15 * 60_000;
// A Claude home whose delete failed is tried again after this, until it goes.
const HOME_DELETE_RETRY_MS = 10 * 60_000;
// ECS's words when the account's Fargate quota, or the region's capacity, has no room for another task.
const NO_ROOM_RE = /limit on the number of vCPUs|LimitExceeded|Capacity is unavailable|RESOURCE:(CPU|MEMORY)/i;
// A start AWS had no room for waits in the queue this long before it is tried again.
const NO_ROOM_RETRY_MS = 60_000;
// The triggers whose starter GitHub vouches for, so the only ones a personal Claude plan may run on.
const GITHUB_TRIGGERS = new Set(['label', 'comment', 'qa', 'review']);
// The merge risk labels' colours, the Actions review's.
const MERGE_RISK_COLORS = { Low: '0e8a16', Medium: 'fbca04', High: 'd93f0b' };
// How the tiers are decided, under every rating, so a reader can see which rule a change hit.
const MERGE_RISK_TIERS = '**High** for a plausible serious failure introduced by the diff, with a specific check to run before merging. **Medium** for meaningful changes with contained or reversible consequences, or changes that need more than a quick check. **Low** for narrow changes with limited consequences and an easy way to verify them.';

// GraphQL spells a bot's login without the `[bot]` the REST API and the project file carry.
function sameAccount(a, b) {
  const key = (login) => String(login ?? '').toLowerCase().replace(/\[bot\]$/, '');
  return Boolean(a && b) && key(a) === key(b);
}

// A review's inline comments as lines of its body, for when GitHub would not take them on the diff's lines.
function withFoldedComments(body, comments) {
  const lines = comments.map((c) => `- \`${c.path}:${c.line}\`: ${c.body.replace(/\s*\n\s*/g, ' ')}`);
  return `${body}\n\n**Inline comments**\n\n${lines.join('\n')}`.slice(0, 60_000);
}

// What Set up app types into claude, on one line as a person would. The fields are docs/reference.md's, which is not in
// the session image, so they are named here.
const SESSION_BRANCH_PREFIX = 'woodshed/';

export const SETUP_APP_PROMPT = 'Woodshed\'s Start app has nothing to run: .woodshed/project.yaml has no `app` section. '
  + 'Work out from this repo how its app runs in development, then add one: `start` (a command that starts the backend '
  + 'and the frontend in the background and returns once both answer), `stop`, `frontendPort` and `backendPort` (the '
  + 'same port twice for one server), `logs` (a name for each server\'s log file) and `howToProve` (how to check a '
  + 'change in the running app); `start`, both ports and `howToProve` are required. Write .woodshed/project.yaml '
  + 'with `version: 1` if there is none, and check it with `node /opt/woodshed/shared/project.mjs get app`. Run the '
  + 'start command yourself and check both ports answer, run the stop, then start it again and leave it running, and '
  + 'commit the file on this branch. The console reads the file within seconds and shows Open app once the frontend '
  + 'answers. Then tell me in a few plain words what you set up and that Open app opens it, at the address your rules '
  + 'give, never a localhost one, which I cannot reach.';

// What statusd said went wrong, for a person: its own error when it gave one (git's push refusal), else the call's.
function statusdError(err) {
  const said = typeof err?.body?.error === 'string' ? err.body.error : firstLine(err);
  return said.split('\n')[0].slice(0, 200);
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, 300);
}

/** @returns {Promise}  the promise's answer, or a rejection once `ms` pass without one */
function withinTime(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Why a container died, from its log's tail: the last `ERROR:` the entrypoint wrote, which says what went wrong, or
 * else the last line, which for a task that never ran is ECS's stop reason. The tail ends with that stop reason even
 * when the session logged, and on its own it says only "Essential container in task exited".
 * @param {string} tail  the launcher's logTail
 * @returns {string|null}
 */
export function failureReason(tail) {
  const lines = String(tail ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const error = lines.findLast((line) => /(^|\] )ERROR: /.test(line));
  const reason = error ? error.replace(/^.*?ERROR: /, '') : lines.at(-1);
  return reason ? reason.slice(0, 500) : null;
}

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

/** @returns {string}  why a start failed, said plainly when AWS had no room for it */
export function startError(err) {
  const line = firstLine(err);
  if (!NO_ROOM_RE.test(line)) return line;
  return `AWS has no room for another session: the account's Fargate vCPU quota or the region's capacity is used up. Stop a session and try again, or raise the quota (${line})`;
}

/** @returns {string}  a title from the first line of a prompt, for a session given no name */
function titleFrom(prompt) {
  const line = String(prompt).trim().split('\n')[0].trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/**
 * How long statusd may take to type a message and send it: it types claude's in runs of 50 characters 20 ms apart, a
 * line at a time, then reads the box (session/statusd.mjs, typingSteps), so a long one takes seconds. Each step is
 * allowed 60 ms (a tmux call and its pause), with the box check's wait and the reads around it on top.
 */
export function sendTimeoutMs(text) {
  const steps = Math.ceil(text.length / 50) + text.split('\n').length;
  return 10_000 + steps * 60;
}

// fetch's codes for a connection that was never made: nothing reached statusd (undici's, and Node's own).
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * @param {object} session
 * @param {'GET'|'POST'} method
 * @param {string} path
 * @param {{body?: object, timeoutMs?: number}} [opts]
 */
export async function callStatusd(session, method, path, { body, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const { host, statusPort } = session.endpoint;
  const res = await fetch(`http://${host}:${statusPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Its answer goes with the error: a 409 from /send with `typed` means the text is in the agent's box already.
    const body = await res.json().catch(() => null);
    throw Object.assign(new Error(`statusd ${path} answered ${res.status}`), { status: res.status, body });
  }
  return res.json();
}

/**
 * The console's address for a comment on a project's repo, as its project file's `consoleLinks` says. A file that could
 * not be read (null) keeps the default project's links, as before the setting, and leaves another project's out: its
 * repo may be public. Without one, a comment names no link to the console or a session's app.
 * @param {{publicUrl: string, project: {default?: boolean}|null, consoleLinks: boolean|null}} args
 * @returns {string|null}
 */
export function commentConsoleUrl({ publicUrl, project, consoleLinks }) {
  if (consoleLinks === true) return publicUrl;
  if (consoleLinks === false) return null;
  return project?.default === false ? null : publicUrl;
}

/**
 * @param {{session: object, publicUrl: string|null, maxRunning: number, consoleName?: string}} args  `publicUrl`: null
 *   leaves out every link; `consoleName` is config.consoleName, which every comment here calls the console
 * @returns {string}  the comment posted on the issue or PR when a session is created
 */
export function startComment({ session, publicUrl, maxRunning, appDomain = '', linkQuery = null, consoleName = DEFAULT_CONSOLE_NAME, label = 'woodshed' }) {
  if (session.status === 'failed') return failedComment({ session, publicUrl, linkQuery, consoleName, label });
  const head = session.status === 'queued'
    ? `Queued a session on ${consoleName} for @${session.startedBy}. It starts when one of the ${maxRunning} slots frees up.`
    : `Started a session on ${consoleName} for @${session.startedBy} on \`${session.branch}\`${session.plan ? `, on @${session.plan}'s own Claude plan` : ''}.`;
  const links = publicUrl
    ? [
      `Watch it and type into it: ${sessionLink(publicUrl, session.id, linkQuery)}`,
      ...(appDomain ? [`Its app, once started from that page: https://${session.id}.${appDomain}/`] : []),
    ]
    : [`Watch it and type into it from ${consoleName}.`];
  return [
    head,
    '',
    ...links,
    '',
    'Comment `/woodshed <message>` here to send it a message.',
  ].join('\n');
}

/**
 * @param {{session: object, publicUrl: string|null}} args  `publicUrl`: null leaves out the link
 * @returns {string}  the comment posted on the issue or PR when a `/woodshed` comment resumes a session
 */
export function resumeComment({ session, publicUrl, linkQuery = null, consoleName = DEFAULT_CONSOLE_NAME }) {
  return [
    `Resumed the ${consoleName} session on \`${session.branch}\` for @${session.resumedBy}, with its conversation${session.plan ? `, on @${session.plan}'s own Claude plan` : ''}.`,
    '',
    publicUrl ? `Watch it and type into it: ${sessionLink(publicUrl, session.id, linkQuery)}` : `Watch it and type into it from ${consoleName}.`,
  ].join('\n');
}

/**
 * @param {{login: string, label: string, unlabeled: boolean, member: boolean, publicUrl: string|null}} args
 *   `member`: on People; `publicUrl`: null leaves out the console's address
 * @returns {string}  the comment posted when someone without sessions from GitHub adds the label or comments
 */
export function refusalComment({ login, label, unlabeled, member, publicUrl, consoleName = DEFAULT_CONSOLE_NAME }) {
  let ask;
  if (member) {
    ask = `An admin can make you a Contributor, Member or Owner on the console's People page${publicUrl ? `: ${publicUrl}/people` : '.'}`;
  } else {
    ask = `Ask an admin to add you to the console${publicUrl ? ` (${publicUrl})` : ''} as a Contributor, Member or Owner.`;
  }
  return [
    `@${login} can't start ${consoleName} sessions from GitHub yet, so nothing started${unlabeled ? ` and the \`${label}\` label was taken off` : ''}.`,
    '',
    ask,
  ].join('\n');
}

/**
 * The error itself stays in the console: a launch error can carry the session's tokens.
 * @param {{session: object, publicUrl: string|null, label?: string}} args  `publicUrl`: null leaves out the link;
 *   `label` is the repo's own (repoTriggers.mjs)
 * @returns {string}
 */
export function failedComment({ session, publicUrl, linkQuery = null, consoleName = DEFAULT_CONSOLE_NAME, label = 'woodshed' }) {
  return [
    `The ${consoleName} session for @${session.startedBy} failed to start. The console shows why${publicUrl ? `: ${sessionLink(publicUrl, session.id, linkQuery)}` : '.'}`,
    '',
    `Add the \`${label}\` label again, or comment \`/woodshed <message>\`, to try again.`,
  ].join('\n');
}

// What Details lists of the messages between a person's sessions (noteMessage): the newest, each cut to a line.
const MESSAGES_KEPT = 20;
const MESSAGE_PREVIEW_CHARS = 200;

/**
 * @param {{config: object, store: {state: object, save: () => void}, launcher: object,
 *          github: object, statusd?: typeof callStatusd, now?: () => number,
 *          databases?: {available: boolean, createForSession: (id: string) => Promise<void>,
 *                       sweep: (keepIds: Set<string>) => Promise<void>}|null,
 *          homes?: {remove: (name: string) => Promise<void>}|null,
 *          people?: {check: (login: string) => Promise<boolean>}|null, pullWebhooksFlowing?: () => boolean}} deps
 *   `databases`: a shared session's own, copied as it first starts and dropped once it is cleaned up (databases.mjs);
 *   `homes`: where a shared session's Claude home is kept between its runs (the provider's home store)
 *   `people`: refuses a trigger from a handle now on another GitHub account than the one first seen (githubPeople.mjs)
 *   `pullWebhooksFlowing`: pull request webhooks are arriving, so a waiting pull request is read only when one comes,
 *   or every `config.fallbackPollMs` (pullWebhooks.mjs)
 *   `pullRequests`: the repo's project file's gates for a pull request, from the default branch (projectFile.mjs)
 *   `reviewGates`: the same, with every repo's default review where the file names none (defaultReview.mjs), as it is
 *   without it: what starts a review, on the tag or asked for (reviewOnDemand), and the tag a session is told. Only that: the Slack post and QA wait for the file's own review
 *   alone, so a repo that names none posts as before, whether or not a default review ran
 *   `projectBlocker(project)`: why no session that gets databases can start on that project, a blocker, or null
 *   (databaseGate.mjs)
 *   `repoTriggers`: each repo's label and its switches for labels and /woodshed comments (repoTriggers.mjs); without
 *   it, every repo has the console's label and both on
 */
export function createFleet({
  config, store, launcher, github, statusd = callStatusd, startableRepos = null, now = Date.now, databases = null, slack = null, homes = null,
  userSettings = null, people = null, autoName = null, attachments = null, qaRecordings = null, members = null, pings = null,
  pullWebhooksFlowing = () => false, pullRequests = async () => null, reviewGates = async (name) => withDefaultReview(await pullRequests(name)), projectBlocker = async () => null, githubFor = null,
  consoleLinks = async () => true, newId = newSessionId, ownApp = () => null, reviewerApp = null, repoTriggers = null, reviewAgents = null,
  mcpServers = null, appShares = null, egress = null,
}) {
  const { state } = store;
  // Each repo's label and whether its label and /woodshed comments start anything (repoTriggers.mjs).
  const triggersOf = (project) => repoTriggers?.of(project?.name ?? null) ?? { label: config.label, labels: true, comments: true };
  const nowIso = () => new Date(now()).toISOString();
  const secondsSince = (iso) => (iso ? Math.round((now() - Date.parse(iso)) / 1000) : null);
  const retention = () => config.retention ?? DEFAULT_RETENTION;
  const announcer = createPrAnnouncer({
    store, github, githubOf: (name) => githubOf(projectNamed(config, name) ?? defaultProject(config)), defaultProjectName: () => defaultProject(config).name, slack, gates: (name, number) => gatesFor(name, number), now, giveUpMs: () => retention().slackGiveUpMs, qaWaitMs: () => retention().qaWaitMs ?? DEFAULT_RETENTION.qaWaitMs,
    events: { dropped: prDropped, feedback: prFeedback, gaveUp: prGaveUp, mention: prMention, listening: prListening },
    webhooksFlowing: pullWebhooksFlowing, fallbackMs: config.fallbackPollMs, ownApp, sessionKnown: (id) => Boolean(find(id)),
  });
  const issueTracking = createIssueTracking({ github });
  const issueTrackings = new Map();
  const prCheckedAt = new Map();
  // When each pull request with ended review or QA runs was last read for whether it closed (pruneEndedRuns).
  const pullRunsCheckedAt = new Map();
  // Private sessions whose statusd last refused or missed review feedback, so it is warned of once.
  const untypedSaid = new Set();
  const homeDeleteTriedAt = new Map();
  let ticking = false;
  // The quick check has its own guard: sharing the tick's would skip ticks while starting sessions time out.
  let checkingStarts = false;
  let checkingWaits = false;
  // The last error each waiting session's progress read gave, so a launcher that keeps failing logs it once.
  const progressErrors = new Map();
  // Sessions whose statusd is being read, by the tick or the quick check: one read at a time, so a held message is
  // never typed in twice.
  const readingStatus = new Set();
  // The start each session last logged as unreached for (noteUnreached), so each start logs it once.
  const unreachedStarts = new Map();
  // Stops in flight in this process. A session left `stopping` by a restart has none, and tick finishes it.
  const stopsInFlight = new Set();
  // Private sessions being handed off (handOffPrivate): a second Hand off meanwhile would start a second session.
  const handoffsInFlight = new Set();
  // A Stop pressed while a hand-off's stop pushes: carried out if that push fails and the session would run on.
  const stopsAskedMidHandoff = new Map();
  // Launches in flight in this process. A session left `starting` with no task by a restart has none, and tick
  // looks for the task it began.
  const launchesInFlight = new Set();
  let webhooksAliveAt = -Infinity;
  let lastPollAt = -Infinity;
  let pollingSlowly = false;
  // Projects already said to have no GitHub client to poll with: said once, not on every poll.
  const unpolledProjects = new Set();
  // Another project's poll error, by its name, while it keeps failing.
  const failingProjects = new Map();
  // Lockdowns in flight (taint): a session is treated as locked from the moment its lockdown starts.
  const locking = new Map();
  // When each tainted session's notice to its statusd was last tried, so the tick tries again until it lands.
  const taintNoticeTriedAt = new Map();

  function update(session, fields) {
    Object.assign(session, fields);
    // A session that stops can start nothing more: its start token goes with its run (sessionStarts.mjs).
    if (session.startTokenHash && !ACTIVE_STATUSES.has(session.status)) session.startTokenHash = null;
    // Nor does it wait on a question it asked (noteQuestion): a Resume starts it with none open.
    if (session.askedAt && !ACTIVE_STATUSES.has(session.status)) {
      Object.assign(session, { askedAt: null, askedOf: null, askedSettled: null, askedLastAt: null });
      console.log('fleet: question answered', { id: session.id, why: 'stopped' });
    }
    store.save();
  }

  function find(id) {
    return state.sessions.find((s) => s.id === id) ?? null;
  }

  function sessionEnv(session) {
    const env = {
      ...config.sessionEnv,
      SESSION_ID: session.id,
      SESSION_TOKEN: session.token,
      TERMINAL_TOKEN: session.terminalToken,
      STARTED_BY: session.startedBy,
      SESSION_URL: sessionLink(config.publicUrl, session.id, config.linkQuery),
    };
    // A private session fetches its owner's settings from the console's session API at start (sessionApi.mjs).
    if (session.owner) env.SESSION_KIND = 'private';
    // The session's app answers at `<id>.<appDomain>`; Woodshed's own app (console/bin/devConsole.mjs) lets in that name alone.
    if (config.appDomain) env.SESSION_APP_DOMAIN = config.appDomain;
    // Every project runs in the default project's image for now, so a session on another one clones its repo at start.
    // So does one on a default project an admin added to a console that started with no repo, which no image holds.
    const project = projectFor(config, session);
    if (!project.default || project.clonedAtStart) env.PROJECT_REPO = project.repo;
    // Claude Code is the image's default; any other agent is named (shared/agents.cjs).
    if (agents.isAgent(session.options?.agent) && session.options.agent !== 'claude') env.AGENT = session.options.agent;
    if (session.options?.model) env.MODEL = session.options.model;
    if (session.options?.effort) env.EFFORT = session.options.effort;
    if (session.options?.permissionMode) env.PERMISSION_MODE = session.options.permissionMode;
    if (session.resumeClaude) env.RESUME_SESSION = session.resumeClaude;
    // The entrypoint fetches them from the session API (attachments.mjs) and lists them under the prompt.
    if (session.attachments) env.ATTACHMENTS = String(session.attachments);
    // With a GitHub App, sessions fetch short-lived tokens from the console instead (sessionApi.mjs).
    const ghToken = config.sessionEnv.GH_TOKEN || config.ghToken;
    if (ghToken) env.GH_TOKEN = ghToken;
    // A question from Slack reads the default branch and pushes nothing (asks.mjs): a fixed token could write, so it gets only the
    // session API's read-only one.
    if (isAsk(session)) {
      delete env.GH_TOKEN;
      env.SESSION_MODE = 'ask';
      if (session.slack?.name) env.ASKED_BY = session.slack.name;
    } else if (isQa(session)) {
      // QA reads the pull request and changes nothing on it: the console posts its report (qaSessions.mjs).
      delete env.GH_TOKEN;
      env.SESSION_MODE = 'qa';
      env.PR = String(session.number);
      env.QA_BASE = session.qa.base;
    } else if (isReview(session)) {
      // The review reads the diff and changes nothing: the console submits the verdict and the Merge risk check.
      delete env.GH_TOKEN;
      env.SESSION_MODE = 'review';
      env.PR = String(session.number);
      env.REVIEW_BASE = session.review.base;
      // Whose earlier inline comments are the review's own, for the session to check whether the head fixes them.
      if (session.review.author) env.REVIEW_AUTHOR = session.review.author;
      // Who reviews, as the author chose on My settings when the review started (reviewAgents.mjs), and how its codex
      // reaches OpenAI, through the console either way: the author's ChatGPT login, or a key.
      if (session.review.agents?.length) env.REVIEW_AGENTS = session.review.agents.join(' ');
      if (session.review.agents?.includes('codex')) {
        env.REVIEW_CODEX_AUTH = session.review.codexVia === 'chatgpt' ? 'chatgpt' : 'key';
        if (env.REVIEW_CODEX_AUTH === 'chatgpt' && session.review.codexAccount) env.REVIEW_CODEX_ACCOUNT = session.review.codexAccount;
      }
      // OpenCode reviews on one provider's API key, which the console adds (reviewAgentProxy.mjs): which provider its
      // config points at the console. Grok Build needs nothing more: it calls the console's /grok on a key either way.
      if (session.review.agents?.includes('opencode') && session.review.ownSignIns?.opencode?.provider) env.REVIEW_OPENCODE_PROVIDER = session.review.ownSignIns.opencode.provider;
    } else if (session.kind === 'pr') env.PR = String(session.number);
    else {
      if (session.kind === 'issue') env.ISSUE = String(session.number);
      env.BRANCH = session.branch;
    }
    if (session.prompt) env.PROMPT = session.prompt;
    // The review's tag, for the session's rules when its checkout's project file names none (entrypoint.sh, writeRules).
    if (session.reviewTag) env.WOODSHED_REVIEW_TAG = session.reviewTag;
    // Claude opens with nothing to do: the person came to read the review, which the session starts itself.
    if (session.reviewOnly) env.REVIEW_ONLY = '1';
    // Its agent's terminal comes from its person's Herdr, as a child of theirs (`woodshed session new --herdr --parent`):
    // the entrypoint waits for it rather than make its own. Set for this run alone, by the start or resume that asked.
    if (session.owner && session.herdrParent) env.WOODSHED_HERDR_PARENT = '1';
    // The MCP servers the console hands this session (mcpServers.mjs), each reached through its relay: names only, the
    // session never holds what a server takes. A production one is turned off until its person turns it on. A launcher
    // whose sessions cannot be moved onto a locked network later (AWS) starts a session that may use one on a guarded
    // network at once, whose only way out is the console's egress proxy. A tainted session starts locked down, whatever
    // it is resumed as, with its production servers alone.
    const servers = mcpServers?.forSession(session, project.repo ?? null) ?? [];
    if (servers.length) env.WOODSHED_MCP_SERVERS = JSON.stringify(servers);
    const production = Boolean(session.taintedAt) || servers.some((s) => s.production);
    if (production) env.WOODSHED_PROD_MCP = '1';
    if (session.taintedAt) env.WOODSHED_TAINTED = '1';
    if (production && egress?.sessionUrl && (session.taintedAt || launcher.guardsEgress)) env.WOODSHED_EGRESS_PROXY = egress.sessionUrl;
    return env;
  }

  /** @returns {boolean}  whether the session's egress is held to the lockdown's: tainted, or its lockdown under way */
  function isLocked(session) {
    return Boolean(session?.taintedAt) || locking.has(session?.id);
  }

  /**
   * Taints a session: its network is locked down by the launcher, outside the container, and only once that is in
   * place is it marked, which nothing ever undoes. A lockdown that fails leaves the session untainted and throws, so
   * the call that asked for it is refused (mcpRelay.mjs). Called again while one is under way, it waits for that one.
   * @param {object} session
   * @param {{why?: string}} [opts]
   * @returns {Promise<object>}  the session, tainted
   */
  // Called with a session's id the moment its lockdown starts (onLocking).
  const lockingListeners = [];
  function onLocking(fn) {
    lockingListeners.push(fn);
  }

  function taint(session, { why = null } = {}) {
    if (session.taintedAt) return Promise.resolve(session);
    if (locking.has(session.id)) return locking.get(session.id);
    const run = (async () => {
      // A hand-off reads the conversation into a session that outlives this one (handoff.mjs): never both at once.
      if (handoffsInFlight.has(session.id)) throw shown('the session is being handed off to another agent: try again once it is done');
      if (session.status !== 'running' || !session.ref || !session.endpoint) throw shown('the session is not running');
      // One started before it could use production holds what an untainted session does (its owner's databases, maybe
      // the machine's Docker): it is never tainted, whatever the servers say now.
      if (!session.mayUseProduction) {
        throw shown('this session started before it could use production, so it holds its owner\'s databases: start a new My Woodshed session, which starts ready for it');
      }
      // The agents its owner started beside its own lose what they were allowed (a Codex one's sign-in and the team's
      // OpenAI key) from the moment the lockdown starts, whether or not it succeeds: statusd stops them at its taint.
      if (session.extraAgents?.length) {
        console.log('fleet: other agents\' access dropped at the lockdown', { id: session.id, agents: session.extraAgents });
        update(session, { extraAgents: null });
      }
      // Whatever it has open that the lockdown does not cover (the egress proxy's tunnels, an ordinary MCP server's
      // stream) is cut before anything of production reaches it.
      for (const cut of lockingListeners) {
        try {
          cut(session.id);
        } catch (err) {
          console.warn('fleet: a cut at the lockdown failed', { id: session.id, message: firstLine(err) });
        }
      }
      // Root on the machine could join the session to any network again: only a session without it is locked down.
      if (session.endpoint.docker === 'host') {
        throw shown('this session holds the machine\'s Docker socket, which could undo a lockdown: start a new My Woodshed session, which production access starts without it');
      }
      if (typeof launcher.lockDown !== 'function') throw shown(`this console's sessions (${launcher.kind}) cannot be locked down`);
      console.log('fleet: locking a session down', { id: session.id, owner: session.owner ?? null, why });
      let endpoint;
      try {
        endpoint = await launcher.lockDown(session.ref, { sessionId: session.id, endpoint: session.endpoint, env: sessionEnv(session), egressUrl: egress?.sessionUrl ?? null });
      } catch (err) {
        console.warn('fleet: lockdown failed, the session stays untainted', { id: session.id, message: firstLine(err) });
        throw shown(`the session could not be locked down: ${firstLine(err)}`);
      }
      update(session, { taintedAt: nowIso(), taintedWhy: why, ...(endpoint ? { endpoint: { ...session.endpoint, ...endpoint } } : {}) });
      console.log('fleet: session tainted', { id: session.id, owner: session.owner ?? null, taintedAt: session.taintedAt, launcher: launcher.kind, why });
      // Nobody outside the session's people sees its app from now on.
      appShares?.clearSession(session.id);
      tellTainted(session).catch(() => {});
      return session;
    })().finally(() => locking.delete(session.id));
    locking.set(session.id, run);
    return run;
  }

  // The session's statusd is told, so claude reopens on the console's Anthropic proxy with the lockdown's rules and the
  // agent is told what is blocked. Tried again on each tick until it lands: an image from before it answers 404.
  async function tellTainted(session) {
    if (!session.taintedAt || session.taintNoticedAt || session.status !== 'running' || !session.endpoint) return;
    if (now() - (taintNoticeTriedAt.get(session.id) ?? -Infinity) < 20_000) return;
    taintNoticeTriedAt.set(session.id, now());
    try {
      const ca = egress?.caPem ? await egress.caPem() : null;
      await statusd(session, 'POST', '/taint', { body: { proxy: egress?.sessionUrl ?? null, ca, message: TAINT_MESSAGE }, timeoutMs: 15_000 });
    } catch (err) {
      console.warn('fleet: the tainted session was not told yet', { id: session.id, message: firstLine(err) });
      return;
    }
    taintNoticeTriedAt.delete(session.id);
    update(session, { taintNoticedAt: nowIso() });
    console.log('fleet: tainted session told', { id: session.id });
  }

  // A tainted session goes once it has been stopped for the Console settings page's time (24 hours by default),
  // with everything it kept: its Claude home, its attachments, its record.
  async function removeTainted(session) {
    if (!session.taintedAt || !session.owner || ACTIVE_STATUSES.has(session.status) || session.status === 'stopping') return;
    const after = retention().taintedRemoveAfterMs ?? 24 * 3_600_000;
    const from = Date.parse(session.stoppedAt ?? session.taintedAt);
    if (!Number.isFinite(from) || now() < from + after) return;
    console.log('fleet: tainted session removed', { id: session.id, owner: session.owner, why: `stopped ${spanText(after)} ago` });
    await removePrivateSession({ owner: session.owner, id: session.id });
  }

  // A tainted session's saved home that could not be deleted when it was removed: tried again until it goes.
  async function retryTaintedHomes() {
    const pending = state.taintedHomesPending ?? [];
    if (!pending.length || !homes) return;
    const left = [];
    for (const item of pending) {
      if (now() - (homeDeleteTriedAt.get(item.name) ?? -Infinity) < HOME_DELETE_RETRY_MS) {
        left.push(item);
        continue;
      }
      homeDeleteTriedAt.set(item.name, now());
      try {
        await homes.remove(item.name);
        homeDeleteTriedAt.delete(item.name);
        console.log('fleet: tainted session\'s Claude home deleted', { id: item.id });
      } catch (err) {
        console.warn('fleet: tainted session\'s Claude home not deleted yet, tried again later', { id: item.id, message: firstLine(err) });
        left.push(item);
      }
    }
    // Only what this sweep deleted goes: an entry added while it awaited storage stays in the queue.
    const done = new Set(pending.filter((item) => !left.includes(item)));
    if (done.size) {
      state.taintedHomesPending = (state.taintedHomesPending ?? []).filter((item) => !done.has(item));
      store.save();
    }
  }

  // Decided at each start and resume, from whoever started the session: its token itself never leaves the console,
  // whose Anthropic proxy adds it to this session's calls alone.
  // Only a label or a /woodshed comment: GitHub says who that was, and checked their write access. Whether or not the
  // console makes the session's databases: the entrypoint asks the session API's /settings for the plan either way, so
  // a console with no db-admin (or a project with no database) is no reason to fall back to a team key it may not have.
  async function planFor(session) {
    if (session.owner || !GITHUB_TRIGGERS.has(session.trigger) || session.review?.teamKey || session.qa?.teamKey) return null;
    await userSettings?.refresh?.(session.startedBy, { force: true });
    if (!userSettings?.usesOwnTokenForShared(session.startedBy)) return null;
    try {
      if (await userSettings.claudeToken(session.startedBy)) return session.startedBy;
      console.warn('fleet: the starter\'s Claude token is not saved, the team key it is', { id: session.id, startedBy: session.startedBy });
    } catch (err) {
      console.warn('fleet: the starter\'s Claude token could not be read, the team key it is', { id: session.id, startedBy: session.startedBy, message: firstLine(err) });
    }
    return null;
  }

  async function launch(session) {
    launchesInFlight.add(session.id);
    try {
      await launchNow(session);
    } finally {
      launchesInFlight.delete(session.id);
    }
  }

  async function launchNow(session) {
    // Two callers can list the same queued session before either has launched it.
    if (session.status !== 'queued') return;
    update(session, { status: 'starting', startedAt: nowIso(), retryAt: null, waitProgress: null });
    console.log('fleet: starting session', { id: session.id, number: session.number, launcher: launcher.kind });
    if (!session.owner) {
      const plan = await planFor(session);
      update(session, { plan });
      console.log('fleet: whose Claude the session runs on', { id: session.id, plan: plan ?? 'team key' });
    }
    // Whether this session may use production is decided at a start, its first or a Resume (a new container either way),
    // once and for good, and only such a session can ever be tainted
    // (taint): it starts as one must be for the lockdown (no machine's Docker, on AWS the guarded network), and works on
    // databases of its own, as a shared session does, never its owner's: what it writes there after a taint is dropped
    // with it (keptIds), and no untainted session reads it.
    if (session.owner && !session.mayUseProduction && mcpServers?.forSession(session, projectFor(config, session).repo ?? null).some((s) => s.production)) {
      update(session, { mayUseProduction: true, ...(databases?.available ? { ownDatabases: true } : {}) });
      console.log('fleet: a session that may use production', { id: session.id, owner: session.owner, ownDatabases: Boolean(session.ownDatabases) });
    }
    // The tag that asks for the repo's review, which a coding session's rules tell its agent to put on its commits: the
    // project file's, or every repo's default where the file names none, which the file in the checkout cannot say
    // (defaultReview.mjs). None for every-commit review, a review run elsewhere, or a file that could not be read, which
    // starts the session all the same.
    if (!isAsk(session) && !isQa(session) && !isReview(session)) {
      const review = (await reviewGates(projectFor(config, session).name).catch((err) => {
        console.warn('fleet: review tag not read, the session starts with none', { id: session.id, message: firstLine(err) });
        return null;
      }))?.review ?? null;
      update(session, { reviewTag: review?.rerun ?? null });
    }
    let started;
    try {
      // Copied while the container starts: the session waits for them at the session API before it writes its env.
      if (((!session.owner && !isAsk(session) && !isReview(session)) || session.ownDatabases) && databases?.available) await databases.createForSession(session.id);
      started = await launcher.start(session.id, { ...sessionEnv(session), ...startTokenFor(session) });
    } catch (err) {
      const error = startError(err);
      // No room is AWS being full for now, not the session failing: it waits in the queue until a task stops.
      if (NO_ROOM_RE.test(firstLine(err))) {
        update(session, { status: 'queued', startedAt: null, error, retryAt: new Date(now() + NO_ROOM_RETRY_MS).toISOString() });
        console.warn('fleet: AWS has no room, session back in the queue', { id: session.id, retryInMs: NO_ROOM_RETRY_MS });
        // Not waited for: the queue goes on, and checkWaiting reads it again within a couple of seconds.
        readProgress(session).catch((err) => console.error('fleet: wait progress failed', { id: session.id, message: firstLine(err) }));
        return;
      }
      console.error('fleet: session failed to start', { id: session.id, message: firstLine(err) });
      update(session, { status: 'failed', stoppedAt: nowIso(), error });
      await announceFailure(session);
      return;
    }
    // Stopped while the container was coming up: nothing else will ever clean it up.
    if (session.status !== 'starting') {
      await launcher.stop(started.ref);
      return;
    }
    const { ref, ...endpoint } = started;
    // The container may already have reported a step of its own: the docker launcher starts it before answering.
    update(session, { ref, endpoint, startSteps: { machine: nowIso(), ...session.startSteps } });
    console.log('fleet: machine ready', { id: session.id, seconds: secondsSince(session.startedAt) });
  }

  // Each run of a person's own session gets a token to start sessions of theirs with (sessionStarts.mjs), made here so the
  // console only ever keeps its hash: the session holds the token, the record its hash, and a resume makes another.
  function startTokenFor(session) {
    if (!mayStartSessions(session)) {
      if (session.startTokenHash) update(session, { startTokenHash: null });
      return {};
    }
    const token = newStartToken();
    update(session, { startTokenHash: startTokenHash(token) });
    return { WOODSHED_START_TOKEN: token };
  }


  async function startQueued() {
    const limits = { maxRunning: config.maxRunning, maxPrivate: config.maxPrivatePerPerson, maxAsks: config.maxAsks };
    for (const session of sessionsToStart(state.sessions, limits, now())) await launch(session);
  }

  // In the background the caller gets the session back as soon as it is 'starting', not after the container has an
  // address, which run-task and its wait make take several seconds. The loop may go on to other queued sessions, as a tick does.
  async function runStartQueued({ background }) {
    if (!background) return startQueued();
    startQueued().catch((err) => console.error('fleet: background start failed', { message: firstLine(err) }));
  }

  /**
   * @param {{kind: 'issue'|'pr'|'task'|'ask', number: number|null, title: string, startedBy: string,
   *          trigger: 'label'|'comment'|'console'|'my-woodshed'|'slack'|'qa', prompt?: string, branch?: string|null,
   *          owner?: string|null, options?: {model: string, effort: string, permissionMode: string}|null,
   *          attach?: ((id: string) => Promise<number>)|null, background?: boolean, reviewOnly?: boolean, herdrParent?: boolean,
   *          slack?: {channel: string, threadTs: string, user: string, name: string|null}|null}} args
   *   `qa` ({base, sha, heading, commentId}) makes a 'pr' session a QA session (qaSessions.mjs), which tests the pull
   *   request against `base` and changes nothing on it.
   *   `kind` 'task' is a private session on no issue or PR, 'ask' a question from Slack on no branch, answered in
   *   the `slack` thread; `owner` makes a session private to that login; `attach` moves the files attached to New
   *   session under it before it launches, and says how many; `background` answers without waiting for the launch
   */
  // A console that started with no repo has nothing to check out until an admin adds one on the Console settings page.
  function refuseWithoutRepo(project, { kind, trigger }) {
    if (project?.repo) return;
    console.warn('fleet: session refused, the console has no repo yet', { kind, trigger });
    throw shown('Not started: the console has no repo yet. An admin adds one on the Console settings page, under Repos.');
  }

  async function createSession({
    kind, number, title, startedBy, trigger, prompt = '', branch = null, owner = null, options = null, resumeClaude = null, attach = null,
    background = false, reviewOnly = false, slack: thread = null, assignTo = null, project = defaultProject(config), qa = null, review = null,
    herdrParent = false, startedFrom = null, startedApart = false,
  }) {
    refuseWithoutRepo(project, { kind, trigger });
    // An agent that runs on its owner's own sign-in alone runs only in that owner's private session: a shared session,
    // a question, a QA run and a review hold no one's sign-in (shared/agents.cjs).
    if (!owner && agents.agent(options?.agent).signIn) {
      console.warn('fleet: session refused, its agent needs an owner\'s own sign-in', { kind, number, trigger, agent: options.agent });
      throw shown(`${agents.agent(options.agent).product} runs only in a My Woodshed session`);
    }
    // A question from Slack, and a review that only reads the diff, get no databases, so they need none hosted.
    // A question from Slack, and a review that only reads the diff, get no databases, so they need none hosted; nor
    // anything else of the project's start, so a blocker does not hold them back.
    const blocked = kind === 'ask' || review ? null : await projectBlocker(project);
    if (blocked) {
      const why = blockerText(blocked);
      console.warn('fleet: session refused, its project is not ready', { kind, number, trigger, why, ...projectField(project) });
      throw shown(`Not started: ${why}`);
    }
    const id = newId();
    const attached = attach ? await attach(id) : 0;
    const defaultBranch = kind === 'issue' ? `woodshed/${number}-${id}` : kind === 'task' ? `woodshed/${owner}-${id}` : null;
    const session = {
      id, project: project.name, repo: project.repo, kind, number, title, startedBy, trigger, prompt, owner, options, resumeClaude, slack: thread,
      branch: branch || defaultBranch,
      // The branch the console made for it, when it made one: `branch` follows what statusd says is checked out.
      ...(!branch && defaultBranch ? { madeBranch: defaultBranch } : {}),
      status: 'queued', state: null, createdAt: nowIso(), startedAt: null, stoppedAt: null,
      lastActiveAt: null, checkedAt: null, stopReason: null, error: null,
      head: null, prUrl: null, lastMessage: null, commentId: null,
      token: newSessionToken(), terminalToken: newSessionToken(), ref: null, endpoint: null, pendingMessages: [],
      ...(attached ? { attachments: attached } : {}),
      ...(reviewOnly ? { reviewOnly: true } : {}),
      ...(owner && herdrParent ? { herdrParent: true } : {}),
      // The session of the same person's that started this one (sessionStarts.mjs), for the pages to link both ways.
      // `startedApart`: started on its own (woodshed-session new --separate), not as a piece of the starting session's
      // work: the rail shows it at the top level, and the starting session's own list leaves it out.
      ...(owner && startedFrom ? { startedFrom, ...(startedApart ? { startedApart: true } : {}) } : {}),
      ...(qa ? { qa } : {}),
      ...(review ? { review } : {}),
      ...(assignTo ? { assignee: assignTo.login, assignedBy: assignTo.login, assignedHow: assignTo.how, assignedAt: nowIso() } : {}),
    };
    state.sessions.push(session);
    store.save();
    console.log('fleet: session created', {
      id, kind, number, trigger, startedBy, private: Boolean(owner), resumed: Boolean(branch), background, assignee: session.assignee ?? null, qa: Boolean(qa),
      ...(project.default ? {} : { project: project.name, repo: project.repo }),
      ...(session.herdrParent ? { herdrParent: true } : {}),
      ...(session.startedFrom ? { startedFrom: session.startedFrom, ...(session.startedApart ? { startedApart: true } : {}) } : {}),
    });
    await runStartQueued({ background });
    return session;
  }

  // The messages between two sessions of a person's (sessionStarts.mjs), on both, for the page's Details: when, which
  // way, with which session, whether it asked something, and the start of what it said. The newest MESSAGES_KEPT.
  // `unconfirmed`: the console did not hear back that it went in (fleet.send's `unknown`): it may not have arrived.
  function noteMessage({ from, to, text, question = false, unconfirmed = false }) {
    const at = nowIso();
    const said = String(text).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_PREVIEW_CHARS);
    for (const [s, other, dir] of [[from, to, 'out'], [to, from, 'in']]) {
      update(s, { messages: [{ at, dir, with: other.id, question: Boolean(question), text: said, ...(unconfirmed ? { unconfirmed: true } : {}) }, ...(s.messages ?? [])].slice(0, MESSAGES_KEPT) });
    }
  }

  // A question a session asked another of its person's (sessionStarts.mjs, --question): it waits for an answer, which the
  // rail says (public/common.js displayStatus). It ends with any message typed into it, or once it works again after its
  // turn on the question ended: the person may answer in its own Chat or TUI.
  function noteQuestion(session, { to }) {
    update(session, { askedAt: nowIso(), askedOf: to, askedSettled: false, askedLastAt: null });
    console.log('fleet: session asked a question', { id: session.id, of: to });
  }
  function answered(session, why) {
    if (!session.askedAt) return;
    update(session, { askedAt: null, askedOf: null, askedSettled: null, askedLastAt: null });
    console.log('fleet: question answered', { id: session.id, why });
  }
  // The last thing it said when its turn on the question ended (`askedLastAt`): a newer one is a turn since, one whose
  // working the reads every few seconds may have missed (an answer typed in its TUI and done with quickly).
  function settleQuestion(session) {
    if (!session.askedAt) return;
    const lastAt = session.lastMessage?.at ?? null;
    if (session.state === 'working') {
      if (session.askedSettled) answered(session, 'working again');
    } else if (['done', 'needs-you', 'idle'].includes(session.state)) {
      if (!session.askedSettled) update(session, { askedSettled: true, askedLastAt: lastAt });
      else if (lastAt && lastAt !== session.askedLastAt) answered(session, 'a turn since');
    }
  }

  function hold(session, text, id = null) {
    update(session, { pendingMessages: [...session.pendingMessages, id ? { id, text } : text] });
    console.log('fleet: message held until the agent is at its prompt', { id: session.id, pending: session.pendingMessages.length });
  }

  function canType(session) {
    // While claude opens the pane holds a shell, which would run the text as a command.
    if (!(session.status === 'running' && session.state && session.state !== 'not-running' && session.state !== 'starting')) return false;
    // A statusd from before the guarded send (a session started before an upgrade) types blind, Enter and all: through
    // it, only while the agent is plainly idle, never at a prompt it could answer.
    return session.safeSend === true || session.state === 'done';
  }

  // Through a statusd that types blind, the idle state is only as good as its read: such a message is always held, and
  // deliverHeld types one right after each status read that says the agent is idle, then waits for the next read.
  function guarded(session) {
    return session.safeSend === true;
  }

  // A send statusd never answered may have gone in: it may still be typing it and press its Enter after (a timeout), or
  // have sent it before the connection dropped (a reset, a reply cut off). Sent again it could reach the agent twice, so
  // it is not: the agent's record says whether it arrived. Only a connection that was never made, or an answer statusd
  // gave in full (`status` with its body), says it typed nothing; that is held to try again.
  function unknownOutcome(session, err) {
    // statusd always answers with its reasons: an answer with none was cut off, or is not statusd's, and says nothing of
    // what was typed (a 409's `typed`).
    if (typeof err?.status === 'number' && err.body && typeof err.body === 'object') return false;
    const code = err?.cause?.code ?? err?.code ?? null;
    if (NEVER_CONNECTED.has(code)) return false;
    console.warn('fleet: message send got no answer, not sent again: it may have gone in', { id: session.id, why: code ?? err?.name ?? null });
    return true;
  }

  // A send statusd refused after the text went in (a prompt came up as it was typed): typing it again would put it in
  // the agent's box twice. It is there, for the agent to read once the prompt is answered.
  // The page is told which of its messages that was, by its own id and when, never its text (`leftInBox`), so its bubble
  // can say it sits in the box; a status read with the box empty again forgets it (readStatus).
  function inTheBox(session, err, messageId = null) {
    if (!(err?.status === 409 && err.body?.typed === true)) return false;
    console.warn('fleet: message left in the agent\'s box, not sent', { id: session.id, why: err.body?.why ?? null });
    update(session, { leftInBox: { at: nowIso(), id: messageId } });
    return true;
  }

  // The page's id for each message the console held and has since sent, the last 20: its bubble turns sent on its own id
  // alone, which an older read of the session never holds.
  function noteDelivered(session, messageId) {
    if (!messageId) return;
    update(session, { deliveredIds: [...(session.deliveredIds ?? []), messageId].slice(-20) });
  }

  // statusd typed nothing because the agent is not at its prompt for it (working, asking, a message not yet taken):
  // held, and sent again once it is. Not a failure, so said once per reason, quietly.
  function busyWhy(err) {
    if (err?.status !== 409 || typeof err.body?.why !== 'string' || err.body.typed) return null;
    return err.body.why;
  }
  // Why each session's held messages last did not go, so it is logged once per reason.
  const heldWhy = new Map();

  function withoutFirst(list, text) {
    const at = list.indexOf(text);
    return at === -1 ? list : [...list.slice(0, at), ...list.slice(at + 1)];
  }

  /**
   * @param {string} text  typed as statusd types it: CRLF made newlines, other control characters left out
   * @returns {Promise<'sent'|'queued'|'in-box'|'unknown'>}  unknown: no answer in time, so it may have gone in  in-box: typed with no Enter (a prompt came up as it went in), so it sits
   *   in the agent's box unsent, for the person to send or clear in the TUI tab; never typed again
   */
  async function send(session, raw, { id = null } = {}) {
    const outcome = await sendNow(session, raw, { id });
    // On its way, or in: an answer to a question the session asked. One left in its box unsent is not, yet.
    if (outcome !== 'in-box') answered(session, 'a message');
    return outcome;
  }

  async function sendNow(session, raw, { id = null } = {}) {
    // As statusd will take it (session/statusd.mjs, typeableText), so what is held is what can be typed, and the same
    // length the page is told of.
    const text = String(raw).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!text.trim()) {
      console.warn('fleet: message dropped, nothing in it to type', { id: session.id });
      return 'sent';
    }
    // Behind the ones already waiting, in the order they were sent.
    if (!canType(session) || !guarded(session) || session.pendingMessages.length) {
      hold(session, text, id);
      return 'queued';
    }
    try {
      await statusd(session, 'POST', '/send', { body: { text }, timeoutMs: sendTimeoutMs(text) });
    } catch (err) {
      if (inTheBox(session, err, id)) return 'in-box';
      // It may have gone in: not held to send again, and said to the page as not known, not as sent.
      if (unknownOutcome(session, err)) return 'unknown';
      // Busy is not a failure: hold() says it is held.
      if (!busyWhy(err)) console.warn('fleet: send failed, holding the message', { id: session.id, message: firstLine(err) });
      hold(session, text, id);
      return 'queued';
    }
    console.log('fleet: message sent', { id: session.id, chars: text.length });
    return 'sent';
  }

  async function deliverHeld(session) {
    while (session.pendingMessages.length && canType(session)) {
      const [held] = session.pendingMessages;
      const text = typeof held === 'string' ? held : held.text;
      const messageId = typeof held === 'string' ? null : held.id;
      // A message from Chat (it has the page's id) held before the session came back on a statusd that types blind (a
      // resume on an older image): never typed there, as the page's own send is refused (server.mjs). The page is told.
      if (messageId && !guarded(session)) {
        console.warn('fleet: held message from the page dropped, the session cannot send safely', { id: session.id, chars: text.length });
        update(session, {
          pendingMessages: withoutFirst(session.pendingMessages, held),
          refusedIds: [...(session.refusedIds ?? []), messageId].slice(-20),
        });
        continue;
      }
      let boxed = false;
      try {
        await statusd(session, 'POST', '/send', { body: { text }, timeoutMs: sendTimeoutMs(text) });
      } catch (err) {
        // One statusd will never take (too long, not text) would hold every message behind it: it goes, said so.
        if (err?.status === 400) {
          console.warn('fleet: held message dropped, the session refuses it', { id: session.id, chars: text.length, message: firstLine(err) });
          update(session, {
            pendingMessages: withoutFirst(session.pendingMessages, held),
            ...(messageId && { refusedIds: [...(session.refusedIds ?? []), messageId].slice(-20) }),
          });
          continue;
        }
        // A send with no answer in time may have gone in: not sent again, and the page told so, by its id, rather than
        // left promising it.
        const inBox = inTheBox(session, err, messageId);
        const unknown = !inBox && unknownOutcome(session, err);
        if (unknown && messageId) update(session, { unknownIds: [...(session.unknownIds ?? []), messageId].slice(-20) });
        boxed = inBox || unknown;
        if (!boxed) {
          // Busy is the usual answer mid-turn: said once per reason, not on every status read.
          const why = busyWhy(err) ?? firstLine(err);
          if (heldWhy.get(session.id) !== why) console.log('fleet: held message not delivered yet', { id: session.id, why });
          heldWhy.set(session.id, why);
          return;
        }
      }
      heldWhy.delete(session.id);
      // The list as it is now: a message held while this one went in stays.
      update(session, { pendingMessages: withoutFirst(session.pendingMessages, held) });
      if (!boxed) noteDelivered(session, messageId);
      // In the agent's box with no Enter: inTheBox said so; it is not sent, and not typed again.
      if (!boxed) console.log('fleet: held message sent', { id: session.id, chars: text.length, left: session.pendingMessages.length });
      // The agent is working on it now, which a blind statusd would not check before the next one's Enter.
      if (!guarded(session)) return;
    }
  }

  /**
   * @param {{by?: string|null, requireCheckpoint?: boolean}} [opts]  requireCheckpoint: a hand-off's stop, which goes on
   *   only once the work is pushed; a checkpoint that fails leaves the session running and throws
   */
  async function stop(session, reason, { by = null, requireCheckpoint = false } = {}) {
    if (session.status === 'queued' || (session.status === 'starting' && !session.ref)) {
      // A start the console lost track of, e.g. across a restart, may still have made a container.
      if (session.status === 'starting') await launcher.stop(launcher.refFor(session.id));
      update(session, { status: 'stopped', stoppedAt: nowIso(), stopReason: reason, stoppedBy: by });
      console.log('fleet: session stopped before it ran', { id: session.id, reason, by });
      return;
    }
    // One that stopped by itself (paused when idle or at its lifetime, or failed) waits on its person in Needs you;
    // a person stopping it says it waits on nobody, so it moves to Stopped. Resume still picks it up.
    if (session.status === 'stopped' || session.status === 'failed') {
      if (!by || session.stoppedBy) return;
      update(session, { stoppedBy: by });
      console.log('fleet: stopped session moved to Stopped', { id: session.id, by, stopReason: session.stopReason });
      return;
    }
    if (session.status === 'stopping' && handoffsInFlight.has(session.id)) {
      stopsAskedMidHandoff.set(session.id, { reason, by });
      console.log('fleet: stop asked during a hand-off, held until its push is done', { id: session.id, by });
      return;
    }
    if (session.status !== 'starting' && session.status !== 'running') return;
    update(session, { status: 'stopping', stoppingAt: nowIso(), stopReason: reason, stoppedBy: by });
    console.log('fleet: stopping session', { id: session.id, reason, by });
    stopsInFlight.add(session.id);
    try {
      await checkpointAndRemove(session, { requireCheckpoint });
    } finally {
      stopsInFlight.delete(session.id);
    }
    await startQueued();
  }

  async function checkpointAndRemove(session, { requireCheckpoint = false } = {}) {
    if (requireCheckpoint && !session.endpoint) {
      update(session, { status: 'running', stoppingAt: null, stopReason: null, stoppedBy: null });
      throw shown('the console cannot reach it to push its work: it keeps running');
    }
    if (session.endpoint) {
      try {
        const result = await statusd(session, 'POST', '/checkpoint', { timeoutMs: CHECKPOINT_TIMEOUT_MS, ...(requireCheckpoint ? { body: { keepRunningOnFailure: true } } : {}) });
        console.log('fleet: checkpoint pushed', { id: session.id, committed: result?.committed, head: result?.head });
      } catch (err) {
        if (requireCheckpoint) {
          // Its container and checkout stay: what it could not push is still there, and it runs on as it did.
          update(session, { status: 'running', stoppingAt: null, stopReason: null, stoppedBy: null });
          console.warn('fleet: checkpoint failed, the session keeps running', { id: session.id, message: firstLine(err) });
          throw shown(`its work could not be pushed (${statusdError(err)}): it keeps running, with its work in its checkout`);
        }
        console.warn('fleet: checkpoint failed, stopping anyway', { id: session.id, message: firstLine(err) });
      }
    }
    await launcher.stop(session.ref);
    update(session, { status: 'stopped', stoppedAt: nowIso(), endpoint: null, ...keptFields(session) });
  }

  // A shared session that ran keeps its conversation and databases once stopped, however it stopped. A QA or review
  // run is never resumed: the next commit gets a run of its own, so it ends when it stops, and the conversation its
  // stop saved is deleted on the next tick.
  function keptFields(session) {
    if (session.owner) return {};
    return isQa(session) || isReview(session) ? { homeDeletePending: Boolean(homes) } : { kept: true };
  }

  // A QA run that stopped before its stop deleted its conversation left it saved, with nothing to delete it: its
  // homeDeletePending was never set. Marked once, so the delete is tried as for any other. Its trigger names it too,
  // for a run whose qa or review fields are missing.
  function endedRunHome(session) {
    const run = isQa(session) || isReview(session) || session.trigger === 'qa' || session.trigger === 'review';
    if (session.owner || session.kept || session.homeDeletePending !== undefined || !run) return;
    if (ACTIVE_STATUSES.has(session.status) || session.status === 'stopping') return;
    update(session, { homeDeletePending: Boolean(homes) });
  }

  async function finishInterruptedStop(session) {
    console.log('fleet: finishing a stop the last run did not', { id: session.id });
    await launcher.stop(session.ref);
    update(session, { status: 'stopped', stoppedAt: nowIso(), endpoint: null, ...keptFields(session) });
  }

  async function containerGone(session) {
    // A tainted session's own output may hold what it saw: its log is never read into the console's.
    const tail = session.taintedAt ? '' : await launcher.logTail(session.ref);
    const reason = failureReason(tail) || 'container exited';
    const failed = session.status === 'starting';
    console.warn('fleet: container is gone', { id: session.id, failed, reason });
    await launcher.stop(session.ref);
    update(session, {
      status: failed ? 'failed' : 'stopped', stoppedAt: nowIso(), endpoint: null,
      stopReason: failed ? null : 'container exited', error: failed ? reason : null,
      ...(failed ? {} : keptFields(session)),
    });
    if (failed) await announceFailure(session);
  }

  // Only once the issue has been told the session started or queued: a first start that fails is
  // announced by startComment itself.
  async function announceFailure(session) {
    if (!session.commentId) return;
    const project = projectFor(config, session);
    const body = failedComment({ session, publicUrl: await consoleUrlOf(project), linkQuery: config.linkQuery, consoleName: config.consoleName, label: triggersOf(project).label });
    const posted = await safely('failure comment', () => githubOf(project).comment(session.number, body));
    if (posted && state.github) {
      state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
      store.save();
    }
  }

  // The console restarted while it waited for a starting task's address: the task came up, and with no ref nothing
  // read its status, so it sat on Starting until the start timeout stopped it.
  async function findLostStart(session) {
    if (session.status !== 'starting' || !launcher.find || launchesInFlight.has(session.id)) return;
    let found;
    try {
      found = await launcher.find(session.id);
    } catch (err) {
      // AWS failing here must not keep the tick from the start timeout, which ends a start that never comes back.
      console.warn('fleet: lost start not looked up', { id: session.id, message: firstLine(err) });
      return;
    }
    // Stopped while it looked, e.g. from the card's menu: that stop already removed the task by the session id.
    if (!found || session.status !== 'starting') return;
    const { ref, ...endpoint } = found;
    update(session, { ref, endpoint, startSteps: { machine: nowIso(), ...session.startSteps } });
    console.log('fleet: lost start found again', { id: session.id, seconds: secondsSince(session.startedAt) });
  }

  // Every checked task in one AWS call, not one each: each call is an AWS CLI process, and the console runs only a few at
  // once (MAX_CLI_PROCESSES in providers/aws/ecsLauncher.mjs), so one per session kept a save on My settings waiting its turn.
  async function taskStatesFor(sessions) {
    const refs = sessions.filter((s) => (s.status === 'starting' || s.status === 'running') && s.ref).map((s) => s.ref);
    if (!launcher.taskStates || !refs.length) return new Map();
    try {
      return await launcher.taskStates(refs);
    } catch (err) {
      console.warn('fleet: task states not read together, reading each', { count: refs.length, message: firstLine(err) });
      return new Map();
    }
  }

  async function refresh(session, taskStates) {
    if (!session.ref) await findLostStart(session);
    if (!session.ref) return;
    // A start found again this tick was not in the tick's read. The docker launcher has no pull to report.
    const task = taskStates?.get(session.ref)
      ?? (launcher.taskState ? await launcher.taskState(session.ref) : { alive: await launcher.isAlive(session.ref) });
    if (!task.alive) return containerGone(session);
    if (task.pullStartedAt) startStep(session, 'pullStarted', task.pullStartedAt);
    await readStatus(session);
  }

  /**
   * The repos besides its own a session may report a pull request on (claude's, opened from another clone:
   * session/openedPulls.mjs). The console reads each with that project's token and shows its title and state, so only a
   * private session's, on the repos its owner may start on, as New session and /api/pulls allow; a shared session,
   * review, QA run or question has none. Asked only when the status names another repo's.
   * @returns {Promise<string[]>}
   */
  const startableKept = new Map();
  async function reportableRepos(session, status) {
    if (!session.owner || !startableRepos || !Array.isArray(status.prUrls)) return [];
    const own = String(session.repo ?? '').toLowerCase();
    if (!status.prUrls.some((url) => { const repo = pullRepo(url); return repo && repo.toLowerCase() !== own; })) return [];
    // Kept a minute per owner: projectAccess keeps no failed write check, which would be asked again on every read.
    const kept = startableKept.get(session.owner);
    if (kept && now() - kept.at < STARTABLE_KEEP_MS) return kept.repos;
    try {
      const repos = (await startableRepos(session.owner)).filter((repo) => allProjects(config).some((p) => p.repo === repo));
      startableKept.set(session.owner, { at: now(), repos });
      return repos;
    } catch (err) {
      console.warn('fleet: the owner\'s projects not read, other repos\' pull requests left out', { id: session.id, message: firstLine(err) });
      return [];
    }
  }

  async function readStatus(session, timeoutMs = STATUS_TIMEOUT_MS) {
    if (readingStatus.has(session.id)) return;
    readingStatus.add(session.id);
    try {
      let status;
      try {
        status = await statusd(session, 'GET', '/status', { timeoutMs });
      } catch (err) {
        // statusd is the last thing a container starts, so a starting session has none yet.
        if (session.status === 'running') console.warn('fleet: status check failed', { id: session.id, message: firstLine(err) });
        else noteUnreached(session, firstLine(err));
        return;
      }
      const wasStarting = session.status === 'starting';
      const wasAsking = session.state === 'needs-you';
      update(session, statusUpdate(session, status, nowIso(), { repos: await reportableRepos(session, status) }));
      settleQuestion(session);
      // A message left in the box: sent or cleared in the TUI tab once the box is empty again.
      if (session.leftInBox && status.boxText === false) {
        update(session, { leftInBox: null });
        console.log('fleet: the agent\'s box is empty again, the message left in it sent or cleared', { id: session.id });
      }
      // Once each time it starts to ask: a session still asking on the next read is not told about again.
      if (!wasAsking && session.state === 'needs-you' && pings) await safely('assignee message', () => pings.needsYou(session));
      if (wasStarting) console.log('fleet: session running', { id: session.id, branch: session.branch, seconds: secondsSince(session.startedAt) });
      await deliverHeld(session);
      await announcePull(session);
    } finally {
      readingStatus.delete(session.id);
    }
  }

  // A shared session's pull request is posted to Slack once it passes; a My Woodshed session's is only watched, its
  // owner's work being their own, so its session hears each verdict and broken suite until it passes, with or without
  // Slack. A GitHub that cannot be read is tried again on the next tick. Each pull request a session reports is tracked
  // once, so a session that closes its pull request and opens another from a new branch gets the new one too.
  async function announcePull(session) {
    if (!session.prUrl || session.announcedPrUrl === session.prUrl) return;
    const project = projectFor(config, session);
    const watch = Boolean(session.owner);
    // A review-only session reads someone's pull request: it is never told to fix and push it.
    if (watch && session.reviewOnly) return;
    // An older image's statusd would type into the shell of an agent that exited: nothing is typed into it unasked.
    if (watch && !session.agentOnlySend) {
      if (!session.watchSkippedSaid) {
        console.log('fleet: pull request not watched, the session\'s image types into its pane unchecked', { id: session.id });
        update(session, { watchSkippedSaid: true });
      }
      return;
    }
    // Its pull request is read on its project's repo by number: one on another repo is not that one.
    if (watch && !onProjectRepo(session.prUrl, project)) {
      console.log('fleet: pull request on another repo than the session\'s project, not watched', { id: session.id, project: project.name });
      update(session, { announcedPrUrl: session.prUrl });
      return;
    }
    if (!watch && (!announcer.available || !announcer.postsFor(project))) return;
    const tracked = await safely('pull request read for Slack', async () => (await announcer.track(session, project, { watch })) !== 'later');
    if (tracked) update(session, { announcedPrUrl: session.prUrl });
  }

  /**
   * A start step, for the session page's checklist: one its entrypoint reported, or `pullStarted` from ECS. Only the
   * first of each counts, and only while the session starts.
   * @param {object} session
   * @param {string} step  one of START_STEPS, checked by the session API, or `pullStarted`
   * @param {string} [at]  when it happened, if not now: ECS's time, which the tick reads up to 10 s late
   */
  function startStep(session, step, at = nowIso()) {
    if (session.status !== 'starting' || session.startSteps?.[step]) return;
    update(session, { startSteps: { ...session.startSteps, [step]: at } });
    console.log('fleet: start step', { id: session.id, step, seconds: Math.round((Date.parse(at) - Date.parse(session.startedAt)) / 1000) });
  }

  /**
   * A start whose agent opened a while ago, and which the console has still not reached: its launcher has not answered
   * with the session's address (`address: false`, `launching` while its start call is still out), or statusd does not
   * answer there (`message`, the read's error). The page shows it as Connecting to the session and its clock, and a
   * person sees nothing else, so it is logged once each start.
   * @param {object} session
   * @param {string|null} [message]
   */
  function noteUnreached(session, message = null) {
    const opened = session.startSteps?.claude;
    if (session.status !== 'starting' || !opened || now() - Date.parse(opened) < UNREACHED_AFTER_MS) return;
    if (unreachedStarts.get(session.id) === session.startedAt) return;
    unreachedStarts.set(session.id, session.startedAt);
    console.warn('fleet: the agent is open but the console has not reached the session', {
      id: session.id, seconds: secondsSince(opened), address: Boolean(session.endpoint), launching: launchesInFlight.has(session.id), message,
    });
  }

  // Every couple of seconds, a starting session's statusd alone, so its page turns to the terminal as soon as claude
  // opens rather than on the next tick. Whether the task is alive is left to the tick: that is an aws call.
  async function checkStarting() {
    if (checkingStarts) return;
    checkingStarts = true;
    try {
      for (const session of state.sessions) if (session.status === 'starting' && !session.endpoint) noteUnreached(session);
      const starting = state.sessions.filter((s) => s.status === 'starting' && s.endpoint);
      await Promise.all(starting.map(async (session) => {
        try {
          await readStatus(session, STARTING_STATUS_TIMEOUT_MS);
        } catch (err) {
          console.error('fleet: session check failed', { id: session.id, message: firstLine(err) });
        }
      }));
    } finally {
      checkingStarts = false;
    }
  }

  // While a start waits for room (waitsForRetry), its launcher may say how the wait is going, as steps: an embedding
  // whose sessions wait for a machine being set up shows that setup on the session page. Read with the starting check,
  // and saved only when it changed.
  async function checkWaiting() {
    if (checkingWaits) return;
    checkingWaits = true;
    try {
      await Promise.all(state.sessions.map(readProgress));
    } finally {
      checkingWaits = false;
    }
  }

  async function readProgress(session) {
    if (!(session.status === 'queued' && waitsForRetry(session, now()))) {
      progressErrors.delete(session.id);
      if (session.waitProgress) update(session, { waitProgress: null });
      return;
    }
    if (!launcher.progress) return;
    let progress;
    try {
      progress = waitProgressFrom(await withinTime(launcher.progress(session.id), STATUS_TIMEOUT_MS));
    } catch (err) {
      const message = firstLine(err);
      if (progressErrors.get(session.id) !== message) console.warn('fleet: wait progress not read', { id: session.id, message });
      progressErrors.set(session.id, message);
      return;
    }
    progressErrors.delete(session.id);
    // Started, or stopped, while the launcher answered.
    if (!(session.status === 'queued' && waitsForRetry(session, now()))) return;
    if (JSON.stringify(progress) === JSON.stringify(session.waitProgress ?? null)) return;
    update(session, { waitProgress: progress });
    const steps = progress?.steps ?? [];
    console.log('fleet: wait progress', {
      id: session.id, steps: steps.length, done: steps.filter((s) => s.state === 'done').length, failed: steps.some((s) => s.state === 'failed'),
    });
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const taskStates = await taskStatesFor(state.sessions);
      for (const session of [...state.sessions]) {
        try {
          if (session.status === 'stopping' && !stopsInFlight.has(session.id)) await finishInterruptedStop(session);
          if (session.status !== 'starting' && session.status !== 'running') continue;
          await refresh(session, taskStates);
          const reason = stopReason(session, now(), limitsOf(session));
          if (reason) await stop(session, reason);
        } catch (err) {
          console.error('fleet: session check failed', { id: session.id, message: firstLine(err) });
        }
      }
      await startQueued();
      // Before retention, which can take an ended QA run off the list at once.
      for (const session of [...state.sessions]) await safely('QA run ended without a report', () => qaEndedUnreported(session));
      for (const session of [...state.sessions]) await safely('review ended without a report', () => reviewEndedUnreported(session));
      for (const session of [...state.sessions]) await safely('retention check', () => retain(session));
      await safely('ended pull request runs', () => pruneEndedRuns());
      for (const session of [...state.sessions]) await safely('tainted session removal', () => removeTainted(session));
      for (const session of [...state.sessions]) await safely('taint notice', () => tellTainted(session));
      await safely('tainted homes', () => retryTaintedHomes());
      await sweepDatabases();
      await announcer.check();
    } finally {
      ticking = false;
    }
  }

  // A session that ended without being kept (a failed first start, a private one, one cleaned up, one removed
  // from the list) is left out of this set, so its databases go on the next tick.
  async function sweepDatabases() {
    if (!databases?.available) return;
    try {
      await databases.sweep(keptIds(state.sessions));
    } catch (err) {
      console.error('fleet: database sweep failed', { message: firstLine(err) });
    }
  }

  // When a kept session goes, by the Console settings page's numbers as they are now: after its pull request merged
  // or closed, after it stopped with its pull request still open, or after it stopped with none.
  function keepRule(session) {
    const r = retention();
    if (session.prClosedAt) {
      return { from: Date.parse(session.prClosedAt), ms: r.afterCloseMs, why: `its pull request ${session.prMerged ? 'merged' : 'closed'} ${spanText(r.afterCloseMs)} ago` };
    }
    if (pullNumber(session.prUrl)) return { from: Date.parse(session.stoppedAt), ms: r.openPrMs, why: `stopped ${spanText(r.openPrMs)} ago with its pull request still open` };
    return { from: Date.parse(session.stoppedAt), ms: r.withoutPrMs, why: `stopped ${spanText(r.withoutPrMs)} ago with no pull request` };
  }

  async function retain(session) {
    endedRunHome(session);
    if (session.homeDeletePending) await deleteHome(session);
    if (isGone(session)) return dropIfDue(session);
    if (session.owner || !session.kept || ACTIVE_STATUSES.has(session.status)) return;
    const number = pullNumber(session.prUrl);
    if (number && !session.prClosedAt && now() - (prCheckedAt.get(session.id) ?? -Infinity) >= PR_STATE_CHECK_MS) {
      prCheckedAt.set(session.id, now());
      const pull = await githubOf(projectFor(config, session)).pull(number);
      if (pull.state === 'closed') {
        update(session, { prClosedAt: new Date(Date.parse(pull.closed_at) || now()).toISOString(), prMerged: Boolean(pull.merged_at) });
        console.log('fleet: a kept session\'s pull request closed', { id: session.id, number, merged: session.prMerged });
      }
    }
    const rule = keepRule(session);
    if (!Number.isFinite(rule.from)) return;
    const deletesAt = new Date(rule.from + rule.ms).toISOString();
    if (session.deletesAt !== deletesAt) update(session, { deletesAt });
    if (now() >= Date.parse(deletesAt)) await cleanUp(session, rule.why);
  }

  /**
   * A webhook said these pull requests changed: a waiting one is read at the next check, and a kept session's is
   * read for its retention at the next tick.
   * @param {number[]} numbers
   * @param {string|null} [projectName]  the project whose repo they are on: the default one when none is named
   * @returns {number[]}  the numbers either of them cares about
   */
  function pullsChanged(numbers, projectName = null) {
    const project = projectOfEvent(projectName);
    if (!project) return [];
    const marked = new Set(announcer.stale(numbers, project.default ? null : project.name));
    for (const session of state.sessions) {
      const number = pullNumber(session.prUrl);
      if (!number || !numbers.includes(number) || !onProject(session, project) || session.prClosedAt || !prCheckedAt.has(session.id)) continue;
      prCheckedAt.delete(session.id);
      marked.add(number);
    }
    for (const number of numbers) {
      if (pullRunsCheckedAt.delete(`${project.name}#${number}`)) marked.add(number);
    }
    return [...marked];
  }

  // Its databases go on the sweep after this; the branch stays on GitHub. A home that cannot be deleted now is
  // tried again on a later tick.
  async function cleanUp(session, why) {
    update(session, { kept: false, cleanedAt: nowIso(), deletesAt: null, homeDeletePending: Boolean(homes) });
    prCheckedAt.delete(session.id);
    console.log('fleet: kept session cleaned up', { id: session.id, why });
    await deleteHome(session);
  }

  async function deleteHome(session) {
    if (!homes) return update(session, { homeDeletePending: false });
    if (now() - (homeDeleteTriedAt.get(session.id) ?? -Infinity) < HOME_DELETE_RETRY_MS) return;
    homeDeleteTriedAt.set(session.id, now());
    try {
      await homes.remove(sharedHomeName(session.id));
    } catch (err) {
      console.warn('fleet: Claude home not deleted yet, tried again later', { id: session.id, message: firstLine(err) });
      return;
    }
    homeDeleteTriedAt.delete(session.id);
    update(session, { homeDeletePending: false });
  }

  // A shared session that ended keeping nothing: deleted, or one that never ran. Only its card is left.
  function isGone(session) {
    return !session.owner && !session.kept && !ACTIVE_STATUSES.has(session.status) && session.status !== 'stopping';
  }

  // Off the list once it has shown as Deleted for the Console settings page's number of days. A question waits until
  // its thread has been told it went unanswered, and a Claude home still being deleted until it is gone, since
  // nothing retries it once the session is off the list.
  // An ended review stays while the approval it holds for QA waits on its record (heldApproval), then as long as a
  // kept review lasted: its record is what tells reviewOnTag that its commit was reviewed.
  function dropIfDue(session) {
    if (session.homeDeletePending || (isAsk(session) && !session.noticedAt) || session.review?.held) return;
    const from = Date.parse(session.cleanedAt ?? session.stoppedAt ?? session.createdAt);
    const removeMs = retention().removeAfterDeleteMs ?? DEFAULT_RETENTION.removeAfterDeleteMs;
    const listed = isReview(session) ? removeMs + (retention().withoutPrMs ?? DEFAULT_RETENTION.withoutPrMs) : removeMs;
    // A QA run's recordings are watched as its session (qaRecordings.mjs): it stays listed as long as they are kept.
    const ms = isQa(session) && session.qa?.videos?.length ? Math.max(listed, QA_RECORDING_DAYS * 86_400_000) : listed;
    if (!Number.isFinite(from) || now() < from + ms) return;
    dropRecord(session, `deleted ${spanText(ms)} ago`);
  }

  // A review's or QA run's record is what the next run on its pull request reads: whether a commit was reviewed or
  // tested, the comment it writes over, the approval held for QA, the review's last posted verdict (approvalDismissed)
  // and the recordings a QA comment links. Each read takes the latest record that has it, and none is read once the pull request
  // merged or closed. Every run of every commit stayed listed until the delete timer (dropIfDue), weeks later, which
  // piled up hundreds of cards: the ones nothing reads go off the list as soon as they have ended.
  async function pruneEndedRuns() {
    const byPull = new Map();
    for (const session of state.sessions) {
      if (session.owner || !Number.isInteger(session.number) || !(isQa(session) || isReview(session))) continue;
      const key = `${projectFor(config, session).name}#${session.number}`;
      byPull.set(key, [...(byPull.get(key) ?? []), session]);
    }
    // A pull request whose runs all went off the list is not read again.
    for (const key of pullRunsCheckedAt.keys()) if (!byPull.has(key)) pullRunsCheckedAt.delete(key);
    for (const [key, runs] of byPull) {
      // Not yet settled: still going, or its end not yet told (qaEndedUnreported, reviewEndedUnreported), or a Claude
      // home still being deleted, which nothing retries once the record is gone.
      const settled = (s) => !ACTIVE_STATUSES.has(s.status) && s.status !== 'stopping' && !s.homeDeletePending
        && (isQa(s) ? Boolean(s.qa.conclusion || s.qa.endChecked) : Boolean(s.review.reported || s.review.endChecked));
      const watched = (s) => isQa(s) && s.qa.videos?.length && now() < Date.parse(s.stoppedAt ?? s.createdAt) + QA_RECORDING_DAYS * 86_400_000;
      const ended = runs.filter(settled);
      if (!ended.length) continue;
      const latest = (kind, has = () => true) => runs.filter((s) => (kind === 'qa' ? isQa(s) : isReview(s)) && has(s)).at(-1);
      // Each run writes over the QA comment, so only the last run's recordings are linked from it. A run that could
      // not edit it posted a comment of its own, which leaves the old one linking its run's recordings: the last
      // settled run of each comment is kept while its recordings are.
      const linked = latest('qa', settled);
      const comments = new Map();
      for (const s of runs) if (isQa(s) && settled(s) && s.qa.commentId) comments.set(s.qa.commentId, s);
      const linking = new Set([linked, ...comments.values()].filter((s) => s && watched(s)));
      if (ended.length === runs.length && await pullClosed(key, runs[0])) {
        for (const s of ended) if (!linking.has(s)) dropRecord(s, 'its pull request merged or closed');
        continue;
      }
      // The last settled run of each kind too, while a later one still runs: its result is the pull request's until then.
      const read = new Set([
        latest('qa'), linked, latest('qa', (s) => s.qa.commentId),
        latest('review', settled),
        latest('review'), latest('review', (s) => s.review.commentId),
        latest('review', (s) => s.review.conclusion && s.review.posted),
        ...runs.filter((s) => isReview(s) && s.review.held), ...linking,
      ]);
      for (const s of ended) if (!read.has(s)) dropRecord(s, 'a later run on its pull request replaced it');
    }
  }

  // Read at most every PR_STATE_CHECK_MS for each pull request with ended runs, and at the next tick after a webhook
  // said it changed (pullsChanged).
  async function pullClosed(key, session) {
    if (now() - (pullRunsCheckedAt.get(key) ?? -Infinity) < PR_STATE_CHECK_MS) return false;
    pullRunsCheckedAt.set(key, now());
    const pull = await safely('pull request of ended runs', () => githubOf(projectFor(config, session)).pull(session.number));
    return pull?.state === 'closed';
  }

  function dropRecord(session, why) {
    state.sessions = state.sessions.filter((s) => s !== session);
    prCheckedAt.delete(session.id);
    store.save();
    console.log('fleet: deleted session taken off the list', { id: session.id, why });
  }

  /**
   * Remove, on a shared session already deleted: its card goes from the list for everyone. Its branch and pull
   * request stay on GitHub.
   * @param {object} session
   * @param {string} by
   */
  function removeShared(session, by) {
    if (session.owner) throw shown('a My Woodshed session is removed from My Woodshed');
    if (!isGone(session)) throw shown('only a session whose conversation and databases are deleted can be removed: delete it first');
    if (session.homeDeletePending) throw shown('its saved conversation is still being deleted: try again in a minute');
    dropRecord(session, `removed from the console by @${by}`);
  }

  /**
   * A session stuck starting or stopping, from the Console settings page: its task is stopped and it is marked
   * stopped, keeping what it has, without the checkpoint a stop would wait on.
   * @param {object} session
   * @param {string} by
   */
  async function forceStop(session, by) {
    if (session.status !== 'starting' && session.status !== 'stopping') throw shown('only a session stuck starting or stopping is stopped from here');
    console.log('fleet: stuck session stopped', { id: session.id, status: session.status, by });
    await launcher.stop(session.ref ?? launcher.refFor(session.id));
    stopsInFlight.delete(session.id);
    update(session, {
      status: 'stopped', stoppedAt: nowIso(), endpoint: null, stopReason: session.stopReason ?? `stuck ${session.status}, stopped by @${by}`,
      ...(session.startedAt && !session.owner ? keptFields(session) : {}),
    });
    return session;
  }

  /**
   * Resume on a stopped shared session: the same session runs again, with its page, branch and databases, and
   * claude reopens its conversation from the Claude home it saved. `text`, when given, is typed in once claude is
   * open. Without a saved conversation claude starts on the session's own prompt, as a new session would.
   * @param {object} session
   * @param {{text?: string, by: string, why: string}} args
   */
  async function resumeShared(session, { text = '', by, why }) {
    if (session.owner) throw shown('a My Woodshed session is resumed from My Woodshed');
    if (ACTIVE_STATUSES.has(session.status)) throw shown('that session is still running');
    if (!session.kept) throw shown(`its conversation and databases are deleted: comment /woodshed on ${session.kind === 'pr' ? 'PR ' : ''}#${session.number} to start a new session on its branch`);
    const message = String(text ?? '').trim();
    update(session, {
      status: 'queued', state: null, startedAt: null, stoppedAt: null, stopReason: null, stoppedBy: null, error: null, ref: null, endpoint: null,
      startSteps: null, token: newSessionToken(), terminalToken: newSessionToken(), resumeClaude: session.claudeSession ?? null,
      pendingMessages: message ? [...session.pendingMessages, message] : session.pendingMessages,
      lastActiveAt: null, checkedAt: null, app: null, appServers: null, appName: null, apps: null,
      prClosedAt: null, prMerged: null, deletesAt: null, resumedAt: nowIso(), resumedBy: by,
    });
    prCheckedAt.delete(session.id);
    console.log('fleet: resuming a shared session', { id: session.id, by, why, claudeSession: Boolean(session.resumeClaude), message: Boolean(message) });
    await startQueued();
    return session;
  }

  /**
   * Delete now, on a shared session (a running one is stopped first): its conversation and databases go at once, rather than days after
   * its pull request closed.
   * @param {object} session
   * @param {string} by
   */
  async function deleteShared(session, by) {
    if (session.owner) throw shown('a My Woodshed session keeps nothing of its own to delete');
    const wasActive = ACTIVE_STATUSES.has(session.status);
    await stopForRemoval(session, `deleted from the console by @${by}`);
    // A session stopped before it ran kept nothing, so there is nothing left to clean up.
    if (!session.kept && wasActive) return session;
    if (!session.kept) throw shown('its conversation and databases are already deleted');
    await cleanUp(session, `deleted from the console by @${by}`);
    return session;
  }

  // The announcer says a pull request stopped waiting. Once one is in Slack and none of the session's others is
  // still waiting, its work is done: it stops, keeping what it has, and shows as finished. Only a post stops it: a
  // pull request that closed or gave up may be about to be replaced by one statusd has not reported yet.
  async function prDropped(item, why) {
    const session = find(item.sessionId);
    if (!session || why !== 'posted') return;
    // Where the post is stays with it, so its thread is found again after the project's channel changes.
    update(session, { slackPostedAt: nowIso(), ...(item.post ? { slackPost: item.post } : {}) });
    if (announcer.waitingSessions().has(session.id)) {
      console.log('fleet: session kept, another pull request is still waiting', { id: session.id, number: item.number });
      return;
    }
    if (session.status === 'queued' || session.status === 'starting' || session.status === 'running') await stop(session, 'posted to Slack');
  }

  // The announcer gave up on a pull request: its assignee hears it, besides the GitHub comment the announcer leaves.
  async function prGaveUp(item, pull) {
    const session = find(item.sessionId);
    if (session && pings) await safely('assignee message', () => pings.gaveUp(session, pull));
  }

  // The assignee is tagged in the thread of the pull request's post, by the rules of their messages.
  function prMention(item) {
    const session = find(item.sessionId);
    return session && pings ? pings.mentionFor(session) : null;
  }

  // Whether a watched pull request's session (a My Woodshed one) can still hear about it: only while it runs, since
  // nothing but its owner resumes it. A stopping one cannot: a message held for it would be typed in at a later Resume.
  const ownListening = (session) => Boolean(session && ACTIVE_STATUSES.has(session.status) && session.status !== 'stopping');
  // It listens only for the pull request it reports now, on the item's repo: while it reports another or none (or
  // statusd's lookup failed), the watch waits for it to be back.
  function prListening(item) {
    const session = find(item.sessionId);
    if (!ownListening(session)) return 'ended';
    const project = item.project ? projectNamed(config, item.project) : defaultProject(config);
    // Its project left the console, or its repo is another now (a default project replaced): its pull request is no
    // longer that project's.
    if (!project || (item.repo && item.repo.toLowerCase() !== String(project.repo ?? '').toLowerCase())) return 'ended';
    const current = session.reportedPrUrl === undefined ? session.prUrl : session.reportedPrUrl;
    return pullNumber(current) === item.number && onProjectRepo(current, project) ? 'yes' : 'elsewhere';
  }

  // Whether a pull request URL is the item's pull request, on its project's repo.
  function samePull(prUrl, item) {
    const project = item.project ? projectNamed(config, item.project) : defaultProject(config);
    return pullNumber(prUrl) === item.number && onProjectRepo(prUrl, project);
  }

  // Whether a pull request URL is on a project's repo.
  function onProjectRepo(prUrl, project) {
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/i.exec(prUrl ?? '')?.[1];
    return Boolean(repo && project?.repo && repo.toLowerCase() === project.repo.toLowerCase());
  }

  // A review asking for changes, an approval's notes, or a suite that failed or was skipped: typed into the session,
  // or resumed with it (a shared one: a stopped My Woodshed session is not). True when the session was told.
  async function prFeedback(item, text, { stillWanted = async () => true, sha = null, untilMs = () => Infinity } = {}) {
    const session = find(item.sessionId);
    if (!session) return false;
    // A My Woodshed session is typed into now or told again at the next check, never held: a held message would be
    // typed in at a later Resume, after its watch ended.
    if (session.owner) {
      if (!ownListening(session)) {
        console.log('fleet: review feedback dropped, the My Woodshed session is not running', { id: session.id, number: item.number });
        return false;
      }
      if (!canType(session)) return 'later';
      try {
        // claude may have closed since the last status read, and the pane would then be a shell that runs the text:
        // its state is read again just before.
        const fresh = await statusd(session, 'GET', '/status');
        // The session may have started stopping, or the watch ended or been renewed, while statusd answered.
        if (!ownListening(session) || !(await stillWanted()) || !ownListening(session)) return 'later';
        if (!fresh?.state || fresh.state === 'not-running' || fresh.state === 'starting' || fresh.agentOnlySend !== true) return 'later';
        // And it must still be on this pull request.
        if ('prUrl' in fresh && !samePull(fresh.prUrl, item)) return 'later';
        // statusd checks the pane once more as it types (`agentOnly`, a 409 otherwise; an older statusd ignores it).
        // With the pull request it is about, which statusd checks afresh on the branch checked out, just before typing.
        const project = item.project ? projectNamed(config, item.project) : defaultProject(config);
        // statusd reads GitHub before typing: it may take a while, and types only within withinMs of getting it, while
        // the console still waits, so a reply the console gave up on never types a text it then sends again.
        // Never past the watch's own end: what is left of its wait, if that is shorter.
        const withinMs = Math.floor(Math.min(GUARDED_SEND_WITHIN_MS, untilMs()));
        if (withinMs < 1000) return 'later';
        await statusd(session, 'POST', '/send', {
          // notAfter as well: withinMs counts from statusd getting it, and time in transit must count too.
          body: { text, agentOnly: true, prUrl: `https://github.com/${project.repo}/pull/${item.number}`, ...(sha ? { headSha: sha } : {}), withinMs, notAfter: now() + withinMs },
          timeoutMs: withinMs + 10_000,
        });
      } catch (err) {
        // Once until it is typed in: it is tried every minute while the session refuses it.
        if (!untypedSaid.has(session.id)) console.warn('fleet: review feedback not typed in yet', { id: session.id, number: item.number, message: firstLine(err) });
        untypedSaid.add(session.id);
        return 'later';
      }
      untypedSaid.delete(session.id);
      console.log('fleet: review feedback typed in', { id: session.id, number: item.number, outcome: 'sent', owner: true });
      return true;
    }
    if (ACTIVE_STATUSES.has(session.status)) {
      const outcome = await send(session, text);
      console.log('fleet: review feedback typed in', { id: session.id, number: item.number, outcome });
      return true;
    }
    if (!session.kept) {
      console.log('fleet: review feedback dropped, the session is deleted', { id: session.id, number: item.number });
      return false;
    }
    await resumeShared(session, { text, by: 'woodshed', why: 'review feedback' });
    return true;
  }

  // Only for what is best effort: a reaction or a comment that fails must not undo a session.
  async function safely(what, fn) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`fleet: ${what} failed`, { message: firstLine(err) });
      return null;
    }
  }

  /**
   * A shared session's assignee: the member who has it. Anyone who can be assigned may take an unassigned one, hand one
   * over to another, or unassign it, so work does not wait on someone who is away.
   * @param {{id: string, by: string, to: string|null}} args  `to` is the handle of someone who can be assigned, or null to unassign
   */
  function assign({ id, by, to }) {
    const session = find(id);
    if (!session || session.owner) throw shown('no shared session with that id');
    if (session.kind === 'ask') throw shown('a question from Slack has nobody to assign');
    if (isQa(session) || isReview(session)) throw shown('a review or QA run has nobody to assign: it runs by itself and ends');
    if (!members?.isAssignable(by)) throw shown('only someone who can be assigned sessions can assign one');
    const target = to ? findLogin(members.assignables(), to) : null;
    if (to && !target) throw shown(`@${to} cannot be assigned sessions`);
    const from = session.assignee ?? null;
    if ((from === null && target === null) || sameLogin(from, target)) return session;
    const how = !target ? 'unassign' : sameLogin(target, by) && !from ? 'take it' : 'hand over';
    update(session, target
      ? { assignee: target, assignedBy: by, assignedHow: how, assignedAt: nowIso() }
      : { assignee: null, assignedBy: by, assignedHow: how, assignedAt: nowIso() });
    console.log('fleet: session assigned', { id, from, to: target, by, how });
    mirrorAssignee(session);
    return session;
  }

  // Sessions of someone who can no longer be assigned, or left the console, go back to Unassigned, where anyone who can
  // be assigned sees them and can take them.
  function releaseAssignments({ login, by }) {
    const held = state.sessions.filter((s) => !s.owner && s.assignee && sameLogin(s.assignee, login));
    for (const s of held) {
      update(s, { assignee: null, assignedBy: by, assignedHow: 'unassign', assignedAt: nowIso() });
      mirrorAssignee(s);
    }
    if (held.length) console.log('fleet: assignments released', { login, by, sessions: held.length });
    return held.length;
  }

  // The spelling the members list has, so one person is spelled one way on every session.
  function assignableSpelling(login) {
    return findLogin(members?.assignables() ?? [], login) ?? login;
  }

  // Someone who can be assigned and speaks up on a session nobody has takes it. Whoever has it keeps it: a later
  // comment only talks.
  function takeIfUnassigned(session, login, how) {
    if (!session || session.owner || session.kind === 'ask' || session.assignee || !members?.isAssignable(login)) return;
    const spelled = assignableSpelling(login);
    update(session, { assignee: spelled, assignedBy: spelled, assignedHow: how, assignedAt: nowIso() });
    console.log('fleet: session assigned', { id: session.id, from: null, to: spelled, by: spelled, how });
    mirrorAssignee(session);
  }

  // The issue's assignee follows the session's, in the background: assigning answers the page at once, and a GitHub
  // refusal only logs. One change at a time per session, so a quick take and hand over land in order.
  const assigneeSyncs = new Map();
  function mirrorAssignee(session) {
    if (session.kind !== 'issue' || session.owner) return Promise.resolve();
    const run = (assigneeSyncs.get(session.id) ?? Promise.resolve()).then(() => safely('issue assignee', async () => {
      const githubAssignee = await issueTrackingOf(projectFor(config, session)).syncAssignee({ number: session.number, to: session.assignee ?? null, added: session.githubAssignee ?? null });
      update(session, { githubAssignee });
    }));
    assigneeSyncs.set(session.id, run);
    return run;
  }

  async function startFromGitHub({ number, login, trigger, text, commentId, title, kind, resumeBranch, announce = true, project = defaultProject(config) }) {
    const gh = githubOf(project);
    let target = { title, kind };
    if (!title) {
      const issue = await gh.issue(number);
      target = { title: issue.title, kind: issue.pull_request ? 'pr' : 'issue' };
    }
    const branch = target.kind === 'pr' ? (await gh.pull(number)).head.ref : resumeBranch;
    // Whoever tags the ticket or comments /woodshed has the session, when they can be assigned. Anyone else leaves it
    // unassigned, for someone who can to take.
    const assignTo = members?.isAssignable(login) ? { login: assignableSpelling(login), how: trigger } : null;
    if (!assignTo) console.log('fleet: session starts unassigned, its starter cannot be assigned', { number, login, trigger });
    const session = await createSession({
      kind: target.kind, number, title: target.title, startedBy: login, trigger, prompt: text, branch, assignTo, project,
    });
    if (session.kind === 'issue') {
      await safely('issue in progress', () => issueTrackingOf(project).markInProgress(number));
      if (session.assignee) await mirrorAssignee(session);
    }
    if (!announce) return session;
    await safely('reaction', () => (commentId ? gh.reactToComment(commentId) : gh.reactToIssue(number)));
    const publicUrl = await consoleUrlOf(project);
    const posted = await safely('start comment', () => gh.comment(number, startComment({
      session, publicUrl, maxRunning: config.maxRunning, appDomain: config.appDomain, linkQuery: config.linkQuery, consoleName: config.consoleName,
      label: triggersOf(project).label,
    })));
    if (posted) {
      update(session, { commentId: posted });
      if (state.github) state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
      store.save();
    }
    return session;
  }

  /**
   * A session started from the console's API, by whoever is signed in (server.mjs), with nothing posted to GitHub.
   * It always runs on the team key: its starter is not one GitHub vouched for.
   *
   * @param {{number: number, startedBy: string, prompt?: string}} args
   */
  async function startManual({ number, startedBy, prompt = '' }) {
    const route = routeTrigger({ sessions: state.sessions, number, trigger: 'label' });
    if (route.action === 'ignore') throw new Error(`#${number} ${route.reason}`);
    if (route.action === 'resume') return resumeShared(find(route.sessionId), { text: prompt, by: startedBy, why: 'console' });
    return startFromGitHub({ number, login: startedBy, trigger: 'console', text: prompt, resumeBranch: route.resumeBranch, announce: false });
  }

  async function targetFor(on, project = defaultProject(config)) {
    if (on.kind === 'task') return { kind: 'task', number: null, title: '', branch: null };
    if (on.kind === 'branch') return { kind: 'task', number: null, title: '', branch: on.branch };
    const repoGitHub = githubOf(project);
    let issue;
    try {
      issue = await repoGitHub.issue(on.number);
    } catch (err) {
      if (/HTTP 404/.test(`${err?.stderr ?? ''}${err?.message ?? ''}`)) throw shown(`#${on.number} is no issue or pull request on ${project.repo}`);
      throw err;
    }
    const isPr = Boolean(issue?.pull_request);
    if (on.pr && !isPr) throw shown(`#${on.number} is an issue, not a pull request`);
    if (!isPr) return { kind: 'issue', number: on.number, title: issue.title, branch: null };
    const pull = await repoGitHub.pull(on.number);
    // A merged or closed pull request's branch is often deleted, and the session's checkout of it then fails after it
    // waited for a machine. Refused here instead, naming the repo: a number looked up on the wrong project reads as one.
    if (pull.state === 'closed') {
      throw shown(`#${on.number} on ${project.repo} was ${pull.merged_at ? 'merged' : 'closed'}: start on an open pull request, or on its branch`);
    }
    return { kind: 'pr', number: on.number, title: issue.title, branch: pull.head.ref };
  }

  // The GitHub client of a project's repo: the fleet's own for the default project.
  function githubOf(project) {
    return project.default ? github : (githubFor?.(project) ?? github);
  }

  // The project a GitHub event is about: the default one when it names none (the poll's, and every event from before
  // projects), null when it names one the installation no longer has.
  function projectOfEvent(name) {
    return name ? projectNamed(config, name) : defaultProject(config);
  }

  function onProject(session, project) {
    return projectFor(config, session).name === project.name;
  }

  // An issue's assignee and board status, kept on the repo the issue is on.
  function issueTrackingOf(project) {
    if (project.default) return issueTracking;
    const key = `${project.name}\n${project.repo}`;
    if (!issueTrackings.has(key)) issueTrackings.set(key, createIssueTracking({ github: githubOf(project) }));
    return issueTrackings.get(key);
  }

  // What a log line adds for another project's session or event: nothing for the default project's, as before projects.
  function projectField(project) {
    return project.default ? {} : { project: project.name };
  }

  // The console's address for a comment on a project's repo, as that repo's project file says (commentConsoleUrl).
  async function consoleUrlOf(project) {
    const links = await consoleLinks(project.name);
    const url = commentConsoleUrl({ publicUrl: config.publicUrl, project, consoleLinks: links });
    if (!url) console.log('fleet: comment names no console address', { ...projectField(project), why: links === false ? 'consoleLinks' : 'project file not read' });
    return url;
  }

  /**
   * The idle pause and lifetime a session runs on: the console's, then its owner's own from My settings for a private
   * session, then the session's own, set on its page.
   */
  function limitsOf(session) {
    const own = session.owner ? userSettings?.limitsFor(session.owner) : null;
    return withSessionLimits(own ? { ...config.limits, ...own } : config.limits, session.limits);
  }

  /** @returns {{at: string, why: 'idle'|'lifetime'}|null}  when a running session pauses or stops by itself */
  function pauseOf(session) {
    const end = pauseAt(session, limitsOf(session));
    return end ? { at: new Date(end.at).toISOString(), why: end.why } : null;
  }

  /**
   * Whose call when a session pauses and stops: a private session's owner (nobody else can open it), and a shared
   * session's assignee alone, since it is their work the change holds open or cuts short. An unassigned one is taken
   * first.
   */
  function refuseUnlessLimitsAreTheirs(session, by) {
    if (session.owner) return;
    if (sameLogin(session.assignee, by)) return;
    throw Object.assign(shown(session.assignee
      ? `only ${session.assignee}, who has this session, can change when it pauses or stops`
      : 'nobody has this session: take it to change when it pauses or stops'), { forbidden: true });
  }

  /**
   * Extend: the session's pause or stop, whichever comes first, an hour later than it would be, in its last 15 minutes.
   */
  function extend(session, by) {
    if (session.status !== 'running') throw shown('only a running session can be extended');
    if (isAsk(session)) throw shown('a question from Slack cannot be extended');
    refuseUnlessLimitsAreTheirs(session, by);
    const end = pauseAt(session, limitsOf(session));
    if (!end) throw shown('this session has no pause to put off yet');
    // Only in the last 15 minutes, as the page offers it: an Extend is a person there to say so, not a way round the
    // limits, which the session's own Pause and stop sets.
    if (end.at - now() > EXTEND_WINDOW_MS) throw shown(`Extend is offered in the last ${spanText(EXTEND_WINDOW_MS)} before it ${end.why === 'lifetime' ? 'stops' : 'pauses'}`);
    const until = new Date(Math.max(end.at, now()) + EXTEND_MS).toISOString();
    update(session, { extendedUntil: until, extendedAt: nowIso() });
    console.log('fleet: session extended', { id: session.id, by, why: end.why, until });
    return session;
  }

  /**
   * A session's own pause and stop, in place of its owner's or the console's: `{idleHours, lifetimeHours}` in Console
   * settings' ranges, a key left out or empty going back to what it would run on otherwise.
   */
  function setLimits(session, values, by) {
    if (isAsk(session)) throw shown('a question from Slack runs on the console\'s limits for questions');
    refuseUnlessLimitsAreTheirs(session, by);
    const limits = checkLimits(values);
    update(session, { limits: Object.keys(limits).length ? limits : null });
    console.log('fleet: session limits changed', { id: session.id, by, ...limits });
    return session;
  }

  /**
   * Puts one of a person's private sessions under another of theirs on the rail, as a piece of its work, or with `under`
   * null takes it out of its group (railGroups in public/common.js, which nests by `startedFrom`). The session that
   * now has it lists it with woodshed-session list (sessionStarts.mjs), and its questions go there. Never under itself,
   * one in its own group, a session not running, or someone else's.
   * @param {object} session
   * @param {object|null} under
   */
  function regroup(session, under) {
    if (!session.owner) throw shown('only a My Woodshed session is in a group');
    if (!under) {
      if (!session.startedFrom || session.startedApart) return session;
      console.log('fleet: session taken out of its group', { id: session.id, from: session.startedFrom });
      update(session, { startedApart: true });
      return session;
    }
    if (under.id === session.id) throw shown('a session cannot be put under itself');
    if (under.owner !== session.owner) throw shown('only under another of your own sessions');
    if (!ACTIVE_STATUSES.has(under.status)) throw shown(`"${under.title}" is not running: a group is shown only under a running session`);
    // Not under a session in its own group, which would make a loop.
    // The whole chain, however long, each session once: one already seen is a loop the rail nests none of.
    const seen = new Set();
    for (let p = under; p?.startedFrom && !p.startedApart && !seen.has(p.id); p = find(p.startedFrom)) {
      if (p.startedFrom === session.id) throw shown(`"${under.title}" is in this session's own group`);
      seen.add(p.id);
    }
    if (session.startedFrom === under.id && !session.startedApart) return session;
    console.log('fleet: session put under another', { id: session.id, under: under.id, from: session.startedFrom ?? null });
    delete session.startedApart;
    update(session, { startedFrom: under.id });
    return session;
  }

  /**
   * A new name for a session, the one every page shows. A shared session's is everyone's, as its title is.
   * @param {object} session
   * @param {string} title
   */
  function rename(session, title) {
    const next = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
    if (!next) throw shown('a name cannot be empty');
    console.log('fleet: session renamed', { id: session.id, chars: next.length });
    update(session, { title: next });
    return session;
  }

  /**
   * Another agent started in a private session beside its own (session/agents.mjs), recorded once the session started
   * it: a Codex one may then use the team's key (openaiProxy.mjs) and send its refreshed sign-in back at the stop
   * (sessionApi.mjs POST /codex-auth), as a Codex session does.
   * @param {object} session
   * @param {'claude'|'codex'} agent
   * @returns {boolean}  whether it was allowed now, rather than before
   */
  function allowAgent(session, agent) {
    if ((session.extraAgents ?? []).includes(agent)) return false;
    console.log('fleet: another agent allowed in the session', { id: session.id, agent });
    update(session, { extraAgents: [...(session.extraAgents ?? []), agent] });
    return true;
  }


  /**
   * New session on My Woodshed: a session private to `owner`, on their own Claude token. The console posts no comment
   * or reaction; the session itself still pushes its branch and opens a PR, as any session does.
   * @param {{owner: string, prompt: string, name?: string, workOn?: string, model?: string, effort?: string,
   *          permissionMode?: string, background?: boolean}} args  `workOn` is the form's optional issue, pull request or branch
   */
  async function startPrivate({ owner, prompt, name = '', workOn = '', attachmentIds = [], files = [], background = false, project = defaultProject(config), herdrParent = false, startedFrom = null, startedApart = false, ...picked }) {
    refuseWithoutRepo(project, { kind: 'task', trigger: 'my-woodshed' });
    const on = parseWorkOn(workOn, { defaultBranch: await githubOf(project).defaultBranch?.() ?? null });
    const reviewOnly = !String(prompt ?? '').trim() && on.kind !== 'task';
    const text = String(prompt ?? '').trim();
    const agentName = picked.agent === 'claude' || !picked.agent ? 'Claude' : agents.agent(picked.agent).product;
    if (!text && !reviewOnly) throw shown(`say what ${agentName} should do`);
    const options = sessionOptions(picked);
    logIfInLine(owner);
    const target = await targetFor(on, project);
    if (reviewOnly && target.kind === 'issue') throw shown(`say what ${agentName} should do`);
    if (reviewOnly) console.log('fleet: private session starts as a review, no prompt given', { owner, on: on.kind });
    // With no prompt there is nothing for Haiku to name from, so a branch is named for itself.
    const given = String(name ?? '').trim().slice(0, TITLE_CHARS) || target.title || (reviewOnly ? `Review ${target.branch}` : '');
    // With no namer the first line stays, and the page offers the rename all the same.
    const naming = given ? null : (autoName?.(text) ?? Promise.resolve(null));
    // The files the person attached, then any the console made for it (a hand-off's conversation).
    const attach = attachments && (attachmentIds?.length || files.length) ? async (sessionId) => {
      const claimed = attachmentIds?.length ? await attachments.claim({ login: owner, ids: attachmentIds, sessionId }) : 0;
      return claimed + (files.length ? await attachments.put({ sessionId, files, after: claimed }) : 0);
    } : null;
    const session = await createSession({
      ...target, title: given || titleFrom(text), startedBy: owner, owner, trigger: 'my-woodshed', prompt: text, options, attach, background, reviewOnly, project,
      herdrParent, startedFrom, startedApart,
    });
    if (naming) renameWhenNamed(session, naming);
    return session;
  }

  /**
   * Hand off, on a running private session: its work goes on in a new private session of the same owner, on the same
   * branch, run by the agent picked (handoff.mjs). Its conversation is read first, while it runs; then it stops, which
   * commits and pushes its work as any stop does; then the new one starts on the branch with the conversation attached
   * and a prompt that says where it came from. The old one stays on the list, stopped, and Resume picks it up as ever.
   * @param {{owner: string, id: string, conversation?: boolean, note?: string, project?: object, agent?: string,
   *   model?: string, effort?: string, permissionMode?: string}} args  conversation: whether it goes across
   * @returns {Promise<object>}  the new session
   */
  async function handOffPrivate({ owner, id, conversation = true, note = '', project: given = null, ...picked }) {
    const from = find(id);
    if (!from || from.owner !== owner) throw shown('no session you can open with that id');
    // Nothing a tainted session holds is copied anywhere that outlives it (CLAUDE.md, "Production data").
    // Its lockdown under way counts as seen: the call that started it may be answering with production data now.
    if (isLocked(from)) throw shown('it has seen production data: nothing it holds goes to another session');
    if (handoffsInFlight.has(id)) throw shown('it is being handed off already');
    if (from.status !== 'running' || !from.endpoint) throw shown('only a running session can be handed off: resume it first');
    if (!from.branch) throw shown('it has no branch to hand off');
    const text = handoffNote(note);
    const sourceAgent = agents.agentOfSession(from);
    // The new agent's loosest mode that lets it do no more unasked than the old one could, as a session started from
    // another gets (shared/agents.cjs, modeForStartedSession), unless the person picked one.
    const carried = picked.permissionMode || agents.modeForStartedSession(sourceAgent, from.options?.permissionMode || 'auto', picked.agent || 'claude');
    const options = sessionOptions({ ...picked, permissionMode: carried });
    const source = { id, title: from.title, agent: sourceAgent, branch: from.branch };
    const project = given ?? projectFor(config, from);
    // The branch the new session starts on is checked as its start would, before anything stops: the agent may have
    // checked out the default branch, or a pull request's branch may have a name a session cannot take.
    const workOn = parseWorkOn(from.branch, { defaultBranch: await githubOf(project).defaultBranch?.() ?? null });
    if (workOn.kind !== 'branch' || workOn.branch !== from.branch) throw shown(`${from.branch} is not a branch name a session can work on`);
    // Taken before anything is awaited after the checks above, so a lockdown that starts from here on is refused (taint).
    if (isLocked(from) || handoffsInFlight.has(id)) throw shown('it has seen production data, or is being handed off already');
    handoffsInFlight.add(id);
    try {
      let entries = [];
      if (conversation) {
        try {
          const read = await statusd(from, 'GET', '/transcript', { timeoutMs: HANDOFF_READ_TIMEOUT_MS });
          entries = Array.isArray(read?.entries) ? read.entries : [];
        } catch (err) {
          console.warn('fleet: hand-off refused, the conversation not read', { id, message: firstLine(err) });
          throw shown('its conversation could not be read: try again, or hand off without it');
        }
      }
      // A lockdown that won the race before the hand-off was taken: nothing read from it goes anywhere.
      if (isLocked(from)) throw shown('it has seen production data: nothing it holds goes to another session');
      // A Stop pressed during the read is an ordinary stop, which removes the checkout even when its push is refused.
      // Stopped or still stopping, the hand-off's own stop would find nothing left to push, and the new session would
      // start from the branch's old remote commit: the case requireCheckpoint is there to prevent.
      if (from.status !== 'running') throw shown('it was stopped meanwhile: nothing was handed off');
      // Stopped only once its work is pushed: a push refused (a branch moved on remotely) leaves it running, its work
      // in its checkout, and nothing handed off.
      try {
        await stop(from, `handed off to ${agents.agent(options.agent).product}`, { by: owner, requireCheckpoint: true });
      } catch (err) {
        // Someone pressed Stop meanwhile: it runs on only because the hand-off failed, so their stop goes ahead.
        const asked = stopsAskedMidHandoff.get(id);
        if (asked) {
          stopsAskedMidHandoff.delete(id);
          handoffsInFlight.delete(id);
          await stop(from, asked.reason, { by: asked.by });
          throw shown(`${err.message.replace(/: it keeps running.*$/, '')}: it was stopped, as asked meanwhile`);
        }
        throw err;
      }
      if (from.status !== 'stopped') throw shown('it did not stop: try again in a moment');
      const files = conversation ? [{ name: HANDOFF_FILE, text: handoffDocument({ from: source, to: options, entries, at: nowIso() }) }] : [];
      let next;
      try {
        next = await startPrivate({
          owner, prompt: handoffPrompt({ from: source, to: options, note: text, conversation }), name: from.title, workOn: from.branch,
          files, background: true, project, ...options,
        });
      } catch (err) {
        console.warn('fleet: hand-off stopped the session, the new one did not start', { id, agent: options.agent, message: firstLine(err) });
        throw shown(`it stopped with its work pushed, but the new session did not start (${err.message}): Resume picks it up again`);
      }
      update(from, { handedOffTo: next.id });
      update(next, { handedOffFrom: id });
      console.log('fleet: session handed off', {
        id, to: next.id, owner, from: source.agent, agent: options.agent, model: options.model || null, conversation, entries: entries.length, note: Boolean(text),
      });
      return next;
    } finally {
      handoffsInFlight.delete(id);
      stopsAskedMidHandoff.delete(id);
    }
  }

  // At the limit a private session waits in its owner's own line, and starts when one of their tasks stops.
  function logIfInLine(owner) {
    const running = activePrivateCount(state.sessions, owner);
    if (running < config.maxPrivatePerPerson) return;
    // Called before the new or resumed session joins the line, so it is not among those counted.
    const ahead = state.sessions.filter((s) => s.owner === owner && s.status === 'queued' && !waitsForRetry(s, now())).length;
    console.log('fleet: private session waits in line, at the limit', { owner, running, limit: config.maxPrivatePerPerson, ahead });
  }

  // The session starts on its prompt's first line, and the rail shows Haiku's name on its next poll. A name the person
  // gave it on the rail meanwhile is theirs to keep. `namedAt` says the naming is over, named or not: the session's page
  // then offers a rename for a few seconds, since New session asks for no name.
  function renameWhenNamed(session, naming) {
    const startedAs = session.title;
    naming.catch((err) => {
      console.warn('fleet: session not renamed', { id: session.id, message: firstLine(err) });
      return null;
    }).then((name) => {
      if (!find(session.id) || session.title !== startedAs) return;
      update(session, { ...(name ? { title: name } : {}), namedAt: nowIso() });
      console.log('fleet: session named', { id: session.id, named: Boolean(name) });
    }).catch((err) => console.warn('fleet: session name not saved', { id: session.id, message: firstLine(err) }));
  }

  /**
   * Resume on a stopped private session: the same session runs again, with its page, branch and options, and claude
   * reopens its conversation from the Claude home it saved. Its prompt starts again when there is no conversation to
   * reopen, such as one that never reached claude.
   * @param {{owner: string, id: string, background?: boolean, herdrParent?: boolean}} args  herdrParent: for this run, as
   *   startPrivate's
   */
  async function resumePrivate({ owner, id, background = false, herdrParent = false }) {
    const session = find(id);
    if (!session || session.owner !== owner) throw shown('no session you can open with that id');
    if (ACTIVE_STATUSES.has(session.status)) throw shown('that session is still running');
    logIfInLine(owner);
    update(session, {
      status: 'queued', state: null, startedAt: null, stoppedAt: null, stopReason: null, stoppedBy: null, error: null, ref: null,
      // Only claude reopens a conversation; every other agent starts its prompt again.
      endpoint: null, startSteps: null, token: newSessionToken(), terminalToken: newSessionToken(), resumeClaude: agents.agentOfSession(session) === 'claude' ? session.claudeSession ?? null : null,
      lastActiveAt: null, checkedAt: null, app: null, appServers: null, appName: null, apps: null, resumedAt: nowIso(), resumedBy: owner, queuedAt: nowIso(),
      herdrParent: herdrParent ? true : null,
      // A Resume starts its own agent alone: what the agents of the last run were allowed (a Codex one's sign-in) is
      // not this run's, and the last run's list is not either.
      extraAgents: null, agents: null,
      // Its pull request's watch ended when it stopped: it is watched again once statusd reports it.
      announcedPrUrl: null,
      // A tainted session starts locked down, its entrypoint told so (WOODSHED_TAINTED): its statusd needs no notice.
      ...(session.taintedAt ? { taintNoticedAt: nowIso() } : {}),
    });
    // Or, when its stop was not read yet, the watch starts a new run for this one.
    announcer.renew(session.id);
    console.log('fleet: resuming a private session', { id, owner, claudeSession: Boolean(session.resumeClaude), background, tainted: Boolean(session.taintedAt), herdrParent: Boolean(herdrParent) });
    await runStartQueued({ background });
    return session;
  }

  // Remove and Delete work on a running session too: it is stopped first, pushing its work as any stop does. One
  // already stopping is not waited for, since its stop is in flight and finishes by itself.
  async function stopForRemoval(session, reason) {
    if (session.status === 'stopping') throw shown('it is stopping: try again in a moment');
    if (!ACTIVE_STATUSES.has(session.status)) return;
    console.log('fleet: stopping a session to remove it', { id: session.id, status: session.status, reason });
    await stop(session, reason);
    if (ACTIVE_STATUSES.has(session.status)) throw shown('it did not stop: try again in a moment');
  }

  /**
   * Remove, on a private session: off the list, with the Claude home it kept for its Resume. Its branch stays.
   * @param {{owner: string, id: string}} args
   */
  async function removePrivateSession({ owner, id }) {
    const session = find(id);
    if (!session || session.owner !== owner) throw shown('no session you can open with that id');
    await stopForRemoval(session, 'removed from the console');
    // Off the list before the delete is awaited, so a Resume meanwhile finds no session rather than starting one the
    // list then drops, which tick would never watch.
    state.sessions = state.sessions.filter((s) => s !== session);
    store.save();
    console.log('fleet: private session removed', { id, owner });
    await forgetPrivateData(session);
  }

  // The files attached at its start were kept for each Resume.
  async function dropAttachments(session) {
    await attachments?.drop(session.id).catch((err) => {
      console.warn('fleet: private session\'s attachments not deleted', { id: session.id, message: firstLine(err) });
    });
  }

  // Best effort: a home left behind costs storage, and Forget or Remove My Woodshed deletes it with the rest.
  // A tainted session's is tried again until it goes (retryTaintedHomes): it may hold what the session saw.
  async function forgetPrivateData(session) {
    await dropAttachments(session);
    if (!homes) return;
    const name = privateSessionHomeName(session.owner, session.id);
    await homes.remove(name).catch((err) => {
      console.warn('fleet: private session\'s Claude home not deleted', { id: session.id, tainted: Boolean(session.taintedAt), message: firstLine(err) });
      if (!session.taintedAt) return;
      state.taintedHomesPending = [...(state.taintedHomesPending ?? []), { id: session.id, name }];
      store.save();
    });
  }

  /**
   * Remove My Woodshed, for its sessions: each of the owner's private sessions stops, pushing its work first as
   * any stop does, and then every one of them leaves the console's records. Their branches stay on GitHub.
   * @param {string} owner
   * @returns {Promise<{stopped: number, removed: number}>}
   */
  async function removePrivate(owner) {
    const theirs = state.sessions.filter((s) => s.owner === owner);
    const live = theirs.filter((s) => ['queued', 'starting', 'running'].includes(s.status));
    // A stop this process is running removes its task itself. One a restart interrupted is only ever finished by
    // tick, which never sees a session off the list, so it is finished here, or its task would run on, unwatched.
    const interrupted = theirs.filter((s) => s.status === 'stopping' && !stopsInFlight.has(s.id));
    await Promise.all([...live.map((s) => stop(s, 'My Woodshed removed')), ...interrupted.map(finishInterruptedStop)]);
    await Promise.all(theirs.map(dropAttachments));
    state.sessions = state.sessions.filter((s) => s.owner !== owner);
    store.save();
    console.log('fleet: private sessions removed', { owner, stopped: live.length + interrupted.length, removed: theirs.length });
    return { stopped: live.length + interrupted.length, removed: theirs.length };
  }

  /**
   * @param {{number: number, login: string, trigger: 'label'|'comment', text?: string,
   *          commentId?: number, title?: string, kind?: 'issue'|'pr'}} trigger
   * @returns {Promise<{outcome: 'started'|'sent'|'resumed'|'ignored', sessionId?: string, reason?: string}>}
   */
  async function handleTrigger(trigger) {
    const { number, login, commentId } = trigger;
    const project = projectOfEvent(trigger.project);
    if (!project) {
      console.log('fleet: trigger ignored, its project is not this console\'s', { number, login, trigger: trigger.trigger, project: trigger.project });
      return { outcome: 'ignored', reason: `${trigger.project} is not one of this console's projects` };
    }
    // Write access, the issue and its sessions are all the project's own: another repo's #12 is not this one's.
    const gh = githubOf(project);
    if (!(await gh.canWrite(login))) {
      console.log('fleet: trigger ignored, no write access', { number, login, trigger: trigger.trigger, ...projectField(project) });
      return { outcome: 'ignored', reason: 'no write access to the repo' };
    }
    if (people && !(await people.check(login))) {
      console.log('fleet: trigger ignored, the handle was another account\'s', { number, login, trigger: trigger.trigger, ...projectField(project) });
      return { outcome: 'ignored', reason: 'the GitHub name was another account\'s when last used here' };
    }
    const sessions = state.sessions.filter((s) => onProject(s, project));
    const route = routeTrigger({ sessions, number, trigger: trigger.trigger, kind: trigger.kind, text: trigger.text });
    console.log('fleet: trigger routed', { number, login, trigger: trigger.trigger, action: route.action, reason: route.reason, ...projectField(project) });
    if (route.action === 'ignore') return { outcome: 'ignored', reason: route.reason };
    if (route.action === 'start' && runsElsewhere(await pullRequests(project.name), project, number, trigger.trigger)) {
      return { outcome: 'ignored', reason: 'pullRequests.runsOn names another console' };
    }
    if (members && !members.hasGithubSessions(login)) return refuseFromGitHub(trigger, gh, project);
    if (route.action === 'send') {
      await send(find(route.sessionId), trigger.text);
      takeIfUnassigned(find(route.sessionId), login, trigger.trigger);
      await safely('reaction', () => gh.reactToComment(commentId));
      return { outcome: 'sent', sessionId: route.sessionId };
    }
    if (route.action === 'resume') return resumeFromGitHub(find(route.sessionId), trigger, gh);
    const blocked = await projectBlocker(project);
    if (blocked) return refuseForDatabases(trigger, blockerText(blocked), gh, project);
    const session = await startFromGitHub({ ...trigger, resumeBranch: route.resumeBranch, project });
    return { outcome: 'started', sessionId: session.id };
  }

  // The project is not ready (databaseGate.mjs: an engine it needs is not hosted, or the program's hook said why):
  // said once on the issue, as a refusal.
  async function refuseForDatabases({ number, login, trigger }, why, gh = github, project = defaultProject(config)) {
    console.warn('fleet: trigger refused, its project is not ready', { number, login, trigger, why, ...projectField(project) });
    const posted = await safely('refusal comment', () => gh.comment(number, `${config.consoleName || DEFAULT_CONSOLE_NAME} cannot start a session here: ${why}`));
    if (posted && state.github) {
      state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
      store.save();
    }
    return { outcome: 'ignored', reason: why };
  }

  // A member without sessions from GitHub (People) is told on the issue, and their label taken off, so it does not
  // look like it is working. A later label from someone with it starts the session as usual.
  async function refuseFromGitHub({ number, login, trigger }, gh = github, project = defaultProject(config)) {
    const member = Boolean(members?.isMember?.(login));
    console.log('fleet: trigger ignored, no sessions from GitHub', { number, login, trigger, member });
    const { label } = triggersOf(project);
    const unlabeled = trigger === 'label' ? await safely('label removal', () => gh.removeLabel(number, label)) : null;
    const body = refusalComment({ login, label, unlabeled: Boolean(unlabeled), member, publicUrl: await consoleUrlOf(project), consoleName: config.consoleName });
    const posted = await safely('refusal comment', () => gh.comment(number, body));
    if (posted && state.github) {
      state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
      store.save();
    }
    return { outcome: 'ignored', reason: `@${login} has no sessions from GitHub` };
  }

  // A resume leaves who has the session as it was, assigned or not.
  async function resumeFromGitHub(session, { number, login, trigger, text, commentId }, gh = github) {
    const message = text || `Carry on with ${session.kind === 'pr' ? 'PR ' : ''}#${session.number}: the ${triggersOf(projectFor(config, session)).label} label was added again.`;
    await resumeShared(session, { text: message, by: login, why: trigger });
    await safely('reaction', () => (commentId ? gh.reactToComment(commentId) : gh.reactToIssue(number)));
    const publicUrl = await consoleUrlOf(projectFor(config, session));
    const posted = await safely('resume comment', () => gh.comment(number, resumeComment({ session, publicUrl, linkQuery: config.linkQuery, consoleName: config.consoleName })));
    if (posted && state.github) {
      state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
      store.save();
    }
    return { outcome: 'resumed', sessionId: session.id };
  }

  // A webhook and the poll can both see one label. Whichever comes second skips it: the webhook's
  // receive time and the event's own time are seconds apart, however late the poll runs.
  // Another project's label is kept with its project's name, so its #12 is not the default project's #12.
  function claimLabel(number, at, project = null) {
    const time = Date.parse(at);
    const recent = state.recentLabels ?? [];
    if (recent.some((l) => l.number === number && (l.project ?? null) === project && Math.abs(Date.parse(l.at) - time) <= LABEL_DEDUPE_MS)) return false;
    state.recentLabels = [...recent, { number, at, ...(project ? { project } : {}) }].slice(-RECENT_LABELS_KEPT);
    store.save();
    return true;
  }

  /**
   * Why a label or /woodshed comment is not acted on because its repo's settings turn it off, or null. Logged; nothing
   * is posted on the issue, since the repo was turned off on purpose.
   * @returns {string|null}
   */
  function switchedOff({ trigger, number, login, project: name = null }) {
    const project = projectOfEvent(name);
    if (!project) return null;
    const t = triggersOf(project);
    const off = trigger === 'label' ? !t.labels : trigger === 'comment' ? !t.comments : false;
    if (!off) return null;
    console.log('fleet: trigger ignored, the repo turns it off', { number, login, trigger, ...projectField(project) });
    return trigger === 'label' ? `${project.repo}'s settings turn its label off` : `${project.repo}'s settings turn /woodshed comments off`;
  }

  function claimComment(commentId) {
    if (state.github?.seenComments.includes(commentId)) return false;
    // Before the poll's first run there is no cursor; that run then skips everything older than itself.
    if (state.github) {
      state.github.seenComments = rememberSeen(state.github.seenComments, [commentId]);
      store.save();
    }
    return true;
  }

  function releaseClaim(trigger) {
    if (trigger.trigger === 'comment') {
      if (state.github) state.github.seenComments = state.github.seenComments.filter((id) => id !== trigger.commentId);
    } else {
      state.recentLabels = (state.recentLabels ?? []).filter((l) => !(l.number === trigger.number && l.at === trigger.at && (l.project ?? null) === (trigger.project ?? null)));
    }
    store.save();
  }

  /**
   * A trigger from the webhooks queue (webhookDispatch.mjs), checked against what the poll already handled.
   * @param {{number: number, login: string, trigger: 'label'|'comment', at?: string, text?: string,
   *          commentId?: number, title?: string, kind?: 'issue'|'pr'}} trigger
   * @returns {Promise<{outcome: 'started'|'sent'|'resumed'|'ignored'|'duplicate', sessionId?: string, reason?: string}>}
   */
  async function handleWebhookTrigger(trigger) {
    const off = switchedOff(trigger);
    if (off) return { outcome: 'ignored', reason: off };
    const claimed = trigger.trigger === 'comment' ? claimComment(trigger.commentId) : claimLabel(trigger.number, trigger.at, trigger.project ?? null);
    if (!claimed) {
      console.log('fleet: webhook trigger already handled', { number: trigger.number, trigger: trigger.trigger });
      return { outcome: 'duplicate', reason: 'already handled by the poll' };
    }
    const sessionsBefore = state.sessions.length;
    const { at, ...rest } = trigger;
    try {
      return await handleTrigger(rest);
    } catch (err) {
      // Released so the queue's retry is handled again, unless a session already started: a retry would start a second one.
      const started = state.sessions.length > sessionsBefore;
      if (!started) releaseClaim(trigger);
      console.warn('fleet: webhook trigger failed', { number: trigger.number, trigger: trigger.trigger, released: !started });
      throw err;
    }
  }

  /**
   * A label on a pull request that is not the console's own: when it is the project's QA label and its QA runs here
   * (`pullRequests.qa.runner: woodshed`), a QA session starts on the pull request's branch, once the review has approved
   * its latest commit (qaAfterReview starts it then). Any other label is dropped without a word, as the console's
   * webhooks drop every label that is not theirs.
   * @param {{number: number, label: string, login: string, project?: string}} trigger
   * @returns {Promise<{outcome: 'started'|'ignored'|'waiting', sessionId?: string, reason?: string}|{unrecorded: true}>}
   */
  async function handleQaLabel({ number, label, login, project: projectName = null }) {
    const project = projectOfEvent(projectName);
    const gates = project ? await pullRequests(project.name) : null;
    const qa = gates?.qa;
    if (!qa || qa.runner !== 'woodshed' || qa.label !== label) return { unrecorded: true };
    return startQa({ project, gates, number, login, why: 'label' });
  }

  /**
   * A review on a pull request: when the project's review approved its latest commit and the pull request carries the
   * QA label, QA runs on that commit, as whoever added the label. Once for each commit, however many times it is approved.
   * @param {{number: number, project?: string|null}} args
   * @returns {Promise<{outcome: 'started'|'ignored'|'waiting', sessionId?: string, reason?: string}|{unrecorded: true}>}
   */
  async function qaAfterReview({ number, project: projectName = null }) {
    const project = projectOfEvent(projectName);
    const gates = project ? await pullRequests(project.name) : null;
    const qa = gates?.qa;
    if (!qa || qa.runner !== 'woodshed' || !gates.review) return { unrecorded: true };
    const gh = githubOf(project);
    const pull = await gh.pull(number);
    if (!(pull.labels ?? []).some((l) => l.name === qa.label)) return { unrecorded: true };
    const tested = state.sessions.some((s) => isQa(s) && s.number === number && onProject(s, project) && s.qa.sha === pull.head.sha);
    if (tested) return { unrecorded: true };
    // The label already posted the Waiting check: a review that does not approve the head adds nothing.
    if (!(await reviewApproved({ project, gates, gh, number, sha: pull.head.sha })).approved) return { unrecorded: true };
    const login = await gh.labeledBy(number, qa.label);
    if (!login) {
      console.log('fleet: QA after review skipped, no one added the label', { number, ...projectField(project) });
      return { outcome: 'ignored', reason: 'could not tell who added the QA label' };
    }
    return startQa({ project, gates, number, login, why: 'review', pull });
  }

  // The checks a person starting QA passes, then the session. A project with a review waits for it to approve the
  // head commit, as QA in the repo's CI does: the label posts a neutral `Waiting` check, which the brief reads as no result.
  async function startQa({ project, gates, number, login, why, pull: known = null }) {
    const { qa } = gates;
    const gh = githubOf(project);
    const ignored = (reason) => {
      console.log('fleet: QA not started', { number, login, why, reason, ...projectField(project) });
      return { outcome: 'ignored', reason };
    };
    // A person who added the label must pass the identity checks. A label the console's own App added (qa.autoLabel)
    // stands for the pull request's author, on a same-repo head, on the team key when the author fails the checks.
    let teamKeyWhy = null;
    let owner = null;
    const appLogin = ownApp()?.login ?? null;
    if (qa.autoLabel && appLogin && login === appLogin) {
      const autoPull = known ?? await gh.pull(number);
      if (autoPull.head?.repo?.full_name && autoPull.head.repo.full_name !== project.repo) return ignored('the pull request is from a fork');
      owner = pullOwner(project, autoPull, number);
      login = owner.login;
      teamKeyWhy = await teamKeyReason(login);
      console.log('fleet: QA label added by the console, run as the author', { number, login, teamKey: Boolean(teamKeyWhy), ...projectField(project) });
    } else {
      if (!(await gh.canWrite(login))) return ignored('no write access to the repo');
      if (people && !(await people.check(login))) return ignored('the GitHub name was another account\'s when last used here');
      if (members && !members.hasGithubSessions(login)) return ignored(`${login} cannot start sessions from GitHub`);
    }
    const route = routeQa({ sessions: state.sessions.filter((s) => onProject(s, project)), number });
    if (route.action === 'ignore') return ignored(route.reason);
    if (runsElsewhere(gates, project, number, 'qa', owner)) return ignored(owner?.elsewhere ? 'another console\'s session opened it' : 'pullRequests.runsOn names another console');
    const pull = known ?? await gh.pull(number);
    if (pull.state !== 'open') return ignored('the pull request is not open');
    if (gates.review) {
      const verdict = await reviewApproved({ project, gates, gh, number, sha: pull.head.sha });
      if (!verdict.approved) {
        await safely('QA waiting check', () => gh.createCheckRun({
          sha: pull.head.sha, name: qa.check, conclusion: 'neutral', title: 'Waiting for the review to approve this commit',
          summary: 'QA runs here once the review approves the pull request\'s latest commit.',
        }));
        console.log('fleet: QA waiting for the review', { number, login, verdict: verdict.state, ...projectField(project) });
        return { outcome: 'waiting', reason: 'the review has not approved the latest commit' };
      }
    }
    const blocked = await projectBlocker(project);
    if (blocked) return ignored(blockerText(blocked));
    // One QA comment per pull request: a later run writes over the last one's.
    const commentId = state.sessions.filter((s) => isQa(s) && s.number === number && onProject(s, project) && s.qa.commentId).at(-1)?.qa.commentId ?? null;
    const session = await createSession({
      kind: 'pr', number, title: `QA: ${pull.title}`, startedBy: login, trigger: 'qa', branch: pull.head.ref, project,
      qa: {
        base: pull.base.ref, sha: pull.head.sha, heading: qa.heading, check: qa.check, commentId, ...(teamKeyWhy ? { teamKey: true } : {}),
        // A repo whose recordings are public (qa.recordings) gets its run's videos at names only this secret opens.
        ...(qa.recordings === 'public' ? { share: newRecordingSecret() } : {}),
      },
    });
    await postQaComment(session, gh, runningComment({ heading: qa.heading, sessionUrl: await qaSessionUrl(session, project) }));
    console.log('fleet: QA session started', { id: session.id, number, login, why, base: pull.base.ref, ...projectField(project) });
    return { outcome: 'started', sessionId: session.id };
  }

  /**
   * A pull request opened or marked ready (qa.autoLabel): the console adds the QA label, once, and the label's own flow
   * runs QA after the review approves. Someone who removes the label opts the pull request out.
   * @param {{number: number, project?: string|null}} args
   */
  async function qaAutoLabel({ number, project: projectName = null }) {
    const project = projectOfEvent(projectName);
    const gates = project ? await pullRequests(project.name) : null;
    const qa = gates?.qa;
    if (!qa?.autoLabel || qa.runner !== 'woodshed') return { unrecorded: true };
    const gh = githubOf(project);
    const pull = await gh.pull(number);
    // The label's author is whose QA it is: another console's would read to the one that runs it as a stranger's.
    if (runsElsewhere(gates, project, number, 'qa label', pullOwner(project, pull, number))) return { unrecorded: true };
    if (pull.state !== 'open' || pull.draft || (pull.labels ?? []).some((l) => l.name === qa.label)) return { unrecorded: true };
    if (pull.head?.repo?.full_name && pull.head.repo.full_name !== project.repo) return { unrecorded: true };
    await gh.addLabel(number, qa.label);
    console.log('fleet: QA label added', { number, label: qa.label, ...projectField(project) });
    return { outcome: 'labelled' };
  }

  async function qaSessionUrl(session, project) {
    const publicUrl = await consoleUrlOf(project);
    return publicUrl ? sessionLink(publicUrl, session.id, config.linkQuery) : null;
  }

  async function postQaComment(session, gh, body) {
    const { commentId } = session.qa;
    if (commentId) {
      const updated = await safely('QA comment', async () => { await gh.updateComment(commentId, body); return true; });
      if (updated) return;
    }
    const posted = await safely('QA comment', () => gh.comment(session.number, body));
    if (!posted) return;
    update(session, { qa: { ...session.qa, commentId: posted } });
    if (state.github) state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
    store.save();
  }

  /**
   * One of a QA session's videos, sent before its report: kept where the provider keeps files (qaRecordings.mjs) for
   * the QA comment to link, behind the console's sign-in. Throws when the store refuses it.
   * @param {object} session
   * @param {Buffer} video  WebM
   * @returns {Promise<{n: number}>}  its number in the run
   */
  async function qaVideo(session, video) {
    if (!qaRecordings) throw new Error('this console keeps no QA recordings');
    const videos = session.qa.videos ?? [];
    const n = videos.length + 1;
    await qaRecordings.saveVideo(session.id, n, video);
    update(session, { qa: { ...session.qa, videos: [...videos, { n, bytes: video.length }] } });
    console.log('fleet: QA video saved', { id: session.id, number: session.number, n, bytes: video.length });
    return { n };
  }

  /**
   * A QA run's log (POST /qa-log): how each of its claude passes ended and the steps the run took, kept on the session
   * for the console's page to show (GET /api/sessions/<id>/qa-log) whether or not the run ever got to its report.
   * @param {object} session
   * @param {string} text
   * @param {'summary'|'full'} [tier]
   */
  function qaLog(session, text, tier = 'full') {
    // The summary holds counts and fixed words only: whoever may open the session reads it. The full log holds what claude
    // and its tools printed, which only an admin or the person who started the run reads (GET /api/sessions/<id>/qa-log).
    update(session, { qa: { ...session.qa, [tier === 'summary' ? 'summaryLog' : 'log']: text } });
    console.log('fleet: QA run log kept', { id: session.id, number: session.number, tier, bytes: Buffer.byteLength(text) });
  }

  /**
   * The still the QA comment shows, from the run's first video: kept beside the videos at a name nobody can guess, the
   * one part of a recording served without sign-in, since GitHub fetches a comment's images with none.
   * @param {object} session
   * @param {Buffer} png
   */
  async function qaPoster(session, png) {
    if (!qaRecordings) throw new Error('this console keeps no QA recordings');
    const { path: posterPath } = await qaRecordings.savePoster(session.id, png);
    update(session, { qa: { ...session.qa, poster: posterPath } });
    console.log('fleet: QA poster saved', { id: session.id, number: session.number, bytes: png.length });
    return { saved: true };
  }

  // The links a QA comment gives its recordings, on the console's public address; none without one. A public run's
  // (qa.share) open with no sign-in, so they name the console even where the project file says `consoleLinks: false`:
  // they are what its repo asked to show, and open nothing else there.
  async function qaRecordingLinks(session, project) {
    const { share } = session.qa;
    const base = share ? config.publicUrl : await consoleUrlOf(project);
    if (!base || !session.qa.videos?.length) return { videos: [], poster: null, open: false };
    const pathOf = (n) => (share ? qaPublicVideoPath(session.id, share, n) : qaVideoPath(session.id, n));
    return {
      videos: session.qa.videos.map((v) => ({ url: `${base}${pathOf(v.n)}`, bytes: v.bytes })),
      poster: session.qa.poster ? `${base}${session.qa.poster}` : null,
      open: Boolean(share),
    };
  }

  /**
   * A public run's video, for anyone with its name (GET /qa-video/…): the session its id names, if its secret matches.
   * @returns {object|null}  the session, or null for a name that opens nothing
   */
  function publicQaVideo(id, secret, n) {
    const session = find(id);
    return session && isQa(session) && opensPublicVideo(session, { secret, n }) ? session : null;
  }

  /**
   * A QA session's report (POST /qa-report): written into the pull request's QA comment, then the session stops.
   * @param {object} session
   * @param {{verdict: {conclusion: string, title: string, status: string, total: number}, report: string, sha: string,
   *   costUsd: number|null}} result  from parseQaReport
   */
  async function qaFinished(session, { verdict, report, sha, costUsd }) {
    const project = projectFor(config, session);
    const gh = githubOf(project);
    const sessionUrl = await qaSessionUrl(session, project);
    const { videos, poster, open } = await qaRecordingLinks(session, project);
    await postQaComment(session, gh, finishedComment({ heading: session.qa.heading, verdict, report, sessionUrl, videos, poster, open }));
    // The check carries the report too: sessions comment as the App, but cannot post a check, so the brief reads it here.
    // The session runs the pull request's code, which can send any commit: only this pull request's gets a check.
    const ours = sha === session.qa.sha || sha === (await safely('QA pull request', () => gh.pull(session.number)))?.head?.sha;
    if (!ours) console.warn('fleet: QA check skipped, not the pull request\'s commit', { id: session.id, number: session.number, reported: sha, started: session.qa.sha });
    const checkUrl = ours ? await safely('QA check', () => gh.createCheckRun({
      sha, name: session.qa.check ?? 'QA', conclusion: verdict.conclusion, title: verdict.title,
      summary: `${verdict.status}\n\n${report}`.trim(), detailsUrl: sessionUrl, externalId: session.id,
    })) : null;
    update(session, { qa: { ...session.qa, conclusion: verdict.conclusion, title: verdict.title, testedSha: sha, costUsd } });
    console.log('fleet: QA finished', { id: session.id, number: session.number, conclusion: verdict.conclusion, total: verdict.total, costUsd, checkPosted: Boolean(checkUrl) });
    // Only the commit this session was started on: a report naming another sha did not test what that approval waits for.
    if (sha === session.qa.sha) {
      const failed = verdict.conclusion === 'failure';
      const qaLine = failed ? `The review approved this commit, but QA failed (${verdict.title}): see the QA comment.` : `QA: ${verdict.title}.`;
      await safely('held approval after QA', () => releaseHeldApproval(project, session.number, { sha, failed, qaLine }));
    }
    // In the background: the session waits on this reply, and the stop saves its home through it first.
    stop(session, `QA finished: ${verdict.title}`)
      .catch((err) => console.warn('fleet: stopping a finished QA session failed', { id: session.id, message: firstLine(err) }))
      // A commit the review approved while this one ran was turned away as already running: it runs now.
      .then(() => safely('QA of a commit approved meanwhile', () => qaAfterReview({ number: session.number, project: project.name })));
  }

  /**
   * A pull request whose review runs in a session (pullRequests.review.runner: woodshed): when its head commit carries
   * the review's rerun tag, or was pushed over the review's approval and dismissed it (approvalDismissed), and no
   * session has reviewed that commit, a review session starts, as the pull request's author. Once for each commit. Cheap to call on any pull request change: it returns early unless the runner is
   * `woodshed`.
   * @param {{number: number, project?: string|null}} args
   */
  async function reviewOnTag({ number, project: projectName = null }) {
    const project = projectOfEvent(projectName);
    const gates = project ? await reviewGates(project.name) : null;
    const review = gates?.review;
    if (!review || review.runner !== 'woodshed') return { unrecorded: true };
    const gh = githubOf(project);
    const pull = await gh.pull(number);
    if (pull.state !== 'open' || pull.draft) return { unrecorded: true };
    if (state.sessions.some((s) => isReview(s) && s.number === number && onProject(s, project) && s.review.sha === pull.head.sha)) return { unrecorded: true };
    if (review.rerun) {
      const message = await safely('review head commit', () => gh.commitMessage(pull.head.sha));
      const tagged = Boolean(message?.includes(review.rerun));
      if (!tagged && !(await approvalDismissed(project, gh, number, pull.head.sha))) return { unrecorded: true };
    }
    const owner = pullOwner(project, pull, number);
    return startReview({ project, gates, number, login: owner.login, owner, pull });
  }

  /**
   * Whether the review's own last verdict on this pull request was an approval of an older commit, which GitHub now
   * shows dismissed: a push to a repo that dismisses stale approvals took it away. Such a push is reviewed tag or not,
   * since nothing else gives the approval back and git's own merge message carries no tag (#333, #334). A fix after
   * changes were asked for, or a push to a repo that keeps stale approvals, still waits for the tag.
   */
  async function approvalDismissed(project, gh, number, head) {
    const last = state.sessions.filter((s) => isReview(s) && s.number === number && onProject(s, project) && s.review.conclusion && s.review.posted).at(-1);
    if (last?.review.conclusion !== 'APPROVE' || last.review.sha === head) return false;
    const reviews = await safely('reviews of the pull request', () => gh.reviews(number));
    const dismissed = Boolean(reviews?.some((r) => r.commit_id === last.review.sha && r.state === 'DISMISSED'));
    if (dismissed) console.log('fleet: the review\'s approval was dismissed by a push, reviewing it again', { number, approved: last.review.sha, head, ...projectField(project) });
    return dismissed;
  }

  /**
   * A review its author asks for (`woodshed review start`, POST /api/my/pulls/<number>/review): the same review
   * session a tagged commit starts (reviewOnTag), on the pull request's head as it is now, tag or not. Only the author
   * may ask, since it runs on their own sign-ins and their choice on My settings, and only where the project's review
   * runs in a session. A head a review session gave its verdict on, or is reviewing, answers with that session; one whose
   * review failed, was stopped with no verdict, or whose verdict GitHub did not take may be asked again. One ask at a
   * time for each pull request, and one start (startReview), so two at once cannot both start a session.
   * @param {{project: object, number: number, login: string}} args
   * @returns {Promise<{outcome: 'started'|'running'|'reviewed', sessionId: string}|{outcome: 'refused', status: number, reason: string}>}
   */
  async function reviewOnDemand({ project, number, login }) {
    const key = `${project.name}#${number}`;
    if (askingReview.has(key) || startingReview.has(key)) {
      console.log('fleet: review asked for, refused', { number, login, reason: 'already being asked for', ...projectField(project) });
      return { outcome: 'refused', status: 409, reason: `a review of #${number} is being started already: try again in a moment` };
    }
    askingReview.add(key);
    try {
      return await askReview({ project, number, login });
    } finally {
      askingReview.delete(key);
    }
  }

  async function askReview({ project, number, login }) {
    const refused = (status, reason) => {
      console.log('fleet: review asked for, refused', { number, login, reason, ...projectField(project) });
      return { outcome: 'refused', status, reason };
    };
    // The review the fleet runs by: the project file's, or every repo's default where it names none (reviewGates,
    // defaultReview.mjs). Refused only where the file itself chooses another runner, or runsOn another console.
    const gates = await reviewGates(project.name);
    const runner = gates?.review?.runner ?? null;
    if (runner !== 'woodshed') {
      return refused(409, `${project.repo}'s project file runs its review in ${runner === 'actions' ? 'GitHub Actions' : runner}, not in this console: its pullRequests.review chooses that runner`);
    }
    const gh = githubOf(project);
    let pull;
    try {
      pull = await gh.pull(number);
    } catch (err) {
      return refused(/\b404\b|Not Found/.test(firstLine(err)) ? 404 : 502, `pull request #${number} on ${project.repo} was not read: ${firstLine(err)}`);
    }
    if (!pull?.head?.sha) return refused(404, `no pull request #${number} on ${project.repo}`);
    const owner = pullOwner(project, pull, number);
    if (owner.login !== login) return refused(403, `#${number} is not your pull request: only its author asks for its review, which runs on their sign-ins`);
    if (runsElsewhere(gates, project, number, 'review', owner)) {
      return refused(409, `${project.repo}'s pullRequests.runsOn names another console (${gates.runsOn}), which runs its reviews`);
    }
    if (pull.state !== 'open') return refused(409, `#${number} is not open`);
    if (pull.draft) return refused(409, `#${number} is a draft: mark it ready for review first`);
    const done = state.sessions.filter((s) => isReview(s) && s.number === number && onProject(s, project) && s.review.sha === pull.head.sha
      && (ACTIVE_STATUSES.has(s.status) || (s.review.conclusion && s.review.posted !== false))).at(-1);
    if (done) {
      const outcome = ACTIVE_STATUSES.has(done.status) ? 'running' : 'reviewed';
      console.log('fleet: review asked for', { number, login, outcome, id: done.id, ...projectField(project) });
      return { outcome, sessionId: done.id };
    }
    const started = await startReview({ project, gates, number, login, owner, pull, asked: true });
    if (started.outcome !== 'started') return refused(409, started.reason);
    console.log('fleet: review asked for', { number, login, outcome: 'started', id: started.sessionId, ...projectField(project) });
    return started;
  }

  // Pull requests whose review is being asked for by hand (reviewOnDemand) or started (startReview), by project and
  // number: a tagged commit's start and an ask that overlap start one session, not two.
  const askingReview = new Set();
  const startingReview = new Set();

  // The review runs as a session (pullRequests.review.runner: woodshed) instead of the Actions workflow: the
  // `[woodshed-review]` tag on the head commit starts it, session/review.sh runs the review, and the console submits
  // the verdict and the Merge risk check here (reviewFinished), as its own App. One review session per commit.
  const skipKey = (project, number) => `${project?.name ?? ''}#${number}`;

  /**
   * Whether this pull request's author chose no code review (or nothing could run one) at its last review: then what
   * waits for a review, the Slack post and QA, goes on without it. A later review that runs clears it.
   */
  function reviewSkipped(projectName, number) {
    return Boolean(state.reviewSkips?.[`${projectName ?? ''}#${number}`]);
  }

  /** The project's pull request gates, without the review for a pull request whose review was skipped. */
  async function gatesFor(projectName, number) {
    const gates = await pullRequests(projectName);
    if (!gates?.review || number == null || !reviewSkipped(projectName ?? defaultProject(config).name, number)) return gates;
    return { ...gates, review: null };
  }

  async function startReview(args) {
    const key = `${args.project.name}#${args.number}`;
    // A tagged commit's start goes on while an ask only reads GitHub, and is never dropped for one: whichever reaches
    // here second finds the other's session (`already running`) or waits out this guard's few reads.
    if (startingReview.has(key)) {
      console.log('fleet: review not started', { number: args.number, login: args.login, reason: 'a review of it is being started already', ...projectField(args.project) });
      return { outcome: 'ignored', reason: 'a review of it is being started already' };
    }
    startingReview.add(key);
    try {
      return await startReviewNow(args);
    } finally {
      startingReview.delete(key);
    }
  }

  async function startReviewNow({ project, gates, number, login, owner = null, pull: known = null }) {
    const { review, mergeRisk } = gates;
    const gh = githubOf(project);
    const ignored = (reason) => {
      console.log('fleet: review not started', { number, login, reason, ...projectField(project) });
      return { outcome: 'ignored', reason };
    };
    if (runsElsewhere(gates, project, number, 'review', owner)) return ignored(owner?.elsewhere ? 'another console\'s session opened it' : 'pullRequests.runsOn names another console');
    const pull = known ?? await gh.pull(number);
    if (pull.state !== 'open' || pull.draft) return ignored('the pull request is not open, or is a draft');
    // The session runs on the author's Claude plan only when they pass the label trigger's identity checks: a reused
    // handle must not spend the old person's token, and only someone set up for sessions runs on their plan. Failing them
    // still gets a review, on the team key. A bot author (a pull request a session opened) has no plan.
    const teamKeyWhy = await teamKeyReason(login);
    if (teamKeyWhy) console.log('fleet: review runs on the team key', { number, login, why: teamKeyWhy, ...projectField(project) });
    // The head must be a branch in the repo, never a fork, as the Actions review requires too.
    if (pull.head?.repo?.full_name && pull.head.repo.full_name !== project.repo) return ignored('the pull request is from a fork');
    if (state.sessions.some((s) => isReview(s) && s.number === number && onProject(s, project) && ACTIVE_STATUSES.has(s.status))) {
      return ignored('a review session is already running on it');
    }
    const commentId = state.sessions.filter((s) => isReview(s) && s.number === number && onProject(s, project) && s.review.commentId).at(-1)?.review.commentId ?? null;
    // The author's choice and own sign-ins only for someone who passed the same checks as their Claude plan; never a
    // bot's. Anyone else's review runs the most the team keys can.
    const ownLogin = teamKeyWhy || login.endsWith('[bot]') ? null : login;
    const { agents, choice = null, codexLogin = null, codexVia = null, codexAccount = null, ownSignIns = null, why: agentsWhy, keysUnread = false, expanded = true } = reviewAgents
      ? await reviewAgents.forReview({ login: ownLogin }) : { agents: ['claude'], why: null };
    if (agentsWhy) console.warn('fleet: review runs other than the author chose', { number, login, choice, agents, why: agentsWhy, ...projectField(project) });
    if (!agents.length && choice !== 'none' && keysUnread) {
      // Nothing to run only because the team keys could not be read: no review was chosen, so nothing is skipped, and
      // what waits for a review keeps waiting. The next commit with the review tag tries again.
      return ignored('the team keys could not be read, so whom to review with is not known');
    }
    if (!agents.length) {
      // No review: what waits for one (the Slack post, QA) goes on without it for this pull request (reviewSkipped).
      state.reviewSkips = { ...state.reviewSkips, [skipKey(project, number)]: { login, sha: pull.head.sha, at: nowIso(), why: choice === 'none' ? 'the author chose no review' : 'nothing can run a review' } };
      store.save();
      return ignored(choice === 'none' ? 'the author chose no code review' : 'no team key and no sign-in of the author\'s can run a review');
    }
    if (state.reviewSkips?.[skipKey(project, number)]) {
      const { [skipKey(project, number)]: _dropped, ...rest } = state.reviewSkips;
      state.reviewSkips = rest;
    }
    const session = await createSession({
      kind: 'pr', number, title: `Review: ${pull.title}`, startedBy: login, trigger: 'review', branch: pull.head.ref, project,
      review: {
        base: pull.base.ref, sha: pull.head.sha, heading: review.heading, author: review.author ?? null, check: mergeRisk?.check ?? null, commentId,
        agents, ...(codexLogin ? { codexLogin } : {}), ...(codexVia ? { codexVia } : {}), ...(codexAccount ? { codexAccount } : {}),
        // Whose sign-in a Grok Build or OpenCode reviewer runs on, and how: never the sign-in itself, which the console's
        // proxy reads at each call (reviewAgentProxy.mjs).
        ...(ownSignIns ? { ownSignIns } : {}),
        ...(teamKeyWhy ? { teamKey: true } : {}),
      },
    });
    console.log('fleet: review session started', {
      id: session.id, number, login, base: pull.base.ref, agents, choice: choice ?? (expanded ? 'every reviewer that can run' : 'Claude Code and Codex, as before'),
      codex: agents.includes('codex') ? (codexLogin ? `own ${codexVia === 'chatgpt' ? 'ChatGPT login' : 'key'}` : 'team key') : null,
      ...(ownSignIns?.grok ? { grok: `own ${ownSignIns.grok.via === 'login' ? 'login' : 'key'}` } : {}),
      ...(ownSignIns?.opencode ? { opencode: `own ${ownSignIns.opencode.provider} key` } : {}),
      ...projectField(project),
    });
    update(session, { review: { ...session.review, runningPosted: true } });
    await postReviewComment(session, gh, reviewRunningComment({ sessionUrl: await qaSessionUrl(session, project), agents }));
    return { outcome: 'started', sessionId: session.id };
  }

  // A repo connected to several consoles names the one that does its automatic work (label and comment sessions,
  // review, QA) in pullRequests.runsOn, by the login its App acts as, and after a slash which of that App's consoles
  // (config.runsOnName), for a host that runs several on one App. The others still start sessions by hand.
  function runsElsewhere(gates, project, number, what, owner = null) {
    if (owner?.own) return false;
    if (owner?.elsewhere) return true;
    const runsOn = gates?.runsOn ?? null;
    if (!runsOn) return false;
    const login = ownApp()?.login ?? null;
    const [app, name = null] = runsOn.split('/');
    if (login === app && (name === null || name === (config.runsOnName ?? null))) return false;
    console.log('fleet: skipped, pullRequests.runsOn names another console', { number, what, runsOn, login, name: config.runsOnName ?? null, ...projectField(project) });
    return true;
  }

  // Each console runs review and QA of the pull requests its own sessions opened, as the person who started the session,
  // on their plan; every other console leaves them alone. The App that opened one is its author, and has no plan.
  // Its branch finds the session too, since GitHub can announce the pull request before the session reports its URL.
  // A bot-authored session branch this console has no session for is another console's (consoles may share one App), and
  // is skipped: a branch name can only make a console skip, never spend someone's plan.
  function pullOwner(project, pull, number) {
    const author = pull.user?.login ?? '';
    const branch = pull.head?.ref ?? '';
    const appLogin = ownApp()?.login ?? null;
    const sessionBranch = branch.startsWith(SESSION_BRANCH_PREFIX);
    if (!author.endsWith('[bot]') || !(author === appLogin || sessionBranch)) return { login: author };
    const opener = author === appLogin ? state.sessions
      .filter((s) => !isQa(s) && !isReview(s) && onProject(s, project) && (pullNumber(s.prUrl) === number || (branch && s.branch === branch))).at(-1) : null;
    const starter = opener?.startedBy ?? null;
    if (starter && !starter.endsWith('[bot]')) {
      console.log('fleet: pull request opened by a session, run as its starter', { number, sessionId: opener.id, starter, ...projectField(project) });
      return { login: starter, own: true };
    }
    if (sessionBranch) {
      console.log('fleet: pull request opened by another console\'s session, left to it', { number, author, found: Boolean(opener), ...projectField(project) });
      return { login: author, elsewhere: true };
    }
    console.log('fleet: pull request opened by the App, no session starter to stand for', { number, found: Boolean(opener), ...projectField(project) });
    return { login: author };
  }


  async function teamKeyReason(login) {
    if (login.endsWith('[bot]')) return null;
    if (people && !(await people.check(login))) return 'the GitHub name was another account\'s when last used here';
    if (members && !members.hasGithubSessions(login)) return 'cannot start sessions from GitHub';
    return null;
  }

  /**
   * A review session's result (POST /review-report): the console submits the formal review and the Merge risk check as
   * its App, then the session stops. A null conclusion (the session wrote no verdict) submits nothing and only stops it.
   * @param {object} session
   * @param {{conclusion: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT'|null, summary: string, comment: string, agents?: string[]|null,
   *   mergeRisk: {tier: string|null, reason: string, summary: string}, sha: string, costUsd: number|null}} result
   */
  async function reviewFinished(session, { conclusion, summary, comment, mergeRisk, inlineComments = [], resolved = [], sha, costUsd, agents }) {
    const project = projectFor(config, session);
    const gh = githubOf(project);
    const hold = conclusion === 'APPROVE' && await qaWillRun(project, session.number);
    const scheduled = session.review.agents;
    const heading = reviewHeading(session.review.heading, agents ?? (scheduled?.length === 1 ? scheduled : null));
    const ours = conclusion ? await submitReview(session, gh, { conclusion, heading, summary, comment, mergeRisk, inlineComments, sha, hold }) : false;
    if (ours && conclusion === 'APPROVE' && !hold) await resolveFixedThreads(session, gh, resolved);
    if (!conclusion) {
      console.warn('fleet: review session wrote no verdict, nothing submitted', { id: session.id, number: session.number });
      await postReviewEnded(session, project, 'the session wrote no verdict');
    } else if (!comment && session.review.runningPosted && session.review.commentId) {
      console.log('fleet: review wrote no comment, its running comment closed', { id: session.id, number: session.number, conclusion });
      await postReviewComment(session, gh, reviewDoneComment({ conclusion, tier: mergeRisk?.tier ?? null }));
    }
    const held = hold && ours ? { sha, heading, summary, inlineComments, resolved } : null;
    // `posted`: GitHub took the verdict (or the console holds it for QA), which an ask for the same head stands on.
    update(session, { review: { ...session.review, conclusion, reported: true, reviewedSha: sha, costUsd, held, posted: Boolean(ours) } });
    console.log('fleet: review finished', { id: session.id, number: session.number, conclusion, tier: mergeRisk?.tier ?? null, costUsd, posted: ours, held: Boolean(held) });
    stop(session, conclusion ? `Review finished: ${conclusion}` : 'Review finished without a verdict')
      .catch((err) => console.warn('fleet: stopping a finished review session failed', { id: session.id, message: firstLine(err) }));
    // Nothing went to GitHub, so no review webhook comes: QA starts from the held approval here. When it cannot start,
    // the approval goes out now with the reason, or the pull request would wait for an approval that never comes. A QA
    // run already going on it picks this commit up when it finishes (qaFinished).
    if (!held) return;
    const qa = await safely('QA after a held approval', () => qaAfterReview({ number: session.number, project: project.name }));
    const pending = qa?.outcome === 'started' || (qa?.outcome === 'ignored' && qa.reason === QA_ALREADY_RUNNING);
    if (pending) return;
    const reason = qa?.reason ?? 'no QA session could start';
    console.warn('fleet: held approval released, QA did not start', { id: session.id, number: session.number, reason });
    await safely('held approval without QA', () => releaseHeldApproval(project, session.number, { sha, failed: false, qaLine: `QA did not start: ${reason}.` }));
  }

  // QA runs on this pull request here (pullRequests.qa.runner: woodshed, and it carries the QA label), so the review's
  // APPROVE waits for it: "Approved" on GitHub then means reviewed and tested, in any repo, with no branch rule needed.
  async function qaWillRun(project, number) {
    const qa = (await pullRequests(project.name))?.qa;
    if (!qa || qa.runner !== 'woodshed') return false;
    const pull = await safely('QA label of the reviewed pull request', () => githubOf(project).pull(number));
    return (pull?.labels ?? []).some((l) => l.name === qa.label);
  }

  // The review approved this commit: on GitHub, or held for QA (reviewFinished).
  function heldApproval(project, number, sha) {
    return state.sessions.filter((s) => isReview(s) && s.number === number && onProject(s, project) && s.review.held?.sha === sha).at(-1) ?? null;
  }

  async function reviewApproved({ project, gates, gh, number, sha }) {
    if (heldApproval(project, number, sha)) return { approved: true, state: 'held for QA' };
    if (reviewSkipped(project?.name ?? null, number)) return { approved: true, state: 'no review, by the author\'s choice' };
    const verdict = reviewVerdict(await gh.reviews(number), gates.review);
    return { approved: verdict?.state === 'APPROVED' && verdict.commit_id === sha, state: verdict?.state ?? null };
  }

  /**
   * QA finished on a commit whose approval was held for it: the approval goes to GitHub with QA's result in it, or, when
   * QA failed, the verdict becomes REQUEST_CHANGES. Not when the head moved since: that commit gets its own review.
   */
  /**
   * A QA run that ended without its report (paused when idle or at its lifetime, stopped by someone, or failed to
   * start) never reaches qaFinished, so the approval its review holds for it would wait for good. Once it has ended,
   * that approval goes out saying QA did not finish, unless another QA run on the same commit is still going, which
   * will report on it. A commit approved meanwhile, while this run held QA, gets its own run, as qaFinished starts it.
   * Checked once per run, on a tick.
   * @param {object} session
   */
  async function qaEndedUnreported(session) {
    if (!isQa(session) || session.qa.conclusion || session.qa.endChecked) return;
    if (session.status !== 'stopped' && session.status !== 'failed') return;
    const project = projectFor(config, session);
    const { sha } = session.qa;
    const same = (s) => s !== session && isQa(s) && s.number === session.number && onProject(s, project);
    if (state.sessions.some((s) => same(s) && s.qa.sha === sha && (ACTIVE_STATUSES.has(s.status) || s.status === 'stopping'))) return;
    update(session, { qa: { ...session.qa, endChecked: true } });
    const holding = state.sessions.filter((s) => isReview(s) && s.number === session.number && onProject(s, project) && s.review.held);
    if (!holding.length) return;
    const reason = firstLine(session.stopReason ?? session.error ?? '') || 'it stopped without a report';
    if (heldApproval(project, session.number, sha)) {
      console.log('fleet: held approval released, QA stopped without a report', { id: session.id, number: session.number, sha, reason });
      await releaseHeldApproval(project, session.number, { sha, failed: false, qaLine: `QA did not finish: ${reason}.` });
    }
    if (holding.some((s) => s.review.held?.sha !== sha)) await qaAfterReview({ number: session.number, project: project.name });
  }

  async function releaseHeldApproval(project, number, { sha, failed, qaLine }) {
    const review = heldApproval(project, number, sha);
    if (!review) return;
    const gh = githubOf(project);
    const { heading = review.review.heading, summary, inlineComments, resolved } = review.review.held;
    update(review, { review: { ...review.review, held: null } });
    const head = (await safely('pull request for a held approval', () => gh.pull(number)))?.head?.sha;
    if (head !== sha) {
      console.log('fleet: held approval dropped, the head moved since', { id: review.id, number, sha, head: head ?? null });
      return;
    }
    const verdict = failed ? 'REQUEST_CHANGES' : 'APPROVE';
    const ok = await sendVerdict(review, gh, { conclusion: verdict, body: `${heading} — ${verdict}\n\n${summary}\n\n${qaLine}`.trim(), inlineComments, sha });
    if (ok && !failed) await resolveFixedThreads(review, gh, resolved);
    console.log('fleet: held approval released', { id: review.id, number, verdict, ok });
  }

  // Only submits when the reviewed commit is still the head: a push since makes the review stale, so it is dropped
  // rather than approving the wrong commit.
  async function submitReview(session, gh, { conclusion, heading, summary, comment, mergeRisk, inlineComments = [], sha, hold = false }) {
    if (comment) await postReviewComment(session, gh, comment);
    const pull = await safely('review pull request', () => gh.pull(session.number));
    if (!pull?.head?.sha) {
      console.warn('fleet: review not submitted, the pull request could not be read', { id: session.id, number: session.number });
      return false;
    }
    if (sha !== pull.head.sha) {
      console.warn('fleet: review not submitted, the head moved since it was reviewed', { id: session.id, number: session.number, reported: sha, head: pull.head.sha });
      return false;
    }
    const body = `${heading} — ${conclusion}\n\n${summary}`.trim();
    const submitted = hold ? true : await sendVerdict(session, gh, { conclusion, body, inlineComments, sha });
    if (hold) console.log('fleet: review approval held until QA finishes', { id: session.id, number: session.number, sha });
    if (mergeRisk?.tier) {
      if (session.review.check) {
        await safely('Merge risk check', () => gh.createCheckRun({
          sha, name: session.review.check, conclusion: 'neutral', title: `${mergeRisk.tier}: ${mergeRisk.reason}`.slice(0, 250),
          summary: `${mergeRisk.summary}\n\n${MERGE_RISK_TIERS}\n\nSet by the AI review. It does not block merging.`.trim(), externalId: session.id,
        }));
      }
      await safely('merge risk label', () => setMergeRiskLabel(gh, session.number, mergeRisk.tier));
    }
    return submitted;
  }

  // The formal review, at `sha`: GitHub refuses it once a push moved the head, rather than approving the wrong commit.
  async function sendVerdict(session, gh, { conclusion, body, inlineComments = [], sha }) {
    // As the reviewer App when there is one: GitHub refuses an approval from the pull request's author, and a pull request
    // a shared session opened is the console App's.
    const asReviewer = Boolean(reviewerApp?.configured());
    const send = (review) => (asReviewer
      ? reviewerApp.submitReview({ repo: projectFor(config, session).repo, number: session.number, event: conclusion, sha, ...review })
      : gh.createReview(session.number, { event: conclusion, sha, ...review }));
    let submitted = await safely('review verdict', () => send({ body, comments: inlineComments }));
    // GitHub refuses the whole review when one comment is on a line the diff does not show: the verdict still goes in,
    // with the comments in its body.
    const folded = submitted === null && inlineComments.length > 0;
    if (folded) submitted = await safely('review verdict without inline comments', () => send({ body: withFoldedComments(body, inlineComments), comments: [] }));
    console.log('fleet: review verdict submitted', {
      id: session.id, number: session.number, as: asReviewer ? 'reviewer App' : 'console App', ok: submitted !== null,
      inlineComments: inlineComments.length, folded,
    });
    // With no reviewer App the gates trust no verdict (reviewLogins.mjs): say so, or a pull request waits with no reason.
    if (!session.review.author) console.warn('fleet: review verdict not counted, no reviewer App and no review.author', { id: session.id, number: session.number });
    return submitted !== null;
  }

  // The label is for people to see at a glance. Anyone who can triage can change it, so the console and any merge rule
  // read the Merge risk check, never the label.
  async function setMergeRiskLabel(gh, number, tier) {
    const name = `merge risk: ${tier.toLowerCase()}`;
    await gh.ensureLabel({ name, color: MERGE_RISK_COLORS[tier], description: 'Set by the AI review' });
    for (const other of Object.keys(MERGE_RISK_COLORS)) {
      if (other === tier) continue;
      await gh.removeLabel(number, `merge risk: ${other.toLowerCase()}`).catch(() => false);
    }
    await gh.addLabel(number, name);
    return true;
  }

  /**
   * After an APPROVE, resolves the review's own open threads that are outdated or that the session found fixed, as the
   * Actions review does, so they block no merge. A person's thread, or an id the session made up, matches nothing.
   */
  async function resolveFixedThreads(session, gh, fixedIds) {
    const own = session.review.author;
    if (!own) return;
    const threads = await safely('review threads', () => gh.reviewThreads(session.number));
    if (!threads) return;
    const fixed = new Set(fixedIds);
    const mine = threads.filter((t) => !t.isResolved && sameAccount(t.author, own));
    const picked = mine.filter((t) => t.isOutdated || fixed.has(t.commentId));
    let resolved = 0;
    for (const t of picked) if (await safely('resolve review thread', () => gh.resolveThread(t.id))) resolved++;
    console.log('fleet: review threads resolved', {
      id: session.id, number: session.number, threads: threads.length, own: mine.length, outdated: mine.filter((t) => t.isOutdated).length,
      given: fixed.size, picked: picked.length, resolved,
    });
  }

  // A review session that stopped or failed before reporting (reviewFinished) would leave its comment saying it is
  // still reviewing. Checked once per run, on a tick.
  async function reviewEndedUnreported(session) {
    if (!isReview(session) || session.review.reported || session.review.endChecked) return;
    if (session.status !== 'stopped' && session.status !== 'failed') return;
    update(session, { review: { ...session.review, endChecked: true } });
    const reason = firstLine(session.stopReason ?? session.error ?? '') || 'it stopped without a report';
    console.log('fleet: review ended without a report', { id: session.id, number: session.number, reason });
    await postReviewEnded(session, projectFor(config, session), reason);
  }

  async function postReviewEnded(session, project, reason) {
    // Only a run that posted its own running comment: an older run's comment id may hold an earlier review.
    if (!session.review.runningPosted || !session.review.commentId) return;
    await postReviewComment(session, githubOf(project), reviewEndedComment({ reason, sessionUrl: await qaSessionUrl(session, project) }));
  }

  async function postReviewComment(session, gh, body) {
    const { commentId } = session.review;
    if (commentId && await safely('review comment', async () => { await gh.updateComment(commentId, body); return true; })) return;
    const posted = await safely('review comment', () => gh.comment(session.number, body));
    if (!posted) return;
    update(session, { review: { ...session.review, commentId: posted } });
    if (state.github) state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
    store.save();
  }

  /**
   * A session asked for a person in a `Needs a human:` comment on its issue or pull request (the webhooks Lambda queues
   * only the App's own). Its assignee is told in Slack, once for each comment. The console's own such comment, for a
   * pull request that gave up, already sent them a message.
   * @param {{number: number, commentId: number, url?: string|null, body?: string, project?: string}} message
   *   `project` names the project whose repo it is on: the default one when it names none
   */
  async function handleNeedsHuman({ number, commentId, url = null, body = '', project: projectName = null }) {
    if (String(body).includes(GAVE_UP_TEXT)) return { outcome: 'ignored', reason: 'the console\'s own comment, already messaged' };
    const project = projectOfEvent(projectName);
    const session = project && state.sessions
      .filter((s) => !s.owner && !isQa(s) && !isReview(s) && onProject(s, project) && (s.number === number || pullNumber(s.prUrl) === number)).at(-1);
    if (!session) {
      console.log('fleet: a Needs a human comment with no shared session on it', { number, ...(projectName ? { project: projectName } : {}) });
      return { outcome: 'ignored', reason: 'no shared session works on this issue or pull request' };
    }
    if (!claimComment(commentId)) return { outcome: 'duplicate', reason: 'already handled', sessionId: session.id };
    const sent = pings ? await safely('assignee message', () => pings.needsHuman(session, { number, url })) : null;
    console.log('fleet: a session asked for a person', { id: session.id, number, assignee: session.assignee ?? null, told: sent === true });
    return sent === true
      ? { outcome: 'sent', sessionId: session.id }
      : { outcome: 'ignored', sessionId: session.id, reason: session.assignee ? 'the assignee has no Slack link, or Slack refused' : 'the session has no assignee' };
  }

  function webhooksAlive() {
    webhooksAliveAt = now();
  }

  // While webhooks arrive, the poll is only a fallback for a lost delivery and runs every fallbackPollMs.
  function pollIsDue() {
    const webhooksUp = now() - webhooksAliveAt < WEBHOOKS_FRESH_MS;
    if (webhooksUp !== pollingSlowly) {
      pollingSlowly = webhooksUp;
      console.log('fleet: github poll interval changed', { webhooks: webhooksUp, everyMs: webhooksUp ? config.fallbackPollMs : config.pollMs });
    }
    return !webhooksUp || now() - lastPollAt >= config.fallbackPollMs;
  }

  // Each project's repo is polled on its own client: the default's cursors are `state.github`, as before projects, and
  // another's are `state.githubProjects` under its name. GitHub's comment ids are unique across repos, so the one seen
  // list in `state.github` serves them all. The default's name the repo they were read on: on a console that started
  // with no repo, removing the first one added makes the next the default, which must start from now, not from the old
  // repo's last event and replay its own labels. Cursors kept from before they named one are the environment's repo's.
  function cursorsOf(project) {
    if (project.default) {
      const kept = state.github;
      return kept && (!kept.repo || kept.repo.toLowerCase() === project.repo.toLowerCase()) ? kept : null;
    }
    const kept = state.githubProjects?.[project.name];
    return kept && kept.repo.toLowerCase() === project.repo.toLowerCase() ? kept : null;
  }

  // A removed repo's cursors go, so the same name on another repo, or the repo added again, starts from now.
  function dropGoneCursors(projects) {
    for (const name of Object.keys(state.githubProjects ?? {})) {
      const project = projects.find((p) => p.name === name && !p.default);
      if (project && cursorsOf(project)) continue;
      delete state.githubProjects[name];
      store.save();
      console.log('fleet: github cursors dropped, no longer a project', { project: name });
    }
  }

  // Only the project's own client: falling back to the default's would poll the default repo again under another name.
  function pollClientOf(project) {
    if (project.default) return github;
    const gh = githubFor?.(project) ?? null;
    if (!gh && !unpolledProjects.has(project.name)) {
      unpolledProjects.add(project.name);
      console.warn('fleet: project not polled, it has no GitHub client', { project: project.name });
    }
    return gh;
  }

  // The first poll of a repo only records where GitHub is, so a restart or a repo just added never replays history.
  async function startCursors(project, gh) {
    const startedAt = nowIso();
    const cursors = { lastEventId: await gh.latestEventId(), commentsSince: startedAt, notBefore: startedAt };
    // The comments already acted on stay seen: their ids are unique across repos.
    if (project.default) state.github = { repo: project.repo, ...cursors, seenComments: state.github?.seenComments ?? [] };
    else state.githubProjects = { ...state.githubProjects, [project.name]: { repo: project.repo, ...cursors } };
    store.save();
    console.log('fleet: github cursors initialised', { lastEventId: cursors.lastEventId, ...projectField(project) });
  }

  // One project failing leaves the others polled. The default project's failure is still the poll's own, as before
  // projects (`console: github poll failed`); another's is logged here with its project, once until its error changes
  // or it recovers, not every 30 seconds.
  async function pollGitHub() {
    const projects = allProjects(config);
    dropGoneCursors(projects);
    let failure = null;
    async function guarded(project, work) {
      try {
        await work();
        if (failingProjects.delete(project.name)) console.log('fleet: a project\'s github poll recovered', { project: project.name });
      } catch (err) {
        if (project.default) {
          failure ??= err;
          return;
        }
        const message = firstLine(err);
        if (failingProjects.get(project.name) === message) return;
        failingProjects.set(project.name, message);
        console.warn('fleet: a project\'s github poll failed', { project: project.name, message });
      }
    }
    const due = [];
    for (const project of projects) {
      const gh = pollClientOf(project);
      if (!gh) continue;
      if (cursorsOf(project)) due.push({ project, gh });
      else await guarded(project, () => startCursors(project, gh));
    }
    // Another project's comments are marked in the default's seen list, so they wait for it.
    if (state.github && due.length && pollIsDue()) {
      lastPollAt = now();
      for (const { project, gh } of due) await guarded(project, () => pollProject(project, gh, cursorsOf(project)));
    }
    if (failure) throw failure;
  }

  async function pollProject(project, gh, cursors) {
    const pollStartedAt = now();
    const on = project.default ? {} : { project: project.name };

    const { events, complete } = await gh.issueEventsSince(cursors.lastEventId);
    if (!complete) console.warn('fleet: more issue events than one poll reads, older ones skipped', { count: events.length, ...on });
    const own = triggersOf(project);
    for (const t of labelTriggers(events, { label: own.label, afterId: cursors.lastEventId })) {
      cursors.lastEventId = t.id;
      store.save();
      if (switchedOff({ trigger: 'label', number: t.number, login: t.login, ...on })) continue;
      if (!claimLabel(t.number, t.at, on.project ?? null)) {
        console.log('fleet: polled label already handled by a webhook', { number: t.number, ...on });
        continue;
      }
      const { at, ...rest } = t;
      await handleTrigger({ ...rest, trigger: 'label', ...on });
    }
    cursors.lastEventId = Math.max(cursors.lastEventId, ...events.map((e) => e.id));

    const comments = (await gh.commentsSince(cursors.commentsSince)) ?? [];
    // Oldest update first: a full page means newer comments wait for the next poll, from where this one stopped.
    const full = comments.length >= gh.pageSize;
    const triggers = commandTriggers(comments, { seen: new Set(state.github.seenComments), notBefore: cursors.notBefore });
    for (const t of triggers) {
      // Marked before handling, so a trigger that throws is logged once and not retried every 30 seconds.
      state.github.seenComments = rememberSeen(state.github.seenComments, [t.id]);
      store.save();
      if (switchedOff({ trigger: 'comment', number: t.number, login: t.login, ...on })) continue;
      await handleTrigger({ number: t.number, login: t.login, text: t.text, commentId: t.id, trigger: 'comment', ...on });
    }
    cursors.commentsSince = full
      ? comments.at(-1).updated_at
      : new Date(pollStartedAt - COMMENT_OVERLAP_MS).toISOString();
    store.save();
  }

  // The session's statusd runs the project file's `app.start`; the next status check says when the app is up, or down.
  // `app` picks one of several by name; without it statusd starts the default, as an image from before several apps
  // starts its one app whatever it is sent. `said` gets whether statusd took the start: it takes none while a stop
  // script runs, and says so with `started: false`; a switch to another app it queues behind the stop is taken.
  async function startApp(session, { app = null, said = {} } = {}) {
    if (session.status !== 'running' || !session.endpoint) throw Object.assign(new Error('the session is not running'), { notRunning: true });
    if (app !== null && !session.apps?.some((a) => a.name === app)) {
      throw Object.assign(new Error(session.apps ? `the project has no app named ${app}` : 'this session\'s image starts its one app only'), { refused: true });
    }
    const result = await statusd(session, 'POST', '/app/start', ...(app === null ? [] : [{ body: { app } }]));
    if (typeof result?.started === 'boolean') said.started = result.started;
    update(session, { app: APP_STATES.has(result?.app) ? result.app : 'starting', ...(app !== null && { appName: app }) });
    console.log('fleet: app start asked', { id: session.id, started: Boolean(result?.started), app: session.app, appName: session.appName ?? null });
    return session;
  }

  // A project file with no app leaves Start app nothing to run: Set up app asks the session's claude to write one, which
  // its statusd reads at the next Start app.
  async function setupApp(session) {
    if (session.status !== 'running' || !session.endpoint) throw Object.assign(new Error('the session is not running'), { notRunning: true });
    if (isAsk(session)) throw Object.assign(new Error('a question from Slack has no app'), { refused: true });
    if (session.app !== 'none') throw Object.assign(new Error('the project already has an app: Start app runs it'), { refused: true });
    const sent = await send(session, SETUP_APP_PROMPT);
    console.log('fleet: app setup asked', { id: session.id, sent });
    return { session, sent };
  }

  // A private session's claude is asked for /woodshed:remote-control, which signs in without leaving it
  // (session/bin/woodshed-login); an image from before that command types woodshed-login at the Terminal tab instead.
  // `where` is the tab the person pastes the code in.
  async function startClaudeLogin(session) {
    if (session.status !== 'running' || !session.endpoint) throw Object.assign(new Error('the session is not running'), { notRunning: true });
    if (!session.owner) throw Object.assign(new Error('only a My Woodshed session can sign in'), { notPrivate: true });
    // Remote Control would carry the session's screen to claude.ai: a session that has seen production data never has it.
    if (session.taintedAt) throw Object.assign(new Error('this session has seen production data, so Remote Control is off'), { notPrivate: true });
    const result = await statusd(session, 'POST', '/claude-login');
    const where = result?.where === 'agent' ? 'agent' : 'terminal';
    console.log('fleet: Claude login started', { id: session.id, where });
    return { session, where };
  }

  // `said` gets whether statusd ran a stop: none when the app has no stop command, or one already runs.
  async function stopApp(session, { said = {} } = {}) {
    if (session.status !== 'running' || !session.endpoint) throw Object.assign(new Error('the session is not running'), { notRunning: true });
    const result = await statusd(session, 'POST', '/app/stop');
    if (typeof result?.stopping === 'boolean') said.stopping = result.stopping;
    update(session, { app: APP_STATES.has(result?.app) ? result.app : 'stopping' });
    console.log('fleet: app stop asked', { id: session.id, stopping: Boolean(result?.stopping), app: session.app });
    return session;
  }

  return {
    noteMessage, noteQuestion, clearQuestion: (session) => answered(session, 'a message'),
    createSession, assign, releaseAssignments, startManual, startPrivate, handOffPrivate, taint, isLocked, onLocking, rename, regroup, allowAgent, extend, setLimits, limitsOf, pauseOf, resumePrivate, removePrivateSession, removePrivate, resumeShared, deleteShared, removeShared, forceStop, send, stop, startApp, stopApp, setupApp, startClaudeLogin, tick, checkStarting, checkWaiting, startStep, pollGitHub,
    handleTrigger, handleWebhookTrigger, handleQaLabel, qaAfterReview, qaAutoLabel, qaFinished, qaLog, qaVideo, qaPoster, publicQaVideo, reviewOnTag, reviewOnDemand, reviewFinished, handleNeedsHuman, webhooksAlive, pullsChanged, find,
    sessions: () => state.sessions,
    slackWaiting: () => announcer.waitingSessions(),
  };
}
