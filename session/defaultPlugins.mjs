// The plugins every private session should have, and which of them a restored Claude home still lacks. The entrypoint
// installs those (installDefaultPlugins) before claude starts, in private sessions only: Slack's MCP signs in as the
// session's owner, and a shared session must never hold an integration token (CLAUDE.md, "Rules"). A saved home keeps
// the plugin after that, so only someone's first session pays for the install. Each default is offered once: the
// entrypoint records it in the home's offered list, so one its owner uninstalled is not installed again.
//
//   node defaultPlugins.mjs <installed_plugins.json> <settings.json> <offered.json>   prints one `plugin@marketplace`
//                                                                                     per line, and counts a default
//                                                                                     already installed as offered
//   node defaultPlugins.mjs --offered <offered.json> <plugin@marketplace>             adds it to the offered list

import fs from 'node:fs';
import { isMain } from '../shared/isMain.mjs';

// Add a plugin here to give it to every private session. The marketplace must be one claude knows without a
// `plugin marketplace add`: anthropic-plugin-directory and claude-plugins-official are.
export const DEFAULT_PLUGINS = ['slack@anthropic-plugin-directory'];

/**
 * @param {object} installed  installed_plugins.json: { plugins: { "name@marketplace": [...] } }
 * @param {object} settings   ~/.claude/settings.json: a plugin someone turned off is in `enabledPlugins` as false
 * @param {unknown} offered    the ids installed by this step before, whatever became of them since
 * @param {string[]} [wanted]
 * @returns {string[]}  the default plugins never offered, installed or turned off
 */
export function defaultPluginsToInstall(installed, settings, offered, wanted = DEFAULT_PLUGINS) {
  const have = installed?.plugins ?? {};
  const enabled = settings?.enabledPlugins ?? {};
  const before = new Set(Array.isArray(offered) ? offered : []);
  return wanted.filter((id) => !before.has(id) && !Object.hasOwn(have, id) && enabled[id] !== false);
}

/** @returns {string[]}  the offered list with `id` added once */
export function withOffered(offered, id) {
  const list = Array.isArray(offered) ? offered.filter((x) => typeof x === 'string') : [];
  return list.includes(id) ? list : [...list, id];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No file yet (a fresh home), or one claude is halfway through writing: nothing installed, nothing turned off.
    return null;
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--offered') {
    const [, offeredFile, id] = args;
    fs.writeFileSync(offeredFile, `${JSON.stringify(withOffered(readJson(offeredFile), id))}\n`);
  } else {
    const [installedFile, settingsFile, offeredFile] = args;
    const installed = readJson(installedFile);
    const offered = readJson(offeredFile);
    // A default someone installed by hand before this list existed counts as offered, so uninstalling it later sticks.
    const seen = DEFAULT_PLUGINS.filter((id) => Object.hasOwn(installed?.plugins ?? {}, id)).reduce(withOffered, offered ?? []);
    if (JSON.stringify(seen) !== JSON.stringify(offered ?? [])) fs.writeFileSync(offeredFile, `${JSON.stringify(seen)}\n`);
    for (const id of defaultPluginsToInstall(installed, readJson(settingsFile), offered)) console.log(id);
  }
}
