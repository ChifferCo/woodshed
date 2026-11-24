// The woodshed command line's token (wsc_, cliSignIn.mjs) on the allowed session, config, and review routes acts as
// the person who approved the token. The separate /api/cli/settings routes
// (cliSettings.mjs) allow `woodshed settings` to reach that person's shared Claude settings and own files for their repos.
//
//   GET  /api/sessions                      woodshed session list, and the wait on a start: what that person sees
//   GET  /api/my/projects                   the repos that person may start on, for --repo
//   GET  /api/my/pulls                      woodshed session list and review pulls: their open pull requests
//   POST /api/my/pulls/<number>/review      woodshed review start: the console's review of their own open pull
//                                           request, on a project they may start on (write access asked of GitHub),
//                                           refused where the repo's review does not run in a session
//   POST /api/my/sessions                   woodshed session new: a private session of theirs
//   POST /api/my/sessions/<id>/resume       woodshed session resume: one of their private sessions
//   POST /api/my/sessions/<id>/remove       woodshed session remove: one of their private sessions
//   POST /api/sessions/<id>/stop            woodshed session stop: a session they may stop on the console's page
//   POST /api/sessions/<id>/extend          woodshed session extend: its pause or stop an hour later, in its last minutes
//   POST /api/sessions/<id>/limits          woodshed session limits: its own pause and stop. These two are a private
//                                           session's owner's and a shared one's assignee's alone, as on the page
//   POST /api/sessions/<id>/app/start|stop  woodshed session app: Start app and Stop app, for whoever may on the page.
//                                           Not Set up app, which types into the session's agent
//   GET  /api/sessions/<id>/app-share       woodshed session app <id> share: who besides its owner may open a My Woodshed
//   POST /api/sessions/<id>/app-share/members, /links, /links/<link>/revoke   session's app, and its links, changed
//                                           as the page's Share the app does: the owner's alone, a private session's
//                                           alone, and never shared once it has seen production data (server.mjs,
//                                           appShareAction, the page's own check)
//   GET  /api/sessions/<id>/agents          woodshed session agents: the agents beside a private session's own
//   POST /api/sessions/<id>/agents          woodshed session agent: another started in it, as the page's + Another agent
//   POST /api/sessions/<id>/agents/<agent-N>/stop   woodshed session agent <id> stop: one of them ended. The owner's
//                                           alone, as on the page (server.mjs, agentAction)
//   GET  /api/review-readiness?repo=        woodshed review enable and status: whether a repo of theirs can be
//                                           reviewed in a session, and what is missing (reviewReadiness.mjs)
//   GET  /api/cli/config, and a few My settings writes   woodshed config: their choices, never a secret (cliConfig.mjs)
//
// A review's calls, /reviews/claude-<id>/..., take the token too, for `woodshed review <id>`, through the review proxy's
// own gate (reviewProxy.mjs forCli): owner only, never a session that has seen production data.
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
  ['GET', /^\/api\/my\/pulls$/],
  ['POST', /^\/api\/my\/pulls\/[1-9][0-9]{0,8}\/review$/],
  ['POST', /^\/api\/my\/sessions$/],
  ['POST', /^\/api\/my\/sessions\/[0-9a-f]{8}\/(resume|remove)$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/(stop|extend|limits)$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/app\/(start|stop)$/],
  ['GET', /^\/api\/sessions\/[0-9a-f]{8}\/app-share$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/app-share\/(members|links|links\/[0-9a-f]{8}\/revoke)$/],
  ['GET', /^\/api\/sessions\/[0-9a-f]{8}\/agents$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/agents$/],
  ['POST', /^\/api\/sessions\/[0-9a-f]{8}\/agents\/agent-[2-9]\/stop$/],
  ['GET', /^\/api\/review-readiness$/],
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
 * A call on a session, config, or review route with a command line token.
 * @param {{req, res, url: URL, cli: ReturnType<typeof import('./cliSignIn.mjs').createCliSignIn>|null,
 *          reply: (res, status: number, body: object) => void,
 *          read: (req, res, url: URL, login: string|null) => unknown,
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
  if (req.method === 'GET') return read(req, res, url, login);
  // Writes only: the start's wait reads the list every few seconds.
  console.log('cliSessions: call', { login, token: id, path: pathname });
  return write(req, res, pathname, login);
}
