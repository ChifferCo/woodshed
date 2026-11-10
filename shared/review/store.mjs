// On-disk state for reviews, one directory per SESSION.
//
// Layout:
//
//   $REVIEWS_DIR/
//     claude-<8hex>/
//       session.json          the target, its metadata, the branch, the worktree
//       diff.json             the parsed diff
//       review.json           the generated artifact
//       chat.json             the conversation with the reviewer, oldest first
//       job-analysis.json     breadcrumb for the startup orphan sweep
//       job-explain.json      (one per job KIND — they run concurrently)
//       job-chat.json
//
// Keyed by session rather than by pull request, because a review's lifetime is
// now a session's: it is created by /run, it is read for as long as that
// session exists, and it is removed when the session is killed. There is no
// TTL, no LRU and no garbage collector — an earlier design had all three, and
// they existed only because a review owned a 130 MB checkout that nothing else
// would ever reclaim. The worktree now belongs to the session, so the session's
// own Kill button is the collector.
//
// Nothing here is keyed by head SHA any more either. A session reviews one
// commit at a time, and Re-review replaces that commit in place — the record,
// the diff and the artifact are all overwritten, and the session, its worktree
// and its branch stay put. Keying any of it by SHA would leave the previous
// pass on disk with nothing to collect it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const REVIEWS_DIR =
  process.env.WOODSHED_REVIEWS || path.join(os.homedir(), '.claude', 'bridge-reviews');

// Session names are `claude-` plus randomBytes(4).toString('hex'), which every
// session route in server.mjs pins the same way. Everything here builds a
// filesystem path out of one, so it is checked before it is joined rather than
// trusted because the caller "obviously" passed a real one.
const SESSION_RE = /^claude-[0-9a-f]{8}$/;

export function isSessionName(name) {
  return typeof name === 'string' && SESSION_RE.test(name);
}

function sessionDirFor(session) {
  if (!isSessionName(session)) throw new Error(`not a session name: ${String(session).slice(0, 40)}`);
  return path.join(REVIEWS_DIR, session);
}

function ensureSessionDir(session) {
  const dir = sessionDirFor(session);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write to a sibling temp file and rename. A half-written artifact read by the
// next poll is indistinguishable from a corrupt one, and rename is atomic
// within a filesystem.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    // Missing is the common case, and corrupt is treated the same, because the
    // caller's only sensible response to either is to regenerate. Anything
    // else — EACCES on the directory, say — must NOT look like a cache miss:
    // that would silently re-run a paid analysis on every single open.
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err instanceof SyntaxError) return null;
    throw err;
  }
}

// --- the review's own record ------------------------------------------------

/**
 * What this session is reviewing. Written once by /run, then read-only.
 *
 * It is what makes the review survive a shed restart: everything the page
 * needs — the target, the pull request metadata, the head SHA, the branch and
 * the worktree — is here, so nothing has to go back to `gh` to redraw a review
 * that was launched an hour ago.
 */
export function writeSessionReview({ session, review }) {
  writeJsonAtomic(path.join(ensureSessionDir(session), 'session.json'), review);
}

export function readSessionReview(session) {
  if (!isSessionName(session)) return null;
  return readJson(path.join(sessionDirFor(session), 'session.json'));
}

export function hasSessionReview(session) {
  if (!isSessionName(session)) return false;
  return fs.existsSync(path.join(sessionDirFor(session), 'session.json'));
}

/** Every session with review state on disk. */
export function listReviewSessions() {
  try {
    return fs.readdirSync(REVIEWS_DIR).filter(isSessionName);
  } catch {
    return [];
  }
}

/** Drop a review's state. The worktree is removed separately. */
export function removeReviewState(session) {
  if (!isSessionName(session)) return false;
  try {
    fs.rmSync(sessionDirFor(session), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// --- parsed diff ------------------------------------------------------------

export function readDiff(session) {
  if (!isSessionName(session)) return null;
  return readJson(path.join(sessionDirFor(session), 'diff.json'));
}

export function writeDiff({ session, diff }) {
  writeJsonAtomic(path.join(ensureSessionDir(session), 'diff.json'), diff);
}

// --- the generated artifact -------------------------------------------------

export function readArtifact(session) {
  if (!isSessionName(session)) return null;
  return readJson(path.join(sessionDirFor(session), 'review.json'));
}

export function writeArtifact({ session, artifact }) {
  writeJsonAtomic(path.join(ensureSessionDir(session), 'review.json'), artifact);
}

/**
 * Drop a stale artifact when the diff underneath it is replaced.
 *
 * Only a re-review needs this, and it needs it badly: restoreState treats an
 * artifact on disk as authoritative, so leaving the old one means the page
 * shows the previous ordering and preamble against the new code the moment
 * anything makes it re-read. Wrong and confident, rather than absent.
 */
export function removeArtifact(session) {
  if (!isSessionName(session)) return false;
  try {
    fs.rmSync(path.join(sessionDirFor(session), 'review.json'), { force: true });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}

/**
 * Empty a review without unmaking it.
 *
 * What the model produced goes — the artifact, the conversation, any job
 * breadcrumb pointing at a run that is no longer wanted. What the review IS
 * stays: `session.json`, which names the target, the worktree and the
 * `review/*` branch that NOTHING else names, and the diff it was taken from.
 *
 * That split is the whole point. Dropping `session.json` here would orphan a
 * shed-created worktree and its branch, which is the failure removeReviewState
 * exists to avoid doing by halves — and the page needs a diff to render, so
 * taking that too would leave it with nothing to show and no way back except
 * a re-review nobody asked for.
 */
export function discardReviewWork(session) {
  if (!isSessionName(session)) return false;
  removeArtifact(session);
  try {
    fs.rmSync(path.join(sessionDirFor(session), 'chat.json'), { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const kind of JOB_KINDS) clearJobBreadcrumb(session, kind);
  return true;
}

// --- explain answers --------------------------------------------------------
//
// There is no on-disk answer cache any more, deliberately.
//
// The old one was keyed on (head SHA, file, line, side, question), and that key
// was sound only because the tree an answer was computed from was pinned to the
// head SHA: every run re-checked-out to it and `git clean`ed. Under a session
// worktree the tree is LIVE — the reviewer can edit it, and `claude` in the
// pane can edit it — while the head SHA never moves. The key would therefore
// go on matching after the code it describes had changed, and the page would
// present a pre-edit answer with a "cached" label on it, which is worse than
// no cache at all.
//
// Of the three ways out, this is the one that cannot be subtly wrong. Reading
// through `git show <sha>:<path>` would answer about the pull request rather
// than about what the reviewer is looking at, and defeats the point of running
// in a checkout at all (the model greps callers and unchanged files). A key
// tracking the tree sounds right until you try to write it: `git diff HEAD`
// covers tracked edits, but the CONTENT of an untracked file is in no cheap
// fingerprint, so the key would be quietly unsound in exactly the case — a new
// file — where a reviewer is most likely to ask twice.
//
// What is left is a re-ask costing a few cents. The in-flight join in
// index.mjs still means a re-ask WHILE a run is going joins it rather than
// paying twice, and the page memoises answers for as long as it is open, so
// the paying case is a deliberate re-ask after a reload.
//
// `answerKey` survives because it is still the askId — the handle the page
// polls on. It is no longer a cache key, and it deliberately no longer
// includes a head SHA, because there is nothing SHA-shaped for it to mean.

/**
 * Identity of one question within one session. Used as the askId in the URL,
 * so it has to be filesystem- and URL-safe hex.
 */
export function answerKey({ session, filePath, line, side, question }) {
  // `session` is in the key because the key IS the identity of a run, and
  // explainJobs is a process-global map. Two review sessions can hold the same
  // path at the same line — different branches of the same repo usually do —
  // so without it the same question in both collides: the second ask joins the
  // first's in-flight run and is served an answer computed in the OTHER
  // session's worktree, about different code. It also let one job's cleanup
  // timer evict a newer job filed under the same key.
  //
  // `side` is here for a smaller version of the same thing: for a modified
  // line the deleted and added rows carry the SAME number, and the prompt says
  // which side it is asking about.
  if (!isSessionName(session)) throw new Error('answerKey needs a session name');
  return createHash('sha256')
    .update([session, filePath, line == null ? '' : String(line), side || '', question || ''].join('\0'))
    .digest('hex')
    .slice(0, 32);
}

// --- job breadcrumbs --------------------------------------------------------
//
// woodshed.service sets KillMode=process so tmux sessions survive a
// restart. The same setting means a `claude -p` child also survives — orphaned,
// with nobody reading its stdout, still spending. The breadcrumb is what lets
// the next boot find and reap it.

// One breadcrumb per job KIND, not per session. An analysis (up to 10 minutes)
// and an explain (seconds) run concurrently for the same review by design, so a
// single job.json meant the explain overwrote the analysis's entry and then
// deleted it on finishing — leaving a live analysis child with no breadcrumb at
// all, which is precisely the orphan the breadcrumb exists to reap.
const JOB_KINDS = ['analysis', 'explain', 'chat'];

function breadcrumbName(kind) {
  return `job-${JOB_KINDS.includes(kind) ? kind : 'analysis'}.json`;
}

export function writeJobBreadcrumb({ session, job }) {
  writeJsonAtomic(path.join(ensureSessionDir(session), breadcrumbName(job.kind)), job);
}

export function readJobBreadcrumbs(session) {
  if (!isSessionName(session)) return [];
  const dir = sessionDirFor(session);
  const out = [];
  for (const kind of JOB_KINDS) {
    const crumb = readJson(path.join(dir, breadcrumbName(kind)));
    if (crumb) out.push(crumb);
  }
  return out;
}

/** True when this session has any job recorded — i.e. a run was interrupted. */
export function hasJobBreadcrumb(session) {
  return readJobBreadcrumbs(session).length > 0;
}

export function clearJobBreadcrumb(session, kind) {
  if (!isSessionName(session)) return;
  try {
    fs.unlinkSync(path.join(sessionDirFor(session), breadcrumbName(kind)));
  } catch {
    // Already gone is the desired state.
  }
}

// --- the conversation ---------------------------------------------------------

// Everything ever said in this session's chat, oldest first. It lives with
// the review's other state, so a session's Kill button collects it, and it
// deliberately survives a re-review: the code moved, the conversation about
// it is still the conversation.
const MAX_CHAT_ENTRIES = 400;

export function readChat(session) {
  if (!isSessionName(session)) return [];
  const got = readJson(path.join(sessionDirFor(session), 'chat.json'));
  return Array.isArray(got) ? got : [];
}

/**
 * Add one turn to a session's transcript.
 *
 * Read, modify, write, with nothing holding a lock — which is safe only
 * because index.mjs's `chatJobs` allows a session one chat turn at a time, so
 * there is never a second writer. That guarantee lives in another file; if it
 * is ever relaxed, two turns landing together will lose one of them silently.
 */
export function appendChat({ session, entries }) {
  const all = readChat(session).concat(entries).slice(-MAX_CHAT_ENTRIES);
  writeJsonAtomic(path.join(ensureSessionDir(session), 'chat.json'), all);
  return all;
}

// --- migration off the old layout -------------------------------------------

/**
 * What the previous, PR-keyed design left behind: `pr-<n>` checkouts at the top
 * level and a `meta/` directory of per-PR state.
 *
 * This box really has both, which is the point — the design that removed the
 * garbage collector also removed the only thing that would ever have deleted
 * them. Returns absolute paths; the caller unregisters any worktree among them
 * before deleting.
 */
export function legacyStatePaths() {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(REVIEWS_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'meta') {
      out.push({ path: path.join(REVIEWS_DIR, 'meta'), isCheckout: false });
      continue;
    }
    // `pr-<n>` at the top level was the checkout itself — a registered git
    // worktree, so it has to be unregistered rather than merely deleted.
    if (/^pr-\d+$/.test(name)) out.push({ path: path.join(REVIEWS_DIR, name), isCheckout: true });
  }
  return out;
}
