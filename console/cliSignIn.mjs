// The woodshed command line's sign-in (cli/), by a device code the person approves in a browser where they are signed in
// to the console, as `gh auth login` and other command lines do (RFC 8628):
//
//   POST /api/cli/device   {"name": "<the computer's name>"}   ->  {deviceCode, userCode, verificationUrl, expiresIn, interval}
//   GET  /cli?code=        (signed in)  ->  a page naming the computer and the code: Sign in the CLI, or Deny
//   POST /cli              (that page's buttons, same origin)  ->  the code approved, or denied, as the signed-in person
//   POST /api/cli/token    {"deviceCode"}  ->  202 while it waits, then 200 {token, login, expiresAt} once, or 403 denied,
//                                              410 expired, 429 asked too often
//   GET  /api/cli/me       (Authorization: Bearer wsc_...)  ->  who the token is, and the console's name, org and address
//   POST /api/cli/logout   (Authorization: Bearer wsc_...)  ->  ends that token
//
// The token is a CLI token of its own, not the database tunnel's (dbTunnel.mjs): that one lasts 12 hours, a person has one
// at a time, and it is made only once their databases are ready. A CLI sign-in is one per computer, lasts 90 days, and
// each shows on My settings with Revoke. The console keeps only each token's SHA-256, in state.json under `cliTokens`.
// Device codes are kept in memory: one outlives no restart, and the CLI starts again.
//
// A browser sends Origin with every cross-site POST and the CLI sends none, so /api/cli/device and /api/cli/token
// refuse a request that has one: no web page starts a sign-in to hand someone the code of. The code is only ever
// approved on the console's own page, by a signed-in person who sees which computer asked and when.

import crypto from 'node:crypto';
import { isSameOrigin } from '../shared/sameOrigin.mjs';
import { PAGE_HEADERS, PAGE_STYLE } from './desktopSignIn.mjs';

export const CLI_TOKEN_TTL_MS = 90 * 24 * 3_600_000;
const DEVICE_CODE_MS = 10 * 60_000;
const POLL_SECONDS = 5;
// More than this many sign-ins waiting at once, and a new one is refused until some expire: each holds a little memory.
const MAX_PENDING = 200;
// A person's computers: past this, a new sign-in ends their oldest.
const MAX_TOKENS_PER_PERSON = 20;
// How often a token's last use is written down: each write saves state.json.
const LAST_USED_EVERY_MS = 60 * 60_000;
const MAX_BODY_BYTES = 4096;
const BEARER_RE = /^Bearer (wsc_[0-9a-f]{64})$/;
// No vowels, so no code spells a word, and none of 0/O or 1/I to misread (RFC 8628, 6.1).
const USER_CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
export const CLI_PAGE_PATH = '/cli';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function userCode() {
  const pick = () => USER_CODE_LETTERS[crypto.randomInt(USER_CODE_LETTERS.length)];
  const four = () => Array.from({ length: 4 }, pick).join('');
  return `${four()}-${four()}`;
}

/** @returns {string|null}  the code as the person may type it (lower case, no dash, spaces), or null for no code */
export function normalUserCode(typed) {
  const letters = String(typed ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== 8) return null;
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

/** What the computer called itself: shown on the page and My settings, so printable and short. */
function deviceName(name) {
  const clean = String(name ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
  return clean || 'a computer';
}

/**
 * @param {{store: {state: object, save: () => void}, now?: () => number,
 *          allowed?: (login: string|null) => boolean}} deps
 *   `allowed` says whether a login may still use the console (on the People list): a token whose person was taken off it
 *   stops working at once, not when it expires
 */
export function createCliSignIn({ store, now = Date.now, allowed = () => true }) {
  // deviceCode's hash -> {userCode, name, from, createdAt, expiresAt, lastPollAt, approved: {login}|null, denied}
  const pending = new Map();

  function tokens() {
    store.state.cliTokens ??= {};
    return store.state.cliTokens;
  }

  function sweep() {
    for (const [key, device] of pending) if (device.expiresAt <= now()) pending.delete(key);
    let dropped = false;
    for (const [id, record] of Object.entries(tokens())) {
      if (Date.parse(record.expiresAt) <= now()) {
        delete tokens()[id];
        dropped = true;
      }
    }
    if (dropped) store.save();
  }

  function byUserCode(code) {
    for (const device of pending.values()) if (device.userCode === code && device.expiresAt > now()) return device;
    return null;
  }

  /**
   * A new sign-in waiting for a person.
   * @param {{name?: string, from?: string|null}} args  `from` is the address that asked, for the log: behind Caddy it is
   *   Caddy's, so the page does not show it
   * @returns {{deviceCode: string, userCode: string, expiresIn: number, interval: number}}
   */
  function start({ name, from = null }) {
    sweep();
    if (pending.size >= MAX_PENDING) throw Object.assign(new Error('too many sign-ins are waiting: try again in a few minutes'), { status: 429 });
    const deviceCode = crypto.randomBytes(32).toString('hex');
    let code = userCode();
    while (byUserCode(code)) code = userCode();
    pending.set(sha256(deviceCode), {
      userCode: code, name: deviceName(name), from, createdAt: now(), expiresAt: now() + DEVICE_CODE_MS, lastPollAt: 0, approved: null, denied: false,
    });
    console.log('cliSignIn: sign-in started', { name: deviceName(name), from });
    return { deviceCode, userCode: code, expiresIn: DEVICE_CODE_MS / 1000, interval: POLL_SECONDS };
  }

  /** @returns {{userCode: string, name: string, from: string|null, createdAt: string}|null}  a waiting sign-in, for the page */
  function waiting(code) {
    const device = byUserCode(normalUserCode(code));
    if (!device || device.approved || device.denied) return null;
    return { userCode: device.userCode, name: device.name, from: device.from, createdAt: new Date(device.createdAt).toISOString() };
  }

  /** @returns {boolean}  false when there is no such code waiting */
  function decide({ code, login, approve }) {
    const device = byUserCode(normalUserCode(code));
    if (!device || device.approved || device.denied) return false;
    if (approve) device.approved = { login };
    else device.denied = true;
    console.log(approve ? 'cliSignIn: sign-in approved' : 'cliSignIn: sign-in denied', { login, name: device.name });
    return true;
  }

  function issue({ login, name }) {
    const id = crypto.randomBytes(8).toString('hex');
    const token = `wsc_${crypto.randomBytes(32).toString('hex')}`;
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + CLI_TOKEN_TTL_MS).toISOString();
    const mine = Object.entries(tokens()).filter(([, r]) => r.login === login).sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    for (const [oldId] of mine.slice(0, Math.max(0, mine.length - MAX_TOKENS_PER_PERSON + 1))) {
      console.log('cliSignIn: oldest sign-in ended, past the most a person keeps', { login, id: oldId, most: MAX_TOKENS_PER_PERSON });
      delete tokens()[oldId];
    }
    tokens()[id] = { login, name, hash: sha256(token), createdAt, expiresAt, lastUsedAt: createdAt };
    store.save();
    console.log('cliSignIn: token made', { login, id, name, expiresAt });
    return { id, token, expiresAt };
  }

  /**
   * The CLI asking whether its sign-in was approved yet. A token is handed out once: the code is gone after.
   * @returns {{status: 'pending'|'slow_down'|'denied'|'expired'}|{status: 'approved', token: string, id: string, login: string|null, expiresAt: string}}
   */
  function poll(deviceCode) {
    if (typeof deviceCode !== 'string' || !/^[0-9a-f]{64}$/.test(deviceCode)) return { status: 'expired' };
    const key = sha256(deviceCode);
    const device = pending.get(key);
    if (!device || device.expiresAt <= now()) {
      pending.delete(key);
      return { status: 'expired' };
    }
    if (device.denied) {
      pending.delete(key);
      return { status: 'denied' };
    }
    if (device.approved) {
      pending.delete(key);
      if (!allowed(device.approved.login)) return { status: 'denied' };
      return { status: 'approved', login: device.approved.login, ...issue({ login: device.approved.login, name: device.name }) };
    }
    // A second earlier than the interval is let through: timers on a busy laptop run late, never early, but the
    // round trip can make two polls look closer than they were sent.
    const tooSoon = now() - device.lastPollAt < (POLL_SECONDS - 1) * 1000;
    device.lastPollAt = now();
    return { status: tooSoon ? 'slow_down' : 'pending' };
  }

  /** @returns {{id: string, login: string|null, record: object}|null}  the live token a request carries */
  function tokenFor(headers) {
    const token = BEARER_RE.exec(String(headers?.authorization || ''))?.[1];
    if (!token) return null;
    const hash = sha256(token);
    const found = Object.entries(tokens()).find(([, r]) => r.hash === hash);
    if (!found || Date.parse(found[1].expiresAt) <= now()) return null;
    const [id, record] = found;
    if (!allowed(record.login)) {
      console.warn('cliSignIn: refused, the token\'s person is no longer a member', { login: record.login, id });
      return null;
    }
    if (now() - Date.parse(record.lastUsedAt ?? 0) >= LAST_USED_EVERY_MS) {
      record.lastUsedAt = new Date(now()).toISOString();
      store.save();
    }
    return { id, login: record.login, record };
  }

  /** @returns {{id, name, createdAt, expiresAt, lastUsedAt}[]}  a person's CLI sign-ins, newest first; never a hash */
  function list(login) {
    sweep();
    return Object.entries(tokens()).filter(([, r]) => r.login === login)
      .map(([id, r]) => ({ id, name: r.name, createdAt: r.createdAt, expiresAt: r.expiresAt, lastUsedAt: r.lastUsedAt ?? null }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** @returns {boolean}  false when that person has no sign-in of that id */
  function revoke(login, id, by = 'My settings') {
    const record = tokens()[id];
    if (!record || record.login !== login) return false;
    delete tokens()[id];
    store.save();
    console.log('cliSignIn: token revoked', { login, id, name: record.name, by });
    return true;
  }

  /** Every CLI sign-in of a person's: Remove My Woodshed, or taken off People. */
  function revokeAll(login, by) {
    // A code approved for them and not collected yet would otherwise sign them in again after this.
    for (const device of pending.values()) {
      if (device.approved?.login === login) {
        device.approved = null;
        device.denied = true;
      }
    }
    const ids = Object.entries(tokens()).filter(([, r]) => r.login === login).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) delete tokens()[id];
    store.save();
    console.log('cliSignIn: every token revoked', { login, count: ids.length, by });
  }

  return { start, waiting, decide, poll, tokenFor, list, revoke, revokeAll, logins: () => [...new Set(Object.values(tokens()).map((r) => r.login))] };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * The CLI's own calls, which carry no cookie: a device code or a token is their sign-in.
 * @param {{req, res, url: URL, cli: ReturnType<typeof createCliSignIn>, publicUrl: string,
 *          about: (login: string|null) => {console: string, org: string|null}}} args
 * @returns {Promise<boolean>}  whether it answered: true for any /api/cli/ path
 */
export async function handleCliApi({ req, res, url, cli, publicUrl, about }) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/cli/')) return false;
  if (pathname === '/api/cli/device' || pathname === '/api/cli/token') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    if (req.headers.origin) {
      console.warn('cliSignIn: refused, a browser\'s call', { path: pathname, origin: String(req.headers.origin).slice(0, 100) });
      return json(res, 403, { error: 'sign in from the woodshed command line' }), true;
    }
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { error: 'send a JSON object' }), true;
    if (pathname === '/api/cli/device') {
      let started;
      try {
        started = cli.start({ name: body.name, from: req.socket?.remoteAddress ?? null });
      } catch (err) {
        if (!err.status) throw err;
        return json(res, err.status, { error: err.message }), true;
      }
      const verificationUrl = `${publicUrl}${CLI_PAGE_PATH}`;
      return json(res, 200, { ...started, verificationUrl, verificationUrlComplete: `${verificationUrl}?code=${started.userCode}` }), true;
    }
    const answer = cli.poll(body.deviceCode);
    const statuses = {
      pending: [202, { status: 'pending' }],
      slow_down: [429, { status: 'slow_down', error: `ask at most every ${POLL_SECONDS} seconds` }],
      denied: [403, { status: 'denied', error: 'the sign-in was denied in the browser' }],
      expired: [410, { status: 'expired', error: 'the code expired before it was approved: run woodshed login again' }],
    };
    if (answer.status === 'approved') {
      const { token, id, login, expiresAt } = answer;
      return json(res, 200, { status: 'approved', token, id, login, expiresAt, ...about(login) }), true;
    }
    const [status, reply] = statuses[answer.status];
    return json(res, status, reply), true;
  }
  const signedIn = cli.tokenFor(req.headers);
  if (!signedIn) return json(res, 401, { error: 'not signed in, or the sign-in ended: run woodshed login' }), true;
  if (pathname === '/api/cli/me' && req.method === 'GET') {
    const { id, login, record } = signedIn;
    return json(res, 200, { login, ...about(login), url: publicUrl, token: { id, name: record.name, createdAt: record.createdAt, expiresAt: record.expiresAt } }), true;
  }
  if (pathname === '/api/cli/logout' && req.method === 'POST') {
    cli.revoke(signedIn.login, signedIn.id, 'woodshed logout');
    return json(res, 200, { ok: true }), true;
  }
  return json(res, 404, { error: 'not found' }), true;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CLI_STYLE = `${PAGE_STYLE}
  .code { display: block; font: 600 24px/1.2 "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.08em; margin: 0 0 20px; }
  .meta { font: 13px/1.5 "JetBrains Mono", ui-monospace, monospace; color: var(--sub); margin: -12px 0 20px; }
  .field { display: block; width: 100%; box-sizing: border-box; margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--ground); color: var(--ink); font: 600 20px "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
  .error { color: var(--bad); margin: -8px 0 16px; }
  button.quiet { background: none; border: 0; padding: 10px 4px; font: inherit; cursor: pointer; text-decoration: underline; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  :root { --bad: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bad: #f97066; } }`;

function page({ consoleName, title, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(consoleName)}: ${escapeHtml(title)}</title>
<style>${CLI_STYLE}</style></head>
<body><main>
${body}
</main></body></html>`;
}

// No code, or one that is not waiting: a box to type the one the terminal shows.
function typePage({ consoleName, error = null, code = '' }) {
  return page({
    consoleName, title: 'sign in the command line', body: `  <h1>Sign in the woodshed command line</h1>
  <p>Type the code <code>woodshed login</code> shows in your terminal.</p>
  <form method="get" action="${CLI_PAGE_PATH}">
    <label class="sr-only" for="code">Code</label>
    <input class="field" id="code" name="code" value="${escapeHtml(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" required>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <button class="btn" type="submit">Next</button><a class="quiet" href="/">Cancel</a>
  </form>`,
  });
}

// The question before the token: who signs in, on which computer, and that it is only for a sign-in the person started.
function consentPage({ consoleName, login, device }) {
  const who = login ? `as <strong>@${escapeHtml(login)}</strong>` : '';
  return page({
    consoleName, title: 'sign in the command line', body: `  <h1>Sign in the woodshed command line?</h1>
  <p>The woodshed command line on <strong>${escapeHtml(device.name)}</strong> asks to sign in to ${escapeHtml(consoleName)} ${who}. Sign in only if you just ran <code>woodshed login</code> and your terminal shows this code:</p>
  <span class="code">${escapeHtml(device.userCode)}</span>
  <p class="meta">Asked ${escapeHtml(device.createdAt.replace('T', ' ').slice(0, 16))} UTC</p>
  <form method="post" action="${CLI_PAGE_PATH}">
    <input type="hidden" name="code" value="${escapeHtml(device.userCode)}">
    <input type="hidden" name="login" value="${escapeHtml(login ?? '')}">
    <button class="btn" type="submit" name="decision" value="approve">Sign in the CLI</button><button class="quiet" type="submit" name="decision" value="deny">Deny</button>
  </form>`,
  });
}

function donePage({ consoleName, approved, name }) {
  return page({
    consoleName, title: approved ? 'command line signed in' : 'sign-in denied',
    body: approved
      ? `  <h1>The command line is signed in</h1>
  <p>Go back to your terminal on ${escapeHtml(name)}. You can close this tab. My settings lists each computer signed in, with Revoke.</p>
  <a class="btn" href="/settings#my-cli">Open My settings</a>`
      : `  <h1>Sign-in denied</h1>
  <p>The command line on ${escapeHtml(name)} is not signed in. If you did not run <code>woodshed login</code> yourself, someone may have sent you the link: tell whoever runs this console.</p>
  <a class="btn" href="/">Open the console</a>`,
  });
}

/**
 * The page the person approves the code on, behind the console's sign-in.
 * @param {{req, res, url: URL, cli: ReturnType<typeof createCliSignIn>, login: string|null, consoleName: string}} args
 * @returns {Promise<boolean>}  whether it answered
 */
export async function handleCliPage({ req, res, url, cli, login, consoleName }) {
  if (url.pathname !== CLI_PAGE_PATH) return false;
  const send = (body, status = 200) => {
    res.writeHead(status, PAGE_HEADERS);
    res.end(body);
    return true;
  };
  if (req.method === 'GET') {
    const typed = url.searchParams.get('code');
    if (!typed) return send(typePage({ consoleName }));
    const device = cli.waiting(typed);
    if (!device) return send(typePage({ consoleName, code: typed.slice(0, 20), error: 'No sign-in is waiting with that code. It lasts 10 minutes: run woodshed login again for a new one.' }), 404);
    return send(consentPage({ consoleName, login, device }));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
  // The consent page's own buttons: a browser always sends Origin with a form's POST, and another site's is refused.
  if (!req.headers.origin || !isSameOrigin(req.headers)) return json(res, 403, { error: 'approve the sign-in from the console\'s own page' }), true;
  let form;
  try {
    form = new URLSearchParams(await readBody(req));
  } catch {
    return json(res, 400, { error: 'the form was too large' }), true;
  }
  const code = form.get('code') ?? '';
  // A page left open while this browser signed in as someone else asks again, naming who it is now.
  if ((form.get('login') ?? '') !== (login ?? '')) {
    console.warn('cliSignIn: the consent page named another account, asked again', { shown: String(form.get('login') ?? '').slice(0, 40), now: login });
    res.writeHead(303, { location: `${CLI_PAGE_PATH}?code=${encodeURIComponent(code)}`, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  const device = cli.waiting(code);
  const approve = form.get('decision') === 'approve';
  if (!device || !cli.decide({ code, login, approve })) {
    return send(typePage({ consoleName, error: 'That sign-in has expired or was already answered. Run woodshed login again.' }), 410);
  }
  return send(donePage({ consoleName, approved: approve, name: device.name }));
}
