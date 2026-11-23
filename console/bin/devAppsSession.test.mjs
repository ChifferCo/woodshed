import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startDevAppsSession } from './devAppsSession.mjs';

test('the two-app session counts none of the usage of whoever runs the dev console, even from a Codex session or a review', async (t) => {
  // A parent that is a Codex session in review mode, with a rollout of real-looking usage in its Codex home.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-apps-parent-'));
  const day = path.join(parent, 'codex', 'sessions', '2026', '11', '23');
  fs.mkdirSync(day, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(day, 'rollout-2026-11-23T00-00-00-x.jsonl'), [
    JSON.stringify({ timestamp: at, type: 'turn_context', payload: { model: 'gpt-operator-marker' } }),
    JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 99, output_tokens: 99 }, last_token_usage: { input_tokens: 99, output_tokens: 99 } } } }),
    '',
  ].join('\n'));
  const saved = {};
  for (const [key, value] of Object.entries({ AGENT: 'codex', CODEX_HOME: path.join(parent, 'codex'), SESSION_MODE: 'review', REVIEW_AGENTS: 'claude codex', REVIEW_CODEX_AUTH: 'key' })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  t.mock.method(console, 'log', () => {});
  const session = await startDevAppsSession({ id: 'abbaabba', token: 'tok' });
  t.after(() => session.close());
  const status = await (await fetch(`http://127.0.0.1:${session.port}/status`, { headers: { authorization: 'Bearer tok' } })).json();
  assert.ok(Array.isArray(status.tokenUsage), 'it reports, as any session does');
  assert.deepEqual(status.tokenUsage.map((r) => [r.agent, r.days]), [['claude', {}]], 'an ordinary claude session of its own, with nothing spent');
  assert.ok(!JSON.stringify(status).includes('operator-marker'));
});
