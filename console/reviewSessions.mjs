// A review session's report, as session/review.sh sends it to the console (POST /review-report): the verdict the
// console submits as a formal review, and the merge-risk the console posts as the Merge risk check. The session has
// already read these from its files with shared/codeReview/codeReview.mjs; this only validates what arrived.
import { MAX_REPORT_CHARS } from './qaSessions.mjs';

const CONCLUSIONS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const TIERS = new Set(['Low', 'Medium', 'High']);
// As many as the Actions review would post in one run: a few precise ones are the aim.
const MAX_INLINE_COMMENTS = 30;
const MAX_INLINE_CHARS = 4000;
const MAX_RESOLVED = 100;

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
 * A report with `conclusion: null` says the session wrote no verdict: the console submits nothing and stops it.
 * @returns {{conclusion: string|null, summary: string, comment: string,
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
  return {
    conclusion: body.conclusion,
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
