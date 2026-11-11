// For tests: a project file with every field written, and only the ones a test cares about set.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { EMPTY_PROJECT } from './project.mjs';

export function fixtureApp(overrides = {}) {
  return {
    start: 'true', stop: null, frontendPort: 3001, backendPort: 9000, logs: {}, paths: [],
    howToProve: 'Start the app and check it.', ...overrides,
  };
}

/** The file's text: JSON, which the project file's YAML reads too. */
export function fixtureProject(overrides = {}) {
  return JSON.stringify({ ...EMPTY_PROJECT, ...overrides });
}

/**
 * A checkout of `repo` on GitHub with no project file, in `dir`: its origin is GitHub's URL for the repo, and its
 * default branch (DEFAULT_BRANCH, which a session exports, or main) is an empty commit.
 */
export function fixtureCheckout(dir, { repo = 'acme/app' } = {}) {
  const branch = process.env.DEFAULT_BRANCH || 'main';
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', branch);
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
  git('update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  return dir;
}

/** The installation's folder of project files, with `files` (`{'owner/name': text}`) in it. */
export function fixtureProjectFiles(dir, files) {
  for (const [repo, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(repo)), { recursive: true });
    fs.writeFileSync(path.join(dir, `${repo}.yaml`), text);
  }
  return dir;
}
