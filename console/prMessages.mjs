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

function suiteFailed({ number, short, suite, runs }) {
  const failed = suiteJobs(runs, suite).filter((r) => r.conclusion !== 'success').slice(0, JOBS_NAMED);
  return `The ${suite.name} failed on PR #${number} at ${short}: ${failed.map((r) => `${r.name} ${r.html_url}`).join(', ')}. `
    + `Find out why. Fix it if the change caused it, then ${pushWith(suite.rerun)}. `
    + `If CI caused it or you cannot fix it, ${NEEDS_HUMAN}`;
}

function suiteSkipped({ number, short, suite }) {
  const { name, rerun } = suite;
  const emptyCommit = `git commit --allow-empty -m "${rerun ? `${rerun} ` : ''}Run the ${name}"`;
  return `The ${name} was skipped on PR #${number} at ${short}, so the PR cannot be posted to Slack. It does not run on a pull request `
    + `that is a draft${rerun ? `, or for a last commit whose subject does not have ${rerun}` : ''}. Before you push anything, run `
    + `\`gh run list --workflow=${path.basename(suite.workflow)} --branch <branch>\` and \`gh run view <id> --json jobs\`: if ${rerun ? 'the tag and ' : ''}the draft state `
    + `${rerun ? 'are' : 'is'} fine and a job such as the install job was cancelled or timed out, that is CI, not your commit. Try \`gh run rerun --failed <id>\` once; `
    + 'if that is refused, or the job is cancelled again, do not keep pushing: post a PR comment that opens with `Needs a human:`, '
    + 'names the job and links its run, and tags the person on the PR body\'s `Started by @…` line (and comment on the issue too if the PR closes one), '
    + `so it does not get lost, then stop. Otherwise push one commit such as \`${emptyCommit}\`, and no more than one.`;
}

/**
 * @param {{number: number, sha: string, review: object|null, broken: {suite: object, outcome: string}[], runs: object[],
 *          gates: object}} args  `review` is a verdict asking for changes, to hand over; `broken` the suites that
 *   failed or were skipped, to hand over
 * @returns {string}  what the session hears
 */
export function feedbackFor({ number, sha, review, broken, runs, gates }) {
  const short = sha.slice(0, 7);
  const parts = [
    review
      ? `The review verdict on PR #${number} at ${short} asks for changes: ${review.html_url}. Read it with \`gh pr view ${number} --comments\`, `
        + `fix the blocking findings, and ${pushWith(rerunTags(gates))}. If you cannot, ${NEEDS_HUMAN}`
      : null,
    ...broken.map(({ suite, outcome }) => (outcome === 'failed' ? suiteFailed({ number, short, suite, runs }) : suiteSkipped({ number, short, suite }))),
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
