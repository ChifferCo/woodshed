import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanName, createAutoNamer } from './autoName.mjs';

function fakeFetch(answer) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (answer instanceof Error) throw answer;
    return { ok: answer.status === undefined, status: answer.status ?? 200, json: async () => answer.body ?? answer };
  }
  return { fetchImpl, calls };
}

test('Haiku names the session from its prompt, on the team key', async () => {
  const { fetchImpl, calls } = fakeFetch({ content: [{ type: 'text', text: '"Fix billing currency rounding."' }], stop_reason: 'end_turn' });
  const autoName = createAutoNamer({ teamKey: async () => 'sk-ant-team\n', fetchImpl });
  assert.equal(await autoName('The billing page rounds EUR wrong'), 'Fix billing currency rounding');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-team');
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.equal(calls[0].body.messages[0].content, 'The billing page rounds EUR wrong');
});

test('no key, a refusal or a timeout leaves the name to the prompt', async () => {
  const none = createAutoNamer({ teamKey: async () => null, fetchImpl: fakeFetch({}).fetchImpl });
  assert.equal(await none('x'), '');
  const refused = createAutoNamer({ teamKey: async () => 'k', fetchImpl: fakeFetch({ status: 529 }).fetchImpl });
  assert.equal(await refused('x'), '');
  const slow = createAutoNamer({ teamKey: async () => 'k', fetchImpl: fakeFetch(new Error('The operation was aborted due to timeout')).fetchImpl });
  assert.equal(await slow('x'), '');
  assert.equal(await createAutoNamer({ teamKey: null })('x'), '');
});

test('a refused call logs Anthropic\'s reason, and a failed key read leaves the name to the prompt', async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args);
  try {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: not supported' } };
    const refused = createAutoNamer({ teamKey: async () => 'k', fetchImpl: fakeFetch({ status: 400, body }).fetchImpl });
    assert.equal(await refused('x'), '');
    assert.equal(lines[0][1].type, 'invalid_request_error');
    assert.match(lines[0][1].message, /effort/);

    const { fetchImpl, calls } = fakeFetch({ content: [{ type: 'text', text: 'Named' }] });
    const denied = createAutoNamer({ teamKey: async () => { throw new Error('AccessDenied'); }, fetchImpl });
    assert.equal(await denied('x'), '');
    assert.equal(lines[1][0], 'autoName: failed');
    assert.equal(calls.length, 0);
  } finally {
    console.warn = warn;
  }
});

test('a long or wordy answer is cut to one short line', () => {
  assert.equal(cleanName('Fix it\nBecause the user asked'), 'Fix it');
  assert.equal(cleanName('a'.repeat(80)).length, 60);
  assert.equal(cleanName('  '), '');
});
