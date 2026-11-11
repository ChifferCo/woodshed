// QA in a Woodshed session, for a project whose file says `pullRequests.qa.runner: woodshed`: the QA label on a pull
// request starts a session on its branch (fleet.handleQaLabel), which runs session/qa.sh with the same prompts and
// verdict as the QA actions (shared/qa/qa.mjs), then sends its report to POST /qa-report (sessionApi.mjs). The console
// writes the report into the pull request's QA comment and stops the session (fleet.qaFinished).

// GitHub caps a comment at 65536 characters; the report is cut to leave room for the heading and the footer.
export const MAX_REPORT_CHARS = 60_000;
const CONCLUSIONS = new Set(['success', 'failure', 'neutral']);

/**
 * @param {{heading: string, sessionUrl: string|null}} args
 * @returns {string}  the QA comment while the session runs
 */
export function runningComment({ heading, sessionUrl }) {
  const where = sessionUrl ? `[a Woodshed session](${sessionUrl})` : 'a Woodshed session';
  return `${heading}\n\n⏳ **Running** in ${where}: planning the tests, then running them in a browser.\n`;
}

/**
 * The QA comment once the run is over, as the QA actions write it: the verdict's line, then the report when it has
 * test cases.
 * @param {{heading: string, verdict: {status: string, total: number}, report: string, sessionUrl: string|null}} args
 * @returns {string}
 */
export function finishedComment({ heading, verdict, report, sessionUrl }) {
  const body = verdict.total > 0 && report.trim() ? `${report.trim()}\n\n` : '';
  const footer = sessionUrl ? `---\n\nRun in [a Woodshed session](${sessionUrl}), whose terminal shows the run.\n` : '';
  return `${heading}\n\n${verdict.status}\n\n${body}${footer}`;
}

/**
 * @param {string} raw  the body session/qa.sh posts
 * @returns {{verdict: {conclusion: string, title: string, status: string, total: number}, report: string,
 *   sha: string, costUsd: number|null}}
 * @throws {Error}  saying what is wrong, for the 400 the session logs
 */
export function parseQaReport(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('body must be JSON');
  }
  const v = body?.verdict;
  if (!CONCLUSIONS.has(v?.conclusion)) throw new Error('verdict.conclusion must be success, failure or neutral');
  if (typeof v.title !== 'string' || typeof v.status !== 'string' || !Number.isInteger(v.total)) {
    throw new Error('verdict must have a title, a status and a total');
  }
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) throw new Error('sha must be a commit');
  const report = typeof body.report === 'string' ? body.report.slice(0, MAX_REPORT_CHARS) : '';
  const costUsd = Number.isFinite(body.costUsd) ? body.costUsd : null;
  return {
    verdict: { conclusion: v.conclusion, title: v.title.slice(0, 200), status: v.status.slice(0, 500), total: v.total },
    report, sha: body.sha, costUsd,
  };
}
