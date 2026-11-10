import test from 'node:test';
import assert from 'node:assert/strict';

import { listUntrackedDevServers, inWorktree, inDeletedWorktrees, groupByOwner, needsConfirm } from './devServerProcs.mjs';

// A recorded shape of the box: the repo, its worktrees directory, and processes
// keyed by pid. Everything below SIGTERMs whatever these selections return, so
// what each test pins is a process that must or must never be picked.
const REPO = '/home/dev/app';
const WORKTREES = `${REPO}/.claude/worktrees`;
const SHED_PID = 50;

function box(procs) {
  const table = new Map();
  const cwds = new Map();
  for (const [pid, { ppid = 1, comm = 'node', rssBytes = 100 * 1024 * 1024, cwd }] of Object.entries(procs)) {
    table.set(Number(pid), { ppid, comm, rssBytes });
    cwds.set(Number(pid), cwd);
  }
  const children = new Map();
  for (const [pid, info] of table) {
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(pid);
  }
  return {
    table,
    children,
    selfPid: SHED_PID,
    repoRoot: REPO,
    appDirs: ['web', 'api'],
    shedDirs: ['tools/shed'],
    readCwd: (pid) => cwds.get(pid) ?? null,
  };
}

function pids(procs) {
  return procs.map((p) => p.pid).sort((a, b) => a - b);
}

test('finds a dev server whose worktree was deleted — the leak that filled the box', () => {
  const b = box({
    10: { comm: 'next-server (v1', cwd: `${WORKTREES}/bridge-aaaaaaaa/web (deleted)` },
    11: { cwd: `${WORKTREES}/bridge-aaaaaaaa/api (deleted)` },
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  assert.deepEqual(pids(found), [10, 11]);
  assert.ok(found.every((p) => p.deleted));
  assert.deepEqual(pids(inDeletedWorktrees(found, WORKTREES)), [10, 11]);
});

test('never selects a process under a tmux pane, however deep', () => {
  const b = box({
    20: { comm: 'bash', cwd: `${WORKTREES}/bridge-bbbbbbbb` },  // pane root
    21: { ppid: 20, cwd: `${WORKTREES}/bridge-bbbbbbbb/api` },
    22: { ppid: 21, cwd: `${WORKTREES}/bridge-bbbbbbbb/api (deleted)` },
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map([['claude-bbbbbbbb', [20]]]) });
  assert.deepEqual(found, []);
});

test('never selects the shed, its ancestors or anything it spawned', () => {
  const b = box({
    40: { comm: 'node', cwd: `${REPO}/api` },  // an ancestor of the shed
    [SHED_PID]: { ppid: 40, cwd: `${REPO}/web` },
    60: { ppid: SHED_PID, cwd: `${REPO}/api` },  // e.g. a ttyd helper
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  assert.deepEqual(found, []);
});

test('ignores what is not a dev server: other commands, and directories that only look like the repo', () => {
  const b = box({
    30: { comm: 'claude', cwd: `${WORKTREES}/bridge-cccccccc/api` },
    31: { comm: 'python', cwd: `${REPO}/api` },
    32: { cwd: REPO },  // repo root, e.g. an MCP server — not web/ or api/
    33: { cwd: `${REPO}-notes/api` },  // shares the prefix, not the repo
    34: { cwd: '/home/dev' },
    35: { cwd: null },  // unreadable
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  assert.deepEqual(found, []);
});

test('a teardown stops only its own worktree, never a sibling that shares the prefix', () => {
  const b = box({
    70: { cwd: `${WORKTREES}/bridge-dddddddd/api` },
    71: { cwd: `${WORKTREES}/bridge-dddddddd/web/.next (deleted)` },
    72: { cwd: `${WORKTREES}/bridge-dddddddd-old/api` },
    73: { cwd: `${WORKTREES}/bridge-eeeeeeee/api` },
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  assert.deepEqual(pids(inWorktree(found, `${WORKTREES}/bridge-dddddddd`)), [70, 71]);
});

test('reaping takes only deleted directories inside the worktrees directory', () => {
  const b = box({
    80: { cwd: `${WORKTREES}/bridge-ffffffff/api` },  // live worktree: a teardown's call, not the reaper's
    81: { cwd: `${REPO}/api (deleted)` },  // outside worktrees: by-hand work
    82: { cwd: `${WORKTREES}/bridge-ffffffff/web (deleted)` },
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  assert.deepEqual(pids(inDeletedWorktrees(found, WORKTREES)), [82]);
});

test('a running session\'s detached servers group as in use; a sibling sharing the prefix does not', () => {
  const b = box({
    90: { comm: 'next-server (v1', cwd: `${WORKTREES}/bridge-11111111/web` },  // a start script's, outside the pane
    91: { cwd: `${WORKTREES}/bridge-11111111/api/src` },
    92: { cwd: `${WORKTREES}/bridge-11111111-old/api` },
    93: { cwd: `${WORKTREES}/bridge-22222222/api` },  // session ended, worktree kept
    94: { cwd: `${WORKTREES}/bridge-33333333/web (deleted)` },
    95: { cwd: `${REPO}/api` },
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  const groups = groupByOwner({ procs: found, worktreesDir: WORKTREES, liveWorktrees: [`${WORKTREES}/bridge-11111111`] });
  const byKey = Object.fromEntries(groups.map((g) => [g.key, { status: g.status, pids: pids(g.procs) }]));
  assert.deepEqual(byKey, {
    'bridge-11111111': { status: 'live', pids: [90, 91] },
    'bridge-11111111-old': { status: 'stopped', pids: [92] },
    'bridge-22222222': { status: 'stopped', pids: [93] },
    'bridge-33333333': { status: 'gone', pids: [94] },
    main: { status: 'main', pids: [95] },
  });
  assert.deepEqual(groups.filter((g) => needsConfirm(g.status)).map((g) => g.key).sort(), ['bridge-11111111', 'main']);
});

test('a test shed and its ttyds are found; the live shed, and a ttyd anywhere else, are not', () => {
  const b = box({
    100: { cwd: `${WORKTREES}/bridge-44444444/tools/shed` },  // preview.sh
    101: { ppid: 100, comm: 'ttyd', cwd: `${WORKTREES}/bridge-44444444/tools/shed` },
    102: { cwd: `${WORKTREES}/bridge-55555555/tools/shed (deleted)` },  // worktree since removed
    103: { comm: 'ttyd', cwd: `${WORKTREES}/bridge-55555555/tools/shed (deleted)` },
    104: { cwd: '/home/dev/woodshed' },  // the installed, live shed
    105: { comm: 'ttyd', cwd: '/home/dev/woodshed' },
    106: { comm: 'ttyd', cwd: `${REPO}/api` },  // ttyd is only ever a shed's
    107: { comm: 'python', cwd: `${REPO}/tools/shed` },
    108: { cwd: `${REPO}/tools` },  // the folder above the shed, not the shed
  });
  const found = listUntrackedDevServers({ ...b, panePids: new Map() });
  assert.deepEqual(pids(found), [100, 101, 102, 103]);
  assert.deepEqual(pids(inDeletedWorktrees(found, WORKTREES)), [102, 103]);
  assert.deepEqual(listUntrackedDevServers({ ...b, shedDirs: undefined, panePids: new Map() }), [], 'with no shed folder named, nothing is a shed');
});

test('a dev server is one in a folder the caller names, at any depth; with none named, nothing is', () => {
  const b = box({
    120: { cwd: `${WORKTREES}/bridge-66666666/apps/site/src` },
    121: { cwd: `${WORKTREES}/bridge-66666666/apps/sitemap` },  // shares the prefix, not the folder
    122: { cwd: `${WORKTREES}/bridge-66666666/docs` },  // in the checkout, but no app folder
    123: { cwd: `${WORKTREES}/bridge-66666666` },  // the checkout's root, where claude and its MCP servers sit
    124: { cwd: `${REPO}/apps/site (deleted)` },
  });
  const found = listUntrackedDevServers({ ...b, appDirs: ['apps/site/'], panePids: new Map() });
  assert.deepEqual(pids(found), [120, 124]);
  assert.deepEqual(listUntrackedDevServers({ ...b, appDirs: undefined, panePids: new Map() }), []);
  assert.deepEqual(listUntrackedDevServers({ ...box({ 125: { cwd: `${REPO}/api` } }), appDirs: [], panePids: new Map() }), []);
});
