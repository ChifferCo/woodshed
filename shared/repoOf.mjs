import { execFileSync } from 'node:child_process';
import { windowsExecutable } from './windowsExecutable.mjs';

/**
 * The repo a checkout is of, as GitHub names it, from its `origin`: every clone Woodshed makes (install.sh, the
 * session image, a session on another project) fetches from `https://github.com/<owner>/<name>.git`.
 * @returns {string|null}  owner/name, null when the origin is not on GitHub or the folder is no checkout
 */
export function repoOf(repoDir) {
  let url;
  try {
    const git = process.platform === 'win32' ? windowsExecutable('git', { from: [process.cwd(), repoDir] }) : 'git';
    if (!git) return null;
    url = execFileSync(git, ['-C', repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  const match = /^(?:https:\/\/(?:[^/@]*@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
