// The code a turn changed, read from the agent's own record of its edits (sessionTranscript.mjs), for the Chat tab to
// show under the work log that made them. Each edit becomes a small diff: the file, and hunks of `-`/`+`/` ` lines.
//   claude: the edit tool's result (`toolUseResult.structuredPatch`, which Claude Code writes beside each Edit,
//     MultiEdit and Write it ran: the real hunks, with their line numbers and context), or, until that result is
//     written or in a record without one, the tool's own input: Edit's old_string and new_string, MultiEdit's edits,
//     Write's content (a new file's lines, or "rewrote the file" when its result says it updated one).
//   codex: apply_patch's input, the `*** Begin Patch` format, which carries the hunks: a custom tool call, a shell call
//     of `apply_patch`, or a patch run inside a codex 0.16x `exec` script.
// Files a shell command changed (`sed -i`, a code generator) are in no record: the Chat says so, and the Diff tab has
// them. Every diff is bounded: its lines are cut at MAX_LINE_CHARS, an edit at MAX_EDIT_LINES, and one answer's
// diffs at MAX_ANSWER_BYTES, newest kept, older ones keeping only their file and counts.

// A line of a diff past this many characters is cut.
export const MAX_LINE_CHARS = 400;
// The lines one edit of one file shows.
export const MAX_EDIT_LINES = 200;
// The lines of diff one /transcript answer carries, in bytes: polled every 1.5 s while the agent works.
export const MAX_ANSWER_BYTES = 192 * 1024;
// Lines of context kept round an edit built from its input, on each side.
const CONTEXT = 3;

/** @typedef {{head: string, lines: string[]}} Hunk */
/** @typedef {{path: string, op: 'edit'|'add'|'delete'|'rewrite', to?: string, add: number, del: number, hunks: Hunk[], cut?: true, all?: true}} FileDiff */

const lineOf = (text) => (text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text);
const splitLines = (text) => {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** @returns {string}  the path as the repo names it: relative to `root` when under it */
export function relativePath(file, root) {
  const p = String(file ?? '').trim();
  if (root && p.startsWith(`${root.replace(/\/+$/, '')}/`)) return p.slice(root.replace(/\/+$/, '').length + 1);
  return p;
}

// A file's diff from its hunks: counted whole, then cut to MAX_EDIT_LINES.
function fileDiff(path, op, hunks, extra = {}) {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l[0] === '+') add++;
    else if (l[0] === '-') del++;
  }
  const kept = [];
  let room = MAX_EDIT_LINES;
  let cut = false;
  for (const h of hunks) {
    if (room <= 0) {
      cut = true;
      break;
    }
    const lines = h.lines.slice(0, room).map(lineOf);
    if (lines.length < h.lines.length) cut = true;
    room -= lines.length;
    kept.push({ head: h.head, lines });
  }
  return { path, op, ...extra, add, del, hunks: kept, ...(cut && { cut: true }) };
}

// The lines a replacement changes, from its old and new text: the lines both share at the start and the end are
// context (at most CONTEXT of each), the rest removed then added.
function replacement(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [
    ...a.slice(Math.max(0, start - CONTEXT), start).map((l) => ` ${l}`),
    ...a.slice(start, a.length - end).map((l) => `-${l}`),
    ...b.slice(start, b.length - end).map((l) => `+${l}`),
    ...a.slice(a.length - end, a.length - end + CONTEXT).map((l) => ` ${l}`),
  ];
}

/**
 * One file's change from its text before and after, as the agents that record edits that way write it: Grok Build's
 * and Antigravity's ACP `diff` content (`path`, `oldText`, `newText`), OpenCode's edit and write inputs. No text before
 * is a new file.
 * @param {string} file
 * @param {string|null|undefined} oldText
 * @param {string} newText
 * @returns {FileDiff|null}  null when there is no path or no new text
 */
export function textDiff(file, oldText, newText, { root } = {}) {
  if (typeof file !== 'string' || !file.trim() || typeof newText !== 'string') return null;
  const at = relativePath(file, root);
  if (oldText === null || oldText === undefined) {
    return fileDiff(at, 'add', [{ head: '@@ new file @@', lines: newText ? splitLines(newText).map((l) => `+${l}`) : [] }]);
  }
  return fileDiff(at, 'edit', [{ head: '@@', lines: replacement(String(oldText), newText) }]);
}

/**
 * What a claude edit tool's input changes, before its result says.
 * @returns {FileDiff[]|null}  null for a tool that edits nothing
 */
export function claudeInputDiffs(name, input, { root } = {}) {
  if (!input || typeof input !== 'object' || typeof input.file_path !== 'string') return null;
  const path = relativePath(input.file_path, root);
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [fileDiff(path, 'edit', [{ head: '@@', lines: replacement(input.old_string, input.new_string) }], input.replace_all === true ? { all: true } : {})];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const hunks = input.edits.filter((e) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string')
      .map((e) => ({ head: '@@', lines: replacement(e.old_string, e.new_string) }));
    return hunks.length ? [fileDiff(path, 'edit', hunks)] : null;
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return [fileDiff(path, 'add', [{ head: '@@ new file @@', lines: input.content ? splitLines(input.content).map((l) => `+${l}`) : [] }])];
  }
  return null;
}

/**
 * What a claude edit changed, from its result: `toolUseResult` as Claude Code writes it beside the tool_result.
 * @param {object[]|null} before  the diffs read from the tool's input
 * @param {string} resultText  the tool_result's text: "has been updated" for a Write over an existing file
 * @returns {FileDiff[]|null}  null to keep `before`
 */
export function claudeResultDiffs(name, result, before, resultText, { root } = {}) {
  const patch = result && typeof result === 'object' && Array.isArray(result.structuredPatch) ? result.structuredPatch : null;
  const file = typeof result?.filePath === 'string' ? relativePath(result.filePath, root) : before?.[0]?.path;
  if (!file) return null;
  if (patch && patch.length) {
    const hunks = patch.filter((h) => Array.isArray(h?.lines)).map((h) => ({
      head: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      lines: h.lines.filter((l) => typeof l === 'string' && /^[-+ ]/.test(l)),
    }));
    if (hunks.length) return [fileDiff(file, 'edit', hunks, result.replaceAll === true ? { all: true } : {})];
  }
  if (name === 'Write' && (result?.type === 'update' || /has been updated/i.test(resultText))) {
    // A rewrite with no hunks in the record: the whole file was written again.
    return patch && !patch.length && result?.type === 'update' ? [] : [{ path: file, op: 'rewrite', add: before?.[0]?.add ?? 0, del: 0, hunks: [] }];
  }
  return null;
}

// ---- codex's patches.

const PATCH_BLOCK = /\*\*\* Begin Patch\n[\s\S]*?(?:\*\*\* End Patch|$)/;

/**
 * The files and hunks of an apply_patch input (`*** Begin Patch` … `*** End Patch`).
 * @returns {FileDiff[]}
 */
export function parsePatch(text, { root } = {}) {
  const block = PATCH_BLOCK.exec(String(text ?? '').replace(/\r\n?/g, '\n'));
  if (!block) return [];
  const files = [];
  let file = null;
  let hunk = null;
  const end = () => {
    if (file) files.push(fileDiff(file.path, file.op, file.hunks.filter((h) => h.lines.length || file.op === 'delete'), file.to ? { to: file.to } : {}));
    file = null;
    hunk = null;
  };
  for (const line of block[0].split('\n').slice(1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      end();
      file = { path: relativePath(header[2], root), op: header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'edit', hunks: [] };
      if (file.op === 'add') file.hunks.push(hunk = { head: '@@ new file @@', lines: [] });
      continue;
    }
    if (line.startsWith('*** End Patch')) break;
    if (!file) continue;
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      file.to = relativePath(move[1], root);
      continue;
    }
    if (line.startsWith('*** ')) continue;
    if (line.startsWith('@@')) {
      file.hunks.push(hunk = { head: line.trim() === '@@' ? '@@' : line, lines: [] });
      continue;
    }
    if (!/^[-+ ]/.test(line) && line !== '') continue;
    if (!hunk) file.hunks.push(hunk = { head: '@@', lines: [] });
    hunk.lines.push(line === '' ? ' ' : line);
  }
  end();
  return files;
}

// The patch in a shell call: `["apply_patch", "<patch>"]`, or a command that pipes one into apply_patch.
export function shellPatch(argv) {
  if (!Array.isArray(argv)) return null;
  if (/^(apply_patch|applypatch)$/.test(argv[0]) && typeof argv[1] === 'string') return argv[1];
  const command = argv.length === 3 && /^-l?c$/.test(argv[1]) ? argv[2] : null;
  if (typeof command === 'string' && /\bapply_patch\b/.test(command) && command.includes('*** Begin Patch')) return command;
  return null;
}

// A JavaScript string literal's text: "…" (JSON's escapes), '…' or `…` (a template, written as is).
function jsString(literal) {
  if (literal[0] === '"') {
    try {
      return JSON.parse(literal);
    } catch {
      // Not JSON's escapes: read below.
    }
  }
  return literal.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e) => {
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e[0] === 'u' || e[0] === 'x') return String.fromCodePoint(parseInt(e.replace(/[ux{}]/g, ''), 16));
    return e;
  });
}

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/g;

/** @returns {string[]}  the patches an `exec` script holds, in order: each string literal that is one */
export function scriptPatches(script) {
  if (typeof script !== 'string' || !script.includes('Begin Patch')) return [];
  return [...script.matchAll(STRING_LITERAL)].map((m) => jsString(m[0])).filter((s) => s.trimStart().startsWith('*** Begin Patch'));
}

// ---- One answer's diffs, bounded.

const diffBytes = (d) => d.hunks.reduce((n, h) => n + h.head.length + h.lines.reduce((m, l) => m + l.length + 1, 0), 0);

/**
 * Keeps the newest diffs' hunks within MAX_ANSWER_BYTES; an older diff past it keeps its file and counts, marked cut.
 * Changes the entries in place.
 * @param {{diffs?: FileDiff[]}[]} entries  newest last
 */
export function capDiffs(entries, budget = MAX_ANSWER_BYTES) {
  let room = budget;
  for (let i = entries.length - 1; i >= 0; i--) {
    const diffs = entries[i].diffs;
    if (!diffs) continue;
    entries[i].diffs = diffs.map((d) => {
      const size = diffBytes(d);
      if (size <= room) {
        room -= size;
        return d;
      }
      room = 0;
      return d.hunks.length ? { ...d, hunks: [], cut: true } : d;
    });
  }
  return entries;
}
