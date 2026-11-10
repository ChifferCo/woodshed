// The local provider's way in for GitHub's webhooks and Slack's events: a small HTTP server of its own, beside the
// console's, at the Lambda's paths (POST /github, POST /slack). It runs the Lambda's own handler
// (../aws/webhooks/index.mjs, which stays there because Terraform zips that one file), so signatures, the events kept
// and the messages made are the same, and hands each message to the console's dispatch (console/webhookDispatch.mjs)
// as the SQS queue does on AWS.
//
// The queue's retries are kept: a message the console fails on is tried again, up to MAX_TRIES, in the order it came.
// What is still waiting is lost when the console restarts; GitHub's poll then finds it, as it finds a lost delivery.
import http from 'node:http';

import { createHandler } from '../aws/webhooks/index.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_TRIES = 3;
const RETRY_MS = [5_000, 15_000];
// As often as the SQS consumer's long poll returns: the fleet slows its GitHub poll while webhooks are reachable.
const ALIVE_MS = 20_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {{host: string, port: number, secrets: {read: (name: string) => Promise<string|null>},
 *          sleep?: (ms: number) => Promise<void>, now?: () => Date}} opts
 *   the signing secrets are `github-webhook-secret` and `slack-signing-secret` in the local store, read at each
 *   delivery, so a rotation on the Secrets page applies at once; without a Slack one, /slack is refused
 * @returns {{run: (handler: {dispatch: Function, alive: () => void}) => Promise<void>, close: () => Promise<void>,
 *            address: () => {port: number}|null}}
 */
export function createWebhookReceiver({ host, port, secrets, sleep, now = () => new Date() }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const queue = [];
  let draining = null;
  let server = null;
  let aliveTimer = null;

  // A dispatch that throws counts as a failed try, as one that answers false does: nothing here may stop the queue, or
  // leave an unhandled rejection that ends the console.
  async function tryOnce(handler, message, attempt) {
    try {
      return await handler.dispatch({ text: JSON.stringify(message), id: message.deliveryId ?? message.eventId ?? null, attempt: `try ${attempt} of ${MAX_TRIES}` });
    } catch (err) {
      console.error('webhooks: dispatch threw, counted as a failed try', { type: message.type ?? null, attempt, message: String(err?.message ?? err).split('\n')[0] });
      return false;
    }
  }

  async function drain(handler) {
    try {
      while (queue.length) {
        const message = queue.shift();
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
          if (await tryOnce(handler, message, attempt)) break;
          if (attempt === MAX_TRIES) console.warn('webhooks: message dropped after its last try', { type: message.type ?? null, tries: MAX_TRIES });
          else await wait(RETRY_MS[attempt - 1]);
        }
      }
    } finally {
      draining = null;
    }
  }

  function enqueue(handler) {
    return async (message) => {
      queue.push(message);
      draining ??= drain(handler);
    };
  }

  async function signingSecret(name) {
    const value = await secrets.read(name);
    if (!value) throw Object.assign(new Error(`${name} has no value yet`), { unset: true });
    return value;
  }

  function serve(handle) {
    return async (req, res) => {
      const path = new URL(req.url, 'http://receiver').pathname;
      try {
        const body = await readBody(req);
        const answer = await handle({
          rawPath: path, requestContext: { http: { method: req.method } }, headers: req.headers,
          body: body.toString('base64'), isBase64Encoded: true,
        });
        res.writeHead(answer.statusCode, answer.headers).end(answer.body);
      } catch (err) {
        if (err.unset) console.warn('webhooks: delivery refused, its signing secret is not set', { path, message: err.message });
        else if (err.status !== 413) console.error('webhooks: delivery failed', { path, message: String(err?.message ?? err).split('\n')[0] });
        if (!res.headersSent) res.writeHead(err.status ?? (err.unset ? 503 : 500), { 'content-type': 'text/plain' }).end(err.status === 413 ? 'too large' : 'not ready');
      }
    };
  }

  async function run(handler) {
    const handle = createHandler({
      getSecret: () => signingSecret('github-webhook-secret'),
      getSlackSecret: () => signingSecret('slack-signing-secret'),
      enqueue: enqueue(handler),
      now,
    });
    server = http.createServer(serve(handle));
    // Like the SQS consumer, this never throws: a console whose receiver cannot listen still polls GitHub.
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    } catch (err) {
      console.error('webhooks: receiver not listening, polling GitHub only', { host, port, message: err.message });
      server = null;
      return;
    }
    console.log('webhooks: listening', { host, port: server.address().port });
    handler.alive();
    aliveTimer = setInterval(() => handler.alive(), ALIVE_MS);
    aliveTimer.unref();
  }

  async function close() {
    clearInterval(aliveTimer);
    if (server) await new Promise((resolve) => server.close(resolve));
    await draining;
  }

  return { run, close, address: () => (server ? { port: server.address().port } : null) };
}
