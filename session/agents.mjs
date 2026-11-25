// The agents a person starts beside a session's own (statusd's /agents): another claude or codex, with the model,
// effort and permission mode they pick, in the same checkout, each in a terminal of its own (`agent-2`, `agent-3`, ...)
// next to the session's `claude`: a tmux session, or where the session's agent runs in Herdr (its owner's Agent
// terminal, agentPane.mjs), a Herdr terminal on the session's own core, which the owner's Herdr shows beside it. The page's Chat and TUI tabs switch between them: Chat reads each one's own record
// of its conversation and types into its own pane, as statusd does for the session's agent, and the TUI tab attaches to
// its terminal (session/bin/woodshed-attach, through ttyd's URL argument).
//
// Each one is told apart from the session's agent, and from the others, by what it writes:
//   claude  its own hook state file (WOODSHED_CLAUDE_STATE_FILE, hookState.mjs), and the transcript its hooks name, or
//           the one its --session-id names until a hook has fired
//   codex   the rollout its process holds open (/proc/<pid>/fd), since every codex in the session files its rollouts in
//           the one $CODEX_HOME
// The session's own agent never reads theirs as its own: statusd skips every record one of these claimed (claimed()).
//
// Only in a private coding session, never once the session is tainted: they are not reopened on the console's proxy as
// the session's own claude is (taint.mjs), so the lockdown stops them all (stopAll) and refuses new ones. They last
// while the session runs: a Resume starts the session's own agent alone.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { hcPane, tmuxPane } from './agentPane.mjs';
import { claudeState, codexState, herdrState, lastInterruptAt, openToolCalls, paneState, withHerdr } from './agentState.mjs';
import { Refusal, answerApproval, answerQuestions, composerEmpty, composerText, readPrompt, typeMessage, typingSteps } from './panePrompt.mjs';
import { createPaneLock } from './paneLock.mjs';
import { readSessionTranscript } from './sessionTranscript.mjs';

// Beside the session's own: four agents at most in one container, each a whole claude or codex.
export const MAX_EXTRA_AGENTS = 3;
export const AGENTS = Object.freeze(['claude', 'codex']);
// What New session offers (console/sessions.mjs sessionOptions checks a start against the same), and what goes into a
// shell line: a model or an effort is a name, never anything a shell reads.
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PERMISSION_MODES = { claude: ['auto', 'acceptEdits', 'plan', 'default'], codex: ['auto', 'plan', 'default'] };
export const MAX_PROMPT_CHARS = 8000;
// The ids, as tmux names their sessions and the TUI tab's URL names them (woodshed-attach checks the same).
export const AGENT_ID_RE = /^agent-[2-9]$/;
const TAIL_BYTES = 64 * 1024;
// How often a message held while its agent was busy is tried again, and how often a codex's rollout is looked for.
const DELIVER_EVERY_MS = 2000;
const ROLLOUT_LOOK_MS = 5000;
// When nothing says the agent took a message (no hook fired, a turn too short to be seen), the next goes this long after.
const TAKEN_MS = 20_000;
// The ids each list keeps, for the page to settle its bubbles by (chatThread.cjs reconcile).
const KEEP_IDS = 20;

/**
 * What a start asks for, checked: the agent, its model, effort and permission mode, and the first message.
 * @returns {{agent: 'claude'|'codex', model: string, effort: string, permissionMode: string, prompt: string}}
 * @throws {Error & {status: 400}}
 */
export function startOptions(body) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  const agent = body?.agent ?? 'claude';
  if (!AGENTS.includes(agent)) throw bad('agent must be claude or codex');
  const name = (value, what) => {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || !NAME_RE.test(value)) throw bad(`${what} is not one a session takes`);
    return value;
  };
  const permissionMode = body?.permissionMode || 'auto';
  if (!PERMISSION_MODES[agent].includes(permissionMode)) throw bad(`${agent} has no permission mode ${String(permissionMode).slice(0, 40)}`);
  const prompt = body?.prompt ?? '';
  if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) throw bad(`the first message must be text of at most ${MAX_PROMPT_CHARS} characters`);
  return { agent, model: name(body?.model, 'the model'), effort: name(body?.effort, 'the effort'), permissionMode, prompt: prompt.trim() };
}

/**
 * The command line typed into the new agent's shell. Every part is a fixed flag, a checked name or a path of
 * Woodshed's own; the first message is read from its file by the shell, never typed.
 * @param {{agent: string, model: string, effort: string, permissionMode: string}} options
 * @param {{bin: string, claudeFlags: string, conversation: string|null, uploadsDir: string, promptFile: string|null}} where
 */
export function commandLine({ agent, model, effort, permissionMode }, { bin, claudeFlags = '', conversation = null, uploadsDir, promptFile = null }) {
  const parts = [path.join(bin, agent)];
  if (agent === 'claude') {
    // The session's own flags (claudeFlags in entrypoint.sh, written with no model, effort or mode): its hooks, rules,
    // MCP servers and plugins.
    if (claudeFlags.trim()) parts.push(claudeFlags.trim());
    if (conversation) parts.push('--session-id', conversation);
    if (permissionMode !== 'default') parts.push('--permission-mode', permissionMode);
    if (model) parts.push('--model', model);
    if (effort) parts.push('--effort', effort);
  } else {
    // As codexFlags in entrypoint.sh: the container is the sandbox. Codex rejects added roots while read-only.
    if (permissionMode !== 'plan') parts.push('--add-dir', uploadsDir);
    if (permissionMode === 'auto') parts.push('--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request');
    if (permissionMode === 'plan') parts.push('--sandbox', 'read-only', '--ask-for-approval', 'on-request');
    if (model) parts.push('--model', model);
    if (effort) parts.push('-c', `model_reasoning_effort=\\"${effort}\\"`);
  }
  // After `--`, which ends both CLIs' options: a message that starts with a dash (a pasted list) is the message.
  if (promptFile) parts.push('--', `"$(cat ${promptFile})"`);
  return parts.join(' ');
}

// The processes under a pid, from /proc: the agent and whatever it runs, under its pane's shell.
async function descendantsOf(pid) {
  const parents = new Map();
  for (const entry of await fs.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!parents.has(ppid)) parents.set(ppid, []);
    parents.get(ppid).push(Number(entry));
  }
  const found = [];
  const queue = [pid];
  while (queue.length && found.length < 500) {
    for (const child of parents.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * The rollout a codex under the pane writes to: the one file under its sessions folder it holds open (measured on codex
 * 0.167, which keeps it open for the whole conversation).
 * @returns {Promise<string|null>}
 */
export async function openRollout(shellPid, codexHome, { descendants = descendantsOf } = {}) {
  const root = path.join(codexHome, 'sessions') + path.sep;
  for (const pid of await descendants(shellPid)) {
    for (const fd of await fs.readdir(`/proc/${pid}/fd`).catch(() => [])) {
      const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      if (target.startsWith(root) && /\/rollout-[^/]*\.jsonl$/.test(target)) return target;
    }
  }
  return null;
}

/**
 * @param {{run: (cmd: string, args: string[], opts?: object) => Promise<{stdout: string}>, repoDir: string,
 *          bin: string, claudeDir: string, codexHome: string, claudeFlagsFile: string, codexReady: () => Promise<boolean>,
 *          codexEnv?: (codexAuth: string|null) => Promise<{env: Record<string, string>, undo?: () => Promise<void>}>,
 *          stateDir?: string, uploadsDir?: string,
 *          tainted?: () => boolean, now?: () => number, openRollout?: typeof openRollout, log?: Pick<Console, 'log'|'warn'>,
 *          terminal?: 'tmux'|'herdr', hcBin?: string}} deps
 *   claudeFlagsFile: the session's claude flags with no model, effort or mode (entrypoint.sh). codexReady: whether
 *   codex has a home here (configureCodex ran). codexEnv: given the owner's Codex sign-in the console sent with the start
 *   (or none), puts it in place and says what a codex's tmux session adds to its environment, and how to take it back
 *   when the start fails after it (statusd's codexBeside). terminal: what the session's own agent runs in, and so its
 *   agents too (statusd's WOODSHED_TERMINAL)
 */
export function createAgents({
  run, repoDir, bin, claudeDir, codexHome, claudeFlagsFile, codexReady, claudeEnv = async () => ({ env: {} }), codexEnv = async () => ({ env: {} }), stateDir = '/tmp', uploadsDir = '/tmp/uploads',
  tainted = () => false, now = Date.now, openRollout: findRollout = openRollout, log = console, terminal = 'tmux', hcBin = 'hc',
}) {
  // Where an agent runs: its tmux session, or its Herdr terminal. Either is made with a shell in the checkout, the agent
  // typed into it.
  const terms = terminal === 'herdr' ? {
    kind: 'herdr',
    // No --keep: a stopped agent's terminal goes, rather than coming back as a shell. hc takes no environment for one,
    // so the agent's own variables go before its command line (prefix).
    make: async (id) => { await run(hcBin, ['run', '--bg', '--no-parent', '--name', id, '--cwd', repoDir, '--json']); },
    io: (id) => hcPane(run, { terminal: id, bin: hcBin }),
    prefix: (env) => Object.entries(env).map(([k, v]) => `${k}='${String(v).replace(/'/g, `'\\''`)}' `).join(''),
    async end(id) {
      await run(hcBin, ['kill', '--json', '--', id]).catch(() => {});
      await run(hcBin, ['rm', '--json', '--', id]).catch(() => {});
    },
  } : {
    kind: 'tmux',
    async make(id, env) {
      await run('tmux', ['new-session', '-d', '-s', id, '-x', '200', '-y', '50', '-c', repoDir, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])]);
      try {
        await run('tmux', ['set-option', '-t', `=${id}:`, 'remain-on-exit', 'on']);
      } catch (err) {
        await run('tmux', ['kill-session', '-t', `=${id}`]).catch(() => {});
        throw err;
      }
    },
    io: (id) => tmuxPane(run, `=${id}:`),
    prefix: () => '',
    end: async (id) => { await run('tmux', ['kill-session', '-t', `=${id}`]).catch(() => {}); },
  };
  /** @type {Map<string, object>} */
  const agents = new Map();
  // Every record one of them wrote, kept after it stops: the session's own agent never takes one for its own.
  const claimedClaude = new Set();
  const claimedCodex = new Set();
  // Whether a codex ever started here, read or not on the Chat tab: its sign-in may have been refreshed all the same.
  let codexStarted = false;
  let ticker = null;

  const claudeFile = (name) => path.join(claudeDir, name);

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  // Its transcript: the one its hooks last named, inside claude's folder for the repo, or the one --session-id named.
  function transcriptOf(a, hook) {
    const named = typeof hook?.transcript === 'string' ? hook.transcript : '';
    const name = path.dirname(named) === claudeDir && /^[0-9a-f-]{36}\.jsonl$/.test(path.basename(named)) ? path.basename(named) : `${a.conversation}.jsonl`;
    claimedClaude.add(name);
    return claudeFile(name);
  }

  async function rolloutOf(a) {
    if (a.rollout && now() - a.rolloutAt < ROLLOUT_LOOK_MS) return a.rollout;
    a.rolloutAt = now();
    try {
      const found = await findRollout(await a.io.shellPid(), codexHome);
      // A codex that exited holds nothing open: its last rollout stays its own.
      if (found) {
        a.rollout = found;
        claimedCodex.add(found);
      }
    } catch {
      // No pane (it was stopped): the last one found stands.
    }
    return a.rollout;
  }

  async function tailOf(file) {
    const handle = await fs.open(file).catch(() => null);
    if (!handle) return null;
    try {
      const { size, mtimeMs } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(size - start), position: start });
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), partial: start > 0, writtenAt: mtimeMs };
    } finally {
      await handle.close();
    }
  }

  /** What one is doing, read as statusd reads the session's own: claude's hooks and transcript, codex's pane. */
  async function stateOf(a, { strict = false } = {}) {
    let pane = '';
    try {
      pane = await a.io.capture();
    } catch (err) {
      if (strict) throw err;
    }
    // Herdr's own word on it, where it runs there: its agent's last status record (agentState.mjs, withHerdr).
    const herdr = terms.kind === 'herdr' ? herdrState({ herdrStatus: await a.io.agent().catch(() => null) }) : null;
    if (a.agent === 'codex') {
      // Its rollout claimed with each read of the list, not only of its Chat: the session's own codex never takes it.
      await rolloutOf(a);
      return { ...withHerdr(herdr, codexState({ paneText: pane, now: now(), startedAt: a.startedAt })), pane, hook: null };
    }
    const hook = await readJson(a.stateFile);
    const tail = await tailOf(transcriptOf(a, hook));
    const reading = claudeState({
      paneText: pane, hook,
      interruptedAt: tail ? lastInterruptAt(tail.text) : null,
      transcriptAt: tail?.writtenAt ?? null,
      openTools: tail ? openToolCalls(tail.text, { partial: tail.partial }) : 0,
      now: now(), startedAt: a.startedAt,
    });
    return { ...withHerdr(herdr, reading), pane, hook };
  }

  function find(id) {
    const a = agents.get(id);
    if (!a) throw Object.assign(new Error('no such agent in this session: it was stopped, or never started'), { status: 404 });
    return a;
  }

  const keep = (list, id) => {
    list.push(id);
    list.splice(0, Math.max(0, list.length - KEEP_IDS));
  };

  async function view(a) {
    const { state } = await stateOf(a);
    if (state !== a.lastState) log.log('agents: agent state changed', { id: a.id, agent: a.agent, from: a.lastState, to: state });
    a.lastState = state;
    return {
      id: a.id, agent: a.agent, model: a.model || null, effort: a.effort || null, permissionMode: a.permissionMode,
      startedAt: new Date(a.startedAt).toISOString(), state,
      // The page's ids of its messages, as the console gives them for the session's own agent (console/sessions.mjs).
      heldIds: a.held.map((m) => m.id), deliveredIds: [...a.delivered], refusedIds: [...a.refused],
      leftInBox: a.leftInBox ? { id: a.leftInBox } : null,
    };
  }

  // ---- Typing a message, as statusd types one into the session's own agent: only between turns, into an empty box.

  function paneIo(a) {
    return {
      capture: () => a.io.capture(),
      async type(text) {
        let done = 0;
        try {
          for (const step of typingSteps(text, a.agent)) {
            if (step.paste !== undefined) await a.io.paste(step.paste);
            else if (step.keys !== undefined) await a.io.literal(step.keys);
            else await a.io.keys(step.key);
            done++;
            await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
          }
        } catch {
          // execFile's error quotes the command line, the message with it: never logged.
          throw Object.assign(new Error('tmux could not type the message'), { typing: true, partial: done > 0 });
        }
      },
      enter: () => a.io.keys('Enter'),
      box: async (text = '') => composerText(await a.io.capture({ ansi: true, back: text.split('\n').length + 100 }), a.agent),
    };
  }

  function lastTaken(a, { state, hook, pane }) {
    if (!a.lastSent) return true;
    if (state !== 'done' || (a.agent === 'claude' && paneState(pane) === 'working')) a.lastSent.seenWorking = true;
    if (a.lastSent.seenWorking || (hook?.at ?? 0) > a.lastSent.at || now() - a.lastSent.at > TAKEN_MS) {
      a.lastSent = null;
      return state === 'done' || state === 'needs-you';
    }
    return false;
  }

  // The first held message typed in, when its agent is back at its prompt; nothing when it is not.
  async function deliver(a) {
    if (!a.held.length || !agents.has(a.id) || !a.lock.take('send')) return;
    const message = a.held[0];
    try {
      const now_ = await stateOf(a, { strict: true });
      const shown = paneState(now_.pane);
      const atPrompt = now_.state === 'done' && (a.agent === 'codex' || (shown !== 'working' && shown !== 'needs-you'));
      if (!atPrompt || !lastTaken(a, now_)) return;
      // A draft in its box (someone typing in the TUI tab) is theirs: this waits behind it. Herdr keeps no colours to
      // tell one by, and its own send waits for a person's draft and types only while the agent is idle (hcPane).
      let done;
      if (a.io.typesText) {
        const colored = await a.io.capture({ ansi: true });
        if (!readPrompt(colored.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) && composerEmpty(colored, a.agent) !== true) return;
        done = await typeMessage(paneIo(a), message.text);
      } else {
        const sent = await a.io.send(message.text);
        // Not idle, or a prompt on screen: nothing typed, and it waits for the next tick.
        if (!sent.sent) return;
        done = sent;
      }
      if (done.sent) {
        a.held.shift();
        keep(a.delivered, message.id);
        a.lastSent = { at: now(), seenWorking: false };
        log.log('agents: text sent', { id: a.id, agent: a.agent, chars: message.text.length });
      } else if (done.typed) {
        // In its box, unsent: a prompt came up as it went in. Not to be typed again.
        a.held.shift();
        a.leftInBox = message.id;
        log.log('agents: text left in the box, a prompt came up', { id: a.id, kind: done.kind });
      }
    } catch (err) {
      if (err?.typing) {
        a.held.shift();
        if (err.partial) a.leftInBox = message.id;
        else keep(a.refused, message.id);
        log.warn('agents: text not typed', { id: a.id, partial: err.partial });
      }
      // A pane that could not be read: tried again on the next tick.
    } finally {
      a.lock.release('send');
    }
  }

  function tick() {
    const waiting = [...agents.values()].filter((a) => a.held.length);
    if (!waiting.length) {
      clearInterval(ticker);
      ticker = null;
      return;
    }
    for (const a of waiting) deliver(a).catch((err) => log.warn('agents: delivery failed', { id: a.id, message: err?.message }));
  }

  // A start once its checks passed: its terminal, its command line typed in, and it on the list.
  async function launch(options, { claudeFlags, env, cleanup }) {
    let n = 2;
    while (agents.has(`agent-${n}`)) n++;
    const id = `agent-${n}`;
    const stateFile = path.join(stateDir, `woodshed-${id}-state.json`);
    const promptFile = options.prompt ? path.join(stateDir, `woodshed-${id}-prompt.md`) : null;
    await fs.rm(stateFile, { force: true });
    if (promptFile) await fs.writeFile(promptFile, `${options.prompt}\n`, { mode: 0o600 });
    const conversation = options.agent === 'claude' ? randomUUID() : null;
    const line = commandLine(options, { bin, claudeFlags, conversation, uploadsDir, promptFile });
    // Its own terminal, its hooks pointed at its own state file. A tmux one is kept after the agent exits, as the
    // session's is.
    const agentEnv = { WOODSHED_CLAUDE_STATE_FILE: stateFile, WOODSHED_AGENT_ID: id, ...env };
    await terms.make(id, agentEnv);
    const a = {
      id, ...options, conversation, stateFile, cleanup, startedAt: now(), io: terms.io(id), lock: createPaneLock(),
      held: [], delivered: [], refused: [], leftInBox: null, lastSent: null, lastState: null, rollout: null, rolloutAt: 0,
    };
    if (conversation) claimedClaude.add(`${conversation}.jsonl`);
    if (a.agent === 'codex') codexStarted = true;
    agents.set(id, a);
    try {
      await a.io.line(`${terms.prefix(agentEnv)}${line}`);
    } catch (err) {
      agents.delete(id);
      await terms.end(id);
      throw err;
    }
    log.log('agents: agent started', { id, terminal: terms.kind, agent: a.agent, model: a.model || null, effort: a.effort || null, permissionMode: a.permissionMode, prompt: Boolean(promptFile) });
    return view(a);
  }

  return {
    /** The agents running beside the session's own, oldest first. */
    async list() {
      return Promise.all([...agents.values()].map(view));
    },

    /** The records the session's own agent must not read as its own: claude's by name, codex's by path. */
    claimed() {
      return { claude: claimedClaude, codex: claimedCodex };
    },

    /** Whether any started here ran codex, whose sign-in the stop sends back. */
    ranCodex() {
      return codexStarted;
    },

    async start(body) {
      const options = startOptions(body);
      if (tainted()) throw Object.assign(new Error('this session has seen production data: no other agent starts in it'), { status: 409 });
      if (agents.size >= MAX_EXTRA_AGENTS) throw Object.assign(new Error(`at most ${MAX_EXTRA_AGENTS} agents beside the session's own: stop one first`), { status: 409 });
      let claudeFlags = '';
      let env = {};
      let undo = null;
      let cleanup = null;
      if (options.agent === 'claude') {
        claudeFlags = await fs.readFile(claudeFlagsFile, 'utf8').catch(() => null);
        if (claudeFlags === null) throw Object.assign(new Error('this session started before it could start another claude: start a new session'), { status: 409 });
        ({ env, undo = null, cleanup = null } = await claudeEnv(typeof body?.claudeToken === 'string' ? body.claudeToken.trim() : ''));
      } else if (!(await codexReady())) {
        throw Object.assign(new Error('codex is not set up in this session: start a new session for it'), { status: 409 });
      } else {
        // The owner's own sign-in, which the console sends with the start and never as part of what it checks.
        ({ env, undo = null } = await codexEnv(typeof body?.codexAuth === 'string' && body.codexAuth.trim() ? body.codexAuth : null));
      }
      try {
        return await launch(options, { claudeFlags, env, cleanup });
      } catch (err) {
        await undo?.().catch(() => {});
        throw err;
      }
    },

    async stop(id) {
      const a = find(id);
      agents.delete(id);
      await terms.end(id);
      await a.cleanup?.();
      log.log('agents: agent stopped', { id, agent: a.agent });
      return { stopped: id };
    },

    /** Every one stopped: the session is locked down (taint), or stopping. */
    async stopAll(why) {
      const stopped = [...agents.values()];
      for (const a of stopped) {
        agents.delete(a.id);
        await terms.end(a.id);
        await a.cleanup?.();
      }
      if (stopped.length) log.log('agents: every agent stopped', { why, stopped: stopped.length });
    },

    /** The conversation, for the Chat tab, as statusd's GET /transcript reads the session's own. */
    async transcript(id, { limit, since } = {}) {
      const a = find(id);
      const file = a.agent === 'codex' ? await rolloutOf(a) : transcriptOf(a, await readJson(a.stateFile));
      return readSessionTranscript({
        agent: a.agent, claudeDir, codexHome, root: repoDir, file,
        ...(limit ? { limit } : {}), ...(since !== undefined && since !== null ? { since } : {}),
      });
    },

    /**
     * A message from Chat: typed in now if its agent is at its prompt, and otherwise held and typed once it is.
     * @returns {Promise<{ok: true, held?: true}|{status: number, typed?: boolean, error: string}>}
     */
    async send(id, text, messageId = randomUUID()) {
      const a = find(id);
      if (a.held.length >= 20) return { status: 409, error: `${a.agent} already has 20 messages waiting` };
      a.held.push({ id: messageId, text });
      await deliver(a);
      if (a.delivered.includes(messageId)) return { ok: true };
      if (a.leftInBox === messageId) return { status: 409, typed: true, error: `it went into ${a.agent}'s box but was not sent: a prompt came up as it was typed. Answer it, then send or clear the box in the TUI tab` };
      if (a.refused.includes(messageId)) return { status: 500, error: `the message could not be typed into ${a.agent}'s terminal` };
      ticker ??= setInterval(tick, DELIVER_EVERY_MS);
      ticker.unref?.();
      return { ok: true, held: true };
    },

    async interrupt(id) {
      await find(id).io.keys('Escape');
      log.log('agents: agent interrupted', { id });
    },

    /** What its pane asks now (panePrompt.mjs readPrompt), or null. */
    async prompt(id) {
      return readPrompt(await find(id).io.capture());
    },

    /** Chat's answer to it, typed only once its pane shows the same prompt. */
    async answer(id, body) {
      const a = find(id);
      if (a.answering) return { status: 409, body: { error: 'another answer is being typed: wait a moment' } };
      a.answering = true;
      const io = { capture: () => a.io.capture(), keys: async (...keys) => { await a.io.keys(...keys); } };
      try {
        if (body.kind === 'question') await answerQuestions(io, body.questions);
        else await answerApproval(io, body);
        log.log('agents: answer typed', { id, kind: body.kind });
        return { status: 200, body: { ok: true } };
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        log.log('agents: answer refused', { id, kind: body.kind, why: err.why });
        return { status: 409, body: { error: err.message, why: err.why, typed: err.typed } };
      } finally {
        a.answering = false;
      }
    },
  };
}
