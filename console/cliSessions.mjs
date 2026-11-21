// The woodshed command line's token (wsc_, cliSignIn.mjs) on the console's own session routes: the few `woodshed
// session` calls and `woodshed config`'s, as exactly the person the token was approved for. Every other route refuses it,
// so a token that leaks from a laptop reaches no secrets, people, terminals or apps, and no settings but that person's own
// choices on My settings.
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
//   GET  /api/cli/config, and a few My settings writes   woodshed config: their choices, never a secret (cliConfig.mjs)
//
// A terminal connected to a session never keeps it awake: more time is asked for, by the person or their agent, with
// extend or limits, and otherwise the session pauses and stops as its limits say.
//
// Each answers as it does the console's page, by the same code: a token is a sign-in, never more than the person's own.
// It is held to what a browser's sign-in is (auth.mjs) by cliSignIn.mjs's `authenticate`, the one check every route a
// token reaches goes through: its person must still be on People and still have write access on GitHub.
// The page's writes need `x-woodshed: 1` and the console's own Origin, which keep another site's form or script from
// riding the browser's cookie. A token is sent by the command line alone, never by a browser on its own, so neither is
// asked of it; a call that carries an Origin is a page's, and is refused.

import { CONFIG_ROUTES } from './cliConfig.mjs';

const ROUTES = [
  ['GET', /^\/api\/sessions$/],
  ['GET', /^\/api\/my\/projects$/],
  ['POST', /^\/api\/my\/sessions$/],
  ['POST', /^\/api\/my\/sessions\/[0-9a-f]{8}\/(resume|remove)$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/(stop|extend|limits)$/],
  ...CONFIG_ROUTES,
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
 * A call with a command line token, on any route but /api/cli/*.
 * @param {{req, res, url: URL, cli: ReturnType<typeof import('./cliSignIn.mjs').createCliSignIn>|null,
 *          reply: (res, status: number, body: object) => void,
 *          read: (res, pathname: string, login: string|null) => unknown,
 *          write: (req, res, pathname: string, login: string|null) => unknown}} args
 *   `read` and `write` answer the route as the console's page would, past its sign-in and its browser checks
 */
export async function handleCliCall({ req, res, url, cli, reply, read, write }) {
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
  const { signedIn, error } = await cli.authenticate(req.headers);
  if (!signedIn) return reply(res, 401, { error });
  const { id, login } = signedIn;
  if (req.method === 'GET') return read(res, pathname, login);
  // Writes only: the start's wait reads the list every few seconds.
  console.log('cliSessions: call', { login, token: id, path: pathname });
  return write(req, res, pathname, login);
}
