// A session starting other sessions of its person's: Claude in a My Woodshed session, asked to hand a piece of work to
// a session of its own (`woodshed-session new`, session/startSessions.mjs), starts it here, and follows it.
//
//   POST /sessions        Authorization: Bearer <WOODSHED_START_TOKEN>  {"prompt", "name"?, "branch"?, "project"?,
//                         "agent"?, "model"?, "effort"?, "separate"?}  ->  201 {"session": <summary>}: a private session of
//                         the same person, as New session starts one, with `startedFrom` naming this session. A piece of
//                         this session's work nests under it on the rail and is in its list; `separate: true` is work
//                         of its own (`startedApart`), at the top level and in no list but `?all=1`
//   GET  /sessions[?all=1]  ->  {"sessions": [<summary>], "startedFrom": <summary>|null}: the sessions this one started
//                         (all=1: every private session of the person's it reaches), newest first, and its starter
//   GET  /sessions/<id>   ->  {"session": <summary>}: one of them; 404 for any other
//
// And between a session and the others it reaches: every private session of the same person's (a coding session of
// theirs, never a question from Slack, a review or a QA run), and nobody else's, nor a shared one:
//
//   POST /sessions/<id>/messages   {"text"}  ->  {"sent": true} or {"held": true}: typed in at its prompt as the Chat
//                         tab's message is (fleet.send), headed with who sent it; held while it works, waits in line or
//                         is paused, and typed once it is at its prompt again
//   GET  /sessions/<id>/wait?for=reply|settled  ->  {"session", "deliveredAt", "waiting"?, "noReply"?, "reply"?,
//                         "waitingOnYou"?}: a message the other sends this one while it waits answers it (`reply`:
//                         {text, at}), and is not typed in; a wait on a session that waits on this one answers at once
//                         (`waitingOnYou`). Otherwise it answers once it
//                         is done or needs the person (for=reply: once it worked after what was sent went in, a held
//                         message counting from when it was typed), or stopped; {"waiting": true} after WAIT_MS, to ask
//                         again
//   GET  /sessions/<id>/transcript?limit=<n>&since=<ms>  ->  {"entries": [{role, text, at}]}: what was asked and said,
//                         from its statusd (session/sessionTranscript.mjs), tools left out; 403 once it has seen
//                         production data, which no other session reads
//   POST /sessions/<id>/stop        stop it, as Stop on the page does
//   POST /sessions/<id>/resume      Resume, with the page's checks (server.mjs's resumeMine)
//   POST /sessions/<id>/rename      {"name"}  as the page's rename; POST /rename names the calling session itself
//
// And the agents beside the calling session's own, in its own container (session/agents.mjs), through the page's own
// route for + Another agent (server.mjs agentAction), with its checks: a helper on the same work, in the same checkout.
//
//   GET  /agents                    ->  {"agents": [...]}: statusd's, each with its id (agent-2 ...) and state
//   POST /agents                    {"prompt", "agent"?, "model"?, "effort"?}  starts one, in the calling session's own
//                                   permission mode (never looser), as + Another agent does
//   POST /agents/<agent-N>/send     {"text"}  typed in at its prompt, held while it works
//   GET  /agents/<agent-N>/transcript?limit=<n>   its conversation, as statusd reads it
//   POST /agents/<agent-N>/stop
//
// The token is its own, not SESSION_TOKEN, which the app's environment holds (statusd starts the app): it is made
// for each run of a private session at its launch (fleet.mjs), kept here only as its hash, and does nothing once the
// session stops. The session's entrypoint writes it to a file of its own and takes it out of the environment before
// anything starts, so neither statusd nor the app it starts has it. It works on these routes alone, on the session API,
// which no browser reaches: a session's app never has a way to it but reading that file, which it can, as the same
// user in the same container. What the token can do is bounded so: start sessions of its own person's, each checked as
// New session checks its start.
//
// A started session is the person's own, as any of theirs: counted in their limit (waiting in line past it, as one
// from New session does), billed as any, with its own branch and nothing of the starting session's but `startedFrom`.
// Stopping one does nothing to the other. There is no cap of its own: the person's limit is the only one.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import agents from '../shared/agents.cjs';
import { ACTIVE_STATUSES, isAsk, isQa, isReview, sessionLink } from './sessions.mjs';

export const START_TOKEN_PREFIX = 'wst_';
const MAX_BODY_BYTES = 64 * 1024;
// A first prompt is the whole brief for a session that knows nothing else: room for a long one, not for a dump.
export const MAX_PROMPT_CHARS = 20_000;
const SESSION_PATH_RE = /^\/sessions\/([0-9a-f]{8})(?:\/(messages|wait|transcript|stop|resume|rename))?$/;
const AGENTS_PATH_RE = /^\/agents(?:\/(agent-[2-9])\/(transcript|send|stop))?$/;
// statusd types no more in one go (session/statusd.mjs, MAX_SEND_CHARS), less the line that says who sent it.
export const MAX_MESSAGE_CHARS = 7500;
// A wait is answered at least this often, so no proxy in between drops it; the command asks again.
export const WAIT_MS = 4 * 60_000;
// A wait for a reply that never sees the session working, with nothing held for it: what was sent was not taken up.
const NO_REPLY_MS = 90_000;
const WAIT_POLL_MS = 2000;
const SETTLED = new Set(['done', 'needs-you', 'idle']);

/** @returns {string}  a new start token, handed to the session once and never kept */
export function newStartToken() {
  return `${START_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
}

/** @returns {string}  what the console keeps of a start token */
export function startTokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @returns {boolean}  whether a session of this kind gets a start token: a person's own, never one that has seen
 *   production data (its prompt could carry that data into a session that has not), nor a question, review or QA run
 */
export function mayStartSessions(session) {
  return Boolean(session.owner) && !session.taintedAt && !isAsk(session) && !isQa(session) && !isReview(session);
}

/** @returns {object|null}  the active session whose start token `given` is */
export function sessionForStartToken(given, sessions) {
  if (typeof given !== 'string' || !given.startsWith(START_TOKEN_PREFIX)) return null;
  const hash = Buffer.from(startTokenHash(given));
  return sessions.find((s) => ACTIVE_STATUSES.has(s.status) && typeof s.startTokenHash === 'string'
    && s.startTokenHash.length === hash.length && timingSafeEqual(Buffer.from(s.startTokenHash), hash) && mayStartSessions(s)) ?? null;
}

/** @returns {boolean}  whether the path is one of these routes */
export function isStartsPath(pathname) {
  return pathname === '/sessions' || pathname === '/rename' || SESSION_PATH_RE.test(pathname) || AGENTS_PATH_RE.test(pathname);
}

const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

/**
 * What another session sees of one: enough to tell how it is doing and where to open it. Of a session that has seen
 * production data, nothing its agent wrote: its last message could carry that data to a session with no lockdown, as its
 * conversation could (the transcript route refuses it). `error` and `stopReason` are the console's own words.
 */
export function startedSummary(s, { publicUrl, linkQuery = null }) {
  const tainted = Boolean(s.taintedAt);
  return {
    id: s.id, title: text(s.title, 200), status: s.status, state: s.state ?? null, project: s.project ?? null, branch: s.branch ?? null,
    agent: agents.agentOfSession(s), prUrl: s.prUrl ?? null, lastMessage: tainted ? null : text(s.lastMessage?.text, 500),
    ...(tainted ? { tainted: true } : {}),
    ...(s.startedApart ? { separate: true } : {}),
    createdAt: s.createdAt ?? null, startedAt: s.startedAt ?? null, stoppedAt: s.stoppedAt ?? null, stopReason: text(s.stopReason, 200),
    error: text(s.error, 300), url: sessionLink(publicUrl, s.id, linkQuery),
  };
}

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) return { tooLarge: true };
  }
  try {
    const body = JSON.parse(raw || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? { body } : { bad: true };
  } catch {
    return { bad: true };
  }
}

/**
 * @param {{fleet: {sessions: () => object[], find: (id: string) => object|null},
 *          config: {publicUrl: string, linkQuery?: object|null},
 *          startMine: (login: string, body: object) => Promise<{status: number, body: object}>,
 *          allowed?: (login: string) => Promise<boolean>|boolean, canWrite?: (login: string) => Promise<boolean>|boolean}} deps
 *   `startMine` is New session's own start, with its checks (server.mjs); `allowed` whether the person may still use
 *   the console, and `canWrite` whether GitHub still lets them write to the console's repo, as a command line token's
 *   person must (cliSignIn.mjs, createWriteAccess). New session's project check asks nothing of the default project,
 *   whose writers the page's sign-in rechecks every hour: a session's start must ask it here.
 */
export function createSessionStarts({
  fleet, config, startMine, resumeMine = null, statusd = null, agentAction = null, allowed = () => true, canWrite = () => true,
  waitMs = WAIT_MS, pollMs = WAIT_POLL_MS, noReplyMs = NO_REPLY_MS, now = Date.now,
}) {
  const summary = (s) => startedSummary(s, { publicUrl: config.publicUrl, linkQuery: config.linkQuery ?? null });

  // The waits open now, one for each session waiting and the session it waits on (waitKey): a session may wait on two
  // at once (two send --wait in the background), and a reply from either answers its own.
  const waits = new Map();
  const waitKey = (waiter, target) => `${waiter}>${target}`;

  function startedBy(session) {
    return fleet.sessions().filter((s) => s.startedFrom === session.id && s.owner === session.owner && !s.startedApart).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function handle(req, res) {
    const pathname = new URL(req.url, 'http://console').pathname;
    // A browser's call: nothing but a session's own program calls these, and a page could only ride on a cookie.
    if (req.headers.origin) {
      req.resume();
      console.warn('sessionStarts: refused, a browser\'s call', { pathname });
      return reply(res, 403, { error: 'not from a browser' });
    }
    const given = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const session = sessionForStartToken(given, fleet.sessions());
    if (!session) {
      req.resume();
      console.warn('sessionStarts: refused, no running session has that start token', { pathname });
      return reply(res, 401, { error: 'this session cannot start sessions: its start token is not one the console knows, or the session stopped' });
    }
    const agentPath = AGENTS_PATH_RE.exec(pathname);
    if (agentPath) return ownAgents(req, res, session, agentPath);
    if (pathname === '/rename') {
      if (req.method !== 'POST') return notFound(req, res);
      const read = await readJson(req);
      if (read.tooLarge || read.bad) return reply(res, 400, { error: 'the body must be a JSON object' });
      return rename(res, session, session, read.body);
    }
    if (pathname === '/sessions') {
      if (req.method === 'GET') {
        req.resume();
        const starter = session.startedFrom ? reached(session, session.startedFrom) : null;
        const all = new URL(req.url, 'http://console').searchParams.get('all') === '1';
        return reply(res, 200, { sessions: (all ? allOf(session) : startedBy(session)).map(summary), startedFrom: starter ? summary(starter) : null });
      }
      if (req.method !== 'POST') return notFound(req, res);
      const read = await readJson(req);
      if (read.tooLarge) return reply(res, 413, { error: 'too large' });
      if (read.bad) return reply(res, 400, { error: 'the body must be a JSON object' });
      return start(res, session, read.body);
    }
    const [, id, action = null] = SESSION_PATH_RE.exec(pathname);
    const other = reached(session, id);
    if (!other) {
      req.resume();
      return reply(res, 404, { error: `no session ${id} of your person's that another session may reach` });
    }
    const wants = action === null || action === 'wait' || action === 'transcript' ? 'GET' : 'POST';
    if (req.method !== wants) return notFound(req, res);
    if (wants === 'GET') req.resume();
    const query = new URL(req.url, 'http://console').searchParams;
    if (action === null) return reply(res, 200, { session: summary(other) });
    if (action === 'wait') return wait(res, session, other, query.get('for') === 'reply' ? 'reply' : 'settled');
    if (action === 'transcript') return transcript(res, session, other, query);
    if (!(await allowed(session.owner)) || !(await canWrite(session.owner))) {
      req.resume();
      console.log('sessionStarts: refused', { from: session.id, to: other.id, action, why: 'no longer allowed' });
      return reply(res, 403, { error: `@${session.owner} can no longer use this console, or no longer writes to its repo` });
    }
    if (action === 'stop') {
      req.resume();
      if (!ACTIVE_STATUSES.has(other.status)) return reply(res, 200, { session: summary(other) });
      await fleet.stop(other, `stopped by session ${session.id}`, { by: session.owner });
      console.log('sessionStarts: session stopped', { from: session.id, id: other.id });
      return reply(res, 200, { session: summary(fleet.find(other.id) ?? other) });
    }
    if (action === 'resume') {
      req.resume();
      if (!resumeMine) return reply(res, 404, { error: 'this console cannot resume a session from another' });
      if (ACTIVE_STATUSES.has(other.status)) return reply(res, 200, { session: summary(other) });
      const answer = await resumeMine(session.owner, other.id);
      console.log('sessionStarts: resume', { from: session.id, id: other.id, status: answer.status });
      return reply(res, answer.status, answer.status === 201 ? { session: summary(fleet.find(other.id) ?? other) } : answer.body);
    }
    const read = await readJson(req);
    if (read.tooLarge) return reply(res, 413, { error: 'too large' });
    if (read.bad) return reply(res, 400, { error: 'the body must be a JSON object' });
    if (action === 'rename') return rename(res, session, other, read.body);
    return message(res, session, other, read.body);
  }

  // The calling session's own agents, through the page's route (agentAction), which answers with statusd's reply.
  async function ownAgents(req, res, session, [, agentId = null, action = null]) {
    if (!agentAction) {
      req.resume();
      return reply(res, 404, { error: 'this console cannot start agents from a session' });
    }
    const route = [undefined, session.id, agentId ?? undefined, action ?? undefined];
    const login = session.owner;
    if (req.method === 'GET' && (!agentId || action === 'transcript')) {
      req.resume();
      return agentAction(req, res, route, login);
    }
    if (req.method !== 'POST' || action === 'transcript') return notFound(req, res);
    if (!(await allowed(login)) || !(await canWrite(login))) {
      req.resume();
      console.log('sessionStarts: refused', { from: session.id, action: `agents ${action ?? 'start'}`, why: 'no longer allowed' });
      return reply(res, 403, { error: `@${login} can no longer use this console, or no longer writes to its repo` });
    }
    const read = await readJson(req);
    if (read.tooLarge) return reply(res, 413, { error: 'too large' });
    if (read.bad) return reply(res, 400, { error: 'the body must be a JSON object' });
    const body = read.body;
    if (!agentId) {
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return reply(res, 400, { error: 'give the agent its first prompt: what to do, and what to answer with' });
      // A helper is claude or codex, as + Another agent offers. As loose as the calling session, never looser, by the
      // rule a session it starts gets (shared/agents.cjs, modeForStartedSession).
      const agent = body.agent === 'codex' ? 'codex' : 'claude';
      const permissionMode = agents.modeForStartedSession(agents.agentOfSession(session), session.options?.permissionMode || 'auto', agent);
      console.log('sessionStarts: agent asked for', { from: session.id, agent, permissionMode });
      return agentAction(req, res, route, login, { body: {
        agent, model: typeof body.model === 'string' ? body.model : '', effort: typeof body.effort === 'string' ? body.effort : '',
        permissionMode, prompt: `[From this session's own agent]\n\n${prompt}`,
      } });
    }
    if (action === 'stop') return agentAction(req, res, route, login, { body: {} });
    const said = typeof body.text === 'string' ? body.text.trim() : '';
    if (!said) return reply(res, 400, { error: 'nothing to send' });
    if (said.length > MAX_MESSAGE_CHARS) return reply(res, 400, { error: `too long: at most ${MAX_MESSAGE_CHARS} characters in one message` });
    return agentAction(req, res, route, login, { body: { text: `[Message from this session's own agent]\n\n${said}` } });
  }

  function rename(res, from, session, body) {
    try {
      fleet.rename(session, typeof body.name === 'string' ? body.name : '');
    } catch (err) {
      if (!err?.shown) throw err;
      return reply(res, 400, { error: err.message });
    }
    console.log('sessionStarts: session renamed', { from: from.id, id: session.id });
    return reply(res, 200, { session: summary(session) });
  }

  function notFound(req, res) {
    req.resume();
    return reply(res, 404, { error: 'not found' });
  }

  /**
   * @returns {object|null}  the session `id`, when it is another private session of the same person's: never anyone
   *   else's, a shared one, a question from Slack, a review or a QA run
   */
  function reached(from, id) {
    const other = fleet.find(id);
    if (!other || !other.owner || other.owner !== from.owner || other.id === from.id) return null;
    return isAsk(other) || isQa(other) || isReview(other) ? null : other;
  }

  /** @returns {object[]}  every private session of the person's but this one, newest first */
  function allOf(session) {
    return fleet.sessions().filter((s) => s.owner === session.owner && reached(session, s.id))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function message(res, from, to, body) {
    const said = typeof body.text === 'string' ? body.text.trim() : '';
    if (!said) return reply(res, 400, { error: 'nothing to send' });
    if (said.length > MAX_MESSAGE_CHARS) return reply(res, 400, { error: `too long: at most ${MAX_MESSAGE_CHARS} characters in one message` });
    // Who it is from, and how to answer, on a line of its own: the session reading it, and the person in its Chat tab,
    // tell it from what the person typed.
    const named = `session ${from.id} "${text(from.title, 80) ?? ''}"`;
    const head = to.startedFrom === from.id
      ? `[Message from ${named}, which started this session. Answer it with: woodshed-session reply "<answer>"]`
      : `[Message from ${named}, ${from.startedFrom === to.id ? 'which this session started' : 'another session of your person\'s'}. Answer it with: woodshed-session send ${from.id} "<answer>"]`;
    // `to` is waiting on `from` (send --wait, wait): this is its answer, handed to that wait, not typed in behind it.
    // Typed in, it would be held until that wait's turn ends, and that wait would never end.
    // A message to a session that asked a question answers it (fleet.send, or below for one handed to its wait); one sent
    // as a question (`question: true`, woodshed-session reply --question) leaves its sender waiting for an answer, which
    // the rail says.
    const asks = body.question === true;
    const waiting = waits.get(waitKey(to.id, from.id));
    const at = new Date(now()).toISOString();
    if (waiting && waiting.answer({ text: said, at, typed: `${head}\n\n${said}` })) {
      fleet.noteMessage?.({ from, to, text: said, question: asks });
      fleet.clearQuestion?.(to);
      if (asks) fleet.noteQuestion?.(from, { to: to.id });
      console.log('sessionStarts: message', { from: from.id, to: to.id, chars: said.length, outcome: 'answered a wait', question: asks });
      return reply(res, 200, { sentAt: at, sent: true, answeredWait: true, session: summary(to) });
    }
    const outcome = await fleet.send(to, `${head}\n\n${said}`);
    // Left in its box unsent (409 below): not sent yet, and a send again would list it twice.
    if (outcome !== 'in-box') fleet.noteMessage?.({ from, to, text: said, question: asks, unconfirmed: outcome === 'unknown' });
    if (asks && outcome !== 'in-box') fleet.noteQuestion?.(from, { to: to.id });
    console.log('sessionStarts: message', { from: from.id, to: to.id, chars: said.length, outcome, question: asks });
    if (outcome === 'in-box') return reply(res, 409, { error: 'it went into the session\'s box but was not sent: a prompt came up as it was typed, which the person answers in its TUI tab' });
    return reply(res, 200, { sentAt: new Date(now()).toISOString(), ...(outcome === 'queued' ? { held: true } : { sent: true }), ...(outcome === 'unknown' ? { unknown: true } : {}), session: summary(to) });
  }

  // The console's own reads of its statusd (fleet.readStatus, every few seconds) keep `state`: this watches it. For a
  // reply, only work after what was sent went in counts: a message held while the session worked goes in once that turn
  // is over, and the turn it was held behind is not its answer. `deliveredAt` says from when, for the caller's read.
  async function wait(res, waiter, session, mode) {
    const id = session.id;
    // Each the other's: answered now, or both would wait for a reply neither can give.
    if (waits.has(waitKey(id, waiter.id))) {
      console.log('sessionStarts: wait answered at once, the other session waits on this one', { from: waiter.id, id });
      return reply(res, 200, { session: summary(session), waitingOnYou: true });
    }
    // One open wait for each pair: a reply from the session it waits on answers it (message, above). A second wait of the
    // same session on the same one takes its place.
    let replied = null;
    let wake = null;
    let closed = false;
    // A reply is taken only while the waiting command is still there to print it: once it went, the message is typed in
    // as any other (message, above), not lost to a wait nobody reads.
    const entry = {
      target: id,
      answer: (r) => {
        if (closed || res.destroyed || res.writableEnded) return false;
        replied = r;
        wake?.();
        return true;
      },
    };
    waits.set(waitKey(waiter.id, id), entry);
    // The request's own 'close' comes once its body is read; the response's, before it is sent, means the caller went.
    res.on('close', () => {
      if (res.writableFinished) return;
      closed = true;
      wake?.();
    });
    let handed = false;
    try {
      return await waitLoop(res, session, mode, () => replied, () => closed, (resolve) => { wake = resolve; }, () => { handed = true; });
    } finally {
      if (waits.get(waitKey(waiter.id, id)) === entry) waits.delete(waitKey(waiter.id, id));
      // Taken in the same tick its command went: typed in at the session's prompt, as any message, not dropped.
      if (replied && !handed) {
        const outcome = await fleet.send(waiter, replied.typed);
        console.log('sessionStarts: message', { from: id, to: waiter.id, chars: replied.text.length, outcome, why: 'its wait went' });
      }
    }
  }

  async function waitLoop(res, session, mode, repliedOf, closedOf, onWake, onHanded) {
    const id = session.id;
    const started = now();
    const lastAt = (s) => (s.lastMessage?.role === 'assistant' && s.lastMessage.at ? Date.parse(s.lastMessage.at) : 0);
    let deliveredAt = session.pendingMessages?.length ? null : started;
    let worked = false;
    for (;;) {
      const s = fleet.find(id);
      if (!s) return reply(res, 404, { error: `no session ${id}` });
      // The waiting command went (Ctrl-C, its timeout): nothing to answer.
      if (closedOf()) return res.end();
      if (repliedOf()) {
        onHanded();
        const { text: said, at } = repliedOf();
        return reply(res, 200, { session: summary(s), reply: { text: said, at } });
      }
      const at = deliveredAt === null ? null : new Date(deliveredAt).toISOString();
      if (!ACTIVE_STATUSES.has(s.status)) return reply(res, 200, { session: summary(s), deliveredAt: at });
      if (s.pendingMessages?.length) {
        deliveredAt = null;
        worked = false;
      } else if (deliveredAt === null) deliveredAt = now();
      if (deliveredAt !== null && (s.state === 'working' || lastAt(s) > deliveredAt)) worked = true;
      const settled = s.status === 'running' && SETTLED.has(s.state) && deliveredAt !== null;
      const since = deliveredAt === null ? null : new Date(deliveredAt).toISOString();
      if (settled && (mode === 'settled' || worked)) return reply(res, 200, { session: summary(s), deliveredAt: since });
      // Sent and gone in, but never seen at work since: it is not coming.
      if (settled && now() - deliveredAt >= noReplyMs) return reply(res, 200, { session: summary(s), deliveredAt: since, noReply: true });
      if (now() - started >= waitMs) return reply(res, 200, { session: summary(s), deliveredAt: since, waiting: true });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        onWake(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  async function transcript(res, from, other, query) {
    // What a session that has seen production data said can carry that data: no other session reads it.
    if (other.taintedAt) return reply(res, 403, { error: `session ${other.id} has seen production data: its conversation is read on the console only` });
    if (other.status !== 'running' || !other.endpoint || !statusd) return reply(res, 409, { error: `session ${other.id} is not running: resume it to read its conversation` });
    const limit = Math.min(Number.parseInt(query.get('limit') ?? '', 10) || 20, 300);
    const since = Date.parse(query.get('since') ?? '');
    let answer;
    try {
      answer = await statusd(other, 'GET', `/transcript?limit=${limit}`);
    } catch (err) {
      console.warn('sessionStarts: transcript not read', { from: from.id, id: other.id, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: `session ${other.id} did not answer: try again` });
    }
    const entries = (answer?.entries ?? [])
      .filter((e) => (e.role === 'user' || e.role === 'assistant') && typeof e.text === 'string' && e.text.trim())
      .filter((e) => Number.isNaN(since) || (e.at && Date.parse(e.at) > since))
      .map((e) => ({ role: e.role, text: e.text, at: e.at ?? null }));
    return reply(res, 200, { entries });
  }

  async function start(res, from, body) {
    const login = from.owner;
    const refuse = (code, why, error) => {
      console.log('sessionStarts: start refused', { from: from.id, owner: login, why });
      return reply(res, code, { error });
    };
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return refuse(400, 'no prompt', 'give the new session its first prompt: what to do, the context it needs, and what done looks like');
    if (prompt.length > MAX_PROMPT_CHARS) return refuse(400, 'prompt too long', `the prompt is over ${MAX_PROMPT_CHARS} characters`);
    if (!(await allowed(login))) return refuse(403, 'not a member', `@${login} can no longer use this console`);
    if (!(await canWrite(login))) return refuse(403, 'write access gone', `@${login} no longer has write access to the repo on GitHub`);
    const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (branch && from.branch && branch === from.branch) return refuse(400, 'same branch', `${branch} is this session's own branch: give the new session one of its own, or none`);
    // Any agent New session offers (shared/agents.cjs), with New session's own checks in startMine: Grok Build and
    // OpenCode only on the person's own sign-in saved for it.
    if (body.agent !== undefined && body.agent !== '' && !agents.isAgent(body.agent)) {
      return refuse(400, 'no such agent', `the agent is one of ${agents.AGENT_IDS.join(', ')}`);
    }
    const agent = body.agent || 'claude';
    // As loose as the starting session, never looser: a mode it was not given, it cannot give. The new session's agent
    // gets the loosest of its own modes that does no more unasked (shared/agents.cjs, modeForStartedSession): Codex's
    // own policy runs commands unasked, so a Codex session started from one that asks before commands is read-only.
    const fromMode = from.options?.permissionMode || 'auto';
    const permissionMode = agents.modeForStartedSession(agents.agentOfSession(from), fromMode, agent);
    if (permissionMode !== fromMode) console.log('sessionStarts: mode tightened for the agent', { from: from.id, fromAgent: agents.agentOfSession(from), fromMode, agent, permissionMode });
    const answer = await startMine(login, {
      prompt, name: typeof body.name === 'string' ? body.name : '', workOn: branch, agent,
      model: typeof body.model === 'string' ? body.model : '', effort: typeof body.effort === 'string' ? body.effort : '', permissionMode,
      project: typeof body.project === 'string' && body.project ? body.project : from.project, startedFrom: from.id,
      ...(body.separate === true ? { startedApart: true } : {}),
    });
    if (answer.status !== 201) {
      console.log('sessionStarts: start refused', { from: from.id, owner: login, why: 'start checks', status: answer.status });
      return reply(res, answer.status, answer.body);
    }
    const started = fleet.find(answer.body.id);
    console.log('sessionStarts: session started', { from: from.id, owner: login, id: answer.body.id, project: started?.project ?? null, status: started?.status ?? null });
    return reply(res, 201, { session: summary(started ?? answer.body) });
  }

  return {
    isPath: isStartsPath,
    handle,
    /** @returns {boolean}  whether the token is the start token of one of this console's running sessions */
    owns: (token) => Boolean(sessionForStartToken(token, fleet.sessions())),
    /** @returns {number}  how many waits are open, for the tests */
    openWaits: () => waits.size,
  };
}
