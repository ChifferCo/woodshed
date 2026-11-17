// The switches on the Webhook events page, one for each source of webhooks: GitHub's and Slack's. GitHub's off, the
// console drops each GitHub delivery as it arrives (the queue or the caller forgets it), stops telling the fleet and
// the pull request readers that webhooks flow, and so polls GitHub at full speed, as a console with no webhooks does.
// Slack's off, it drops each mention: nothing else brings them, so questions from Slack go unanswered. Kept in
// state.json under `webhooks`, so they survive a restart.

export const SOURCES = ['github', 'slack'];

/**
 * @param {{store: {state: object, save: () => void}, onOff?: (source: string) => void, now?: () => number}} deps
 *   `onOff` runs when a source is turned off; GitHub's forgets that pull request webhooks were flowing
 * @returns {{off: (source: string) => boolean, set: (args: {source: string, off: boolean, by: string}) => boolean,
 *            dropped: (source: string) => void, receiving: (how: string|null) => void, view: () => object}}
 */
export function createWebhookSwitch({ store, onOff = () => {}, now = Date.now }) {
  let receivingHow = null;
  const droppedSince = Object.fromEntries(SOURCES.map((s) => [s, 0]));

  const saved = (source) => store.state.webhooks?.[source] ?? {};
  const off = (source) => saved(source).off === true;

  /** @returns {boolean}  whether it changed */
  function set({ source, off: to, by }) {
    if (!SOURCES.includes(source)) throw Object.assign(new Error(`source must be ${SOURCES.join(' or ')}`), { shown: true, status: 400 });
    if (typeof to !== 'boolean') throw Object.assign(new Error('off must be true or false'), { shown: true, status: 400 });
    if (off(source) === to) return false;
    store.state.webhooks = { ...store.state.webhooks, [source]: { off: to, by, at: new Date(now()).toISOString() } };
    store.save();
    droppedSince[source] = 0;
    console.log('webhooks: switched', { source, off: to, by });
    if (to) onOff(source);
    return true;
  }

  /** One delivery dropped while its source is off: the first after the switch is logged, the rest only counted. */
  function dropped(source) {
    if (!droppedSince[source]) console.log('webhooks: off, deliveries dropped from now on', { source });
    droppedSince[source] += 1;
  }

  return {
    off,
    set,
    dropped,
    /** How this console gets webhooks (`queue`, `delivered`), or null when it gets none and only polls. */
    receiving: (how) => { receivingHow = how; },
    view: () => ({
      receiving: receivingHow,
      ...Object.fromEntries(SOURCES.map((s) => [s, { off: off(s), by: saved(s).by ?? null, at: saved(s).at ?? null, dropped: off(s) ? droppedSince[s] : 0 }])),
    }),
  };
}
