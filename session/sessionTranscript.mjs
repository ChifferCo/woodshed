// The conversation so far, for a phone to scroll through on its own (statusd's `GET /transcript`). The terminal is the
// agent's screen, and its scrollback holds only what came since the browser attached, as terminal output. The
// agent's own record of the conversation has it all: claude's transcript (~/.claude/projects/<repo>/<id>.jsonl),
// codex's rollout ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl), Grok Build's session log
// (~/.grok/sessions/<cwd, URL-encoded>/<id>/updates.jsonl), OpenCode's database (~/.local/share/opencode/opencode.db) and Antigravity CLI's
// transcript_full.jsonl (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/).
// Each is read from its end and shaped the same way: what the person asked, what the agent said, and a line for each
// tool it ran, marked `error` when the run failed.
// An edit carries what it changed, a small bounded diff (transcriptDiff.mjs), for the Chat to show each turn's changes.
// Thinking and tool output are left out: the terminal shows those, and the Diff tab the whole branch. The console's Chat tab draws the
// conversation from this, and asks again with `since` (the last answer's writtenAt): an agent that wrote nothing since
// costs a stat, not a read.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { capDiffs, claudeInputDiffs, claudeResultDiffs, parsePatch, scriptPatches, shellPatch, textDiff } from './transcriptDiff.mjs';

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
  for (const key of ['description', 'command', 'cmd', 'command_line', 'file_path', 'filePath', 'target_file', 'absolute_path', 'absolute_path_uri', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
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

// ---- Grok Build: ~/.grok/sessions/<cwd>/<id>/updates.jsonl, its authoritative log. Each line is an ACP notification,
// `{timestamp: <unix seconds>, method: 'session/update', params: {sessionId, update: {sessionUpdate, …}}}`: the person's
// and the agent's words arrive in chunks, joined here into one entry each, and each tool as a `tool_call` that later
// `tool_call_update`s say finished or failed. Thoughts, plans and the command list are not the conversation.
// From xAI's grok-build source (1.0.45) and docs: not yet read from a real 1.0.92 session.

const ACP_TEXT = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(ACP_TEXT).join('')
    : content?.type === 'text' && typeof content.text === 'string' ? content.text : '');

// An ACP tool call's diffs: its `content` items of `{type: 'diff', path, oldText, newText}`.
function acpDiffs(content, root) {
  const diffs = (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === 'diff')
    .map((c) => textDiff(c.path, c.oldText, c.newText, { root }))
    .filter(Boolean);
  return diffs.length ? diffs : null;
}

const unixAt = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t < 1e12 ? t * 1000 : t).toISOString()
  : typeof t === 'string' ? t : null);

/**
 * @param {string} text  the end of a Grok Build updates.jsonl
 * @param {{partial?: boolean, root?: string}} [opts]
 * @returns {Entry[]}
 */
export function parseGrokUpdates(text, { partial = false, root } = {}) {
  const entries = [];
  const tools = new Map();
  // The entry the next chunk of the same role adds to: any other update between them starts a new one.
  let open = null;
  for (const r of records(text, partial)) {
    const u = r?.params?.update;
    if (!u || typeof u.sessionUpdate !== 'string') continue;
    const at = unixAt(r.timestamp);
    const kind = u.sessionUpdate;
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      const role = kind === 'user_message_chunk' ? 'user' : 'assistant';
      const said = ACP_TEXT(u.content);
      if (!said) continue;
      if (open?.role === role) open.text += said;
      else {
        open = { role, text: said, at };
        entries.push(open);
      }
      continue;
    }
    // A thought between two chunks of the reply is not the reply: it neither starts nor ends it.
    if (kind === 'agent_thought_chunk') continue;
    open = null;
    if (kind === 'tool_call') {
      const input = u.rawInput ?? null;
      const entry = { role: 'tool', tool: String(u.kind || u.title || 'tool'), text: toolLine(input) || String(u.title ?? '').split('\n')[0].slice(0, 300), at };
      const diffs = acpDiffs(u.content, root);
      if (diffs) entry.diffs = diffs;
      if (u.status === 'failed') entry.error = true;
      if (typeof u.toolCallId === 'string') tools.set(u.toolCallId, entry);
      entries.push(entry);
    } else if (kind === 'tool_call_update') {
      const entry = tools.get(u.toolCallId);
      if (!entry) continue;
      if (!entry.text && (u.rawInput || u.title)) entry.text = toolLine(u.rawInput) || String(u.title ?? '').split('\n')[0].slice(0, 300);
      const diffs = acpDiffs(u.content, root);
      if (diffs) entry.diffs = diffs;
      if (u.status === 'failed') {
        entry.error = true;
        delete entry.diffs;
      }
    }
    // `rewind_marker` branches the log back to an earlier turn; the record does not say in a form read here which
    // entries it drops, so a rewound turn stays in the Chat as it was said. Plans and the command list are skipped.
  }
  for (const e of entries) if (e.role !== 'tool') e.text = cut(e.text.trim());
  return entries.filter((e) => e.role === 'tool' || e.text);
}

// ---- Antigravity CLI: the conversation's transcript_full.jsonl, in its brain folder
// (~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/), one JSON step a line: USER_INPUT (the
// message, in <USER_REQUEST> tags among its metadata), PLANNER_RESPONSE (the model's words, or `tool_calls`), and a step
// after each tool call with `status` DONE, ERROR (refused or failed: `error` says why) or INVALID. Measured with agy 1.5.18.
// transcript.jsonl beside it is the same with each argument JSON-encoded a second time ("\"ls\""), which is undone here.

const AGY_REQUEST = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;
const AGY_PATH_KEYS = ['Path', 'AbsolutePath', 'TargetFile', 'SearchPath', 'DirectoryPath'];

// An argument as the model gave it: transcript.jsonl keeps each value as JSON text.
function agyArg(value) {
  if (typeof value !== 'string' || !/^["[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function agyToolLine(args) {
  for (const key of ['CommandLine', ...AGY_PATH_KEYS, 'Url', 'query', 'Query', 'Pattern', 'toolSummary', 'Prompt']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.split('\n')[0].slice(0, 300);
  }
  return '';
}

// What an edit changed, from the arguments the model gave: edit_file's Target and Replacement, write_file's Content.
function agyDiffs(name, args, root) {
  if (name === 'edit_file' && typeof args.Path === 'string' && typeof args.Target === 'string' && typeof args.Replacement === 'string') {
    const diff = textDiff(args.Path, args.Target, args.Replacement, { root });
    return diff ? [diff] : null;
  }
  if (name === 'write_file' && typeof args.Path === 'string' && typeof args.Content === 'string' && !args.Append && !args.Overwrite) {
    const diff = textDiff(args.Path, null, args.Content, { root });
    return diff ? [diff] : null;
  }
  return null;
}

/**
 * @param {string} text  the end of an agy transcript_full.jsonl
 * @param {{partial?: boolean, root?: string, planPrefix?: boolean}} [opts]  planPrefix: the session runs in plan mode,
 *   where agy writes `/plan ` before each message: the person's own words are what is shown
 * @returns {Entry[]}
 */
export function parseAntigravityTranscript(text, { partial = false, root, planPrefix = false } = {}) {
  const entries = [];
  // The tool entries still waiting for their result step, oldest first.
  const waiting = [];
  for (const r of records(text, partial)) {
    const at = typeof r?.created_at === 'string' ? r.created_at : null;
    if (r?.type === 'USER_INPUT') {
      let said = typeof r.content === 'string' ? (AGY_REQUEST.exec(r.content)?.[1] ?? r.content.split('<ADDITIONAL_METADATA>')[0]) : '';
      if (planPrefix) said = said.replace(/^\/plan /, '');
      said = said.trim();
      if (said) entries.push({ role: 'user', text: cut(said), at });
    } else if (r?.type === 'PLANNER_RESPONSE') {
      if (typeof r.content === 'string' && r.content.trim()) entries.push({ role: 'assistant', text: cut(r.content.trim()), at });
      for (const call of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
        if (typeof call?.name !== 'string') continue;
        const args = Object.fromEntries(Object.entries(call.args && typeof call.args === 'object' ? call.args : {}).map(([k, v]) => [k, agyArg(v)]));
        const entry = { role: 'tool', tool: call.name.slice(0, 60), text: agyToolLine(args), at };
        const diffs = agyDiffs(call.name, args, root);
        if (diffs) entry.diffs = diffs;
        entries.push(entry);
        waiting.push(entry);
      }
    } else if (r?.source === 'MODEL' && waiting.length) {
      const entry = waiting.shift();
      if (r.status === 'ERROR' || r.status === 'INVALID') {
        entry.error = true;
        delete entry.diffs;
      }
    }
  }
  return entries;
}

/**
 * The transcript an agy conversation writes, from the hook state its own hooks left (hookState.mjs agy): the path agy named,
 * checked to be where it keeps one (never a path a hook's payload could make up), and its `transcript_full.jsonl`.
 * @param {{transcript?: string|null}|null} hook
 * @returns {string|null}  null before agy's first message
 */
export function antigravityRecord(hook, home = os.homedir()) {
  const named = typeof hook?.transcript === 'string' ? hook.transcript : '';
  const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain') + path.sep;
  const rest = named.startsWith(brain) ? named.slice(brain.length) : '';
  return /^[0-9a-f-]{36}\/\.system_generated\/logs\/transcript(_full)?\.jsonl$/.test(rest)
    ? path.join(brain, rest.replace(/transcript\.jsonl$/, 'transcript_full.jsonl'))
    : null;
}

/** @returns {string}  a folder name as Grok Build makes one from a path (Rust's urlencoding::encode) */
export function grokFolderName(dir) {
  return [...Buffer.from(String(dir), 'utf8')].map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

// The newest updates.jsonl of the checkout's sessions: its folder by name, or by the `.cwd` a long path's folder holds.
// With none for the checkout, the newest of any, as codex's rollouts are read.
async function newestGrokUpdates(grokHome, root, { skip, conversation }) {
  const base = path.join(grokHome, 'sessions');
  const dirs = await fs.readdir(base).catch(() => []);
  const mine = [];
  for (const d of dirs) {
    if (root && d === grokFolderName(root)) mine.push(d);
    else if (root) {
      const cwd = await fs.readFile(path.join(base, d, '.cwd'), 'utf8').catch(() => null);
      if (cwd?.trim() === root) mine.push(d);
    }
  }
  const newestOf = async (list) => {
    let best = null;
    for (const d of list) {
      for (const id of await fs.readdir(path.join(base, d)).catch(() => [])) {
        if (skip?.has(id) || (conversation && conversation !== id)) continue;
        const file = path.join(base, d, id, 'updates.jsonl');
        const stat = await fs.stat(file).catch(() => null);
        if (stat?.isFile() && (!best || stat.mtimeMs > best.stat.mtimeMs)) best = { file, stat };
      }
    }
    return best;
  };
  return (await newestOf(mine)) ?? (mine.length ? null : await newestOf(dirs));
}

// ---- OpenCode: its SQLite database, ~/.local/share/opencode/opencode.db (OpenCode 1.19, tables session, message and
// part, each row's `data` JSON without its ids). Read with node's own SQLite, read-only, newest root session of the
// checkout first. A tool part's `state` says whether it ran (`completed`) or failed (`error`); an edit's input holds its
// old and new text, a write its content, a patch its `*** Begin Patch` text.

// The most messages read back from the end of a conversation.
const OPENCODE_MESSAGES = 400;

let sqliteModule;
// node:sqlite warns that it is experimental on first load: statusd's log is not the place for it.
async function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning))) return undefined;
    return emit.call(this, warning, ...rest);
  };
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqliteModule;
}

/** @returns {string}  where OpenCode keeps its database for this home */
export function openCodeDb(home, env = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'opencode.db');
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const msAt = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : null);

// An OpenCode tool call's diffs: an edit's old and new text, a write's content, a patch's text.
function openCodeDiffs(tool, input, root) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.patchText === 'string') {
    const diffs = parsePatch(input.patchText, { root });
    return diffs.length ? diffs : null;
  }
  if (tool === 'edit' && typeof input.oldString === 'string') {
    const d = textDiff(input.filePath, input.oldString, input.newString, { root });
    return d ? [d] : null;
  }
  if (tool === 'write' && typeof input.content === 'string') {
    const d = textDiff(input.filePath, null, input.content, { root });
    return d ? [d] : null;
  }
  return null;
}

/**
 * The entries of OpenCode's messages and their parts, oldest first.
 * @param {{role: string, data: object, at: number|null, parts: object[]}[]} messages
 * @returns {Entry[]}
 */
export function openCodeEntries(messages, { root } = {}) {
  const entries = [];
  for (const m of messages) {
    const at = msAt(m.data?.time?.created ?? m.at);
    if (m.data?.role === 'user') {
      const said = m.parts.filter((p) => p?.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string').map((p) => p.text).join('\n\n').trim();
      if (said) entries.push({ role: 'user', text: cut(said), at });
      continue;
    }
    if (m.data?.role !== 'assistant') continue;
    for (const p of m.parts) {
      const pat = msAt(p?.time?.start ?? p?.state?.time?.start) ?? at;
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim() && !p.synthetic) {
        entries.push({ role: 'assistant', text: cut(p.text.trim()), at: pat });
      } else if (p?.type === 'tool' && p.state) {
        const input = p.state.input ?? null;
        const entry = { role: 'tool', tool: String(p.tool || 'tool'), text: toolLine(input) || String(p.state.title ?? '').slice(0, 300), at: pat };
        if (p.state.status === 'error') entry.error = true;
        else {
          const diffs = openCodeDiffs(entry.tool, input, root);
          if (diffs) entry.diffs = diffs;
        }
        entries.push(entry);
      }
    }
    // Esc ends a turn with the assistant message's error: the same note claude writes.
    if (m.data?.error?.name === 'MessageAbortedError') entries.push({ role: 'user', text: '[Request interrupted by user]', at });
  }
  return entries;
}

/**
 * The newest OpenCode conversation of the checkout, from its database.
 * @returns {Promise<{entries: Entry[], partial: boolean, writtenAt: number}|{unchanged: true, writtenAt: number}|null>}
 *   null: no database, no node:sqlite, or no conversation in the checkout yet
 */
export async function readOpenCode({ dbFile, root, since = null }) {
  if (!(await fs.stat(dbFile).catch(() => null))) return null;
  const mod = await sqlite();
  if (!mod?.DatabaseSync) return null;
  let db;
  try {
    db = new mod.DatabaseSync(dbFile, { readOnly: true });
    const session = db.prepare(`SELECT id, time_updated FROM session WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL
      ORDER BY time_updated DESC LIMIT 1`).get(root);
    if (!session) return null;
    const latest = db.prepare('SELECT MAX(time_updated) AS t FROM part WHERE session_id = ?').get(session.id)?.t ?? 0;
    const writtenAt = Math.max(Number(session.time_updated) || 0, Number(latest) || 0);
    if (since !== null && writtenAt === since) return { unchanged: true, writtenAt };
    const rows = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?')
      .all(session.id, OPENCODE_MESSAGES + 1);
    const partial = rows.length > OPENCODE_MESSAGES;
    const kept = rows.slice(0, OPENCODE_MESSAGES).reverse();
    const byId = new Map(kept.map((r) => [r.id, { data: parseJson(r.data) ?? {}, at: Number(r.time_created) || null, parts: [] }]));
    if (kept.length) {
      const parts = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? AND time_created >= ? ORDER BY time_created, id')
        .all(session.id, Number(kept[0].time_created) || 0);
      for (const p of parts) byId.get(p.message_id)?.parts.push(parseJson(p.data) ?? {});
    }
    return { entries: openCodeEntries([...byId.values()], { root }), partial, writtenAt };
  } catch {
    // A database mid-migration or of another shape: nothing to say yet.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
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

/**
 * The conversation claude writes to in this session: the newest transcript in its folder, of those this session wrote
 * (changed since `writtenFrom`) or reopened (`resume`, the conversation a Resume gave `--resume`). A private session
 * starts from its owner's Claude home, which holds their earlier conversations on the repo, one of them maybe another
 * session's that is still running; until claude writes its first line here, none of them is this session's.
 * @param {string} claudeDir  claude's transcript folder for the repo
 * @param {{writtenFrom?: number, resume?: string|null, skip?: Set<string>|null}} [opts]  writtenFrom: when the home was
 *   restored, in ms (0: all). skip: the names of the session's other claudes' transcripts (agents.mjs), never this one
 * @returns {Promise<{name: string, file: string, stat: import('node:fs').Stats}|null>}
 */
export async function ownClaudeTranscript(claudeDir, { writtenFrom = 0, resume = null, skip = null } = {}) {
  const resumed = resume ? `${resume}.jsonl` : null;
  const found = await newestIn(claudeDir, (name) => name.endsWith('.jsonl') && !skip?.has(name), (name, stat) => name === resumed || stat.mtimeMs >= writtenFrom);
  return found ? { ...found, name: path.basename(found.file) } : null;
}

async function fileStat(file) {
  if (!file) return null;
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ? { file, stat } : null;
}

async function newestIn(dir, keep, own = () => true) {
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
  return stats.filter((s) => s.stat && own(path.basename(s.file), s.stat)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0] ?? null;
}

// Codex files its rollouts by the day they started: the newest is in the last day folder that has one. `skip`: the files
// of the session's other codexes (agents.mjs).
async function newestRollout(codexHome, skip = null) {
  const root = path.join(codexHome, 'sessions');
  const desc = async (dir) => (await fs.readdir(dir).catch(() => [])).filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const year of await desc(root)) {
    for (const month of await desc(path.join(root, year))) {
      for (const day of await desc(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day);
        const found = await newestIn(dir, (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n) && !skip?.has(path.join(dir, n)));
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * The newest conversation of the session's agent, newest entries last.
 * @param {{agent: string, claudeDir: string, codexHome: string, home?: string, root?: string,
 *          limit?: number, since?: number, writtenFrom?: number, resume?: string|null, skip?: Set<string>|null,
 *          file?: string|null}} opts
 *   agent: claude, codex, grok, opencode or antigravity (shared/agents.cjs). claudeDir: claude's transcript folder for the repo. home:
 *   the home the other agents keep theirs in. root: the repo, which edits' paths are given relative to, and whose conversations are read.
 *   since: the writtenAt of the caller's last answer. writtenFrom, resume: which of claude's are this session's
 *   (ownClaudeTranscript). skip: the session's other agents' records (agents.mjs): claude's by name, codex's by path.
 *   file: the record itself, for an agent that knows its own (agents.mjs); undefined reads the newest, null none yet
 * @returns {Promise<{agent: string, entries: Entry[], partial: boolean, writtenAt: number|null}|{agent: string, unchanged: true, writtenAt: number}>}
 *   partial: older entries were left out, by the read or by the limit. unchanged: the newest record is still the
 *   one written at `since`, so the caller's entries stand
 */
export async function readSessionTranscript({ agent, claudeDir, codexHome, home = os.homedir(), grokHome = path.join(home, '.grok'), opencodeDb = openCodeDb(home), conversation, root, limit = MAX_ENTRIES, since = null, writtenFrom = 0, resume = null, skip = null, file, planPrefix = false }) {
  const max = Math.max(1, Math.min(MAX_ENTRIES, Math.trunc(Number(limit)) || MAX_ENTRIES));
  if (agent === 'opencode') {
    const read = await readOpenCode({ dbFile: opencodeDb, root, since });
    if (!read) return { agent, entries: [], partial: false, writtenAt: null };
    if (read.unchanged) return { agent, unchanged: true, writtenAt: read.writtenAt };
    return { agent, entries: capDiffs(read.entries.slice(-max)), partial: read.partial || read.entries.length > max, writtenAt: read.writtenAt };
  }
  // agy's record is the one its own hooks named (statusd, agents.mjs): none until its first message.
  if (agent === 'antigravity' && file === undefined) return { agent, entries: [], partial: false, writtenAt: null };
  const newest = file !== undefined ? await fileStat(file)
    : agent === 'codex' ? await newestRollout(codexHome, skip)
      : agent === 'grok' ? await newestGrokUpdates(grokHome, root, { skip, conversation })
        : await ownClaudeTranscript(claudeDir, { writtenFrom, resume, skip });
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
  const parse = { codex: parseCodexRollout, grok: parseGrokUpdates, antigravity: parseAntigravityTranscript }[agent] ?? parseClaudeTranscript;
  const all = parse(text, { partial, root, planPrefix });
  return {
    agent,
    // The newest edits keep their hunks within the answer's bound; older ones their files and counts.
    entries: capDiffs(all.slice(-max)),
    partial: partial || all.length > max,
    writtenAt: newest.stat.mtimeMs,
  };
}
