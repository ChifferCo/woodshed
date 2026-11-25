import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { MAX_DECOMPRESSED_BYTES, MAX_TEXT, grokFolderName, openCodeDb, ownClaudeTranscript, parseClaudeTranscript, parseCodexRollout, parseGrokUpdates, readSessionTranscript } from './sessionTranscript.mjs';

const line = (o) => JSON.stringify(o);
const at = '2026-11-12T10:00:00.000Z';

// Lines as claude writes them (measured on Claude Code 2.x): a typed prompt as a string, a reply in blocks, a tool call
// and its result, thinking, a slash command in its wrapper, a subagent's sidechain, and records that are not turns.
const CLAUDE = [
  line({ type: 'mode', mode: 'auto' }),
  line({ type: 'user', timestamp: at, message: { role: 'user', content: 'Fix the login bug' } }),
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at it.' }] } }),
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\n--watch', description: 'Run the tests' } }] } }),
  line({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/work/app/login.js' } }] } }),
  line({ type: 'user', timestamp: at, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  line({ type: 'user', timestamp: at, isMeta: true, message: { role: 'user', content: 'Caveat: local commands' } }),
  line({ type: 'assistant', timestamp: at, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
  line({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'Also the logout one' }] } }),
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done: both fixed.' }] } }),
].join('\n');

test('a claude transcript keeps what was asked, said and run, in order', () => {
  assert.deepEqual(parseClaudeTranscript(CLAUDE), [
    { role: 'user', text: 'Fix the login bug', at },
    { role: 'assistant', text: 'Looking at it.', at },
    { role: 'tool', tool: 'Bash', text: 'Run the tests', at },
    { role: 'tool', tool: 'Read', text: '/work/app/login.js', at },
    // The slash command as the person typed it: Chat shows it, and knows it arrived.
    { role: 'user', text: '/clear', at },
    { role: 'user', text: 'Also the logout one', at },
    { role: 'assistant', text: 'Done: both fixed.', at },
  ]);
});

test('a read that starts mid-line drops that line, and a line being written is skipped', () => {
  const text = `ext":"cut"}]}}\n${CLAUDE}\n{"type":"assistant","mess`;
  const entries = parseClaudeTranscript(text, { partial: true });
  assert.equal(entries[0].text, 'Fix the login bug');
  assert.equal(entries.at(-1).text, 'Done: both fixed.');
});

test('a long reply is cut', () => {
  const long = 'x'.repeat(MAX_TEXT + 50);
  const [entry] = parseClaudeTranscript(line({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } }));
  assert.equal(entry.text.length, MAX_TEXT + 1);
  assert.ok(entry.text.endsWith('…'));
  assert.equal(entry.at, null);
});

// Lines as codex writes them (rollout format of codex 0.16x): its context in the first turn, developer instructions,
// a reply, reasoning, and a shell call.
const CODEX = [
  line({ type: 'session_meta', payload: { id: 'x' } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex' }] } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/work</cwd>' }, { type: 'input_text', text: 'Rename the helper' }] } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nstopped\n</turn_aborted>' }] } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'reasoning', summary: [] } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'function_call', name: 'shell', arguments: '{"command":["rg","helper"]}' } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'function_call_output', output: 'a.js' } }),
  line({ type: 'event_msg', timestamp: at, payload: { type: 'token_count' } }),
  line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Renamed in a.js.' }] } }),
].join('\n');

test('a codex rollout keeps what was asked, said and run, without its context', () => {
  assert.deepEqual(parseCodexRollout(CODEX), [
    { role: 'user', text: 'Rename the helper', at },
    { role: 'tool', tool: 'shell', text: 'rg helper', at },
    { role: 'assistant', text: 'Renamed in a.js.', at },
  ]);
});

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the newest claude transcript is read, its newest entries kept', async (t) => {
  const dir = home(t);
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'old.jsonl'), line({ type: 'user', message: { content: 'old' } }));
  fs.utimesSync(path.join(claudeDir, 'old.jsonl'), new Date(1000), new Date(1000));
  fs.writeFileSync(path.join(claudeDir, 'new.jsonl'), CLAUDE);
  const read = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, limit: 2 });
  assert.equal(read.agent, 'claude');
  assert.deepEqual(read.entries.map((e) => e.text), ['Also the logout one', 'Done: both fixed.']);
  assert.equal(read.partial, true);
  assert.equal(typeof read.writtenAt, 'number');
});

// A private session starts from its owner's Claude home, which brings their earlier conversations on the repo, with the
// times they were last written: another session's, still running, among them.
test('a conversation the restored home brought is not the session\'s: its Chat is empty until claude writes', async (t) => {
  const dir = home(t);
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const restoredAt = Date.now() - 60_000;
  const other = path.join(claudeDir, 'other-session.jsonl');
  fs.writeFileSync(other, CLAUDE);
  fs.utimesSync(other, new Date(restoredAt - 5000), new Date(restoredAt - 5000));
  const before = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, writtenFrom: restoredAt });
  assert.deepEqual(before, { agent: 'claude', entries: [], partial: false, writtenAt: null });
  assert.equal(await ownClaudeTranscript(claudeDir, { writtenFrom: restoredAt }), null, 'no conversation id for Resume either');
  fs.writeFileSync(path.join(claudeDir, 'mine.jsonl'), line({ type: 'user', timestamp: at, message: { role: 'user', content: 'Add the export button' } }));
  const after = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, writtenFrom: restoredAt });
  assert.deepEqual(after.entries.map((e) => e.text), ['Add the export button']);
  assert.equal((await ownClaudeTranscript(claudeDir, { writtenFrom: restoredAt })).name, 'mine.jsonl');
  // Nothing restored (no time written): every transcript counts, as before.
  assert.equal((await ownClaudeTranscript(claudeDir)).name, 'mine.jsonl');
});

test('a Resume\'s conversation is the session\'s, though the home brought it', async (t) => {
  const dir = home(t);
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const restoredAt = Date.now() - 60_000;
  for (const [name, ago] of [['resumed', 9000], ['newer-other', 1000]]) {
    const file = path.join(claudeDir, `${name}.jsonl`);
    fs.writeFileSync(file, CLAUDE);
    fs.utimesSync(file, new Date(restoredAt - ago), new Date(restoredAt - ago));
  }
  assert.equal((await ownClaudeTranscript(claudeDir, { writtenFrom: restoredAt, resume: 'resumed' })).name, 'resumed.jsonl');
  const read = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, writtenFrom: restoredAt, resume: 'resumed' });
  assert.equal(read.entries.at(-1).text, 'Done: both fixed.');
});

test('no transcript yet answers no entries', async (t) => {
  const dir = home(t);
  const read = await readSessionTranscript({ agent: 'claude', claudeDir: path.join(dir, 'none'), codexHome: dir });
  assert.deepEqual(read, { agent: 'claude', entries: [], partial: false, writtenAt: null });
});

test("codex's newest rollout is found in its newest day folder, compressed or not", async (t) => {
  const dir = home(t);
  const older = path.join(dir, 'sessions', '2026', '11', '01');
  const newer = path.join(dir, 'sessions', '2026', '11', '12');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, 'rollout-a.jsonl'), line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'older' }] } }));
  fs.writeFileSync(path.join(newer, 'rollout-b.jsonl'), CODEX);
  let read = await readSessionTranscript({ agent: 'codex', claudeDir: dir, codexHome: dir });
  assert.deepEqual(read.entries.map((e) => e.text), ['Rename the helper', 'rg helper', 'Renamed in a.js.']);
  if (typeof zlib.zstdCompressSync !== 'function') return t.skip('this node has no zstd');
  fs.rmSync(path.join(newer, 'rollout-b.jsonl'));
  fs.writeFileSync(path.join(newer, 'rollout-b.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(CODEX)));
  read = await readSessionTranscript({ agent: 'codex', claudeDir: dir, codexHome: dir });
  assert.equal(read.entries.at(-1).text, 'Renamed in a.js.');
  // One that unpacks past the cap is left alone, as a compressed file too large to read is.
  const big = Buffer.alloc(MAX_DECOMPRESSED_BYTES + 1, 0x20);
  fs.writeFileSync(path.join(newer, 'rollout-b.jsonl.zst'), zlib.zstdCompressSync(big));
  read = await readSessionTranscript({ agent: 'codex', claudeDir: dir, codexHome: dir });
  assert.deepEqual([read.entries, read.partial], [[], true]);
});

test('a tool run that failed is marked, in claude\'s transcript and in codex\'s rollout', () => {
  const claude = [
    line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'a.js' } },
    ] } }),
    line({ type: 'user', timestamp: at, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Exit code 1' },
      { type: 'tool_result', tool_use_id: 'tu2', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'cut-off-by-the-read', is_error: true, content: 'x' },
    ] } }),
  ].join('\n');
  assert.deepEqual(parseClaudeTranscript(claude), [
    { role: 'tool', tool: 'Bash', text: 'npm test', at, error: true },
    { role: 'tool', tool: 'Read', text: 'a.js', at },
  ]);

  const item = (payload) => line({ type: 'response_item', timestamp: at, payload });
  const codex = [
    item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["npm","test"]}' }),
    item({ type: 'function_call_output', call_id: 'c1', output: '{"output":"1 failing","metadata":{"exit_code":1}}' }),
    item({ type: 'function_call', name: 'shell', call_id: 'c2', arguments: '{"command":["ls"]}' }),
    item({ type: 'function_call_output', call_id: 'c2', output: '{"output":"a.js","metadata":{"exit_code":0}}' }),
    item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c3', input: '*** Begin Patch' }),
    item({ type: 'custom_tool_call_output', call_id: 'c3', output: 'Exit code: 1\nverification failed' }),
    item({ type: 'function_call', name: 'shell', call_id: 'c4', arguments: '{"command":["true"]}' }),
    item({ type: 'function_call_output', call_id: 'c4', output: 'Exit code: 0' }),
  ].join('\n');
  assert.deepEqual(parseCodexRollout(codex).map((e) => [e.text, Boolean(e.error)]), [
    ['npm test', true], ['ls', false], ['*** Begin Patch', true], ['true', false],
  ]);
  const patch = item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c6', input: '*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** Add File: b.js\n+z\n*** End Patch' });
  assert.equal(parseCodexRollout(patch)[0].text, 'a.js b.js', 'a patch is named by its files');
  const wrapped = item({ type: 'function_call', name: 'shell', call_id: 'c5', arguments: '{"command":["bash","-lc","npm test -- --watch"]}' });
  assert.equal(parseCodexRollout(wrapped)[0].text, 'npm test -- --watch', 'the command bash was given, not bash');
});

test('with since, a transcript written no later than the last answer is answered as unchanged, unread', async (t) => {
  const dir = home(t);
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const file = path.join(claudeDir, 'now.jsonl');
  fs.writeFileSync(file, CLAUDE);
  const first = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir });
  assert.ok(first.entries.length > 0);
  assert.deepEqual(await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, since: first.writtenAt }),
    { agent: 'claude', unchanged: true, writtenAt: first.writtenAt });
  fs.appendFileSync(file, `\n${line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'One more.' }] } })}`);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const next = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, since: first.writtenAt });
  assert.equal(next.unchanged, undefined);
  assert.equal(next.entries.at(-1).text, 'One more.');
});

test("claude's AskUserQuestion keeps each question and its options, and whether it was answered", () => {
  const ask = (id, question) => line({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{
    type: 'tool_use', id, name: 'AskUserQuestion',
    input: { questions: [{ question, header: 'Indent', multiSelect: false, options: [{ label: 'Tabs', description: 'Tab characters' }, { label: 'Spaces' }] }] },
  }] } });
  const result = (id, isError) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
  const entries = parseClaudeTranscript([
    ask('q1', 'Tabs or spaces?'), result('q1', false),
    ask('q2', 'Which width?'), result('q2', true),
    ask('q3', 'Still open?'),
  ].join('\n'));
  assert.deepEqual(entries[0], { role: 'tool', tool: 'AskUserQuestion', text: 'Tabs or spaces?', at: '2026-01-01T00:00:01Z',
    questions: [{ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'], descriptions: ['Tab characters', ''] }], answered: true });
  assert.equal(entries[1].error, true, 'Esc on the question');
  assert.equal(entries[1].answered, undefined);
  assert.equal(entries[2].answered, undefined, 'not answered yet');

  const several = parseClaudeTranscript(line({ type: 'assistant', message: { content: [{
    type: 'tool_use', id: 'q4', name: 'AskUserQuestion',
    input: { questions: [{ question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }] }] },
  }] } }));
  assert.deepEqual(several[0].questions, [{ question: 'Which toppings?', options: ['Cheese', 'Olives'], descriptions: ['', ''], multiSelect: true }], 'a multi-select question says so');
});

test("codex's exec script reads as the tools it calls, each failing by its own exit code", () => {
  const call = (id, input) => line({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
  const out = (id, ...codes) => line({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    ...codes.map((exit_code) => ({ type: 'input_text', text: JSON.stringify({ chunk_id: 'x', exit_code, output: '' }) })),
  ] } });
  const entries = parseCodexRollout([
    // As codex 0.167 wrote it.
    call('c1', `text(await tools.exec_command({cmd:"find console/ -type f -name '*.mjs' -printf '.' | wc -c"}))\n`), out('c1', 0),
    call('c2', "const a = await tools.exec_command({ cmd: 'npm test' });\nconst b = await tools.exec_command({cmd:\"ls\"});\ntext(a + b)"), out('c2', 1, 0),
    call('c3', 'text("hello")'),
    // Waiting on a command already in the log is no entry of its own.
    call('c4', 'text(await tools.wait({session_id: 3}))'), out('c4', 0),
  ].join('\n'));
  assert.deepEqual(entries.map((e) => [e.tool, e.text, e.error ?? false]), [
    ['exec_command', "find console/ -type f -name '*.mjs' -printf '.' | wc -c", false],
    ['exec_command', 'npm test', true],
    ['exec_command', 'ls', false],
    ['exec', 'text("hello")', false],
  ]);
});

// Three turns of codex 0.167, cut short (shared/__fixtures__/rollout-codex-interrupted.jsonl, trimmed from a real
// rollout): No at its approval of a command it asked to run outside the read-only sandbox, ■ Stop while it wrote a reply,
// and ■ Stop while a command it was allowed to run was still going. Each ends `aborted by user after Ns` on the call cut
// short, a developer turn that starts `<turn_aborted>`, and an event_msg `turn_aborted` with reason `interrupted`.
const ROLLOUT_INTERRUPTED = fs.readFileSync(new URL('../shared/__fixtures__/rollout-codex-interrupted.jsonl', import.meta.url), 'utf8');

test("codex's interrupted turn ends on claude's own interrupt note, naming the command when its approval was refused", () => {
  const entries = parseCodexRollout(ROLLOUT_INTERRUPTED);
  assert.deepEqual(entries.map((e) => [e.role, e.tool ?? null, e.role === 'user' ? e.text.slice(0, 29) : e.text.slice(0, 40), e.denied ?? null]), [
    ['user', null, 'Please create a file named he', null],
    ['assistant', null, 'I’ll run the exact command you provided.', null],
    ['tool', 'exec_command', 'echo hi > hello-codexfix.txt', null],
    ['user', null, '[Request interrupted by user]', 'echo hi > hello-codexfix.txt'],
    ['user', null, 'Without running any tools, th', null],
    ['user', null, '[Request interrupted by user]', null],
    ['user', null, 'Run exactly `sleep 45; echo s', null],
    ['assistant', null, 'I’ll request approval to run the exact c', null],
    ['tool', 'exec_command', 'sleep 45; echo slept > slept-codexfix.tx', null],
    ['tool', 'write_stdin', '', null],
    ['user', null, '[Request interrupted by user]', null],
  ]);
  assert.ok(entries.every((e) => !e.error), 'a call cut short did not fail');
  assert.equal(entries[3].at, '2026-11-19T17:15:24.013Z', 'one note, at the developer turn, for it and the event after it');
});

test("codex's interrupt is read from either record alone, and a turn a new message replaced has no note", () => {
  const user = line({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } });
  const aborted = (reason) => line({ timestamp: at, type: 'event_msg', payload: { type: 'turn_aborted', reason } });
  const developer = line({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<turn_aborted>\nThe previous turn was interrupted on purpose.\n</turn_aborted>' }] } });
  const notes = (...lines) => parseCodexRollout([user, ...lines].join('\n')).slice(1).map((e) => e.text);
  assert.deepEqual(notes(aborted('interrupted')), ['[Request interrupted by user]']);
  assert.deepEqual(notes(developer), ['[Request interrupted by user]']);
  assert.deepEqual(notes(aborted('replaced')), []);
  // A shell call of the older function form, asking to run outside the sandbox, refused.
  const call = line({ timestamp: at, type: 'response_item', payload: { type: 'function_call', call_id: 'f1', name: 'shell',
    arguments: JSON.stringify({ command: ['bash', '-lc', 'rm -rf build'], with_escalated_permissions: true }) } });
  const out = (output) => line({ timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: 'f1', output } });
  const denied = parseCodexRollout([user, call, out('aborted by user after 3.1s'), aborted('interrupted')].join('\n'));
  assert.equal(denied.at(-1).denied, 'rm -rf build');
  const ran = parseCodexRollout([user, call, out('Exit code: 0'), aborted('interrupted')].join('\n'));
  assert.equal(ran.at(-1).denied, undefined, 'it ran, and the Esc came after');
});

test("claude's edits carry what they changed: the result's hunks once written, none when the edit failed", () => {
  const use = (id, name, input) => line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  // The tool_result and toolUseResult as Claude Code 2.1 writes them.
  const result = (id, text, toolUseResult, isError) => line({ type: 'user', timestamp: at, toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError && { is_error: true }) }] } });
  const entries = parseClaudeTranscript([
    use('e1', 'Edit', { file_path: '/work/repo/a.js', old_string: 'one', new_string: 'two', replace_all: false }),
    result('e1', 'The file /work/repo/a.js has been updated successfully.', {
      filePath: '/work/repo/a.js', oldString: 'one', newString: 'two', originalFile: 'one\n', replaceAll: false, userModified: false,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+two'] }],
    }),
    use('e2', 'MultiEdit', { file_path: '/work/repo/b.js', edits: [{ old_string: 'a', new_string: 'b' }] }),
    use('e3', 'Write', { file_path: '/work/repo/c.md', content: 'hello\n' }),
    result('e3', 'File created successfully at: /work/repo/c.md', { type: 'create', filePath: '/work/repo/c.md', content: 'hello\n', structuredPatch: [], originalFile: null }),
    use('e4', 'Edit', { file_path: '/work/repo/a.js', old_string: 'missing', new_string: 'x' }),
    result('e4', '<tool_use_error>String to replace not found in file.</tool_use_error>', 'Error: String to replace not found in file.', true),
  ].join('\n'), { root: '/work/repo' });
  assert.deepEqual(entries.map((e) => [e.tool, e.text, e.diffs?.map((d) => [d.path, d.op, d.add, d.del, d.hunks.map((h) => h.head)]) ?? null]), [
    ['Edit', '/work/repo/a.js', [['a.js', 'edit', 1, 1, ['@@ -1,1 +1,1 @@']]]],
    // No result yet: the input's own diff, as it lands.
    ['MultiEdit', '/work/repo/b.js', [['b.js', 'edit', 1, 1, ['@@']]]],
    ['Write', '/work/repo/c.md', [['c.md', 'add', 1, 0, ['@@ new file @@']]]],
    ['Edit', '/work/repo/a.js', null],
  ]);
  assert.equal(entries[3].error, true);
});

test("codex's patches carry their hunks: apply_patch, a shell call of it, and a patch in codex 0.167's exec script", () => {
  const item = (payload) => line({ type: 'response_item', timestamp: at, payload });
  const patch = (file) => `*** Begin Patch\n*** Update File: ${file}\n@@ export function total(cart) {\n-  return 5;\n+  return 0;\n*** End Patch\n`;
  const entries = parseCodexRollout([
    item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', status: 'completed', input: patch('src/a.js') }),
    item({ type: 'custom_tool_call_output', call_id: 'p1', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/a.js\n', metadata: { exit_code: 0, duration_seconds: 0 } }) }),
    item({ type: 'function_call', name: 'shell', call_id: 'p2', arguments: JSON.stringify({ command: ['apply_patch', patch('/work/repo/src/b.js')] }) }),
    item({ type: 'function_call_output', call_id: 'p2', output: 'Exit code: 0' }),
    item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p3', input: patch('src/c.js') }),
    item({ type: 'custom_tool_call_output', call_id: 'p3', output: 'Exit code: 1\nverification failed' }),
  ].join('\n'), { root: '/work/repo' });
  assert.deepEqual(entries.map((e) => [e.tool, e.text, e.diffs?.map((d) => [d.path, d.add, d.del, d.hunks[0].head]) ?? null, e.error ?? false]), [
    ['apply_patch', 'src/a.js', [['src/a.js', 1, 1, '@@ export function total(cart) {']], false],
    ['apply_patch', 'src/b.js', [['src/b.js', 1, 1, '@@ export function total(cart) {']], false],
    ['apply_patch', 'src/c.js', null, true],
  ]);

  // An exec script, as codex 0.167 writes one (the cases above): a nested tool takes a string or an object, so a patch
  // is a string literal in the script. Its output is the script's text parts, and each command's JSON with its exit
  // code; one that threw says `Script error:`.
  const call = (id, input) => line({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
  const out = (id, ...texts) => line({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: texts.map((text) => ({ type: 'input_text', text })) } });
  const script = [
    `const r = await tools.apply_patch(${JSON.stringify(patch('src/d.js'))});`,
    'text(r);',
    'text(await tools.exec_command({cmd:"node --test"}));',
  ].join('\n');
  const thrown = `text(await tools.apply_patch(\`${patch('src/e.js')}\`));`;
  const fromScripts = parseCodexRollout([
    call('x1', script),
    out('x1', 'Script completed\nWall time 0.4 seconds\nOutput:\n', 'Success. Updated the following files:\nM src/d.js\n', JSON.stringify({ chunk_id: 'a', exit_code: 1, output: '' })),
    call('x2', thrown),
    out('x2', 'Script error:\nError: apply_patch verification failed: Failed to find expected lines in src/e.js'),
  ].join('\n'));
  assert.deepEqual(fromScripts.map((e) => [e.tool, e.text, e.diffs?.map((d) => d.path) ?? null, e.error ?? false]), [
    ['apply_patch', 'src/d.js', ['src/d.js'], false],
    // The command's exit code is the command's, not the patch's before it.
    ['exec_command', 'node --test', null, true],
    ['apply_patch', 'src/e.js', null, true],
  ]);
});

test("a /transcript answer's diffs stay bounded however many edits the record holds", async (t) => {
  const dir = home(t);
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const big = Array.from({ length: 400 }, (_, i) => line({ type: 'assistant', timestamp: at, message: { content: [{
    type: 'tool_use', id: `w${i}`, name: 'Write', input: { file_path: `/work/repo/f${i}.txt`, content: `${'y'.repeat(300)}\n`.repeat(300) },
  }] } }));
  fs.writeFileSync(path.join(claudeDir, 'big.jsonl'), big.join('\n'));
  const read = await readSessionTranscript({ agent: 'claude', claudeDir, codexHome: dir, root: '/work/repo' });
  const bytes = JSON.stringify(read.entries.map((e) => e.diffs)).length;
  assert.ok(bytes < 260 * 1024, `diffs are ${bytes} bytes`);
  assert.equal(read.entries.at(-1).diffs[0].hunks.length, 1, 'the newest keeps its lines');
  assert.equal(read.entries.at(-1).diffs[0].cut, true, 'cut at its line cap');
  assert.deepEqual([read.entries[0].diffs[0].hunks.length, read.entries[0].diffs[0].cut, read.entries[0].diffs[0].add], [0, true, 300]);
});

test("a codex script's exit codes go to its own commands, never to another tool, and an unplaceable failure is the script's", () => {
  const call = (id, input) => line({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
  const out = (id, ...codes) => line({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [
    { type: 'input_text', text: 'Script completed\nOutput:\n' },
    { type: 'input_text', text: 'a profile' },
    ...codes.map((exit_code) => ({ type: 'input_text', text: JSON.stringify({ chunk_id: 'x', exit_code, output: '' }) })),
  ] } });
  // The review's case: a lookup that succeeded, then a shell command exiting 1.
  const mixed = parseCodexRollout([
    call('m1', 'const p = await tools.view_image({path: "a.png"});\nconst r = await tools.exec_command({cmd: "npm test"});\ntext(r)'),
    out('m1', 1),
  ].join('\n'));
  assert.deepEqual(mixed.map((e) => [e.tool, e.error ?? false]), [['view_image', false], ['exec_command', true]]);
  // A wait reads a command started in another script: its code is no entry's here, so the failure is said as the
  // script's, and the command it ran itself is not blamed.
  const waited = parseCodexRollout([
    call('w1', 'await tools.exec_command({cmd: "ls"});\ntext(await tools.wait({session_id: 7}))'),
    out('w1', 0, 2),
  ].join('\n'));
  assert.deepEqual(waited.map((e) => [e.tool, e.text, e.error ?? false]), [['exec_command', 'ls', false], ['exec', 'a command in this script failed', true]]);
  // More codes than commands: no guessing either.
  const extra = parseCodexRollout([call('x1', 'text(await tools.exec_command({cmd: "make"}))'), out('x1', 1, 0)].join('\n'));
  assert.deepEqual(extra.map((e) => [e.tool, e.error ?? false]), [['exec_command', false], ['exec', true]]);
});

test('a slash command claude keeps in tags is the person\'s message, as typed', () => {
  const user = (content) => line({ type: 'user', timestamp: at, message: { role: 'user', content } });
  const entries = parseClaudeTranscript([
    user('<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args>notion</command-args>'),
    user('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    user('<local-command-stdout>Compacted</local-command-stdout>'),
  ].join('\n'));
  assert.deepEqual(entries.map((e) => [e.role, e.text]), [['user', '/mcp notion'], ['user', '/compact']], 'its output is not the person\'s');
});

test('a prompt that quotes a command tag in its prose is the prompt, not the command', () => {
  const user = (content) => line({ type: 'user', timestamp: at, message: { role: 'user', content } });
  const entries = parseClaudeTranscript(user('Explain <command-name>/help</command-name> in the transcript format.'));
  assert.deepEqual(entries.map((e) => e.text), ['Explain <command-name>/help</command-name> in the transcript format.']);
});

// ---- Grok Build and OpenCode. Their fixtures are made from each agent's documented record shapes (Grok Build's ACP
// updates.jsonl, OpenCode 1.19's SQLite tables): none is a capture from a real session yet.

const FIXTURES = new URL('../shared/__fixtures__/', import.meta.url);
const fixture = (name) => fs.readFileSync(new URL(name, FIXTURES), 'utf8');

test('a Grok Build log joins its chunks, keeps tools with their failures and edits, and skips thoughts and plans', () => {
  const entries = parseGrokUpdates(fixture('transcript-grok-updates.jsonl'), { root: '/work/app' });
  assert.deepEqual(entries.map((e) => [e.role, e.tool ?? null, e.text, e.error ?? false]), [
    ['user', null, 'Fix the login bug', false],
    ['assistant', null, 'Looking at it.', false],
    ['tool', 'execute', 'npm test', true],
    ['tool', 'edit', '/work/app/src/login.js', false],
    ['assistant', null, 'Fixed: the check was inverted.', false],
  ]);
  assert.equal(entries[0].at, new Date(1763900001 * 1000).toISOString());
  assert.equal(entries[3].diffs[0].path, 'src/login.js');
  assert.deepEqual(entries[3].diffs[0].hunks[0].lines, ['-const ok = false;', '+const ok = true;']);
});

test('Grok Build folders are named as its Rust urlencoding names them', () => {
  assert.equal(grokFolderName('/work/my app~'), '%2Fwork%2Fmy%20app~');
});

test('the newest Grok Build session of the checkout is read, not another folder\'s', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  const mine = path.join(home, '.grok/sessions', grokFolderName('/work/app'), 'a');
  const other = path.join(home, '.grok/sessions', grokFolderName('/elsewhere'), 'b');
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(mine, 'updates.jsonl'), fixture('transcript-grok-updates.jsonl'));
  fs.writeFileSync(path.join(other, 'updates.jsonl'), `${JSON.stringify({ timestamp: 1, params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'not this' } } } })}\n`);
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(other, 'updates.jsonl'), later, later);
  const read = await readSessionTranscript({ agent: 'grok', home, root: '/work/app' });
  assert.equal(read.entries[0].text, 'Fix the login bug');
  const again = await readSessionTranscript({ agent: 'grok', home, root: '/work/app', since: read.writtenAt });
  assert.equal(again.unchanged, true);
});

// OpenCode 1.19's tables (packages/opencode core/src/session/sql.ts), with the columns read here.
const OPENCODE_SCHEMA = `
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`;

test('an OpenCode conversation is read from its database: words, tools, failures, edits and an interrupt', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-'));
  const file = openCodeDb(home, {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(OPENCODE_SCHEMA);
  const t = 1763900000000;
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run('ses_old', 'p', null, '/work/app', 'old', t - 9000, t - 9000, null);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run('ses_new', 'p', null, '/work/app', 'new', t, t + 50, null);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run('ses_child', 'p', 'ses_new', '/work/app', 'sub', t, t + 99, null);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  msg.run('msg_1', 'ses_new', t, t, JSON.stringify({ role: 'user', time: { created: t } }));
  part.run('prt_1', 'msg_1', 'ses_new', t, t, JSON.stringify({ type: 'text', text: 'Fix the login bug' }));
  part.run('prt_2', 'msg_1', 'ses_new', t + 1, t + 1, JSON.stringify({ type: 'text', text: 'context', synthetic: true }));
  msg.run('msg_2', 'ses_new', t + 10, t + 10, JSON.stringify({ role: 'assistant', time: { created: t + 10 } }));
  part.run('prt_3', 'msg_2', 'ses_new', t + 11, t + 11, JSON.stringify({ type: 'reasoning', text: 'hmm' }));
  part.run('prt_4', 'msg_2', 'ses_new', t + 12, t + 12, JSON.stringify({ type: 'text', text: 'Looking at it.' }));
  part.run('prt_5', 'msg_2', 'ses_new', t + 13, t + 13, JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', input: { command: 'npm test' }, error: 'exit 1' } }));
  part.run('prt_6', 'msg_2', 'ses_new', t + 14, t + 14, JSON.stringify({ type: 'tool', tool: 'edit', callID: 'c2', state: { status: 'completed', input: { filePath: '/work/app/src/login.js', oldString: 'a', newString: 'b' }, output: '' } }));
  part.run('prt_7', 'msg_2', 'ses_new', t + 15, t + 50, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
  msg.run('msg_3', 'ses_new', t + 20, t + 20, JSON.stringify({ role: 'assistant', time: { created: t + 20 }, error: { name: 'MessageAbortedError', data: {} } }));
  db.close();
  const read = await readSessionTranscript({ agent: 'opencode', home, root: '/work/app' });
  assert.deepEqual(read.entries.map((e) => [e.role, e.tool ?? null, e.text, e.error ?? false]), [
    ['user', null, 'Fix the login bug', false],
    ['assistant', null, 'Looking at it.', false],
    ['tool', 'bash', 'npm test', true],
    ['tool', 'edit', '/work/app/src/login.js', false],
    ['user', null, '[Request interrupted by user]', false],
  ]);
  assert.equal(read.entries[3].diffs[0].path, 'src/login.js');
  assert.equal(read.writtenAt, t + 50);
  assert.equal((await readSessionTranscript({ agent: 'opencode', home, root: '/work/app', since: t + 50 })).unchanged, true);
  assert.deepEqual((await readSessionTranscript({ agent: 'opencode', home, root: '/elsewhere' })).entries, []);
  assert.deepEqual((await readSessionTranscript({ agent: 'opencode', home: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-none-')), root: '/work/app' })).entries, []);
});
