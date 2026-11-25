// Each person's shared Claude and Codex settings (session/settingsSync.mjs has which items): the copy their running My Woodshed
// sessions keep in step with, a few seconds apart. Held here and saved to the homes bucket after each change, as
// `<login>/claude-settings.json`, so a console restart loses nothing; a person's is read back the first time one of
// their sessions asks.
//
// Merged item by item: a session sends what it changed since the version it last had, and gets back the whole copy
// whenever another session changed something in between. Servers sent by a computer are kept in a separate map in
// the same object. The session API never returns that map, so importing a laptop's server cannot install it there.

import { CODEX_CONFIG, configCredential, isCodexMcp, pathOf, readToml, stringsOf, withEntries } from '../shared/codexConfig.mjs';
import { isCarriedSource } from '../shared/pluginSource.mjs';
import { redact, secretContent } from '../shared/secretLike.mjs';
import logins from './public/logins.cjs';
const { loginKey } = logins;

// MCP logins and a few files: anything near this is something else in a skills folder.
export const MAX_SETTINGS_BYTES = 5 * 1024 * 1024;

function settingsKey(login) {
  return `${loginKey(login)}/claude-settings.json`;
}

// The session checks each id against what it syncs; this keeps a path out of the shared copy that could reach outside
// ~/.claude and ~/.codex in the owner's other sessions. A plugin's item is under ~/.claude too (its list's file).
const ITEM_ID_RE = /^\.(?:claude|codex)(?:\/[^/\\\0]+)+$|^\.claude\.json#mcpServers\/[^\0]+$/;
const isMcpServerItem = (id) => id.startsWith('.claude.json#mcpServers/');

/** Whether a credential field holds text other than variable references and an optional auth scheme. */
export function hasLiteralCredential(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  // Remove only complete references without a fallback value. Anything malformed or literal remains.
  return value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(:-)?\}/g, '').replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim() !== '';
}

/** An MCP service or an HTTP hook can use any header for auth. Carry only references and empty headers. */
export function hasLiteralHttpHeader(config) {
  return Object.values(config?.headers ?? {}).some((value) => typeof value !== 'string' || hasLiteralCredential(value));
}

function laptopMcpProblem(value) {
  let server;
  try {
    server = JSON.parse(value);
  } catch {}
  if (!server || typeof server !== 'object' || Array.isArray(server)) return 'expected an MCP server definition as a JSON object';
  if (hasLiteralHttpHeader(server)) return 'an MCP server sends a literal HTTP header: use a variable reference';
  return null;
}

function hasLiteralHookHeader(value) {
  let settings;
  try {
    settings = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return false;
  }
  return Object.values(settings?.hooks ?? {}).some((groups) => Array.isArray(groups)
    && groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(hasLiteralHttpHeader)));
}

function isItemId(id) {
  const filePart = id.split('#')[0];
  return id.length <= 512 && ITEM_ID_RE.test(id) && !filePart.split('/').some((part) => part === '..' || part === '.');
}

function isItemMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([id, v]) => isItemId(id) && typeof v === 'string');
}

const PLUGIN_ITEM = '.claude/plugins/installed_plugins.json#plugins/';

/**
 * Why the shared copy may not hold an item as sent, or null. A session and a computer leave out what this refuses
 * (session/settingsSync.mjs, cli/settings.mjs): a client that does not is refused here, so the copy, which the person's
 * computer and every one of their sessions read, never holds codex config with a credential in it or a plugin's
 * marketplace with more than a session can add again.
 */
export function itemProblem(id, value, { fromLaptop = false } = {}) {
  if (id === '.codex/auth.json') return 'a Codex sign-in stays where it was set';
  if (id === CODEX_CONFIG) {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const credential = configCredential(text);
    if (credential) return `~/.codex/config.toml ${credential}: a credential stays where it was set`;
    if (fromLaptop && readToml(text).some(isCodexMcp)) return 'Codex MCP servers from a computer stay on that computer';
    return null;
  }
  if (id.startsWith(PLUGIN_ITEM)) {
    // Its name is said back and logged: one with a key's shape is refused without it.
    if (secretContent(id)) return 'a plugin\'s name holds what looks like a key';
    let item = null;
    try {
      item = JSON.parse(value);
    } catch {}
    const fine = item && typeof item === 'object' && Object.keys(item).join() === 'marketplace' && isCarriedSource(item.marketplace);
    return fine ? null : `${redact(id.slice(PLUGIN_ITEM.length))}'s marketplace is not one a session can add`;
  }
  return null;
}

/**
 * @param {unknown} body
 * @returns {{version: number|null, changed: Record<string, string>, removed: string[]}|null}  null when malformed
 */
export function parseSyncBody(body) {
  if (!body || typeof body !== 'object') return null;
  const { version, changed = {}, removed = [] } = body;
  if (version !== null && !Number.isInteger(version)) return null;
  if (!isItemMap(changed) || !Array.isArray(removed) || !removed.every((r) => typeof r === 'string' && isItemId(r))) return null;
  return { version, changed, removed };
}

const CLAUDE_SETTINGS = '.claude/settings.json';
// What New session may show of a saved choice: a model or effort name, never anything longer or stranger, since it is
// drawn on the page and is the person's own file.
const SHOWN_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,63}$/;
const SHOWN_EFFORT = /^[a-z]{1,16}$/;

/**
 * @typedef {{read: boolean, model: string|null, effort: string|null}} SavedChoice
 *   read: false when the copy, or the agent's file in it, could not be read, so nothing is known of what it names; with
 *   read true, a null model or effort is one nothing saved, which the agent picks itself
 */

const unread = () => ({ read: false, model: null, effort: null });

function shown(value, re) {
  if (value === undefined || value === null) return { ok: true, value: null };
  return typeof value === 'string' && re.test(value) ? { ok: true, value } : { ok: false };
}

/** Claude Code's saved `model` and `effortLevel` (what `/model` writes) in a settings.json item. */
function claudeChoice(item) {
  if (item === undefined) return { read: true, model: null, effort: null };
  let settings;
  try {
    settings = JSON.parse(Buffer.from(item, 'base64').toString('utf8'));
  } catch {
    return unread();
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return unread();
  const model = shown(settings.model, SHOWN_MODEL);
  const effort = shown(settings.effortLevel, SHOWN_EFFORT);
  return model.ok && effort.ok ? { read: true, model: model.value, effort: effort.value } : unread();
}

/** Codex's `model` and `model_reasoning_effort` in a config.toml item, the `profile`'s own over the top level's. */
function codexChoice(item) {
  if (item === undefined) return { read: true, model: null, effort: null };
  const statements = readToml(Buffer.from(item, 'base64').toString('utf8'));
  if (!statements) return unread();
  // A value is shown only when it is one string, as codex reads it: anything else is not known.
  const values = new Map();
  for (const st of statements) {
    if (st.kind !== 'kv') continue;
    const strings = stringsOf(st.value);
    values.set(pathOf(st).join('.'), strings.length === 1 && strings[0].raw === st.value.trim() ? strings[0].said : undefined);
  }
  const at = (path) => (values.has(path) ? (values.get(path) === undefined ? { ok: false } : { ok: true, value: values.get(path) }) : { ok: true, value: null });
  const profile = at('profile');
  if (!profile.ok) return unread();
  const pick = (key, re) => {
    const own = profile.value ? at(`profiles.${profile.value}.${key}`) : { ok: true, value: null };
    const top = at(key);
    if (!own.ok || !top.ok) return { ok: false };
    return shown(own.value ?? top.value, re);
  };
  const model = pick('model', SHOWN_MODEL);
  const effort = pick('model_reasoning_effort', SHOWN_EFFORT);
  return model.ok && effort.ok ? { read: true, model: model.value, effort: effort.value } : unread();
}

/**
 * What each agent's "default" is in a person's next session, from their shared copy: the model and effort Claude Code's
 * settings.json and Codex's config.toml name, which a new session starts from. Grok Build and OpenCode keep theirs in no
 * file a session carries, so they are not here: each picks its own.
 * @param {Record<string, string>|null} items  the copy's items, or null when it could not be read
 * @returns {{claude: SavedChoice, codex: SavedChoice}}
 */
export function savedChoices(items) {
  if (!items) return { claude: unread(), codex: unread() };
  return { claude: claudeChoice(items[CLAUDE_SETTINGS]), codex: codexChoice(items[CODEX_CONFIG]) };
}

/**
 * @param {{store: {getText: (key: string) => Promise<string|null>, putText: (key: string, text: string) => Promise<void>,
 *          removeKey: (key: string) => Promise<void>}}} opts  the provider's home store
 */
export function createClaudeSettings({ store }) {
  const held = new Map();
  // One read or write at a time per person, so two sessions' changes never race to S3.
  const turns = new Map();

  function inTurn(login, fn) {
    const next = (turns.get(login) ?? Promise.resolve()).then(fn, fn);
    turns.set(login, next.catch(() => {}));
    return next;
  }

  async function load(login) {
    if (held.has(login)) return held.get(login);
    const text = await store.getText(settingsKey(login));
    const saved = text ? JSON.parse(text) : null;
    const { version, items } = Number.isInteger(saved?.version) && isItemMap(saved.items) ? saved : { version: 0, items: {} };
    const laptopMcp = isItemMap(saved?.laptopMcp) && Object.keys(saved.laptopMcp).every(isMcpServerItem) ? saved.laptopMcp : {};
    const cliVersion = Number.isInteger(saved?.cliVersion) ? saved.cliVersion : version;
    const copy = { version, items, laptopMcp, cliVersion };
    held.set(login, copy);
    return copy;
  }

  /**
   * @param {{login: string, sessionId: string, version: number|null, changed: Record<string, string>, removed: string[]}} args
   * @param {{fromLaptop?: boolean}} [opts]  set by the command line route after authenticating its caller
   * @returns {Promise<{version: number, items?: Record<string, string>}>}  items when the caller's copy is behind
   */
  function sync({ login, sessionId, version, changed, removed }, { fromLaptop = false } = {}) {
    return inTurn(login, async () => {
      const copy = await load(login);
      const versionOf = (state) => fromLaptop ? state.cliVersion : state.version;
      const current = version === versionOf(copy);
      const answer = (state) => current ? { version: versionOf(state) } : {
        version: versionOf(state), items: fromLaptop ? { ...state.items, ...state.laptopMcp } : state.items,
      };
      const changes = Object.entries(changed);
      if (!changes.length && !removed.length) return answer(copy);
      const items = { ...copy.items };
      const laptopMcp = { ...copy.laptopMcp };
      const laptopItem = (id) => fromLaptop && isMcpServerItem(id);
      let sessionChanges = false;
      for (const [id, value] of changes) {
        if (fromLaptop && id === '.claude/settings.json' && hasLiteralHookHeader(value)) {
          throw Object.assign(new Error('a hook sends a literal HTTP header: use a variable reference'), { shown: true, status: 400 });
        }
        const fromComputer = laptopItem(id);
        const problem = fromComputer ? laptopMcpProblem(value) : itemProblem(id, value, { fromLaptop });
        if (problem) throw Object.assign(new Error(problem), { shown: true, status: 400 });
        if (fromComputer) {
          laptopMcp[id] = value;
        } else {
          let nextValue = value;
          if (fromLaptop && id === CODEX_CONFIG && items[id] !== undefined) {
            const previous = readToml(Buffer.from(items[id], 'base64').toString('utf8'));
            const servers = previous?.filter(isCodexMcp) ?? [];
            if (servers.length) nextValue = Buffer.from(withEntries(Buffer.from(value, 'base64').toString('utf8'), servers)).toString('base64');
          }
          items[id] = nextValue;
          sessionChanges = true;
        }
      }
      for (const id of removed) {
        if (laptopItem(id)) delete laptopMcp[id];
        else {
          delete items[id];
          sessionChanges = true;
        }
      }
      // A laptop-only edit does not make an empty session copy look initialized to a first session.
      const next = { version: copy.version + Number(sessionChanges), items, laptopMcp, cliVersion: copy.cliVersion + 1 };
      const text = JSON.stringify({ ...next, updatedAt: new Date().toISOString(), updatedBy: sessionId });
      if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) {
        throw Object.assign(new Error(`the shared Claude settings would be over ${MAX_SETTINGS_BYTES / 1024 / 1024} MB`), { shown: true });
      }
      await store.putText(settingsKey(login), text);
      held.set(login, next);
      console.log('claudeSettings: changed', { login, sessionId, version: versionOf(next), changed: changes.length, removed: removed.length, wasCurrent: current });
      return answer(next);
    });
  }

  /** Forget it and Remove My Woodshed: the MCP logins in here are as much theirs to forget as the home. */
  function remove(login) {
    return inTurn(login, async () => {
      await store.removeKey(settingsKey(login));
      held.delete(login);
      console.log('claudeSettings: deleted', { login });
    });
  }

  /**
   * The copy as it is, for a page to read from: no version is bumped and nothing written.
   * @returns {Promise<{version: number, items: Record<string, string>}>}
   */
  function peek(login) {
    return inTurn(login, async () => {
      const copy = await load(login);
      return { version: copy.version, items: { ...copy.items } };
    });
  }

  return { sync, remove, peek };
}
