// One console process for many orgs: a hosted service runs this, and each org (a tenant) gets an installation of its
// own (installation.mjs), built from the settings and services the host gives for it, with its own loops. The servers
// are shared: the console's (pages, API, websockets, session apps) and the session API's. docs/hosting.md is the
// contract, the threat model and how to run two tenants on a laptop; a self-hosted console is the single-tenant case
// of the same installation (server.mjs, startConsole).
//
// A request is the tenant's the host says it is, never the URL's: the paths are a single console's. `identify(req)`
// names the person, their role and their current tenant, and the request goes to that tenant's installation as the
// person, the way a trusted proxy's header does on a single console (trustedIdentity.mjs). A session's app, on its
// own name, is its session's tenant's, and is open to the person only when they are a member there. A session's
// calls to the session API are its tenant's by the session's own token. Nothing about one tenant is reachable from
// another's installation: each has its own state, secrets, homes, launcher and GitHub access.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { isKnownHost } from '../shared/sameOrigin.mjs';
import { createAnthropicProxy } from './anthropicProxy.mjs';
import { appIdFor } from './appProxy.mjs';
import { safeNext } from './auth.mjs';
import { tenantConfig } from './config.mjs';
import { CONNECTION_PATH } from './dbTunnel.mjs';
import { checkGh } from './github.mjs';
import { toMessage } from './githubEvents.mjs';
import { createInstallation } from './installation.mjs';
import { createOpenAiProxy } from './openaiProxy.mjs';
import { TENANT_ID_RE, knownHosts, servePublic } from './server.mjs';
import { createSessionApi, sessionTokenOf } from './sessionApi.mjs';
import { newSessionId } from './sessions.mjs';
import { openServiceStore } from './store.mjs';
import { installTenantLog, runAs } from './tenantLog.mjs';
import { startTlsAsk } from './tlsAsk.mjs';
import { ROLES } from './trustedIdentity.mjs';

// Where, on the request, the installation finds who is asking: never a header, so nothing the console proxies on to a
// session carries it, and nothing a browser sends can set it.
const TENANT_USER = Symbol('woodshed.tenantUser');
const TENANT_IDENTITY = Symbol('woodshed.tenantIdentity');
// GitHub's rule for a handle, lowercase, as the host sends it (trustedIdentity.mjs).
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const SESSION_PAGE_RE = /^\/s\/([0-9a-f]{8})$/;
const TUNNEL_RE = /^\/api\/tunnel\/(pg|mongo)$/;
const MAX_NAME_CHARS = 100;

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}

function isPage(req, url) {
  return req.method === 'GET' && !url.pathname.startsWith('/api/') && String(req.headers.accept || '').includes('text/html');
}

// A link the host gives for the menu goes into an href: its own pages, on the web or the console's name, nothing else.
function safeHref(href) {
  if (typeof href !== 'string' || href.length > 2000) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}

/**
 * @param {unknown} identity  what `tenancy.identify` answered
 * @returns {{login: string, role: 'owner'|'member', tenantId: string, tenants: {id: string, name: string, role: string}[]}|null}
 *   the identity, or null when it is not one: the person is then not signed in
 */
export function checkIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const { login, role, tenantId } = identity;
  if (typeof login !== 'string' || !LOGIN_RE.test(login) || !ROLES.includes(role) || typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) return null;
  const tenants = (Array.isArray(identity.tenants) ? identity.tenants : [])
    .filter((t) => t && typeof t.id === 'string' && TENANT_ID_RE.test(t.id) && ROLES.includes(t.role))
    .map((t) => ({ id: t.id, name: String(t.name ?? t.id).slice(0, MAX_NAME_CHARS), role: t.role }));
  // The current tenant is one of theirs, whatever the list says.
  if (!tenants.some((t) => t.id === tenantId)) tenants.unshift({ id: tenantId, name: tenantId, role });
  return { login, role, tenantId, tenants };
}

/** @returns {{login: string, role: string}|null}  the person as `tenantId` knows them: null where they are no member */
function userIn(identity, tenantId) {
  if (!identity) return null;
  if (identity.tenantId === tenantId) return { login: identity.login, role: identity.role };
  const entry = identity.tenants.find((t) => t.id === tenantId);
  return entry ? { login: identity.login, role: entry.role } : null;
}

function asUser(req, user, identity) {
  Object.defineProperty(req.headers, TENANT_USER, { value: user, enumerable: false, configurable: true });
  Object.defineProperty(req.headers, TENANT_IDENTITY, { value: identity, enumerable: false, configurable: true });
}

/**
 * @param {unknown} tenant  one of `tenancy.tenants()`
 * @throws {Error}  naming what is missing, so a bad tenant is refused before anything is built for it
 */
function checkTenant(tenant) {
  if (!tenant || typeof tenant !== 'object') throw new Error('a tenant must be an object');
  if (typeof tenant.id !== 'string' || !TENANT_ID_RE.test(tenant.id)) throw new Error('a tenant\'s id must be lowercase letters, digits and dashes');
  const s = tenant.services ?? {};
  if (typeof s.store?.load !== 'function' || typeof s.store?.save !== 'function') throw new Error('services.store needs load and save');
  if (typeof s.github?.token !== 'function') throw new Error('services.github needs token');
  if (typeof s.launcher?.start !== 'function') throw new Error('services.launcher is not a launcher');
}

/**
 * Starts one console process serving every tenant `tenancy` names. docs/hosting.md is the contract.
 * @param {{config: {host: string, port: number, publicUrl: string, appDomain?: string, sessionApi: {host: string, port: number},
 *          tlsAskPort?: number|null, stateDir?: string}, tenancy: object, log?: object|null}} args
 *   `log` is where every line goes, with `tenant` added (console's own methods without it); `config.stateDir` is where
 *   each tenant's files are kept (attachments, restores, the webhook events log), in a folder per tenant
 * @returns {Promise<{server: http.Server, sessionApiServer: http.Server,
 *   dispatchGitHub: (tenantId: string, event: {event: string, deliveryId?: string, payload: object}) => Promise<boolean>,
 *   reload: (tenantId: string) => Promise<void>, remove: (tenantId: string) => Promise<void>, close: () => Promise<void>}>}
 */
export async function startMultiTenantConsole({ config, tenancy, log = null }) {
  for (const name of ['tenants', 'identify', 'signInUrl', 'switchUrl']) {
    if (typeof tenancy?.[name] !== 'function') throw new Error(`tenancy.${name} must be a function`);
  }
  if (!config?.publicUrl || !config.sessionApi?.host || !config.sessionApi?.port) throw new Error('config needs publicUrl and sessionApi: {host, port}');
  const process_ = { ...config, publicUrl: String(config.publicUrl).replace(/\/+$/, ''), appDomain: String(config.appDomain ?? '').trim().toLowerCase(), extraHosts: [] };
  const stateRoot = config.stateDir ?? path.join(os.tmpdir(), 'woodshed-tenants');
  const uninstallLog = installTenantLog({ sink: log });
  // One tenant's bug that leaves a promise unhandled must not end every tenant's console.
  const onUnhandled = (reason) => console.error('console: unhandled rejection', { message: firstLine(reason) });
  process.on('unhandledRejection', onUnhandled);
  await checkGh();

  const hosts = knownHosts(process_);
  /** @type {Map<string, {id: string, name: string, inst: object, store: object, sessionApiHost: string|null}>} */
  const tenants = new Map();
  // What each tenant is doing now (a reload, a remove), so two never overlap for the same one.
  const changing = new Map();
  // Why a tenant the host named is not running, for the page its people get instead.
  const broken = new Map();

  // A session id is its app's name, so it is unique across every tenant: not only within one.
  function newId() {
    for (;;) {
      const id = newSessionId();
      if (!ownerOf(id)) return id;
    }
  }

  function ownerOf(sessionId) {
    for (const entry of tenants.values()) if (entry.inst.fleet.find(sessionId)) return entry;
    return null;
  }

  function hostingFor(tenant) {
    return {
      me(headers) {
        const identity = headers[TENANT_IDENTITY];
        if (!identity) return {};
        let links = [];
        try {
          links = (tenancy.menuLinks?.(identity) ?? []).map((l) => ({ label: String(l?.label ?? '').slice(0, MAX_NAME_CHARS), href: safeHref(l?.href) })).filter((l) => l.label && l.href);
        } catch (err) {
          console.warn('hosted: menu links not given', { message: firstLine(err) });
        }
        const orgs = identity.tenants.map((t) => ({
          id: t.id, name: t.name, role: t.role, current: t.id === tenant.id,
          href: t.id === tenant.id ? null : safeHref(tenancy.switchUrl(t.id, '/')),
        }));
        return { org: { id: tenant.id, name: String(tenant.name ?? tenant.id).slice(0, MAX_NAME_CHARS) }, orgs, hostLinks: links };
      },
    };
  }

  async function build(tenant) {
    checkTenant(tenant);
    const { services } = tenant;
    const stateDir = path.join(stateRoot, tenant.id);
    const tconfig = tenantConfig({
      process: process_, tenant, stateDir, projectFilesDir: services.projectFiles?.dir ?? null, githubSource: services.github,
      launcherKind: services.launcher.kind ?? 'docker',
    });
    const store = await openServiceStore(services.store);
    const clash = store.state.sessions.filter((s) => ownerOf(s.id)).map((s) => s.id);
    if (clash.length) console.warn('hosted: session ids another tenant has too, their apps go to the other', { count: clash.length });
    let inst;
    try {
      inst = await createInstallation({
        config: tconfig,
        store,
        provider: {
          name: null, words: services.words ?? null, launcher: services.launcher, secrets: services.secrets ?? null, homes: services.homes ?? null,
          dbAdmin: services.dbAdmin ?? null, databases: services.dbAdmin ? (services.databases ?? []) : [], webhookUrl: null,
        },
        trusted: { userFor: (headers) => headers?.[TENANT_USER] ?? null },
        hosting: hostingFor(tenant),
        newId,
      });
    } catch (err) {
      await store.close();
      throw err;
    }
    inst.start({ hostWebhooks: true });
    const sessionApiHost = tconfig.sessionApiUrl ? new URL(tconfig.sessionApiUrl).host.toLowerCase() : null;
    console.log('hosted: tenant running', { name: String(tenant.name ?? '').slice(0, MAX_NAME_CHARS), sessionApi: tconfig.sessionApiUrl, ...inst.summary() });
    return { id: tenant.id, name: tenant.name ?? tenant.id, inst, store, sessionApiHost };
  }

  async function stopEntry(entry) {
    entry.inst.stop();
    await entry.store.close();
  }

  async function startTenant(tenant) {
    try {
      const entry = await runAs(tenant.id, () => build(tenant));
      tenants.set(tenant.id, entry);
      broken.delete(tenant.id);
    } catch (err) {
      broken.set(tenant.id, firstLine(err));
      runAs(typeof tenant?.id === 'string' ? tenant.id : null, () => console.error('hosted: tenant not started', { message: firstLine(err) }));
    }
  }

  function serially(tenantId, work) {
    const before = changing.get(tenantId) ?? Promise.resolve();
    const run = before.catch(() => {}).then(work);
    changing.set(tenantId, run);
    return run.finally(() => { if (changing.get(tenantId) === run) changing.delete(tenantId); });
  }

  async function reload(tenantId) {
    return serially(tenantId, async () => {
      const tenant = (await tenancy.tenants()).find((t) => t?.id === tenantId);
      if (!tenant) throw new Error(`tenancy.tenants() has no tenant ${tenantId}`);
      const old = tenants.get(tenantId);
      tenants.delete(tenantId);
      if (old) await runAs(tenantId, () => stopEntry(old));
      runAs(tenantId, () => console.log('hosted: tenant reloading', { was: Boolean(old) }));
      await startTenant(tenant);
      if (!tenants.has(tenantId)) throw new Error(`tenant ${tenantId} did not start: ${broken.get(tenantId)}`);
    });
  }

  async function remove(tenantId) {
    return serially(tenantId, async () => {
      const entry = tenants.get(tenantId);
      tenants.delete(tenantId);
      broken.delete(tenantId);
      if (!entry) return;
      await runAs(tenantId, async () => {
        await stopEntry(entry);
        console.log('hosted: tenant removed');
      });
    });
  }

  async function dispatchGitHub(tenantId, { event, deliveryId = '', payload } = {}) {
    const entry = tenants.get(tenantId);
    if (!entry) throw new Error(`no running tenant ${tenantId}`);
    return runAs(tenantId, async () => {
      const message = toMessage(event, payload, { deliveryId, receivedAt: new Date().toISOString() });
      if (!message) {
        console.log('webhooks: ignored', { event, action: payload?.action ?? null, delivery: deliveryId || null });
        return true;
      }
      return entry.inst.dispatchWebhook({ text: JSON.stringify(message), id: deliveryId || null });
    });
  }

  // The host's answer, or null when it has none or fails: a failure is the host's, said as such, never a sign-in.
  async function identify(req) {
    let given;
    try {
      given = await tenancy.identify(req);
    } catch (err) {
      console.error('hosted: identify failed', { message: firstLine(err) });
      throw Object.assign(new Error('identify failed'), { hostFailed: true });
    }
    if (given === null || given === undefined) return null;
    const identity = checkIdentity(given);
    if (!identity) console.warn('hosted: identify gave something that is not an identity, treated as signed out');
    return identity;
  }

  function notRunning(req, res, url, tenantId) {
    runAs(tenantId, () => console.warn('hosted: request for a tenant that is not running', { path: url.pathname, why: broken.get(tenantId) ?? 'not loaded' }));
    if (isPage(req, url)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><title>Not available</title><body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem"><h1 style="font-size: 1.4rem">This org\'s console is not running right now</h1><p>Try again in a minute.</p>');
    }
    return reply(res, 503, { error: 'this org\'s console is not running right now' });
  }

  // Where a signed-in person's request goes: their current tenant, unless the link names another of theirs.
  function routeFor(req, url, identity) {
    if (req.method === 'GET' && isPage(req, url)) {
      const org = url.searchParams.get('org');
      if (org && org !== identity.tenantId && userIn(identity, org)) return { switchTo: org };
      const page = SESSION_PAGE_RE.exec(url.pathname);
      const current = tenants.get(identity.tenantId);
      if (page && !current?.inst.fleet.find(page[1])) {
        const owner = ownerOf(page[1]);
        if (owner && userIn(identity, owner.id)) return { switchTo: owner.id };
      }
    }
    // Signing in to a session's app is the app's tenant's, which needs no switch: the app is open to its members.
    if (url.pathname === '/auth/app') {
      const owner = ownerOf(url.searchParams.get('id') || '');
      if (owner && userIn(identity, owner.id)) return { tenantId: owner.id };
    }
    return { tenantId: identity.tenantId };
  }

  async function onAppRequest(req, res, appId) {
    const entry = ownerOf(appId);
    if (!entry) return reply(res, 404, { error: 'no such app' });
    let identity;
    try {
      identity = await identify(req);
    } catch {
      return reply(res, 503, { error: 'sign-in is not available right now: try again in a moment' });
    }
    asUser(req, userIn(identity, entry.id), identity);
    return runAs(entry.id, () => entry.inst.handle(req, res));
  }

  async function onRequest(req, res) {
    const appId = appIdFor(req.headers.host, process_.appDomain);
    if (appId) return onAppRequest(req, res, appId);
    if (!isKnownHost(req.headers.host, hosts)) {
      console.warn('console: unknown host refused', { host: String(req.headers.host).slice(0, 100) });
      return reply(res, 421, { error: 'unknown host' });
    }
    const url = new URL(req.url || '/', 'http://console.invalid');
    if (url.pathname === '/healthz') return reply(res, 200, { ok: true, tenants: tenants.size });
    if (servePublic(req, res, url)) return;
    // woodshed-db.mjs has no sign-in: its token is its tenant's.
    if (url.pathname === CONNECTION_PATH) {
      const entry = [...tenants.values()].find((e) => e.inst.tunnel.owns(req.headers));
      if (!entry) return reply(res, 401, { error: 'the token is wrong or has expired: make a new one on My settings' });
      return runAs(entry.id, () => entry.inst.handle(req, res));
    }
    let identity;
    try {
      identity = await identify(req);
    } catch {
      return reply(res, 503, { error: 'sign-in is not available right now: try again in a moment' });
    }
    if (!identity) {
      if (url.pathname === '/api/me') return reply(res, 200, { supported: true, signIn: true, available: true, hosted: true, login: null, visitor: null, asked: null, admin: false, asking: 0, names: {}, repo: null, workflows: [] });
      if (isPage(req, url) || url.pathname === '/login') return redirect(res, tenancy.signInUrl(req));
      return reply(res, 401, { error: 'sign in first' });
    }
    if (url.pathname === '/login') return redirect(res, safeNext(url.searchParams.get('next')));
    const route = routeFor(req, url, identity);
    if (route.switchTo) {
      runAs(route.switchTo, () => console.log('hosted: switching org for a link', { login: identity.login, from: identity.tenantId, path: url.pathname }));
      return redirect(res, tenancy.switchUrl(route.switchTo, `${url.pathname}${url.search}`));
    }
    const entry = tenants.get(route.tenantId);
    if (!entry) return notRunning(req, res, url, route.tenantId);
    asUser(req, userIn(identity, entry.id), identity);
    return runAs(entry.id, () => entry.inst.handle(req, res));
  }

  async function onUpgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    const appId = appIdFor(req.headers.host, process_.appDomain);
    let entry;
    let identity = null;
    try {
      if (appId) {
        entry = ownerOf(appId);
        if (entry) identity = await identify(req);
      } else if (TUNNEL_RE.test(String(req.url || '/').split('?')[0])) {
        entry = [...tenants.values()].find((e) => e.inst.tunnel.owns(req.headers));
      } else {
        identity = await identify(req);
        entry = identity ? tenants.get(identity.tenantId) : null;
      }
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    if (!entry) {
      console.warn('hosted: websocket refused, no tenant for it', { app: Boolean(appId), signedIn: Boolean(identity) });
      socket.end(`HTTP/1.1 ${identity || appId ? '404 Not Found' : '401 Unauthorized'}\r\n\r\n`);
      return;
    }
    asUser(req, userIn(identity, entry.id), identity);
    runAs(entry.id, () => entry.inst.upgrade(req, socket, head));
  }

  // The standard refusals for a token no tenant has: the same answers a single console gives.
  const nobody = createSessionApi({ fleet: { sessions: () => [] }, tokens: null, anthropic: createAnthropicProxy({}), openai: createOpenAiProxy({}) });

  async function onSessionApi(req, res) {
    const token = sessionTokenOf(req);
    const entry = token ? [...tenants.values()].find((e) => e.inst.ownsSessionToken(token)) : null;
    if (!entry) return nobody(req, res);
    // A tenant's sessions reach the session API at the address the host gave that tenant, and nowhere else.
    if (entry.sessionApiHost && String(req.headers.host ?? '').toLowerCase() !== entry.sessionApiHost) {
      runAs(entry.id, () => console.warn('sessionApi: refused, the session called another tenant\'s address', { host: String(req.headers.host ?? '').slice(0, 100) }));
      req.resume();
      return reply(res, 401, { error: 'unauthorized' });
    }
    return runAs(entry.id, () => entry.inst.sessionApi(req, res));
  }

  for (const tenant of await tenancy.tenants()) {
    if (tenants.has(tenant?.id)) {
      console.error('hosted: two tenants with one id, the second not started', { id: String(tenant.id).slice(0, 64) });
      continue;
    }
    await startTenant(tenant);
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('console: request failed', { url: req.url, message: err?.message });
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = 60 * 60_000;
  server.on('upgrade', (req, socket, head) => {
    onUpgrade(req, socket, head).catch((err) => {
      console.error('console: websocket failed', { message: err?.message });
      socket.destroy();
    });
  });
  const sessionApiServer = http.createServer((req, res) => {
    onSessionApi(req, res).catch((err) => {
      console.error('sessionApi: request failed', { message: err?.message });
      if (!res.headersSent) reply(res, 502, { error: 'could not get a GitHub token' });
    });
  });
  const listen = (srv, port, host) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => {
      srv.off('error', reject);
      resolve();
    });
  });
  await listen(server, config.port ?? 7690, config.host ?? '127.0.0.1');
  await listen(sessionApiServer, config.sessionApi.port, config.sessionApi.host);
  const tlsAsk = await startTlsAsk({
    config: { tlsAskPort: config.tlsAskPort ?? null, publicUrl: process_.publicUrl, extraHosts: [], appDomain: process_.appDomain },
    sessions: () => [...tenants.values()].flatMap((e) => e.inst.fleet.sessions()),
  });
  console.log('console: multi-tenant console listening', {
    host: config.host, port: server.address().port, sessionApi: { host: config.sessionApi.host, port: sessionApiServer.address().port },
    tenants: tenants.size, notStarted: broken.size,
  });

  async function close() {
    for (const [id, entry] of tenants) await runAs(id, () => stopEntry(entry));
    tenants.clear();
    const closing = [server, sessionApiServer, tlsAsk].filter(Boolean).map((srv) => new Promise((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    }));
    await Promise.all(closing);
    process.off('unhandledRejection', onUnhandled);
    console.log('console: multi-tenant console closed');
    uninstallLog();
  }

  return { server, sessionApiServer, dispatchGitHub, reload, remove, close };
}
