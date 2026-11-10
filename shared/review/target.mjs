// What the launch form's "PR or branch" field accepts, and what it means.
//
// One field, two kinds of target, because asking a user to pick a radio button
// before typing `23808` is a worse form than working out which one they meant.
// The rule is deliberately blunt: a number or a github.com pull request URL is
// a pull request, and anything else that is a legal git ref is a branch. There
// is no third case — an input that is neither is refused rather than guessed
// at, because every downstream consumer puts this value on an argv.
//
// Validation is stricter than git's own `check-ref-format`. This value becomes
// a `git fetch` refspec component and part of a branch name, and the cheapest
// way to be sure neither can be turned into something else is to allow a small
// character set and nothing more.

import { parsePrIdentifier } from './github.mjs';

const MAX_BRANCH_CHARS = 200;
// `origin/` is what people copy out of `git branch -a`, and asking origin for
// `refs/heads/origin/foo` is a 404 with a confusing message. Strip it rather
// than fail on it.
const REMOTE_PREFIX = 'origin/';

/**
 * @typedef {{ok: true, kind: 'pr', pr: number, slug: string|null}
 *         | {ok: true, kind: 'branch', branch: string}
 *         | {ok: false, error: string}} ParsedTarget
 */

/**
 * Parse the "PR or branch" field.
 *
 * @param {unknown} raw
 * @returns {ParsedTarget}
 */
export function parseTarget(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'a pull request number, pull request URL or branch name is required' };
  }
  // Same reasoning as parsePrIdentifier: String() flattens an array quietly,
  // and `{"target": ["master"]}` accepted as "master" is a shape the API does
  // not document.
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, error: 'the target must be given as a number or a string' };
  }

  const input = String(raw).trim();
  if (!input) {
    return { ok: false, error: 'a pull request number, pull request URL or branch name is required' };
  }

  // A pull request first: `123`, `#123`, or a github.com URL. Anything that
  // LOOKS like one of those but fails validation (a PR number out of range,
  // say) must report that failure rather than fall through and be tried as a
  // branch called "9999999999" — the branch error would be baffling.
  if (/^#?\d+$/.test(input) || /^https?:\/\//i.test(input)) {
    const parsed = parsePrIdentifier(input);
    if (!parsed.ok) return parsed;
    return { ok: true, kind: 'pr', pr: parsed.pr, slug: parsed.slug };
  }

  return parseBranch(input);
}

function parseBranch(input) {
  const branch = input.startsWith(REMOTE_PREFIX) ? input.slice(REMOTE_PREFIX.length) : input;

  if (!branch) return { ok: false, error: 'a branch name is required' };
  if (branch.length > MAX_BRANCH_CHARS) {
    return { ok: false, error: `branch name too long (max ${MAX_BRANCH_CHARS} characters)` };
  }
  // Leading `-` is the one that matters: `git fetch origin +refs/heads/-x:...`
  // is fine, but a bare branch name reaches argv elsewhere and would be read
  // as an option.
  if (branch.startsWith('-')) {
    return { ok: false, error: 'a branch name cannot start with "-"' };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return {
      ok: false,
      error: 'expected a pull request number, a github.com pull request URL, or a branch name (letters, digits, . _ / -)',
    };
  }
  // git's own rules, the subset that a legal-looking string can still break:
  // `..` is a range operator, a leading or trailing `/` is not a ref, `//`
  // makes an empty path component, `.lock` is reserved, and a component
  // starting with `.` is refused by check-ref-format.
  if (branch.includes('..')) return { ok: false, error: 'a branch name cannot contain ".."' };
  if (branch.startsWith('/') || branch.endsWith('/')) {
    return { ok: false, error: 'a branch name cannot start or end with "/"' };
  }
  if (branch.includes('//')) return { ok: false, error: 'a branch name cannot contain "//"' };
  if (branch.endsWith('.lock')) return { ok: false, error: 'a branch name cannot end with ".lock"' };
  if (branch.endsWith('.')) return { ok: false, error: 'a branch name cannot end with "."' };
  if (branch.split('/').some((part) => part.startsWith('.'))) {
    return { ok: false, error: 'no part of a branch name may start with "."' };
  }
  if (branch === 'HEAD') return { ok: false, error: '"HEAD" is not a branch name' };

  return { ok: true, kind: 'branch', branch };
}

/**
 * The pull request's own branch, when a review of it can sit on that branch.
 *
 * A review on the pull request's branch is a session like any other: `git push`
 * updates the pull request, and the rail finds the pull request by the branch
 * name. Null when that cannot work, and the review then falls back to
 * reviewBranchFor's private branch:
 *
 *  - A fork's branch is not on origin. `isCrossRepository` has to be a literal
 *    false, so a `gh` that stops reporting it lands here rather than on a branch
 *    named after somebody else's fork.
 *  - A name that is not a plain branch name. It becomes argv and a refspec.
 *  - A name under review/. Kill deletes anything matching the private branch's
 *    shape unconditionally, so a pull request branch must never look like one.
 *
 * @param {{isCrossRepository?: boolean, headRefName?: string}|null} meta
 * @returns {string|null}
 */
export function prBranchFor(meta) {
  if (!meta || meta.isCrossRepository !== false) return null;
  const name = String(meta.headRefName || '');
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(name) || name.startsWith('-')) return null;
  if (name.startsWith('review/') || name.includes('..') || name.endsWith('/')) return null;
  return name;
}

/**
 * The private branch a review worktree is created on when prBranchFor gives
 * nothing: a fork's pull request, or a branch target.
 *
 * The session id makes it unique by construction, which is the point: `git
 * worktree add <path> <existing-branch>` fails outright when that branch is
 * checked out in another worktree, and this box routinely has thirty of them.
 *
 * @param {{target: ParsedTarget, sessionId: string}} params
 */
export function reviewBranchFor({ target, sessionId }) {
  const stem = target.kind === 'pr' ? `pr-${target.pr}` : slugifyBranch(target.branch);
  return `review/${stem}-${sessionId}`;
}

// `/` would nest the review branch under a directory named after part of the
// source branch, and git refuses `refs/heads/a/b` when `refs/heads/a` exists.
// Flattening sidesteps the whole question.
function slugifyBranch(branch) {
  const flat = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (flat || 'branch').slice(0, 40).replace(/-+$/, '') || 'branch';
}

/** A human label for the target, for logs and the page title. */
export function describeTarget(target) {
  return target.kind === 'pr' ? `PR #${target.pr}` : `branch ${target.branch}`;
}
