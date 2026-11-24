// A session starting other sessions of its person's: Claude in a My Woodshed session, asked to hand a piece of work to
// a session of its own (`woodshed-session new`, session/startSessions.mjs), starts it here, and follows it.
//
//   POST /sessions        Authorization: Bearer <WOODSHED_START_TOKEN>  {"prompt", "name"?, "branch"?, "project"?,
//                         "agent"?, "model"?, "effort"?}  ->  201 {"session": <summary>}: a private session of the same
//                         person, as New session starts one, with `startedFrom` naming this session
//   GET  /sessions        ->  {"sessions": [<summary>]}: the sessions this one started, newest first
//   GET  /sessions/<id>   ->  {"session": <summary>}: one of them; 404 for any other
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

import { ACTIVE_STATUSES, isAsk, isQa, isReview, sessionLink } from './sessions.mjs';

export const START_TOKEN_PREFIX = 'wst_';
const MAX_BODY_BYTES = 64 * 1024;
// A first prompt is the whole brief for a session that knows nothing else: room for a long one, not for a dump.
export const MAX_PROMPT_CHARS = 20_000;
const SESSION_PATH_RE = /^\/sessions\/([0-9a-f]{8})$/;

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
  return pathname === '/sessions' || SESSION_PATH_RE.test(pathname);
}

const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

/** What the starting session sees of one it started: enough to tell how it is doing and where to open it. */
export function startedSummary(s, { publicUrl, linkQuery = null }) {
  return {
    id: s.id, title: text(s.title, 200), status: s.status, state: s.state ?? null, project: s.project ?? null, branch: s.branch ?? null,
    agent: s.options?.agent === 'codex' ? 'codex' : 'claude', prUrl: s.prUrl ?? null, lastMessage: text(s.lastMessage, 500),
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
 *          allowed?: (login: string) => Promise<boolean>|boolean}} deps
 *   `startMine` is New session's own start, with its checks (server.mjs); `allowed` whether the person may still use
 *   the console, as a command line token's person must (cliSignIn.mjs)
 */
export function createSessionStarts({ fleet, config, startMine, allowed = () => true }) {
  const summary = (s) => startedSummary(s, { publicUrl: config.publicUrl, linkQuery: config.linkQuery ?? null });

  function startedBy(session) {
    return fleet.sessions().filter((s) => s.startedFrom === session.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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
    if (req.method === 'GET') {
      req.resume();
      if (pathname === '/sessions') return reply(res, 200, { sessions: startedBy(session).map(summary) });
      const id = SESSION_PATH_RE.exec(pathname)?.[1];
      const one = id ? fleet.find(id) : null;
      if (!one || one.startedFrom !== session.id) return reply(res, 404, { error: `no session ${id} that this session started` });
      return reply(res, 200, { session: summary(one) });
    }
    if (req.method !== 'POST' || pathname !== '/sessions') {
      req.resume();
      return reply(res, 404, { error: 'not found' });
    }
    const read = await readJson(req);
    if (read.tooLarge) return reply(res, 413, { error: 'too large' });
    if (read.bad) return reply(res, 400, { error: 'the body must be a JSON object' });
    return start(res, session, read.body);
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
    const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (branch && from.branch && branch === from.branch) return refuse(400, 'same branch', `${branch} is this session's own branch: give the new session one of its own, or none`);
    // As loose as the starting session, never looser: a mode it was not given, it cannot give.
    const agent = body.agent === 'codex' ? 'codex' : 'claude';
    const mode = from.options?.permissionMode || 'auto';
    const permissionMode = agent === 'codex' && mode === 'acceptEdits' ? 'default' : mode;
    const answer = await startMine(login, {
      prompt, name: typeof body.name === 'string' ? body.name : '', workOn: branch, agent,
      model: typeof body.model === 'string' ? body.model : '', effort: typeof body.effort === 'string' ? body.effort : '', permissionMode,
      project: typeof body.project === 'string' && body.project ? body.project : from.project, startedFrom: from.id,
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
  };
}
