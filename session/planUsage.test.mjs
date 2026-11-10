import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { planUsageFrom, readPlanUsage } from './planUsage.mjs';

test('planUsageFrom turns the status line reading into ISO times and clamped percentages', () => {
  const out = planUsageFrom({
    at: 1793888249,
    rate_limits: { five_hour: { used_percentage: 42, resets_at: 1793900000 }, seven_day: { used_percentage: 130, resets_at: 1794139200 } },
  });
  assert.deepEqual(out, {
    asOf: '2026-11-05T14:17:29.000Z',
    fiveHour: { usedPercent: 42, resetsAt: '2026-11-05T17:33:20.000Z' },
    sevenDay: { usedPercent: 100, resetsAt: '2026-11-08T12:00:00.000Z' },
  });
});

test('planUsageFrom keeps a window that is there when the other is missing', () => {
  const out = planUsageFrom({ at: 1793888249, rate_limits: { seven_day: { used_percentage: 11, resets_at: 1794139200 } } });
  assert.equal(out.fiveHour, null);
  assert.equal(out.sevenDay.usedPercent, 11);
});

test('planUsageFrom says nothing without a usable window', () => {
  assert.equal(planUsageFrom(null), null);
  assert.equal(planUsageFrom({ at: 1 }), null);
  assert.equal(planUsageFrom({ at: 1, rate_limits: { five_hour: { used_percentage: '42' } } }), null);
  assert.equal(planUsageFrom({ rate_limits: { seven_day: { used_percentage: 5 } } }).asOf, null);
});

test('readPlanUsage reads the saved file, and is null when it is missing or half written', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-usage-'));
  const file = path.join(dir, 'claude.json');
  assert.equal(await readPlanUsage(file), null);
  await fs.writeFile(file, '{"at": 1793888249, "rate_limits": {"seven_day"');
  assert.equal(await readPlanUsage(file), null);
  await fs.writeFile(file, JSON.stringify({ at: 1793888249, rate_limits: { seven_day: { used_percentage: 11, resets_at: 1794139200 } } }));
  assert.equal((await readPlanUsage(file)).sevenDay.usedPercent, 11);
  await fs.rm(dir, { recursive: true });
});
