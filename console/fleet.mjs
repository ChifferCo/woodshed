// The console's engine: it turns GitHub triggers into sessions, starts them
// when a slot is free, keeps their status fresh from statusd, and stops them
// at their limits. A shared session that stopped keeps its conversation and
// databases, so it can be resumed, until its pull request has been merged or
// closed for a few days. Everything it talks to is passed in, so the tests can
// run it against fakes.

import { DEFAULT_CONSOLE_NAME } from './config.mjs';
import { DEFAULT_RETENTION, spanText } from './consoleSettings.mjs';
import { labelTriggers, commandTriggers, rememberSeen } from './github.mjs';
import { privateSessionHomeName, sharedHomeName } from './homes.mjs';
import { createIssueTracking } from './issueTracking.mjs';
import { createPrAnnouncer } from './prAnnouncer.mjs';
import { finishedComment, runningComment } from './qaSessions.mjs';
import { reviewVerdict } from './pullGates.mjs';
import { GAVE_UP_TEXT } from './prMessages.mjs';
import { allProjects, defaultProject, projectFor, projectNamed } from './projects.mjs';
import {
  ACTIVE_STATUSES, APP_STATES, activePrivateCount, isAsk, isQa, isReview, keptIds, newSessionId, newSessionToken, sessionLink,
  parseWorkOn, pullNumber, routeQa, routeTrigger, sessionOptions, sessionsToStart, statusUpdate, stopReason, waitProgressFrom, waitsForRetry,
} from './sessions.mjs';
import logins from './public/logins.cjs';
const { findLogin, sameLogin } = logins;

const CHECKPOINT_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 5_000;
// The quick look at a starting session: statusd answers at once on the same network, or is not up yet.
const STARTING_STATUS_TIMEOUT_MS = 1_500;
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

// What Set up app types into claude, on one line as a person would. The fields are docs/reference.md's, which is not in
// the session image, so they are named here.
export const SETUP_APP_PROMPT = 'Woodshed\'s Start app has nothing to run: .woodshed/project.yaml has no `app` section. '
  + 'Work out from this repo how its app runs in development, then add one: `start` (a command that starts the backend '
  + 'and the frontend in the background and returns once both answer), `stop`, `frontendPort` and `backendPort` (the '
  + 'same port twice for one server), `logs` (a name for each server\'s log file) and `howToProve` (how to check a '
  + 'change in the running app); `start`, both ports and `howToProve` are required. Write .woodshed/project.yaml '
  + 'with `version: 1` if there is none, and check it with `node /opt/woodshed/shared/project.mjs get app`. Run the '
  + 'start command yourself and check both ports answer, run the stop, then commit the file on this branch. Start app reads the file again, so tell me when to press it.';

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
  if (!res.ok) throw new Error(`statusd ${path} answered ${res.status}`);
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
export function startComment({ session, publicUrl, maxRunning, appDomain = '', linkQuery = null, consoleName = DEFAULT_CONSOLE_NAME }) {
  if (session.status === 'failed') return failedComment({ session, publicUrl, linkQuery, consoleName });
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
    ask = `An admin can turn on "Sessions from GitHub" for you on the console's People page${publicUrl ? `: ${publicUrl}/people` : '.'}`;
  } else {
    ask = `Ask an admin to add you to the console${publicUrl ? ` (${publicUrl})` : ''} and turn on "Sessions from GitHub" for you.`;
  }
  return [
    `@${login} can't start ${consoleName} sessions from GitHub yet, so nothing started${unlabeled ? ` and the \`${label}\` label was taken off` : ''}.`,
    '',
    ask,
  ].join('\n');
}

/**
 * The error itself stays in the console: a launch error can carry the session's tokens.
 * @param {{session: object, publicUrl: string|null}} args  `publicUrl`: null leaves out the link
 * @returns {string}
 */
export function failedComment({ session, publicUrl, linkQuery = null, consoleName = DEFAULT_CONSOLE_NAME }) {
  return [
    `The ${consoleName} session for @${session.startedBy} failed to start. The console shows why${publicUrl ? `: ${sessionLink(publicUrl, session.id, linkQuery)}` : '.'}`,
    '',
    `Add the \`woodshed\` label again, or comment \`/woodshed <message>\`, to try again.`,
  ].join('\n');
}

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
 */
export function createFleet({
  config, store, launcher, github, statusd = callStatusd, now = Date.now, databases = null, slack = null, homes = null,
  userSettings = null, people = null, autoName = null, attachments = null, members = null, pings = null,
  pullWebhooksFlowing = () => false, pullRequests = async () => null, databasesRefusal = async () => null, githubFor = null,
  consoleLinks = async () => true, newId = newSessionId, ownApp = () => null,
}) {
  const { state } = store;
  const nowIso = () => new Date(now()).toISOString();
  const secondsSince = (iso) => (iso ? Math.round((now() - Date.parse(iso)) / 1000) : null);
  const retention = () => config.retention ?? DEFAULT_RETENTION;
  const announcer = createPrAnnouncer({
    store, github, githubOf: (name) => githubOf(projectNamed(config, name) ?? defaultProject(config)), defaultProjectName: () => defaultProject(config).name, slack, gates: pullRequests, now, giveUpMs: () => retention().slackGiveUpMs, qaWaitMs: () => retention().qaWaitMs ?? DEFAULT_RETENTION.qaWaitMs,
    events: { dropped: prDropped, feedback: prFeedback, gaveUp: prGaveUp, mention: prMention },
    webhooksFlowing: pullWebhooksFlowing, fallbackMs: config.fallbackPollMs, ownApp,
  });
  const issueTracking = createIssueTracking({ github });
  const issueTrackings = new Map();
  const prCheckedAt = new Map();
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
  // Stops in flight in this process. A session left `stopping` by a restart has none, and tick finishes it.
  const stopsInFlight = new Set();
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

  function update(session, fields) {
    Object.assign(session, fields);
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
    if (session.options?.agent === 'codex') env.AGENT = 'codex';
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
    } else if (session.kind === 'pr') env.PR = String(session.number);
    else {
      if (session.kind === 'issue') env.ISSUE = String(session.number);
      env.BRANCH = session.branch;
    }
    if (session.prompt) env.PROMPT = session.prompt;
    // Claude opens with nothing to do: the person came to read the review, which the session starts itself.
    if (session.reviewOnly) env.REVIEW_ONLY = '1';
    return env;
  }

  // Decided at each start and resume, from whoever started the session: its token itself never leaves the console,
  // whose Anthropic proxy adds it to this session's calls alone.
  // Only a label or a /woodshed comment: GitHub says who that was, and checked their write access. And only where the
  // console makes the session's databases: the entrypoint asks the session API for its plan with them, so without
  // them claude would stay on the team key while the pages said otherwise.
  async function planFor(session) {
    if (session.owner || !GITHUB_TRIGGERS.has(session.trigger) || session.review?.teamKey || !databases?.available) return null;
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
    let started;
    try {
      // Copied while the container starts: the session waits for them at the session API before it writes its env.
      if (!session.owner && !isAsk(session) && !isReview(session) && databases?.available) await databases.createForSession(session.id);
      started = await launcher.start(session.id, sessionEnv(session));
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
   *          attach?: ((id: string) => Promise<number>)|null, background?: boolean, reviewOnly?: boolean,
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
  }) {
    refuseWithoutRepo(project, { kind, trigger });
    // A question from Slack, and a review that only reads the diff, get no databases, so they need none hosted.
    const refused = kind === 'ask' || review ? null : await databasesRefusal();
    if (refused) {
      console.warn('fleet: session refused, its databases are not hosted', { kind, number, trigger, why: refused });
      throw shown(`Not started: ${refused}`);
    }
    const id = newId();
    const attached = attach ? await attach(id) : 0;
    const defaultBranch = kind === 'issue' ? `woodshed/${number}-${id}` : kind === 'task' ? `woodshed/${owner}-${id}` : null;
    const session = {
      id, project: project.name, repo: project.repo, kind, number, title, startedBy, trigger, prompt, owner, options, resumeClaude, slack: thread,
      branch: branch || defaultBranch,
      status: 'queued', state: null, createdAt: nowIso(), startedAt: null, stoppedAt: null,
      lastActiveAt: null, checkedAt: null, stopReason: null, error: null,
      head: null, prUrl: null, lastMessage: null, commentId: null,
      token: newSessionToken(), terminalToken: newSessionToken(), ref: null, endpoint: null, pendingMessages: [],
      ...(attached ? { attachments: attached } : {}),
      ...(reviewOnly ? { reviewOnly: true } : {}),
      ...(qa ? { qa } : {}),
      ...(review ? { review } : {}),
      ...(assignTo ? { assignee: assignTo.login, assignedBy: assignTo.login, assignedHow: assignTo.how, assignedAt: nowIso() } : {}),
    };
    state.sessions.push(session);
    store.save();
    console.log('fleet: session created', {
      id, kind, number, trigger, startedBy, private: Boolean(owner), resumed: Boolean(branch), background, assignee: session.assignee ?? null, qa: Boolean(qa),
      ...(project.default ? {} : { project: project.name, repo: project.repo }),
    });
    await runStartQueued({ background });
    return session;
  }

  function hold(session, text) {
    update(session, { pendingMessages: [...session.pendingMessages, text] });
    console.log('fleet: message held until claude is open', { id: session.id, pending: session.pendingMessages.length });
  }

  function canType(session) {
    // While claude opens the pane holds a shell, which would run the text as a command.
    return session.status === 'running' && session.state && session.state !== 'not-running' && session.state !== 'starting';
  }

  /** @returns {Promise<'sent'|'queued'>} */
  async function send(session, text) {
    if (!canType(session)) {
      hold(session, text);
      return 'queued';
    }
    try {
      await statusd(session, 'POST', '/send', { body: { text } });
    } catch (err) {
      console.warn('fleet: send failed, holding the message', { id: session.id, message: firstLine(err) });
      hold(session, text);
      return 'queued';
    }
    console.log('fleet: message sent', { id: session.id, chars: text.length });
    return 'sent';
  }

  async function deliverHeld(session) {
    while (session.pendingMessages.length && canType(session)) {
      const [text, ...rest] = session.pendingMessages;
      try {
        await statusd(session, 'POST', '/send', { body: { text } });
      } catch (err) {
        console.warn('fleet: held message not delivered yet', { id: session.id, message: firstLine(err) });
        return;
      }
      update(session, { pendingMessages: rest });
      console.log('fleet: held message sent', { id: session.id, chars: text.length, left: rest.length });
    }
  }

  async function stop(session, reason, { by = null } = {}) {
    if (session.status === 'queued' || (session.status === 'starting' && !session.ref)) {
      // A start the console lost track of, e.g. across a restart, may still have made a container.
      if (session.status === 'starting') await launcher.stop(launcher.refFor(session.id));
      update(session, { status: 'stopped', stoppedAt: nowIso(), stopReason: reason, stoppedBy: by });
      console.log('fleet: session stopped before it ran', { id: session.id, reason, by });
      return;
    }
    if (session.status !== 'starting' && session.status !== 'running') return;
    update(session, { status: 'stopping', stoppingAt: nowIso(), stopReason: reason, stoppedBy: by });
    console.log('fleet: stopping session', { id: session.id, reason, by });
    stopsInFlight.add(session.id);
    try {
      await checkpointAndRemove(session);
    } finally {
      stopsInFlight.delete(session.id);
    }
    await startQueued();
  }

  async function checkpointAndRemove(session) {
    if (session.endpoint) {
      try {
        const result = await statusd(session, 'POST', '/checkpoint', { timeoutMs: CHECKPOINT_TIMEOUT_MS });
        console.log('fleet: checkpoint pushed', { id: session.id, committed: result?.committed, head: result?.head });
      } catch (err) {
        console.warn('fleet: checkpoint failed, stopping anyway', { id: session.id, message: firstLine(err) });
      }
    }
    await launcher.stop(session.ref);
    update(session, { status: 'stopped', stoppedAt: nowIso(), endpoint: null, ...keptFields(session) });
  }

  // A shared session that ran keeps its conversation and databases once stopped, however it stopped.
  function keptFields(session) {
    return session.owner || isQa(session) ? {} : { kept: true };
  }

  async function finishInterruptedStop(session) {
    console.log('fleet: finishing a stop the last run did not', { id: session.id });
    await launcher.stop(session.ref);
    update(session, { status: 'stopped', stoppedAt: nowIso(), endpoint: null, ...keptFields(session) });
  }

  async function containerGone(session) {
    const tail = await launcher.logTail(session.ref);
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
    const body = failedComment({ session, publicUrl: await consoleUrlOf(project), linkQuery: config.linkQuery, consoleName: config.consoleName });
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
        return;
      }
      const wasStarting = session.status === 'starting';
      const wasAsking = session.state === 'needs-you';
      update(session, statusUpdate(session, status, nowIso()));
      // Once each time it starts to ask: a session still asking on the next read is not told about again.
      if (!wasAsking && session.state === 'needs-you' && pings) await safely('assignee message', () => pings.needsYou(session));
      if (wasStarting) console.log('fleet: session running', { id: session.id, branch: session.branch, seconds: secondsSince(session.startedAt) });
      await deliverHeld(session);
      await announcePull(session);
    } finally {
      readingStatus.delete(session.id);
    }
  }

  // Shared sessions only: a My Woodshed session's work is its owner's own. A GitHub that cannot be read is tried
  // again on the next tick. Each pull request a session reports is tracked once, so a session that closes its
  // pull request and opens another from a new branch gets the new one posted too.
  async function announcePull(session) {
    if (!announcer.available || session.owner || !session.prUrl || session.announcedPrUrl === session.prUrl) return;
    const project = projectFor(config, session);
    if (!announcer.postsFor(project)) return;
    const tracked = await safely('pull request read for Slack', async () => {
      await announcer.track(session, project);
      return true;
    });
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

  // Every couple of seconds, a starting session's statusd alone, so its page turns to the terminal as soon as claude
  // opens rather than on the next tick. Whether the task is alive is left to the tick: that is an aws call.
  async function checkStarting() {
    if (checkingStarts) return;
    checkingStarts = true;
    try {
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
          // A private session runs on its owner's own idle and lifetime, where they set them on My settings.
          const own = session.owner ? userSettings?.limitsFor(session.owner) : null;
          const reason = stopReason(session, now(), own ? { ...config.limits, ...own } : config.limits);
          if (reason) await stop(session, reason);
        } catch (err) {
          console.error('fleet: session check failed', { id: session.id, message: firstLine(err) });
        }
      }
      await startQueued();
      for (const session of [...state.sessions]) await safely('retention check', () => retain(session));
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
  function dropIfDue(session) {
    if (session.homeDeletePending || (isAsk(session) && !session.noticedAt)) return;
    const from = Date.parse(session.cleanedAt ?? session.stoppedAt ?? session.createdAt);
    const ms = retention().removeAfterDeleteMs ?? DEFAULT_RETENTION.removeAfterDeleteMs;
    if (!Number.isFinite(from) || now() < from + ms) return;
    dropRecord(session, `deleted ${spanText(ms)} ago`);
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

  // A review asking for changes, an approval's notes, or a suite that failed or was skipped: typed into the session,
  // or resumed with it. True when the session was told.
  async function prFeedback(item, text) {
    const session = find(item.sessionId);
    if (!session || session.owner) return false;
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
    return { kind: isPr ? 'pr' : 'issue', number: on.number, title: issue.title, branch: isPr ? (await repoGitHub.pull(on.number)).head.ref : null };
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
   * New session on My Woodshed: a session private to `owner`, on their own Claude token. The console posts no comment
   * or reaction; the session itself still pushes its branch and opens a PR, as any session does.
   * @param {{owner: string, prompt: string, name?: string, workOn?: string, model?: string, effort?: string,
   *          permissionMode?: string, background?: boolean}} args  `workOn` is the form's optional issue, pull request or branch
   */
  async function startPrivate({ owner, prompt, name = '', workOn = '', attachmentIds = [], background = false, project = defaultProject(config), ...picked }) {
    refuseWithoutRepo(project, { kind: 'task', trigger: 'my-woodshed' });
    const on = parseWorkOn(workOn, { defaultBranch: await githubOf(project).defaultBranch?.() ?? null });
    const reviewOnly = !String(prompt ?? '').trim() && on.kind !== 'task';
    const text = String(prompt ?? '').trim();
    const agentName = picked.agent === 'codex' ? 'Codex' : 'Claude';
    if (!text && !reviewOnly) throw shown(`say what ${agentName} should do`);
    const options = sessionOptions(picked);
    logIfInLine(owner);
    const target = await targetFor(on, project);
    if (reviewOnly && target.kind === 'issue') throw shown(`say what ${agentName} should do`);
    if (reviewOnly) console.log('fleet: private session starts as a review, no prompt given', { owner, on: on.kind });
    // With no prompt there is nothing for Haiku to name from, so a branch is named for itself.
    const given = String(name ?? '').trim().slice(0, TITLE_CHARS) || target.title || (reviewOnly ? `Review ${target.branch}` : '');
    const naming = given ? null : autoName?.(text);
    const attach = attachments && attachmentIds?.length ? (sessionId) => attachments.claim({ login: owner, ids: attachmentIds, sessionId }) : null;
    const session = await createSession({
      ...target, title: given || titleFrom(text), startedBy: owner, owner, trigger: 'my-woodshed', prompt: text, options, attach, background, reviewOnly, project,
    });
    if (naming) renameWhenNamed(session, naming);
    return session;
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
  // gave it on the rail meanwhile is theirs to keep.
  function renameWhenNamed(session, naming) {
    const startedAs = session.title;
    naming.then((name) => {
      if (!name || !find(session.id) || session.title !== startedAs) return;
      update(session, { title: name });
      console.log('fleet: session named', { id: session.id });
    }).catch((err) => console.warn('fleet: session not renamed', { id: session.id, message: firstLine(err) }));
  }

  /**
   * Resume on a stopped private session: the same session runs again, with its page, branch and options, and claude
   * reopens its conversation from the Claude home it saved. Its prompt starts again when there is no conversation to
   * reopen, such as one that never reached claude.
   * @param {{owner: string, id: string, background?: boolean}} args
   */
  async function resumePrivate({ owner, id, background = false }) {
    const session = find(id);
    if (!session || session.owner !== owner) throw shown('no session you can open with that id');
    if (ACTIVE_STATUSES.has(session.status)) throw shown('that session is still running');
    logIfInLine(owner);
    update(session, {
      status: 'queued', state: null, startedAt: null, stoppedAt: null, stopReason: null, stoppedBy: null, error: null, ref: null,
      endpoint: null, startSteps: null, token: newSessionToken(), terminalToken: newSessionToken(), resumeClaude: session.claudeSession ?? null,
      lastActiveAt: null, checkedAt: null, app: null, appServers: null, appName: null, apps: null, resumedAt: nowIso(), resumedBy: owner, queuedAt: nowIso(),
    });
    console.log('fleet: resuming a private session', { id, owner, claudeSession: Boolean(session.resumeClaude), background });
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
  async function forgetPrivateData(session) {
    await dropAttachments(session);
    if (!homes) return;
    await homes.remove(privateSessionHomeName(session.owner, session.id)).catch((err) => {
      console.warn('fleet: private session\'s Claude home not deleted', { id: session.id, message: firstLine(err) });
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
    if (members && !members.hasGithubSessions(login)) return refuseFromGitHub(trigger, gh, project);
    if (route.action === 'send') {
      await send(find(route.sessionId), trigger.text);
      takeIfUnassigned(find(route.sessionId), login, trigger.trigger);
      await safely('reaction', () => gh.reactToComment(commentId));
      return { outcome: 'sent', sessionId: route.sessionId };
    }
    if (route.action === 'resume') return resumeFromGitHub(find(route.sessionId), trigger, gh);
    const refused = await databasesRefusal();
    if (refused) return refuseForDatabases(trigger, refused, gh);
    const session = await startFromGitHub({ ...trigger, resumeBranch: route.resumeBranch, project });
    return { outcome: 'started', sessionId: session.id };
  }

  // The project file needs a database engine this installation does not host: said once on the issue, as a refusal.
  async function refuseForDatabases({ number, login, trigger }, why, gh = github) {
    console.warn('fleet: trigger refused, its databases are not hosted', { number, login, trigger, why });
    const posted = await safely('refusal comment', () => gh.comment(number, `${config.consoleName || DEFAULT_CONSOLE_NAME} cannot start a session here: ${why}.`));
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
    const unlabeled = trigger === 'label' ? await safely('label removal', () => gh.removeLabel(number, config.label)) : null;
    const body = refusalComment({ login, label: config.label, unlabeled: Boolean(unlabeled), member, publicUrl: await consoleUrlOf(project), consoleName: config.consoleName });
    const posted = await safely('refusal comment', () => gh.comment(number, body));
    if (posted && state.github) {
      state.github.seenComments = rememberSeen(state.github.seenComments, [posted]);
      store.save();
    }
    return { outcome: 'ignored', reason: `@${login} has no sessions from GitHub` };
  }

  // A resume leaves who has the session as it was, assigned or not.
  async function resumeFromGitHub(session, { number, login, trigger, text, commentId }, gh = github) {
    const message = text || `Carry on with ${session.kind === 'pr' ? 'PR ' : ''}#${session.number}: the ${config.label} label was added again.`;
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
    const verdict = reviewVerdict(await gh.reviews(number), gates.review);
    if (verdict?.state !== 'APPROVED' || verdict.commit_id !== pull.head.sha) return { unrecorded: true };
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
    if (!(await gh.canWrite(login))) return ignored('no write access to the repo');
    if (people && !(await people.check(login))) return ignored('the GitHub name was another account\'s when last used here');
    if (members && !members.hasGithubSessions(login)) return ignored(`${login} cannot start sessions from GitHub`);
    const route = routeQa({ sessions: state.sessions.filter((s) => onProject(s, project)), number });
    if (route.action === 'ignore') return ignored(route.reason);
    const pull = known ?? await gh.pull(number);
    if (pull.state !== 'open') return ignored('the pull request is not open');
    if (gates.review) {
      const verdict = reviewVerdict(await gh.reviews(number), gates.review);
      if (verdict?.state !== 'APPROVED' || verdict.commit_id !== pull.head.sha) {
        await safely('QA waiting check', () => gh.createCheckRun({
          sha: pull.head.sha, name: qa.check, conclusion: 'neutral', title: 'Waiting for the review to approve this commit',
          summary: 'QA runs here once the review approves the pull request\'s latest commit.',
        }));
        console.log('fleet: QA waiting for the review', { number, login, verdict: verdict?.state ?? null, ...projectField(project) });
        return { outcome: 'waiting', reason: 'the review has not approved the latest commit' };
      }
    }
    const refused = await databasesRefusal();
    if (refused) return ignored(refused);
    // One QA comment per pull request: a later run writes over the last one's.
    const commentId = state.sessions.filter((s) => isQa(s) && s.number === number && onProject(s, project) && s.qa.commentId).at(-1)?.qa.commentId ?? null;
    const session = await createSession({
      kind: 'pr', number, title: `QA: ${pull.title}`, startedBy: login, trigger: 'qa', branch: pull.head.ref, project,
      qa: { base: pull.base.ref, sha: pull.head.sha, heading: qa.heading, check: qa.check, commentId },
    });
    await postQaComment(session, gh, runningComment({ heading: qa.heading, sessionUrl: await qaSessionUrl(session, project) }));
    console.log('fleet: QA session started', { id: session.id, number, login, why, base: pull.base.ref, ...projectField(project) });
    return { outcome: 'started', sessionId: session.id };
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
   * A QA session's report (POST /qa-report): written into the pull request's QA comment, then the session stops.
   * @param {object} session
   * @param {{verdict: {conclusion: string, title: string, status: string, total: number}, report: string, sha: string,
   *   costUsd: number|null}} result  from parseQaReport
   */
  async function qaFinished(session, { verdict, report, sha, costUsd }) {
    const project = projectFor(config, session);
    const gh = githubOf(project);
    const sessionUrl = await qaSessionUrl(session, project);
    await postQaComment(session, gh, finishedComment({ heading: session.qa.heading, verdict, report, sessionUrl }));
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
    // In the background: the session waits on this reply, and the stop saves its home through it first.
    stop(session, `QA finished: ${verdict.title}`)
      .catch((err) => console.warn('fleet: stopping a finished QA session failed', { id: session.id, message: firstLine(err) }))
      // A commit the review approved while this one ran was turned away as already running: it runs now.
      .then(() => safely('QA of a commit approved meanwhile', () => qaAfterReview({ number: session.number, project: project.name })));
  }

  /**
   * A pull request whose review runs in a session (pullRequests.review.runner: woodshed): when its head commit carries
   * the review's rerun tag and no session has reviewed that commit, a review session starts, as the pull request's
   * author. Once for each commit. Cheap to call on any pull request change: it returns early unless the runner is
   * `woodshed`.
   * @param {{number: number, project?: string|null}} args
   */
  async function reviewOnTag({ number, project: projectName = null }) {
    const project = projectOfEvent(projectName);
    const gates = project ? await pullRequests(project.name) : null;
    const review = gates?.review;
    if (!review || review.runner !== 'woodshed') return { unrecorded: true };
    const gh = githubOf(project);
    const pull = await gh.pull(number);
    if (pull.state !== 'open' || pull.draft) return { unrecorded: true };
    if (state.sessions.some((s) => isReview(s) && s.number === number && onProject(s, project) && s.review.sha === pull.head.sha)) return { unrecorded: true };
    if (review.rerun) {
      const message = await safely('review head commit', () => gh.commitMessage(pull.head.sha));
      if (!message || !message.includes(review.rerun)) return { unrecorded: true };
    }
    return startReview({ project, gates, number, login: pull.user?.login ?? '', pull });
  }

  // The review runs as a session (pullRequests.review.runner: woodshed) instead of the Actions workflow: the
  // `[woodshed-review]` tag on the head commit starts it, session/review.sh runs the review, and the console submits
  // the verdict and the Merge risk check here (reviewFinished), as its own App. One review session per commit.
  async function startReview({ project, gates, number, login, pull: known = null }) {
    const { review, mergeRisk } = gates;
    const gh = githubOf(project);
    const ignored = (reason) => {
      console.log('fleet: review not started', { number, login, reason, ...projectField(project) });
      return { outcome: 'ignored', reason };
    };
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
    const session = await createSession({
      kind: 'pr', number, title: `Review: ${pull.title}`, startedBy: login, trigger: 'review', branch: pull.head.ref, project,
      review: { base: pull.base.ref, sha: pull.head.sha, heading: review.heading, check: mergeRisk?.check ?? null, commentId, ...(teamKeyWhy ? { teamKey: true } : {}) },
    });
    console.log('fleet: review session started', { id: session.id, number, login, base: pull.base.ref, ...projectField(project) });
    return { outcome: 'started', sessionId: session.id };
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
   * @param {{conclusion: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT'|null, summary: string, comment: string,
   *   mergeRisk: {tier: string|null, reason: string, summary: string}, sha: string, costUsd: number|null}} result
   */
  async function reviewFinished(session, { conclusion, summary, comment, mergeRisk, sha, costUsd }) {
    const project = projectFor(config, session);
    const gh = githubOf(project);
    const ours = conclusion ? await submitReview(session, gh, { conclusion, summary, comment, mergeRisk, sha }) : false;
    if (!conclusion) console.warn('fleet: review session wrote no verdict, nothing submitted', { id: session.id, number: session.number });
    update(session, { review: { ...session.review, conclusion, reported: true, reviewedSha: sha, costUsd } });
    console.log('fleet: review finished', { id: session.id, number: session.number, conclusion, tier: mergeRisk?.tier ?? null, costUsd, posted: ours });
    stop(session, conclusion ? `Review finished: ${conclusion}` : 'Review finished without a verdict')
      .catch((err) => console.warn('fleet: stopping a finished review session failed', { id: session.id, message: firstLine(err) }));
  }

  // Only submits when the reviewed commit is still the head: a push since makes the review stale, so it is dropped
  // rather than approving the wrong commit. The verdict starts with the project file's heading, which the gate looks for.
  async function submitReview(session, gh, { conclusion, summary, comment, mergeRisk, sha }) {
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
    const body = `${session.review.heading} — ${conclusion}\n\n${summary}`.trim();
    await safely('review verdict', () => gh.createReview(session.number, { event: conclusion, body, sha }));
    if (session.review.check && mergeRisk?.tier) {
      await safely('Merge risk check', () => gh.createCheckRun({
        sha, name: session.review.check, conclusion: 'neutral', title: `${mergeRisk.tier}: ${mergeRisk.reason}`.slice(0, 250),
        summary: `Set by the AI review.\n\n${mergeRisk.summary}`.trim(), externalId: session.id,
      }));
    }
    return true;
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
      .filter((s) => !s.owner && !isQa(s) && onProject(s, project) && (s.number === number || pullNumber(s.prUrl) === number)).at(-1);
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
    for (const t of labelTriggers(events, { label: config.label, afterId: cursors.lastEventId })) {
      cursors.lastEventId = t.id;
      store.save();
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
      await handleTrigger({ number: t.number, login: t.login, text: t.text, commentId: t.id, trigger: 'comment', ...on });
    }
    cursors.commentsSince = full
      ? comments.at(-1).updated_at
      : new Date(pollStartedAt - COMMENT_OVERLAP_MS).toISOString();
    store.save();
  }

  // The session's statusd runs the project file's `app.start`; the next status check says when the app is up, or down.
  // `app` picks one of several by name; without it statusd starts the default, as an image from before several apps
  // starts its one app whatever it is sent.
  async function startApp(session, { app = null } = {}) {
    if (session.status !== 'running' || !session.endpoint) throw Object.assign(new Error('the session is not running'), { notRunning: true });
    if (app !== null && !session.apps?.some((a) => a.name === app)) {
      throw Object.assign(new Error(session.apps ? `the project has no app named ${app}` : 'this session\'s image starts its one app only'), { refused: true });
    }
    const result = await statusd(session, 'POST', '/app/start', ...(app === null ? [] : [{ body: { app } }]));
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
    const result = await statusd(session, 'POST', '/claude-login');
    const where = result?.where === 'agent' ? 'agent' : 'terminal';
    console.log('fleet: Claude login started', { id: session.id, where });
    return { session, where };
  }

  async function stopApp(session) {
    if (session.status !== 'running' || !session.endpoint) throw Object.assign(new Error('the session is not running'), { notRunning: true });
    const result = await statusd(session, 'POST', '/app/stop');
    update(session, { app: APP_STATES.has(result?.app) ? result.app : 'stopping' });
    console.log('fleet: app stop asked', { id: session.id, stopping: Boolean(result?.stopping), app: session.app });
    return session;
  }

  return {
    createSession, assign, releaseAssignments, startManual, startPrivate, rename, resumePrivate, removePrivateSession, removePrivate, resumeShared, deleteShared, removeShared, forceStop, send, stop, startApp, stopApp, setupApp, startClaudeLogin, tick, checkStarting, checkWaiting, startStep, pollGitHub,
    handleTrigger, handleWebhookTrigger, handleQaLabel, qaAfterReview, qaFinished, reviewOnTag, reviewFinished, handleNeedsHuman, webhooksAlive, pullsChanged, find,
    sessions: () => state.sessions,
    slackWaiting: () => announcer.waitingSessions(),
  };
}
