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
  // The tab a page was on as it went away, kept until the next shell page says whether the visit was left (KEPT_KEYS
  // in common.js drop it at sign-out with the rest).
  const LEAVING_KEY = 'woodshed-session-leaving';
  // Chat, the conversation, is the default; TUI is the agent's own live terminal, and the others are the plain shell,
  // the review, the diff and the app's logs (common.js's sessionTab names the same). `agent` is TUI's old name: an old
  // link, or a tab remembered before the rename, still means it.
  const TABS = ['chat', 'tui', 'terminal', 'review', 'diff', 'applog'];
  const ALIASES = { agent: 'tui' };
  // What a history entry keeps for a review-only session still to land on its Review: no tab was picked there, and
  // coming back to it lands it on Review, whatever the session was left on since (leftOn, memory's asked).
  const LANDS_ON_REVIEW = 'lands-on-review';

  /** @returns {string}  a tab the page knows, Chat for anything else */
  function known(name) {
    const tab = Object.hasOwn(ALIASES, name ?? '') ? ALIASES[name] : name;
    return TABS.includes(tab) ? tab : 'chat';
  }

  /**
   * The tab a session can show now: Review needs a branch, Terminal a shell, Diff and App log a running coding session;
   * one it cannot falls back to TUI. Chat on a session that is not running is not a fallback: the page draws its start
   * or how it ended there (session.js, viewOf) and Chat comes back once it runs.
   * @param {string} tab
   * @param {{ branch?: string, status: string, kind?: string }} s
   * @param {boolean} hasShell
   */
  function shown(tab, s, hasShell) {
    if (tab === 'review' && !s.branch) return 'tui';
    if (tab === 'terminal' && !hasShell) return 'tui';
    if ((tab === 'applog' || tab === 'diff') && (s.status !== 'running' || s.kind === 'ask')) return 'tui';
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
   * The tab to remember as a session is left (a move to another page, Back or Forward), or null for none: the one it
   * shows. A held tab never showed (the history entry keeps it for Back, leftOn), and a session never drawn, or a
   * review-only one still to land on its Review, was left on no tab anyone picked. The memory keeps only these and clicks, never a ?tab an address arrived with, so a tab carried
   * in from elsewhere (the way back through sign-in, perhaps someone else's) is this login's only once they leave on it.
   * @param {{ tab: string, held: string|null, reviewPending: boolean, drawn: boolean }} at
   * @returns {string|null}
   */
  function leaving(at) {
    if (at.held) return null;
    const left = leftOn(at);
    return left === LANDS_ON_REVIEW ? null : left;
  }

  /**
   * Whether a fallback to Agent corrects the memory: only when the memory holds the very tab the session cannot show.
   * A link's tab that falls back leaves another remembered tab alone; a remembered one falls back however it was asked
   * (from the memory, or an entry stamped from it before a reload).
   * @param {string|null} remembered  the memory's tab for the session
   * @param {string} unavailable  the tab asked for that the session cannot show
   */
  function correctsMemory(remembered, unavailable) {
    return Boolean(remembered) && remembered === unavailable;
  }

  /**
   * A page going away (pagehide) cannot tell a reload of the same visit from leaving it, so it only puts its tab aside;
   * the next shell page takes it: kept when the visit was left (My settings and back, another address, Back), dropped
   * on a reload, where the entry's own state still knows the tab and the memory must stay as the visit found it.
   */
  function stashLeaving(storage, login, id, tab) {
    try {
      storage.setItem(LEAVING_KEY, JSON.stringify({ login, id, tab }));
    } catch {
      // Not kept: the memory stays as it was.
    }
  }
  /** @returns {{ id: string, tab: string }|null}  what to remember, once; null on a reload or another login's */
  function takeLeaving(storage, login, reloaded) {
    let left = null;
    try {
      left = JSON.parse(storage.getItem(LEAVING_KEY) || 'null');
      storage.removeItem(LEAVING_KEY);
    } catch {
      return null;
    }
    if (reloaded || !left || left.login !== login || !left.id || !TABS.includes(left.tab)) return null;
    return { id: left.id, tab: left.tab };
  }

  /**
   * A history entry's tab is kept with the login that drew it (its state survives a reload and an account change in
   * the same browser tab), and read back only by that login: another account's Back reaches an entry that asks for
   * nothing, so it gets that account's own memory.
   * @param {object|null} state  history.state
   * @param {string|null} login  the page's woodshed-login meta
   * @returns {string|null}
   */
  function entryTab(state, login) {
    return state && state.login === login ? (state.tab ?? null) : null;
  }
  /** @returns {object}  history.state with `tab`, kept for `login` */
  function withEntryTab(state, tab, login) {
    return { ...state, tab, login };
  }

  /**
   * Whether a link to the address already showing opens it again as a new entry: when it asks for a tab other than the
   * one showing. The address keeps a link's ?tab after a pick, and this login's own entry shows its picked tab over it,
   * so without a new entry (whose state is empty, so its address asks) the action would change nothing.
   * @param {{ sameAddress: boolean, sameSession: boolean, asked: string|null, showing: string }} at
   */
  function opensAgain({ sameAddress, sameSession, asked, showing }) {
    return sameAddress && sameSession && Boolean(asked) && known(asked) !== showing;
  }

  /**
   * The tab a page asks for: this login's own entry's (its history state, the tab it showed: a reload, Back, Forward)
   * over its address, which keeps the ?tab the entry arrived with (a link, kept so a reload through the server's sign-in
   * still carries it) whatever was picked since; else the address's; else the memory's.
   * @param {{ asked: Function }} memory
   * @param {string|null} fromEntry  entryTab: the entry's tab, read only by the login that drew it
   */
  function ask(memory, id, inAddress, fromEntry) {
    if (fromEntry && fromEntry !== LANDS_ON_REVIEW) return fromEntry;
    return memory.asked(id, inAddress, fromEntry);
  }

  /**
   * The ?tab an entry's address asks for, as `login` reads it. The page writes ?tab into an entry itself (a remembered
   * tab, a click), so on another login's entry the ?tab it arrived with (`linkedTab`, a link followed or typed) asks,
   * whatever the address says now; the rest was that login's choice. An entry with no login (an older page, or a new
   * one) is the reader's, as its address says.
   * @param {object|null} state  history.state
   * @param {string|null} login  the page's woodshed-login meta
   * @param {string|null} inAddress  the address's ?tab
   */
  function addressTab(state, login, inAddress) {
    if (!state || !state.login || state.login === login) return inAddress || null;
    return state.linkedTab || null;
  }
  /**
   * The ?tab an entry arrived with: its address's, when it has no state yet (a link followed, typed or pushed), else
   * the one it kept.
   */
  function linkedTab(state, inAddress) {
    return state ? (state.linkedTab ?? null) : (inAddress || null);
  }

  /**
   * Whether a list lookup answered for another login than the page was drawn for: the account changed in another
   * browser tab with no sign-out here, so nothing it answers may be kept under the page's login. Unknown on either
   * side (no sign-in, an older console) is no change.
   * @param {string|null} pageLogin  the page's woodshed-login meta
   * @param {string|null|undefined} answerLogin  the lookup's `login`
   */
  function otherLogin(pageLogin, answerLogin) {
    return Boolean(pageLogin) && Boolean(answerLogin) && pageLogin !== answerLogin;
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
    // Read from storage on every ask and every write, not kept from the page's start: another page of the console may
    // have changed it since (a page the browser restores from its back-forward cache runs none of its start again).
    // What this page wrote is also kept here, for storage that refuses.
    let kept = {};
    function load() {
      try {
        const saved = JSON.parse(storage.getItem(KEY) || 'null');
        if (saved && saved.login === login && saved.tabs && typeof saved.tabs === 'object') return { ...saved.tabs };
        // Another login's (signed out in another browser tab, which ran no cleanup here) goes, unread.
        if (saved) storage.removeItem(KEY);
        return {};
      } catch {
        return { ...kept };
      }
    }
    kept = load();
    return {
      // The tab asked for: the address's, else the one this history entry showed when it was left (Back and Forward
      // reach it; Agent has no ?tab), else the one this session was last left on, else none. An entry still to land on
      // Review asks for none, so the page lands it there.
      asked(id, inAddress, inEntry = null) {
        if (inAddress) return inAddress;
        if (id && inEntry === LANDS_ON_REVIEW) return null;
        if (id && inEntry) return inEntry;
        const tabs = load();
        // A tab remembered before the rename (agent) means its new name.
        return id && Object.hasOwn(tabs, id) && tabs[id] ? known(tabs[id]) : null;
      },
      remember(id, tab) {
        if (!id) return;
        kept[id] = tab;
        if (!writable()) return;
        const tabs = load();
        if (tabs[id] === tab) return;
        tabs[id] = tab;
        try {
          storage.setItem(KEY, JSON.stringify({ login, tabs }));
        } catch {
          // Not kept: the next arrival opens on Agent, as before.
        }
      },
    };
  }


  return { KEY, LEAVING_KEY, stashLeaving, takeLeaving, ask, opensAgain, TABS, LANDS_ON_REVIEW, known, shown, settle, picks, leftOn, entryTab, withEntryTab, addressTab, linkedTab,
    leaving, correctsMemory, otherLogin, lookups, memory };
});
