// What the session's container uses, for the console's CPU and memory badge: the shed sums its process tree from
// /proc, but here the container is the session, so its cgroup says it at once. cgroup v2 and v1 both, since which one
// Fargate mounts depends on its platform version. Memory leaves out the inactive file cache, as `docker stats` does:
// a big checkout fills the cache without anyone being short.

import fs from 'node:fs/promises';

const ROOT = '/sys/fs/cgroup';

async function readOr(file, fallback = null) {
  return fs.readFile(file, 'utf8').then((s) => s.trim(), () => fallback);
}

function statField(text, key) {
  const line = String(text ?? '').split('\n').find((l) => l.startsWith(`${key} `));
  return line ? Number(line.split(' ')[1]) : null;
}

/**
 * @param {string} [root]
 * @returns {Promise<{cpuUsec: number|null, memoryBytes: number|null, memoryLimitBytes: number|null, cores: number|null}>}
 */
export async function readUsage(root = ROOT) {
  const v2 = await readOr(`${root}/cpu.stat`);
  if (v2 !== null) {
    const current = Number(await readOr(`${root}/memory.current`, 'NaN'));
    const inactive = statField(await readOr(`${root}/memory.stat`), 'inactive_file') ?? 0;
    const max = await readOr(`${root}/memory.max`, 'max');
    const [quota, period] = String(await readOr(`${root}/cpu.max`, 'max 100000')).split(' ');
    return {
      cpuUsec: statField(v2, 'usage_usec'),
      memoryBytes: Number.isFinite(current) ? Math.max(0, current - inactive) : null,
      memoryLimitBytes: max === 'max' ? null : Number(max),
      cores: quota === 'max' ? null : Number(quota) / Number(period),
    };
  }
  const cpuNs = Number(await readOr(`${root}/cpuacct/cpuacct.usage`, 'NaN'));
  const usage = Number(await readOr(`${root}/memory/memory.usage_in_bytes`, 'NaN'));
  const inactive = statField(await readOr(`${root}/memory/memory.stat`), 'total_inactive_file') ?? 0;
  const limit = Number(await readOr(`${root}/memory/memory.limit_in_bytes`, 'NaN'));
  const quota = Number(await readOr(`${root}/cpu/cpu.cfs_quota_us`, '-1'));
  const period = Number(await readOr(`${root}/cpu/cpu.cfs_period_us`, '100000'));
  return {
    cpuUsec: Number.isFinite(cpuNs) ? cpuNs / 1000 : null,
    memoryBytes: Number.isFinite(usage) ? Math.max(0, usage - inactive) : null,
    // v1 says "no limit" with a number near 2^63.
    memoryLimitBytes: Number.isFinite(limit) && limit < 2 ** 60 ? limit : null,
    cores: quota > 0 ? quota / period : null,
  };
}

/**
 * @param {{cpuUsec: number|null, at: number}|null} prev  the last sample, or null for the first
 * @param {{cpuUsec: number|null, memoryBytes: number|null, memoryLimitBytes: number|null, cores: number|null, at: number}} next
 * @returns {{cpuPercent: number|null, memoryBytes: number|null, memoryLimitBytes: number|null, cores: number|null}}
 *   `cpuPercent` as the shed has it: 100 is one core busy, null until two samples are 2 s apart
 */
export function usageBetween(prev, next) {
  const elapsedMs = prev ? next.at - prev.at : 0;
  const busy = prev && elapsedMs >= 2000 && prev.cpuUsec !== null && next.cpuUsec !== null ? next.cpuUsec - prev.cpuUsec : null;
  return {
    cpuPercent: busy !== null && busy >= 0 ? Math.round((busy / 1000 / elapsedMs) * 1000) / 10 : null,
    memoryBytes: next.memoryBytes,
    memoryLimitBytes: next.memoryLimitBytes,
    cores: next.cores,
  };
}
