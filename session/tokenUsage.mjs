// The tokens this session's agent used, from its own transcripts, for the console's Usage page. Only where the agent
// calls its provider directly: a private session's claude on its owner's own Claude token, or its codex on the owner's
// own Codex sign-in. Every other call goes through the console's proxies (anthropicProxy.mjs, openaiProxy.mjs), which
// count it there, so statusd says `direct: false` and the console takes nothing from it.
//
// Nothing but numbers and model names leaves the session: no text of the conversation.
//
// claude writes one line per content block of each answer under ~/.claude/projects/ (subagents' in their own files),
// each with the answer's `message.id`, `model` and `usage`; the lines of one answer repeat its usage, so an answer is
// counted once, by its id, with the largest of each count seen. codex writes `token_count` events in its rollout files
// under ~/.codex/sessions/, each with the rollout's running total: the differences between them are what each turn
// used, on the model its last `turn_context` named.
//
// Only what was written since this container started counts (SINCE_FILE, kept in /tmp so a restart of statusd keeps
// it): a Claude home restored from another session holds that session's transcripts, which it reported itself. The
// console keeps each run's report apart, by `since`, so a resumed session's runs add up and none counts twice.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SINCE_FILE = '/tmp/woodshed-usage-since';
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
// Read again at most this often: a status read comes every few seconds, and a long session has many files.
const FRESH_MS = 30_000;
// A line longer than this is a tool result or a pasted file, never a usage line worth reading whole.
const MAX_LINE_BYTES = 4 * 1024 * 1024;

const EMPTY = () => ({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, requests: 0 });
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const dayOf = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null);

/**
 * @param {object} usage  an Anthropic `usage` object, as the API and claude's transcripts have it
 * @returns {{input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number}}
 *   a cache write with no split by its time to live counts as the 5-minute kind
 */
export function claudeTokens(usage) {
  const written = count(usage?.cache_creation_input_tokens);
  const split = usage?.cache_creation && typeof usage.cache_creation === 'object';
  const oneHour = split ? count(usage.cache_creation.ephemeral_1h_input_tokens) : 0;
  return {
    input: count(usage?.input_tokens),
    cacheWrite5m: split ? count(usage.cache_creation.ephemeral_5m_input_tokens) : written,
    cacheWrite1h: oneHour,
    cacheRead: count(usage?.cache_read_input_tokens),
    output: count(usage?.output_tokens),
  };
}

/**
 * @param {object} usage  codex's `total_token_usage` (or an OpenAI Responses `usage`, whose names it shares)
 * @returns {{input: number, cacheRead: number, output: number, reasoning: number}}  `input` without the cached part
 */
export function codexTokens(usage) {
  const cached = count(usage?.cached_input_tokens ?? usage?.input_tokens_details?.cached_tokens);
  return {
    input: Math.max(0, count(usage?.input_tokens) - cached),
    cacheRead: cached,
    output: count(usage?.output_tokens),
    reasoning: count(usage?.reasoning_output_tokens ?? usage?.output_tokens_details?.reasoning_tokens),
  };
}

function add(rows, day, model, fast, tokens, requests = 1) {
  const key = `${day}|${model}|${fast ? 'fast' : ''}`;
  const row = rows.get(key) ?? { day, model, fast, ...EMPTY() };
  for (const [kind, n] of Object.entries(tokens)) row[kind] = (row[kind] ?? 0) + n;
  row.requests += requests;
  rows.set(key, row);
}

/** Reads the lines appended to a file since the last read, keeping where it got to and the unfinished last line. */
async function newLines(file, cursor) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (size < cursor.offset) Object.assign(cursor, { offset: 0, rest: '' });
    if (size === cursor.offset) return [];
    const buffer = Buffer.alloc(size - cursor.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
    cursor.offset += bytesRead;
    const text = cursor.rest + buffer.subarray(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    cursor.rest = lines.pop();
    if (cursor.rest.length > MAX_LINE_BYTES) cursor.rest = '';
    return lines;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

async function filesUnder(dir, re, sinceMs) {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !re.test(e.name)) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    try {
      if ((await fs.stat(file)).mtimeMs >= sinceMs) out.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return out;
}

/**
 * A reader of one agent's transcripts, which keeps what it read so each call reads only what was added.
 * @param {{agent: 'claude'|'codex', since: string, until?: () => string|null, claudeDir?: string, codexDir?: string}} opts
 *   `until`: a time after which nothing counts (a session that went through the console from then on), or null
 * @returns {{read: () => Promise<object[]>}}  rows by day, model and fast mode
 */
export function createTranscriptReader({ agent, since, until = () => null, claudeDir = CLAUDE_DIR, codexDir = CODEX_DIR }) {
  const sinceMs = Date.parse(since);
  const cursors = new Map();
  // claude: each answer once, by its id, with the largest of each count its lines carried.
  const answers = new Map();
  // codex: each rollout's model and last running total, and what each day and model came to.
  const rollouts = new Map();
  const codexRows = new Map();

  function inWindow(at) {
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms < sinceMs) return false;
    const end = until();
    return !end || ms < Date.parse(end);
  }

  function claudeLine(line) {
    if (!line.includes('"usage"')) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const message = record?.message;
    if (record?.type !== 'assistant' || !message?.usage || typeof message.model !== 'string' || message.model.startsWith('<')) return;
    if (!inWindow(record.timestamp)) return;
    const id = String(message.id ?? record.requestId ?? record.uuid ?? '');
    if (!id) return;
    const tokens = claudeTokens(message.usage);
    const known = answers.get(id);
    if (known) {
      for (const kind of Object.keys(tokens)) known.tokens[kind] = Math.max(known.tokens[kind], tokens[kind]);
      return;
    }
    answers.set(id, { day: dayOf(record.timestamp), model: message.model.slice(0, 80), fast: message.usage.speed === 'fast', tokens });
  }

  function codexLine(file, line) {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const state = rollouts.get(file) ?? { model: null, total: null };
    rollouts.set(file, state);
    if (record?.type === 'turn_context' && typeof record.payload?.model === 'string') {
      state.model = record.payload.model.slice(0, 80);
      return;
    }
    if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return;
    const total = record.payload.info?.total_token_usage;
    if (!total) return;
    const now = codexTokens(total);
    // A rollout is read from its start, so a resumed one's totals from before this run are where counting starts.
    const before = state.total ?? { input: 0, cacheRead: 0, output: 0, reasoning: 0 };
    state.total = now;
    if (!inWindow(record.timestamp)) return;
    const delta = {};
    let any = false;
    for (const kind of Object.keys(now)) {
      delta[kind] = Math.max(0, now[kind] - before[kind]);
      if (delta[kind]) any = true;
    }
    // A total that went down is a new count (a compacted or forked rollout): what it says now is all new.
    if (Object.keys(now).some((kind) => now[kind] < before[kind])) Object.assign(delta, now);
    if (any) add(codexRows, dayOf(record.timestamp), state.model ?? 'unknown', false, delta);
  }

  async function readAgent() {
    const claude = agent !== 'codex';
    const files = claude ? await filesUnder(claudeDir, /\.jsonl$/, sinceMs) : await filesUnder(codexDir, /^rollout-.*\.jsonl$/, sinceMs);
    // codex's totals are in order within a file: one read from where the last left off is enough.
    for (const file of files.sort()) {
      const cursor = cursors.get(file) ?? { offset: 0, rest: '' };
      cursors.set(file, cursor);
      for (const line of await newLines(file, cursor)) {
        if (claude) claudeLine(line);
        else codexLine(file, line);
      }
    }
    if (!claude) return [...codexRows.values()];
    const rows = new Map();
    for (const a of answers.values()) if (a.day) add(rows, a.day, a.model, a.fast, a.tokens);
    return [...rows.values()];
  }

  return { read: readAgent };
}

/** @returns {Promise<string>}  when this container started counting: the first call's time, kept in SINCE_FILE */
export async function usageSince(file = SINCE_FILE, now = () => new Date()) {
  try {
    const kept = (await fs.readFile(file, 'utf8')).trim();
    if (Number.isFinite(Date.parse(kept))) return new Date(kept).toISOString();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const since = now().toISOString();
  await fs.writeFile(file, since, { flag: 'wx' }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return (await fs.readFile(file, 'utf8')).trim() || since;
}

/**
 * statusd's `tokenUsage`, read at most every FRESH_MS.
 * @param {{agent: 'claude'|'codex', direct: () => boolean, billing: () => 'plan'|'api', until?: () => Promise<string|null>,
 *          sinceFile?: string, claudeDir?: string, codexDir?: string, now?: () => number}} opts
 *   `direct`: whether the agent calls its provider itself, so this session's transcripts are the only count of it
 * @returns {() => Promise<{since: string, agent: string, direct: boolean, billing: string, rows: object[]}|null>}
 */
export function createTokenUsage({ agent, direct, billing, until = async () => null, sinceFile = SINCE_FILE, claudeDir, codexDir, now = Date.now }) {
  let reader = null;
  let since = null;
  let end = null;
  let last = null;
  let lastAt = 0;
  return async function tokenUsage() {
    if (!direct()) return { since: null, agent, direct: false, billing: billing(), rows: [] };
    if (last && now() - lastAt < FRESH_MS) return last;
    since ??= await usageSince(sinceFile, () => new Date(now()));
    end = await until();
    reader ??= createTranscriptReader({ agent, since, until: () => end, claudeDir, codexDir });
    last = { since, agent, direct: true, billing: billing(), rows: await reader.read() };
    lastAt = now();
    return last;
  };
}
