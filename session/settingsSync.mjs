// A My Woodshed owner's own Claude settings, the same in every one of their sessions while they run: a change in one
// reaches the others within SYNC_EVERY_MS, and a new session starts with the latest. The rest of the Claude home
// (transcripts, claude's own state) stays each session's own; homes.mjs keeps that.
//
// Each item is a file, or one entry of a JSON map that claude rewrites whole from what it holds in memory. Those two
// are merged entry by entry, and an entry gone from one session's file is not taken out of the others': a session
// that never saw a teammate session's new MCP login would otherwise delete it the next time it wrote the file. So a
// logout, or `claude mcp remove`, stays in the session it was made in.
//
//   node settingsSync.mjs pull   the entrypoint, before claude starts: the latest, applied over the restored home
//
// statusd runs syncSettings every SYNC_EVERY_MS after that.

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isMain } from '../shared/isMain.mjs';

export const SYNCED_FILES = ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/keybindings.json'];
export const SYNCED_DIRS = ['.claude/agents', '.claude/commands', '.claude/skills'];
// `live: false`: claude reads ~/.claude.json's servers only as it starts, and rewrites that file all the time, so a
// write into it under a running claude would only be lost. A new server reaches a session as it starts.
export const SYNCED_ENTRIES = [
  { file: '.claude/.credentials.json', key: 'mcpOAuth', live: true },
  { file: '.claude.json', key: 'mcpServers', live: false },
];
export const SYNC_EVERY_MS = 20_000;
// A settings file is a few KB; this keeps a stray log or binary dropped in skills/ out.
export const MAX_ITEM_BYTES = 1024 * 1024;


// settings.json is synced, but its statusLine is each session's own: the entrypoint writes it at every start, naming
// a path in that session's image. Carried between sessions, a newer image's path would reach a session still on an
// older one, which may not have it, and stop its status line. So a session keeps its own on apply, and sends the
// shared copy's back unchanged.
const SETTINGS = '.claude/settings.json';
// A settings.json with no status line, for what a session sends when no shared copy has one to keep.
const NO_STATUS_LINE = Buffer.from('{}').toString('base64');

function settingsJson(b64) {
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Whether two settings.json contents say the same, whatever their formatting. */
function sameSettings(a, b) {
  const x = settingsJson(a);
  const y = settingsJson(b);
  return x && y ? canonical(x) === canonical(y) : a === b;
}

/** settings.json's content with `statusLine` taken from `from`; its own bytes when the two already agree. */
export function withStatusLineOf(b64, from) {
  const json = settingsJson(b64);
  const source = from === undefined ? {} : settingsJson(from);
  if (!json || !source || canonical(json.statusLine) === canonical(source.statusLine)) return b64;
  const { statusLine, ...rest } = json;
  const out = source.statusLine === undefined ? rest : { ...rest, statusLine: source.statusLine };
  return Buffer.from(`${JSON.stringify(out, null, 2)}\n`).toString('base64');
}
export const STATE_FILE = '/tmp/woodshed-settings-sync.json';
// A write renamed into place; one a crash left halfway is swept at the next start.
const TEMP_SUFFIX = '.woodshed-';
const REQUEST_TIMEOUT_MS = 15_000;
// The stop's last round: the console gives the whole checkpoint 90 s, and the home's upload and the push come after.
export const STOP_TIMEOUT_MS = 8_000;

function entryId(file, key, name) {
  return `${file}#${key}/${name}`;
}

/** @returns {{file: string, key: string, name: string, live: boolean}|null}  what an entry id names, null for a file */
export function parseEntryId(id) {
  for (const e of SYNCED_ENTRIES) {
    const prefix = `${e.file}#${e.key}/`;
    if (id.startsWith(prefix)) return { ...e, name: id.slice(prefix.length) };
  }
  return null;
}

// Ids come back from the console, which any of the owner's sessions writes to: one must never name a file outside the
// synced ones, such as `.claude/skills/../../.bashrc`.
export function isSyncedFile(id) {
  if (typeof id !== 'string' || /[\\\0]/.test(id) || path.posix.normalize(id) !== id || id.split('/').includes('..')) return false;
  return SYNCED_FILES.includes(id) || SYNCED_DIRS.some((d) => id.startsWith(`${d}/`));
}

function inside(home, id) {
  const rel = path.relative(path.join(home, '.claude'), path.resolve(home, id));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function filesUnder(home, dir) {
  const found = [];
  const entries = await fs.readdir(path.join(home, dir), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) found.push(...await filesUnder(home, rel));
    else if (e.isFile()) found.push(rel);
  }
  return found;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // Half written as we read it: this round leaves the file out, the next one reads it whole.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * @param {string} home
 * @returns {Promise<{items: Record<string, string>, unreadable: string[], oversized: string[]}>}  each item's content: a
 *   file's as base64, an entry's as JSON. `unreadable` names the JSON files left out this round, whose entries must not
 *   read as removed; `oversized` the files over MAX_ITEM_BYTES, which are neither removed nor overwritten
 */
export async function readSnapshot(home) {
  const items = {};
  const oversized = [];
  const files = [...SYNCED_FILES];
  for (const dir of SYNCED_DIRS) files.push(...await filesUnder(home, dir));
  for (const rel of files) {
    const content = await fs.readFile(path.join(home, rel)).catch((err) => (err.code === 'ENOENT' || err.code === 'EISDIR' ? null : Promise.reject(err)));
    if (!content) continue;
    if (content.length > MAX_ITEM_BYTES) oversized.push(rel);
    else items[rel] = content.toString('base64');
  }
  const unreadable = [];
  for (const { file, key } of SYNCED_ENTRIES) {
    const json = await readJson(path.join(home, file));
    if (json === null) {
      unreadable.push(file);
      continue;
    }
    const map = json[key];
    if (!map || typeof map !== 'object') continue;
    for (const [name, value] of Object.entries(map)) items[entryId(file, key, name)] = JSON.stringify(value);
  }
  return { items, unreadable, oversized };
}

/**
 * What this session changed since the shared copy it last had. An entry missing here is not a removal (see above).
 * @param {Record<string, string>} synced  the shared copy this session last applied or sent
 * @param {Record<string, string>} local
 * @param {string[]} [oversized]  files still here but too big to send, which other sessions keep as last shared
 * @returns {{changed: Record<string, string>, removed: string[]}}
 */
export function localChanges(synced, local, oversized = []) {
  const changed = {};
  for (const [id, value] of Object.entries(local)) if (synced[id] !== value) changed[id] = value;
  const removed = Object.keys(synced).filter((id) => isSyncedFile(id) && !(id in local) && !oversized.includes(id));
  return { changed, removed };
}

/**
 * Writes the shared copy over the home: each file that differs, each entry into its JSON map, and deletes the synced
 * files the shared copy no longer has.
 * @param {string} home
 * @param {Record<string, string>} items
 * @param {{live?: boolean, before?: Record<string, string>}} [opts]  live: claude is running, so entries it reads only at
 *   start are left alone. before: the snapshot the round sent; an item changed on disk since is someone's edit made
 *   while the request was out, so it is left for the next round to send rather than overwritten or deleted
 * @returns {Promise<{written: number, deleted: number, skipped: string[]}>}  skipped: the entries left alone for `live`
 */
export async function applyItems(home, items, { live = false, before = null } = {}) {
  let written = 0;
  let deleted = 0;
  const skipped = [];
  const { items: local, oversized } = await readSnapshot(home);
  const untouched = (id) => !before || before[id] === local[id];
  for (const [id, shared] of Object.entries(items)) {
    // This session's own status line stays (see SETTINGS).
    const value = id === SETTINGS && local[id] ? withStatusLineOf(shared, local[id]) : shared;
    const same = local[id] === value || (id === SETTINGS && local[id] && sameSettings(local[id], value));
    if (!isSyncedFile(id) || !inside(home, id) || same || oversized.includes(id) || !untouched(id)) continue;
    const target = path.join(home, id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(value, 'base64'));
    written += 1;
  }
  for (const id of Object.keys(local)) {
    if (!isSyncedFile(id) || !inside(home, id) || id in items || !untouched(id)) continue;
    await fs.rm(path.join(home, id), { force: true });
    deleted += 1;
  }
  for (const { file, key, live: readLive } of SYNCED_ENTRIES) {
    const wanted = Object.entries(items).filter(([id]) => parseEntryId(id)?.file === file && parseEntryId(id)?.key === key);
    if (!wanted.length) continue;
    const target = path.join(home, file);
    const json = live && !readLive ? null : await readJson(target);
    if (json === null) {
      skipped.push(...wanted.map(([id]) => id));
      continue;
    }
    const map = json[key] && typeof json[key] === 'object' ? json[key] : {};
    let changed = false;
    for (const [id, value] of wanted) {
      const { name } = parseEntryId(id);
      if (JSON.stringify(map[name]) === value || !untouched(id)) continue;
      map[name] = JSON.parse(value);
      changed = true;
      written += 1;
    }
    if (!changed) continue;
    json[key] = map;
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Renamed into place, so claude never reads it half written. Logins are secrets, readable by their owner alone as
    // claude leaves them: the mode is set on the new file, whatever the old one had.
    const temp = `${target}${TEMP_SUFFIX}${process.pid}`;
    try {
      await fs.writeFile(temp, JSON.stringify(json, null, 2), { mode: 0o600 });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
  }
  return { written, deleted, skipped };
}

/** The applied state, for statusd to carry on from what the entrypoint pulled. */
export async function readState(file = STATE_FILE) {
  const json = await readJson(file).catch(() => null);
  return json && typeof json.version === 'number' ? { version: json.version, synced: json.synced ?? {} } : { version: null, synced: {} };
}

export async function writeState(state, file = STATE_FILE) {
  await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
}

/**
 * POST /claude-settings on the console's session API.
 * @returns {Promise<{version: number, items?: Record<string, string>}|null>}  null where the console keeps none
 */
export function exchange({ consoleUrl, token, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${consoleUrl}/claude-settings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`the console answered ${res.statusCode}: ${text.slice(0, 200)}`));
        return resolve(JSON.parse(text));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * One round: send what changed here, take what changed elsewhere. A session that has never synced sends nothing until
 * it has the shared copy, so a home restored from an older save never overwrites newer settings; when there is no
 * shared copy yet, its own settings become it.
 * @param {{home: string, state: {version: number|null, synced: Record<string, string>}, live: boolean,
 *          send: (body: object) => Promise<{version: number, items?: Record<string, string>}|null>}} args
 * @returns {Promise<{state: object, sent: number, removed: number, written: number, deleted: number}|null>}  null when
 *   the console keeps no settings
 */
export async function syncOnce({ home, state, live, send }) {
  const { items: local, unreadable, oversized } = await readSnapshot(home);
  const known = state.version !== null;
  let { changed, removed } = known ? localChanges(state.synced, local, oversized) : { changed: {}, removed: [] };
  // A JSON file read mid-write is left out of this round entirely: its entries are neither sent nor counted as gone.
  for (const file of unreadable) for (const id of Object.keys(changed)) if (parseEntryId(id)?.file === file) delete changed[id];
  // The shared copy's status line goes back as it was, and a difference in it alone is no change. With no shared copy
  // to take one from, none goes out: this session's names a path in its own image.
  if (changed[SETTINGS]) {
    changed[SETTINGS] = withStatusLineOf(changed[SETTINGS], state.synced[SETTINGS] ?? NO_STATUS_LINE);
    if (state.synced[SETTINGS] && sameSettings(changed[SETTINGS], state.synced[SETTINGS])) delete changed[SETTINGS];
  }
  let answer = await send({ version: state.version, changed, removed });
  if (!answer) return null;
  if (!known && answer.version === 0) {
    ({ changed, removed } = localChanges({}, local));
    if (changed[SETTINGS]) changed[SETTINGS] = withStatusLineOf(changed[SETTINGS], NO_STATUS_LINE);
    answer = await send({ version: 0, changed, removed: [] });
    if (!answer) return null;
  }
  let synced;
  let applied = { written: 0, deleted: 0 };
  if (answer.items) {
    const { skipped, ...counts } = await applyItems(home, answer.items, { live, before: local });
    applied = counts;
    synced = { ...answer.items };
    // What was not written is recorded as what is here, or this session's older value would read as a change of its own
    // and go back over the newer one.
    for (const id of skipped) {
      if (id in local) synced[id] = local[id];
      else delete synced[id];
    }
  } else {
    synced = { ...state.synced, ...changed };
    for (const id of removed) delete synced[id];
  }
  return { state: { version: answer.version, synced }, sent: Object.keys(changed).length, removed: removed.length, ...applied };
}

async function pullAtStart() {
  const consoleUrl = process.env.WOODSHED_CONSOLE_URL;
  const token = process.env.SESSION_TOKEN;
  if (!consoleUrl || !token) return;
  const home = os.homedir();
  for (const { file } of SYNCED_ENTRIES) {
    const dir = path.dirname(path.join(home, file));
    const prefix = `${path.basename(file)}${TEMP_SUFFIX}`;
    for (const name of await fs.readdir(dir).catch(() => [])) if (name.startsWith(prefix)) await fs.rm(path.join(dir, name), { force: true });
  }
  const result = await syncOnce({ home, state: { version: null, synced: {} }, live: false, send: (body) => exchange({ consoleUrl, token, body }) });
  if (!result) {
    console.log('settings: this console keeps no shared settings');
    return;
  }
  await writeState(result.state);
  console.log(`settings: version ${result.state.version}, ${result.written} written, ${result.deleted} deleted, ${result.sent} sent`);
}

if (isMain(import.meta.url) && process.argv[2] === 'pull') {
  pullAtStart().catch((err) => {
    console.error(`settings: not pulled: ${err.message}`);
    process.exit(1);
  });
}
