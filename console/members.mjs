// Who may sign in to the console, on top of write access to the repository: the members, and the people asking
// to be one. An admin can invite a handle, accept or decline a request, and remove another member. Kept in
// state.json under `members` and `memberRequests`, by GitHub handle. Labels and /woodshed comments do not look at
// this: any writer still starts shared sessions from GitHub.
//
// A console that has never had a list starts one from the people signed in to it and those with My Woodshed
// sessions, so nobody already using it is shut out; with nobody to start from, the first sign-in is the first member.

import logins from './public/logins.cjs';
const { findLogin, sameLogin, uniqueLogins } = logins;

const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

/** @returns {string|null}  a GitHub handle as typed (an @ in front is fine), or null when it cannot be one */
export function parseHandle(text) {
  const handle = String(text ?? '').trim().replace(/^@/, '');
  return HANDLE_RE.test(handle) ? handle : null;
}

/**
 * @param {{store: {state: object, save: () => void}, now?: () => number}} deps
 */
export function createMembers({ store, now = Date.now }) {
  const nowIso = () => new Date(now()).toISOString();

  function members() {
    if (!store.state.members) seed();
    return store.state.members;
  }

  function requests() {
    store.state.memberRequests ??= {};
    return store.state.memberRequests;
  }

  // GitHub handles are not case-sensitive, so one member is found however its handle is typed.
  function keyOf(map, login) {
    return findLogin(Object.keys(map), login);
  }

  function seed() {
    const signedIn = Object.values(store.state.authSessions ?? {})
      .filter((s) => s.expiresAt > now())
      .map((s) => s.login);
    const owners = (store.state.sessions ?? []).map((s) => s.owner);
    const people = uniqueLogins([...signedIn, ...owners]);
    store.state.members = Object.fromEntries(people.map((login) => [login, { addedBy: null, addedAt: nowIso(), how: 'already using the console' }]));
    store.save();
    console.log('members: list started', { members: people.length });
  }

  /** @returns {boolean} */
  function isMember(login) {
    return Boolean(login) && keyOf(members(), login) !== null;
  }

  /**
   * The first sign-in on a console with an empty list makes its first member.
   * @returns {boolean}  whether `login` became one
   */
  function claimFirst(login) {
    if (Object.keys(members()).length) return false;
    members()[login] = { addedBy: null, addedAt: nowIso(), how: 'first to sign in', admin: true, adminBy: null, adminAt: nowIso() };
    store.save();
    console.log('members: first member, an admin', { login });
    return true;
  }

  function add(login, by, how) {
    members()[login] = { addedBy: by, addedAt: nowIso(), how };
    const asked = keyOf(requests(), login);
    if (asked) delete requests()[asked];
    store.save();
  }

  /** @param {{login: string, by: string}} args  `login` was checked for write access by the caller */
  function invite({ login, by }) {
    const handle = parseHandle(login);
    if (!handle) throw shown('that is not a GitHub handle');
    if (isMember(handle)) throw shown(`@${handle} is already a member`);
    add(handle, by, 'invited');
    console.log('members: invited', { login: handle, by });
    return handle;
  }

  /** @param {{login: string, by: string}} args */
  function accept({ login, by }) {
    const key = keyOf(requests(), login);
    if (!key) throw shown(`@${login} is not asking to join`);
    add(key, by, 'accepted');
    console.log('members: request accepted', { login: key, by });
  }

  /** @param {{login: string, by: string}} args */
  function decline({ login, by }) {
    const key = keyOf(requests(), login);
    if (!key) throw shown(`@${login} is not asking to join`);
    delete requests()[key];
    store.save();
    console.log('members: request declined', { login: key, by });
  }

  /** @param {{login: string, by: string}} args */
  function remove({ login, by }) {
    const key = keyOf(members(), login);
    if (!key) throw shown(`@${login} is not a member`);
    if (sameLogin(key, by)) throw shown('you cannot remove yourself: ask another member');
    delete members()[key];
    store.save();
    console.log('members: removed', { login: key, by });
  }

  // A switch on a member's record: `<field>: true` with who turned it on and when, or none of the three when off.
  function setSwitch(field, { login, on, by }) {
    const key = keyOf(members(), login);
    if (!key) throw shown(`@${login} is not a member`);
    const record = members()[key];
    if (Boolean(record[field]) === Boolean(on)) return { key, changed: false };
    if (on) Object.assign(record, { [field]: true, [`${field}By`]: by, [`${field}At`]: nowIso() });
    else for (const name of [field, `${field}By`, `${field}At`]) delete record[name];
    return { key, changed: true };
  }

  function hasSwitch(field, login) {
    const key = keyOf(members(), login);
    return key ? Boolean(members()[key][field]) : false;
  }

  /** @returns {boolean}  whether `login` may start sessions from GitHub (the label, /woodshed) and see shared sessions */
  function hasGithubSessions(login) {
    return hasSwitch('githubSessions', login);
  }

  /**
   * The caller checks that `by` is an admin. Off also turns Can be assigned off: whoever cannot see shared sessions
   * cannot hold one. The caller gives their sessions back.
   */
  function setGithubSessions({ login, on, by }) {
    const { key, changed } = setSwitch('githubSessions', { login, on, by });
    if (!changed) return;
    if (!on) setSwitch('assignable', { login: key, on: false, by });
    store.save();
    console.log('members: sessions from GitHub changed', { login: key, on: Boolean(on), by });
  }

  /** @returns {boolean}  whether `login` is a member a shared session may be assigned to */
  function isAssignable(login) {
    return hasSwitch('assignable', login);
  }

  /** @returns {string[]}  the members who can be assigned a session, by handle as the list keeps it */
  function assignables() {
    return Object.entries(members()).filter(([, m]) => m.assignable).map(([login]) => login).sort((a, b) => a.localeCompare(b));
  }

  /** The caller checks that `by` is an admin. Only someone with sessions from GitHub can be assigned one. */
  function setAssignable({ login, on, by }) {
    if (on && !hasGithubSessions(login)) throw shown(`@${login} needs sessions from GitHub first`);
    const { key, changed } = setSwitch('assignable', { login, on, by });
    if (!changed) return;
    store.save();
    console.log('members: can be assigned changed', { login: key, on: Boolean(on), by });
  }

  /** @returns {boolean}  whether `login` is a member marked Admin: only admins open the console's own pages (server.mjs). */
  function isAdmin(login) {
    return hasSwitch('admin', login);
  }

  /** @returns {boolean}  whether any member is an admin; a list with none (the one the console started from) has everyone as one */
  function hasAdmin() {
    return Object.values(members()).some((m) => m.admin);
  }

  /** The caller checks that `by` is an admin. The last admin keeps it, so the console's pages always have someone. */
  function setAdmin({ login, admin, by }) {
    if (!admin && isAdmin(login) && Object.values(members()).filter((m) => m.admin).length === 1) throw shown('the console needs an admin: make someone else one first');
    const { key, changed } = setSwitch('admin', { login, on: admin, by });
    if (!changed) return;
    store.save();
    console.log('members: admin changed', { login: key, admin: Boolean(admin), by });
  }

  /** A signed-in writer who is not a member asks to be one. */
  function ask({ login }) {
    if (isMember(login)) return;
    if (keyOf(requests(), login)) return;
    requests()[login] = { askedAt: nowIso() };
    store.save();
    console.log('members: asked to join', { login });
  }

  function withdraw({ login }) {
    const key = keyOf(requests(), login);
    if (!key) return;
    delete requests()[key];
    store.save();
    console.log('members: request taken back', { login: key });
  }

  /** @returns {{askedAt: string}|null} */
  function requestOf(login) {
    const key = keyOf(requests(), login);
    return key ? requests()[key] : null;
  }

  /** @returns {{members: object[], requests: object[]}}  what the People page lists, newest first */
  function view() {
    const byNewest = (field) => (a, b) => String(b[field]).localeCompare(String(a[field]));
    return {
      members: Object.entries(members()).map(([login, m]) => ({ login, ...m })).sort(byNewest('addedAt')),
      requests: Object.entries(requests()).map(([login, r]) => ({ login, ...r })).sort(byNewest('askedAt')),
    };
  }

  return {
    isMember, hasGithubSessions, setGithubSessions, isAssignable, assignables, setAssignable,
    isAdmin, hasAdmin, setAdmin, claimFirst, invite, accept, decline, remove, ask, withdraw, requestOf, view,
  };
}
