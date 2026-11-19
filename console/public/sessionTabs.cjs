// Which tab a session's page opens on, and the tab each session was last left on. An address with `?tab=` says which;
// one without (the rail's links) reopens the tab the session was last on in this browser tab, so moving to another
// session and back keeps your place. What is kept is sessionStorage's, under the login that picked it: another login
// reads none of it, and signing out drops it (common.js). One file for session.js (a script that sets
// `WoodshedSessionTabs`) and its test.
(function (root, factory) {
  const tabs = factory();
  if (typeof module === 'object' && module.exports) module.exports = tabs;
  else root.WoodshedSessionTabs = tabs;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const KEY = 'woodshed-session-tabs';
  // Agent is claude's terminal and the default; the others are the plain shell, the review, the diff and the app's logs.
  const TABS = ['agent', 'terminal', 'review', 'diff', 'applog'];

  /** @returns {string}  a tab the page knows, Agent for anything else */
  function known(name) {
    return TABS.includes(name) ? name : 'agent';
  }

  /**
   * The tab a session can show now: Review needs a branch, Terminal a shell, Diff and App log a running coding session.
   * Anything else shows Agent.
   * @param {string} tab
   * @param {{ branch?: string, status: string, kind?: string }} s
   * @param {boolean} hasShell
   */
  function shown(tab, s, hasShell) {
    if (tab === 'review' && !s.branch) return 'agent';
    if (tab === 'terminal' && !hasShell) return 'agent';
    if ((tab === 'applog' || tab === 'diff') && (s.status !== 'running' || s.kind === 'ask')) return 'agent';
    return tab;
  }

  /**
   * The tabs kept for `login` in `storage` (sessionStorage), which may be missing or throw.
   * @returns {{ asked(id: string|null, inAddress: string|null): string|null, remember(id: string, tab: string): void }}
   */
  function memory(storage, login) {
    let kept = {};
    try {
      const saved = JSON.parse(storage.getItem(KEY) || 'null');
      if (saved && saved.login === login && saved.tabs && typeof saved.tabs === 'object') kept = saved.tabs;
    } catch {
      kept = {};
    }
    return {
      // The tab asked for: the address's, else the one this session was last left on, else none.
      asked(id, inAddress) {
        return inAddress || (id && Object.hasOwn(kept, id) ? kept[id] : null) || null;
      },
      remember(id, tab) {
        if (!id || kept[id] === tab) return;
        kept[id] = tab;
        try {
          storage.setItem(KEY, JSON.stringify({ login, tabs: kept }));
        } catch {
          // Not kept: the next arrival opens on Agent, as before.
        }
      },
    };
  }

  return { KEY, TABS, known, shown, memory };
});
