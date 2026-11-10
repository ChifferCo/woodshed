// What the pages say about where sessions run, in the provider's own words: a provider's `words`
// (providers/README.md) over these, which name no provider. The page gets them from pageShell's
// `woodshed-provider` meta tag, so the first draw already has them.

/**
 * @typedef {[string, string]|null} StepWords  the checklist's label and the short one under a card; null leaves the
 *   step out, for a provider that never reaches it
 * @typedef {{
 *   startSteps: {machine: StepWords, pullStarted: StepWords, container: StepWords},
 *   noRoom: {title: string, line: string, detail: string},
 *   capacityNote: string|null,
 *   homesPlace: string,
 *   databasesPlace: string|null,
 *   webhookReceiver: string,
 *   webhookUrlFix: string,
 *   webhookLog: string|null,
 * }} ProviderWords
 *   `startSteps` are the console's own steps before the entrypoint reports any (START_STEPS in sessions.mjs);
 *   `noRoom` is a queued session the provider had no room for, waiting for its retry (waitsForRetry in sessions.mjs);
 *   `capacityNote` sits under the session limits on Console settings; `homesPlace` and `databasesPlace` are where
 *   saved conversations and database copies are kept, on the same page (null for an installation that runs no database); `webhookReceiver` is what GitHub and Slack
 *   post to, `webhookUrlFix` what gives it a URL when it has none, and `webhookLog` where to read why it refused a
 *   delivery, on the Secrets & webhooks and Webhook events pages
 */

/** @type {ProviderWords} */
export const DEFAULT_WORDS = {
  startSteps: {
    machine: ['Getting a machine', 'getting a machine'],
    pullStarted: ['Waiting for it to start', 'waiting to start'],
    container: ['Pulling the session image', 'pulling the image'],
  },
  noRoom: {
    title: 'Waiting for room',
    line: 'Waiting for room for another session.',
    detail: 'There is no room for another session right now. The console tries again every minute.',
  },
  capacityNote: null,
  homesPlace: 'the saved homes store',
  databasesPlace: 'Postgres and Mongo',
  webhookReceiver: 'the webhook receiver',
  webhookUrlFix: 'its provider has not given it one',
  webhookLog: null,
};

/**
 * @param {{name?: string, words?: Partial<ProviderWords>|null}|null} provider
 * @returns {{name: string|null, words: ProviderWords}}  the provider's words over the defaults, a group at a time
 */
export function providerWords(provider) {
  const own = provider?.words ?? {};
  return {
    name: provider?.name ?? null,
    words: {
      ...DEFAULT_WORDS,
      ...own,
      startSteps: { ...DEFAULT_WORDS.startSteps, ...own.startSteps },
      noRoom: { ...DEFAULT_WORDS.noRoom, ...own.noRoom },
    },
  };
}

/** @returns {string}  the meta tag's content: JSON, escaped for an HTML attribute */
export function providerMetaContent(provider) {
  return JSON.stringify(providerWords(provider))
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
