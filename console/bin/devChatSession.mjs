// A made-up running session for the dev console's Chat tab, served by the real statusd (session/statusd.mjs) over a
// tmux server of its own, whose `claude` pane runs a stand-in agent (devChatAgent.mjs) that writes the agent's real
// record of the conversation: codex's rollout, or claude's transcript. So the Chat tab's whole path is the session's own:
// the thread from GET /transcript, Send typed into the pane by POST /send, Stop's Esc by POST /interrupt.
// A codex session's state is read from its pane, as statusd reads codex's (Working, Needs you, Done), so `docker`
// says its container runs and the console reads its status. A claude session's state comes from claude's hooks, through
// a file every session on the machine shares (/tmp/woodshed-claude-state.json), so it gets no `docker` and keeps the
// state the dev console gives it. Only where tmux is on the PATH (a Woodshed session has it); elsewhere it returns null.
//
// With `real`, the pane runs the real `claude` instead, on whatever Claude credential this machine's claude has (in a
// Woodshed session, its owner's own), in a clone of this checkout with no remote, so nothing it does reaches GitHub or
// this branch. Its hooks write to a state file of its own (WOODSHED_CLAUDE_STATE_FILE, session/hookState.mjs), so its
// state is claude's own and the console reads it as for a real session; and ttyd serves its pane, for the Agent tab.
// It answers claude's folder-trust question itself, once.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUSD = path.join(HERE, '..', '..', 'session', 'statusd.mjs');
const AGENT = path.join(HERE, 'devChatAgent.mjs');
const WOODSHED = path.join(HERE, '..', '..');
const HOOKS = path.join(WOODSHED, 'session', 'claudeHooks.json');
const HOOK_STATE = path.join(WOODSHED, 'session', 'hookState.mjs');
const THEME = 'theme={"background":"#14171d","foreground":"#d6d3cd","cursor":"#E87D09","cursorAccent":"#14171d","selectionBackground":"#2c2013"}';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AUTHOR = ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev Console', '-c', 'commit.gpgsign=false'];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const onPath = (bin) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// claude's hooks, as a session gives them (claudeHooks.json), pointed at this checkout's hookState.mjs, which knows
// WOODSHED_CLAUDE_STATE_FILE. The other hooks and rules are a session's own business.
function realHooks(file) {
  const hooks = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
  const own = Object.fromEntries(Object.entries(hooks).map(([event, list]) => [event, list
    .map((entry) => ({ ...entry, hooks: entry.hooks.filter((x) => x.command.endsWith('/hookState.mjs')).map((x) => ({ ...x, command: `node ${HOOK_STATE}` })) }))
    .filter((entry) => entry.hooks.length)]));
  fs.writeFileSync(file, JSON.stringify({ hooks: own }));
}

// claude asks whether to trust a folder it has not opened before. Its first option is `No, exit` (Claude Code 2.x), so
// the answer is the option that says yes, picked by name: one step down to it, then Enter.
async function trustOnce(tmux) {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    let pane = '';
    try {
      pane = execFileSync('tmux', ['capture-pane', '-p', '-t', 'claude'], { env: tmux, encoding: 'utf8' });
    } catch {
      continue;
    }
    const options = pane.split('\n').filter((line) => /^\s*(❯\s*)?(\d\.\s*)?(No, exit|Yes, I trust this folder|Yes, proceed)/.test(line));
    const yes = options.findIndex((line) => /Yes/.test(line));
    const at = options.findIndex((line) => line.includes('❯'));
    if (yes !== -1 && at !== -1) {
      for (let step = at; step < yes; step++) execFileSync('tmux', ['send-keys', '-t', 'claude', 'Down'], { env: tmux });
      await sleep(200);
      execFileSync('tmux', ['send-keys', '-t', 'claude', 'Enter'], { env: tmux });
      console.log('dev console: real claude trusted its folder');
      return;
    }
    if (/\? for shortcuts|bypass permissions|auto mode/i.test(pane)) return;
  }
}

/**
 * @param {{id: string, token: string, agent: 'codex'|'claude', nextPath: string, real?: boolean, terminalToken?: string}} opts
 *   nextPath: the PATH a `docker` call for any other container goes on with. real: the real claude, with ttyd on
 *   terminalToken
 * @returns {Promise<{port: number, termPort: number|null, ref: string|null, binDir: string|null, close: () => void}|null>}
 */
export async function startDevChatSession({ id, token, agent, nextPath, real = false, terminalToken = '' }) {
  if (!onPath('tmux') || (real && (!onPath('claude') || !onPath('ttyd')))) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `woodshed-dev-chat-${real ? 'real-' : ''}${agent}-`));
  const home = real ? os.homedir() : path.join(root, 'home');
  const repo = path.join(root, 'repo');
  if (!real) fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', ['-C', repo, ...AUTHOR, ...args], { stdio: 'ignore' });
  if (real) {
    // This checkout as it is committed, on a branch of its own, with no remote to push to.
    execFileSync('git', ['clone', '-q', '--no-hardlinks', WOODSHED, repo], { stdio: 'ignore' });
    git('checkout', '-q', '-B', `woodshed/${id}`);
    git('remote', 'remove', 'origin');
  } else {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'A made-up checkout for the dev console\'s chat.\n');
    git('init', '-q', '-b', `woodshed/${id}`);
    git('add', '-A');
    git('commit', '-q', '-m', 'chat');
  }
  const codexHome = path.join(home, '.codex');
  const recordDir = agent === 'codex' ? codexHome : path.join(home, '.claude', 'projects', repo.replace(/[/.]/g, '-'));
  const stateFile = path.join(root, 'claude-state.json');
  // A tmux server of its own (TMUX_TMPDIR), so it never meets the session's own claude.
  const tmuxEnv = { ...process.env, TMUX: '', TMUX_TMPDIR: root, HOME: home, ...(real && { WOODSHED_CLAUDE_STATE_FILE: stateFile }) };
  let paneCommand = `${process.execPath} ${AGENT} ${agent} ${recordDir} ${repo}`;
  if (real) {
    const settings = path.join(root, 'hooks.json');
    realHooks(settings);
    paneCommand = `claude --settings ${settings} --permission-mode auto`;
  }
  execFileSync('tmux', ['new-session', '-d', '-s', 'claude', '-x', '120', '-y', '30', '-c', repo, paneCommand], { env: tmuxEnv });
  if (real) await trustOnce(tmuxEnv);
  let ttyd = null;
  let termPort = null;
  if (real) {
    termPort = await freePort();
    ttyd = spawn('ttyd', ['--writable', '--interface', '127.0.0.1', '--port', String(termPort), '--base-path', `/term/${id}`,
      '--credential', `woodshed:${terminalToken}`, '-t', THEME, '-t', 'scrollback=10000', '-t', 'disableLeaveAlert=true',
      'tmux', 'attach', '-t', 'claude'], { stdio: 'ignore', env: tmuxEnv });
  }
  const port = await freePort();
  const child = spawn(process.execPath, [STATUSD], {
    env: {
      ...tmuxEnv, SESSION_TOKEN: token, SESSION_ID: id, STATUSD_PORT: String(port), REPO_DIR: repo, CODEX_HOME: codexHome,
      AGENT: agent === 'codex' ? 'codex' : '', APP_PORT: '', APP_API_PORT: '', WOODSHED_CONSOLE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // What it was sent and its state: the rest is warnings of what a made-up session lacks (gh, a branch on GitHub).
  const relay = (chunk) => { if (/statusd: (text sent|agent interrupted|answer typed|answer refused|claude state changed)/.test(String(chunk))) process.stdout.write(`dev chat session ${id}: ${chunk}`); };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  await new Promise((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); }));
  let binDir = null;
  let ref = null;
  if (agent === 'codex' || real) {
    ref = `woodshed-${id}`;
    binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'docker'), `#!/bin/sh
if [ "$1" = inspect ] && [ "$4" = ${ref} ]; then echo true; exit 0; fi
PATH='${nextPath}' exec docker "$@"
`, { mode: 0o755 });
  }
  console.log('dev console: chat session ready', { id, agent, real, port });
  return {
    port, termPort, ref, binDir,
    close() {
      child.kill();
      ttyd?.kill();
      try {
        execFileSync('tmux', ['kill-server'], { env: tmuxEnv, stdio: 'ignore' });
      } catch {
        // Gone already.
      }
      fs.rmSync(root, { recursive: true, force: true });
      // The real claude's transcripts are in the machine's own Claude home, under the clone's name.
      if (real) fs.rmSync(recordDir, { recursive: true, force: true });
    },
  };
}
