// Dev servers a session started for itself, and finding them again afterwards.
//
// The shed stops the servers it starts — Start app and the frontend preview
// live in tmux sessions it owns. But a session also starts servers of its own:
// the repo's own start script and a backgrounded dev server both run as
// detached process groups, outside every tmux pane. Killing the claude session
// does not reach them, and removing the worktree does not either — they keep
// running from a deleted directory, and a `next dev` among them writes
// `.next/trace` back into the path, so the worktree's directory reappears on disk. Left alone they accumulate until the
// box runs out of memory, which is how this module came to exist.
//
// Kept apart from server.mjs, and taking its /proc readers as arguments, so the
// selection — the part that decides what gets a SIGTERM — can be tested against
// a recorded process table instead of the live box.

import path from 'node:path';

// What /proc/<pid>/cwd reads as once the directory has been removed.
const DELETED_SUFFIX = ' (deleted)';

const KILLABLE_COMMS = new Set(['node', 'esbuild', 'tsup', 'npm', 'npx']);
// /proc comm is capped at 15 characters, and Next sets its process title to
// "next-server (v15.x)" — so it arrives as "next-server (v1" and an exact-match
// set silently misses the largest processes on the box. Match those by prefix.
const KILLABLE_PREFIXES = ['next-server', 'next-router'];

export function isKillableComm(comm) {
  if (KILLABLE_COMMS.has(comm)) return true;
  return KILLABLE_PREFIXES.some((p) => comm.startsWith(p));
}

// A process whose directory was removed still reports the old path, with the
// kernel's marker appended. Without stripping it, `…/backend (deleted)` fails
// every path test below — which is exactly the process most worth finding.
export function parseCwd(cwd) {
  if (!cwd) return { dir: null, deleted: false };
  if (cwd.endsWith(DELETED_SUFFIX)) return { dir: cwd.slice(0, -DELETED_SUFFIX.length), deleted: true };
  return { dir: cwd, deleted: false };
}

// `dir` is `root` or somewhere below it. The separator matters: without it
// ~/app-notes/api passes as though it were inside ~/app.
export function isInsideDir(dir, root) {
  if (!dir || !root) return false;
  return dir === root || dir.startsWith(root + path.sep);
}

// Command name alone is far too loose: plenty of legitimate `node` runs outside
// tmux as the box's user — Claude Code's own SSH server when you use "Add SSH
// connection", a VS Code Remote server, a claude started from a plain ssh
// shell. Killing one of those would drop the connection you are working in.
//
// A dev server, by contrast, always runs from one of the app's folders in a
// checkout (`appDirs`, as `api` or `apps/web/`), which the caller names: its
// start command cd's there. Requiring that is what makes these lists safe to
// act on; the others sit at ~ or at the repo root and can never qualify, and
// with no folders named nothing does.
export function isDevServerDir(dir, repoRoot, appDirs) {
  return inNamedDir(dir, repoRoot, appDirs);
}

function inNamedDir(dir, repoRoot, dirs) {
  if (!isInsideDir(dir, repoRoot)) return false;
  const rel = dir.slice(repoRoot.length);
  return (dirs ?? []).map((d) => d.replace(/^\/+|\/+$/g, '')).filter(Boolean)
    .some((d) => new RegExp(`(^|/)${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`).test(rel));
}

// A test shed: a second copy of the caller run out of a checkout of the repo, in
// one of the folders the caller names (`shedDirs`, matched as appDirs are). The
// live copy runs from outside the repo, so it can never match, and is excluded
// as selfPids anyway. A shed's ttyds inherit its cwd, which is how they are
// found with it: they outlive a stopped preview, holding their ports. With no
// folders named, nothing is a shed.
export function isWoodshedDir(dir, repoRoot, shedDirs) {
  return inNamedDir(dir, repoRoot, shedDirs);
}

function qualifies(comm, dir, repoRoot, appDirs, shedDirs) {
  if (isWoodshedDir(dir, repoRoot, shedDirs)) return comm === 'node' || comm === 'ttyd';
  return isKillableComm(comm) && isDevServerDir(dir, repoRoot, appDirs);
}

// Every pid under a tmux pane — somebody's session, off limits.
function trackedPids(panePids, children) {
  const tracked = new Set();
  for (const roots of panePids.values()) {
    const stack = [...roots];
    while (stack.length) {
      const pid = stack.pop();
      if (tracked.has(pid)) continue;
      tracked.add(pid);
      for (const child of children.get(pid) || []) stack.push(child);
    }
  }
  return tracked;
}

// The shed, everything above it and everything below it. Killing our own
// ancestry would take the page down with it, and below it are the ttyds.
function selfPids(selfPid, table, children) {
  const chain = new Set();
  let cur = selfPid;
  while (cur && cur > 1 && !chain.has(cur)) {
    chain.add(cur);
    cur = table.get(cur)?.ppid;
  }
  const stack = [selfPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) || []) {
      if (chain.has(child)) continue;
      chain.add(child);
      stack.push(child);
    }
  }
  return chain;
}

/**
 * Dev-server processes running outside every tmux pane, of any size.
 *
 * Every caller narrows this further — the strays panel by memory, a session
 * teardown by worktree, the reaper to deleted directories — but they all start
 * from the same guarantees: never a pane's process, never the shed, never a
 * command that is not a dev server, never a directory outside the app's
 * folders (`appDirs`, see isDevServerDir) — or, for a test shed and its ttyds,
 * its own directory (`shedDirs`, see isWoodshedDir).
 *
 * `readCwd(pid)` returns the raw /proc cwd link or null when it cannot be read.
 */
export function listUntrackedDevServers({ table, children, panePids, selfPid, repoRoot, appDirs, shedDirs, readCwd }) {
  const tracked = trackedPids(panePids, children);
  const self = selfPids(selfPid, table, children);
  const out = [];
  for (const [pid, info] of table) {
    if (tracked.has(pid) || self.has(pid)) continue;
    if (!isKillableComm(info.comm) && info.comm !== 'ttyd') continue;
    const cwd = readCwd(pid);
    const { dir, deleted } = parseCwd(cwd);
    if (!qualifies(info.comm, dir, repoRoot, appDirs, shedDirs)) continue;
    out.push({ pid, comm: info.comm, rssBytes: info.rssBytes, cwd, dir, deleted });
  }
  return out;
}

// The ones running out of one worktree — what a session's Stop, Kill or Remove
// has to take down with it.
export function inWorktree(procs, worktree) {
  return procs.filter((p) => isInsideDir(p.dir, worktree));
}

// The ones whose worktree has been removed. Nothing can be using a dev server
// that serves a checkout which no longer exists, so these are the one case the
// shed stops without being asked. Scoped to the worktrees directory: a deleted
// directory anywhere else in the repo is somebody's by-hand work, not a leak.
export function inDeletedWorktrees(procs, worktreesDir) {
  return procs.filter((p) => p.deleted && isInsideDir(p.dir, worktreesDir));
}

// Statuses whose servers may be in use, so stopping them needs a confirmation.
// A live session's servers sit outside its pane by design (a start script
// may start them detached), so being listed here does not make them leftovers.
// The main checkout has no single owner to ask.
const IN_USE_STATUSES = new Set(['live', 'main']);

export function needsConfirm(status) {
  return IN_USE_STATUSES.has(status);
}

/**
 * The panel's grouping: one group per worktree, plus one for the main checkout,
 * each with the status that decides how freely it may be stopped.
 *
 * - `live`: a running session's worktree
 * - `stopped`: a worktree whose session is not running
 * - `gone`: a worktree that has been removed
 * - `main`: the repo's own checkout, outside every worktree
 *
 * `liveWorktrees` are the absolute worktree paths of running sessions.
 */
export function groupByOwner({ procs, worktreesDir, liveWorktrees }) {
  const groups = new Map();
  for (const p of procs) {
    const worktree = worktreeOf(p.dir, worktreesDir);
    const key = worktree ? path.basename(worktree) : 'main';
    if (!groups.has(key)) {
      groups.set(key, { key, worktree, status: statusOf(worktree, liveWorktrees), procs: [] });
    }
    const group = groups.get(key);
    group.procs.push(p);
    // One deleted cwd is enough: nothing in a removed worktree is in use.
    if (p.deleted && group.status === 'stopped') group.status = 'gone';
  }
  return [...groups.values()];
}

function worktreeOf(dir, worktreesDir) {
  if (!isInsideDir(dir, worktreesDir) || dir === worktreesDir) return null;
  return path.join(worktreesDir, dir.slice(worktreesDir.length + 1).split(path.sep)[0]);
}

function statusOf(worktree, liveWorktrees) {
  if (!worktree) return 'main';
  return liveWorktrees.includes(worktree) ? 'live' : 'stopped';
}
