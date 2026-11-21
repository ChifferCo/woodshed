// `woodshed settings`: this computer's Claude settings join the copy a person's private sessions keep in step
// (console/claudeSettings.mjs, session/settingsSync.mjs), and a checkout's ignored files become their own files for its
// repo on My settings (console/repoSettings.mjs). The items, how they merge and which paths they may name are the
// session sync's own, imported here; console/cliSettings.mjs is the console's side.
//
//   woodshed settings plan  [--only <what>,...] [--own-files <checkout>]   each item, its size, and upload, skip or
//                                                                        refuse with why. Nothing is sent
//   woodshed settings push  [same]                                       the same list, then the uploads. Items never
//                                                                        listed before are asked about, or (with no
//                                                                        terminal to ask on) sent only after a plan
//   woodshed settings pull  [same] [--replace]                           the shared copy written here: what is missing,
//                                                                        and with --replace what differs
//
// A laptop is not a session: its home is the person's (~), a session's is /home/node, and settings name paths in it.
// A path into what is synced (~/.claude/skills/...) is moved to the other home; a setting naming any other path in the
// home (a hook running ~/bin/notify.sh) is left out, and said, since the other side does not have that file. The status
// line stays each side's own. MCP logins never go either way, and an API key in an MCP server's env, a credential
// helper or a file that looks like a secret is refused by name, never shown.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { isLoginItem } from '../console/cliSettings.mjs';
import { MAX_SETTINGS_BYTES } from '../console/claudeSettings.mjs';
import {
  applyItems, isSyncedFile, localChanges, MAX_ITEM_BYTES, NO_STATUS_LINE, parseEntryId, readSnapshot, sameSettings,
  SETTINGS, SYNCED_DIRS, withStatusLineOf,
} from '../session/settingsSync.mjs';
import { skipReason, writeOwnFiles } from '../session/ownFiles.mjs';
import { DEFAULT_MAX_VALUE_BYTES, MAX_OWN_FILES } from '../shared/ownFiles.mjs';
import { loadProject, repoOf } from '../shared/project.mjs';

// The session image's user (session/Dockerfile, USER node): the home its synced paths are under.
export const SESSION_HOME = '/home/node';
export const CATEGORIES = Object.freeze(['settings', 'keybindings', 'memory', 'agents', 'commands', 'skills', 'mcp', 'own-files']);
// Programs an MCP server is often given by its full path on a Mac or Linux: on a session's PATH by their bare name.
const PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
// settings.json keys that run a program to hand claude a credential: the session has its own way in.
const CREDENTIAL_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
const SECRET_VARIABLE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|COOKIE|SESSION)(_|$)/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|(token|secret|key|auth)/i;

// What a file's content can hold that is a credential, by kind: the plan names the kind, never the match.
const SECRET_CONTENT = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a live Stripe key', /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
// What an own file may still not hold: its point is a developer's own keys, but never production's.
const PRODUCTION_CONTENT = SECRET_CONTENT.filter(([kind]) => kind === 'a private key' || kind === 'a live Stripe key');

/** @returns {string|null}  why a file of this name is refused as a secret, null when it is not one */
export function secretName(file, { ownFile = false } = {}) {
  const base = path.posix.basename(file).toLowerCase();
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|kdbx)$/.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return 'named like a private key or certificate';
  if (/^(\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd)$/.test(base) || /(^|[._-])credentials?([._-]|$)/.test(base) || /^service-account.*\.json$/.test(base)) return 'named like a credentials file';
  if (ownFile) return /(^|[._-])prod(uction)?([._-]|$)/.test(base) ? 'named for production: sessions never get production credentials' : null;
  if (/^\.env(\..+)?$|\.env$/.test(base) || /(^|[._-])secrets?([._-]|$)/.test(base)) return 'named like a secret';
  return null;
}

/** @returns {string|null}  the kind of credential the text holds, null for none */
export function secretContent(text, kinds = SECRET_CONTENT) {
  return kinds.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** @returns {boolean}  a name an env file goes by, which --own-files takes without being named */
export function envLike(file) {
  const base = path.posix.basename(file).toLowerCase();
  if (/^\.env\.(example|sample|template|dist)$/.test(base)) return false;
  return /^\.env(\..+)?$|\.env$|^\.envrc$|^\.dev\.vars$|\.local$|\.local\.[a-z]+$/.test(base);
}

function categoryOf(id) {
  if (parseEntryId(id)) return 'mcp';
  if (id === SETTINGS) return 'settings';
  if (id === '.claude/keybindings.json') return 'keybindings';
  if (id === '.claude/CLAUDE.md') return 'memory';
  return id.split('/')[1];
}

/** What the person sees and types for an item: ~/.claude/skills/x/SKILL.md, mcp/github, or an own file's path. */
function nameOf(id) {
  const entry = parseEntryId(id);
  if (entry) return entry.key === 'mcpServers' ? `mcp/${entry.name}` : `${entry.file}#${entry.key}/${entry.name}`;
  return `~/${id}`;
}

/**
 * Whether an item is among what --only names: a category, or a name or a folder of names, with or without ~/.claude/.
 * @param {string[]} only  empty for everything
 */
export function matchesOnly(only, { category, name }) {
  if (!only.length) return true;
  const short = name.replace(/^~\/\.claude\//, '');
  return only.some((raw) => {
    const want = raw.replace(/^~\//, '').replace(/^\.claude\//, '').replace(/\/$/, '');
    return want === category || want === short || short.startsWith(`${want}/`) || want === name;
  });
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
  const literal = (v) => typeof v === 'string' && v.trim() && !/\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/.test(v);
  const env = Object.entries(server?.env ?? {}).find(([k, v]) => SECRET_VARIABLE.test(k) && literal(v));
  if (env) return `its env sets ${env[0]}`;
  const header = Object.entries(server?.headers ?? {}).find(([k, v]) => SECRET_HEADER.test(k) && literal(v));
  if (header) return `it sends a ${header[0]} header`;
  return null;
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
      if (!PATH_DIRS.includes(path.posix.dirname(server.command))) return { fate: 'skip', reason: `runs ${server.command}, a program at a path the other side may not have` };
      notes.push(`runs ${path.posix.basename(server.command)} from the PATH, not ${server.command}`);
      server = { ...server, command: path.posix.basename(server.command) };
    }
    const moved = movePaths(server, { from, to });
    if (moved.value === DROP || moved.dropped.length) return { fate: 'skip', reason: `names ${moved.dropped[0]?.path ?? from}, a path the other side does not have` };
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
  const { statusLine, ...rest } = json;
  const moved = movePaths(rest, { from, to });
  notes.push(...moved.dropped.map((d) => `${d.at} (names ${d.path}, not on the other side)`));
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
  return parseEntryId(id) ? Buffer.byteLength(value) : Buffer.from(value, 'base64').length;
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

/**
 * Each of this computer's Claude items against the shared copy, as `push` would send it.
 * @param {{home: string, shared: Record<string, string>, only: string[]}} args
 * @returns {Promise<{rows: object[], changed: Record<string, string>}>}  changed: what push sends
 */
export async function claudePushPlan({ home, shared, only }) {
  const { items, unreadable, oversized } = await readSnapshot(home);
  const rows = [];
  const ready = {};
  for (const [id, raw] of Object.entries(items)) {
    const row = { kind: 'claude', id, name: nameOf(id), category: categoryOf(id), bytes: bytesOf(id, raw) };
    if (!matchesOnly(only, row)) {
      rows.push({ ...row, fate: 'skip', reason: ONLY });
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
    if (row.id in changed) Object.assign(row, { fate: 'upload', reason: row.id in shared ? 'changed' : 'new' });
    else Object.assign(row, { fate: 'skip', reason: 'the same as the shared copy' });
  }
  for (const file of oversized) rows.push({ kind: 'claude', id: file, name: nameOf(file), category: categoryOf(file), bytes: fs.statSync(path.join(home, file)).size, fate: 'skip', reason: `over ${MAX_ITEM_BYTES / 1024 / 1024} MB` });
  for (const file of unreadable) rows.push({ kind: 'claude', id: file, name: `~/${file}`, category: 'mcp', bytes: 0, fate: 'skip', reason: 'not read as JSON (claude may be writing it): try again' });
  for (const dir of SYNCED_DIRS) {
    for (const link of await symlinksUnder(home, dir)) rows.push({ kind: 'claude', id: link, name: nameOf(link), category: categoryOf(link), bytes: 0, fate: 'skip', reason: 'a symlink, which is not followed: copy what it points to here' });
  }
  return { rows: rows.map(({ value, ...row }) => row), changed };
}

/**
 * The shared copy against this computer's, as `pull` would write it.
 * @returns {Promise<{rows: object[], items: Record<string, string>, before: Record<string, string>, replaced: string[]}>}
 *   items and before: applyItems' arguments
 */
export async function claudePullPlan({ home, shared, only, replace }) {
  const { items: local } = await readSnapshot(home);
  const rows = [];
  const items = {};
  for (const [id, raw] of Object.entries(shared)) {
    const row = { kind: 'claude', id, name: nameOf(id), category: categoryOf(id), bytes: bytesOf(id, raw) };
    if (!isSyncedFile(id) && !parseEntryId(id)) {
      rows.push({ ...row, fate: 'skip', reason: 'not an item this computer syncs' });
      continue;
    }
    if (!matchesOnly(only, row)) {
      rows.push({ ...row, fate: 'skip', reason: ONLY });
      continue;
    }
    const out = translate(id, raw, { from: SESSION_HOME, to: home, statusLineOf: local[SETTINGS] });
    // Yours as a push would send it: the same as the shared copy means nothing here is behind it.
    const mine = id in local ? translate(id, local[id], { from: home, to: SESSION_HOME, statusLineOf: raw }) : null;
    const same = mine && !mine.fate && (mine.value === raw || (id === SETTINGS && sameSettings(mine.value, raw)));
    if (out.fate) rows.push({ ...row, fate: out.fate, reason: out.reason });
    else if (same || local[id] === out.value) rows.push({ ...row, fate: 'skip', reason: 'the same as yours' });
    else if (id in local && !replace) rows.push({ ...row, fate: 'skip', reason: 'yours differs: --replace takes the shared one' });
    else {
      let { value, notes } = out;
      if (id === SETTINGS && id in local) {
        const own = withOwnCredentials(value, local[id]);
        value = own.value;
        notes = [
          ...(own.kept.length ? [`yours kept: ${own.kept.join(', ')}`] : []),
          ...(mine?.dropped?.length ? [`yours lost, in the backup: ${mine.dropped.map((d) => d.at).join(', ')}`] : []),
        ];
      }
      items[id] = value;
      rows.push({ ...row, fate: id in local ? 'replace' : 'write', reason: id in local ? 'differs from yours' : 'new here', notes });
    }
  }
  // applyItems deletes the synced files its items leave out, as a session takes a removal: here a pull only adds and
  // replaces, so this computer's own files go back in as they are. `before` is what was read here: a file written since
  // (claude making a skill as this runs) is neither overwritten nor deleted.
  const keep = Object.fromEntries(Object.entries(local).filter(([id]) => isSyncedFile(id)));
  return { rows, items: { ...keep, ...items }, before: local, replaced: Object.keys(items).filter((id) => id in local) };
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

/** My settings' own files for the repo, written into the checkout where git ignores them, as a session does. */
export function ownFilesPullPlan({ top, project, stored, only, replace }) {
  const rows = [];
  const write = {};
  for (const [file, text] of Object.entries(stored).sort(([a], [b]) => a.localeCompare(b))) {
    const row = { kind: 'own', id: `own:${project}/${file}`, name: file, category: 'own-files', bytes: Buffer.byteLength(text) };
    const why = skipReason(top, file);
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
  return { rows, write };
}

/**
 * @param {string[]} rest  what follows `settings` on the command line, the console's own options taken out
 * @returns {{sub: 'plan'|'push'|'pull', only: string[], ownFiles: string|null, replace: boolean}}
 */
export function parseSettingsArgs(rest) {
  const out = { sub: null, only: [], ownFiles: null, replace: false };
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
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (!out.sub && ['plan', 'push', 'pull'].includes(arg)) out.sub = arg;
    else throw new Error(`unexpected ${arg}: woodshed settings plan|push|pull [--only <what>,...] [--own-files <checkout>]`);
  }
  if (!out.sub) throw new Error('woodshed settings needs plan, push or pull');
  if (out.replace && out.sub !== 'pull') throw new Error('--replace is for pull');
  return out;
}

// The items each console's list was shown with, so push asks about only what was never listed (settings-shown.json in
// the command line's folder; names only, never content).
function shownStore(dir, origin) {
  const file = path.join(dir, 'settings-shown.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    has: () => new Set(read()[origin]?.ids ?? []),
    add(ids) {
      const all = read();
      all[origin] = { ids: [...new Set([...(all[origin]?.ids ?? []), ...ids])].sort(), at: new Date().toISOString() };
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

  const pulling = args.sub === 'pull';
  const claude = !claudeWanted ? { rows: [], changed: {}, items: {} }
    : pulling ? await claudePullPlan({ home, shared: shared.items, only: args.only, replace: args.replace })
      : await claudePushPlan({ home, shared: shared.items, only: args.only });
  const ownPlan = !own ? { rows: [], upload: {}, write: {} }
    : pulling ? ownFilesPullPlan({ top: own.top, project: own.project, stored: own.stored, only: args.only, replace: args.replace })
      : ownFilesPushPlan({ top: own.top, envFiles: own.envFiles, project: own.project, stored: own.stored, only: args.only });

  const moving = pulling ? ['write', 'replace'] : ['upload'];
  function show(title, rows) {
    if (!rows.length) return;
    say(title);
    const listed = rows.filter((r) => r.reason !== ONLY);
    const width = Math.min(48, Math.max(0, ...listed.map((r) => r.name.length)));
    for (const row of listed) {
      const why = [row.reason, ...(moving.includes(row.fate) ? row.notes ?? [] : [])].filter(Boolean).join('; ');
      say(`  ${row.fate.padEnd(8)}${size(row.bytes).padStart(9)}  ${row.name.padEnd(width)}  ${why}`);
    }
    if (listed.length < rows.length) say(`  (${rows.length - listed.length} more left out by --only)`);
  }
  const rows = [...claude.rows, ...ownPlan.rows];
  if (json) for (const { kind, id, name, category, bytes, fate, reason, notes } of rows) emit({ event: 'item', kind, id, name, category, bytes, fate, reason, ...(notes?.length ? { notes } : {}) });
  if (claudeWanted) show(pulling
    ? `Your shared Claude settings on ${origin} (version ${shared.version}), into ${home}:`
    : `Claude settings in ${home}/.claude and ${home}/.claude.json, against your shared copy on ${origin} (version ${shared.version}):`, claude.rows);
  if (own) show(pulling
    ? `Your own files for ${own.repo} on My settings, into ${own.top}:`
    : `Files git ignores in ${own.top}, as your own files for ${own.repo} on My settings:`, ownPlan.rows);
  const counts = Object.fromEntries(['upload', 'write', 'replace', 'skip', 'refuse'].map((f) => [f, rows.filter((r) => r.fate === f).length]));
  const words = Object.entries(counts).filter(([, n]) => n).map(([f, n]) => `${n} ${f === 'skip' ? 'skipped' : f === 'refuse' ? 'refused' : `to ${f}`}`).join(', ') || 'nothing found';
  const merged = { ...shared.items, ...claude.changed };
  const overBudget = !pulling && Buffer.byteLength(JSON.stringify({ version: shared.version, items: merged })) > MAX_SETTINGS_BYTES;
  if (overBudget) ctx.warn(`Your shared copy would be over the ${MAX_SETTINGS_BYTES / 1024 / 1024} MB the console keeps: leave something out with --only`);
  if (rows.some((r) => r.fate === 'refuse')) say('Refused items stay here. Sign in to an MCP server in a session, and keep an API key in your own env file values on My settings, Repo settings.');
  const shown = shownStore(ctx.dir, origin);
  const outgoing = rows.filter((r) => moving.includes(r.fate));

  if (args.sub === 'plan') {
    shown.add(outgoing.map((r) => r.id));
    if (json) emit({ event: 'plan', console: origin, version: shared.version, ...counts, sent: false });
    say(`${words}. Nothing was sent.`);
    return EXIT.done;
  }
  if (!outgoing.length) {
    if (json) emit({ event: pulling ? 'pulled' : 'pushed', console: origin, ...counts, sent: 0 });
    say(`${words}. Nothing to ${pulling ? 'write' : 'send'}.`);
    return EXIT.done;
  }

  if (pulling) {
    const backup = backupReplaced({ dir: ctx.dir, home, ids: claude.replaced ?? [], top: own?.top, files: ownPlan.rows.filter((r) => r.fate === 'replace').map((r) => r.name) });
    const written = claude.rows.some((r) => moving.includes(r.fate)) ? await applyItems(home, claude.items, { before: claude.before }) : { written: 0 };
    const own_ = Object.keys(ownPlan.write).length ? writeOwnFiles(own.top, ownPlan.write) : { written: [], skipped: [] };
    if (backup) say(`What was replaced is kept in ${backup}.`);
    if (json) emit({ event: 'pulled', console: origin, version: shared.version, written: written.written, ownFilesWritten: own_.written.length, ...(backup ? { backup } : {}), ...counts });
    const left = ['skip', 'refuse'].filter((f) => counts[f]).map((f) => `${counts[f]} ${f === 'skip' ? 'skipped' : 'refused'}`);
    say(`${written.written + own_.written.length} written here${counts.replace ? ` (${counts.replace} replaced)` : ''}${left.length ? `, ${left.join(', ')}` : ''}.`);
    if (claude.rows.some((r) => moving.includes(r.fate) && r.category === 'mcp')) say('MCP servers reach claude as it starts: a claude open now may write over ~/.claude.json, so start it again.');
    return EXIT.done;
  }

  if (overBudget) throw fail('Nothing sent.', { code: EXIT.refused, status: 'too-large' });
  const seen = shown.has();
  const unseen = outgoing.filter((r) => !seen.has(r.id));
  if (unseen.length) {
    if (!interactive) {
      throw fail(`${unseen.length} of these ${unseen.length === 1 ? 'was' : 'were'} never shown before. Nothing sent: run woodshed settings plan, which sends nothing, then push again.`, { code: EXIT.waiting, status: 'not-shown' });
    }
    const answer = await ask(`Upload ${outgoing.length} item${outgoing.length === 1 ? '' : 's'} to ${origin}? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      say('Nothing sent.');
      return EXIT.waiting;
    }
  }
  shown.add(outgoing.map((r) => r.id));
  let version = shared.version;
  if (Object.keys(claude.changed).length) {
    const answer = await call(origin, '/api/cli/settings', { method: 'POST', token, body: { version: shared.version, changed: claude.changed, removed: [] } });
    if (answer.status !== 200) throw fail(`${origin} did not take your Claude settings (${answer.status}): ${String(answer.body?.error ?? '').slice(0, 200)}`);
    version = answer.body.version;
  }
  const failed = [];
  for (const [file, text] of Object.entries(ownPlan.upload)) {
    const answer = await call(origin, `/api/cli/settings/files/${encodeURIComponent(own.project)}`, { method: 'POST', token, body: { path: file, text } });
    if (answer.status !== 200) failed.push({ file, error: String(answer.body?.error ?? answer.status).slice(0, 200) });
  }
  const sentOwn = Object.keys(ownPlan.upload).length - failed.length;
  if (json) emit({ event: 'pushed', console: origin, version, sent: Object.keys(claude.changed).length, ownFilesSent: sentOwn, failed, ...counts });
  if (Object.keys(claude.changed).length) say(`Sent ${Object.keys(claude.changed).length} Claude item${Object.keys(claude.changed).length === 1 ? '' : 's'}: your shared copy is version ${version}. Running sessions take them within a minute; MCP servers as a session starts.`);
  if (own) say(`Saved ${sentOwn} own file${sentOwn === 1 ? '' : 's'} for ${own.repo}: your next session on it writes them.`);
  for (const { file, error } of failed) ctx.warn(`${file} not saved: ${error}`);
  return failed.length ? EXIT.failed : EXIT.done;
}
