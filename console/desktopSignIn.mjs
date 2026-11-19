// The desktop app's sign-in through the person's own browser (desktop/signIn.mjs is the app's side, auth.mjs keeps the
// codes). Open to anyone who reaches the console, like the rest of sign-in:
//
//   GET  /auth/desktop/ready    ->  whether this console hands sign-ins to the app, and the paths its pages sign in
//                                   at, which the app sends to the browser; an app that gets anything else (an older
//                                   console, or a hosting proxy that answers none of these) signs in inside its window
//   GET  /auth/desktop?challenge=&next=
//                               ->  signed out: GitHub sign-in in this browser, which comes back here
//                                   signed in: a page that asks whether to sign the app in, as whom
//   POST /auth/desktop          ->  (that page's button, same origin) a page that opens
//                                   woodshed://signed-in?code=&challenge=&next=
//   POST /auth/desktop/claim    ->  {code, verifier} for the app's own session cookie
//
// The button is what keeps another program on the machine from signing itself in: anything can open a browser at
// /auth/desktop with a challenge of its own, and register woodshed:// to catch the link, so the code is made only
// when the person presses Sign in on a page that says it is for the Woodshed app, and only from the console's own page.
//
// A program that signs people in itself (a hosting proxy, the multi-tenant console) answers the same routes with this
// handler: its own `auth` (visitorFor, desktopCode and claimDesktopCode, with auth.mjs's createDesktopCodes),
// `signInUrl` and `signInPaths` (console/README.md, "Embedding the console").
import { DESKTOP_CHALLENGE_RE, safeNext } from './auth.mjs';
import { isSameOrigin } from '../shared/sameOrigin.mjs';

const MAX_CLAIM_BYTES = 4096;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** @returns {string}  the woodshed:// address that hands the code to the app */
// The challenge goes back with the code, so the app claims only the link of the sign-in it is waiting on: a link from an
// older tab, or from another console, leaves that sign-in as it is. It is no secret: the app sent it in the open.
export function desktopLink({ code, challenge, next }) {
  const link = new URL('woodshed://signed-in');
  link.searchParams.set('code', code);
  link.searchParams.set('challenge', challenge);
  link.searchParams.set('next', safeNext(next));
  return link.href;
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; --ink: #1b2232; --sub: #666666; --ground: #ffffff; --stopped: #f6f5f2; --line: #e2e2e2; --action: #b45a05; --action-ink: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e8ecf5; --sub: #a3aabb; --ground: #12151c; --stopped: #10131a; --line: #2a3142; --action: #f59433; --action-ink: #1b1204; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; background: var(--stopped); color: var(--ink); font: 15px/1.5 "Red Hat Display", system-ui, sans-serif; }
  main { width: min(440px, 100%); background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 32px; box-sizing: border-box; }
  h1 { font: 700 22px/1.3 Merriweather, Georgia, serif; margin: 0 0 8px; }
  p { color: var(--sub); margin: 0 0 20px; }
  .btn { display: inline-block; padding: 10px 16px; border-radius: 6px; border: 0; background: var(--action); color: var(--action-ink); font: 600 15px "Red Hat Display", system-ui, sans-serif; text-decoration: none; cursor: pointer; }
  .quiet { display: inline-block; margin-left: 12px; color: var(--sub); }
  form { margin: 0; }`;

// Never in a frame: a page of another site could otherwise lay it under a click of its own.
const PAGE_HEADERS = {
  // same-origin, not no-referrer: with no-referrer Chrome sends the consent form's POST with `Origin: null`, which the
  // origin check refuses. Other sites, and the woodshed:// link, still get no referrer.
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

// The question before the code: who is signing in, to what, and that it is only for a sign-in the person started.
function consentPage({ login, challenge, next, consoleName }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(consoleName)}: sign in to the app</title>
<style>${PAGE_STYLE}</style></head>
<body><main>
  <h1>Sign in to the Woodshed app?</h1>
  <p>The Woodshed app on this computer asks to sign in to ${escapeHtml(consoleName)} as <strong>@${escapeHtml(login)}</strong>. Sign in only if you just pressed Sign in with GitHub in the app.</p>
  <form method="post" action="/auth/desktop">
    <input type="hidden" name="login" value="${escapeHtml(login)}">
    <input type="hidden" name="challenge" value="${escapeHtml(challenge)}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button class="btn" type="submit">Sign in to the app</button><a class="quiet" href="/">Cancel</a>
  </form>
</main></body></html>`;
}

// The browser's last page: it opens the app, and says what to do when the browser asked first and was told no.
function handOffPage({ link, consoleName }) {
  const href = escapeHtml(link);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${href}">
<title>${escapeHtml(consoleName)}: back to the app</title>
<style>${PAGE_STYLE}</style></head>
<body><main>
  <h1>You're signed in</h1>
  <p>Your browser is handing the sign-in to the Woodshed app. If it asked whether to open Woodshed, say yes. You can close this tab after.</p>
  <a class="btn" href="${href}">Open the Woodshed app</a>
</main></body></html>`;
}

async function readBody(req, parse = (text) => JSON.parse(text || '{}')) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_CLAIM_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

/** The console's own sign-in: GitHub's, which comes back to `back`. */
export const consoleSignInUrl = (back) => `/auth/start?next=${encodeURIComponent(back)}`;
export const CONSOLE_SIGN_IN_PATHS = Object.freeze(['/auth/start']);

/**
 * @param {{req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL,
 *          auth: {available(): boolean, enabled(): boolean,
 *                 visitorFor(cookieHeader: string|undefined, req: object): Promise<{login: string}|null>,
 *                 desktopCode(args: {cookieHeader: string|undefined, req: object, challenge: string}): Promise<string|null>,
 *                 claimDesktopCode(args: {code: string, verifier: string}): ({login: string, setCookie: string}|null|Promise<{login: string, setCookie: string}|null>)},
 *          consoleName?: string, signInUrl?: (back: string) => string, signInPaths?: readonly string[]}} args
 *   `auth` is auth.mjs's createAuth() on a console; `signInUrl` where a signed-out browser signs in, coming back to
 *   `back`; `signInPaths` the paths the console's pages go to to sign in, which the app sends to the browser instead
 * @returns {Promise<boolean>}  whether it answered: true for its own paths
 */
export async function handleDesktopSignIn({
  req, res, url, auth, consoleName = 'Woodshed', signInUrl = consoleSignInUrl, signInPaths = CONSOLE_SIGN_IN_PATHS,
}) {
  const { pathname } = url;
  if (pathname === '/auth/desktop/ready' && req.method === 'GET') {
    json(res, 200, { desktop: true, available: auth.available(), required: auth.enabled(), signInPaths });
    return true;
  }
  if (pathname === '/auth/desktop' && req.method === 'GET') {
    const challenge = url.searchParams.get('challenge') ?? '';
    const next = safeNext(url.searchParams.get('next'));
    if (!DESKTOP_CHALLENGE_RE.test(challenge)) {
      json(res, 400, { error: 'open this from the Woodshed app' });
      return true;
    }
    const user = await auth.visitorFor(req.headers.cookie, req);
    if (!user) {
      // Signed out in this browser: the console's sign-in, which brings the browser back here, challenge and all.
      const back = `/auth/desktop?${new URLSearchParams({ challenge, next })}`;
      res.writeHead(302, { location: signInUrl(back), 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(200, PAGE_HEADERS);
    res.end(consentPage({ login: user.login, challenge, next, consoleName }));
    return true;
  }
  if (pathname === '/auth/desktop' && req.method === 'POST') {
    // The consent page's own button: a browser always sends Origin with a form's POST, and another site's is refused.
    if (!req.headers.origin || !isSameOrigin(req.headers)) {
      json(res, 403, { error: 'sign the app in from the console\'s own page' });
      return true;
    }
    let form;
    try {
      form = await readBody(req, (text) => new URLSearchParams(text));
    } catch {
      json(res, 400, { error: 'the form was too large' });
      return true;
    }
    const challenge = form.get('challenge') ?? '';
    const next = safeNext(form.get('next'));
    if (!DESKTOP_CHALLENGE_RE.test(challenge)) {
      json(res, 400, { error: 'open this from the Woodshed app' });
      return true;
    }
    // The account the page named is the one the app gets: a page left open while this browser signed in as someone else
    // asks again, naming who it is now. Both reads take this request's cookie, so they cannot disagree.
    const now = await auth.visitorFor(req.headers.cookie, req);
    if (now && now.login !== form.get('login')) {
      console.warn('desktopSignIn: the consent page named another account, asked again', { shown: String(form.get('login') ?? '').slice(0, 40), now: now.login });
      res.writeHead(303, { location: `/auth/desktop?${new URLSearchParams({ challenge, next })}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    const code = now ? await auth.desktopCode({ cookieHeader: req.headers.cookie, req, challenge }) : null;
    if (!code) {
      res.writeHead(303, { location: `/auth/desktop?${new URLSearchParams({ challenge, next })}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(200, PAGE_HEADERS);
    res.end(handOffPage({ link: desktopLink({ code, challenge, next }), consoleName }));
    return true;
  }
  if (pathname === '/auth/desktop/claim' && req.method === 'POST') {
    // A browser page cannot send this header to another site without a preflight this console never answers.
    if (req.headers['x-woodshed'] !== '1') {
      json(res, 403, { error: 'claim from the Woodshed app' });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: 'send {code, verifier} as JSON' });
      return true;
    }
    const claimed = await auth.claimDesktopCode({ code: body?.code, verifier: body?.verifier });
    if (!claimed) {
      json(res, 401, { error: 'That sign-in has expired or was already used. Sign in again from the app.' });
      return true;
    }
    json(res, 200, { login: claimed.login }, { 'set-cookie': claimed.setCookie });
    return true;
  }
  return false;
}
