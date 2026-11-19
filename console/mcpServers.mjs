// The MCP servers this console hands its sessions' claude, every one reached through the console's relay
// (mcpRelay.mjs), so no session ever holds what a server takes to let it in. Admins keep the list on the Console
// settings page, or through the same API (server.mjs, /api/console-settings/mcp-servers); an embedding program can
// keep it itself (README.md, "Embedding the console", `mcpServers`).
//
// Two kinds:
//   ordinary     a tool the team shares (an issue tracker, docs, an error tracker's read API). Handed to the sessions it
//                names; its calls go on as they come, with what the console adds to them (`auth`).
//   production   one that reads production data, such as woodshed-prod-mcp. Only a My Woodshed session running claude,
//                of a person and repo it names, gets it, turned off until its person turns it on; the first relayed
//                call taints the session, which is locked down outside its container before the call goes on (fleet's
//                taint). Offered only where the launcher can lock a session down (`lockdown`).
//
// What the console adds to each relayed call (`auth`):
//   oidc     a five-minute token the console signs as its OpenID Connect issuer (oidcIssuer.mjs) for `audience`
//   header   a header whose value is a secret only the console reads (`mcp-servers/<name>/header`), never shown again
//   none     nothing
//
// The installation's environment may name one production server too (WOODSHED_PROD_MCP_URL, Terraform's prod_mcp):
// listed as `woodshed-prod`, `source: environment`, and changed only where it is set.

import { issuerFrom } from './oidcIssuer.mjs';
import { isAsk, isQa, isReview } from './sessions.mjs';

export const ENVIRONMENT_SERVER_NAME = 'woodshed-prod';
export const PROD_MCP_AUDIENCE = 'woodshed-prod-mcp';
// After this long stopped, a tainted session is removed, and with it everything it kept (fleet.mjs, removeTainted).
export const DEFAULT_TAINTED_REMOVE_HOURS = 24;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
// Headers the relay sets or drops itself, so a server's own may not be one of them.
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'cookie']);
const AUTHS = new Set(['none', 'oidc', 'header']);
const MAX_SERVERS = 50;
const MAX_HEADER_BYTES = 8 * 1024;

const shown = (message, status = 400) => Object.assign(new Error(message), { shown: true, status });

/** @returns {string}  the secret holding a server's header value */
export const headerSecretName = (name) => `mcp-servers/${name}/header`;

// `*` for anyone or any repo, otherwise a list, compared without case. Empty is nobody.
function listOf(value) {
  if (value === '*' || (Array.isArray(value) && value.length === 1 && value[0] === '*')) return '*';
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(items.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

function inList(list, value) {
  return list === '*' || Boolean(value && list.includes(String(value).toLowerCase()));
}

function checkUrl(raw, what) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw shown(`${what} is not a URL`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw shown(`${what} must be an http(s) URL with no credentials in it`);
  return url.toString().replace(/\/+$/, '');
}

/**
 * The server the installation's environment names (WOODSHED_PROD_MCP_URL), or null.
 * @param {NodeJS.ProcessEnv} env
 * @returns {object|null}
 */
export function environmentServer(env) {
  const raw = String(env.WOODSHED_PROD_MCP_URL ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = checkUrl(raw, 'WOODSHED_PROD_MCP_URL');
  } catch (err) {
    throw new Error(err.message);
  }
  return {
    name: ENVIRONMENT_SERVER_NAME, url, production: true, shared: false,
    people: listOf(env.WOODSHED_PROD_MCP_PEOPLE), repos: listOf(env.WOODSHED_PROD_MCP_REPOS),
    auth: 'oidc', audience: PROD_MCP_AUDIENCE, header: null, source: 'environment',
  };
}

/**
 * What the environment says of MCP servers and the issuer: loadConfig's `mcp`.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} publicUrl  the console's, the issuer unless WOODSHED_OIDC_ISSUER says otherwise
 * @returns {{environment: object|null, issuer: string, taintedRemoveAfterMs: number}}
 */
export function mcpSettings(env, publicUrl) {
  const hours = Number(env.WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS ?? DEFAULT_TAINTED_REMOVE_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS must be a number of hours above 0');
  return {
    environment: environmentServer(env),
    issuer: issuerFrom(env.WOODSHED_OIDC_ISSUER || publicUrl),
    taintedRemoveAfterMs: hours * 3_600_000,
  };
}

/**
 * A server as an admin or a program sent it, checked and in its stored shape.
 * @param {object} input
 * @returns {object}
 * @throws {Error}  shown, with what is wrong
 */
export function checkServer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw shown('server must be an object');
  const name = String(input.name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw shown('name must be lowercase letters, digits and dashes, at most 40, such as sentry or linear');
  if (name === ENVIRONMENT_SERVER_NAME) throw shown(`${ENVIRONMENT_SERVER_NAME} is the name of the server the installation's environment sets`);
  const url = checkUrl(input.url, 'url');
  const production = input.production === true;
  const shared = !production && input.shared === true;
  const people = listOf(input.people ?? '*');
  const repos = listOf(input.repos ?? '*');
  if (people !== '*' && people.some((p) => !LOGIN_RE.test(p))) throw shown('people must be GitHub logins, or * for everyone');
  if (repos !== '*' && repos.some((r) => !REPO_RE.test(r))) throw shown('repos must be owner/name, or * for every repo');
  if (production && (people !== '*' && !people.length)) throw shown('a production server needs at least one person, or * for everyone');
  const auth = String(input.auth ?? (production ? 'oidc' : 'none'));
  if (!AUTHS.has(auth)) throw shown('auth must be none, oidc or header');
  const audience = auth === 'oidc' ? String(input.audience ?? '').trim() || (production ? PROD_MCP_AUDIENCE : name) : null;
  if (audience && (audience.length > 200 || /\s/.test(audience))) throw shown('audience must be one word, at most 200 characters');
  const header = auth === 'header' ? String(input.header ?? '').trim().toLowerCase() || 'authorization' : null;
  if (header && (!HEADER_RE.test(header) || RESERVED_HEADERS.has(header))) throw shown(`header cannot be ${header}`);
  return { name, url, production, shared, people, repos, auth, audience, header };
}

/**
 * Which sessions get a server. Decided from the session and the server alone, so the fleet asks it at launch (to hand
 * the session its servers, and on AWS a guarded network) and the relay at every call.
 * @param {object} server
 * @param {object} session
 * @param {string|null} repo  the session's project's repo, owner/name
 * @returns {{ok: true}|{ok: false, why: string}}
 */
export function serverEligibility(server, session, repo) {
  if (session?.options?.agent === 'codex') return { ok: false, why: 'a Codex session gets no MCP servers from the console yet' };
  if (isQa(session) || isReview(session)) return { ok: false, why: 'a QA run or a review gets no MCP servers from the console' };
  const isPrivate = Boolean(session?.owner) && !isAsk(session);
  if (server.production) {
    if (!isPrivate) return { ok: false, why: 'only a My Woodshed session can use production access' };
    if (!inList(server.people, session.owner)) return { ok: false, why: `@${session.owner} is not allowed ${server.name} on this console` };
  } else if (isPrivate) {
    if (!inList(server.people, session.owner)) return { ok: false, why: `@${session.owner} is not allowed ${server.name} on this console` };
  } else if (!server.shared) {
    return { ok: false, why: `${server.name} is for My Woodshed sessions only` };
  }
  if (!inList(server.repos, repo)) return { ok: false, why: `${repo ?? 'this repo'} is not allowed ${server.name} on this console` };
  if (session?.taintedAt && !server.production) return { ok: false, why: 'this session has seen production data, so only its production servers are open to it' };
  return { ok: true };
}

/**
 * @param {{store: {state: object, save: () => void}, settings: ReturnType<typeof mcpSettings>,
 *          secrets?: object|null, host?: {list: () => Promise<object[]>, save: Function, remove: Function}|null,
 *          lockdown?: () => {available: boolean, why: string|null}, now?: () => number}} deps
 *   `host` is an embedding program's mcpServers hook, which keeps the list instead of state.json. `lockdown` says
 *   whether this console can lock a session down, which a production server needs
 */
export function createMcpServers({ store, settings, secrets = null, host = null, lockdown = () => ({ available: false, why: 'no launcher' }), now = Date.now }) {
  // A store the console has, but no backend for yet (the local provider before one is chosen on the Secrets page).
  const keepsSecrets = () => Boolean(secrets) && secrets.configured?.() !== false;
  // The program's list, read at start and after each of its changes; null without a program.
  let hosted = null;

  const kept = () => (host ? hosted ?? [] : Array.isArray(store.state.mcpServers) ? store.state.mcpServers : []);

  /** @returns {object[]}  every server, the environment's first */
  function list() {
    const own = kept().map((s) => ({ ...s, source: host ? 'host' : 'console' }));
    return settings.environment ? [settings.environment, ...own] : own;
  }

  const get = (name) => list().find((s) => s.name === name) ?? null;

  /**
   * @returns {{name: string, production: boolean}[]}  the servers a session gets, for its environment
   *   (WOODSHED_MCP_SERVERS); a tainted session only its production ones
   */
  function forSession(session, repo) {
    // A production server only where a session can be locked down: its first call would be refused otherwise.
    const production = lockdown().available;
    return list().filter((s) => (production || !s.production) && serverEligibility(s, session, repo).ok).map((s) => ({ name: s.name, production: s.production }));
  }

  /** What the page and the API show: never a header's value. */
  function view() {
    const can = lockdown();
    return {
      servers: list().map((s) => ({
        name: s.name, url: s.url, production: s.production, shared: s.shared, people: s.people, repos: s.repos,
        auth: s.auth, audience: s.audience, header: s.header, headerSet: Boolean(s.headerSavedAt), source: s.source,
        updatedBy: s.updatedBy ?? null, updatedAt: s.updatedAt ?? null,
      })),
      production: { available: can.available, why: can.why ?? null },
      headers: keepsSecrets(),
      issuer: settings.issuer,
      jwks: `${settings.issuer}/.well-known/jwks.json`,
      editable: true,
    };
  }

  async function load() {
    if (!host) return;
    try {
      const found = await host.list();
      hosted = (Array.isArray(found) ? found : []).flatMap((s) => {
        try {
          return [{ ...checkServer(s), headerSavedAt: s.headerSavedAt ?? null }];
        } catch (err) {
          console.warn('mcpServers: a server from the program left out', { name: s?.name ?? null, why: err.message });
          return [];
        }
      });
    } catch (err) {
      console.warn('mcpServers: the program\'s list not read', { message: err?.message });
      if (err?.shown) throw err;
      throw shown('The MCP servers could not be read from the program that runs this console. Try again; the console log says why.', 503);
    }
  }

  function requireEditable(name) {
    if (name === ENVIRONMENT_SERVER_NAME && settings.environment) throw shown(`${name} is set by the installation's environment (WOODSHED_PROD_MCP_URL, or Terraform's prod_mcp), and is changed there`, 409);
  }

  /**
   * Adds a server, or replaces the one of that name.
   * @param {{server: object, by: string}} args
   * @returns {Promise<object>}  the server as kept
   */
  async function save({ server, by }) {
    const checked = checkServer(server);
    requireEditable(checked.name);
    const before = kept().find((s) => s.name === checked.name) ?? null;
    if (!before && kept().length >= MAX_SERVERS) throw shown(`a console keeps at most ${MAX_SERVERS} MCP servers`, 409);
    if (checked.production) {
      const can = lockdown();
      if (!can.available) throw shown(`A production server needs this console to lock a session down, and it cannot: ${can.why}`, 409);
    }
    if (checked.auth === 'header' && !keepsSecrets()) throw shown('this console has no secret store yet (Secrets & webhooks), so a server cannot have a header the console adds', 409);
    const record = {
      ...checked,
      // The header's value stays while the header's name does.
      headerSavedAt: checked.auth === 'header' && before?.header === checked.header ? before.headerSavedAt ?? null : null,
      updatedBy: by, updatedAt: new Date(now()).toISOString(),
    };
    if (before?.headerSavedAt && !record.headerSavedAt && secrets) await secrets.remove(headerSecretName(checked.name)).catch(() => {});
    if (host) {
      await host.save({ server: record, by });
      await load();
    } else {
      store.state.mcpServers = [...kept().filter((s) => s.name !== checked.name), record];
      store.save();
    }
    console.log(before ? 'mcpServers: server changed' : 'mcpServers: server added', {
      name: checked.name, host: new URL(checked.url).host, production: checked.production, shared: checked.shared,
      people: checked.people === '*' ? '*' : checked.people.length, repos: checked.repos, auth: checked.auth, by,
      ...(before && before.production !== checked.production && { productionWas: before.production }),
    });
    return record;
  }

  /** @param {{name: string, by: string}} args */
  async function remove({ name, by }) {
    const wanted = String(name ?? '').trim().toLowerCase();
    requireEditable(wanted);
    const before = kept().find((s) => s.name === wanted);
    if (!before) throw shown(`there is no MCP server called ${wanted}`, 404);
    if (secrets && before.headerSavedAt) await secrets.remove(headerSecretName(wanted)).catch((err) => console.warn('mcpServers: header not deleted', { name: wanted, message: err?.message }));
    if (host) {
      await host.remove({ name: wanted, by });
      await load();
    } else {
      store.state.mcpServers = kept().filter((s) => s.name !== wanted);
      store.save();
    }
    console.log('mcpServers: server removed', { name: wanted, by });
  }

  /**
   * Sets or clears the value of a server's header: write-only, held in the secret store.
   * @param {{name: string, value: string, by: string}} args
   */
  async function setHeader({ name, value, by }) {
    const wanted = String(name ?? '').trim().toLowerCase();
    requireEditable(wanted);
    const server = kept().find((s) => s.name === wanted);
    if (!server) throw shown(`there is no MCP server called ${wanted}`, 404);
    if (server.auth !== 'header') throw shown(`${wanted} adds no header: set its auth to header first`, 409);
    if (!keepsSecrets()) throw shown('this console has no secret store yet (Secrets & webhooks)', 409);
    const text = String(value ?? '').trim();
    if (Buffer.byteLength(text) > MAX_HEADER_BYTES) throw shown(`a header value is at most ${MAX_HEADER_BYTES / 1024} KB`);
    if (/[\r\n]/.test(text)) throw shown('a header value is one line');
    if (text) await secrets.save(headerSecretName(wanted), text, `Woodshed: the ${server.header} header the console adds to MCP server ${wanted}'s calls. Only the console reads it`);
    else await secrets.remove(headerSecretName(wanted));
    const record = { ...server, headerSavedAt: text ? new Date(now()).toISOString() : null, updatedBy: by, updatedAt: new Date(now()).toISOString() };
    if (host) {
      await host.save({ server: record, by });
      await load();
    } else {
      store.state.mcpServers = kept().map((s) => (s.name === wanted ? record : s));
      store.save();
    }
    console.log(text ? 'mcpServers: header saved' : 'mcpServers: header cleared', { name: wanted, header: server.header, by, ...(text && { bytes: Buffer.byteLength(text) }) });
  }

  /** @returns {Promise<string|null>}  a server's header value, for the relay */
  async function headerValue(server) {
    if (!secrets || !server.headerSavedAt) return null;
    return secrets.read(headerSecretName(server.name));
  }

  return { list, get, forSession, view, load, save, remove, setHeader, headerValue, settings };
}
