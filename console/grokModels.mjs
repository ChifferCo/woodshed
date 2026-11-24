// The Grok Build models New session offers, read with the person's own Grok sign-in (users/<login>/grok-auth), as
// codexModels.mjs reads Codex's. Grok Build runs on nothing else, so with no sign-in there is no list: the Model field
// is then the free-text box, which takes any name of the registry's shape (shared/agents.cjs), and a start is never
// refused for a model the list does not have.
//
//   own login (~/.grok/auth.json)  GET https://cli-chat-proxy.grok.com/v1/models, Authorization: Bearer <entry.key>:
//                                  the Grok Build models, each with its reasoning efforts
//   own xAI key (xai-…)            GET https://api.x.ai/v1/models, Authorization: Bearer <key>: every xAI model, so the
//                                  image and video ones, which a coding session cannot use, are left out
//
// The console never refreshes a login: that rotates its refresh token, which the person's sessions hold. A login whose
// `expires_at` has passed is not sent at all, and gives the person's last list read, or none, and says so. Nothing read
// here is logged but the login, the source, a status and a count: never a token, an email or a name from auth.json.

import agents from '../shared/agents.cjs';

const LOGIN_UPSTREAM = 'https://cli-chat-proxy.grok.com/v1';
const KEY_UPSTREAM = 'https://api.x.ai/v1';
const FRESH_MS = 10 * 60_000;
// After a failure, the next try waits this long, so a page open on New session does not ask xAI on every poll.
const RETRY_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MAX_MODELS = 40;
const MAX_BYTES = 2 * 1024 * 1024;
// A model whose id says it makes pictures or video: listed for a key, of no use to a coding session.
const NOT_FOR_CODE = /imagine|image|video/i;

const GROK = agents.agent('grok');

/**
 * The model's efforts as Grok Build's `--effort` takes them, kept to the registry's list (sessions.mjs checks a start
 * against it): an entry's `value`, else its `id`.
 * @returns {{efforts: string[]|null, defaultEffort: string|null}}  efforts null: the answer said nothing of them, so
 *   the page offers the registry's
 */
function effortsOf(m) {
  if (m.supports_reasoning_effort === false) return { efforts: [], defaultEffort: null };
  if (!Array.isArray(m.reasoning_efforts)) return { efforts: null, defaultEffort: null };
  const allowed = (GROK.efforts ?? []).filter(Boolean);
  const named = (r) => [r?.value, r?.id].find((v) => typeof v === 'string' && allowed.includes(v)) ?? null;
  const efforts = [];
  let defaultEffort = null;
  for (const r of m.reasoning_efforts) {
    const e = named(r);
    if (!e || efforts.includes(e)) continue;
    efforts.push(e);
    if (r.default === true) defaultEffort = e;
  }
  if (!defaultEffort && efforts.includes(m.reasoning_effort)) defaultEffort = m.reasoning_effort;
  return { efforts, defaultEffort };
}

/**
 * The models an answer lists, in its own order. Anything that is not a model name Grok Build's `--model` takes is left
 * out, since it ends up on the command line, and so is every image or video model.
 * @param {unknown} body  `{data: [{id, name?, description?, supports_reasoning_effort?, reasoning_effort?,
 *   reasoning_efforts?: [{id, value, label, description, default}]}]}`
 * @returns {{slug: string, name: string, description: string, efforts: string[]|null, defaultEffort: string|null}[]}
 */
export function modelsFrom(body) {
  const listed = Array.isArray(body?.data) ? body.data : [];
  const seen = new Set();
  return listed
    .filter((m) => m && typeof m.id === 'string' && agents.modelShapeOk('grok', m.id) && !NOT_FOR_CODE.test(m.id)
      && !seen.has(m.id) && seen.add(m.id))
    .slice(0, MAX_MODELS)
    .map((m) => ({
      slug: m.id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 60) : m.id,
      description: typeof m.description === 'string' ? m.description.trim().slice(0, 200) : '',
      ...effortsOf(m),
    }));
}

/**
 * How a saved Grok sign-in reaches a catalog: where, its header, and which kind it is.
 * @param {string} saved  an `xai-` key, or the JSON of ~/.grok/auth.json (checkSignIn in shared/agents.cjs)
 * @returns {{url: string, base: string, authorization: string, source: 'login'|'key'}|{expired: true}|null}  null:
 *   nothing usable. `base` is the API the sign-in calls, under which `url` is the model list: a review's grok reaches it
 *   through the console (reviewAgentProxy.mjs)
 */
export function credentialOf(saved, now = Date.now(), { loginUpstream = LOGIN_UPSTREAM, keyUpstream = KEY_UPSTREAM } = {}) {
  if (typeof saved !== 'string' || !saved) return null;
  const key = (k) => ({ url: `${keyUpstream}/models`, base: keyUpstream, authorization: `Bearer ${k}`, source: 'key' });
  if (!saved.startsWith('{')) return key(saved);
  let auth;
  try {
    auth = JSON.parse(saved);
  } catch {
    return null;
  }
  if (!auth || typeof auth !== 'object') return null;
  // The login's entry is keyed `https://auth.x.ai::<…>`; any other entry with a key is read the same way after it.
  const entries = Object.entries(auth).filter(([, e]) => e && typeof e === 'object' && typeof e.key === 'string' && e.key);
  const [, entry] = entries.find(([scope]) => scope.startsWith('https://auth.x.ai::')) ?? entries[0] ?? [];
  if (!entry) return null;
  if (entry.key.startsWith('xai-') && !entry.refresh_token) return key(entry.key);
  let expiresAt = null;
  if (typeof entry.expires_at === 'string') {
    const at = Date.parse(entry.expires_at);
    if (!Number.isFinite(at) || at <= now) return { expired: true };
    expiresAt = at;
  }
  // `expiresAt` null: the login says nothing of when it ends, which the catalog tries anyway, and a review never does.
  return { url: `${loginUpstream}/models`, base: loginUpstream, authorization: `Bearer ${entry.key}`, source: 'login', expiresAt };
}

/**
 * @param {{userSettings?: {agentAuth: (login: string, id: string) => Promise<string|null>}|null,
 *          fetch?: typeof fetch, loginUpstream?: string, keyUpstream?: string, now?: () => number}} opts
 * @returns {{list: (login: string) => Promise<GrokCatalog>, forget: (login: string) => void}}
 *
 * @typedef {{models: ReturnType<typeof modelsFrom>, source: 'login'|'key'|null, note: string|null}} GrokCatalog
 *   `source` says which kind of sign-in read it; `note` says why the list is not a fresh one, or why there is none
 */
// The errors this module throws itself, whose messages hold nothing of the person's.
const OWN_MESSAGES = new Set(['the catalog is too large', 'the answer is not JSON']);

export function createGrokModels({ userSettings = null, fetch: fetchImpl = globalThis.fetch, loginUpstream = LOGIN_UPSTREAM, keyUpstream = KEY_UPSTREAM, now = Date.now } = {}) {
  // By login: the last list read, when, and the last failed try.
  const kept = new Map();
  const reading = new Map();

  async function read(login) {
    let saved;
    try {
      saved = userSettings ? await userSettings.agentAuth(login, 'grok') : null;
    } catch (err) {
      console.warn('grokModels: credential not read', { login, message: err?.message });
      return { failed: 'the console could not read your Grok Build sign-in' };
    }
    if (!saved) return { failed: 'no Grok Build sign-in is saved' };
    const cred = credentialOf(saved, now(), { loginUpstream, keyUpstream });
    if (!cred) return { failed: 'your saved Grok Build sign-in has no token' };
    // A token with anything but a header's printable characters (a line break in a pasted file) is never sent: fetch
    // would refuse it in an error that quotes it.
    if (cred.authorization && !/^[\x21-\x7e]+ [\x21-\x7e]+$/.test(cred.authorization)) {
      console.warn('grokModels: catalog not read', { login, source: cred.source, message: 'the token is not one a header can carry' });
      return { failed: 'your saved Grok Build sign-in has a token that cannot be sent: save it again' };
    }
    if (cred.expired) {
      console.log('grokModels: own login expired, not read', { login });
      return { failed: 'your saved Grok Build login has expired: a Grok session refreshes it when it stops, or save a new one' };
    }
    try {
      const answer = await fetchImpl(cred.url, {
        headers: { authorization: cred.authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!answer.ok) {
        console.warn('grokModels: xAI refused the catalog', { login, source: cred.source, status: answer.status });
        return { failed: `xAI answered ${answer.status}` };
      }
      if (Number(answer.headers?.get?.('content-length')) > MAX_BYTES) throw new Error('the catalog is too large');
      const text = await answer.text();
      if (text.length > MAX_BYTES) throw new Error('the catalog is too large');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // JSON.parse's own message quotes the answer, which is not logged.
        throw new Error('the answer is not JSON');
      }
      const models = modelsFrom(body);
      if (!models.length) {
        console.warn('grokModels: the catalog listed no models', { login, source: cred.source });
        return { failed: 'xAI listed no models' };
      }
      console.log('grokModels: catalog read', { login, source: cred.source, models: models.length });
      return { models, source: cred.source };
    } catch (err) {
      // Only this module's own messages are logged: another's (fetch's, a socket's) can quote what was sent.
      const message = err?.name === 'TimeoutError' ? 'timed out' : OWN_MESSAGES.has(err?.message) ? err.message : (err?.name || 'Error');
      console.warn('grokModels: catalog not read', { login, source: cred.source, message });
      return { failed: 'xAI could not be reached' };
    }
  }

  /** @returns {Promise<GrokCatalog>} */
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
    return { models: [], source: null, note: `type a model name, since ${entry?.why ?? 'the list was not read'}` };
  }

  /** Drops the person's kept list, after their Grok sign-in changed. */
  function forget(login) {
    kept.delete(login);
    reading.delete(login);
  }

  return { list, forget };
}
