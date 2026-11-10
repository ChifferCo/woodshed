// A person's own GitHub token, for their private sessions to push and open pull requests as them. It is a GitHub
// App user token ("via woodshed-cloud" on GitHub), from the same authorization as signing in: Connect GitHub on My
// settings signs in once more, and this time the console keeps what GitHub answered.
//
// With expiring user tokens (the App's default) the answer holds an 8-hour token and a refresh token, which works
// once: each refresh returns a new pair, saved before the token is handed out, and one refresh per person runs at
// a time. Without expiry the token itself is kept. Either way it lives in Secrets Manager at
// `users/<login>/github` and never reaches a session; a session gets the short-lived token, from the session API.
//
// That token reaches every repo the App is installed on that the person can write to. A session on a project other
// than the installation's default gets a copy GitHub scopes down to that project's repo alone (scopedTokenFor), so it
// still pushes and opens pull requests as its owner without reaching the installation's other repos.

import logins from './public/logins.cjs';
const { loginKey, sameLogin } = logins;

const GITHUB_WEB = 'https://github.com';
const GITHUB_API = 'https://api.github.com';
// A token handed out is good for at least this long, as for the installation tokens (githubApp.mjs).
const REFRESH_MARGIN_MS = 10 * 60_000;
// githubToken.sh caches a token until shortly before `expiresAt`; a token that never expires is still asked for again.
const NO_EXPIRY_CACHE_MS = 8 * 3_600_000;

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

/**
 * @param {object} answer  GitHub's answer to a code or refresh exchange
 * @param {number} nowMs
 * @returns {{accessToken: string, expiresAt: number|null, refreshToken: string|null, refreshExpiresAt: number|null}}
 */
export function credentialsFrom(answer, nowMs) {
  return {
    accessToken: answer.access_token,
    expiresAt: answer.expires_in ? nowMs + answer.expires_in * 1000 : null,
    refreshToken: answer.refresh_token ?? null,
    refreshExpiresAt: answer.refresh_token_expires_in ? nowMs + answer.refresh_token_expires_in * 1000 : null,
  };
}

/**
 * @param {{clientId: () => Promise<string>, clientSecret: () => string|null,
 *          userSettings: {githubCredentials: Function, saveGitHub: Function, forgetGitHub: Function, view: Function},
 *          fetchImpl?: typeof fetch, now?: () => number, githubWeb?: string, githubApi?: string}} deps
 */
export function createGitHubUser({
  clientId, clientSecret, userSettings, fetchImpl = fetch, now = Date.now, githubWeb = GITHUB_WEB, githubApi = GITHUB_API,
}) {
  const cache = new Map();
  const refreshing = new Map();
  // Scoped tokens by person and repo, each with the token it was made from: a refresh makes a new one.
  const scoped = new Map();
  const scoping = new Map();

  /** Keeps the answer of a Connect GitHub sign-in, and who GitHub says they are, for commits. */
  async function connect({ login, answer }) {
    const credentials = credentialsFrom(answer, now());
    const res = await fetchImpl(`${githubApi}/user`, { headers: { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/vnd.github+json' } });
    const user = await res.json().catch(() => ({}));
    if (!res.ok || !sameLogin(user.login, login)) throw shown('GitHub did not say who connected. Try again.');
    const identity = { name: user.name || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
    await userSettings.saveGitHub(login, credentials, identity);
    cache.set(loginKey(login), credentials);
    console.log('githubUser: connected', { login, expiring: Boolean(credentials.refreshToken) });
  }

  async function refresh(login, credentials) {
    const res = await fetchImpl(`${githubWeb}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: await clientId(), client_secret: clientSecret(), grant_type: 'refresh_token', refresh_token: credentials.refreshToken }),
    });
    // GitHub refuses a refresh with 200 and an `error`. Anything else is GitHub having a moment, a 5xx or a 429: the
    // refresh token is still good, so the push fails this once and the next one tries again.
    if (!res.ok) throw new Error(`GitHub's token endpoint answered ${res.status}`);
    const answer = await res.json().catch(() => ({}));
    if (!answer.access_token) {
      // A revoked authorization, or a refresh token past its six months: only connecting again helps.
      console.warn('githubUser: GitHub refused the refresh, disconnecting', { login, status: res.status, error: String(answer.error ?? '').slice(0, 60) });
      await userSettings.forgetGitHub(login);
      cache.delete(loginKey(login));
      throw shown(`GitHub no longer accepts @${login}'s authorization: connect GitHub again on My settings`);
    }
    const next = credentialsFrom(answer, now());
    // A Disconnect while GitHub was answering: saving now would connect them again.
    if (!userSettings.view(login).github.connected) {
      console.log('githubUser: disconnected during a refresh, dropping the new token', { login });
      cache.delete(loginKey(login));
      await revoke(login, next.accessToken);
      return null;
    }
    // Saved before it is used: the old refresh token is spent, so losing this one would disconnect them.
    await userSettings.saveGitHub(login, next);
    cache.set(loginKey(login), next);
    console.log('githubUser: token refreshed', { login });
    return next;
  }

  /**
   * @returns {Promise<{token: string, expiresAt: number}|null>}  the person's own token, or null when they have not
   *   connected GitHub, so their sessions push as the App
   * @throws {Error}  `shown`, when they had connected and GitHub refuses them now
   */
  async function tokenFor(login) {
    const key = loginKey(login);
    // The record says whether they are connected, whatever this process still holds: Disconnect and Remove My
    // Woodshed clear the record, and a cached token must not outlive them, nor a refresh bring the secret back.
    if (!userSettings.view(login).github.connected) {
      cache.delete(key);
      return null;
    }
    let credentials = cache.get(key) ?? (await userSettings.githubCredentials(login));
    if (!credentials) return null;
    cache.set(key, credentials);
    if (credentials.expiresAt && credentials.expiresAt - now() < REFRESH_MARGIN_MS) {
      if (!credentials.refreshToken) {
        await userSettings.forgetGitHub(login);
        cache.delete(key);
        throw shown(`@${login}'s GitHub token has expired: connect GitHub again on My settings`);
      }
      if (!refreshing.has(key)) refreshing.set(key, refresh(login, credentials).finally(() => refreshing.delete(key)));
      credentials = await refreshing.get(key);
      if (!credentials) return null;
    }
    return { token: credentials.accessToken, expiresAt: credentials.expiresAt ?? now() + NO_EXPIRY_CACHE_MS };
  }

  function forgetScoped(login) {
    const prefix = `${loginKey(login)}\n`;
    for (const key of scoped.keys()) if (key.startsWith(prefix)) scoped.delete(key);
  }

  async function makeScoped(login, from, { repo, permissions }) {
    const secret = clientSecret();
    if (!secret) {
      console.warn('githubUser: no scoped token, the console has no client secret', { login, repo });
      return null;
    }
    const id = await clientId();
    const [owner, name] = repo.split('/');
    let res;
    try {
      res = await fetchImpl(`${githubApi}/applications/${id}/token/scoped`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ access_token: from.token, target: owner, repositories: [name], permissions }),
      });
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      console.warn('githubUser: GitHub did not answer the scoped token request', { login, repo, message: String(err.message).slice(0, 80) });
      return null;
    }
    const answer = await res.json().catch(() => ({}));
    if (!res.ok || !answer.token) {
      console.warn('githubUser: GitHub refused a scoped token', { login, repo, status: res.status });
      return null;
    }
    const expiresAt = Date.parse(answer.expires_at ?? '') || from.expiresAt;
    console.log('githubUser: scoped token made', { login, repo });
    return { from: from.token, token: answer.token, expiresAt };
  }

  /**
   * The person's own token, scoped by GitHub to one repo and to `permissions`, for their sessions on a project other
   * than the default.
   * @param {string} login
   * @param {{repo: string, permissions: Record<string, 'read'|'write'>}} scope  `repo` is owner/name
   * @returns {Promise<{token: string, expiresAt: number}|null>}  null when they have not connected GitHub, or GitHub
   *   (or a console with no client secret) made none: the caller falls back to the App's token for that repo
   * @throws {Error}  `shown`, as tokenFor, when they had connected and GitHub refuses them now
   */
  async function scopedTokenFor(login, scope) {
    const from = await tokenFor(login);
    if (!from) {
      forgetScoped(login);
      return null;
    }
    const key = `${loginKey(login)}\n${scope.repo.toLowerCase()}`;
    const held = scoped.get(key);
    if (held && held.from === from.token && held.expiresAt - now() >= REFRESH_MARGIN_MS) return { token: held.token, expiresAt: held.expiresAt };
    if (!scoping.has(key)) scoping.set(key, makeScoped(login, from, scope).finally(() => scoping.delete(key)));
    const made = await scoping.get(key);
    if (!made) return null;
    scoped.set(key, made);
    return { token: made.token, expiresAt: made.expiresAt };
  }

  /**
   * Ends a token at GitHub, so a session that already cached it can no longer push with it. Deleting the stored copy
   * does not need this to work: a failure leaves only a token that expires in hours, and is logged.
   */
  async function revoke(login, accessToken) {
    const id = await clientId();
    let res;
    try {
      res = await fetchImpl(`${githubApi}/applications/${id}/token`, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${clientSecret()}`).toString('base64')}`,
          accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({ access_token: accessToken }),
      });
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      console.warn('githubUser: GitHub did not answer the revoke', { login, message: String(err.message).slice(0, 80) });
      return;
    }
    // 404: GitHub no longer knows the token, so it is already over.
    if (!res.ok && res.status !== 404) return console.warn('githubUser: GitHub refused the revoke', { login, status: res.status });
    console.log('githubUser: token revoked', { login });
  }

  /** Disconnect and Remove My Woodshed: the stored token goes first, then GitHub ends the one sessions may hold. */
  async function disconnect(login) {
    const key = loginKey(login);
    const held = cache.get(key) ?? (await userSettings.githubCredentials(login));
    cache.delete(key);
    forgetScoped(login);
    await userSettings.forgetGitHub(login);
    if (held?.accessToken) await revoke(login, held.accessToken);
    console.log('githubUser: disconnected', { login, heldToken: Boolean(held?.accessToken) });
  }

  return { connect, tokenFor, scopedTokenFor, disconnect };
}
