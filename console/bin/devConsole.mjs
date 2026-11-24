// Runs the console on this machine with a few made-up sessions, so a change to console/public can be checked in a
// browser without AWS, GitHub or Docker. Usage: node console/bin/devConsole.mjs [port] [tls ask port]
// Then open http://localhost:<port>/s/aaaa1111. CLAUDE.md says how to unfold the rail's stopped zones.
// /s/beadfeed?tab=review is a running session whose Review tab is the shed's real page, over a made-up change with an
// analysis already written (devReviewSession.mjs). /s/abbaabba is running on a project with two apps, web and admin,
// behind the real statusd (devAppsSession.mjs): Start app picks one, and Open app opens whichever runs. /s/c0ffee11 has
// a live TUI, where ttyd and tmux are on the PATH (devTerminalSession.mjs). /s/c0de5e55 and /s/c1a0de00 open
// on a Chat tab that works, over a stand-in codex and claude behind the real statusd, where tmux is on the PATH
// (devChatSession.mjs): a message is answered with a few tool calls and a reply, one that says "fail" has a tool fail,
// and one that says "ask" puts the codex session at Needs you until Enter in its TUI tab.
// /s/62000c0d and /s/0c0de0c0 are the same over a stand-in Grok Build and OpenCode, writing each one's own record (its
// updates.jsonl, its SQLite database) for the real statusd to read.
// /s/c1a0de02 is the same claude, started from a Claude home that holds an earlier session's conversation, as a private
// session started while another runs is: its Chat stays empty until it is sent a message. /s/a6e1a6e1 is @local's own
// session on that codex, whose pane bar's agent switch starts a stand-in claude or codex beside it (session/agents.mjs).
// DEV_CONSOLE_APP_PORTS=7701-7703 puts session apps on those ports of localhost, in place of `<id>.apps.localhost`.
// DEV_CONSOLE_SESSION_APP=1, in a session (SESSION_ID set), also answers under the session's app name,
// `<SESSION_ID>.<SESSION_APP_DOMAIN>`, as Woodshed's own app does behind the console's app proxy (scripts/devConsoleApp.sh).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentName, envValue, isSettingName } from '../../shared/envNames.mjs';
import { startDevAppsSession } from './devAppsSession.mjs';
import { startDevChatSession } from './devChatSession.mjs';
import { writeDevGh } from './devGh.mjs';
import { enableReview } from '../../cli/projectReview.mjs';
import { startDevReview } from './devReviewSession.mjs';
import { startDevTerminal } from './devTerminalSession.mjs';
import { makeDevClone } from './devWoodshedClone.mjs';

const port = process.argv[2] || '7690';
const sessionApp = process.env.DEV_CONSOLE_SESSION_APP === '1';
const sessionId = process.env.SESSION_ID ?? '';
if (sessionApp && !/^[0-9a-f]{8}$/.test(sessionId)) {
  console.error('dev console: DEV_CONSOLE_SESSION_APP=1 needs the session\'s SESSION_ID');
  process.exit(1);
}
const appDomain = (process.env.SESSION_APP_DOMAIN ?? '').trim().toLowerCase();
// A console from before SESSION_APP_DOMAIN sends none. Without the domain the app name cannot be told from a DNS-rebound
// `<SESSION_ID>.attacker.example`, so only loopback is let in.
if (sessionApp && !appDomain) console.warn('dev console: no SESSION_APP_DOMAIN, so the session\'s app name is refused and only loopback is let in');
// Off unless given, so a second dev console does not fight over it (tlsAsk.mjs).
const tlsAskPort = process.argv[3] ? { WOODSHED_TLS_ASK_PORT: process.argv[3] } : {};
// The console as its image starts it, on the local provider (the docker launcher). DEV_CONSOLE_HOST_REPOS=1 starts it as
// an embedding program would, with a made-up repos hook, for Console settings' Repos card (scripts/devHostConsole.mjs).
const woodshed = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// DEV_CONSOLE_REVIEWER=none|made|installed gives it a made-up console App and reviewer App, for `woodshed review`
// (scripts/devReviewerConsole.mjs): none made, made but not installed on example-org/example-repo, or installed there.
const reviewerDev = ['none', 'made', 'installed'].includes(process.env.DEV_CONSOLE_REVIEWER) ? process.env.DEV_CONSOLE_REVIEWER : null;
const server = path.join(woodshed, ...(process.env.DEV_CONSOLE_HOST_REPOS === '1' ? ['scripts', 'devHostConsole.mjs']
  : reviewerDev ? ['scripts', 'devReviewerConsole.mjs'] : ['providers', 'console.mjs']));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-console-'));

const now = new Date().toISOString();
// /s/5747ed01's start token (console/sessionStarts.mjs), for session/bin/woodshed-session from this machine: with
// DEV_CONSOLE_SESSION_API_PORT, `WOODSHED_CONSOLE_URL=http://127.0.0.1:<port> node session/startSessions.mjs` with this
// file as its token file (WOODSHED_START_TOKEN_FILE). Only its hash is in the made-up state, as the console keeps it.
const devStartToken = `wst_${crypto.randomBytes(32).toString('hex')}`;
const devStartTokenFile = path.join(stateDir, 'start-token');
fs.writeFileSync(devStartTokenFile, devStartToken, { mode: 0o600 });
console.log('dev console: /s/5747ed01\'s start token for woodshed-session', { file: devStartTokenFile });
const REVIEW_ID = 'beadfeed';
// DEV_CONSOLE_REVIEW_PR=1 makes /s/beadfeed @local's own My Woodshed session, whose branch has a made-up open pull
// request, #26701, answered by a stand-in gh (devReviewGh.mjs): for `woodshed review beadfeed`, which opens your own
// sessions only, and for the review's writes (comment, verdict, rename, merge), which a shared session's review refuses.
// It opened #26695 before it, on a branch of its own: its Review switches between the two, each with its own review.
const reviewPr = process.env.DEV_CONSOLE_REVIEW_PR === '1'
  ? { number: 26701, title: 'Retry webhook deliveries with backoff', login: 'local', slug: 'example-org/example-repo',
    earlier: { number: 26695, branch: `woodshed/${REVIEW_ID}-docs`, title: 'Say what a webhook subscriber should answer' } } : null;
// The PATH before the review's stand-in gh goes first on it: everything else here, the console's own gh among it,
// keeps the PATH it had.
const basePath = process.env.PATH;
const review = await startDevReview({ id: REVIEW_ID, branch: `woodshed/${REVIEW_ID}`, pr: reviewPr });
const APPS_ID = 'abbaabba';
// Each made-up session's statusd and ttyd take a token made for this run: they listen on loopback alone, and a token
// written in this repository would let anything on the machine type into them.
const secret = () => crypto.randomBytes(16).toString('hex');
const tokens = new Map();
const tokensOf = (id) => {
  if (!tokens.has(id)) tokens.set(id, { token: secret(), terminalToken: secret() });
  return tokens.get(id);
};
const twoApps = await startDevAppsSession({ id: APPS_ID, token: tokensOf(APPS_ID).token });
const TERMINAL_ID = 'c0ffee11';
const liveTerminal = await startDevTerminal({ id: TERMINAL_ID, terminalToken: `x${TERMINAL_ID}` });
const CODEX_CHAT_ID = 'c0de5e55';
const CLAUDE_CHAT_ID = 'c1a0de00';
const codexChat = await startDevChatSession({ id: CODEX_CHAT_ID, ...tokensOf(CODEX_CHAT_ID), agent: 'codex', nextPath: [twoApps.binDir, basePath].join(path.delimiter) });
const claudeChat = await startDevChatSession({ id: CLAUDE_CHAT_ID, ...tokensOf(CLAUDE_CHAT_ID), agent: 'claude', nextPath: [codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) });
// Grok Build and OpenCode, private sessions of @local's: their records in their own shapes (devChatAgent.mjs).
const GROK_CHAT_ID = '62000c0d';
const OPENCODE_CHAT_ID = '0c0de0c0';
const grokChat = await startDevChatSession({ id: GROK_CHAT_ID, ...tokensOf(GROK_CHAT_ID), agent: 'grok', nextPath: [claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) });
const openCodeChat = await startDevChatSession({ id: OPENCODE_CHAT_ID, ...tokensOf(OPENCODE_CHAT_ID), agent: 'opencode', nextPath: [grokChat?.binDir, claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) });
// A private session just started while another runs: its Claude home, restored from its owner's, holds an earlier
// session's conversation, and its own claude has written nothing yet. Its Chat is empty until it is sent a message.
// /s/5747ed01 started it, so `woodshed-session send|wait|read` from there reach its stand-in claude (sessionStarts.mjs).
const NEW_CHAT_ID = 'c1a0de02';
const newChat = await startDevChatSession({ id: NEW_CHAT_ID, ...tokensOf(NEW_CHAT_ID), agent: 'claude', restoredHome: true, nextPath: [openCodeChat?.binDir, grokChat?.binDir, claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) });
// A private session of the dev login's on a stand-in codex, whose pane bar offers + Another agent (session/agents.mjs):
// the agents it starts are stand-ins too, a claude and a codex, each with its own Chat and TUI.
const AGENTS_CHAT_ID = 'a6e1a6e1';
const agentsChat = await startDevChatSession({ id: AGENTS_CHAT_ID, ...tokensOf(AGENTS_CHAT_ID), agent: 'codex', nextPath: [newChat?.binDir, openCodeChat?.binDir, grokChat?.binDir, claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) });
// A real agent runs on this machine's credentials, so it is never served behind the session's app name: Open app and
// app shares reach that console, which has no sign-in. Run it on a port of its own instead, which only this machine
// reaches: DEV_CONSOLE_REAL_CLAUDE=1 node console/bin/devConsole.mjs 7700.
const wantsReal = process.env.DEV_CONSOLE_REAL_CLAUDE === '1' || process.env.DEV_CONSOLE_REAL_CODEX === '1';
if (wantsReal && sessionApp) console.warn('dev console: no real agent behind DEV_CONSOLE_SESSION_APP, which Open app and app shares reach: run one on another port');
const realAllowed = wantsReal && !sessionApp;
// DEV_CONSOLE_REAL_CLAUDE=1: /s/c1a0dea1 runs the real claude, on this machine's Claude credential, in a clone of this
// checkout with no remote (devChatSession.mjs), with its TUI tab live. Off by default: it spends that credential.
const REAL_ID = 'c1a0dea1';
const realClaude = realAllowed && process.env.DEV_CONSOLE_REAL_CLAUDE === '1'
  ? await startDevChatSession({ id: REAL_ID, ...tokensOf(REAL_ID), agent: 'claude', real: true,
    nextPath: [agentsChat?.binDir, newChat?.binDir, openCodeChat?.binDir, grokChat?.binDir, claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) })
  : null;
if (realAllowed && process.env.DEV_CONSOLE_REAL_CLAUDE === '1' && !realClaude) console.warn('dev console: no real claude, it needs claude, ttyd and tmux on the PATH');
// DEV_CONSOLE_REAL_CODEX=1: /s/c0dea1ed runs the real codex the same way, on this machine's Codex sign-in.
const REAL_CODEX_ID = 'c0dea1ed';
const realCodex = realAllowed && process.env.DEV_CONSOLE_REAL_CODEX === '1'
  ? await startDevChatSession({ id: REAL_CODEX_ID, ...tokensOf(REAL_CODEX_ID), agent: 'codex', real: true,
    nextPath: [realClaude?.binDir, agentsChat?.binDir, newChat?.binDir, openCodeChat?.binDir, grokChat?.binDir, claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter) })
  : null;
function session(id, number, title, extra = {}) {
  return {
    id, repo: 'example-org/example-repo', kind: 'pr', number, title, startedBy: 'octocat', trigger: 'console', prompt: '',
    owner: null, options: null, resumeClaude: null, branch: `woodshed/${id}`, status: 'stopped', state: null,
    createdAt: now, startedAt: now, stoppedAt: now, lastActiveAt: now, checkedAt: null, stopReason: 'idle', error: null,
    head: null, prUrl: `https://github.com/example-org/example-repo/pull/${number}`, lastMessage: null, commentId: null,
    ...(tokens.get(id) ?? { token: `t${id}`, terminalToken: `x${id}` }), ref: null, endpoint: null, pendingMessages: [], ...extra,
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
const GB = 1024 ** 3;
const sessions = [
  session('aaaa1111', 26325, 'Speed up Claude sessions'),
  session('bbbb2222', 26326, 'A session with no pull request yet', { prUrl: null }),
  // A finished QA session: it opened no pull request, and tested the one it was started on.
  session('9a9a9a9a', 26334, 'QA: Make the GitHub App optional', { trigger: 'qa', prUrl: null, head: '688cc2e', stopReason: 'QA finished: Pass: 6 test cases passed', qa: { conclusion: 'success' } }),
  session('9b9b9b9b', 26335, 'QA: Make the GitHub App optional', { trigger: 'qa', prUrl: null, head: '688cc2e', stopReason: 'stopped by the console' }),
  // A review the console runs on a pull request (pullRequests.review.runner: woodshed), started as its author with
  // nobody assigned, and one that finished, which is never kept, so it shows as stopped with no Resume. The rail keeps
  // both in its folded Reviews and QA zone, with no Take it.
  session('7e7e7e7e', 145, 'Review: fix(session): tell the remote-control login where it stands', {
    trigger: 'review', prUrl: null, status: 'running', state: 'working', stoppedAt: null, stopReason: null, assignee: null,
    review: { base: 'main', sha: 'f00d145', heading: null, author: null, check: null, commentId: null },
  }),
  session('7f7f7f7f', 144, 'Review: feat(console): pin a session', {
    trigger: 'review', prUrl: null, stopReason: 'Review finished: APPROVE',
    review: { base: 'main', sha: 'f00d144', heading: null, author: null, check: null, commentId: null, conclusion: 'APPROVE', reported: true },
  }),
  // Three pull requests, oldest first: its card shows a merged or closed one only while no newer one came after it.
  // Polling is off, so none has a state here and all three show.
  session('cafe7777', 26330, 'Split the billing page into steps', {
    kind: 'task', number: null, status: 'running', state: 'done', stoppedAt: null, stopReason: null,
    prUrl: 'https://github.com/example-org/example-repo/pull/26333',
    prUrls: [26331, 26332, 26333].map((n) => `https://github.com/example-org/example-repo/pull/${n}`),
  }),
  // Woodshed's own review and QA at work on two of those pull requests: each chip says so, with the ring, where its
  // checks alone would show a tick.
  session('7d7d7d7d', 26332, 'Review: Split the billing page into steps', {
    trigger: 'review', prUrl: null, status: 'running', state: 'working', stoppedAt: null, stopReason: null, assignee: null,
    review: { base: 'main', sha: 'f00d332', heading: null, author: null, check: null, commentId: null },
  }),
  session('9c9c9c9c', 26333, 'QA: Split the billing page into steps', {
    trigger: 'qa', prUrl: null, status: 'running', state: 'working', stoppedAt: null, stopReason: null, assignee: null, head: 'f00d333', qa: {},
  }),
  session('cccc3333', 26327, 'A failed start', { status: 'failed', error: 'The container did not start.' }),
  // Running, for the top bar's buttons. With no container behind it the app's links and the terminal go nowhere.
  session('dddd4444', 26328, 'Keep background shell alive for cap', { status: 'running', stoppedAt: null, stopReason: null, app: 'stopped', appServers: { frontend: false, backend: false, frontendPort: 5173, backendPort: 8080 }, hasShell: true, editor: true,
    usage: { cpuPercent: 37.5, memoryBytes: 1.6 * GB, memoryLimitBytes: 8 * GB, memoryPeakBytes: 3.1 * GB, cores: 2, diskUsedBytes: 6.2 * GB, diskTotalBytes: 20 * GB } }),
  // Waiting for input for 50 minutes, so it pauses in 10 at the console's hour: the timer shows, and Extend for the one
  // the viewer (local) has. Only a shared session's assignee may extend it or change its hours.
  session('e7e7e7e7', 26340, 'Pause the importer when the queue drains', { status: 'running', state: 'done', stoppedAt: null, stopReason: null, app: 'stopped', hasShell: true,
    assignee: 'local', lastActiveAt: new Date(Date.parse(now) - 50 * 60_000).toISOString() }),
  session('e8e8e8e8', 26341, 'Retry the export on a timeout', { status: 'running', state: 'done', stoppedAt: null, stopReason: null, app: 'stopped', hasShell: true,
    assignee: 'ana-dev', lastActiveAt: new Date(Date.parse(now) - 50 * 60_000).toISOString() }),
  // Running on a project whose file has no app: Set up app in place of Start app.
  session('a0a0b1b1', 26329, 'A project with no app yet', { status: 'running', stoppedAt: null, stopReason: null, app: 'none', appServers: { frontend: false, backend: false, frontendPort: null, backendPort: null }, hasShell: true }),
  // The rail's names: one started and assigned to octocat, one handed to him, one someone else has, and a private
  // one. Mine needs a signed-in octocat, which a stub of the page's data call gives.
  session('abcd7777', 26627, 'Merge Shared and My Woodshed tabs', { status: 'running', state: 'done', stoppedAt: null, stopReason: null, assignee: 'octocat' }),
  session('bcde8888', 26590, 'Fix CSV upload for large files', { kind: 'issue', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null, startedBy: 'ana-dev', assignee: 'octocat' }),
  // On a second and a third project: the rail marks each in its colour, with a filter chip per project, when the
  // console has more than one, as with WOODSHED_PROJECTS='[{"name":"example-repo","repo":"example-org/example-repo","default":true},
  // {"name":"example-api","repo":"example-org/example-api"},{"name":"example-web","repo":"example-org/example-web"}]'.
  session('beef4242', 26631, 'Rate limit the public API', { project: 'example-api', repo: 'example-org/example-api', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat' }),
  session('beef4343', 26632, 'Show the plan picker on the pricing page', { project: 'example-web', repo: 'example-org/example-web', status: 'running', state: 'needs-you', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat' }),
  // Its project uses no Redis, so Open ▾ has only the databases.
  session('cdef9999', 26629, 'Retry Xero sync on a 429', { status: 'running', state: 'working', stoppedAt: null, stopReason: null, startedBy: 'priya-dev', assignee: 'priya-dev', redis: false,
    // Near its memory limit, for the badge's red and the machine dialog's: its disk from an image before it was reported.
    usage: { cpuPercent: 162, memoryBytes: 7.5 * GB, memoryLimitBytes: 8 * GB, memoryPeakBytes: 7.9 * GB, cores: 2, diskUsedBytes: null, diskTotalBytes: null } }),
  // A label the viewer added, on their own Claude plan, that nobody has: on Mine, since they started it, and Unassigned on
  // Everyone.
  session('a11e0001', 3, 'Add a ruler to the canvas', {
    kind: 'issue', trigger: 'label', startedBy: 'local', plan: 'local', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null,
  }),
  // One the viewer started and handed to someone else: still on Mine, since it runs on the viewer's plan.
  session('a11e0002', 4, 'Snap shapes to the grid', {
    kind: 'issue', trigger: 'label', startedBy: 'local', plan: 'local', assignee: 'ana-dev', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null,
  }),
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
  // A private session with everything the pane bar can hold: Invite (it has a PR), its plan, the machine, the editor and
  // Redis, for how the bar fits a long name. It has no shell, so Terminal opens App log.
  session('ba5eba11', null, 'Crowded pane bar with a long session name to see what gives way', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'working', stoppedAt: null, stopReason: null, editor: true,
    prUrl: 'https://github.com/example-org/example-repo/pull/26700',
    app: 'stopped', appServers: { frontend: false, backend: false, frontendPort: 5173, backendPort: 8080 },
    usage: { cpuPercent: 41, memoryBytes: 632 * 1024 * 1024, memoryLimitBytes: 8 * GB, memoryPeakBytes: 1.1 * GB, cores: 2, diskUsedBytes: 4 * GB, diskTotalBytes: 20 * GB },
    planUsage: planReading({ minutesAgo: 2, fiveHour: [12, 200], sevenDay: [68, 3 * 1440] }),
  }),
  // A private session whose Resume failed at start: Resume stays, and the reason is the entrypoint's ERROR. Owned by
  // `local`, the dev console's viewer, so its page opens.
  session('fa11ed01', null, 'Update EC2 Woodshed to latest master', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'failed', state: null, prUrl: null,
    error: '.woodshed/project.yaml: pullRequests.qa is missing author', startedAt: new Date(Date.parse(now) - 60_000).toISOString(),
  }),
  // Private Codex sessions, owned by `local`: their pages say codex, not claude, and offer no Remote Control.
  session('c0dec0de', null, 'Session names on Codex', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', options: { agent: 'codex' }, status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
  }),
  // A private session whose app's frontend is down, owned by `local`: the phone's ⋯ sheet offers Start app again, as
  // the top bar does. With no container behind it the start goes nowhere; a browser test stubs the call.
  session('f00dd00d', null, 'Phone start app again', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true, editor: true,
    app: 'frontend-down', appServers: { frontend: false, backend: true, frontendPort: 5173, backendPort: 8080 },
  }),
  // A project with two apps whose second one's frontend is down, for `woodshed session app`'s restart hint, which names
  // it with --app; and one whose app is still stopping, which a start is not taken during.
  session('add0a990', null, 'Admin app frontend down', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
    app: 'frontend-down', appName: 'admin', apps: [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }],
    appServers: { frontend: false, backend: true, frontendPort: 5173, backendPort: 8080 },
  }),
  session('0ff0a990', null, 'App still stopping', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
    app: 'stopping', appServers: { frontend: true, backend: true, frontendPort: 5173, backendPort: 8080 },
  }),
  // The same with its app up, for the sheet's Open app ↗. The app's name goes nowhere here.
  session('f00dd00e', null, 'Phone open app', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true, editor: true,
    app: 'running', appServers: { frontend: true, backend: true, frontendPort: 5173, backendPort: 8080 },
  }),
  // A private session that has seen production data (console/mcpRelay.mjs), owned by `local`: its card says Production in
  // place of Private, its pane bar Production data, and its pane offers no Share the app, Editor or Remote Control.
  // A private session that handed a piece of work to a new session of local's (console/sessionStarts.mjs): the new one's
  // hover card and Details say Started from, this one's Started here. It holds the start token above.
  session('5747ed01', null, 'Plan the billing page', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
    branch: 'woodshed/local-5747ed01', startTokenHash: crypto.createHash('sha256').update(devStartToken).digest('hex'),
  }),
  session('5747ed02', null, 'Move invoice totals to the server', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
    branch: 'woodshed/local-5747ed02', startedFrom: '5747ed01', lastMessage: { role: 'assistant', text: 'Moved the totals into InvoiceService and opened a draft PR.' },
  }),
  // Two more of 5747ed01's: one piece of its work asking its person, which the rail shows in 5747ed01's group and on
  // Needs you too, and one started on its own (`startedApart`, woodshed-session new --separate), at the top level.
  session('5747ed03', null, 'Invoice PDF export', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'needs-you', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
    branch: 'woodshed/local-5747ed03', startedFrom: '5747ed01',
    lastMessage: { role: 'assistant', text: 'Should I add pdfkit, or use the headless Chrome the app already has?' },
  }),
  session('5747ed04', null, 'Refund flow audit', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true,
    branch: 'woodshed/local-5747ed04', startedFrom: '5747ed01', startedApart: true,
  }),
  session('7a1e7ed1', null, 'Why order 42 shows as unpaid', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'working', stoppedAt: null, stopReason: null, prUrl: null, hasShell: true, editor: true,
    taintedAt: new Date(Date.now() - 12 * 60_000).toISOString(), taintNoticedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    app: 'running', appServers: { frontend: true, backend: true, frontendPort: 5173, backendPort: 8080 },
  }),
  // Paused when idle, so it waits in Mine's Needs you, with Move to Stopped in its ⋯ menu.
  session('ba5ed001', null, 'A private session paused when idle', { kind: 'task', trigger: 'my-woodshed', owner: 'local', stopReason: 'idle for 1 h', prUrl: null }),
  session('c0dec0d1', null, 'Stopped Codex session', { kind: 'task', trigger: 'my-woodshed', owner: 'local', options: { agent: 'codex' }, prUrl: null }),
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
  // Running, with its Review tab answered by the stand-in statusd above. Its terminal, Diff and app go nowhere.
  session(REVIEW_ID, 26701, 'Retry webhook deliveries with backoff', {
    status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat',
    endpoint: { host: '127.0.0.1', statusPort: review.port, termPort: review.port },
    ...(reviewPr ? {
      kind: 'task', trigger: 'my-woodshed', owner: 'local', assignee: null, prUrl: `https://github.com/${reviewPr.slug}/pull/${reviewPr.number}`,
      prUrls: [reviewPr.earlier.number, reviewPr.number].map((n) => `https://github.com/${reviewPr.slug}/pull/${n}`),
    } : {}),
  }),
  // Running on a project that declares two apps, with the real statusd behind it: Start app ▾ lists them.
  // Its checkout's three branches have a pull request each, which that statusd reports: three chips on its card.
  session(APPS_ID, 26702, 'A project with two apps', {
    status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat', hasShell: true,
    ref: twoApps.ref, endpoint: { host: '127.0.0.1', statusPort: twoApps.port, termPort: twoApps.port },
  }),
  // Running, with a live TUI and Terminal tab (devTerminalSession.mjs), where ttyd and tmux are on the PATH: for find,
  // copy, links and scrolling back on a real xterm, and the shell's websocket. Its Diff and app go nowhere.
  ...(liveTerminal ? [session(TERMINAL_ID, 26703, 'A session with a live terminal', {
    status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat',
    endpoint: { host: '127.0.0.1', statusPort: liveTerminal.port, termPort: liveTerminal.port, shellPort: liveTerminal.shellPort },
  })] : []),
  // Running on a stand-in codex and claude (devChatSession.mjs), for the Chat tab. The codex one's state is read from
  // its pane; the claude one keeps this one. Their TUI tab has no ttyd, and their Terminal, Diff and app go nowhere.
  ...(codexChat ? [session(CODEX_CHAT_ID, 26704, 'Back off webhook retries for longer', {
    status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat', options: { agent: 'codex' },
    ref: codexChat.ref, endpoint: { host: '127.0.0.1', statusPort: codexChat.port, termPort: codexChat.termPort ?? codexChat.port },
  })] : []),
  ...(claudeChat ? [session(CLAUDE_CHAT_ID, 26705, 'Why webhook deliveries fail after a deploy', {
    status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat',
    ref: claudeChat.ref, endpoint: { host: '127.0.0.1', statusPort: claudeChat.port, termPort: claudeChat.termPort ?? claudeChat.port },
  })] : []),
  ...(agentsChat ? [session(AGENTS_CHAT_ID, null, 'Several agents in one session', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null,
    options: { agent: 'codex' }, hasShell: false,
    ref: agentsChat.ref, endpoint: { host: '127.0.0.1', statusPort: agentsChat.port, termPort: agentsChat.termPort ?? agentsChat.port },
  })] : []),
  // A stand-in Grok Build and OpenCode, each read from its pane and its own record, as statusd reads the real ones.
  ...(grokChat ? [session(GROK_CHAT_ID, null, 'Back off webhook retries on Grok Build', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', options: { agent: 'grok' }, status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null,
    ref: grokChat.ref, endpoint: { host: '127.0.0.1', statusPort: grokChat.port, termPort: grokChat.termPort ?? grokChat.port },
  })] : []),
  ...(openCodeChat ? [session(OPENCODE_CHAT_ID, null, 'Back off webhook retries on OpenCode', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', options: { agent: 'opencode' }, status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null,
    ref: openCodeChat.ref, endpoint: { host: '127.0.0.1', statusPort: openCodeChat.port, termPort: openCodeChat.termPort ?? openCodeChat.port },
  })] : []),
  ...(newChat ? [session(NEW_CHAT_ID, null, 'A new session beside a running one', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, startedFrom: '5747ed01',
    ref: newChat.ref, endpoint: { host: '127.0.0.1', statusPort: newChat.port, termPort: newChat.termPort ?? newChat.port },
  })] : []),
  ...(realClaude ? [session(REAL_ID, null, 'Real claude on a clone of this checkout', {
    kind: 'task', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null, assignee: 'octocat', hasShell: false,
    ref: realClaude.ref, endpoint: { host: '127.0.0.1', statusPort: realClaude.port, termPort: realClaude.termPort },
  })] : []),
  ...(realCodex ? [session(REAL_CODEX_ID, null, 'Real codex on a clone of this checkout', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', options: { agent: 'codex' }, status: 'running', state: 'done', stoppedAt: null,
    stopReason: null, prUrl: null, hasShell: false, ref: realCodex.ref,
    endpoint: { host: '127.0.0.1', statusPort: realCodex.port, termPort: realCodex.termPort },
  })] : []),
  // Starting, for the start checklist in the provider's words: its container is up and booting. With no container
  // behind it the start timeout fails it after a while; restart this script to see it again.
  session('5a5a5a5a', 26700, 'A session starting', {
    status: 'starting', stoppedAt: null, stopReason: null, prUrl: null, startedAt: new Date(Date.now() - 6_000).toISOString(),
    startSteps: { machine: new Date(Date.now() - 2_000).toISOString() },
  }),
  // Its agent open 2 min ago, every step done, and no address from its launcher: Connecting to the session counts.
  session('7c7c7c7c', 26710, 'A session with claude open, not reached yet', {
    status: 'starting', stoppedAt: null, stopReason: null, prUrl: null, startedAt: new Date(Date.now() - 135_000).toISOString(),
    startSteps: Object.fromEntries([['container', 122], ['settings', 121], ['home', 121], ['branch', 121], ['databases', 121], ['env', 120], ['claude', 120]]
      .map(([step, secondsAgo]) => [step, new Date(Date.now() - secondsAgo * 1000).toISOString()])),
  }),
  // Waiting for room, with the steps its launcher says the wait is at (a launcher's `progress`, providers/README.md).
  // Its next try is an hour away, so the docker launcher never takes it, and nothing here changes the steps.
  session('6b6b6b6b', 26701, 'A session waiting for its machine', {
    status: 'queued', startedAt: null, stoppedAt: null, stopReason: null, prUrl: null,
    retryAt: new Date(Date.now() + 3_600_000).toISOString(), error: 'Capacity is unavailable: a machine is being set up',
    waitProgress: { steps: [
      { label: 'Creating a machine', state: 'done', note: null, at: new Date(Date.now() - 95_000).toISOString() },
      { label: 'Installing Docker', state: 'done', note: null, at: new Date(Date.now() - 70_000).toISOString() },
      { label: 'Building the session image', state: 'current', note: 'step 4 of 9', at: new Date(Date.now() - 22_000).toISOString() },
      { label: 'Starting the databases', state: 'pending', note: null, at: null },
    ] },
  }),
];
// Made-up MCP servers for Console settings' card (console/mcpServers.mjs): nothing answers at their addresses.
const mcpServers = [
  { name: 'docs', url: 'https://docs.example.com/mcp', production: false, shared: true, people: '*', repos: '*', auth: 'oidc', audience: 'docs', header: null, headerSavedAt: null, updatedBy: 'local', updatedAt: '2026-11-19T09:00:00.000Z' },
  { name: 'tracker', url: 'https://tracker.example.com/mcp', production: false, shared: false, people: ['local'], repos: '*', auth: 'header', audience: null, header: 'x-api-key', headerSavedAt: null, updatedBy: 'local', updatedAt: '2026-11-19T09:00:00.000Z' },
];
// DEV_CONSOLE_PEOPLE=1 gives the People page a list to show: made-up members with their switches every way, and two
// people asking to join. Without it the console starts its list from the sessions' owners, with nobody asking.
const people = process.env.DEV_CONSOLE_PEOPLE === '1' ? {
  members: {
    local: { addedBy: null, addedAt: '2026-10-01T09:00:00.000Z', how: 'first to sign in', admin: true, adminBy: 'local', adminAt: '2026-10-01T09:00:00.000Z', githubSessions: true, githubSessionsBy: 'local', githubSessionsAt: '2026-10-01T09:00:00.000Z', assignable: true, assignableBy: 'local', assignableAt: '2026-10-01T09:00:00.000Z' },
    octocat: { addedBy: null, addedAt: '2026-10-01T09:00:00.000Z', how: 'already using the console', githubSessions: true, githubSessionsBy: 'local', githubSessionsAt: '2026-10-02T09:00:00.000Z', assignable: true, assignableBy: 'local', assignableAt: '2026-10-02T09:00:00.000Z' },
    'mia-dev': { addedBy: 'local', addedAt: '2026-11-03T09:00:00.000Z', how: 'invited', githubSessions: true, githubSessionsBy: 'local', githubSessionsAt: '2026-11-03T09:00:00.000Z' },
    'sam-ops': { addedBy: 'local', addedAt: '2026-11-12T09:00:00.000Z', how: 'accepted' },
  },
  memberRequests: { 'lee-new': { askedAt: '2026-11-20T08:00:00.000Z' }, 'kim-design': { askedAt: '2026-11-18T15:30:00.000Z' } },
} : {};
// DEV_CONSOLE_EXEC_PORT=<port> adds a running My Woodshed session of @local's, 55aa55aa, for `woodshed tunnel`
// (console/execPipe.mjs): its statusd is a session container you started yourself, with its 7682 published on that
// port of loopback and its SESSION_TOKEN in the file DEV_CONSOLE_EXEC_TOKEN_FILE (cli/README.md, "Trying the tunnel").
const execPort = Number(process.env.DEV_CONSOLE_EXEC_PORT) || null;
if (execPort) {
  sessions.push(session('55aa55aa', null, 'A session your computer reaches', {
    kind: 'task', trigger: 'my-woodshed', owner: 'local', status: 'running', state: 'done', stoppedAt: null, stopReason: null, prUrl: null,
    token: fs.readFileSync(process.env.DEV_CONSOLE_EXEC_TOKEN_FILE, 'utf8').trim(),
    endpoint: { host: '127.0.0.1', statusPort: execPort, termPort: execPort },
  }));
}
fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ sessions, github: null, mcpServers, ...people }));

// The shell's own console settings, under either name (shared/envNames.mjs: a GitHub App, required sign-in, the ECS
// launcher), would turn this back into the real console, so none of them are passed on, but hosted mode's
// (console/README.md, "Hosted mode"), to try it with a stand-in broker and signed headers, and the console's name. In a
// session that also keeps out the session's own WOODSHED_PROJECT_FILES_DIR.
const HOSTED = ['GITHUB_BROKER_URL', 'GITHUB_BROKER_TOKEN_FILE', 'TRUSTED_IDENTITY_SECRET', 'CONSOLE_NAME'];
const hosted = Object.fromEntries(HOSTED.map((name) => [currentName(name), envValue(process.env, name)]).filter(([, value]) => value !== undefined));
const projects = envValue(process.env, 'PROJECTS');
const inherited = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !isSettingName(key))), ...hosted };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(String(free)));
    });
  });
}

// The console refuses a host name it does not know (shared/sameOrigin.mjs), and a session's app name,
// `<SESSION_ID>.<SESSION_APP_DOMAIN>`, is known only to the console in front of it. So a request comes in on `port`, and
// one for loopback or that name reaches the console on a port of its own as if for loopback: an Origin naming the host
// it came by names loopback too, and any other Origin is still refused. Any other name gets the console's own 421, which
// keeps a DNS-rebound page out (isKnownHost), `<SESSION_ID>.attacker.example` too.
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
function isSessionAppHost(host) {
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (LOOPBACK_NAMES.has(name)) return true;
  return Boolean(appDomain) && name === `${sessionId}.${appDomain}`;
}

function asLoopback(headers, consolePort) {
  const out = { ...headers, host: `127.0.0.1:${consolePort}` };
  let sameHost = false;
  try {
    sameHost = new URL(headers.origin).host === headers.host;
  } catch {
    // No Origin, or one that does not parse: passed on as it came.
  }
  if (sameHost) out.origin = `http://127.0.0.1:${consolePort}`;
  return out;
}

const MISDIRECTED = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function serveSessionApp(consolePort) {
  const front = http.createServer((req, res) => {
    if (!isSessionAppHost(req.headers.host)) {
      console.warn('dev console: unknown host refused', { host: String(req.headers.host).slice(0, 100) });
      res.writeHead(421, MISDIRECTED);
      return res.end(JSON.stringify({ error: 'unknown host' }));
    }
    const upstream = http.request({ host: '127.0.0.1', port: consolePort, method: req.method, path: req.url, headers: asLoopback(req.headers, consolePort) }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('the dev console is not up yet\n');
    });
    req.pipe(upstream);
  });
  front.on('upgrade', (req, socket, head) => {
    if (!isSessionAppHost(req.headers.host)) return socket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n');
    const upstream = net.connect(Number(consolePort), '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(asLoopback(req.headers, consolePort))) {
        for (const v of [value].flat()) lines.push(`${key}: ${v}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    front.once('error', reject).listen(Number(port), '127.0.0.1', () => {
      console.log('dev console: answering as the session\'s app too', { port, consolePort, appDomain: appDomain || null });
      resolve();
    });
  });
}

const consolePort = sessionApp ? await freePort() : port;

// The Woodshed card on Console settings follows a made-up clone, four commits behind its made-up upstream, never this
// checkout (devWoodshedClone.mjs). Update ends the console with code 75, and it is started again here, as install.sh's
// bin/woodshed does.
const devClone = makeDevClone(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-clone-')));
const RESTART_EXIT_CODE = 75;
// DEV_CONSOLE_REPO_SETTINGS=1 gives My settings' Repo settings what it needs to save: a local secret store, and two
// made-up repos whose project files this gh answers, the first the sessions' own.
const repoSettingsDev = process.env.DEV_CONSOLE_REPO_SETTINGS === '1' ? devRepoSettings(stateDir) : null;
// New session's Work on list reads made-up open pull requests from this gh (devGh.mjs).
// With a made-up reviewer App, the default branch's project file has no review yet, for `woodshed review` to turn on.
// DEV_CONSOLE_REVIEW_ON=1: example-org/example-repo's default branch runs its review in a session, and @local has three
// open pull requests there, for `woodshed review pulls|start` and `woodshed setup`'s reviews (with
// DEV_CONSOLE_REVIEWER=installed for the review's readiness). A review started on one fails at launch: no session
// image runs here.
// DEV_CONSOLE_REVIEW_ON=default: the same, with a project file that names no review, which the console reviews by its
// default (console/defaultReview.mjs).
const reviewOn = ['1', 'default'].includes(process.env.DEV_CONSOLE_REVIEW_ON);
// As `woodshed review enable` writes it (cli/projectReview.mjs).
const REVIEW_ON_FILE = enableReview(null, {}).text;
const devGhDir = writeDevGh(path.join(stateDir, 'dev-gh'), {
  projectFiles: {
    ...(reviewerDev ? { 'example-org/example-repo': 'version: 1\n' } : {}), ...repoSettingsDev?.projectFiles,
    ...(reviewOn ? { 'example-org/example-repo': process.env.DEV_CONSOLE_REVIEW_ON === 'default' ? 'version: 1\n' : REVIEW_ON_FILE } : {}),
  },
  mine: reviewOn ? { repo: 'example-org/example-repo', login: 'local' } : null,
});

// A local secret store, as the local provider keeps one.
function devSecrets(dir) {
  const secretsDir = path.join(dir, 'secrets');
  const keyFile = path.join(dir, 'secrets.key');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return { WOODSHED_LOCAL_SECRETS_DIR: secretsDir, WOODSHED_LOCAL_SECRETS_KEY_FILE: keyFile };
}

// The first repo's file also names the avatar menu's workflow links, over the installation's
// WOODSHED_ACTIONS_WORKFLOWS, which only a repo whose file names none would show.
function devRepoSettings(dir) {
  const file = (envPath) => `version: 1\nenvFiles:\n  - path: ${envPath}\n    defaults:\n      - LOG_LEVEL=info\n`;
  const links = 'workflowLinks:\n  - label: Deploy\n    workflow: .github/workflows/deploy.yml\n';
  return {
    env: {
      ...devSecrets(dir),
      WOODSHED_ACTIONS_WORKFLOWS: 'Run infrastructure=infra.yml',
      WOODSHED_PROJECTS: JSON.stringify([
        { name: 'example-repo', repo: 'example-org/example-repo', default: true },
        { name: 'example-tools', repo: 'example-org/example-tools' },
      ]),
    },
    projectFiles: { 'example-org/example-repo': file('api/.env') + links, 'example-org/example-tools': file('tools/.env') },
  };
}

// GH_TOKEN stands in for `gh auth token`, and polling is off, so nothing here calls GitHub: the open pull requests come
// from devGh.mjs's gh.
const webhookPort = process.env.DEV_CONSOLE_WEBHOOKS === '1' ? await freePort() : null;
// Made-up deliveries for the Webhook events page (console/webhookEvents.mjs), oldest first as the log is written: one
// of each thing the console does with a message. Nothing sent them.
if (webhookPort) {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const delivery = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
  const event = (minutesAgo, n, fields) => ({ receivedAt: at(minutesAgo), handledAt: at(minutesAgo), deliveryId: delivery(n), type: null, number: null, kind: null, login: null, detail: '', sessionId: null, reason: null, ...fields });
  const made = [
    event(190, 1, { type: 'label', number: 41, kind: 'issue', login: 'mia-dev', detail: 'woodshed', outcome: 'started', sessionId: 'aaaa1111' }),
    event(150, 2, { type: 'comment', number: 41, kind: 'issue', login: 'mia-dev', detail: '/woodshed also cover the empty state', outcome: 'sent', sessionId: 'aaaa1111' }),
    event(95, 3, { type: 'label', number: 41, kind: 'issue', login: 'mia-dev', detail: 'woodshed', outcome: 'duplicate', reason: 'the poll already started this one' }),
    event(60, 4, { type: 'pr', number: 57, kind: 'pr', login: 'sam-ops', detail: 'review submitted', outcome: 'refreshed', reason: 'the chip and the Slack post' }),
    event(32, 5, { type: 'comment', number: 63, kind: 'pr', login: 'drive-by', detail: '/woodshed fix the flaky test', outcome: 'ignored', reason: 'drive-by has no write access to the repo' }),
    event(14, 6, { type: 'mention', login: 'slack:U0MADEUP01', detail: 'how do sessions get their databases?', outcome: 'ignored', reason: 'Slack questions are switched off on Console settings' }),
    event(3, 7, { type: 'comment', number: 41, kind: 'issue', login: 'mia-dev', detail: '/woodshed pick this up again', outcome: 'failed', reason: 'the session could not be resumed: its Claude home was not saved' }),
  ];
  fs.writeFileSync(path.join(stateDir, 'webhookEvents.jsonl'), made.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
}
let child = null;
function startConsole() {
  child = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: {
      ...inherited, PATH: [devGhDir, realCodex?.binDir, realClaude?.binDir, agentsChat?.binDir, newChat?.binDir, openCodeChat?.binDir, grokChat?.binDir, claudeChat?.binDir, codexChat?.binDir, twoApps.binDir, basePath].filter(Boolean).join(path.delimiter), WOODSHED_HOST: '127.0.0.1', WOODSHED_PORT: consolePort, WOODSHED_STATE_DIR: stateDir,
      WOODSHED_POLL_GITHUB: '0', GH_TOKEN: 'dev',
      // DEV_CONSOLE_APP_PORTS (such as 7701-7703) puts session apps on ports of localhost instead, as a console reached
      // through Tailscale's serve has them (appPorts.mjs).
      ...(process.env.DEV_CONSOLE_APP_PORTS ? { WOODSHED_APP_PORTS: process.env.DEV_CONSOLE_APP_PORTS } : { WOODSHED_APP_DOMAIN: 'apps.localhost' }),
      WOODSHED_CHECKOUT: devClone, WOODSHED_SUPERVISED: '1',
      // Nobody signs in here, which on its own would make it a one-person console with one list of sessions: the made-up
      // team's Mine and Everyone show unless DEV_CONSOLE_ONE_PERSON=1 asks for that one list (server.mjs, onePersonConsole).
      WOODSHED_ONE_PERSON: process.env.DEV_CONSOLE_ONE_PERSON === '1' ? '1' : '0',
      // Its own links name the port people open, not the one behind it.
      ...(sessionApp ? { WOODSHED_PUBLIC_URL: `http://localhost:${port}` } : {}),
      // The sessions' made-up repo, or the projects this shell names. DEV_CONSOLE_NO_REPO=1 starts it with none, as a new
      // installation that adds its repos on the Console settings page does.
      ...(process.env.DEV_CONSOLE_NO_REPO === '1' ? {}
        : projects ? { WOODSHED_PROJECTS: projects } : { WOODSHED_REPO: 'example-org/example-repo' }),
      ...repoSettingsDev?.env,
      // DEV_CONSOLE_HOMES_DIR keeps saved Claude homes in that folder (providers/local/homeStore.mjs), as the console's
      // own at `_sessions/<id>/claude-home.tar.gz`, for Console settings' Sessions holding data.
      ...(process.env.DEV_CONSOLE_HOMES_DIR ? { WOODSHED_LOCAL_HOMES_DIR: process.env.DEV_CONSOLE_HOMES_DIR } : {}),
      // DEV_CONSOLE_SESSION_IMAGE starts New session's sessions from that session image, with the variables in the JSON
      // file DEV_CONSOLE_SESSION_ENV_FILE on top (such as GIT_CONFIG_* pointing the made-up repo's clone at a local
      // one), for a start in the real image: cli/README.md, "Trying session herdr". DEV_CONSOLE_SESSION_API_PORT puts
      // the session API on that port of loopback in place of 7691, which that file's WOODSHED_CONSOLE_URL then names.
      ...(process.env.DEV_CONSOLE_SESSION_IMAGE ? { WOODSHED_IMAGE: process.env.DEV_CONSOLE_SESSION_IMAGE } : {}),
      ...(process.env.DEV_CONSOLE_SESSION_ENV_FILE ? { WOODSHED_SESSION_ENV_FILE: process.env.DEV_CONSOLE_SESSION_ENV_FILE } : {}),
      ...(process.env.DEV_CONSOLE_SESSION_API_PORT ? { WOODSHED_SESSION_API_HOST: '127.0.0.1', WOODSHED_SESSION_API_PORT: process.env.DEV_CONSOLE_SESSION_API_PORT } : {}),
      ...tlsAskPort,
      // DEV_CONSOLE_WEBHOOKS=1 names a webhook receiver, so Console settings shows its GitHub webhooks switch.
      // Polling is off here, so the receiver never listens and nothing arrives.
      ...(webhookPort ? { WOODSHED_LOCAL_WEBHOOK_PORT: String(webhookPort), ...(repoSettingsDev ? {} : devSecrets(path.join(stateDir, 'webhook-secrets'))) } : {}),
    },
  });
  child.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE || restarting) {
      console.log(restarting ? 'dev console: the console stopped, starting it again on the same state' : 'dev console: the console asked to be started again');
      restarting = false;
      startConsole();
      return;
    }
    review.close();
    twoApps.close();
    liveTerminal?.close();
    codexChat?.close();
    claudeChat?.close();
    grokChat?.close();
    openCodeChat?.close();
    newChat?.close();
    agentsChat?.close();
    realClaude?.close();
    realCodex?.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(devClone), { recursive: true, force: true });
    process.exit(code ?? 0);
  });
}
// SIGHUP stops the console as a redeploy does (SIGTERM) and starts it again on the same state, for what must outlive a
// console restart: terminals, tunnels, `woodshed tunnel`.
let restarting = false;
process.on('SIGHUP', () => {
  restarting = true;
  child.kill('SIGTERM');
});
startConsole();
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

function answersOn(onPort) {
  return new Promise((resolve) => {
    const probe = net.connect(Number(onPort), '127.0.0.1', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

// The port people open answers only once the console behind it does, so devConsoleApp.sh's start never returns into a 502.
if (sessionApp) {
  while (!(await answersOn(consolePort))) await new Promise((resolve) => setTimeout(resolve, 100));
  await serveSessionApp(consolePort);
}
