// The Usage page's prices, read from OpenRouter's public model list each time the page asks (console/usage.mjs), so
// they follow Anthropic's and OpenAI's list prices with no upkeep here. Nothing is kept between reads: the list is one
// unauthenticated GET. When it is not reached in time, or does not read as a model list, the page is priced from the
// tables in shared/apiPrices.mjs and says so.

import { PRICES_AS_OF, pricesFromOpenRouter } from '../shared/apiPrices.mjs';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const TIMEOUT_MS = 5_000;
// The list is about 1 MB; past this it is not what was asked for.
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * @param {{fetch?: typeof globalThis.fetch, url?: string, timeoutMs?: number, now?: () => number}} [opts]
 * @returns {{read: () => Promise<{table: Record<string, object>|null, source: 'openrouter'|'built-in', asOf: string}>}}
 */
export function createLivePrices({ fetch = globalThis.fetch, url = OPENROUTER_MODELS_URL, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  // Each reason a read failed is logged once, until a read works again.
  let lastWhy = null;
  const builtIn = (why) => {
    if (why !== lastWhy) console.warn('livePrices: OpenRouter\'s prices not read, the built-in list is used', { why });
    lastWhy = why;
    return { table: null, source: 'built-in', asOf: PRICES_AS_OF };
  };

  return {
    async read() {
      let body;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return builtIn(`status ${res.status}`);
        const text = await res.text();
        if (text.length > MAX_BYTES) return builtIn('the answer was too large');
        body = JSON.parse(text);
      } catch (err) {
        return builtIn(err?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : err instanceof SyntaxError ? 'the answer is not JSON' : String(err?.cause?.code ?? err?.message ?? err).split('\n')[0]);
      }
      const table = pricesFromOpenRouter(body);
      if (!table) return builtIn('the answer names no Anthropic or OpenAI model');
      if (lastWhy !== null) console.log('livePrices: OpenRouter\'s prices read again', { models: Object.keys(table).length });
      lastWhy = null;
      return { table, source: 'openrouter', asOf: new Date(now()).toISOString() };
    },
  };
}
