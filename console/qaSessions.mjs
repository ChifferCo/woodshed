// QA in a Woodshed session, for a project whose file says `pullRequests.qa.runner: woodshed`: the QA label on a pull
// request starts a session on its branch (fleet.handleQaLabel), which runs session/qa.sh with the same prompts and
// verdict as the QA actions (shared/qa/qa.mjs), then sends its report to POST /qa-report (sessionApi.mjs). The console
// writes the report into the pull request's QA comment and stops the session (fleet.qaFinished). Before the report,
// the session sends the browser's video of each page the tests opened (POST /qa-video), which the console commits to a
// ref of the repo's own, never a branch (fleet.qaVideo), for the comment to link.

// GitHub caps a comment at 65536 characters; the report is cut to leave room for the heading and the footer.
export const MAX_REPORT_CHARS = 60_000;
const CONCLUSIONS = new Set(['success', 'failure', 'neutral']);
// A QA run's videos: the browser's recording of each page the tests opened, as Playwright writes them (WebM). GitHub
// takes a file of up to 100 MB; base64 makes one a third bigger on the way.
export const MAX_QA_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_QA_VIDEOS = 5;
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// The spinner Claude's GitHub Action shows while it works, so a running review or QA looks the same as one in Actions.
export const SPINNER_HTML = '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

/**
 * @param {{heading: string, sessionUrl: string|null}} args
 * @returns {string}  the QA comment while the session runs
 */
export function runningComment({ heading, sessionUrl }) {
  const where = sessionUrl ? `[a Woodshed session](${sessionUrl})` : 'a Woodshed session';
  return `${heading}\n\n**Running** in ${where}: planning the tests, then running them in a browser, which it records. ${SPINNER_HTML}\n`;
}

/** @returns {boolean}  whether the bytes are a WebM file, the only kind of video the session sends */
export function isWebm(buffer) {
  return buffer.length > WEBM_MAGIC.length && buffer.subarray(0, WEBM_MAGIC.length).equals(WEBM_MAGIC);
}

/**
 * Where a QA session's videos are kept: a ref of the repo that is not a branch, so clones never fetch it, one for each
 * run so that an older QA comment's links keep working.
 * @param {{id: string, number: number}} session
 */
export function qaVideoRef(session) {
  return `refs/woodshed-qa/${Number(session.number)}-${session.id}`;
}

/**
 * @param {{url: string, bytes: number}[]} videos
 * @returns {string}  the comment's line linking the recordings, empty with none
 */
export function videoLine(videos = []) {
  if (!videos.length) return '';
  const size = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  // Links download the file: GitHub plays a video only when it was attached by hand in the browser.
  const links = videos.length === 1
    ? `[download](${videos[0].url}) (${size(videos[0].bytes)})`
    : videos.map((v, i) => `[page ${i + 1}](${v.url}) (${size(v.bytes)})`).join(' · ');
  const what = videos.length === 1 ? 'the browser during the tests' : 'the browser during the tests, a video for each page it opened';
  return `🎥 **Recording** of ${what}, WebM, which any browser plays once downloaded: ${links}`;
}

/**
 * The QA comment once the run is over, as the QA actions write it: the verdict's line, then the report when it has
 * test cases, and a link to the browser's recording when the session sent one.
 * @param {{heading: string, verdict: {status: string, total: number}, report: string, sessionUrl: string|null,
 *   videos?: {url: string, bytes: number}[]}} args
 * @returns {string}
 */
export function finishedComment({ heading, verdict, report, sessionUrl, videos = [] }) {
  const body = verdict.total > 0 && report.trim() ? `${report.trim()}\n\n` : '';
  const video = videos.length ? `${videoLine(videos)}\n\n` : '';
  const footer = sessionUrl ? `---\n\nRun in [a Woodshed session](${sessionUrl}), whose terminal shows the run.\n` : '';
  return `${heading}\n\n${verdict.status}\n\n${video}${body}${footer}`;
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
