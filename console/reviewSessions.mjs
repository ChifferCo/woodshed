// A review session's report, as session/review.sh sends it to the console (POST /review-report): the verdict the
// console submits as a formal review, and the merge-risk the console posts as the Merge risk check. The session has
// already read these from its files with shared/codeReview/codeReview.mjs; this only validates what arrived.
import { MAX_REPORT_CHARS } from './qaSessions.mjs';

const CONCLUSIONS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const TIERS = new Set(['Low', 'Medium', 'High']);

/**
 * @returns {{conclusion: string, title: string, summary: string, comment: string,
 *   mergeRisk: {tier: string|null, reason: string, summary: string}, sha: string, costUsd: number|null}}
 */
export function parseReviewReport(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('body must be JSON');
  }
  if (!CONCLUSIONS.has(body?.conclusion)) throw new Error('conclusion must be APPROVE, REQUEST_CHANGES or COMMENT');
  if (typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) throw new Error('sha must be a commit');
  const mr = body.mergeRisk ?? {};
  return {
    conclusion: body.conclusion,
    title: String(body.title ?? '').slice(0, 200),
    summary: String(body.summary ?? '').slice(0, MAX_REPORT_CHARS),
    comment: String(body.comment ?? '').slice(0, MAX_REPORT_CHARS),
    mergeRisk: {
      tier: TIERS.has(mr.tier) ? mr.tier : null,
      reason: String(mr.reason ?? '').slice(0, 200),
      summary: String(mr.summary ?? '').slice(0, 2000),
    },
    sha: body.sha,
    costUsd: Number.isFinite(body.costUsd) ? body.costUsd : null,
  };
}
