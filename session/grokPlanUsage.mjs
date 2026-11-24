// Grok Build logs one billing snapshot when it fetches credits (`billing: fetched credits config` in
// ~/.grok/logs/unified.jsonl). Read only that line's allowance and when the period ends. Never the tier, balances,
// or anything else on the line. An API-key session, or one whose limits a team manages, may log no percent: then
// there is no chip. The line is written at startup and the log grows past it, so a reading is kept until the file
// changes and a newer one is in the tail.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES = 1024 * 1024;
const OVERLAP = 64 * 1024;
const SCAN_CAP = 8 * 1024 * 1024;
const MAX_SPAN_MS = 400 * 86400_000;
const MSG = 'billing: fetched credits config';

const defaultFile = () => path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'logs', 'unified.jsonl');

// The last reading per file, with the stat it was read from. statusd asks every few seconds.
const cache = new Map();

function prefer(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (a.asOf ?? '') >= (b.asOf ?? '') ? a : b;
}

/**
 * @param {object} record  one JSON line of unified.jsonl
 * @returns {{agent: 'grok', asOf: string|null, fiveHour: null, sevenDay: object}|null}
 */
export function grokPlanUsageFrom(record) {
  if (record?.msg !== MSG) return null;
  const config = record.ctx?.config;
  const used = config?.creditUsagePercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const period = config.currentPeriod;
  const end = typeof period?.end === 'string' ? Date.parse(period.end) : NaN;
  const start = typeof period?.start === 'string' ? Date.parse(period.start) : NaN;
  const monthly = typeof period?.type === 'string' && period.type.includes('MONTH');
  const span = Number.isFinite(end) && Number.isFinite(start) && end > start && end - start <= MAX_SPAN_MS ? end - start : null;
  const at = typeof record.ts === 'string' ? Date.parse(record.ts) : NaN;
  return {
    agent: 'grok',
    asOf: Number.isFinite(at) ? new Date(at).toISOString() : null,
    fiveHour: null,
    sevenDay: {
      usedPercent: Math.min(100, Math.max(0, used)),
      resetsAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
      label: monthly ? 'Month' : 'Week',
      short: monthly ? 'mo' : 'wk',
      ...(span !== null ? { spanMs: span } : {}),
    },
  };
}

function newestIn(text, { dropFirst, dropLast }) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  let newest = null;
  for (const line of lines) {
    if (!line.includes(MSG)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    newest = prefer(newest, grokPlanUsageFrom(record));
  }
  return newest;
}

async function readRange(handle, start, end) {
  const length = end - start;
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

// Backward through the file until an allowance shows or SCAN_CAP bytes have been covered. A chunk overlaps the next
// so a line split on the boundary is whole in one of them.
async function scanBack(handle, size) {
  let newest = null;
  let end = size;
  let looked = 0;
  while (end > 0 && looked < SCAN_CAP) {
    const start = Math.max(0, end - TAIL_BYTES);
    const text = await readRange(handle, start, end);
    newest = prefer(newest, newestIn(text, { dropFirst: start > 0, dropLast: end < size }));
    if (start === 0) break;
    const nextEnd = start + OVERLAP;
    looked += end - nextEnd;
    if (nextEnd >= end) break;
    end = nextEnd;
  }
  return newest;
}

/**
 * @param {string} [file]  unified.jsonl; the owner's Grok home when omitted
 * @returns {Promise<ReturnType<typeof grokPlanUsageFrom>>}
 */
export async function readGrokPlanUsage(file = defaultFile()) {
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      cache.delete(file);
      return null;
    }
    throw error;
  }
  const prev = cache.get(file);
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) return prev.usage;

  const handle = await fs.open(file, 'r');
  try {
    const size = stat.size;
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = newestIn(await readRange(handle, start, size), { dropFirst: start > 0, dropLast: false });
    // The tail's line is the one to show. A tail with none keeps the last reading when the log has grown past it.
    // A cold file larger than the tail is scanned once, only as far as SCAN_CAP.
    const usage = tail ?? (prev ? prev.usage : size > TAIL_BYTES ? await scanBack(handle, size) : null);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
    return usage;
  } finally {
    await handle.close();
  }
}
