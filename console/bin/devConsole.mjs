// Runs the console on this machine with a few made-up sessions, so a change to console/public can be checked in a
// browser without AWS, GitHub or Docker. Usage: node console/bin/devConsole.mjs [port] [tls ask port]
// Then open http://localhost:<port>/s/aaaa1111. CLAUDE.md says how to unfold the rail's stopped zones.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.argv[2] || '7690';
// Off unless given, so a second dev console does not fight over it (tlsAsk.mjs).
const tlsAskPort = process.argv[3] ? { WOODSHED_CLOUD_TLS_ASK_PORT: process.argv[3] } : {};
// The console as its image starts it, on the local provider (the docker launcher).
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'providers', 'console.mjs');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-console-'));

const now = new Date().toISOString();
function session(id, number, title, extra = {}) {
  return {
    id, repo: 'example-org/example-repo', kind: 'pr', number, title, startedBy: 'octocat', trigger: 'console', prompt: '',
    owner: null, options: null, resumeClaude: null, branch: `woodshed/${id}`, status: 'stopped', state: null,
    createdAt: now, startedAt: now, stoppedAt: now, lastActiveAt: now, checkedAt: null, stopReason: 'idle', error: null,
    head: null, prUrl: `https://github.com/example-org/example-repo/pull/${number}`, lastMessage: null, commentId: null,
    token: `t${id}`, terminalToken: `x${id}`, ref: null, endpoint: null, pendingMessages: [], ...extra,
  };
}
// A status line reading as sessions.mjs keeps it: each window's used share and how many minutes until it resets.
function planReading({ minutesAgo, fiveHour, sevenDay }) {
  const at = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  return {
    asOf: at(-minutesAgo),
    fiveHour: { usedPercent: fiveHour[0], resetsAt: at(fiveHour[1]) },
    sevenDay: { usedPercent: sevenDay[0], resetsAt: at(sevenDay[1]) },
  };
}
const sessions = [
  session('aaaa1111', 26325, 'Speed up Claude sessions'),
  session('bbbb2222', 26326, 'A session with no pull request yet', { prUrl: null }),
  session('cccc3333', 26327, 'A failed start', { status: 'failed', error: 'The container did not start.' }),
  // Running, for the top bar's buttons. With no container behind it the app's links and the terminal go nowhere.
  session('dddd4444', 26328, 'Keep background shell alive for cap', { status: 'running', stoppedAt: null, stopReason: null, app: 'stopped', appServers: { frontend: false, backend: false, frontendPort: 5173, backendPort: 8080 }, hasShell: true, editor: true }),
  // The rail's names: one started and assigned to octocat, one handed to him, one someone else has, and a private
  // one. Mine needs a signed-in octocat, which a stub of the page's data call gives.
  session('abcd7777', 26627, 'Merge Shared and My Woodshed tabs', { status: 'running', state: 'done', stoppedAt: null, stopReason: null, assignee: 'octocat' }),
  session('bcde8888', 26590, 'Fix CSV upload for large files', { kind: 'issue', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null, startedBy: 'ana-dev', assignee: 'octocat' }),
  // Its project uses no Redis, so Data ▾ has only the databases.
  session('cdef9999', 26629, 'Retry Xero sync on a 429', { status: 'running', state: 'working', stoppedAt: null, stopReason: null, startedBy: 'priya-dev', assignee: 'priya-dev', redis: false }),
  // Finished: its pull request is in Slack. Listed under Finished on Mine and on Everyone.
  session('ab12cd34', 26690, 'manage_datasets query returns too many rows', { kept: true, slackPostedAt: now, stopReason: null, assignee: 'octocat' }),
  // Two private sessions with plan readings: the older one's pane shows the newer reading, since the plan is shared.
  session('fedc0000', null, 'Removed timing on Woodshed', {
    kind: 'task', trigger: 'my-woodshed', owner: 'octocat', status: 'running', state: 'needs-you', stoppedAt: null, stopReason: null, prUrl: null,
    planUsage: planReading({ minutesAgo: 50, fiveHour: [20, 150], sevenDay: [40, 3 * 1440] }),
  }),
  session('fedd1111', null, 'Plan limits in the pane bar', {
    kind: 'task', trigger: 'my-woodshed', owner: 'octocat', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null,
    planUsage: planReading({ minutesAgo: 1, fiveHour: [42, 132], sevenDay: [78, 2 * 1440 + 600] }),
  }),
  // Deleted, so listed under Ended with Remove in its ⋯ menu. The older one has been deleted for longer than the
  // Console setting's days, so the first tick takes it off the list.
  session('de1e7e01', 26689, 'manage_datasets convert_file keeps headers', { cleanedAt: now, stopReason: 'its pull request merged 3 days ago', prClosedAt: now, prMerged: true }),
  session('de1e7e02', 26601, 'A session deleted a month ago', { cleanedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), prClosedAt: now, prMerged: true }),
  // A question from Slack that answered and paused: kept for a follow-up, and listed under Ended.
  session('ffff6666', null, 'What happens when someone adds the woodshed label?', {
    kind: 'ask', stopReason: 'idle for 5 min', kept: true, branch: null, prUrl: null, startedBy: 'slack:U0DEV', trigger: 'slack',
    slack: { channel: 'C0DEV', threadTs: '1.0', user: 'U0DEV', name: 'Joel' },
  }),
  // A question from Slack that has answered, for its own idle countdown.
  session('eeee5555', null, 'How does the console pick a session to start?', {
    kind: 'ask', status: 'running', state: 'idle', stoppedAt: null, stopReason: null, branch: null, prUrl: null,
    startedBy: 'slack:U0DEV', trigger: 'slack', lastActiveAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    slack: { channel: 'C0DEV', threadTs: '1.0', user: 'U0DEV', name: 'Joel' },
  }),
  // Starting, for the start checklist in the provider's words: its container is up and booting. With no container
  // behind it the start timeout fails it after a while; restart this script to see it again.
  session('5a5a5a5a', 26700, 'A session starting', {
    status: 'starting', stoppedAt: null, stopReason: null, prUrl: null, startedAt: new Date(Date.now() - 6_000).toISOString(),
    startSteps: { machine: new Date(Date.now() - 2_000).toISOString() },
  }),
];
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sessions, github: null }));

// The shell's own WOODSHED_CLOUD_* settings (a GitHub App, required sign-in, the ECS launcher) would turn this back
// into the real console, so none of them are passed on.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOODSHED_CLOUD_')));

// GH_TOKEN stands in for `gh auth token`, and polling is off, so nothing here calls GitHub.
const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  env: {
    ...inherited, WOODSHED_CLOUD_HOST: '127.0.0.1', WOODSHED_CLOUD_PORT: port, WOODSHED_CLOUD_STATE_DIR: stateDir,
    WOODSHED_CLOUD_POLL_GITHUB: '0', GH_TOKEN: 'dev', WOODSHED_CLOUD_APP_DOMAIN: 'apps.localhost',
    // The console starts only with a repo set: the sessions' made-up one, or the projects this shell names.
    ...(process.env.WOODSHED_CLOUD_PROJECTS
      ? { WOODSHED_CLOUD_PROJECTS: process.env.WOODSHED_CLOUD_PROJECTS }
      : { WOODSHED_CLOUD_REPO: 'example-org/example-repo' }),
    ...tlsAskPort,
  },
});
child.on('exit', (code) => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
