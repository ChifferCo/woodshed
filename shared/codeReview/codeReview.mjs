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

function main([command, dir]) {
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: { pr: { type: 'string' }, head: { type: 'string' }, server: { type: 'string' }, repo: { type: 'string' }, reviewer: { type: 'string' } },
  });
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
  throw new Error('usage: codeReview.mjs prompt <dir> --pr --head --server --repo [--reviewer] | verdict <dir>');
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
