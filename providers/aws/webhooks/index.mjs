// Woodshed's one way in from the internet. GitHub posts its webhooks to
// this function's URL; it checks the signature, keeps only the events the
// console acts on, and queues a small message the console long-polls for. The
// console itself never takes an inbound connection.
//
//   POST /github   GitHub webhooks, signed with the <name_prefix>/github-webhook-secret value
//   POST /slack    Slack's Events API, signed with the <name_prefix>/slack-signing-secret value: a mention of
//                  the bot, which asks a question (the console's asks.mjs)
//   anything else  404
//
// No dependencies: the Lambda Node.js runtime ships the AWS SDK.

import { createHmac, timingSafeEqual } from 'node:crypto';

// The console sends at most 8000 characters to a session; the rest of a longer comment is on GitHub.
const MAX_COMMENT_CHARS = 8000;
// A cheap first cut, so ordinary comments are not queued; the console parses the command itself.
const COMMAND_PREFIX = /^\s*\/woodshed\b/i;
// A session asking for a person (session/readyGate.mjs, prompt.md): the console messages its assignee. Only the App's
// own comments count, since a session comments as the App and anyone could type the words; the console checks that,
// against its App's login (console/appIdentity.mjs), because each installation names its App itself.
const NEEDS_HUMAN_PREFIX = /^\s*Needs a human:/i;
// Slack refuses a request older than this itself, so a replayed one is refused here too.
const SLACK_MAX_AGE_SECONDS = 5 * 60;
// What can change a pull request's chip, its review or its checks: the console reads the pull request again when it
// is one a session opened. A workflow run lists the pull requests of its branch.
const PULL_ACTIONS = new Set(['opened', 'closed', 'reopened', 'synchronize', 'edited', 'ready_for_review', 'converted_to_draft', 'enqueued', 'dequeued']);
const REVIEW_ACTIONS = new Set(['submitted', 'dismissed']);
const MAX_PULLS_PER_RUN = 10;

/**
 * @param {string} secret
 * @param {Buffer} body  the raw request body, exactly as GitHub signed it
 * @param {string|undefined} header  `X-Hub-Signature-256`, `sha256=<hex>`
 * @returns {boolean}
 */
export function verifySignature(secret, body, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * @param {string} event  `X-GitHub-Event`
 * @param {object} payload
 * @param {{deliveryId: string, receivedAt: string}} meta
 * @returns {object|null}  the message for the console, or null when it acts on nothing in this event
 */
export function toMessage(event, payload, { deliveryId, receivedAt }) {
  // The repo each event is about: one App can be installed on several repos, and the console acts on its projects'.
  const base = { source: 'github', deliveryId, receivedAt, login: payload?.sender?.login ?? null, repo: payload?.repository?.full_name ?? null };
  if ((event === 'issues' || event === 'pull_request') && payload?.action === 'labeled') {
    const target = event === 'issues' ? payload.issue : payload.pull_request;
    if (!target?.number || !payload.label?.name) return null;
    const kind = event === 'pull_request' || target.pull_request ? 'pr' : 'issue';
    return { ...base, type: 'label', number: target.number, kind, title: target.title ?? '', label: payload.label.name };
  }
  const pulls = changedPulls(event, payload);
  if (pulls) return { ...base, type: 'pr', kind: 'pr', number: pulls.numbers[0], numbers: pulls.numbers, what: pulls.what };
  if (event === 'issue_comment' && payload?.action === 'created') {
    const comment = payload.comment;
    if (!comment?.id || !payload.issue?.number) return null;
    if (NEEDS_HUMAN_PREFIX.test(comment.body ?? '')) {
      return {
        ...base, login: comment.user?.login ?? base.login, type: 'needsHuman', number: payload.issue.number, commentId: comment.id,
        url: comment.html_url ?? null, body: comment.body.slice(0, MAX_COMMENT_CHARS),
      };
    }
    if (!COMMAND_PREFIX.test(comment.body ?? '')) return null;
    return {
      ...base, type: 'comment', number: payload.issue.number, commentId: comment.id,
      createdAt: comment.created_at, body: comment.body.slice(0, MAX_COMMENT_CHARS),
    };
  }
  return null;
}

/** @returns {{numbers: number[], what: string}|null}  the pull requests an event changed, and a short name for it */
function changedPulls(event, payload) {
  const action = payload?.action;
  if (event === 'pull_request' && PULL_ACTIONS.has(action) && payload.pull_request?.number) {
    return { numbers: [payload.pull_request.number], what: `pull request ${action}` };
  }
  if (event === 'pull_request_review' && REVIEW_ACTIONS.has(action) && payload.pull_request?.number) {
    return { numbers: [payload.pull_request.number], what: `review ${action}` };
  }
  if (event === 'workflow_run' && action === 'completed') {
    const numbers = (payload.workflow_run?.pull_requests ?? []).map((p) => p?.number).filter(Number.isInteger).slice(0, MAX_PULLS_PER_RUN);
    if (numbers.length) return { numbers, what: `${String(payload.workflow_run.name ?? 'workflow').slice(0, 60)} ${payload.workflow_run.conclusion ?? 'completed'}` };
  }
  return null;
}

/**
 * Slack's v0 signature: an HMAC of `v0:<timestamp>:<body>`, refused when the timestamp is over five minutes off.
 * @param {string} secret
 * @param {Buffer} body
 * @param {{signature?: string, timestamp?: string, nowMs: number}} headers  `X-Slack-Signature`, `X-Slack-Request-Timestamp`
 * @returns {boolean}
 */
export function verifySlackSignature(secret, body, { signature, timestamp, nowMs }) {
  if (!secret || typeof signature !== 'string' || !/^\d+$/.test(timestamp ?? '')) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_MAX_AGE_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * @param {object} payload  an Events API `event_callback`
 * @param {{receivedAt: string}} meta
 * @returns {object|null}  the message for the console: a person mentioning the bot, in the workspace the app is
 *   installed in. A bot's message, an edit, or someone from another workspace in a shared channel gives null
 */
export function toSlackMessage(payload, { receivedAt }) {
  const event = payload?.event;
  if (payload?.type !== 'event_callback' || event?.type !== 'app_mention') return null;
  if (event.bot_id || event.subtype || !event.user || !event.channel || !event.ts) return null;
  if (event.user_team && payload.team_id && event.user_team !== payload.team_id) return null;
  return {
    source: 'slack', type: 'mention', eventId: payload.event_id ?? '', receivedAt, team: payload.team_id ?? null,
    channel: event.channel, user: event.user, ts: event.ts, threadTs: event.thread_ts ?? null,
    text: String(event.text ?? '').slice(0, MAX_COMMENT_CHARS),
  };
}

function respond(statusCode, text) {
  return { statusCode, headers: { 'content-type': 'text/plain' }, body: text };
}

function lowerCaseKeys(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * @param {{getSecret: (opts?: {fresh?: boolean}) => Promise<string>, getSlackSecret?: (opts?: {fresh?: boolean}) => Promise<string>,
 *          enqueue: (message: object) => Promise<void>, now?: () => Date}} deps
 *   `getSecret({fresh: true})` reads the secret again, at most every 10 seconds: the console's Secrets page can rotate
 *   it. `getSlackSecret` is the same for Slack's signing secret; without it /slack is a 404
 * @returns {(event: object) => Promise<{statusCode: number, body: string}>}  a Function URL handler
 */
export function createHandler({ getSecret, getSlackSecret = null, enqueue, now = () => new Date() }) {
  return async function handle(request) {
    const path = request?.rawPath ?? '/';
    const method = request?.requestContext?.http?.method ?? 'GET';
    if (path !== '/github' && !(path === '/slack' && getSlackSecret)) return respond(404, 'not found');
    if (method !== 'POST') return respond(405, 'POST only');

    const headers = lowerCaseKeys(request.headers);
    const body = Buffer.from(request.body ?? '', request.isBase64Encoded ? 'base64' : 'utf8');
    if (path === '/slack') return handleSlack(headers, body);
    const signature = headers['x-hub-signature-256'];
    const signed = verifySignature(await getSecret(), body, signature) || verifySignature(await getSecret({ fresh: true }), body, signature);
    if (!signed) {
      console.warn('webhooks: bad or missing signature', { delivery: headers['x-github-delivery'] ?? null });
      return respond(401, 'bad signature');
    }

    const event = headers['x-github-event'];
    const deliveryId = headers['x-github-delivery'] ?? '';
    if (event === 'ping') return respond(200, 'pong');
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return respond(400, 'body must be JSON');
    }
    const message = toMessage(event, payload, { deliveryId, receivedAt: now().toISOString() });
    if (!message) {
      console.log('webhooks: ignored', { event, action: payload?.action ?? null, delivery: deliveryId });
      return respond(204, '');
    }
    await enqueue(message);
    console.log('webhooks: queued', { type: message.type, number: message.number, delivery: deliveryId });
    return respond(202, 'queued');
  };

  // Slack wants a 200 within three seconds or it sends the event again; a retry is queued too, and the console
  // drops the second by its event id.
  async function handleSlack(headers, body) {
    const signed = { signature: headers['x-slack-signature'], timestamp: headers['x-slack-request-timestamp'], nowMs: now().getTime() };
    const ok = verifySlackSignature(await getSlackSecret(), body, signed) || verifySlackSignature(await getSlackSecret({ fresh: true }), body, signed);
    if (!ok) {
      console.warn('webhooks: bad or missing Slack signature', { retry: headers['x-slack-retry-num'] ?? null });
      return respond(401, 'bad signature');
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return respond(400, 'body must be JSON');
    }
    // Slack's check of the URL, when the Events API is turned on.
    if (payload?.type === 'url_verification') return respond(200, String(payload.challenge ?? ''));
    const message = toSlackMessage(payload, { receivedAt: now().toISOString() });
    if (!message) {
      console.log('webhooks: Slack event ignored', { type: payload?.event?.type ?? payload?.type ?? null, event: payload?.event_id ?? null });
      return respond(200, '');
    }
    await enqueue(message);
    console.log('webhooks: Slack mention queued', { event: message.eventId, channel: message.channel, retry: headers['x-slack-retry-num'] ?? null });
    return respond(200, 'queued');
  }
}

// Read once per cold start, and again when a signature fails after a rotation. A failed read is retried on the
// next request rather than cached. Unsigned requests cannot make it read more than once every 10 seconds, and a
// rotation just after one costs at most 10 seconds of refused deliveries, which the poll then catches.
const REFRESH_MS = 10_000;
function secretFromSecretsManager(secretId) {
  let secretPromise = null;
  let readAt = 0;
  return async function read({ fresh = false } = {}) {
    if (fresh && Date.now() - readAt >= REFRESH_MS) secretPromise = null;
    if (!secretPromise) {
      readAt = Date.now();
      secretPromise = (async () => {
        const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
        const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
        return out.SecretString ?? '';
      })().catch((err) => {
        secretPromise = null;
        throw err;
      });
    }
    return secretPromise;
  };
}

let sqs = null;
async function sendToQueue(message) {
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  sqs ??= new SQSClient({});
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(message) }));
}

export const handler = createHandler({
  getSecret: secretFromSecretsManager(process.env.WEBHOOK_SECRET_ID),
  // Slack's events are off until Terraform names the secret.
  getSlackSecret: process.env.SLACK_SECRET_ID ? secretFromSecretsManager(process.env.SLACK_SECRET_ID) : null,
  enqueue: sendToQueue,
});
