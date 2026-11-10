// Which agent terminals the session page keeps loaded. Moving to a session builds its ttyd page, websocket and tmux
// attach from nothing, so the last few stay mounted, hidden, and coming back is a show, not a load. This is only the
// bookkeeping (what to keep, what to drop); session.js owns the iframes. It also loads in node, for its test.
(function (root) {
  'use strict';

  /**
   * @param {{max: number}} args  how many terminals stay loaded, the one on screen included
   * @returns {{touch: (key: string) => string[], retain: (keep: Set<string>) => string[], has: (key: string) => boolean, keys: () => string[]}}
   *   Each call returns the keys to unmount. Keys are most recently used last.
   */
  function createTerminalCache({ max }) {
    let order = [];

    function evict(protectedKey) {
      const dropped = [];
      while (order.length > max) {
        const oldest = order.find((k) => k !== protectedKey);
        if (oldest === undefined) break;
        order = order.filter((k) => k !== oldest);
        dropped.push(oldest);
      }
      return dropped;
    }

    return {
      // The terminal on screen: most recent, and never the one dropped to make room.
      touch(key) {
        order = [...order.filter((k) => k !== key), key];
        return evict(key);
      },
      // Sessions that stopped, were removed or restarted: their terminals are dead.
      retain(keep) {
        const dropped = order.filter((k) => !keep.has(k));
        order = order.filter((k) => keep.has(k));
        return dropped;
      },
      has: (key) => order.includes(key),
      keys: () => [...order],
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createTerminalCache };
  else root.Woodshed.createTerminalCache = createTerminalCache;
})(typeof window !== 'undefined' ? window : globalThis);
