// Antigravity's quota, for the pane bar's plan meter, from what its status line was last given (agentStatusLine.mjs):
// `quota` holds each model group's buckets, each with the fraction left and when it resets
// (antigravity.google/docs/cli/statusline). Its 5-hour and weekly buckets become the meter's fiveHour and sevenDay, as
// Claude Code's and Codex's windows do: the most used of each, across the groups. An API key has no quota, and gives
// none (the docs: /usage and the status line's quota are off on a key), so a session on one shows no meter, and a Google
// sign-in on a subscription does. Reconstructed from the docs' field names, which agy 1.5.14's own match
// (`remaining_fraction,omitempty`, `reset_in_seconds,omitempty` on its status line's quota bucket): a used-up bucket
// leaves its zero fraction out, which is none left. No session has shown one yet.

const HOUR = 3600;
const WINDOWS = [['fiveHour', 5 * HOUR], ['sevenDay', 7 * 24 * HOUR]];

/**
 * @param {any} status  the status line's last input, with `at` (ms) when it was written (readStatus)
 * @returns {{agent: 'antigravity', asOf: string|null, fiveHour: object|null, sevenDay: object|null}|null}
 */
export function antigravityPlanUsageFrom(status) {
  const quota = status?.quota;
  if (!quota || typeof quota !== 'object') return null;
  const at = Number.isFinite(status.at) ? status.at : null;
  const out = { agent: 'antigravity', asOf: at === null ? null : new Date(at).toISOString(), fiveHour: null, sevenDay: null };
  for (const bucket of bucketsOf(quota)) {
    // agy leaves a zero out: no fraction is none left.
    const left = bucket.remaining_fraction === undefined ? 0 : Number(bucket.remaining_fraction);
    const resetIn = Number(bucket.reset_in_seconds);
    if (!Number.isFinite(left) || !Number.isFinite(resetIn) || resetIn < 0) continue;
    // The window a bucket is: the shortest that its reset fits in.
    const window = WINDOWS.find(([, seconds]) => resetIn <= seconds * 1.05)?.[0];
    if (!window) continue;
    const usedPercent = Math.round(Math.min(100, Math.max(0, (1 - left) * 100)) * 100) / 100;
    const resetsAt = at === null ? (typeof bucket.reset_time === 'string' ? bucket.reset_time : null) : new Date(at + resetIn * 1000).toISOString();
    if (!out[window] || usedPercent > out[window].usedPercent) out[window] = { usedPercent, resetsAt };
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

// The buckets, however deep: `quota` maps a group to its buckets, or a bucket name to a bucket.
function bucketsOf(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return [];
  if ('remaining_fraction' in node || 'reset_in_seconds' in node) return [node];
  return Object.values(node).flatMap((child) => bucketsOf(child, depth + 1));
}
