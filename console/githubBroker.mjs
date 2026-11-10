// GitHub access borrowed from whatever hosts the console (README.md, "Hosted mode"). The console then has no GitHub App
// of its own: every installation token, its own and the ones sessions get from the session API, comes from the host's
// broker, which holds the App:
//
//   POST <url>   Authorization: Bearer <the token in the file>   {"repo": "owner/name"} or {}
//             -> 200 {"token": "ghs_...", "expiresAt": "<ISO 8601>"}; anything else is a refusal, {"error": "..."} maybe
//
// The bearer is read from its file at each call, so the host can rotate it without a restart, and is never logged.

import fs from 'node:fs';

// A token handed out is good for at least this long, so a push started with it does not fail halfway.
const REFRESH_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

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

/**
 * @param {{url: string, tokenFile: string, fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {{tokenSource: (args: {repo: string|null, label: string}) => {token: () => Promise<{token: string, expiresAt: number}>}}}
 *   one cache for the console: each repo's token is asked for once and shared by every source on that repo
 */
export function createGitHubBroker({ url, tokenFile, fetchImpl = fetch, now = Date.now }) {
  const cached = new Map();
  const pending = new Map();

  async function ask(repo, label) {
    const started = now();
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerFrom(tokenFile)}`, 'content-type': 'application/json' },
        body: JSON.stringify(repo ? { repo } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn('githubBroker: not reached', { label, repo, message: String(err?.message ?? err).split('\n')[0] });
      throw new Error(`the GitHub broker was not reached (${label}): ${String(err?.message ?? err).split('\n')[0]}`);
    }
    const answer = await res.json().catch(() => ({}));
    const expiresAt = Date.parse(answer?.expiresAt);
    if (res.status !== 200 || typeof answer?.token !== 'string' || !answer.token || !Number.isFinite(expiresAt)) {
      const why = String(answer?.error ?? '').slice(0, 200);
      console.warn('githubBroker: token refused', { label, repo, status: res.status, error: why || null });
      throw new Error(`the GitHub broker refused a token (${label}): HTTP ${res.status}${why ? ` ${why}` : ''}`);
    }
    console.log('githubBroker: token borrowed', { label, repo, expiresAt: answer.expiresAt, ms: now() - started });
    return { token: answer.token, expiresAt };
  }

  function tokenSource({ repo, label }) {
    const key = repo ?? '';
    return {
      async token() {
        const kept = cached.get(key);
        if (kept && kept.expiresAt - now() > REFRESH_MARGIN_MS) return kept;
        // Callers that arrive while a token is being asked for share it rather than each asking the broker.
        if (!pending.has(key)) pending.set(key, ask(repo, label).finally(() => pending.delete(key)));
        const fresh = await pending.get(key);
        cached.set(key, fresh);
        return fresh;
      },
    };
  }

  return { tokenSource };
}
