// GitHub access borrowed from whatever hosts the console (README.md, "Hosted mode"). The console then has no GitHub App
// of its own: every installation token, its own and the ones sessions get from the session API, comes from the host's
// broker, which holds the App:
//
//   POST <url>   Authorization: Bearer <the token in the file>
//                {"repo": "owner/name", "permissions": {"contents": "write", ...}}, either left out when not wanted; {}
//             -> 200 {"token": "ghs_...", "expiresAt": "<ISO 8601>", "permissions": {...}}; anything else is a refusal,
//                {"error": "..."} maybe
//
// `permissions` narrows the token as GitHub's own installation token call does: a session's is narrower than the
// console's, and an ask session's reads only. The answer must then say what the token may do, as GitHub answers it,
// and a token said to do more than was asked, or that says nothing, is refused rather than handed to a session.
// The bearer is read from its file at each call, so the host can rotate it without a restart, and is never logged.

import fs from 'node:fs';

// A token handed out is good for at least this long, so a push started with it does not fail halfway.
const REFRESH_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
// GitHub's levels, least first; `admin` is above anything a token here is asked for.
const LEVELS = ['read', 'write', 'admin'];

/**
 * @param {Record<string, string>} asked
 * @param {unknown} given  what the broker says the token may do
 * @returns {string|null}  why the token is not within what was asked, or null when it is
 */
function widerThanAsked(asked, given) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return 'it did not say what the token may do';
  const wider = Object.entries(given).filter(([name, level]) => {
    const want = LEVELS.indexOf(asked[name]);
    const got = LEVELS.indexOf(level);
    return want < 0 || got < 0 || got > want;
  }).map(([name]) => name);
  return wider.length ? `the token may do more than was asked: ${wider.sort().join(', ')}` : null;
}

// One cache entry per repo and permissions, whatever order the permissions were written in.
function keyOf(repo, permissions) {
  const sorted = permissions ? Object.keys(permissions).sort().map((name) => `${name}=${permissions[name]}`).join(',') : '*';
  return `${repo ?? ''}\n${sorted}`;
}

function bearerFrom(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new Error(`the GitHub broker's token file could not be read (${err.code ?? 'unreadable'})`);
  }
  if (!text) throw new Error('the GitHub broker\'s token file is empty');
  return text;
}

/** @returns {number}  an answer's expiry in ms: an ISO 8601 string, as the HTTP broker sends it, a Date or ms */
function expiryOf(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value ?? ''));
}

/**
 * The checks and the cache, over any way of asking: the host's broker over HTTP, or a token source in the same
 * process. `ask(repo, permissions, label)` resolves to the broker's answer,
 * `{token, expiresAt, permissions}`, or throws its refusal.
 * @param {{ask: (repo: string|null, permissions: Record<string, string>|null, label: string) => Promise<object>,
 *          now?: () => number, kind: string}} opts  `kind` is what the log calls it
 */
function createTokenBroker({ ask, now = Date.now, kind }) {
  const cached = new Map();
  const pending = new Map();

  async function checked(repo, permissions, label) {
    const started = now();
    const answer = await ask(repo, permissions, label);
    const expiresAt = expiryOf(answer?.expiresAt);
    if (typeof answer?.token !== 'string' || !answer.token || !Number.isFinite(expiresAt)) {
      console.warn('githubBroker: token refused', { label, repo, kind, error: 'no token or expiry in the answer' });
      throw new Error(`the GitHub broker gave no token (${label})`);
    }
    const wider = permissions ? widerThanAsked(permissions, answer.permissions) : null;
    if (wider) {
      console.warn('githubBroker: token wider than asked, not used', { label, repo, why: wider });
      throw new Error(`the GitHub broker's token was not used (${label}): ${wider}`);
    }
    console.log('githubBroker: token borrowed', { label, repo, kind, expiresAt: new Date(expiresAt).toISOString(), ms: now() - started });
    return { token: answer.token, expiresAt };
  }

  function tokenSource({ repo, permissions = null, label }) {
    const key = keyOf(repo, permissions);
    return {
      async token() {
        const kept = cached.get(key);
        if (kept && kept.expiresAt - now() > REFRESH_MARGIN_MS) return kept;
        // Callers that arrive while a token is being asked for share it rather than each asking the broker.
        if (!pending.has(key)) pending.set(key, checked(repo, permissions, label).finally(() => pending.delete(key)));
        const fresh = await pending.get(key);
        cached.set(key, fresh);
        return fresh;
      },
    };
  }

  return { tokenSource };
}

/**
 * @param {{url: string, tokenFile: string, fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {{tokenSource: (args: {repo: string|null, permissions?: Record<string, 'read'|'write'>|null, label: string})
 *   => {token: () => Promise<{token: string, expiresAt: number}>}}}
 *   one cache for the console: each repo's token with the same permissions is asked for once, and shared by every
 *   source that asks for it. No `permissions` is the installation's own, for the console
 */
export function createGitHubBroker({ url, tokenFile, fetchImpl = fetch, now = Date.now }) {
  async function ask(repo, permissions, label) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerFrom(tokenFile)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...(repo ? { repo } : {}), ...(permissions ? { permissions } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn('githubBroker: not reached', { label, repo, message: String(err?.message ?? err).split('\n')[0] });
      throw new Error(`the GitHub broker was not reached (${label}): ${String(err?.message ?? err).split('\n')[0]}`);
    }
    const answer = await res.json().catch(() => ({}));
    if (res.status !== 200 || typeof answer?.token !== 'string' || !answer.token || !Number.isFinite(Date.parse(answer?.expiresAt))) {
      const why = String(answer?.error ?? '').slice(0, 200);
      console.warn('githubBroker: token refused', { label, repo, status: res.status, error: why || null });
      throw new Error(`the GitHub broker refused a token (${label}): HTTP ${res.status}${why ? ` ${why}` : ''}`);
    }
    return answer;
  }
  return createTokenBroker({ ask, now, kind: 'http' });
}

/**
 * A token source the caller hands the console (`config.githubBroker.source`), called in the process, with the HTTP
 * broker's checks and cache: a token said to do more than was asked, or that says nothing, is not used.
 * @param {{source: {token: (args: {repo: string|null, permissions: Record<string, string>|null}) =>
 *            Promise<{token: string, expiresAt: string|number|Date, permissions?: object}>}, now?: () => number}} opts
 */
export function createInProcessBroker({ source, now = Date.now }) {
  async function ask(repo, permissions, label) {
    try {
      return await source.token({ repo, permissions });
    } catch (err) {
      console.warn('githubBroker: token refused', { label, repo, kind: 'source', error: String(err?.message ?? err).split('\n')[0].slice(0, 200) });
      throw new Error(`the token source gave no GitHub token (${label}): ${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  return createTokenBroker({ ask, now, kind: 'source' });
}
