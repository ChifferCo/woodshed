// The plugins a restored Claude home lists as installed whose files it does not have. A saved home keeps
// ~/.claude/plugins/cache now, but one saved before that, or a save cut short, lists plugins without their files, and
// claude then starts with `Plugin "<name>" not cached at …` for each one. The entrypoint installs each again
// (restorePlugins) before claude starts, so this is the fallback, not the usual path.
//
//   node missingPlugins.mjs <installed_plugins.json> <repo dir>   prints `plugin@marketplace scope` per line, the scope
//                                                                 it was installed in, so it comes back where it was

import fs from 'node:fs';
import { isMain } from '../shared/isMain.mjs';

// What `claude plugin install` takes, and nothing that could be anything else on a command line.
const PLUGIN_ID_RE = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/;

// The scopes `claude plugin install --scope` takes.
const SCOPES = new Set(['user', 'project', 'local']);

/**
 * @param {object} installed  installed_plugins.json, version 2: { plugins: { "name@marketplace": [{ scope, projectPath?, installPath }] } }
 * @param {{repoDir: string, exists?: (path: string) => boolean}} opts
 * @returns {{id: string, scope: 'user'|'project'|'local'}[]}  what to install again, and where: a user install, or one
 *   for this repo, whose installPath is gone
 */
export function missingPlugins(installed, { repoDir, exists = fs.existsSync }) {
  const missing = [];
  for (const [id, installs] of Object.entries(installed?.plugins ?? {})) {
    if (!PLUGIN_ID_RE.test(id) || !Array.isArray(installs)) continue;
    const gone = installs.find((i) => (i?.scope === 'user' || i?.projectPath === repoDir) && SCOPES.has(i.scope)
      && typeof i.installPath === 'string' && !exists(i.installPath));
    if (gone) missing.push({ id, scope: gone.scope });
  }
  return missing;
}

if (isMain(import.meta.url)) {
  const [file, repoDir] = process.argv.slice(2);
  let installed = null;
  try {
    installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No list, or one claude is halfway through writing: nothing to put back.
  }
  for (const { id, scope } of missingPlugins(installed, { repoDir })) console.log(`${id} ${scope}`);
}
