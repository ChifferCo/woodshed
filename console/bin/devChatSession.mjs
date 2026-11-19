// A made-up running session for the dev console's Chat tab, served by the real statusd (session/statusd.mjs) over a
// tmux server of its own, whose `claude` pane runs a stand-in agent (devChatAgent.mjs) that writes the agent's real
// record of the conversation: codex's rollout, or claude's transcript. So the Chat tab's whole path is the session's own:
// the thread from GET /transcript, Send typed into the pane by POST /send, Stop's Esc by POST /interrupt.
// A codex session's state is read from its pane, as statusd reads codex's (Working, Needs you, Done), so `docker`
// says its container runs and the console reads its status. A claude session's state comes from claude's hooks, through
// a file every session on the machine shares (/tmp/woodshed-claude-state.json), so it gets no `docker` and keeps the
// state the dev console gives it. Only where tmux is on the PATH (a Woodshed session has it); elsewhere it returns null.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUSD = path.join(HERE, '..', '..', 'session', 'statusd.mjs');
const AGENT = path.join(HERE, 'devChatAgent.mjs');
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

/**
 * @param {{id: string, token: string, agent: 'codex'|'claude', nextPath: string}} opts
 *   nextPath: the PATH a `docker` call for any other container goes on with
 * @returns {Promise<{port: number, ref: string|null, binDir: string|null, close: () => void}|null>}
 */
export async function startDevChatSession({ id, token, agent, nextPath }) {
  if (!onPath('tmux')) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `woodshed-dev-chat-${agent}-`));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'A made-up checkout for the dev console\'s chat.\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...AUTHOR, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', `woodshed/${id}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chat');
  const codexHome = path.join(home, '.codex');
  const recordDir = agent === 'codex' ? codexHome : path.join(home, '.claude', 'projects', repo.replace(/[/.]/g, '-'));
  // A tmux server of its own (TMUX_TMPDIR), so it never meets the session's own claude.
  const tmuxEnv = { ...process.env, TMUX: '', TMUX_TMPDIR: root, HOME: home };
  execFileSync('tmux', ['new-session', '-d', '-s', 'claude', '-x', '120', '-y', '30', '-c', repo,
    `${process.execPath} ${AGENT} ${agent} ${recordDir} ${repo}`], { env: tmuxEnv });
  const port = await freePort();
  const child = spawn(process.execPath, [STATUSD], {
    env: {
      ...tmuxEnv, SESSION_TOKEN: token, SESSION_ID: id, STATUSD_PORT: String(port), REPO_DIR: repo, CODEX_HOME: codexHome,
      AGENT: agent === 'codex' ? 'codex' : '', APP_PORT: '', APP_API_PORT: '', WOODSHED_CONSOLE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // What it was sent and its state: the rest is warnings of what a made-up session lacks (gh, a branch on GitHub).
  const relay = (chunk) => { if (/statusd: (text sent|agent interrupted|claude state changed)/.test(String(chunk))) process.stdout.write(`dev chat session ${id}: ${chunk}`); };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  await new Promise((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); }));
  let binDir = null;
  let ref = null;
  if (agent === 'codex') {
    ref = `woodshed-${id}`;
    binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'docker'), `#!/bin/sh
if [ "$1" = inspect ] && [ "$4" = ${ref} ]; then echo true; exit 0; fi
PATH='${nextPath}' exec docker "$@"
`, { mode: 0o755 });
  }
  console.log('dev console: chat session ready', { id, agent, port });
  return {
    port, ref, binDir,
    close() {
      child.kill();
      try {
        execFileSync('tmux', ['kill-server'], { env: tmuxEnv, stdio: 'ignore' });
      } catch {
        // Gone already.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
