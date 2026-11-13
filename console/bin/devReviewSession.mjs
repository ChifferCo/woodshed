// A made-up session's statusd for the dev console, answering only the review: the shed's real review host
// (session/reviewShed/host.mjs) over a small git checkout made here, with an analysis already written, so the session
// page's Review tab draws the real page with no container, GitHub or analysis run. Its chat and Re-review do run
// `claude` when one is on the PATH, in that checkout, as a session's would; without one they say why they failed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// A made-up author, and no signing: a signing setup of the person running it must not stop the dev console starting.
const AUTHOR = ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev Console', '-c', 'commit.gpgsign=false'];

// The default branch's files, then what the branch changes: a webhook sender that gives up on the first failure, and
// the branch that makes it retry with backoff.
const BEFORE = {
  'src/webhooks/deliver.mjs': `// Sends one webhook event to a subscriber's URL.

export async function deliver(subscription, event, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(subscription.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-event-id': event.id },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(\`\${subscription.url} answered \${res.status}\`);
  return { status: res.status };
}
`,
  'config/webhooks.json': `{
  "timeoutMs": 10000
}
`,
  'docs/webhooks.md': `# Webhooks

Each event is POSTed once to every subscriber. A subscriber that does not answer 2xx misses the event.
`,
};

const AFTER = {
  'src/webhooks/retry.mjs': `// When to try a failed delivery again: exponential backoff with full jitter, capped, for errors worth retrying.

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function shouldRetry(status) {
  return status === undefined || RETRYABLE.has(status);
}

/** @returns {number}  milliseconds to wait before attempt number \`attempt\` (1 is the first retry) */
export function backoffMs(attempt, { baseMs, maxMs, random = Math.random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** A Retry-After header in seconds or as a date, or null. */
export function retryAfterMs(header, now = Date.now()) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
`,
  'src/webhooks/deliver.mjs': `// Sends one webhook event to a subscriber's URL, trying again with backoff when the failure is worth retrying.

import config from '../../config/webhooks.json' with { type: 'json' };
import { backoffMs, retryAfterMs, shouldRetry } from './retry.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deliver(subscription, event, { fetch = globalThis.fetch, wait = sleep } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    let res = null;
    try {
      res = await fetch(subscription.url, {
        method: 'POST',
        // The same id on every attempt, so a subscriber can drop a repeat it already handled.
        headers: { 'content-type': 'application/json', 'x-event-id': event.id, 'x-attempt': String(attempt + 1) },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      lastError = err;
    }
    if (res?.ok) return { status: res.status, attempts: attempt + 1 };
    if (res) lastError = new Error(\`\${subscription.url} answered \${res.status}\`);
    if (!shouldRetry(res?.status) || attempt === config.maxRetries) break;
    const asked = retryAfterMs(res?.headers.get('retry-after'));
    await wait(Math.min(config.maxDelayMs, asked ?? backoffMs(attempt + 1, { baseMs: config.baseDelayMs, maxMs: config.maxDelayMs })));
  }
  throw lastError;
}
`,
  'src/webhooks/retry.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, retryAfterMs, shouldRetry } from './retry.mjs';

test('a 4xx other than 408, 425 and 429 is not retried', () => {
  assert.equal(shouldRetry(400), false);
  assert.equal(shouldRetry(429), true);
  assert.equal(shouldRetry(undefined), true, 'a network error is');
});

test('the backoff doubles up to the cap', () => {
  const top = (attempt) => backoffMs(attempt, { baseMs: 500, maxMs: 30_000, random: () => 0.999999 });
  assert.deepEqual([1, 2, 3].map(top), [499, 999, 1999]);
  assert.equal(top(20), 29_999);
});

test('Retry-After is read in seconds or as a date', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs('soon'), null);
});
`,
  'config/webhooks.json': `{
  "timeoutMs": 10000,
  "maxRetries": 5,
  "baseDelayMs": 500,
  "maxDelayMs": 30000
}
`,
  'docs/webhooks.md': `# Webhooks

Each event is POSTed to every subscriber. A subscriber that answers 408, 425, 429 or 5xx, or does not answer, is tried
again up to 5 times, waiting longer each time (500 ms doubling, at most 30 s), or as long as its Retry-After asks.
Every attempt carries the same \`x-event-id\`, so a subscriber can drop one it already handled.
`,
};

// What an analysis run writes (shared/review/analyze.mjs), for the files above.
const ARTIFACT = {
  overview: 'Webhook deliveries that fail with a timeout, a 429 or a 5xx are now tried again up to five times, with exponential backoff and full jitter, honouring `Retry-After` when the subscriber sends one.\n\nThe retry policy lives in its own module, `retry.mjs`, so `deliver.mjs` only loops; every attempt carries the same `x-event-id` so subscribers can drop repeats.',
  decisions: [
    {
      title: 'A delivery can now hold its worker for over three minutes',
      why: 'Five retries at up to 30 s each, plus a 10 s timeout per attempt, all inside one `deliver` call. That is fine while deliveries run in parallel; check the caller does not run them one after another.',
      files: ['src/webhooks/deliver.mjs', 'config/webhooks.json'],
    },
    {
      title: '`Retry-After` is honoured, capped at `maxDelayMs`',
      why: 'A subscriber answering `Retry-After: 86400` waits 30 s, not a day: `deliver.mjs` takes the smaller of the two.',
      files: ['src/webhooks/deliver.mjs', 'src/webhooks/retry.mjs'],
    },
    {
      title: 'Full jitter rather than fixed backoff',
      why: 'Spreads retries from many deliveries that failed at once, so a recovering subscriber is not hit by all of them on the same second.',
      files: ['src/webhooks/retry.mjs'],
    },
    {
      title: 'Only 408, 425, 429 and 5xx are retried',
      why: 'Any other 4xx means the request itself is wrong, and sending it again cannot help.',
      files: ['src/webhooks/retry.mjs'],
    },
    {
      title: 'De-duplication is left to subscribers',
      why: 'A retry after a timeout can deliver an event twice. Every attempt carries the same `x-event-id` and the docs ask subscribers to drop repeats; nothing on this side enforces it.',
      files: ['docs/webhooks.md'],
    },
    {
      title: 'The retry loop has no test of its own, and no dead-letter queue yet',
      why: 'The tests cover `retry.mjs`’s pure functions only, and an event that fails every attempt is still dropped; both are left for another change.',
      files: ['src/webhooks/retry.test.mjs', 'src/webhooks/deliver.mjs'],
    },
  ],
  architecture: 'The delivery path is now a loop around one `fetch`, with every decision about waiting moved out of it.\n\n| Piece | Responsibility |\n|---|---|\n| `src/webhooks/deliver.mjs` | Sends an event, loops on failure, sleeps between attempts |\n| `src/webhooks/retry.mjs` | Which statuses are retried, the backoff, `Retry-After` parsing |\n| `config/webhooks.json` | Timeout, retry count and delay bounds |',
  diagram: {
    nodes: [
      { id: 'caller', label: 'event source', change: 'unchanged' },
      { id: 'deliver', label: 'deliver.mjs', change: 'changed' },
      { id: 'retry', label: 'retry.mjs', change: 'added' },
      { id: 'config', label: 'config/webhooks.json', change: 'changed' },
      { id: 'subscriber', label: 'subscriber URL', change: 'unchanged' },
      { id: 'thrown', label: 'error to the caller', change: 'removed' },
    ],
    edges: [
      { from: 'caller', to: 'deliver', label: 'each event', change: 'unchanged' },
      { from: 'deliver', to: 'retry', label: 'retry? how long?', change: 'added' },
      { from: 'deliver', to: 'config', label: 'reads bounds', change: 'added' },
      { from: 'deliver', to: 'subscriber', label: 'POST', change: 'unchanged' },
      { from: 'deliver', to: 'thrown', label: 'on any non-2xx', change: 'removed' },
    ],
  },
  groups: [
    { title: 'The retry policy', why: 'Read the rules first: everything in `deliver.mjs` follows from them.', files: [
      { path: 'src/webhooks/retry.mjs', preamble: 'Three pure functions: `shouldRetry` decides from the status, `backoffMs` picks a wait with full jitter under a doubling ceiling, and `retryAfterMs` reads the header in either of its two forms.', role: 'core' },
    ] },
    { title: 'Delivering with retries', why: 'The loop that uses the policy, and the settings that bound it.', files: [
      { path: 'src/webhooks/deliver.mjs', preamble: 'Wraps the single `fetch` in a loop of `maxRetries + 1` attempts, stops at once for a status not worth retrying, and waits the server’s `Retry-After` or the backoff, never more than `maxDelayMs`. `wait` is injectable so the loop can be tested without sleeping.', role: 'core' },
      { path: 'config/webhooks.json', preamble: 'The four numbers the loop reads. `maxRetries` and `maxDelayMs` together set the longest a delivery can take.', role: 'config' },
    ] },
    { title: 'Tests and docs', why: 'What is checked, and what subscribers are told.', files: [
      { path: 'src/webhooks/retry.test.mjs', preamble: 'Covers the policy’s functions, including a capped backoff and both forms of `Retry-After`. The loop in `deliver.mjs` has no test of its own.', role: 'test' },
      { path: 'docs/webhooks.md', preamble: 'Tells subscribers which answers are retried and asks them to drop a repeated `x-event-id`.', role: 'docs' },
    ] },
  ],
  classified: 5,
  generatedAt: new Date().toISOString(),
};

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

/** A bare remote with the default branch, and a checkout on `branch` one commit ahead of it. */
function makeCheckout(root, branch, defaultBranch) {
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  const git = (...args) => execFileSync('git', [...AUTHOR, '-C', repo, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '--bare', '-b', defaultBranch, remote]);
  execFileSync('git', ['init', '-q', '-b', defaultBranch, repo]);
  writeFiles(repo, BEFORE);
  git('add', '-A');
  git('commit', '-q', '-m', 'Send webhooks');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', defaultBranch);
  git('remote', 'set-head', 'origin', defaultBranch);
  git('checkout', '-q', '-b', branch);
  writeFiles(repo, AFTER);
  git('add', '-A');
  git('commit', '-q', '-m', 'Retry webhook deliveries with backoff');
  return repo;
}

/**
 * @param {{id: string, branch: string}} opts  the made-up session's id and branch
 * @returns {Promise<{port: number, close: () => void}>}
 */
export async function startDevReview({ id, branch }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-review-'));
  // A session's own DEFAULT_BRANCH, when this runs in one, is what the shed diffs against.
  const repo = makeCheckout(root, branch, process.env.DEFAULT_BRANCH || 'main');
  // The shed's store reads this when it loads, so before the host is imported.
  process.env.WOODSHED_REVIEWS = path.join(root, 'reviews');
  const sessionDir = path.join(process.env.WOODSHED_REVIEWS, `claude-${id}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  // On disk before the first open, which then reads it as the finished analysis (restoreState).
  fs.writeFileSync(path.join(sessionDir, 'review.json'), JSON.stringify(ARTIFACT));
  const { createReviewHost } = await import('../../session/reviewShed/host.mjs');
  const host = createReviewHost({ repoDir: repo, sessionId: id, sessionKind: 'shared' });
  const server = http.createServer((req, res) => {
    host.handle(req, res).then((done) => {
      if (done) return;
      // Everything else a real statusd answers, this one does not.
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'the dev console\'s review session answers only its review' }));
    }).catch((err) => {
      console.warn('dev review: request failed', { message: err.message });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  console.log('dev console: review session ready', { id, port });
  return {
    port,
    close() {
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
