// Keeps a person's saved Grok Build login (users/<login>/grok-auth, ~/.grok/auth.json) usable by refreshing it.
//
// The login's access token (`key`) ends at `expires_at`, within hours of being saved. Grok Build refreshes it with
// xAI's OIDC token endpoint (measured: the issuer in the entry's scope, `https://auth.x.ai::<client id>`, its
// `.well-known/openid-configuration` names `token_endpoint`, a public client, so a refresh_token grant with the
// client_id and no secret). xAI rotates the refresh token at each use: the old one is dead afterwards. A Grok session
// of the owner's holds a copy of the login, and writes its own refreshed one back when it stops (sessionApi.mjs,
// agentAuthReply). The two must not both refresh the same token, so the console refreshes only:
//
//   - inside the sign-in's own turn (userSettings.agentAuthTurn), so a save on My settings, a session's write-back and
//     the handing of the login to a starting session wait for it, or it for them;
//   - when none of the owner's Grok sessions is queued, starting, running or stopping. Such a session was given the
//     login, and refreshes and writes back by itself; once it stopped it has written back, and the console goes on from
//     what it wrote. A session that starts meanwhile is in the fleet before it asks for the login, so it is seen, and
//     its own read of the login waits for the turn (sessionApi.mjs, settingsReply).
//
// A refresh that xAI refuses (the token is revoked or was already used) is not tried again until a new login is saved:
// reusing a rotated token can have xAI end the whole family. One that did not reach xAI is tried again a minute later.
// Nothing here logs or returns a token, an email or a name from auth.json: only the login, a state, a status and
// xAI's own error code when it is a plain word.

import { ACTIVE_STATUSES } from './sessions.mjs';
import { loginEntryOf } from './grokModels.mjs';
import agents from '../shared/agents.cjs';

// A login ending within this is refreshed: a review runs for minutes, and each call of it asks again.
const MARGIN_MS = 10 * 60_000;
const RETRY_MS = 60_000;
// Discovery and the token call each, so a session's read of its login (15 s at its start) waits at most about 10 s.
const TIMEOUT_MS = 5_000;
// Errors that mean the token call never left this machine: the token is unspent, so it is safe to send again.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const MAX_BYTES = 256 * 1024;
const ISSUER_HOSTS = ['auth.x.ai'];

/**
 * How long a saved login lasts.
 * @param {string|null} saved
 * @returns {{kind: 'none'|'key'|'login', endsAt: number|null, refreshable: boolean, expired?: boolean}}  `endsAt` null: it
 *   says no end (or one that cannot be read, which `expired` marks)
 */
export function describeLogin(saved, now = Date.now()) {
  if (!saved) return { kind: 'none', endsAt: null, refreshable: false };
  if (!saved.startsWith('{')) return { kind: 'key', endsAt: null, refreshable: false };
  let auth;
  try {
    auth = JSON.parse(saved);
  } catch {
    return { kind: 'none', endsAt: null, refreshable: false };
  }
  const { entry } = loginEntryOf(auth);
  if (!entry) return { kind: 'none', endsAt: null, refreshable: false };
  if (entry.key.startsWith('xai-') && !entry.refresh_token) return { kind: 'key', endsAt: null, refreshable: false };
  const refreshable = typeof entry.refresh_token === 'string' && entry.refresh_token.length > 0;
  if (typeof entry.expires_at !== 'string') return { kind: 'login', endsAt: null, refreshable };
  const at = Date.parse(entry.expires_at);
  if (!Number.isFinite(at)) return { kind: 'login', endsAt: null, refreshable, expired: true };
  return { kind: 'login', endsAt: at, refreshable, expired: at <= now };
}

/**
 * @param {{userSettings: {agentAuth: Function, agentAuthTurn?: Function}|null,
 *          sessions?: () => {owner?: string|null, status: string, options?: {agent?: string}}[],
 *          fetch?: typeof fetch, now?: () => number, issuerHosts?: string[]}} deps
 *   `sessions` lists the fleet's sessions, to tell whether a Grok session of the owner's is running
 */
export function createGrokLogin({ userSettings = null, sessions = () => [], fetch: fetchImpl = globalThis.fetch, now = Date.now, issuerHosts = ISSUER_HOSTS } = {}) {
  const GROK = agents.agent('grok');
  // By login: the saved text that must not be sent again (a digest, so a new login is tried) with why, and when a try failed.
  const refused = new Map();
  const failedAt = new Map();
  const keyOf = (login) => String(login).toLowerCase();

  const turn = (login, fn) => userSettings.agentAuthTurn
    ? userSettings.agentAuthTurn(login, 'grok', fn)
    : fn({ read: () => userSettings.agentAuth(login, 'grok'), save: (value) => userSettings.setAgentAuth(login, 'grok', value) });

  function growing(login) {
    const mine = String(login).toLowerCase();
    return sessions().some((s) => s.owner && String(s.owner).toLowerCase() === mine && s.options?.agent === 'grok'
      && (ACTIVE_STATUSES.has(s.status) || s.status === 'stopping'));
  }

  /** The token endpoint of the entry's issuer, only on a host that is xAI's. */
  async function tokenEndpoint(issuer) {
    let url;
    try {
      url = new URL(issuer);
    } catch {
      throw new Error('the login names no issuer');
    }
    if (url.protocol !== 'https:' || !issuerHosts.includes(url.host)) throw new Error('the login names an issuer that is not xAI\'s');
    const base = url.origin;
    const found = await getJson(`${base}/.well-known/openid-configuration`);
    const endpoint = new URL(String(found.token_endpoint ?? ''));
    if (endpoint.protocol !== 'https:' || endpoint.host !== url.host) throw new Error('the issuer\'s token endpoint is not on its own host');
    return endpoint;
  }

  async function read(answer) {
    const length = Number(answer.headers?.get?.('content-length'));
    if (length > MAX_BYTES) throw new Error('the answer is too large');
    const text = await answer.text();
    if (text.length > MAX_BYTES) throw new Error('the answer is too large');
    return text;
  }

  async function getJson(url) {
    const answer = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!answer.ok) throw new Error(`discovery answered ${answer.status}`);
    return JSON.parse(await read(answer));
  }

  /**
   * One refresh_token grant. Throws `{terminal: true, code}` for an answer that says the token is no good, and any
   * other error for xAI not answering.
   * @returns {Promise<{key: string, refresh_token: string|null, expires_at: string}>}
   */
  async function exchange(scope, entry) {
    const [scopeIssuer, scopeClient] = String(scope).split('::');
    const issuer = typeof entry.oidc_issuer === 'string' && entry.oidc_issuer ? entry.oidc_issuer : scopeIssuer;
    const clientId = typeof entry.oidc_client_id === 'string' && entry.oidc_client_id ? entry.oidc_client_id : scopeClient;
    if (!clientId) throw new Error('the login names no client');
    const endpoint = await tokenEndpoint(issuer);
    let answer;
    try {
      answer = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: entry.refresh_token, client_id: clientId }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      // No answer to a call that may have been sent: xAI may have rotated the token, so the same one is never sent again.
      const code = err?.cause?.code ?? err?.code;
      throw Object.assign(new Error('no answer to the token call'), NOT_SENT.has(code) ? {} : { terminal: true, ambiguous: true });
    }
    let body = null;
    try {
      body = JSON.parse(await read(answer));
    } catch {
      body = null;
    }
    if (!answer.ok) {
      // 4xx other than a rate limit: the token is refused. xAI's own error code is logged when it is a plain word.
      const code = typeof body?.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : null;
      if (answer.status >= 400 && answer.status < 500 && answer.status !== 429 && answer.status !== 408) throw Object.assign(new Error('refused'), { terminal: true, status: answer.status, code });
      throw Object.assign(new Error(`xAI answered ${answer.status}`), { status: answer.status });
    }
    const seconds = Number(body?.expires_in);
    // A success xAI sent that holds no readable token (the body was cut off, or timed out): it has rotated the token, so
    // the same one is never sent again.
    if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(seconds) || seconds <= 0) {
      throw Object.assign(new Error('the answer holds no access token'), { terminal: true, ambiguous: true });
    }
    return {
      key: body.access_token,
      // Rotated; one that is not sent back leaves the old, which is all there is.
      refresh_token: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : entry.refresh_token,
      expires_at: new Date(now() + seconds * 1000).toISOString(),
    };
  }

  /**
   * The person's saved Grok sign-in, refreshed first when it is a login that has ended or is about to, can be, and no
   * Grok session of theirs holds it.
   * @param {string} login
   * @returns {Promise<{saved: string|null, state: 'none'|'key'|'ok'|'refreshed'|'expired', why: string|null}>}
   *   `expired`: the saved login has ended and was not refreshed, `why` saying why in the review's words ("the author's
   *   saved Grok Build login has expired, …")
   */
  async function fresh(login) {
    const product = GROK.product;
    return turn(login, async ({ read: readSaved, save }) => {
      const saved = await readSaved();
      const now0 = now();
      const info = describeLogin(saved, now0);
      if (info.kind !== 'login') return { saved, state: info.kind, why: null };
      const ending = info.endsAt === null ? Boolean(info.expired) : info.endsAt <= now0 + MARGIN_MS;
      if (!ending) return { saved, state: 'ok', why: null };
      const gone = info.expired === true;
      const stay = (why) => ({ saved, state: gone ? 'expired' : 'ok', why: gone ? `the author's saved ${product} login has expired, ${why}` : null });
      if (!info.refreshable) return stay('and it holds no refresh token: save a new one');
      const digest = agents.signInDigest(saved);
      if (refused.get(keyOf(login))?.digest === digest) return stay(refused.get(keyOf(login)).why);
      if (growing(login)) return stay("and a Grok session of the author's is running: it refreshes the login when it stops");
      if (now0 - (failedAt.get(keyOf(login)) ?? 0) < RETRY_MS) return stay('and the console could not refresh it just now');
      const { scope, entry } = loginEntryOf(JSON.parse(saved));
      let renewed;
      try {
        renewed = await exchange(scope, entry);
      } catch (err) {
        if (err.terminal) {
          const why = err.ambiguous ? 'and the console cannot tell whether xAI took its refresh: save a new one' : 'and xAI refused to refresh it: save a new one';
          refused.set(keyOf(login), { digest, why });
          console.warn('grokLogin: xAI refused the refresh, the login is not tried again until a new one is saved', { login, status: err.status, code: err.code, ambiguous: Boolean(err.ambiguous) });
          return stay(why);
        }
        failedAt.set(keyOf(login), now0);
        console.warn('grokLogin: refresh not completed', { login, message: err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err).split('\n')[0].slice(0, 120) });
        return stay('and the console could not refresh it just now');
      }
      const next = JSON.stringify({ ...JSON.parse(saved), [scope]: { ...entry, ...renewed } });
      // The old refresh token is dead now, so a save that fails is tried once more before the login is given up.
      try {
        try {
          await save(next);
        } catch (err) {
          if (err.shown) throw err;
          await save(next);
        }
      } catch (err) {
        console.error('grokLogin: the refreshed login could not be saved, the saved one is out of date', { login, message: err?.shown ? err.message : 'the store refused' });
        // xAI has rotated the token, so the one still saved is spent: never sent again until a different login is saved.
        const why = 'and the console could not save its refresh, which used up the saved login: save a new one';
        refused.set(keyOf(login), { digest, why });
        return stay(why);
      }
      failedAt.delete(keyOf(login));
      console.log('grokLogin: login refreshed', { login, expiresAt: renewed.expires_at });
      return { saved: next, state: 'refreshed', why: null };
    });
  }

  // What the page last heard of each login, so My settings' poll does not read the secret store on every call.
  const seen = new Map();
  const STATUS_MS = 30_000;

  /**
   * For My settings' row: how the saved login stands, from a read at most every 30 s (which refreshes it when it can).
   * @returns {Promise<{state: string, endsAt: number|null, why: string|null}>}
   */
  async function status(login) {
    const key = String(login).toLowerCase();
    const known = seen.get(key);
    if (known && now() - known.at < STATUS_MS) return known.value;
    const result = await fresh(login);
    const value = { state: result.state, endsAt: describeLogin(result.saved, now()).endsAt, why: result.why };
    seen.set(key, { at: now(), value });
    return value;
  }

  return {
    fresh, status,
    /** What `status` last said of this login, if it did lately: for a view that cannot wait. */
    cached: (login) => { const k = seen.get(String(login).toLowerCase()); return k && now() - k.at < 5 * 60_000 ? k.value : null; },
    // A new login was saved, or removed: what was known of the old one no longer holds.
    forget: (login) => { refused.delete(keyOf(login)); failedAt.delete(keyOf(login)); seen.delete(String(login).toLowerCase()); },
  };
}
