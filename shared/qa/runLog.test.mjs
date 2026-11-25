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

test('a secret the clip would cut is taken out whole first, so no piece of it survives', () => {
  const secret = 'S3cr3t-'.repeat(60);
  const env = { REGISTRY_TOKEN: secret };
  process.env.REGISTRY_TOKEN = secret;
  try {
    const text = summarize('test', toolError(`npm ERR! ${'x'.repeat(280)} ${secret}`));
    assert.ok(!text.includes('S3cr3t'), 'no prefix of it is left');
  } finally {
    delete process.env.REGISTRY_TOKEN;
  }
  assert.ok(!redact(`${'x'.repeat(280)} ${secret}`, env).includes('S3cr3t'));
});

test('a short value the installation names as an install secret is taken out too', () => {
  const env = { REGISTRY_PIN: '48151', WOODSHED_INSTALL_SECRETS: 'REGISTRY_PIN', PORT_NUMBER_TOKEN: '1234' };
  const clean = redact('pin 48151 on port 1234', env);
  assert.doesNotMatch(clean, /48151/);
  assert.match(clean, /1234/, 'a short value of a variable only named like a secret stays');
});

test('a quoted credential in a tool error keeps the event valid JSON, so the error is counted and its value is gone', () => {
  const stream = line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'config: password: "opaqueValue123" rejected' }] } });
  const text = summarize('test', stream);
  assert.match(text, /Tool errors: 1/);
  assert.doesNotMatch(text, /opaqueValue123/);
});

test('a credential in a prefixed name, as an app prints its env file, is taken out', () => {
  const clean = redact('STRIPE_SECRET_KEY=opaqueStripe99\nDATABASE_PASSWORD: opaqueDb77\nMY_API_TOKEN=opaqueTok55\nPORT=3000', {});
  assert.doesNotMatch(clean, /opaqueStripe99|opaqueDb77|opaqueTok55/);
  assert.match(clean, /PORT=3000/);
});

test('the summary tier has counts and fixed words, and nothing claude or its tools printed', () => {
  const stream = [said('registry said zzOpaque7788'), toolError('Timeout 30000ms exceeded; token zzOpaque7788'), toolError('net::ERR_CONNECTION_REFUSED'),
    `stderr zzOpaque7788`, line({ type: 'result', subtype: 'error_max_turns', num_turns: 9, duration_ms: 5000, total_cost_usd: 1 })].join('\n');
  const text = summarize('test', stream, { text: false });
  assert.doesNotMatch(text, /zzOpaque7788|registry said|Timeout 30000/);
  assert.match(text, /Ended: ran out of turns/);
  assert.match(text, /Tool errors: 2 \(1 timeout, 1 connection refused\)/);
  assert.match(text, /Said: 1 message\nOther output: 1 line/);
  assert.match(summarize('test', stream), /zzOpaque7788|registry said/, 'the full tier keeps them');
});

test('a result event\'s odd fields never reach the verdict or the summary: counts are whole numbers, subtypes short words', () => {
  const stream = line({ type: 'result', subtype: 'error_max_turns', num_turns: 'PRIVATE-MARKER', duration_ms: 'x', total_cost_usd: 'y' });
  assert.equal(whyEnded('test', stream), 'the test pass ran out of turns before it finished');
  const lower = line({ type: 'result', subtype: 'opaque_registry_credential', num_turns: 3 });
  assert.match(summarize('test', lower, { text: false }), /\(unknown\)/, 'a lowercase word that claude does not write is not printed');
  assert.doesNotMatch(summarize('test', lower, { text: false }), /opaque_registry/);
  const odd = line({ type: 'result', subtype: 'PRIVATE-MARKER https://x', is_error: false, num_turns: 3 });
  assert.doesNotMatch(summarize('test', odd, { text: false }), /PRIVATE/);
  assert.match(summarize('test', odd, { text: false }), /\(unknown\)/);
  const denied = line({ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'PRIVATE-MARKER x' }] });
  assert.doesNotMatch(summarize('test', denied, { text: false }), /PRIVATE/);
});
