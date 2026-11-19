// A stand-in agent for the dev console's chat sessions (devChatSession.mjs), run in the tmux pane where a session runs
// claude or codex. It writes the agent's own record of the conversation, as the real one does: codex's rollout
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) or claude's transcript (~/.claude/projects/<repo>/<id>.jsonl),
// and draws what statusd reads a codex pane by (session/codexState.mjs): `esc to interrupt` while it works, `Would you
// like to run` while it asks, and the `› ` composer once its turn is over.
// A message is typed in and Enter ends it. It answers each with a turn of a few tool calls and a reply: a read, the
// tests, an edit of one line (codex's apply_patch, claude's Edit with its result's hunk), and a new file (a patch in
// codex 0.167's exec script, claude's Write), each turn's its own, for the Chat's per-turn diffs. A message that
// says "fail" has a tool call fail, and one that says "ask" waits on an approval first: ↑/↓ and Enter in the TUI tab,
// y or n, or the Chat tab's Approve and Deny (session/panePrompt.mjs reads it as it reads codex's). Esc stops the turn.
// The approval is a stand-in: its words are codex 0.167's own (its title and options, from the strings in the codex
// binary: `Would you like to run the following command?`, `Yes, just this once`, `Yes, and don't ask again for this
// command in this session`, `No, and tell Codex what to do differently`, `Press enter to confirm or esc to cancel`), and
// its layout (the `›` on the highlighted row, the numbers, each option's key after it) is how codex's list draws them,
// as far as could be told without a signed-in codex to capture.
// Usage: node devChatAgent.mjs codex|claude <record dir> <repo dir>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [format, dir, repo] = process.argv.slice(2);
const now = () => new Date().toISOString();
const id = crypto.randomUUID();
let file;
if (format === 'codex') {
  const d = new Date();
  const day = path.join(dir, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  file = path.join(day, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
} else {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `${id}.jsonl`);
}
const write = (record) => fs.appendFileSync(file, `${JSON.stringify(record)}\n`);

// ---- One record line for each thing said or run, in the agent's own shape.
let call = 0;
function said(role, text) {
  if (format === 'codex') {
    write({ timestamp: now(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  } else {
    write({ type: role, timestamp: now(), uuid: crypto.randomUUID(), message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } });
  }
}
// An edit: a file, the line it starts at, and the line it replaces with another, with a line of context each side.
const FILE = 'console/webhookDispatch.mjs';
const edit = (from, to) => ({ file: FILE, at: 12, before: '// How long each retry waits.', old: `const BACKOFF_MS = ${from};`, new: `const BACKOFF_MS = ${to};`, after: '' });
const patchOf = (e) => `*** Begin Patch\n*** Update File: ${e.file}\n@@ ${e.before}\n-${e.old}\n+${e.new}\n*** End Patch\n`;
const applied = (files) => JSON.stringify({ output: `Success. Updated the following files:\n${files.join('\n')}\n`, metadata: { exit_code: 0, duration_seconds: 0 } });

function ran(tool, input, failed = false) {
  const callId = `call_${++call}`;
  if (format === 'codex') {
    // codex edits with apply_patch, a custom tool whose input is the patch, and reads with a shell command.
    if (tool === 'Edit') {
      write({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'apply_patch', call_id: callId, input: patchOf(input) } });
      write({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: failed ? 'Exit code: 1' : applied([`M ${input.file}`]) } });
      return;
    }
    // codex 0.167 runs tools from an `exec` script: here, one that adds a file with a patch, then runs a command.
    if (tool === 'Script') {
      const patch = `*** Begin Patch\n*** Add File: ${input.file}\n${input.lines.map((l) => `+${l}`).join('\n')}\n*** End Patch\n`;
      const script = `const patched = await tools.apply_patch(${JSON.stringify(patch)});\ntext(patched);\ntext(await tools.exec_command({cmd:"node --test console/webhookDispatch.test.mjs"}));\n`;
      write({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', name: 'exec', call_id: callId, input: script } });
      write({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.6 seconds\nOutput:\n' },
        { type: 'input_text', text: `Success. Updated the following files:\nA ${input.file}\n` },
        { type: 'input_text', text: JSON.stringify({ chunk_id: 'a1', wall_time_seconds: 0.5, exit_code: 0, original_token_count: 3, output: 'ok\n' }) },
      ] } });
      return;
    }
    const command = tool === 'Read' ? `sed -n '1,120p' ${input}` : input;
    write({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: callId, arguments: JSON.stringify({ command: ['bash', '-lc', command] }) } });
    write({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ output: failed ? '1 failing' : 'ok', metadata: { exit_code: failed ? 1 : 0 } }) } });
  } else {
    if (tool === 'Edit') {
      // claude's Edit, and its result as Claude Code writes it: toolUseResult's structuredPatch holds the real hunk.
      const filePath = path.join(repo, input.file);
      write({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Edit', input: { file_path: filePath, old_string: input.old, new_string: input.new, replace_all: false } }] } });
      write({ type: 'user', timestamp: now(),
        toolUseResult: { filePath, oldString: input.old, newString: input.new, originalFile: '', replaceAll: false, userModified: false,
          structuredPatch: [{ oldStart: input.at - 1, oldLines: 3, newStart: input.at - 1, newLines: 3, lines: [` ${input.before}`, `-${input.old}`, `+${input.new}`, ` ${input.after}`] }] },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: failed, content: failed ? 'String to replace not found' : `The file ${filePath} has been updated successfully.` }] } });
      return;
    }
    if (tool === 'Script') {
      // claude writes a new file with Write: a create's result has no hunks, so the content is the file.
      const filePath = path.join(repo, input.file);
      const content = `${input.lines.join('\n')}\n`;
      write({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Write', input: { file_path: filePath, content } }] } });
      write({ type: 'user', timestamp: now(), toolUseResult: { type: 'create', filePath, content, structuredPatch: [], originalFile: null, userModified: false },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: `File created successfully at: ${filePath}` }] } });
      return;
    }
    const args = tool === 'Read' ? { file_path: input } : { command: input };
    write({ type: 'assistant', timestamp: now(), message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: tool, input: args }] } });
    write({ type: 'user', timestamp: now(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: failed, content: failed ? 'Exit code 1' : 'ok' }] } });
  }
}

// ---- A conversation that happened before the page opened.
if (format === 'codex') write({ timestamp: now(), type: 'session_meta', payload: { id, cwd: repo } });
said('user', 'Why do webhook deliveries fail after a deploy?');
ran('Read', 'console/webhookDispatch.mjs');
ran('Bash', 'rg -n "retry" console/webhookDispatch.mjs');
ran('Bash', 'node --test console/webhookDispatch.test.mjs', true);
ran('Bash', 'node --test console/webhookDispatch.test.mjs');
said('assistant', [
  '## What happens',
  '',
  'A deploy stops the console for **a few seconds**, and the first retry lands while it is away:',
  '',
  '1. The delivery fails with `ECONNREFUSED`.',
  '2. The retry waits 2 s, then 4 s, then 8 s.',
  '3. It gives up after the fifth try.',
  '',
  '| Try | Wait | Console up? |',
  '| --- | ---: | --- |',
  '| 1 | 2 s | no |',
  '| 2 | 4 s | no |',
  '| 3 | 8 s | yes |',
  '',
  'The backoff is in `console/webhookDispatch.mjs`:',
  '',
  '```js',
  'const BACKOFF_MS = [2_000, 4_000, 8_000];',
  'await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1));',
  '```',
  '',
  'See https://docs.github.com/en/webhooks for how GitHub retries on its side.',
].join('\n'));
said('user', 'Make it back off for longer');
ran('Edit', edit('[2_000, 4_000, 8_000]', '[5_000, 15_000, 45_000]'));
ran('Bash', 'node --test console/webhookDispatch.test.mjs');
said('assistant', 'Changed the backoff to 5 s, 15 s and 45 s (`console/webhookDispatch.mjs:42`). The tests pass.');

// ---- The pane.
const out = (s) => process.stdout.write(s);
let screen = 'idle';
// codex's approval options, each with its key, and the one highlighted.
const APPROVAL = [['Yes, just this once', 'y'], ['Yes, and don\'t ask again for this command in this session', 'a'], ['No, and tell Codex what to do differently', 'esc']];
let approvalAt = 0;
let started = 0;
let typed = '';
let timers = [];
let clock = null;
// Messages typed while it works, taken in order once the turn ends, as claude queues them.
const queue = [];
let turns = 0;
function draw() {
  out('\x1b[2J\x1b[H');
  out(`stand-in ${format} (dev console)\n\n`);
  if (screen === 'working' && format === 'claude') {
    // claude's own working screen: its box between rules, the turn's line under them, as statusd reads claude's pane.
    const rule = '─'.repeat(60);
    out(`\n${rule}\n❯\u00a0\n${rule}\n  ✻ Working… (${Math.round((Date.now() - started) / 1000)}s · esc to interrupt)\n`);
  } else if (screen === 'working') out(`• Working (${Math.round((Date.now() - started) / 1000)}s • esc to interrupt)\n`);
  if (screen === 'asking') {
    out('Would you like to run the following command?\n\n  Reason: the tests need the new column\n\n  $ npm run migrate\n\n');
    APPROVAL.forEach(([label, key], i) => out(`${i === approvalAt ? '›' : ' '} ${i + 1}. ${label} (${key})\n`));
    out('\n  Press enter to confirm or esc to cancel\n');
  }
  // Each agent's input box as it draws it: claude's `❯` between rules, codex's `›`, the hint in an empty one dim
  // (SGR 2), as statusd reads it (composerEmpty, session/panePrompt.mjs).
  const hint = (text) => `\x1b[2m${text}\x1b[0m`;
  if (screen === 'idle' && format === 'claude') {
    const rule = '─'.repeat(60);
    out(`\n${rule}\n❯\u00a0${typed || hint('Try "fix lint errors"')}\n${rule}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`);
  } else if (screen === 'idle') out(`\n\x1b[1m›\x1b[0m ${typed || hint('Ask anything')}\n\n  stand-in codex · /tmp/fx/repo\n`);
}

function after(ms, step) {
  timers.push(setTimeout(step, ms));
}

function stop({ next = true } = {}) {
  for (const t of timers) clearTimeout(t);
  timers = [];
  clearInterval(clock);
  screen = 'idle';
  draw();
  if (!next) queue.length = 0;
  else if (queue.length) submit(queue.shift());
}

function work(text) {
  screen = 'working';
  started = Date.now();
  clock = setInterval(draw, 1000);
  draw();
  const fail = /fail/i.test(text);
  after(3000, () => ran('Read', 'console/webhookDispatch.mjs'));
  after(7000, () => ran('Bash', 'node --test console/webhookDispatch.test.mjs', fail));
  // Each turn changes the backoff again and adds a note of its own, so a turn's diff is its own.
  turns++;
  after(9000, () => ran('Edit', edit(`[${turns + 4}_000, 15_000, 45_000]`, `[${turns + 5}_000, 15_000, 45_000]`)));
  after(11000, () => ran('Script', { file: `docs/notes/turn-${turns}.md`, lines: [`# Turn ${turns}`, '', `You asked: ${text.split('\n')[0]}`] }));
  after(16000, () => {
    said('assistant', fail
      ? `One test failed on the first run (\`webhookDispatch.test.mjs\`), so I fixed the edit and ran it again: it passes now.\n\nYou asked: _${text.split('\n')[0]}_`
      : `Done. You asked:\n\n> ${text.split('\n')[0]}\n\nI read the dispatcher, ran its tests and made the change.`);
    stop();
  });
}

function submit(text) {
  if (!text.trim()) return;
  said('user', text);
  if (/\bask\b/i.test(text)) {
    screen = 'asking';
    approvalAt = 0;
    draw();
    return;
  }
  work(text);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c === '\x03') process.exit(0);
    if (c === '\x1b') {
      // A key's sequence (an arrow, a paste's bracket) is not a lone Esc. ↑ and ↓ move the approval's highlight.
      if (chunk[i + 1] === '[' || chunk[i + 1] === 'O') {
        i += 2;
        while (i < chunk.length && !/[A-Za-z~]/.test(chunk[i])) i++;
        if (screen === 'asking' && (chunk[i] === 'A' || chunk[i] === 'B')) {
          approvalAt = Math.max(0, Math.min(APPROVAL.length - 1, approvalAt + (chunk[i] === 'B' ? 1 : -1)));
          draw();
        }
        continue;
      }
      if (screen !== 'idle') {
        if (format === 'claude') said('user', '[Request interrupted by user]');
        stop({ next: false });
      }
      continue;
    }
    if (screen === 'asking') {
      const picked = c === '\r' ? approvalAt : c === 'y' ? 0 : c === 'a' ? 1 : c === 'n' ? 2 : null;
      if (picked === 2) {
        stop({ next: false });
      } else if (picked !== null) work('Run the migration');
      continue;
    }
    if (screen === 'working' && c === '\r') {
      if (typed.trim()) queue.push(typed);
      typed = '';
      continue;
    }
    if (screen === 'working') {
      if (c !== '\x7f') typed += c;
      continue;
    }
    if (c === '\r') {
      const text = typed;
      typed = '';
      submit(text);
      if (screen === 'idle') draw();
    } else if (c === '\x7f') {
      typed = typed.slice(0, -1);
      draw();
    } else {
      typed += c;
      draw();
    }
  }
});
draw();
