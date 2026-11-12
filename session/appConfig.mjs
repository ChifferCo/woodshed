// Read/save this repository's installation app through the authenticated session API. The cache stays outside git.
// node appConfig.mjs pull | save <app.json> | check <app.json>
import fs from 'node:fs';
import path from 'node:path';
import { loadProject, parseProject, repoOf } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';

export const APP_CONFIG_FILE = '/tmp/woodshed-app-config.json';

// Like the entrypoint's consoleCall: a console restart must not fail a session that is starting. Save is also safe
// to retry: the console accepts the same app again and refuses a different app already saved by another session.
async function request(url, options, { retryDelayMs = 5_000, maxAttempts = 9, maxMs = 60_000 } = {}) {
  const deadline = Date.now() + maxMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))) });
      if (res.status === 404) return null; // An older console.
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      if (!res.ok) {
        const result = await res.json().catch(() => null);
        throw Object.assign(new Error(result?.error || `the console answered ${res.status}`), { retryable });
      }
      return await res.json(); // A truncated response is retried too.
    } catch (err) {
      if (err.retryable === false || attempt >= maxAttempts || Date.now() + retryDelayMs >= deadline) throw err;
      console.warn('appConfig: console did not answer, retrying', { attempt });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export async function appConfig(action, file, { env = process.env, repoDir = env.REPO_DIR || process.cwd(), retry = {} } = {}) {
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
  const result = await request(`${env.WOODSHED_CONSOLE_URL}/app-config${action === 'save' ? '/save' : ''}`, {
    method: 'POST', headers: { authorization: `Bearer ${env.SESSION_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(action === 'save' ? { app } : {}),
  }, retry);
  if (!result) {
    if (action === 'pull') return { available: false };
    throw new Error('this console does not support saving app settings');
  }
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
