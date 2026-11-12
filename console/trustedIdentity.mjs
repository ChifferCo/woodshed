// Sign-in from a trusted proxy (README.md, "Hosted mode"). Whatever hosts the console signs people in itself and
// puts a fresh, short-lived identity on every request it forwards, page loads, API calls and websocket upgrades alike,
// on the console's name and on the session apps' names:
//
//   X-Woodshed-Identity: <payload>.<sig>
//     payload  base64url(JSON {"login": "<github login, lowercase>", "role": "owner"|"member", "exp": <ms since epoch>})
//     sig      base64url(HMAC-SHA256(secret, payload))
//
// With WOODSHED_TRUSTED_IDENTITY_SECRET set, that header is the only sign-in, and it is required. The host says
// who is in, so neither the People list nor write access to the repo is asked about these people; `owner` is an admin
// (Secrets & webhooks, Webhook events, Console settings), `member` is not. Nothing the console proxies to a session ever
// gets the header (appProxy.mjs, editorProxy.mjs and terminalProxy.mjs drop it): within its minute it would let the
// session's own code act on the console as whoever opened it.

import crypto from 'node:crypto';

export const IDENTITY_HEADER = 'x-woodshed-identity';
export const ROLES = Object.freeze(['owner', 'member']);
// GitHub's own rule for a handle, lowercase: the host sends it lowercased, so one person is spelled one way.
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
// The host sends one good for 60 seconds; a payload far bigger than that JSON is not one.
const MAX_HEADER_CHARS = 1024;
// The host sends one good for 60 seconds. One that claims far longer was not made per request, and a copy of it that
// leaked would sign someone in for as long as it says: refused, with room left for the two clocks to differ.
const MAX_LIFETIME_MS = 5 * 60_000;
// The refusals that say something is wrong, logged at most this often for each reason.
const LOG_EVERY_MS = 60_000;

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function sameSig(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * What the host's proxy sends; here for the tests and the dev console's stand-in host.
 * @param {{secret: string, login: string, role: 'owner'|'member', exp: number}} args
 * @returns {string}
 */
export function signIdentity({ secret, login, role, exp }) {
  const payload = Buffer.from(JSON.stringify({ login, role, exp })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * @param {{value: string|string[]|undefined, secret: string, now: number}} args
 * @returns {{login: string, role: 'owner'|'member'}|{refused: 'missing'|'malformed'|'forged'|'expired'|'too long'|'bad identity'}}
 */
export function verifyIdentity({ value, secret, now }) {
  if (value === undefined || value === '') return { refused: 'missing' };
  // Two of the header can only be a proxy passing on one it was sent: neither is the proxy's own.
  if (typeof value !== 'string' || value.length > MAX_HEADER_CHARS) return { refused: 'malformed' };
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return { refused: 'malformed' };
  const payload = value.slice(0, dot);
  if (!sameSig(value.slice(dot + 1), sign(secret, payload))) return { refused: 'forged' };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { refused: 'malformed' };
  }
  if (typeof claims?.login !== 'string' || !LOGIN_RE.test(claims.login) || !ROLES.includes(claims.role)) return { refused: 'bad identity' };
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return { refused: 'expired' };
  if (claims.exp - now > MAX_LIFETIME_MS) return { refused: 'too long' };
  return { login: claims.login, role: claims.role };
}

/**
 * @param {{secret: string, now?: () => number}} opts
 * @returns {{userFor: (headers: import('node:http').IncomingHttpHeaders) => {login: string, role: 'owner'|'member'}|null}}
 *   `userFor` is who the request's header names, or null for none or one that does not check out
 */
export function createTrustedIdentity({ secret, now = Date.now }) {
  const lastLogged = new Map();

  function userFor(headers) {
    const checked = verifyIdentity({ value: headers?.[IDENTITY_HEADER], secret, now: now() });
    if (!checked.refused) return checked;
    // A missing header is any request that did not come through the proxy: the health check, a probe. Not news.
    if (checked.refused !== 'missing' && now() - (lastLogged.get(checked.refused) ?? -Infinity) >= LOG_EVERY_MS) {
      lastLogged.set(checked.refused, now());
      console.warn('trustedIdentity: identity refused', { why: checked.refused });
    }
    return null;
  }

  return { userFor };
}
