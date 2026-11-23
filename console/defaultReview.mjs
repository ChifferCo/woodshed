// Every repo's review, by default: a repo whose project file names no review (pullRequests.review), or that has no
// project file at all, is reviewed in a Woodshed session (runner: woodshed) on a commit whose message has
// [woodshed-review], with nothing to commit or turn on. The project file the console reads for the repo wins
// (projectFile.mjs: its default branch's, else the installation's for a repo with none): one that names a review, on any
// runner, is the review, and it is where a team changes the tag or reviews every commit (`woodshed review enable`).
//
// It only starts reviews: the fleet's `reviewGates` (installation.mjs) add it for the review on the tag and for the tag
// sessions are told (WOODSHED_REVIEW_TAG, fleet.mjs), since their checkout's file cannot say it, so the pull requests
// they open carry it. What a pull request waits for, its Slack post and QA, stays the file's alone: a repo whose file
// names no review posts once green, as before, whatever a default review said. `woodshed review start` (fleet.mjs,
// reviewOnDemand) runs by it too. QA, suites, mergeRisk and runsOn are the file's.

export const DEFAULT_RERUN = '[woodshed-review]';

/** The default review, in the parsed project file's shape (shared/project.mjs). */
export const DEFAULT_REVIEW = Object.freeze({
  author: null, heading: '## Woodshed review', workflow: null, rerun: DEFAULT_RERUN, commentAuthor: null, runner: 'woodshed',
});

/**
 * The gates the fleet runs a repo's pull requests by: its project file's, with the default review where it names none.
 * @param {object|null} gates  the project file's `pullRequests`, null for a file with none or no file
 * @returns {object}
 */
export function withDefaultReview(gates) {
  if (gates?.review) return gates;
  return { ...(gates ?? { suites: [], qa: null, mergeRisk: null }), review: DEFAULT_REVIEW };
}
