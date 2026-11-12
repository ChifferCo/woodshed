// Read/save this repository's installation app through the authenticated session API. The cache stays outside git.
// node appConfig.mjs pull | save <app.json> | check <app.json>
import fs from 'node:fs';
import path from 'node:path';
import { loadProject, parseProject, repoOf } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';

export const APP_CONFIG_FILE = '/tmp/woodshed-app-config.json';

export async function appConfig(action, file, { env = process.env, repoDir = env.REPO_DIR || process.cwd() } = {}) {
  const cache = env.WOODSHED_APP_CONFIG_FILE || APP_CONFIG_FILE;
  let app;
  if (action === 'save' || action === 'check') {
    app = parseProject({ version: 1, app: JSON.parse(fs.readFileSync(file, 'utf8')) }).app;
    if (!app) throw new Error('app is required');
    if (action === 'check') return { checked: true };
    if (loadProject(repoDir, { savedAppFile: null }).apps.length) throw new Error('the project already defines an app; its settings take precedence');
  } else if (action !== 'pull') throw new Error('use pull, check <app.json>, or save <app.json>');
  if (!env.WOODSHED_CONSOLE_URL || !env.SESSION_TOKEN) {
    if (action === 'pull') return { available: false };
    throw new Error('this session has no connection to the console');
  }
  const res = await fetch(`${env.WOODSHED_CONSOLE_URL}/app-config${action === 'save' ? '/save' : ''}`, {
    method: 'POST', headers: { authorization: `Bearer ${env.SESSION_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(action === 'save' ? { app } : {}), signal: AbortSignal.timeout(15_000),
  });
  if (action === 'pull' && res.status === 404) return { available: false }; // An older console.
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `the console answered ${res.status}`);
  if (result.repo !== repoOf(repoDir)?.toLowerCase()) throw new Error('the saved app belongs to another repository');
  if (result.app) parseProject({ version: 1, app: result.app });
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(`${cache}.tmp`, JSON.stringify(result), { mode: 0o600 });
  fs.renameSync(`${cache}.tmp`, cache);
  return { available: true, saved: Boolean(result.app) };
}

if (isMain(import.meta.url)) {
  try {
    const result = await appConfig(process.argv[2], process.argv[3]);
    console.log(`appConfig: ${process.argv[2]} finished`, result);
  } catch (err) {
    console.error(`appConfig: ${err.message}`);
    process.exitCode = 1;
  }
}
