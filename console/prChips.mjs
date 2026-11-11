// What each session's pull request looks like now, for the chip on its card and pane bar: open, draft, in the merge
// queue, merged or closed, its checks and its review. After the shed's prStatus.mjs, which reads the same fields per branch with `gh pr
// list`; here one GraphQL call asks for every session's pull request that is due, by number, with the console's App
// token. A failure keeps what was last read. While pull request webhooks arrive, a webhook marks the pull request it
// is about as due, and the rest are read only every `fallbackMs`, for a lost delivery.

const REFRESH_MS = 60_000;
// A settled pull request changes rarely; it is asked again every 15 minutes.
const SETTLED_MS = 15 * 60_000;
const MAX_PER_CALL = 50;

/**
 * The shed's reduction (prStatus.mjs reduceChecks): a check run's verdict is its conclusion once complete, else its
 * status; a status context's is its state.
 * @param {object[]} contexts  statusCheckRollup.contexts.nodes
 * @returns {{pass: number, fail: number, pending: number, total: number}}
 */
export function reduceChecks(contexts) {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const check of contexts ?? []) {
    const verdict = check?.status === 'COMPLETED' ? check?.conclusion : (check?.state || check?.status);
    if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') pass++;
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(verdict)) fail++;
    else pending++;
  }
  return { pass, fail, pending, total: pass + fail + pending };
}

/**
 * @param {object} raw  a pullRequest node from the query
 * @returns {{number: number, title: string, state: 'open'|'draft'|'queued'|'merged'|'closed', review: 'approved'|'changes'|'pending'|null,
 *            checks: {pass: number, fail: number, pending: number, total: number}|null, queuePosition: number|null}}
 */
export function describePr(raw) {
  let state = 'open';
  if (raw.state === 'MERGED') state = 'merged';
  else if (raw.state === 'CLOSED') state = 'closed';
  else if (raw.isDraft) state = 'draft';
  else if (raw.mergeQueueEntry) state = 'queued';
  const settled = state === 'merged' || state === 'closed';
  const review = settled ? null
    : { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'pending' }[raw.reviewDecision] ?? null;
  const checks = settled ? null : reduceChecks(raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes);
  const queuePosition = state === 'queued' && Number.isInteger(raw.mergeQueueEntry.position) ? raw.mergeQueueEntry.position : null;
  return { number: raw.number, title: String(raw.title ?? '').slice(0, 300), state, review, checks: checks?.total ? checks : null, queuePosition };
}

/** @returns {number|null}  the number of a pull request on `repo` */
export function prNumberOf(prUrl, repo) {
  const match = new RegExp(`^https://github\\.com/${repo.replace('/', '\\/')}/pull/(\\d+)$`).exec(String(prUrl ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * @param {{github: {pullStatuses: (numbers: number[]) => Promise<object[]>}|null, repo: string, now?: () => number,
 *          webhooksFlowing?: () => boolean, fallbackMs?: number}} deps
 *   `webhooksFlowing` says pull request webhooks are arriving; `fallbackMs` is how often an open pull request is read then
 */
export function createPrChips({ github, repo, now = Date.now, webhooksFlowing = () => false, fallbackMs = REFRESH_MS }) {
  const known = new Map();
  // When each number GitHub had no pull request for was asked: it is asked again only as often as a settled one.
  const missing = new Map();

  function due(number) {
    const entry = known.get(number);
    if (!entry) return now() - (missing.get(number) ?? -Infinity) >= SETTLED_MS;
    if (entry.stale) return true;
    const settled = entry.pr.state === 'merged' || entry.pr.state === 'closed';
    const openMs = webhooksFlowing() ? Math.max(fallbackMs, REFRESH_MS) : REFRESH_MS;
    return now() - entry.at >= (settled ? SETTLED_MS : openMs);
  }

  /**
   * A webhook said these pull requests changed: each one this has read is due at the next refresh.
   * @returns {number[]}  the numbers it had read
   */
  function stale(numbers) {
    const marked = numbers.filter((n) => known.has(n));
    for (const n of marked) known.get(n).stale = true;
    return marked;
  }

  /** Reads the pull requests of the sessions listed that are due, in calls of 50. */
  async function refresh(sessions) {
    if (!github?.pullStatuses) return;
    const numbers = [...new Set(sessions.map((s) => prNumberOf(s.prUrl, repo)).filter(Boolean))].filter(due);
    for (let i = 0; i < numbers.length; i += MAX_PER_CALL) {
      const batch = numbers.slice(i, i + MAX_PER_CALL);
      const from = now();
      const found = await github.pullStatuses(batch);
      for (const raw of found) known.set(raw.number, { at: now(), pr: describePr(raw) });
      for (const number of batch) {
        // One GitHub no longer has is not asked again every refresh: it waits like a missing one.
        if (known.get(number)?.stale) known.get(number).stale = false;
        if (known.get(number)?.at >= from) missing.delete(number);
        else missing.set(number, now());
      }
      console.log('prChips: read', { asked: batch.length, found: found.length, ms: now() - from });
    }
  }

  /** @returns {ReturnType<typeof describePr>|null} */
  function view(prUrl) {
    const number = prNumberOf(prUrl, repo);
    return number ? known.get(number)?.pr ?? null : null;
  }

  return { refresh, view, stale };
}

/**
 * The chips of every project: one reader per project's repo, each with its own GitHub client. A session's pull request
 * URL names its repo, so each reader reads only its own project's sessions, and a webhook marks only the reader of the
 * project it is about.
 * `projects` may be a function, read on every use, so a repo an admin adds or removes while the console runs is followed.
 * @param {{projects: {name: string, repo: string, default?: boolean}[]|(() => {name: string, repo: string, default?: boolean}[]), githubFor: (project: object) => object|null,
 *          now?: () => number, webhooksFlowing?: () => boolean, fallbackMs?: number}} deps
 */
export function createProjectPrChips({ projects, githubFor, ...rest }) {
  const current = typeof projects === 'function' ? projects : () => projects;
  const kept = new Map();
  // One reader per project now listed; a removed repo's goes, and one added again starts afresh.
  function readersNow() {
    const list = current();
    const keys = new Set(list.map((p) => `${p.name}\n${p.repo}`));
    for (const key of kept.keys()) if (!keys.has(key)) kept.delete(key);
    return list.map((project) => {
      const key = `${project.name}\n${project.repo}`;
      if (!kept.has(key)) kept.set(key, { project, chips: createPrChips({ github: githubFor(project), repo: project.repo, ...rest }) });
      return kept.get(key);
    });
  }
  const defaultName = () => { const list = current(); return list.find((p) => p.default)?.name ?? list[0]?.name; };
  return {
    // One project's GitHub failing leaves its chips as they were, and the others are still read.
    async refresh(sessions) {
      for (const { project, chips } of readersNow()) {
        try {
          await chips.refresh(sessions);
        } catch (err) {
          console.warn('prChips: a project\'s pull requests not read', { project: project.name, message: String(err?.message ?? err).split('\n')[0] });
        }
      }
    },
    view(prUrl) {
      for (const { chips } of readersNow()) {
        const pr = chips.view(prUrl);
        if (pr) return pr;
      }
      return null;
    },
    /** @param {string|null} [project]  another project's name; none for the default project's */
    stale(numbers, project = null) {
      const name = project ?? defaultName();
      return readersNow().find((r) => r.project.name === name)?.chips.stale(numbers) ?? [];
    },
  };
}
