import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLivePrices } from './livePrices.mjs';
import { PRICES_AS_OF } from '../shared/apiPrices.mjs';

const LIST = { data: [{ id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002' } }] };
const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function quiet(t) {
  const logged = [];
  for (const level of ['log', 'warn']) t.mock.method(console, level, (...args) => logged.push(args));
  return logged;
}

test('each read asks OpenRouter again and prices from its answer', async (t) => {
  quiet(t);
  const asked = [];
  const prices = createLivePrices({ fetch: async (url, init) => { asked.push([url, init.headers.accept]); return answer(200, LIST)(); }, now: () => Date.parse('2026-11-23T10:00:00Z') });
  const read = await prices.read();
  assert.equal(read.source, 'openrouter');
  assert.equal(read.asOf, '2026-11-23T10:00:00.000Z');
  assert.equal(read.table['claude-opus-5-5'].input, 4);
  await prices.read();
  assert.deepEqual(asked, [['https://openrouter.ai/api/v1/models', 'application/json'], ['https://openrouter.ai/api/v1/models', 'application/json']]);
});

test('a failed read falls back on the built-in tables and says why once', async (t) => {
  const logged = quiet(t);
  const cases = [
    [answer(503, 'down'), 'status 503'],
    [answer(200, 'not json'), 'the answer is not JSON'],
    [answer(200, { data: [] }), 'the answer names no Anthropic or OpenAI model'],
    [async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, 'ENOTFOUND'],
  ];
  for (const [fetch, why] of cases) {
    const prices = createLivePrices({ fetch });
    assert.deepEqual(await prices.read(), { table: null, source: 'built-in', asOf: PRICES_AS_OF });
    await prices.read();
    const lines = logged.filter(([msg, data]) => /not read/.test(msg) && data.why === why);
    assert.equal(lines.length, 1, `${why} is logged once`);
  }
});

test('a read that takes too long gives up', async (t) => {
  quiet(t);
  const prices = createLivePrices({ timeoutMs: 50, fetch: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  // AbortSignal.timeout's timer does not hold the process open; this one does until the read gives up.
  const hold = setTimeout(() => {}, 5_000);
  t.after(() => clearTimeout(hold));
  const read = await prices.read();
  assert.equal(read.source, 'built-in');
});
