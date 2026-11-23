// `woodshed session`: start, list, stop, resume and remove Woodshed sessions from the command line, through the
// console's own session routes, signed in with the command line's token (console/cliSessions.mjs lists the routes it
// reaches). A session started here is a private one, as My Woodshed's New session starts.
//
//   woodshed session new [--repo R] [--branch B] [--agent claude|codex|grok|opencode] [--model M] [--no-wait|--connect|--herdr [--parent[=T]]] ["prompt"]
//   woodshed session connect <id> [--shell]
//   woodshed session herdr <id> [--parent[=T]]
//   woodshed session list [--all]
//   woodshed session get <id>
//   woodshed session app <id> [start [--app <name>] [--no-wait]|stop]
//   woodshed session app <id> share [--members on|off | --link [--hours 1|24|168] [--path /page] | --revoke <link id>]
//   woodshed session stop <id>
//   woodshed session resume <id> [--no-wait|--herdr]
//   woodshed session remove <id> [--yes]
//   woodshed session prune
//   woodshed session extend <id>
//   woodshed session limits <id> [--idle-hours <n>|default] [--lifetime-hours <n>|default]
//   woodshed session watch [--kind review,qa,...] [--everyone] [--every <seconds>] [--herdr] [--add]
//
// list, get and watch name each session's kind: your own private one, a shared one, a review or QA run the console
// started on a pull request (pullRequests.review or .qa with runner: woodshed), or a question from Slack. A review's
// or QA's pull request is named, and `inMine` is the console's rail's Mine (console/public/common.js, inMine).
// watch follows the console's list and prints one event per session that starts, runs, is done with its turn, needs its
// person, pauses, stops, finishes or fails (watch.mjs), for a Herdr mod or a script to turn into notifications. A session
// of yours that is a machine in Herdr is said to be unreachable when it pauses or stops, until `session herdr` brings it
// back. --herdr runs the watch in a terminal of hc's own that reports each session as an OSC 7501 record, so Herdr tells
// of them as of its own agents without any session being opened as a machine. --add also adds each of your own private
// sessions to Herdr as `session herdr` does, as it starts running or resumes, wherever it was started (the console's
// page, Slack, an agent in another session): `woodshed setup --terminal herdr` starts the watch so.
//
// Inside a Woodshed session (hc.mjs, sessionHere), hc is that session's own Herdr core: a machine added there is nested in
// a machine, which the person's computer's Herdr never shows. So there nothing is added to Herdr: herdr, --herdr and
// watch --add say that the person's computer adds it, and --parent, whose parent would be a terminal in that core, is
// refused.
//
// Nothing here keeps a session awake: it pauses when idle and stops at its lifetime, as its limits say, unless its
// person (or their agent) asks for more time with extend or limits. list and get say when each will.
//
// app says whether the session's app runs and where it opens, and starts or stops it, as the page's Open app, Start app
// and Stop app do. Set up app, which asks the session's agent to write the project file's app, stays on the page.
// app's share says who besides you may open your private session's app, and changes it, as the page's Share the app does:
// every member of the console (one switch), or a link anyone can open, until it expires, is revoked or the session stops.
//
// connect puts this terminal on one of your sessions' (terminal.mjs): its agent's, or with --shell the Terminal tab's
// shell, resuming it first when it paused.
// herdr makes one of your sessions a machine in Herdr's hc, `woodshed-<id>`, reached through `woodshed tunnel` (hc.mjs),
// resuming it first when it paused; remove forgets that machine too. A session removed elsewhere (the console's page, or
// the console cleaning it up) leaves its machine behind, unreachable: list says so, and prune forgets those. With
// --parent the session's agent's terminal is made from here, a child of a terminal of this computer's (hc's `run --on`
// from that terminal), so an agent there can `hc wait --children` on it: the session, started or resumed with
// herdrParent, waits for it rather than make its own.

import {
  HC_MINIMUM, WATCH_SPACE, WATCH_TERMINAL, addMachine, agentOn, hcVersion, leftoverMachines, machineName, nameAgentPlace, parentTerminal, removeMachine,
  sessionHere, shellQuote, startAgentTerminal, startWatcher, tunnelMachines,
} from './hc.mjs';
import { changes, eventDetail, herdrClear, herdrRecord, parseEvery, parseKinds, unreachableText } from './watch.mjs';
import agents from '../shared/agents.cjs';

const { AGENT_IDS, agentOfSession, agent: agentInfo } = agents;

// Set in the environment of the watch --herdr starts in hc: that copy reports, rather than starting another.
export const WATCH_IN_HERDR = 'WOODSHED_WATCH_IN_HERDR';
// How long an ended session's record stays on the watch's terminal in Herdr.
const RECORD_KEEP_MS = 3_600_000;

// A terminal whose connection dropped is opened again for this long, waiting a little longer each time.
const RECONNECT_GIVE_UP_MS = 60_000;
const RECONNECT_WAITS_MS = [500, 1000, 2000, 4000, 8000];
// A connection that lasted less than this before it dropped counts as no connection: the minute goes on from the first
// drop, so one that opens and drops at once again and again is not tried for ever.
const RECONNECT_HELD_MS = 10_000;

// How often a start's wait reads the list, and how long it keeps trying through a console it cannot reach.
const POLL_MS = 2000;
// A stop answers once the session's work is pushed and its container gone: its checkpoint alone may take 90 s.
const STOP_DEADLINE_MS = 180_000;
// How many reads `watch --add` tries to add a session to Herdr before it says to add it by hand.
const ADD_TRIES = 3;
const UNREACHABLE_GIVE_UP_MS = 60_000;

export const SESSION_USAGE = `Usage: woodshed session <command> [--console <url>] [--json]

Commands:
  new [options] ["prompt"]   start a private session, and wait until it runs, fails or needs you
      --repo <owner/name>    the repo to work on (default: the one New session opens on for you)
      --branch <branch>      work on this branch, or a pull request or issue: 123, pr 123, or its URL
      --agent <agent>        the agent it runs: claude, codex, grok, opencode (default claude). Grok Build and
                             OpenCode run on your own sign-in from My settings
      --model <model>        the agent's model (default the agent's own)
      --no-wait              print the session and return once the console has it
      --connect              once it runs, put this terminal on its agent's, as connect does
      --herdr                once it runs, add it to Herdr as herdr does. Inside a Woodshed session nothing is added:
                             your computer adds it (herdr there, or watch --herdr --add)
      --parent[=<t>]         with --herdr: make its agent's terminal a child of a terminal here, this one (HC_TERMINAL_ID)
                             or <t>, so it can hc wait --children on it; run it from a Herdr terminal. The agent starts
                             as Woodshed starts it, in Herdr whatever My settings says, and outlives its parent
      --no-notify            with --parent: Herdr types no notes about the agent into its parent
      --end-with-parent      with --parent: the agent ends when its parent's program does (hc's own default)
  connect <id> [--shell]     put this terminal on one of your sessions' agent (the console's TUI tab), or with --shell
                             its shell (the Terminal tab); a paused one is resumed first. Ctrl-\\ disconnects, and the
                             session goes on
  herdr <id>                 make one of your sessions a machine in Herdr (hc ${HC_MINIMUM} or newer), woodshed-<id>,
                             reached through woodshed tunnel; a paused one is resumed first, and waited for. Run on
                             your computer: inside a Woodshed session it adds nothing and says so (exit 3)
      --parent[=<t>]         resume it with its agent's terminal a child of a terminal here, as new's --parent does
      --no-notify            (and --no-notify, --end-with-parent as there). A running session's terminal is there
      --end-with-parent      already, with no parent, and hc gives a terminal its parent only as it starts: only one
                             still waiting for its terminal (started with --parent) takes one
  list [--all]               your sessions and the shared ones you can see, with their state, kind (private,
                             shared, a review or QA of a pull request, ask) and when each pauses or stops by
                             itself; --all also lists those that ended
  get <id>                   one session: its state, kind, branch, pull request, its app, and when it pauses or stops
  app <id> [start|stop]      whether a running session's app is up, and its link to open in a browser; start starts
                             it (one to three minutes) and waits until it is up, stop stops it
      --app <name>           start this one of the project's apps, where it has several
      --no-wait              return once the session has been asked to start it
  app <id> share [option]    who besides you can open your session's app: the members switch and the live links,
                             as the page's Share the app shows them (never a link's secret). One option at a time:
      --members on|off       every member signed in to the console may open it, or no longer
      --link                 make a link anyone can open, printed once: a secret until it expires, is revoked, or
                             the session pauses or stops
      --hours 1|24|168       with --link: how long it lasts (default 24)
      --path </page>         with --link: the app's page it lands on, such as /landing-a (default its home)
      --revoke <link id>     end one link at once
  stop <id>                  stop a session; a running one's work is pushed as it stops
  resume <id> [--no-wait]    start one of your stopped sessions again, its conversation and all, and wait for it
      --herdr                once it runs, add it to Herdr again as herdr does (not inside a Woodshed session)
  remove <id> [--yes]        take one of your sessions off the list, with its saved conversation (stopped first),
                             and forget its machine in Herdr
  prune                      forget the woodshed-<id> machines in Herdr whose session is no longer on this console
                             (removed on the page, or cleaned up); paused and stopped sessions' machines stay
  extend <id>                put its pause or stop off by an hour; the console allows it in the last 15 minutes
  limits <id> [options]      its own idle pause and lifetime, in place of yours or the console's
      --idle-hours <n>       pause after this many hours with nothing to do; default goes back to yours
      --lifetime-hours <n>   stop this many hours after it started; default goes back to yours
                             A running session is never kept awake by a terminal or a tunnel: extend or limits
                             is how you, or your agent, ask for more time.
  watch [options]            follow the console and print one line per session that starts, runs, is done with its
                             turn, needs you, pauses, stops, finishes or fails, until stopped (Ctrl-C); with --json
                             one event per line. Opens no session: a machine in Herdr is only said to be unreachable
      --kind <kinds>         only these, separated by commas: private, shared, review, qa, ask (default all)
      --everyone             every session you can see, not only Mine (yours, and those you started or have)
      --every <seconds>      how often it asks the console (default 15, at least 5)
      --herdr                run it in Herdr instead, in hc terminal ${WATCH_TERMINAL}, which reports each session's
                             state as Herdr's own agents report theirs (OSC 7501), and return
      --add                  also add each of your own private sessions to Herdr as herdr does, as it starts running
                             or resumes, wherever it was started; never a shared one, a review, QA run or question, one
                             that saw production, or one already connected, and never resumes one to add it. Run on
                             your computer: inside a Woodshed session it is refused (exit 3)

Exit codes: 0 done, 2 waiting on a person (sign in, a session that needs you, a confirmation), 3 refused, 1 anything else.`;

// A session's start, in the order the console's page lists its steps (console/public/common.js, START_STEPS). The
// first three are the launcher's, named here for any provider.
const START_STEPS = [
  ['machine', 'Getting a machine'],
  ['pullStarted', 'Waiting for the machine to start'],
  ['container', 'Starting the container'],
  ['settings', 'Fetching its settings'],
  ['home', 'Restoring the Claude home'],
  ['branch', 'Checking out the branch'],
  ['databases', 'Getting its databases'],
  ['env', 'Writing the env files and the prompt'],
  ['claude', 'Opening the agent'],
];

const LIVE = new Set(['queued', 'starting', 'running', 'stopping']);
// The app's states, as the session's statusd reports them (session/statusd.mjs, appState; console/sessions.mjs).
const APP_STATES = new Set(['running', 'api-down', 'frontend-down', 'starting', 'stopping', 'failed', 'stopped', 'none']);
// How long `session app start` waits for the app to come up: the page says one to three minutes.
const APP_START_DEADLINE_MS = 300_000;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
// What goes with --parent: hc's --no-notify, and its own default of ending with the parent, which a session does not take.
const PARENT_FLAGS = ['no-notify', 'end-with-parent'];
// An hc terminal address here (`t7`, `t1b`): at most hc's 32 characters, read in one pass.
const looksLikeAddress = (word) => typeof word === 'string' && word.length <= 32 && /^t\d+(?:[a-z][a-z0-9]*)?$/.test(word);
const ID_RE = /^[0-9a-f]{8}$/;
// An app's name in the project file (shared/project.mjs, APP_NAME).
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// What a console says reaches a terminal: never a control character or a direction override, which could move the
// cursor, retitle the window or make one id read as another. Other text, accents and all, is kept.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
export function printable(text, most = 200) {
  if (text === null || text === undefined) return null;
  return String(text).replace(UNPRINTABLE_RE, ' ').slice(0, most);
}

/**
 * What the console's page shows a session as (console/public/common.js, displayStatus), as a key and a word.
 * @returns {{key: string, word: string}}
 */
export function stateOf(s) {
  const agent = AGENT_IDS.includes(s.options?.agent) ? s.options.agent : 'claude';
  if (s.status === 'running') {
    if (s.state === 'needs-you') return { key: 'needs-you', word: 'needs you' };
    if (s.state === 'working') return { key: 'working', word: 'working' };
    if (s.state === 'done' && s.slackWaiting) return { key: 'review', word: 'in review' };
    // Done with its turn while a background shell waits on a job of its pull request: it needs nobody yet.
    if (s.state === 'done' && s.shells > 0 && s.prUrl) return { key: 'job', word: 'waiting on a job' };
    if (s.state === 'done') return { key: 'done', word: 'done' };
    if (s.state === 'starting') return { key: 'starting', word: 'starting' };
    return { key: 'idle', word: `${agent} exited` };
  }
  if (!LIVE.has(s.status) && s.kept && !s.owner) {
    if (s.prClosedAt) return { key: 'merged', word: s.prMerged ? 'merged' : 'closed' };
    if (s.status === 'failed') return { key: 'failed', word: 'failed' };
    if (s.slackPostedAt) return { key: 'finished', word: 'finished' };
    return { key: 'paused', word: s.stoppedBy ? 'stopped' : 'paused' };
  }
  if (s.status === 'queued' && s.owner) return { key: 'queued', word: 'waiting' };
  if (s.status === 'failed' || (s.owner && s.stopReason === 'did not start in time')) return { key: 'failed', word: 'failed' };
  if (s.status === 'stopped' && s.owner && !s.stoppedBy && /^(idle|ran) for /.test(s.stopReason ?? '')) return { key: 'paused', word: 'paused' };
  if (s.cleanedAt) return { key: 'stopped', word: 'deleted' };
  const word = printable(s.status, 30) || 'unknown';
  return { key: word, word };
}

/** @returns {boolean}  whether `woodshed review` can open this session: its person's own, private, and never tainted */
export function reviewable(s, login) {
  return Boolean(s?.owner && login && s.owner === login && s.kind !== 'ask' && !s.taintedAt && s.status !== 'failed' && !s.cleanedAt);
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_RE = /^[0-9]{1,9}$/;

/**
 * A GitHub pull request's address read without a regular expression over the whole of it, since it comes from the
 * console or the person: `https://github.com/<owner>/<name>/pull/<number>`, exactly, or with `loose` a trailing slash,
 * query or fragment too, as one pasted from a browser has.
 * @returns {{repo: string, number: number, url: string}|null}  `url` is the address as GitHub writes it
 */
export function parsePullUrl(text, { loose = false } = {}) {
  const raw = String(text ?? '');
  if (raw.length > 400) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) return null;
  const parts = u.pathname.split('/');
  if (loose && parts.length === 6 && parts[5] === '') parts.pop();
  const [, owner, name, pull, number] = parts;
  if (parts.length !== 5 || pull !== 'pull' || !NAME_RE.test(owner) || !NAME_RE.test(name) || !NUMBER_RE.test(number)) return null;
  const url = `https://github.com/${owner}/${name}/pull/${number}`;
  if (!loose && raw !== url) return null;
  return { repo: `${owner}/${name}`, number: Number(number), url };
}

/**
 * A pull request as the console's chips read it (console/prChips.mjs describePr): its state, verdict and checks, or
 * only its number and address while the console has not read it.
 */
export function pullOf(url, chip) {
  const pull = parsePullUrl(url);
  if (!pull) return null;
  const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
  const checks = chip?.checks && typeof chip.checks === 'object'
    ? { pass: count(chip.checks.pass), fail: count(chip.checks.fail), pending: count(chip.checks.pending), total: count(chip.checks.total) } : null;
  return {
    number: pull.number, repo: pull.repo, url,
    title: printable(chip?.title, 200),
    state: ['open', 'draft', 'queued', 'merged', 'closed'].includes(chip?.state) ? chip.state : null,
    review: ['approved', 'changes', 'pending'].includes(chip?.review) ? chip.review : null,
    checks: checks?.total ? checks : null,
  };
}

/**
 * The pull request a session is on, as the console's chip reads it: the last one it opened, or for a review, a QA run or
 * a session from a pull request's label, the one it was started on (pullRequestOf). The chip is the opened one's, so
 * the started-on one has its number and link alone when the session opened another.
 * @returns {ReturnType<typeof pullOf>}
 */
function pullRequestChip(s) {
  const own = pullOf(s.prUrl, s.pr);
  if (s.kind !== 'pr') return own;
  const on = pullRequestOf(s);
  if (!on || own?.number === on.number) return own ?? (on && pullOf(on.url, null));
  return pullOf(on.url, null);
}

/** `#123 open · approved · checks 3 passing`, a pull request's line as the chips would say it. */
export function pullText(p) {
  const bits = [`#${p.number}`, p.state ?? 'not read yet'];
  if (p.review) bits.push({ approved: 'approved', changes: 'changes requested', pending: 'review required' }[p.review]);
  const c = p.checks;
  if (c) bits.push(c.fail ? `checks ${c.fail} of ${c.total} failing` : c.pending ? `checks ${c.pending} of ${c.total} running` : `checks ${c.total} passing`);
  return `${bits[0]} ${bits.slice(1).join(' · ')}`;
}

/** @returns {boolean}  a session that ended for good: nothing of it is kept to resume */
function ended(s) {
  if (LIVE.has(s.status)) return false;
  if (s.owner) return false;
  return !s.kept || s.kind === 'ask';
}

/**
 * What a session is, as the console's page tells them apart: a review or QA run it started on a pull request
 * (console/public/common.js, isPullCheck; the console's own sessions.mjs reads its `review` or `qa`), a question from
 * Slack, a private session, or a shared one.
 * @returns {'review'|'qa'|'ask'|'private'|'shared'}
 */
export function kindOf(s) {
  if (s.trigger === 'review' || (s.review && typeof s.review === 'object')) return 'review';
  if (s.trigger === 'qa' || (s.qa && typeof s.qa === 'object')) return 'qa';
  if (s.kind === 'ask') return 'ask';
  return s.owner ? 'private' : 'shared';
}

const PULL_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;

/**
 * The pull request a session is on: the one a review or QA run, or a session from a pull request's label, was started
 * for, else the last one it opened.
 * @returns {{number: number, url: string}|null}
 */
export function pullRequestOf(s) {
  const repo = typeof s.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s.repo) ? s.repo : null;
  if (s.kind === 'pr' && Number.isSafeInteger(s.number) && s.number > 0 && repo) return { number: s.number, url: `https://github.com/${repo}/pull/${s.number}` };
  const opened = typeof s.prUrl === 'string' ? PULL_URL_RE.exec(s.prUrl) : null;
  return opened ? { number: Number(opened[1]), url: opened[0] } : null;
}

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** @returns {boolean}  on the rail's Mine: your own private session, or a shared one you started or have */
export function inMine(s, login) {
  if (s.owner) return sameLogin(s.owner, login);
  return sameLogin(s.assignee, login) || sameLogin(s.startedBy, login);
}

/** A review's or QA's verdict, once it reported: the review's APPROVE, REQUEST_CHANGES or COMMENT, QA's check conclusion. */
function verdictOf(s, kind) {
  const run = kind === 'review' ? s.review : kind === 'qa' ? s.qa : null;
  return run && typeof run === 'object' ? printable(run.conclusion, 40) : null;
}

/**
 * Where a running session's app opens, as the console's page links Open app (console/public/common.js, appUrl): its
 * own name under the console's app domain, on the console's scheme and port; with app ports, the port the console
 * lent it, or the console's /auth/app, which lends one. On an app domain a browser signed in to the console opens it;
 * an app port, on a console nobody signs in to, opens for anyone who reaches it.
 * @param {{domain: string|null, ports: boolean}|null} appsOn  what the console's list says of session apps
 * @returns {string|null}  none while the session is not running, has no app, or the console serves no session apps
 */
export function appUrlOf(s, { origin, appsOn }) {
  if (!servesApps(appsOn) || s.status !== 'running' || s.kind === 'ask' || !APP_STATES.has(s.app) || s.app === 'none') return null;
  if (appsOn.ports) return typeof s.appUrl === 'string' && /^https?:\/\//.test(s.appUrl) ? printable(s.appUrl, 300) : `${origin}/auth/app?id=${s.id}&next=/`;
  const { protocol, port } = new URL(origin);
  return `${protocol}//${s.id}.${appsOn.domain}${port ? `:${port}` : ''}/`;
}

/**
 * Whether the console serves session apps: an app domain, or app ports, whose links are the console's own name and
 * lent ports, so need no DNS name (a console at http://[::1]:7690 has app ports and no domain the CLI can build on).
 */
function servesApps(appsOn) {
  return Boolean(appsOn?.domain || appsOn?.ports);
}

/** @returns {{domain: string|null, ports: boolean}}  what the console's list says of session apps */
function appsOnOf(body) {
  const domain = typeof body?.appDomain === 'string' && body.appDomain.length <= 253 && HOST_RE.test(body.appDomain) ? body.appDomain.toLowerCase() : null;
  return { domain, ports: body?.appPorts === true, signIn: typeof body?.signIn === 'boolean' ? body.signIn : null };
}

/**
 * The command that starts the session's app again: with --app for one of several that is not the default (the first,
 * which statusd starts without a name), so a restart never starts another app than the one that went down.
 */
export function startCommand(x) {
  const named = x.appName && x.apps?.length > 1 && x.apps[0] !== x.appName ? x.appName : null;
  const quoted = named && (/^[\w.@-]+$/.test(named) ? named : `'${named.replace(/'/g, `'\\''`)}'`);
  return `woodshed session app ${x.id} start${quoted ? ` --app ${quoted}` : ''}`;
}

/** @returns {string}  what `get` and a start say of the session's app, with the next step; empty when it has none to say */
export function appText(x) {
  const label = x.appName && x.apps?.length > 1 ? ` (${x.appName})` : '';
  const start = startCommand(x);
  switch (x.app) {
    case 'running': return `running${label}: ${x.appUrl}`;
    case 'api-down': return `up${label}, but its API is down, so its calls fail: ${x.appUrl}`;
    case 'frontend-down': return `its frontend is down${label}. Start it again: ${start}`;
    case 'starting': return `starting${label}; it opens at ${x.appUrl}`;
    case 'stopping': return 'stopping';
    case 'failed': return `its start failed${label}. Its log is /tmp/woodshed-app.log in the session; try again: ${start}`;
    case 'stopped': return `not running. Start it: ${start}`;
    case 'none': return `none yet: the project file names no app. Set up app on ${x.url} has the agent write one`;
    default: return '';
  }
}

/** The fields the command line prints of a session, with the console's text made printable. */
export function summary(s, { origin, login, appsOn = null }) {
  const { key, word } = stateOf(s);
  const hours = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const kind = kindOf(s);
  return {
    id: s.id,
    title: printable(s.title),
    status: printable(s.status, 30),
    state: key,
    stateWord: word,
    kind,
    // Your own private session: what resume, remove, connect and herdr act on.
    mine: Boolean(s.owner) && s.owner === login,
    // What the console's rail lists under Mine: also the shared sessions, reviews and QA runs you started or have.
    inMine: inMine(s, login),
    shared: !s.owner,
    owner: printable(s.owner, 60),
    assignee: printable(s.assignee, 60),
    stoppedBy: printable(s.stoppedBy, 60),
    startedBy: printable(s.startedBy, 60),
    verdict: verdictOf(s, kind),
    project: printable(s.project, 60),
    repo: printable(s.repo, 100),
    branch: printable(s.branch, 200),
    agent: agentOfSession(s),
    model: printable(s.options?.model, 60) || null,
    prUrl: printable(s.prUrl, 300),
    url: `${origin}/s/${s.id}`,
    createdAt: s.createdAt ?? null,
    startedAt: s.startedAt ?? null,
    stoppedAt: s.stoppedAt ?? null,
    stopReason: printable(s.stopReason),
    error: printable(s.error),
    // When a running session pauses (idle) or stops (lifetime) by itself, and the hours it runs on: its own, else its
    // owner's, else the console's. ownLimits are the session's own alone, which limits changes.
    pause: s.pause && Date.parse(s.pause.at) ? { at: new Date(Date.parse(s.pause.at)).toISOString(), why: s.pause.why === 'lifetime' ? 'lifetime' : 'idle' } : null,
    runsOn: s.runsOn ? { idleHours: hours(s.runsOn.idleHours), lifetimeHours: hours(s.runsOn.lifetimeHours) } : null,
    ownLimits: s.limits ? { idleHours: hours(s.limits.idleHours), lifetimeHours: hours(s.limits.lifetimeHours) } : null,
    extendedUntil: printable(s.extendedUntil, 40),
    // Its app, while it runs on a console that serves session apps: its state, which of the project's apps it is, and
    // the link that opens it (appLink says for whom). null when there is nothing to open.
    app: servesApps(appsOn) && s.status === 'running' && s.kind !== 'ask' && APP_STATES.has(s.app) ? s.app : null,
    appName: printable(s.appName, 60),
    apps: Array.isArray(s.apps) ? s.apps.map((a) => printable(a?.name, 60)).filter(Boolean) : null,
    appUrl: appUrlOf(s, { origin, appsOn }),
    // Where the link opens: `domain`, the session's own name under the console's app domain, which opens only in a
    // browser signed in to the console and which Share the app shares; `port`, a port of a console nobody signs in to,
    // which opens for anyone who reaches the console and has no Share the app.
    appLink: appUrlOf(s, { origin, appsOn }) ? (appsOn.ports ? 'port' : 'domain') : null,
    // Whether the link needs a browser signed in to the console: false on a console nobody signs in to (app ports
    // always, an app domain with sign-in off), null from a console that does not say.
    appSignIn: appUrlOf(s, { origin, appsOn }) ? (appsOn.ports ? false : appsOn.signIn) : null,
    // Its pull request as the console's chip reads it, every one it opened, and the command that reviews it here.
    pullRequest: pullRequestChip(s),
    pullRequests: (Array.isArray(s.prs) ? s.prs : []).map((p) => pullOf(p?.url, p?.pr)).filter(Boolean),
    reviewCommand: reviewable(s, login) ? `woodshed review ${s.id}` : null,
  };
}

/** @returns {string}  `review #123` for a review or QA run, else the session's kind */
export function kindText(x) {
  const run = x.kind === 'review' || x.kind === 'qa';
  return run && x.pullRequest ? `${x.kind} #${x.pullRequest.number}` : x.kind;
}

/** @returns {string}  whose a session is, in a word: a review or QA run is whoever it was started for */
export function whoseText(x, login) {
  if (x.kind === 'review' || x.kind === 'qa') return x.inMine ? 'you' : x.startedBy ? `@${x.startedBy}` : '-';
  if (x.mine) return 'mine';
  if (!x.shared) return `@${x.owner}`;
  if (!x.assignee) return 'shared';
  return sameLogin(x.assignee, login) ? 'you' : `@${x.assignee}`;
}

/** @returns {string}  `in 42m, idle` for a session's pause, or an empty string for none */
export function pauseText(pause, nowMs) {
  if (!pause) return '';
  const minutes = Math.max(0, Math.round((Date.parse(pause.at) - nowMs) / 60_000));
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${span}, ${pause.why}`;
}

/**
 * @param {{origin: string, rest: string[]}} args
 * @param {{call: Function, token: string|null, stdout: {write: Function}, say: (text: string) => void, emit: (o: object) => void, json: boolean,
 *          sleep: (ms: number) => Promise<void>, now: () => number, stderr: {write: Function},
 *          confirm: (question: string) => Promise<boolean|null>, fail: (message: string, opts?: object) => Error,
 *          EXIT: object}} ctx  `confirm` answers null where nobody can be asked (no terminal)
 * @returns {Promise<number>}  the exit code
 */
export async function sessionCommand({ origin, rest }, ctx) {
  const { call, say, emit, json, sleep, now, stderr, confirm, fail, EXIT } = ctx;
  const [sub, ...words] = rest;
  if (!sub || sub === 'help') {
    ctx.stdout.write(`${SESSION_USAGE}\n`);
    return sub ? EXIT.done : EXIT.failed;
  }
  const opts = parseSessionArgs(sub, words, fail);
  if (!ctx.token) {
    if (json) emit({ event: 'error', status: 'signed-out', error: `not signed in to ${origin}` });
    say(`Not signed in to ${origin}. Run: woodshed login --console ${origin}`);
    return EXIT.waiting;
  }

  // A call to the console, its refusals said as the command line's exit codes.
  // `policy400`: a 400 is the console's rule, not a mistake in what was sent (extend outside its window).
  async function ask(pathname, { method = 'GET', body, policy400 = false, deadlineMs = null } = {}) {
    let out;
    try {
      out = await call(origin, pathname, { method, body, token: ctx.token, deadlineMs });
    } catch (err) {
      // A write still under way at the console: what happened is told by the session's state, not this answer.
      if (err.timedOut && method !== 'GET') throw fail(`${origin} did not answer in time; it may still be doing it. Check with: woodshed session get ${pathname.match(/[0-9a-f]{8}/)?.[0] ?? '<id>'}`);
      throw err;
    }
    if (out.status === 400 && policy400) throw fail(printable(out.body?.error) ?? `${origin} refused that`, { code: EXIT.refused, status: 'refused' });
    if (out.status === 401) {
      const why = printable(out.body?.error) ?? 'it was revoked, or it expired';
      throw fail(`The sign-in to ${origin} ended: ${why}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    }
    if (out.status === 403) throw fail(printable(out.body?.error) ?? `${origin} refused that`, { code: EXIT.refused, status: 'refused' });
    if (out.status === 404 && !out.body?.error) throw fail(`${origin} answered 404: a console from before the command line could start sessions`);
    if (out.status >= 400) throw Object.assign(fail(printable(out.body?.error) ?? `${origin} answered ${out.status}`), { http: out.status });
    if (!out.body || typeof out.body !== 'object') throw fail(`${origin} answered ${out.status} with no JSON: not a Woodshed console`);
    return out.body;
  }

  // What the console's last list said of session apps, for summary's app link.
  let appsOn = null;

  async function list() {
    const body = await ask('/api/sessions');
    appsOn = appsOnOf(body);
    const login = typeof body.login === 'string' ? printable(body.login, 60) : null;
    return { login, sessions: Array.isArray(body.sessions) ? body.sessions.filter((s) => s && ID_RE.test(s.id)) : [] };
  }

  async function find(id) {
    const { login, sessions } = await list();
    const s = sessions.find((x) => x.id === id);
    if (!s) throw fail(`No session ${id} that you can see on ${origin}. woodshed session list shows yours.`);
    return { login, s };
  }

  // Your own private session: resume and remove are the owner's alone. A shared one is the console's page's.
  function ownPrivate(s, login, verb) {
    if (s.owner && s.owner === login) return;
    throw fail(`${s.id} is a shared session: the command line can ${verb} only your own My Woodshed sessions. Open ${origin}/s/${s.id}`, { code: EXIT.refused, status: 'refused' });
  }

  // Inside a Woodshed session, hc is that session's own Herdr core, which the person's computer never shows: nothing is
  // added to it, and the person's computer is named as where it is added.
  const here = sessionHere(ctx.env ?? {});
  const onYourComputer = (id) => `woodshed session herdr ${id} --console ${shellQuote(origin)}`;
  const insideText = (id) => `This runs inside Woodshed session ${here}, where hc is that session's own Herdr: a machine added there never shows in your computer's Herdr sidebar`;
  const yourComputerAdds = (id) => `Your computer adds it: run ${onYourComputer(id)} there, or keep woodshed session watch --herdr --add running there, which adds each of your sessions as it starts or resumes.`;
  function refuseParentInside() {
    if (!here || !opts.parent) return;
    throw fail(`--parent makes the session's agent a child of a terminal in this computer's Herdr, and this runs inside Woodshed session ${here}, whose Herdr your computer never shows. Run it from a terminal on your computer; here, leave out --herdr and --parent, and follow the session with woodshed session get <id> --json.`, { code: EXIT.refused, status: 'in-session' });
  }
  // After a start or resume with --herdr inside a session: said instead of the add, and the start's own exit stands.
  function skippedInside(id, code) {
    const text = `${insideText(id)}, so ${id} was not added. ${yourComputerAdds(id)}`;
    if (json) emit({ event: 'herdr', action: 'skipped', status: 'in-session', session: id, insideSession: here, onYourComputer: onYourComputer(id), message: text });
    else say(text);
    return code;
  }

  // A start, followed until the session runs, fails, stops or needs its person. Each step is said once it is done.
  async function follow(id) {
    const said = new Set();
    let lastWord = null;
    let unreachableSince = null;
    if (!json) say('Waiting for it to start (Ctrl-C stops waiting; the session keeps starting).');
    for (;;) {
      let got;
      try {
        got = await list();
        unreachableSince = null;
      } catch (err) {
        // A laptop's network that drops for a moment: asked again, for a minute.
        if (!err.unreachable) throw err;
        unreachableSince ??= now();
        if (now() - unreachableSince >= UNREACHABLE_GIVE_UP_MS) throw err;
        if (!json) stderr.write(`woodshed: ${err.message}; trying again\n`);
        await sleep(POLL_MS);
        continue;
      }
      const s = got.sessions.find((x) => x.id === id);
      if (!s) throw fail(`Session ${id} is no longer on ${origin}'s list: it was removed.`);
      const shown = summary(s, { origin, login: got.login, appsOn });
      if (shown.stateWord !== lastWord && (s.status === 'queued' || s.status === 'starting')) {
        lastWord = shown.stateWord;
        if (json) emit({ event: 'status', id, status: s.status, state: shown.state });
        else if (s.status === 'queued') say(s.retryAt ? 'Waiting for room to start it: the console tries again every minute.' : 'Waiting in line: you have as many sessions running as the console allows. It starts when one stops.');
        else if (s.status === 'starting') say('Starting:');
      }
      const at = s.startSteps && typeof s.startSteps === 'object' ? s.startSteps : {};
      for (const [step, label] of START_STEPS) {
        if (!at[step] || said.has(step)) continue;
        said.add(step);
        const text = step === 'claude' ? `Opening ${shown.agent}` : label;
        const seconds = s.startedAt && Date.parse(at[step]) ? Math.max(0, Math.round((Date.parse(at[step]) - Date.parse(s.startedAt)) / 1000)) : null;
        if (json) emit({ event: 'step', id, step, label: text, at: printable(at[step], 40) });
        else say(`  done  ${text}${seconds === null ? '' : ` (${seconds}s)`}`);
      }
      if (s.status === 'running') {
        if (shown.state === 'needs-you') {
          if (json) emit({ event: 'needs-you', session: shown });
          say(`Session ${id} is running and needs you: ${shown.url}`);
          return EXIT.waiting;
        }
        if (json) emit({ event: 'running', session: shown });
        say(`Session ${id} is running: ${shown.url}`);
        if (appText(shown)) say(`Its app: ${appText(shown)}`);
        return EXIT.done;
      }
      if (s.status === 'failed') {
        if (json) emit({ event: 'failed', session: shown });
        say(`Session ${id} failed to start: ${shown.error ?? shown.stopReason ?? 'the console does not say why'}. ${shown.url}`);
        return EXIT.failed;
      }
      if (s.status === 'stopped' || s.status === 'stopping') {
        if (json) emit({ event: 'stopped', session: shown });
        say(`Session ${id} stopped before it ran${shown.stopReason ? `: ${shown.stopReason}` : ''}. ${shown.url}`);
        return EXIT.failed;
      }
      await sleep(POLL_MS);
    }
  }

  // --repo names the repo as owner/name, or the console's name for it: the console takes a project's name.
  async function projectFor(repo) {
    const body = await ask('/api/my/projects');
    const projects = Array.isArray(body.projects) ? body.projects : [];
    const wanted = repo.toLowerCase();
    const found = projects.find((p) => String(p.repo ?? '').toLowerCase() === wanted) ?? projects.find((p) => String(p.name ?? '').toLowerCase() === wanted);
    if (found) return found.name;
    const yours = projects.map((p) => printable(p.repo ?? p.name, 100)).join(', ') || 'none';
    throw fail(`You cannot start sessions on ${repo} on ${origin}: it is not one of its repos, or you have no write access to it. Yours: ${yours}`, { code: EXIT.refused, status: 'refused' });
  }

  async function defaultProjectName() {
    const body = await ask('/api/my/projects');
    return typeof body.defaultProject === 'string' && body.defaultProject ? body.defaultProject : undefined;
  }

  // Herdr's hc, checked before anything is started or resumed to add to it. Never installed or updated from here.
  async function hcReady() {
    if (ctx.platform === 'win32') throw fail('woodshed session herdr does not run on Windows yet', { code: EXIT.refused, status: 'refused' });
    const hc = await hcVersion(ctx.hc);
    if (!hc.installed) throw fail(`Adding a session to Herdr needs its hc, ${HC_MINIMUM} or newer, and there is no hc on your PATH. Install Herdr, then run this again.`, { code: EXIT.refused, status: 'no-hc' });
    if (!hc.ok) throw fail(`Adding a session to Herdr needs hc ${HC_MINIMUM} or newer, and yours is ${hc.version ?? 'a version it does not say'}. Update it (hc update), then run this again.`, { code: EXIT.refused, status: 'old-hc' });
    return hc;
  }

  // The terminal here --parent names, found before anything is started or resumed for it.
  async function parentHere() {
    try {
      return await parentTerminal(ctx.hc, { env: ctx.env ?? {}, named: opts.parent === true ? null : opts.parent });
    } catch (err) {
      if (!err.usage && !err.hc) throw err;
      throw fail(printable(err.message, 500), err.usage ? { code: EXIT.refused, status: 'no-parent' } : {});
    }
  }

  // A running session of yours made a machine in hc. Its agent is there only when you picked Herdr on My settings: in
  // tmux otherwise, which hc cannot reach, though new terminals and agents on the machine work. Exits as a start's wait
  // does: waiting on you when the session asks for you.
  // With `parent` (parentTerminal's address here), its agent's terminal is made from here as that terminal's child, when
  // the session waits for it; one that does not already has its terminal, which hc cannot give a parent now.
  // A running session of yours made a machine in hc, its agent given a space and tab, and those named after it in the
  // Herdr app's window: what `session herdr` and `watch --add` do. `afterAdd` runs once the machine is there, before the
  // agent is looked for. With `keptAsIs`, a machine already connected through this same line is left as it is, its agent
  // not looked for. hc's own failures are thrown with `hc` set.
  async function addToHerdr(s, login, { afterAdd = null, keptAsIs = false } = {}) {
    const name = machineName(s.id);
    const added = await addMachine(ctx.hc, { name, via: ctx.via(s.id) });
    const shown = summary(s, { origin, login, appsOn });
    if (keptAsIs && added.action === 'kept') return { name, added, shown, agent: null, after: null };
    const after = afterAdd ? await afterAdd(name) : null;
    const agent = await agentOn(ctx.hc, name, { place: ctx.placeHerdrAgent !== false }).catch(() => ({ inHerdr: null, address: null }));
    // Its space named after the session's title and its tab after its agent, in the Herdr app's window. The console
    // names a session a few seconds after it starts: running this again picks the title up. Not for move, which lays
    // out its own spaces.
    if (agent.inHerdr && ctx.placeHerdrAgent !== false && ctx.app) {
      const named = await nameAgentPlace(ctx.hc, ctx.app, { machine: name, address: agent.address, title: shown.title, agent: shown.agent, sleep })
        .catch((err) => ({ space: null, tab: null, error: err.message }));
      if (named.space || named.tab) agent.named = { space: named.space, tab: named.tab };
      if (named.error) agent.namingError = printable(named.error, 500);
    }
    return { name, added, shown, agent, after };
  }

  async function connect(s, login, parent = null) {
    const name = machineName(s.id);
    if (!json) say(`Adding ${s.id} to Herdr as ${name}…`);
    let added;
    let child = null;
    let agent;
    let shown;
    try {
      ({ added, agent, shown, after: child } = await addToHerdr(s, login, {
        afterAdd: parent ? () => startAgentTerminal(ctx.hc, { machine: name, parent, notify: !opts['no-notify'], outlive: !opts['end-with-parent'] }) : null,
      }));
    } catch (err) {
      if (!err.hc) throw err;
      throw fail(printable(err.message, 500));
    }
    let code = shown.state === 'needs-you' ? EXIT.waiting : EXIT.done;
    // Asked for and not given: the machine stays added, and the exit says the parent was not.
    // What it has as its parent now is read from hc, never assumed: a run of this one may have made it already.
    const why = (c) => {
      if (!c.there) return 'the session did not wait for one, and its agent runs in tmux, not Herdr';
      return `${c.why === 'taken' ? 'it was made while this was on its way' : 'it was already there'}, ${c.parent ? `a child of ${c.parent}` : 'with no parent'}, and hc gives a terminal its parent only as it starts`;
    };
    const noParent = child && !child.made
      ? `Could not make ${parent} the parent of its agent's terminal: ${why(child)}. Run woodshed session new --herdr --parent for a session whose agent is a child of this terminal.`
      : null;
    if (noParent) code = EXIT.failed;
    // Herdr hears of a turn ending or the agent blocking from the agent's own status records: claude sends them, the
    // pinned codex none (session/agentPane.mjs), nor do the other agents, so their child wakes its parent's hc wait only
    // by exiting.
    const reportsStatus = shown.agent === 'claude';
    const parentField = child ? { parent: child.made ? { made: true, terminal: parent, address: child.address, outlives: !opts['end-with-parent'], notify: !opts['no-notify'], reportsStatus } : { made: false, why: child.why, there: child.there, has: child.parent } } : {};
    if (json) {
      emit({ event: 'connected', session: shown, machine: { name, action: added.action, state: added.state }, agent, ...parentField });
      if (noParent) emit({ event: 'error', status: 'no-parent', error: noParent });
      return code;
    }
    say(added.action === 'kept' ? `${name} was already in Herdr, connected.` : `${name} is in Herdr: it shows in the app's sidebar.`);
    if (child?.made) {
      const wakes = reportsStatus ? 'when it ends a turn, blocks, errors or exits' : `only when it exits: ${shown.agent} tells Herdr nothing of its turns`;
      say(`Its agent's terminal ${child.address} is a child of ${parent} here${opts['end-with-parent'] ? ', and ends with it' : ', and outlives it'}: hc wait --children any wakes ${parent} ${wakes}.`);
    }
    if (noParent) stderr.write(`woodshed: ${noParent}\n`);
    if (agent.placementError) say(`Could not put the agent in a Herdr space: ${printable(agent.placementError, 500)}`);
    if (agent.named?.space) say(`Named its Herdr space "${agent.named.space}".`);
    if (agent.namingError) say(`Could not name its Herdr space or tab: ${agent.namingError}`);
    if (agent.inHerdr) say(`Its agent is ${agent.address}: hc attach ${agent.address}`);
    else if (agent.inHerdr === false) {
      say(`Its agent runs in tmux, not Herdr: Agent terminal on My settings was tmux when the session started. New terminals and agents on ${name} work; the agent itself is at ${shown.url}. Pick Herdr on My settings for your next sessions.`);
    } else say(`hc could not say yet whether its agent is there: hc get ${name}/claude`);
    if (code === EXIT.waiting) say(`It needs you: ${shown.url}`);
    return code;
  }

  // Before anything is started or resumed for it: a terminal to put on the session's, and nothing else read from stdout.
  function terminalReady() {
    if (json) throw fail('session connect puts this terminal on the session\'s: it has no --json', { code: EXIT.failed });
    if (!ctx.tty) throw fail('session connect needs a terminal: for a command, use woodshed tunnel <id> -- <line>');
  }

  // This terminal on the session's until one side ends it. A connection that drops (a network, a laptop that slept, a
  // console restarted) is opened again while the session runs: its terminal went on meanwhile, and is drawn again.
  async function onTerminal(s, kind) {
    const what = kind === 'shell' ? 'shell' : `${agentInfo(agentOfSession(s)).command}'s terminal`;
    const reconnect = `woodshed session connect ${s.id}${kind === 'shell' ? ' --shell' : ''} --console ${shellQuote(origin)}`;
    stderr.write(`Connecting to ${s.id}'s ${what}. Ctrl-\\ disconnects; the session goes on.\n`);
    let reconnectUntil = null;
    let tries = 0;
    let lastFailure;
    const giveUp = () => fail(`Could not connect to ${s.id} again in ${RECONNECT_GIVE_UP_MS / 1000} s: ${lastFailure}. Run ${reconnect} to try again.`);
    for (;;) {
      let out;
      if (reconnectUntil !== null) {
        const remaining = reconnectUntil - now();
        if (remaining <= 0) throw giveUp();
        const backoff = RECONNECT_WAITS_MS[Math.min(tries, RECONNECT_WAITS_MS.length - 1)];
        await sleep(Math.min(backoff, remaining));
        if (now() >= reconnectUntil) throw giveUp();
        tries += 1;
        // The console may still be restarting behind its proxy. Check the session again before opening the terminal.
        try {
          const { s: latest } = await find(s.id);
          if (latest.status !== 'running') {
            throw fail(`Session ${s.id} is ${stateOf(latest).word} now. Run ${reconnect} to resume it and connect again.`);
          }
        } catch (err) {
          if (!err.unreachable && ![502, 503, 504].includes(err.http)) throw err;
          out = { status: 'unreachable', message: err.message };
        }
        if (!out && now() >= reconnectUntil) throw giveUp();
      }
      out ??= await ctx.terminal(s.id, kind);
      // ttyd sends 1000 on a normal close and a different code on an error.
      if (out.status === 'detached' || (out.status === 'closed' && out.code === 1000)) {
        stderr.write(`\r\nConnection to ${s.id} closed.\n`);
        return EXIT.done;
      }
      if (out.status === 'closed') {
        stderr.write(`\r\nConnection to ${s.id} closed by the session's terminal with ${out.code ?? 'no code'}.\n`);
        return EXIT.failed;
      }
      if (out.status === 'refused' && out.http === 401) {
        throw fail(`The sign-in to ${origin} ended: ${out.message}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
      }
      if (out.status === 'refused' && /production data/.test(out.message)) throw fail(`Session ${s.id}: ${out.message}`, { code: EXIT.refused, status: 'refused' });
      const held = out.status === 'attached-then-cut' && (out.ms ?? 0) >= RECONNECT_HELD_MS;
      if (out.status === 'attached-then-cut' && (held || reconnectUntil === null)) {
        reconnectUntil = now() + RECONNECT_GIVE_UP_MS;
        tries = 0;
        stderr.write(`\r\nwoodshed: the connection to ${s.id} dropped (${out.message}); connecting again. Ctrl-C stops.\n`);
      } else if (reconnectUntil === null) {
        // Never connected: said as it is, not tried again.
        throw fail(out.status === 'refused' ? `${origin} refused the terminal: ${out.message}` : out.message);
      } else if (out.status === 'attached-then-cut') {
        const remaining = reconnectUntil - now();
        if (remaining > 0) stderr.write(`\r\nwoodshed: it dropped again at once (${out.message}); still trying, for up to ${Math.ceil(remaining / 1000)} s more.\n`);
      }
      lastFailure = out.message;
    }
  }

  if (sub === 'new') {
    if (opts.connect && opts.herdr) throw fail('--connect and --herdr: pick one');
    if (opts.connect) {
      if (opts.wait === false) throw fail('--connect waits for the session to run: leave out --no-wait');
      terminalReady();
    }
    if (opts.parent && !opts.herdr) throw fail('--parent makes the agent\'s terminal in Herdr: add --herdr');
    if (opts.herdr) {
      if (opts.wait === false) throw fail('--herdr waits for the session to run: leave out --no-wait');
      refuseParentInside();
      if (!here) await hcReady();
    }
    const parent = opts.parent ? await parentHere() : null;
    // With no --repo, the one New session opens on for this person (a default they saved), never the console's own.
    const project = opts.repo ? await projectFor(opts.repo) : await defaultProjectName();
    const body = {
      prompt: opts.prompt, workOn: opts.branch ?? '', agent: opts.agent ?? 'claude', model: opts.model ?? '', ...(project ? { project } : {}),
      // The session then waits for its agent's terminal from here, rather than make its own (startAgentTerminal).
      ...(parent ? { herdrParent: true } : {}),
    };
    const s = await ask('/api/my/sessions', { method: 'POST', body });
    if (!ID_RE.test(String(s.id))) throw fail(`${origin} answered with no session id`);
    const shown = summary(s, { origin, login: s.owner ?? null, appsOn });
    if (json) emit({ event: 'started', session: shown });
    say(`Started session ${shown.id}${shown.title ? `: ${shown.title}` : ''}`);
    say(`  ${shown.url}`);
    if (opts.wait === false) return EXIT.done;
    const started = await follow(shown.id);
    if ((!opts.herdr && !opts.connect) || (started !== EXIT.done && started !== EXIT.waiting)) return started;
    if (opts.herdr && here) return skippedInside(shown.id, started);
    const found = await find(shown.id);
    if (opts.connect) return onTerminal(found.s, 'term');
    return connect(found.s, found.login, parent);
  }

  // The machines in Herdr this command line added for sessions no longer on the console's list. Every session it lists
  // counts as there, ended or not: only one gone from the list altogether has nothing to bring back. null: no hc here
  // new enough to have added one, or hc could not list its machines.
  async function leftovers(sessions) {
    if (ctx.platform === 'win32' || !ctx.hc) return null;
    try {
      if (!(await hcVersion(ctx.hc)).ok) return null;
      const listed = new Set(sessions.map((s) => s.id));
      return await leftoverMachines(ctx.hc, { origin, exists: (id) => listed.has(id) });
    } catch (err) {
      if (!err.hc) throw err;
      return null;
    }
  }

  if (sub === 'list') {
    const { login, sessions } = await list();
    const shown = sessions.filter((s) => opts.all || !ended(s)).map((s) => summary(s, { origin, login, appsOn }));
    // Your own open pull requests on the console's repos that no session listed here opened: My Woodshed's group.
    let pulls = [];
    let pullsError = null;
    try {
      const body = await ask('/api/my/pulls');
      // A review's or QA's pullRequest is the one it was started on, which it did not open: that stays in the group.
      const opened = (x) => [x.kind === 'review' || x.kind === 'qa' ? null : x.pullRequest, ...x.pullRequests];
      const has = new Set(shown.flatMap(opened).filter(Boolean).map((p) => `${p.repo.toLowerCase()}#${p.number}`));
      pulls = (Array.isArray(body.pulls) ? body.pulls : [])
        .filter((p) => p?.why === 'yours' && Number.isInteger(p.number) && typeof p.repo === 'string' && !has.has(`${p.repo.toLowerCase()}#${p.number}`))
        .map((p) => ({ ...pullOf(`https://github.com/${p.repo}/pull/${p.number}`, { title: p.title, state: p.draft ? 'draft' : 'open', checks: p.checks }), project: printable(p.project, 60), branch: printable(p.branch, 200) }))
        .filter((p) => p.number);
    } catch (err) {
      if (err.code === EXIT.waiting) throw err;
      // A console from before the command line could read them says so, and the sessions are listed all the same.
      pullsError = err.message;
    }
    const gone = await leftovers(sessions);
    if (json) {
      emit({ console: origin, login, sessions: shown, pullRequests: pulls, ...(pullsError ? { pullRequestsError: pullsError } : {}),
        ...(gone ? { herdrLeftovers: gone.map((m) => m.name) } : {}) });
      return EXIT.done;
    }
    if (!shown.length) say(opts.all ? 'No sessions.' : 'No sessions. --all also lists those that ended.');
    else {
      const rows = [['ID', 'STATE', 'KIND', 'WHOSE', 'PAUSES', 'PROJECT', 'TITLE'], ...shown.map((x) => [x.id, x.stateWord, kindText(x), whoseText(x, login), pauseText(x.pause, now()) || '-', x.project ?? '', x.title ?? ''])];
      const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
      const indent = ' '.repeat(widths[0] + 2);
      rows.forEach((row, i) => {
        say(row.map((cell, c) => (c === row.length - 1 ? cell : cell.padEnd(widths[c]))).join('  ').trimEnd());
        const x = shown[i - 1];
        if (!x) return;
        // Every pull request it opened, newest last, as its chips show them; the command that reviews it, when you can.
        const prs = x.pullRequests.length ? x.pullRequests : [x.pullRequest].filter(Boolean);
        for (const p of prs) say(`${indent}${pullText(p)}${p.title && p.title !== x.title ? `  ${p.title}` : ''}`);
        if (prs.length && x.reviewCommand) say(`${indent}review it: ${x.reviewCommand}`);
      });
    }
    if (pulls.length) {
      say('');
      say('Your open pull requests with no session:');
      for (const p of pulls) say(`  ${pullText(p)}  ${p.repo}${p.title ? `  ${p.title}` : ''}`);
      say(`  To review one here, start a session on it, then review that: woodshed session new --repo <repo> --branch <number>`);
    }
    if (pullsError) say(`Your pull requests with no session were not read: ${pullsError}`);
    if (gone?.length) {
      const names = gone.map((m) => m.name).join(', ');
      say(`\nHerdr still has ${gone.length === 1 ? 'a machine' : `${gone.length} machines`} of ${gone.length === 1 ? 'a session' : 'sessions'} no longer on ${origin}: ${names}. Forget ${gone.length === 1 ? 'it' : 'them'} with: woodshed session prune`);
    }
    return EXIT.done;
  }

  if (sub === 'prune') {
    if (ctx.platform === 'win32') throw fail('woodshed session prune does not run on Windows yet', { code: EXIT.refused, status: 'refused' });
    const hc = await hcVersion(ctx.hc);
    if (!hc.ok) {
      if (json) emit({ event: 'pruned', forgot: [], failed: [], hc: false });
      say(hc.installed ? `Your hc is older than ${HC_MINIMUM}: this command line added no machines to it.` : 'No hc on your PATH: there is no machine in Herdr to forget.');
      return EXIT.done;
    }
    const { sessions } = await list();
    const listed = new Set(sessions.map((s) => s.id));
    let gone;
    try {
      gone = await leftoverMachines(ctx.hc, { origin, exists: (id) => listed.has(id) });
    } catch (err) {
      if (!err.hc) throw err;
      throw fail(printable(err.message, 500));
    }
    const forgot = [];
    const failed = [];
    for (const m of gone) {
      try {
        // Looked up again by its line: never another machine that took the name since.
        if (await removeMachine(ctx.hc, m.name, { origin, session: m.session })) forgot.push(m.name);
      } catch (err) {
        if (!err.hc) throw err;
        failed.push({ name: m.name, error: printable(err.message, 500) });
      }
    }
    if (json) emit({ event: 'pruned', forgot, failed });
    if (!gone.length) say(`Herdr has no machine of a session no longer on ${origin}.`);
    for (const name of forgot) say(`Forgot ${name} in Herdr: its session is no longer on ${origin}.`);
    for (const f of failed) stderr.write(`woodshed: ${f.error}\n`);
    return failed.length ? EXIT.failed : EXIT.done;
  }

  if (sub === 'watch') return watch();

  // The watch's own flags again, for the copy of it --herdr starts in hc.
  function watchFlags() {
    return [
      ...(opts.kinds ? ['--kind', [...opts.kinds].join(',')] : []),
      ...(opts.everyone ? ['--everyone'] : []),
      ...(opts.every !== undefined ? ['--every', String(opts.everyMs / 1000)] : []),
      ...(opts.add ? ['--add'] : []),
    ];
  }

  // Follows the console's list until stopped, and says each session that starts, runs, is done with its turn, needs its
  // person, pauses, stops, finishes or fails (watch.mjs). The first read only learns what is there. A console it cannot
  // reach (a laptop asleep, a redeploy) is asked again at the same pace for as long as it runs, and what changed meanwhile
  // is told when it answers again. Only a sign-in that ended, or a refusal, stops it. A console away at the first read is
  // said (unreachable, then reachable) before the first read's `watching`.
  // With --herdr it runs in a terminal of hc's own (WATCH_TERMINAL), started here, and reports each session there as an
  // OSC 7501 record, so the Herdr app tells of them as of its own agents, with no session opened as a machine.
  async function watch() {
    const inHerdr = Boolean(opts.herdr) && ctx.env?.[WATCH_IN_HERDR] === '1';
    if (opts.add && here) {
      throw fail(`--add adds your sessions to the Herdr on this computer, and this runs inside Woodshed session ${here}, where hc is that session's own Herdr: a machine added there never shows in your computer's Herdr sidebar. Run woodshed session watch --herdr --add on your computer.`, { code: EXIT.refused, status: 'in-session' });
    }
    if (opts.herdr && !inHerdr) {
      await hcReady();
      let started;
      try {
        started = await startWatcher(ctx.hc, ctx.watcherArgv([...watchFlags(), '--herdr']));
      } catch (err) {
        if (!err.hc) throw err;
        throw fail(printable(err.message, 500));
      }
      if (json) emit({ event: 'herdr', action: started.action, terminal: WATCH_TERMINAL, address: started.address, add: Boolean(opts.add) });
      const adds = opts.add ? ' It also adds each of your own private sessions to Herdr as it starts running or resumes.' : '';
      say(started.action === 'kept'
        ? `Herdr already has ${WATCH_TERMINAL} watching: it goes on as it was started. To start it again with these options: hc kill ${WATCH_TERMINAL}, then run this again.`
        : `Watching in Herdr: hc terminal ${WATCH_TERMINAL}, in the app's ${WATCH_SPACE} space. It reports each session's state there as Herdr's own agents report theirs.${adds} Stop it with: hc kill ${WATCH_TERMINAL}`);
      return EXIT.done;
    }
    if (opts.add) await hcReady();
    const wanted = (s, login) => (!opts.kinds || opts.kinds.has(kindOf(s))) && (opts.everyone || inMine(s, login));
    const stamp = () => new Date(now()).toISOString();
    // Herdr's hc, when it is here: a session of yours that is a machine there is said to be unreachable when it pauses or
    // stops. Its machines are read only then.
    const hcHere = ctx.platform !== 'win32' && ctx.hc ? await hcVersion(ctx.hc).then((v) => v.ok, () => false) : false;
    const machineOf = async (x) => {
      if (!hcHere || !x.mine) return null;
      try {
        return (await tunnelMachines(ctx.hc, { origin })).get(x.id) ?? null;
      } catch (err) {
        if (!err.hc) throw err;
        return null;
      }
    };
    // With --add: each of your own private sessions that started running or resumed, to add to Herdr, with the tries it
    // took. A try that fails is made again at the next read while the session runs, up to ADD_TRIES.
    const addable = (s, login) => kindOf(s) === 'private' && Boolean(s.owner) && s.owner === login && !s.taintedAt;
    const toAdd = new Map();
    async function addPending(got) {
      const listed = new Map(got.sessions.map((s) => [s.id, s]));
      for (const [id, tries] of toAdd) {
        const s = listed.get(id);
        // Never resumed to be added: one that paused or stopped meanwhile waits for its next start.
        if (!s || s.status !== 'running' || s.taintedAt) {
          toAdd.delete(id);
          continue;
        }
        let out;
        try {
          out = await addToHerdr(s, got.login, { keptAsIs: true });
        } catch (err) {
          if (!err.hc) throw err;
          const last = tries + 1 >= ADD_TRIES;
          if (last) toAdd.delete(id);
          else toAdd.set(id, tries + 1);
          const error = printable(err.message, 500);
          if (json) emit({ event: 'herdr-not-added', at: stamp(), session: summary(s, { origin, login: got.login, appsOn }), error, again: !last, ...(last ? { bringBack: `woodshed session herdr ${id}` } : {}) });
          else say(`${stamp().slice(11, 19)}  ${id}  not added to Herdr: ${error}${last ? `. Add it with: woodshed session herdr ${id}` : '; trying again'}`);
          continue;
        }
        toAdd.delete(id);
        // Already connected through this same line: nothing was done, and nothing is said.
        if (out.added.action === 'kept') continue;
        if (json) emit({ event: 'herdr-added', at: stamp(), session: out.shown, machine: { name: out.name, action: out.added.action }, agent: out.agent });
        else say(`${stamp().slice(11, 19)}  ${id}  added to Herdr as ${out.name}${out.agent?.inHerdr ? `: hc attach ${out.agent.address}` : ''}`);
      }
    }
    // Each session's record on this terminal, with when it ended: an ended one's is kept a while, then cleared.
    const records = new Map();
    let phases = null;
    let awaySince = null;
    for (;;) {
      if (ctx.signal?.aborted) return EXIT.done;
      let got;
      try {
        got = await list();
      } catch (err) {
        // Any 5xx is the console's own trouble, and passes: a watch meant to run for hours outlives it.
        if (!err.unreachable && !(err.http >= 500)) throw err;
        if (awaySince === null) {
          awaySince = now();
          if (json) emit({ event: 'unreachable', at: stamp(), error: printable(err.message, 300) });
          else stderr.write(`woodshed: ${err.message}; asking again every ${opts.everyMs / 1000} s\n`);
        }
        await sleep(opts.everyMs);
        continue;
      }
      if (awaySince !== null) {
        if (json) emit({ event: 'reachable', at: stamp(), awaySeconds: Math.round((now() - awaySince) / 1000) });
        else stderr.write(`woodshed: ${origin} answers again\n`);
        awaySince = null;
      }
      // Every session's phase is kept, so one that comes into Mine later (assigned to you) is not told as new.
      const { phases: next, events } = changes(phases, got.sessions, { kindOf });
      if (!phases) {
        const watched = got.sessions.filter((s) => wanted(s, got.login)).length;
        const what = opts.kinds ? [...opts.kinds].join(', ') : 'all';
        if (json) emit({ event: 'watching', at: stamp(), console: origin, login: got.login, kinds: opts.kinds ? [...opts.kinds] : null, everyone: Boolean(opts.everyone), everySeconds: opts.everyMs / 1000, sessions: watched, herdr: inHerdr, add: Boolean(opts.add) });
        else say(`Watching ${opts.everyone ? 'every session you can see' : 'your sessions (Mine)'} on ${origin}, kinds: ${what}, every ${opts.everyMs / 1000} s${inHerdr ? ', for Herdr' : ''}${opts.add ? ', adding each of your private sessions to Herdr as it starts or resumes' : ''}. Ctrl-C stops.`);
      }
      phases = next;
      // Whatever --kind and --everyone watch: a session of yours is added as it starts running, a resume included.
      if (opts.add) for (const e of events) if (e.event === 'started' && addable(e.session, got.login)) toAdd.set(e.session.id, 0);
      for (const e of events) {
        if (!wanted(e.session, got.login)) continue;
        // Back at work after a question or a turn: nothing to tell, but Herdr's record of it is put right.
        if (e.quiet) {
          if (inHerdr && records.has(e.session.id)) ctx.stdout.write(herdrRecord(e, summary(e.session, { origin, login: got.login, appsOn })));
          continue;
        }
        const x = summary(e.session, { origin, login: got.login, appsOn });
        const machine = e.event === 'paused' || e.event === 'stopped' ? await machineOf(x) : null;
        if (inHerdr) {
          ctx.stdout.write(herdrRecord(e, x, { machine }));
          records.set(x.id, ['paused', 'stopped', 'finished', 'failed'].includes(e.event) ? now() : null);
        }
        if (json) {
          emit({ event: e.event, at: stamp(), ...(e.why ? { why: e.why } : {}), session: x, ...(machine ? { machine: { name: machine, unreachable: true, bringBack: `woodshed session herdr ${x.id}` } } : {}) });
          continue;
        }
        const detail = eventDetail(e, x);
        say([stamp().slice(11, 19), x.id, `${e.event}${detail ? ` (${detail})` : ''}`, kindText(x), x.title ?? '', x.url].join('  '));
        if (machine) say(`          ${unreachableText(machine, x.id)}`);
      }
      if (toAdd.size) await addPending(got);
      if (inHerdr) {
        // Gone from the list or from what is watched, or ended an hour ago: its record goes from the terminal.
        const listed = new Map(got.sessions.map((s) => [s.id, s]));
        for (const [id, endedAt] of records) {
          const s = listed.get(id);
          if (s && wanted(s, got.login) && (endedAt === null || now() - endedAt < RECORD_KEEP_MS)) continue;
          ctx.stdout.write(herdrClear(id));
          records.delete(id);
        }
      }
      await sleep(opts.everyMs);
    }
  }

  const id = opts.id;
  const { login, s } = await find(id);

  if (sub === 'stop') {
    // One that stopped by itself (paused, or failed) is still sent: the console then has it wait on nobody, as the page's
    // Stop does. One a person stopped, or that is stopping, has nothing left to do.
    const settled = s.status === 'stopping' || (!LIVE.has(s.status) && (s.stoppedBy || !['stopped', 'failed'].includes(s.status)));
    if (settled) {
      if (json) emit({ event: 'stopped', session: summary(s, { origin, login, appsOn }), already: true });
      say(`Session ${id} is not running: it is ${stateOf(s).word}.`);
      return EXIT.done;
    }
    const after = await ask(`/api/sessions/${id}/stop`, { method: 'POST', body: {}, deadlineMs: STOP_DEADLINE_MS });
    if (json) emit({ event: 'stopped', session: summary({ ...s, ...after }, { origin, login, appsOn }), already: !LIVE.has(s.status) });
    // The console's stop answers when it is done, and says nothing of whether the checkpoint pushed: none is made of a
    // session still in line, and a failed one does not hold the stop. So this claims no push.
    say(LIVE.has(s.status) ? `Stopped session ${id}.` : `Session ${id} was already ${stateOf(s).word}: it is marked stopped by you, and waits on nobody now.`);
    return EXIT.done;
  }

  // Resumes one of your own that is not running, or follows one starting, as resume does.
  async function resumeAndWait() {
    if (LIVE.has(s.status)) {
      if (s.status === 'stopping') throw fail(`Session ${id} is stopping: resume it once it has stopped.`);
      if (json) emit({ event: 'resumed', session: summary(s, { origin, login, appsOn }), already: true });
      say(`Session ${id} is already ${stateOf(s).word}.`);
      if (s.status === 'running') return stateOf(s).key === 'needs-you' ? EXIT.waiting : EXIT.done;
      return opts.wait === false ? EXIT.done : follow(id);
    }
    const after = await ask(`/api/my/sessions/${id}/resume`, { method: 'POST', body: opts.parent ? { herdrParent: true } : {} });
    if (json) emit({ event: 'resumed', session: summary({ ...s, ...after }, { origin, login, appsOn }), already: false });
    say(`Resuming session ${id}${s.title ? `: ${printable(s.title)}` : ''}`);
    if (opts.wait === false) return EXIT.done;
    return follow(id);
  }

  if (sub === 'resume') {
    ownPrivate(s, login, 'resume');
    if (!opts.herdr) return resumeAndWait();
    if (s.taintedAt) throw fail(`Session ${id} has seen production data: nothing opens a pipe into it from this computer.`, { code: EXIT.refused, status: 'refused' });
    if (!here) await hcReady();
    const resumed = await resumeAndWait();
    if (resumed !== EXIT.done && resumed !== EXIT.waiting) return resumed;
    if (here) return skippedInside(id, resumed);
    const found = await find(id);
    return connect(found.s, found.login);
  }

  if (sub === 'connect') {
    // The console opens a terminal only on your own private sessions, never one that has seen production data.
    ownPrivate(s, login, 'connect to');
    if (s.taintedAt) throw fail(`Session ${id} has seen production data: nothing opens a terminal on it from this computer.`, { code: EXIT.refused, status: 'refused' });
    terminalReady();
    const kind = opts.shell ? 'shell' : 'term';
    if (s.status === 'running') return onTerminal(s, kind);
    const resumed = await resumeAndWait();
    if (resumed !== EXIT.done && resumed !== EXIT.waiting) return resumed;
    return onTerminal((await find(id)).s, kind);
  }

  if (sub === 'herdr') {
    // The tunnel opens only into your own private sessions, never one that has seen production data.
    ownPrivate(s, login, 'add to Herdr');
    if (s.taintedAt) throw fail(`Session ${id} has seen production data: nothing opens a pipe into it from this computer.`, { code: EXIT.refused, status: 'refused' });
    // Inside a session nothing is resumed or added: the person's computer adds it.
    refuseParentInside();
    if (here) throw fail(`${insideText(id)}, so nothing was added. ${yourComputerAdds(id)}`, { code: EXIT.refused, status: 'in-session' });
    await hcReady();
    const parent = opts.parent ? await parentHere() : null;
    // A running one is taken as it is: only one still waiting for its terminal takes a parent (connect says so).
    if (s.status === 'running') return connect(s, login, parent);
    const resumed = await resumeAndWait();
    if (resumed !== EXIT.done && resumed !== EXIT.waiting) return resumed;
    const found = await find(id);
    return connect(found.s, found.login, parent);
  }

  if (sub === 'app' && opts.action === 'share') return share();

  if (sub === 'app') {
    // Both are start's alone: with no action, or with stop, they would be ignored without a word.
    if (opts.app !== undefined && opts.action !== 'start') throw fail('--app picks the app to start: use it with start');
    if (opts.wait === false && opts.action !== 'start') throw fail('--no-wait is for start: stop and the state never wait');
    const x = summary(s, { origin, login, appsOn });
    if (s.kind === 'ask') throw fail(`Session ${id} answers a question from Slack: it has no app.`, { code: EXIT.refused, status: 'refused' });
    if (!servesApps(appsOn)) throw fail(`${origin} serves no session apps: a session's app opens only on a console with an app domain or app ports.`, { code: EXIT.refused, status: 'refused' });
    if (s.status !== 'running') {
      const resume = s.owner && s.owner === login ? `: woodshed session resume ${id} first` : '';
      throw fail(`Session ${id} is ${stateOf(s).word}. Its app runs only while it does${resume}.`, { code: EXIT.refused, status: 'not-running' });
    }
    if (!opts.action) {
      if (json) emit({ event: 'app', session: x });
      say(x.app ? `Its app: ${appText(x)}` : `Session ${id} has not said yet whether its app runs. Try again in a few seconds, or open ${x.url}`);
      return EXIT.done;
    }
    if (opts.action === 'start' && x.app === 'none') {
      throw fail(`Session ${id}'s project file names no app yet. Set up app on ${x.url} has its agent write one.`, { code: EXIT.waiting, status: 'no-app' });
    }
    // statusd takes no start while the stop script runs: it answers as asked and starts nothing.
    const stillStopping = `Session ${id}'s app is still stopping, so it was not started. Try again in a few seconds, once \`woodshed session app ${id}\` says it is not running.`;
    if (opts.action === 'start' && x.app === 'stopping') throw fail(stillStopping, { code: EXIT.failed, status: 'stopping' });
    let after;
    try {
      after = await ask(`/api/sessions/${id}/app/${opts.action}`, { method: 'POST', body: opts.app ? { app: opts.app } : {} });
    } catch (err) {
      // The session's own refusal: not running, no app by that name, an image from before Start app.
      if (err.http === 409) throw fail(err.message, { code: EXIT.refused, status: 'refused' });
      throw err;
    }
    const asked = summary({ ...s, ...after }, { origin, login, appsOn });
    if (opts.action === 'stop') {
      // `stopping` false: no stop ran. With the app still up, the project's app has no stop command; a stop already
      // running is said as stopping. A console from before it says nothing, and the state is taken as it reads.
      if (after?.stopping === false && asked.app !== 'stopping') {
        throw fail(`Session ${id}'s app has no stop command in the project file (app.stop), so nothing was stopped: it is ${appText(asked) || asked.app || 'as it was'}.`, { code: EXIT.refused, status: 'no-stop' });
      }
      if (json) emit({ event: 'app-stopping', session: asked });
      say(after?.stopping === false ? `Session ${id}'s app is already stopping.` : `Stopping session ${id}'s app.`);
      return EXIT.done;
    }
    // A start the session did not take reads `started: false`; a switch to another app, which starts once the running
    // one's stop script ends, is taken and reads as stopping meanwhile. A console from before `started` says only the
    // state, and stopping is then taken as not started.
    const skipped = typeof after?.started === 'boolean' ? !after.started && asked.app === 'stopping' : asked.app === 'stopping';
    if (skipped) throw fail(stillStopping, { code: EXIT.failed, status: 'stopping' });
    if (json) emit({ event: 'app-starting', session: asked });
    // The app asked for: --app's, else the default (the first), which the console's answer does not name yet.
    const target = opts.app || asked.apps?.[0] || asked.appName;
    const which = target && asked.apps?.length > 1 ? ` (${target})` : '';
    say(asked.app === 'stopping'
      ? `Switching session ${id}'s app${which}: the running one stops first, then it starts, in one to three minutes.`
      : `Starting session ${id}'s app${which}: one to three minutes.`);
    if (opts.wait === false) return EXIT.done;
    // Up once its frontend and backend both answer. Between the start script's end and its servers listening it can
    // read as stopped or half up for a moment, so only a failed start ends the wait early.
    const until = now() + APP_START_DEADLINE_MS;
    const isOther = (y) => Boolean(target && y.apps?.length > 1 && y.appName && y.appName !== target);
    let last = asked;
    for (;;) {
      await sleep(POLL_MS);
      const got = await list();
      const latest = got.sessions.find((y) => y.id === id);
      if (!latest || latest.status !== 'running') throw fail(`Session ${id} stopped while its app was starting.`);
      last = summary(latest, { origin, login: got.login, appsOn });
      // Up only as the app asked for: with several, another one's servers still answering (one with no stop command,
      // left beside it) is not this one up.
      if (last.app === 'running' && !isOther(last)) {
        if (json) emit({ event: 'app-running', session: last });
        say(`Its app is up: ${last.appUrl}`);
        return EXIT.done;
      }
      if (last.app === 'failed' || now() >= until) break;
    }
    if (json) emit({ event: 'app-not-up', session: last });
    say(last.app === 'failed' ? `Its app: ${appText(last)}`
      : last.app === 'running' && isOther(last) ? `${target} is not up after ${APP_START_DEADLINE_MS / 60_000} minutes: the session says ${last.appName} is the one running. Its start log is /tmp/woodshed-app.log in the session.`
      : `Its app is not up after ${APP_START_DEADLINE_MS / 60_000} minutes: ${appText(last) || 'it says nothing yet'}. Its start log is /tmp/woodshed-app.log in the session.`);
    return EXIT.failed;
  }

  // Who besides you may open your session's app, as the page's Share the app says it and changes it: the members
  // switch, and links anyone can open (console/appShares.mjs). A link's token is printed once, as the page shows it once.
  async function share() {
    ownPrivate(s, login, 'share the app of');
    if (s.kind === 'ask') throw fail(`Session ${id} answers a question from Slack: it has no app.`, { code: EXIT.refused, status: 'refused' });
    if (!servesApps(appsOn)) throw fail(`${origin} serves no session apps: there is no app to share.`, { code: EXIT.refused, status: 'refused' });
    // App ports are a console nobody signs in to, whose page has no Share the app.
    if (appsOn.ports) throw fail(`${origin} lends its session apps ports, and nobody signs in to it: their links already open for whoever reaches the console, so there is nothing to share.`, { code: EXIT.refused, status: 'refused' });
    if (s.taintedAt && (opts.link || opts.members === 'on')) throw fail(`Session ${id} has seen production data: its app is never shared.`, { code: EXIT.refused, status: 'refused' });
    const base = `/api/sessions/${id}/app-share`;
    let answer;
    try {
      if (opts.members) answer = await ask(`${base}/members`, { method: 'POST', body: { on: opts.members === 'on' } });
      else if (opts.link) answer = await ask(`${base}/links`, { method: 'POST', body: { hours: opts.hours, ...(opts.path && { path: opts.path }) } });
      else if (opts.revoke) answer = await ask(`${base}/links/${opts.revoke}/revoke`, { method: 'POST', body: {} });
      else answer = await ask(base);
    } catch (err) {
      // The console's own rules: not running, a shared session, production data, ten links already. A link it does not
      // know is a mistake in what was asked.
      if (opts.revoke && err.http === 404 && /no such link/.test(err.message)) throw fail(`Session ${id} has no live link ${opts.revoke}: woodshed session app ${id} share lists them.`);
      if (err.http === 409 || err.http === 404 || (err.http === 400 && /at most/.test(err.message))) throw fail(err.message, { code: EXIT.refused, status: 'refused' });
      throw err;
    }
    const shown = shareView(answer);
    const x = summary(s, { origin, login, appsOn });
    const ends = x.pause ? ` (it ${x.pause.why === 'lifetime' ? 'stops' : 'pauses'} ${pauseText(x.pause, now()).replace(/, \w+$/, '')})` : '';
    const lasts = `Sharing ends when the session pauses or stops${ends}: woodshed session limits ${id} keeps it up longer.`;
    if (opts.link) {
      const url = typeof answer.url === 'string' && /^https?:\/\//.test(answer.url) ? printable(answer.url, 4000) : null;
      if (!url) throw fail(`${origin} made link ${printable(answer.created, 20) ?? ''} but did not send it back: revoke it with woodshed session app ${id} share --revoke <link id>.`);
      const link = shown.links.find((l) => l.id === answer.created) ?? null;
      // A console from before a link's own path makes it without one: it lands on the app's home.
      const landed = opts.path ? new URL(url).searchParams.has('next') : null;
      if (json) emit({ event: 'link', id, link, url, path: landed ? printable(answer.path, 500) : null, share: shown });
      say(`Link ${link?.id ?? printable(answer.created, 20)} to session ${id}'s app, for ${HOURS_WORDS[opts.hours]}${link ? `, ending ${utc(link.expiresAt)}` : ''}:`);
      say(`  ${url}`);
      say(`This link is a secret, shown only now: anyone who has it can open the app as the session's signed-in user, and change its data, until it expires, you revoke it (woodshed session app ${id} share --revoke ${link?.id ?? printable(answer.created, 20)}), or the session pauses or stops. Give it to the person it is for; do not post it anywhere.`);
      if (opts.path && !landed) say(`${origin} does not take a page for the link to land on: after opening it, go to ${opts.path} on the app.`);
      say(lasts);
      if (appsOn.signIn === false) say(`Nobody signs in to ${origin}, so its app link already opens for whoever reaches the console.`);
      return EXIT.done;
    }
    const event = opts.members ? 'members' : opts.revoke ? 'revoked' : 'share';
    if (json) emit({ event, id, ...(opts.revoke && { link: opts.revoke }), share: shown });
    if (opts.revoke) say(`Revoked link ${opts.revoke}: it opens nothing now.`);
    say(`Session ${id}'s app${shown.appUrl ? `, ${shown.appUrl}` : ''}:`);
    say(`  Members of this console: ${shown.members ? 'on, anyone signed in to the console can open it' : 'off'}`);
    if (!shown.links.length) say('  Links: none');
    for (const l of shown.links) say(`  Link ${l.id}: made${l.by ? ` by @${l.by}` : ''} ${utc(l.createdAt)}, ends ${utc(l.expiresAt)}`);
    if (!shown.members && !shown.links.length) say('  Only you can open it.');
    if (shown.members || shown.links.length) say(lasts);
    if (appsOn.signIn === false) say(`Nobody signs in to ${origin}, so its app link already opens for whoever reaches the console.`);
    return EXIT.done;
  }

  if (sub === 'get') {
    const x = summary(s, { origin, login, appsOn });
    if (json) {
      emit({ session: x });
      return EXIT.done;
    }
    const hoursText = (h) => (h === null ? '?' : `${h} h`);
    const rows = [
      ['Session', `${x.id}${x.title ? `  ${x.title}` : ''}`],
      ['State', `${x.stateWord} (${x.status})`],
      ['Kind', {
        private: 'private', shared: 'shared', ask: 'a question from Slack',
        review: `a review of pull request #${x.pullRequest?.number ?? '?'}, started by the console`,
        qa: `QA of pull request #${x.pullRequest?.number ?? '?'}, started by the console`,
      }[x.kind]],
      ['Whose', x.kind === 'review' || x.kind === 'qa' ? (x.startedBy ? `for @${x.startedBy}${x.inMine ? ' (you)' : ''}` : '')
        : x.mine ? 'yours' : x.shared ? `shared${x.assignee ? `, @${x.assignee} has it` : ', nobody has it'}` : `@${x.owner}`],
      ['Project', [x.project, x.branch && `branch ${x.branch}`].filter(Boolean).join(', ')],
      ['Agent', [x.agent, x.model].filter(Boolean).join(', ')],
      ['Pauses', x.pause ? `${pauseText(x.pause, now())} (${x.pause.at.slice(0, 16).replace('T', ' ')} UTC)` : LIVE.has(x.status) ? 'not yet: it is busy, or starting' : 'not running'],
      ['Runs on', x.runsOn ? `${hoursText(x.runsOn.idleHours)} idle, ${hoursText(x.runsOn.lifetimeHours)} lifetime${x.ownLimits ? ' (its own)' : ''}` : ''],
      ['Pull req.', x.pullRequest?.url ?? x.prUrl ?? ''],
      ['App', appText(x)],
      ['Verdict', x.verdict ?? ''],
      ['Stopped', x.status === 'running' ? '' : [x.stopReason, x.error].filter(Boolean).join(': ')],
      ['Open', x.url],
    ];
    for (const [label, value] of rows) if (value) say(`${`${label}:`.padEnd(11)}${value}`);
    return EXIT.done;
  }

  if (sub === 'extend') {
    if (s.status !== 'running') throw fail(`Session ${id} is not running: it is ${stateOf(s).word}. Only a running session can be extended.`, { code: EXIT.refused, status: 'refused' });
    const after = summary({ ...s, ...(await ask(`/api/sessions/${id}/extend`, { method: 'POST', body: {}, policy400: true })) }, { origin, login, appsOn });
    if (json) emit({ event: 'extended', session: after });
    say(after.pause ? `Session ${id} now ${after.pause.why === 'lifetime' ? 'stops' : 'pauses'} ${pauseText(after.pause, now()).replace(/, \w+$/, '')}.` : `Session ${id} was extended.`);
    return EXIT.done;
  }

  if (sub === 'limits') {
    // The session's own, with what was asked changed: a key left out would go back to its owner's or the console's.
    const own = s.limits && typeof s.limits === 'object' ? s.limits : {};
    const body = { idleHours: own.idleHours ?? null, lifetimeHours: own.lifetimeHours ?? null };
    for (const [flag, key] of [['idle-hours', 'idleHours'], ['lifetime-hours', 'lifetimeHours']]) {
      if (opts[flag] === undefined) continue;
      if (opts[flag] === 'default') body[key] = null;
      else {
        const value = Number(opts[flag]);
        if (!Number.isFinite(value) || value <= 0) throw fail(`--${flag} must be a number of hours, or default`);
        body[key] = value;
      }
    }
    const after = summary({ ...s, ...(await ask(`/api/sessions/${id}/limits`, { method: 'POST', body })) }, { origin, login, appsOn });
    if (json) emit({ event: 'limits', session: after });
    const runs = after.runsOn ? `${after.runsOn.idleHours} h idle, ${after.runsOn.lifetimeHours} h lifetime` : 'its new limits';
    say(`Session ${id} runs on ${runs}${after.pause ? `; it ${after.pause.why === 'lifetime' ? 'stops' : 'pauses'} ${pauseText(after.pause, now()).replace(/, \w+$/, '')}` : ''}.`);
    return EXIT.done;
  }

  // remove
  ownPrivate(s, login, 'remove');
  if (!opts.yes) {
    const stops = LIVE.has(s.status) ? 'It is stopped first, its work pushed. ' : '';
    const answer = await confirm(`Remove "${printable(s.title) ?? id}"? ${stops}Its saved conversation goes, so resume cannot reopen it. The branch stays on GitHub. [y/N] `);
    if (answer === null) throw fail(`Removing session ${id} deletes its saved conversation: add --yes to remove it.`, { code: EXIT.waiting, status: 'confirm' });
    if (!answer) {
      if (json) emit({ event: 'kept', id });
      say('Kept.');
      return EXIT.done;
    }
  }
  await ask(`/api/my/sessions/${id}/remove`, { method: 'POST', body: {}, deadlineMs: STOP_DEADLINE_MS });
  // Its machine in Herdr goes too, so ended sessions do not pile up in the sidebar. With no hc here there is none.
  const name = machineName(id);
  let machine = null;
  if ((await hcVersion(ctx.hc)).ok) {
    try {
      machine = { name, removed: await removeMachine(ctx.hc, name, { origin, session: id }) };
    } catch (err) {
      if (!err.hc) throw err;
      machine = { name, removed: false, error: printable(err.message, 500) };
    }
  }
  if (json) emit({ event: 'removed', id, machine });
  say(`Removed session ${id}.`);
  if (machine?.removed) say(`Forgot ${name} in Herdr.`);
  // Not looked at, so not named as this session's: the person checks its line before forgetting it.
  if (machine?.error) stderr.write(`woodshed: ${machine.error}. If hc machine ls shows ${name} reached by woodshed tunnel ${id}, forget it with: hc machine rm ${name}\n`);
  return EXIT.done;
}

// A link's expiries, as the page's Share the app offers them (console/public/appShare.js, EXPIRIES).
export const SHARE_HOURS = [1, 24, 168];
const SHARE_VALUES = ['members', 'hours', 'path', 'revoke'];
// What never goes into a path to print or send: UNPRINTABLE_RE's characters, without its /g (whose test keeps state).
const CONTROL_RE = new RegExp(UNPRINTABLE_RE.source);
const HOURS_WORDS = { 1: '1 hour', 24: '1 day', 168: '7 days' };
const LINK_ID_RE = /^[0-9a-f]{8}$/;

/** @returns {string}  a console's time as `2026-11-20 10:00 UTC`, or `?` */
function utc(ms) {
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '?';
}

/**
 * What the console says of who may open a session's app, its strings made safe to print. Never a token: the console's
 * view has none, and the one link URL a make answers with is printed on its own.
 * @returns {{appUrl: string|null, members: boolean, links: {id: string, by: string|null, createdAt: number|null, expiresAt: number|null}[]}}
 */
export function shareView(body) {
  const links = Array.isArray(body?.links) ? body.links : [];
  return {
    appUrl: typeof body?.appUrl === 'string' && /^https?:\/\//.test(body.appUrl) ? printable(body.appUrl, 300) : null,
    members: body?.members === true,
    links: links.filter((l) => l && LINK_ID_RE.test(l.id)).map((l) => ({
      id: l.id,
      by: typeof l.by === 'string' ? printable(l.by, 60) : null,
      createdAt: Number.isFinite(l.createdAt) ? l.createdAt : null,
      expiresAt: Number.isFinite(l.expiresAt) ? l.expiresAt : null,
    })),
  };
}

/**
 * @returns {{prompt?: string, repo?: string, branch?: string, agent?: string, model?: string, wait?: boolean,
 *            all?: boolean, yes?: boolean, id?: string, action?: 'start'|'stop', app?: string}}
 */
export function parseSessionArgs(sub, words, fail) {
  const commands = {
    new: { values: ['repo', 'branch', 'agent', 'model'], flags: ['no-wait', 'connect', 'herdr', ...PARENT_FLAGS], optional: ['parent'], words: 'prompt' },
    connect: { values: [], flags: ['shell'], words: 'id' },
    herdr: { values: [], flags: [...PARENT_FLAGS], optional: ['parent'], words: 'id' },
    list: { values: [], flags: ['all'], words: null },
    get: { values: [], flags: [], words: 'id' },
    app: { values: ['app', ...SHARE_VALUES], flags: ['no-wait', 'link'], words: 'id-action' },
    extend: { values: [], flags: [], words: 'id' },
    limits: { values: ['idle-hours', 'lifetime-hours'], flags: [], words: 'id' },
    stop: { values: [], flags: [], words: 'id' },
    resume: { values: [], flags: ['no-wait', 'herdr'], words: 'id' },
    remove: { values: [], flags: ['yes'], words: 'id' },
    prune: { values: [], flags: [], words: null },
    watch: { values: ['kind', 'every'], flags: ['everyone', 'herdr', 'add'], words: null },
  };
  // Its own keys only: `constructor` or `toString` is no command.
  const takes = Object.hasOwn(commands, sub) ? commands[sub] : null;
  if (!takes) throw fail(`unknown session command ${sub}\n\n${SESSION_USAGE}`);
  const out = {};
  const positional = [];
  let ownWords = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (ownWords || !word.startsWith('-')) {
      positional.push(word);
      continue;
    }
    if (word === '--') {
      ownWords = true;
      continue;
    }
    const [name, inline] = word.replace(/^--/, '').split(/=(.*)/s);
    if (takes.optional?.includes(name)) {
      // A value after `=`, or as the next word only when it reads as an hc address (t7, t1b): any other word is the
      // prompt's or the id, so a terminal's name goes after `=`.
      if (inline !== undefined) {
        if (inline === '') throw fail(`--${name}= needs a terminal`);
        out[name] = inline;
      } else if (looksLikeAddress(words[i + 1])) out[name] = words[++i];
      else out[name] = true;
    } else if (takes.values.includes(name)) {
      const value = inline ?? words[++i];
      if (value === undefined || value === '') throw fail(`--${name} needs a value`);
      out[name] = value;
    } else if (takes.flags.includes(name) && inline === undefined) {
      if (name === 'no-wait') out.wait = false;
      else out[name] = true;
    } else throw fail(`unknown option ${word} for session ${sub}\n\n${SESSION_USAGE}`);
  }
  for (const flag of PARENT_FLAGS) if (out[flag] && !out.parent) throw fail(`--${flag} goes with --parent`);
  if (sub === 'resume' && out.herdr && out.wait === false) throw fail('--herdr waits for the session to run: leave out --no-wait');
  if (sub === 'limits' && out['idle-hours'] === undefined && out['lifetime-hours'] === undefined) throw fail('session limits needs --idle-hours or --lifetime-hours (a number, or default)');
  if (out.agent !== undefined && !AGENT_IDS.includes(out.agent)) throw fail(`--agent must be one of ${AGENT_IDS.join(', ')}`);
  // An app's name, never the next option taken for one (`--app --no-wait`).
  if (out.app !== undefined && !APP_NAME_RE.test(out.app)) throw fail(`--app needs an app's name: lowercase letters, digits and dashes, as the project file names them${out.app.startsWith('-') ? `, not ${out.app}` : ''}`);
  if (sub === 'watch') {
    out.kinds = parseKinds(out.kind, fail);
    out.everyMs = parseEvery(out.every, fail);
  }
  if (takes.words === 'prompt') out.prompt = positional.join(' ');
  else if (takes.words === 'id-action') {
    // session app <id> [start|stop|share]
    if (positional.length < 1 || positional.length > 2) throw fail(`session ${sub} takes a session id, then start, stop or share\n\n${SESSION_USAGE}`);
    if (positional[1] !== undefined && !['start', 'stop', 'share'].includes(positional[1])) throw fail(`session app ${positional[1]}: start, stop or share`);
    if (!ID_RE.test(positional[0])) throw fail(`${positional[0]} is not a session id: eight letters and digits, as woodshed session list shows`);
    [out.id, out.action] = positional;
  } else if (takes.words === 'id') {
    if (positional.length !== 1) throw fail(`session ${sub} takes one session id\n\n${SESSION_USAGE}`);
    if (!ID_RE.test(positional[0])) throw fail(`${positional[0]} is not a session id: eight letters and digits, as woodshed session list shows`);
    [out.id] = positional;
  } else if (positional.length) throw fail(`unexpected ${positional[0]}\n\n${SESSION_USAGE}`);
  if (sub === 'app') checkShareArgs(out, fail);
  return out;
}

// session app <id> share's options: only with share, one at a time, and an expiry the page offers.
function checkShareArgs(out, fail) {
  const shareOpts = [...SHARE_VALUES, 'link'].filter((k) => out[k] !== undefined);
  if (out.action !== 'share') {
    if (shareOpts.length) throw fail(`--${shareOpts[0]} is for share: woodshed session app <id> share --${shareOpts[0]} …`);
    return;
  }
  if (out.app !== undefined || out.wait === false) throw fail(`--${out.app !== undefined ? 'app' : 'no-wait'} is for start, not share`);
  const asked = ['members', 'link', 'revoke'].filter((k) => out[k] !== undefined);
  if (asked.length > 1) throw fail(`session app share takes one of --members, --link and --revoke at a time, not ${asked.map((k) => `--${k}`).join(' and ')}`);
  if (out.members !== undefined && !['on', 'off'].includes(out.members)) throw fail('--members must be on or off');
  if (out.revoke !== undefined && !LINK_ID_RE.test(out.revoke)) throw fail(`--revoke needs a link's id: eight letters and digits, as woodshed session app <id> share lists them`);
  if ((out.hours !== undefined || out.path !== undefined) && !out.link) throw fail(`--${out.hours !== undefined ? 'hours' : 'path'} goes with --link`);
  if (out.link) {
    const hours = out.hours === undefined ? 24 : Number(out.hours);
    if (!SHARE_HOURS.includes(hours) || !/^\d+$/.test(out.hours ?? '24')) throw fail(`--hours must be 1, 24 or 168 (an hour, a day or a week, as the page's Share the app offers), not ${out.hours}`);
    out.hours = hours;
  }
  // The app's home is where a link lands anyway: no path to ask for.
  if (out.path === '/') delete out.path;
  if (out.path !== undefined && (!out.path.startsWith('/') || /^\/[/\\]/.test(out.path) || out.path.length > 500 || CONTROL_RE.test(out.path))) throw fail(`--path needs a page of the app, starting with one /, such as /landing-a${out.path.startsWith('-') ? `, not ${printable(out.path, 60)}` : ''}`);
}
