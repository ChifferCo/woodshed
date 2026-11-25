// A review's Grok Build and OpenCode calls to their model APIs, on the session API's port, on the pull request author's
// own sign-in. Those agents have no team key (shared/agents.cjs): a review runs one when its author turned their
// sign-in on for reviews and the default includes it, or their reviewer choice names it (reviewAgents.mjs). A sign-in
// already saved when that default shipped stays out until they set reviews back to the default. A saved
// choice that leaves it out does not, unless none of that choice can run, in which case the same default runs. The review
// records whose sign-in it is
// (`review.ownSignIns`). As the OpenAI proxy does for a review's Codex (openaiProxy.mjs), the sign-in is added here, so it
// never enters the review session, which reads what anyone who can push to the pull request wrote. The session's agent
// holds only its SESSION_TOKEN, as its API key:
//
//   /grok/v1/<path>                 Authorization: Bearer <SESSION_TOKEN>  ->  the author's xAI key at api.x.ai/v1/<path>,
//                                   or their `grok login` at cli-chat-proxy.grok.com/v1/<path> (grokModels.mjs, credentialOf)
//   /opencode/anthropic/v1/<path>   x-api-key: <SESSION_TOKEN>             ->  api.anthropic.com/v1/<path>, on the author's key
//   /opencode/openai/v1/<path>      Authorization: Bearer <SESSION_TOKEN>  ->  api.openai.com/v1/<path>, on the author's key
//
// The session's grok reaches here by GROK_MODELS_BASE_URL, and its opencode by a provider's `baseURL` in its own config
// (session/review.sh). Only what a review's model calls need passes, each path with the one method it needs: its turns
// and the model list, never a key's files, batches, stored completions or anything else. The sign-in is read at each call, so one turned off, removed or expired since the review
// started stops being used at once. The console never refreshes a Grok login (grokModels.mjs says why): one whose
// `expires_at` has passed is refused, and the review's grok says so. OpenCode runs only on an API key here, never a login
// (OPENCODE_REVIEW_PROVIDERS says why). Nothing of a sign-in is logged: the login, the agent, how, and a status.
//
// Each body is read whole (up to MAX_BODY_BYTES) and checked before the sign-in is read or added: it must be JSON with
// only the fields the review's agent was measured to send (reviewAgentScope.mjs), so a call cannot name a response,
// file, vector store, container or anything else the author's account already holds and have the provider read it for
// a prompt planted in the pull request. The body sent on is the checked one, written again. A GET passes with no body.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import agents from '../shared/agents.cjs';
import { isReview } from './sessions.mjs';
import { ownReviewCredential } from './reviewAgents.mjs';
import { refusedField, withoutReasoningIds } from './reviewAgentScope.mjs';

const GROK_PREFIX = '/grok';
const OPENCODE_PREFIX = '/opencode';

// What of each API a review's agent may reach, under its /v1, each path with the one method it needs. Measured with grok
// 1.0.92 on a key: GET /v1/models, POST /v1/responses (its session title) and POST /v1/chat/completions (its turns); with
// opencode 1.19.6, POST /v1/messages for Anthropic and POST /v1/responses for OpenAI. The method is part of the rule, not
// a detail: the same path read with another method is another API (OpenAI's GET /v1/chat/completions lists every stored
// completion in the key's project, and GET /v1/responses/<id> reads one back), which a prompt in the diff could ask for.
// No query string passes either: no call measured sends one, and one could turn a path into a listing.
const GROK_CALLS = { '/v1/models': 'GET', '/v1/responses': 'POST', '/v1/chat/completions': 'POST' };
const OPENCODE_PROVIDERS = {
  anthropic: {
    upstream: 'https://api.anthropic.com', header: (key) => ({ 'x-api-key': key }),
    calls: { '/v1/messages': 'POST', '/v1/messages/count_tokens': 'POST', '/v1/models': 'GET' },
  },
  openai: {
    upstream: 'https://api.openai.com', header: (key) => ({ authorization: `Bearer ${key}` }),
    calls: { '/v1/responses': 'POST', '/v1/models': 'GET' },
  },
};

// A path already in its plain form: no `.` or `..` segment, no empty one, no `%` escape and no backslash.
const UNPLAIN_PATH_RE = /[%\\]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/;
// Ours to set, or the connection's own: never passed on. OpenAI's organization and project headers too: they pick which
// of the author's projects a key acts in, which is the key's own, never the review's to choose.
const DROPPED_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'authorization', 'x-api-key',
  'cookie', 'chatgpt-account-id', 'anthropic-api-key', 'openai-organization', 'openai-project',
  // The body goes on as read and checked here, with its own length.
  'content-length', 'transfer-encoding', 'content-encoding']);

// The most of a call's body that is read to check it: a long review's conversation, with a few images, fits.
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const under = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** @returns {boolean}  whether a session API path is this proxy's */
export function isReviewAgentPath(pathname) {
  return under(pathname, GROK_PREFIX) || under(pathname, OPENCODE_PREFIX);
}

// Grok's conversation and session ids (`x-grok-conv-id`, `x-grok-session-id`, `x-grok-conv-group-id`, measured with
// 1.0.92), which xAI may keep state by: whatever the session sends, the upstream gets an id of this review's own, the same
// for the same id within the review, and never one naming a conversation outside it. Keyed by a secret of this console's
// alone, made at start.
const GROK_ID_HEADER = /^x-grok-[a-z-]*id$/;
const ID_KEY = crypto.randomBytes(32);

/** @returns {string}  a UUID-shaped id, from the review session, the header and the id the session sent */
export function scopedId(sessionId, name, value, key = ID_KEY) {
  const hex = crypto.createHmac('sha256', key).update(`${sessionId}\0${name}\0${Array.isArray(value) ? value.join(',') : String(value)}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The session token a call carries: a bearer, or Anthropic's x-api-key, which opencode's Anthropic provider sends its key in.
 * @returns {string|null}
 */
export function reviewAgentTokenOf(headers) {
  const bearer = /^Bearer (\S+)$/.exec(String(headers.authorization ?? ''))?.[1];
  if (bearer) return bearer;
  const key = headers['x-api-key'];
  return typeof key === 'string' && /^\S+$/.test(key) ? key : null;
}

/**
 * Which agent a call is for, and what of its API it asks: null for anything a review's agent has no business with.
 * @param {string} url  the request's path and query
 * @param {string} [method]  the request's method: a path passes only with the one its rule names
 * @returns {{agent: 'grok'|'opencode', provider: string|null, path: string}|{agent: string, refused: string, status?: number}|null}
 */
export function reviewAgentRoute(url, method = 'GET') {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  let agent;
  let provider = null;
  let rest;
  if (under(pathname, GROK_PREFIX)) {
    agent = 'grok';
    rest = pathname.slice(GROK_PREFIX.length);
  } else if (under(pathname, OPENCODE_PREFIX)) {
    agent = 'opencode';
    const m = /^\/([a-z0-9-]+)(\/.*)?$/.exec(pathname.slice(OPENCODE_PREFIX.length));
    if (!m || !Object.hasOwn(OPENCODE_PROVIDERS, m[1])) return { agent, refused: 'not a provider a review\'s OpenCode runs on' };
    provider = m[1];
    rest = m[2] ?? '';
  } else return null;
  const calls = agent === 'grok' ? GROK_CALLS : OPENCODE_PROVIDERS[provider].calls;
  const needs = !UNPLAIN_PATH_RE.test(rest) && Object.hasOwn(calls, rest) ? calls[rest] : null;
  const product = agents.agent(agent).product;
  if (!needs || url.includes('#')) return { agent, refused: `not something a review's ${product} needs` };
  if (method !== needs) return { agent, refused: `a review's ${product} only sends ${needs} to ${rest}`, status: 405 };
  if (q !== -1) return { agent, refused: `a review's ${product} sends no query string` };
  return { agent, provider, path: rest };
}

// A body up to MAX_BODY_BYTES; past it, the rest is read and dropped, so the refusal can still be answered.
function readCapped(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      if (bytes > MAX_BODY_BYTES) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        chunks.length = 0;
        return resolve('too large');
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve('cut off'));
    req.on('aborted', () => resolve('cut off'));
  });
}

function refuse(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: code === 401 ? 'authentication_error' : 'permission_error', message } }));
}

/**
 * @param {{userSettings?: {usesOwnAgentForReviews: (login: string, id: string) => boolean,
 *            agentAuth: (login: string, id: string) => Promise<string|null>}|null,
 *          grokUpstreams?: {key: string, login: string}, opencodeUpstreams?: Record<string, string>, now?: () => number}} opts
 *   the upstreams are for tests: a recording stand-in in place of xAI's, Anthropic's and OpenAI's
 * @returns {{isProxyPath: (pathname: string) => boolean,
 *            handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, session: object|null) => Promise<void>}}
 */
export function createReviewAgentProxy({ userSettings = null, grokUpstreams = {}, opencodeUpstreams = {}, now = Date.now } = {}) {
  const routed = new Set();

  /**
   * The author's own sign-in for the review's agent, read at each call.
   * @returns {Promise<{target: URL, headers: Record<string, string>, via: string}|{refused: string}>}
   */
  async function authorCredential(login, agent, provider) {
    const product = agents.agent(agent).product;
    if (!userSettings?.usesOwnAgentForReviews(login, agent)) return { refused: `@${login} no longer has their ${product} sign-in on for reviews` };
    const cred = ownReviewCredential(agent, await userSettings.agentAuth(login, agent), now());
    if (cred.why) return { refused: cred.why.replace('the author', `@${login}`) };
    if (agent === 'grok') {
      const base = (cred.via === 'login' ? grokUpstreams.login : grokUpstreams.key) ?? cred.base;
      return { target: new URL(base), headers: { authorization: cred.authorization }, via: cred.via };
    }
    if (cred.provider !== provider) return { refused: `@${login}'s saved OpenCode sign-ins no longer have the ${provider} API key this review started on` };
    return { target: new URL(opencodeUpstreams[provider] ?? OPENCODE_PROVIDERS[provider].upstream), headers: OPENCODE_PROVIDERS[provider].header(cred.key), via: provider };
  }

  function forward(req, res, { target, path, headers: added, product, body, sessionId }) {
    const transport = target.protocol === 'http:' ? http : https;
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (DROPPED_HEADERS.has(name)) continue;
      headers[name] = GROK_ID_HEADER.test(name) ? scopedId(sessionId, name, value) : value;
    }
    Object.assign(headers, added, { host: target.host });
    if (body) headers['content-length'] = String(body.length);
    const base = target.pathname.replace(/\/+$/, '');
    // The base names the API's /v1 (a Grok upstream) or none (Anthropic's, OpenAI's): the path asked for has its own.
    const upstreamPath = base.endsWith('/v1') ? `${base}${path.slice('/v1'.length)}` : `${base}${path}`;
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: upstreamPath, headers,
    }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      console.warn('reviewAgentProxy: upstream not reached', { product, path: path.slice(0, 120), message: err?.code ?? err?.name ?? 'Error' });
      if (!res.headersSent) return refuse(res, 502, `the console could not reach ${product}'s API`);
      res.destroy();
    });
    // The agent cancels a turn by closing its request: the upstream call goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    out.end(body ?? undefined);
  }

  /**
   * A call's body, read whole and checked before the author's sign-in is read: null when it was refused (and answered).
   * A GET has none, and one that carries one is not read: nothing of it goes on.
   */
  async function checkedBody(req, res, session, route, product) {
    if (req.method === 'GET') {
      req.resume();
      return undefined;
    }
    const api = route.agent === 'grok' ? 'grok' : route.provider;
    const refused = (status, why, field, message) => {
      console.warn('reviewAgentProxy: refused, a body a review\'s agent does not send', { sessionId: session.id, agent: route.agent, path: route.path, why, field });
      refuse(res, status, message);
      return null;
    };
    const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding !== 'identity') {
      req.resume();
      return refused(415, 'compressed', null, `a review's ${product} sends its calls uncompressed, as JSON the console can check`);
    }
    const body = await readCapped(req);
    if (body === 'too large') return refused(413, 'too large', null, `this call is larger than the console reads for a review (${MAX_BODY_BYTES / 1024 / 1024} MB)`);
    if (body === 'cut off') {
      res.destroy();
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return refused(400, 'not JSON', null, `a review's ${product} sends JSON the console can check, and this call is not`);
    }
    // grok's reasoning items come back with an id the provider does not need (reviewAgentScope.mjs): taken off.
    withoutReasoningIds(api, route.path, parsed);
    const field = refusedField(api, route.path, parsed);
    if (field !== null) {
      return refused(403, 'a field not allowed', field, `a review's ${product} does not send ${field} to ${route.path}: the console passes only what a review's ${product} sends, never a field that could name something the author's account holds`);
    }
    // What goes on is what was checked, written again from it, never the bytes as sent: JSON.parse keeps a key's last
    // value, so `"store": true, "store": false` passes the check as false, and a provider that read the first would store
    // the response in the author's project.
    return Buffer.from(JSON.stringify(parsed));
  }

  async function handle(req, res, session) {
    const route = reviewAgentRoute(req.url, req.method);
    const product = agents.agent(route?.agent).product;
    if (!session) {
      req.resume();
      console.warn('reviewAgentProxy: refused, no active session has that token', { from: req.socket.remoteAddress });
      return refuse(res, 401, 'not an active Woodshed session');
    }
    if (!isReview(session)) {
      req.resume();
      console.warn('reviewAgentProxy: refused, not a review session', { sessionId: session.id, agent: route?.agent ?? null });
      return refuse(res, 403, `only a review of its author's pull request runs ${product} through the console`);
    }
    // A review is never tainted (production access is a private session's alone): one that is, is refused all the same.
    if (session.taintedAt) {
      req.resume();
      console.warn('reviewAgentProxy: refused, a tainted session', { sessionId: session.id });
      return refuse(res, 403, 'this session has seen production data');
    }
    if (!route || route.refused) {
      req.resume();
      // The path only, never its query: a query is refused, and what it held is not logged.
      console.warn('reviewAgentProxy: refused a call a review\'s agent does not need', { sessionId: session.id, agent: route?.agent ?? null, method: String(req.method).slice(0, 16), path: req.url.split('?')[0].slice(0, 120) });
      return refuse(res, route?.status ?? 404, route?.refused ?? 'not something a review needs');
    }
    const own = session.review.agents?.includes(route.agent) ? session.review.ownSignIns?.[route.agent] ?? null : null;
    if (!own?.login) {
      req.resume();
      console.warn('reviewAgentProxy: refused, the review does not run it', { sessionId: session.id, agent: route.agent });
      return refuse(res, 403, `this review does not run ${product}`);
    }
    if (route.agent === 'opencode' && own.provider !== route.provider) {
      req.resume();
      console.warn('reviewAgentProxy: refused, not the provider the review started on', { sessionId: session.id, provider: route.provider, started: own.provider ?? null });
      return refuse(res, 403, `this review's OpenCode runs on ${own.provider ?? 'no provider'}, not ${route.provider}`);
    }
    // Checked before the sign-in is read: a call that could name what the author's account holds never gets it.
    const body = await checkedBody(req, res, session, route, product);
    if (body === null) return undefined;
    let cred;
    try {
      cred = await authorCredential(own.login, route.agent, route.provider);
    } catch (err) {
      req.resume();
      console.warn('reviewAgentProxy: credential not read', { sessionId: session.id, agent: route.agent, message: err?.name ?? 'Error' });
      return refuse(res, 502, 'the console could not read the credential for this call');
    }
    if (cred.refused) {
      req.resume();
      console.warn('reviewAgentProxy: refused, the author\'s sign-in not usable', { sessionId: session.id, agent: route.agent, author: own.login, why: cred.refused });
      return refuse(res, 403, cred.refused);
    }
    if (!routed.has(`${session.id}/${route.agent}`)) {
      routed.add(`${session.id}/${route.agent}`);
      console.log(`reviewAgentProxy: first call on the author's ${product} sign-in`, { sessionId: session.id, agent: route.agent, author: own.login, via: cred.via });
    }
    return forward(req, res, { target: cred.target, path: route.path, headers: cred.headers, product, body, sessionId: session.id });
  }

  return { isProxyPath: isReviewAgentPath, handle };
}
