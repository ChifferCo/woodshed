// The conversation so far, for a phone to scroll through on its own (statusd's `GET /transcript`). The terminal is the
// agent's screen: tmux keeps no scrollback of claude's full-screen view, and every swipe there is a round trip. The
// agent's own record of the conversation has it all: claude's transcript (~/.claude/projects/<repo>/<id>.jsonl) and
// codex's rollout ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl). Each is read from its end and shaped the same
// way: what the person asked, what the agent said, and a line for each tool it ran. Thinking and tool output are left
// out: the terminal and the Diff tab show those.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// How much of the end of a transcript is read: claude's hold every tool's output, so they run to many megabytes.
export const TAIL_BYTES = 4 * 1024 * 1024;
// The entries answered, the newest.
export const MAX_ENTRIES = 300;
// One entry's text is cut here: a pasted log or a long plan is still readable, and the answer stays small.
export const MAX_TEXT = 8000;
// A compressed rollout is read whole, so one past this is left alone.
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;

/** @typedef {{role: 'user'|'assistant'|'tool', text: string, tool?: string, at: string|null}} Entry */

const cut = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

// What a tool was asked, in a line: the command, the file, the pattern, or what it was for.
function toolLine(input) {
  if (typeof input === 'string') {
    try {
      return toolLine(JSON.parse(input));
    } catch {
      return input.split('\n')[0].slice(0, 300);
    }
  }
  if (!input || typeof input !== 'object') return '';
  for (const key of ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.split('\n')[0].slice(0, 300);
    if (Array.isArray(value) && value.length) return value.join(' ').slice(0, 300);
  }
  return '';
}

// Lines of a JSONL text; with `partial`, the first is the end of a line cut by the read and is dropped.
function records(text, partial) {
  const lines = text.split('\n');
  if (partial) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // The line being written as it was read.
    }
  }
  return out;
}

// Text claude's transcript keeps in a person's turn that the person did not write: a slash command's wrapper and
// output, a hook's or the harness's notes.
const NOT_TYPED = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification)>/;

/**
 * @param {string} text  the end of a claude transcript
 * @param {{partial?: boolean}} [opts]  partial: the text starts mid-line
 * @returns {Entry[]}
 */
export function parseClaudeTranscript(text, { partial = false } = {}) {
  const entries = [];
  for (const r of records(text, partial)) {
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain || r.isMeta || !r.message) continue;
    const at = typeof r.timestamp === 'string' ? r.timestamp : null;
    const content = typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : r.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (r.type === 'user' && NOT_TYPED.test(block.text)) continue;
        entries.push({ role: r.type, text: cut(block.text.trim()), at });
      } else if (block?.type === 'tool_use' && r.type === 'assistant') {
        entries.push({ role: 'tool', tool: String(block.name || 'tool'), text: toolLine(block.input), at });
      }
    }
  }
  return entries;
}

// What codex puts in the person's turn besides what they typed: its environment, the repo's instructions, and any
// other text that is one tag from start to end.
const CODEX_CONTEXT = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md)|^\s*<([a-z_]+)>[\s\S]*<\/\2>\s*$/;

/**
 * @param {string} text  the end of a codex rollout
 * @param {{partial?: boolean}} [opts]  partial: the text starts mid-line
 * @returns {Entry[]}
 */
export function parseCodexRollout(text, { partial = false } = {}) {
  const entries = [];
  for (const r of records(text, partial)) {
    const item = r.type === 'response_item' ? r.payload : null;
    if (!item) continue;
    const at = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant') && Array.isArray(item.content)) {
      const said = item.content
        .filter((c) => (c?.type === 'input_text' || c?.type === 'output_text') && typeof c.text === 'string')
        .map((c) => c.text)
        .filter((t) => t.trim() && !CODEX_CONTEXT.test(t))
        .join('\n\n')
        .trim();
      if (said) entries.push({ role: item.role, text: cut(said), at });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
      const input = item.arguments ?? item.input ?? item.action;
      entries.push({ role: 'tool', tool: String(item.name || 'shell'), text: toolLine(input), at });
    }
  }
  return entries;
}

// The end of a file, and whether it was cut.
async function tail(file, size) {
  const handle = await fs.open(file);
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(size - start), position: start });
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), partial: start > 0 };
  } finally {
    await handle.close();
  }
}

async function newestIn(dir, keep) {
  let names;
  try {
    names = (await fs.readdir(dir)).filter(keep);
  } catch {
    return null;
  }
  const stats = await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    return { file, stat: await fs.stat(file).catch(() => null) };
  }));
  return stats.filter((s) => s.stat).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0] ?? null;
}

// Codex files its rollouts by the day they started: the newest is in the last day folder that has one.
async function newestRollout(codexHome) {
  const root = path.join(codexHome, 'sessions');
  const desc = async (dir) => (await fs.readdir(dir).catch(() => [])).filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const year of await desc(root)) {
    for (const month of await desc(path.join(root, year))) {
      for (const day of await desc(path.join(root, year, month))) {
        const found = await newestIn(path.join(root, year, month, day), (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n));
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * The newest conversation of the session's agent, newest entries last.
 * @param {{agent: 'claude'|'codex', claudeDir: string, codexHome: string, limit?: number}} opts
 *   claudeDir: claude's transcript folder for the repo
 * @returns {Promise<{agent: string, entries: Entry[], partial: boolean, writtenAt: number|null}>}
 *   partial: older entries were left out, by the read or by the limit
 */
export async function readSessionTranscript({ agent, claudeDir, codexHome, limit = MAX_ENTRIES }) {
  const newest = agent === 'codex'
    ? await newestRollout(codexHome)
    : await newestIn(claudeDir, (n) => n.endsWith('.jsonl'));
  if (!newest) return { agent, entries: [], partial: false, writtenAt: null };
  let text;
  let partial = false;
  if (newest.file.endsWith('.zst')) {
    if (newest.stat.size > MAX_COMPRESSED_BYTES || typeof zlib.zstdDecompressSync !== 'function') {
      return { agent, entries: [], partial: true, writtenAt: newest.stat.mtimeMs };
    }
    text = zlib.zstdDecompressSync(await fs.readFile(newest.file)).toString('utf8');
  } else {
    ({ text, partial } = await tail(newest.file, newest.stat.size));
  }
  const all = agent === 'codex' ? parseCodexRollout(text, { partial }) : parseClaudeTranscript(text, { partial });
  const max = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(Number(limit)) || MAX_ENTRIES));
  return {
    agent,
    entries: all.slice(-max),
    partial: partial || all.length > max,
    writtenAt: newest.stat.mtimeMs,
  };
}
