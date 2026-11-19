// The desktop app's sign-in through the person's own browser (desktop/signIn.mjs is the app's side, auth.mjs keeps the
// codes). Open to anyone who reaches the console, like the rest of sign-in:
//
//   GET  /auth/desktop/ready    ->  whether this console hands sign-ins to the app; an app that gets anything else
//                                   (an older console, or one behind a hosting proxy) signs in inside its own window
//   GET  /auth/desktop?challenge=&next=
//                               ->  signed out: GitHub sign-in in this browser, which comes back here
//                                   signed in: a page that opens woodshed://signed-in?code=&next=
//   POST /auth/desktop/claim    ->  {code, verifier} for the app's own session cookie
import { DESKTOP_CHALLENGE_RE, safeNext } from './auth.mjs';

const MAX_CLAIM_BYTES = 4096;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** @returns {string}  the woodshed:// address that hands the code to the app */
export function desktopLink({ code, next }) {
  const link = new URL('woodshed://signed-in');
  link.searchParams.set('code', code);
  link.searchParams.set('next', safeNext(next));
  return link.href;
}

// The browser's last page: it opens the app, and says what to do when the browser asked first and was told no.
function handOffPage({ link, consoleName }) {
  const href = escapeHtml(link);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${href}">
<title>${escapeHtml(consoleName)}: back to the app</title>
<style>
  :root { color-scheme: light dark; --ink: #1b2232; --sub: #666666; --ground: #ffffff; --stopped: #f6f5f2; --line: #e2e2e2; --action: #b45a05; --action-ink: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e8ecf5; --sub: #a3aabb; --ground: #12151c; --stopped: #10131a; --line: #2a3142; --action: #f59433; --action-ink: #1b1204; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; background: var(--stopped); color: var(--ink); font: 15px/1.5 "Red Hat Display", system-ui, sans-serif; }
  main { width: min(440px, 100%); background: var(--ground); border: 1px solid var(--line); border-radius: 12px; padding: 32px; }
  h1 { font: 700 22px/1.3 Merriweather, Georgia, serif; margin: 0 0 8px; }
  p { color: var(--sub); margin: 0 0 20px; }
  a.btn { display: inline-block; padding: 10px 16px; border-radius: 6px; background: var(--action); color: var(--action-ink); font-weight: 600; text-decoration: none; }
</style></head>
<body><main>
  <h1>You're signed in</h1>
  <p>Your browser is handing the sign-in to the Woodshed app. If it asked whether to open Woodshed, say yes. You can close this tab after.</p>
  <a class="btn" href="${href}">Open the Woodshed app</a>
</main></body></html>`;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_CLAIM_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * @param {{req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL,
 *          auth: ReturnType<import('./auth.mjs').createAuth>, consoleName?: string}} args
 * @returns {Promise<boolean>}  whether it answered: true for its own paths
 */
export async function handleDesktopSignIn({ req, res, url, auth, consoleName = 'Woodshed' }) {
  const { pathname } = url;
  if (pathname === '/auth/desktop/ready' && req.method === 'GET') {
    json(res, 200, { desktop: true, available: auth.available(), required: auth.enabled() });
    return true;
  }
  if (pathname === '/auth/desktop' && req.method === 'GET') {
    const challenge = url.searchParams.get('challenge') ?? '';
    const next = safeNext(url.searchParams.get('next'));
    if (!DESKTOP_CHALLENGE_RE.test(challenge)) {
      json(res, 400, { error: 'open this from the Woodshed app' });
      return true;
    }
    const code = await auth.desktopCode({ cookieHeader: req.headers.cookie, challenge });
    if (!code) {
      // Signed out in this browser: GitHub's sign-in, which brings the browser back here, challenge and all.
      const back = `/auth/desktop?${new URLSearchParams({ challenge, next })}`;
      res.writeHead(302, { location: `/auth/start?next=${encodeURIComponent(back)}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(handOffPage({ link: desktopLink({ code, next }), consoleName }));
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
    const claimed = auth.claimDesktopCode({ code: body?.code, verifier: body?.verifier });
    if (!claimed) {
      json(res, 401, { error: 'That sign-in has expired or was already used. Sign in again from the app.' });
      return true;
    }
    json(res, 200, { login: claimed.login }, { 'set-cookie': claimed.setCookie });
    return true;
  }
  return false;
}
