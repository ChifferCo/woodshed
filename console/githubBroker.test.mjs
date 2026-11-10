import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitHubBroker } from './githubBroker.mjs';
import { createProjectTokens } from './projectTokens.mjs';

const BEARER = 'brk_s3cret-bearer-value';

function tokenFile(t, text = `${BEARER}\n`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-broker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'broker-token');
  fs.writeFileSync(file, text);
  return file;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// What the console logs while `fn` runs, so a test can say the bearer never reached it.
async function logsOf(fn) {
  const lines = [];
  const kept = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(kept)) console[name] = (...args) => lines.push(JSON.stringify(args));
  try {
    await fn();
  } finally {
    Object.assign(console, kept);
  }
  return lines.join('\n');
}

test('the broker is asked with the bearer from its file, as JSON naming the repo, or {} for none', async (t) => {
  const asked = [];
  const clock = { now: Date.parse('2026-11-10T10:00:00Z') };
  async function fetchImpl(url, init) {
    asked.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return json(200, { token: `ghs_${asked.length}`, expiresAt: '2026-11-10T11:00:00Z' });
  }
  const broker = createGitHubBroker({ url: 'https://host.example/github/token', tokenFile: tokenFile(t), fetchImpl, now: () => clock.now });

  assert.deepEqual(await broker.tokenSource({ repo: 'acme/app', label: 'console' }).token(), { token: 'ghs_1', expiresAt: Date.parse('2026-11-10T11:00:00Z') });
  assert.deepEqual(asked[0], {
    url: 'https://host.example/github/token', method: 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' }, body: { repo: 'acme/app' },
  });
  await broker.tokenSource({ repo: null, label: 'console' }).token();
  assert.deepEqual(asked[1].body, {});
});

test('a repo\'s token is kept until 5 minutes before it expires, shared by every source on that repo', async (t) => {
  let asked = 0;
  const clock = { now: Date.parse('2026-11-10T10:00:00Z') };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function fetchImpl(url, init) {
    asked++;
    await gate;
    return json(200, { token: `ghs_${asked}_${JSON.parse(init.body).repo}`, expiresAt: new Date(clock.now + 60 * 60_000).toISOString() });
  }
  const broker = createGitHubBroker({ url: 'https://host.example/t', tokenFile: tokenFile(t), fetchImpl, now: () => clock.now });
  const console1 = broker.tokenSource({ repo: 'acme/app', label: 'console' });
  const sessions = broker.tokenSource({ repo: 'acme/app', label: 'sessions' });
  const other = broker.tokenSource({ repo: 'acme/api', label: 'console:api' });

  const together = Promise.all([console1.token(), sessions.token(), console1.token()]);
  release();
  const [a, b, c] = await together;
  assert.equal(asked, 1, 'callers that arrive together share one ask');
  assert.equal(a.token, 'ghs_1_acme/app');
  assert.deepEqual([b.token, c.token], [a.token, a.token]);
  assert.equal((await other.token()).token, 'ghs_2_acme/api', 'another repo is its own token');

  clock.now += 54 * 60_000;
  assert.equal((await sessions.token()).token, 'ghs_1_acme/app', 'six minutes left: still kept');
  assert.equal(asked, 2);
  clock.now += 60_001;
  assert.equal((await sessions.token()).token, 'ghs_3_acme/app', 'under five minutes left: asked again');
});

test('a refusal says the status and the broker\'s error, and the bearer is never logged', async (t) => {
  const answers = [
    json(403, { error: 'the App is not installed on acme/app' }),
    new Response('<html>bad gateway</html>', { status: 502 }),
    json(200, { token: 'ghs_x' }),
    json(201, { token: 'ghs_x', expiresAt: '2026-11-10T11:00:00Z' }),
  ];
  const broker = createGitHubBroker({ url: 'https://host.example/t', tokenFile: tokenFile(t), fetchImpl: async () => answers.shift() });
  const source = broker.tokenSource({ repo: 'acme/app', label: 'sessions' });
  const logged = await logsOf(async () => {
    await assert.rejects(source.token(), /the GitHub broker refused a token \(sessions\): HTTP 403 the App is not installed on acme\/app/);
    await assert.rejects(source.token(), /HTTP 502$/);
    await assert.rejects(source.token(), /HTTP 200/, 'no expiry is no token');
    await assert.rejects(source.token(), /HTTP 201/, 'only a 200 is an answer');
  });
  assert.match(logged, /githubBroker: token refused/);
  assert.ok(!logged.includes(BEARER), 'the bearer is never in the log');
});

test('the bearer is read at each ask, so the host can rotate it, and an empty or missing file is an error', async (t) => {
  const seen = [];
  const file = tokenFile(t);
  const clock = { now: Date.parse('2026-11-10T10:00:00Z') };
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization);
    return json(200, { token: 'ghs_x', expiresAt: new Date(clock.now + 60_000).toISOString() });
  };
  const broker = createGitHubBroker({ url: 'https://host.example/t', tokenFile: file, fetchImpl, now: () => clock.now });
  const source = broker.tokenSource({ repo: 'acme/app', label: 'console' });
  await source.token();
  fs.writeFileSync(file, 'rotated');
  await source.token();
  assert.deepEqual(seen, [`Bearer ${BEARER}`, 'Bearer rotated'], 'a token with under 5 minutes left is asked for again, with the new bearer');
  fs.writeFileSync(file, '  \n');
  await assert.rejects(source.token(), /the GitHub broker's token file is empty/);
  fs.rmSync(file);
  await assert.rejects(source.token(), /the GitHub broker's token file could not be read \(ENOENT\)/);
});

test('with a broker, the console and coding sessions borrow the repo\'s token, and an ask session gets none', async (t) => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(JSON.parse(init.body).repo);
    return json(200, { token: 'ghs_borrowed', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  };
  const config = {
    githubApp: null, githubBroker: { url: 'https://host.example/t', tokenFile: tokenFile(t) },
    projects: [{ name: 'app', repo: 'acme/app', default: true }, { name: 'api', repo: 'acme/api' }],
  };
  const tokens = createProjectTokens({ config, fetchImpl });
  assert.equal((await tokens.console.token()).token, 'ghs_borrowed');
  assert.equal((await tokens.sessions.token()).token, 'ghs_borrowed');
  assert.equal(tokens.asks, null, 'nothing can narrow the broker\'s token to read-only');
  const api = tokens.forSession({ project: 'api' });
  assert.deepEqual([api.project, api.default, api.asks], ['api', false, null]);
  await api.sessions.token();
  assert.deepEqual(asked, ['acme/app', 'acme/api']);
  assert.equal(createProjectTokens({ config: { ...config, githubBroker: null } }), null, 'neither an App nor a broker: no tokens');
});
