// Which pull requests a running session has, for the chip on its card and the
// mark in its rail row. The shed stops at the worktree; this is the one thing
// it knows about what happened to the work afterwards.
//
// It is its own file for the reason the other root modules are: a seam. Nothing
// here touches tmux, ports or /proc, and server.mjs calls exactly three of these
// functions.
//
// ---- why it is per branch, and never awaited -------------------------------
//
// Rule 5 keeps anything slow off the /sessions path, and `gh` is a network call.
// So the poll never awaits: it reads a cache, and refills it on a timer behind
// itself. A chip is therefore up to a minute stale, which for CI is the right
// trade — the cost of a stale chip is clicking through to a pull request that
// has moved on, and the cost of a synchronous call is every open tab freezing
// until GitHub answers.
//
// The lookup is one call per branch rather than one bulk list of the repo's
// pull requests. Measured on this box against a busy repo:
//
//   gh pr list --state all --limit 150 --json ...,statusCheckRollup   HTTP 504
//   the same, without statusCheckRollup                     3.7s,   38 KB
//   gh pr list --state open --limit 40 --json ...,rollup     9.0s,  587 KB
//   gh pr list --head <branch> --state all --json ...,rollup ~1.2s, 6-32 KB
//
// The bulk list that carries what a chip needs does not exist: GitHub times out
// building it. One that omits the rollup needs a second pass for the checks
// anyway. Per branch costs one call per thing actually on screen — six branches
// in parallel came back in 1.6s total — and has no "last 150 pull requests"
// horizon for a session resumed onto an old branch to fall past.

import fs from 'node:fs';
import path from 'node:path';
import { run } from './review/exec.mjs';
import { originSlug } from './review/github.mjs';

// How long one branch's answer is good for. Checks take minutes to turn over,
// so a minute of staleness is invisible in practice.
const FRESH_MS = 60_000;
// Except when the answer cannot change any more. A merged or closed pull
// request is immutable — its state, its checks and its review are all final —
// so re-asking every minute buys nothing. This is what makes a generous branch
// cap affordable: a session with eleven branches pays for eleven lookups once,
// and then only for the branches that are still live.
const SETTLED_FRESH_MS = 15 * 60_000;
// After a failure — no auth, no network, GitHub down — wait longer before
// trying that branch again, so a broken `gh` costs one call per branch per five
// minutes rather than one per minute forever.
const FAIL_BACKOFF_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 20_000;
// A payload cap that no single branch's answer approaches (the largest measured
// was 32 KB) but which bounds a pathological one.
const GH_MAX_BYTES = 4 * 1024 * 1024;
// At most this many `gh` processes at once per refresh pass. What keeps there
// from being many overlapping passes is the inFlight claim in
// schedulePrRefresh, not this number.
const MAX_PARALLEL = 4;
// A session's current branch plus every branch it has moved off. This caps the
// branches KEPT, not the reflog scanned — the whole tail is read either way,
// which is nothing for a file that runs to a few dozen lines.
//
// Twelve because four was measured to be wrong. Across the 32 worktrees on
// this box the distribution is p50=1, p90=2, max=11 — but that max is a real
// session whose open pull request sat on the sixth branch back, because it had
// rebuilt its branch twice and moved on. A cap of four silently dropped the one
// thing worth showing: the merged work behind it still drew three chips, so the
// card looked complete while the OPEN pull request was the one missing. Twelve
// clears every worktree here with room, and the cap now almost never binds.
const MAX_BRANCHES_PER_SESSION = 12;
// The reflog of a long-lived session is unbounded and this read is on the poll
// path. Only the tail matters — it holds the most recent checkouts.
const REFLOG_TAIL_BYTES = 256 * 1024;
// Nothing has asked about this branch in a while, so stop holding its answer.
const CACHE_TTL_MS = 30 * 60_000;

// branch -> { at, prs, failedAt, seenAt }. Module-level, and deliberately not
// in tmux: unlike a label this is derived, not remembered, so a shed restart
// costs one refresh rather than losing anything (rule 4's counter-case).
const cache = new Map();
const inFlight = new Set();

/**
 * The branches a session's worktree has been on: its current one first, then
 * back through its reflog. Two small file reads, no subprocess — this runs
 * inside the /sessions poll, once per running session.
 *
 * @returns {string[]} newest first, already filtered to plausible PR branches
 */
export function branchesForSession({ worktreePath }) {
  try {
    const gitDir = resolveWorktreeGitDir(worktreePath);
    if (!gitDir) return [];
    const head = readTextFile(path.join(gitDir, 'HEAD'), 4096);
    const reflog = readTailOf(path.join(gitDir, 'logs', 'HEAD'), REFLOG_TAIL_BYTES);
    return parseWorktreeBranches({ head, reflog });
  } catch (err) {
    // A worktree removed mid-poll is the ordinary way to land here. No branches
    // is the right answer, and it is not worth a log line per session per poll.
    return [];
  }
}

/**
 * The branch names in a worktree's HEAD and reflog, newest first. Pure, so the
 * filtering rules can be tested against recorded git files rather than by
 * driving a real checkout.
 *
 * @param {{head: string, reflog: string}} files contents of HEAD and logs/HEAD
 * @returns {string[]}
 */
export function parseWorktreeBranches({ head, reflog }) {
  const names = [];

  const current = parseHeadRef(head);
  if (current) names.push(current);

  // Reflog entries are chronological, so walking backwards gives most recent
  // first. Only checkouts are matched:
  //   "checkout: moving from <old> to <new>"
  // Both sides count — the branch a session left is where its earlier pull
  // request came from. A `git branch -m` writes "Branch: renamed refs/heads/A
  // to refs/heads/B" and is deliberately NOT matched: the only rename the
  // shed itself performs is off the scaffolding branch, which normalizeBranch
  // drops anyway.
  const lines = (reflog || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const move = /\bcheckout: moving from (\S+) to (\S+)\s*$/.exec(lines[i]);
    if (!move) continue;
    names.push(move[2], move[1]);
  }

  const out = [];
  const seen = new Set();
  for (const raw of names) {
    const name = normalizeBranch(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_BRANCHES_PER_SESSION) break;
  }
  return out;
}

/** "ref: refs/heads/<name>". A detached HEAD is a bare sha and names nothing. */
function parseHeadRef(head) {
  const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head || '');
  return m ? m[1] : null;
}

/**
 * The branch a worktree is on RIGHT NOW, or null when it is on nothing a pull
 * request could be on — main or master, the shed's scaffolding branch, a detached
 * sha. Distinct from parseWorktreeBranches on purpose: that list is history,
 * and "this session has been on that branch" is not "this session is on it".
 * The rail's pull-request folder asks the second question, and answering it
 * from the first sent people into a session that had moved on.
 *
 * @returns {string|null}
 */
export function parseHeadBranch(head) {
  return normalizeBranch(parseHeadRef(head));
}

/** parseHeadBranch, read from a session's worktree. One 4 KB read. */
export function currentBranchForSession({ worktreePath }) {
  try {
    const gitDir = resolveWorktreeGitDir(worktreePath);
    if (!gitDir) return null;
    return parseHeadBranch(readTextFile(path.join(gitDir, 'HEAD'), 4096));
  } catch {
    return null;
  }
}

/**
 * Reject what cannot carry a pull request, and normalise what can.
 *
 * @returns {string|null}
 */
function normalizeBranch(raw) {
  let name = String(raw || '').trim();
  if (!name) return null;
  // A remote-tracking checkout ("origin/feat/x") is a detached read of somebody
  // else's branch; the pull request is on the branch name without the remote.
  name = name.replace(/^origin\//, '');
  if (!name) return null;
  // The branch every shed worktree is created on. It is scaffolding — it is
  // renamed the moment real work starts — and skipping it here is what keeps an
  // idle session from costing a `gh` call a minute for a branch that by
  // construction has no pull request.
  if (/^worktree-bridge-[0-9a-f]{8}$/.test(name)) return null;
  if (name === 'master' || name === 'main' || name === 'HEAD') return null;
  // This becomes argv. There is no shell on this path, but a value starting
  // with "-" would still be read by `gh` as an option rather than a branch, and
  // a branch name is a known, narrow character set.
  if (name.startsWith('-')) return null;
  if (!/^[A-Za-z0-9._\/-]{1,255}$/.test(name)) return null;
  return name;
}

/**
 * A worktree's git directory. The `.git` in a worktree is a file holding
 * "gitdir: <path>", not a directory — read it rather than rebuilding the
 * `<repo>/.git/worktrees/<slug>` layout a second time.
 *
 * @returns {string|null}
 */
function resolveWorktreeGitDir(worktreePath) {
  if (!worktreePath) return null;
  const dotGit = path.join(worktreePath, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  // The main checkout: .git is a real directory and this is not a worktree.
  if (stat.isDirectory()) return null;
  const pointer = readTextFile(dotGit, 4096);
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  return m ? m[1] : null;
}

function readTextFile(file, maxBytes) {
  const buf = Buffer.alloc(maxBytes);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, read).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The last `maxBytes` of a file, for a log that grows without bound. */
function readTailOf(file, maxBytes) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const want = size - start;
    const buf = Buffer.alloc(want);
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buf, 0, want, start);
    return buf.slice(0, read).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The pull requests to draw for a session, from whatever the cache holds.
 * Synchronous by design: this is what the poll calls.
 *
 * @param {string[]} branches from branchesForSession()
 * @returns {Array<object>} newest first; empty when nothing is known yet
 */
export function pullRequestsFor(branches) {
  const found = [];
  const seen = new Set();
  for (const branch of branches || []) {
    const entry = cache.get(branch);
    if (!entry) continue;
    entry.seenAt = Date.now();
    for (const pr of entry.prs || []) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      found.push(pr);
    }
  }
  return selectPullRequests(found);
}

/**
 * Which of a session's pull requests are worth drawing, and in what order.
 *
 * Still in flight first, then settled, each newest-first within its group.
 * Not simply newest-first: a session that has shipped eight times and has one
 * open pull request had that open one land in the MIDDLE of the row, sorted
 * between merged numbers above and below it. The live one is the only one
 * anybody can still act on, and both the card and the rail take their lead
 * from the head of this list.
 *
 * A closed-unmerged pull request is dropped when anything of the session's did
 * land or is still in flight — that is the supersede case ("closed #23820,
 * opened #23860"), where the newer one is the whole story and the dead one is
 * noise. It survives only when it is the session's last word, which is the
 * case worth flagging: a session that looks finished and shipped nothing.
 *
 * @param {Array<object>} prs
 * @returns {Array<object>}
 */
export function selectPullRequests(prs) {
  const byNumber = [...(prs || [])].sort((a, b) => b.number - a.number);
  const live = byNumber.filter((p) => p.state !== 'closed');
  const kept = live.length ? live : byNumber;
  return [...kept].sort((a, b) => rank(a) - rank(b) || b.number - a.number);
}

/** In flight before settled. Draft ranks with open — it is still yours to move. */
function rank(pr) {
  return pr?.state === 'open' || pr?.state === 'draft' ? 0 : 1;
}

/**
 * Reduce GitHub's statusCheckRollup — 30 to 100 entries per pull request in
 * this repo — to the three numbers a badge can show. Called the moment a
 * response lands, so the raw array is never held.
 *
 * @returns {{pass: number, fail: number, pending: number, total: number}}
 */
export function reduceChecks(rollup) {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const check of Array.isArray(rollup) ? rollup : []) {
    // Two shapes in one array: CheckRun has status/conclusion, StatusContext
    // has state. A CheckRun that has not COMPLETED has a null conclusion, so
    // reading conclusion first would count every running job as passing.
    const verdict = check?.status === 'COMPLETED'
      ? check?.conclusion
      : (check?.state || check?.status);
    if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') pass++;
    else if (
      verdict === 'FAILURE' || verdict === 'TIMED_OUT' || verdict === 'CANCELLED' ||
      verdict === 'ACTION_REQUIRED' || verdict === 'STARTUP_FAILURE' || verdict === 'ERROR'
    ) fail++;
    else pending++;
  }
  return { pass, fail, pending, total: pass + fail + pending };
}

/**
 * One `gh pr list` record, reduced to what the page draws. Everything else —
 * the rollup array above all — is dropped here rather than cached.
 *
 * @returns {object|null}
 */
export function describePr(raw) {
  const number = Number(raw?.number);
  if (!Number.isSafeInteger(number) || number < 1) return null;

  const ghState = String(raw?.state || '').toUpperCase();
  let state = 'open';
  if (ghState === 'MERGED') state = 'merged';
  else if (ghState === 'CLOSED') state = 'closed';
  else if (raw?.isDraft) state = 'draft';

  // A settled pull request reports neither. Checks on it are history, and a red
  // cross would read as something to go and fix; the review is worse than
  // history, because "merged · approved" is a mark on every merged chip that
  // says nothing anyone did not already know from the word "merged".
  const settled = state === 'merged' || state === 'closed';

  const decision = String(raw?.reviewDecision || '').toUpperCase();
  let review = null;
  if (settled) review = null;
  else if (decision === 'APPROVED') review = 'approved';
  else if (decision === 'CHANGES_REQUESTED') review = 'changes';
  else if (decision === 'REVIEW_REQUIRED') review = 'pending';

  const checks = settled ? null : reduceChecks(raw?.statusCheckRollup);

  return {
    number,
    title: typeof raw?.title === 'string' ? raw.title.slice(0, 300) : '',
    url: typeof raw?.url === 'string' && /^https:\/\/github\.com\//.test(raw.url) ? raw.url : null,
    branch: typeof raw?.headRefName === 'string' ? raw.headRefName.slice(0, 255) : '',
    state,
    review,
    checks: checks && checks.total ? checks : null,
  };
}

/**
 * How long a cached answer stays good.
 *
 * An empty answer is NOT settled: "this branch has no pull request" becomes
 * false the moment someone opens one, which is exactly the transition the chip
 * exists to show. Only a branch whose pull requests are all merged or closed
 * has an answer that cannot change.
 *
 * @param {{prs: Array<object>, failedAt: number|null}} entry
 * @returns {number} ms
 */
export function ttlFor(entry) {
  if (entry?.failedAt) return FAIL_BACKOFF_MS;
  const prs = entry?.prs;
  if (!Array.isArray(prs) || prs.length === 0) return FRESH_MS;
  const settled = prs.every((p) => p?.state === 'merged' || p?.state === 'closed');
  return settled ? SETTLED_FRESH_MS : FRESH_MS;
}

/**
 * Refill whatever has gone stale, behind the poll. The poll does not await the
 * returned promise and never sees its result.
 *
 * @param {string[]} branches every branch on screen this poll
 */
export function schedulePrRefresh(branches) {
  const stale = [];
  const now = Date.now();
  for (const branch of branches || []) {
    if (inFlight.has(branch)) continue;
    const entry = cache.get(branch);
    if (entry) {
      entry.seenAt = now;
      const age = now - entry.at;
      if (age < ttlFor(entry)) continue;
    }
    // Claimed HERE, not when a worker picks it up. inFlight has to mean
    // "queued or running", because /sessions is polled about once a second
    // across open tabs: a branch sitting in the queue was invisible to the
    // next poll, which re-enqueued it and started another MAX_PARALLEL
    // workers. On a cold start with forty branches that stacked `gh`
    // processes and asked GitHub the same question several times over.
    // MAX_PARALLEL only bounds one call to refreshBranches; this is what
    // stops there being an unbounded number of those.
    inFlight.add(branch);
    stale.push(branch);
  }
  prune(now);
  if (!stale.length) return undefined;
  // The poll ignores the promise; a caller that needs the answer now can await it. It cannot reject: refreshBranch
  // swallows its own errors.
  // Every branch claimed above is released in refreshBranch's finally, and the
  // worker loop drains the queue completely, so no claim outlives this call.
  return refreshBranches(stale);
}

function prune(now) {
  for (const [branch, entry] of cache) {
    if (now - (entry.seenAt || entry.at) > CACHE_TTL_MS) cache.delete(branch);
  }
}

async function refreshBranches(branches) {
  const queue = [...branches];
  const workers = [];
  for (let i = 0; i < Math.min(MAX_PARALLEL, queue.length); i++) {
    workers.push((async function worker() {
      while (queue.length) {
        const branch = queue.shift();
        await refreshBranch(branch);
      }
    })());
  }
  await Promise.all(workers);
}

/** What describePr reads. A caller that needs more appends to it. */
export const PR_LIST_FIELDS = [
  'number', 'title', 'headRefName', 'state', 'isDraft', 'reviewDecision', 'url', 'statusCheckRollup',
];

/**
 * One `gh pr list`, as the raw records or null. The single place the shed
 * shells out to list pull requests: the per-branch lookup below and the rail's
 * folder (pullRequests.mjs) both come through here, so what a failure looks
 * like, how much output is allowed and which fields describePr depends on
 * cannot drift between the two — the folder had its own copy once, and a
 * field added to one list and not the other would have reduced every folder
 * row to the default with nothing to say so.
 *
 * @param {{slug: string, args: string[], extraFields?: string[],
 *          log: Function, event: string, fields: object}} params
 *   `event` is the log prefix ("pr.lookup") and `fields` what to log with it.
 * @returns {Promise<object[]|null>} null on any failure — spawn, exit, parse —
 *   so a caller can tell "nothing matched" from "GitHub did not answer".
 */
export async function ghPrList({ slug, args, extraFields = [], log, event, fields }) {
  const result = await run(
    'gh',
    ['pr', 'list', '--repo', slug, ...args, '--json', [...PR_LIST_FIELDS, ...extraFields].join(',')],
    { timeoutMs: GH_TIMEOUT_MS, maxBytes: GH_MAX_BYTES },
  );
  if (result.status !== 0) {
    log(event + '_failed', {
      ...fields,
      status: result?.status,
      error: (result?.stderr || '').toString().trim().slice(0, 200),
    });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (err) {
    log(event + '_unparseable', { ...fields, error: err?.message });
    return null;
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** The branch is already claimed in inFlight by schedulePrRefresh; this
 *  releases it. */
async function refreshBranch(branch) {
  try {
    const slug = await originSlug(repoRoot);
    if (!slug) {
      remember(branch, null);
      return;
    }
    const raw = await ghPrList({
      slug,
      args: ['--head', branch, '--state', 'all', '--limit', '10'],
      log: logFn,
      event: 'pr.lookup',
      fields: { branch },
    });
    if (raw === null) {
      remember(branch, null);
      return;
    }
    // An empty array is a real answer — this branch has no pull request — and
    // caching it is the point: without it every branchless session would be
    // looked up again every minute.
    remember(branch, raw.map(describePr).filter(Boolean));
  } catch (err) {
    // Nothing above should reach here: exec.mjs's `run` documents that it
    // never rejects, for a non-zero exit or a failed spawn alike, and the JSON
    // parse has its own catch. This is here because the caller fires this with
    // `void` and cannot await it, so an escaped rejection would be an
    // unhandled one — and under `Restart=on-failure` that ends the process and
    // drops every embedded terminal on the box. Three lines to keep that
    // guarantee local instead of resting on another module's contract.
    remember(branch, null);
    logFn('pr.lookup_threw', { branch, error: err?.message });
  } finally {
    inFlight.delete(branch);
  }
}

/** `prs === null` records a failure, which backs the branch off rather than
 *  discarding an answer that is merely old. */
function remember(branch, prs) {
  const previous = cache.get(branch);
  cache.set(branch, {
    at: Date.now(),
    seenAt: Date.now(),
    prs: prs || previous?.prs || [],
    failedAt: prs ? null : Date.now(),
  });
}

// server.mjs owns both of these; they are handed over rather than re-derived so
// this module has no opinion about where the repo is or how logging works.
let repoRoot = '';
let logFn = function noop() {};

/** @param {{repoRoot: string, log: Function}} deps */
export function configurePrStatus(deps) {
  repoRoot = deps?.repoRoot || '';
  if (typeof deps?.log === 'function') logFn = deps.log;
}

/** Test seam: drop everything cached, so one test cannot see another's state. */
export function resetPrCache() {
  cache.clear();
  inFlight.clear();
}
