// The plugins their owner installed for the whole home elsewhere, on their computer or in another of their sessions,
// which this session's home lacks: the shared settings carry each as the marketplace it comes from (settingsSync.mjs's
// plugin items), never its files. The entrypoint installs them (installSyncedPlugins) before claude starts, in private
// sessions only, as it does the default plugins: each is offered once, in the same list, so one its owner uninstalled
// or turned off is not installed again.
//
//   node syncedPlugins.mjs <home> <offered.json> [<state.json>]   prints `install <plugin@marketplace> <marketplace>`
//                                                                 per plugin, `-` for a marketplace claude knows, and
//                                                                 `skip <plugin@marketplace>` for one it cannot add

import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../shared/isMain.mjs';
import { BUILT_IN_MARKETPLACES, defaultPluginsToInstall } from './defaultPlugins.mjs';
import { marketplaceArg } from '../shared/pluginSource.mjs';
import { MARKETPLACES_FILE, parsePluginId, pluginId, PLUGINS_FILE, SETTINGS, STATE_FILE } from './settingsSync.mjs';

export { marketplaceArg };

/**
 * @param {{synced: Record<string, string>, installed: object|null, settings: object|null, offered: unknown, known: object|null}} args
 *   synced: the shared copy the start pulled; known: known_marketplaces.json
 * @returns {{id: string, add: string|null, skip?: true}[]}  add: the marketplace to add first, null when claude knows it
 */
export function pluginsToInstall({ synced, installed, settings, offered, known }) {
  const wanted = Object.keys(synced ?? {}).map(parsePluginId).filter(Boolean);
  return defaultPluginsToInstall(installed, settings, offered, wanted).map((id) => {
    const market = id.split('@')[1];
    if (known?.[market]) return { id, add: null };
    let source = null;
    try {
      source = JSON.parse(synced[pluginId(id)]).marketplace;
    } catch {}
    // Added from where it came even when claude names it: a fresh home has no copy of claude-plugins-official.
    const add = marketplaceArg(source);
    if (add) return { id, add };
    return BUILT_IN_MARKETPLACES.includes(market) ? { id, add: null } : { id, add: null, skip: true };
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const [home, offeredFile, stateFile = STATE_FILE] = process.argv.slice(2);
  const settings = readJson(path.join(home, SETTINGS));
  const plugins = pluginsToInstall({
    synced: readJson(stateFile)?.synced ?? {}, installed: readJson(path.join(home, PLUGINS_FILE)), settings,
    offered: readJson(offeredFile), known: readJson(path.join(home, MARKETPLACES_FILE)),
  });
  for (const { id, add, skip } of plugins) console.log(skip ? `skip ${id}` : `install ${id} ${add ?? '-'}`);
}
