import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { MAX_TEXT, parseClaudeTranscript, parseCodexRollout, readSessionTranscript } from './sessionTranscript.mjs';

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
});
