// What tokens cost at the providers' list API prices, for the console's Usage page (console/usage.mjs): what an API key
// was charged, and what a Claude or ChatGPT plan's tokens would have cost on a key. US dollars per million tokens, as
// published on 2026-11-23 (PRICES_AS_OF): Anthropic's pricing page and OpenAI's rate card. A model missing here is
// shown with its tokens and no price, never a guess; add its row when it ships.
//
// The kinds of token, as session/tokenUsage.mjs counts them:
//   input        uncached input
//   cacheWrite5m input written to a 5-minute cache (Anthropic: 1.25x input)
//   cacheWrite1h input written to a 1-hour cache (Anthropic: 2x input)
//   cacheRead    input read from a cache
//   output       output, thinking and reasoning included (both bill them as output)
// Fast mode (Claude's `speed: "fast"`) is counted under the model's id with `:fast` after it, and priced at FAST_RATE
// times the standard row unless the row gives its own.

export const PRICES_AS_OF = '2026-11-23';

const FAST_RATE = 2;

// Anthropic: input, output, cache read. Cache writes follow from input.
const CLAUDE = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-mythos-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-mythos-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-opus-4-5': [5, 25, 0.5],
  'claude-opus-4-1': [15, 75, 1.5],
  'claude-opus-4': [15, 75, 1.5],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-sonnet-4-5': [3, 15, 0.3],
  'claude-sonnet-4': [3, 15, 0.3],
  // Haiku 5.5's prompts over 100K tokens cost five times this; a session's are rarely that long, and the transcript
  // does not say, so this is the floor.
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
  'claude-3-5-haiku': [0.8, 4, 0.08],
};

// OpenAI: input, output, cached input. No cache writes.
const OPENAI = {
  'gpt-6.2-astra': [8, 40, 0.4],
  'gpt-6.2-sol': [2, 10, 0.1],
  'gpt-6.1-sol': [2, 10, 0.1],
  'gpt-6.1-terra': [1, 5, 0.05],
  'gpt-6-astra': [10, 50, 1],
  'gpt-6-sol': [2, 10, 0.2],
  'gpt-6-luna': [0.1, 0.5, 0.01],
  'gpt-6': [2, 10, 0.2],
  'gpt-5.6-sol': [4, 20, 0.4],
  'gpt-5.6-terra': [2, 12, 0.2],
  'gpt-5.6-luna': [0.2, 1.2, 0.02],
  'gpt-5.5': [5, 30, 0.5],
  'gpt-5.3-codex': [1.75, 14, 0.175],
  'gpt-5.3': [1.75, 14, 0.175],
  'gpt-5.2-codex': [1.75, 14, 0.175],
  'gpt-5.2': [1.75, 14, 0.175],
  'gpt-5.1-codex-max': [1.25, 10, 0.125],
  'gpt-5.1-codex-mini': [0.25, 2, 0.025],
  'gpt-5.1-codex': [1.25, 10, 0.125],
  'gpt-5.1': [1.25, 10, 0.125],
  'gpt-5-codex': [1.25, 10, 0.125],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5': [1.25, 10, 0.125],
};

const PER = 1_000_000;

function row(model) {
  const claude = CLAUDE[model];
  if (claude) {
    const [input, output, cacheRead] = claude;
    return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
  }
  const openai = OPENAI[model];
  if (openai) {
    const [input, output, cacheRead] = openai;
    return { input, output, cacheRead, cacheWrite5m: input, cacheWrite1h: input };
  }
  return null;
}

/**
 * @param {string} model  as the transcript names it: `claude-opus-5-5`, `claude-opus-5-5:fast`, a dated
 *   `claude-sonnet-4-5-20250929`, `gpt-6.1-sol`
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number}|null}
 *   dollars per million tokens of each kind, or null for a model with no list price here
 */
export function priceOf(model) {
  if (typeof model !== 'string' || !model) return null;
  const fast = model.endsWith(':fast');
  const id = (fast ? model.slice(0, -':fast'.length) : model).toLowerCase()
    // Bedrock's and Vertex's spellings, and a dated snapshot.
    .replace(/^(?:us\.|eu\.|global\.)?anthropic\./, '').replace(/@\d{8}$/, '').replace(/-\d{8}$/, '').replace(/-v\d+(?::\d+)?$/, '')
    // Claude Code's [1m] context marker is not part of the id.
    .replace(/\[1m\]$/, '');
  const base = row(id);
  if (!base || !fast) return base;
  return Object.fromEntries(Object.entries(base).map(([kind, price]) => [kind, price * FAST_RATE]));
}

export const TOKEN_KINDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];

/**
 * @param {string} model
 * @param {{input?: number, cacheWrite5m?: number, cacheWrite1h?: number, cacheRead?: number, output?: number}} tokens
 * @returns {number|null}  dollars at list API prices, or null when the model has no price here
 */
export function costOf(model, tokens) {
  const price = priceOf(model);
  if (!price) return null;
  return TOKEN_KINDS.reduce((sum, kind) => sum + ((Number(tokens?.[kind]) || 0) * price[kind]) / PER, 0);
}
