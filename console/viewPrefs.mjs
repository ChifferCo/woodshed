// Each person's rail: the sessions they pinned, and the project New session opens on. After the shed's
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
   * @returns {{pinned: string[]}}
   */
  function view(login, ids = null) {
    const prefs = all()[login ?? ''] ?? emptyPrefs();
    const kept = (id) => !ids || ids.has(id);
    return {
      pinned: prefs.pinned.filter(kept),
    };
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

  return { view, setPinned, defaultProject, setDefaultProject };
}
