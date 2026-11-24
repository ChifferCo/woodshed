import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grokPlanUsageFrom, readGrokPlanUsage } from './grokPlanUsage.mjs';

const TAIL = 1024 * 1024;
const week = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-01T00:00:00.000Z', end: '2026-11-08T00:00:00.000Z' };
const line = (percent, extra = {}, ts = '2026-11-24T12:00:00.000Z', period = week) => JSON.stringify({
  ts, msg: 'billing: fetched credits config',
  ctx: { subscriptionTier: 'Example', prepaidBalance: { val: 0 }, config: { creditUsagePercent: percent, currentPeriod: period, ...extra } },
}) + '\n';

test('a weekly allowance becomes the week window, and nothing else on the line', () => {
  const usage = grokPlanUsageFrom(JSON.parse(line(62).trim()));
  assert.equal(usage.agent, 'grok');
  assert.equal(usage.asOf, '2026-11-24T12:00:00.000Z');
  assert.equal(usage.fiveHour, null);
  assert.deepEqual(usage.sevenDay, {
    usedPercent: 62, resetsAt: week.end, label: 'Week', short: 'wk', spanMs: 7 * 86400_000,
  });
  assert.equal('subscriptionTier' in usage || 'prepaidBalance' in usage, false);
});

test('a monthly period is labeled a month, and the percent is clamped', () => {
  const period = { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };
  const high = grokPlanUsageFrom(JSON.parse(line(150, {}, '2026-11-24T12:00:00.000Z', period).trim()));
  assert.equal(high.sevenDay.usedPercent, 100);
  assert.equal(high.sevenDay.label, 'Month');
  assert.equal(high.sevenDay.short, 'mo');
  assert.equal(high.sevenDay.spanMs, Date.parse(period.end) - Date.parse(period.start));
  const zero = grokPlanUsageFrom(JSON.parse(line(0).trim()));
  assert.equal(zero.sevenDay.usedPercent, 0);
  const negative = grokPlanUsageFrom(JSON.parse(line(-4).trim()));
  assert.equal(negative.sevenDay.usedPercent, 0);
});

test('a missing percent, a bad time and any other line produce no chip', () => {
  const noPercent = JSON.parse(line(40).trim());
  delete noPercent.ctx.config.creditUsagePercent;
  for (const value of [null, {}, { msg: 'billing: fetched credits config' }, { msg: 'other', ctx: { config: { creditUsagePercent: 10 } } }, noPercent, JSON.parse(line('40').trim()), JSON.parse(line(NaN).trim())]) {
    assert.equal(grokPlanUsageFrom(value), null);
  }
  const open = grokPlanUsageFrom(JSON.parse(line(12, {}, 'not-a-time', { type: 'USAGE_PERIOD_TYPE_WEEKLY' }).trim()));
  assert.equal(open.asOf, null);
  assert.equal(open.sevenDay.resetsAt, null);
  assert.equal(open.sevenDay.spanMs, undefined);
  const long = grokPlanUsageFrom(JSON.parse(line(12, {}, '2026-11-24T12:00:00.000Z', { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2020-01-01T00:00:00.000Z', end: '2026-11-08T00:00:00.000Z' }).trim()));
  assert.equal(long.sevenDay.spanMs, undefined);
  assert.equal(long.sevenDay.resetsAt, '2026-11-08T00:00:00.000Z');
});

test('readGrokPlanUsage reads the tail, ignores a partial line, and picks the newer event', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-usage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'unified.jsonl');
  assert.equal(await readGrokPlanUsage(path.join(dir, 'missing')), null);
  await fs.writeFile(file, `${'x'.repeat(TAIL + 5)}\n${line(28, {}, '2026-11-23T12:00:00.000Z')}${line(62)}\n{"partial":`);
  const usage = await readGrokPlanUsage(file);
  assert.equal(usage.sevenDay.usedPercent, 62);
  assert.equal(usage.asOf, '2026-11-24T12:00:00.000Z');
  assert.equal(await readGrokPlanUsage(file), usage, 'an unchanged file is not read again');
});

test('a log that grows past the billing line keeps it, and a newer line replaces it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-usage-grow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'unified.jsonl');
  await fs.writeFile(file, line(62));
  const first = await readGrokPlanUsage(file);
  await fs.appendFile(file, `${'y'.repeat(TAIL + 10)}\n`);
  const kept = await readGrokPlanUsage(file);
  assert.equal(kept, first);
  await fs.appendFile(file, line(80, {}, '2026-11-25T12:00:00.000Z'));
  const newer = await readGrokPlanUsage(file);
  assert.equal(newer.sevenDay.usedPercent, 80);
  assert.notEqual(newer, first);
});

test('a cold read still finds an allowance written before the last megabyte, including one split on the boundary', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-usage-scan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const buried = path.join(dir, 'buried.jsonl');
  await fs.writeFile(buried, line(44) + 'z'.repeat(TAIL + 50));
  assert.equal((await readGrokPlanUsage(buried)).sevenDay.usedPercent, 44);

  const event = line(55);
  const splitAt = 80;
  const size = TAIL + 100;
  const file = path.join(dir, 'split.jsonl');
  await fs.writeFile(file, `${'a'.repeat(splitAt - 1)}\n${event}${'b'.repeat(size - splitAt - event.length)}`);
  assert.equal((await readGrokPlanUsage(file)).sevenDay.usedPercent, 55);

  const beyond = path.join(dir, 'beyond.jsonl');
  await fs.writeFile(beyond, line(71) + 'q'.repeat(8 * TAIL + TAIL));
  assert.equal(await readGrokPlanUsage(beyond), null);
});
