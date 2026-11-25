import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, summarize, whyEnded } from './runLog.mjs';

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

test('redact takes credentials out of free text, whatever prints them, and the environment\'s own secrets by value', () => {
  const env = { NPM_REGISTRY_TOKEN: 'registry-value-1234', HOME: '/home/x' };
  const dirty = [
    'npm ERR! //registry.example/:_authToken=abcdef1234567890', 'Authorization: Bearer abc.def.ghi-12345',
    'git clone https://user:pw123@example.com/r.git', 'used ghp_AbCdEfGh1234567890 and registry-value-1234',
    'fetch https://api.example/x?api_key=SECRETVALUE99&page=2', 'password: "hunter2hunter2"',
  ].join('\n');
  const clean = redact(dirty, env);
  for (const secret of ['abcdef1234567890', 'abc.def.ghi-12345', 'pw123', 'ghp_AbCdEfGh1234567890', 'registry-value-1234', 'SECRETVALUE99', 'hunter2hunter2']) {
    assert.ok(!clean.includes(secret), `${secret} is gone`);
  }
  assert.match(clean, /page=2/, 'ordinary text stays');
  assert.match(clean, /https:\/\/\[redacted\]@example\.com\/r\.git/);
});

test('a credential in a tool error, a message or the output never reaches the summary', () => {
  const stream = [toolError('npm ERR! _authToken=abcdef1234567890'), said('I used ghp_AbCdEfGh1234567890'), 'stderr: Bearer abc.def.ghi-12345'].join('\n');
  const clean = redact(summarize('test', stream), {});
  assert.doesNotMatch(clean, /abcdef1234567890|ghp_AbCdEfGh|abc\.def\.ghi/);
  assert.match(clean, /Tool errors: 1/);
});

test('redact takes out a credential in JSON, and the variables the installation names as install secrets', () => {
  const env = { BUNDLE_GEMS__EXAMPLE__COM: 'gem-user:gempass-9876', WOODSHED_INSTALL_SECRETS: 'BUNDLE_GEMS__EXAMPLE__COM' };
  const clean = redact('{"user":"u","password":"opaqueValue123","nested":{"api_key": "k-opaque-456"}} and gem-user:gempass-9876', env);
  assert.doesNotMatch(clean, /opaqueValue123|k-opaque-456|gempass/);
  assert.match(clean, /"user":"u"/, 'what is not a credential stays');
});
