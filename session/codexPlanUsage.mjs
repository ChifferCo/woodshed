// Codex records account rate limits in token_count events in its local rollout files. Read only a bounded tail;
// never send the transcript, credits, or account details to the console. API-key sessions may report no limits.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SESSIONS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const TAIL_BYTES = 1024 * 1024;

export function codexPlanUsageFrom(record) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
  const limits = record.payload.rate_limits;
  if (!limits || (limits.limit_id && limits.limit_id !== 'codex')) return null;
  const out = { agent: 'codex', asOf: typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp)) ? new Date(record.timestamp).toISOString() : null, fiveHour: null, sevenDay: null };
  for (const w of [limits.primary, limits.secondary]) {
    const key = w?.window_minutes === 300 ? 'fiveHour' : w?.window_minutes === 10080 ? 'sevenDay' : null;
    if (!key || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
    const reset = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000) : null;
    out[key] = { usedPercent: Math.min(100, Math.max(0, w.used_percent)), resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null };
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

export async function readCodexPlanUsage(dir = SESSIONS) {
  let entries;
  try { entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const files = await Promise.all(entries.filter((e) => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).map(async (e) => {
    const file = path.join(e.parentPath, e.name);
    try { return { file, mtime: (await fs.stat(file)).mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  let newest = null;
  for (const { file } of files.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 8)) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start) lines.shift();
      for (const line of lines.reverse()) {
        if (!line.includes('"token_count"')) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const usage = codexPlanUsageFrom(record);
        if (usage && (!newest || (usage.asOf ?? '') > (newest.asOf ?? ''))) newest = usage;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  return newest;
}
