// The repo's default branch, for code that cannot ask GitHub: the session sets DEFAULT_BRANCH from the remote at its
// start (session/entrypoint.sh); otherwise it is what the clone's `origin/HEAD` points at, and for a checkout with no
// `origin/HEAD`, the one of `main` or `master` the remote has.
import { execFileSync } from 'node:child_process';

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * @param {string} repoDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}  the branch's name, as `main`; null when it cannot be told
 */
export function defaultBranchOf(repoDir, env = process.env) {
  if (env.DEFAULT_BRANCH) return env.DEFAULT_BRANCH;
  try {
    return git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    // No origin/HEAD: a checkout that was not cloned.
  }
  for (const name of ['main', 'master']) {
    try {
      git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
      return name;
    } catch {
      // Not that one.
    }
  }
  return null;
}
