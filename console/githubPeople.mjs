// Who each GitHub handle is: its display name, for the pages, and the account's numeric id, which never changes.
// The handle stays the key everywhere else. GitHub frees a handle its owner renamed away from, and another account
// can then take it: the first id seen for a handle is kept, and a sign-in or a trigger from another account under
// it is refused, so it never lands on the first one's token and settings. Kept in state.json under
// `githubAccounts`, apart from `people` (userSettings.mjs), which Remove My Woodshed deletes.

import logins from './public/logins.cjs';
const { loginKey } = logins;

const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 15 * 60_000;

/**
 * @param {{store: {state: object, save: () => void}, github: {user: (login: string) => Promise<{id: number, name?: string|null}>}|null,
 *          now?: () => number}} deps  `github` looks a handle up; null where the console has no GitHub
 */
export function createGitHubPeople({ store, github, now = Date.now }) {
  const lookups = new Map();
  const retryAfter = new Map();

  function accounts() {
    store.state.githubAccounts ??= {};
    return store.state.githubAccounts;
  }

  /**
   * @param {{login: string, id: number, name?: string|null}} account  as GitHub answered for the handle
   * @returns {boolean}  false when the handle was first seen on another account, whose record is then kept as it was
   */
  function remember({ login, id, name }) {
    const key = loginKey(login);
    const known = accounts()[key];
    if (known?.id && id && known.id !== id) {
      console.warn('people: the handle now belongs to another GitHub account', { login, knownId: known.id, id });
      // Marked as checked, so the pages do not look it up again on every load.
      accounts()[key] = { ...known, checkedAt: now() };
      store.save();
      return false;
    }
    accounts()[key] = { id: known?.id ?? id ?? null, name: String(name ?? '').trim() || null, checkedAt: now() };
    store.save();
    return true;
  }

  async function lookUp(login) {
    const key = loginKey(login);
    if (!lookups.has(key)) {
      lookups.set(key, github.user(login).finally(() => lookups.delete(key)));
    }
    return lookups.get(key);
  }

  /**
   * Asks GitHub who holds the handle now. A failure lets it through: write access was already checked, and GitHub
   * being down should not stop every label.
   * @returns {Promise<boolean>}  false only when the handle now belongs to another account than the one first seen
   */
  async function check(login) {
    if (!github) return true;
    let user;
    try {
      user = await lookUp(login);
    } catch (err) {
      console.warn('people: handle not looked up, let through', { login, message: String(err?.message ?? err).split('\n')[0] });
      return true;
    }
    return remember({ login, id: user?.id, name: user?.name });
  }

  // For the pages only: a failure keeps the last name, and is not asked again for a while.
  function refresh(login) {
    const key = loginKey(login);
    if (!github || lookups.has(key) || now() < (retryAfter.get(key) ?? 0)) return;
    lookUp(login).then((user) => {
      retryAfter.delete(key);
      remember({ login, id: user?.id, name: user?.name });
    }, (err) => {
      retryAfter.set(key, now() + RETRY_MS);
      console.warn('people: display name not refreshed', { login, retryInMs: RETRY_MS, message: String(err?.message ?? err).split('\n')[0] });
    });
  }

  /**
   * @param {Iterable<string|null|undefined>} logins
   * @returns {Record<string, string>}  the display name of each handle that has one; the rest show as @handle.
   *   Handles not seen yet, or not looked up for a day, are looked up for the next answer
   */
  function names(logins) {
    const out = {};
    for (const login of new Set([...logins].filter(Boolean))) {
      const known = accounts()[loginKey(login)];
      if (!known || now() - known.checkedAt >= REFRESH_MS) refresh(login);
      if (known?.name) out[login] = known.name;
    }
    return out;
  }

  return { remember, check, names };
}
