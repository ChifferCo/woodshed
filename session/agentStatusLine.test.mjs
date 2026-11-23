import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { isolatedEnv } from '../test/isolatedEnv.mjs';
import { keepStatus, readStatus, statusLineText } from './agentStatusLine.mjs';
import { antigravityPlanUsageFrom } from './agentPlanUsage.mjs';

const run = promisify(execFile);

// Field names from antigravity.google/docs/cli/statusline; no session has shown one yet.
const STATUS = {
  agent_state: 'tool_use', tool_confirmation_pending: false, conversation_id: 'c1', transcript_path: '/home/node/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl',
  model: { display_name: 'Gemini 4 Argon' },
  quota: { argon: { five_hour: { remaining_fraction: 0.25, reset_in_seconds: 3600 }, weekly: { remaining_fraction: 0.9, reset_in_seconds: 5 * 24 * 3600 } } },
};

test('the status line keeps agy\'s JSON whole for statusd, and draws a short line', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'status.json');
  const script = fileURLToPath(new URL('./agentStatusLine.mjs', import.meta.url));
  const child = run('node', [script], { env: { ...isolatedEnv(), WOODSHED_AGENT_STATUS_FILE: file } });
  child.child.stdin.end(JSON.stringify(STATUS));
  const { stdout } = await child;
  assert.equal(stdout, 'Gemini 4 Argon · tool use\n');
  const kept = await readStatus(file);
  assert.equal(kept.transcript_path, STATUS.transcript_path);
  assert.ok(kept.at > 0);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('what is not a JSON object is not kept, and an asking agent says so', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'statusline-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(keepStatus('not json', path.join(dir, 's.json')), null);
  assert.equal(keepStatus('[1]', path.join(dir, 's.json')), null);
  assert.equal(await readStatus(path.join(dir, 's.json')), null);
  assert.equal(statusLineText({ model: 'auto', tool_confirmation_pending: true }), 'auto · waiting for you');
});

test('Antigravity\'s quota: the most used 5-hour and weekly buckets, as the plan meter reads them', () => {
  const at = Date.parse('2026-11-23T10:00:00Z');
  assert.deepEqual(antigravityPlanUsageFrom({ ...STATUS, at }), {
    agent: 'antigravity', asOf: '2026-11-23T10:00:00.000Z',
    fiveHour: { usedPercent: 75, resetsAt: '2026-11-23T11:00:00.000Z' },
    sevenDay: { usedPercent: 10, resetsAt: '2026-11-28T10:00:00.000Z' },
  });
  // A key has no quota.
  assert.equal(antigravityPlanUsageFrom({ agent_state: 'idle', at }), null);
  assert.equal(antigravityPlanUsageFrom(null), null);
});
