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
  // What a history entry keeps for a review-only session still to land on its Review: no tab was picked there, and
  // coming back to it lands it on Review, whatever the session was left on since (leftOn, memory's asked).
  const LANDS_ON_REVIEW = 'lands-on-review';

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
   * Which tab a render shows, given the tab asked for and the session as the page has it. Until a lookup for this route
   * has answered (`pending`, which a failed lookup leaves as it was), the session may be a kept snapshot's or the
   * previous page's (starting, where it now runs): a tab it cannot show is held, Agent shows meanwhile, and the held tab
   * is tried again on the first render after an answer. Only then does a fallback stand (`fellBack`): the page then
   * takes the tab out of the address and remembers Agent.
   * @param {{ tab: string, held: string|null, pending: boolean, s: object, hasShell: boolean }} at
   * @returns {{ tab: string, held: string|null, fellBack: boolean }}
   */
  function settle({ tab, held, pending, s, hasShell }) {
    const wanted = held && !pending ? held : tab;
    const showable = shown(wanted, s, hasShell);
    if (showable === wanted) return { tab: wanted, held: pending ? held : null, fellBack: false };
    if (pending) return { tab: showable, held: wanted, fellBack: false };
    return { tab: showable, held: null, fellBack: true };
  }

  /**
   * Whether clicking `next` is a choice to keep. A click on the tab showing is one too when that tab stands in for
   * another: one held while the lookup is pending (settle), or a review-only session's Review, which it switches to
   * once it runs (`landOnReview`). Either is then replaced by the click.
   * @param {{ tab: string, next: string, held: string|null, landOnReview: boolean }} at
   */
  function picks({ tab, next, held, landOnReview }) {
    return tab !== next || Boolean(held) || landOnReview;
  }

  /**
   * The tab a history entry keeps, for Back and Forward, written each time the page draws it: the one it shows, or a
   * held one over the Agent standing in for it. A review-only session still to land on its Review (`reviewPending`)
   * keeps LANDS_ON_REVIEW, since Agent there was not picked: coming back lands it on its Review as the first arrival
   * would, even after a later visit picked another tab. An entry whose session was never drawn (left before the list
   * had it) showed no tab and keeps none (null): coming back asks as a first arrival would.
   * @param {{ tab: string, held: string|null, reviewPending: boolean, drawn?: boolean }} at
   * @returns {string|null}
   */
  function leftOn({ tab, held, reviewPending, drawn = true }) {
    if (!drawn) return null;
    return held || (reviewPending ? LANDS_ON_REVIEW : tab);
  }

  /**
   * Orders the page's list lookups, which a move and the poll can have in flight at once: an answer to an older one
   * that lands after a newer one's is stale (a session starting that now runs), and must not confirm a tab's fallback.
   * Only an answer that came back applies: a failed lookup is dropped when stale, and never makes an older answer stale.
   * @returns {{ start(): number, fresh(n: number): boolean, stale(n: number): boolean }}  `fresh` (for an answer) also
   *   records `n` as the newest applied; `stale` (for a failure) records nothing
   */
  function lookups() {
    let started = 0;
    let applied = 0;
    return {
      start: () => ++started,
      fresh(n) {
        if (n < applied) return false;
        applied = n;
        return true;
      },
      stale: (n) => n < applied,
    };
  }

  /**
   * The tabs kept for `login` in `storage` (sessionStorage), which may be missing or throw. Nothing is written once
   * `writable` says no: sign-out has dropped the memory, and a page still answering must not put it back.
   * @returns {{ asked(id: string|null, inAddress: string|null, inEntry?: string|null): string|null,
   *   remember(id: string, tab: string): void }}
   */
  function memory(storage, login, writable = () => true) {
    let kept = {};
    try {
      const saved = JSON.parse(storage.getItem(KEY) || 'null');
      if (saved && saved.login === login && saved.tabs && typeof saved.tabs === 'object') kept = saved.tabs;
    } catch {
      kept = {};
    }
    return {
      // The tab asked for: the address's, else the one this history entry showed when it was left (Back and Forward
      // reach it; Agent has no ?tab), else the one this session was last left on, else none. An entry still to land on
      // Review asks for none, so the page lands it there.
      asked(id, inAddress, inEntry = null) {
        if (inAddress) return inAddress;
        if (id && inEntry === LANDS_ON_REVIEW) return null;
        return (id && inEntry) || (id && Object.hasOwn(kept, id) ? kept[id] : null) || null;
      },
      remember(id, tab) {
        if (!id || kept[id] === tab) return;
        kept[id] = tab;
        if (!writable()) return;
        try {
          storage.setItem(KEY, JSON.stringify({ login, tabs: kept }));
        } catch {
          // Not kept: the next arrival opens on Agent, as before.
        }
      },
    };
  }

  return { KEY, TABS, LANDS_ON_REVIEW, known, shown, settle, picks, leftOn, lookups, memory };
});
