import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costOf, priceOf } from './apiPrices.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('a Claude model is priced per kind of token, cache writes from its input price', () => {
  const p = priceOf('claude-opus-5-5');
  assert.deepEqual(p, { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
  close(costOf('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }), 4 + 20 + 0.2 + 5 + 8);
});

test('a dated, Bedrock or [1m] spelling is the same model, and fast mode costs twice as much', () => {
  assert.deepEqual(priceOf('claude-sonnet-4-5-20250929'), priceOf('claude-sonnet-4-5'));
  assert.deepEqual(priceOf('us.anthropic.claude-opus-4-8'), priceOf('claude-opus-4-8'));
  assert.deepEqual(priceOf('claude-opus-5-5[1m]'), priceOf('claude-opus-5-5'));
  close(costOf('claude-opus-5-5:fast', { output: 1e6 }), 40);
});

test('an OpenAI model is priced with its cached input as the cache read', () => {
  close(costOf('gpt-6.1-sol', { input: 2e6, cacheRead: 1e6, output: 1e6 }), 4 + 0.1 + 10);
});

test('a model with no price says so rather than guessing', () => {
  assert.equal(priceOf('gpt-99-imaginary'), null);
  assert.equal(costOf('gpt-99-imaginary', { input: 1e6 }), null);
  assert.equal(priceOf(''), null);
  assert.equal(priceOf(undefined), null);
  assert.equal(priceOf('constructor'), null, 'an object\'s own names are no model');
  assert.equal(costOf('toString', { input: 1 }), null);
});
