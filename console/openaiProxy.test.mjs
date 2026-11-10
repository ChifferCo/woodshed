import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createOpenAiProxy } from './openaiProxy.mjs';
import { createSessionApi } from './sessionApi.mjs';

const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'codex-private', owner: 'joel', options: { agent: 'codex' } },
  { id: 'bbbbbbbb', status: 'running', token: 'claude-private', owner: 'joel', options: { agent: 'claude' } },
  { id: 'cccccccc', status: 'stopped', token: 'stopped', owner: 'joel', options: { agent: 'codex' } },
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(t, { teamKey = 'sk-team' } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {}\n\n');
    });
  });
  const upPort = await listen(upstream);
  const openai = createOpenAiProxy({ teamKey, upstream: `http://127.0.0.1:${upPort}` });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, openai });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  const call = (token) => fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{"model":"gpt-5.5"}',
  });
  return { seen, call };
}

test('a Codex session\'s call goes out on the team key, and its session token never reaches OpenAI', async (t) => {
  const { seen, call } = await setup(t);
  const res = await call('codex-private');
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/v1/responses', 'the console\'s prefix is dropped');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-team');
  assert.equal(seen[0].body, '{"model":"gpt-5.5"}');
  assert.ok(!JSON.stringify(seen[0].headers).includes('codex-private'));
});

test('only an active Codex session may use the team key', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('claude-private')).status, 403, 'a Claude session');
  assert.equal((await call('stopped')).status, 401, 'a stopped session');
  assert.equal((await call(null)).status, 401, 'no token');
  assert.equal(seen.length, 0, 'nothing reached OpenAI');
});

test('with no team key saved the session is told where to save one', async (t) => {
  const { call } = await setup(t, { teamKey: null });
  const res = await call('codex-private');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /openai-api-key/);
});
