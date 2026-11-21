// What the Woodshed mod knows of the `woodshed` command line, apart from drawing: the arguments it passes, how it
// reads what the command prints, and which agents are in a Woodshed session. Plain functions, no Herdr imports, so
// herdr-mod/woodshed.test.mjs runs them under node.

/** A session id, as the command line prints it. */
export const SESSION_ID = /^[0-9a-f]{8}$/;

/** The machine name a session is added to Herdr under: `woodshed-<id>`. */
export const MACHINE_PREFIX = 'woodshed-';

/** @returns {string|null}  the session id of a machine named `woodshed-<id>`, else null */
export function sessionOfMachine(name) {
  if (typeof name !== 'string' || !name.startsWith(MACHINE_PREFIX)) return null;
  const id = name.slice(MACHINE_PREFIX.length);
  return SESSION_ID.test(id) ? id : null;
}

// The command line's exit codes (cli/README.md).
export const EXIT = { done: 0, failed: 1, waiting: 2, refused: 3 };

/**
 * A background terminal's name in herdr-core: one per kind and session, so the panel finds a forward again after the
 * app restarts, and never starts two. Names are 1-32 of a-z 0-9 - _.
 */
export function terminalName(kind, id) {
  return `woodshed-${kind}-${id}`;
}

/** @returns {{kind: string, id: string}|null}  what a terminal named by terminalName runs */
export function terminalKind(name) {
  const m = /^woodshed-(new|fwd)-([0-9a-z]{1,20})$/.exec(String(name ?? ''));
  return m ? { kind: m[1], id: m[2] } : null;
}

/**
 * `woodshed session new`'s arguments for the New session form. Empty fields are left to the command line's own
 * defaults (the repo New session opens on, the agent's own model). The prompt goes after `--`, so a prompt that
 * starts with `-` is never read as an option.
 * @returns {string[]}
 */
export function newSessionArgs({ repo, branch, agent, model, prompt }) {
  const args = ['session', 'new', '--json'];
  const put = (flag, value) => {
    const v = String(value ?? '').trim();
    if (v) args.push(flag, v);
  };
  put('--repo', repo);
  put('--branch', branch);
  if (agent === 'codex' || agent === 'claude') args.push('--agent', agent);
  put('--model', model);
  const text = String(prompt ?? '').trim();
  if (text) args.push('--', text);
  return args;
}

/**
 * The ports typed into Forward port…: `3000`, `3000:3001` (the session's 3000 on this computer's 3001), several
 * separated by spaces or commas, or empty for every port the session listens on.
 * @returns {{auto: true}|{ports: string[]}|{error: string}}
 */
export function parsePorts(text) {
  const words = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (!words.length) return { auto: true };
  const ok = (n) => /^\d{1,5}$/.test(n) && Number(n) >= 1 && Number(n) <= 65535;
  for (const word of words) {
    const [port, local, extra] = word.split(':');
    if (extra !== undefined || !ok(port) || (local !== undefined && !ok(local))) {
      return { error: `${word} is not a port: give a number, or <session port>:<port here>` };
    }
  }
  return { ports: words };
}

/** `woodshed forward`'s arguments: every port with --auto, else the ones given. */
export function forwardArgs(id, parsed) {
  return parsed.auto ? ['forward', '--auto', id, '--json'] : ['forward', id, ...parsed.ports, '--json'];
}

/** @returns {object[]}  each JSON object line in a command's output; other lines are skipped */
export function jsonLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object') out.push(value);
    } catch {
      // A line cut short (the command still writing it) is read on the next pass.
    }
  }
  return out;
}

/**
 * Where `woodshed session new --json` has got to, from the lines it has printed so far.
 * @returns {{session: object|null, steps: string[], status: string|null, end: string|null, error: string|null}}
 *   `end` is running, needs-you, failed or stopped once the command is done
 */
export function startProgress(text) {
  const progress = { session: null, steps: [], status: null, end: null, error: null };
  for (const event of jsonLines(text)) {
    if (event.session && typeof event.session === 'object') progress.session = event.session;
    if (event.event === 'step' && typeof event.label === 'string') progress.steps.push(event.label);
    else if (event.event === 'status') progress.status = typeof event.status === 'string' ? event.status : progress.status;
    else if (['running', 'needs-you', 'failed', 'stopped'].includes(event.event)) progress.end = event.event;
    else if (event.event === 'error') progress.error = typeof event.error === 'string' ? event.error : 'the command failed';
  }
  return progress;
}

/**
 * The ports a `woodshed forward --json` has open now, from its `forwarding` and `closed` events in order.
 * @returns {{port: number, local: number, wanted: number, url: string, moved: boolean}[]}
 */
export function openForwards(text) {
  const open = new Map();
  for (const event of jsonLines(text)) {
    if (event.event === 'forwarding' && Number.isInteger(event.port) && typeof event.url === 'string') {
      const wanted = Number.isInteger(event.wanted) ? event.wanted : event.port;
      open.set(event.port, { port: event.port, local: event.local, wanted, url: event.url, moved: Boolean(event.moved) });
    } else if (event.event === 'closed' && Number.isInteger(event.port)) open.delete(event.port);
  }
  return [...open.values()].sort((a, b) => a.port - b.port);
}

/** @returns {string}  the error a finished command gave: its JSON error line, else its last line of stderr */
export function errorOf(result) {
  const lines = jsonLines(result?.stdout);
  const failed = lines.reverse().find((e) => e.event === 'error' && typeof e.error === 'string');
  if (failed) return failed.error;
  const said = String(result?.stderr ?? '').trim().split('\n').filter(Boolean).pop();
  return (said ?? '').replace(/^woodshed: /, '') || 'the woodshed command failed';
}

/** What an exit code means for the person, in the panel's words. */
export function outcomeOf(code) {
  if (code === EXIT.done) return { word: 'Done', level: 'success' };
  if (code === EXIT.waiting) return { word: 'Waiting on you', level: 'warning' };
  if (code === EXIT.refused) return { word: 'Refused', level: 'error' };
  return { word: 'Failed', level: 'error' };
}

/** `in 42m` or `in 2h 5m` until an ISO time, from `now` (ms). */
export function untilText(at, now) {
  const minutes = Math.max(0, Math.round((Date.parse(at) - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}

/** @returns {string}  `pauses in 42m` or `stops in 2h 5m` for a session's pause, or '' for none */
export function pauseText(pause, now) {
  if (!pause || !Date.parse(pause.at)) return '';
  return `${pause.why === 'lifetime' ? 'stops' : 'pauses'} ${untilText(pause.at, now)}`;
}

/** extend is allowed in a session's last 15 minutes (console/sessions.mjs): the panel offers it then. */
export const EXTEND_WINDOW_MS = 15 * 60_000;

/** @returns {boolean}  whether a session's pause or stop is close enough for Extend */
export function mayExtend(session, now) {
  const at = Date.parse(session?.pause?.at ?? '');
  return session?.status === 'running' && Number.isFinite(at) && at - now <= EXTEND_WINDOW_MS;
}

/**
 * The agents in Woodshed sessions that have just become blocked: those in a space on a `woodshed-<id>` machine whose
 * status is blocked now and was not at the last look. `seen` maps an agent's address to its last status, and is
 * updated in place; an agent that went away is forgotten.
 * @returns {{address: string, session: string, agent: object}[]}
 */
export function newlyBlocked(seen, agents, spaces) {
  const machineOf = new Map((spaces ?? []).map((s) => [s.id, s.machine]));
  const now = new Set();
  const out = [];
  for (const agent of agents ?? []) {
    const session = sessionOfMachine(machineOf.get(agent.space));
    if (!session) continue;
    now.add(agent.address);
    if (agent.status === 'blocked' && seen.get(agent.address) !== 'blocked') out.push({ address: agent.address, session, agent });
    seen.set(agent.address, agent.status);
  }
  for (const address of [...seen.keys()]) if (!now.has(address)) seen.delete(address);
  return out;
}

/** The notification for an agent that needs the person, naming its session. */
export function blockedNotice({ address, session, agent }, sessions) {
  const known = (sessions ?? []).find((s) => s.id === session);
  const who = agent?.program?.name || agent?.app || 'An agent';
  return {
    title: `Woodshed ${session} needs you`,
    body: `${who}${known?.title ? ` in "${known.title}"` : ''}${agent?.tab_name ? `, tab ${agent.tab_name}` : ''}`,
    level: 'warning',
    action: { name: 'agent.focus', args: { terminal: address } },
  };
}
