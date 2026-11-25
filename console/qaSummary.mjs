// The summary tier of a QA run's log (session/qa.sh, POST /qa-log?tier=summary): what everyone who can open the QA session
// reads, so it holds counts and fixed words only. The process that posts it runs the pull request's code and holds the
// session's token, so the console does not trust what it sends: every line must be one the run's own script writes
// (shared/qa/runLog.mjs `summarize` with `text: false`, and qa.sh's steps), and the few that name something (the pull
// request's number, its base branch) must name this session's. Anything else is refused whole. The full log is not
// checked here: it is read only by an admin and whoever started the run.

// The result subtypes claude writes (shared/qa/runLog.mjs): the one value in a summary that comes from the run's own files.
const SUBTYPES = ['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries'];
const ENDED = ['ran out of turns before it finished', 'hit an error while it ran', 'ran out of its budget', 'ended in an error', 'finished'];
const CATEGORY = '(?:timeout|connection refused|not found|permission denied|server error|other)';

// Lines with nothing in them that varies but a count.
export const COUNT_LINES = [
  /^$/,
  /^Did not run\.$/,
  /^Started; its outcome is not known yet\.$/,
  /^No report\.md was written\.$/,
  /^The planner found nothing to test \(its explanation is in the full log\)\.$/,
  new RegExp(`^Ended: (?:${ENDED.join('|')}) \\((?:${SUBTYPES.join('|')}|unknown)(?:, is_error)?\\)$`),
  /^Ended: no result from claude, so it was stopped or crashed before it finished\.$/,
  /^Ran: \d{1,9} turns, \d{1,9} tool calls(?:, \d{1,9} s)?(?:, \$\d{1,6}\.\d\d)?$/,
  /^Permission denied: \d{1,6} calls?$/,
  new RegExp(`^Tool errors: \\d{1,6} \\(\\d{1,6} ${CATEGORY}(?:, \\d{1,6} ${CATEGORY})*\\)$`),
  /^Said: \d{1,6} messages?$/,
  /^Other output: \d{1,6} lines?$/,
];
const LINES = [/^## (?:steps|plan|test)$/, ...COUNT_LINES];

export const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} text  the summary a QA session posted
 * @param {{number: number, base: string}} pull  what the session was started on
 * @returns {string|null}  null when every line is one a summary has, else why it is not
 */
export function summaryProblem(text, { number, base }) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const ref = escaped(base);
  const heading = new RegExp(`^QA of pull request #${Number(number)} against ${ref}, session [0-9a-f]{8}$`);
  // The steps the script says as it goes, each with its time.
  const steps = [
    new RegExp(`^QA of pull request #${Number(number)} against ${ref}$`),
    /^QA notes present$/,
    /^QA notes: \.woodshed\/qa\.md$/,
    new RegExp(`^No QA notes on ${ref}$`),
    new RegExp(`^Could not fetch ${ref}: the planner's diff will fail$`),
    /^Planning the tests$/,
    /^No test plan$/,
    /^Starting the app$/,
    /^The project file names no app to test$/,
    /^The app did not start; its log is on the App log tab$/,
    /^Running the tests at http:\/\/localhost:\d{1,5}, recording the browser$/,
    /^Test pass started; if the run is stopped now, its outcome is not known$/,
    /^The browser did not close in \d{1,4}s, its video may be cut short$/,
    /^Video sent to the console \(\d{1,6} KB, status: \d{3}\)$/,
    /^Video not sent, (?:past \d{1,3}|over \d{1,4} MB \(\d{1,12} bytes\))$/,
    /^Still sent to the console \(status: \d{3}\)$/,
    /^No still sent: (?:Playwright's ffmpeg is not in this image|ffmpeg made none)$/,
  ];
  if (!lines.length || !heading.test(lines[0])) return 'its first line is not the run\'s heading';
  for (let i = 1; i < lines.length; i += 1) {
    const step = /^\[qa \d\d:\d\d:\d\d\] (.*)$/.exec(lines[i]);
    const fine = step ? steps.some((re) => re.test(step[1])) : LINES.some((re) => re.test(lines[i]));
    if (!fine) return `line ${i + 1} is not a line a summary has`;
  }
  return null;
}
