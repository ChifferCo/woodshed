// Who besides its owner may open a My Woodshed session's app (`https://<id>.<app domain>`). Only the app: the
// terminal, Review, the database viewers and Start/Stop never look here.
//
// The owner picks the audience each time, and either can be turned off:
//
//   members  every signed-in member of the console opens the app (the console's own sign-in, appCode in auth.mjs)
//   a link   anyone holding `https://<id>.<app domain>/__woodshed/share?t=<token>`, with no GitHub account
//
// A link has an expiry (an hour to a week) and can be revoked. Opening it trades the token for a cookie that
// holds the same token, so the cookie ends with the link and nothing leans on a console sign-in. The state file
// keeps only a hash of each token. Shares end with the session's run: `sweep` drops those of a session no longer
// active, so a resumed session starts with its app private again.
//
// Neither audience is read-only: the app runs as the session's dev user, and so does whoever opens it.

import crypto from 'node:crypto';
import { parseCookies } from './auth.mjs';

export const SHARE_COOKIE = 'woodshed_view';
const MAX_HOURS = 7 * 24;
const MAX_LINKS = 10;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{store: {state: object, save: () => void}, secure?: boolean, now?: () => number}} deps
 *   `secure` (an https console) gives the cookie its `__Host-` name, which code in another app cannot plant
 */
export function createAppShares({ store, secure = true, now = Date.now }) {
  const cookieName = secure ? `__Host-${SHARE_COOKIE}` : SHARE_COOKIE;

  function all() {
    store.state.appShares ??= {};
    return store.state.appShares;
  }

  function forSession(sessionId) {
    return all()[sessionId] ?? null;
  }

  function live(sessionId) {
    const entry = forSession(sessionId);
    return Object.entries(entry?.links ?? {}).filter(([, link]) => link.expiresAt > now());
  }

  /** @returns {boolean}  whether every signed-in member may open this session's app */
  function membersOpen(sessionId) {
    return Boolean(forSession(sessionId)?.members);
  }

  /** @returns {{members: boolean, links: {id: string, createdAt: number, expiresAt: number}[]}} */
  function view(sessionId) {
    return {
      members: membersOpen(sessionId),
      links: live(sessionId).map(([id, l]) => ({ id, createdAt: l.createdAt, expiresAt: l.expiresAt })).sort((a, b) => b.createdAt - a.createdAt),
    };
  }

  function drop(sessionId) {
    const entry = forSession(sessionId);
    if (!entry || entry.members || Object.keys(entry.links ?? {}).length) return;
    delete all()[sessionId];
  }

  function setMembers({ sessionId, on, by }) {
    const entry = all()[sessionId] ??= { members: null, links: {} };
    entry.members = on ? { at: now(), by } : null;
    drop(sessionId);
    store.save();
    console.log('appShares: members changed', { sessionId, on: Boolean(on), by });
  }

  /**
   * @returns {{id: string, token: string, expiresAt: number}}  the token is shown once: only its hash is kept
   * @throws {Error}  with a message the page shows, for hours out of range or too many links
   */
  function createLink({ sessionId, hours, by }) {
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) throw Object.assign(new Error(`hours must be a whole number from 1 to ${MAX_HOURS}`), { shown: true });
    if (live(sessionId).length >= MAX_LINKS) throw Object.assign(new Error(`a session has at most ${MAX_LINKS} links: revoke one first`), { shown: true });
    const id = crypto.randomBytes(4).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const entry = all()[sessionId] ??= { members: null, links: {} };
    entry.links[id] = { hash: hash(secret), createdAt: now(), expiresAt: now() + hours * 3_600_000, by };
    store.save();
    console.log('appShares: link issued', { sessionId, id, hours, by });
    return { id, token: `${id}.${secret}`, expiresAt: entry.links[id].expiresAt };
  }

  /** @returns {boolean}  whether there was such a link */
  function revokeLink({ sessionId, linkId, by }) {
    const entry = forSession(sessionId);
    if (!entry?.links || !Object.hasOwn(entry.links, linkId)) return false;
    delete entry.links[linkId];
    drop(sessionId);
    store.save();
    console.log('appShares: link revoked', { sessionId, id: linkId, by });
    return true;
  }

  // The link a token names, when it is this app's, not expired and the token's secret matches.
  function linkFor({ token, appId }) {
    const [id, secret, ...rest] = String(token || '').split('.');
    const links = forSession(appId)?.links;
    const link = id && secret && !rest.length && links && Object.hasOwn(links, id) ? links[id] : null;
    if (!link || link.expiresAt <= now() || !sameHash(link.hash, hash(secret))) return null;
    return { id, expiresAt: link.expiresAt };
  }

  /** @returns {{setCookie: string, linkId: string}|null}  null for an unknown, expired, revoked or other app's token */
  function claim({ token, appId }) {
    const link = linkFor({ token, appId });
    if (!link) {
      console.warn('appShares: link refused', { appId });
      return null;
    }
    const maxAge = Math.max(1, Math.floor((link.expiresAt - now()) / 1000));
    const setCookie = [`${cookieName}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', secure && 'Secure', `Max-Age=${maxAge}`]
      .filter(Boolean).join('; ');
    console.log('appShares: link opened', { appId, id: link.id });
    return { setCookie, linkId: link.id };
  }

  /** @returns {{linkId: string}|null}  the link this browser's cookie holds, while it is still good for this app */
  function viewerFor({ cookieHeader, appId }) {
    const link = linkFor({ token: parseCookies(cookieHeader)[cookieName], appId });
    return link && { linkId: link.id };
  }

  /** Ends every share of a session. */
  function clearSession(sessionId) {
    if (!forSession(sessionId)) return;
    delete all()[sessionId];
    store.save();
    console.log('appShares: shares ended', { sessionId });
  }

  /**
   * @param {Set<string>|string[]} activeIds  the sessions that are still running a task
   * @returns {void}  drops the shares of any other session and the links that ran out
   */
  function sweep(activeIds) {
    const active = new Set(activeIds);
    let changed = false;
    for (const [sessionId, entry] of Object.entries(all())) {
      if (!active.has(sessionId)) {
        delete all()[sessionId];
        changed = true;
        console.log('appShares: shares ended', { sessionId, why: 'session no longer active' });
        continue;
      }
      for (const [id, link] of Object.entries(entry.links ?? {})) {
        if (link.expiresAt > now()) continue;
        delete entry.links[id];
        changed = true;
      }
      drop(sessionId);
    }
    if (changed) store.save();
  }

  return { membersOpen, view, setMembers, createLink, revokeLink, claim, viewerFor, clearSession, sweep, cookieName };
}
