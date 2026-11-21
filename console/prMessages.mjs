// What the pull request announcer (prAnnouncer.mjs) tells a session, and writes on GitHub when a pull request gives
// up, in the console's words: only numbers, names and links GitHub gave, and the gates' names and re-run tags from the
// repo's project file (`pullRequests`).

import path from 'node:path';

import { rerunTags, suiteJobs } from './pullGates.mjs';

const JOBS_NAMED = 4;

// The console's own `Needs a human:` comment for a pull request that gave up. Its assignee already gets a message for
// it (gaveUp), so the fleet does not message them again when the comment comes back as a webhook.
export const GAVE_UP_TEXT = 'this pull request did not pass its review and checks in time';

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function pushWith(tags) {
  return tags ? `push a commit whose subject has ${tags}` : 'push a commit';
}

const NEEDS_HUMAN = 'post a PR comment that opens with `Needs a human:` and tags the person on the PR body\'s `Started by @…` line, then stop.';
// A My Woodshed session's owner is at its terminal, and its pull request goes to no Slack.
const ASK_OWNER = 'say so here, with what you found, and ask what to do, then wait for the answer.';
const stuck = (watch) => (watch ? ASK_OWNER : NEEDS_HUMAN);

/**
 * @param {{number: number, sha: string, review: object, gates: object, graceMinutes: number}} args
 * @returns {string}  the note an approval hands the session, before the post waits for it to read the review's notes
 */
export function approvalNotesFor({ number, sha, review, gates, graceMinutes }) {
  const tags = rerunTags(gates);
  const waitsFor = gates.suites.length ? 'the new review and suite' : 'the new review';
  return `The review verdict on PR #${number} at ${sha.slice(0, 7)} is APPROVE: ${review.html_url}. The pull request is posted to Slack in ${graceMinutes} minutes at the earliest, `
    + `${gates.qa ? `once ${gates.qa.check} has finished on it, ` : ''}and this session stops then. Before that, read the review's notes with \`gh pr view ${number} --comments\` and \`gh api repos/{owner}/{repo}/pulls/${number}/comments\`. `
    + `Fix what is real with a commit${tags ? ` whose subject has ${tags}` : ''} (the post then waits for ${waitsFor}), `
    + 'and answer what you decline in a PR comment with the reason. If there is nothing to act on, do nothing.';
}

/**
 * @param {{number: number, sha: string, review: object|null, suites: {name: string, notRun?: boolean}[], gates: object}} args
 *   `suites` each suite's outcome on the commit, all green; `notRun` for one whose path filters leave this change out
 * @returns {string}  what a My Woodshed session hears once its pull request passed its review and suites on a commit
 */
export function passedNotesFor({ number, sha, review, suites = [], gates }) {
  const short = sha.slice(0, 7);
  const names = (list) => list.map((s) => s.name).join(', ');
  const ran = suites.filter((s) => !s.notRun);
  const notRun = suites.filter((s) => s.notRun);
  const passed = [
    gates.review && review ? `the review verdict is APPROVE (${review.html_url})` : null,
    ran.length ? `${names(ran)} passed` : null,
    notRun.length ? `${names(notRun)} does not run for the files this PR changes` : null,
  ].filter(Boolean).join(', and ');
  const notes = gates.review
    ? 'The PR is done: do not change the code, commit or push for the review\'s notes, even optional ones, since a new commit starts its review and suites again. '
      + `Read them with \`gh pr view ${number} --comments\` and \`gh api repos/{owner}/{repo}/pulls/${number}/comments\`, `
      + 'and say here, one line each, any you think worth a follow-up: its owner reads this terminal and decides. Then '
    : '';
  const gatesSaid = gates.review ? 'its review and suites' : 'its suites';
  return `PR #${number} at ${short} passed ${gatesSaid}: ${passed}. ${notes}${notes ? 'run' : 'Run'} \`gh pr checks ${number}\`: wait for any other check still pending `
    + 'and handle a failed one as the rules say for CI. Once none is pending, say in one line what passed, name each check that still fails '
    + 'and why it is not your change\'s, and stop.';
}

function suiteFailed({ number, short, suite, runs, watch }) {
  const failed = suiteJobs(runs, suite).filter((r) => r.conclusion !== 'success').slice(0, JOBS_NAMED);
  return `The ${suite.name} failed on PR #${number} at ${short}: ${failed.map((r) => `${r.name} ${r.html_url}`).join(', ')}. `
    + `Find out why. Fix it if the change caused it, then ${pushWith(suite.rerun)}. `
    + `If CI caused it or you cannot fix it, ${stuck(watch)}`;
}

function suiteSkipped({ number, short, suite, watch }) {
  const { name, rerun } = suite;
  const emptyCommit = `git commit --allow-empty -m "${rerun ? `${rerun} ` : ''}Run the ${name}"`;
  const giveUp = watch
    ? `if that is refused, or the job is cancelled again, do not keep pushing: ${ASK_OWNER} `
    : 'if that is refused, or the job is cancelled again, do not keep pushing: post a PR comment that opens with `Needs a human:`, '
      + 'names the job and links its run, and tags the person on the PR body\'s `Started by @…` line (and comment on the issue too if the PR closes one), '
      + 'so it does not get lost, then stop. ';
  return `The ${name} was skipped on PR #${number} at ${short}, so the PR ${watch ? 'has not passed it' : 'cannot be posted to Slack'}. It does not run on a pull request `
    + `that is a draft${rerun ? `, or for a last commit whose subject does not have ${rerun}` : ''}. Before you push anything, run `
    + `\`gh run list --workflow=${path.basename(suite.workflow)} --branch <branch>\` and \`gh run view <id> --json jobs\`: if ${rerun ? 'the tag and ' : ''}the draft state `
    + `${rerun ? 'are' : 'is'} fine and a job such as the install job was cancelled or timed out, that is CI, not your commit. Try \`gh run rerun --failed <id>\` once; `
    + `${giveUp}Otherwise push one commit such as \`${emptyCommit}\`, and no more than one.`;
}

/**
 * @param {{number: number, sha: string, review: object|null, broken: {suite: object, outcome: string}[], runs: object[],
 *          gates: object, watch?: boolean}} args  `review` is a verdict asking for changes, to hand over; `broken` the suites that
 *   failed or were skipped, to hand over; `watch` for a My Woodshed session, which asks its owner rather than GitHub
 * @returns {string}  what the session hears
 */
export function feedbackFor({ number, sha, review, broken, runs, gates, watch = false }) {
  const short = sha.slice(0, 7);
  const parts = [
    review
      ? `The review verdict on PR #${number} at ${short} asks for changes: ${review.html_url}. Read it with \`gh pr view ${number} --comments\`, `
        + `fix the blocking findings, and ${pushWith(rerunTags(gates))}. If you cannot, ${stuck(watch)}`
      : null,
    ...broken.map(({ suite, outcome }) => (outcome === 'failed' ? suiteFailed({ number, short, suite, runs, watch }) : suiteSkipped({ number, short, suite, watch }))),
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * @param {{starter: string|null, pull: object, review: object|null, suites: {name: string, outcome: string}[], gates: object|null}} args
 * @returns {string}  the `Needs a human:` comment for a pull request that gave up
 */
export function gaveUpComment({ starter, pull, review, suites, gates }) {
  const state = gates
    ? [`Review verdict: ${gates.review ? review?.state ?? 'none' : 'not configured'}.`, ...suites.map((s) => `${capital(s.name)}: ${s.outcome}.`)].join(' ')
    : `It is ${pull.draft ? 'still a draft' : 'out of draft, and its checks have not all passed'}.`;
  return `Needs a human: ${starter ? `@${starter} ` : ''}${GAVE_UP_TEXT}, so it was not posted to Slack. ${state} `
    + `Look at the runs on ${pull.head.sha.slice(0, 7)} (a cancelled job can be re-run from the Actions page), then push a fix or ask for another run.`;
}
