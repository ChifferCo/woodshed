// GitHub App installation tokens. The console signs a 10-minute JWT with the
// App's private key and trades it for an installation token, which lasts an
// hour and works only on the console's repo. The private key never leaves the
// console: sessions get installation tokens from it (sessionApi.mjs). The same
// JWT reads and sets the App's own webhook settings.

import crypto from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
// GitHub refuses a JWT that lives longer than 10 minutes, or one whose iat is ahead of its clock.
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;
// A token handed out is good for at least this long, so a push started with it does not fail halfway.
const REFRESH_MARGIN_MS = 10 * 60_000;

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

/**
 * @param {{appId: string, privateKey: string, nowMs: number}} opts
 * @returns {string}  an RS256 JWT that authenticates as the App itself
 */
export function appJwt({ appId, privateKey, nowMs }) {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: String(appId) })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

// The key can arrive after the console starts, from the Secrets page.
function currentKey(privateKey) {
  const key = typeof privateKey === 'function' ? privateKey() : privateKey;
  if (!key) throw new Error('the GitHub App key is not set yet: upload it on the console\'s Secrets page');
  return key;
}

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };

/**
 * @param {{appId: string, installationId: string, privateKey: string|(() => string|null), repo: string,
 *          permissions?: Record<string, 'read'|'write'>, label: string,
 *          fetchImpl?: typeof fetch, now?: () => number}} opts
 *   `permissions` narrows the token below what the App was granted; omitted, it gets all of them.
 *   `label` names the token in logs.
 * @returns {{token: () => Promise<{token: string, expiresAt: number}>}}
 */
export function createTokenSource({ appId, installationId, privateKey, repo, permissions, label, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  let pending = null;

  async function mint() {
    const body = { repositories: [repo.split('/').pop()] };
    if (permissions) body.permissions = permissions;
    const res = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt({ appId, privateKey: currentKey(privateKey), nowMs: now() })}`,
        ...GITHUB_HEADERS,
      },
      body: JSON.stringify(body),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub refused an installation token (${label}): HTTP ${res.status} ${String(answer.message ?? '').slice(0, 200)}`);
    const minted = { token: answer.token, expiresAt: Date.parse(answer.expires_at) };
    console.log('githubApp: token minted', { label, expiresAt: answer.expires_at });
    return minted;
  }

  return {
    async token() {
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached;
      // Callers that arrive while a token is being minted share it rather than each asking GitHub.
      pending ??= mint().finally(() => { pending = null; });
      cached = await pending;
      return cached;
    },
  };
}

/**
 * Calls made as the App itself, not as an installation: its webhook settings and its subscribed events.
 * @param {{appId: string, privateKey: string|(() => string|null), fetchImpl?: typeof fetch, now?: () => number}} opts
 */
export function createAppApi({ appId, privateKey, fetchImpl = fetch, now = Date.now }) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${appJwt({ appId, privateKey: currentKey(privateKey), nowMs: now() })}`, ...GITHUB_HEADERS },
      body: body ? JSON.stringify(body) : undefined,
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(`GitHub refused ${method} ${path}: HTTP ${res.status} ${String(answer.message ?? '').slice(0, 200)}`), { status: res.status });
    }
    return answer;
  }

  // An App whose webhook is switched off has no webhook to read: GitHub answers 404, not an empty config.
  async function hookCall(method, path, body, whenOff) {
    try {
      return await call(method, path, body);
    } catch (err) {
      if (err.status === 404 && whenOff !== undefined) return whenOff;
      throw err;
    }
  }

  return {
    /** @returns {Promise<{slug: string, events: string[], clientId: string}>}  `clientId` is what GitHub sign-in names the App by */
    async app() {
      const answer = await call('GET', '/app');
      return { slug: answer.slug, events: answer.events ?? [], clientId: answer.client_id ?? '' };
    },
    /**
     * @returns {Promise<string|null>}  the id of the App's installation on `repo` (`owner/name`), null when the App is
     *   not installed on it, or cannot see it
     */
    async installationOf(repo) {
      try {
        const answer = await call('GET', `/repos/${repo}/installation`);
        return answer.id ? String(answer.id) : null;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    /**
     * @returns {Promise<{active: boolean, url: string, contentType: string, insecureSsl: string}>}
     *   `active` false when the App's webhook is switched off. GitHub never returns the secret
     */
    async hookConfig() {
      const answer = await hookCall('GET', '/app/hook/config', undefined, null);
      if (!answer) return { active: false, url: '', contentType: '', insecureSsl: '' };
      return { active: true, url: answer.url ?? '', contentType: answer.content_type ?? '', insecureSsl: String(answer.insecure_ssl ?? '') };
    },
    /**
     * @returns {Promise<{id: number, guid: string, deliveredAt: string, event: string, action: string|null,
     *                    statusCode: number, status: string, redelivery: boolean}[]>}  newest first
     */
    async deliveries() {
      const answer = await hookCall('GET', '/app/hook/deliveries?per_page=10', undefined, []);
      return (Array.isArray(answer) ? answer : []).map((d) => ({
        id: d.id, guid: d.guid, deliveredAt: d.delivered_at, event: d.event, action: d.action ?? null,
        statusCode: d.status_code, status: d.status, redelivery: Boolean(d.redelivery),
      }));
    },
    /** @param {{url?: string, secret?: string}} fields  only what changes; JSON, with certificate checks on */
    async setHookConfig({ url, secret }) {
      const body = { content_type: 'json', insecure_ssl: '0' };
      if (url) body.url = url;
      if (secret) body.secret = secret;
      await call('PATCH', '/app/hook/config', body);
      console.log('githubApp: webhook settings changed', { url: Boolean(url), secret: Boolean(secret) });
    },
  };
}
