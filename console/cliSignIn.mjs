// The woodshed command line's sign-in (cli/), by a device code the person approves in a browser where they are signed in
// to the console, as `gh auth login` and other command lines do (RFC 8628):
//
//   POST /api/cli/device   {"name": "<the computer's name>"}   ->  {deviceCode, userCode, verificationUrl, expiresIn, interval}
//   GET  /cli?code=        (signed in)  ->  a page naming the computer and the code: Sign in the CLI, or Deny
//   POST /cli              (that page's buttons, same origin)  ->  the code approved, or denied, as the signed-in person
//   POST /api/cli/token    {"deviceCode"}  ->  202 while it waits, then 200 {token, login, expiresAt} once, or 403 denied,
//                                              410 expired, 429 asked too often
//   GET  /api/cli/me       (Authorization: Bearer wsc_...)  ->  who the token is, and the console's name, org and address
//   POST /api/cli/logout   (Authorization: Bearer wsc_...)  ->  ends that token
//
// Every call that signs in with a token, here, on `woodshed session`'s routes (cliSessions.mjs) and on the pipe into a
// session (execPipe.mjs), is checked by `authenticate` alone, so no route can skip a check: the token is live, its
// person is still on the console (`allowed`), and they still have write access on GitHub (`canWrite`), asked at the
// token's first use and then every hour, as a browser's sign-in is (auth.mjs). When GitHub says no, every command line
// sign-in of theirs ends, as the browser's session does; GitHub not answering lets the call through, and is asked again
// 5 minutes later.
//
// The token is a CLI token of its own, not the database tunnel's (dbTunnel.mjs): that one lasts 12 hours, a person has one
// at a time, and it is made only once their databases are ready. A CLI sign-in is one per computer, lasts 90 days, and
// each shows on My settings with Revoke. The console keeps only each token's SHA-256, in state.json under `cliTokens`.
// Device codes are kept in memory: one outlives no restart, and the CLI starts again.
//
// A browser sends Origin with every cross-site POST and the CLI sends none, so /api/cli/device and /api/cli/token
// refuse a request that has one: no web page starts a sign-in to hand someone the code of. The code is only ever
// approved on the console's own page, by a signed-in person who sees which computer asked and when.
//
// A program that runs several consoles behind one address (console/README.md, "Embedding the console") gives them one
// waiting room (`devices`, from createCliDevices): the CLI's first calls carry no sign-in, so nothing says which console
// they are for until a person approves the code on one. The console that approved it makes the token, in its own state,
// checked by its own `allowed`, whichever console the CLI's next poll reaches; and `owns` says which console holds a
// token, so the program can send each of the token's calls there.
//
// Starting a sign-in needs no identity, so how many may wait is limited per client address (clientAddress.mjs: behind
// a trusted proxy, the address it forwards), and console-wide as a backstop: one client filling its share leaves the
// rest to everyone else. Over either, /api/cli/device answers 429 with Retry-After, the seconds until the oldest of
// those waiting expires.

import { AsyncResource } from 'node:async_hooks';
import crypto from 'node:crypto';
import { isSameOrigin } from '../shared/sameOrigin.mjs';
import agents from '../shared/agents.cjs';
import { clientAddress, clientKey, parseTrustedProxies } from './clientAddress.mjs';
import { PAGE_HEADERS, PAGE_STYLE } from './desktopSignIn.mjs';

export const CLI_TOKEN_TTL_MS = 90 * 24 * 3_600_000;
const DEVICE_CODE_MS = 10 * 60_000;
const POLL_SECONDS = 5;
// More than this many sign-ins waiting at once, and a new one is refused until some expire: each holds a little memory.
const MAX_PENDING = 200;
// Denied codes hold no place (start), so they are bounded on their own: past this many, the oldest is dropped, and its
// CLI, which has likely stopped asking, hears its code expired instead of denied.
const MAX_DENIED = 200;
// And this many from one client address: a person who runs login again, or a few people behind one office's address.
// A code collected or denied in the browser stops counting at once (a denied one is kept, uncounted, for its CLI's next
// poll); one left behind (a login stopped with Ctrl-C) counts until its 10 minutes are up.
export const MAX_PENDING_PER_CLIENT = 5;
// A flood of refused starts is logged at most this often for each limit, with how many there were.
const REFUSAL_LOG_MS = 60_000;
// A person's computers: past this, a new sign-in ends their oldest.
const MAX_TOKENS_PER_PERSON = 20;
// How often a token's last use is written down: each write saves state.json.
const LAST_USED_EVERY_MS = 60 * 60_000;
const MAX_BODY_BYTES = 4096;
// Write access on GitHub is asked again after this, and after this when GitHub did not answer.
const WRITE_RECHECK_MS = 3_600_000;
const WRITE_RETRY_MS = 5 * 60_000;
const NOT_SIGNED_IN = 'not signed in, or the sign-in ended: run woodshed login';
const WRITE_ACCESS_GONE = 'you no longer have write access to the repository: your command line sign-in ended';
const BEARER_RE = /^Bearer (wsc_[0-9a-f]{64})$/;
// No vowels, so no code spells a word, and none of 0/O or 1/I to misread (RFC 8628, 6.1).
const USER_CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
export const CLI_PAGE_PATH = '/cli';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function userCode() {
  const pick = () => USER_CODE_LETTERS[crypto.randomInt(USER_CODE_LETTERS.length)];
  const four = () => Array.from({ length: 4 }, pick).join('');
  return `${four()}-${four()}`;
}

/** @returns {string|null}  the code as the person may type it (lower case, no dash, spaces), or null for no code */
export function normalUserCode(typed) {
  const letters = String(typed ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== 8) return null;
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

/** What the computer called itself: shown on the page and My settings, so printable and short. */
function deviceName(name) {
  const clean = String(name ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
  return clean || 'a computer';
}

/**
 * The sign-ins waiting for a person, for createCliSignIn's `devices`: one per console, or one several consoles share.
 * @returns {Map<string, object>}  deviceCode's hash -> {userCode, name, from, client, createdAt, expiresAt, lastPollAt,
 *   approved: {login, by, issue}|null, denied}: `by` is the console that approved, `issue` makes its token, `client` the
 *   key the limit per client counts by (clientAddress.mjs), across every console sharing the room
 */
export function createCliDevices() {
  return new Map();
}

/**
 * Whether a token's person still has write access, asked of GitHub at first and then hourly.
 * @param {{canWrite: ((login: string) => Promise<boolean>)|null, revokeAll: (login: string, by: string) => void,
 *          now?: () => number, logAs?: string}} deps  `canWrite` null where sign-in does not ask GitHub (no sign-in, or a
 *   hosting proxy); `logAs` the prefix of its log lines, the caller's: a session's start checks it too (sessionStarts)
 * @returns {{allowed: (login: string|null) => Promise<boolean>}}
 */
export function createWriteAccess({ canWrite, revokeAll, now = Date.now, logAs = 'cliSignIn' }) {
  const checkedAt = new Map();
  const retryAfter = new Map();
  const checking = new Map();

  async function check(login) {
    let still;
    try {
      still = await canWrite(login);
    } catch (err) {
      retryAfter.set(login, now() + WRITE_RETRY_MS);
      console.warn(`${logAs}: write access not rechecked`, { login, retryInMs: WRITE_RETRY_MS, message: String(err?.message ?? err).split('\n')[0] });
      return true;
    }
    retryAfter.delete(login);
    if (!still) {
      checkedAt.delete(login);
      console.log(`${logAs}: refused, write access gone`, { login });
      revokeAll(login, 'write access gone');
      return false;
    }
    checkedAt.set(login, now());
    return true;
  }

  async function allowed(login) {
    if (!canWrite || !login) return true;
    if (now() - (checkedAt.get(login) ?? -Infinity) < WRITE_RECHECK_MS) return true;
    if (now() < (retryAfter.get(login) ?? 0)) return true;
    // A start's wait asks every few seconds, and an open pipe every 15: those share one check rather than one call to
    // GitHub each.
    if (!checking.has(login)) checking.set(login, check(login).finally(() => checking.delete(login)));
    return checking.get(login);
  }

  return { allowed };
}

/**
 * @param {{store: {state: object, save: () => void}, now?: () => number,
 *          allowed?: (login: string|null) => boolean, canWrite?: ((login: string) => Promise<boolean>)|null,
 *          devices?: ReturnType<typeof createCliDevices>, trustedProxies?: ReturnType<typeof parseTrustedProxies>}} deps
 *   `allowed` says whether a login may still use the console (on the People list): a token whose person was taken off it
 *   stops working at once, not when it expires. `canWrite` asks GitHub whether they still have write access (auth.mjs's),
 *   null where sign-in does not ask it. `devices` is the waiting room, the console's own unless it shares one.
 *   `trustedProxies` are those whose X-Forwarded-For names the client (WOODSHED_TRUSTED_PROXIES, loopback by default)
 */
export function createCliSignIn({ store, now = Date.now, allowed = () => true, canWrite = null, devices = createCliDevices(), trustedProxies = parseTrustedProxies() }) {
  const pending = devices;
  // Losing write access ends every sign-in of theirs, as it does a browser's.
  const writeAccess = createWriteAccess({ canWrite, revokeAll: (login, by) => revokeAll(login, by), now });
  // This console, as an approval names it: a shared room holds other consoles' approvals too.
  const self = Symbol('cliSignIn');
  // This console, as its consent page names it: consoles at one address can share every label the page shows (a name,
  // an org, or none), so the form carries this, and a form from another console's page asks again. Not a secret: it
  // only tells consoles apart, and a code outlives no restart, so one made at each start is enough.
  const consoleId = crypto.randomBytes(12).toString('hex');
  // Told of each token that ends before its time, so what it holds open closes with it (execPipe.mjs).
  const endedListeners = [];
  const ended = (id, login, why) => {
    for (const fn of endedListeners) {
      try {
        fn({ id, login, why });
      } catch (err) {
        console.warn('cliSignIn: a listener failed at a token\'s end', { id, message: err.message });
      }
    }
  };
  // For each limit: refused starts not logged yet, and when it last logged.
  const refusals = { client: { count: 0, loggedAt: -Infinity }, console: { count: 0, loggedAt: -Infinity } };

  function tokens() {
    store.state.cliTokens ??= {};
    return store.state.cliTokens;
  }

  function sweep() {
    for (const [key, device] of pending) if (device.expiresAt <= now()) pending.delete(key);
    let dropped = false;
    for (const [id, record] of Object.entries(tokens())) {
      if (Date.parse(record.expiresAt) <= now()) {
        delete tokens()[id];
        dropped = true;
      }
    }
    if (dropped) store.save();
  }

  function byUserCode(code) {
    for (const device of pending.values()) if (device.userCode === code && device.expiresAt > now()) return device;
    return null;
  }

  // Over a limit: refused with the seconds until the oldest of those it counted expires. Logged at most once a minute for
  // each limit, with `refused`, how many of that limit's refusals since its last line (any addresses), and `lastFrom`,
  // the address of the one that wrote it.
  function refuse({ scope, counted, from, most }) {
    const oldest = Math.min(...counted.map((device) => device.expiresAt));
    const retryAfter = Math.max(1, Math.ceil((oldest - now()) / 1000));
    const tally = refusals[scope];
    tally.count += 1;
    if (now() - tally.loggedAt >= REFUSAL_LOG_MS) {
      console.warn('cliSignIn: sign-in refused, too many waiting', { scope, lastFrom: from, most, retryAfter, refused: tally.count });
      tally.count = 0;
      tally.loggedAt = now();
    }
    const minutes = Math.ceil(retryAfter / 60);
    const later = `try again in ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const message = scope === 'client'
      ? `${most} sign-ins from your address are already waiting: finish one you started, or ${later}`
      : `too many sign-ins are waiting on this console: ${later}`;
    return Object.assign(new Error(message), { status: 429, retryAfter, scope });
  }

  /**
   * A new sign-in waiting for a person.
   * @param {{name?: string, from?: string|null}} args  `from` is the client's address (clientOf), which the limit per
   *   client counts by and the log names
   * @returns {{deviceCode: string, userCode: string, expiresIn: number, interval: number}}
   */
  function start({ name, from = null }) {
    sweep();
    // A request with no address at all (a stand-in in a test) is one client of its own: the console-wide cap still holds.
    const client = clientKey(from) ?? 'unknown';
    // A denied code only waits for its CLI to hear so: it holds no place.
    const waitingNow = [...pending.values()].filter((device) => !device.denied);
    const mine = waitingNow.filter((device) => device.client === client);
    if (mine.length >= MAX_PENDING_PER_CLIENT) throw refuse({ scope: 'client', counted: mine, from, most: MAX_PENDING_PER_CLIENT });
    if (waitingNow.length >= MAX_PENDING) throw refuse({ scope: 'console', counted: waitingNow, from, most: MAX_PENDING });
    const deviceCode = crypto.randomBytes(32).toString('hex');
    let code = userCode();
    while (byUserCode(code)) code = userCode();
    pending.set(sha256(deviceCode), {
      userCode: code, name: deviceName(name), from, client, createdAt: now(), expiresAt: now() + DEVICE_CODE_MS, lastPollAt: 0, approved: null, denied: false,
    });
    console.log('cliSignIn: sign-in started', { name: deviceName(name), from });
    return { deviceCode, userCode: code, expiresIn: DEVICE_CODE_MS / 1000, interval: POLL_SECONDS };
  }

  /** @returns {{userCode: string, name: string, from: string|null, createdAt: string}|null}  a waiting sign-in, for the page */
  function waiting(code) {
    const device = byUserCode(normalUserCode(code));
    if (!device || device.approved || device.denied) return null;
    return { userCode: device.userCode, name: device.name, from: device.from, createdAt: new Date(device.createdAt).toISOString() };
  }

  /**
   * @param {{code: string, login: string|null, approve: boolean, about?: object|null}} args  `about` is what the CLI is
   *   told of the console with its token (handleCliApi), as this console says it now
   * @returns {boolean}  false when there is no such code waiting
   */
  function decide({ code, login, approve, about = null }) {
    const device = byUserCode(normalUserCode(code));
    if (!device || device.approved || device.denied) return false;
    // The token is this console's, made when the CLI next asks, through whichever console sharing the room it reaches.
    // Bound to this call's context, so what making it logs is this console's, as everything else it does here is.
    if (approve) {
      device.approved = {
        login, by: self,
        issue: AsyncResource.bind((name) => (allowed(login) ? { status: 'approved', login, about, ...issue({ login, name }) } : { status: 'denied' })),
      };
    } else {
      device.denied = true;
      capDenied();
    }
    console.log(approve ? 'cliSignIn: sign-in approved' : 'cliSignIn: sign-in denied', { login, name: device.name });
    return true;
  }

  function capDenied() {
    const denied = [...pending.entries()].filter(([, device]) => device.denied).sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [key] of denied.slice(0, Math.max(0, denied.length - MAX_DENIED))) pending.delete(key);
  }

  function issue({ login, name }) {
    const id = crypto.randomBytes(8).toString('hex');
    const token = `wsc_${crypto.randomBytes(32).toString('hex')}`;
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + CLI_TOKEN_TTL_MS).toISOString();
    const mine = Object.entries(tokens()).filter(([, r]) => r.login === login).sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - MAX_TOKENS_PER_PERSON + 1))) {
      console.log('cliSignIn: oldest sign-in ended, past the most a person keeps', { login, id: oldId, most: MAX_TOKENS_PER_PERSON });
      delete tokens()[oldId];
      ended(oldId, login, 'past the most a person keeps');
    }
    tokens()[id] = { login, name, hash: sha256(token), createdAt, expiresAt, lastUsedAt: createdAt };
    store.save();
    console.log('cliSignIn: token made', { login, id, name, expiresAt });
    return { id, token, expiresAt };
  }

  /**
   * The CLI asking whether its sign-in was approved yet. A token is handed out once: the code is gone after.
   * @returns {{status: 'pending'|'slow_down'|'denied'|'expired'}|{status: 'approved', token: string, id: string,
   *   login: string|null, expiresAt: string, about: object|null}}  `about` is the approving console's
   */
  function poll(deviceCode) {
    if (typeof deviceCode !== 'string' || !/^[0-9a-f]{64}$/.test(deviceCode)) return { status: 'expired' };
    const key = sha256(deviceCode);
    const device = pending.get(key);
    if (!device || device.expiresAt <= now()) {
      pending.delete(key);
      return { status: 'expired' };
    }
    if (device.denied) {
      pending.delete(key);
      return { status: 'denied' };
    }
    if (device.approved) {
      pending.delete(key);
      return device.approved.issue(device.name);
    }
    // A second earlier than the interval is let through: timers on a busy laptop run late, never early, but the
    // round trip can make two polls look closer than they were sent.
    const tooSoon = now() - device.lastPollAt < (POLL_SECONDS - 1) * 1000;
    device.lastPollAt = now();
    return { status: tooSoon ? 'slow_down' : 'pending' };
  }

  /**
   * Whether the request carries a live token of this console's, for a program routing requests between consoles: no
   * check of `allowed` and nothing written, so the console it is sent to refuses it, and logs why, as its own.
   * @returns {boolean}
   */
  function owns(headers) {
    const token = BEARER_RE.exec(String(headers?.authorization || ''))?.[1];
    if (!token) return false;
    const hash = sha256(token);
    // Read as it is: a console that never made a token has no `cliTokens`, and routing writes nothing to it.
    return Object.values(store.state.cliTokens ?? {}).some((r) => r.hash === hash && Date.parse(r.expiresAt) > now());
  }

  // The live token a request carries, its person still on the console. Not handed out: `authenticate` is the only way
  // in, so no route skips the check of write access.
  function liveToken(headers) {
    const token = BEARER_RE.exec(String(headers?.authorization || ''))?.[1];
    if (!token) return null;
    const hash = sha256(token);
    const found = Object.entries(tokens()).find(([, r]) => r.hash === hash);
    if (!found || Date.parse(found[1].expiresAt) <= now()) return null;
    const [id, record] = found;
    if (!allowed(record.login)) {
      console.warn('cliSignIn: refused, the token\'s person is no longer a member', { login: record.login, id });
      return null;
    }
    if (now() - Date.parse(record.lastUsedAt ?? 0) >= LAST_USED_EVERY_MS) {
      record.lastUsedAt = new Date(now()).toISOString();
      store.save();
    }
    return { id, login: record.login, record };
  }

  /**
   * The one check of a request's token, for every route it signs in to.
   * @returns {Promise<{signedIn: {id: string, login: string|null, record: object}|null, error: string|null,
   *   ended: boolean}>}  `signedIn` null when refused, with `error` to answer; `ended` when the check itself ended the
   *   token (its person's write access gone), so a logout has nothing left to do
   */
  async function authenticate(headers) {
    const found = liveToken(headers);
    if (!found) return { signedIn: null, error: NOT_SIGNED_IN, ended: false };
    if (!(await writeAccess.allowed(found.login))) return { signedIn: null, error: WRITE_ACCESS_GONE, ended: true };
    // Revoked while GitHub was asked (My settings, or the person taken off People).
    if (!tokens()[found.id]) return { signedIn: null, error: NOT_SIGNED_IN, ended: false };
    return { signedIn: found, error: null, ended: false };
  }

  /** @returns {{id, name, createdAt, expiresAt, lastUsedAt}[]}  a person's CLI sign-ins, newest first; never a hash */
  function list(login) {
    sweep();
    return Object.entries(tokens()).filter(([, r]) => r.login === login)
      .map(([id, r]) => ({ id, name: r.name, createdAt: r.createdAt, expiresAt: r.expiresAt, lastUsedAt: r.lastUsedAt ?? null }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** @returns {boolean}  false when that person has no sign-in of that id */
  function revoke(login, id, by = 'My settings') {
    const record = tokens()[id];
    if (!record || record.login !== login) return false;
    delete tokens()[id];
    store.save();
    console.log('cliSignIn: token revoked', { login, id, name: record.name, by });
    ended(id, login, 'revoked');
    return true;
  }

  /** Every CLI sign-in of a person's: Remove My Woodshed, or taken off People. */
  function revokeAll(login, by) {
    // A code approved for them and not collected yet would otherwise sign them in again after this. Only this
    // console's: in a shared room, their approval on another console is that one's.
    for (const device of pending.values()) {
      if (device.approved?.by === self && device.approved.login === login) {
        device.approved = null;
        device.denied = true;
      }
    }
    capDenied();
    const ids = Object.entries(tokens()).filter(([, r]) => r.login === login).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) delete tokens()[id];
    store.save();
    console.log('cliSignIn: every token revoked', { login, count: ids.length, by });
    for (const id of ids) ended(id, login, 'revoked');
  }

  /** @param {(ended: {id: string, login: string|null, why: string}) => void} fn  called as each token is revoked */
  function whenEnded(fn) {
    endedListeners.push(fn);
  }

  return {
    id: consoleId, start, waiting, decide, poll, owns, authenticate, list, revoke, revokeAll, whenEnded,
    logins: () => [...new Set(Object.values(tokens()).map((r) => r.login))],
    /** The address a request came from, through a trusted proxy's X-Forwarded-For (clientAddress.mjs). */
    clientOf: (req) => clientAddress(req, trustedProxies),
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Whether `login` has saved each personal agent sign-in, for `GET /api/cli/me`'s `sessionSignIns` (setup's agent step).
 * As on My settings, a sign-in saved directly to the store also counts: refresh re-reads it, and caches the check.
 * Grok Build and OpenCode count only with their own sign-in saved (shared/agents.cjs).
 * @returns {(login: string|null) => Promise<{claude: boolean, codex: boolean, grok: boolean, opencode: boolean}>}
 */
export function sessionSignInsOf(userSettings) {
  return async (login) => {
    await userSettings?.refresh?.(login);
    const view = userSettings?.view(login);
    const own = Object.fromEntries(agents.OWN_ONLY_AGENTS.map((id) => [id, view?.agentAuth?.[id]?.set === true]));
    return { claude: view?.claudeToken?.set === true, codex: view?.codexAuth?.set === true, ...own };
  };
}

/**
 * The CLI's own calls, which carry no cookie: a device code or a token is their sign-in.
 * @param {{req, res, url: URL, cli: ReturnType<typeof createCliSignIn>, publicUrl: string,
 *          about: (login: string|null) => {console: string, org: string|null},
 *          sessionSignIns?: (login: string|null) => Promise<{claude: boolean, codex: boolean}>}} args
 * @returns {Promise<boolean>}  whether it answered: true for any /api/cli/ path
 */
export async function handleCliApi({ req, res, url, cli, publicUrl, about, sessionSignIns }) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/cli/')) return false;
  if (pathname === '/api/cli/device' || pathname === '/api/cli/token') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    if (req.headers.origin) {
      console.warn('cliSignIn: refused, a browser\'s call', { path: pathname, origin: String(req.headers.origin).slice(0, 100) });
      return json(res, 403, { error: 'sign in from the woodshed command line' }), true;
    }
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { error: 'send a JSON object' }), true;
    if (pathname === '/api/cli/device') {
      let started;
      try {
        started = cli.start({ name: body.name, from: cli.clientOf(req) });
      } catch (err) {
        if (!err.status) throw err;
        return json(res, err.status, { error: err.message, ...(err.scope ? { scope: err.scope } : {}) }, err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {}), true;
      }
      const verificationUrl = `${publicUrl}${CLI_PAGE_PATH}`;
      return json(res, 200, { ...started, verificationUrl, verificationUrlComplete: `${verificationUrl}?code=${started.userCode}` }), true;
    }
    const answer = cli.poll(body.deviceCode);
    const statuses = {
      pending: [202, { status: 'pending' }],
      slow_down: [429, { status: 'slow_down', error: `ask at most every ${POLL_SECONDS} seconds` }],
      denied: [403, { status: 'denied', error: 'the sign-in was denied in the browser' }],
      expired: [410, { status: 'expired', error: 'the code expired before it was approved: run woodshed login again' }],
    };
    if (answer.status === 'approved') {
      const { token, id, login, expiresAt } = answer;
      return json(res, 200, { status: 'approved', token, id, login, expiresAt, ...(answer.about ?? about(login)) }), true;
    }
    const [status, reply] = statuses[answer.status];
    return json(res, status, reply), true;
  }
  const { signedIn, error, ended } = await cli.authenticate(req.headers);
  // A logout whose check ended the token (write access gone) got what it asked for.
  if (!signedIn && ended && pathname === '/api/cli/logout' && req.method === 'POST') return json(res, 200, { ok: true }), true;
  if (!signedIn) return json(res, 401, { error }), true;
  if (pathname === '/api/cli/me' && req.method === 'GET') {
    const { id, login, record } = signedIn;
    return json(res, 200, { login, ...about(login), url: publicUrl, token: { id, name: record.name, createdAt: record.createdAt, expiresAt: record.expiresAt },
      ...(sessionSignIns ? { sessionSignIns: await sessionSignIns(login) } : {}) }), true;
  }
  if (pathname === '/api/cli/logout' && req.method === 'POST') {
    cli.revoke(signedIn.login, signedIn.id, 'woodshed logout');
    return json(res, 200, { ok: true }), true;
  }
  return json(res, 404, { error: 'not found' }), true;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CLI_STYLE = `${PAGE_STYLE}
  .code { display: block; font: 600 24px/1.2 "Red Hat Mono", ui-monospace, monospace; letter-spacing: 0.08em; margin: 0 0 20px; }
  .meta { font: 13px/1.5 "Red Hat Mono", ui-monospace, monospace; color: var(--sub); margin: -12px 0 20px; }
  .field { display: block; width: 100%; box-sizing: border-box; margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--ground); color: var(--ink); font: 600 20px "Red Hat Mono", ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
  .error { color: var(--bad); margin: -8px 0 16px; }
  button.quiet { background: none; border: 0; padding: 10px 4px; font: inherit; cursor: pointer; text-decoration: underline; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  :root { --bad: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bad: #f97066; } }`;

function page({ consoleName, title, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(consoleName)}: ${escapeHtml(title)}</title>
<style>${CLI_STYLE}</style></head>
<body><main>
${body}
</main></body></html>`;
}

// No code, or one that is not waiting: a box to type the one the terminal shows.
function typePage({ consoleName, error = null, code = '' }) {
  return page({
    consoleName, title: 'sign in the command line', body: `  <h1>Sign in the woodshed command line</h1>
  <p>Type the code <code>woodshed login</code> shows in your terminal.</p>
  <form method="get" action="${CLI_PAGE_PATH}">
    <label class="sr-only" for="code">Code</label>
    <input class="field" id="code" name="code" value="${escapeHtml(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" required>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <button class="btn" type="submit">Next</button><a class="quiet" href="/">Cancel</a>
  </form>`,
  });
}

// What the page says the token is for, which its form sends back: a page left open while the browser moved to another
// console at the same address (an embedding program's) asks again, as one left open while it signed in as someone
// else does, so the token is never another console's than the page named.
function shownAbout(about) {
  return JSON.stringify(about ?? null);
}

// The question before the token: who signs in, on which computer and to what, and that it is only for a sign-in the
// person started.
function consentPage({ consoleName, consoleId, login, device, about }) {
  const who = login ? `as <strong>@${escapeHtml(login)}</strong>` : '';
  const org = about?.org ? ` for <strong>${escapeHtml(about.org)}</strong>` : '';
  return page({
    consoleName, title: 'sign in the command line', body: `  <h1>Sign in the woodshed command line?</h1>
  <p>The woodshed command line on <strong>${escapeHtml(device.name)}</strong> asks to sign in to ${escapeHtml(consoleName)}${org} ${who}. Sign in only if you just ran <code>woodshed login</code> and your terminal shows this code:</p>
  <span class="code">${escapeHtml(device.userCode)}</span>
  <p class="meta">Asked ${escapeHtml(device.createdAt.replace('T', ' ').slice(0, 16))} UTC</p>
  <form method="post" action="${CLI_PAGE_PATH}">
    <input type="hidden" name="code" value="${escapeHtml(device.userCode)}">
    <input type="hidden" name="login" value="${escapeHtml(login ?? '')}">
    <input type="hidden" name="about" value="${escapeHtml(shownAbout(about))}">
    <input type="hidden" name="console" value="${escapeHtml(consoleId)}">
    <button class="btn" type="submit" name="decision" value="approve">Sign in the CLI</button><button class="quiet" type="submit" name="decision" value="deny">Deny</button>
  </form>`,
  });
}

function donePage({ consoleName, approved, name }) {
  return page({
    consoleName, title: approved ? 'command line signed in' : 'sign-in denied',
    body: approved
      ? `  <h1>The command line is signed in</h1>
  <p>Go back to your terminal on ${escapeHtml(name)}. You can close this tab. My settings lists each computer signed in, with Revoke.</p>
  <a class="btn" href="/settings#my-cli">Open My settings</a>`
      : `  <h1>Sign-in denied</h1>
  <p>The command line on ${escapeHtml(name)} is not signed in. If you did not run <code>woodshed login</code> yourself, someone may have sent you the link: tell whoever runs this console.</p>
  <a class="btn" href="/">Open the console</a>`,
  });
}

/**
 * The page the person approves the code on, behind the console's sign-in.
 * @param {{req, res, url: URL, cli: ReturnType<typeof createCliSignIn>, login: string|null, consoleName: string,
 *          about?: (login: string|null) => {console: string, org: string|null}}} args
 *   `about` is what the CLI is told of the console, as handleCliApi's: the page names its org, and the token carries it
 * @returns {Promise<boolean>}  whether it answered
 */
export async function handleCliPage({ req, res, url, cli, login, consoleName, about = () => null }) {
  if (url.pathname !== CLI_PAGE_PATH) return false;
  const send = (body, status = 200) => {
    res.writeHead(status, PAGE_HEADERS);
    res.end(body);
    return true;
  };
  if (req.method === 'GET') {
    const typed = url.searchParams.get('code');
    if (!typed) return send(typePage({ consoleName }));
    const device = cli.waiting(typed);
    if (!device) return send(typePage({ consoleName, code: typed.slice(0, 20), error: 'No sign-in is waiting with that code. It lasts 10 minutes: run woodshed login again for a new one.' }), 404);
    return send(consentPage({ consoleName, consoleId: cli.id, login, device, about: about(login) }));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
  // The consent page's own buttons: a browser always sends Origin with a form's POST, and another site's is refused.
  if (!req.headers.origin || !isSameOrigin(req.headers)) return json(res, 403, { error: 'approve the sign-in from the console\'s own page' }), true;
  let form;
  try {
    form = new URLSearchParams(await readBody(req));
  } catch {
    return json(res, 400, { error: 'the form was too large' }), true;
  }
  const code = form.get('code') ?? '';
  // A page left open while this browser signed in as someone else, or moved to another console at this address, asks
  // again, naming who and where it is now. The console is told by its id, not its labels, which two consoles can share;
  // the labels are checked too, so a page that named an org this console no longer says is asked again. A form with no
  // id is from no page that can still approve: codes are kept in memory, so none outlives the restart that brought it.
  const aboutNow = about(login);
  const otherConsole = form.get('console') !== cli.id || form.get('about') !== shownAbout(aboutNow);
  if ((form.get('login') ?? '') !== (login ?? '') || otherConsole) {
    console.warn(otherConsole ? 'cliSignIn: the consent page named another console, asked again' : 'cliSignIn: the consent page named another account, asked again',
      { shown: String(form.get('login') ?? '').slice(0, 40), now: login });
    res.writeHead(303, { location: `${CLI_PAGE_PATH}?code=${encodeURIComponent(code)}`, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  const device = cli.waiting(code);
  const approve = form.get('decision') === 'approve';
  if (!device || !cli.decide({ code, login, approve, about: aboutNow })) {
    return send(typePage({ consoleName, error: 'That sign-in has expired or was already answered. Run woodshed login again.' }), 410);
  }
  return send(donePage({ consoleName, approved: approve, name: device.name }));
}
