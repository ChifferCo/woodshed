import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { agyAnswer, stateForAgyHook, stateForHook, runningShells } from './hookState.mjs';

const run = promisify(execFile);

// The firings a turn produced in a probe on Claude Code 2.1.311, in order.
test('a turn reads working, then needs-you at a dialog, then done', () => {
  // SessionStart resets what an earlier claude in the container left; a Woodshed session's first prompt comes after it.
  assert.equal(stateForHook({ hook_event_name: 'SessionStart', source: 'startup' }), 'done');
  assert.equal(stateForHook({ hook_event_name: 'UserPromptSubmit' }), 'working');
  assert.equal(stateForHook({ hook_event_name: 'PreToolUse', tool_name: 'Write' }), 'working');
  assert.equal(stateForHook({ hook_event_name: 'PermissionRequest', tool_name: 'Write' }), 'needs-you');
  assert.equal(stateForHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), 'needs-you');
  assert.equal(stateForHook({ hook_event_name: 'PostToolUse', tool_name: 'Write' }), 'working');
  assert.equal(stateForHook({ hook_event_name: 'Stop' }), 'done');
});

test('the idle reminder and a background agent\'s tool calls change nothing', () => {
  // Both fire on a claude that is already done; either would hide the waiting banner.
  assert.equal(stateForHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
  assert.equal(stateForHook({ hook_event_name: 'PostToolUse', agent_id: 'a1' }), null);
  assert.equal(stateForHook({ hook_event_name: 'SubagentStop' }), null);
});

// The firings around a background agent in a probe on Claude Code 2.1.311, in order.
test('a turn that ends with a background agent running reads working until claude stops with none left', () => {
  const agent = { id: 'a3e5', type: 'subagent', status: 'running', agent_type: 'general-purpose' };
  assert.equal(stateForHook({ hook_event_name: 'Stop', background_tasks: [agent] }), 'working');
  assert.equal(stateForHook({ hook_event_name: 'PreToolUse', agent_id: 'a3e5', tool_name: 'Bash' }), null);
  // The agent's result wakes claude as a prompt of its own.
  assert.equal(stateForHook({ hook_event_name: 'UserPromptSubmit' }), 'working');
  assert.equal(stateForHook({ hook_event_name: 'SubagentStop', agent_id: 'a3e5', background_tasks: [agent] }), null);
  assert.equal(stateForHook({ hook_event_name: 'Stop', background_tasks: [] }), 'done');
});

test('a background shell or a finished agent does not hold the session at working', () => {
  const shell = { id: 'b1', type: 'shell', status: 'running' };
  const finished = { id: 'a1', type: 'subagent', status: 'completed' };
  assert.equal(stateForHook({ hook_event_name: 'Stop', background_tasks: [shell, finished] }), 'done');
});

test('a turn that ends with waiting shells running records how many, and no other firing does', () => {
  const watch = { id: 'b1', type: 'shell', status: 'running', command: "until [ \"$(gh run list --branch x --limit 1 --json status --jq '.[0].status')\" = completed ]; do sleep 30; done" };
  const pr = { id: 'b2', type: 'shell', status: 'running', command: 'gh pr view 12 --json reviews' };
  const done = { id: 'b3', type: 'shell', status: 'completed', command: 'gh run list' };
  const agent = { id: 'a1', type: 'subagent', status: 'running' };
  assert.equal(runningShells({ hook_event_name: 'Stop', background_tasks: [watch, pr, done, agent] }), 2);
  assert.equal(runningShells({ hook_event_name: 'Stop', background_tasks: [{ type: 'shell', status: 'running', command: 'sleep 120' }] }), 1);
  assert.equal(runningShells({ hook_event_name: 'Stop', background_tasks: [] }), 0);
  assert.equal(runningShells({ hook_event_name: 'Stop' }), 0);
  assert.equal(runningShells({ hook_event_name: 'UserPromptSubmit', background_tasks: [watch] }), 0);
});

test('other jobs that end count too: a deploy wait, a health check, a poll loop, a test run', () => {
  const job = (command) => ({ type: 'shell', status: 'running', command });
  const commands = ['aws ecs wait services-stable --cluster c --services s', 'curl -sf localhost:9000/health', 'kubectl rollout status deploy/api',
    'while ! nc -z localhost 5432; do sleep 1; done', 'npm test -- --run', 'npx playwright test'];
  assert.equal(runningShells({ hook_event_name: 'Stop', background_tasks: commands.map(job) }), commands.length);
});

test('a dev server or a shell with no command is not a waiting job', () => {
  const server = (command) => ({ type: 'shell', status: 'running', command });
  assert.equal(runningShells({ hook_event_name: 'Stop', background_tasks: [server('npm run dev'), server('node server.js --port 3001'), server('cd app && npm start'), { type: 'shell', status: 'running' }] }), 0);
});

test('a start script\'s command lines are not waiting jobs', () => {
  // A start script that starts each server with `setsid ... &` and exits once they answer means claude never holds the
  // servers as shells. Run in the background, the wrapper's own command line still matches nothing here.
  const job = (command) => ({ type: 'shell', status: 'running', command });
  const commands = ['bash scripts/serve.sh start', 'bash scripts/serve.sh status', 'bash scripts/serve.sh stop', 'scripts/serve.sh start'];
  assert.equal(runningShells({ hook_event_name: 'Stop', background_tasks: commands.map(job) }), 0);
});

test('the hook prints nothing, since a UserPromptSubmit hook\'s output goes into claude\'s context', async () => {
  const script = fileURLToPath(new URL('./hookState.mjs', import.meta.url));
  const child = run('node', [script]);
  child.child.stdin.end(JSON.stringify({ hook_event_name: 'SubagentStop' }));
  const { stdout, stderr } = await child;
  assert.equal(stdout + stderr, '');
});

test('Grok Build\'s camelCase hooks read the same: a turn, an approval, an interrupt and its idle backstop', () => {
  const grok = (hookEventName, extra = {}) => stateForHook({ hookEventName, sessionId: 's', promptId: 'p', ...extra });
  assert.equal(grok('SessionStart'), 'done');
  assert.equal(grok('UserPromptSubmit'), 'working');
  assert.equal(grok('PreToolUse', { toolName: 'bash' }), 'working');
  assert.equal(grok('Notification', { notificationType: 'permission_prompt' }), 'needs-you');
  assert.equal(grok('PostToolUse', { toolName: 'bash' }), 'working');
  assert.equal(grok('StopCancelled'), 'done');
  assert.equal(grok('StopFailure'), 'done');
  assert.equal(grok('Notification', { notificationType: 'idle_prompt' }), 'done');
  assert.equal(grok('Notification', { notificationType: 'task_complete' }), null);
  assert.equal(grok('Stop'), 'done');
  // A subagent's events are not the session's.
  assert.equal(grok('Stop', { subagentType: 'explore' }), null);
  assert.equal(grok('PreToolUse', { subagentType: 'explore' }), null);
  // claude's idle reminder still says nothing new.
  assert.equal(stateForHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
});

// agy 1.5.18's hooks (~/.gemini/config/hooks.json), in the order a turn with one command fired them, measured against a
// stand-in model: none as it opens, SessionStart with the first message, then each model call and tool.
test('agy\'s hooks: every event of a turn is working, its Stop is done, and the model call\'s end says nothing', () => {
  const agy = (hookEventName) => stateForAgyHook({ hookEventName, conversationId: 'c', workspacePaths: ['/work/app'] });
  assert.equal(agy('SessionStart'), 'working');
  assert.equal(agy('PreInvocation'), 'working');
  assert.equal(agy('PreToolUse'), 'working');
  assert.equal(agy('PostToolUse'), 'working');
  // It fires after each model call, tools included: another call, or the Stop, follows.
  assert.equal(agy('PostInvocation'), null);
  assert.equal(agy('Stop'), 'done');
  assert.equal(agy('Notification'), null);
});

test('agy\'s hook answers allow to a tool call and {} to the rest, never the {} that denies one', () => {
  assert.deepEqual(agyAnswer({ hookEventName: 'PreToolUse' }), { decision: 'allow' });
  for (const hookEventName of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop', 'PostToolUse']) assert.deepEqual(agyAnswer({ hookEventName }), {}, hookEventName);
});

test('run for agy, the hook answers on stdout and records the state and the transcript it names', async () => {
  const script = fileURLToPath(new URL('./hookState.mjs', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-'));
  const stateFile = path.join(dir, 'state.json');
  const fire = async (payload) => {
    const child = run('node', [script, 'agy'], { env: { PATH: process.env.PATH, WOODSHED_CLAUDE_STATE_FILE: stateFile, WOODSHED_OPENED_PULLS_FILE: path.join(dir, 'pulls.json') } });
    child.child.stdin.end(JSON.stringify(payload));
    return (await child).stdout;
  };
  const conversationId = '23af8bc5-836e-4660-b87c-a649091d8ba1';
  const transcriptPath = `/home/node/.gemini/antigravity-cli/brain/${conversationId}/.system_generated/logs/transcript_full.jsonl`;
  assert.equal(await fire({ hookEventName: 'PreToolUse', conversationId, transcriptPath, toolCall: { name: 'run_command', args: {} } }), '{"decision":"allow"}');
  const written = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual([written.state, written.event, written.transcript, written.conversation], ['working', 'PreToolUse', transcriptPath, conversationId]);
  assert.equal(await fire({ hookEventName: 'Stop', conversationId, transcriptPath, terminationReason: 'NO_TOOL_CALL' }), '{}');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).state, 'done');
  // An event that says nothing leaves the file as it was, and still answers.
  assert.equal(await fire({ hookEventName: 'PostInvocation', conversationId }), '{}');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).state, 'done');
  fs.rmSync(dir, { recursive: true, force: true });
});
