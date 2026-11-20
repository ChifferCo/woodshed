// Each person's rail: the sessions they pinned, the project New session opens on, and the tab a session opens on when
// none was picked for it (Chat or TUI, one for a desktop and one for a phone). After the shed's
// viewPrefs.mjs, but per person, since everyone here sees the same shared sessions. Kept in the console's state, so
// it is the same in every browser the person signs in from.

const ID_RE = /^[0-9a-f]{8}$/;
// More than anyone's rail holds; the oldest go first.
const MAX_IDS = 200;

// The rail's fold feature is gone; its stored choices go the first time the console loads without it.
function dropFoldedKeys(store) {
  const people = Object.values(store.state.viewPrefs ?? {});
  const stale = people.filter((prefs) => 'folded' in prefs || 'startFolded' in prefs);
  if (!stale.length) return;
  for (const prefs of stale) {
    delete prefs.folded;
    delete prefs.startFolded;
  }
  store.save();
  console.log('viewPrefs: dropped the old fold choices', { people: stale.length });
}

// The views a session can open on by default, and the widths each choice is for (session.js reads `phone` under 720px).
export const SESSION_VIEWS = ['chat', 'tui'];
const DEFAULT_SESSION_VIEW = { desktop: 'chat', phone: 'chat' };

function emptyPrefs() {
  return { pinned: [] };
}

/** @param {{state: object, save: () => void}} store */
export function createViewPrefs(store) {
  dropFoldedKeys(store);

  function all() {
    store.state.viewPrefs ??= {};
    return store.state.viewPrefs;
  }

  function prefsOf(login) {
    const key = login ?? '';
    all()[key] ??= emptyPrefs();
    return all()[key];
  }

  function checkId(id) {
    if (!ID_RE.test(String(id ?? ''))) throw Object.assign(new Error('id must be a session id'), { shown: true });
  }

  /**
   * @param {string|null} login
   * @param {Set<string>} [ids]  the sessions the person can see now; a pin of any other is left out
   * @returns {{pinned: string[], sessionView: {desktop: string, phone: string}}}
   */
  function view(login, ids = null) {
    const prefs = all()[login ?? ''] ?? emptyPrefs();
    const kept = (id) => !ids || ids.has(id);
    return {
      pinned: prefs.pinned.filter(kept),
      sessionView: sessionView(login),
    };
  }

  /** @returns {{desktop: string, phone: string}}  the tab a session opens on when none was picked, Chat unless changed */
  function sessionView(login) {
    return { ...DEFAULT_SESSION_VIEW, ...all()[login ?? '']?.sessionView };
  }

  /**
   * @param {{desktop?: string, phone?: string}} choice  either or both; Chat, the default, is kept as nothing
   * @returns {{desktop: string, phone: string}}
   */
  function setSessionView(login, choice) {
    const picks = Object.entries(choice ?? {});
    if (!picks.length || picks.some(([where, view]) => !Object.hasOwn(DEFAULT_SESSION_VIEW, where) || !SESSION_VIEWS.includes(view))) {
      throw Object.assign(new Error('give desktop or phone, each chat or tui'), { shown: true });
    }
    const prefs = prefsOf(login);
    const next = { ...prefs.sessionView, ...Object.fromEntries(picks) };
    for (const [where, view] of Object.entries(next)) if (view === DEFAULT_SESSION_VIEW[where]) delete next[where];
    if (Object.keys(next).length) prefs.sessionView = next;
    else delete prefs.sessionView;
    store.save();
    console.log('viewPrefs: session view changed', { login, ...sessionView(login) });
    return sessionView(login);
  }

  /** @returns {string|null}  the project the person chose to open New session on, whether or not it still exists */
  function defaultProject(login) {
    return all()[login ?? '']?.defaultProject ?? null;
  }

  /** @param {string|null} name  null goes back to the installation's default project */
  function setDefaultProject(login, name) {
    const prefs = prefsOf(login);
    if (name) prefs.defaultProject = name;
    else delete prefs.defaultProject;
    store.save();
    return defaultProject(login);
  }

  function setPinned(login, id, on) {
    checkId(id);
    const prefs = prefsOf(login);
    prefs.pinned = prefs.pinned.filter((p) => p !== id);
    if (on) prefs.pinned = [...prefs.pinned, id].slice(-MAX_IDS);
    store.save();
    return view(login);
  }

  return { view, setPinned, defaultProject, setDefaultProject, sessionView, setSessionView };
}
