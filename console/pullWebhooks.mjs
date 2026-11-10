// Pull request webhooks: a change to a pull request, a review of it, or a workflow run on it (the Lambda's `pr`
// message). Each one marks the pull request due in whatever reads it (the chips, the Slack announcer, a kept session's
// retention), and the loops that already run read it within seconds. Nothing is read here and no payload is trusted:
// the webhook only says when to look.
//
// While they arrive, those loops poll only as a fallback for a lost delivery. "Arrive" means any pull request
// webhook in the last half hour, about any pull request: CI on this repository sends many an hour, so a quiet half
// hour means the App is not subscribed or GitHub is not delivering, and the loops go back to their full speed.

export const FLOWING_MS = 30 * 60_000;

/**
 * @param {{now?: () => number}} [opts]
 * @returns {{flowing: () => boolean, watch: (reader: {name: string, stale: (numbers: number[]) => number[]}) => void,
 *            handle: (message: object) => {outcome: 'refreshed', reason: string}|{unrecorded: true}}}
 *   each reader's `stale` returns the numbers it reads, of those it was given
 */
export function createPullWebhooks({ now = Date.now } = {}) {
  let lastAt = -Infinity;
  let wasFlowing = false;
  const readers = [];

  function flowing() {
    const is = now() - lastAt < FLOWING_MS;
    if (is !== wasFlowing) {
      wasFlowing = is;
      console.log('pullWebhooks: pull request polling changed', { webhooks: is, why: is ? 'webhooks arriving' : 'no pull request webhook for 30 minutes' });
    }
    return is;
  }

  function watch(reader) {
    readers.push(reader);
  }

  /** A pull request no session opened is left out of the events log: CI sends one for every run on every branch. */
  function handle(message) {
    lastAt = now();
    flowing();
    const numbers = (Array.isArray(message?.numbers) ? message.numbers : [message?.number]).filter(Number.isInteger);
    const by = readers.filter((r) => r.stale(numbers).length).map((r) => r.name);
    if (!by.length) return { unrecorded: true };
    console.log('pullWebhooks: pull request marked due', { numbers, what: message?.what ?? null, by });
    return { outcome: 'refreshed', reason: by.join(', ') };
  }

  return { flowing, watch, handle };
}
