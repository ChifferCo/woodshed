import { runGit } from './git.mjs';

/**
 * The repo a checkout is of, as GitHub names it, from its `origin`: every clone Woodshed makes (install.sh, the
 * session image, a session on another project) fetches from `https://github.com/<owner>/<name>.git`.
 * @returns {string|null}  owner/name, null when the origin is not on GitHub or the folder is no checkout
 */
export function repoOf(repoDir) {
  let url;
  try {
    url = runGit(repoDir, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return null;
  }
  const match = /^(?:https:\/\/(?:[^/@]*@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}
