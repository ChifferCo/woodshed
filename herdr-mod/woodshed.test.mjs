import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionOfMachine, terminalName, terminalKind, newSessionArgs, jsonLines, startProgress, errorOf, outcomeOf, pauseText,
  mayExtend, newlyBlocked, blockedNotice,
} from './woodshed/woodshed.js';

// The lines below are what the command line prints with --json: `session new` (cli/sessions.mjs).

test('a session is known by its machine, woodshed-<id>, and nothing else', () => {
  assert.equal(sessionOfMachine('woodshed-ab12cd34'), 'ab12cd34');
  for (const name of [null, undefined, 'acme-dev-box', 'woodshed-AB12CD34', 'woodshed-ab12cd3', 'woodshed-ab12cd345', 'x-woodshed-ab12cd34']) {
    assert.equal(sessionOfMachine(name), null, String(name));
  }
});

test('background terminals are named for what they run, within herdr-core\'s 32 characters', () => {
  const name = terminalName('new', Date.now().toString(36));
  assert.ok(/^[a-z0-9_-]{1,32}$/.test(name), name);
  assert.deepEqual(terminalKind(terminalName('new', 'k1')), { kind: 'new', id: 'k1' });
  assert.equal(terminalKind('woodshed-fwd-ab12cd34'), null);
  assert.equal(terminalKind('claude'), null);
  assert.equal(terminalKind('woodshed-other-ab12cd34'), null);
});

test('New session passes only what was filled in, and the prompt after --', () => {
  assert.deepEqual(newSessionArgs({ agent: 'claude' }), ['session', 'new', '--json', '--agent', 'claude']);
  assert.deepEqual(
    newSessionArgs({ repo: ' acme/app ', branch: '123', agent: 'codex', prompt: '--help is broken' }),
    ['session', 'new', '--json', '--repo', 'acme/app', '--branch', '123', '--agent', 'codex', '--', '--help is broken'],
  );
  assert.deepEqual(newSessionArgs({ agent: 'sh -c x' }), ['session', 'new', '--json']);
});

test('a start is followed from its JSON lines, a line still being written skipped', () => {
  const session = { id: 'ab12cd34', url: 'https://console.example.com/s/ab12cd34' };
  const lines = [
    JSON.stringify({ event: 'started', session }),
    JSON.stringify({ event: 'status', id: 'ab12cd34', status: 'queued' }),
    JSON.stringify({ event: 'step', id: 'ab12cd34', step: 'machine', label: 'Getting a machine' }),
    JSON.stringify({ event: 'step', id: 'ab12cd34', step: 'container', label: 'Starting the container' }),
  ];
  const midway = startProgress(`${lines.join('\n')}\n{"event":"step","id":"ab1`);
  assert.deepEqual(midway.steps, ['Getting a machine', 'Starting the container']);
  assert.equal(midway.end, null);
  assert.equal(midway.session.id, 'ab12cd34');
  const done = startProgress([...lines, JSON.stringify({ event: 'needs-you', session: { ...session, state: 'needs-you' } })].join('\n'));
  assert.equal(done.end, 'needs-you');
  assert.equal(done.session.state, 'needs-you');
  assert.equal(startProgress('{"event":"error","status":"refused","error":"You cannot start sessions on x"}').error, 'You cannot start sessions on x');
});

test('a failure says the command line\'s own reason', () => {
  assert.equal(errorOf({ stdout: '{"event":"error","status":"signed-out","error":"Not signed in"}\n', stderr: '' }), 'Not signed in');
  assert.equal(errorOf({ stdout: '', stderr: 'woodshed: the console did not answer\n' }), 'the console did not answer');
  assert.equal(errorOf({}), 'the woodshed command failed');
  assert.deepEqual([0, 1, 2, 3].map((c) => outcomeOf(c).word), ['Done', 'Failed', 'Waiting on you', 'Refused']);
});

test('pause text and Extend follow the console\'s last 15 minutes', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  assert.equal(pauseText({ at: at(42), why: 'idle' }, now), 'pauses in 42m');
  assert.equal(pauseText({ at: at(125), why: 'lifetime' }, now), 'stops in 2h 5m');
  assert.equal(pauseText(null, now), '');
  assert.equal(mayExtend({ status: 'running', pause: { at: at(14) } }, now), true);
  assert.equal(mayExtend({ status: 'running', pause: { at: at(16) } }, now), false);
  assert.equal(mayExtend({ status: 'stopped', pause: { at: at(5) } }, now), false);
  assert.equal(mayExtend({ status: 'running', pause: null }, now), false);
});

test('an agent in a session\'s machine that becomes blocked is told once, naming its session', () => {
  const spaces = [{ id: 's1', machine: null }, { id: 'woodshed-ab12cd34/s1', machine: 'woodshed-ab12cd34' }];
  const agent = (address, space, status) => ({ address, space, status, tab_name: 'fix login', program: { name: 'Claude Code' } });
  const seen = new Map();
  assert.deepEqual(newlyBlocked(seen, [agent('t1', 's1', 'blocked'), agent('woodshed-ab12cd34/t2', 'woodshed-ab12cd34/s1', 'working')], spaces), []);
  const now = newlyBlocked(seen, [agent('t1', 's1', 'blocked'), agent('woodshed-ab12cd34/t2', 'woodshed-ab12cd34/s1', 'blocked')], spaces);
  assert.deepEqual(now.map((b) => [b.address, b.session]), [['woodshed-ab12cd34/t2', 'ab12cd34']]);
  assert.deepEqual(newlyBlocked(seen, [agent('woodshed-ab12cd34/t2', 'woodshed-ab12cd34/s1', 'blocked')], spaces), [], 'still blocked: told once');
  assert.deepEqual(newlyBlocked(seen, [], spaces), []);
  assert.equal(seen.size, 0, 'an agent that went is forgotten');
  const notice = blockedNotice(now[0], [{ id: 'ab12cd34', title: 'Fix the login loop' }]);
  assert.equal(notice.title, 'Woodshed ab12cd34 needs you');
  assert.equal(notice.body, 'Claude Code in "Fix the login loop", tab fix login');
  assert.deepEqual(notice.action, { name: 'agent.focus', args: { terminal: 'woodshed-ab12cd34/t2' } });
});

test('jsonLines keeps objects only', () => {
  assert.deepEqual(jsonLines('plain\n{"a":1}\n[1]\n{bad\n'), [{ a: 1 }]);
});
