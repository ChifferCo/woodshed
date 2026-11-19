import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_EDIT_LINES, MAX_LINE_CHARS, capDiffs, claudeInputDiffs, claudeResultDiffs, parsePatch, scriptPatches, shellPatch } from './transcriptDiff.mjs';

const root = '/work/repo';

test("claude's Edit reads as the lines it replaced, with the lines both share as context", () => {
  const [d] = claudeInputDiffs('Edit', {
    file_path: '/work/repo/src/a.js',
    old_string: 'function a() {\n  return 1;\n}',
    new_string: 'function a() {\n  return 2;\n}',
  }, { root });
  assert.deepEqual(d, { path: 'src/a.js', op: 'edit', add: 1, del: 1, hunks: [{ head: '@@', lines: [' function a() {', '-  return 1;', '+  return 2;', ' }'] }] });
  const [all] = claudeInputDiffs('Edit', { file_path: '/elsewhere/b.js', old_string: 'x', new_string: 'y', replace_all: true }, { root });
  assert.equal(all.path, '/elsewhere/b.js', 'a path outside the repo stays whole');
  assert.equal(all.all, true, 'replace_all says every occurrence');
});

test("claude's MultiEdit is a hunk an edit, and Write a new file's lines", () => {
  const [multi] = claudeInputDiffs('MultiEdit', { file_path: '/work/repo/a.js', edits: [
    { old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'c\ne\nf' },
  ] }, { root });
  assert.deepEqual(multi.hunks.map((h) => h.lines), [['-a', '+b'], [' c', '-d', '+e', '+f']]);
  assert.deepEqual([multi.add, multi.del], [3, 2]);
  const [write] = claudeInputDiffs('Write', { file_path: '/work/repo/new.md', content: '# Title\n\nBody\n' }, { root });
  assert.deepEqual(write, { path: 'new.md', op: 'add', add: 3, del: 0, hunks: [{ head: '@@ new file @@', lines: ['+# Title', '+', '+Body'] }] });
  assert.equal(claudeInputDiffs('Read', { file_path: '/work/repo/a.js' }, { root }), null);
  assert.equal(claudeInputDiffs('Bash', { command: 'ls' }), null);
});

test("claude's result replaces the input's diff with its own hunks, and a Write over a file says it rewrote it", () => {
  // toolUseResult as Claude Code 2.1 writes it beside an Edit's tool_result.
  const result = {
    filePath: '/work/repo/a.js', oldString: 'return 1;', newString: 'return 2;', originalFile: 'x', replaceAll: false, userModified: false,
    structuredPatch: [{ oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [' function a() {', '-  return 1;', '+  return 2;', ' }'] }],
  };
  const before = claudeInputDiffs('Edit', { file_path: '/work/repo/a.js', old_string: 'return 1;', new_string: 'return 2;' }, { root });
  assert.deepEqual(claudeResultDiffs('Edit', result, before, 'The file /work/repo/a.js has been updated successfully.', { root }), [
    { path: 'a.js', op: 'edit', add: 1, del: 1, hunks: [{ head: '@@ -4,3 +4,3 @@', lines: [' function a() {', '-  return 1;', '+  return 2;', ' }'] }] },
  ]);
  // A Write over an existing file: its result has the hunks too (type update).
  const update = { type: 'update', filePath: '/work/repo/b.js', content: 'b\n', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] };
  assert.deepEqual(claudeResultDiffs('Write', update, null, '', { root })[0].hunks, [{ head: '@@ -1,1 +1,1 @@', lines: ['-a', '+b'] }]);
  // A new file's result has no hunks: the input's lines stand.
  assert.equal(claudeResultDiffs('Write', { type: 'create', filePath: '/work/repo/c.js', structuredPatch: [] }, before, 'File created successfully at: /work/repo/c.js', { root }), null);
  // A record with no toolUseResult, whose text says it updated the file: the old lines are unknown.
  const wrote = claudeInputDiffs('Write', { file_path: '/work/repo/d.js', content: 'one\ntwo\n' }, { root });
  assert.deepEqual(claudeResultDiffs('Write', null, wrote, 'The file /work/repo/d.js has been updated successfully.', { root }),
    [{ path: 'd.js', op: 'rewrite', add: 2, del: 0, hunks: [] }]);
});

test('an edit is cut at its line cap and each line at its length, counted whole', () => {
  const [d] = claudeInputDiffs('Write', { file_path: 'big.txt', content: `${'x'.repeat(MAX_LINE_CHARS + 10)}\n${'y\n'.repeat(MAX_EDIT_LINES + 50)}` });
  assert.equal(d.add, MAX_EDIT_LINES + 51);
  assert.equal(d.hunks[0].lines.length, MAX_EDIT_LINES);
  assert.equal(d.cut, true);
  assert.equal(d.hunks[0].lines[0].length, MAX_LINE_CHARS + 1);
  assert.ok(d.hunks[0].lines[0].endsWith('…'));
});

test("codex's patch reads as its files and hunks: added, updated, moved and deleted", () => {
  const files = parsePatch([
    '*** Begin Patch',
    '*** Update File: src/a.js',
    '@@ function a() {',
    '-  return 1;',
    '+  return 2;',
    ' }',
    '@@',
    '-x',
    '+y',
    '*** Add File: /work/repo/src/new.js',
    '+export const n = 1;',
    '*** Update File: old.js',
    '*** Move to: moved.js',
    '@@',
    '-a',
    '+b',
    '*** End of File',
    '*** Delete File: gone.js',
    '*** End Patch',
  ].join('\n'), { root });
  assert.deepEqual(files, [
    { path: 'src/a.js', op: 'edit', add: 2, del: 2, hunks: [{ head: '@@ function a() {', lines: ['-  return 1;', '+  return 2;', ' }'] }, { head: '@@', lines: ['-x', '+y'] }] },
    { path: 'src/new.js', op: 'add', add: 1, del: 0, hunks: [{ head: '@@ new file @@', lines: ['+export const n = 1;'] }] },
    { path: 'old.js', op: 'edit', to: 'moved.js', add: 1, del: 1, hunks: [{ head: '@@', lines: ['-a', '+b'] }] },
    { path: 'gone.js', op: 'delete', add: 0, del: 0, hunks: [] },
  ]);
  assert.deepEqual(parsePatch('not a patch'), []);
});

test('a patch is found in a shell call and in an exec script, whatever its quotes', () => {
  const patch = '*** Begin Patch\n*** Update File: a.js\n@@\n-a\n+b\n*** End Patch';
  assert.equal(shellPatch(['apply_patch', patch]), patch);
  assert.ok(shellPatch(['bash', '-lc', `apply_patch <<'EOF'\n${patch}\nEOF`]).includes('*** Update File: a.js'));
  assert.equal(shellPatch(['bash', '-lc', 'ls']), null);
  assert.deepEqual(scriptPatches([
    `const one = await tools.apply_patch(${JSON.stringify(patch)});`,
    `const two = await tools.apply_patch(\`${patch.replace('a.js', 'b.js')}\`);`,
    "const s = 'it\\'s not a patch';",
    'text(one + two)',
  ].join('\n')), [patch, patch.replace('a.js', 'b.js')]);
});

test("one answer's diffs are bounded: the newest keep their hunks, older ones their files and counts", () => {
  const diff = (path) => ({ path, op: 'edit', add: 1, del: 0, hunks: [{ head: '@@', lines: [`+${'z'.repeat(98)}`] }] });
  const entries = [{ role: 'tool', diffs: [diff('old.js')] }, { role: 'user', text: 'hi' }, { role: 'tool', diffs: [diff('mid.js')] }, { role: 'tool', diffs: [diff('new.js')] }];
  capDiffs(entries, 250);
  assert.deepEqual(entries.map((e) => e.diffs?.[0].hunks.length ?? null), [0, null, 1, 1]);
  assert.equal(entries[0].diffs[0].cut, true);
  assert.equal(entries[0].diffs[0].add, 1, 'its counts stay');
});
