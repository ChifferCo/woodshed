// The Usage page's numbers: the tokens each session's agent spent, by day and model, and what they cost at the
// providers' list API prices (shared/apiPrices.mjs). A session's statusd counts them from the agent's own transcripts
// (session/tokenUsage.mjs) and says whether a plan (Claude or ChatGPT) or an API key pays for them; the console keeps
// each report in `state.tokenUsage`, by session and by run, so a session's usage stays after it is deleted, for
// KEEP_DAYS. For a key the price is what the key was charged, near enough; for a plan it is what the same tokens would
// have cost on a key.
//
// Who sees what: a person their own sessions' (private ones they own, shared ones they started or that ran on their
// plan); an admin everyone's.

import { PRICES_AS_OF, TOKEN_KINDS, costOf, priceOf } from '../shared/apiPrices.mjs';

export const KEEP_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 62;
const MAX_MODELS = 40;
const MAX_RUNS = 50;
const MAX_TOKENS = 1e13;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@[\]/-]{0,99}$/;

function tokensFrom(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const kind of TOKEN_KINDS) {
    const v = t[kind];
    out[kind] = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TOKENS ? Math.round(v) : 0;
  }
  return TOKEN_KINDS.some((k) => out[k]) ? out : null;
}

/**
 * statusd's `tokenUsage`, in range: it runs as the session's own user, so its answer is only as trusted as the session.
 * @returns {{agent: 'claude'|'codex', billing: 'plan'|'key', since: string, days: object}|null}
 */
export function tokenUsageFrom(report) {
  if (!report || typeof report !== 'object') return null;
  if (report.agent !== 'claude' && report.agent !== 'codex') return null;
  if (report.billing !== 'plan' && report.billing !== 'key') return null;
  const since = typeof report.since === 'string' && report.since.length <= 40 && Number.isFinite(Date.parse(report.since))
    ? new Date(report.since).toISOString() : null;
  if (!since || !report.days || typeof report.days !== 'object') return null;
  const days = {};
  for (const day of Object.keys(report.days).filter((d) => DAY_RE.test(d)).sort().slice(-MAX_DAYS)) {
    const models = report.days[day];
    if (!models || typeof models !== 'object') continue;
    for (const model of Object.keys(models).filter((m) => MODEL_RE.test(m)).slice(0, MAX_MODELS)) {
      const tokens = tokensFrom(models[model]);
      if (tokens) (days[day] ??= {})[model] = tokens;
    }
  }
  return { agent: report.agent, billing: report.billing, since, days };
}

/** @returns {'private'|'review'|'qa'|'ask'|'shared'} */
function kindOf(session) {
  if (session.owner) return 'private';
  if (session.review) return 'review';
  if (session.qa) return 'qa';
  if (session.slack) return 'ask';
  return 'shared';
}

/** @returns {string|null}  whose usage a session's is: its owner, the person whose plan it ran on, or who started it */
function personOf(entry) {
  return entry.owner ?? (entry.billing === 'plan' ? entry.plan : null) ?? entry.startedBy ?? null;
}

const zero = () => Object.fromEntries(TOKEN_KINDS.map((k) => [k, 0]));
const addTokens = (into, t) => { for (const k of TOKEN_KINDS) into[k] += t[k] ?? 0; return into; };
const totalOf = (t) => TOKEN_KINDS.reduce((s, k) => s + (t[k] ?? 0), 0);

/**
 * @param {{state: object, save: () => void}} store
 * @param {{now?: () => number}} [opts]
 */
export function createUsage(store, { now = Date.now } = {}) {
  const ledger = () => (store.state.tokenUsage ??= {});
  let prunedAt = -Infinity;

  /**
   * Keeps a session's latest report. Each run of the session (a Resume starts another) reports from its own start, so
   * the runs are kept side by side, by when each began.
   * @param {object} session
   * @param {object} report  statusd's `tokenUsage`
   * @returns {boolean}  whether anything changed
   */
  function record(session, report) {
    if (now() - prunedAt > 60 * 60 * 1000) prune();
    const usage = tokenUsageFrom(report);
    if (!usage || !Object.keys(usage.days).length) return false;
    const all = ledger();
    const entry = all[session.id] ??= { runs: {} };
    const meta = {
      title: typeof session.title === 'string' ? session.title.slice(0, 200) : null,
      repo: session.repo ?? null,
      branch: session.branch ?? null,
      kind: kindOf(session),
      owner: session.owner ?? null,
      startedBy: session.startedBy ?? null,
      plan: session.plan ?? null,
    };
    const run = { agent: usage.agent, billing: usage.billing, days: usage.days };
    const before = JSON.stringify(entry);
    Object.assign(entry, meta);
    entry.runs[usage.since] = run;
    const runs = Object.keys(entry.runs).sort();
    for (const old of runs.slice(0, Math.max(0, runs.length - MAX_RUNS))) delete entry.runs[old];
    if (JSON.stringify(entry) === before) return false;
    store.save();
    return true;
  }

  /** Drops the days past KEEP_DAYS, and a session left with none. */
  function prune() {
    prunedAt = now();
    const cutoff = new Date(now() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
    let changed = false;
    for (const [id, entry] of Object.entries(ledger())) {
      for (const [since, run] of Object.entries(entry.runs ?? {})) {
        for (const day of Object.keys(run.days ?? {})) {
          if (day < cutoff) { delete run.days[day]; changed = true; }
        }
        if (!Object.keys(run.days ?? {}).length) { delete entry.runs[since]; changed = true; }
      }
      if (!Object.keys(entry.runs ?? {}).length) { delete ledger()[id]; changed = true; }
    }
    if (changed) store.save();
  }

  /**
   * @param {{login: string|null, admin: boolean, everyone?: boolean, days?: number}} view
   *   `everyone` an admin's whole console; otherwise the viewer's own
   * @returns {object}  the page's numbers (README.md, "Usage")
   */
  function summary({ login, admin, everyone = false, days = 30 }) {
    const span = Math.min(KEEP_DAYS, Math.max(1, Math.round(Number(days) || 30)));
    const to = new Date(now()).toISOString().slice(0, 10);
    const from = new Date(now() - (span - 1) * DAY_MS).toISOString().slice(0, 10);
    const all = everyone && admin;
    const billings = { plan: { tokens: zero(), cost: 0, unpriced: 0 }, key: { tokens: zero(), cost: 0, unpriced: 0 } };
    const models = new Map();
    const people = new Map();
    const dayRows = new Map();
    const sessionRows = [];
    const unpricedModels = new Set();

    for (const [sessionId, entry] of Object.entries(ledger())) {
      for (const run of Object.values(entry.runs ?? {})) {
        const person = personOf({ ...entry, billing: run.billing });
        const mine = login && (entry.owner === login || entry.startedBy === login || (run.billing === 'plan' && entry.plan === login));
        if (!all && !mine) continue;
        let row = sessionRows.find((r) => r.sessionId === sessionId && r.billing === run.billing && r.agent === run.agent);
        for (const [day, byModel] of Object.entries(run.days ?? {})) {
          if (day < from || day > to) continue;
          for (const [model, tokens] of Object.entries(byModel)) {
            const cost = costOf(model, tokens);
            const b = billings[run.billing];
            addTokens(b.tokens, tokens);
            if (cost === null) { b.unpriced += totalOf(tokens); unpricedModels.add(model); } else b.cost += cost;

            const mKey = `${run.billing}|${run.agent}|${model}`;
            const m = models.get(mKey) ?? { billing: run.billing, agent: run.agent, model, priced: Boolean(priceOf(model)), tokens: zero(), cost: 0 };
            addTokens(m.tokens, tokens);
            m.cost += cost ?? 0;
            models.set(mKey, m);

            const pKey = person ?? '';
            const p = people.get(pKey) ?? { person, plan: { tokens: 0, cost: 0 }, key: { tokens: 0, cost: 0 } };
            p[run.billing].tokens += totalOf(tokens);
            p[run.billing].cost += cost ?? 0;
            people.set(pKey, p);

            const d = dayRows.get(day) ?? { day, plan: { tokens: 0, cost: 0 }, key: { tokens: 0, cost: 0 } };
            d[run.billing].tokens += totalOf(tokens);
            d[run.billing].cost += cost ?? 0;
            dayRows.set(day, d);

            if (!row) {
              row = { sessionId, title: entry.title, repo: entry.repo, branch: entry.branch, kind: entry.kind, person, agent: run.agent, billing: run.billing, tokens: 0, cost: 0, lastDay: day };
              sessionRows.push(row);
            }
            row.tokens += totalOf(tokens);
            row.cost += cost ?? 0;
            if (day > row.lastDay) row.lastDay = day;
          }
        }
      }
    }
    const byCost = (a, b) => b.cost - a.cost || totalOf(b.tokens ?? {}) - totalOf(a.tokens ?? {});
    const dayList = [];
    for (let i = 0; i < span; i++) {
      const day = new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10);
      dayList.push(dayRows.get(day) ?? { day, plan: { tokens: 0, cost: 0 }, key: { tokens: 0, cost: 0 } });
    }
    return {
      everyone: all,
      from,
      to,
      days: span,
      pricesAsOf: PRICES_AS_OF,
      totals: billings,
      unpricedModels: [...unpricedModels].sort(),
      byModel: [...models.values()].sort(byCost),
      byPerson: [...people.values()].sort((a, b) => (b.plan.cost + b.key.cost) - (a.plan.cost + a.key.cost)),
      byDay: dayList,
      bySession: sessionRows.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 50),
    };
  }

  return { record, prune, summary };
}
