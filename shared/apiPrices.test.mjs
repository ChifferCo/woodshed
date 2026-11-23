import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costOf, priceOf, pricesFromOpenRouter } from './apiPrices.mjs';

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

// As OpenRouter's GET /api/v1/models answers, trimmed to the fields read.
const OPENROUTER = { data: [
  { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375', input_cache_write_1h: '0.000006' } },
  { id: 'anthropic/claude-opus-5.5:batch', pricing: { prompt: '0.0000015', completion: '0.0000075' } },
  { id: 'anthropic/claude-next-6', pricing: { prompt: '0.00001', completion: '0.00005' } },
  { id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001', overrides: [{ min_prompt_tokens: 272000, prompt: '0.000004' }] } },
  { id: 'openai/gpt-free', pricing: { prompt: 'free', completion: '0' } },
  { id: 'google/gemini-9', pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'anthropic/constructor', pricing: { prompt: '0.000001', completion: '0.000001' } },
] };

test('OpenRouter\'s list prices Anthropic\'s and OpenAI\'s models under their transcripts\' ids, before the tables here', () => {
  const live = pricesFromOpenRouter(OPENROUTER);
  assert.deepEqual(Object.keys(live).sort(), ['claude-next-6', 'claude-opus-5-5', 'constructor', 'gpt-6.1-sol'], 'no :batch variant, other provider, or unpriced model');
  const opus = priceOf('claude-opus-5-5', live);
  for (const [kind, want] of Object.entries({ input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 })) close(opus[kind], want);
  close(costOf('claude-opus-5-5:fast', { output: 1e6 }, live), 30);
  close(costOf('claude-opus-5-5-20261101', { input: 1e6 }, live), 3);
  const next = priceOf('claude-next-6', live);
  close(next.cacheRead, 1);
  close(next.cacheWrite5m, 12.5);
  close(next.cacheWrite1h, 20);
  close(costOf('gpt-6.1-sol', { input: 1e6, cacheRead: 1e6, output: 1e6 }, live), 2 + 0.1 + 10);
  assert.deepEqual(priceOf('claude-sonnet-4-5', live), priceOf('claude-sonnet-4-5'), 'a model OpenRouter does not list is priced from the tables here');
  assert.equal(priceOf('toString', live), null);
});

test('an answer that is not a model list gives no table', () => {
  for (const body of [null, 'x', {}, { data: 'x' }, { data: [] }, { data: [{ id: 'google/x', pricing: { prompt: '1', completion: '1' } }] }]) {
    assert.equal(pricesFromOpenRouter(body), null);
  }
  assert.equal(pricesFromOpenRouter({ data: [{ id: 'openai/gpt-x', pricing: { prompt: '1e9', completion: '0.1' } }] }), null, 'a price past any real one is no price');
});
