// The code review's prompt and verdict, for a review that runs as a Woodshed session (session/review.sh) in place of
// the Actions workflow. The session writes its verdict, summary, merge risk and the full comment into a directory with
// this prompt, then the console submits the formal review and the merge-risk check (console/fleet.mjs, reviewFinished).
// The merge-risk tiers match the Actions review (review.yml), so the tier is the same wherever the review runs.
//
//   node codeReview.mjs prompt <dir> --pr <n> --head <sha> --server <url> --repo <owner/name> [--reviewer <login>]
//       writes <dir>/review-prompt.md, pointing at <dir>/context.md, <dir>/base-rules/, <dir>/instructions.md and
//       <dir>/risk-areas.md, which session/review.sh fills from the base branch
//   node codeReview.mjs verdict <dir>
//       prints {conclusion, summary, comment, mergeRisk: {tier, reason, summary}, inlineComments, resolved} as JSON, or
//       exits 3 when the session
//       wrote no verdict
//   node codeReview.mjs merge <dir> <codexDir>
//       the same, for a review by Claude Code (<dir>) and Codex (<codexDir>) together (mergeVerdicts); exits 3 when
//       neither wrote a verdict
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isMain } from '../isMain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONCLUSIONS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
const TIERS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };

/** The review prompt, with the session's paths and the pull request's facts filled in. */
export function reviewPrompt({ dir, pr, head, server, repo, reviewer = '' }) {
  return fs.readFileSync(path.join(HERE, 'prompt.txt'), 'utf8')
    .replaceAll('{{DIR}}', dir).replaceAll('{{PR}}', String(pr)).replaceAll('{{HEAD_SHA}}', head)
    .replaceAll('{{SERVER}}', server).replaceAll('{{REPO}}', repo)
    .replaceAll('{{REVIEWER}}', reviewer || 'the review\'s own account');
}

export function writePrompt({ dir, pr, head, server, repo, reviewer = '' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-prompt.md'), reviewPrompt({ dir, pr, head, server, repo, reviewer }));
}

/**
 * The inline comments the session wrote to inline-comments.json: a list of {path, line, body}. A file that is missing
 * or not a list is none; the console checks each one again.
 * @returns {{path: string, line: number, body: string}[]}
 */
export function inlineCommentsIn(dir) {
  let list;
  try {
    list = JSON.parse(readFile(dir, 'inline-comments.json') || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((c) => typeof c?.path === 'string' && Number.isInteger(c?.line) && typeof c?.body === 'string')
    .map((c) => ({ path: c.path.replace(/^\.\//, ''), line: c.line, body: c.body }));
}

/**
 * Whose each earlier inline comment in context.md is, from the `**<name>:**` its body opens with when both reviewed
 * (mergeVerdicts marks them so). A comment with no such mark, a person's or one from a review by one reviewer, is left out.
 * @param {string[]} names  the reviewers' names, as mergeVerdicts gets them
 * @returns {Map<number, string>}  comment id to reviewer name
 */
export function commentAuthorsIn(dir, names) {
  // An id's first record is the real one: a later line shaped like one is inside some comment's body, and never
  // changes whose it is.
  const authors = new Map();
  const seen = new Set();
  for (const m of readFile(dir, 'context.md').matchAll(/^\[comment ([0-9]{1,15})\] \S+ on [^\n]*?: (?:\*\*([^*\n]+):\*\*)?/gm)) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    if (names.includes(m[2])) authors.set(id, m[2]);
  }
  return authors;
}

/** @returns {number[]}  the ids in resolved.txt, one a line, digits only */
export function resolvedIn(dir) {
  return [...new Set(readFile(dir, 'resolved.txt').split('\n').map((l) => l.trim()).filter((l) => /^[0-9]{1,15}$/.test(l)).map(Number))];
}

const readFile = (dir, name) => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return '';
  }
};

/**
 * The merge risk the session wrote: the tier on the first line, then a reason sentence, then optional bullets.
 * @returns {{tier: 'Low'|'Medium'|'High'|null, reason: string, summary: string}}
 */
export function mergeRiskIn(dir) {
  const text = readFile(dir, 'merge-risk.md').trim();
  if (!text) return { tier: null, reason: '', summary: '' };
  const [first, ...rest] = text.split('\n');
  const tier = TIERS[first.trim().toUpperCase()] ?? null;
  const reason = (rest.find((l) => l.trim() && !l.trim().startsWith('-')) ?? '').trim();
  return { tier, reason, summary: text };
}

/**
 * What the review session decided, read back for the console to submit. `conclusion` is null when the session wrote no
 * verdict (it could not review), so the console posts nothing and the pull request stays unapproved.
 * @returns {{conclusion: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT'|null, summary: string, comment: string,
 *   mergeRisk: {tier: string|null, reason: string, summary: string}, inlineComments: object[], resolved: number[]}}
 */
export function verdictIn(dir) {
  const raw = readFile(dir, 'verdict.txt').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  const conclusion = CONCLUSIONS.includes(raw) ? raw : null;
  const mergeRisk = mergeRiskIn(dir);
  return {
    conclusion, summary: readFile(dir, 'summary.md').trim(), comment: readFile(dir, 'review-comment.md').trim(), mergeRisk,
    inlineComments: inlineCommentsIn(dir), resolved: resolvedIn(dir),
  };
}

const STRICTNESS = { APPROVE: 0, COMMENT: 1, REQUEST_CHANGES: 2 };
const TIER_ORDER = { Low: 0, Medium: 1, High: 2 };
// As many inline comments as the console posts in one review (console/reviewSessions.mjs).
const MAX_INLINE_COMMENTS = 30;

/**
 * One review from two reviewers' verdicts, each `{name, verdict}` with a verdict as verdictIn reads it. The strictest
 * conclusion wins (REQUEST_CHANGES, then COMMENT, then APPROVE) and the higher merge risk, so a pull request is approved
 * only when both approve. The comment and summary keep a section from each, and the inline comments say whose they are.
 * An earlier comment one of them wrote (`authors`) is resolved when that one found it fixed: the other often leaves a
 * finding that is not its own off its list. One with no known writer, or whose writer wrote no verdict, is resolved only
 * when every reviewer with a verdict found it fixed. A reviewer that wrote no verdict is left out, and the comment says
 * so; with neither, the conclusion is null.
 * @param {{name: string, verdict: ReturnType<typeof verdictIn>}[]} reviews
 * @param {{authors?: Map<number, string>}} [options]  each earlier comment's writer, from commentAuthorsIn
 */
export function mergeVerdicts(reviews, { authors = new Map() } = {}) {
  const done = reviews.filter((r) => r.verdict.conclusion);
  const missing = reviews.filter((r) => !r.verdict.conclusion).map((r) => r.name);
  if (!done.length) return { ...reviews[0].verdict, conclusion: null };
  const missingNote = missing.length ? `${missing.join(' and ')} wrote no verdict, so this is ${done.map((r) => r.name).join(' and ')}'s alone.` : '';
  const conclusion = done.map((r) => r.verdict.conclusion).reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a));
  const risky = done.filter((r) => r.verdict.mergeRisk.tier)
    .reduce((a, b) => (!a || TIER_ORDER[b.verdict.mergeRisk.tier] > TIER_ORDER[a.verdict.mergeRisk.tier] ? b : a), null);
  const mergeRisk = risky ? { ...risky.verdict.mergeRisk } : { tier: null, reason: '', summary: '' };
  if (risky && done.length > 1) mergeRisk.summary = `${mergeRisk.summary}\n\n(The higher of the reviewers' tiers: ${risky.name}'s.)`;
  const sections = (field) => done.length === 1
    ? [done[0].verdict[field], missingNote].filter(Boolean).join('\n\n')
    : done.filter((r) => r.verdict[field]).map((r) => `### ${r.name}: ${r.verdict.conclusion}\n\n${r.verdict[field]}`).join('\n\n');
  const perReviewer = Math.max(1, Math.floor(MAX_INLINE_COMMENTS / done.length));
  const inlineComments = done.flatMap((r) => r.verdict.inlineComments.slice(0, perReviewer)
    .map((c) => ({ ...c, body: done.length > 1 ? `**${r.name}:** ${c.body}` : c.body })));
  const fixedBy = (id) => {
    const writer = done.find((r) => r.name === authors.get(id));
    return writer ? writer.verdict.resolved.includes(id) : done.every((r) => r.verdict.resolved.includes(id));
  };
  const resolved = [...new Set(done.flatMap((r) => r.verdict.resolved))].filter(fixedBy);
  return { conclusion, summary: sections('summary'), comment: sections('comment'), mergeRisk, inlineComments, resolved };
}

function main([command, dir, other]) {
  const { values } = command === 'prompt' ? parseArgs({
    args: process.argv.slice(4),
    options: { pr: { type: 'string' }, head: { type: 'string' }, server: { type: 'string' }, repo: { type: 'string' }, reviewer: { type: 'string' } },
  }) : { values: {} };
  if (command === 'prompt' && dir && values.pr && values.head && values.server && values.repo) {
    writePrompt({ dir, pr: values.pr, head: values.head, server: values.server, repo: values.repo, reviewer: values.reviewer ?? '' });
    return;
  }
  if (command === 'verdict' && dir) {
    const verdict = verdictIn(dir);
    if (!verdict.conclusion) process.exit(3);
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    return;
  }
  if (command === 'merge' && dir && other) {
    const names = ['Claude Code', 'Codex'];
    const verdict = mergeVerdicts([{ name: names[0], verdict: verdictIn(dir) }, { name: names[1], verdict: verdictIn(other) }],
      { authors: commentAuthorsIn(dir, names) });
    if (!verdict.conclusion) process.exit(3);
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    return;
  }
  throw new Error('usage: codeReview.mjs prompt <dir> --pr --head --server --repo [--reviewer] | verdict <dir> | merge <dir> <codexDir>');
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
