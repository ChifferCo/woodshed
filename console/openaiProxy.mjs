// codex's calls to OpenAI from private Codex sessions that have no sign-in of their own, on the session API's port. As the
// Anthropic proxy does for claude, the team key is added here, so the session holds only its SESSION_TOKEN, which nothing
// takes but this port, which only session tasks reach, while the session is active. A session that runs on its owner's
// own Codex sign-in calls OpenAI directly and never comes here.
//
//   /openai/<path>   Authorization: Bearer <SESSION_TOKEN>  ->  api.openai.com/<path>, on the team key
//
// Only a Codex session may use it, and a review session whose Codex reviews beside Claude (Console settings' Reviews
// card, reviewAgents.mjs): any other kind of session has no business with the key.
//
// A review of a pull request whose author turned on "Also use it for reviews of my pull requests" (My settings) runs
// its Codex on that author's own sign-in (`review.codexLogin`), added here as the team key is, so the sign-in never
// enters the review session, which reads what anyone who can push to the pull request wrote:
//
//   /openai/<path>                Authorization: Bearer <SESSION_TOKEN>  ->  api.openai.com/<path>, on the author's key
//   /chatgpt/backend-api/<path>   Authorization: Bearer <SESSION_TOKEN>  ->  chatgpt.com/backend-api/<path>, on the
//                                 author's ChatGPT login (its access token and account), for codex/* and the account check
//
// The session's codex holds a stand-in ChatGPT login whose access token is its SESSION_TOKEN (session/review.sh). The
// console never refreshes a ChatGPT login (codexModels.mjs says why): one whose access token has expired is refused,
// and the review's Codex says so.

import http from 'node:http';
import https from 'node:https';
import { isReview, runsCodex } from './sessions.mjs';
import { credentialOf } from './codexModels.mjs';

const PREFIX = '/openai';
const CHATGPT_PREFIX = '/chatgpt';
// What of ChatGPT's backend a review's codex may reach: Codex's own API, and the account check codex makes before it.
const CHATGPT_PATH_RE = /^\/backend-api\/(?:codex\/[A-Za-z0-9/_.-]*|wham\/accounts\/check)$/;

// What of api.openai.com a review's codex may reach on a key, the author's or the team's: its turns, the compaction of a
// long one, and the model list. Not files, vector stores, fine-tuning or anything else the key can do.
const REVIEW_OPENAI_PATH_RE = /^\/v1\/(?:responses(?:\/compact)?|models)$/;

// A path already in its plain form: no `.` or `..` segment, no empty one, no `%` escape and no backslash.
const UNPLAIN_PATH_RE = /[%\\]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/;

/**
 * The OpenAI path a review's call may reach, or null; what passes is what is forwarded, query and all.
 * @param {string} rawPath  the request's path and query, after /openai
 * @returns {string|null}
 */
export function reviewOpenAiPathAllowed(rawPath) {
  const q = rawPath.indexOf('?');
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  const search = q === -1 ? '' : rawPath.slice(q);
  if (UNPLAIN_PATH_RE.test(pathname) || !REVIEW_OPENAI_PATH_RE.test(pathname) || search.includes('#')) return null;
  return pathname + search;
}

/**
 * The ChatGPT path a review's call may reach, or null. Only a path already in its plain form passes: no `.` or `..`
 * segment, no empty one, no `%` escape and no backslash, since chatgpt.com would resolve `codex/../conversations` (or
 * its escaped forms) to the author's chats. What passes is what is forwarded, query and all.
 * @param {string} rawPath  the request's path and query, after /chatgpt
 * @returns {string|null}
 */
export function chatgptPathAllowed(rawPath) {
  const q = rawPath.indexOf('?');
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  if (UNPLAIN_PATH_RE.test(pathname)) return null;
  if (!CHATGPT_PATH_RE.test(pathname)) return null;
  const search = q === -1 ? '' : rawPath.slice(q);
  return /#/.test(search) ? null : pathname + search;
}
const TEAM_KEY_SECRET = 'openai-api-key';
// A key replaced on the Secrets page reaches sessions within this.
const TEAM_KEY_TTL_MS = 5 * 60_000;
// Ours to set, or the connection's own: never passed on.
const DROPPED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key',
  'chatgpt-account-id', 'cookie']);

const under = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** @returns {boolean}  whether a session API path is this proxy's */
export function isOpenAiPath(pathname) {
  return under(pathname, PREFIX) || under(pathname, CHATGPT_PREFIX);
}

function refuse(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: code === 401 ? 'authentication_error' : 'permission_error', message } }));
}

/** @returns {string|null}  the session token a request carries as its bearer */
export function bearerOf(headers) {
  return /^Bearer (\S+)$/.exec(String(headers.authorization ?? ''))?.[1] ?? null;
}

/**
 * @param {{secrets?: {read: (name: string) => Promise<string|null>}|null,
 *          teamKey?: string|null,  the key itself, where there is no Secrets Manager (the docker launcher's env file)
 *          userSettings?: {usesOwnCodexForReviews: (login: string) => boolean, codexAuth: (login: string) => Promise<string|null>}|null,
 *          upstream?: string, chatgptUpstream?: string, now?: () => number}} opts
 * @returns {{isProxyPath: (pathname: string) => boolean,
 *            handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, session: object|null) => Promise<void>,
 *            teamCredential: () => Promise<string|null>, cut: (sessionId: string) => void}}
 */
export function createOpenAiProxy({ secrets = null, teamKey = null, userSettings = null, upstream = 'https://api.openai.com',
  chatgptUpstream = 'https://chatgpt.com', now = Date.now }) {
  const targets = { openai: new URL(upstream), chatgpt: new URL(chatgptUpstream) };
  let team = null;
  let teamRead = null;
  const routed = new Set();

  // Calls that arrive while the key is being read wait for that one read.
  function teamCredential() {
    if (!secrets) return Promise.resolve(teamKey);
    if (team && now() - team.at < TEAM_KEY_TTL_MS) return Promise.resolve(team.key);
    teamRead ??= secrets.read(TEAM_KEY_SECRET).then((stored) => {
      // A console with no stored key, such as a local one whose store is not chosen yet, uses its settings'.
      const key = stored ?? teamKey;
      team = { key, at: now() };
      console.log('openaiProxy: team key read', { set: Boolean(key) });
      return key;
    }).finally(() => { teamRead = null; });
    return teamRead;
  }

  /**
   * The author's own sign-in for a review that runs on it, read at each call: one turned off or removed since the
   * review started stops being used at once.
   * @returns {Promise<{headers: Record<string, string>, apiKey: boolean}|{refused: string}>}
   */
  async function authorCredential(login) {
    if (!userSettings?.usesOwnCodexForReviews(login)) return { refused: `@${login} no longer has their Codex sign-in on for reviews` };
    const cred = credentialOf(await userSettings.codexAuth(login), now());
    if (!cred) return { refused: `@${login}'s saved Codex sign-in has no access token` };
    if (cred.expired) return { refused: `@${login}'s saved Codex sign-in has expired: a Codex session of theirs refreshes it, or they save a new one` };
    return cred;
  }

  // The calls on their way, by session: a lockdown cuts its session's (cut), so nothing it sends after its first relayed
  // production call rides a request opened before it.
  const open = new Map();

  function forward(req, res, { target, path, headers: added, sessionId }) {
    const transport = target.protocol === 'http:' ? http : https;
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(name)) headers[name] = value;
    Object.assign(headers, added, { host: target.host });
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path, headers,
    }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('openaiProxy: OpenAI not reached', { path: req.url, message: err?.message });
      if (!res.headersSent) return refuse(res, 502, 'the console could not reach OpenAI');
      res.destroy();
    });
    // codex cancels a turn by closing its request: the call to OpenAI goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    if (sessionId) {
      if (!open.has(sessionId)) open.set(sessionId, new Set());
      const call = { req, res, out };
      open.get(sessionId).add(call);
      res.on('close', () => {
        open.get(sessionId)?.delete(call);
        if (!open.get(sessionId)?.size) open.delete(sessionId);
      });
    }
    req.pipe(out);
  }

  /** Every call of the session's still on its way, ended: its lockdown has started (fleet.onLocking). */
  function cut(sessionId) {
    const calls = open.get(sessionId);
    if (!calls?.size) return;
    console.log('openaiProxy: calls cut at the lockdown', { sessionId, calls: calls.size });
    for (const { req, res, out } of calls) {
      out.destroy();
      req.destroy();
      res.destroy();
    }
    open.delete(sessionId);
  }

  function firstCall(session, via) {
    if (routed.has(session.id)) return;
    routed.add(session.id);
    console.log(`openaiProxy: first call on ${via}`, { sessionId: session.id, review: isReview(session) });
  }

  async function handle(req, res, session) {
    if (!session) {
      req.resume();
      console.warn('openaiProxy: refused, no active session has that token', { from: req.socket.remoteAddress });
      return refuse(res, 401, 'not an active Woodshed session');
    }
    // A private session whose owner started a Codex agent beside its claude (session/agents.mjs) runs codex too.
    if (!runsCodex(session) && !(isReview(session) && session.review.agents?.includes('codex'))) {
      req.resume();
      console.warn('openaiProxy: refused, not a Codex session', { sessionId: session.id });
      return refuse(res, 403, 'only a Codex session may use the team\'s OpenAI key');
    }
    const chatgpt = under(new URL(req.url, 'http://console').pathname, CHATGPT_PREFIX);
    const author = isReview(session) ? session.review.codexLogin ?? null : null;
    let cred;
    try {
      cred = author ? await authorCredential(author) : null;
    } catch (err) {
      req.resume();
      console.warn('openaiProxy: credential not read', { sessionId: session.id, message: err?.message });
      return refuse(res, 502, 'the console could not read the credential for this call');
    }
    if (cred?.refused) {
      req.resume();
      console.warn('openaiProxy: refused, the author\'s sign-in not usable', { sessionId: session.id, author, why: cred.refused });
      return refuse(res, 403, cred.refused);
    }
    if (chatgpt) {
      const path = req.url.slice(CHATGPT_PREFIX.length);
      if (!cred || cred.apiKey) {
        req.resume();
        console.warn('openaiProxy: refused, ChatGPT is only for a review on its author\'s ChatGPT login', { sessionId: session.id });
        return refuse(res, 403, 'only a review on its author\'s own ChatGPT login reaches ChatGPT');
      }
      const allowed = chatgptPathAllowed(path);
      if (!allowed) {
        req.resume();
        console.warn('openaiProxy: refused a ChatGPT path a review\'s codex does not need', { sessionId: session.id, path: path.slice(0, 120) });
        return refuse(res, 404, 'not something a review\'s codex needs');
      }
      firstCall(session, 'the author\'s ChatGPT login');
      return forward(req, res, { target: targets.chatgpt, path: allowed, headers: cred.headers, sessionId: session.id });
    }
    // A review reads what anyone who can push wrote, and runs it: on a key, its codex reaches Codex's calls alone. So does
    // a Codex agent its owner started beside claude (session/agents.mjs): the team key's files, batches and the rest of
    // its account are no session's to reach.
    let openaiPath = req.url.slice(PREFIX.length) || '/';
    const besideClaude = !isReview(session) && session.options?.agent !== 'codex';
    if (isReview(session) || besideClaude) {
      openaiPath = reviewOpenAiPathAllowed(openaiPath);
      if (!openaiPath) {
        req.resume();
        console.warn(`openaiProxy: refused an OpenAI path ${besideClaude ? 'a Codex agent beside claude' : 'a review\'s codex'} does not need`, { sessionId: session.id, path: req.url.slice(0, 120) });
        return refuse(res, 404, 'not something codex needs');
      }
    }
    if (cred) {
      if (!cred.apiKey) {
        req.resume();
        return refuse(res, 403, 'this review\'s Codex runs on its author\'s ChatGPT login, through /chatgpt');
      }
      firstCall(session, 'the author\'s key');
      return forward(req, res, { target: targets.openai, path: openaiPath, headers: cred.headers, sessionId: session.id });
    }
    let key;
    try {
      key = await teamCredential();
    } catch (err) {
      // Secrets Manager failing: this call fails, and codex retries it.
      req.resume();
      console.warn('openaiProxy: credential not read', { sessionId: session.id, message: err?.message });
      return refuse(res, 502, 'the console could not read the credential for this call');
    }
    if (!key) {
      req.resume();
      console.warn('openaiProxy: no team key saved', { sessionId: session.id });
      return refuse(res, 503, 'the console has no OpenAI key: save your own Codex sign-in on My settings, or set openai-api-key on the Secrets page');
    }
    // Asked again after the key's read: a lockdown that started meanwhile took the session's Codex agent's access.
    if (!runsCodex(session) && !isReview(session)) {
      req.resume();
      console.warn('openaiProxy: refused, not a Codex session', { sessionId: session.id });
      return refuse(res, 403, 'only a Codex session may use the team\'s OpenAI key');
    }
    firstCall(session, 'the team key');
    return forward(req, res, { target: targets.openai, path: openaiPath, headers: { authorization: `Bearer ${key}` }, sessionId: session.id });
  }

  return { isProxyPath: isOpenAiPath, handle, teamCredential, cut };
}
