// The switch on the Webhook events page that turns GitHub's webhooks off. Off, the console drops each GitHub delivery
// as it arrives (the queue or the caller forgets it), stops telling the fleet and the pull request readers that
// webhooks flow, and so polls GitHub at full speed, as a console with no webhooks does. Slack mentions still come
// through: nothing else brings them. Kept in state.json under `webhooks`, so it survives a restart.

/**
 * @param {{store: {state: object, save: () => void}, onOff?: () => void, now?: () => number}} deps
 *   `onOff` runs when the switch is turned off, to forget that webhooks were flowing
 * @returns {{off: () => boolean, set: (args: {off: boolean, by: string}) => boolean, dropped: () => void,
 *            receiving: (how: string|null) => void, view: () => object}}
 */
export function createWebhookSwitch({ store, onOff = () => {}, now = Date.now }) {
  let receivingHow = null;
  let droppedSince = 0;

  const off = () => store.state.webhooks?.githubOff === true;

  /** @returns {boolean}  whether it changed */
  function set({ off: to, by }) {
    if (typeof to !== 'boolean') throw Object.assign(new Error('off must be true or false'), { shown: true, status: 400 });
    if (off() === to) return false;
    store.state.webhooks = { githubOff: to, by, at: new Date(now()).toISOString() };
    store.save();
    droppedSince = 0;
    console.log('webhooks: GitHub webhooks switched', { off: to, by });
    if (to) onOff();
    return true;
  }

  /** One GitHub delivery dropped while off: the first after the switch is logged, the rest only counted. */
  function dropped() {
    if (!droppedSince) console.log('webhooks: off, GitHub deliveries dropped from now on');
    droppedSince += 1;
  }

  return {
    off,
    set,
    dropped,
    /** How this console gets webhooks (`queue`, `delivered`), or null when it gets none and only polls. */
    receiving: (how) => { receivingHow = how; },
    view: () => {
      const saved = store.state.webhooks ?? {};
      return { receiving: receivingHow, off: off(), by: saved.by ?? null, at: saved.at ?? null, dropped: off() ? droppedSince : 0 };
    },
  };
}
