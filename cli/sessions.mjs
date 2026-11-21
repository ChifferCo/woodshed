// `woodshed session`: start, list, stop, resume and remove Woodshed sessions from the command line, through the
// console's own session routes, signed in with the command line's token (console/cliSessions.mjs lists the routes it
// reaches). A session started here is a private one, as My Woodshed's New session starts.
//
//   woodshed session new [--repo R] [--branch B] [--agent claude|codex] [--model M] [--no-wait|--connect|--herdr] ["prompt"]
//   woodshed session connect <id> [--shell]
//   woodshed session herdr <id>
//   woodshed session list [--all]
//   woodshed session get <id>
//   woodshed session app <id> [start [--app <name>] [--no-wait]|stop]
//   woodshed session stop <id>
//   woodshed session resume <id> [--no-wait]
//   woodshed session remove <id> [--yes]
//   woodshed session prune
//   woodshed session extend <id>
//   woodshed session limits <id> [--idle-hours <n>|default] [--lifetime-hours <n>|default]
//
// Nothing here keeps a session awake: it pauses when idle and stops at its lifetime, as its limits say, unless its
// person (or their agent) asks for more time with extend or limits. list and get say when each will.
//
// app says whether the session's app runs and where it opens, and starts or stops it, as the page's Open app, Start app
// and Stop app do. Set up app, which asks the session's agent to write the project file's app, stays on the page.
//
// connect puts this terminal on one of your sessions' (terminal.mjs): its agent's, or with --shell the Terminal tab's
// shell, resuming it first when it paused.
// herdr makes one of your sessions a machine in Herdr's hc, `woodshed-<id>`, reached through `woodshed tunnel` (hc.mjs),
// resuming it first when it paused; remove forgets that machine too. A session removed elsewhere (the console's page, or
// the console cleaning it up) leaves its machine behind, unreachable: list says so, and prune forgets those.

import { HC_MINIMUM, addMachine, agentOn, hcVersion, leftoverMachines, machineName, nameAgentPlace, removeMachine, shellQuote } from './hc.mjs';

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
const UNREACHABLE_GIVE_UP_MS = 60_000;

export const SESSION_USAGE = `Usage: woodshed session <command> [--console <url>] [--json]

Commands:
  new [options] ["prompt"]   start a private session, and wait until it runs, fails or needs you
      --repo <owner/name>    the repo to work on (default: the one New session opens on for you)
      --branch <branch>      work on this branch, or a pull request or issue: 123, pr 123, or its URL
      --agent claude|codex   the agent it runs (default claude)
      --model <model>        the agent's model (default the agent's own)
      --no-wait              print the session and return once the console has it
      --connect              once it runs, put this terminal on its agent's, as connect does
      --herdr                once it runs, add it to Herdr as herdr does
  connect <id> [--shell]     put this terminal on one of your sessions' agent (the console's TUI tab), or with --shell
                             its shell (the Terminal tab); a paused one is resumed first. Ctrl-\\ disconnects, and the
                             session goes on
  herdr <id>                 make one of your sessions a machine in Herdr (hc ${HC_MINIMUM} or newer), woodshed-<id>,
                             reached through woodshed tunnel; a paused one is resumed first, and waited for
  list [--all]               your sessions and the shared ones you can see, with their state and when each
                             pauses or stops by itself; --all also lists those that ended
  get <id>                   one session: its state, branch, pull request, its app, and when it pauses or stops
  app <id> [start|stop]      whether a running session's app is up, and its link to open in a browser; start starts
                             it (one to three minutes) and waits until it is up, stop stops it
      --app <name>           start this one of the project's apps, where it has several
      --no-wait              return once the session has been asked to start it
  stop <id>                  stop a session; a running one's work is pushed as it stops
  resume <id> [--no-wait]    start one of your stopped sessions again, its conversation and all, and wait for it
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
const ID_RE = /^[0-9a-f]{8}$/;

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
  const agent = s.options?.agent === 'codex' ? 'codex' : 'claude';
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

/** @returns {boolean}  a session that ended for good: nothing of it is kept to resume */
function ended(s) {
  if (LIVE.has(s.status)) return false;
  if (s.owner) return false;
  return !s.kept || s.kind === 'ask';
}

/**
 * Where a running session's app opens, as the console's page links Open app (console/public/common.js, appUrl): its
 * own name under the console's app domain, on the console's scheme and port; with app ports, the port the console
 * lent it, or the console's /auth/app, which lends one. A browser signed in to the console opens it.
 * @param {{domain: string|null, ports: boolean}|null} appsOn  what the console's list says of session apps
 * @returns {string|null}  none while the session is not running, has no app, or the console serves no session apps
 */
export function appUrlOf(s, { origin, appsOn }) {
  if (!appsOn?.domain || s.status !== 'running' || s.kind === 'ask' || !APP_STATES.has(s.app) || s.app === 'none') return null;
  if (appsOn.ports) return typeof s.appUrl === 'string' && /^https?:\/\//.test(s.appUrl) ? printable(s.appUrl, 300) : `${origin}/auth/app?id=${s.id}&next=/`;
  const { protocol, port } = new URL(origin);
  return `${protocol}//${s.id}.${appsOn.domain}${port ? `:${port}` : ''}/`;
}

/** @returns {{domain: string|null, ports: boolean}}  what the console's list says of session apps */
function appsOnOf(body) {
  const domain = typeof body?.appDomain === 'string' && body.appDomain.length <= 253 && HOST_RE.test(body.appDomain) ? body.appDomain.toLowerCase() : null;
  return { domain, ports: body?.appPorts === true };
}

/** @returns {string}  what `get` and a start say of the session's app, with the next step; empty when it has none to say */
export function appText(x) {
  const label = x.appName && x.apps?.length > 1 ? ` (${x.appName})` : '';
  const start = `woodshed session app ${x.id} start`;
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
  return {
    id: s.id,
    title: printable(s.title),
    status: printable(s.status, 30),
    state: key,
    stateWord: word,
    mine: Boolean(s.owner) && s.owner === login,
    shared: !s.owner,
    owner: printable(s.owner, 60),
    assignee: printable(s.assignee, 60),
    project: printable(s.project, 60),
    repo: printable(s.repo, 100),
    branch: printable(s.branch, 200),
    agent: s.options?.agent === 'codex' ? 'codex' : 'claude',
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
    // the link that opens it in a browser signed in to the console. null when there is nothing to open.
    app: appsOn?.domain && s.status === 'running' && s.kind !== 'ask' && APP_STATES.has(s.app) ? s.app : null,
    appName: printable(s.appName, 60),
    apps: Array.isArray(s.apps) ? s.apps.map((a) => printable(a?.name, 60)).filter(Boolean) : null,
    appUrl: appUrlOf(s, { origin, appsOn }),
  };
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

  // A running session of yours made a machine in hc. Its agent is there only when you picked Herdr on My settings: in
  // tmux otherwise, which hc cannot reach, though new terminals and agents on the machine work. Exits as a start's wait
  // does: waiting on you when the session asks for you.
  async function connect(s, login) {
    const name = machineName(s.id);
    if (!json) say(`Adding ${s.id} to Herdr as ${name}…`);
    let added;
    try {
      added = await addMachine(ctx.hc, { name, via: ctx.via(s.id) });
    } catch (err) {
      if (!err.hc) throw err;
      throw fail(printable(err.message, 500));
    }
    const agent = await agentOn(ctx.hc, name, { place: ctx.placeHerdrAgent !== false }).catch(() => ({ inHerdr: null, address: null }));
    const shown = summary(s, { origin, login, appsOn });
    // Its space named after the session's title and its tab after its agent, in the Herdr app's window. The console
    // names a session a few seconds after it starts: running this again picks the title up. Not for move, which lays
    // out its own spaces.
    if (agent.inHerdr && ctx.placeHerdrAgent !== false && ctx.app) {
      const named = await nameAgentPlace(ctx.hc, ctx.app, { machine: name, address: agent.address, title: shown.title, agent: shown.agent, sleep })
        .catch((err) => ({ space: null, tab: null, error: err.message }));
      if (named.space || named.tab) agent.named = { space: named.space, tab: named.tab };
      if (named.error) agent.namingError = printable(named.error, 500);
    }
    const code = shown.state === 'needs-you' ? EXIT.waiting : EXIT.done;
    if (json) {
      emit({ event: 'connected', session: shown, machine: { name, action: added.action, state: added.state }, agent });
      return code;
    }
    say(added.action === 'kept' ? `${name} was already in Herdr, connected.` : `${name} is in Herdr: it shows in the app's sidebar.`);
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
    const what = kind === 'shell' ? 'shell' : `${s.options?.agent === 'codex' ? 'codex' : 'claude'}'s terminal`;
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
    if (opts.herdr) {
      if (opts.wait === false) throw fail('--herdr waits for the session to run: leave out --no-wait');
      await hcReady();
    }
    // With no --repo, the one New session opens on for this person (a default they saved), never the console's own.
    const project = opts.repo ? await projectFor(opts.repo) : await defaultProjectName();
    const body = {
      prompt: opts.prompt, workOn: opts.branch ?? '', agent: opts.agent ?? 'claude', model: opts.model ?? '', ...(project ? { project } : {}),
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
    const found = await find(shown.id);
    if (opts.connect) return onTerminal(found.s, 'term');
    return connect(found.s, found.login);
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
    const gone = await leftovers(sessions);
    if (json) {
      emit({ console: origin, login, sessions: shown, ...(gone ? { herdrLeftovers: gone.map((m) => m.name) } : {}) });
      return EXIT.done;
    }
    if (!shown.length) say(opts.all ? 'No sessions.' : 'No sessions. --all also lists those that ended.');
    else {
      const whose = (x) => (x.mine ? 'mine' : x.shared ? (x.assignee ? (x.assignee === login ? 'you' : `@${x.assignee}`) : 'shared') : `@${x.owner}`);
      const rows = [['ID', 'STATE', 'WHOSE', 'PAUSES', 'PROJECT', 'TITLE'], ...shown.map((x) => [x.id, x.stateWord, whose(x), pauseText(x.pause, now()) || '-', x.project ?? '', x.title ?? ''])];
      const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
      for (const row of rows) say(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd());
    }
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
    const after = await ask(`/api/my/sessions/${id}/resume`, { method: 'POST', body: {} });
    if (json) emit({ event: 'resumed', session: summary({ ...s, ...after }, { origin, login, appsOn }), already: false });
    say(`Resuming session ${id}${s.title ? `: ${printable(s.title)}` : ''}`);
    if (opts.wait === false) return EXIT.done;
    return follow(id);
  }

  if (sub === 'resume') {
    ownPrivate(s, login, 'resume');
    return resumeAndWait();
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
    await hcReady();
    if (s.status === 'running') return connect(s, login);
    const resumed = await resumeAndWait();
    if (resumed !== EXIT.done && resumed !== EXIT.waiting) return resumed;
    const found = await find(id);
    return connect(found.s, found.login);
  }

  if (sub === 'app') {
    const x = summary(s, { origin, login, appsOn });
    if (s.kind === 'ask') throw fail(`Session ${id} answers a question from Slack: it has no app.`, { code: EXIT.refused, status: 'refused' });
    if (!appsOn?.domain) throw fail(`${origin} serves no session apps: a session's app opens only on a console with an app domain or app ports.`, { code: EXIT.refused, status: 'refused' });
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
    if (opts.app !== undefined && opts.action !== 'start') throw fail('--app picks the app to start: use it with start');
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
      if (json) emit({ event: 'app-stopping', session: asked });
      say(`Stopping session ${id}'s app.`);
      return EXIT.done;
    }
    if (json) emit({ event: 'app-starting', session: asked });
    say(`Starting session ${id}'s app${asked.appName && asked.apps?.length > 1 ? ` (${asked.appName})` : ''}: one to three minutes.`);
    if (opts.wait === false) return EXIT.done;
    // Up once its frontend and backend both answer. Between the start script's end and its servers listening it can
    // read as stopped or half up for a moment, so only a failed start ends the wait early.
    const until = now() + APP_START_DEADLINE_MS;
    let last = asked;
    for (;;) {
      await sleep(POLL_MS);
      const got = await list();
      const latest = got.sessions.find((y) => y.id === id);
      if (!latest || latest.status !== 'running') throw fail(`Session ${id} stopped while its app was starting.`);
      last = summary(latest, { origin, login: got.login, appsOn });
      if (last.app === 'running') {
        if (json) emit({ event: 'app-running', session: last });
        say(`Its app is up: ${last.appUrl}`);
        return EXIT.done;
      }
      if (last.app === 'failed' || now() >= until) break;
    }
    if (json) emit({ event: 'app-not-up', session: last });
    say(last.app === 'failed' ? `Its app: ${appText(last)}` : `Its app is not up after ${APP_START_DEADLINE_MS / 60_000} minutes: ${appText(last) || 'it says nothing yet'}. Its start log is /tmp/woodshed-app.log in the session.`);
    return EXIT.failed;
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
      ['Whose', x.mine ? 'yours' : x.shared ? `shared${x.assignee ? `, @${x.assignee} has it` : ', nobody has it'}` : `@${x.owner}`],
      ['Project', [x.project, x.branch && `branch ${x.branch}`].filter(Boolean).join(', ')],
      ['Agent', [x.agent, x.model].filter(Boolean).join(', ')],
      ['Pauses', x.pause ? `${pauseText(x.pause, now())} (${x.pause.at.slice(0, 16).replace('T', ' ')} UTC)` : LIVE.has(x.status) ? 'not yet: it is busy, or starting' : 'not running'],
      ['Runs on', x.runsOn ? `${hoursText(x.runsOn.idleHours)} idle, ${hoursText(x.runsOn.lifetimeHours)} lifetime${x.ownLimits ? ' (its own)' : ''}` : ''],
      ['Pull req.', x.prUrl ?? ''],
      ['App', appText(x)],
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

/**
 * @returns {{prompt?: string, repo?: string, branch?: string, agent?: string, model?: string, wait?: boolean,
 *            all?: boolean, yes?: boolean, id?: string, action?: 'start'|'stop', app?: string}}
 */
export function parseSessionArgs(sub, words, fail) {
  const commands = {
    new: { values: ['repo', 'branch', 'agent', 'model'], flags: ['no-wait', 'connect', 'herdr'], words: 'prompt' },
    connect: { values: [], flags: ['shell'], words: 'id' },
    herdr: { values: [], flags: [], words: 'id' },
    list: { values: [], flags: ['all'], words: null },
    get: { values: [], flags: [], words: 'id' },
    app: { values: ['app'], flags: ['no-wait'], words: 'id-action' },
    extend: { values: [], flags: [], words: 'id' },
    limits: { values: ['idle-hours', 'lifetime-hours'], flags: [], words: 'id' },
    stop: { values: [], flags: [], words: 'id' },
    resume: { values: [], flags: ['no-wait'], words: 'id' },
    remove: { values: [], flags: ['yes'], words: 'id' },
    prune: { values: [], flags: [], words: null },
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
    if (takes.values.includes(name)) {
      const value = inline ?? words[++i];
      if (value === undefined || value === '') throw fail(`--${name} needs a value`);
      out[name] = value;
    } else if (takes.flags.includes(name) && inline === undefined) {
      if (name === 'no-wait') out.wait = false;
      else out[name] = true;
    } else throw fail(`unknown option ${word} for session ${sub}\n\n${SESSION_USAGE}`);
  }
  if (sub === 'limits' && out['idle-hours'] === undefined && out['lifetime-hours'] === undefined) throw fail('session limits needs --idle-hours or --lifetime-hours (a number, or default)');
  if (out.agent !== undefined && !['claude', 'codex'].includes(out.agent)) throw fail('--agent must be claude or codex');
  if (takes.words === 'prompt') out.prompt = positional.join(' ');
  else if (takes.words === 'id-action') {
    // session app <id> [start|stop]
    if (positional.length < 1 || positional.length > 2) throw fail(`session ${sub} takes a session id, then start or stop\n\n${SESSION_USAGE}`);
    if (positional[1] !== undefined && !['start', 'stop'].includes(positional[1])) throw fail(`session app ${positional[1]}: start or stop`);
    if (!ID_RE.test(positional[0])) throw fail(`${positional[0]} is not a session id: eight letters and digits, as woodshed session list shows`);
    [out.id, out.action] = positional;
  } else if (takes.words === 'id') {
    if (positional.length !== 1) throw fail(`session ${sub} takes one session id\n\n${SESSION_USAGE}`);
    if (!ID_RE.test(positional[0])) throw fail(`${positional[0]} is not a session id: eight letters and digits, as woodshed session list shows`);
    [out.id] = positional;
  } else if (positional.length) throw fail(`unexpected ${positional[0]}\n\n${SESSION_USAGE}`);
  return out;
}
