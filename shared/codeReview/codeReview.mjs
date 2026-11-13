// The code review's prompt and verdict, for a review that runs as a Woodshed session (session/review.sh) in place of
// the Actions workflow. The session writes its verdict, summary, merge risk and the full comment into a directory with
// this prompt, then the console submits the formal review and the merge-risk check (console/fleet.mjs, reviewFinished).
// The merge-risk tiers match the Actions review (review.yml), so the tier is the same wherever the review runs.
//
//   node codeReview.mjs prompt <dir> --pr <n> --head <sha> --server <url> --repo <owner/name>
//       writes <dir>/review-prompt.md, pointing at <dir>/context.md, <dir>/base-rules/, <dir>/instructions.md and
//       <dir>/risk-areas.md, which session/review.sh fills from the base branch
//   node codeReview.mjs verdict <dir>
//       prints {conclusion, summary, comment, mergeRisk: {tier, reason, summary}} as JSON, or exits 3 when the session
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
export function reviewPrompt({ dir, pr, head, server, repo }) {
  return fs.readFileSync(path.join(HERE, 'prompt.txt'), 'utf8')
    .replaceAll('{{DIR}}', dir).replaceAll('{{PR}}', String(pr)).replaceAll('{{HEAD_SHA}}', head)
    .replaceAll('{{SERVER}}', server).replaceAll('{{REPO}}', repo);
}

export function writePrompt({ dir, pr, head, server, repo }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-prompt.md'), reviewPrompt({ dir, pr, head, server, repo }));
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
 *   mergeRisk: {tier: string|null, reason: string, summary: string}}}
 */
export function verdictIn(dir) {
  const raw = readFile(dir, 'verdict.txt').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  const conclusion = CONCLUSIONS.includes(raw) ? raw : null;
  const mergeRisk = mergeRiskIn(dir);
  return { conclusion, summary: readFile(dir, 'summary.md').trim(), comment: readFile(dir, 'review-comment.md').trim(), mergeRisk };
}

function main([command, dir]) {
  const { values } = parseArgs({
    args: process.argv.slice(4),
    options: { pr: { type: 'string' }, head: { type: 'string' }, server: { type: 'string' }, repo: { type: 'string' } },
  });
  if (command === 'prompt' && dir && values.pr && values.head && values.server && values.repo) {
    writePrompt({ dir, pr: values.pr, head: values.head, server: values.server, repo: values.repo });
    return;
  }
  if (command === 'verdict' && dir) {
    const verdict = verdictIn(dir);
    if (!verdict.conclusion) process.exit(3);
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    return;
  }
  throw new Error('usage: codeReview.mjs prompt <dir> --pr --head --server --repo | verdict <dir>');
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2));
}
