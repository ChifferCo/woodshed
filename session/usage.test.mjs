import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readUsage, usageBetween } from './usage.mjs';

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-cgroup-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return root;
}

test('cgroup v2 and v1 give the same answer, the inactive file cache left out', async (t) => {
  const GB = 1024 ** 3;
  const v2 = await tree({
    'cpu.stat': 'usage_usec 5000000\nuser_usec 4000000\n', 'memory.current': String(3 * GB), 'memory.stat': `anon 1\ninactive_file ${GB}\n`,
    'memory.max': String(8 * GB), 'cpu.max': '200000 100000',
  });
  const v1 = await tree({
    'cpuacct/cpuacct.usage': '5000000000', 'memory/memory.usage_in_bytes': String(3 * GB), 'memory/memory.stat': `total_inactive_file ${GB}\n`,
    'memory/memory.limit_in_bytes': String(8 * GB), 'cpu/cpu.cfs_quota_us': '200000', 'cpu/cpu.cfs_period_us': '100000',
  });
  t.after(() => Promise.all([v2, v1].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const expected = { cpuUsec: 5_000_000, memoryBytes: 2 * GB, memoryLimitBytes: 8 * GB, cores: 2 };
  assert.deepEqual(await readUsage(v2), expected);
  assert.deepEqual(await readUsage(v1), expected);

  const unlimited = await tree({ 'cpu.stat': 'usage_usec 1\n', 'memory.current': '100', 'memory.max': 'max', 'cpu.max': 'max 100000' });
  t.after(() => fs.rm(unlimited, { recursive: true, force: true }));
  assert.deepEqual(await readUsage(unlimited), { cpuUsec: 1, memoryBytes: 100, memoryLimitBytes: null, cores: null });
});

test('CPU is per core between two samples 2 s apart, and unknown before', () => {
  const at = 1_000_000;
  const first = { cpuUsec: 0, memoryBytes: 5, memoryLimitBytes: 10, cores: 2, at };
  assert.equal(usageBetween(null, first).cpuPercent, null);
  // 3 s of one core busy over 2 s is 150%.
  assert.equal(usageBetween(first, { ...first, cpuUsec: 3_000_000, at: at + 2000 }).cpuPercent, 150);
  assert.equal(usageBetween(first, { ...first, cpuUsec: 3_000_000, at: at + 1000 }).cpuPercent, null, 'too close');
  assert.equal(usageBetween(first, { ...first, cpuUsec: -5, at: at + 5000 }).cpuPercent, null, 'a counter that went back');
});
