// Every repo's review, by default: a repo whose project file names no review (pullRequests.review), or that has no
// project file at all, is reviewed in a Woodshed session (runner: woodshed) on a commit whose message has
// [woodshed-review], with nothing to commit or turn on. The project file the console reads for the repo wins
// (projectFile.mjs: its default branch's, else the installation's for a repo with none): one that names a review, on any
// runner, is the review, and it is where a team changes the tag or reviews every commit (`woodshed review enable`).
//
// It is the review alone: QA, suites, mergeRisk and runsOn stay the file's. installation.mjs's gatesOf adds it, which the
// fleet's review, QA and Slack gates all read. Sessions are told its tag (WOODSHED_REVIEW_TAG, fleet.mjs), since their
// checkout's file cannot say it, so the pull requests they open carry it. Someone who wants no review of their own pull
// requests chooses none on My settings (reviewAgents.mjs), which also lets their Slack posts go out without one.

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
