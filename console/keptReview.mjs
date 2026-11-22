// A repo's review turned on in the console's own keeping, with no commit to the repo: `woodshed review enable` and
// `disable` (cli/review.mjs), through POST /api/kept-review (reviewReadiness.mjs). Its pull requests are then reviewed in
// a Woodshed session (pullRequests.review.runner: woodshed) as if its project file said so, from the moment it is kept:
// nothing waits for a pull request to merge.
//
// The project file the console reads for the repo wins (projectFile.mjs: its default branch's, else the installation's
// for a repo with none): one whose pullRequests.review names a review, on any runner, is the review, and this one counts
// only where the file names none, or where there is no file at all (withKeptReview, used by installation.mjs's gatesOf,
// which the fleet's review, QA and Slack gates all read). It holds the review alone: QA, suites, mergeRisk and runsOn
// stay the file's.
//
// A program that embeds the console keeps it in its own store through the `reviewKeeping` hook (console/README.md,
// "Embedding the console"), `{get(repo), set(repo, value, {by})}`, asked again after a minute; a console of its own keeps
// it in its state, under `keptReviews`, by repo in lower case.

export const KEPT_HEADING = '## Woodshed review';
export const KEPT_RERUN = '[woodshed-review]';
// A program's answer is kept this long: the fleet reads the gates on every pull request change.
const KEEP_MS = 60_000;
const RERUN_MOST = 100;
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);

/** @returns {boolean}  a tag a commit's message carries to be reviewed: one line of text, or null for every commit */
export function validRerun(rerun) {
  return rerun === null || (typeof rerun === 'string' && rerun.trim() !== '' && rerun.length <= RERUN_MOST && !/[\r\n]/.test(rerun));
}

/**
 * What is kept, as the console reads it, from the state or a program's answer.
 * @returns {{review: object, by: string|null, at: string|null}|null}  `review` in the parsed project file's shape
 *   (shared/project.mjs); null for nothing kept, or something that does not read as a kept review
 */
function normal(entry, repo) {
  if (entry === null || entry === undefined) return null;
  const rerun = entry?.review?.rerun;
  if (typeof entry !== 'object' || typeof entry.review !== 'object' || !validRerun(rerun === undefined ? KEPT_RERUN : rerun)) {
    console.warn('keptReview: not read as a kept review, taken as none', { repo });
    return null;
  }
  return {
    review: { author: null, heading: KEPT_HEADING, workflow: null, rerun: rerun === undefined ? KEPT_RERUN : rerun, commentAuthor: null, runner: 'woodshed' },
    by: typeof entry.by === 'string' ? entry.by : null,
    at: typeof entry.at === 'string' ? entry.at : null,
  };
}

/**
 * The gates the fleet runs a repo's pull requests by: its project file's, with the kept review where the file names
 * none.
 * @param {object|null} gates  the project file's `pullRequests`, null for a file with none or no file
 * @param {{review: object}|null} kept
 */
export function withKeptReview(gates, kept) {
  if (!kept || gates?.review) return gates;
  return { ...(gates ?? { suites: [], qa: null, mergeRisk: null }), review: kept.review };
}

/**
 * What the fleet's gates are read with (installation.mjs): the project file's, and the kept review where it names none.
 * The kept one is not asked for while the file names a review.
 * @param {{pullRequestsOf: (name: string) => Promise<object|null>, keptOf: (name: string) => Promise<object|null>}} deps
 * @returns {(name: string) => Promise<object|null>}
 */
export function gatesWithKeptReview({ pullRequestsOf, keptOf }) {
  return async (name) => {
    const gates = await pullRequestsOf(name);
    return withKeptReview(gates, gates?.review ? null : await keptOf(name));
  };
}

/**
 * @param {{store: {state: object, save: () => void}, host?: {get: (repo: string) => Promise<object|null>,
 *          set: (repo: string, value: object|null, who: {by: string|null}) => Promise<void>}|null, now?: () => number}} deps
 */
export function createKeptReviews({ store, host = null, now = Date.now }) {
  if (host && (typeof host.get !== 'function' || typeof host.set !== 'function')) throw new Error('reviewKeeping needs get and set');
  const held = new Map();
  const keyOf = (repo) => String(repo).toLowerCase();

  return {
    /** Where it is kept: the embedding program's store, or the console's state. */
    where: host ? 'program' : 'console',
    /**
     * @param {string} repo  owner/name
     * @returns {Promise<{review: object, by: string|null, at: string|null}|null>}
     * @throws {Error}  when the program's store did not answer and nothing was read from it before
     */
    async of(repo) {
      if (!repo) return null;
      const key = keyOf(repo);
      if (!host) return normal(store.state.keptReviews?.[key], repo);
      const last = held.get(key);
      if (last && now() - last.at < KEEP_MS) return last.value;
      try {
        const value = normal(await host.get(repo), repo);
        held.set(key, { at: now(), value });
        return value;
      } catch (err) {
        console.warn('keptReview: the program\'s store not read', { repo, kept: last ? 'last answer' : 'none', message: firstLine(err) });
        if (last) return last.value;
        throw new Error(`whether ${repo}'s review is kept on could not be read: ${firstLine(err)}`);
      }
    },
    /**
     * Turns it on, with the tag a commit carries to be reviewed (null: every commit), or off with `on: false`.
     * @returns {Promise<{review: object, by: string|null, at: string|null}|null>}  what is kept now
     */
    async set(repo, { on, rerun = KEPT_RERUN, by = null }) {
      if (on && !validRerun(rerun)) throw new Error(`a review tag is one line of at most ${RERUN_MOST} characters`);
      const key = keyOf(repo);
      const value = on ? { review: { runner: 'woodshed', rerun }, by, at: new Date(now()).toISOString() } : null;
      if (host) {
        await host.set(repo, value, { by });
        held.set(key, { at: now(), value: normal(value, repo) });
      } else {
        const { [key]: _was, ...rest } = store.state.keptReviews ?? {};
        store.state.keptReviews = value ? { ...rest, [key]: value } : rest;
        store.save();
      }
      console.log(on ? 'keptReview: turned on' : 'keptReview: turned off', { repo, by, ...(on ? { rerun } : {}), where: host ? 'program' : 'console' });
      return normal(value, repo);
    },
  };
}
