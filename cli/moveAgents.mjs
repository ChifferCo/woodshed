// `woodshed herdr move`'s terminals: what each one runs (an agent with its conversation, a shell, or a program), and an
// agent's conversation carried to a session with its folders said as the session's.
//
// A Claude Code conversation is `<claude home>/projects/<encoded folder>/<id>.jsonl`, the folder encoded with every
// character that is not a letter or a digit as `-`; `claude --resume <id>` reads it from the folder it runs in. A Codex
// one is `<codex home>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, whose first record names its folder; `codex resume <id>`
// finds it by id. Nothing else of either home is read or carried.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CREDENTIAL_HEADER_ARGUMENT, hideUrlPasswords } from './moveCode.mjs';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'nu', 'tcsh', 'csh', 'elvish', 'xonsh', 'pwsh']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// How far apart an agent's last state change and its conversation's last write may be to be called the same turn.
const SAME_TURN_MS = 120_000;

/** @returns {string}  Claude Code's folder name for a working folder */
export function claudeProjectDir(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
}

const base = (word) => path.basename(String(word ?? '')).replace(/^-/, '');

/**
 * What a terminal runs: an agent (Claude Code or Codex), a shell, or another program, from what hc says runs in it in
 * the foreground now, and the status record the program sends.
 * @param {object} terminal  hc's Terminal
 * @returns {{kind: 'agent'|'shell'|'process', agent?: 'claude'|'codex', argv: string[], cwd: string, state: string|null}}
 */
export function classify(terminal) {
  const fg = terminal.foreground ?? null;
  const argv = commandLine(Array.isArray(fg?.argv) && fg.argv.length ? fg.argv : (terminal.argv ?? []));
  const cwd = String(fg?.cwd || terminal.cwd || '');
  const state = typeof terminal.status?.state === 'string' ? terminal.status.state : null;
  const app = String(terminal.status?.app ?? '');
  const words = [fg?.name, ...argv.slice(0, 3)].map(base);
  const anyArg = (re) => argv.slice(0, 3).some((a) => re.test(a));
  if (/claude/i.test(app) || words.includes('claude') || anyArg(/@anthropic-ai\/claude-code|\/claude(\.js|\.exe)?$/)) {
    return { kind: 'agent', agent: 'claude', argv, cwd, state };
  }
  if (/codex/i.test(app) || words.includes('codex') || anyArg(/@openai\/codex|\/codex(\.js)?$/)) return { kind: 'agent', agent: 'codex', argv, cwd, state };
  if (SHELLS.has(base(fg?.name ?? argv[0]))) return { kind: 'shell', argv, cwd, state };
  return { kind: 'process', argv, cwd, state };
}

/**
 * A program's words as the OS has them, made a command line again. A program that sets its own title (npm sets
 * `npm run dev`) leaves its first word holding the whole line and the rest empty: `["npm run dev", "", "", ""]`.
 * @returns {string[]}
 */
export function commandLine(argv) {
  const words = argv.map(String);
  // Only a retitled program's padding is dropped: an empty argument of an ordinary command (--prefix '') is its own.
  if (words.length && /\s/.test(words[0]) && words.slice(1).every((w) => w === '') && !fs.existsSync(words[0])) return words[0].trim().split(/\s+/);
  return words;
}

/** @returns {string|null}  the conversation a command line resumes or starts by id: --resume X, -r X, --session-id X */
export function conversationInArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = String(argv[i]).split(/=(.*)/s);
    if (!['--resume', '-r', '--session-id'].includes(flag)) continue;
    const value = inline ?? argv[i + 1];
    if (UUID_RE.test(String(value ?? ''))) return String(value);
  }
  // `codex resume <id>`
  const at = argv.findIndex((a) => a === 'resume');
  if (at >= 0 && UUID_RE.test(String(argv[at + 1] ?? ''))) return String(argv[at + 1]);
  return null;
}

// The folders a terminal may be said to be in: as hc has it, as the OS resolves it, and as the shell said it (PWD).
function folders(...dirs) {
  const out = new Set();
  for (const dir of dirs.filter(Boolean)) {
    out.add(dir);
    try {
      out.add(fs.realpathSync(dir));
    } catch {
      // Gone since: the name is all there is.
    }
    // macOS: /tmp and /var are /private/tmp and /private/var, and a program may say either.
    if (dir.startsWith('/private/')) out.add(dir.slice('/private'.length));
  }
  return [...out];
}

function newest(files) {
  return files.map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The Claude conversations of a folder, newest first.
 * @returns {{id: string, file: string, mtimeMs: number}[]}
 */
export function claudeConversations(home, cwd) {
  const found = [];
  for (const dir of folders(cwd)) {
    const at = path.join(home, 'projects', claudeProjectDir(dir));
    let names;
    try {
      names = fs.readdirSync(at);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.replace(/\.jsonl$/, '');
      if (name.endsWith('.jsonl') && UUID_RE.test(id) && !found.some((f) => f.id === id)) found.push({ id, file: path.join(at, name) });
    }
  }
  return newest(found.map((f) => f.file)).map(({ file, mtimeMs }) => ({ id: path.basename(file, '.jsonl'), file, mtimeMs }));
}

function firstRecord(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The Codex conversations started in a folder, newest first. Codex keeps them by day, so only the last 60 days are
 * looked through.
 * @returns {{id: string, file: string, mtimeMs: number, relative: string}[]}
 */
export function codexConversations(home, cwd, { now = Date.now() } = {}) {
  const want = new Set(folders(cwd));
  const root = path.join(home, 'sessions');
  const files = [];
  for (let day = 0; day < 60; day++) {
    const d = new Date(now - day * 86_400_000);
    const dir = path.join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) if (/^rollout-.*\.jsonl$/.test(name)) files.push(path.join(dir, name));
  }
  const out = [];
  for (const { file, mtimeMs } of newest([...new Set(files)])) {
    const meta = firstRecord(file);
    const payload = meta?.payload ?? meta;
    if (!payload || !want.has(String(payload.cwd ?? '')) || !UUID_RE.test(String(payload.id ?? ''))) continue;
    out.push({ id: String(payload.id), file, mtimeMs, relative: path.relative(root, file).split(path.sep).join('/') });
  }
  return out;
}

/**
 * A Codex conversation by its id, however long ago it started: its rollout file is under the day it began.
 * @returns {{id: string, file: string, mtimeMs: number, relative: string}|null}
 */
export function codexConversationById(home, id) {
  const root = path.join(home, 'sessions');
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const at = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) {
        const found = walk(at, depth + 1);
        if (found) return found;
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(`-${id}.jsonl`)) {
        return { id, file: at, mtimeMs: fs.statSync(at).mtimeMs, relative: path.relative(root, at).split(path.sep).join('/') };
      }
    }
    return null;
  };
  return UUID_RE.test(id) ? walk(root, 0) : null;
}

/**
 * Each agent's conversation: its `claude.session` (or `codex.session`) label, else the id on its command line, else
 * the conversation of its folder last written when the agent last changed state, else, for a folder with one agent,
 * the folder's newest. Two agents that would get one conversation get neither: which is whose cannot be told.
 * @param {{address: string, agent: 'claude'|'codex', cwd: string, labels: object, argv: string[], statusMs: number|null}[]} agents
 * @returns {Map<string, {id: string, file: string, relative?: string, from: string}|{error: string}>}  by address
 */
export function findConversations(agents, { env = process.env, now = Date.now(), peers = agents } = {}) {
  const out = new Map();
  const listed = new Map();
  const list = (a) => {
    const key = `${a.agent}\0${a.cwd}`;
    if (!listed.has(key)) listed.set(key, a.agent === 'claude' ? claudeConversations(claudeHome(env), a.cwd) : codexConversations(codexHome(env), a.cwd, { now }));
    return listed.get(key);
  };
  // Every agent of that kind there, the ones not moving too: one moved alone from a busy folder is no guess's to make.
  const sameFolder = (a) => new Set([...agents, ...peers].filter((b) => b.agent === a.agent && b.cwd === a.cwd).map((b) => b.address)).size;
  for (const a of agents) {
    const all = list(a);
    const named = a.labels?.[`${a.agent}.session`] ?? conversationInArgv(a.argv);
    let pick = null;
    let from = null;
    if (named) {
      pick = all.find((c) => c.id === named) ?? (a.agent === 'codex' ? codexConversationById(codexHome(env), named) : null);
      from = a.labels?.[`${a.agent}.session`] ? 'label' : 'command line';
      if (!pick) {
        out.set(a.address, { error: `its conversation ${named} (from its ${from}) is not in ${a.agent === 'claude' ? claudeHome(env) : codexHome(env)} for ${a.cwd}` });
        continue;
      }
    } else if (a.statusMs) {
      const near = all.map((c) => ({ c, gap: Math.abs(c.mtimeMs - a.statusMs) })).filter((x) => x.gap <= SAME_TURN_MS).sort((x, y) => x.gap - y.gap)[0];
      if (near) [pick, from] = [near.c, 'last turn'];
    }
    if (!pick && sameFolder(a) === 1 && all[0]) [pick, from] = [all[0], 'newest'];
    if (!pick) {
      out.set(a.address, {
        error: all.length ? `which of ${a.cwd}'s ${all.length} ${a.agent} conversations is its own cannot be told: label it, hc label ${a.address} ${a.agent}.session=<id>`
          : `no ${a.agent} conversation for ${a.cwd} in ${a.agent === 'claude' ? claudeHome(env) : codexHome(env)}`,
      });
      continue;
    }
    out.set(a.address, { id: pick.id, file: pick.file, ...(pick.relative ? { relative: pick.relative } : {}), from });
  }
  // One conversation for two agents is a guess for at least one of them.
  const byId = new Map();
  for (const [address, found] of out) if (found.id) byId.set(found.id, [...(byId.get(found.id) ?? []), address]);
  for (const [id, addresses] of byId) {
    if (addresses.length < 2) continue;
    for (const address of addresses) out.set(address, { error: `${addresses.join(' and ')} would both get conversation ${id}: label each, hc label <t> claude.session=<id>` });
  }
  return out;
}

/**
 * A conversation's records with their folders said as the session's: each `cwd` (Claude's records, Codex's
 * `payload.cwd`) in the local checkout, or under it, moved to the same place in the session's. Lines that are not
 * JSON are kept as they are.
 * @param {string} text  the .jsonl
 * @param {{from: string[], to: string, codexProvider?: string|null}} roots  the local checkout's top, in each way it
 *        may be said, and the session's; for a Codex conversation, the model provider the session's codex runs on
 * @returns {string}
 */
export function rewriteConversation(text, { from, to, codexProvider = null }) {
  const roots = [...new Set(from)].sort((a, b) => b.length - a.length);
  const move = (dir) => {
    if (typeof dir !== 'string') return dir;
    for (const root of roots) {
      if (dir === root) return to;
      if (dir.startsWith(`${root}/`)) return `${to}${dir.slice(root.length)}`;
    }
    return dir;
  };
  return String(text).split('\n').map((line) => {
    if (!line.trim()) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (!record || typeof record !== 'object') return line;
    let changed = false;
    if (typeof record.cwd === 'string' && move(record.cwd) !== record.cwd) {
      record.cwd = move(record.cwd);
      changed = true;
    }
    if (record.payload && typeof record.payload.cwd === 'string' && move(record.payload.cwd) !== record.payload.cwd) {
      record.payload.cwd = move(record.payload.cwd);
      changed = true;
    }
    // Codex continues a conversation only on the model provider it names, and a session's codex has its own: the
    // console's proxy on the team key, OpenAI on the owner's sign-in.
    if (codexProvider && record.type === 'session_meta' && record.payload && record.payload.model_provider !== codexProvider) {
      record.payload.model_provider = codexProvider;
      changed = true;
    }
    return changed ? JSON.stringify(record) : line;
  }).join('\n');
}

/** @returns {string[]}  a checkout's top as it may be said: as given, resolved, and without macOS's /private */
export function rootsOf(root) {
  return folders(root);
}

/**
 * A session's Claude settings without the hooks that report its own agent's state (hookState.mjs): a second claude in
 * the session would speak for the first. Its permissions (the ask before `gh pr merge`) and its other hooks (the ready
 * gate before a pull request) are kept.
 * @returns {object}
 */
export function withoutStateHooks(settings) {
  const out = { ...settings };
  if (!settings?.hooks || typeof settings.hooks !== 'object') return out;
  out.hooks = {};
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    const kept = (Array.isArray(matchers) ? matchers : []).map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !/hookState\.mjs/.test(String(h.command ?? ''))) }))
      .filter((m) => m.hooks.length);
    if (kept.length) out.hooks[event] = kept;
  }
  return out;
}

// Validate the name and look for a credential word in separate passes, even for long arguments.
const SECRET_WORD_RE = /token|password|passwd|pass|pwd|secret|key|auth|credential/i;
// A flag whose value is a credential only when it looks like one: curl's -u user:password, but not python's -u alone.
const USER_FLAG_RE = /^(-u|-U|--user|--proxy-user)$/;

/**
 * A program's command line as it may be shown: every value that may be a credential hidden as `…`. The real one is kept
 * for the restart alone.
 * @returns {string}
 */
export function shownCommand(argv, looksSecret = () => false) {
  const out = [];
  let hideNext = false;
  for (let i = 0; i < argv.length; i++) {
    const word = String(argv[i]);
    const equals = word.indexOf('=');
    const name = equals < 0 ? word : word.slice(0, equals);
    const credentialName = /^[\w-]+$/.test(name) && SECRET_WORD_RE.test(name);
    const flag = name.startsWith('-');
    const safeUrl = hideUrlPasswords(word);
    const hide = hideNext;
    // A word hidden as the preceding switch's value can still be an option with a secret value of its own.
    hideNext = i + 1 < argv.length && ((credentialName && flag && equals < 0)
      || (USER_FLAG_RE.test(word) && String(argv[i + 1]).includes(':')));
    if (hide || looksSecret(safeUrl)) out.push('…');
    else if (CREDENTIAL_HEADER_ARGUMENT.test(word)) out.push(`${word.split(':')[0]}: …`);
    else if (safeUrl !== word) out.push(safeUrl);
    // curl's user:password joined to its flag: -uuser:pass, --user=user:pass.
    else if (/^(-[uU][^-\s]|--(proxy-)?user=)[^:]*:/.test(word)) out.push(`${word.startsWith('--') ? word.split('=')[0] : word.slice(0, 2)}…`);
    else if (credentialName && equals >= 0 && (flag || equals + 1 < word.length)) out.push(`${name}=…`);
    else if (hideNext) out.push(word);
    else out.push(/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
  }
  return out.join(' ');
}
