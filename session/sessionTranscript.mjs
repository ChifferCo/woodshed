// The conversation so far, for a phone to scroll through on its own (statusd's `GET /transcript`). The terminal is the
// agent's screen, and its scrollback holds only what came since the browser attached, as terminal output. The
// agent's own record of the conversation has it all: claude's transcript (~/.claude/projects/<repo>/<id>.jsonl) and
// codex's rollout ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl). Each is read from its end and shaped the same
// way: what the person asked, what the agent said, and a line for each tool it ran, marked `error` when the run failed.
// An edit carries what it changed, a small bounded diff (transcriptDiff.mjs), for the Chat to show each turn's changes.
// Thinking and tool output are left out: the terminal shows those, and the Diff tab the whole branch. The console's Chat tab draws the
// conversation from this, and asks again with `since` (the last answer's writtenAt): an agent that wrote nothing since
// costs a stat, not a read.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { capDiffs, claudeInputDiffs, claudeResultDiffs, parsePatch, scriptPatches, shellPatch } from './transcriptDiff.mjs';

// How much of the end of a transcript is read: claude's hold every tool's output, so they run to many megabytes.
export const TAIL_BYTES = 4 * 1024 * 1024;
// The entries answered, the newest.
export const MAX_ENTRIES = 300;
// One entry's text is cut here: a pasted log or a long plan is still readable, and the answer stays small.
export const MAX_TEXT = 8000;
// A compressed rollout is read whole, so one past this is left alone.
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
// And one that unpacks past this is left alone too: zstd packs repeated tool output many times over, and statusd
// unpacks it in one go.
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {{role: 'user'|'assistant'|'tool', text: string, tool?: string, error?: true, denied?: string, diffs?: object[],
 *   at: string|null}} Entry
 *   denied: on codex's interrupt note, the command whose approval was refused. diffs: what an edit changed, file by
 *   file (transcriptDiff.mjs); an edit that failed has none.
 */

const cut = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

// What a tool was asked, in a line: the command, the file, the pattern, or what it was for.
// The files a codex patch (apply_patch's input) changes.
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

function toolLine(input) {
  if (typeof input === 'string' && input.startsWith('*** Begin Patch')) {
    const files = [...input.matchAll(PATCH_FILE)].map((m) => m[1].trim());
    if (files.length) return files.join(' ').slice(0, 300);
  }
  if (typeof input === 'string') {
    try {
      return toolLine(JSON.parse(input));
    } catch {
      return input.split('\n')[0].slice(0, 300);
    }
  }
  if (!input || typeof input !== 'object') return '';
  // codex runs a shell command as ["bash", "-lc", "<command>"]: the command is what was run.
  const argv = input.command;
  if (Array.isArray(argv) && argv.length === 3 && /^(ba|z)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1]) && typeof argv[2] === 'string') {
    return argv[2].split('\n')[0].slice(0, 300);
  }
  for (const key of ['description', 'command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.split('\n')[0].slice(0, 300);
    if (Array.isArray(value) && value.length) return value.join(' ').slice(0, 300);
  }
  return '';
}

// What claude's AskUserQuestion asks, for the Chat tab to show over the work log: each question and its options' labels.
// claude takes the answer in its terminal: the TUI tab, or the Chat tab's picks, which statusd types there
// (panePrompt.mjs).
function askedQuestions(block) {
  const list = block.name === 'AskUserQuestion' && Array.isArray(block.input?.questions) ? block.input.questions : [];
  const questions = list.filter((q) => typeof q?.question === 'string' && q.question.trim()).slice(0, 4).map((q) => ({
    question: q.question.trim().slice(0, 500),
    options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o?.label ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, 8),
    // Each option's description, as claude draws it under the label: what tells a wrapped label from its description.
    descriptions: (Array.isArray(q.options) ? q.options : []).filter((o) => String(o?.label ?? '').trim())
      .map((o) => String(o?.description ?? '').trim().slice(0, 300)).slice(0, 8),
    // A question that takes several options is picked in the terminal: the Chat tab answers one option a question.
    ...(q.multiSelect === true && { multiSelect: true }),
  }));
  return questions.length ? questions : null;
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

// A tool_result's text, for what claude said of the edit ("has been updated").
const resultText = (block) => (typeof block.content === 'string' ? block.content
  : Array.isArray(block.content) ? block.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '');

// claude's record of a slash command: `<command-name>/mcp</command-name> <command-message>mcp</command-message>
// <command-args>notion</command-args>`. Its output (`<local-command-stdout>`) is not the person's.
// Only a record that is that wrapper and nothing else: a prompt that quotes a tag in its prose is the prompt.
const COMMAND_WRAPPER = /^\s*(?:<command-(name|message|args)>[^<]*<\/command-\1>\s*)+$/;

function typedCommand(text) {
  if (!COMMAND_WRAPPER.test(text)) return null;
  const name = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/**
 * @param {string} text  the end of a claude transcript
 * @param {{partial?: boolean, root?: string}} [opts]  partial: the text starts mid-line. root: the repo, which an
 *   edit's path is given relative to
 * @returns {Entry[]}
 */
export function parseClaudeTranscript(text, { partial = false, root } = {}) {
  const entries = [];
  // Each tool run by its id, for the result claude files in the next turn: is_error says it failed.
  const tools = new Map();
  for (const r of records(text, partial)) {
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain || r.isMeta || !r.message) continue;
    const at = typeof r.timestamp === 'string' ? r.timestamp : null;
    const content = typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : r.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        // A slash command the person typed, which claude keeps in tags: the command as typed, for Chat to show and to
        // know it arrived.
        const command = r.type === 'user' ? typedCommand(block.text) : null;
        if (command) {
          entries.push({ role: 'user', text: cut(command), at });
          continue;
        }
        if (r.type === 'user' && NOT_TYPED.test(block.text)) continue;
        entries.push({ role: r.type, text: cut(block.text.trim()), at });
      } else if (block?.type === 'tool_use' && r.type === 'assistant') {
        const entry = { role: 'tool', tool: String(block.name || 'tool'), text: toolLine(block.input), at };
        const questions = askedQuestions(block);
        if (questions) Object.assign(entry, { text: questions[0].question, questions });
        const diffs = claudeInputDiffs(entry.tool, block.input, { root });
        if (diffs) entry.diffs = diffs;
        if (typeof block.id === 'string') tools.set(block.id, entry);
        entries.push(entry);
      } else if (block?.type === 'tool_result') {
        const entry = tools.get(block.tool_use_id);
        if (entry && block.is_error === true) {
          entry.error = true;
          // An edit that failed changed nothing.
          delete entry.diffs;
        } else if (entry?.questions) entry.answered = true;
        else if (entry?.diffs) {
          // The result's own hunks, when it is this edit's: a record holds one result's toolUseResult.
          const single = content.filter((b) => b?.type === 'tool_result').length === 1;
          const diffs = claudeResultDiffs(entry.tool, single ? r.toolUseResult : null, entry.diffs, resultText(block), { root });
          if (diffs) entry.diffs = diffs;
        }
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
// Whether a codex tool's output says it failed: a shell call's output is JSON with its exit code in `metadata`, or text
// that starts `Exit code: N`.
function codexFailed(output) {
  const text = typeof output === 'string' ? output : typeof output?.content === 'string' ? output.content : null;
  if (text === null) return false;
  try {
    const code = JSON.parse(text)?.metadata?.exit_code;
    if (typeof code === 'number') return code !== 0;
  } catch {
    // Plain text.
  }
  const match = /^Exit code: (\d+)/.exec(text);
  return Boolean(match) && match[1] !== '0';
}

// codex 0.16x runs its tools from a script: one `exec` call whose input is JavaScript such as
// `text(await tools.exec_command({cmd:"npm test"}))`. Each tool the script calls, with its command or path, so the
// work log says what was run rather than the script.
const SCRIPT_CALL = /\btools\.([A-Za-z_][\w]*)\s*\(/g;
const SCRIPT_ARG = /\b(cmd|command|path|file_path|pattern|query|url)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/;

// What a script calls that is not work of its own: `wait` reads a command still running, already in the log.
const SCRIPT_QUIET = new Set(['wait']);

function scriptValue(literal) {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal);
    } catch {
      // Not JSON's escapes: shown as written.
    }
  }
  return literal.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
}

/**
 * @returns {{tool: string, text: string, diffs?: object[]}[]|null}  the tools an `exec` script calls, or null for any
 *   other input. Its apply_patch calls take the script's patches in order, each named by its files
 */
export function codexScriptCalls(name, input, { root, quiet = false } = {}) {
  if (name !== 'exec' || typeof input !== 'string') return null;
  const starts = [...input.matchAll(SCRIPT_CALL)];
  if (!starts.length) return null;
  const patches = scriptPatches(input);
  return starts.map((m, i) => {
    if (m[1] === 'apply_patch' && patches.length) {
      const diffs = parsePatch(patches.shift(), { root });
      return { tool: m[1], text: diffs.map((d) => d.path).join(' ').slice(0, 300), ...(diffs.length && { diffs }) };
    }
    const args = input.slice(m.index + m[0].length, starts[i + 1]?.index ?? input.length);
    const arg = SCRIPT_ARG.exec(args);
    return { tool: m[1], text: arg ? scriptValue(arg[2]).split('\n')[0].slice(0, 300) : '' };
  }).filter((c) => quiet || !SCRIPT_QUIET.has(c.tool));
}

// The script tools whose answer is a command's output, with its exit_code: the start of one, or the rest of one still
// running. An exit code belongs to one of these, in the order they were called, and to no other tool.
const SCRIPT_EXEC = new Set(['exec_command', 'write_stdin', 'wait', 'shell', 'local_shell', 'unified_exec']);
// Of those, the ones that start a command of their own, with an entry in the work log.
const SCRIPT_STARTS = new Set(['exec_command', 'shell', 'local_shell', 'unified_exec']);

// The diffs of a codex tool call that patches: apply_patch's input, or a shell call that runs apply_patch.
function codexDiffs(input, root) {
  let patch = typeof input === 'string' && input.trimStart().startsWith('*** Begin Patch') ? input : null;
  if (!patch) {
    let args = input;
    if (typeof input === 'string') {
      try {
        args = JSON.parse(input);
      } catch {
        args = null;
      }
    }
    patch = shellPatch(args?.command);
  }
  const diffs = patch ? parsePatch(patch, { root }) : [];
  return diffs.length ? diffs : null;
}

// What an `exec` script's output says when it threw, and what apply_patch answers once it applied a patch.
const SCRIPT_ERROR = /^\s*Script error/;
const PATCH_APPLIED = /Success\. Updated the following files/;

// The exit codes in an `exec` script's output: one JSON part per command it ran, each with its `exit_code`.
function scriptExitCodes(output) {
  if (!Array.isArray(output)) return [];
  const codes = [];
  for (const part of output) {
    if (typeof part?.text !== 'string' || !part.text.trimStart().startsWith('{')) continue;
    try {
      const code = JSON.parse(part.text)?.exit_code;
      if (typeof code === 'number') codes.push(code);
    } catch {
      // Not one of them.
    }
  }
  return codes;
}

// codex 0.16x's mark of a tool call cut short: the call's whole output, when Esc (or No at its approval) ended the turn.
const CODEX_ABORTED = /^aborted by user\b/;
// A call that asked to run outside the sandbox: codex showed its approval before running it.
const CODEX_ESCALATED = /\bsandbox_permissions["']?\s*:\s*["']require_escalated["']|"with_escalated_permissions"\s*:\s*true/;
// What the developer turn after an interrupt starts with, in rollouts that write no turn_aborted event.
const CODEX_TURN_ABORTED = /^\s*<turn_aborted>/;

/**
 * The note for a codex turn cut short, written as claude writes its own (`[Request interrupted by user]`), so the Chat
 * tab reads both the same, and a console from before it still says Interrupted. `denied`: the command whose approval
 * was refused, when the call cut short was one asking to run outside the sandbox and had no output yet. codex writes the
 * same records for No at its approval and for Esc there, which is the same key ((esc) on the No option).
 */
function codexInterrupt(at, denied) {
  return { role: 'user', text: '[Request interrupted by user]', at, ...(denied && { denied }) };
}

export function parseCodexRollout(text, { partial = false, root } = {}) {
  const entries = [];
  const tools = new Map();
  // The call whose output said it was cut short, since the last thing after it: an approval refused when it asked to
  // run outside the sandbox.
  let aborted = null;
  const interrupted = (at) => {
    const last = entries[entries.length - 1];
    if (!(last?.role === 'user' && last.text === '[Request interrupted by user]')) entries.push(codexInterrupt(at, aborted?.denied ?? null));
    aborted = null;
  };
  for (const r of records(text, partial)) {
    const at = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (r.type === 'event_msg' && r.payload?.type === 'turn_aborted') {
      // `replaced` is a turn a new message took over: that message comes next, and says so itself.
      if (r.payload.reason !== 'replaced') interrupted(at);
      continue;
    }
    const item = r.type === 'response_item' ? r.payload : null;
    if (!item) continue;
    if (item.type === 'message' && item.role === 'developer' && Array.isArray(item.content)
      && item.content.some((c) => typeof c?.text === 'string' && CODEX_TURN_ABORTED.test(c.text))) {
      interrupted(at);
      continue;
    }
    if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant') && Array.isArray(item.content)) {
      aborted = null;
      const said = item.content
        .filter((c) => (c?.type === 'input_text' || c?.type === 'output_text') && typeof c.text === 'string')
        .map((c) => c.text)
        .filter((t) => t.trim() && !CODEX_CONTEXT.test(t))
        .join('\n\n')
        .trim();
      if (said) entries.push({ role: item.role, text: cut(said), at });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
      const input = item.arguments ?? item.input ?? item.action;
      const calls = codexScriptCalls(item.name, input, { root });
      const diffs = calls ? null : codexDiffs(input, root);
      // A shell call that ran apply_patch is the patch: named by its files, and an edit in the work log.
      const one = diffs ? { tool: 'apply_patch', text: diffs.map((d) => d.path).join(' ').slice(0, 300), diffs } : { tool: String(item.name || 'shell'), text: toolLine(input) };
      const made = (calls ?? [one]).map((c) => ({ role: 'tool', ...c, at }));
      // Which call each exit code answers: only a script's own commands, each with its entry. A `wait` or `write_stdin`
      // reads a command started before, maybe in another script, so its code is no entry's here.
      if (calls) {
        const left = [...made];
        made.execs = codexScriptCalls(item.name, input, { quiet: true })
          .filter((c) => SCRIPT_EXEC.has(c.tool))
          .map((c) => {
            if (!SCRIPT_STARTS.has(c.tool)) return null;
            const i = left.findIndex((e) => e?.tool === c.tool);
            if (i === -1) return null;
            const own = left[i];
            left.fill(null, 0, i + 1);
            return own;
          });
      }
      if (typeof item.call_id === 'string') tools.set(item.call_id, made);
      const raw = typeof input === 'string' ? input : JSON.stringify(input ?? null);
      if (CODEX_ESCALATED.test(raw)) made.escalated = true;
      aborted = null;
      entries.push(...made);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const made = tools.get(item.call_id);
      if (!made?.length) continue;
      if (typeof item.output === 'string' && CODEX_ABORTED.test(item.output)) {
        aborted = { denied: made.escalated ? made[made.length - 1].text || null : null };
        continue;
      }
      aborted = null;
      const codes = scriptExitCodes(item.output);
      // Each exit code to the command it answers, when the script's commands and its codes line up one to one. When
      // they do not, or a code answers a wait on a command started elsewhere, the failure is the script's, said as
      // such: never pinned on a tool that did not fail. A script's patches answer no exit code: one that threw before
      // any patch said it applied leaves them failed.
      if (codes.length && made.execs) {
        const lined = made.execs.length === codes.length;
        let unplaced = false;
        codes.forEach((code, i) => {
          if (code === 0) return;
          const own = lined ? made.execs[i] : null;
          if (own) own.error = true;
          else unplaced = true;
        });
        if (unplaced) entries.push({ role: 'tool', tool: 'exec', text: 'a command in this script failed', at: made[made.length - 1].at, error: true });
      } else if (codes.length) {
        if (codes.some((c) => c !== 0)) made[made.length - 1].error = true;
      } else if (codexFailed(item.output)) made[made.length - 1].error = true;
      const said = Array.isArray(item.output) ? item.output.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n') : '';
      if (SCRIPT_ERROR.test(said) && !PATCH_APPLIED.test(said)) for (const e of made) if (e.tool === 'apply_patch') e.error = true;
      for (const e of made) if (e.error) delete e.diffs;
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
 * @param {{agent: 'claude'|'codex', claudeDir: string, codexHome: string, root?: string, limit?: number, since?: number}} opts
 *   claudeDir: claude's transcript folder for the repo. root: the repo, which edits' paths are given relative to.
 *   since: the writtenAt of the caller's last answer
 * @returns {Promise<{agent: string, entries: Entry[], partial: boolean, writtenAt: number|null}|{agent: string, unchanged: true, writtenAt: number}>}
 *   partial: older entries were left out, by the read or by the limit. unchanged: the newest record is still the
 *   one written at `since`, so the caller's entries stand
 */
export async function readSessionTranscript({ agent, claudeDir, codexHome, root, limit = MAX_ENTRIES, since = null }) {
  const newest = agent === 'codex'
    ? await newestRollout(codexHome)
    : await newestIn(claudeDir, (n) => n.endsWith('.jsonl'));
  if (!newest) return { agent, entries: [], partial: false, writtenAt: null };
  if (since !== null && newest.stat.mtimeMs === since) return { agent, unchanged: true, writtenAt: since };
  let text;
  let partial = false;
  if (newest.file.endsWith('.zst')) {
    if (newest.stat.size > MAX_COMPRESSED_BYTES || typeof zlib.zstdDecompressSync !== 'function') {
      return { agent, entries: [], partial: true, writtenAt: newest.stat.mtimeMs };
    }
    try {
      text = zlib.zstdDecompressSync(await fs.readFile(newest.file), { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8');
    } catch (err) {
      if (err?.code !== 'ERR_BUFFER_TOO_LARGE') throw err;
      return { agent, entries: [], partial: true, writtenAt: newest.stat.mtimeMs };
    }
  } else {
    ({ text, partial } = await tail(newest.file, newest.stat.size));
  }
  const all = agent === 'codex' ? parseCodexRollout(text, { partial, root }) : parseClaudeTranscript(text, { partial, root });
  const max = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(Number(limit)) || MAX_ENTRIES));
  return {
    agent,
    // The newest edits keep their hunks within the answer's bound; older ones their files and counts.
    entries: capDiffs(all.slice(-max)),
    partial: partial || all.length > max,
    writtenAt: newest.stat.mtimeMs,
  };
}
