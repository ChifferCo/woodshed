// The notifications the app has shown, kept for the console's page to list under its bell (console/public/
// notificationBell.js). Kept free of Electron so `node --test` checks it with the rest of Woodshed.
//
// Newest first, at most `max`: the bell is a list of what happened lately, not a history. Each entry has a key of its
// own (a session can ring many times), the session it opens, what it said, when, and whether the person has seen it.

/**
 * @typedef {{ key: string, id: string, kind: string, title: string, body: string, at: number, read: boolean }} Entry
 */

/** @param {{ max?: number, now?: () => number }} [opts] */
export function createNotificationLog({ max = 50, now = () => Date.now() } = {}) {
  /** @type {Entry[]} */
  let entries = [];
  let next = 0;
  return {
    /**
     * @param {{ id: string, kind: string, title: string, body: string }} n  one of attention()'s `notify`
     * @param {{ read?: boolean }} [opts]  `read`: already seen, as one about the session the person is looking at
     * @returns {Entry}
     */
    add(n, { read = false } = {}) {
      next += 1;
      const entry = { key: `n${next}`, id: String(n.id), kind: String(n.kind), title: String(n.title), body: String(n.body), at: now(), read: Boolean(read) };
      entries = [entry, ...entries].slice(0, max);
      return entry;
    },
    /** @returns {{ items: Entry[], unread: number }}  a copy, newest first */
    list() {
      return { items: entries.map((e) => ({ ...e })), unread: entries.filter((e) => !e.read).length };
    },
    /**
     * @param {string|null} [key]  the entry, or every one when left out
     * @returns {boolean}  whether anything changed
     */
    markRead(key = null) {
      let changed = false;
      for (const e of entries) {
        if (e.read || (key !== null && e.key !== key)) continue;
        e.read = true;
        changed = true;
      }
      return changed;
    },
    /** Every entry about one session, as when the person opens it. @returns {boolean} whether anything changed */
    markSessionRead(id) {
      let changed = false;
      for (const e of entries) {
        if (e.read || e.id !== String(id)) continue;
        e.read = true;
        changed = true;
      }
      return changed;
    },
    /** @returns {boolean}  whether anything was there */
    clear() {
      const had = entries.length > 0;
      entries = [];
      return had;
    },
  };
}
