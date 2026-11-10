// What the Console settings page lists under "Sessions holding data": each stopped shared session that still keeps
// its conversation and databases, and anything stalled. Stalled is what the console's own clean-up has not managed:
// a session stuck starting or stopping, databases with no session to keep them that are not dropping, and a saved
// Claude home with no kept session. Each comes with what fixes it.

import { spanText } from './consoleSettings.mjs';
import { sessionDatabaseName } from './databases.mjs';
import { sharedHomeName } from './homes.mjs';
import { ACTIVE_STATUSES, keptIds } from './sessions.mjs';

// Past this a start or a stop is stuck: a start gives up at 15 minutes, a stop's checkpoint at 90 seconds.
export const STUCK_MS = 20 * 60_000;

function since(iso, now) {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? now - at : 0;
}

/**
 * @param {{sessions: object[], records: object, homes: {id: string, bytes: number, savedAt: string|null}[]|null,
 *          now: number, dropRetryMs: number}} args
 *   `records` is state.json's `sessionDatabases`; `homes` is null when the bucket could not be listed
 * @returns {{held: object[], stalled: object[], homesListed: boolean,
 *            totals: {databases: number, homes: number|null, homeBytes: number|null}}}
 */
export function heldReport({ sessions, records, homes, now, dropRetryMs }) {
  const homeIds = new Map((homes ?? []).map((h) => [h.id, h]));
  const keep = keptIds(sessions);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ref = (s) => (s ? { sessionKind: s.kind, number: s.number, prUrl: s.prUrl ?? null } : { sessionKind: null, number: null, prUrl: null });
  const held = sessions
    .filter((s) => !s.owner && s.kept && !ACTIVE_STATUSES.has(s.status))
    .map((s) => ({
      id: s.id, title: s.title, ...ref(s), stopReason: s.stopReason ?? null,
      stoppedAt: s.stoppedAt ?? null, deletesAt: s.deletesAt ?? null, prClosedAt: s.prClosedAt ?? null, prMerged: Boolean(s.prMerged),
      database: records[s.id] ? sessionDatabaseName(s.id) : null,
      home: homes ? Boolean(homeIds.get(s.id)) : null, homeBytes: homeIds.get(s.id)?.bytes ?? null,
    }));

  const stalled = [];
  // A teammate's My Woodshed session is theirs alone to see, here as everywhere.
  for (const s of sessions.filter((x) => !x.owner)) {
    const from = s.status === 'starting' ? s.startedAt : s.status === 'stopping' ? s.stoppingAt : null;
    if (!from || since(from, now) <= STUCK_MS) continue;
    stalled.push({
      kind: 'stuck', id: s.id, title: s.title, ...ref(s), status: s.status,
      why: `Stuck in ${s.status} for ${spanText(since(from, now))}${s.status === 'stopping' ? ': its last push never answered' : ''}`,
      meta: [records[s.id] ? sessionDatabaseName(s.id) : null].filter(Boolean),
    });
  }
  for (const [id, record] of Object.entries(records)) {
    if (keep.has(id)) continue;
    const failing = record.status === 'failed' || (record.status === 'working' && since(record.startedAt, now) > dropRetryMs);
    if (!failing) continue;
    const session = byId.get(id);
    const error = record.error ? ` (${record.error})` : '';
    stalled.push({
      kind: 'databases', id, title: session?.title ?? null, ...ref(session), orphan: !session,
      why: session
        ? `Deleted${session.cleanedAt ? ` ${spanText(since(session.cleanedAt, now))} ago` : ''}, but its databases are still there: the drop did not work${error}`
        : `Databases with no session in the console${error}`,
      meta: [sessionDatabaseName(id)],
    });
  }
  for (const home of homes ?? []) {
    if (keep.has(home.id)) continue;
    const session = byId.get(home.id);
    stalled.push({
      kind: 'home', id: home.id, title: session?.title ?? null, ...ref(session), orphan: !session,
      why: session ? 'Deleted, but its saved conversation is still there: its delete has not worked yet' : 'A saved conversation with no session in the console',
      meta: [`${sharedHomeName(home.id)}/claude-home.tar.gz`, megabytes(home.bytes)],
    });
  }
  const totals = {
    databases: Object.values(records).filter((r) => r.action !== 'remove').length,
    homes: homes ? homes.length : null,
    homeBytes: homes ? homes.reduce((sum, h) => sum + (h.bytes || 0), 0) : null,
  };
  return { held, stalled, homesListed: Boolean(homes), totals };
}

function megabytes(bytes) {
  return `${Math.max(1, Math.round((bytes || 0) / 1_000_000))} MB`;
}

/**
 * @param {{store: {state: object}, fleet: object, databases: object|null, homes: object|null, now?: () => number}} deps
 */
export function createHeldData({ store, fleet, databases, homes, now = Date.now }) {
  /** @returns {Promise<{held: object[], stalled: object[], homesListed: boolean}>} */
  async function report() {
    let listed = null;
    if (homes?.listShared) {
      try {
        listed = await homes.listShared();
      } catch (err) {
        console.warn('heldData: the Claude homes could not be listed', { message: String(err?.message ?? err).split('\n')[0] });
      }
    }
    return heldReport({
      sessions: fleet.sessions(), records: databases?.sessionRecords?.() ?? store.state.sessionDatabases ?? {}, homes: listed,
      now: now(), dropRetryMs: databases?.DROP_RETRY_MS ?? 10 * 60_000,
    });
  }

  /**
   * The fix a stalled row offers, checked again against the state now, so a row the page showed a while ago and
   * that has since become a kept or running session is left alone.
   * @param {{kind: 'stuck'|'databases'|'home', id: string, by: string}} args
   * @throws {Error}  shown, when it no longer applies
   */
  async function clean({ kind, id, by }) {
    const gone = () => Object.assign(new Error('that is no longer stalled: reload the page'), { shown: true });
    const { stalled } = await report();
    if (!stalled.some((r) => r.kind === kind && r.id === id)) throw gone();
    console.log('heldData: stalled data cleaned', { kind, id, by });
    if (kind === 'stuck') return fleet.forceStop(fleet.find(id), by);
    if (kind === 'databases') return databases.dropSessionNow(id, by);
    if (kind === 'home') return homes.remove(sharedHomeName(id));
    throw gone();
  }

  return { report, clean };
}
