// What a token costs at the providers' list prices, for the Usage page (usage.mjs): what the team keys spent, and what
// the tokens of a Claude or ChatGPT subscription would have cost had they gone through the API. The one place prices
// are kept: change a price here, with PRICES_AS_OF, and the page says the new date.
//
// Every price is US dollars per million tokens, standard tier, as each provider's pricing page listed it on
// PRICES_AS_OF. What is left out, and so not in any estimate: batch discounts, Haiku 5.5's dearer rate for prompts
// over 100K tokens, OpenAI's long-context rate for prompts over 272K tokens, priority tiers and promotions, and
// regional or partner (Bedrock, Vertex) pricing. A model not listed has no price: its tokens are counted and the page
// says it has no price, rather than guessing one.

export const PRICES_AS_OF = '2026-11-23';

export const PRICE_SOURCES = [
  { provider: 'anthropic', label: 'Anthropic pricing', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { provider: 'openai', label: 'OpenAI pricing', url: 'https://developers.openai.com/api/docs/pricing' },
];

// Anthropic: input, output and cache read as listed; a cache write is 1.25× input for 5 minutes and 2× for an hour.
// `fast` is the fast-mode price, where the model has one.
const claude = (input, output, cacheRead, fast = null) => ({
  provider: 'anthropic', input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2,
  fast: fast && { input: fast[0], output: fast[1], cacheRead: cacheRead * (fast[0] / input), cacheWrite5m: fast[0] * 1.25, cacheWrite1h: fast[0] * 2 },
});
// OpenAI: input, cached input and output. Its output includes the reasoning tokens; there is no cache write.
const openai = (input, cacheRead, output) => ({ provider: 'openai', input, output, cacheRead: cacheRead ?? input, cacheWrite5m: 0, cacheWrite1h: 0, fast: null });

export const PRICES = {
  'claude-fable-5-2': claude(8, 40, 0.2, [16, 80]),
  'claude-mythos-5-2': claude(8, 40, 0.2, [16, 80]),
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-mythos-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-mythos-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2, [8, 40]),
  'claude-opus-5': claude(5, 25, 0.5, [10, 50]),
  'claude-opus-4-8': claude(5, 25, 0.5, [10, 50]),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-sonnet-5-5': claude(2, 10, 0.1),
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  // Up to 100K tokens of prompt: past that it is $0.50 / $2.50, which a day's total cannot tell apart.
  'claude-haiku-5-5': claude(0.1, 0.5, 0.01),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  // Up to 272K tokens of input, for the models whose page row has a long-context rate.
  'gpt-6.2-astra': openai(8, 0.4, 40),
  'gpt-6.2-sol': openai(2, 0.1, 10),
  'gpt-6-astra': openai(10, 1, 50),
  'gpt-6.1-sol': openai(2, 0.1, 10),
  'gpt-6.1-terra': openai(1, 0.05, 5),
  'gpt-6-luna': openai(0.1, 0.01, 0.5),
  'gpt-6-sol': openai(2, 0.2, 10),
  'gpt-5.6-sol': openai(4, 0.4, 20),
  'gpt-5.6-terra': openai(2, 0.2, 12),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.5-pro': openai(30, null, 180),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-pro': openai(30, null, 180),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.2-pro': openai(21, null, 168),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gpt-5-pro': openai(15, null, 120),
};

/**
 * The price table's name for a model as a provider or a transcript gives it: `claude-opus-5-5-20260401`,
 * `anthropic.claude-opus-5-5`, `claude-opus-5-5[1m]` and `openai/gpt-5.5-2026-08-01` are all their base model.
 * @param {string} model
 * @returns {string|null}  null when the table has no such model
 */
export function priceKey(model) {
  let name = String(model ?? '').toLowerCase().trim();
  name = name.replace(/\[[^\]]*\]$/, '').replace(/^(?:anthropic|openai|us|eu|global)[./]/, '').replace(/^(?:anthropic)[./]/, '');
  if (PRICES[name]) return name;
  const undated = name.replace(/-(?:20\d{6}|20\d{2}-\d{2}-\d{2})$/, '').replace(/@.*$/, '');
  return PRICES[undated] ? undated : null;
}

/** The token kinds a row counts, each priced on its own. `reasoning` is part of `output`, shown, never priced again. */
export const TOKEN_KINDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];

/**
 * @param {string} model
 * @param {{input?: number, cacheWrite5m?: number, cacheWrite1h?: number, cacheRead?: number, output?: number}} tokens
 * @param {{fast?: boolean}} [opts]
 * @returns {number|null}  US dollars at list price, or null for a model with no price
 */
export function costOf(model, tokens, { fast = false } = {}) {
  const key = priceKey(model);
  if (!key) return null;
  const row = fast && PRICES[key].fast ? PRICES[key].fast : PRICES[key];
  let usd = 0;
  for (const kind of TOKEN_KINDS) usd += ((Number(tokens?.[kind]) || 0) * row[kind]) / 1e6;
  return usd;
}
