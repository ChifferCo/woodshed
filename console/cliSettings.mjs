// `woodshed settings` (cli/settings.mjs): a person's computer joins the Claude settings their private sessions keep in
// step (claudeSettings.mjs, session/settingsSync.mjs), and saves their own whole files for a repo (repoSettings.mjs),
// with the command line's token (cliSignIn.mjs) as its sign-in:
//
//   GET  /api/cli/settings                   {version, items}: the shared copy, MCP logins left out
//   POST /api/cli/settings                   {version, changed, removed: []}: the computer's changes, merged item by item
//                                            as a session's are  ->  {version, items?}. A computer removes nothing: a
//                                            removal stays in the session it was made in, and so it stays on a laptop
//   GET  /api/cli/settings/repos             the repos the person can start sessions on (GET /api/my/repos)
//   GET  /api/cli/settings/files/<project>   {files}: their own whole files for it (GET /api/my/repos/<project>/files)
//   POST /api/cli/settings/files/<project>   {path, text}: one file added or replaced (the same route's POST)
//   GET  /api/cli/settings/dotfiles          {files}: their own lines for each dotfile on My settings (shared/dotfiles.mjs)
//   POST /api/cli/settings/dotfiles/<key>    {text}: their own lines for one, checked as My settings checks them
//
// The repo routes are My settings' own (repoSettings.mjs's API), opened to the token: the same checks, the same records
// and log lines. The shared copy's route is the session API's /claude-settings for a computer: a session's turn there
// is checked against its session (tainted, its owner removed), a computer's against its token.
//
// MCP logins (`.claude/.credentials.json#mcpOAuth/...`) go between a person's sessions only: none is taken from a
// computer, and none handed to one. Each is a sign-in made by hand in a session, which a laptop has its own of.

import { DOTFILES } from '../shared/dotfiles.mjs';
import { MAX_SETTINGS_BYTES, parseSyncBody } from './claudeSettings.mjs';

export const CLI_SETTINGS_PATH = '/api/cli/settings';
const FILES_RE = /^\/api\/cli\/settings\/files\/([^/]+)$/;
const DOTFILE_RE = /^\/api\/cli\/settings\/dotfiles(?:\/([a-z-]+))?$/;
// A dotfile's lines and their JSON: My settings' own limit on a file is 64 KB.
const MAX_DOTFILE_BODY = 200_000;
const LOGIN_PREFIX = '.claude/.credentials.json#';

/** @returns {boolean}  an MCP login's item, which never goes to or from a computer */
export function isLoginItem(id) {
  return id.startsWith(LOGIN_PREFIX);
}

function withoutLogins(items) {
  return Object.fromEntries(Object.entries(items ?? {}).filter(([id]) => !isLoginItem(id)));
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param {{req, res, url: URL, cli: ReturnType<typeof import('./cliSignIn.mjs').createCliSignIn>,
 *          claudeSettings: ReturnType<typeof import('./claudeSettings.mjs').createClaudeSettings>|null,
 *          repoSettingsApi: ((req, res, who: object) => Promise<void>)|null,
 *          userSettings?: ReturnType<typeof import('./userSettings.mjs').createUserSettings>|null}} args
 *   `cli.authenticate` is the token's one check, as on every route it reaches: its person still on People, with write
 *   access on GitHub. `repoSettingsApi` is createRepoSettingsApi's handler
 * @returns {Promise<boolean>}  whether it answered: true for any /api/cli/settings path
 */
export async function handleCliSettings({ req, res, url, cli, claudeSettings, repoSettingsApi, userSettings = null }) {
  const { pathname } = url;
  if (pathname !== CLI_SETTINGS_PATH && !pathname.startsWith(`${CLI_SETTINGS_PATH}/`)) return false;
  // A token is sent by the command line alone: a call carrying an Origin is a page's (cliSessions.mjs).
  if (req.headers.origin) {
    req.resume();
    console.warn('cliSettings: refused, a browser\'s call', { path: pathname, origin: String(req.headers.origin).slice(0, 100) });
    return reply(res, 403, { error: 'a command line token is for the woodshed command line, not a page' }), true;
  }
  const { signedIn, error } = await cli.authenticate(req.headers);
  if (!signedIn) {
    req.resume();
    return reply(res, 401, { error: error ?? 'not signed in, or the sign-in ended: run woodshed login' }), true;
  }
  const { login } = signedIn;
  if (!login) {
    req.resume();
    return reply(res, 409, { error: 'this console has no GitHub sign-in, so it keeps no one\'s own settings' }), true;
  }

  if (pathname === `${CLI_SETTINGS_PATH}/repos` || FILES_RE.test(pathname)) {
    if (!repoSettingsApi) {
      req.resume();
      return reply(res, 404, { error: 'this console keeps no repo settings' }), true;
    }
    const project = FILES_RE.exec(pathname)?.[1] ?? null;
    if (!project && req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' }), true;
    await repoSettingsApi(req, res, { route: { scope: 'my', project, key: null, instructions: false, remove: false, files: Boolean(project) }, login });
    return true;
  }
  const dotfile = DOTFILE_RE.exec(pathname);
  if (dotfile) {
    // Awaited, so a secret store that fails reaches the server's own error answer rather than going unhandled.
    await dotfileReply(req, res, { login, token: signedIn.id, key: dotfile[1] ?? null, userSettings });
    return true;
  }
  if (pathname !== CLI_SETTINGS_PATH) return reply(res, 404, { error: 'not found' }), true;
  if (!claudeSettings) {
    req.resume();
    return reply(res, 404, { error: 'this console keeps no shared Claude settings: it has nowhere to save Claude homes' }), true;
  }
  const from = `cli:${signedIn.id}`;
  if (req.method === 'GET') {
    // A turn with no changes and no version: the whole copy comes back.
    const copy = await claudeSettings.sync({ login, sessionId: from, version: null, changed: {}, removed: [] });
    return reply(res, 200, { version: copy.version, items: withoutLogins(copy.items) }), true;
  }
  if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' }), true;
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_SETTINGS_BYTES * 2) return reply(res, 413, { error: 'too large' }), true;
  }
  let body;
  try {
    body = parseSyncBody(JSON.parse(text));
  } catch {
    body = null;
  }
  if (!body) return reply(res, 400, { error: 'expected {"version", "changed", "removed"}' }), true;
  if (body.removed.length) {
    console.warn('cliSettings: refused, a removal from a computer', { login, token: signedIn.id, items: body.removed.length });
    return reply(res, 400, { error: 'a computer never removes an item from your shared settings: remove it in a session' }), true;
  }
  const logins = Object.keys(body.changed).filter(isLoginItem);
  if (logins.length) {
    console.warn('cliSettings: refused, MCP logins from a computer', { login, token: signedIn.id, items: logins.length });
    return reply(res, 400, { error: 'MCP logins are not taken from a computer: sign in to the server in a session' }), true;
  }
  let answer;
  try {
    answer = await claudeSettings.sync({ login, sessionId: from, ...body });
  } catch (err) {
    if (!err.shown) throw err;
    console.warn('cliSettings: refused', { login, token: signedIn.id, message: err.message });
    return reply(res, err.status ?? 413, { error: err.message }), true;
  }
  console.log('cliSettings: pushed', { login, token: signedIn.id, changed: Object.keys(body.changed).length, version: answer.version });
  return reply(res, 200, answer.items ? { version: answer.version, items: withoutLogins(answer.items) } : { version: answer.version }), true;
}

// A computer's dotfiles, as the person's own lines for them on My settings: the same store, check and log line as the
// page's (userSettings.saveFile), so a line the page would refuse is refused here too.
async function dotfileReply(req, res, { login, token, key, userSettings }) {
  if (!userSettings || userSettings.view(login).available === false) {
    req.resume();
    return reply(res, 404, { error: 'this console has no secret store, so it keeps no one\'s own lines' });
  }
  if (req.method === 'GET' && !key) {
    const files = await userSettings.ownFiles(login);
    return reply(res, 200, { files: Object.fromEntries(Object.keys(DOTFILES).map((k) => [k, files[k] ?? null])) });
  }
  if (req.method !== 'POST' || !key) {
    req.resume();
    return reply(res, 405, { error: 'method not allowed' });
  }
  if (!Object.hasOwn(DOTFILES, key)) {
    req.resume();
    return reply(res, 404, { error: `no dotfile called ${key}` });
  }
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_DOTFILE_BODY) return reply(res, 413, { error: 'too large' });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (typeof body?.text !== 'string' || !body.text.trim()) return reply(res, 400, { error: 'expected {"text"}: a computer never clears them, Clear mine on My settings does' });
  try {
    await userSettings.saveFile(login, key, body.text);
  } catch (err) {
    if (!err.shown) throw err;
    console.warn('cliSettings: dotfile refused', { login, token, key, why: err.message.split(':')[0] });
    return reply(res, 400, { error: err.message });
  }
  console.log('cliSettings: dotfile saved', { login, token, key, bytes: Buffer.byteLength(body.text) });
  return reply(res, 200, { key });
}
