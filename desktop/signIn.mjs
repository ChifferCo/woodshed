// The app's side of signing in through the person's own browser, where they are usually signed in to GitHub already
// (console/desktopSignIn.mjs is the console's). Kept free of Electron so `node --test` checks it.
//
// The app makes a verifier and sends only its SHA-256, the challenge, to the browser. The console hands the browser a
// one-time code on a woodshed:// link, which the OS gives the app; the app claims it with the verifier, which never
// left it. A code another program catches is no use without that verifier.
import crypto from 'node:crypto';

export const PROTOCOL = 'woodshed';
const PENDING_MS = 10 * 60_000;

/** @returns {{verifier: string, challenge: string}}  PKCE's S256 pair */
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** A console's own sign-in: its login page's Sign in with GitHub. */
export const CONSOLE_SIGN_IN_PATHS = Object.freeze(['/auth/start']);

/**
 * The paths a console's pages go to to sign in, from its `/auth/desktop/ready`: a console behind a program that signs
 * people in itself names that program's (the hosted console's `/account/sign-in`).
 * @returns {string[]}  paths on the console only; the console's own when it named none
 */
export function signInPathsFrom(ready) {
  const named = Array.isArray(ready?.signInPaths) ? ready.signInPaths : [];
  const paths = named.filter((p) => typeof p === 'string' && /^\/(?![/\\])[\w./-]{0,200}$/.test(p)).slice(0, 8);
  return paths.length ? paths : [...CONSOLE_SIGN_IN_PATHS];
}

/**
 * The console's sign-in step, and where to go after it: one of its sign-in paths, on its origin (`/auth/start?next=`,
 * the login page's button, on a console of its own). Not a console's own `/login`, where a signed-out page lands: that
 * page is the console's, and its button is the step.
 * @param {readonly string[]} [signInPaths]  signInPathsFrom()'s
 * @returns {{next: string}|null}  null for any other address
 */
export function signInStep(target, consoleUrl, signInPaths = CONSOLE_SIGN_IN_PATHS) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.origin !== new URL(consoleUrl).origin) return null;
  if (!signInPaths.includes(url.pathname)) return null;
  return { next: url.searchParams.get('next') || '/' };
}

/** @returns {string}  the console page the browser opens to sign the app in */
export function browserUrl(consoleUrl, { challenge, next }) {
  const url = new URL('auth/desktop', consoleUrl);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('next', next || '/');
  return url.href;
}

/**
 * @param {string} link  what the OS handed the app
 * @returns {{code: string, challenge: string, next: string}|null}  null for anything but woodshed://signed-in with a
 *   code and the challenge of the sign-in it answers
 */
export function parseSignedInLink(link) {
  let url;
  try {
    url = new URL(String(link));
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== 'signed-in') return null;
  const code = url.searchParams.get('code');
  if (!code || !/^[0-9a-f]{16,128}$/.test(code)) return null;
  const challenge = url.searchParams.get('challenge');
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  const next = url.searchParams.get('next') || '/';
  // Only a path on the console: never another site, nor `//host`.
  return { code, challenge, next: /^\/(?![/\\])/.test(next) ? next : '/' };
}

/**
 * The one sign-in the app is waiting on. A link that arrives with none, or after ten minutes, is ignored: the app
 * started no sign-in, so it holds no verifier for it.
 */
export function createPending({ now = Date.now } = {}) {
  let current = null;
  return {
    /** `consoleUrl`: the console the sign-in is for, whose code alone it claims */
    begin(next, consoleUrl = null) {
      const pair = pkcePair();
      current = { ...pair, next, consoleUrl, startedAt: now() };
      return current;
    },
    /**
     * The sign-in waiting on `consoleUrl` that made `challenge`, forgotten as it is handed over (a sign-in is claimed
     * once). Anything else, a stale tab's link or another console's, is left waiting.
     * @returns {object|null}
     */
    takeFor(consoleUrl, challenge) {
      const match = current && now() - current.startedAt < PENDING_MS && current.consoleUrl === consoleUrl && current.challenge === challenge;
      if (!match) return null;
      const taken = current;
      current = null;
      return taken;
    },
    /** @returns {{verifier: string, next: string}|null}  and forgets it: a sign-in is claimed once */
    take() {
      const taken = current && now() - current.startedAt < PENDING_MS ? current : null;
      current = null;
      return taken;
    },
    /** @returns {object|null}  the sign-in still waiting on `consoleUrl`, kept: Open the browser again reuses it */
    current(consoleUrl) {
      return current && now() - current.startedAt < PENDING_MS && current.consoleUrl === consoleUrl ? current : null;
    },
    waiting() {
      return Boolean(current && now() - current.startedAt < PENDING_MS);
    },
  };
}

/** @returns {string|null}  the woodshed:// link among a process's arguments (Windows and Linux hand it over this way) */
export function linkInArgs(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`)) ?? null;
}

/**
 * A claim's Set-Cookie header as Electron's `session.cookies.set` takes it. The app claims with credentials left out,
 * so nothing is stored by the answer itself, and stores the session only while the claim is still the sign-in the
 * person is on: a late claim never replaces a newer one's account.
 * @param {string} header  one Set-Cookie header
 * @param {string} url  the address the claim went to
 * @param {() => number} [now]
 * @returns {object|null}  `cookies.set` details, or null for a header with no name
 */
export function parseSetCookie(header, url, now = Date.now) {
  const [pair, ...attributes] = String(header).split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const details = { url, name: pair.slice(0, eq), value: pair.slice(eq + 1), path: '/' };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'path' && value.startsWith('/')) details.path = value;
    else if (key === 'httponly') details.httpOnly = true;
    else if (key === 'secure') details.secure = true;
    else if (key === 'samesite' && /^(lax|strict|none)$/i.test(value)) details.sameSite = value.toLowerCase() === 'none' ? 'no_restriction' : value.toLowerCase();
    else if (key === 'max-age' && /^-?\d+$/.test(value)) details.expirationDate = Math.floor(now() / 1000) + Number(value);
    else if (key === 'expires' && !('expirationDate' in details) && !Number.isNaN(Date.parse(value))) details.expirationDate = Math.floor(Date.parse(value) / 1000);
  }
  return details;
}
