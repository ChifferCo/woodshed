// What a session's pull request waits for before the console posts it (prAnnouncer.mjs), read against the repo's
// project file's `pullRequests` (docs/reference.md, "The project file"): its review's verdict, its suites' jobs, and whether a
// suite's workflow runs at all for the files it touched. Pure functions over what GitHub answered.

const PASSING = new Set(['success', 'neutral', 'skipped']);

/**
 * The review posts its verdict as a review by its `author`, whose body starts with its `heading`.
 * @param {object[]} reviews  a pull request's, oldest first
 * @param {{author: string, heading: string}|null} review  the project file's `pullRequests.review`
 * @returns {object|null}  the latest such review: its `state` is the verdict, such as `APPROVED` or `CHANGES_REQUESTED`
 */
export function reviewVerdict(reviews, review) {
  if (!review) return null;
  return (reviews ?? []).filter((r) => r.user?.login === review.author && String(r.body ?? '').startsWith(review.heading)).at(-1) ?? null;
}

/**
 * The review's own PR comment is folded under a `<summary>` of its heading's words: `## Code Review` is folded under
 * `<summary>Code Review</summary>`.
 * @returns {string}
 */
export function reviewSummaryOf(review) {
  return `<summary>${review.heading.replace(/^#+\s*/, '').trim()}</summary>`;
}

/** @returns {object[]}  the suite's jobs among a commit's check runs: those whose name starts with its `jobs` */
export function suiteJobs(checkRuns, suite) {
  return (checkRuns ?? []).filter((r) => String(r.name ?? '').startsWith(suite.jobs));
}

/**
 * The workflow itself passes with every job skipped, so only jobs that ran and passed count as green.
 * @param {object[]} checkRuns  a commit's latest run of each check
 * @param {{jobs: string}} suite  one of the project file's `pullRequests.suites`
 * @returns {'none'|'running'|'green'|'failed'|'skipped'}  `none` before any job shows, which may yet happen
 */
export function suiteOutcome(checkRuns, suite) {
  const jobs = suiteJobs(checkRuns, suite);
  // A skipped matrix is never expanded: its one check run keeps the name's whole expression, the name quoted in it.
  const skippedMatrix = (checkRuns ?? []).some((r) => String(r.name ?? '').includes(`'${suite.jobs}`)
    && r.status === 'completed' && r.conclusion === 'skipped');
  if (!jobs.length) return skippedMatrix ? 'skipped' : 'none';
  if (jobs.some((r) => r.status !== 'completed')) return 'running';
  if (jobs.every((r) => r.conclusion === 'success')) return 'green';
  if (jobs.some((r) => !PASSING.has(r.conclusion))) return 'failed';
  return 'skipped';
}

/**
 * With no gates in the project file, a pull request is posted once none of its checks is running or failed.
 * @returns {boolean}
 */
export function checksPass(checkRuns) {
  return (checkRuns ?? []).every((r) => r.status === 'completed' && PASSING.has(r.conclusion));
}

// A GitHub Actions path filter as a regular expression: `**` crosses folders, `*` and `?` do not.
function filterPattern(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// The last pattern a file matches decides, and a `!` pattern takes it back, as GitHub applies them.
function matchesFilter(patterns, file) {
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (filterPattern(p.slice(1)).test(file)) hit = false;
    } else if (filterPattern(p).test(file)) hit = true;
  }
  return hit;
}

/**
 * @param {string[]|null} files  a pull request's file paths; null when there were more than were read
 * @param {{pathsIgnore: string[]|null, paths: string[]|null}} filters  the workflow's `on.pull_request` ones
 * @returns {boolean}  true when the workflow never runs for these files
 */
export function suiteNeverRuns(files, { pathsIgnore, paths }) {
  if (!files?.length) return false;
  if (pathsIgnore?.length && files.every((f) => matchesFilter(pathsIgnore, f))) return true;
  return Boolean(paths?.length) && !files.some((f) => matchesFilter(paths, f));
}

/**
 * What a commit's subject carries to run the review and every suite again, such as `[review][e2e]`.
 * @returns {string}  empty when none of them names a tag
 */
export function rerunTags(gates) {
  return [gates?.review?.rerun, ...(gates?.suites ?? []).map((s) => s.rerun)].filter(Boolean).join('');
}
