// Who is in a console behind a hosting proxy, when the program embedding it keeps the list (createInstallation's
// `members`): the program owns who is in and each person's role, and core never keeps its own copy of that roster. Core
// keeps only the per-person switches People sets, by lowercased login, under `memberSwitches` in state.json:
//   - Sessions from GitHub is on for every listed person, so only those turned off are kept (`githubSessionsOff`).
//     Off by default would hide every shared session, which nothing hid behind a proxy before the list.
//   - Can be assigned is off for every listed person, so only those turned on are kept (`assignable`).
// Admin is the role: an owner is an admin, changed with the program's setRole.
//
// The same interface as members.mjs where the console asks it (server.mjs, fleet.mjs), so one People page and one
// fleet serve both. The fleet asks synchronously (who may start a session from a label, who can be assigned), and the
// program answers asynchronously, so those answers come from the list as last read: it is read at start, read again in
// the background once it is older than `ttlMs` when something asks (the caller gets the list it had meanwhile), and read
// again, waited for, after each add, remove and role change made here. People's own reads wait for a fresh list. Until
// a first list arrives (the program failed at start), nobody is in, so nothing is let through on a guess.
//
// A switch only counts for someone on the list. Someone the program took off elsewhere is no member, assignable or
// admin from the next read on, and their switches are cleared then, as Remove here clears them at once. Each read also
// gives back the shared sessions of anyone it does not list (`whenGone`, the fleet's release), switches or not: someone
// the program dropped while the console was down, or whose release a restart cut short, still holds them. The first
// read comes before the fleet is made, so that one's sweep runs when the installation gives `whenGone`.
//
// An empty list while core knows of someone (the last list, a stored switch, an assigned shared session) is taken for
// the program's mistake, not everyone leaving at once: People cannot remove the last owner, so the list is kept and
// nothing is cleared or released. A console that never had anyone takes an empty list as it is.

import logins from './public/logins.cjs';
import { parseHandle } from './members.mjs';
const { findLogin } = logins;

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

const ROLES = new Set(['owner', 'member']);
// What the program may say in People's own words: a note beside a person (list) and what it did on an add (`told`).
// Plain text, cut to these lengths; People draws it as text, never as markup.
export const NOTE_CHARS = 80;
export const TOLD_CHARS = 200;

// A program's text as People shows it: one line, trimmed and cut, or null for anything that is not text.
function programText(value, chars) {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, chars) : null;
}

/**
 * @param {{hook: {list: () => Promise<{login: string, role: string, note?: string}[]>, add: Function, remove: Function, setRole: Function},
 *          store: {state: object, save: () => void}, ttlMs?: number, now?: () => number,
 *          onGone?: ((login: string) => void)|null}} deps
 *   `onGone` gives back the shared sessions of someone the program's list does not have (or set it later, whenGone)
 */
export function createHostedMembers({ hook, store, ttlMs = 5_000, now = Date.now, onGone = null, retryMs = 5_000, maxRetryMs = 60_000, setTimer = setTimeout }) {
  let release = onGone;
  const nowIso = () => new Date(now()).toISOString();
  // The program's list as last read, in its order: [{login, role}], and by lowercased login.
  let roster = null;
  let byLogin = new Map();
  let previous = null;
  let timer = null;
  let failures = 0;
  let stopped = false;
  let readAt = -Infinity;
  let reading = null;
  // Watchers of anyone leaving the list: each gets every login that was listed before a read, or that its own `also`
  // names (tokens kept from before a restart), and is not now.
  const leavers = [];

  function switches() {
    store.state.memberSwitches ??= {};
    return store.state.memberSwitches;
  }

  function take(list) {
    if (!Array.isArray(list)) throw new Error('members.list() must answer a list');
    const next = [];
    const seen = new Map();
    let dropped = 0;
    for (const entry of list) {
      const login = parseHandle(entry?.login);
      if (!login || !ROLES.has(entry?.role) || seen.has(login.toLowerCase())) { dropped += 1; continue; }
      // A note that is not text is left out, and the person kept.
      const note = programText(entry.note, NOTE_CHARS);
      const person = { login, role: entry.role, ...(note ? { note } : {}) };
      next.push(person);
      seen.set(login.toLowerCase(), person);
    }
    if (dropped) console.warn('members: entries of the program\'s list left out', { dropped });
    if (!next.length && known()) {
      console.warn('members: the program\'s list came back empty, kept the last one', { members: roster?.length ?? 0 });
      return;
    }
    previous = roster;
    roster = next;
    byLogin = seen;
    // Switches of anyone no longer listed: the program took them off in its own pages.
    const left = Object.keys(switches()).filter((key) => !seen.has(key));
    for (const key of left) delete switches()[key];
    if (left.length) {
      store.save();
      console.log('members: switches cleared, no longer on the program\'s list', { logins: left });
    }
    sweep();
    const was = previous;
    for (const w of leavers) notifyLeft(w, was);
  }

  // Who holds a shared session now, from the fleet's own records in the same state.
  const holders = () => (store.state.sessions ?? []).filter((s) => !s.owner && s.assignee).map((s) => s.assignee);

  // Whether core knows of anyone the program could have listed: an empty list then is not taken as it is.
  const known = () => Boolean(roster?.length) || Object.keys(switches()).length > 0 || holders().length > 0;

  // Shared sessions of anyone not on the list go back to Unassigned, once there is a fleet to do it.
  function sweep() {
    if (!release || !roster) return;
    const unlisted = new Map();
    for (const login of holders()) if (!byLogin.has(login.toLowerCase())) unlisted.set(login.toLowerCase(), login);
    for (const login of unlisted.values()) {
      try { release(login); } catch (err) { console.error('members: release after leaving failed', { login, message: String(err?.message ?? err).split('\n')[0] }); }
    }
  }

  function notifyLeft(w, was) {
    const names = new Map();
    for (const p of was ?? []) names.set(p.login.toLowerCase(), p.login);
    for (const login of w.also()) names.set(String(login).toLowerCase(), login);
    for (const [key, login] of names) {
      if (byLogin.has(key)) continue;
      try { w.fn(login); } catch (err) { console.error('members: leaving handler failed', { login, message: String(err?.message ?? err).split('\n')[0] }); }
    }
  }

  /** `fn(login)` for each login that leaves the list at a read, and for those of `also()` the list does not have, now for the list already read */
  function whenLeft(fn, { also = () => [] } = {}) {
    const w = { fn, also };
    leavers.push(w);
    if (roster) notifyLeft(w, null);
  }

  /** Who gives back the sessions of those the list does not have: from now on, and at once for the list already read. */
  function whenGone(fn) {
    release = fn;
    sweep();
  }

  // After a failed read, ask again by itself (retryMs, doubling up to maxRetryMs) until one succeeds, so a program that
  // recovers is heard without anyone's request. `stop` ends it.
  function retryLater() {
    if (stopped || timer) return;
    const wait = Math.min(retryMs * 2 ** failures, maxRetryMs);
    failures += 1;
    timer = setTimer(() => {
      timer = null;
      refresh().catch((err) => console.warn('members: the program\'s list not read again', { message: String(err?.message ?? err).split('\n')[0], nextInMs: Math.min(retryMs * 2 ** (failures - 1), maxRetryMs) }));
    }, wait);
    timer?.unref?.();
  }

  /** Ends the retries; the list is still read on demand. */
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // One read at a time; a failed one keeps the list before it, and is tried again once that is older than ttlMs.
  function refresh() {
    reading ??= (async () => {
      try {
        take(await hook.list());
        failures = 0;
      } catch (err) {
        retryLater();
        throw err;
      } finally {
        readAt = now();
        reading = null;
      }
    })();
    return reading;
  }

  function current() {
    if (!reading && now() - readAt > ttlMs) {
      refresh().catch((err) => console.warn('members: the program\'s list not read', { message: String(err?.message ?? err).split('\n')[0] }));
    }
    return byLogin;
  }

  /** A fresh list, waited for: what People shows and what its changes check against. Throws when the program fails. */
  async function load() {
    if (reading) await reading.catch(() => {});
    if (!roster || now() - readAt > ttlMs) await refresh();
  }

  // After a change: a read that started before it may not have it, so wait for that one and read again.
  async function reread() {
    if (reading) await reading.catch(() => {});
    try {
      await refresh();
    } catch (err) {
      console.warn('members: the program\'s list not read after a change', { message: String(err?.message ?? err).split('\n')[0] });
    }
  }

  const personOf = (login) => (login ? current().get(String(login).toLowerCase()) ?? null : null);
  const switchesOf = (login) => switches()[String(login).toLowerCase()] ?? {};

  function isMember(login) {
    return Boolean(personOf(login));
  }

  function isAdmin(login) {
    return personOf(login)?.role === 'owner';
  }

  function hasAdmin() {
    return [...current().values()].some((p) => p.role === 'owner');
  }

  function hasGithubSessions(login) {
    return isMember(login) && !switchesOf(login).githubSessionsOff;
  }

  function isAssignable(login) {
    return hasGithubSessions(login) && Boolean(switchesOf(login).assignable);
  }

  function assignables() {
    return [...current().values()].filter((p) => isAssignable(p.login)).map((p) => p.login).sort((a, b) => a.localeCompare(b));
  }

  function memberOrRefuse(login) {
    const person = personOf(login);
    if (!person) throw shown(`@${login} is not a member`);
    return person;
  }

  function setSwitch(person, field, value, by) {
    const key = person.login.toLowerCase();
    const record = { ...(switches()[key] ?? {}) };
    if (value) record[field] = { by, at: nowIso() };
    else delete record[field];
    if (Object.keys(record).length) switches()[key] = record;
    else delete switches()[key];
  }

  /** The caller checks that `by` is an admin. Off also turns Can be assigned off, as on a console of its own. */
  function setGithubSessions({ login, on, by }) {
    const person = memberOrRefuse(login);
    if (hasGithubSessions(person.login) === Boolean(on)) return;
    setSwitch(person, 'githubSessionsOff', !on, by);
    if (!on) setSwitch(person, 'assignable', false, by);
    store.save();
    console.log('members: sessions from GitHub changed', { login: person.login, on: Boolean(on), by });
  }

  /** The caller checks that `by` is an admin. Only someone with sessions from GitHub can be assigned one. */
  function setAssignable({ login, on, by }) {
    const person = memberOrRefuse(login);
    if (on && !hasGithubSessions(person.login)) throw shown(`@${person.login} needs sessions from GitHub first`);
    if (isAssignable(person.login) === Boolean(on)) return;
    setSwitch(person, 'assignable', on, by);
    store.save();
    console.log('members: can be assigned changed', { login: person.login, on: Boolean(on), by });
  }

  // The program's refusal is shown as it is; anything else it throws is logged here and fails the call. Resolves to
  // what the program answered.
  async function ask(what, args) {
    try {
      return await hook[what](args);
    } catch (err) {
      if (err?.shown) throw shown(String(err.message));
      console.error('members: the program failed a change', { what, login: args.login, message: String(err?.message ?? err).split('\n')[0] });
      throw new Error('the program did not make the change');
    }
  }

  const owners = () => [...current().values()].filter((p) => p.role === 'owner');

  /**
   * The caller checks that `by` is an admin.
   * @returns {Promise<{login: string, told: string|null}>}  `told`: what the program says it did, such as an email sent
   */
  async function add({ login, role, by }) {
    const handle = parseHandle(login);
    if (!handle) throw shown('that is not a GitHub handle');
    if (!ROLES.has(role)) throw shown('the role is owner or member');
    await load();
    if (isMember(handle)) throw shown(`@${handle} is already a member`);
    const answer = await ask('add', { login: handle, role, by });
    const told = programText(answer?.told, TOLD_CHARS);
    console.log('members: added', { login: handle, role, by, told: Boolean(told) });
    await reread();
    return { login: handle, told };
  }

  /** The caller checks that `by` is an admin. Nobody removes themselves, and the last owner stays. */
  async function remove({ login, by }) {
    await load();
    const person = memberOrRefuse(login);
    if (findLogin([by], person.login)) throw shown('you cannot remove yourself: ask another owner');
    if (person.role === 'owner' && owners().length === 1) throw shown('the console needs an owner: make someone else one first');
    await ask('remove', { login: person.login, by });
    delete switches()[person.login.toLowerCase()];
    store.save();
    console.log('members: removed', { login: person.login, by });
    await reread();
  }

  /** The caller checks that `by` is an admin. The last owner keeps it. */
  async function setRole({ login, role, by }) {
    if (!ROLES.has(role)) throw shown('the role is owner or member');
    await load();
    const person = memberOrRefuse(login);
    if (person.role === role) return;
    if (person.role === 'owner' && owners().length === 1) throw shown('the console needs an owner: make someone else one first');
    await ask('setRole', { login: person.login, role, by });
    console.log('members: role changed', { login: person.login, role, by });
    await reread();
  }

  /** @returns {{members: object[], requests: []}}  what the People page lists, in the program's order, with each note */
  function view() {
    current();
    return {
      members: (roster ?? []).map((p) => {
        const own = switchesOf(p.login);
        return {
          login: p.login, role: p.role, admin: p.role === 'owner', ...(p.note ? { note: p.note } : {}),
          githubSessions: !own.githubSessionsOff,
          ...(own.githubSessionsOff ? { githubSessionsOffBy: own.githubSessionsOff.by, githubSessionsOffAt: own.githubSessionsOff.at } : {}),
          assignable: isAssignable(p.login),
          ...(own.assignable ? { assignableBy: own.assignable.by, assignableAt: own.assignable.at } : {}),
        };
      }),
      requests: [],
    };
  }

  return {
    hosted: true, stop, refresh, load, whenGone, whenLeft, isMember, isAdmin, hasAdmin, hasGithubSessions, setGithubSessions, isAssignable, assignables,
    setAssignable, add, remove, setRole, view, requestOf: () => null,
  };
}

/** @throws {Error}  when `members` is not the hook createInstallation takes */
export function checkMembersHook(members, trusted) {
  if (members == null) return;
  if (!trusted || ['list', 'add', 'remove', 'setRole'].some((f) => typeof members[f] !== 'function')) {
    throw new Error('members is for a console behind trusted sign-in, and needs list, add, remove and setRole');
  }
}
