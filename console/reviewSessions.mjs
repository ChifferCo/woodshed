// A review session's report, as session/review.sh sends it to the console (POST /review-report): the verdict the
// console submits as a formal review, and the merge-risk the console posts as the Merge risk check. The session has
// already read these from its files with shared/codeReview/codeReview.mjs; this only validates what arrived.
import { MAX_REPORT_CHARS, SPINNER_HTML } from './qaSessions.mjs';

const CONCLUSIONS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const TIERS = new Set(['Low', 'Medium', 'High']);
// As many as the Actions review would post in one run: a few precise ones are the aim.
const MAX_INLINE_COMMENTS = 30;
const MAX_INLINE_CHARS = 4000;
const MAX_RESOLVED = 100;

// The legacy Claude heading also identifies Woodshed verdicts to the gate. Accept it alongside the new headings.
const CLAUDE_HEADING = '## Claude review';
const CODEX_HEADING = '## Codex review';
const BOTH_HEADING = '## Claude Code and Codex review';

export function reviewHeading(heading, agents) {
  if (heading !== CLAUDE_HEADING || !agents?.includes('codex')) return heading;
  return agents.includes('claude') ? BOTH_HEADING : CODEX_HEADING;
}

export function matchesReviewHeading(body, review) {
  if (body.startsWith(review.heading)) return true;
  return review.runner === 'woodshed' && review.heading === CLAUDE_HEADING
    && [CODEX_HEADING, BOTH_HEADING].some((heading) => body.startsWith(`${heading} — `));
}

// The inline comments the session wrote, each on a file and a line of the head; anything else is dropped.
function inlineCommentsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => typeof c?.path === 'string' && c.path && !c.path.startsWith('/') && !c.path.split('/').includes('..')
    && Number.isInteger(c.line) && c.line > 0 && typeof c.body === 'string' && c.body.trim())
    .slice(0, MAX_INLINE_COMMENTS)
    .map((c) => ({ path: c.path, line: c.line, body: c.body.slice(0, MAX_INLINE_CHARS) }));
}

// The ids of earlier inline comments the session found fixed: the console resolves only the review's own among them.
function resolvedOf(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_RESOLVED);
}

/**
 * @param {{sessionUrl: string|null, agents?: string[]}} args
 * @returns {string}  the review's comment while its session runs, replaced by the review's own comment when it ends
 */
export function reviewRunningComment({ sessionUrl, agents = ['claude'] }) {
  const where = sessionUrl ? `[a Woodshed session](${sessionUrl})` : 'a Woodshed session';
  const names = { claude: 'Claude Code', codex: 'Codex' };
  const who = agents.includes('codex') ? ` with ${agents.map((a) => names[a] ?? a).join(' and ')}` : '';
  return `**Reviewing**${who} in ${where}: the review and its merge risk follow here when it ends. ${SPINNER_HTML}\n`;
}

/**
 * @param {{reason: string, sessionUrl: string|null}} args
 * @returns {string}  the review's comment when its session ended without a review
 */
export function reviewEndedComment({ reason, sessionUrl }) {
  const where = sessionUrl ? ` ([session](${sessionUrl}))` : '';
  return `⚠️ **The review did not finish**${where}: ${reason}. A new commit starts another.\n`;
}

/**
 * @param {{conclusion: string, tier: string|null}} args
 * @returns {string}  the review's comment when it reported a verdict but wrote no comment of its own
 */
export function reviewDoneComment({ conclusion, tier }) {
  const verdict = { APPROVE: 'approved', REQUEST_CHANGES: 'changes requested', COMMENT: 'commented, no verdict' }[conclusion] ?? 'finished';
  return `**Review finished**: ${verdict}${tier ? `, merge risk ${tier}` : ''}. Details in the review.\n`;
}

/**
 * A report with `conclusion: null` says the session wrote no verdict: the console submits nothing and stops it.
 * @returns {{conclusion: string|null, agents?: string[], summary: string, comment: string,
 *   mergeRisk: {tier: string|null, reason: string, summary: string}, inlineComments: {path: string, line: number, body: string}[],
 *   resolved: number[], sha: string, costUsd: number|null}}
 */
export function parseReviewReport(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('body must be JSON');
  }
  if (body?.conclusion !== null && !CONCLUSIONS.has(body?.conclusion)) throw new Error('conclusion must be APPROVE, REQUEST_CHANGES, COMMENT or null');
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) throw new Error('sha must be a commit');
  const mr = body.mergeRisk ?? {};
  const agents = Array.isArray(body.agents) ? ['claude', 'codex'].filter((agent) => body.agents.includes(agent)) : [];
  return {
    conclusion: body.conclusion,
    ...(agents.length ? { agents } : {}),
    summary: String(body.summary ?? '').slice(0, MAX_REPORT_CHARS),
    comment: String(body.comment ?? '').slice(0, MAX_REPORT_CHARS),
    mergeRisk: {
      tier: TIERS.has(mr.tier) ? mr.tier : null,
      reason: String(mr.reason ?? '').slice(0, 200),
      summary: String(mr.summary ?? '').slice(0, 2000),
    },
    inlineComments: inlineCommentsOf(body.inlineComments),
    resolved: resolvedOf(body.resolved),
    sha: body.sha,
    costUsd: Number.isFinite(body.costUsd) ? body.costUsd : null,
  };
}
