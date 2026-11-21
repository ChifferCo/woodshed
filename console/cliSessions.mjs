// The woodshed command line's token (wsc_, cliSignIn.mjs) on the console's own session routes: the few `woodshed
// session` calls, as exactly the person the token was approved for. Every other route refuses it, so a token that leaks
// from a laptop reaches no settings, secrets, people, terminals or apps.
//
//   GET  /api/sessions                      woodshed session list, and the wait on a start: what that person sees
//   GET  /api/my/projects                   the repos that person may start on, for --repo
//   POST /api/my/sessions                   woodshed session new: a private session of theirs
//   POST /api/my/sessions/<id>/resume       woodshed session resume: one of their private sessions
//   POST /api/my/sessions/<id>/remove       woodshed session remove: one of their private sessions
//   POST /api/sessions/<id>/stop            woodshed session stop: a session they may stop on the console's page
//   POST /api/sessions/<id>/extend          woodshed session extend: its pause or stop an hour later, in its last minutes
//   POST /api/sessions/<id>/limits          woodshed session limits: its own pause and stop. These two are a private
//                                           session's owner's and a shared one's assignee's alone, as on the page
//
// A terminal connected to a session never keeps it awake: more time is asked for, by the person or their agent, with
// extend or limits, and otherwise the session pauses and stops as its limits say.
//
// Each answers as it does the console's page, by the same code: a token is a sign-in, never more than the person's own.
// It is held to what a browser's sign-in is (auth.mjs): its person must still be on People (cliSignIn.mjs's `allowed`)
// and still have write access on GitHub, asked at the token's first use and then every hour, as a browser's is. When
// GitHub says no, every command line sign-in of theirs ends, as the browser's session does.
// The page's writes need `x-woodshed: 1` and the console's own Origin, which keep another site's form or script from
// riding the browser's cookie. A token is sent by the command line alone, never by a browser on its own, so neither is
// asked of it; a call that carries an Origin is a page's, and is refused.

const RECHECK_MS = 3_600_000;
// GitHub not answering lets the call through, as auth.mjs does, and is asked again after this.
const RETRY_MS = 5 * 60_000;

const ROUTES = [
  ['GET', /^\/api\/sessions$/],
  ['GET', /^\/api\/my\/projects$/],
  ['POST', /^\/api\/my\/sessions$/],
  ['POST', /^\/api\/my\/sessions\/[0-9a-f]{8}\/(resume|remove)$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/(stop|extend|limits)$/],
];

/** @returns {boolean}  a route the command line's token may call */
export function cliMayCall(method, pathname) {
  return ROUTES.some(([m, re]) => m === method && re.test(pathname));
}

/** @returns {boolean}  the request signs in with a command line token, rather than a cookie */
export function carriesCliToken(headers) {
  return /^Bearer wsc_/.test(String(headers?.authorization ?? ''));
}

/**
 * Whether a command line token's person still has write access, asked of GitHub at first and then hourly.
 * @param {{canWrite: ((login: string) => Promise<boolean>)|null, revokeAll: (login: string, by: string) => void,
 *          now?: () => number}} deps  `canWrite` null where sign-in does not ask GitHub (no sign-in, or a hosting proxy)
 * @returns {{allowed: (login: string|null) => Promise<boolean>}}
 */
export function createCliAccess({ canWrite, revokeAll, now = Date.now }) {
  const checkedAt = new Map();
  const retryAfter = new Map();
  const checking = new Map();

  async function check(login) {
    let still;
    try {
      still = await canWrite(login);
    } catch (err) {
      retryAfter.set(login, now() + RETRY_MS);
      console.warn('cliSessions: write access not rechecked', { login, retryInMs: RETRY_MS, message: String(err?.message ?? err).split('\n')[0] });
      return true;
    }
    retryAfter.delete(login);
    if (!still) {
      checkedAt.delete(login);
      console.log('cliSessions: refused, write access gone', { login });
      revokeAll(login, 'write access gone');
      return false;
    }
    checkedAt.set(login, now());
    return true;
  }

  async function allowed(login) {
    if (!canWrite || !login) return true;
    if (now() - (checkedAt.get(login) ?? -Infinity) < RECHECK_MS) return true;
    if (now() < (retryAfter.get(login) ?? 0)) return true;
    // A start's wait asks every few seconds: those share one check rather than one call to GitHub each.
    if (!checking.has(login)) checking.set(login, check(login).finally(() => checking.delete(login)));
    return checking.get(login);
  }

  return { allowed };
}

/**
 * A call with a command line token, on any route but /api/cli/*.
 * @param {{req, res, url: URL, cli: ReturnType<typeof import('./cliSignIn.mjs').createCliSignIn>|null,
 *          reply: (res, status: number, body: object) => void,
 *          read: (res, pathname: string, login: string|null) => unknown,
 *          write: (req, res, pathname: string, login: string|null) => unknown,
 *          access?: ReturnType<typeof createCliAccess>|null}} args
 *   `read` and `write` answer the route as the console's page would, past its sign-in and its browser checks
 */
export async function handleCliCall({ req, res, url, cli, reply, read, write, access = null }) {
  const { pathname } = url;
  if (!cli) return reply(res, 404, { error: 'this console has no command line sign-in' });
  if (req.headers.origin) {
    console.warn('cliSessions: refused, a browser\'s call', { path: pathname, origin: String(req.headers.origin).slice(0, 100) });
    return reply(res, 403, { error: 'a command line token is for the woodshed command line, not a page' });
  }
  if (!cliMayCall(req.method, pathname)) {
    console.warn('cliSessions: refused, not a route the command line may call', { method: req.method, path: pathname.slice(0, 100) });
    return reply(res, 403, { error: 'the command line\'s sign-in does not reach this: use the console' });
  }
  const signedIn = cli.tokenFor(req.headers);
  if (!signedIn) return reply(res, 401, { error: 'not signed in, or the sign-in ended: run woodshed login' });
  const { id, login } = signedIn;
  if (access && !(await access.allowed(login))) return reply(res, 401, { error: 'you no longer have write access to the repository: your command line sign-in ended' });
  if (req.method === 'GET') return read(res, pathname, login);
  // Writes only: the start's wait reads the list every few seconds.
  console.log('cliSessions: call', { login, token: id, path: pathname });
  return write(req, res, pathname, login);
}
