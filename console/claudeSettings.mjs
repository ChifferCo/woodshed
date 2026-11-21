// Each person's shared Claude and Codex settings (session/settingsSync.mjs has which items): the copy their running My Woodshed
// sessions keep in step with, a few seconds apart. Held here and saved to the homes bucket after each change, as
// `<login>/claude-settings.json`, so a console restart loses nothing; a person's is read back the first time one of
// their sessions asks.
//
// Merged item by item: a session sends what it changed since the version it last had, and gets back the whole copy
// whenever another session changed something in between.

import { CODEX_CONFIG, configCredential } from '../shared/codexConfig.mjs';
import { isCarriedSource } from '../shared/pluginSource.mjs';
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
export function itemProblem(id, value) {
  if (id === CODEX_CONFIG) {
    const credential = configCredential(Buffer.from(value, 'base64').toString('utf8'));
    return credential ? `~/.codex/config.toml ${credential}: a credential stays where it was set` : null;
  }
  if (id.startsWith(PLUGIN_ITEM)) {
    let item = null;
    try {
      item = JSON.parse(value);
    } catch {}
    const fine = item && typeof item === 'object' && Object.keys(item).join() === 'marketplace' && isCarriedSource(item.marketplace);
    return fine ? null : `${id.slice(PLUGIN_ITEM.length)}'s marketplace is not one a session can add`;
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
    const copy = saved && isItemMap(saved.items) ? saved : { version: 0, items: {} };
    held.set(login, copy);
    return copy;
  }

  /**
   * @param {{login: string, sessionId: string, version: number|null, changed: Record<string, string>, removed: string[]}} args
   * @returns {Promise<{version: number, items?: Record<string, string>}>}  items when the session's copy is behind
   */
  function sync({ login, sessionId, version, changed, removed }) {
    return inTurn(login, async () => {
      const copy = await load(login);
      const current = version === copy.version;
      const changes = Object.keys(changed).length + removed.length;
      if (!changes) return current ? { version: copy.version } : { version: copy.version, items: copy.items };
      for (const [id, value] of Object.entries(changed)) {
        const problem = itemProblem(id, value);
        if (problem) throw Object.assign(new Error(problem), { shown: true, status: 400 });
      }
      const items = { ...copy.items, ...changed };
      for (const id of removed) delete items[id];
      const text = JSON.stringify({ version: copy.version + 1, items, updatedAt: new Date().toISOString(), updatedBy: sessionId });
      if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) {
        throw Object.assign(new Error(`the shared Claude settings would be over ${MAX_SETTINGS_BYTES / 1024 / 1024} MB`), { shown: true });
      }
      await store.putText(settingsKey(login), text);
      const next = { version: copy.version + 1, items };
      held.set(login, next);
      console.log('claudeSettings: changed', { login, sessionId, version: next.version, changed: Object.keys(changed).length, removed: removed.length, wasCurrent: current });
      // A session that was current has every item already: its own changes are the only new ones.
      return current ? { version: next.version } : next;
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

  return { sync, remove };
}
