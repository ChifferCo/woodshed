// Unified-diff parsing, hand-written because the shed has no dependencies.
//
// Input is whatever `gh pr diff <n>` prints, which is `git diff` output: a
// run of `diff --git` sections, each with optional mode/rename/index headers,
// then either `--- / +++ / @@` hunks or a binary marker.
//
// Paths come from the `---` and `+++` lines rather than the `diff --git`
// header, because the header is genuinely ambiguous for paths containing a
// space (`diff --git a/my file.txt b/my file.txt` has no unique split point)
// while the `---`/`+++` lines carry exactly one path each. Renames fall back
// to the `rename from`/`rename to` lines, which are likewise unambiguous.

import { dialectForPath } from './highlight.mjs';

// A 50k-line diff is a 50k-row DOM on a phone. Past these caps the file still
// appears — with its header, counts and preamble — but its body is replaced by
// a "too large to display" notice and a copy-the-command fallback.
const MAX_DIFF_LINES = 15_000;
// Line COUNT caps do nothing for a minified bundle or a single-line CSV, where
// one changed line is megabytes: it would be written to disk, shipped whole to
// a phone, and fed to the tokenizer, hanging the tab. Ordinary PR content, not
// just malice.
const MAX_LINE_CHARS = 4_000;
export const MAX_FILE_DIFF_LINES = 3_000;

/**
 * @param {string} text raw unified diff
 * @returns {{files: ParsedFile[], totalLines: number, truncated: boolean}}
 */
export function parseUnifiedDiff(text) {
  const lines = String(text || '').split('\n');
  // Splitting a patch that ends in a newline leaves one trailing ''. Inside an
  // open hunk that reads as an empty context line, which invented a numbered
  // gutter row that is not in the diff and added 1 to totalLines. A genuinely
  // empty context line mid-hunk is a single space, and still parses correctly.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let current = null;
  let hunk = null;
  let totalLines = 0;
  let truncated = false;

  function closeFile() {
    if (!current) return;
    if (hunk && hunk.lines.length) current.hunks.push(hunk);
    hunk = null;
    finalizeFile(current);
    files.push(current);
    current = null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      closeFile();
      current = newFile();
      // Kept only as the fallback for paths the ---/+++ lines never supply
      // (a pure mode change emits no such lines at all).
      const guess = pathsFromGitHeader(line);
      current.oldPath = guess.oldPath;
      current.newPath = guess.newPath;
      continue;
    }

    if (!current) continue;

    // Per-file headers only exist BEFORE the first @@ of a file. Inside a hunk
    // every line carries a +/-/space marker, and two of those collide with a
    // header: a deleted line whose content starts with `-- ` becomes `--- `,
    // and an added one starting with `++ ` becomes `+++ `. Without this guard
    // such a line was read as a file header — it vanished from the hunk, the
    // deletion count diverged from GitHub's, and every later old-side gutter
    // number in that hunk was one too low. Lua and SQL comments start `-- `,
    // and this repo has a file full of them.
    if (!hunk) {
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = unquoteGitPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.status = 'renamed';
      current.newPath = unquoteGitPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      current.modeChanged = true;
      continue;
    }
    if (line.startsWith('index ')) continue;

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      const p = sidePath(line.slice(4));
      if (p === null) current.status = current.status === 'renamed' ? 'renamed' : 'added';
      else current.oldPath = p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = sidePath(line.slice(4));
      if (p === null) current.status = 'deleted';
      else current.newPath = p;
      continue;
    }

    }

    if (line.startsWith('@@')) {
      if (hunk && hunk.lines.length) current.hunks.push(hunk);
      hunk = parseHunkHeader(line);
      continue;
    }

    if (!hunk) continue;

    // Body lines. A bare '' is the artefact of splitting a trailing newline;
    // git also emits a genuinely empty context line as a single space, so an
    // empty string mid-hunk is treated as empty context.
    const marker = line[0];
    if (marker === '\\') {
      // "\ No newline at end of file" annotates the preceding line.
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewline = true;
      continue;
    }
    if (marker !== '+' && marker !== '-' && marker !== ' ' && line !== '') {
      // Anything else ends the hunk — trailing prose, a new `diff --git` is
      // handled above, and `gh` occasionally appends a blank separator.
      if (hunk.lines.length) current.hunks.push(hunk);
      hunk = null;
      continue;
    }

    // Counts and line numbers are tallied before the size cap, so a truncated
    // diff still reports the same +A/−D as GitHub does. Only the stored line
    // text is dropped.
    let body = line === '' ? '' : line.slice(1);
    if (body.length > MAX_LINE_CHARS) {
      // Deliberately NOT current.truncated: page.mjs reads that flag as "this
      // file has no renderable body, show a notice instead", which would hide
      // an otherwise perfectly readable diff because one line was long. The
      // appended marker is the signal for this case.
      body = `${body.slice(0, MAX_LINE_CHARS)}\u2026 [line truncated]`;
    }
    const overCap = totalLines >= MAX_DIFF_LINES;
    if (overCap) {
      truncated = true;
      current.truncated = true;
    }
    totalLines += 1;

    if (marker === '+') {
      current.additions += 1;
      if (!overCap) hunk.lines.push({ type: 'add', oldNo: null, newNo: hunk.newNext, text: body });
      hunk.newNext += 1;
    } else if (marker === '-') {
      current.deletions += 1;
      if (!overCap) hunk.lines.push({ type: 'del', oldNo: hunk.oldNext, newNo: null, text: body });
      hunk.oldNext += 1;
    } else {
      if (!overCap) {
        hunk.lines.push({ type: 'ctx', oldNo: hunk.oldNext, newNo: hunk.newNext, text: body });
      }
      hunk.oldNext += 1;
      hunk.newNext += 1;
    }
  }

  closeFile();
  return { files, totalLines, truncated };
}

function stripControlChars(value) {
  if (value == null) return value;
  return value.replace(/[\u0000-\u001f\u007f]/g, '\uFFFD');
}

function newFile() {
  return {
    oldPath: null,
    newPath: null,
    status: 'modified',
    isBinary: false,
    modeChanged: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    truncated: false,
    language: '',
  };
}

function finalizeFile(file) {
  if (file.status === 'added') file.oldPath = null;
  if (file.status === 'deleted') file.newPath = null;
  // Control characters are stripped before the path goes anywhere. git happily
  // decodes escaped newlines and tabs out of a quoted path (unquoteGitPath does
  // so faithfully), and the path is later interpolated one-per-line into the
  // analysis prompt's <changed-files> block. A file named with an embedded
  // newline could otherwise forge a fence close and place instructions outside
  // the region the prompt labels as untrusted.
  file.oldPath = stripControlChars(file.oldPath);
  file.newPath = stripControlChars(file.newPath);
  file.path = file.newPath || file.oldPath || '';
  file.language = dialectForPath(file.path);

  const count = file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
  if (count > MAX_FILE_DIFF_LINES) {
    file.truncated = true;
    file.hunks = [];
  }
  markIntraLine(file);
}

// `--- a/x` / `+++ b/x`, or `/dev/null` for the absent side. Git may append a
// tab and a timestamp; everything from the tab on is metadata, not the path.
function sidePath(rest) {
  const cut = rest.indexOf('\t');
  const raw = cut === -1 ? rest : rest.slice(0, cut);
  if (raw === '/dev/null') return null;
  const unquoted = unquoteGitPath(raw);
  return unquoted.replace(/^[ab]\//, '');
}

function pathsFromGitHeader(line) {
  const rest = line.slice('diff --git '.length);
  // Quoted form is unambiguous; take both quoted runs.
  if (rest.startsWith('"')) {
    const parts = rest.match(/"(?:[^"\\]|\\.)*"/g) || [];
    return {
      oldPath: parts[0] ? unquoteGitPath(parts[0]).replace(/^[ab]\//, '') : null,
      newPath: parts[1] ? unquoteGitPath(parts[1]).replace(/^[ab]\//, '') : null,
    };
  }
  // Unquoted: split at " b/" — correct whenever the old path does not itself
  // contain that sequence, and the ---/+++ lines override this anyway.
  const at = rest.indexOf(' b/');
  if (at === -1) return { oldPath: null, newPath: null };
  return {
    oldPath: rest.slice(0, at).replace(/^a\//, ''),
    newPath: rest.slice(at + 3),
  };
}

// Git quotes paths with C-style escapes when they contain control characters,
// quotes, backslashes or non-ASCII bytes (core.quotePath).
function unquoteGitPath(raw) {
  const s = String(raw);
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const inner = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const c = inner[i + 1];
    if (c >= '0' && c <= '7') {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
    if (Object.prototype.hasOwnProperty.call(simple, c)) bytes.push(simple[c]);
    else bytes.push(c.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf-8');
}

function parseHunkHeader(line) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  const oldStart = m ? parseInt(m[1], 10) : 1;
  const newStart = m ? parseInt(m[3], 10) : 1;
  return {
    header: line,
    // The trailing text on an @@ line is git's guess at the enclosing
    // function. It is the cheapest useful context signal in the whole diff,
    // so it is kept separately and fed to the analysis prompt.
    context: m ? (m[5] || '').trim() : '',
    oldStart,
    newStart,
    oldNext: oldStart,
    newNext: newStart,
    lines: [],
  };
}

// Pair up adjacent del/add runs of equal length and mark the differing middle
// of each pair, so a one-character change reads as a one-character change
// rather than two entirely repainted lines.
function markIntraLine(file) {
  for (const h of file.hunks) {
    for (let i = 0; i < h.lines.length; i += 1) {
      if (h.lines[i].type !== 'del') continue;
      let dels = 0;
      while (h.lines[i + dels] && h.lines[i + dels].type === 'del') dels += 1;
      let adds = 0;
      while (h.lines[i + dels + adds] && h.lines[i + dels + adds].type === 'add') adds += 1;
      if (dels === adds) {
        for (let k = 0; k < dels; k += 1) {
          const del = h.lines[i + k];
          const add = h.lines[i + dels + k];
          const range = intraLineDiff(del.text, add.text);
          if (range) {
            // A pure insertion into a line ("foo()" -> "foo(bar)") leaves the
            // OLD side with a zero-width range: nothing was removed, so there
            // is nothing to mark. Attaching it anyway makes the renderer emit
            // an empty highlight span on one of the commonest shapes in any
            // diff. Each side is attached only if it actually spans something.
            if (range.old[1] > range.old[0]) del.range = range.old;
            if (range.new[1] > range.new[0]) add.range = range.new;
          }
        }
      }
      i += dels + adds - 1;
    }
  }
}

/**
 * Common-prefix / common-suffix trim. Returns null when the lines share too
 * little to be worth marking — highlighting nearly the whole of both lines is
 * noise, and a wholesale rewrite is better shown as a plain +/- pair.
 *
 * @returns {{old: [number, number], new: [number, number]} | null}
 */
export function intraLineDiff(oldText, newText) {
  const a = String(oldText);
  const b = String(newText);
  if (a === b || !a || !b) return null;

  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start += 1;

  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;

  const shared = start + end;
  if (shared < Math.min(a.length, b.length) * 0.3) return null;

  return {
    old: [start, a.length - end],
    new: [start, b.length - end],
  };
}
