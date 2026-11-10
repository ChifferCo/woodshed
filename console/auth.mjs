// Sign-in with GitHub, through the GitHub App's own user authorization:
//
//   GET /auth/start?next=/path  ->  github.com/login/oauth/authorize, with a one-time state
//   GET /auth/callback          ->  code -> user token -> login -> write access? -> session cookie
//
// Anyone with write access to the repo who is on the console's list (members.mjs) may sign in, write access checked with the same collaborator call the
// console makes for a /woodshed comment, unless the handle was first seen here on another GitHub account (githubPeople.mjs). The user token is used once, to learn the login, and dropped,
// unless the sign-in was Connect GitHub on My settings (`connect`), which hands it to `onConnect` to keep.
// Sessions live in state.json under a hash of their id, so a console restart signs nobody out and the
// file never holds a usable cookie. Access is checked again every hour: leaving the repo signs you out.
//
// A session's app, on `<id>.<app domain>`, cannot read the console's cookie, so it gets its own:
//
//   GET /auth/app?id=&next=     (console, signed in)  ->  <id>.<app domain>/__woodshed/auth?code=&next=
//   GET /__woodshed/auth        (app name)            ->  a cookie for that one app, then `next`
//
// The code lives a minute and works once. An app's cookie leans on the console session that made it, so
// signing out of the console, or losing write access, ends it too.
//
// Saving the App's client secret only makes sign-in available. The console starts requiring it after the
// first sign-in that completes, so a wrong Callback URL in the App's settings can lock nobody out. A console
// the internet reaches passes `required` instead: sign-in is then required from the start and stays so.

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'woodshed_session';
export const CLIENT_SECRET = 'github-app-client-secret';
const STATE_COOKIE = 'woodshed_oauth_state';
const APP_COOKIE = 'woodshed_app';
const APP_CODE_MS = 60_000;
const SESSION_MS = 12 * 3_600_000;
const RECHECK_MS = 3_600_000;
const RETRY_MS = 5 * 60_000;
const STATE_MS = 10 * 60_000;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * @param {string|undefined} header  the request's Cookie header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    // Any cookie on this origin lands here, ours or not: a malformed one must not turn every request into a 500.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw;
    }
  }
  return out;
}

// Only a path on this console. Resolved the way a browser would, so another origin comes back as `/`.
// Resolving can still leave `//host` (from `/.//host`), which a Location header sends to that host,
// so the leading slashes collapse to one.
export function safeNext(next) {
  const base = 'http://console.invalid';
  try {
    const url = new URL(String(next || '/'), base);
    if (url.origin !== base) return '/';
    return `/${url.pathname.replace(/^[/\\]+/, '')}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

// A refusal is the person's to fix, so the login page shows its message. Any other error is the console's: GitHub
// not reached, gh missing, the App's client secret wrong. The page then says only CONSOLE_FAILED, and the log has why.
function refusal(message) {
  return Object.assign(new Error(message), { shown: true });
}

export const CONSOLE_FAILED = 'The console could not check your access with GitHub. Ask whoever runs it to look at its log.';

/**
 * @param {Error & {shown?: boolean}} err  what auth.callback threw
 * @returns {{fault: 'yours'|'console', message: string}}  whose problem it is, and what the login page says
 */
export function signInFailure(err) {
  if (err?.shown) return { fault: 'yours', message: err.message };
  return { fault: 'console', message: CONSOLE_FAILED };
}

/**
 * @param {{publicUrl: string, store: {state: object, save: () => void},
 *          clientId: () => Promise<string>, clientSecret: () => string|null,
 *          canWrite: (login: string) => Promise<boolean>, fetchImpl?: typeof fetch, now?: () => number,
 *          githubWeb?: string, githubApi?: string, required?: boolean,
 *          onConnect?: (args: {login: string, answer: object}) => Promise<void>,
 *          people?: {remember: (account: {login: string, id: number, name?: string|null}) => boolean},
 *          members?: {isMember: (login: string) => boolean, claimFirst: (login: string) => boolean}}} deps
 *   `clientSecret` returns null until it is set on the Secrets page, and sign-in is off until then, unless
 *   `required`, when nobody gets in until it is set.
 *   `githubWeb` and `githubApi` point at GitHub; tests and the local preview pass a fake
 *   `onConnect` keeps a Connect GitHub sign-in's tokens (githubUser.mjs)
 *   `people` keeps each handle's account id and display name, and refuses a handle now on another account
 *   `members` is who may sign in (members.mjs): a writer who is not one still gets a session, but only as a
 *   visitor, which opens nothing but the page that asks to join
 */
export function createAuth({
  publicUrl, store, clientId, clientSecret, canWrite, fetchImpl = fetch, now = Date.now,
  githubWeb = 'https://github.com', githubApi = 'https://api.github.com', required = false, onConnect = null, people = null, members = null, slackPeople = null,
}) {
  const secure = publicUrl.startsWith('https:');
  // Code in a session app, on a name under the console's, can set a cookie for the console's name too. Browsers
  // take a `__Host-` cookie only from that exact name, so an app cannot plant or shadow these. It needs Secure.
  const sessionCookie = secure ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
  const stateCookie = secure ? `__Host-${STATE_COOKIE}` : STATE_COOKIE;
  const appCookie = secure ? `__Host-${APP_COOKIE}` : APP_COOKIE;
  const redirectUri = `${publicUrl.replace(/\/+$/, '')}/auth/callback`;
  const pending = new Map();
  const rechecks = new Map();
  const retryAfter = new Map();
  const appCodes = new Map();

  function sessions() {
    store.state.authSessions ??= {};
    return store.state.authSessions;
  }

  function appSessions() {
    store.state.authAppSessions ??= {};
    return store.state.authAppSessions;
  }

  function cookie(name, value, maxAgeSeconds) {
    return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', secure && 'Secure', `Max-Age=${maxAgeSeconds}`]
      .filter(Boolean).join('; ');
  }

  function forget(expiredBefore) {
    for (const [key, s] of Object.entries(sessions())) if (s.expiresAt <= expiredBefore) delete sessions()[key];
    for (const [state, p] of pending) if (p.expiresAt <= expiredBefore) pending.delete(state);
    for (const [code, c] of appCodes) if (c.expiresAt <= expiredBefore) appCodes.delete(code);
    for (const [key, a] of Object.entries(appSessions())) if (!sessions()[a.key]) delete appSessions()[key];
  }

  /** @returns {boolean}  whether anyone can sign in: the App's client secret is set */
  function available() {
    return Boolean(clientSecret());
  }

  /** @returns {boolean}  whether the console requires sign-in: always when `required`, else available and proven */
  function enabled() {
    return required || (available() && Boolean(store.state.authArmed));
  }

  // A new client secret is unproven: the console stops requiring sign-in until a sign-in with it completes.
  function disarm() {
    if (required || !store.state.authArmed) return;
    store.state.authArmed = false;
    store.save();
    console.log('auth: sign-in no longer required until the next one completes');
  }

  /**
   * @param {string} next
   * @param {{connect?: boolean}} [opts]  `connect`: keep this sign-in's GitHub token, for Connect GitHub
   * @returns {Promise<{location: string, setCookie: string}>}
   */
  async function start(next, { connect = false } = {}) {
    forget(now());
    const state = crypto.randomBytes(24).toString('hex');
    pending.set(state, { next: safeNext(next), expiresAt: now() + STATE_MS, connect: connect && Boolean(onConnect) });
    const url = new URL(`${githubWeb}/login/oauth/authorize`);
    url.searchParams.set('client_id', await clientId());
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    // The state also sits in a cookie of this browser, so a callback someone else started cannot sign it in.
    return { location: url.href, setCookie: cookie(stateCookie, state, STATE_MS / 1000) };
  }

  async function loginFor(code) {
    const res = await fetchImpl(`${githubWeb}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: await clientId(), client_secret: clientSecret(), code, redirect_uri: redirectUri }),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok || !answer.access_token) {
      console.warn('auth: GitHub refused the sign-in code', { status: res.status, error: String(answer.error ?? '').slice(0, 60) });
      // An expired or used code is a stale link. Anything else (incorrect_client_credentials, redirect_uri_mismatch,
      // a 5xx) is how the console is set up, and signing in again would fail the same way.
      if (answer.error === 'bad_verification_code') throw refusal('That sign-in link has expired or was already used. Sign in again.');
      throw new Error(`GitHub refused the sign-in code (${String(answer.error || res.status).slice(0, 60)})`);
    }
    const user = await fetchImpl(`${githubApi}/user`, {
      headers: { authorization: `Bearer ${answer.access_token}`, accept: 'application/vnd.github+json' },
    });
    const body = await user.json().catch(() => ({}));
    if (!user.ok || !body.login) throw new Error(`GitHub did not say who signed in (${user.status})`);
    return { login: body.login, id: body.id, name: body.name, publicEmail: body.email, answer };
  }

  // The emails on the account: the verified ones when GitHub lets the token read them, else the public one. A
  // failure is not an error here: the person is just left unmatched on Slack.
  async function emailsOf({ token, publicEmail }) {
    let verified = [];
    try {
      const res = await fetchImpl(`${githubApi}/user/emails`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      const list = res.ok ? await res.json().catch(() => []) : [];
      verified = (Array.isArray(list) ? list : []).filter((e) => e?.verified && e.email)
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary))).map((e) => e.email);
    } catch (err) {
      console.warn('auth: emails not read for the Slack match', { message: String(err?.message ?? err).split('\n')[0] });
    }
    return [...new Set([...verified, publicEmail].filter(Boolean))];
  }

  /**
   * @param {{code: string, state: string, cookieHeader: string|undefined}} args
   * @returns {Promise<{login: string, next: string, setCookies: string[]}>}
   */
  async function callback({ code, state, cookieHeader }) {
    forget(now());
    const started = pending.get(state);
    pending.delete(state);
    if (!started || !code || parseCookies(cookieHeader)[stateCookie] !== state) {
      console.warn('auth: callback refused', { known: Boolean(started), code: Boolean(code) });
      throw refusal('That sign-in link has expired or was not started here. Sign in again.');
    }
    // A refusal from here on keeps where the person was going, for their next try.
    let login;
    let member;
    // Which call a failure came from, for the console's log line: `sign-in code`, `write access`, `connect` or `members`.
    let step = 'sign-in code';
    try {
      const signedIn = await loginFor(code);
      login = signedIn.login;
      step = 'write access';
      if (!(await canWrite(login))) {
        console.log('auth: sign-in refused, no write access', { login });
        throw refusal(`@${login} has no write access to the repository, so cannot sign in.`);
      }
      if (people && !people.remember({ login, id: signedIn.id, name: signedIn.name })) {
        console.warn('auth: sign-in refused, the handle was another account\'s', { login });
        throw refusal(`@${login} was another GitHub account's name when it was last used here, so it cannot sign in. Ask a teammate to clear the old account (Woodshed Cloud's CLAUDE.md, "Signing in fails").`);
      }
      step = 'connect';
      if (started.connect) await onConnect({ login, answer: signedIn.answer });
      step = 'members';
      member = !members || members.isMember(login) || members.claimFirst(login);
      // Only members are matched, so a stranger who signs in leaves nothing behind.
      // Never able to fail the sign-in: the user token is used only for this one read.
      if (slackPeople && member) {
        slackPeople.matchOnSignIn({ login, emails: () => emailsOf({ token: signedIn.answer.access_token, publicEmail: signedIn.publicEmail }) })
          .catch((err) => console.warn('auth: Slack match failed', { login, message: String(err?.message ?? err).split('\n')[0] }));
      }
    } catch (err) {
      throw Object.assign(err, { next: started.next, step });
    }
    const id = crypto.randomBytes(32).toString('hex');
    sessions()[hash(id)] = { login, createdAt: now(), checkedAt: now(), expiresAt: now() + SESSION_MS };
    const arming = !store.state.authArmed;
    store.state.authArmed = true;
    store.save();
    console.log('auth: signed in', { login, nowRequired: arming, member });
    return { login, next: started.next, setCookies: [cookie(sessionCookie, id, SESSION_MS / 1000), cookie(stateCookie, '', 0)] };
  }

  /** @returns {Promise<{login: string}|null>}  a member signed in on this browser */
  async function sessionFor(cookieHeader) {
    const id = parseCookies(cookieHeader)[sessionCookie];
    if (!id) return null;
    return sessionByKey(hash(id));
  }

  /** @returns {Promise<{login: string}|null>}  anyone signed in on this browser, a member or not, for the page that asks to join */
  async function visitorFor(cookieHeader) {
    const id = parseCookies(cookieHeader)[sessionCookie];
    if (!id) return null;
    return signedInByKey(hash(id));
  }

  // Taking someone off the list shuts them out at once: their session stays, but only as a visitor's.
  async function sessionByKey(key) {
    const user = await signedInByKey(key);
    return user && (!members || members.isMember(user.login)) ? user : null;
  }

  async function signedInByKey(key) {
    const s = sessions()[key];
    if (!s) return null;
    if (s.expiresAt <= now()) {
      delete sessions()[key];
      store.save();
      return null;
    }
    if (now() - s.checkedAt >= RECHECK_MS && now() >= (retryAfter.get(key) ?? 0)) {
      // A page load sends several requests at once: they share one check rather than one gh call each.
      if (!rechecks.has(key)) rechecks.set(key, recheck(key, s).finally(() => rechecks.delete(key)));
      return rechecks.get(key);
    }
    return { login: s.login };
  }

  async function recheck(key, s) {
    let still;
    try {
      still = await canWrite(s.login);
    } catch (err) {
      // GitHub being down should not sign the whole team out, nor be asked again on every request.
      retryAfter.set(key, now() + RETRY_MS);
      console.warn('auth: write access not rechecked', { login: s.login, retryInMs: RETRY_MS, message: String(err?.message ?? err).split('\n')[0] });
      return { login: s.login };
    }
    retryAfter.delete(key);
    if (!still) {
      console.log('auth: signed out, write access gone', { login: s.login });
      delete sessions()[key];
      store.save();
      return null;
    }
    s.checkedAt = now();
    store.save();
    return { login: s.login };
  }

  /** @returns {string}  the Set-Cookie header that clears the browser's session */
  function signOut(cookieHeader) {
    const id = parseCookies(cookieHeader)[sessionCookie];
    if (id && sessions()[hash(id)]) {
      console.log('auth: signed out', { login: sessions()[hash(id)].login });
      delete sessions()[hash(id)];
      store.save();
    }
    return cookie(sessionCookie, '', 0);
  }

  /** @returns {Promise<string|null>}  a one-time code that signs this browser in to one session's app */
  async function appCode({ cookieHeader, appId }) {
    const id = parseCookies(cookieHeader)[sessionCookie];
    const user = id ? await sessionByKey(hash(id)) : null;
    if (!user) return null;
    const code = crypto.randomBytes(24).toString('hex');
    appCodes.set(code, { key: hash(id), appId, expiresAt: now() + APP_CODE_MS });
    console.log('auth: app sign-in code issued', { login: user.login, appId });
    return code;
  }

  /** @returns {Promise<{login: string, setCookie: string}|null>}  null for a used, expired or other app's code */
  async function claimAppCode({ code, appId }) {
    const claimed = appCodes.get(code);
    appCodes.delete(code);
    forget(now());
    const user = claimed && claimed.expiresAt > now() && claimed.appId === appId ? await sessionByKey(claimed.key) : null;
    if (!user) {
      console.warn('auth: app sign-in code refused', { appId, known: Boolean(claimed), sameApp: claimed?.appId === appId });
      return null;
    }
    const id = crypto.randomBytes(32).toString('hex');
    const { expiresAt } = sessions()[claimed.key];
    appSessions()[hash(id)] = { key: claimed.key, appId, expiresAt };
    store.save();
    console.log('auth: app signed in', { login: user.login, appId });
    return { login: user.login, setCookie: cookie(appCookie, id, Math.max(1, Math.floor((expiresAt - now()) / 1000))) };
  }

  /** @returns {Promise<{login: string}|null>}  who this app cookie belongs to, for this app only */
  async function appSessionFor({ cookieHeader, appId }) {
    const id = parseCookies(cookieHeader)[appCookie];
    const a = id ? appSessions()[hash(id)] : null;
    if (!a || a.appId !== appId) return null;
    const user = await sessionByKey(a.key);
    if (user) return user;
    delete appSessions()[hash(id)];
    store.save();
    return null;
  }

  return {
    available, enabled, disarm, start, callback, sessionFor, visitorFor, signOut, redirectUri,
    appCode, claimAppCode, appSessionFor, appCookie,
  };
}
