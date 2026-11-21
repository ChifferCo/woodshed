import { execFileSync } from 'node:child_process';
import { windowsExecutable } from './windowsExecutable.mjs';

// Windows searches the working directory before PATH for a bare executable name. A CLI caller can be in a
// different checkout from the one passed to git -C, so exclude both when finding the installed Git.
export function runGit(repoDir, args, options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) {
  const git = process.platform === 'win32' ? windowsExecutable('git', { from: [process.cwd(), repoDir] }) : 'git';
  if (!git) throw new Error('No installed Git was found outside the checkout.');
  return execFileSync(git, ['-C', repoDir, ...args], options);
}
