// A review session's report, as session/review.sh sends it to the console (POST /review-report): the verdict the
// console submits as a formal review, and the merge-risk the console posts as the Merge risk check. The session has
// already read these from its files with shared/codeReview/codeReview.mjs; this only validates what arrived.
import { MAX_REPORT_CHARS, SPINNER_HTML } from './qaSessions.mjs';
import agentsRegistry from '../shared/agents.cjs';
import { isKnownReason } from '../shared/codeReview/failureReason.mjs';

const CONCLUSIONS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
const TIERS = new Set(['Low', 'Medium', 'High']);
// As many as the Actions review would post in one run: a few precise ones are the aim.
const MAX_INLINE_COMMENTS = 30;
const MAX_INLINE_CHARS = 4000;
const MAX_RESOLVED = 100;

// The legacy Claude heading also identifies Woodshed verdicts to the gate. Accept it alongside the new headings.
const CLAUDE_HEADING = '## Claude review';
// Each reviewer's name in a heading and the running comment: Claude Code, Codex, Grok Build, OpenCode.
const productOf = (id) => agentsRegistry.agent(id).product;
const PRODUCT_NAMES = agentsRegistry.REVIEW_AGENT_IDS.map(productOf);
const NAMES_RE = new RegExp(`^## (?:${PRODUCT_NAMES.join('|')})(?:(?:, | and )(?:${PRODUCT_NAMES.join('|')}))* review — `);

/** @returns {string}  the reviewers' names as a sentence lists them: `Claude Code, Codex and Grok Build` */
export function reviewerNames(agents) {
  const names = agentsRegistry.REVIEW_AGENT_IDS.filter((id) => agents.includes(id)).map(productOf);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

/**
 * The review's heading for the reviewers that wrote its verdict: the project's own heading, or for a woodshed review by
 * any but Claude Code alone, theirs (`## Codex review`, `## Claude Code and Codex review`, `## Claude Code and Grok
 * Build review`).
 */
export function reviewHeading(heading, agents) {
  if (heading !== CLAUDE_HEADING || !agents?.length || (agents.length === 1 && agents[0] === 'claude')) return heading;
  return `## ${reviewerNames(agents)} review`;
}

export function matchesReviewHeading(body, review) {
  if (body.startsWith(review.heading)) return true;
  return review.runner === 'woodshed' && review.heading === CLAUDE_HEADING && NAMES_RE.test(body);
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
export function reviewRunningComment({ sessionUrl, agents = ['claude'], leftOut = null }) {
  const where = sessionUrl ? `[a Woodshed session](${sessionUrl})` : 'a Woodshed session';
  const who = agents.length === 1 && agents[0] === 'claude' ? '' : ` with ${reviewerNames(agents)}`;
  const left = leftOutNote(leftOut);
  return `**Reviewing**${who} in ${where}: the review and its merge risk follow here when it ends.${left ? ` ${left}` : ''} ${SPINNER_HTML}\n`;
}

/**
 * @param {{reason: string, sessionUrl: string|null}} args
 * @returns {string}  the review's comment when its session ended without a review
 */
export function reviewEndedComment({ reason, sessionUrl }) {
  const where = sessionUrl ? ` ([session](${sessionUrl}))` : '';
  return `⚠️ **The review did not finish**${where}: ${codeSpan(reason)}. A new commit starts another.\n`;
}

/** The reason quotes what the session met, a project file's unknown key among it, so it goes in as code: a link, an
 * image, a tag or an @mention in it stays text on the pull request. The status and the log keep it as it was. A fence
 * one backtick longer than the longest run inside holds it whole, and its padding keeps a backtick at either end apart. */
function codeSpan(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  const fence = '`'.repeat(Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence} ${line} ${fence}`;
}

/**
 * @param {{conclusion: string, tier: string|null}} args
 * @returns {string}  the review's comment when it reported a verdict but wrote no comment of its own
 */
export function reviewDoneComment({ conclusion, tier }) {
  const verdict = { APPROVE: 'approved', REQUEST_CHANGES: 'changes requested', COMMENT: 'commented, no verdict' }[conclusion] ?? 'finished';
  return `**Review finished**: ${verdict}${tier ? `, merge risk ${tier}` : ''}. Details in the review.\n`;
}

// Why a reviewer the author chose was left out, by the code the console gave it (reviewAgents.mjs): fixed sentences
// only, so nothing from a log or a credential reaches the pull request. An unknown code says nothing of why.
const LEFT_OUT_WHY = {
  off: 'you have not turned its sign-in on for reviews',
  none: 'you have no sign-in saved for it',
  'no-token': 'your saved sign-in has no token',
  expired: 'your saved login has expired',
  'no-expiry': 'your saved login does not say when it expires',
  unsendable: 'your saved sign-in has a token that cannot be sent',
  'no-key': 'this console has nothing to run it on',
  unread: 'your saved sign-in could not be read',
};

/**
 * @param {{agent: string, code: string}[]|null|undefined} leftOut  from the review session's record
 * @returns {string}  a note for the review, one sentence for each reviewer the author chose and the console left out, or ''
 */
export function leftOutNote(leftOut) {
  if (!Array.isArray(leftOut)) return '';
  return leftOut
    .filter((l) => agentsRegistry.REVIEW_AGENT_IDS.includes(l?.agent))
    .map((l) => `${productOf(l.agent)} was left out${LEFT_OUT_WHY[l.code] ? `: ${LEFT_OUT_WHY[l.code]}` : ''}.`)
    .join(' ');
}

const WHY_PRODUCTS = new Set(agentsRegistry.REVIEW_AGENT_IDS.map((id) => agentsRegistry.agent(id).product));

/** The reasons a report gives for no verdict, each `<reviewer>: <sentence>`: only a known reviewer with a sentence the
 * session's own classifier makes survives, so a session cannot put other text in the log or the pull request. */
function whyOf(raw) {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, 2000).split(';').map((part) => part.trim()).filter(Boolean).filter((part) => {
    const at = part.indexOf(': ');
    return at > 0 && WHY_PRODUCTS.has(part.slice(0, at)) && isKnownReason(part.slice(at + 2));
  }).join('; ');
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
  const agents = Array.isArray(body.agents) ? agentsRegistry.REVIEW_AGENT_IDS.filter((agent) => body.agents.includes(agent)) : [];
  return {
    conclusion: body.conclusion,
    ...(whyOf(body.why) ? { why: whyOf(body.why) } : {}),
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
