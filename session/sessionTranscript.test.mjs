import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { MAX_DECOMPRESSED_BYTES, MAX_TEXT, parseClaudeTranscript, parseCodexRollout, readSessionTranscript } from './sessionTranscript.mjs';

const line = (o) => JSON.stringify(o);
const at = '2026-11-12T10:00:00.000Z';

// Lines as claude writes them (measured on Claude Code 2.x): a typed prompt as a string, a reply in blocks, a tool call
// and its result, thinking, a slash command's wrapper, a subagent's sidechain, and records that are not turns.
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
    questions: [{ question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }], answered: true });
  assert.equal(entries[1].error, true, 'Esc on the question');
  assert.equal(entries[1].answered, undefined);
  assert.equal(entries[2].answered, undefined, 'not answered yet');

  const several = parseClaudeTranscript(line({ type: 'assistant', message: { content: [{
    type: 'tool_use', id: 'q4', name: 'AskUserQuestion',
    input: { questions: [{ question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }] }] },
  }] } }));
  assert.deepEqual(several[0].questions, [{ question: 'Which toppings?', options: ['Cheese', 'Olives'], multiSelect: true }], 'a multi-select question says so');
});
