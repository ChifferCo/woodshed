// Woodshed Cloud console: lists sessions, opens a live terminal on each, and
// starts them from GitHub labels and `/woodshed` comments.
//
//   GET  /all                    Shared: the rail, and the shared sessions in the pane
//   GET  /s/<id>                 one session: the rail and its terminal
//   GET  /events                 the webhook events page
//   GET  /secrets                the secrets and webhook settings page
//   GET  /                       My Woodshed: your private sessions, and New session
//   GET  /settings               My settings: your Claude token
//   GET  /api/sessions           every shared session and your own private ones, without their tokens
//   GET  /api/my                 your settings' state (never a value), your running count and limit
//   POST /api/my/sessions        {"prompt", "name", "workOn", "model", "effort", "permissionMode", "project"}  a private session
//   GET  /api/my/projects        the projects you can start sessions on, and the one New session opens on for you
//   POST /api/my/projects/default {"project": "<name>"}   New session opens on it for you
//   POST /api/my/claude-token    {"value": "sk-ant-..."}
//   POST /api/my/codex-auth      {"value": "sk-..." or the text of ~/.codex/auth.json}
//   POST /api/my/codex-auth/remove
//   POST /api/my/claude-token/remove
//   POST /api/my/claude-token/shared {"on": true}   shared sessions you start from GitHub run on your token
//   POST /api/my/remove          {"confirm": "<your login>"}  Remove My Woodshed: stops your sessions, deletes your settings
//   GET  /api/my/pulls           your open pull requests, and those waiting on your review, for the rail
//   GET  /api/my/files/<file>    the console's shared file for one of the repo's env files or tmux-conf, and your own lines added after it
//   POST /api/my/files/<file>    {"text": "..."}   your own lines, for your next sessions; empty clears them
//   POST /api/my/files/<file>/reset                clears them: the console's file alone again
//   GET  /auth/connect           Connect GitHub: sign in once more and keep the token, so your sessions push as you
//   POST /api/my/github/identity {"name": "...", "email": "..."}   what your sessions' commits say
//   POST /api/my/github/disconnect
//   POST /api/my/home/forget     deletes your saved Claude home: MCP logins, memory, transcripts
//   POST /api/my/sessions/<id>/resume   a stopped private session again, claude's conversation and all
//   POST /api/my/sessions/<id>/remove   a private session (a running one is stopped first) off the list, with the Claude home it kept
//   POST /api/my/databases       your own databases, made, or copied from the template again ({"confirm": "reset"} once made)
//   POST /api/my/databases/restore?name=<file>   a pg_dump or mongodump as the body, restored into a copy of your database to check;
//                                POST /api/my/databases/restore/apply {"confirm": "apply"} swaps it in, /discard drops it (dbRestore.mjs)
//   POST /api/my/tunnel-token    a token for woodshed-db.mjs, shown once; POST /api/my/tunnel-token/remove revokes it
//   GET  /api/tunnel/connection, UPGRADE /api/tunnel/pg|mongo   your databases from your computer, by that token (dbTunnel.mjs)
//   POST /api/sessions           {"number": 123, "startedBy": "login", "prompt": "..."}
//   POST /api/sessions/<id>/stop
//   POST /api/sessions/<id>/pin     {"on": true}   pinned to the top of your rail; yours alone
//   POST /api/sessions/<id>/rename  {"title": "..."}   the name every page shows
//   POST /api/my/uploads?name=<file>   one file for your next New session, as the body; {"id"} names it in
//                                POST /api/my/sessions's "attachments" (attachments.mjs)
//   POST /api/sessions/<id>/upload?name=<file>&pane=agent|terminal|none   a file pasted or dropped on a terminal,
//                                saved in the session with its path typed at that pane's prompt (none: not typed)
//   POST /api/sessions/<id>/send    {"text": "..."}   the phone's message box: typed into claude, then Enter
//   GET  /api/sessions/<id>/image?path=<path>   a picture a terminal path names, from the session
//   POST /api/sessions/<id>/scroll  {"steps": -3, "pane": "agent"}   a phone's swipe on a terminal
//   GET  /api/skills             the repo's skills and commands, for New session's / list
//   GET  /api/sessions/<id>/applog  the end of the session's app logs: its start, the backend's and the frontend's
//   GET  /api/sessions/<id>/diff    the Diff tab: the checkout against the default branch, uncommitted work included, as a plain diff
//   GET  /review?session=claude-<id>, /reviews/claude-<id>/...   the Review tab: the shed's own review page and its calls,
//                                carried to the session that answers them (reviewProxy.mjs)
//   GET  /manifest.webmanifest, the icons   install as an app (the shed's pwa.mjs), before sign-in
//   POST /api/sessions/<id>/resume  {"message": "..."}  a stopped shared session again, its conversation and all
//   POST /api/sessions/<id>/delete  a shared session's conversation and databases, deleted now (a running one is stopped first)
//   POST /api/sessions/<id>/remove  a shared session already deleted, off the list for everyone
//   Admins only (members.mjs), with 403 for anyone else: /api/people*, /api/secrets*, /api/webhook*,
//   /api/console-settings*, the API behind People, Secrets & webhooks, Webhook events and Console settings.
//   GET  /api/webhook-events     what the console did with each queued webhook
//   GET  /api/secrets            each secret's state (never a value) and the GitHub App's webhook settings
//   GET/POST /api/secrets-manager  where this console keeps its secrets: {"kind": "local"|"aws", "prefix"}. Only where the
//                                local provider has no WOODSHED_LOCAL_SECRETS_DIR (providers/local/secretSlot.mjs)
//   POST /api/secrets/<name>/reveal
//   POST /api/secrets/<name>     {"value": "...", "confirm": "<name>"}
//   GET  /api/console-settings   the limits and retention numbers, the Slack channel, and the sessions holding data
//   GET  /api/people             who may sign in, and who asks to (members.mjs)
//   POST /api/people/invite|accept|decline|remove  {"login": "<handle>"}   an admin's change to that list
//   GET  /api/people/slack-search?q=ana   Slack members whose name or handle has that text, for the link's search box
//   POST /api/people/github-sessions  {"login": "<handle>", "on": true|false}   who starts sessions from GitHub and sees shared ones
//   POST /api/people/assignable  {"login": "<handle>", "on": true|false}   who may be assigned a shared session (needs the above)
//   POST /api/people/admin      {"login": "<handle>", "admin": true|false}   who is an admin; the last one keeps it
//   POST /api/sessions/<id>/assign  {"to": "<handle>"|null}   a change of who has a shared session, by someone who can be assigned
//   POST /api/people/slack       {"login": "<handle>", "slack": "U01ABC2DEF3" | "@handle" | ""}   links a member's Slack user by hand (slackPeople.mjs)
//   POST /api/access/ask|withdraw  a visitor, signed in but not on the list, asks to join or takes it back
//   POST /api/console-settings   {"values": {"maxRunning": 6, ...}, "slackChannel": "C..."}   one card's changes, all or none
//   POST /api/console-settings/projects         {"repo": "owner/name", "name": "optional"}   add a repo sessions can start on (addedProjects.mjs)
//   POST /api/console-settings/projects/remove  {"name": "<project>"}   take an added repo off
//   POST /api/console-settings/clean  {"kind": "stuck"|"databases"|"home", "id": "<session id>"}  a stalled row's fix
//   GET  /api/webhook/deliveries GitHub's last 10 deliveries to the App's webhook, with their status codes
//   POST /api/webhook/rotate     {"confirm": "github-webhook-secret"}
//   POST /api/webhook/apply      {"confirm": "webhook"}   the Lambda's URL and the stored secret, set on the App
//   POST /api/webhook/url        {"url": "https://...", "confirm": "webhook"}
//   *    /term/<id>/...          the session's ttyd on claude's tmux (the Agent tab), proxied with its credentials
//   *    /shell/<id>/...         its second ttyd, on a plain shell in the repo (the Terminal tab)
//   *    /redis/<id>/...         the session's redis-commander, through its statusd
//   *    /pg/<id>/..., /mongo/<id>/...   a session's pgweb and mongo-express, on the databases the console made for it
//   GET  /login, /auth/start, /auth/callback, POST /auth/sign-out   sign-in with GitHub (auth.mjs)
//   GET  /api/me                 who is signed in, and whether sign-in is on
//   POST /api/sessions/<id>/app/start  start the session's app
//   POST /api/sessions/<id>/app/stop   stop it
//   POST /api/sessions/<id>/claude-login   type woodshed-login at the session's Terminal tab (a My Woodshed session)
//   GET  /api/sessions/<id>/review     what the session's branch changes, from GitHub (review.mjs)
//   *    https://<id>.<app domain>/...  the session's running app, through its statusd (appProxy.mjs)
//   GET  /auth/app?id=&next=     a one-time code that signs this browser in to that app (auth.mjs)
//   GET  https://<id>.<app domain>/__woodshed/auth   claims the code: the app's own sign-in cookie
//   GET  /api/sessions/<id>/app-share   who else may open a My Woodshed session's app, and its links (owner only; appShares.mjs)
//   POST /api/sessions/<id>/app-share/members  {"on": true}   every signed-in member may open the app
//   POST /api/sessions/<id>/app-share/links    {"hours": 24}  a link anyone can open, with its expiry; the token is shown once
//   POST /api/sessions/<id>/app-share/links/<linkId>/revoke   ends one link
//   GET  https://<id>.<app domain>/__woodshed/share?t=<token>   claims a link: a cookie for that one app, until the link ends
//   *    https://<id>.<app domain>/__woodshed/code/...   the session's VS Code, through its statusd, websockets too:
//        Editor ↗, for whoever can open the session itself (editorProxy.mjs)
//
// In AWS it sits behind Caddy, open to the internet, and every page, API call and terminal needs a GitHub
// sign-in with write access (auth.mjs, always required there by WOODSHED_CLOUD_REQUIRE_SIGN_IN). Locally it
// listens on loopback and has no sign-in. Every request must name a host the console
// answers to, which stops DNS rebinding, and writes and terminal websockets must
// come from the console's own origin, checked with Woodshed's sameOrigin.mjs.
// Writes also need the `x-woodshed: 1` header, which a cross-site form cannot send. The console's own pages
// (People, secrets, webhook history, Console settings) are an admin's: ADMIN_API_RE below.
//
// A session started from My Woodshed is private: every route that reaches it (its page's data, terminal,
// Redis, app, review, Stop, the websockets) answers anyone but its owner as it would an id that does not exist.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostedEngines, viewersOf } from '../shared/databases/index.mjs';
import { handlePwaRequest, MANIFEST } from '../shared/pwa.mjs';
import { createReviewProxy, isReviewPath } from './reviewProxy.mjs';
import { isKnownHost, isSameOrigin } from '../shared/sameOrigin.mjs';
import { createAsks } from './asks.mjs';
import { CLIENT_SECRET, createAuth, safeNext, signInFailure } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { createAttachments, MAX_ATTACHMENT_BYTES } from './attachments.mjs';
import { createAutoNamer } from './autoName.mjs';
import { createPrChips } from './prChips.mjs';
import { createPullWebhooks } from './pullWebhooks.mjs';
import { createDatabaseGate } from './databaseGate.mjs';
import { createDatabases } from './databases.mjs';
import { createDbRestore } from './dbRestore.mjs';
import { createSlack } from './slack.mjs';
import { CONNECTION_PATH, createTunnel, tunnelTargetsFor } from './dbTunnel.mjs';
import { createFleet } from './fleet.mjs';
import { checkGh, createGitHub } from './github.mjs';
import { createAppApi } from './githubApp.mjs';
import { createAppIdentity } from './appIdentity.mjs';
import { applyStored, createGitHubAppSetup, supervisorOf } from './githubAppSetup.mjs';
import { createAnthropicProxy } from './anthropicProxy.mjs';
import { createOpenAiProxy } from './openaiProxy.mjs';
import { createSessionApi } from './sessionApi.mjs';
import { createReviewSource } from './review.mjs';
import { createConsoleSettings, liveConfig } from './consoleSettings.mjs';
import { createHeldData } from './heldData.mjs';
import { ACTIVE_STATUSES, activePrivateCount, canSee, publicSession, sharedRunningCount } from './sessions.mjs';
import { APP_KEY_SECRET, WEBHOOK_SECRET, createSettings } from './settings.mjs';
import { openStore } from './store.mjs';
import { createGitHubUser } from './githubUser.mjs';
import { createClaudeSettings } from './claudeSettings.mjs';
import { createProjectReader } from './projectFile.mjs';
import { createUserSettings } from './userSettings.mjs';
import { createViewPrefs } from './viewPrefs.mjs';
import { createGitHubPeople } from './githubPeople.mjs';
import { createSlackPeople } from './slackPeople.mjs';
import { createAssigneePings } from './assigneePings.mjs';
import { createMembers, parseHandle } from './members.mjs';
import { handleTerminalRequest, handleTerminalUpgrade } from './terminalProxy.mjs';
import { appIdFor, handleAppRequest, handleAppUpgrade } from './appProxy.mjs';
import { handleEditorRequest, handleEditorUpgrade, isEditorPath } from './editorProxy.mjs';
import { startTlsAsk } from './tlsAsk.mjs';
import { createAppShares } from './appShares.mjs';
import { providerMetaContent } from './providerWords.mjs';
import { createWebhookDispatch } from './webhookDispatch.mjs';
import { createWebhookEvents, SWEEP_MS as EVENTS_SWEEP_MS } from './webhookEvents.mjs';
import { createProjectTokens } from './projectTokens.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import { createAddedProjects, repoChecker } from './addedProjects.mjs';
import { allProjects, defaultProject, projectFor } from './projects.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
// /, /all and a session's page are one page, session.js last.
const SHELL_SCRIPTS = ['terminalCache.js', 'terminal.js', 'launcher.js', 'sharedHome.js', 'messageBox.js', 'appShare.js', 'session.js'];
const STATIC_FILES = {
  'style.css': 'text/css; charset=utf-8',
  'logins.cjs': 'text/javascript; charset=utf-8',
  'setupSteps.cjs': 'text/javascript; charset=utf-8',
  'inviteLink.cjs': 'text/javascript; charset=utf-8',
  'common.js': 'text/javascript; charset=utf-8',
  'theme.js': 'text/javascript; charset=utf-8',
  'shell.js': 'text/javascript; charset=utf-8',
  'terminalCache.js': 'text/javascript; charset=utf-8',
  'terminal.js': 'text/javascript; charset=utf-8',
  'sharedHome.js': 'text/javascript; charset=utf-8',
  'messageBox.js': 'text/javascript; charset=utf-8',
  'appShare.js': 'text/javascript; charset=utf-8',
  'session.js': 'text/javascript; charset=utf-8',
  'events.js': 'text/javascript; charset=utf-8',
  'secrets.js': 'text/javascript; charset=utf-8',
  'webhookSetup.js': 'text/javascript; charset=utf-8',
  'githubSetup.js': 'text/javascript; charset=utf-8',
  'login.js': 'text/javascript; charset=utf-8',
  'launcher.js': 'text/javascript; charset=utf-8',
  'mySettings.js': 'text/javascript; charset=utf-8',
  'dbRestore.js': 'text/javascript; charset=utf-8',
  'dbRestoreStates.js': 'text/javascript; charset=utf-8',
  'consoleSettings.js': 'text/javascript; charset=utf-8',
  'people.js': 'text/javascript; charset=utf-8',
  // Run on people's own computers, so it is served before sign-in; it holds nothing secret.
  'woodshed-db.mjs': 'text/javascript; charset=utf-8',
};
const MAX_BODY_BYTES = 16 * 1024;
// A whole .env file, JSON-escaped, under Secrets Manager's 64 KB.
const MAX_SECRET_BODY_BYTES = 160 * 1024;
const PEOPLE_RE = /^\/api\/people\/(invite|accept|decline|remove|slack|assignable|github-sessions|admin)$/;
const SESSION_PAGE_RE = /^\/s\/([0-9a-f]{8})$/;
const MY_CODEX_AUTH_RE = /^\/api\/my\/codex-auth(?:\/(remove))?$/;
const MY_LIMITS_PATH = '/api/my/limits';
const PROJECTS_PATH = '/api/console-settings/projects';
const MY_DEFAULT_PROJECT_PATH = '/api/my/projects/default';
const MY_TOKEN_RE = /^\/api\/my\/claude-token(?:\/(remove|shared))?$/;
const PULLS_FRESH_MS = 60_000;
const MY_FILE_RE = /^\/api\/my\/files\/([a-z-]+)(\/reset)?$/;
const MY_GITHUB_RE = /^\/api\/my\/github\/(identity|disconnect)$/;
const MY_SESSION_ACTION_RE = /^\/api\/my\/sessions\/([0-9a-f]{8})\/(resume|remove)$/;
const MY_TUNNEL_RE = /^\/api\/my\/tunnel-token(\/remove)?$/;
const MY_RESTORE_RE = /^\/api\/my\/databases\/restore\/(apply|discard)$/;
// A whole .env file, JSON-escaped, under Secrets Manager's 64 KB.
const MAX_FILE_BODY_BYTES = 160 * 1024;
const DATABASES_NOT_READY = 'your own databases are not ready yet: My settings shows how far along they are';
const STOP_RE = /^\/api\/sessions\/([0-9a-f]{8})\/stop$/;
const ASSIGN_RE = /^\/api\/sessions\/([0-9a-f]{8})\/assign$/;
const SHARED_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(resume|delete|remove)$/;
const VIEW_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(pin|rename)$/;
const TERMINAL_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(upload|image|scroll|send|applog|diff)$/;
// The skills in the repo change with a merge; an hour is soon enough for a / list.
const SKILLS_FRESH_MS = 60 * 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
// The shed's mark and install details, under the console's name. Served before sign-in: a browser fetches the
// manifest without cookies.
const CONSOLE_MANIFEST = JSON.stringify({ ...MANIFEST, name: 'Woodshed Cloud', short_name: 'Woodshed Cloud', description: 'Claude sessions in containers.' }, null, 2);
const PWA_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
const MAX_RESUME_MESSAGE_CHARS = 4000;
const CLAUDE_LOGIN_RE = /^\/api\/sessions\/([0-9a-f]{8})\/claude-login$/;
const APP_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/app\/(start|stop)$/;
const REVIEW_RE = /^\/api\/sessions\/([0-9a-f]{8})\/review$/;
const SECRET_RE = /^\/api\/secrets\/([a-z0-9-]+)(\/reveal)?$/;
const SETUP_WRITE_RE = /^\/api\/setup\/github\/(manifest|paste|installation|restart)$/;
const WEBHOOK_RE = /^\/api\/webhook\/(rotate|apply|url)$/;
// The calls behind People, Secrets & webhooks, Webhook events and Console settings. Their pages load for anyone signed
// in, and say what these calls answer.
const ADMIN_API_RE = /^\/api\/(?:people|secrets|secrets-manager|webhook|console-settings|setup)(?:\/|$)|^\/api\/webhook-events$/;
const APP_ID_RE = /^[0-9a-f]{8}$/;
const APP_AUTH_PATH = '/__woodshed/auth';
const APP_SHARE_PATH = '/__woodshed/share';
const APP_SHARE_RE = /^\/api\/sessions\/([0-9a-f]{8})\/app-share(?:\/(members|links)(?:\/([0-9a-f]{8})\/(revoke))?)?$/;

/**
 * @param {{host: string, publicUrl: string, extraHosts: string[]}} config
 * @returns {string[]}  the names a request may arrive by: loopback, this machine, the public URL's host
 */
export function knownHosts({ host, publicUrl, extraHosts }) {
  const names = ['localhost', '127.0.0.1', '::1', os.hostname(), new URL(publicUrl).hostname, ...extraHosts];
  if (host !== '0.0.0.0' && host !== '::') names.push(host);
  return names.filter(Boolean);
}

// A static file's URL carries a hash of its contents, so the browser keeps it until a deploy changes it rather than
// fetching every script again on each page. Keyed by mtime, so an edited file gets a new hash without a restart.
const staticHashes = new Map();
function staticHash(file) {
  const full = path.join(PUBLIC_DIR, file);
  const { mtimeMs } = fs.statSync(full);
  if (staticHashes.get(file)?.mtimeMs !== mtimeMs) {
    staticHashes.set(file, { mtimeMs, hash: createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 12) });
  }
  return staticHashes.get(file).hash;
}

/** @returns {string}  the file's URL, versioned */
function staticUrl(file) {
  return `/static/${file}?v=${staticHash(file)}`;
}

/**
 * @param {{title: string, script: string|string[], login?: string|null, provider?: {name: string, words?: object}|null}} args
 *   the page's scripts, loaded in order after common.js; `provider`'s words are what the page says about where
 *   sessions run (providerWords.mjs), the defaults where it has none
 * @returns {string}  the page shell; the script renders everything from /api/sessions
 */
export function pageShell({ title, script, login = null, provider = null }) {
  // Whose page it is, for session.js to draw from what it kept only for the same person. A GitHub login, or nothing.
  const who = /^[A-Za-z0-9-]{1,39}$/.test(String(login ?? '')) ? `\n<meta name="woodshed-login" content="${login}">` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${who}
<meta name="woodshed-provider" content="${providerMetaContent(provider)}">
<title>${title}</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1b2232">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Woodshed Cloud">
<script src="${staticUrl('theme.js')}"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Red+Hat+Display:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="${staticUrl('style.css')}">
</head>
<body>
<div id="app"></div>
<script src="${staticUrl('logins.cjs')}"></script>
<script src="${staticUrl('setupSteps.cjs')}"></script>
<script src="${staticUrl('inviteLink.cjs')}"></script>
<script src="${staticUrl('common.js')}"></script>
<script src="${staticUrl('shell.js')}"></script>
${[script].flat().map((s) => `<script src="${staticUrl(s)}"></script>`).join('\n')}
</body>
</html>
`;
}

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "frame-ancestors 'none'",
  });
  res.end(body);
}

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function appUrl(config, id, path) {
  return `https://${id}.${config.appDomain}${path}`;
}

function linkExpiredPage(id, publicUrl) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Sign-in link expired</title>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">That sign-in link has expired</h1>
<p>Open the app again from its session's page.</p>
<p><a href="${publicUrl}/s/${id}">Open session ${id} in the console</a></p>`;
}

function shareLinkEndedPage(id, publicUrl) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Link ended</title>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">This link has expired or was turned off</h1>
<p>Ask the person who shared it for a new one.</p>
<p>A member of the console can <a href="${publicUrl}/auth/app?id=${id}">sign in</a> instead, when the app is shared with members.</p>`;
}

/**
 * Websockets to a session's app. Once sign-in is required they need the app's own cookie, as its pages do.
 * @param {{config: object, fleet: object, auth?: object|null}} deps
 */
export function createAppUpgrade({ config, fleet, auth = null, members = null, appShares = null }) {
  return function appUpgrade(req, socket, head, id) {
    if (isEditorPath(new URL(req.url || '/', 'http://app.invalid').pathname)) return editorUpgrade(req, socket, head, id);
    const allowed = auth?.enabled()
      ? appViewerFor({ auth, appShares, cookieHeader: req.headers.cookie, appId: id })
      : Promise.resolve({ login: soloLoginOf(config), link: false });
    allowed.then((viewer) => {
      if (!viewer) {
        console.warn('app: websocket refused, not signed in', { id });
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      const targetFor = appTarget({ fleet, login: viewer.login, members: auth ? members : null, shares: appShares, link: viewer.link });
      handleAppUpgrade(req, socket, head, { id, targetFor, dropCookie: [auth?.appCookie, appShares?.cookieName] });
    }, () => socket.destroy());
  };

  // The editor's websocket: the app's own sign-in, never a share link's cookie.
  function editorUpgrade(req, socket, head, id) {
    const user = auth?.enabled() ? auth.appSessionFor({ cookieHeader: req.headers.cookie, appId: id }) : Promise.resolve({ login: soloLoginOf(config) });
    user.then((viewer) => {
      if (!viewer) {
        console.warn('editor: websocket refused, not signed in', { id });
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      handleEditorUpgrade(req, socket, head, { id, target: editorTarget({ fleet, login: viewer.login, members: auth ? members : null, id }) });
    }, () => socket.destroy());
  }
}

/**
 * @param {{config: object, fleet: object, settings?: ReturnType<typeof createSettings>|null,
 *          events?: {list: () => object[]}, review?: ReturnType<typeof createReviewSource>|null,
 *          people?: {names: (logins: Iterable<string>) => Record<string, string>}|null}} deps
 *   `settings` only where the Secrets page works (AWS); `people` gives the pages each handle's display name
 */
export function createHandler({
  config, fleet, settings = null, events = { list: () => [] }, auth = null, review = null, userSettings = null, github = null,
  githubUser = null, homes = null, databases = null, tunnel = null, slack = null, consoleSettings = null, heldData = null,
  people = null, slackPeople = null, claudeSettings = null, viewPrefs = null, attachments = null, prChips = null, members = null, asks = null,
  dbRestore = null, githubSetup = null, secrets = null, appShares = null, provider = null, appIdentity = null, databaseGate = null, projectAccess = null, addedProjects = null,
}) {
  const hosts = knownHosts(config);
  const soloLogin = soloLoginOf(config);
  // Who may open a shared session is the People list's to say, once sign-in tells people apart.
  const access = auth ? members : null;
  let skillsCache = null;
  // One read of GitHub at a time: every keystroke after `/` asks.
  let skillsReading = null;
  const otherPublicNames = new Set(config.extraHosts);
  // Each person's pull requests, for a minute: every My Woodshed page asks on each refresh.
  const pullsCache = new Map();

  // The pages show these in place of each handle; a handle with none shows as @handle.
  // A Slack asker is `slack:<id>`, named by asks.mjs: GitHub has no such handle.
  function namesFor(logins) {
    const all = logins.filter(Boolean);
    const github = all.filter((l) => !l.startsWith('slack:'));
    return { ...(people ? people.names(github) : {}), ...(asks ? asks.names(all.filter((l) => l.startsWith('slack:'))) : {}) };
  }

  function hostnameOf(hostHeader) {
    try {
      return new URL(`http://${hostHeader}`).hostname;
    } catch {
      return null;
    }
  }

  // A console with no sign-in, or no list of people, has nobody to tell apart: everyone is an admin there. So is
  // everyone on a list with no admin yet, so the first can be switched on; setAdmin keeps the last one from going.
  function isAdminLogin(login) {
    return !auth?.enabled() || !login || !members || !members.hasAdmin() || members.isAdmin(login);
  }

  function redirect(res, location, setCookie) {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...(setCookie ? { 'set-cookie': setCookie } : {}) });
    res.end();
  }

  // The sign-in routes, open to anyone who reaches the console. Answers and returns true for its own paths.
  async function authRoute(req, res, url) {
    const { pathname } = url;
    if (pathname === '/login' && req.method === 'GET') {
      html(res, pageShell({ title: 'Woodshed Cloud', script: 'login.js' }));
      return true;
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      const user = auth?.available() ? await auth.sessionFor(req.headers.cookie) : null;
      // Signed in with write access but not on the list: the login page offers to ask to join.
      const visitor = !user && auth?.available() && auth.visitorFor ? await auth.visitorFor(req.headers.cookie) : null;
      reply(res, 200, {
        supported: Boolean(auth), signIn: Boolean(auth?.enabled()), available: Boolean(auth?.available()), login: user?.login ?? null,
        visitor: visitor?.login ?? null, asked: visitor && members ? members.requestOf(visitor.login)?.askedAt ?? null : null,
        // Without sign-in turned on the server lets everyone through (signedIn gives no login), so the menu says the same.
        admin: !auth?.enabled() || Boolean(user && isAdminLogin(user.login)),
        asking: user && members && isAdminLogin(user.login) ? members.view().requests.length : 0,
        names: namesFor([user?.login ?? visitor?.login]),
        // The menu's workflow links. A signed-out browser is not told which repo this is: it may be private.
        repo: user || !auth?.enabled() ? defaultProject(config).repo : null,
        workflows: user || !auth?.enabled() ? (config.actionsWorkflows ?? []) : [],
      });
      return true;
    }
    if ((pathname === '/api/access/ask' || pathname === '/api/access/withdraw') && req.method === 'POST') {
      await accessRequest(req, res, pathname);
      return true;
    }
    if (!auth) return false;
    if (pathname === '/auth/start' && req.method === 'GET') {
      if (!auth.available()) {
        redirect(res, '/login');
        return true;
      }
      const { location, setCookie } = await auth.start(url.searchParams.get('next'));
      redirect(res, location, setCookie);
      return true;
    }
    if (pathname === '/auth/callback' && req.method === 'GET') {
      try {
        const { next, setCookies } = await auth.callback({
          code: url.searchParams.get('code'), state: url.searchParams.get('state'), cookieHeader: req.headers.cookie,
        });
        redirect(res, next, setCookies);
      } catch (err) {
        const { fault, message } = signInFailure(err);
        // A refusal logged its own line in auth.mjs. The console's failure is logged here, and never shown on the page.
        if (fault === 'console') console.error('auth: sign-in failed', { fault, step: err?.step ?? null, message: String(err?.message ?? err).split('\n')[0] });
        redirect(res, `/login?error=${encodeURIComponent(message)}${err?.next ? `&next=${encodeURIComponent(err.next)}` : ''}`);
      }
      return true;
    }
    if (pathname === '/auth/sign-out' && req.method === 'POST') {
      if (!isSameOrigin(req.headers)) {
        reply(res, 403, { error: 'sign out from the console itself' });
        return true;
      }
      res.writeHead(303, { location: '/login', 'set-cookie': auth.signOut(req.headers.cookie), 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    return false;
  }

  // A visitor, signed in with write access but not on the list, asks to join or takes the request back.
  async function accessRequest(req, res, pathname) {
    if (req.headers['x-woodshed'] !== '1' || !isSameOrigin(req.headers)) return reply(res, 403, { error: 'ask from the console itself' });
    const visitor = auth && members ? await auth.visitorFor(req.headers.cookie) : null;
    if (!visitor) return reply(res, 401, { error: 'sign in first' });
    if (members.isMember(visitor.login)) return reply(res, 200, { member: true });
    if (pathname === '/api/access/ask') members.ask({ login: visitor.login });
    else members.withdraw({ login: visitor.login });
    return reply(res, 200, { member: false, asked: members.requestOf(visitor.login)?.askedAt ?? null });
  }

  function peopleReply(res) {
    if (!members) return reply(res, 404, { error: 'this console has no list of people' });
    const view = members.view();
    const logins = [...view.members, ...view.requests].flatMap((p) => [p.login, p.addedBy]).filter(Boolean);
    return reply(res, 200, { ...view, names: namesFor(logins), slack: slackPeople ? slackPeople.links(view.members.map((m) => m.login)) : null });
  }

  async function slackSearchReply(res, query) {
    if (!members || !slackPeople) return reply(res, 404, { error: 'this console has no Slack' });
    try {
      return reply(res, 200, await slackPeople.search({ query }));
    } catch (err) {
      if (err.shown) return reply(res, 400, { error: err.message });
      console.error('console: Slack members not searched', { message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'Slack did not answer; try again' });
    }
  }

  async function peopleSlack(res, { handle, value, by }) {
    if (!slackPeople) return reply(res, 404, { error: 'this console has no Slack' });
    if (!members.isMember(handle)) return reply(res, 404, { error: `@${handle} is not a member` });
    try {
      await slackPeople.setManual({ login: handle, value, by });
    } catch (err) {
      if (err.shown) return reply(res, 400, { error: err.message });
      console.error('console: Slack user not looked up', { login: handle, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'Slack did not answer; try again' });
    }
    return peopleReply(res);
  }

  // Can be assigned, and sessions from GitHub, which it needs. Off for either gives their sessions back to Unassigned,
  // where anyone who can be assigned takes them.
  function peopleSwitch(res, { handle, on, by, set }) {
    if (typeof on !== 'boolean') return reply(res, 400, { error: 'on must be true or false' });
    try {
      set({ login: handle, on, by });
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
    }
    if (!on) fleet.releaseAssignments?.({ login: handle, by });
    return peopleReply(res);
  }

  function peopleAdmin(res, { handle, admin, by }) {
    if (typeof admin !== 'boolean') return reply(res, 400, { error: 'admin must be true or false' });
    try {
      members.setAdmin({ login: handle, admin, by });
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
    }
    return peopleReply(res);
  }

  // An admin invites, accepts, declines and removes: handle() lets nobody else this far.
  async function peopleWrite(req, res, pathname, login) {
    if (!members) return reply(res, 404, { error: 'this console has no list of people' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    const handle = parseHandle(body?.login);
    if (!handle) return reply(res, 400, { error: 'login must be a GitHub handle' });
    const action = pathname.split('/').pop();
    if (action === 'slack') return peopleSlack(res, { handle, value: body?.slack, by: login });
    if (action === 'assignable') return peopleSwitch(res, { handle, on: body?.on, by: login, set: members.setAssignable });
    if (action === 'github-sessions') return peopleSwitch(res, { handle, on: body?.on, by: login, set: members.setGithubSessions });
    if (action === 'admin') return peopleAdmin(res, { handle, admin: body?.admin, by: login });
    if (action === 'invite' && github) {
      // Write access is still what lets someone in, so a handle without it would be invited for nothing.
      let writes;
      try {
        writes = await github.canWrite(handle);
      } catch (err) {
        console.error('console: write access not checked for an invite', { login: handle, message: String(err?.message ?? err).split('\n')[0] });
        return reply(res, 502, { error: 'GitHub did not answer; try again' });
      }
      if (!writes) return reply(res, 400, { error: `@${handle} has no write access to the repository, so could not sign in` });
    }
    try {
      members[action]({ login: handle, by: login });
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
    }
    if (action === 'remove') {
      fleet.releaseAssignments?.({ login: handle, by: login });
      // Their token is refused from now on (createTunnel's `allowed`); this also closes the tunnels already open.
      tunnel?.revoke(handle);
    }
    return peopleReply(res);
  }

  // Once sign-in is on, every page, API call and terminal needs a session; the login page's own files do not.
  // @returns {Promise<{login: string|null}|null>}  who is asking (login null with sign-in off), or null once answered
  async function signedIn(req, res, url) {
    if (!auth?.enabled() || url.pathname === '/healthz' || url.pathname.startsWith('/static/')) return { login: soloLogin };
    const user = await auth.sessionFor(req.headers.cookie);
    if (user) return user;
    const page = req.method === 'GET' && !url.pathname.startsWith('/api/') && String(req.headers.accept || '').includes('text/html');
    if (page) redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    else reply(res, 401, { error: 'sign in first' });
    return null;
  }

  // A session's app, on its own name. Once sign-in is required, it asks the console who you are first.
  async function appRequest(req, res, id) {
    const dropCookie = [auth?.appCookie, appShares?.cookieName];
    const ctx = ({ login, link = false }) => ({ id, targetFor: appTarget({ fleet, login, members: access, shares: appShares, link }), publicUrl: config.publicUrl, dropCookie });
    const url = new URL(req.url || '/', 'http://app.invalid');
    if (isEditorPath(url.pathname)) return editorRequest(req, res, id, url);
    if (!auth?.enabled()) return handleAppRequest(req, res, ctx({ login: soloLogin }));
    if (url.pathname === APP_AUTH_PATH && req.method === 'GET') {
      const claimed = await auth.claimAppCode({ code: url.searchParams.get('code') || '', appId: id });
      if (!claimed) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(linkExpiredPage(id, config.publicUrl));
      }
      return redirect(res, safeNext(url.searchParams.get('next')), claimed.setCookie);
    }
    if (url.pathname === APP_SHARE_PATH && req.method === 'GET' && appShares) {
      const claimed = appShares.claim({ token: url.searchParams.get('t') || '', appId: id });
      if (!claimed) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(shareLinkEndedPage(id, config.publicUrl));
      }
      // The token leaves the address bar at once, and no page the app links to is told where it came from.
      res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': claimed.setCookie });
      return res.end();
    }
    const viewer = await appViewerFor({ auth, appShares, cookieHeader: req.headers.cookie, appId: id });
    if (viewer) return handleAppRequest(req, res, ctx(viewer));
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 401, { error: 'sign in first: open the app from the console' });
    console.log('app: sending to the console to sign in', { id });
    return redirect(res, `${config.publicUrl}/auth/app?id=${id}&next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  // The editor, on the app's name, for whoever can open the session itself: the app's sign-in cookie says who, and a
  // share link's cookie never counts (editorProxy.mjs).
  async function editorRequest(req, res, id, url) {
    const viewer = auth?.enabled() ? await auth.appSessionFor({ cookieHeader: req.headers.cookie, appId: id }) : { login: soloLogin };
    if (!viewer) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 401, { error: 'sign in first: open the editor from the console' });
      console.log('editor: sending to the console to sign in', { id });
      return redirect(res, `${config.publicUrl}/auth/app?id=${id}&next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    const target = editorTarget({ fleet, login: viewer.login, members: access, id });
    if (!target && url.pathname === `/__woodshed/code/`) console.log('editor: refused, the viewer cannot open the session or it is not running', { id });
    return handleEditorRequest(req, res, { id, target });
  }

  // The console's side of an app's sign-in: a signed-in browser leaves with a code for that one app.
  async function appSignIn(req, res, url, login) {
    const id = url.searchParams.get('id') || '';
    const next = safeNext(url.searchParams.get('next'));
    if (!config.appDomain || !APP_ID_RE.test(id) || !findAppFor(id, login)) return reply(res, 404, { error: 'no such session' });
    if (!auth?.enabled()) return redirect(res, appUrl(config, id, next));
    const code = await auth.appCode({ cookieHeader: req.headers.cookie, appId: id });
    if (!code) return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return redirect(res, appUrl(config, id, `${APP_AUTH_PATH}?code=${code}&next=${encodeURIComponent(next)}`));
  }

  /** @returns {object|null}  the session, unless it is someone else's private one, or shared and they have no shared view */
  function findFor(id, login) {
    const session = fleet.find(id);
    return session && canOpen(session, login, access) ? session : null;
  }

  /** @returns {object|null}  the session when `login` may open its app: findFor's, or a private session its owner shared with members */
  function findAppFor(id, login) {
    const session = fleet.find(id);
    return session && canOpenApp(session, login, access, appShares?.membersOpen(id)) ? session : null;
  }

  /** @returns {boolean}  whether `login` sees shared sessions and the Everyone tab */
  function seesShared(login) {
    return !login || !access || access.hasGithubSessions(login);
  }

  const proxyReview = createReviewProxy({ findFor });

  // Every shared session for someone with sessions from GitHub, and the asker's own private ones. The counts are the
  // fleet's, which say nothing of whose.
  function sessionsBody(login) {
    const all = fleet.sessions();
    const sessions = all.filter((s) => canOpen(s, login, access));
    const slackWaiting = fleet.slackWaiting?.() ?? new Set();
    return {
      repo: defaultProject(config).repo,
      // The rail names each session's project only when there is more than one to tell apart.
      projects: allProjects(config).map((p) => p.name),
      label: config.label,
      maxRunning: config.maxRunning,
      login,
      appDomain: config.appDomain || null,
      // What Data ▾ offers: the viewers of the databases each session has a copy of.
      databases: databases?.available ? databases.engines : [],
      viewers: databases?.available ? viewersOf(databases.engines).filter((v) => !v.own).map(({ route, name, program }) => ({ route, name, program })) : [],
      idleHours: config.limits.idleMs / 3_600_000,
      askIdleHours: config.limits.askIdleMs / 3_600_000,
      lifetimeHours: config.limits.lifetimeMs / 3_600_000,
      // The asker's own, which only their private sessions use.
      myIdleHours: (login && userSettings?.limitsFor(login).idleMs / 3_600_000) || null,
      afterCloseDays: (config.retention?.afterCloseMs ?? 3 * 86_400_000) / 86_400_000,
      maxPrivate: config.maxPrivatePerPerson,
      // The slots are shared sessions' alone: My Woodshed's start at once.
      running: sharedRunningCount(all),
      queued: all.filter((s) => s.status === 'queued' && !s.owner).length,
      sessions: sessions.map((s) => ({ ...publicSession(s), project: projectFor(config, s).name, slackWaiting: slackWaiting.has(s.id), pr: prChips?.view(s.prUrl) ?? null })).reverse(),
      // Who may have a shared session, and whether the asker is one: the Assign menu and the rail's Mine read them.
      // `shared` is whether the rail has an Everyone tab.
      assignables: members?.assignables() ?? [],
      assignable: Boolean(login && members?.isAssignable(login)),
      shared: seesShared(login),
      names: namesFor([login, ...(members?.assignables() ?? []), ...sessions.flatMap((s) => [s.startedBy, s.plan, s.assignee])]),
      viewPrefs: viewPrefs?.view(login, new Set(sessions.map((s) => s.id))) ?? null,
    };
  }

  // Assign, take it, hand over or unassign: for someone who can be assigned, on a shared session they can see.
  async function assignAction(req, res, id, login) {
    const session = findFor(id, login);
    if (!session || session.owner) return reply(res, 404, { error: 'no such session' });
    if (!login) return reply(res, 400, { error: 'sign in to assign a session' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (body?.to !== null && typeof body?.to !== 'string') return reply(res, 400, { error: 'to must be the handle of someone who can be assigned, or null to unassign' });
    try {
      fleet.assign({ id, by: login, to: body.to });
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
    }
    return reply(res, 200, publicSession(session));
  }

  async function reviewReply(res, session) {
    if (!session) return reply(res, 404, { error: 'no such session' });
    if (!review) return reply(res, 404, { error: 'this console has no GitHub access, so no review' });
    try {
      return reply(res, 200, await review(session));
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      console.warn('console: review not readable', { id: session.id, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'GitHub did not answer: try again in a moment' });
    }
  }

  // Every change names what it changes, typed by hand on the page, so a stray or replayed call does nothing.
  async function settingsWrite(req, res, pathname) {
    if (!settings) return reply(res, 404, { error: 'the Secrets page needs a secrets manager and the GitHub App' });
    let body;
    try {
      body = await readJson(req, MAX_SECRET_BODY_BYTES);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    const secretMatch = SECRET_RE.exec(pathname);
    const action = WEBHOOK_RE.exec(pathname)?.[1];
    const name = secretMatch?.[1];
    const expected = secretMatch ? name : action === 'rotate' ? WEBHOOK_SECRET : 'webhook';
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    const confirmed = Boolean(secretMatch?.[2]) || body.confirm === expected;
    if (!confirmed) return reply(res, 400, { error: `type ${expected} to confirm` });
    try {
      if (secretMatch?.[2]) return reply(res, 200, { value: await settings.reveal(name) });
      if (secretMatch) await settings.replace(name, body.value);
      else if (action === 'rotate') await settings.rotateWebhookSecret();
      else if (action === 'apply') await settings.applyWebhook();
      else await settings.setWebhookUrl(body.url);
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      console.error('console: settings change failed', { pathname, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'The secret store or GitHub refused the change; the console log says why' });
    }
    console.log('console: settings changed', { pathname });
    return reply(res, 200, { ok: true });
  }

  // `canChoose` only where the dashboard picks the store (providers/local/secretSlot.mjs): elsewhere it is fixed by
  // settings, and is the provider's own (Secrets Manager on AWS, sealed files on local), so its kind is the provider's.
  function managerView() {
    const canChoose = typeof secrets?.configure === 'function';
    const fixed = secrets && provider?.name ? { kind: provider.name } : {};
    return { canChoose, configured: secrets ? secrets.configured?.() !== false : false, ...(canChoose ? secrets.describe() : fixed) };
  }

  // GitHub sends the browser back from creating the App with a code; the page that follows says how it went.
  async function githubSetupCreated(res, url) {
    if (!githubSetup) return redirect(res, '/setup/github');
    try {
      await githubSetup.completeManifest({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      return redirect(res, '/setup/github?created=1');
    } catch (err) {
      if (!err.shown) console.error('console: GitHub App creation failed', { message: String(err?.message ?? err).split('\n')[0] });
      return redirect(res, `/setup/github?error=${encodeURIComponent(err.shown ? err.message : 'the console could not keep the App: its log says why')}`);
    }
  }

  async function githubSetupWrite(req, res, pathname, login) {
    if (!githubSetup) return reply(res, 404, { error: 'this console has no secret store, so it cannot keep a GitHub App' });
    let body;
    try {
      body = await readJson(req, MAX_SECRET_BODY_BYTES);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    try {
      const action = pathname.split('/').pop();
      if (action === 'manifest') return reply(res, 200, githubSetup.startManifest({ ownerType: body.ownerType }));
      if (action === 'paste') return reply(res, 200, { ...(await githubSetup.saveManual(body)), ...(await githubSetup.view()) });
      if (action === 'restart') return reply(res, 202, githubSetup.restart({ by: login ?? null }));
      return reply(res, 200, await githubSetup.findInstallation({ installationId: body.installationId }));
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      console.error('console: GitHub App setup failed', { pathname, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'GitHub or the secret store refused it; the console log says why' });
    }
  }

  async function managerWrite(req, res, login) {
    if (typeof secrets?.configure !== 'function') return reply(res, 404, { error: 'this console\'s secrets manager is set by its settings, not on the page' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    try {
      await secrets.configure({ kind: body.kind, prefix: body.prefix });
    } catch (err) {
      if (!err.shown) throw err;
      return reply(res, 409, { error: err.message });
    }
    console.log('console: secrets manager chosen', { kind: body.kind, by: login ?? 'console' });
    return reply(res, 200, managerView());
  }

  // The projects for New session and My settings. A console made without projectAccess (tests, old callers) has one.
  async function projectsView(login) {
    if (projectAccess) return projectAccess.view(login);
    const { name, repo } = defaultProject(config);
    return { projects: [{ name, repo }], defaultProject: name, saved: false };
  }

  function myView(login) {
    const view = userSettings ? userSettings.view(login) : { claudeToken: { set: false, savedAt: null }, codexAuth: { set: false, savedAt: null }, setUp: false, available: false };
    return {
      login, ...view, databases: databases?.view(login) ?? null, databasesRefusal: databaseGate?.last() ?? null, restore: dbRestore?.view(login) ?? null, tunnel: tunnel?.view(login) ?? null, running: activePrivateCount(fleet.sessions(), login),
      limit: config.maxPrivatePerPerson, limitDefaults: { idleHours: config.limits.idleMs / 3_600_000, lifetimeHours: config.limits.lifetimeMs / 3_600_000 }, names: namesFor([login]),
      // A console with a secret store and no GitHub App: the setup card sends whoever opens it to /setup/github.
      githubSetupNeeded: Boolean(githubSetup?.available()),
      // Who sessions push as without the person's own GitHub, `<slug>[bot]`: each installation names its App.
      app: appIdentity?.known() ?? null,
    };
  }

  async function pullsReply(res, login) {
    if (!login || !github) return reply(res, 200, { pulls: [] });
    const cached = pullsCache.get(login);
    if (cached && Date.now() - cached.at < PULLS_FRESH_MS) return reply(res, 200, { pulls: cached.pulls });
    try {
      const pulls = await github.openPullsFor(login);
      pullsCache.set(login, { at: Date.now(), pulls });
      return reply(res, 200, { pulls });
    } catch (err) {
      console.warn('console: pull requests not readable', { login, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 200, { pulls: cached?.pulls ?? [], stale: true });
    }
  }

  async function fileReply(res, login, key) {
    if (!login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    if (!userSettings) return reply(res, 404, { error: 'this console has no secret store, so there are no files to keep' });
    try {
      return reply(res, 200, await userSettings.file(login, key));
    } catch (err) {
      if (err.shown) return reply(res, 404, { error: err.message });
      console.error('console: file not readable', { login, key, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'The secret store did not answer: try again in a moment' });
    }
  }

  function databasesReady(login) {
    return !databases?.available || databases.view(login).status === 'ready';
  }

  // The Claude token is what makes My Woodshed usable, so saving the first one starts making the databases too. A
  // failure here is shown on My settings, which can try again; the token is saved either way.
  async function firstDatabases(login) {
    if (!databases?.available || databases.view(login).status !== 'none') return;
    try {
      await databases.create(login);
    } catch (err) {
      console.error('console: own databases not started', { login, message: String(err?.message ?? err).split('\n')[0] });
    }
  }

  // Remove My Woodshed: the settings go first, so a session that starts in between finds no token and fails.
  async function removeMine(res, login, body) {
    if (body.confirm !== login) return reply(res, 400, { error: `type ${login} to confirm` });
    // A restore's CREATE DATABASE could land after the drop, leaving a database nothing would ever remove.
    if (dbRestore?.busy(login)) return reply(res, 409, { error: 'a dump is being restored or applied: wait for it to finish' });
    // Disconnect first, which also ends at GitHub the token a running session may still hold.
    if (githubUser) await githubUser.disconnect(login);
    if (userSettings) await userSettings.removeAll(login);
    const { stopped, removed } = await fleet.removePrivate(login);
    if (databases) await databases.remove(login);
    dbRestore?.forget(login);
    tunnel?.revoke(login);
    // Last: each stop above tries to save the home, which the session API refuses for someone with no record now.
    if (homes) {
      await homes.removeSessionsOf(login);
      await homes.remove(login);
    }
    await claudeSettings?.remove(login);
    console.log('console: My Woodshed removed', { login, stopped, removed });
    return reply(res, 200, { ...myView(login), stopped, removed });
  }

  // My Woodshed's writes act for the signed-in login only; nothing in the body says whose.
  async function myWrite(req, res, pathname, login) {
    if (!login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    let body;
    const fileMatch = MY_FILE_RE.exec(pathname);
    try {
      body = await readJson(req, fileMatch ? MAX_FILE_BODY_BYTES : undefined);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    try {
      const actionMatch = MY_SESSION_ACTION_RE.exec(pathname);
      if (actionMatch) {
        if (actionMatch[2] === 'remove') {
          await fleet.removePrivateSession({ owner: login, id: actionMatch[1] });
          return reply(res, 200, { removed: actionMatch[1] });
        }
        const resuming = fleet.find(actionMatch[1]);
        if (resuming?.options?.agent !== 'codex' && !userSettings?.view(login).claudeToken.set) return reply(res, 409, { error: 'save your Claude token on My settings first' });
        if (!databasesReady(login)) return reply(res, 409, { error: DATABASES_NOT_READY });
        // Write access to a project's repo can be taken away after a session started on it: Resume asks again, as a start does.
        if (resuming?.owner === login && projectAccess && (await projectAccess.forStart(login, resuming.project)) === null) {
          console.log('console: session resume refused, project not open to the person', { login, sessionId: resuming.id, project: resuming.project ?? null });
          return reply(res, 403, { error: `you can no longer start sessions on ${resuming.project}: you have no write access to its repo, or it is not one of this console's` });
        }
        return reply(res, 201, publicSession(await fleet.resumePrivate({ owner: login, id: actionMatch[1], background: true })));
      }
      if (pathname === '/api/my/home/forget') {
        // A running session saves its home every few minutes, which would bring back what was forgotten.
        // One waiting in line counts too: it would start on the home this deletes.
        if (fleet.sessions().some((s) => s.owner === login && ACTIVE_STATUSES.has(s.status))) {
          console.log('console: Claude home not forgotten, a session is running or waiting', { login });
          return reply(res, 409, { error: 'Stop your running or waiting My Woodshed sessions first: each one saves its Claude home every 5 minutes, which would bring it back.' });
        }
        // The sessions' first, so a failure leaves the owner's home, and the size My settings shows for it, as they were.
        if (homes) {
          await homes.removeSessionsOf(login);
          await homes.remove(login);
        }
        await claudeSettings?.remove(login);
        userSettings?.noteHome(login, 0);
        return reply(res, 200, myView(login));
      }
      const githubMatch = MY_GITHUB_RE.exec(pathname);
      if (githubMatch && userSettings) {
        if (githubMatch[1] === 'disconnect') await (githubUser ? githubUser.disconnect(login) : userSettings.forgetGitHub(login));
        else await userSettings.setGitIdentity(login, body);
        return reply(res, 200, myView(login));
      }
      if (fileMatch && userSettings) {
        const [, key, reset] = fileMatch;
        if (reset) await userSettings.resetFile(login, key);
        else await userSettings.saveFile(login, key, body.text);
        return reply(res, 200, await userSettings.file(login, key));
      }
      if (pathname === '/api/my/sessions') {
        const { prompt, name, workOn, agent, model, effort, permissionMode, attachments: attachmentIds } = body;
        // A Codex session signs in with its own login or the team's OpenAI key: it needs no Claude token.
        if (agent !== 'codex' && !userSettings?.view(login).claudeToken.set) return reply(res, 409, { error: 'save your Claude token on My settings first' });
        if (!databasesReady(login)) return reply(res, 409, { error: DATABASES_NOT_READY });
        const project = projectAccess ? await projectAccess.forStart(login, body.project) : undefined;
        if (project === null) {
          console.log('console: session start refused, project not open to the person', { login, project: String(body.project ?? '').slice(0, 40) });
          return reply(res, 403, { error: `you cannot start sessions on a project named ${String(body.project ?? '').slice(0, 40)}: it is not one of this console's, or you have no write access to its repo` });
        }
        return reply(res, 201, publicSession(await fleet.startPrivate({ owner: login, prompt, name, workOn, agent, model, effort, permissionMode, attachmentIds, background: true, project })));
      }
      if (pathname === MY_DEFAULT_PROJECT_PATH) {
        if (!projectAccess || !viewPrefs) return reply(res, 404, { error: 'this console keeps no default project' });
        if (typeof body.project !== 'string') return reply(res, 400, { error: 'project must be a project\'s name' });
        const saved = await projectAccess.setDefault(login, body.project);
        if (!saved) return reply(res, 403, { error: `you cannot start sessions on a project named ${body.project.slice(0, 40)}` });
        return reply(res, 200, saved);
      }
      if (pathname === '/api/my/remove') return await removeMine(res, login, body);
      const tunnelMatch = MY_TUNNEL_RE.exec(pathname);
      if (tunnelMatch) {
        if (!tunnel) return reply(res, 409, { error: 'this console has no tunnel to your databases' });
        if (tunnelMatch[1]) {
          tunnel.revoke(login);
          return reply(res, 200, myView(login));
        }
        const { token } = tunnel.issue(login);
        return reply(res, 200, { ...myView(login), tunnelToken: token });
      }
      if (pathname === '/api/my/databases') {
        if (!databases) return reply(res, 409, { error: 'this console has no databases of your own to make' });
        if (databases.view(login).status === 'ready' && body.confirm !== 'reset') return reply(res, 400, { error: 'type reset to confirm: your data goes' });
        if (dbRestore?.busy(login)) return reply(res, 409, { error: 'a dump is being restored or applied: wait for it to finish' });
        await databases.create(login);
        dbRestore?.forget(login);
        return reply(res, 200, myView(login));
      }
      const restoreMatch = MY_RESTORE_RE.exec(pathname);
      if (restoreMatch) {
        if (!dbRestore) return reply(res, 404, { error: 'this console cannot restore a dump' });
        if (restoreMatch[1] === 'discard') await dbRestore.discard(login);
        else {
          if (body.confirm !== 'apply') return reply(res, 400, { error: 'type apply to confirm: your database is replaced' });
          await dbRestore.apply(login);
        }
        return reply(res, 200, myView(login));
      }
      if (!userSettings) return reply(res, 409, { error: 'this console has no secret store, so My settings cannot be saved' });
      const codexMatch = MY_CODEX_AUTH_RE.exec(pathname);
      if (codexMatch) {
        if (codexMatch[1]) await userSettings.removeCodexAuth(login);
        else {
          await userSettings.setCodexAuth(login, body.value);
          await firstDatabases(login);
        }
        return reply(res, 200, myView(login));
      }
      if (pathname === MY_LIMITS_PATH) {
        userSettings.setLimits(login, body.limits);
        return reply(res, 200, myView(login));
      }
      const tokenAction = MY_TOKEN_RE.exec(pathname)[1];
      if (tokenAction === 'remove') await userSettings.removeClaudeToken(login);
      else if (tokenAction === 'shared') {
        if (typeof body.on !== 'boolean') return reply(res, 400, { error: 'on must be true or false' });
        userSettings.setOwnTokenForShared(login, body.on);
      } else {
        await userSettings.setClaudeToken(login, body.value);
        await firstDatabases(login);
      }
      return reply(res, 200, myView(login));
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 409, { error: err.message });
      console.error('console: My Woodshed change failed', { pathname, login, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'The secret store or GitHub refused that; the console log says why' });
    }
  }

  // Resume, Delete now and Remove, on a stopped shared session. Who asked is the signed-in login, or the console's own
  // name where it has no sign-in.
  async function sharedAction(req, res, [, id, action], login) {
    const session = findFor(id, login);
    if (!session) return reply(res, 404, { error: 'no such session' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    const by = login ?? 'console';
    try {
      if (action === 'delete') return reply(res, 200, publicSession(await fleet.deleteShared(session, by)));
      if (action === 'remove') {
        fleet.removeShared(session, by);
        return reply(res, 200, { removed: true });
      }
      const text = String(body?.message ?? '').slice(0, MAX_RESUME_MESSAGE_CHARS);
      return reply(res, 200, publicSession(await fleet.resumeShared(session, { text, by, why: 'console' })));
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
    }
  }

  async function stageUpload(req, res, login) {
    if (!login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    if (!attachments) return reply(res, 404, { error: 'this console keeps no attachments' });
    const name = new URL(req.url, 'http://console.invalid').searchParams.get('name');
    try {
      return reply(res, 201, await attachments.stage(req, { login, name }));
    } catch (err) {
      req.resume();
      if (err.shown) return reply(res, err.status, { error: err.message });
      throw err;
    }
  }

  async function restoreUpload(req, res, login) {
    if (!login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    if (!dbRestore) return reply(res, 404, { error: 'this console cannot restore a dump' });
    const name = new URL(req.url, 'http://console.invalid').searchParams.get('name');
    try {
      return reply(res, 202, { ...myView(login), restore: await dbRestore.upload(req, { login, name }) });
    } catch (err) {
      req.resume();
      if (err.shown) return reply(res, err.status, { error: err.message });
      throw err;
    }
  }

  // The session's statusd, straight through: the body (a file) and the answer (a file, or JSON) are never held whole.
  function toStatusd(req, res, session, { method, path, body = null, maxBytes = Infinity }) {
    const { host, statusPort } = session.endpoint;
    const headers = { authorization: `Bearer ${session.token}` };
    if (body !== null) headers['content-type'] = 'application/json';
    else if (method === 'POST') headers['content-type'] = 'application/octet-stream';
    const upstream = http.request({ host, port: statusPort, method, path, headers, timeout: UPLOAD_TIMEOUT_MS }, (upRes) => {
      const passed = { 'content-type': upRes.headers['content-type'] || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      res.writeHead(upRes.statusCode || 502, passed);
      upRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('statusd took too long')));
    upstream.on('error', (err) => {
      console.warn('console: statusd unreachable', { id: session.id, path: path.split('?')[0], message: err.message });
      if (!res.headersSent) reply(res, 502, { error: 'the session did not answer: try again in a moment' });
      else res.destroy();
    });
    if (body !== null) return upstream.end(JSON.stringify(body));
    if (method !== 'POST') return upstream.end();
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) return;
      req.unpipe(upstream);
      upstream.destroy();
      if (!res.headersSent) reply(res, 413, { error: `over ${Math.round(maxBytes / 1024 / 1024)} MB` });
    });
    req.pipe(upstream);
  }

  function runningFor(id, login) {
    const session = findFor(id, login);
    return session?.status === 'running' && session.endpoint ? session : null;
  }

  async function terminalAction(req, res, [, id, action], login) {
    const session = runningFor(id, login);
    if (!session) {
      req.resume();
      return reply(res, findFor(id, login) ? 409 : 404, { error: findFor(id, login) ? 'the session is not running' : 'no such session' });
    }
    const url = new URL(req.url, 'http://console.invalid');
    if (action === 'upload') {
      // `none` saves the file and types nothing: the phone's message box adds its path to the message itself.
      const asked = url.searchParams.get('pane');
      const pane = asked === 'none' ? null : asked === 'terminal' ? 'terminal' : 'agent';
      const query = new URLSearchParams({ name: url.searchParams.get('name') || 'file', ...(pane && { pane }) });
      return toStatusd(req, res, session, { method: 'POST', path: `/upload?${query}`, maxBytes: MAX_ATTACHMENT_BYTES });
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (action === 'send') {
      if (typeof body?.text !== 'string' || !body.text.trim()) return reply(res, 400, { error: 'nothing to send' });
      console.log('console: message typed in from the page', { id: session.id, chars: body.text.length });
      return toStatusd(req, res, session, { method: 'POST', path: '/send', body: { text: body.text } });
    }
    return toStatusd(req, res, session, { method: 'POST', path: '/scroll', body: { steps: body?.steps, pane: body?.pane } });
  }

  async function skillsReply(res) {
    if (!github?.skills) return reply(res, 200, { skills: [] });
    if (skillsCache && Date.now() - skillsCache.at < SKILLS_FRESH_MS) return reply(res, 200, { skills: skillsCache.skills });
    skillsReading ??= github.skills().then((skills) => {
      skillsCache = { at: Date.now(), skills };
      console.log('console: skills read', { count: skills.length });
    }, (err) => {
      console.warn('console: skills not readable', { message: String(err?.message ?? err).split('\n')[0] });
      // Asked again in a minute, not on every launcher that opens meanwhile.
      skillsCache = { at: Date.now() - SKILLS_FRESH_MS + 60_000, skills: skillsCache?.skills ?? [] };
    }).finally(() => { skillsReading = null; });
    await skillsReading;
    return reply(res, 200, { skills: skillsCache?.skills ?? [] });
  }

  // A pin is the asker's own; a rename is the session's, for everyone who can see it.
  async function viewAction(req, res, [, id, action], login) {
    const session = findFor(id, login);
    if (!session) return reply(res, 404, { error: 'no such session' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      if (action === 'rename') return reply(res, 200, publicSession(fleet.rename(session, body?.title)));
      if (!viewPrefs) return reply(res, 404, { error: 'this console keeps no rail preferences' });
      if (typeof body?.on !== 'boolean') return reply(res, 400, { error: 'on must be true or false' });
      return reply(res, 200, viewPrefs.setPinned(login, id, body.on));
    } catch (err) {
      if (err.shown) return reply(res, 400, { error: err.message });
      throw err;
    }
  }

  async function consoleSettingsReply(res) {
    if (!consoleSettings) return reply(res, 404, { error: 'this console has no settings page' });
    return reply(res, 200, {
      settings: consoleSettings.view(),
      slack: slack?.view() ?? null,
      projects: addedProjects?.view() ?? null,
      data: heldData ? await heldData.report() : null,
    });
  }

  // The same typed confirm as every other admin change is the page's; the server checks the value's bounds.
  async function consoleSettingsWrite(req, res, pathname, login) {
    if (!consoleSettings) return reply(res, 404, { error: 'this console has no settings page' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    try {
      if (pathname === PROJECTS_PATH || pathname === `${PROJECTS_PATH}/remove`) {
        if (!addedProjects) return reply(res, 404, { error: 'this console keeps no list of repos' });
        const by = login ?? 'console';
        if (pathname === PROJECTS_PATH) await addedProjects.add({ repo: body.repo, name: body.name, by });
        else addedProjects.remove({ name: body.name, by });
      } else if (pathname === '/api/console-settings') {
        const by = login ?? 'console';
        const values = body.values ?? {};
        consoleSettings.check(values);
        if (body.slackChannel !== undefined) {
          if (!slack) return reply(res, 404, { error: 'this console posts nothing to Slack' });
          slack.setChannel({ channel: slack.checkChannel(body.slackChannel), by });
        }
        consoleSettings.setMany({ values, by });
      } else {
        if (!heldData) return reply(res, 404, { error: 'this console keeps no session data' });
        if (!['stuck', 'databases', 'home'].includes(body.kind) || !/^[0-9a-f]{8}$/.test(String(body.id ?? ''))) {
          return reply(res, 400, { error: 'kind must be stuck, databases or home, and id a session id' });
        }
        await heldData.clean({ kind: body.kind, id: body.id, by: login ?? 'console' });
      }
    } catch (err) {
      if (err.shown) return reply(res, pathname === '/api/console-settings' || pathname.startsWith(PROJECTS_PATH) ? 400 : 409, { error: err.message });
      console.error('console: console settings change failed', { pathname, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'The change failed; the console log says why' });
    }
    return consoleSettingsReply(res);
  }

  // Who else may open a My Woodshed session's app is its owner's to say, and nobody else's: a teammate gets the
  // unknown-id answer, as for the session's other routes.
  async function appShareAction(req, res, [, id, kind, linkId, revoke], login) {
    const session = findFor(id, login);
    if (!session || !appShares || !config.appDomain) return reply(res, 404, { error: 'no such session' });
    if (!session.owner) return reply(res, 409, { error: 'a shared session\'s app is already open to the members who can open the session' });
    if (session.owner !== login) return reply(res, 404, { error: 'no such session' });
    const shareView = () => ({ ...appShares.view(id), appUrl: appUrl(config, id, '/') });
    if (req.method === 'GET') return reply(res, 200, shareView());
    if (!kind) return reply(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (kind === 'members') {
      if (typeof body?.on !== 'boolean') return reply(res, 400, { error: 'on must be true or false' });
      if (body.on && session.status !== 'running') return reply(res, 409, { error: 'the session is not running: its app can be shared while it is' });
      appShares.setMembers({ sessionId: id, on: body.on, by: login });
      return reply(res, 200, shareView());
    }
    if (revoke) {
      if (!appShares.revokeLink({ sessionId: id, linkId, by: login })) return reply(res, 404, { error: 'no such link' });
      return reply(res, 200, shareView());
    }
    if (session.status !== 'running') return reply(res, 409, { error: 'the session is not running: its app can be shared while it is' });
    try {
      const link = appShares.createLink({ sessionId: id, hours: body?.hours, by: login });
      return reply(res, 201, { ...shareView(), url: appUrl(config, id, `${APP_SHARE_PATH}?t=${link.token}`), created: link.id });
    } catch (err) {
      if (err.shown) return reply(res, 400, { error: err.message });
      throw err;
    }
  }

  async function write(req, res, pathname, login) {
    if (req.headers['x-woodshed'] !== '1') return reply(res, 403, { error: 'missing x-woodshed header' });
    if (!isSameOrigin(req.headers)) return reply(res, 403, { error: 'cross-origin request refused' });
    if (pathname === '/api/secrets-manager') return managerWrite(req, res, login);
    if (SECRET_RE.test(pathname) || WEBHOOK_RE.test(pathname)) return settingsWrite(req, res, pathname);
    if (SETUP_WRITE_RE.test(pathname)) return githubSetupWrite(req, res, pathname, login);
    if (pathname === '/api/my/uploads') return stageUpload(req, res, login);
    if (pathname === '/api/my/databases/restore') return restoreUpload(req, res, login);
    const terminalWrite = TERMINAL_RE.exec(pathname);
    if (terminalWrite && ['upload', 'scroll', 'send'].includes(terminalWrite[2])) return terminalAction(req, res, terminalWrite, login);
    if (pathname === '/api/console-settings' || pathname === '/api/console-settings/clean' || pathname === PROJECTS_PATH || pathname === `${PROJECTS_PATH}/remove`) return consoleSettingsWrite(req, res, pathname, login);
    if (PEOPLE_RE.test(pathname)) return peopleWrite(req, res, pathname, login);
    if (pathname === '/api/my/sessions' || pathname === '/api/my/remove' || pathname === MY_DEFAULT_PROJECT_PATH || MY_TOKEN_RE.test(pathname) || pathname === MY_LIMITS_PATH || MY_CODEX_AUTH_RE.test(pathname) || MY_FILE_RE.test(pathname)
      || MY_GITHUB_RE.test(pathname) || MY_SESSION_ACTION_RE.test(pathname) || pathname === '/api/my/home/forget' || pathname === '/api/my/databases'
      || MY_TUNNEL_RE.test(pathname) || MY_RESTORE_RE.test(pathname)) {
      return myWrite(req, res, pathname, login);
    }
    const loginMatch = CLAUDE_LOGIN_RE.exec(pathname);
    if (loginMatch) {
      const session = findFor(loginMatch[1], login);
      if (!session) return reply(res, 404, { error: 'no such session' });
      try {
        await fleet.startClaudeLogin(session);
        return reply(res, 200, { ok: true });
      } catch (err) {
        if (err.notRunning) return reply(res, 409, { error: 'the session is not running' });
        if (err.notPrivate) return reply(res, 409, { error: err.message });
        const message = String(err?.message ?? err).split('\n')[0];
        console.warn('console: Claude login action failed', { id: session.id, message });
        if (/answered 404/.test(message)) return reply(res, 409, { error: 'this session\'s image predates the sign-in button: start a new session to get it' });
        return reply(res, 502, { error: 'the session did not answer: try again in a moment' });
      }
    }
    const shareMatch = APP_SHARE_RE.exec(pathname);
    if (shareMatch) return appShareAction(req, res, shareMatch, login);
    const appMatch = APP_ACTION_RE.exec(pathname);
    if (appMatch) {
      const [, id, action] = appMatch;
      const session = findFor(id, login);
      if (!session) return reply(res, 404, { error: 'no such session' });
      try {
        return reply(res, 200, publicSession(await (action === 'start' ? fleet.startApp(session) : fleet.stopApp(session))));
      } catch (err) {
        if (err.notRunning) return reply(res, 409, { error: 'the session is not running' });
        const message = String(err?.message ?? err).split('\n')[0];
        console.warn('console: app action failed', { id: session.id, action, message });
        // A session started before its image had the action has a statusd without the route.
        if (/answered 404/.test(message)) {
          return reply(res, 409, { error: `this session's image predates ${action === 'start' ? 'Start' : 'Stop'} app: start a new session to get it` });
        }
        return reply(res, 502, { error: 'the session did not answer: try again in a moment' });
      }
    }
    const sharedMatch = SHARED_ACTION_RE.exec(pathname);
    if (sharedMatch) return sharedAction(req, res, sharedMatch, login);
    const viewMatch = VIEW_ACTION_RE.exec(pathname);
    if (viewMatch) return viewAction(req, res, viewMatch, login);
    const assignMatch = ASSIGN_RE.exec(pathname);
    if (assignMatch) return assignAction(req, res, assignMatch[1], login);
    const stopMatch = STOP_RE.exec(pathname);
    if (stopMatch) {
      const session = findFor(stopMatch[1], login);
      if (!session) return reply(res, 404, { error: 'no such session' });
      await fleet.stop(session, 'stopped from the console', { by: login });
      return reply(res, 200, publicSession(session));
    }
    if (pathname === '/api/sessions') {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return reply(res, 400, { error: err.message });
      }
      if (!seesShared(login)) return reply(res, 403, { error: 'starting a shared session needs sessions from GitHub: an admin turns it on in People' });
      const number = Number(body.number);
      if (!Number.isInteger(number) || number <= 0) return reply(res, 400, { error: 'number must be an issue or PR number' });
      // Whoever is signed in started it; a body's word counts only on a console with no sign-in.
      const startedBy = login ?? body.startedBy;
      if (typeof startedBy !== 'string' || !startedBy) return reply(res, 400, { error: 'startedBy is required' });
      try {
        const session = await fleet.startManual({ number, startedBy, prompt: String(body.prompt ?? '') });
        return reply(res, 201, publicSession(session));
      } catch (err) {
        return reply(res, 409, { error: err.message });
      }
    }
    return reply(res, 404, { error: 'not found' });
  }

  return async function handle(req, res) {
    const appId = appIdFor(req.headers.host, config.appDomain);
    if (appId) return appRequest(req, res, appId);
    if (!isKnownHost(req.headers.host, hosts)) {
      console.warn('console: unknown host refused', { host: String(req.headers.host).slice(0, 100) });
      return reply(res, 421, { error: 'unknown host' });
    }
    const url = new URL(req.url || '/', 'http://console.invalid');
    // woodshed-db.mjs has no cookie: its token is its sign-in.
    if (url.pathname === CONNECTION_PATH && req.method === 'GET') {
      return tunnel ? tunnel.connection(req, res) : reply(res, 404, { error: 'this console has no tunnel to your databases' });
    }
    // Sign-in's cookies belong to one host name, and GitHub sends people back only to publicUrl's. Once sign-in
    // can be used, a page opened on another public name (the bare IP) moves there.
    const stays = url.pathname === '/healthz';
    if (auth?.available() && req.method === 'GET' && !stays && otherPublicNames.has(hostnameOf(req.headers.host))) {
      return redirect(res, `${config.publicUrl}${url.pathname}${url.search}`);
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(CONSOLE_MANIFEST);
    }
    if (PWA_PATHS.has(url.pathname) && handlePwaRequest(req, res)) return;
    if (await authRoute(req, res, url)) return;
    const user = await signedIn(req, res, url);
    if (!user) return;
    if (url.pathname === '/auth/app' && req.method === 'GET') return appSignIn(req, res, url, user.login);
    // Connect GitHub is a sign-in like any other, by the person already signed in, that keeps its token.
    if (url.pathname === '/auth/connect' && req.method === 'GET') {
      if (!auth?.enabled() || !githubUser) return reply(res, 404, { error: 'this console has no GitHub sign-in to connect with' });
      const { location, setCookie } = await auth.start('/settings?connected=1', { connect: true });
      console.log('console: Connect GitHub started', { login: user.login });
      return redirect(res, location, setCookie);
    }
    if (handleTerminalRequest(req, res, { targetFor: terminalTarget(fleet, user.login, access) })) return;
    if (isReviewPath(url.pathname)) return proxyReview(req, res, url, user.login);
    const { pathname } = url;
    if (ADMIN_API_RE.test(pathname) && !isAdminLogin(user.login)) {
      console.log('console: admin call refused', { login: user.login, pathname, method: req.method });
      return reply(res, 403, { error: 'only an admin can do this' });
    }
    if (req.method === 'POST') return write(req, res, pathname, user.login);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'method not allowed' });
    // One page for the three: session.js moves between them in place, so each loads what any of them needs.
    if (pathname === '/' || pathname === '/all' || SESSION_PAGE_RE.test(pathname)) return html(res, pageShell({ title: 'Woodshed Cloud', script: SHELL_SCRIPTS, login: user.login, provider }));
    if (pathname === '/settings') return html(res, pageShell({ title: 'Woodshed Cloud', script: ['dbRestoreStates.js', 'dbRestore.js', 'mySettings.js'], provider }));
    if (pathname === '/setup/github') return html(res, pageShell({ title: 'Woodshed Cloud', script: 'githubSetup.js' }));
    if (pathname === '/setup/github/created') return githubSetupCreated(res, url);
    if (pathname === '/api/setup/github') return githubSetup ? reply(res, 200, await githubSetup.view()) : reply(res, 404, { error: 'this console has no secret store, so it cannot keep a GitHub App' });
    if (pathname === '/events') return html(res, pageShell({ title: 'Woodshed Cloud', script: 'events.js', provider }));
    if (pathname === '/secrets') return html(res, pageShell({ title: 'Woodshed Cloud', script: ['webhookSetup.js', 'secrets.js'], provider }));
    if (pathname === '/console-settings') return html(res, pageShell({ title: 'Woodshed Cloud', script: 'consoleSettings.js', provider }));
    if (pathname === '/api/console-settings') return consoleSettingsReply(res);
    if (pathname === '/people') return html(res, pageShell({ title: 'Woodshed Cloud', script: 'people.js', provider }));
    if (pathname === '/api/people') return peopleReply(res);
    if (pathname === '/api/people/slack-search') return slackSearchReply(res, url.searchParams.get('q'));
    if (pathname === '/api/sessions') return reply(res, 200, sessionsBody(user.login));
    if (pathname === '/api/my') {
      await databaseGate?.refusal();
      return reply(res, 200, myView(user.login));
    }
    if (pathname === '/api/my/pulls') return pullsReply(res, user.login);
    if (pathname === '/api/my/projects') return reply(res, 200, await projectsView(user.login));
    if (pathname === '/api/skills') return skillsReply(res);
    const shareRead = APP_SHARE_RE.exec(pathname);
    if (shareRead && !shareRead[2]) return appShareAction(req, res, shareRead, user.login);
    const imageMatch = TERMINAL_RE.exec(pathname);
    if (imageMatch?.[2] === 'applog' || imageMatch?.[2] === 'diff') {
      const session = runningFor(imageMatch[1], user.login);
      if (!session) return reply(res, findFor(imageMatch[1], user.login) ? 409 : 404, { error: 'the session is not running' });
      return toStatusd(req, res, session, { method: 'GET', path: `/${imageMatch[2]}` });
    }
    if (imageMatch?.[2] === 'image') {
      const session = runningFor(imageMatch[1], user.login);
      if (!session) return reply(res, 404, { error: 'no such image' });
      const asked = url.searchParams.get('path') || '';
      return toStatusd(req, res, session, { method: 'GET', path: `/image?${new URLSearchParams({ path: asked })}` });
    }
    const fileRead = MY_FILE_RE.exec(pathname);
    if (fileRead && !fileRead[2]) return fileReply(res, user.login, fileRead[1]);
    const reviewMatch = REVIEW_RE.exec(pathname);
    if (reviewMatch) return reviewReply(res, findFor(reviewMatch[1], user.login));
    if (pathname === '/api/webhook-events') {
      const list = events.list();
      return reply(res, 200, { repo: defaultProject(config).repo, queue: Boolean(config.webhookQueue || config.localWebhooks), events: list, names: namesFor(list.map((e) => e.login)) });
    }
    if (pathname === '/api/secrets-manager') return reply(res, 200, managerView());
    if (pathname === '/api/secrets') {
      if (!settings) return reply(res, 404, { error: 'the Secrets page needs a secrets manager and the GitHub App' });
      return reply(res, 200, await settings.view());
    }
    if (pathname === '/api/webhook/deliveries') {
      if (!settings) return reply(res, 404, { error: 'the Secrets page needs a secrets manager and the GitHub App' });
      try {
        return reply(res, 200, { deliveries: await settings.deliveries() });
      } catch (err) {
        console.warn('console: GitHub deliveries not readable', { message: String(err?.message ?? err).split('\n')[0] });
        return reply(res, err.shown ? 409 : 502, { error: err.shown ? err.message : 'GitHub’s deliveries could not be read' });
      }
    }
    if (pathname === '/healthz') return reply(res, 200, { ok: true });
    const file = pathname.startsWith('/static/') ? pathname.slice('/static/'.length) : null;
    if (file && STATIC_FILES[file]) {
      // Only the version a page names is kept: an old or missing ?v= is asked for again each time.
      const current = url.searchParams.get('v') === staticHash(file);
      res.writeHead(200, { 'content-type': STATIC_FILES[file], 'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
    }
    return reply(res, 404, { error: 'not found' });
  };
}

/**
 * A local console with no sign-in has one person at the keyboard, who gets a login of their own so My Woodshed works:
 * their Claude token, private sessions and settings are kept under it. Elsewhere, and with a GitHub App, nobody has one
 * until they sign in.
 * @returns {string|null}
 */
export function soloLoginOf(config) {
  return config.launcher?.kind === 'docker' && !config.githubApp ? config.localLogin ?? null : null;
}

/**
 * Someone else's private session is nobody's to open. A shared one is for members with sessions from GitHub (People);
 * a console with no sign-in or no list has nobody to tell apart.
 * @returns {boolean}
 */
export function canOpen(session, login, members) {
  if (!canSee(session, login)) return false;
  return Boolean(session.owner) || !login || !members || members.hasGithubSessions(login);
}

/**
 * A My Woodshed session's app is also open to every member when its owner shared it with them (appShares.mjs).
 * Nothing else about the session is: the terminal, Review, viewers and Start/Stop stay on `canOpen`.
 * @returns {boolean}
 */
export function canOpenApp(session, login, members, sharedWithMembers) {
  if (canOpen(session, login, members)) return true;
  return Boolean(sharedWithMembers && session.owner && login && (!members || members.isMember(login)));
}

// The app alone, for someone who signed in to the console, or holds a share link's cookie: only what the app proxy
// needs, so no other port of the session is ever handed to the app's path.
function appTarget({ fleet, login, members, shares, link }) {
  return function targetFor(id) {
    const session = fleet.find(id);
    if (!session?.endpoint || session.status !== 'running') return null;
    if (!link && !canOpenApp(session, login, members, shares?.membersOpen(id))) return null;
    return { host: session.endpoint.host, statusPort: session.endpoint.statusPort, sessionToken: session.token };
  };
}

/**
 * The editor of a running session that `login` can open itself, when its statusd says it has one (the project file
 * turns it on, and the image has it): what canOpen allows, never a share of the app.
 * @returns {{host: string, statusPort: number, sessionToken: string}|null}
 */
function editorTarget({ fleet, login, members, id }) {
  const session = fleet.find(id);
  if (!session?.endpoint || session.status !== 'running' || session.editor !== true || !canOpen(session, login, members)) return null;
  return { host: session.endpoint.host, statusPort: session.endpoint.statusPort, sessionToken: session.token };
}

/**
 * Who a request for a session's app comes from: a member signed in to the console (their app cookie), or a holder of a
 * share link (its cookie). Both can be absent.
 * @returns {Promise<{login: string|null, link: boolean}|null>}
 */
async function appViewerFor({ auth, appShares, cookieHeader, appId }) {
  const user = await auth.appSessionFor({ cookieHeader, appId });
  const link = Boolean(appShares?.viewerFor({ cookieHeader, appId }));
  return user || link ? { login: user?.login ?? null, link } : null;
}

// A terminal, viewer or app, for whoever asks: a session they cannot open resolves to nothing.
function terminalTarget(fleet, login, members) {
  return function targetFor(id) {
    const session = fleet.find(id);
    if (!session?.endpoint || session.status !== 'running' || !canOpen(session, login, members)) return null;
    const { host, termPort, statusPort, shellPort } = session.endpoint;
    return { host, termPort, statusPort, shellPort, terminalToken: session.terminalToken, sessionToken: session.token };
  };
}

/**
 * Sign-in, with the App's client secret read from Secrets Manager at start and kept in memory. Setting the
 * secret on the Secrets page makes sign-in available without a restart; the first one to complete makes it required.
 */
async function startAuth({ config, store, secrets, appApi, github, userSettings, people, members, slackPeople }) {
  let clientSecret = await secrets.read(CLIENT_SECRET).catch((err) => {
    console.error('console: GitHub App client secret not readable', { message: String(err?.message ?? err).split('\n')[0] });
    return null;
  });
  let clientId = null;
  const githubUser = createGitHubUser({
    clientId: async () => {
      clientId ??= (await appApi.app()).clientId;
      return clientId;
    },
    clientSecret: () => clientSecret,
    userSettings,
  });
  const auth = createAuth({
    publicUrl: config.publicUrl,
    store,
    required: config.requireSignIn,
    clientId: async () => {
      clientId ??= (await appApi.app()).clientId;
      return clientId;
    },
    clientSecret: () => clientSecret,
    canWrite: (login) => github.canWrite(login),
    onConnect: (args) => githubUser.connect(args),
    people,
    members,
    slackPeople,
  });
  console.log('console: GitHub sign-in', { available: auth.available(), required: auth.enabled(), alwaysRequired: config.requireSignIn });
  return {
    ...auth,
    githubUser,
    secretReplaced(name, value) {
      if (name !== CLIENT_SECRET) return;
      clientSecret = value;
      auth.disarm();
      console.log('console: GitHub sign-in available', { reason: 'client secret set', required: auth.enabled() });
    },
  };
}

function every(ms, what, fn) {
  async function run() {
    try {
      await fn();
    } catch (err) {
      console.error(`console: ${what} failed`, { message: String(err?.message ?? err).split('\n')[0] });
    }
    setTimeout(run, ms);
  }
  run();
}

/**
 * The App's private key, as the console holds it. In AWS it is read from its secret at start, and the Secrets
 * page swaps in a new one without a restart; until the secret has a value, the console runs without GitHub.
 * @returns {Promise<{current: () => string|null, set: (pem: string) => void, reload: () => Promise<void>}>}
 */
async function loadAppKey(config, secrets) {
  let key = null;
  const { keyFile, keyFromSecret } = config.githubApp;

  async function reload() {
    if (keyFile) key = fs.readFileSync(keyFile, 'utf8');
    else if (keyFromSecret) {
      key = await secrets.read(APP_KEY_SECRET).catch((err) => {
        console.error('console: GitHub App key not readable', { message: String(err?.message ?? err).split('\n')[0] });
        return null;
      });
    }
    if (key) console.log('console: GitHub App key loaded');
  }

  await reload();
  if (!key) console.warn('console: no GitHub App key yet, so no GitHub polling, webhooks or session tokens until it is set on the Secrets page');
  return {
    current: () => key,
    reload,
    set(pem) {
      key = pem;
      console.log('console: GitHub App key replaced');
    },
  };
}

// Waits out a missing App key, reading it again each time: the secret may be filled in, or the first read may have failed.
async function untilAppKey(appKey, everyMs) {
  while (!appKey.current()) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    await appKey.reload();
  }
}

function startSessionApi({ config, fleet, tokens, userSettings, githubUser, homes, databases, claudeSettings, anthropic, openai, attachments, asks }) {
  // Without a GitHub App the API still answers what it can: a session's settings, Claude token and home. It mints no GitHub token.
  if (!config.sessionApi.host) return;
  const handle = createSessionApi({
    fleet, tokens: tokens?.sessions ?? null, tokensFor: tokens?.forSession ?? null, userSettings, githubUser, homes, databases, claudeSettings, anthropic, openai, attachments, askTokens: tokens?.asks ?? null, asks,
  });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('sessionApi: request failed', { message: err?.message });
      if (!res.headersSent) reply(res, 502, { error: 'could not get a GitHub token' });
    });
  });
  server.listen(config.sessionApi.port, config.sessionApi.host, () => console.log('sessionApi: listening', config.sessionApi));
}

/**
 * Starts the console on what its provider supplies: where sessions run, its secrets, saved Claude homes, db-admin runs
 * and webhooks. ../providers/console.mjs picks the provider and calls this; nothing in the console imports one
 * (test/layout.test.mjs).
 * @param {{provider: {name: string, launcher: object,
 *   secrets: {list: Function, read: Function, write: Function, save: Function, remove: Function}|null,
 *   homes: object|null, dbAdmin: object|null, webhooks: {run: Function}|null, webhookUrl: (() => Promise<string|null>)|null},
 *   config?: object}} args
 *   each of the provider's parts is null where it has none: `dbAdmin` runs session/dbAdmin.mjs
 *   (databases.mjs), `webhooks` hands GitHub and Slack events to webhookDispatch.mjs, and `webhookUrl` is where GitHub
 *   should post them
 *   `config` is loadConfig()'s, read again when left out
 */
export async function startConsole({ provider, config: given = null }) {
  const first = given ?? loadConfig();
  const store = openStore(first.stateDir);
  // An App saved on the setup page is the console's own from the next start.
  const loaded = applyStored({ config: first, store, secrets: provider.secrets });
  const githubSetup = provider.secrets ? createGitHubAppSetup({ store, secrets: provider.secrets, config: loaded, supervisor: supervisorOf(process.env) }) : null;
  // The limits and retention numbers are the Console settings page's, read each time they are used.
  const config = liveConfig(loaded, store);
  const consoleSettings = createConsoleSettings({ store, config: loaded });
  const { secrets, homes, dbAdmin } = provider;
  const appKey = config.githubApp ? await loadAppKey(config, secrets) : null;
  const tokens = createProjectTokens({ config, privateKey: () => appKey.current() });
  await checkGh();
  const github = createGitHub({ repo: defaultProject(config).repo, token: tokens && (async () => (await tokens.console.token()).token) });
  // Each project's repo, on that project's own token: the default project's is the console's own client.
  const projectClients = new Map([[defaultProject(config).name, github]]);
  const githubFor = (project) => {
    // A repo an admin removed and added again is a new client, since it may be on another installation.
    const key = project.default ? project.name : `${project.name}\n${project.repo}\n${project.installationId ?? ''}`;
    if (!projectClients.has(key)) {
      const token = tokens && (async () => (await tokens.forSession({ project: project.name }).console.token()).token);
      projectClients.set(key, createGitHub({ repo: project.repo, token }));
    }
    return projectClients.get(key);
  };
  // The databases the provider's db-admin makes a copy of for each session: what the installation runs.
  const databases = createDatabases({ store, secrets, dbAdmin, engines: provider.databases ?? [] });
  const databaseTargets = tunnelTargetsFor(config.tunnelTargets, databases.engines);
  // Where the console makes none (the docker launcher), the session's environment says which servers it has.
  const hosted = databases.available ? databases.engines : hostedEngines(config.sessionEnv ?? {});
  console.log('console: databases', {
    made: databases.available, engines: databases.engines, hosted, tunnel: Object.keys(databaseTargets).filter((k) => databaseTargets[k]),
  });
  const slack = createSlack({ store, secrets });
  console.log('console: Slack posts', { available: slack.available, channel: slack.view().channel || null });
  const claudeSettings = homes ? createClaudeSettings({ store: homes }) : null;
  const projectReader = createProjectReader({ github });
  const databaseGate = createDatabaseGate({ projectDatabases: projectReader.databases, hosted });
  const userSettings = createUserSettings({ store, secrets, envFiles: config.envFiles, appendedFor: projectReader.appendedFor });
  const people = createGitHubPeople({ store, github });
  const members = createMembers({ store });
  const appShares = createAppShares({ store, secure: loaded.publicUrl.startsWith('https:') });
  const slackPeople = createSlackPeople({ store, slack });
  // In AWS the team key is the console's alone; the docker launcher's sessions keep the one in its env file.
  const openai = createOpenAiProxy({ secrets, teamKey: config.sessionEnv.OPENAI_API_KEY ?? null });
  const anthropic = createAnthropicProxy({ userSettings, secrets, teamKey: config.sessionEnv.ANTHROPIC_API_KEY ?? null });
  const attachments = createAttachments({ dir: path.join(loaded.stateDir, 'attachments') });
  const pullWebhooks = createPullWebhooks();
  const prChips = createPrChips({ github, repo: defaultProject(config).repo, webhooksFlowing: pullWebhooks.flowing, fallbackMs: config.fallbackPollMs });
  const pings = createAssigneePings({ slack, slackPeople, publicUrl: config.publicUrl });
  const fleet = createFleet({
    config, store, launcher: provider.launcher, github, databases, slack, homes, userSettings, people, members, pings,
    autoName: createAutoNamer({ teamKey: anthropic.teamCredential }), attachments, pullWebhooksFlowing: pullWebhooks.flowing,
    pullRequests: projectReader.pullRequests, databasesRefusal: databaseGate.refusal, githubFor,
  });
  pullWebhooks.watch({ name: 'chip', stale: prChips.stale });
  pullWebhooks.watch({ name: 'Slack post or retention', stale: fleet.pullsChanged });
  // Questions need the bot token to answer, and the session API to hear the answer.
  const asks = slack.canReply && config.sessionApi.host ? createAsks({ store, fleet, slack, publicUrl: config.publicUrl }) : null;
  console.log('console: Slack questions', { available: Boolean(asks) });
  const events = createWebhookEvents({ file: path.join(loaded.stateDir, 'webhookEvents.jsonl'), store });
  const appApi = appKey ? createAppApi({ appId: config.githubApp.appId, privateKey: () => appKey.current() }) : null;
  const appIdentity = createAppIdentity({ appApi });
  const addedProjects = createAddedProjects({ store, config, check: repoChecker({ appApi }) });
  const auth = secrets && appApi ? await startAuth({ config, store, secrets, appApi, github, userSettings, people, members, slackPeople }) : null;
  // Without sign-in every gate lets a request through, which a console the internet reaches must never do.
  // A store the dashboard has not chosen yet holds no client secret either, so sign-in could never come on.
  if (config.requireSignIn && (!auth || secrets?.configured?.() === false)) throw new Error('WOODSHED_CLOUD_REQUIRE_SIGN_IN needs the GitHub App (WOODSHED_CLOUD_GITHUB_APP_ID) and Secrets Manager');
  const settings = secrets && appKey
    ? createSettings({ config, secrets, appKey, appApi, webhookUrl: provider.webhookUrl ?? (async () => null), onReplace: (name, value) => auth?.secretReplaced(name, value) })
    : null;
  const githubUser = auth?.githubUser ?? null;
  // A tunnel token lasts 12 hours; who may use it is asked at each connection, as sign-in asks for each request.
  const tunnel = createTunnel({ store, targets: databaseTargets, databases, allowed: (login) => !auth?.enabled() || members.isMember(login) });
  const dbRestore = createDbRestore({
    store, dir: path.join(loaded.stateDir, 'restores'), databases, targets: databaseTargets,
    defaultBranchMigrations: tokens ? () => projectReader.migrationFiles('postgres') : null,
    projectDatabases: projectReader.databases,
  });
  await dbRestore.recover();
  const viewPrefs = createViewPrefs(store);
  const handle = createHandler({
    config, fleet, settings, events, auth, review: createReviewSource({ github }), userSettings, github, githubUser, homes, databases, tunnel, slack,
    consoleSettings, heldData: createHeldData({ store, fleet, databases, homes }), people, slackPeople, claudeSettings, viewPrefs, attachments,
    prChips, members, asks, dbRestore, githubSetup, secrets, appShares, provider: { name: provider.name, words: provider.words ?? null }, appIdentity,
    databaseGate, addedProjects,
    projectAccess: createProjectAccess({ config, githubFor, viewPrefs, signIn: () => Boolean(auth?.enabled()) }),
  });
  const hosts = knownHosts(config);
  const appUpgrade = createAppUpgrade({ config, fleet, auth, members, appShares });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('console: request failed', { url: req.url, message: err?.message });
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    });
  });
  // A dump of a gigabyte or two takes longer to send than Node's 5-minute default for a whole request. Caddy is in front.
  server.requestTimeout = 60 * 60_000;
  server.on('upgrade', (req, socket, head) => {
    // An error on a socket nobody listens to is an uncaught exception.
    socket.on('error', () => socket.destroy());
    const appId = appIdFor(req.headers.host, config.appDomain);
    if (appId) return appUpgrade(req, socket, head, appId);
    // woodshed-db.mjs is no browser: no Origin, no cookie, and a token that does what the same-origin check does here.
    if (isKnownHost(req.headers.host, hosts) && tunnel.handleUpgrade(req, socket, head)) return;
    // A websocket is not covered by the same-origin policy, and this one types into claude.
    if (!isKnownHost(req.headers.host, hosts) || !isSameOrigin(req.headers)) {
      console.warn('console: terminal websocket refused', { host: String(req.headers.host).slice(0, 100), origin: String(req.headers.origin).slice(0, 100) });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const allowed = auth?.enabled() ? auth.sessionFor(req.headers.cookie) : Promise.resolve({ login: soloLoginOf(config) });
    allowed.then((user) => {
      if (!user) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      if (!handleTerminalUpgrade(req, socket, head, { targetFor: terminalTarget(fleet, user.login, auth ? members : null) })) socket.destroy();
    }, () => socket.destroy());
  });
  server.listen(config.port, config.host, () => {
    console.log('console: listening', {
      host: config.host, port: config.port, repo: defaultProject(config).repo, projects: config.projects?.map((p) => p.name), label: config.label,
      launcher: config.launcher.kind, maxRunning: config.maxRunning, pollGitHub: config.pollGitHub,
      githubApp: Boolean(tokens), ownDatabases: databases.available, tunnel: tunnel.available,
    });
    // In ECS, sessions get their GitHub token from the task definition's secret, which says what it is.
    if (config.launcher.kind === 'docker' && !tokens && !config.sessionEnv.GH_TOKEN) {
      console.warn('console: sessions push with the console\'s own gh token; set GH_TOKEN in the session env file to give them a narrower one');
    }
  });
  startSessionApi({ config, fleet, tokens, userSettings, githubUser, homes, databases, claudeSettings, anthropic, openai, attachments, asks });
  await startTlsAsk({ config, sessions: () => fleet.sessions() });
  every(60 * 60_000, 'attachments sweep', () => attachments.sweep());
  every(EVENTS_SWEEP_MS, 'webhook events sweep', () => events.sweep());
  // Every session someone can still open: a stopped one's pull request still merges or closes.
  // Every 10 seconds, so a chip a webhook marked due changes soon; only due pull requests are asked for.
  if (tokens) every(10_000, 'pull request chips', () => prChips.refresh(fleet.sessions().filter((s) => s.prUrl && !s.cleanedAt)));
  every(config.tickMs, 'tick', () => fleet.tick());
  every(config.tickMs, 'app shares sweep', () => appShares.sweep(fleet.sessions().filter((s) => ACTIVE_STATUSES.has(s.status)).map((s) => s.id)));
  if (asks) every(config.tickMs, 'asks', () => asks.tick());
  every(config.startingCheckMs, 'starting check', () => fleet.checkStarting());
  if (databases.available) every(databases.POLL_MS, 'databases', () => databases.poll());
  if (!config.pollGitHub) return;
  // Neither starts without an App key: a message read then would fail its three tries and land in the dead-letter queue.
  const keyReady = appKey ? untilAppKey(appKey, config.pollMs) : Promise.resolve();
  keyReady.then(() => {
    every(config.pollMs, 'github poll', () => fleet.pollGitHub());
    appIdentity.login();
    if (provider.webhooks) provider.webhooks.run(createWebhookDispatch({ label: config.label, config, fleet, asks, pulls: pullWebhooks, events, appIdentity }));
  });
}
