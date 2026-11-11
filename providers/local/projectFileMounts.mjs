// The installation's project files (WOODSHED_CLOUD_PROJECT_FILES_DIR, docs/reference.md, "The project file") in a
// container of the session image: a read-only bind mount of each file it needs, at `<owner>/<name>.yaml` under
// PROJECT_FILES_MOUNT, which the container is told is the folder.
//
// Each file, not the folder: the folder may hold the files of repos the session does not work on, and a mount is all
// the container sees of it. A session needs its own repo's and the image's repo's, which it reads for the secrets to
// withhold on another project (entrypoint.sh, withholdInstallationSecrets). Read-only, so nothing in a session can
// change what the next one starts with. A mount rather than a call to the console's session API: the entrypoint,
// statusd, Claude's hooks and the db-admin task all read the project file through project.mjs, which reads files, and
// the db-admin task has no session token to call with.
//
// The docker daemon resolves a mount's source on its own host, so the folder must be the same path there, as it is
// when the console runs on that machine (dbAdminRunner.mjs's runs folder is the same). A daemon on another machine
// (createDockerLauncher's `dockerHost`) has its own copy of the folder, at `hostDir`: the console reads `dir` to know
// which files there are, and the mounts name the same files under `hostDir`.
import path from 'node:path';

import { installationProjectFile } from '../../shared/project.mjs';

export const PROJECT_FILES_MOUNT = '/run/woodshed-project-files';

// --mount reads its value as one CSV record, so a path with a comma or a quote is quoted.
function csvField(text) {
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {{dir: string|null, hostDir?: string|null, repos: (string|null|undefined)[]}} args  `repos` are owner/name, any
 *   case; `hostDir` is where the docker host has the same folder, `dir` itself when the daemon is on this machine
 * @returns {{args: string[], repos: string[]}}  docker run's `--mount` flags, and the repos the folder has a file for
 */
export function projectFileMounts({ dir, hostDir = null, repos }) {
  if (!dir) return { args: [], repos: [] };
  const seen = new Set();
  const args = [];
  const found = [];
  for (const repo of repos) {
    if (!repo || seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    const file = installationProjectFile({ dir, repo });
    if (!file) continue;
    const source = hostDir ? path.join(hostDir, path.relative(dir, file.path)) : file.path;
    args.push('--mount', ['type=bind', `source=${source}`, `target=${PROJECT_FILES_MOUNT}/${repo}.yaml`, 'readonly'].map(csvField).join(','));
    found.push(repo);
  }
  return { args, repos: found };
}
