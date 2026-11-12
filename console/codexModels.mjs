// The Codex models New session offers, as codex itself lists them: the catalog OpenAI's Codex backend serves at
// `GET /backend-api/codex/models?client_version=<codex's version>`, read with the person's own Codex sign-in, or with
// the team's OpenAI key when they have none. codex reads its catalog there for an API key too, not from /v1/models.
// So a model OpenAI adds shows here the day it ships, and a retired one leaves, with no change to the console.
//
//   own ChatGPT sign-in (auth.json)  Authorization: Bearer <tokens.access_token>, chatgpt-account-id: <tokens.account_id>
//   own API key, or the team key     Authorization: Bearer <key>
//
// The console never refreshes a ChatGPT sign-in: that rotates its refresh token, which the person's sessions hold. An
// access token that has expired, or a catalog that cannot be read, gives the person's last list read, or else the
// catalog built into the session image's codex (BUILT_IN below), and says so.

import { CODEX_EFFORT_RE, CODEX_MODEL_RE } from './sessions.mjs';

// The session image's codex (CODEX_VERSION in session/Dockerfile; codexModels.test.mjs keeps them the same). The
// backend answers with the models that version can run.
export const CODEX_CLIENT_VERSION = '0.167.0';
const UPSTREAM = 'https://chatgpt.com/backend-api/codex';
const FRESH_MS = 10 * 60_000;
// After a failure, the next try waits this long, so a page open on New session does not ask OpenAI on every poll.
const RETRY_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MAX_MODELS = 40;
const MAX_BYTES = 2 * 1024 * 1024;

// `codex debug models --bundled` of codex 0.167.0, the models it lists: what codex in a session falls back to when it
// cannot read the catalog either.
export const BUILT_IN = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low'],
  ['gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low'],
  ['gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium'],
  ['gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low'],
  ['gpt-6.1-terra', 'GPT-6.1 Terra', 'GPT-6.1 Terra Codex model.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'medium'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['gpt-5.5', 'GPT-5.5', 'Legacy coding model.', ['low', 'medium', 'high', 'xhigh'], 'medium'],
].map(([slug, name, description, efforts, defaultEffort]) => ({ slug, name, description, efforts, defaultEffort }));

/**
 * The models a catalog answer lists for this kind of sign-in, in codex's own order. Anything that is not a plain model
 * or effort name is left out, since both end up on codex's command line.
 * @param {unknown} body  the backend's JSON: `{models: [{slug, display_name, description, visibility, supported_in_api,
 *   priority, supported_reasoning_levels: [{effort}], default_reasoning_level}]}`
 * @param {{apiKey: boolean}} how  an API key runs only the models marked `supported_in_api`
 * @returns {{slug: string, name: string, description: string, efforts: string[], defaultEffort: string|null}[]}
 */
export function modelsFrom(body, { apiKey }) {
  const listed = Array.isArray(body?.models) ? body.models : [];
  const seen = new Set();
  return listed
    .filter((m) => m && m.visibility === 'list' && (!apiKey || m.supported_in_api !== false)
      && typeof m.slug === 'string' && CODEX_MODEL_RE.test(m.slug) && !seen.has(m.slug) && seen.add(m.slug))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .slice(0, MAX_MODELS)
    .map((m) => {
      const efforts = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((r) => r?.effort).filter((e) => typeof e === 'string' && CODEX_EFFORT_RE.test(e));
      return {
        slug: m.slug,
        name: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim().slice(0, 60) : m.slug,
        description: typeof m.description === 'string' ? m.description.trim().slice(0, 200) : '',
        efforts: [...new Set(efforts)],
        defaultEffort: efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : null,
      };
    });
}

/**
 * How a saved Codex sign-in reaches the catalog: its headers, and whether it is an API key.
 * @param {string} saved  an `sk-` key, or the JSON of ~/.codex/auth.json (checkCodexAuth in userSettings.mjs)
 * @returns {{headers: Record<string, string>, apiKey: boolean}|{expired: true}|null}  null for one with nothing usable
 */
export function credentialOf(saved, now = Date.now()) {
  if (typeof saved !== 'string' || !saved) return null;
  if (!saved.startsWith('{')) return { headers: { authorization: `Bearer ${saved}` }, apiKey: true };
  let auth;
  try {
    auth = JSON.parse(saved);
  } catch {
    return null;
  }
  if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) {
    return { headers: { authorization: `Bearer ${auth.OPENAI_API_KEY}` }, apiKey: true };
  }
  const access = auth?.tokens?.access_token;
  if (typeof access !== 'string' || !access) return null;
  const exp = jwtExpiry(access);
  if (exp !== null && exp * 1000 <= now) return { expired: true };
  const account = auth.tokens.account_id;
  return { headers: { authorization: `Bearer ${access}`, ...(typeof account === 'string' && account ? { 'chatgpt-account-id': account } : {}) }, apiKey: false };
}

/** @returns {number|null}  a JWT's `exp`, in seconds; null when it has none or is not a JWT */
function jwtExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp;
    return Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * @param {{userSettings?: {codexAuth: (login: string) => Promise<string|null>}|null,
 *          teamCredential?: (() => Promise<string|null>)|null,  the OpenAI proxy's: the team key
 *          fetch?: typeof fetch, upstream?: string, now?: () => number}} opts
 * @returns {{list: (login: string) => Promise<CodexCatalog>, allows: (login: string, model: string, effort: string) => Promise<string|null>,
 *            forget: (login: string) => void}}
 *
 * @typedef {{models: ReturnType<typeof modelsFrom>, source: 'own'|'team'|'built-in', note: string|null}} CodexCatalog
 *   `source` says whose sign-in read it; `note` says why the list is not a fresh one, for the page
 */
export function createCodexModels({ userSettings = null, teamCredential = null, fetch: fetchImpl = globalThis.fetch, upstream = UPSTREAM, now = Date.now } = {}) {
  // By login: the last list read, when, and the last failed try.
  const kept = new Map();
  const reading = new Map();

  async function credential(login) {
    const own = userSettings ? await userSettings.codexAuth(login) : null;
    if (own) return { ...(credentialOf(own, now()) ?? { unusable: true }), source: 'own' };
    const team = teamCredential ? await teamCredential() : null;
    if (team) return { headers: { authorization: `Bearer ${team}` }, apiKey: true, source: 'team' };
    return null;
  }

  async function read(login) {
    let cred;
    try {
      cred = await credential(login);
    } catch (err) {
      console.warn('codexModels: credential not read', { login, message: err?.message });
      return { failed: 'the console could not read your Codex sign-in' };
    }
    if (!cred) return { failed: 'no Codex sign-in is saved and the console has no OpenAI key' };
    if (cred.expired) {
      console.log('codexModels: own sign-in expired, not read', { login });
      return { failed: 'your saved Codex sign-in has expired: a Codex session refreshes it when it stops, or save a new one' };
    }
    if (cred.unusable) return { failed: 'your saved Codex sign-in has no access token' };
    const url = `${upstream}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
    try {
      const answer = await fetchImpl(url, {
        headers: { ...cred.headers, accept: 'application/json', originator: 'codex_cli_rs' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!answer.ok) {
        console.warn('codexModels: OpenAI refused the catalog', { login, source: cred.source, status: answer.status });
        return { failed: `OpenAI answered ${answer.status}` };
      }
      const text = await answer.text();
      if (text.length > MAX_BYTES) throw new Error('the catalog is too large');
      const models = modelsFrom(JSON.parse(text), { apiKey: cred.apiKey });
      if (!models.length) {
        console.warn('codexModels: the catalog listed no models', { login, source: cred.source });
        return { failed: 'OpenAI listed no models' };
      }
      console.log('codexModels: catalog read', { login, source: cred.source, models: models.length });
      return { models, source: cred.source };
    } catch (err) {
      console.warn('codexModels: catalog not read', { login, source: cred.source, message: err?.message });
      return { failed: 'OpenAI could not be reached' };
    }
  }

  /** @returns {Promise<CodexCatalog>} */
  async function list(login) {
    const last = kept.get(login);
    const at = now();
    const stale = !last?.models || at - last.at >= FRESH_MS;
    const due = !last || (stale && (!last.failedAt || at - last.failedAt >= RETRY_MS));
    if (due) {
      if (!reading.has(login)) {
        const run = read(login).then((got) => {
          // A read the person's sign-in changed under (forget) keeps nothing: it was made on the old one.
          if (reading.get(login) !== run) return;
          const prev = kept.get(login);
          kept.set(login, got.models
            ? { models: got.models, source: got.source, at: now() }
            : { ...(prev?.models ? prev : {}), failedAt: now(), why: got.failed });
        }).finally(() => { if (reading.get(login) === run) reading.delete(login); });
        reading.set(login, run);
      }
      await reading.get(login);
    }
    const entry = kept.get(login);
    if (entry?.models) {
      const stale = entry.failedAt && entry.failedAt > entry.at;
      return { models: entry.models, source: entry.source, note: stale ? `the list read ${new Date(entry.at).toISOString()}, since then ${entry.why}` : null };
    }
    return { models: BUILT_IN, source: 'built-in', note: `codex's built-in list, since ${entry?.why ?? 'the catalog was not read'}` };
  }

  /**
   * @returns {Promise<string|null>}  why a start with this model and effort is refused, or null when the list allows it.
   *   Codex's default model ('') takes any effort a listed model takes.
   */
  async function allows(login, model, effort) {
    const { models } = await list(login);
    const picked = model ? models.find((m) => m.slug === model) : null;
    if (model && !picked) return `the model must be one of ${models.map((m) => m.slug).join(', ')}`;
    const efforts = picked ? picked.efforts : [...new Set(models.flatMap((m) => m.efforts))];
    if (effort && !efforts.includes(effort)) return `the effort must be one of ${efforts.join(', ')}${picked ? ` for ${picked.slug}` : ''}`;
    return null;
  }

  /** Drops the person's kept list, after their Codex sign-in changed. */
  function forget(login) {
    kept.delete(login);
    reading.delete(login);
  }

  return { list, allows, forget };
}
