import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, whyEnded } from './runLog.mjs';

const line = (o) => JSON.stringify(o);
const said = (text) => line({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash' }] } });
const toolError = (text) => line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: text }] } });

test('a pass that ran out of turns says so, with its numbers, its tool errors and what it last said', () => {
  const stream = [said('Opening the app'), toolError('net::ERR_CONNECTION_REFUSED at http://localhost:3999'), said('Retrying'),
    line({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 200, duration_ms: 61000, total_cost_usd: 3.5,
      permission_denials: [{ tool_name: 'Bash' }] })].join('\n');
  const text = summarize('test', stream);
  assert.match(text, /^## test\nEnded: ran out of turns before it finished \(error_max_turns\)/);
  assert.match(text, /Permission denied: 1 call \(Bash\)/);
  assert.match(text, /Ran: 200 turns, 2 tool calls, 61 s, \$3\.50/);
  assert.match(text, /Tool errors: 1[\s\S]*ERR_CONNECTION_REFUSED/);
  assert.match(text, /Last said \(2 of 2\):\n {2}> Opening the app\n {2}> Retrying/);
  assert.equal(whyEnded('test', stream), 'the test pass ran out of turns before it finished (200 turns)');
});

test('a pass with no result was stopped or crashed, and what claude printed instead of its stream is kept', () => {
  const stream = `${said('Working')}\nError: Claude usage limit reached`;
  assert.match(summarize('test', stream), /Ended: no result from claude[\s\S]*Other output[\s\S]*usage limit reached/);
  assert.equal(whyEnded('test', stream), 'the test pass ended without a result: claude was stopped or crashed');
});

test('a pass that finished well has no reason to give, and one that never ran says so', () => {
  const stream = [said('Done'), line({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.1 })].join('\n');
  assert.equal(whyEnded('plan', stream), null);
  assert.match(summarize('plan', stream), /Ended: finished \(success\)/);
  assert.equal(summarize('test', null), '## test\nDid not run.\n');
});

test('an error result gives its message', () => {
  const stream = line({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low', num_turns: 1 });
  assert.equal(whyEnded('test', stream), 'the test pass ended in an error');
});

test('what claude or its tools printed never reaches the published reason, only the run log', () => {
  const secret = 'PRIVATE-MARKER-https://x.example/?token=abc';
  const crashed = `${said('hi')}\nError: ${secret}`;
  const errored = line({ type: 'result', subtype: 'success', is_error: true, result: secret });
  for (const stream of [crashed, errored]) {
    assert.doesNotMatch(whyEnded('test', stream), /PRIVATE-MARKER|token/);
    assert.match(summarize('test', stream), /PRIVATE-MARKER/, 'the console-only log keeps it');
  }
});
