// A made-up running session for the dev console's Chat tab, served by the real statusd (session/statusd.mjs) over a
// tmux server of its own, whose `claude` pane runs a stand-in agent (devChatAgent.mjs) that writes the agent's real
// record of the conversation: codex's rollout, or claude's transcript. So the Chat tab's whole path is the session's own:
// the thread from GET /transcript, Send typed into the pane by POST /send, Stop's Esc by POST /interrupt.
// A codex session's state is read from its pane, as statusd reads codex's (Working, Needs you, Done), so `docker`
// says its container runs and the console reads its status. A claude session gets no `docker` and keeps the state the
// dev console gives it; its statusd has a hook state file of its own (WOODSHED_CLAUDE_STATE_FILE), never the machine's,
// which the session's own claude writes, so its sends go by its own screen, which the stand-in draws as claude does. Only where tmux is on the PATH (a Woodshed session has it); elsewhere it returns null.
//
// With `real`, the pane runs the real `claude` instead, on whatever Claude credential this machine's claude has (in a
// Woodshed session, its owner's own), in a clone of this checkout with no remote, so nothing it does reaches GitHub or
// this branch. Its hooks write to a state file of its own (WOODSHED_CLAUDE_STATE_FILE, session/hookState.mjs), so its
// state is claude's own and the console reads it as for a real session; and ttyd serves its pane, for the TUI tab.
// It answers claude's folder-trust question itself, once.
//
// With `real` and the codex agent, the pane runs the real `codex` with the flags a session gives it in auto mode
// (codexFlags in session/entrypoint.sh), on this machine's Codex sign-in (~/.codex/auth.json, from `codex login`):
// a CODEX_HOME of its own holds a copy, with the clone trusted as a session's checkout is, and the copy goes back at
// close, since OpenAI rotates a ChatGPT login's refresh token at each use. Codex writes no hooks: its state is the
// pane's, as in a session.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { statusdReady } from './devStatusd.mjs';

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
 *   nextPath: the PATH a `docker` call for any other container goes on with. real: the real agent, with ttyd on
 *   terminalToken
 * @returns {Promise<{port: number, termPort: number|null, ref: string|null, binDir: string|null, close: () => void}|null>}
 */
function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The login lent to the dev session's codex, given back to the machine at its close, but only when the copy is the
 * newer one: codex refreshed it (its copy changed) and the machine's is still the one it was lent (nobody signed in
 * again, no codex of the machine's refreshed it, since). Otherwise the machine's stays as it is.
 * @param {{host: string, lent: string, startedAs: string}} files  startedAs: the hash both were at the start
 * @returns {'copied back'|'unchanged'|'kept the newer one on the machine'}
 */
export function returnLogin({ host, lent, startedAs }) {
  if (fileHash(lent) === startedAs) return 'unchanged';
  if (fileHash(host) !== startedAs) return 'kept the newer one on the machine';
  fs.copyFileSync(lent, host);
  return 'copied back';
}

// An earlier session's conversation on the repo, as a Claude home restored from the owner's brings it: last written
// before this session started, another session's that may still be running.
const EARLIER = [
  { type: 'user', message: { role: 'user', content: 'Why do webhook deliveries fail after a deploy?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The receiver restarts mid-delivery: an earlier session\'s answer, which the new one must not show.' }] } },
];
function restoreEarlierHome(recordDir, restoredFile) {
  fs.mkdirSync(recordDir, { recursive: true });
  const file = path.join(recordDir, `${crypto.randomUUID()}.jsonl`);
  const at = new Date(Date.now() - 10 * 60_000);
  fs.writeFileSync(file, EARLIER.map((r) => JSON.stringify({ ...r, timestamp: at.toISOString(), uuid: crypto.randomUUID() })).join('\n') + '\n');
  fs.utimesSync(file, at, at);
  // What restoreHome in session/entrypoint.sh writes before it unpacks the home.
  fs.writeFileSync(restoredFile, `${Date.now() - 60_000}\n`);
}

/**
 * restoredHome: the session starts from a Claude home holding an earlier session's conversation (restoreEarlierHome),
 * as a private session started while another runs does, and its stand-in writes nothing until it is sent a message;
 * claudeAuth: WOODSHED_CLAUDE_AUTH for its statusd, which says whether a plan or a key pays for its tokens
 */
export async function startDevChatSession({ id, token, agent, nextPath, real = false, terminalToken = '', restoredHome = false, claudeAuth = '' }) {
  if (!onPath('tmux') || (real && (!onPath(agent) || !onPath('ttyd')))) return null;
  const ownCodexAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (real && agent === 'codex' && !fs.existsSync(ownCodexAuth)) {
    console.warn('dev console: no real codex, this machine has no Codex sign-in (run codex login)');
    return null;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `woodshed-dev-chat-${real ? 'real-' : ''}${agent}-`));
  const realCodex = real && agent === 'codex';
  let lentLogin = null;
  const home = real && !realCodex ? os.homedir() : path.join(root, 'home');
  const repo = path.join(root, 'repo');
  if (!real || realCodex) fs.mkdirSync(home);
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
  if (realCodex) {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    // The bytes lent, read once: hashed as they were copied, so a refresh of the machine's login meanwhile is not taken
    // for the one lent, and kept over the lent copy at close.
    const lent = fs.readFileSync(ownCodexAuth);
    fs.writeFileSync(path.join(codexHome, 'auth.json'), lent, { mode: 0o600 });
    lentLogin = { at: crypto.createHash('sha256').update(lent).digest('hex') };
    fs.chmodSync(path.join(codexHome, 'auth.json'), 0o600);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `[projects."${repo}"]\ntrust_level = "trusted"\n`);
  }
  const stateFile = path.join(root, 'claude-state.json');
  const restoredFile = path.join(root, 'home-restored-from');
  if (restoredHome && agent === 'claude' && !real) restoreEarlierHome(recordDir, restoredFile);
  // A tmux server of its own (TMUX_TMPDIR), so it never meets the session's own claude.
  const tmuxEnv = { ...process.env, TMUX: '', TMUX_TMPDIR: root, HOME: home, WOODSHED_CLAUDE_STATE_FILE: stateFile, WOODSHED_HOME_RESTORED_FILE: restoredFile,
    ...(restoredHome && { DEV_CHAT_AGENT_FRESH: '1' }),
    ...(realCodex && { CODEX_HOME: codexHome }) };
  let paneCommand = `${process.execPath} ${AGENT} ${agent} ${recordDir} ${repo}`;
  if (realCodex) {
    // A session's flags for its permission mode (codexFlags in session/entrypoint.sh): auto, or, with
    // DEV_CONSOLE_REAL_CODEX_MODE=plan, a read-only sandbox, where codex asks before it writes: the Chat tab's approvals.
    const sandbox = process.env.DEV_CONSOLE_REAL_CODEX_MODE === 'plan' ? 'read-only' : 'danger-full-access';
    paneCommand = `codex --sandbox ${sandbox} --ask-for-approval on-request`;
  } else if (real) {
    const settings = path.join(root, 'hooks.json');
    realHooks(settings);
    // A session's permission mode (claudeFlags in session/entrypoint.sh): auto, or, with
    // DEV_CONSOLE_REAL_CLAUDE_MODE=default, the mode New session's "default" gives, where claude asks before it runs a
    // command or edits a file: the Chat tab's approvals. A session leaves the flag out for default, since its own
    // settings name no other; here it is named, so this machine's own defaultMode cannot turn the dialog off.
    const mode = process.env.DEV_CONSOLE_REAL_CLAUDE_MODE === 'default' ? 'default' : 'auto';
    paneCommand = `claude --settings ${settings} --permission-mode ${mode}`;
  }
  execFileSync('tmux', ['new-session', '-d', '-s', 'claude', '-x', '120', '-y', '30', '-c', repo, paneCommand], { env: tmuxEnv });
  if (real && !realCodex) await trustOnce(tmuxEnv);
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
      ...tmuxEnv, SESSION_TOKEN: token, SESSION_ID: id, STATUSD_PORT: String(port), STATUSD_HOST: '127.0.0.1', REPO_DIR: repo, CODEX_HOME: codexHome,
      AGENT: agent === 'codex' ? 'codex' : '', APP_PORT: '', APP_API_PORT: '', WOODSHED_CONSOLE_URL: '',
      // How claude pays, as the entrypoint's chooseClaudeAuth says it: `own` for a private session on its owner's plan.
      WOODSHED_CLAUDE_AUTH: claudeAuth,
      // An ordinary session's, whatever kind of session the dev console itself runs in (a QA one's would never say done).
      SESSION_MODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // What it was sent and its state: the rest is warnings of what a made-up session lacks (gh, a branch on GitHub).
  const relay = (chunk) => { if (/statusd: (text sent|text not sent|message held|held message|agent interrupted|answer typed|answer refused|claude state changed)/.test(String(chunk))) process.stdout.write(`dev chat session ${id}: ${chunk}`); };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  let binDir = null;
  let ref = null;
  {
    ref = `woodshed-${id}`;
    binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'docker'), `#!/bin/sh
if [ "$1" = inspect ] && [ "$4" = ${ref} ]; then echo true; exit 0; fi
PATH='${nextPath}' exec docker "$@"
`, { mode: 0o755 });
  }
  const session = {
    port, termPort, ref, binDir,
    close() {
      child.kill();
      ttyd?.kill();
      try {
        execFileSync('tmux', ['kill-server'], { env: tmuxEnv, stdio: 'ignore' });
      } catch {
        // Gone already.
      }
      // codex may have refreshed the login it was lent: the machine keeps the newer one (returnLogin).
      if (realCodex) {
        try {
          const outcome = returnLogin({ host: ownCodexAuth, lent: path.join(codexHome, 'auth.json'), startedAs: lentLogin.at });
          console.log('dev console: the real codex\'s login', { outcome });
        } catch (err) {
          console.warn('dev console: the real codex\'s login not copied back', { message: err.message });
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      // The real claude's transcripts are in the machine's own Claude home, under the clone's name.
      if (real && !realCodex) fs.rmSync(recordDir, { recursive: true, force: true });
    },
  };
  // A statusd that did not start leaves nothing behind it: the dev console goes on without this session.
  try {
    await statusdReady(child);
  } catch (err) {
    console.warn('dev console: chat session not started', { id, agent, real, message: err.message });
    session.close();
    return null;
  }
  console.log('dev console: chat session ready', { id, agent, real, port });
  return session;
}
