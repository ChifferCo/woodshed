// The summary tier of a review session's run log (session/review.sh, POST /review-log?tier=summary): what everyone who can
// open the session reads, so it holds counts and fixed words only. As for a QA run's (qaSummary.mjs), the process that posts
// it holds the session's token and runs beside the pull request's code, so every line must be one the script writes, and the
// few that name something (the pull request's number, its base branch) must name this session's.

import { COUNT_LINES, escaped } from './qaSummary.mjs';
import { isKnownReason } from '../shared/codeReview/failureReason.mjs';

const AGENT = '(?:Claude Code|Codex|Grok Build|OpenCode)';
const NAMES = `${AGENT}(?:(?:, | and )${AGENT})*`;
const AGENT_STEP = '(?:Grok Build|OpenCode|Codex)';

const HEADINGS = /^## (?:steps|review|verdict)$/;
const VERDICT = /^Verdict: (?:APPROVE|REQUEST_CHANGES|COMMENT|none|not yet)$/;

/**
 * @param {string} text  the summary a review session posted
 * @param {{number: number, base: string}} pull  what the session was started on
 * @returns {string|null}  null when every line is one a summary has, else why it is not
 */
export function reviewSummaryProblem(text, { number, base }) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const ref = escaped(base);
  const heading = new RegExp(`^Review of pull request #${Number(number)} against ${ref}, session [0-9a-f]{8}$`);
  const steps = [
    new RegExp(`^Review of pull request #${Number(number)} against ${ref}$`),
    new RegExp(`^Could not fetch ${ref}$`),
    /^The pull request carries a \.review folder of its own: it is removed, and none of it is read$/,
    /^Earlier comments' writers not read, so a fixed thread is resolved only when both reviewers list it$/,
    /^Could not write the review prompt, so there is no review$/,
    /^Reviewing the diff$/,
    new RegExp(`^Reviewing the diff with ${NAMES}$`),
    new RegExp(`^Waiting for ${NAMES} to finish$`),
    new RegExp(`^${AGENT_STEP} (?:reviews on the author's own sign-in, which the console adds to its calls|reviews on the author's ChatGPT login, which the console adds to its calls|reviews on a key the console adds to its calls \\(the author's or the team's\\))$`),
    /^(?:Grok Build|OpenCode|Codex) ended \(exit=\d{1,3}\)$/,
    new RegExp(`^${AGENT_STEP} took longer than \\d{1,4} minutes and was stopped$`),
    new RegExp(`^Could not write ${AGENT_STEP}'s review prompt$`),
    /^Could not start the relay to the console, so Codex does not review$/,
    /^OpenCode has no provider to review on, so it does not review$/,
    /^OpenCode reviews on the author's own (?:anthropic|openai) key, which the console adds to its calls$/,
    /^The reviewer wrote no verdict, so nothing is submitted$/,
  ];
  if (!lines.length || !heading.test(lines[0])) return 'its first line is not the run\'s heading';
  for (let i = 1; i < lines.length; i += 1) {
    const step = /^\[review \d\d:\d\d:\d\d\] (.*)$/.exec(lines[i]);
    const said = step && new RegExp(`^${AGENT} wrote no verdict: (.+)$`).exec(step[1]);
    const fine = step ? steps.some((re) => re.test(step[1])) || !!(said && isKnownReason(said[1]))
      : HEADINGS.test(lines[i]) || VERDICT.test(lines[i]) || /^Started; its outcome is not known yet\.$/.test(lines[i]) || COUNT_LINES.some((re) => re.test(lines[i]));
    if (!fine) return `line ${i + 1} is not a line a summary has`;
  }
  return null;
}
