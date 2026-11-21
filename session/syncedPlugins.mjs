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
import { MARKETPLACES_FILE, parsePluginId, pluginId, PLUGINS_FILE, SETTINGS, STATE_FILE } from './settingsSync.mjs';

const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * What `claude plugin marketplace add` takes for a marketplace's recorded source, when a session can add it: a GitHub
 * repo, or a git or marketplace.json URL over https with no sign-in or query in it. A folder on another computer, or a
 * source pinned to a ref or a path in its repo, is not.
 * @returns {string|null}
 */
export function marketplaceArg(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.source === 'github') return typeof source.repo === 'string' && REPO_RE.test(source.repo) && !source.ref && !source.path ? source.repo : null;
  if (source.source !== 'git' && source.source !== 'url') return null;
  let url;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || source.ref || source.path || /\s/.test(source.url)) return null;
  return url.href;
}

/**
 * @param {{synced: Record<string, string>, installed: object|null, settings: object|null, offered: unknown, known: object|null}} args
 *   synced: the shared copy the start pulled; known: known_marketplaces.json
 * @returns {{id: string, add: string|null, skip?: true}[]}  add: the marketplace to add first, null when claude knows it
 */
export function pluginsToInstall({ synced, installed, settings, offered, known }) {
  const wanted = Object.keys(synced ?? {}).map(parsePluginId).filter(Boolean);
  return defaultPluginsToInstall(installed, settings, offered, wanted).map((id) => {
    const market = id.split('@')[1];
    if (BUILT_IN_MARKETPLACES.includes(market) || known?.[market]) return { id, add: null };
    let source = null;
    try {
      source = JSON.parse(synced[pluginId(id)]).marketplace;
    } catch {}
    const add = marketplaceArg(source);
    return add ? { id, add } : { id, add: null, skip: true };
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
