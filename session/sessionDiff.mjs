// The Diff tab: what the session's checkout changes against the merge base with the default branch, commits,
// uncommitted edits and untracked files together. Everything here is the review's own (shared/review): worktreeDiff
// builds the diff in a scratch index, so claude's index is never touched, and parseUnifiedDiff reads each file's path,
// status and counts. The answer has the shape of console/review.mjs's shapeReview, so the console draws both with the
// same code.

import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { worktreeDiff } from '../shared/review/worktree.mjs';
import { parseUnifiedDiff } from '../shared/review/diff.mjs';
import { run } from '../shared/review/exec.mjs';
import { defaultBranchOf } from '../shared/defaultBranch.mjs';

// The files' hunks together are held under this: past it a browser tab struggles.
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

// Each file's part of the patch from its first @@ on, as GitHub's compare API gives a file's `patch`. The parser
// starts a file at each `diff --git` line, so the chunks and its files come in the same order.
function hunksByFile(patch) {
  return patch.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git ')).map((chunk) => {
    const at = chunk.search(/^@@/m);
    return at < 0 ? null : chunk.slice(at).replace(/\n$/, '');
  });
}

// parseUnifiedDiff says `deleted` where GitHub, and so the console's renderer, says `removed`.
const STATUS = { added: 'added', deleted: 'removed', renamed: 'renamed', modified: 'modified' };

/**
 * @param {string} patch  a whole unified diff
 * @returns {{additions: number, deletions: number, files: {path: string, previousPath: string|null, status: string,
 *   additions: number, deletions: number, patch: string|null, truncated: boolean}[]}}
 *   `patch` is null for a binary or mode-only file, and for one over the parser's line cap (`truncated`)
 */
export function shapeSessionDiff(patch) {
  const parsed = parseUnifiedDiff(patch).files;
  const hunks = hunksByFile(patch);
  const files = parsed.map((f, i) => ({
    path: f.path,
    previousPath: f.status === 'renamed' && f.oldPath !== f.newPath ? f.oldPath : null,
    status: STATUS[f.status] ?? 'modified',
    additions: f.additions,
    deletions: f.deletions,
    patch: f.isBinary || f.truncated ? null : hunks[i] ?? null,
    truncated: f.truncated,
  }));
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files,
  };
}

// A few minified lines pass the parser's line caps at any size, so the hunks are also held to `maxBytes` in all: past
// it a file keeps its counts and is marked too large to show, as the parser marks one past its line caps.
function withinBytes(shaped, maxBytes) {
  let used = 0;
  const files = shaped.files.map((f) => {
    if (!f.patch) return f;
    // A file left out costs nothing, so one large lockfile does not hide the small files after it.
    const bytes = Buffer.byteLength(f.patch, 'utf8');
    if (used + bytes > maxBytes) return { ...f, patch: null, truncated: true };
    used += bytes;
    return f;
  });
  return { ...shaped, files };
}

async function gitLine(repoDir, args) {
  const out = await run('git', ['-C', repoDir, ...args], { timeoutMs: 30_000 });
  return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * @param {{repoDir: string, baseRef?: string|null, maxBytes?: number, diff?: typeof worktreeDiff}} params
 * @returns {Promise<{ok: true} & ReturnType<typeof shapeSessionDiff> & {base: string, branch: string|null, head: string,
 *   baseSha: string, aheadBy: number, uncommitted: boolean, baseFetched: boolean} | {ok: false, status: number,
 *   error: string}>}  the files and counts are of the whole diff, even where a file's hunks are left out
 */
export async function readSessionDiff({ repoDir, baseRef = defaultBranchOf(repoDir), maxBytes = MAX_PATCH_BYTES, diff = worktreeDiff }) {
  if (!baseRef) return { ok: false, status: 409, error: 'the checkout has no default branch to compare with' };
  const started = Date.now();
  const indexFile = path.join(os.tmpdir(), `woodshed-diff-index-${randomBytes(6).toString('hex')}`);
  const read = await diff({ repoRoot: repoDir, worktreePath: repoDir, baseRef, indexFile });
  if (!read.ok) {
    console.warn('statusd: diff not read', { status: read.status, error: read.error });
    return { ok: false, status: read.status, error: read.error };
  }
  const [branch, ahead, status] = await Promise.all([
    gitLine(repoDir, ['symbolic-ref', '--short', '-q', 'HEAD']),
    gitLine(repoDir, ['rev-list', '--count', `${read.baseSha}..HEAD`]),
    gitLine(repoDir, ['status', '--porcelain']),
  ]);
  const shaped = withinBytes(shapeSessionDiff(read.patch), maxBytes);
  const bytes = Buffer.byteLength(read.patch, 'utf8');
  const tooLarge = shaped.files.filter((f) => f.truncated).length;
  const answer = {
    ok: true,
    base: baseRef,
    branch: branch || null,
    head: read.headSha.slice(0, 10),
    baseSha: read.baseSha,
    aheadBy: Number(ahead) || 0,
    uncommitted: Boolean(status),
    baseFetched: read.baseFetched,
    ...shaped,
  };
  console.log('statusd: diff read', {
    files: shaped.files.length, aheadBy: answer.aheadBy, uncommitted: answer.uncommitted, bytes, tooLarge, baseFetched: read.baseFetched, ms: Date.now() - started,
  });
  return answer;
}
