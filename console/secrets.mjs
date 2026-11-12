// The secrets the console's Secrets page sets. Terraform creates each one
// empty; their values never pass through Terraform or a command line. Each save
// is a new Secrets Manager version, so AWSPREVIOUS keeps the one before it.
//
// A session secret can be shown: anyone who reaches the console can already
// open a session's terminal and read it from the environment. The Anthropic key
// cannot: sessions reach Anthropic through the console's proxy and never hold
// it (anthropicProxy.mjs). Nor the GitHub App key: sessions never see it, and
// with it anyone could mint tokens as the App until the key is revoked.

import crypto from 'node:crypto';


// Secrets Manager's limit on one value.
const MAX_SECRET_BYTES = 65_536;

/**
 * @typedef {{name: string, group: 'session'|'console', kind: 'line'|'pem'|'webhook', readable: boolean}} SecretSpec
 *   `kind` says what a value looks like: one line, a PEM private key, or a generated webhook secret.
 */

/**
 * Every secret the Secrets page sets: the fixed ones, and one for each install secret (`installSecrets` from config.mjs),
 * which sit after the model keys. A repo's env files are not here: they are its Repo settings (repoSettings.mjs).
 * @param {{installSecrets?: {secret: string}[]}} [opts]
 * @returns {SecretSpec[]}
 */
export function secretSpecs({ installSecrets = [] } = {}) {
  return [
    { name: 'anthropic-api-key', group: 'session', kind: 'line', readable: false },
    { name: 'openai-api-key', group: 'session', kind: 'line', readable: false },
    ...installSecrets.map(({ secret }) => ({ name: secret, group: 'session', kind: 'line', readable: true })),
    { name: 'github-app-key', group: 'console', kind: 'pem', readable: false },
    { name: 'github-webhook-secret', group: 'console', kind: 'webhook', readable: true },
    { name: 'github-app-client-secret', group: 'console', kind: 'line', readable: false },
    { name: 'slack-bot-token', group: 'console', kind: 'line', readable: false },
    { name: 'slack-signing-secret', group: 'console', kind: 'line', readable: false },
  ];
}

/**
 * @param {SecretSpec} spec
 * @param {unknown} value
 * @returns {string}  the value to store
 * @throws {Error}  with a message the page can show, never containing the value
 */
export function checkValue(spec, value) {
  if (typeof value !== 'string') throw new Error('the value must be text');
  const text = value.trim();
  if (!text) throw new Error('the value is empty');
  if (Buffer.byteLength(text) > MAX_SECRET_BYTES) throw new Error('the value is over the 64 KB a secret can hold');
  if (spec.kind === 'line' && /\s/.test(text)) throw new Error('the value must be one line with no spaces');
  if (spec.kind === 'pem') {
    try {
      crypto.createPrivateKey(text);
    } catch {
      throw new Error('this is not a PEM private key');
    }
  }
  return text;
}

export function newWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}
