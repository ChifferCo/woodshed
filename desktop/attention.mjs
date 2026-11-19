// What the Dock badge counts and which sessions to notify about, from the console's /api/sessions. Kept free of
// Electron so `node --test` checks it with the rest of Woodshed.
//
// It follows the console's own words (console/public/common.js, displayStatus): a running session whose claude asks
// for a person is `needs-you`, and one that finished its turn is `done`. Only the person's own sessions count, as on
// the rail's Mine (common.js, inMine): their private sessions, and the shared ones they started or have.
//
// Each read is compared with the last one, and a notification is a change between them: nothing on the first read (so
// opening the app replays nothing), one per change, and at most one per session per read (the most pressing), so a
// session assigned to you while it asks for someone does not ring twice.

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
 * Every kind of notification, in the order the Notifications menu lists them, with whether it is on until the person
 * says otherwise. `key` is what settings.json keeps.
 *
 * On by default, the moments a person acts on: claude asks (needs-you) or finished its turn (done); a session failed,
 * which nothing else will tell them; a shared session someone else handed them; a pull request opened, merged or
 * closed; and the verdict of a review or QA run on their pull request, which runs by itself and is otherwise heard of
 * only on GitHub.
 *
 * Off by default:
 * - checks: every push runs the checks again, and claude in the session usually watches them itself (the rail's
 *   "waiting on a job"), so a busy pull request would ring on each commit.
 * - paused: the idle pause follows a needs-you or done the person already heard about, and the session waits on the
 *   rail with Resume; the lifetime one is worth knowing of to some, hence the switch.
 *
 * Left out:
 * - A pull request's review decision (approved, changes requested) from its chip: Woodshed's own review is notified
 *   from its review session, with its verdict, and the decision would ring a second time for it. A person's review is
 *   typed into the session that opened the pull request, whose next needs-you or done is notified.
 * - A session stopped by a person: they did it, or it was a teammate on a shared session, whose page says so.
 * - Queued, starting, working: nothing to do yet.
 */
export const NOTIFICATION_KINDS = [
  { key: 'needs-you', label: 'A session needs you', on: true },
  { key: 'done', label: 'A session is done with its turn', on: true },
  { key: 'failed', label: 'A session failed', on: true },
  { key: 'assigned', label: 'A session is assigned to you', on: true },
  { key: 'pr-opened', label: 'A pull request is opened', on: true },
  { key: 'merged', label: 'A pull request is merged or closed', on: true },
  { key: 'review', label: 'A review of your pull request finished', on: true },
  { key: 'qa', label: 'A QA run on your pull request finished', on: true },
  { key: 'checks', label: 'A pull request\'s checks fail or pass', on: false },
  { key: 'paused', label: 'A session is paused at its idle or lifetime limit', on: false },
];

// Which one shows when a session has several changes in one read: what asks the most of the person first.
const PRIORITY = ['failed', 'needs-you', 'assigned', 'review', 'qa', 'merged', 'pr-opened', 'checks', 'done', 'paused'];

/**
 * @param {Record<string, boolean>|undefined} saved  settings.json's `notifications`
 * @returns {Set<string>}  the kinds that are on: each saved choice, else its default
 */
export function enabledKinds(saved) {
  const on = new Set();
  for (const { key, on: byDefault } of NOTIFICATION_KINDS) {
    const choice = saved && typeof saved[key] === 'boolean' ? saved[key] : byDefault;
    if (choice) on.add(key);
  }
  return on;
}

// The console's own stops (common.js, PAUSE_REASON_RE and START_TIMEOUT_REASON; sessions.mjs, stopReason).
const PAUSE_REASON_RE = /^(idle|ran) for /;
const START_TIMEOUT_REASON = 'did not start in time';

/** @returns {boolean}  failed, as the page's word says it (common.js, displayStatus) */
export function hasFailed(s) {
  return s.status === 'failed' || (Boolean(s.owner) && s.stopReason === START_TIMEOUT_REASON);
}

/** @returns {string|null}  why the console paused it, `idle 1 h` or `ran 8 h`, or null when it is not paused */
export function pausedFor(s) {
  if (s.status !== 'stopped' || s.stoppedBy || !PAUSE_REASON_RE.test(s.stopReason ?? '')) return null;
  return s.stopReason.replace(PAUSE_REASON_RE, '$1 ');
}

function isPullCheck(s) {
  return s.trigger === 'review' || s.trigger === 'qa';
}

function prNumber(url) {
  return /\/pull\/(\d+)$/.exec(String(url ?? ''))?.[1] ?? null;
}

/** Every pull request the session opened, with its chip (common.js shownPrs); a console from before the list sends prUrl. */
function prsOf(s) {
  if (Array.isArray(s.prs) && s.prs.length) return s.prs.filter((p) => p?.url);
  return s.prUrl ? [{ url: s.prUrl, pr: s.pr ?? null }] : [];
}

/** @returns {'fail'|'pending'|'pass'|null}  where an open pull request's checks stand (common.js prMarkLevel's checks) */
function checksLevel(pr) {
  if (!pr?.checks || pr.state === 'merged' || pr.state === 'closed') return null;
  if (pr.checks.fail) return 'fail';
  if (pr.checks.pending) return 'pending';
  return 'pass';
}

function firstLine(text, max = 140) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const REVIEW_WORDS = { APPROVE: 'approved', REQUEST_CHANGES: 'changes requested', COMMENT: 'commented' };
const QA_WORDS = { success: 'passed', failure: 'failed', neutral: 'finished' };

function reviewBody(review) {
  const word = REVIEW_WORDS[review.conclusion];
  if (!word) return 'Review finished without a verdict.';
  return review.held && review.conclusion === 'APPROVE' ? 'Review finished: approved, held until QA reports.' : `Review finished: ${word}.`;
}

function qaBody(qa) {
  const word = QA_WORDS[qa.conclusion] ?? 'finished';
  return qa.title ? `QA ${word}: ${firstLine(qa.title)}.` : `QA ${word}.`;
}

function prLabel(url, pr) {
  const number = prNumber(url);
  const name = number ? `PR ${number}` : 'The pull request';
  return pr?.title ? `${name}, ${firstLine(pr.title, 100)}` : name;
}

/**
 * What one read remembers for the next: each of the person's sessions, and each of their pull requests by its URL (two
 * sessions on one pull request notify about it once).
 * @typedef {{ sessions: Map<string, object>, prs: Map<string, { state: string|null, checks: string|null }> }} Seen
 */

/**
 * @param {{ login?: string | null, onePerson?: boolean, names?: object, sessions?: object[] }} body  /api/sessions's answer
 * @param {Seen|null} before  what the last read saw, or null before the first
 * @param {{ first?: boolean, enabled?: Set<string> }} [opts]  `first`: notify about nothing (opening the app replays
 *   nothing); `enabled`: the kinds the person has on (enabledKinds), every default one when left out
 * @returns {{ badge: number, now: Seen, notify: { id: string, kind: string, title: string, body: string }[] }}
 *   the badge counts the sessions asking for the person; `notify` the changes since `before` worth a notification
 */
export function attention(body, before, { first = false, enabled = enabledKinds() } = {}) {
  const prev = before ?? { sessions: new Map(), prs: new Map() };
  const now = { sessions: new Map(), prs: new Map() };
  const found = new Map();
  const add = (s, kind, text) => {
    if (first || !enabled.has(kind)) return;
    const list = found.get(s.id) ?? [];
    list.push({ id: s.id, kind, title: s.title || s.branch || `Session ${s.id}`, body: text });
    found.set(s.id, list);
  };
  const login = body?.login ?? null;
  const nameOf = (handle) => body?.names?.[handle] || `@${handle}`;
  let badge = 0;
  for (const s of body?.sessions ?? []) {
    // Questions from Slack are answered in their thread, nobody's to follow here.
    if (!s?.id || s.kind === 'ask' || !isMine(s, login, { onePerson: Boolean(body.onePerson) })) continue;
    const was = prev.sessions.get(s.id);
    const pullCheck = isPullCheck(s);
    const waiting = pullCheck ? null : waitsFor(s);
    const mark = {
      waiting, failed: hasFailed(s), paused: pausedFor(s), assignee: s.assignee ?? null,
      reviewed: Boolean(s.review?.reported), qaDone: Boolean(s.qa?.conclusion),
    };
    now.sessions.set(s.id, mark);
    // A review or QA run never counts toward the badge: it runs by itself, and only its verdict is the person's.
    if (waiting === 'needs-you') badge += 1;

    if (waiting && was?.waiting !== waiting) {
      add(s, waiting, waiting === 'needs-you' ? 'Needs you: claude is asking a question.' : 'Done: claude finished its turn.');
    }
    if (mark.failed && !was?.failed) {
      const why = (s.error ? firstLine(s.error) : s.stopReason === START_TIMEOUT_REASON ? 'it did not start in time' : '').replace(/\.$/, '');
      add(s, 'failed', why ? `Failed: ${why}.` : 'Failed.');
    }
    if (mark.paused && !was?.paused) add(s, 'paused', `Paused: ${mark.paused}. Resume it from the console.`);
    // Handed over by someone else; taking it yourself, or starting it, is no news.
    if (!s.owner && login && sameLogin(s.assignee, login) && !sameLogin(was?.assignee, login) && s.assignedBy && !sameLogin(s.assignedBy, login)) {
      add(s, 'assigned', `Assigned to you by ${nameOf(s.assignedBy)}.`);
    }
    // A run that started and finished between two reads (the computer asleep, the console unreachable) rings too, as a
    // failure does: it is new since the last read, which is what `add` holds to, never the first.
    if (s.trigger === 'review' && mark.reviewed && !was?.reviewed) add(s, 'review', reviewBody(s.review));
    if (s.trigger === 'qa' && mark.qaDone && !was?.qaDone) add(s, 'qa', qaBody(s.qa));

    // A review or QA session's pull request is the author's coding session's too: it is followed there.
    if (pullCheck) continue;
    for (const { url, pr } of prsOf(s)) {
      if (now.prs.has(url)) continue;
      const known = prev.prs.get(url);
      const state = pr?.state ?? null;
      const checks = checksLevel(pr);
      now.prs.set(url, { state, checks });
      if (!known) {
        // New since the last read, on a session that was there without it. A session started on a pull request
        // (Work on, or a label on one) reports that pull request, which it did not open.
        const startedOnIt = s.kind === 'pr' && String(s.number) === prNumber(url);
        if (was && !startedOnIt && state !== 'merged' && state !== 'closed') add(s, 'pr-opened', `Pull request opened: ${prLabel(url, pr)}.`);
        continue;
      }
      if ((state === 'merged' || state === 'closed') && known.state && known.state !== state && known.state !== 'merged' && known.state !== 'closed') {
        add(s, 'merged', `${state === 'merged' ? 'Merged' : 'Closed without merging'}: ${prLabel(url, pr)}.`);
      }
      // From one read level to another: a chip read for the first time, or a push read only once its checks ended,
      // tells nothing new.
      if (checks && known.checks && checks !== known.checks && checks !== 'pending') {
        const counts = checks === 'fail' ? `${pr.checks.fail} of ${pr.checks.total}` : `all ${pr.checks.total}`;
        add(s, 'checks', `Checks ${checks === 'fail' ? 'failing' : 'passing'}: ${counts} on ${prLabel(url, pr)}.`);
      }
    }
  }
  const notify = [];
  for (const list of found.values()) {
    list.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
    notify.push(list[0]);
  }
  return { badge, now, notify };
}
