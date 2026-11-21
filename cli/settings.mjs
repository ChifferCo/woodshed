// `woodshed settings`: this computer's Claude settings join the copy a person's private sessions keep in step
// (console/claudeSettings.mjs, session/settingsSync.mjs), and a checkout's ignored files become their own files for its
// repo on My settings (console/repoSettings.mjs). The items, how they merge and which paths they may name are the
// session sync's own, imported here; console/cliSettings.mjs is the console's side.
//
//   woodshed settings plan  [--only <what>,...] [--own-files <checkout>]   each item, its size, and upload, skip or
//                                                                        refuse with why. Nothing is sent
//   woodshed settings plan --pull [--replace] [same]                     what pull would write, and what each item that
//                                                                        runs here runs. Nothing is written
//   woodshed settings push  [same]                                       the same list, then the uploads. Items never
//                                                                        listed before are asked about, or (with no
//                                                                        terminal to ask on) sent only after a plan. An
//                                                                        item a session changed since is left alone
//   woodshed settings pull  [same] [--replace]                           the shared copy written here: what is missing,
//                                                                        and with --replace what differs. Each item but
//                                                                        keybindings.json is shown with what it runs,
//                                                                        then asked about, or held until a plan showed it
//
// A laptop is not a session: its home is the person's (~), a session's is /home/node, and settings name paths in it.
// A path into what is synced (~/.claude/skills/...) is moved to the other home; a setting naming any other path in the
// home (a hook running ~/bin/notify.sh) is left out, and said, since the other side does not have that file. The status
// line stays each side's own. MCP logins never go either way, and an API key in an MCP server's env, a credential
// helper or a file that looks like a secret is refused by name, never shown.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { isLoginItem } from '../console/cliSettings.mjs';
import { MAX_SETTINGS_BYTES } from '../console/claudeSettings.mjs';
import {
  CODEX_CONFIG, inlinePairs, keyText, pathOf, readToml, sharedPart, stringsOf, textOf, unitOf, withEntries,
} from '../session/codexConfig.mjs';
import {
  applyItems, isSyncedFile, localChanges, MARKETPLACES_FILE, MAX_ITEM_BYTES, NO_STATUS_LINE, parseEntryId, parsePluginId, PLUGINS_FILE, readSnapshot,
  sameSettings, SETTINGS, SYNCED_DIRS, withStatusLineOf,
} from '../session/settingsSync.mjs';
import { marketplaceArg } from '../session/syncedPlugins.mjs';
import { BUILT_IN_MARKETPLACES } from '../session/defaultPlugins.mjs';
import { skipReason, writeOwnFiles } from '../session/ownFiles.mjs';
import { DOTFILES, dotfileProblem, fromComputer } from '../shared/dotfiles.mjs';
import { DEFAULT_MAX_VALUE_BYTES, MAX_OWN_FILES } from '../shared/ownFiles.mjs';
import { SECRET_CONTENT, SECRET_HEADER, SECRET_VARIABLE, secretContent } from '../shared/secretLike.mjs';
import { loadProject, repoOf } from '../shared/project.mjs';

export { secretContent };

// The session image's user (session/Dockerfile, USER node): the home its synced paths are under.
export const SESSION_HOME = '/home/node';
export const CATEGORIES = Object.freeze(['settings', 'keybindings', 'memory', 'agents', 'commands', 'skills', 'mcp', 'codex', 'plugins', 'dotfiles', 'own-files']);
// What My settings keeps of a dotfile: a secret's limit, as tmux's own lines.
const MAX_DOTFILE_BYTES = 65_536;
// Programs an MCP server is often given by its full path on a Mac or Linux: on a session's PATH by their bare name.
const PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
// settings.json keys that run a program to hand claude a credential: the session has its own way in.
const CREDENTIAL_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
// What an own file may still not hold: its point is a developer's own keys, but never production's, real AWS keys or a
// team's integration token (CLAUDE.md, "Rules").
const PRODUCTION_CONTENT = SECRET_CONTENT.filter(([kind]) => ['a private key', 'a live Stripe key', 'an AWS access key', 'a Slack token'].includes(kind) || kind.startsWith('a Woodshed'));

/** @returns {string|null}  why a file of this name is refused as a secret, null when it is not one */
export function secretName(file, { ownFile = false } = {}) {
  const base = path.posix.basename(file).toLowerCase();
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|kdbx)$/.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return 'named like a private key or certificate';
  if (/^(\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd)$/.test(base) || /(^|[._-])credentials?([._-]|$)/.test(base) || /^service-account.*\.json$/.test(base)) return 'named like a credentials file';
  // Any folder on its way counts too: deploy/production/.env is production's as much as .env.production is.
  if (ownFile) return file.toLowerCase().split('/').some((part) => /(^|[._-])prod(uction)?([._-]|$)/.test(part)) ? 'named for production: sessions never get production credentials' : null;
  if (/^\.env(\..+)?$|\.env$/.test(base) || /(^|[._-])secrets?([._-]|$)/.test(base)) return 'named like a secret';
  return null;
}

/** @returns {boolean}  a name an env file goes by, which --own-files takes without being named */
export function envLike(file) {
  const base = path.posix.basename(file).toLowerCase();
  if (/^\.env\.(example|sample|template|dist)$/.test(base)) return false;
  return /^\.env(\..+)?$|\.env$|^\.envrc$|^\.dev\.vars$|\.local$|\.local\.[a-z]+$/.test(base);
}

function categoryOf(id) {
  if (parsePluginId(id)) return 'plugins';
  if (parseEntryId(id)) return 'mcp';
  if (id.startsWith('.codex/')) return 'codex';
  if (id === SETTINGS) return 'settings';
  if (id === '.claude/keybindings.json') return 'keybindings';
  if (id === '.claude/CLAUDE.md') return 'memory';
  return id.split('/')[1];
}

/** What the person sees and types for an item: ~/.claude/skills/x/SKILL.md, mcp/github, or an own file's path. */
function nameOf(id) {
  const plugin = parsePluginId(id);
  if (plugin) return `plugin/${plugin}`;
  const entry = parseEntryId(id);
  if (entry) return entry.key === 'mcpServers' ? `mcp/${entry.name}` : `${entry.file}#${entry.key}/${entry.name}`;
  return `~/${id}`;
}

/**
 * Whether an item is among what --only names: a category, or a name or a folder of names, with or without ~/.claude/.
 * @param {string[]} only  empty for everything
 */
export function matchesOnly(only, { category, name }, { byName = false } = {}) {
  if (!only.length) return !byName;
  // ~/.claude's items by their name in it (skills/review), ~/.codex's by theirs in the home (.codex/skills/review).
  const short = name.replace(/^~\/\.claude\//, '').replace(/^~\//, '');
  return only.some((raw) => {
    const want = raw.replace(/^~\//, '').replace(/^\.claude\//, '').replace(/\/$/, '');
    // A kind is not a name, even where it is also a folder (skills/): --only skills does not name each skill.
    if (byName && CATEGORIES.includes(want)) return false;
    return (!byName && want === category) || want === short || short.startsWith(`${want}/`) || want === name;
  });
}

/** @returns {string}  an item's content as the shared copy held it, by name: what this computer last pushed or pulled */
export function itemHash(id, value) {
  return crypto.createHash('sha256').update(`${id}\0${value}`).digest('hex');
}

/** What a session's text may print here: printable ASCII, so a name or command cannot move the cursor or retitle. */
function printable(text, max = 200) {
  const out = String(text).replace(/[^\x20-\x7e]/g, '?');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * The first folder or file on a path under `root` that is a symlink, which the sync never reads or writes through: a
 * linked skills folder would send another checkout's files, and a pull would write into it.
 * @returns {string|null}  the symlink's path under root
 */
export function linkOnPath(root, rel) {
  let at = root;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    let stat;
    try {
      stat = fs.lstatSync(at);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return path.relative(root, at);
  }
  return null;
}

const fileOf = (id) => (parsePluginId(id) ? PLUGINS_FILE : parseEntryId(id)?.file ?? id);

/**
 * A dropped path as the list shows it: the home by name and at most its first two plain folder or file names, so a token
 * inside the rest of an argument (a query string, a key in a file name) is never printed.
 */
export function shownPath(dropped, from, { prefix = '~/' } = {}) {
  const rest = dropped.startsWith(from) ? dropped.slice(from.length) : dropped.replace(/^(~|\$HOME|\$\{HOME\})/, '');
  const parts = rest.split('/').filter(Boolean);
  const plain = [];
  for (const part of parts.slice(0, 2)) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(part) || secretContent(part)) break;
    plain.push(part);
  }
  return `${prefix}${plain.join('/')}${plain.length < parts.length ? `${plain.length ? '/' : ''}...` : ''}`;
}

const DROP = Symbol('drop');
const ONLY = 'left out by --only';

/** Whether a path under a home is one the sync carries, so it is there on the other side too. */
function carried(rel) {
  return isSyncedFile(rel) || SYNCED_DIRS.some((d) => rel === d || rel === `${d}/`);
}

/**
 * Moves the paths a JSON value names from one home to the other. A string naming any other path in the home is dropped,
 * and with it the array element it is in (a hook, a permission rule), or else its key.
 * @returns {{value: unknown, dropped: {at: string, path: string}[], moved: number}}  dropped: where each was (hooks.Stop[0])
 *   and the path it named
 */
export function movePaths(value, { from, to }) {
  const dropped = [];
  let moved = 0;
  const pathRe = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$|[\\s'"\`])([^\\s'"\`;,)\\]}]*)`, 'g');
  // The home by name: ~/x in a hook's shell or a permission rule, $HOME/x. Each side's own, so a carried path stays as it is.
  const namedRe = /(?<=^|[\s'"`=(:,])(?:~|\$HOME|\$\{HOME\})(?=\/|$|[\s'"`;,)\]}])([^\s'"`;,)\]}]*)/g;
  function str(s) {
    let left = null;
    const out = s.replace(pathRe, (whole, rest) => {
      const rel = rest.replace(/^\//, '');
      if (rel && carried(rel)) {
        moved += 1;
        return `${to}/${rel}`;
      }
      left ??= whole;
      return whole;
    });
    for (const [whole, rest] of out.matchAll(namedRe)) {
      const rel = rest.replace(/^\//, '');
      if (!rel || !carried(rel)) left ??= whole;
    }
    return left ? { drop: left } : { value: out };
  }
  function walk(node, at, inArray) {
    if (typeof node === 'string') {
      const r = str(node);
      if (r.drop) return { drop: r.drop };
      return { value: r.value };
    }
    if (Array.isArray(node)) {
      const out = [];
      node.forEach((child, i) => {
        const r = walk(child, `${at}[${i}]`, true);
        if (r.drop) dropped.push({ at: `${at}[${i}]`, path: r.drop });
        else out.push(r.value);
      });
      return { value: out };
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        const r = walk(child, at ? `${at}.${key}` : key, inArray);
        if (!r.drop) out[key] = r.value;
        else if (inArray) return { drop: r.drop };
        else dropped.push({ at: `${at ? `${at}.` : ''}${key}`, path: r.drop });
      }
      return { value: out };
    }
    return { value: node };
  }
  const r = walk(value, '', false);
  return { value: r.drop ? DROP : r.value, dropped, moved };
}

function decodeJson(b64) {
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

const encodeJson = (json) => Buffer.from(`${JSON.stringify(json, null, 2)}\n`).toString('base64');

/** An MCP server entry's literal credentials: an env variable or header named like one, not one made of a ${VARIABLE}. */
function serverCredential(server) {
  // A value is safe only when it is made of variables with no fallback, after an optional scheme (Bearer ${TOKEN}).
  const literal = (v) => {
    if (typeof v !== 'string' || !v.trim()) return false;
    if (/\$\{[^}]*:-[^}]+\}/.test(v)) return true;
    return v.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(:-)?\}/g, '').replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim() !== '';
  };
  if (typeof server?.url === 'string') {
    let url = null;
    try {
      url = new URL(server.url);
    } catch {}
    if (url && (url.username || url.password)) return 'its URL carries a sign-in';
    const param = url && [...url.searchParams].find(([k, v]) => SECRET_VARIABLE.test(k) && literal(v));
    if (param) return `its URL carries ${param[0]}`;
  }
  const env = Object.entries(server?.env ?? {}).find(([k, v]) => SECRET_VARIABLE.test(k) && literal(v));
  if (env) return `its env sets ${env[0]}`;
  const header = Object.entries(server?.headers ?? {}).find(([k, v]) => SECRET_HEADER.test(k) && literal(v));
  if (header) return `it sends its ${header[0]} header`;
  return null;
}

// config.toml's keys that stay each side's own: the folders it trusts, and where codex sends its calls and as whom. A
// session's codex runs on its owner's own sign-in or the console's proxy (session/bin/codex), and a computer's provider
// (a local model, a company gateway) is not one a session reaches.
const CODEX_OWN_KEYS = new Set(['projects', 'model_provider', 'model_providers', 'profile', 'profiles', 'openai_base_url', 'chatgpt_base_url']);
// Tables whose keys are an environment variable's or a header's name (mcp_servers.x.env, shell_environment_policy.set).
const CODEX_ENV_TABLES = new Set(['env', 'set', 'http_headers']);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// A value that is one of codex's own words (preferred_auth_method = "chatgpt", a store = "file"), not a credential.
const WORD = /^[a-z][a-z0-9_-]{0,24}$/;

/** What in one of config.toml's statements is a credential, or null: named, never shown. */
function codexCredential(statement) {
  if (statement.kind !== 'kv') return null;
  const at = pathOf(statement);
  const name = keyText(at);
  const kind = secretContent(statement.text);
  if (kind) return `holds what looks like ${kind}`;
  const strings = stringsOf(statement.value);
  if (/^(experimental_)?bearer_token$/.test(at.at(-1)) && strings.length) return `sets ${name}`;
  const pair = inlinePairs(statement.value).find((p) => (SECRET_VARIABLE.test(p.key) || SECRET_HEADER.test(p.key)) && !ENV_NAME.test(p.said) && p.said.trim());
  if (pair) return `sets ${name}.${keyText([pair.key])}`;
  const single = strings.length === 1 && statement.value.trim() === strings[0].raw ? strings[0].said : null;
  const last = at.at(-1);
  if (single !== null && single.trim() && !ENV_NAME.test(single)) {
    if (CODEX_ENV_TABLES.has(at.at(-2)) && (SECRET_VARIABLE.test(last) || (at.at(-2) === 'http_headers' && SECRET_HEADER.test(last)))) return `sets ${name}`;
    if (SECRET_VARIABLE.test(last) && !WORD.test(single)) return `sets ${name}`;
  }
  for (const { said } of strings) {
    let url = null;
    try {
      url = new URL(said);
    } catch {}
    if (url && (url.username || url.password)) return `${name}'s URL carries a sign-in`;
    const param = url && [...url.searchParams].find(([k, v]) => SECRET_VARIABLE.test(k) && v && !/^\$/.test(v));
    if (param) return `${name}'s URL carries ${param[0]}`;
  }
  return null;
}

/**
 * ~/.codex/config.toml as it would be on the other side: each entry that is a side's own, holds a credential or names
 * a path the other side has not is left out whole (unitOf: an MCP server with its env, a provider), and paths into what
 * is synced are moved.
 * @returns {{value: string, notes: string[], own: object[]}|{fate: 'skip'|'refuse', reason: string}}  own: the statements
 *   left out but trusted folders, which a pull keeps of this computer's own
 */
export function translateCodexConfig(value, { from, to }) {
  const statements = readToml(Buffer.from(value, 'base64').toString('utf8'));
  if (!statements) return { fate: 'skip', reason: 'not TOML this reads: edit it in a session, or fix it here', unreadable: true };
  const leave = new Map();
  const texts = new Map();
  let moved = 0;
  for (const s of statements) {
    const unit = unitOf(s);
    if (!unit || leave.has(unit)) continue;
    const at = pathOf(s);
    if (CODEX_OWN_KEYS.has(at[0])) {
      leave.set(unit, at[0] === 'projects' ? 'projects' : `${unit} (where codex sends its calls stays each side's own)`);
      continue;
    }
    const credential = codexCredential(s);
    if (credential) {
      leave.set(unit, `${unit} (${credential}, a credential)`);
      continue;
    }
    if (s.kind !== 'kv') continue;
    let text = s.text;
    // An MCP server's program by its full path, as an MCP server of claude's (translate): by its bare name from a
    // folder every PATH has, and otherwise left here.
    const program = at.at(-1) === 'command' && stringsOf(s.value).length === 1 ? stringsOf(s.value)[0] : null;
    if (program && path.posix.isAbsolute(program.said) && !program.said.startsWith(`${from}/`)) {
      if (!PATH_DIRS.includes(path.posix.dirname(program.said))) {
        leave.set(unit, `${unit} (runs a program at ${shownPath(program.said, '', { prefix: '/' })}, a path the other side may not have)`);
        continue;
      }
      text = text.replace(program.raw, JSON.stringify(path.posix.basename(program.said)));
    }
    for (const { raw, said: str } of stringsOf(s.value)) {
      const r = movePaths([str], { from, to });
      if (r.dropped.length) {
        leave.set(unit, `${unit} (names ${shownPath(r.dropped[0].path, from)}, not on the other side)`);
        break;
      }
      if (r.moved) {
        moved += r.moved;
        text = text.replace(raw, JSON.stringify(r.value[0]));
      }
    }
    texts.set(s, text);
  }
  const kept = statements.filter((s) => !leave.has(unitOf(s))).map((s) => ({ ...s, text: texts.get(s) ?? s.text }));
  const out = sharedPart(textOf(kept));
  const own = statements.filter((s) => leave.has(unitOf(s)) && pathOf(s)[0] !== 'projects');
  const notes = [...new Set(leave.values())].filter((n) => n !== 'projects');
  if (!out.trim()) return { fate: 'skip', reason: notes.length ? `nothing left once these are left out: ${notes.join(', ')}` : 'nothing in it but trusted folders, which each side keeps its own', own };
  return {
    value: Buffer.from(out).toString('base64'), own,
    notes: [...(notes.length ? [`left out: ${notes.join(', ')}`] : []), ...(moved ? [`${moved} path${moved === 1 ? '' : 's'} moved to ${to}`] : [])],
  };
}

/** A plugin's item, which names its marketplace: one only this computer has, or one with a sign-in in its URL, stays here. */
function translatePlugin(id, value) {
  let marketplace = null;
  try {
    ({ marketplace } = JSON.parse(value));
  } catch {
    return { fate: 'skip', reason: 'not JSON' };
  }
  const name = parsePluginId(id);
  const market = name.split('@')[1];
  if (secretContent(value)) return { fate: 'refuse', reason: `its marketplace holds what looks like ${secretContent(value)}` };
  if (marketplace && typeof marketplace === 'object' && typeof marketplace.url === 'string') {
    let url = null;
    try {
      url = new URL(marketplace.url);
    } catch {}
    if (url && (url.username || url.password)) return { fate: 'refuse', reason: 'its marketplace\'s URL carries a sign-in, a credential' };
  }
  if (!BUILT_IN_MARKETPLACES.includes(market) && !marketplaceArg(marketplace)) {
    return { fate: 'skip', reason: `a session cannot add its marketplace ${market} (a folder on this computer, a pinned ref, or none recorded)` };
  }
  return { value, notes: [] };
}

/**
 * One item as it would be on the other side: moved to that home, with what it may not carry left out.
 * @param {string} id
 * @param {string} value  a file's content as base64, an entry's as JSON (readSnapshot's)
 * @param {{from: string, to: string, statusLineOf?: string}} opts  statusLineOf: the settings.json whose status line
 *   the result keeps (the other side's own)
 * @returns {{value: string, notes: string[]}|{fate: 'skip'|'refuse', reason: string}}
 */
export function translate(id, value, { from, to, statusLineOf }) {
  if (isLoginItem(id)) return { fate: 'refuse', reason: 'an MCP login: sign in to the server where you use it' };
  if (parsePluginId(id)) return translatePlugin(id, value);
  if (id === CODEX_CONFIG) return translateCodexConfig(value, { from, to });
  const entry = parseEntryId(id);
  if (entry) {
    let server;
    try {
      server = JSON.parse(value);
    } catch {
      return { fate: 'skip', reason: 'not JSON' };
    }
    const credential = serverCredential(server);
    if (credential) return { fate: 'refuse', reason: `${credential}, a credential: API keys stay where they are` };
    const notes = [];
    if (typeof server?.command === 'string' && path.posix.isAbsolute(server.command) && !server.command.startsWith(`${from}/`)) {
      if (!PATH_DIRS.includes(path.posix.dirname(server.command))) return { fate: 'skip', reason: `runs a program at ${shownPath(server.command, '', { prefix: '/' })}, a path the other side may not have` };
      notes.push(`runs ${path.posix.basename(server.command)} from the PATH, not ${server.command}`);
      server = { ...server, command: path.posix.basename(server.command) };
    }
    const moved = movePaths(server, { from, to });
    if (moved.value === DROP || moved.dropped.length) return { fate: 'skip', reason: `names ${moved.dropped[0] ? shownPath(moved.dropped[0].path, from) : '~'}, a path the other side does not have` };
    if (moved.moved) notes.push(`${moved.moved} path${moved.moved === 1 ? '' : 's'} moved to ${to}`);
    const text = JSON.stringify(moved.value);
    const kind = secretContent(text);
    if (kind) return { fate: 'refuse', reason: `holds what looks like ${kind}` };
    return { value: text, notes };
  }
  const file = path.posix.basename(id);
  const named = secretName(file);
  if (named) return { fate: 'refuse', reason: named };
  if (id !== SETTINGS) {
    const kind = secretContent(Buffer.from(value, 'base64').toString('latin1'));
    return kind ? { fate: 'refuse', reason: `holds what looks like ${kind}` } : { value, notes: [] };
  }
  let json = decodeJson(value);
  if (!json) return { fate: 'skip', reason: 'not a JSON object, so claude would not read it either' };
  const notes = [];
  if (json.statusLine !== undefined) notes.push('statusLine (each side draws its own)');
  const helpers = CREDENTIAL_KEYS.filter((k) => json[k] !== undefined);
  const secretEnv = Object.keys(json.env ?? {}).filter((k) => SECRET_VARIABLE.test(k));
  if (helpers.length || secretEnv.length) {
    json = { ...json };
    for (const k of helpers) delete json[k];
    if (secretEnv.length) json.env = Object.fromEntries(Object.entries(json.env).filter(([k]) => !secretEnv.includes(k)));
    notes.push(...helpers.map((k) => `${k} (a credential helper)`), ...secretEnv.map((k) => `env.${k} (a credential)`));
  }
  // A hook that calls a URL or runs with headers or env can carry a credential, as an MCP server can: such a hook stays
  // where it is, either way, and is never shown.
  if (json.hooks && typeof json.hooks === 'object') {
    const hooks = {};
    for (const [event, groups] of Object.entries(json.hooks)) {
      hooks[event] = !Array.isArray(groups) ? groups : groups.map((group, i) => {
        if (!Array.isArray(group?.hooks)) return group;
        const kept = group.hooks.filter((hook, j) => {
          const credential = hook && typeof hook === 'object' ? serverCredential(hook) : null;
          if (credential) notes.push(`hooks.${event}[${i}].hooks[${j}] (${credential.replace(/^its |^it /, '')}, a credential)`);
          return !credential;
        });
        return kept.length === group.hooks.length ? group : { ...group, hooks: kept };
      });
    }
    json = { ...json, hooks };
  }
  const { statusLine, ...rest } = json;
  const moved = movePaths(rest, { from, to });
  notes.push(...moved.dropped.map((d) => `${d.at} (names ${shownPath(d.path, from)}, not on the other side)`));
  const body = moved.value === DROP ? {} : moved.value;
  const out = withStatusLineOf(encodeJson(statusLine === undefined ? body : { ...body, statusLine }), statusLineOf ?? NO_STATUS_LINE);
  const kind = secretContent(Buffer.from(out, 'base64').toString('utf8'));
  if (kind) return { fate: 'refuse', reason: `holds what looks like ${kind}` };
  return {
    value: out, dropped: moved.dropped,
    notes: notes.length ? [`left out: ${notes.join(', ')}`, ...(moved.moved ? [`${moved.moved} path${moved.moved === 1 ? '' : 's'} moved to ${to}`] : [])] : [],
  };
}

/**
 * settings.json from the shared copy, with what this computer keeps to itself put back: its credential helpers and the
 * env variables named like credentials, which a push never sends.
 * @returns {{value: string, kept: string[]}}
 */
function withOwnCredentials(b64, mine) {
  const json = decodeJson(b64);
  const own = decodeJson(mine);
  if (!json || !own) return { value: b64, kept: [] };
  const kept = [];
  for (const k of CREDENTIAL_KEYS) {
    if (own[k] === undefined) continue;
    json[k] = own[k];
    kept.push(k);
  }
  for (const [k, v] of Object.entries(own.env ?? {})) {
    if (!SECRET_VARIABLE.test(k)) continue;
    json.env = { ...json.env, [k]: v };
    kept.push(`env.${k}`);
  }
  return kept.length ? { value: encodeJson(json), kept } : { value: b64, kept };
}

function bytesOf(id, value) {
  return parseEntryId(id) || parsePluginId(id) ? Buffer.byteLength(value) : Buffer.from(value, 'base64').length;
}

async function symlinksUnder(home, dir) {
  const found = [];
  const entries = await fs.promises.readdir(path.join(home, dir), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isSymbolicLink()) found.push(rel);
    else if (e.isDirectory()) found.push(...await symlinksUnder(home, rel));
  }
  return found;
}

export const SAME_AS_SHARED = 'the same as the shared copy';
const SAME_AS_YOURS = 'the same as yours';

/**
 * Each of this computer's Claude items against the shared copy, as `push` would send it.
 * @param {{home: string, shared: Record<string, string>, only: string[], synced?: Record<string, string>}} args
 *   synced: each item's hash as the shared copy held it when this computer last pushed or pulled it (itemHash)
 * @returns {Promise<{rows: object[], changed: Record<string, string>}>}  changed: what push sends
 */
export async function claudePushPlan({ home, shared, only, synced = {} }) {
  const { items, unreadable, oversized } = await readSnapshot(home);
  const rows = [];
  const ready = {};
  for (const [id, raw] of Object.entries(items)) {
    const row = { kind: 'claude', id, name: nameOf(id), category: categoryOf(id), bytes: bytesOf(id, raw) };
    if (!matchesOnly(only, row)) {
      rows.push({ ...row, fate: 'skip', reason: ONLY });
      continue;
    }
    const link = linkOnPath(home, fileOf(id));
    if (link) {
      rows.push({ ...row, fate: 'skip', reason: `~/${link} is a symlink, which is not followed: copy what it points to here` });
      continue;
    }
    const out = translate(id, raw, { from: home, to: SESSION_HOME, statusLineOf: shared[SETTINGS] });
    if (out.fate) rows.push({ ...row, fate: out.fate, reason: out.reason });
    else {
      ready[id] = out.value;
      rows.push({ ...row, bytes: bytesOf(id, out.value), notes: out.notes, value: out.value });
    }
  }
  // The sync's own comparison: what this computer has that the shared copy does not, or has otherwise.
  const { changed } = localChanges(shared, ready);
  if (changed[SETTINGS] && shared[SETTINGS] && sameSettings(changed[SETTINGS], shared[SETTINGS])) delete changed[SETTINGS];
  for (const row of rows) {
    if (row.fate) continue;
    // The shared copy moved on since this computer last had the item: a session's edit, which yours would undo.
    const theirs = row.id in changed && row.id in shared && synced[row.id] !== itemHash(row.id, shared[row.id]);
    if (theirs && !matchesOnly(only, row, { byName: true })) {
      delete changed[row.id];
      const named = `--only ${row.name.replace(/^~\/\.claude\//, '')}`;
      Object.assign(row, {
        fate: 'skip',
        reason: synced[row.id] ? `changed in a session since this computer last had it: pull it first, or ${named} sends yours over it`
          : `the shared copy has its own, which this computer never pulled: pull it first, or ${named} sends yours over it`,
      });
    } else if (row.id in changed) Object.assign(row, { fate: 'upload', reason: row.id in shared ? 'changed' : 'new' });
    else Object.assign(row, { fate: 'skip', reason: SAME_AS_SHARED });
  }
  for (const file of oversized) rows.push({ kind: 'claude', id: file, name: nameOf(file), category: categoryOf(file), bytes: fs.statSync(path.join(home, file)).size, fate: 'skip', reason: `over ${MAX_ITEM_BYTES / 1024 / 1024} MB` });
  for (const file of unreadable) rows.push({ kind: 'claude', id: file, name: `~/${file}`, category: 'mcp', bytes: 0, fate: 'skip', reason: 'not read as JSON (claude may be writing it): try again' });
  for (const dir of SYNCED_DIRS) {
    if (linkOnPath(home, dir)) continue;
    for (const link of await symlinksUnder(home, dir)) rows.push({ kind: 'claude', id: link, name: nameOf(link), category: categoryOf(link), bytes: 0, fate: 'skip', reason: 'a symlink, which is not followed: copy what it points to here' });
  }
  return { rows: rows.map(({ value, ...row }) => row), changed };
}

// A line is shown whole, or its end could hide what it does: an item with a longer one is refused, to be read in a session.
export const RUNS_MAX = 2000;

/**
 * Whether a pulled item can make this computer's claude run something, so a pull writes it only once its content was
 * shown: everything but keybindings. MCP servers and settings.json run commands; a skill, command or agent can grant
 * tools and run shell (`!` lines); CLAUDE.md and the rest are instructions claude follows; a script runs as it is.
 */
export function runsHere(id) {
  return id !== '.claude/keybindings.json';
}

const json1 = (v) => JSON.stringify(v);

/** What a pulled item would run or let claude do here, a line each and whole, for the person to read before it is written. */
export function runsOf(id, value) {
  const entry = parseEntryId(id);
  const whole = (lines) => lines.map((l) => printable(l, Infinity));
  if (entry) {
    let server = {};
    try {
      server = JSON.parse(value) ?? {};
    } catch {}
    // The program and each argument as JSON, so where one argument ends is plain; each env value but a credential's,
    // since one (NODE_OPTIONS, npm_config_registry) can change what runs.
    const lines = [server.command ? `runs: ${json1([server.command, ...(Array.isArray(server.args) ? server.args : [])])}` : `connects to: ${server.url ?? 'nothing named'}`];
    for (const [k, v] of Object.entries(server.env ?? {})) lines.push(`env.${k}: ${SECRET_VARIABLE.test(k) ? '(not shown)' : json1(v)}`);
    for (const [k, v] of Object.entries(server)) if (!['type', 'command', 'args', 'url', 'env'].includes(k)) lines.push(`${k}: ${json1(v)}`);
    return whole(lines);
  }
  if (id === SETTINGS) {
    // Every key, since any can change what claude may do here (defaultMode, plugins, a hook of another type).
    const json = decodeJson(value) ?? {};
    const lines = [];
    for (const [key, v] of Object.entries(json)) {
      if (key === 'hooks' && v && typeof v === 'object') {
        for (const [event, groups] of Object.entries(v)) {
          (Array.isArray(groups) ? groups : [groups]).forEach((group, i) => {
            const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
            if (!hooks.length) lines.push(`hooks.${event}[${i}]: ${json1(group)}`);
            hooks.forEach((hook, j) => lines.push(`hooks.${event}[${i}]${group?.matcher ? ` (${group.matcher})` : ''} [${j}]: ${hook?.command ? `runs ${hook.command}` : json1(hook)}`));
          });
        }
      } else if (CREDENTIAL_KEYS.includes(key) || key === 'statusLine') {
        // Only ever this computer's own, kept by a replace: a session's never comes (translate leaves them out). Its
        // command may hold a key, and it is not the session's to show.
        lines.push(`${key}: (yours, not shown)`);
      } else if (key === 'env' && v && typeof v === 'object') {
        // A value can change what runs (NODE_OPTIONS), so it is shown, but never one named like a credential.
        for (const [k, x] of Object.entries(v)) lines.push(`env.${k}: ${SECRET_VARIABLE.test(k) ? '(not shown)' : x}`);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, x] of Object.entries(v)) {
          if (Array.isArray(x)) x.forEach((item) => lines.push(`${key}.${k}: ${typeof item === 'string' ? item : json1(item)}`));
          else lines.push(`${key}.${k}: ${json1(x)}`);
        }
      } else lines.push(`${key}: ${json1(v)}`);
    }
    return whole(lines.length ? lines : ['nothing set']);
  }
  const text = Buffer.from(value, 'base64').toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (id === CODEX_CONFIG) {
    // Every key, as settings.json's, since any can change what codex may do here; a credential's value is never shown.
    const lines = (readToml(text) ?? []).filter((s) => s.kind === 'kv')
      .map((s) => `${keyText(pathOf(s))} = ${codexCredential(s) ? '(not shown)' : s.value.replace(/\s*\n\s*/g, ' ')}`);
    return whole(lines.length ? lines : ['nothing set']);
  }
  if (/\.(md|markdown)$/i.test(id)) {
    // Its frontmatter (allowed-tools, tools, hooks, model) and each line that runs shell as it loads (!`cmd`).
    const lines = [];
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    if (front) lines.push(...front.split('\n').filter((l) => l.trim()).map((l) => `frontmatter: ${l}`));
    for (const line of text.split('\n')) if (/!`|^\s*!/.test(line)) lines.push(`runs as it loads: ${line.trim()}`);
    lines.push(`${text.replace(/\n$/, '').split('\n').length} lines of instructions claude follows`);
    return whole(lines);
  }
  return whole([text.startsWith('#!') ? `a script: ${text.split('\n')[0]}` : 'a file claude or a hook may run']);
}

/**
 * The shared copy against this computer's, as `pull` would write it.
 * @returns {Promise<{rows: object[], items: Record<string, string>, before: Record<string, string>, replaced: string[]}>}
 *   items and before: applyItems' arguments
 */
export async function claudePullPlan({ home, shared, only, replace }) {
  const { items: local, oversized } = await readSnapshot(home);
  let knownHere = null;
  try {
    knownHere = JSON.parse(fs.readFileSync(path.join(home, MARKETPLACES_FILE), 'utf8'));
  } catch {}
  const rows = [];
  const items = {};
  for (const [id, raw] of Object.entries(shared)) {
    const row = { kind: 'claude', id, name: nameOf(id), category: categoryOf(id), bytes: bytesOf(id, raw) };
    if (!isSyncedFile(id) && !parseEntryId(id) && !parsePluginId(id)) {
      rows.push({ ...row, fate: 'skip', reason: 'not an item this computer syncs' });
      continue;
    }
    if (!matchesOnly(only, row)) {
      rows.push({ ...row, fate: 'skip', reason: ONLY });
      continue;
    }
    const link = linkOnPath(home, fileOf(id));
    if (link) {
      rows.push({ ...row, fate: 'skip', reason: `~/${link} is a symlink here, which is not written through` });
      continue;
    }
    if (oversized.includes(id)) {
      rows.push({ ...row, fate: 'skip', reason: `yours is over ${MAX_ITEM_BYTES / 1024 / 1024} MB, and is left as it is` });
      continue;
    }
    const out = translate(id, raw, { from: SESSION_HOME, to: home, statusLineOf: local[SETTINGS] });
    // A plugin is never installed from here: what it runs is its marketplace's, which a list cannot show. Its row says
    // how to install it by hand.
    if (parsePluginId(id) && !out.fate) {
      const name = parsePluginId(id);
      const add = marketplaceArg(JSON.parse(raw).marketplace);
      const known = BUILT_IN_MARKETPLACES.includes(name.split('@')[1]) || !add || Boolean(knownHere?.[name.split('@')[1]]);
      rows.push(id in local ? { ...row, fate: 'skip', reason: SAME_AS_YOURS } : {
        ...row, fate: 'skip', reason: `not installed here: ${known ? '' : `claude plugin marketplace add ${add}, then `}claude plugin install ${name}`,
      });
      continue;
    }
    // Yours as a push would send it: the same as the shared copy means nothing here is behind it.
    const mine = id in local ? translate(id, local[id], { from: home, to: SESSION_HOME, statusLineOf: raw }) : null;
    const same = mine && !mine.fate && (mine.value === raw || (id === SETTINGS && sameSettings(mine.value, raw)));
    if (out.fate) rows.push({ ...row, fate: out.fate, reason: out.reason });
    else if (mine?.unreadable) rows.push({ ...row, fate: 'skip', reason: 'yours is not TOML this reads, so what it keeps to itself could not be told: fix it, then pull' });
    else if (same || local[id] === out.value) rows.push({ ...row, fate: 'skip', reason: SAME_AS_YOURS });
    else if (id in local && !replace) rows.push({ ...row, fate: 'skip', reason: 'yours differs: --replace takes the shared one' });
    else {
      let { value, notes } = out;
      if (id === CODEX_CONFIG && mine?.own?.length) {
        // What this computer keeps to itself of its config.toml (its provider, an MCP server with a key) stays as it is,
        // in place of the shared copy's entries of the same names. Its trusted folders stay too (applyItems).
        value = Buffer.from(withEntries(Buffer.from(value, 'base64').toString('utf8'), mine.own)).toString('base64');
        notes = [`yours kept: ${[...new Set(mine.own.map(unitOf).filter(Boolean))].join(', ')}`];
      }
      if (id === SETTINGS && id in local) {
        const own = withOwnCredentials(value, local[id]);
        value = own.value;
        notes = [
          ...(own.kept.length ? [`yours kept: ${own.kept.join(', ')}`] : []),
          ...(mine?.dropped?.length ? [`yours lost, in the backup: ${mine.dropped.map((d) => d.at).join(', ')}`] : []),
        ];
      }
      items[id] = value;
      const runs = runsHere(id) ? runsOf(id, value) : null;
      if (runs?.some((l) => l.length > RUNS_MAX)) {
        delete items[id];
        rows.push({ ...row, fate: 'refuse', reason: `a line of it is over ${RUNS_MAX} characters, too long to show whole here: read it in a session` });
        continue;
      }
      rows.push({
        ...row, fate: id in local ? 'replace' : 'write', reason: id in local ? 'differs from yours' : 'new here', notes,
        ...(runs ? { runs, gate: itemHash(id, value) } : {}),
      });
    }
  }
  // applyItems deletes the synced files its items leave out, as a session takes a removal: here a pull only adds and
  // replaces, so this computer's own files go back in as they are. `before` is what was read here: a file written since
  // (claude making a skill as this runs) is neither overwritten nor deleted.
  const keep = Object.fromEntries(Object.entries(local).filter(([id]) => isSyncedFile(id)));
  return { rows, items: { ...keep, ...items }, before: local, replaced: Object.keys(items).filter((id) => id in local) };
}

/**
 * This computer's dotfiles as the person's own lines on My settings (shared/dotfiles.mjs): what a session takes of each,
 * with what was left out named. Only ever pushed: the computer's own file is where they come from, so a pull leaves
 * them out.
 * @param {{home: string, stored: Record<string, string|null>, only: string[]}} args  stored: My settings' lines now
 * @returns {{rows: object[], upload: Record<string, string>}}
 */
export function dotfilesPushPlan({ home, stored, only }) {
  const rows = [];
  const upload = {};
  for (const [key, { label, from }] of Object.entries(DOTFILES)) {
    const files = {};
    for (const name of from) {
      try {
        // Read through a symlink: a dotfiles repo often holds them, and nothing is ever written here.
        files[name] = fs.readFileSync(path.join(home, name), 'utf8');
      } catch {}
    }
    if (!Object.keys(files).length) continue;
    const row = { kind: 'dotfile', id: `dotfile:${key}`, name: `dotfile/${key}`, category: 'dotfiles', bytes: 0 };
    if (!matchesOnly(only, row)) {
      rows.push({ ...row, fate: 'skip', reason: ONLY });
      continue;
    }
    const sources = Object.keys(files).map((n) => `~/${n}`).join(', ');
    const { text, left } = fromComputer(key, files, { home });
    const notes = [`your own ${label} lines, from ${sources}`, ...(left.length ? [`left out: ${left.join(', ')}`] : [])];
    row.bytes = Buffer.byteLength(text);
    if (!text.trim()) {
      rows.push({ ...row, fate: 'skip', reason: `nothing in ${sources} a session takes`, notes });
      continue;
    }
    // The console's own check, as it saves them: what fromComputer kept always passes it, so this is a second look.
    const problem = dotfileProblem(key, text);
    if (problem) {
      rows.push({ ...row, fate: 'refuse', reason: problem });
      continue;
    }
    if (row.bytes > MAX_DOTFILE_BYTES) {
      rows.push({ ...row, fate: 'skip', reason: `over the ${MAX_DOTFILE_BYTES / 1024} KB My settings keeps` });
      continue;
    }
    if (stored[key] != null && normal(stored[key]).trim() === text.trim()) {
      rows.push({ ...row, fate: 'skip', reason: 'the same as on My settings', notes });
      continue;
    }
    upload[key] = text;
    rows.push({ ...row, fate: 'upload', reason: stored[key] == null ? 'new' : 'changed: replaces your lines on My settings', notes });
  }
  return { rows, upload };
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

// check-ignore exits 1 when none is ignored: its output is the answer either way.
function gitIn(dir, args, input) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (err) {
    if (err.status === 1) return err.stdout ?? '';
    throw err;
  }
}

/**
 * The checkout --own-files names: its top folder, its repo on GitHub, and the env files its project file writes.
 * @returns {{top: string, repo: string, envFiles: string[]}}
 */
export function checkoutOf(dir) {
  let top;
  try {
    top = git(dir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error(`${dir} is not a git checkout`);
  }
  const repo = repoOf(top);
  if (!repo) throw new Error(`${top}'s origin is not a GitHub repo`);
  let envFiles = [];
  try {
    envFiles = loadProject(top, { projectFilesDir: null, repo }).envFiles.map((f) => f.path);
  } catch {
    // No project file, or one this version does not read: the console checks the paths again as it saves.
  }
  return { top, repo, envFiles };
}

const normal = (text) => text.replace(/\r\n/g, '\n');

/**
 * The checkout's files git ignores and does not track, as `push --own-files` would save them for its repo.
 * @param {{top: string, envFiles: string[], project: string, stored: Record<string, string>, only: string[]}} args
 * @returns {{rows: object[], upload: Record<string, string>}}
 */
export function ownFilesPushPlan({ top, envFiles, project, stored, only }) {
  const found = git(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0').filter(Boolean);
  // --directory names a folder whose files are all ignored as well as those files, unless the folder is ignored itself
  // (node_modules/): only that kind is listed as a folder, the files of the other kind one by one.
  const folders = found.filter((f) => f.endsWith('/'));
  const ignoredFolders = new Set(folders.length ? gitIn(top, ['check-ignore', '--stdin', '-z', '--no-index'], folders.join('\0')).split('\0').filter(Boolean) : []);
  const listed = found.filter((f) => !f.endsWith('/') || ignoredFolders.has(f));
  // A file named by --only inside a folder git ignores whole, which the listing shows only as the folder.
  for (const want of only) {
    if (!listed.includes(want) && !CATEGORIES.includes(want) && fs.statSync(path.join(top, want), { throwIfNoEntry: false })?.isFile()) listed.push(want);
  }
  const rows = [];
  const upload = {};
  for (const file of listed.sort()) {
    const row = { kind: 'own', id: `own:${project}/${file}`, name: file, category: 'own-files', bytes: 0 };
    if (file.endsWith('/')) {
      rows.push({ ...row, fate: 'skip', reason: 'a folder git ignores: its files are not looked at; --only <its path> takes one' });
      continue;
    }
    const why = skipReason(top, file);
    if (why) {
      rows.push({ ...row, fate: 'skip', reason: why });
      continue;
    }
    const full = path.join(top, file);
    row.bytes = fs.statSync(full).size;
    const named = secretName(file, { ownFile: true });
    if (named) {
      rows.push({ ...row, fate: 'refuse', reason: named });
      continue;
    }
    if (row.bytes > DEFAULT_MAX_VALUE_BYTES) {
      rows.push({ ...row, fate: 'skip', reason: `over the ${DEFAULT_MAX_VALUE_BYTES / 1024} KB My settings keeps` });
      continue;
    }
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) {
      rows.push({ ...row, fate: 'skip', reason: 'not text' });
      continue;
    }
    const text = normal(buffer.toString('utf8'));
    if (!text.trim()) {
      rows.push({ ...row, fate: 'skip', reason: 'empty: My settings takes an empty file as removing yours' });
      continue;
    }
    const kind = secretContent(text, PRODUCTION_CONTENT);
    if (kind) {
      rows.push({ ...row, fate: 'refuse', reason: `holds what looks like ${kind}` });
      continue;
    }
    if (envFiles.includes(file)) {
      rows.push({ ...row, fate: 'skip', reason: 'one of the repo\'s env files: its values go on My settings, Repo settings' });
      continue;
    }
    const picked = only.some((o) => o === file) || (envLike(file) && matchesOnly(only, row));
    if (!picked) {
      rows.push({ ...row, fate: 'skip', reason: only.length ? ONLY : 'not an env file: --only <its path> takes it' });
      continue;
    }
    if (stored[file] !== undefined && normal(stored[file]) === text) {
      rows.push({ ...row, fate: 'skip', reason: 'the same as on My settings' });
      continue;
    }
    upload[file] = text;
    rows.push({ ...row, fate: 'upload', reason: stored[file] === undefined ? 'new' : 'changed' });
  }
  const total = new Set([...Object.keys(stored), ...Object.keys(upload)]).size;
  if (total > MAX_OWN_FILES) {
    for (const row of rows) if (row.fate === 'upload') Object.assign(row, { fate: 'skip', reason: `My settings keeps ${MAX_OWN_FILES} files a repo at most, and this would make ${total}` });
    return { rows, upload: {} };
  }
  return { rows, upload };
}

/**
 * Why a saved file cannot be written at its path in the checkout: something other than a file is there (an ignored
 * folder of the same name), or a file sits where one of its folders would be. Null when it can.
 */
function notAFileHere(top, file) {
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) {
    const stat = fs.statSync(path.join(top, ...parts.slice(0, i)), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) return `${parts.slice(0, i).join('/')} is a file here, where the path needs a folder: move it aside`;
  }
  const stat = fs.statSync(path.join(top, file), { throwIfNoEntry: false });
  return stat && !stat.isFile() ? 'a folder is at that path here: move it aside' : null;
}

/** My settings' own files for the repo, written into the checkout where git ignores them, as a session does. */
export function ownFilesPullPlan({ top, project, stored, only, replace }) {
  const rows = [];
  const write = {};
  for (const [file, text] of Object.entries(stored).sort(([a], [b]) => a.localeCompare(b))) {
    const row = { kind: 'own', id: `own:${project}/${file}`, name: file, category: 'own-files', bytes: Buffer.byteLength(text) };
    const why = skipReason(top, file) ?? notAFileHere(top, file);
    const here = !why && fs.statSync(path.join(top, file), { throwIfNoEntry: false });
    if (why) rows.push({ ...row, fate: 'skip', reason: why });
    else if (!matchesOnly(only, row)) rows.push({ ...row, fate: 'skip', reason: ONLY });
    else if (here && normal(fs.readFileSync(path.join(top, file), 'utf8')) === normal(text)) rows.push({ ...row, fate: 'skip', reason: 'the same as yours' });
    else if (here && !replace) rows.push({ ...row, fate: 'skip', reason: 'yours differs: --replace takes the one on My settings' });
    else {
      write[file] = text;
      rows.push({ ...row, fate: here ? 'replace' : 'write', reason: here ? 'differs from yours' : 'new here' });
    }
  }
  // Two saved paths where one is the other's folder (app/.env and app/.env/x) cannot both be written: the deeper waits.
  for (const row of rows) {
    const over = Object.keys(write).find((other) => other !== row.name && row.name.startsWith(`${other}/`));
    if (!over || !(row.name in write)) continue;
    delete write[row.name];
    Object.assign(row, { fate: 'skip', reason: `${over} is saved too, as a file where this path needs a folder: remove one on My settings` });
  }
  return { rows, write };
}

/**
 * @param {string[]} rest  what follows `settings` on the command line, the console's own options taken out
 * @returns {{sub: 'plan'|'push'|'pull', only: string[], ownFiles: string|null, replace: boolean}}
 */
export function parseSettingsArgs(rest) {
  const out = { sub: null, only: [], ownFiles: null, replace: false, pull: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = (name) => {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
      return rest[++i];
    };
    if (arg === '--only' || arg.startsWith('--only=')) out.only.push(...value('--only').split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--own-files' || arg.startsWith('--own-files=')) out.ownFiles = value('--own-files');
    else if (arg === '--replace') out.replace = true;
    else if (arg === '--pull') out.pull = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!out.sub && ['plan', 'push', 'pull'].includes(arg)) out.sub = arg;
    else throw new Error(`unexpected ${arg}: woodshed settings plan [--pull]|push|pull [--only <what>,...] [--own-files <checkout>]`);
  }
  if (!out.sub) throw new Error('woodshed settings needs plan, push or pull');
  if (out.pull && out.sub !== 'plan') throw new Error('--pull is for plan: it lists what pull would write');
  if (out.replace && out.sub !== 'pull' && !out.pull) throw new Error('--replace is for pull, and plan --pull');
  return out;
}

// What this command line keeps of each console's settings, in settings-state.json in its folder, never an item's content:
//   shown      the names of the items a list has shown, so push asks only about the ones never listed
//   pullShown  the hashes of the items that run here (MCP servers, settings.json, scripts) a pull's list has shown, so a
//              pull writes none whose content nobody has seen
//   synced     each item's hash as the shared copy held it when this computer last pushed or pulled it, so a push can
//              tell a session's newer edit from this computer's own
function stateStore(dir, origin) {
  const file = path.join(dir, 'settings-state.json');
  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    read() {
      const mine = readAll()[origin] ?? {};
      return { shown: new Set(mine.shown ?? []), pullShown: new Set(mine.pullShown ?? []), synced: { ...(mine.synced ?? {}) } };
    },
    save({ shown, pullShown, synced }) {
      const all = readAll();
      // The newest pull hashes are the ones still worth keeping: an older content of an item is not written again.
      all[origin] = { shown: [...shown].sort(), pullShown: [...pullShown].slice(-2000), synced, at: new Date().toISOString() };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    },
  };
}

/**
 * A copy of each file a pull replaces, in the command line's folder: a setting this computer had that a session does not
 * (a hook running a script of this computer's) is not in the shared copy, so --replace would otherwise lose it.
 * @returns {string|null}  the folder, null when nothing is replaced
 */
function backupReplaced({ dir, home, ids, top, files }) {
  const sources = [...new Set(ids.map((id) => parseEntryId(id)?.file ?? id))].map((rel) => [path.join(home, rel), path.join('home', rel)]);
  if (top) sources.push(...files.map((file) => [path.join(top, file), path.join('checkout', file)]));
  if (!sources.length) return null;
  const where = path.join(dir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const [from, to] of sources) {
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(where, to)), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, path.join(where, to));
    fs.chmodSync(path.join(where, to), 0o600);
  }
  return where;
}

function size(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function askOnTerminal(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

/**
 * `woodshed settings`, signed in. Its output goes through the command line's own say and emit.
 * @param {{rest: string[], origin: string, token: string, dir: string, env: object, json: boolean,
 *          call: (origin: string, pathname: string, opts?: object) => Promise<{status: number, body: any}>,
 *          say: (text: string) => void, emit: (object: object) => void, warn: (text: string) => void,
 *          fail: (message: string, opts?: {code?: number, status?: string}) => Error, EXIT: Record<string, number>,
 *          home?: string, interactive?: boolean, ask?: (question: string) => Promise<string>}} ctx
 * @returns {Promise<number>}  the exit code
 */
export async function settingsCommand(ctx) {
  const { origin, token, call, say, emit, json, fail, EXIT } = ctx;
  let args;
  try {
    args = parseSettingsArgs(ctx.rest);
  } catch (err) {
    throw fail(err.message);
  }
  const home = ctx.home ?? ctx.env.HOME ?? os.homedir();
  const interactive = !json && (ctx.interactive ?? Boolean(process.stdin.isTTY));
  const ask = ctx.ask ?? askOnTerminal;
  if (ctx.env.CLAUDE_CONFIG_DIR) ctx.warn(`CLAUDE_CONFIG_DIR is set, but woodshed settings reads ${home}/.claude and ${home}/.claude.json only`);
  if (ctx.env.CODEX_HOME) ctx.warn(`CODEX_HOME is set, but woodshed settings reads ${home}/.codex only`);

  async function get(pathname) {
    const answer = await call(origin, pathname, { token });
    if (answer.status === 401) throw fail(`The sign-in to ${origin} ended: run woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    if (answer.status !== 200 || !answer.body) throw fail(`${origin} answered ${answer.status} to ${pathname}: ${String(answer.body?.error ?? 'a console from before woodshed settings').slice(0, 200)}`);
    return answer.body;
  }

  const onlyClaude = args.only.filter((o) => o !== 'own-files');
  const claudeWanted = !args.only.length || onlyClaude.length > 0;
  const shared = claudeWanted ? await get('/api/cli/settings') : { version: null, items: {} };
  let own = null;
  if (args.ownFiles) {
    let checkout;
    try {
      checkout = checkoutOf(path.resolve(args.ownFiles));
    } catch (err) {
      throw fail(err.message);
    }
    const { repos = [] } = await get('/api/cli/settings/repos');
    const project = repos.find((r) => String(r.repo).toLowerCase() === checkout.repo.toLowerCase());
    if (!project) throw fail(`${origin} has no repo ${checkout.repo} you can start sessions on`, { code: EXIT.refused, status: 'refused' });
    const { files = {} } = await get(`/api/cli/settings/files/${encodeURIComponent(project.project)}`);
    own = { ...checkout, project: project.project, stored: files };
  }
  // Dotfiles go one way, from here: a pull leaves them out (dotfilesPushPlan).
  const pulling = args.sub === 'pull' || args.pull;
  let dotfiles = null;
  const hasDotfile = Object.values(DOTFILES).some(({ from }) => from.some((name) => fs.existsSync(path.join(home, name))));
  if (!pulling && hasDotfile && (!args.only.length || args.only.some((o) => o === 'dotfiles' || o.startsWith('dotfile/')))) {
    const answer = await call(origin, '/api/cli/settings/dotfiles', { token });
    if (answer.status === 200 && answer.body?.files) dotfiles = answer.body.files;
    else if (answer.status === 401) throw fail(`The sign-in to ${origin} ended: run woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    else ctx.warn(`${origin} keeps no dotfiles from a computer (${answer.status}): a console from before them, or one with no secret store`);
  }

  const state = stateStore(ctx.dir, origin);
  const kept = state.read();
  const claude = !claudeWanted ? { rows: [], changed: {}, items: {} }
    : pulling ? await claudePullPlan({ home, shared: shared.items, only: args.only, replace: args.replace })
      : await claudePushPlan({ home, shared: shared.items, only: args.only, synced: kept.synced });
  const ownPlan = !own ? { rows: [], upload: {}, write: {} }
    : pulling ? ownFilesPullPlan({ top: own.top, project: own.project, stored: own.stored, only: args.only, replace: args.replace })
      : ownFilesPushPlan({ top: own.top, envFiles: own.envFiles, project: own.project, stored: own.stored, only: args.only });
  const dotPlan = dotfiles ? dotfilesPushPlan({ home, stored: dotfiles, only: args.only }) : { rows: [], upload: {} };

  const moving = pulling ? ['write', 'replace'] : ['upload'];
  const rows = [...claude.rows, ...ownPlan.rows, ...dotPlan.rows];
  const gated = claude.rows.filter((r) => moving.includes(r.fate) && r.gate);
  // A pull writes nothing that runs here (an MCP server, settings.json, a script) whose content no list has shown: a
  // session writes the shared copy unattended, and this computer holds what sessions must never reach.
  const unseenGated = gated.filter((r) => !kept.pullShown.has(r.gate));
  function hold(list, reason) {
    for (const row of list) {
      Object.assign(row, { fate: 'hold', reason });
      if (row.id in (claude.before ?? {}) && isSyncedFile(row.id)) claude.items[row.id] = claude.before[row.id];
      else delete claude.items[row.id];
    }
    claude.replaced = (claude.replaced ?? []).filter((id) => !list.some((r) => r.id === id));
  }
  if (args.sub === 'pull' && unseenGated.length && !interactive) {
    hold(unseenGated, 'runs here, and no list has shown this content: run woodshed settings plan --pull, or pull on a terminal');
  }

  function show(title, list) {
    if (!list.length) return;
    say(title);
    const listed = list.filter((r) => r.reason !== ONLY);
    const width = Math.min(48, Math.max(0, ...listed.map((r) => printable(r.name).length)));
    for (const row of listed) {
      const why = [row.reason, ...(moving.includes(row.fate) ? row.notes ?? [] : [])].filter(Boolean).join('; ');
      say(`  ${row.fate.padEnd(8)}${size(row.bytes).padStart(9)}  ${printable(row.name, 120).padEnd(width)}  ${printable(why, 600)}`);
      if (row.runs && ['write', 'replace', 'hold'].includes(row.fate)) for (const line of row.runs) say(`${' '.repeat(21)}${line}`);
    }
    if (listed.length < list.length) say(`  (${list.length - listed.length} more left out by --only)`);
  }
  if (json) {
    for (const { kind, id, name, category, bytes, fate, reason, notes, runs } of rows) {
      emit({ event: 'item', kind, id, name, category, bytes, fate, reason, ...(notes?.length ? { notes } : {}), ...(runs ? { runs } : {}) });
    }
  }
  if (claudeWanted) show(pulling
    ? `Your shared Claude and Codex settings on ${origin} (version ${shared.version}), into ${home}:`
    : `Claude and Codex settings in ${home}/.claude, ${home}/.claude.json and ${home}/.codex, against your shared copy on ${origin} (version ${shared.version}):`, claude.rows);
  if (own) show(pulling
    ? `Your own files for ${own.repo} on My settings, into ${own.top}:`
    : `Files git ignores in ${own.top}, as your own files for ${own.repo} on My settings:`, ownPlan.rows);
  show('Dotfiles in your home, as your own lines for them on My settings, which your private sessions write after their own:', dotPlan.rows);
  const tally = () => Object.fromEntries(['upload', 'write', 'replace', 'hold', 'skip', 'refuse'].map((f) => [f, rows.filter((r) => r.fate === f).length]));
  let counts = tally();
  const words = Object.entries(counts).filter(([, n]) => n).map(([f, n]) => `${n} ${f === 'skip' ? 'skipped' : f === 'refuse' ? 'refused' : f === 'hold' ? 'held' : `to ${f}`}`).join(', ') || 'nothing found';
  const merged = { ...shared.items, ...claude.changed };
  const overBudget = !pulling && Buffer.byteLength(JSON.stringify({ version: shared.version, items: merged })) > MAX_SETTINGS_BYTES;
  if (overBudget) ctx.warn(`Your shared copy would be over the ${MAX_SETTINGS_BYTES / 1024 / 1024} MB the console keeps: leave something out with --only`);
  if (rows.some((r) => r.fate === 'refuse')) say('Refused items stay here. Sign in to an MCP server in a session, and keep an API key in your own env file values on My settings, Repo settings.');
  const outgoing = rows.filter((r) => moving.includes(r.fate));

  if (args.sub === 'plan') {
    if (pulling) gated.forEach((r) => kept.pullShown.add(r.gate));
    else outgoing.forEach((r) => kept.shown.add(r.id));
    state.save(kept);
    if (json) emit({ event: 'plan', console: origin, version: shared.version, pull: pulling, ...counts, sent: false });
    say(`${words}. Nothing was ${pulling ? 'written' : 'sent'}.`);
    return EXIT.done;
  }

  if (pulling) {
    const held = rows.filter((r) => r.fate === 'hold');
    if (unseenGated.length && interactive) {
      const answer = await ask(`Write ${unseenGated.length} item${unseenGated.length === 1 ? '' : 's'} that run${unseenGated.length === 1 ? 's' : ''} here, as listed above? [y/N] `);
      if (/^y(es)?$/i.test(String(answer).trim())) unseenGated.forEach((r) => kept.pullShown.add(r.gate));
      else {
        hold(unseenGated, 'not confirmed');
        held.push(...unseenGated);
      }
    }
    counts = tally();
    const writing = rows.filter((r) => moving.includes(r.fate));
    let written = { written: 0, skipped: [] };
    let backup = null;
    let ownWritten = { written: [], skipped: [] };
    if (writing.length) {
      backup = backupReplaced({ dir: ctx.dir, home, ids: claude.replaced ?? [], top: own?.top, files: ownPlan.rows.filter((r) => r.fate === 'replace').map((r) => r.name) });
      if (claude.rows.some((r) => moving.includes(r.fate))) written = await applyItems(home, claude.items, { before: claude.before });
      if (Object.keys(ownPlan.write).length) ownWritten = writeOwnFiles(own.top, ownPlan.write);
    }
    // A JSON file claude was writing as this ran is left alone: its items are not written, and not recorded as had.
    for (const row of claude.rows) {
      if (moving.includes(row.fate) && !written.skipped.includes(row.id)) kept.synced[row.id] = itemHash(row.id, shared.items[row.id]);
      else if (row.reason === SAME_AS_YOURS) kept.synced[row.id] = itemHash(row.id, shared.items[row.id]);
    }
    state.save(kept);
    if (backup) say(`What was replaced is kept in ${backup}.`);
    if (written.skipped.length) ctx.warn(`${written.skipped.length} not written: ~/.claude.json was being written as this ran. Run woodshed settings pull again.`);
    if (json) {
      emit({
        event: 'pulled', console: origin, version: shared.version, written: written.written, notWritten: written.skipped.length,
        ownFilesWritten: ownWritten.written.length, ...(backup ? { backup } : {}), ...counts,
      });
    }
    const left = ['hold', 'skip', 'refuse'].filter((f) => counts[f]).map((f) => `${counts[f]} ${f === 'skip' ? 'skipped' : f === 'refuse' ? 'refused' : 'held'}`);
    say(`${written.written + ownWritten.written.length} written here${counts.replace ? ` (${counts.replace} replaced)` : ''}${left.length ? `, ${left.join(', ')}` : ''}.`);
    if (held.length) say('Held items run here and were written nowhere: read what they run above, then run woodshed settings plan --pull and pull again, or pull on a terminal.');
    if (claude.rows.some((r) => moving.includes(r.fate) && r.category === 'mcp')) say('MCP servers reach claude as it starts: a claude open now may write over ~/.claude.json, so start it again.');
    return held.length ? EXIT.waiting : EXIT.done;
  }

  const recordSame = () => {
    for (const row of claude.rows) if (row.reason === SAME_AS_SHARED) kept.synced[row.id] = itemHash(row.id, shared.items[row.id]);
  };
  if (!outgoing.length) {
    recordSame();
    state.save(kept);
    if (json) emit({ event: 'pushed', console: origin, ...counts, sent: 0 });
    say(`${words}. Nothing to send.`);
    return EXIT.done;
  }
  if (overBudget) throw fail('Nothing sent.', { code: EXIT.refused, status: 'too-large' });
  const unseen = outgoing.filter((r) => !kept.shown.has(r.id));
  if (unseen.length) {
    if (!interactive) {
      throw fail(`${unseen.length} of these ${unseen.length === 1 ? 'was' : 'were'} never shown before. Nothing sent: run woodshed settings plan, which sends nothing, then push again.`, { code: EXIT.waiting, status: 'not-shown' });
    }
    const together = outgoing.filter((r) => r.kind !== 'dotfile');
    if (unseen.some((r) => r.kind !== 'dotfile')) {
      const answer = await ask(`Upload ${together.length} item${together.length === 1 ? '' : 's'} to ${origin}? [y/N] `);
      if (!/^y(es)?$/i.test(String(answer).trim())) {
        say('Nothing sent.');
        return EXIT.waiting;
      }
    }
    // A dotfile is asked about on its own: it is a whole file of this computer's, where the rest are Claude's and Codex's.
    for (const row of unseen.filter((r) => r.kind === 'dotfile')) {
      const answer = await ask(`Save ${row.name}'s lines (${row.notes?.[0] ?? ''}) on My settings, for your private sessions? [y/N] `);
      if (/^y(es)?$/i.test(String(answer).trim())) continue;
      Object.assign(row, { fate: 'skip', reason: 'not confirmed' });
      delete dotPlan.upload[row.id.slice('dotfile:'.length)];
    }
    counts = tally();
  }
  outgoing.filter((r) => r.fate === 'upload').forEach((r) => kept.shown.add(r.id));
  state.save(kept);
  let version = shared.version;
  if (Object.keys(claude.changed).length) {
    // removed is always empty: a computer never takes an item out of the copy, as a session's removal does not spread.
    const answer = await call(origin, '/api/cli/settings', { method: 'POST', token, body: { version: shared.version, changed: claude.changed, removed: [] } });
    if (answer.status !== 200) throw fail(`${origin} did not take your Claude settings (${answer.status}): ${String(answer.body?.error ?? '').slice(0, 200)}`);
    version = answer.body.version;
    for (const [id, value] of Object.entries(claude.changed)) kept.synced[id] = itemHash(id, value);
  }
  recordSame();
  state.save(kept);
  const failed = [];
  for (const [file, text] of Object.entries(ownPlan.upload)) {
    const answer = await call(origin, `/api/cli/settings/files/${encodeURIComponent(own.project)}`, { method: 'POST', token, body: { path: file, text } });
    if (answer.status !== 200) failed.push({ file, error: String(answer.body?.error ?? answer.status).slice(0, 200) });
  }
  const sentOwn = Object.keys(ownPlan.upload).length - failed.length;
  let sentDotfiles = 0;
  for (const [key, text] of Object.entries(dotPlan.upload)) {
    const answer = await call(origin, `/api/cli/settings/dotfiles/${key}`, { method: 'POST', token, body: { text } });
    if (answer.status === 200) sentDotfiles += 1;
    else failed.push({ file: `dotfile/${key}`, error: String(answer.body?.error ?? answer.status).slice(0, 300) });
  }
  if (json) emit({ event: 'pushed', console: origin, version, sent: Object.keys(claude.changed).length, ownFilesSent: sentOwn, dotfilesSent: sentDotfiles, failed, ...counts });
  if (Object.keys(claude.changed).length) say(`Sent ${Object.keys(claude.changed).length} item${Object.keys(claude.changed).length === 1 ? '' : 's'} of your Claude and Codex settings: your shared copy is version ${version}. Running sessions take them within a minute; MCP servers as a session starts.`);
  if (own) say(`Saved ${sentOwn} own file${sentOwn === 1 ? '' : 's'} for ${own.repo}: your next session on it writes them.`);
  if (sentDotfiles) say(`Saved ${sentDotfiles} dotfile${sentDotfiles === 1 ? '' : 's'} on My settings: your next private session writes ${sentDotfiles === 1 ? 'it' : 'them'}.`);
  for (const { file, error } of failed) ctx.warn(`${file} not saved: ${error}`);
  return failed.length ? EXIT.failed : EXIT.done;
}
