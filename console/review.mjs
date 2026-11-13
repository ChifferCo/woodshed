// A session's Review tab: what its branch changes against the repository's default branch, read from GitHub's
// compare API. The shed reads the worktree instead, so it also sees uncommitted work and writes an analysis
// with claude; a Woodshed session's worktree is in its container, so this shows what the session has pushed.

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_PATCH_LINES = 400;
const CACHE_MS = 30_000;
const CACHE_ENTRIES = 50;

/**
 * @param {object} compare  GitHub's answer for `compare/<base>...<branch>`
 * @param {{base: string, branch: string}} names
 * @returns {{base: string, branch: string, head: string|null, aheadBy: number, behindBy: number, additions: number,
 *   deletions: number, url: string|null, files: {path: string, previousPath: string|null, status: string,
 *   additions: number, deletions: number, patch: string|null, truncated: boolean}[]}}
 *   `patch` is null for a binary or very large file, which GitHub sends without one
 */
export function shapeReview(compare, { base, branch }) {
  const files = (compare?.files ?? []).map((f) => {
    const lines = typeof f.patch === 'string' ? f.patch.split('\n') : null;
    return {
      path: String(f.filename ?? ''),
      previousPath: f.previous_filename ?? null,
      status: String(f.status ?? 'modified'),
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      patch: lines ? lines.slice(0, MAX_PATCH_LINES).join('\n') : null,
      truncated: Boolean(lines && lines.length > MAX_PATCH_LINES),
    };
  });
  const commits = compare?.commits ?? [];
  return {
    base,
    branch,
    head: commits.at(-1)?.sha?.slice(0, 10) ?? null,
    aheadBy: Number(compare?.ahead_by) || 0,
    behindBy: Number(compare?.behind_by) || 0,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    url: compare?.html_url ?? null,
    files,
  };
}

/**
 * @param {{github: {defaultBranch: () => Promise<string>, compare: (base: string, head: string) => Promise<object>},
 *          now?: () => number}} deps
 * @returns {(session: {branch?: string|null, head?: string|null}) => Promise<ReturnType<typeof shapeReview>>}
 *   throws with `shown` set when the answer is the session's state rather than a failure
 */
export function createReviewSource({ github, now = Date.now }) {
  const cache = new Map();
  return async function reviewFor({ branch, head }) {
    if (!branch) throw Object.assign(new Error('this session has no branch yet'), { shown: true });
    if (!BRANCH_RE.test(branch)) throw Object.assign(new Error('the branch name is not one the console reads'), { shown: true });
    const key = `${branch}@${head ?? ''}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.review;
    const base = await github.defaultBranch();
    let compare;
    try {
      compare = await github.compare(base, branch);
    } catch (err) {
      if (!/HTTP 404/.test(`${err?.stderr ?? ''}${err?.message ?? ''}`)) throw err;
      throw Object.assign(new Error(`GitHub has no ${branch} yet: the session pushes it when it commits, and when it stops`), { shown: true });
    }
    const review = shapeReview(compare, { base, branch });
    cache.set(key, { at: now(), review });
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    console.log('review: read from GitHub', { branch, files: review.files.length, aheadBy: review.aheadBy });
    return review;
  };
}
