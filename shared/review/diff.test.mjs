// node --test review/diff.test.mjs
//
// The parser is the load-bearing component: everything else in the feature is
// commentary on what it produces, and its failures are silent — a wrong gutter
// number or a dropped line looks exactly like a correct one.
//
// Deliberately a small suite. What is here either caught a real bug or guards
// a failure that would reach a reader without anyone noticing; tests that
// demonstrated a regex worked have been removed, because nobody reads those
// and everybody trusts them.
//
// The PR #23792 fixture is checked in rather than fetched. An earlier draft
// hard-coded that PR's line counts and fetched it live; the counts changed
// within hours, which would have red-flagged the parser for a reason that had
// nothing to do with the parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseUnifiedDiff, MAX_FILE_DIFF_LINES } from './diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, '__fixtures__', 'pr-23792.patch'), 'utf-8');

test('parses a real gh pr diff into GitHub-matching file counts', () => {
  // The anchor. Everything below tests a shape; this tests reality.
  const { files } = parseUnifiedDiff(FIXTURE);
  const got = files.map((f) => `${f.path} ${f.additions} ${f.deletions}`).sort();
  assert.deepEqual(got, [
    'tools/README.md 65 6',
    // The recorded patch predates the Woodshed rename, so it still carries the
    // old path. Fixtures are recordings — they are not rewritten to match.
    'tools/bridge/server.mjs 429 114',
  ]);
});

test('reconstructs line numbers that match the hunk headers', () => {
  // Caught two real bugs. A gutter that lies is the worst failure available
  // here: it is confidently wrong, and an explain answer cites it by number.
  const { files } = parseUnifiedDiff(FIXTURE);
  for (const file of files) {
    for (const hunk of file.hunks) {
      const firstOld = hunk.lines.find((l) => l.oldNo !== null);
      const firstNew = hunk.lines.find((l) => l.newNo !== null);
      if (firstOld) assert.equal(firstOld.oldNo, hunk.oldStart, hunk.header);
      if (firstNew) assert.equal(firstNew.newNo, hunk.newStart, hunk.header);
      let prevOld = 0;
      let prevNew = 0;
      for (const l of hunk.lines) {
        if (l.oldNo !== null) {
          assert.equal(l.oldNo, prevOld === 0 ? l.oldNo : prevOld + 1, `${hunk.header}: old gap`);
          prevOld = l.oldNo;
        }
        if (l.newNo !== null) {
          assert.equal(l.newNo, prevNew === 0 ? l.newNo : prevNew + 1, `${hunk.header}: new gap`);
          prevNew = l.newNo;
        }
      }
    }
  }
});

test('does not invent a trailing empty context line', () => {
  // Splitting a patch that ends in a newline leaves one trailing ''. Treated
  // as an empty context line inside an open hunk, it produced a numbered
  // gutter row for a line that is not in the diff.
  const { files } = parseUnifiedDiff(FIXTURE);
  for (const file of files) {
    const lastHunk = file.hunks[file.hunks.length - 1];
    const lastLine = lastHunk.lines[lastHunk.lines.length - 1];
    assert.notEqual(lastLine.text, '', `${file.path} ends with a phantom empty line`);
  }
});

test('a deleted line starting with -- is not mistaken for a file header', () => {
  // Found by CI. The diff marker is prefixed to the content, so deleting a Lua
  // or SQL comment (`-- x`) produces the line `--- x`, and adding one that
  // starts `++ ` produces `+++ x`. Both collide with the ---/+++ file headers:
  // the line vanished, the counts diverged from GitHub's, and every later
  // old-side gutter number in the hunk was one too low.
  const { files, totalLines } = parseUnifiedDiff(
    [
      'diff --git a/throttle.ts b/throttle.ts',
      '--- a/throttle.ts',
      '+++ b/throttle.ts',
      '@@ -10,4 +10,3 @@',
      ' const script = `',
      '--- refill the bucket',
      '-  local now = 1',
      '+++ added line that looks like a header',
      ' `;',
    ].join('\n'),
  );

  assert.equal(files.length, 1, 'a phantom second file was invented');
  assert.equal(files[0].deletions, 2);
  assert.equal(files[0].additions, 1);
  assert.equal(totalLines, 5);
  const lines = files[0].hunks[0].lines;
  assert.equal(lines[1].text, '-- refill the bucket');
  assert.equal(lines[3].text, '++ added line that looks like a header');
  // The consequence that actually reaches a reader: the numbering after it.
  assert.deepEqual(
    lines.filter((l) => l.oldNo !== null).map((l) => l.oldNo),
    [10, 11, 12, 13],
  );

  // And the guard must not break what it guards: real headers still parse.
  const renamed = parseUnifiedDiff(
    [
      'diff --git a/x/old.ts b/x/new.ts',
      'similarity index 90%',
      'rename from x/old.ts',
      'rename to x/new.ts',
      '--- a/x/old.ts',
      '+++ b/x/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n'),
  ).files;
  assert.equal(renamed[0].oldPath, 'x/old.ts');
  assert.equal(renamed[0].newPath, 'x/new.ts');
});

test('the file shapes the fixture does not contain', () => {
  // The fixture is all modified files, so added / deleted / renamed / binary
  // are covered nowhere else — and each has its own header grammar.
  const added = parseUnifiedDiff(
    ['diff --git a/x/new.ts b/x/new.ts', 'new file mode 100644', '--- /dev/null',
     '+++ b/x/new.ts', '@@ -0,0 +1,2 @@', '+const a = 1;', '+const b = 2;', ''].join('\n'),
  ).files[0];
  assert.equal(added.status, 'added');
  assert.equal(added.oldPath, null);
  assert.equal(added.additions, 2);

  const deleted = parseUnifiedDiff(
    ['diff --git a/x/gone.ts b/x/gone.ts', 'deleted file mode 100644', '--- a/x/gone.ts',
     '+++ /dev/null', '@@ -1,2 +0,0 @@', '-const a = 1;', '-const b = 2;', ''].join('\n'),
  ).files[0];
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.newPath, null);
  assert.equal(deleted.deletions, 2);

  const renamed = parseUnifiedDiff(
    ['diff --git a/old/name.ts b/new/name.ts', 'similarity index 100%',
     'rename from old/name.ts', 'rename to new/name.ts', ''].join('\n'),
  ).files[0];
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.hunks.length, 0);

  const binary = parseUnifiedDiff(
    ['diff --git a/logo.png b/logo.png', 'index 1111111..2222222 100644',
     'Binary files a/logo.png and b/logo.png differ', ''].join('\n'),
  ).files[0];
  assert.equal(binary.isBinary, true);
  assert.equal(binary.hunks.length, 0);
});

test('a file over the per-file cap keeps its counts but drops its body', () => {
  const big = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', '@@ -1,1 +1,4001 @@'];
  for (let i = 0; i < MAX_FILE_DIFF_LINES + 1; i += 1) big.push(`+line ${i}`);
  const { files } = parseUnifiedDiff(big.join('\n'));
  assert.equal(files[0].truncated, true);
  assert.equal(files[0].hunks.length, 0);
  assert.equal(files[0].additions, MAX_FILE_DIFF_LINES + 1);
});

test('a long line is clamped without the file being marked truncated', () => {
  // The conflation that hid whole files: the renderer reads file.truncated as
  // "no renderable body, show a notice", so setting it because ONE line was
  // long replaced a perfectly readable four-line CSS diff with a notice.
  const long = `/* ${'x'.repeat(4_100)} */`;
  const { files } = parseUnifiedDiff(
    ['diff --git a/style.css b/style.css', '--- a/style.css', '+++ b/style.css',
     '@@ -1,3 +1,4 @@', ' .a { color: red; }', `-${long}`, `+${long}y`,
     '+.b { color: blue; }'].join('\n'),
  );
  assert.equal(files[0].truncated, false, 'a long line must not hide the file');
  assert.equal(files[0].hunks[0].lines.length, 4);
  assert.ok(files[0].hunks[0].lines[1].text.endsWith('[line truncated]'));
  // The short lines either side are untouched and still readable.
  assert.equal(files[0].hunks[0].lines[3].text, '.b { color: blue; }');
});

test('no attached intra-line range is ever zero-width', () => {
  // A pure insertion is the commonest shape in any diff, and its old side has
  // a zero-width range — nothing was removed. Attaching it made the renderer
  // emit an empty highlight span on a large fraction of all changed lines.
  const cases = [
    ['foo()', 'foo(bar)'],
    ['ab', 'axb'],
    ['axb', 'ab'],
    ['const timeout = 5000;', 'const timeout = 9000;'],
  ];
  for (const [before, after] of cases) {
    const { files } = parseUnifiedDiff(
      ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@',
       `-${before}`, `+${after}`, ''].join('\n'),
    );
    for (const line of files[0].hunks[0].lines) {
      if (!line.range) continue;
      assert.ok(line.range[1] > line.range[0], `zero-width range for ${before} -> ${after}`);
    }
  }
  const pure = parseUnifiedDiff(
    ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@',
     '-foo()', '+foo(bar)', ''].join('\n'),
  ).files[0].hunks[0].lines;
  assert.equal(pure[0].range, undefined, 'the deleted side should carry no range');
  assert.equal('foo(bar)'.slice(pure[1].range[0], pure[1].range[1]), 'bar');
});
