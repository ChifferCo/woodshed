// A stand-in agent for the dev console's chat sessions (devChatSession.mjs), run in the tmux pane where a session runs
// claude or codex. It writes the agent's own record of the conversation, as the real one does: codex's rollout
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) or claude's transcript (~/.claude/projects/<repo>/<id>.jsonl),
// and draws what statusd reads a codex pane by (session/codexState.mjs): `esc to interrupt` while it works, `Would you
// like to run` while it asks, and the `› ` composer once its turn is over.
// A message is typed in and Enter ends it. It answers each with a turn of a few tool calls and a reply. A message that
// says "fail" has a tool call fail, and one that says "ask" waits on a yes first: Enter in the Agent tab gives it. Esc
// stops the turn. Usage: node devChatAgent.mjs codex|claude <record dir> <repo dir>

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
function ran(tool, input, failed = false) {
  const callId = `call_${++call}`;
  if (format === 'codex') {
    // codex edits with apply_patch, a custom tool whose input is the patch, and reads with a shell command.
    if (tool === 'Edit') {
      write({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: `*** Begin Patch\n*** Update File: ${input}\n@@\n-a\n+b\n*** End Patch` } });
      write({ timestamp: now(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: failed ? 'Exit code: 1' : 'Exit code: 0' } });
      return;
    }
    const command = tool === 'Read' ? `sed -n '1,120p' ${input}` : input;
    write({ timestamp: now(), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: callId, arguments: JSON.stringify({ command: ['bash', '-lc', command] }) } });
    write({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ output: failed ? '1 failing' : 'ok', metadata: { exit_code: failed ? 1 : 0 } }) } });
  } else {
    const args = tool === 'Edit' ? { file_path: input, old_string: 'a', new_string: 'b' } : tool === 'Read' ? { file_path: input } : { command: input };
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
ran('Edit', 'console/webhookDispatch.mjs');
ran('Bash', 'node --test console/webhookDispatch.test.mjs');
said('assistant', 'Changed the backoff to 5 s, 15 s and 45 s (`console/webhookDispatch.mjs:42`). The tests pass.');

// ---- The pane.
const out = (s) => process.stdout.write(s);
let screen = 'idle';
let started = 0;
let typed = '';
let timers = [];
let clock = null;
// Messages typed while it works, taken in order once the turn ends, as claude queues them.
const queue = [];
function draw() {
  out('\x1b[2J\x1b[H');
  out(`stand-in ${format} (dev console)\n\n`);
  if (screen === 'working') out(`• Working (${Math.round((Date.now() - started) / 1000)}s • esc to interrupt)\n`);
  if (screen === 'asking') out('Would you like to run the following command?\n\n  $ npm run migrate\n\n› 1. Yes, proceed\n  2. No, and tell me what to do differently\n\nPress enter to confirm or esc to cancel\n');
  if (screen === 'idle') out(`\n› ${typed || 'Ask anything'}`);
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
  after(11000, () => ran('Edit', 'console/webhookDispatch.mjs'));
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
      // A key's sequence (an arrow, a paste's bracket) is not a lone Esc.
      if (chunk[i + 1] === '[' || chunk[i + 1] === 'O') {
        i += 2;
        while (i < chunk.length && !/[A-Za-z~]/.test(chunk[i])) i++;
        continue;
      }
      if (screen !== 'idle') {
        if (format === 'claude') said('user', '[Request interrupted by user]');
        stop({ next: false });
      }
      continue;
    }
    if (screen === 'asking') {
      if (c === '\r') work('Run the migration');
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
