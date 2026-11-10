// The AWS provider's source of GitHub and Slack events: it long-polls the SQS queue the webhooks Lambda
// (webhooks/index.mjs) fills, hands each message to the console's dispatch (console/webhookDispatch.mjs), and deletes
// it once dispatched. One the console fails on stays on the queue: it comes back after the visibility timeout, and the
// third failure moves it to the dead-letter queue.

const WAIT_SECONDS = 20;
const MAX_MESSAGES = 10;
// The queue's redrive policy (terraform/webhooks.tf): the third receive that fails moves the message to the dead letters.
const MAX_RECEIVES = 3;
const BACKOFF_MS = [5_000, 15_000, 60_000];
// Before the queue exists, or while the role cannot see it, retrying sooner only fills the log.
const RESOLVE_RETRY_MS = 5 * 60_000;

/**
 * @typedef {{dispatch: (message: {text: string, id?: string|null, attempt?: string|null}) => Promise<boolean>,
 *            alive: () => void}} WebhookHandler
 *   what console/webhookDispatch.mjs's createWebhookDispatch returns
 */

/**
 * @param {{queue: string, aws: (args: string[]) => Promise<any>, sleep?: (ms: number) => Promise<void>}} opts
 *   `queue` is a name or a URL
 */
export function createWebhookQueue({ queue, aws, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function queueUrl() {
    if (queue.startsWith('https://')) return queue;
    return (await aws(['sqs', 'get-queue-url', '--queue-name', queue]))?.QueueUrl;
  }

  /**
   * @param {string} url
   * @param {WebhookHandler} handler
   * @returns {Promise<number>}  how many messages came in
   */
  async function receiveOnce(url, handler) {
    const out = await aws([
      'sqs', 'receive-message', '--queue-url', url, '--wait-time-seconds', String(WAIT_SECONDS),
      '--max-number-of-messages', String(MAX_MESSAGES), '--attribute-names', 'ApproximateReceiveCount',
    ]);
    handler.alive();
    const messages = out?.Messages ?? [];
    for (const message of messages) {
      const receives = Number(message.Attributes?.ApproximateReceiveCount ?? 0);
      const done = await handler.dispatch({ text: message.Body, id: message.MessageId ?? null, attempt: `try ${receives} of ${MAX_RECEIVES}` });
      if (done) await aws(['sqs', 'delete-message', '--queue-url', url, '--receipt-handle', message.ReceiptHandle]);
    }
    return messages.length;
  }

  /** @param {WebhookHandler} handler */
  async function run(handler) {
    let url = null;
    while (!url) {
      try {
        url = await queueUrl();
      } catch (err) {
        console.warn('webhooks: queue not reachable, polling GitHub only', { queue, message: String(err?.message ?? err).split('\n')[0] });
        await wait(RESOLVE_RETRY_MS);
      }
    }
    console.log('webhooks: listening', { queue });
    let failures = 0;
    for (;;) {
      try {
        await receiveOnce(url, handler);
        failures = 0;
      } catch (err) {
        const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        failures++;
        console.warn('webhooks: receive failed, backing off', { failures, delayMs: delay, message: String(err?.message ?? err).split('\n')[0] });
        await wait(delay);
      }
    }
  }

  return { receiveOnce, run };
}
