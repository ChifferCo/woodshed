// The tokens this session's agent spent, by day and model, for the console's Usage page (console/usage.mjs). Nothing is
// fetched: claude writes each answer's `usage` into its transcripts (~/.claude/projects/**/*.jsonl, subagents' too),
// and codex its running total into its rollouts ($CODEX_HOME/sessions/**/rollout-*.jsonl, `token_count` events). Only
// what was spent since `since` counts: a private session's restored home brings earlier sessions' transcripts, which
// were counted by those sessions. Files are read from where the last read stopped, so a read costs a stat per file
// once the first has caught up. Counts only, never text.
//
// How the session pays for them (`billing`): `plan` for a Claude or ChatGPT subscription, `key` for an API key (the
// team's, through the console, or the owner's own).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
export const CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
// A first read of a file past this starts this far from its end: a transcript that big holds earlier sessions' turns,
// and its tail is what is new.
const FIRST_READ_BYTES = 32 * 1024 * 1024;
// One read's slice of a file.
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * @param {{WOODSHED_CLAUDE_AUTH?: string, WOODSHED_CODEX_AUTH?: string}} env
 * @param {'claude'|'codex'} agent
 * @param {object|null} codexAuth  codex's auth.json, parsed, or null
 * @returns {'plan'|'key'}
 */
export function billingOf(env, agent, codexAuth) {
  if (agent === 'codex') {
    if (env.WOODSHED_CODEX_AUTH === 'key') return 'key';
    if (codexAuth?.OPENAI_API_KEY) return 'key';
    return codexAuth?.tokens ? 'plan' : 'key';
  }
  // own: the owner's setup token; plan: a Claude plan through the console. Anything else is a key.
  return env.WOODSHED_CLAUDE_AUTH === 'own' || env.WOODSHED_CLAUDE_AUTH === 'plan' ? 'plan' : 'key';
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** @returns {{input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number}} */
export function claudeTokens(usage) {
  const split = usage?.cache_creation;
  const write1h = n(split?.ephemeral_1h_input_tokens);
  const write5m = split ? n(split.ephemeral_5m_input_tokens) : n(usage?.cache_creation_input_tokens);
  return { input: n(usage?.input_tokens), cacheWrite5m: write5m, cacheWrite1h: write1h, cacheRead: n(usage?.cache_read_input_tokens), output: n(usage?.output_tokens) };
}

/** codex's input counts its cached input in it; output counts its reasoning in it. */
export function codexTokens(usage) {
  const cached = n(usage?.cached_input_tokens);
  return { input: Math.max(0, n(usage?.input_tokens) - cached), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: cached, output: n(usage?.output_tokens) };
}

const KINDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];
const minus = (a, b) => Object.fromEntries(KINDS.map((k) => [k, Math.max(0, a[k] - (b?.[k] ?? 0))]));

/**
 * @param {{since: number, agent: 'claude'|'codex', claudeDir?: string, codexDir?: string}} opts  `since` in ms
 * @returns {{read: () => Promise<{since: string, days: Record<string, Record<string, Record<string, number>>>}>}}
 *   `days` is `{'2026-11-23': {'claude-opus-5-5': {input, cacheWrite5m, cacheWrite1h, cacheRead, output}}}`, UTC days
 */
export function tokenCounter({ since, agent, claudeDir = CLAUDE_DIR, codexDir = CODEX_DIR }) {
  const days = {};
  const files = new Map();
  // claude writes one line per content block of an answer, each with the answer's usage so far: an answer counts once,
  // at the largest numbers any of its lines gave.
  const answers = new Map();

  function add(day, model, tokens, sign = 1) {
    const byModel = (days[day] ??= {});
    const t = (byModel[model] ??= Object.fromEntries(KINDS.map((k) => [k, 0])));
    for (const k of KINDS) t[k] += sign * tokens[k];
  }

  function at(record) {
    const ms = Date.parse(record?.timestamp ?? '');
    return Number.isFinite(ms) ? ms : null;
  }

  function claudeLine(record) {
    if (record?.type !== 'assistant') return;
    const message = record.message;
    if (!message?.usage || typeof message.model !== 'string' || message.model.startsWith('<')) return;
    const ms = at(record);
    if (ms === null || ms < since) return;
    const model = message.usage.speed === 'fast' ? `${message.model}:fast` : message.model;
    const tokens = claudeTokens(message.usage);
    const id = typeof message.id === 'string' ? message.id : null;
    const day = new Date(ms).toISOString().slice(0, 10);
    if (!id) return add(day, model, tokens);
    const counted = answers.get(id);
    if (!counted) {
      answers.set(id, { day, model, tokens });
      return add(day, model, tokens);
    }
    const larger = Object.fromEntries(KINDS.map((k) => [k, Math.max(counted.tokens[k], tokens[k])]));
    add(counted.day, counted.model, minus(larger, counted.tokens));
    counted.tokens = larger;
  }

  function codexLine(record, state) {
    if (record?.type === 'turn_context' && typeof record.payload?.model === 'string') {
      state.model = record.payload.model;
      return;
    }
    if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return;
    const info = record.payload.info;
    if (!info?.total_token_usage) return;
    const total = codexTokens(info.total_token_usage);
    const sum = (t) => KINDS.reduce((s, k) => s + t[k], 0);
    // A total that went down is a new count (a compaction or a fork): the last answer alone is what is new.
    const delta = state.total && sum(total) >= sum(state.total) ? minus(total, state.total) : codexTokens(info.last_token_usage);
    state.total = total;
    const ms = at(record);
    if (ms === null || ms < since || !sum(delta)) return;
    add(new Date(ms).toISOString().slice(0, 10), state.model ?? 'unknown', delta);
  }

  async function list(dir, match) {
    let entries;
    try {
      entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries.filter((e) => e.isFile() && match.test(e.name)).map((e) => path.join(e.parentPath ?? e.path, e.name));
  }

  async function readFile(file, onRecord) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    // A file last written before `since` holds nothing of this session's, and is not read at all.
    if (stat.mtimeMs < since) return;
    let state = files.get(file);
    if (!state || stat.size < state.offset) {
      const start = stat.size > FIRST_READ_BYTES ? stat.size - FIRST_READ_BYTES : 0;
      state = { offset: start, rest: '', skipFirst: start > 0 };
      files.set(file, state);
    }
    if (stat.size === state.offset) return;
    const handle = await fs.open(file, 'r');
    try {
      while (state.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - state.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        const lines = (state.rest + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
        state.rest = lines.pop();
        if (state.skipFirst) {
          lines.shift();
          state.skipFirst = false;
        }
        for (const line of lines) {
          if (!line.includes('"usage"') && !line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          onRecord(record, state);
        }
      }
    } finally {
      await handle.close();
    }
  }

  return {
    async read() {
      if (agent === 'codex') {
        for (const file of await list(codexDir, /^rollout-.*\.jsonl$/)) await readFile(file, codexLine);
      } else {
        for (const file of await list(claudeDir, /\.jsonl$/)) await readFile(file, claudeLine);
      }
      return { since: new Date(since).toISOString(), days: structuredClone(days) };
    },
  };
}
