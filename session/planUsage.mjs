// How much of the owner's Claude plan is used, for the console's plan chip. Nothing is fetched: Claude Code hands
// `rate_limits` to the status line command after each API response, and session/statusline.sh saves it to FILE. The
// usage endpoint behind claude.ai refuses the setup token a private session runs on, so this is the one source.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FILE = path.join(os.homedir(), '.claude', 'woodshed-usage', 'claude.json');

function windowFrom(w) {
  const used = w?.used_percentage;
  const resets = w?.resets_at;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: typeof resets === 'number' && Number.isFinite(resets) ? new Date(resets * 1000).toISOString() : null,
  };
}

/**
 * @param {{at?: number, rate_limits?: object}|null} record  what the status line saved: `at` in Unix seconds
 * @returns {{asOf: string|null, fiveHour: {usedPercent: number, resetsAt: string|null}|null,
 *            sevenDay: {usedPercent: number, resetsAt: string|null}|null}|null}
 *   either window may be missing, as Claude Code leaves one out on its own; null when neither is there
 */
export function planUsageFrom(record) {
  const limits = record?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const fiveHour = windowFrom(limits.five_hour);
  const sevenDay = windowFrom(limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  const asOf = typeof record.at === 'number' && Number.isFinite(record.at) ? new Date(record.at * 1000).toISOString() : null;
  return { asOf, fiveHour, sevenDay };
}

/** @returns {Promise<ReturnType<typeof planUsageFrom>>}  null before Claude's first answer, or on a plan with no limits */
export async function readPlanUsage(file = FILE) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return planUsageFrom(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
