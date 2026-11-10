import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { stateForHook, runningShells } from './hookState.mjs';

const run = promisify(execFile);

// The firings a turn produced in a probe on Claude Code 2.1.311, in order.
test('a turn reads working, then needs-you at a dialog, then done', () => {
  // SessionStart resets what an earlier claude in the container left; a Cloud session's first prompt comes after it.
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
