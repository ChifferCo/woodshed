// The woodshed command line's token (wsc_, cliSignIn.mjs) on the review setup's person routes (reviewSetup.mjs):
// `woodshed review` asks for a repo's review to be turned on, and follows its request, as the person the token was
// approved for. Exactly these three, and no others of /api/review-setup:
//
//   GET  /api/review-setup         woodshed review list, and the wait after enable: the requests that person asked for
//   POST /api/review-setup         woodshed review enable: a request of theirs, which an admin of the repo approves on
//                                  its page, in a browser
//   GET  /api/review-setup/<id>    woodshed review status: one request, as the page shows it to that person
//
// Approving and refusing (`/approve`, `/refuse`) answer 403 to a token: an approval is made on the request's page, by
// someone signed in there who sees what it changes. Each route answers as it does the page, by the same code
// (createReviewSetupApi), with the token's person as `login`, and never as a console admin: a token reaches no more
// than an asker's own requests, and what the repo's GitHub says that person may read of them. A console admin reads
// everyone's on the page.
//
// The page's writes need `x-woodshed: 1` and the console's own Origin, which keep another site's form or script from
// riding the browser's cookie. A token is sent by the command line alone, never by a browser on its own, so neither is
// asked of it; a call that carries an Origin is a page's, and is refused. Something in a session asks with its
// SESSION_TOKEN on the session API's POST /review-setup instead: a session is never handed a wsc_ token.

import { reviewSetupRoute } from './reviewSetup.mjs';

const ROUTES = [
  ['GET', /^\/api\/review-setup$/],
  ['POST', /^\/api\/review-setup$/],
  ['GET', /^\/api\/review-setup\/[0-9a-f]{12}$/],
];

/** @returns {boolean}  a review setup route the command line's token may call */
export function cliMayCallReviewSetup(method, pathname) {
  return ROUTES.some(([m, re]) => m === method && re.test(pathname));
}

/** @returns {boolean}  a call to the review setup's routes that signs in with a command line token, not a cookie */
export function isCliReviewSetupCall(headers, pathname) {
  return /^Bearer wsc_/.test(String(headers?.authorization ?? '')) && Boolean(reviewSetupRoute(pathname));
}

/**
 * A call with a command line token on /api/review-setup (isCliReviewSetupCall).
 * @param {{req, res, url: URL, cli: ReturnType<typeof import('./cliSignIn.mjs').createCliSignIn>|null,
 *          api: ReturnType<typeof import('./reviewSetup.mjs').createReviewSetupApi>|null,
 *          reply: (res, status: number, body: object) => void,
 *          access?: {allowed: (login: string|null) => Promise<boolean>}|null}} args
 *   `api` is null on a console with no GitHub App of its own; `access`, where given, is asked whether the token's person
 *   may still use the console beyond the People list (write access on GitHub)
 */
export async function handleCliReviewSetup({ req, res, url, cli, api, reply, access = null }) {
  const { pathname } = url;
  const refuse = (status, body) => {
    req.resume();
    return reply(res, status, body);
  };
  if (!cli) return refuse(404, { error: 'this console has no command line sign-in' });
  if (req.headers.origin) {
    console.warn('cliReviewSetup: refused, a browser\'s call', { path: pathname, origin: String(req.headers.origin).slice(0, 100) });
    return refuse(403, { error: 'a command line token is for the woodshed command line, not a page' });
  }
  if (!cliMayCallReviewSetup(req.method, pathname)) {
    console.warn('cliReviewSetup: refused, not a route the command line may call', { method: req.method, path: pathname.slice(0, 100) });
    return refuse(403, { error: 'a request is approved or refused on its page in the console, not from the command line' });
  }
  const signedIn = cli.tokenFor(req.headers);
  if (!signedIn) return refuse(401, { error: 'not signed in, or the sign-in ended: run woodshed login' });
  const { id, login } = signedIn;
  if (access && !(await access.allowed(login))) return refuse(401, { error: 'you no longer have write access to the repository: your command line sign-in ended' });
  if (!api) return refuse(404, { error: 'this console has no GitHub App of its own to turn on a repo\'s review with' });
  // Writes only: the wait after enable reads the list every few seconds.
  if (req.method === 'POST') console.log('cliReviewSetup: call', { login, token: id, path: pathname });
  return api(req, res, { route: reviewSetupRoute(pathname), login, admin: false });
}
