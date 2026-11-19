// What the Dock badge counts and which sessions to notify about, from the console's /api/sessions. Kept free of
// Electron so `node --test` checks it with the rest of Woodshed.
//
// It follows the console's own words (console/public/common.js, displayStatus): a running session whose claude asks
// for a person is `needs-you`, and one that finished its turn is `done`. Only the person's own sessions count, as on
// the rail's Mine (common.js, inMine): their private sessions, and the shared ones they started or have.

function sameLogin(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/** @returns {boolean} */
export function isMine(session, login, { onePerson = false } = {}) {
  if (session.owner) return onePerson || sameLogin(session.owner, login);
  // A console one person uses lists every session as theirs (`onePerson`), and one nobody signs in to has no login.
  if (onePerson || !login) return true;
  return sameLogin(session.assignee, login) || sameLogin(session.startedBy, login);
}

/** @returns {'needs-you' | 'done' | null} what the session waits on the person for, while it runs */
export function waitsFor(session) {
  if (session.status !== 'running') return null;
  if (session.state === 'needs-you') return 'needs-you';
  // Done with its turn while its pull request waits on the review and suites, or a background job: nobody yet.
  if (session.state === 'done' && !session.slackWaiting && !(session.shells > 0 && session.prUrl)) return 'done';
  return null;
}

/**
 * @param {{ login?: string | null, sessions?: object[] }} body  /api/sessions's answer
 * @param {Map<string, string>} before  each session's id to what it waited for at the last read
 * @returns {{ badge: number, now: Map<string, string>, notify: { id: string, title: string, body: string }[] }}
 *   the badge counts the sessions asking for the person; `notify` the ones that started waiting since `before`, none
 *   on the first read (an empty `before` with `first`), so opening the app does not replay every waiting session.
 */
export function attention(body, before, { first = false } = {}) {
  const now = new Map();
  const notify = [];
  let badge = 0;
  for (const s of body?.sessions ?? []) {
    if (!s?.id || s.kind === 'ask' || s.trigger === 'review' || s.trigger === 'qa' || !isMine(s, body.login, { onePerson: Boolean(body.onePerson) })) continue;
    const waiting = waitsFor(s);
    if (!waiting) continue;
    now.set(s.id, waiting);
    if (waiting === 'needs-you') badge += 1;
    if (!first && before.get(s.id) !== waiting) {
      const title = s.title || s.branch || `Session ${s.id}`;
      notify.push({ id: s.id, title, body: waiting === 'needs-you' ? 'Needs you: claude is asking a question.' : 'Done: claude finished its turn.' });
    }
  }
  return { badge, now, notify };
}
