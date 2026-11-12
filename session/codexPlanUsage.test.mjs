import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexPlanUsageFrom, readCodexPlanUsage } from './codexPlanUsage.mjs';

const record = (limits, timestamp = '2026-11-12T12:00:00Z') => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: limits } });
const week = { used_percent: 28, window_minutes: 10080, resets_at: 1795116181 };
test('Codex windows are selected by duration, including a weekly primary and no secondary', () => {
  const usage = codexPlanUsageFrom(record({ primary: week }));
  assert.equal(usage.agent, 'codex');
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.sevenDay.usedPercent, 28);
  assert.equal(usage.sevenDay.resetsAt, new Date(week.resets_at * 1000).toISOString());
  const both = codexPlanUsageFrom(record({ primary: { ...week, used_percent: 120, window_minutes: 300 }, secondary: week }));
  assert.equal(both.fiveHour.usedPercent, 100);
  assert.equal(both.sevenDay.usedPercent, 28);
});
test('missing, invalid, unrelated model limits and non-usage records produce no chip', () => {
  for (const value of [null, {}, { type: 'response_item' }, record(null), record({ primary: { ...week, used_percent: '28' } }), record({ limit_id: 'codex_review', primary: week }), record({ primary: { ...week, window_minutes: 60 } })]) {
    assert.equal(codexPlanUsageFrom(value), null);
  }
  assert.equal(codexPlanUsageFrom(record({ primary: { ...week, resets_at: Infinity } })).sevenDay.resetsAt, null);
});
test('readCodexPlanUsage reads nested rollout tails, ignores partial lines, and picks the latest reading', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await readCodexPlanUsage(path.join(dir, 'missing')), null);
  await fs.mkdir(path.join(dir, '2026/11/12'), { recursive: true });
  await fs.writeFile(path.join(dir, 'rollout-old.jsonl'), JSON.stringify(record({ primary: { ...week, used_percent: 80 } }, '2026-11-11T12:00:00Z')));
  await fs.writeFile(path.join(dir, '2026/11/12/rollout-new.jsonl'), 'x'.repeat(1024 * 1024 + 5) + '\n' + JSON.stringify(record({ primary: week })) + '\n{"partial":');
  assert.equal((await readCodexPlanUsage(dir)).sevenDay.usedPercent, 28);
});
