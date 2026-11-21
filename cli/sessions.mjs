// `woodshed session`: start, list, stop, resume and remove Woodshed sessions from the command line, through the
// console's own session routes, signed in with the command line's token (console/cliSessions.mjs lists the routes it
// reaches). A session started here is a private one, as My Woodshed's New session starts.
//
//   woodshed session new [--repo R] [--branch B] [--agent claude|codex] [--model M] [--no-wait|--connect|--herdr [--parent[=T]]] ["prompt"]
//   woodshed session connect <id> [--shell]
//   woodshed session herdr <id> [--parent[=T]]
//   woodshed session list [--all]
//   woodshed session get <id>
//   woodshed session stop <id>
//   woodshed session resume <id> [--no-wait]
//   woodshed session remove <id> [--yes]
//   woodshed session extend <id>
//   woodshed session limits <id> [--idle-hours <n>|default] [--lifetime-hours <n>|default]
//
// Nothing here keeps a session awake: it pauses when idle and stops at its lifetime, as its limits say, unless its
// person (or their agent) asks for more time with extend or limits. list and get say when each will.
//
// connect puts this terminal on one of your sessions' (terminal.mjs): its agent's, or with --shell the Terminal tab's
// shell, resuming it first when it paused.
// herdr makes one of your sessions a machine in Herdr's hc, `woodshed-<id>`, reached through `woodshed tunnel` (hc.mjs),
// resuming it first when it paused; remove forgets that machine too. With --parent the session's agent's terminal is
// made from here, a child of a terminal of this computer's (hc's `run --on` from that terminal), so an agent there can
// `hc wait --children` on it: the session, started or resumed with herdrParent, waits for it rather than make its own.

import { HC_MINIMUM, addMachine, agentOn, hcVersion, machineName, parentTerminal, removeMachine, shellQuote, startAgentTerminal } from './hc.mjs';

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
      --parent[=<t>]         with --herdr: make its agent's terminal a child of a terminal here, this one (HC_TERMINAL_ID)
                             or <t>, so it can hc wait --children on it; run it from a Herdr terminal. The agent starts
                             as Woodshed starts it, in Herdr whatever My settings says, and outlives its parent
      --no-notify            with --parent: Herdr types no notes about the agent into its parent
      --end-with-parent      with --parent: the agent ends when its parent's program does (hc's own default)
  connect <id> [--shell]     put this terminal on one of your sessions' agent (the console's TUI tab), or with --shell
                             its shell (the Terminal tab); a paused one is resumed first. Ctrl-\\ disconnects, and the
                             session goes on
  herdr <id>                 make one of your sessions a machine in Herdr (hc ${HC_MINIMUM} or newer), woodshed-<id>,
                             reached through woodshed tunnel; a paused one is resumed first, and waited for
      --parent[=<t>]         resume it with its agent's terminal a child of a terminal here, as new's --parent does
      --no-notify            (and --no-notify, --end-with-parent as there). A running session's terminal is there
      --end-with-parent      already, with no parent, and hc gives a terminal its parent only as it starts: only one
                             still waiting for its terminal (started with --parent) takes one
  list [--all]               your sessions and the shared ones you can see, with their state and when each
                             pauses or stops by itself; --all also lists those that ended
  get <id>                   one session: its state, branch, pull request, and when it pauses or stops
  stop <id>                  stop a session; a running one's work is pushed as it stops
  resume <id> [--no-wait]    start one of your stopped sessions again, its conversation and all, and wait for it
  remove <id> [--yes]        take one of your sessions off the list, with its saved conversation (stopped first),
                             and forget its machine in Herdr
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
// What goes with --parent: hc's --no-notify, and its own default of ending with the parent, which a session does not take.
const PARENT_FLAGS = ['no-notify', 'end-with-parent'];
// An hc terminal address here (`t7`, `t1b`): at most hc's 32 characters, read in one pass.
const looksLikeAddress = (word) => typeof word === 'string' && word.length <= 32 && /^t\d+(?:[a-z][a-z0-9]*)?$/.test(word);
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

/** The fields the command line prints of a session, with the console's text made printable. */
export function summary(s, { origin, login }) {
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

  async function list() {
    const body = await ask('/api/sessions');
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
      const shown = summary(s, { origin, login: got.login });
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
  async function connect(s, login, parent = null) {
    const name = machineName(s.id);
    if (!json) say(`Adding ${s.id} to Herdr as ${name}…`);
    let added;
    let child = null;
    try {
      added = await addMachine(ctx.hc, { name, via: ctx.via(s.id) });
      if (parent) child = await startAgentTerminal(ctx.hc, { machine: name, parent, notify: !opts['no-notify'], outlive: !opts['end-with-parent'] });
    } catch (err) {
      if (!err.hc) throw err;
      throw fail(printable(err.message, 500));
    }
    const agent = await agentOn(ctx.hc, name, { place: ctx.placeHerdrAgent !== false }).catch(() => ({ inHerdr: null, address: null }));
    const shown = summary(s, { origin, login });
    let code = shown.state === 'needs-you' ? EXIT.waiting : EXIT.done;
    // Asked for and not given: the machine stays added, and the exit says the parent was not.
    const noParent = child && !child.made
      ? `Its agent's terminal ${child.why === 'taken' ? 'was started by the session itself, its wait for this one over,' : 'was already there,'} with no parent: hc gives a terminal its parent only as it starts. Run woodshed session new --herdr --parent for a session whose agent is a child of this terminal.`
      : null;
    if (noParent) code = EXIT.failed;
    const parentField = child ? { parent: child.made ? { made: true, terminal: parent, address: child.address, outlives: !opts['end-with-parent'], notify: !opts['no-notify'] } : { made: false, why: child.why } } : {};
    if (json) {
      emit({ event: 'connected', session: shown, machine: { name, action: added.action, state: added.state }, agent, ...parentField });
      if (noParent) emit({ event: 'error', status: 'no-parent', error: noParent });
      return code;
    }
    say(added.action === 'kept' ? `${name} was already in Herdr, connected.` : `${name} is in Herdr: it shows in the app's sidebar.`);
    if (child?.made) {
      say(`Its agent's terminal ${child.address} is a child of ${parent} here${opts['end-with-parent'] ? ', and ends with it' : ', and outlives it'}: hc wait --children any wakes ${parent} when it ends a turn, blocks, errors or exits.`);
    }
    if (noParent) stderr.write(`woodshed: ${noParent}\n`);
    if (agent.placementError) say(`Could not put the agent in a Herdr space: ${printable(agent.placementError, 500)}`);
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
    if (opts.parent && !opts.herdr) throw fail('--parent makes the agent\'s terminal in Herdr: add --herdr');
    if (opts.herdr) {
      if (opts.wait === false) throw fail('--herdr waits for the session to run: leave out --no-wait');
      await hcReady();
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
    const shown = summary(s, { origin, login: s.owner ?? null });
    if (json) emit({ event: 'started', session: shown });
    say(`Started session ${shown.id}${shown.title ? `: ${shown.title}` : ''}`);
    say(`  ${shown.url}`);
    if (opts.wait === false) return EXIT.done;
    const started = await follow(shown.id);
    if ((!opts.herdr && !opts.connect) || (started !== EXIT.done && started !== EXIT.waiting)) return started;
    const found = await find(shown.id);
    if (opts.connect) return onTerminal(found.s, 'term');
    return connect(found.s, found.login, parent);
  }

  if (sub === 'list') {
    const { login, sessions } = await list();
    const shown = sessions.filter((s) => opts.all || !ended(s)).map((s) => summary(s, { origin, login }));
    if (json) {
      emit({ console: origin, login, sessions: shown });
      return EXIT.done;
    }
    if (!shown.length) {
      say(opts.all ? 'No sessions.' : 'No sessions. --all also lists those that ended.');
      return EXIT.done;
    }
    const whose = (x) => (x.mine ? 'mine' : x.shared ? (x.assignee ? (x.assignee === login ? 'you' : `@${x.assignee}`) : 'shared') : `@${x.owner}`);
    const rows = [['ID', 'STATE', 'WHOSE', 'PAUSES', 'PROJECT', 'TITLE'], ...shown.map((x) => [x.id, x.stateWord, whose(x), pauseText(x.pause, now()) || '-', x.project ?? '', x.title ?? ''])];
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const row of rows) say(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd());
    return EXIT.done;
  }

  const id = opts.id;
  const { login, s } = await find(id);

  if (sub === 'stop') {
    // One that stopped by itself (paused, or failed) is still sent: the console then has it wait on nobody, as the page's
    // Stop does. One a person stopped, or that is stopping, has nothing left to do.
    const settled = s.status === 'stopping' || (!LIVE.has(s.status) && (s.stoppedBy || !['stopped', 'failed'].includes(s.status)));
    if (settled) {
      if (json) emit({ event: 'stopped', session: summary(s, { origin, login }), already: true });
      say(`Session ${id} is not running: it is ${stateOf(s).word}.`);
      return EXIT.done;
    }
    const after = await ask(`/api/sessions/${id}/stop`, { method: 'POST', body: {}, deadlineMs: STOP_DEADLINE_MS });
    if (json) emit({ event: 'stopped', session: summary({ ...s, ...after }, { origin, login }), already: !LIVE.has(s.status) });
    // The console's stop answers when it is done, and says nothing of whether the checkpoint pushed: none is made of a
    // session still in line, and a failed one does not hold the stop. So this claims no push.
    say(LIVE.has(s.status) ? `Stopped session ${id}.` : `Session ${id} was already ${stateOf(s).word}: it is marked stopped by you, and waits on nobody now.`);
    return EXIT.done;
  }

  // Resumes one of your own that is not running, or follows one starting, as resume does.
  async function resumeAndWait() {
    if (LIVE.has(s.status)) {
      if (s.status === 'stopping') throw fail(`Session ${id} is stopping: resume it once it has stopped.`);
      if (json) emit({ event: 'resumed', session: summary(s, { origin, login }), already: true });
      say(`Session ${id} is already ${stateOf(s).word}.`);
      if (s.status === 'running') return stateOf(s).key === 'needs-you' ? EXIT.waiting : EXIT.done;
      return opts.wait === false ? EXIT.done : follow(id);
    }
    const after = await ask(`/api/my/sessions/${id}/resume`, { method: 'POST', body: opts.parent ? { herdrParent: true } : {} });
    if (json) emit({ event: 'resumed', session: summary({ ...s, ...after }, { origin, login }), already: false });
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
    const parent = opts.parent ? await parentHere() : null;
    // A running one is taken as it is: only one still waiting for its terminal takes a parent (connect says so).
    if (s.status === 'running') return connect(s, login, parent);
    const resumed = await resumeAndWait();
    if (resumed !== EXIT.done && resumed !== EXIT.waiting) return resumed;
    const found = await find(id);
    return connect(found.s, found.login, parent);
  }

  if (sub === 'get') {
    const x = summary(s, { origin, login });
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
      ['Stopped', x.status === 'running' ? '' : [x.stopReason, x.error].filter(Boolean).join(': ')],
      ['Open', x.url],
    ];
    for (const [label, value] of rows) if (value) say(`${`${label}:`.padEnd(11)}${value}`);
    return EXIT.done;
  }

  if (sub === 'extend') {
    if (s.status !== 'running') throw fail(`Session ${id} is not running: it is ${stateOf(s).word}. Only a running session can be extended.`, { code: EXIT.refused, status: 'refused' });
    const after = summary({ ...s, ...(await ask(`/api/sessions/${id}/extend`, { method: 'POST', body: {}, policy400: true })) }, { origin, login });
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
    const after = summary({ ...s, ...(await ask(`/api/sessions/${id}/limits`, { method: 'POST', body })) }, { origin, login });
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
 *            all?: boolean, yes?: boolean, id?: string}}
 */
export function parseSessionArgs(sub, words, fail) {
  const commands = {
    new: { values: ['repo', 'branch', 'agent', 'model'], flags: ['no-wait', 'connect', 'herdr', ...PARENT_FLAGS], optional: ['parent'], words: 'prompt' },
    connect: { values: [], flags: ['shell'], words: 'id' },
    herdr: { values: [], flags: [...PARENT_FLAGS], optional: ['parent'], words: 'id' },
    list: { values: [], flags: ['all'], words: null },
    get: { values: [], flags: [], words: 'id' },
    extend: { values: [], flags: [], words: 'id' },
    limits: { values: ['idle-hours', 'lifetime-hours'], flags: [], words: 'id' },
    stop: { values: [], flags: [], words: 'id' },
    resume: { values: [], flags: ['no-wait'], words: 'id' },
    remove: { values: [], flags: ['yes'], words: 'id' },
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
  if (sub === 'limits' && out['idle-hours'] === undefined && out['lifetime-hours'] === undefined) throw fail('session limits needs --idle-hours or --lifetime-hours (a number, or default)');
  if (out.agent !== undefined && !['claude', 'codex'].includes(out.agent)) throw fail('--agent must be claude or codex');
  if (takes.words === 'prompt') out.prompt = positional.join(' ');
  else if (takes.words === 'id') {
    if (positional.length !== 1) throw fail(`session ${sub} takes one session id\n\n${SESSION_USAGE}`);
    if (!ID_RE.test(positional[0])) throw fail(`${positional[0]} is not a session id: eight letters and digits, as woodshed session list shows`);
    [out.id] = positional;
  } else if (positional.length) throw fail(`unexpected ${positional[0]}\n\n${SESSION_USAGE}`);
  return out;
}
