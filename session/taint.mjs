// A session's side of its taint (console/mcpRelay.mjs). The lockdown itself is outside the container: its network
// reaches only the console, which this cannot change. What this does is make the session work within it: every tool
// goes through the console's egress proxy (git, gh, curl, Node), trusting the proxy's own authority for GitHub, claude
// reopens on the console's Anthropic proxy with web search and fetch off, and the woodshed-prod MCP server is on.
//
//   node taint.mjs apply <egress.json>   a tainted session's start (session/entrypoint.sh): writes the marker, the
//                                        egress variables and the CA bundle from the session API's /egress answer
//   node taint.mjs proxy <proxy URL>     a guarded session's start (AWS): its egress variables, no CA, no marker
//   node taint.mjs mcp-config            claude's --mcp-config from WOODSHED_MCP_SERVERS (console/mcpServers.mjs): each
//                                        server at the console's relay, the production ones off in /mcp until the
//                                        person turns one on, and only those in a tainted session
//
// statusd calls applyTaint when the console tells it the session was tainted (POST /taint).

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMain } from '../shared/isMain.mjs';

export const TAINT_MARKER = '/tmp/woodshed-tainted';
// Written once the session's side of the taint is all in place (statusd's POST /taint): the marker alone says only that
// it began, so a notice after a setup that failed partway finishes it rather than answering that it was done.
export const TAINT_SET_UP = '/tmp/woodshed-taint-set-up';
export const EGRESS_ENV_FILE = '/tmp/woodshed-egress.env';
export const EGRESS_CA_BUNDLE = '/tmp/woodshed-egress-ca.pem';
export const MCP_CONFIG_FILE = '/tmp/woodshed-mcp.json';
// claude's own flags in a tainted session: only the --mcp-config servers (woodshed-prod), and no tool that has
// Anthropic reach the internet for it (the console's proxy refuses those calls anyway).
export const TAINTED_CLAUDE_FLAGS = ' --strict-mcp-config --disallowedTools WebSearch,WebFetch';
const SYSTEM_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];

/** @returns {boolean} */
export function isTainted(marker = TAINT_MARKER) {
  return existsSync(marker);
}

/** @returns {boolean}  whether the session's side of its taint was all set up */
export function isTaintSetUp(file = TAINT_SET_UP) {
  return existsSync(file);
}

/** Says the session's side of its taint is all in place. */
export async function markTaintSetUp(file = TAINT_SET_UP) {
  await fs.writeFile(file, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
}

function hostOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return new URL(text).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
  return text.split(':')[0] || null;
}

/**
 * What goes straight, never through the egress proxy: the console itself (its session API and proxies), the
 * session's databases and services, and the session's own loopback.
 * @param {Record<string, string|undefined>} env
 * @returns {string}  NO_PROXY's value
 */
export function noProxyFor(env) {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  for (const value of [env.WOODSHED_CONSOLE_URL, env.PGHOST, env.WOODSHED_MONGO_HOST]) {
    const host = hostOf(value);
    if (host) hosts.add(host);
  }
  for (const name of String(env.WOODSHED_SERVICES ?? '').split(/\s+/).filter(Boolean)) {
    const host = hostOf(env[name]);
    if (host) hosts.add(host);
  }
  return [...hosts].join(',');
}

/**
 * The proxy's URL with the session's own token, which is how the proxy knows the session (egressProxy.mjs).
 * @param {string} proxy  http://<host>:<port>
 * @param {string} token
 */
export function proxyWithToken(proxy, token) {
  const url = new URL(proxy);
  url.username = 'woodshed';
  url.password = token;
  return url.toString().replace(/\/$/, '');
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * @param {{proxy: string, token: string, env: Record<string, string|undefined>, caBundle?: string|null}} args
 * @returns {Record<string, string>}  what points every tool at the proxy (and, tainted, at the proxy's CA too)
 */
export function egressVariables({ proxy, token, env, caBundle = null }) {
  const withToken = proxyWithToken(proxy, token);
  const noProxy = noProxyFor(env);
  const vars = {};
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) vars[name] = withToken;
  for (const name of ['NO_PROXY', 'no_proxy']) vars[name] = noProxy;
  // npm and Node read their own: npm the config's, Node 24's fetch only with this.
  Object.assign(vars, { npm_config_proxy: withToken, npm_config_https_proxy: withToken, NODE_USE_ENV_PROXY: '1' });
  // git asks the proxy with no credential first and retries on the same connection after its 407, which the proxy closes:
  // basic up front, as curl and gh send it.
  vars.GIT_HTTP_PROXY_AUTHMETHOD = 'basic';
  if (caBundle) {
    // git, curl, gh (Go), Python and Node: each reads its own variable for the authorities it trusts.
    for (const name of ['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS']) vars[name] = caBundle;
    // claude's calls that are not the model's (telemetry, updates) go nowhere from a locked-down session.
    Object.assign(vars, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });
  }
  return vars;
}

/** @returns {string}  egressVariables' as shell lines */
export function egressEnvText(args) {
  const lines = Object.entries(egressVariables(args)).map(([name, value]) => `export ${name}=${quote(value)}`);
  return `# Woodshed: this session reaches the internet only through the console's egress proxy (session/taint.mjs).\n${lines.join('\n')}\n`;
}

// What the Terminal tab's shells and claude's commands read at their start (~/.profile and ~/.bashrc).
export const PROFILE_LINE = `[ -f ${EGRESS_ENV_FILE} ] && . ${EGRESS_ENV_FILE}`;

async function addProfileLine(files) {
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (!text.split('\n').includes(PROFILE_LINE)) await fs.appendFile(file, `\n${PROFILE_LINE}\n`);
  }
}

/** The system's authorities and the proxy's, in one file, so every tool trusts both. */
async function writeBundle(ca, file) {
  const system = SYSTEM_BUNDLES.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).find(Boolean) ?? '';
  await fs.writeFile(file, `${system.trimEnd()}\n# The Woodshed console's egress proxy, for GitHub only (its name constraints)\n${ca.trim()}\n`, { mode: 0o644 });
}

/**
 * The servers the console hands this session, from WOODSHED_MCP_SERVERS (console/fleet.mjs).
 * @param {Record<string, string|undefined>} env
 * @returns {{name: string, production: boolean}[]}
 */
export function serversOf(env) {
  try {
    const list = JSON.parse(env.WOODSHED_MCP_SERVERS || '[]');
    return (Array.isArray(list) ? list : []).filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(String(s?.name ?? ''))).map((s) => ({ name: s.name, production: s.production === true }));
  } catch {
    return [];
  }
}

/**
 * claude's --mcp-config: each server at the console's relay, with the session's own token, which no server ever sees.
 * @param {{servers: {name: string, production: boolean}[], consoleUrl: string, token: string, tainted: boolean}} args
 * @returns {object}  a tainted session's has its production servers alone
 */
export function mcpConfig({ servers, consoleUrl, token, tainted }) {
  const mcpServers = {};
  for (const { name, production } of servers) {
    if (tainted && !production) continue;
    mcpServers[name] = { type: 'http', url: `${consoleUrl.replace(/\/+$/, '')}/mcp/${name}`, headers: { Authorization: `Bearer ${token}` } };
  }
  return { mcpServers };
}

/**
 * ~/.claude.json with the production servers on (`on`) or off for the checkout, the other servers as they were.
 * @param {string|null} text
 * @param {string} repoDir
 * @param {string[]} names  the production servers
 * @param {boolean} on
 * @returns {string}
 */
export function withProdServers(text, repoDir, names, on) {
  const config = text ? JSON.parse(text) : {};
  config.projects ??= {};
  const project = config.projects[repoDir] ??= {};
  const disabled = (Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : []).filter((n) => !names.includes(n));
  project.disabledMcpServers = on ? disabled : [...disabled, ...names];
  return JSON.stringify(config, null, 2);
}

/** Writes claude's --mcp-config and turns the production servers on or off: off until the person turns one on. */
export async function writeMcpConfig({ env, repoDir, tainted, file = MCP_CONFIG_FILE, claudeJson = path.join(os.homedir(), '.claude.json') }) {
  const servers = serversOf(env);
  if (!servers.length || !env.WOODSHED_CONSOLE_URL) return { servers: [], production: [] };
  await fs.writeFile(file, `${JSON.stringify(mcpConfig({ servers, consoleUrl: env.WOODSHED_CONSOLE_URL, token: env.SESSION_TOKEN ?? '', tainted }), null, 2)}\n`, { mode: 0o600 });
  const production = servers.filter((s) => s.production).map((s) => s.name);
  if (production.length) {
    const before = await fs.readFile(claudeJson, 'utf8').catch(() => null);
    await fs.writeFile(claudeJson, withProdServers(before, repoDir, production, tainted));
  }
  return { servers: servers.filter((s) => !tainted || s.production).map((s) => s.name), production };
}

/**
 * The session's side of the taint: the marker, the egress variables, the CA bundle, and its production servers on.
 * @param {{proxy: string|null, ca: string|null, token: string, env: Record<string, string|undefined>, repoDir: string,
 *          files?: {marker?: string, envFile?: string, bundle?: string, claudeJson?: string, mcpConfig?: string, profiles?: string[]}}} args
 * @returns {Promise<{egress: boolean, variables: Record<string, string>}>}  whether the egress variables were written
 *   (there was a proxy and a CA), and them, for the caller's own process
 */
export async function applyTaint({ proxy, ca, token, env, repoDir, files = {} }) {
  const marker = files.marker ?? TAINT_MARKER;
  const envFile = files.envFile ?? EGRESS_ENV_FILE;
  const bundle = files.bundle ?? EGRESS_CA_BUNDLE;
  const claudeJson = files.claudeJson ?? path.join(os.homedir(), '.claude.json');
  const profiles = files.profiles ?? ['.profile', '.bashrc'].map((f) => path.join(os.homedir(), f));
  await fs.writeFile(marker, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
  let variables = {};
  if (proxy && ca) {
    await writeBundle(ca, bundle);
    variables = egressVariables({ proxy, token, env, caBundle: bundle });
    await fs.writeFile(envFile, egressEnvText({ proxy, token, env, caBundle: bundle }), { mode: 0o600 });
    await addProfileLine(profiles);
  }
  // Its production servers on, and the others out of claude's config: the relay refuses them now anyway.
  await writeMcpConfig({ env, repoDir, tainted: true, file: files.mcpConfig ?? MCP_CONFIG_FILE, claudeJson });
  return { egress: Boolean(proxy && ca), variables };
}

if (isMain(import.meta.url)) {
  const [what, arg] = process.argv.slice(2);
  const token = process.env.SESSION_TOKEN;
  const repoDir = process.env.REPO_DIR || process.cwd();
  if (what === 'apply') {
    const answer = JSON.parse(await fs.readFile(arg, 'utf8'));
    const { egress } = await applyTaint({ proxy: answer.proxy, ca: answer.ca, token, env: process.env, repoDir });
    // A resumed tainted session's start sets the rest up itself, before claude opens: statusd has nothing to finish.
    await markTaintSetUp();
    console.log(`egress: ${egress ? 'through the console' : 'none'}`);
  } else if (what === 'proxy') {
    await fs.writeFile(EGRESS_ENV_FILE, egressEnvText({ proxy: arg, token, env: process.env }), { mode: 0o600 });
    console.log('egress: through the console');
  } else if (what === 'mcp-config') {
    const { servers, production } = await writeMcpConfig({ env: process.env, repoDir, tainted: isTainted() || process.env.WOODSHED_TAINTED === '1' });
    console.log(JSON.stringify({ servers, production }));
  } else {
    console.error('usage: taint.mjs apply <egress.json> | proxy <url> | mcp-config');
    process.exit(2);
  }
}
