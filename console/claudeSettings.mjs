// Each person's shared Claude settings (session/settingsSync.mjs has which items): the copy their running My Woodshed
// sessions keep in step with, a few seconds apart. Held here and saved to the homes bucket after each change, as
// `<login>/claude-settings.json`, so a console restart loses nothing; a person's is read back the first time one of
// their sessions asks.
//
// Merged item by item: a session sends what it changed since the version it last had, and gets back the whole copy
// whenever another session changed something in between. Servers sent by a computer are kept in a separate map in
// the same object. The session API never returns that map, so importing a laptop's server cannot install it there.

import logins from './public/logins.cjs';
const { loginKey } = logins;

// MCP logins and a few files: anything near this is something else in a skills folder.
export const MAX_SETTINGS_BYTES = 5 * 1024 * 1024;

function settingsKey(login) {
  return `${loginKey(login)}/claude-settings.json`;
}

// The session checks each id against what it syncs; this keeps a path out of the shared copy that could reach outside
// ~/.claude in the owner's other sessions.
const ITEM_ID_RE = /^\.claude(?:\/[^/\\\0]+)+$|^\.claude\.json#mcpServers\/[^\0]+$/;
const isMcpServerItem = (id) => id.startsWith('.claude.json#mcpServers/');

/** Whether a credential field holds text other than variable references and an optional auth scheme. */
export function hasLiteralCredential(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  // Remove only complete references without a fallback value. Anything malformed or literal remains.
  return value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(:-)?\}/g, '').replace(/^\s*(Bearer|Basic|Token)\s+/i, '').trim() !== '';
}

/** An MCP service can use any header for auth. Only references and empty headers travel between computers. */
export function hasLiteralMcpHeader(server) {
  return Object.values(server?.headers ?? {}).some((value) => typeof value !== 'string' || hasLiteralCredential(value));
}

function laptopMcpProblem(value) {
  let server;
  try {
    server = JSON.parse(value);
  } catch {}
  if (!server || typeof server !== 'object' || Array.isArray(server)) return 'expected an MCP server definition as a JSON object';
  if (hasLiteralMcpHeader(server)) return 'an MCP server sends a literal HTTP header: use a variable reference';
  return null;
}

function isItemId(id) {
  const filePart = id.split('#')[0];
  return id.length <= 512 && ITEM_ID_RE.test(id) && !filePart.split('/').some((part) => part === '..' || part === '.');
}

function isItemMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([id, v]) => isItemId(id) && typeof v === 'string');
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
        if (laptopItem(id)) {
          const problem = laptopMcpProblem(value);
          if (problem) throw Object.assign(new Error(problem), { shown: true, status: 400 });
          laptopMcp[id] = value;
        } else {
          items[id] = value;
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

  return { sync, remove };
}
