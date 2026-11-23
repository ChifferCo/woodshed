// The Woodshed console: lists sessions, opens a live terminal on each, and
// starts them from GitHub labels and `/woodshed` comments.
//
//   GET  /all                    Shared: the rail, and the shared sessions in the pane
//   GET  /s/<id>                 one session: the rail and its terminal
//   GET  /events                 the webhook events page
//   GET  /secrets                the secrets and webhook settings page
//   GET  /console-settings/repos/<project>   a repo's settings page (public/repoSettings.js), for admins: its API says so
//   GET  /                       My Woodshed: your private sessions, and New session
//   GET  /settings               My settings: your Claude token
//   GET  /api/sessions           every shared session and your own private ones, without their tokens
//   GET  /api/my                 your settings' state (never a value), your running count and limit, and each of your
//                                projects that cannot start sessions with why and how to fix it (`projectBlockers`)
//   POST /api/my/sessions        {"prompt", "name", "workOn", "model", "effort", "permissionMode", "project", "herdrParent"}  a private session;
//                                herdrParent: its agent's terminal is made from the person's Herdr, as a child of theirs
//                                (`woodshed session new --herdr --parent`), and the session waits for it
//   GET  /api/my/projects        the projects you can start sessions on, and the one New session opens on for you
//   GET  /api/my/codex-models    the Codex models New session offers you: OpenAI's catalog, read on your Codex sign-in or the team key
//   POST /api/my/projects/default {"project": "<name>"}   New session opens on it for you
//   POST /api/my/claude-token    {"value": "sk-ant-..."}
//   POST /api/my/codex-auth      {"value": "sk-..." or the text of ~/.codex/auth.json}
//   POST /api/my/codex-auth/remove
//   POST /api/my/codex-auth/reviews  {"on": true|false}   reviews of my pull requests run Codex on this sign-in (reviewAgents.mjs)
//   GET  /api/my/reviews              who reviews my pull requests, and the choices this console can run for me
//   POST /api/my/reviews              {"choice": "none"|"claude"|"codex"|"both"|null}   null is the most there is
//   POST /api/my/terminal             {"terminal": "tmux"|"herdr"}   what my private sessions run their agent in
//   POST /api/my/claude-token/remove
//   POST /api/my/claude-token/shared {"on": true}   shared sessions you start from GitHub run on your token
//   POST /api/my/remove          {"confirm": "<your login>"}  Remove My Woodshed: stops your sessions, deletes your settings
//   GET  /api/my/pulls           your open pull requests on every repo you may start on, and those waiting on your review, for the rail
//   POST /api/my/pulls/<number>/review {"project": "<name>"}   the console's review of your own open pull request, now
//                                (fleet.mjs reviewOnDemand): 201 started, 200 already running or done on its head commit
//   GET  /api/my/files/<key>     tmux-conf: the image's tmux.conf, and your own lines added after it; gitconfig, inputrc,
//                                bash-aliases: your own lines for those (shared/dotfiles.mjs)
//   POST /api/my/files/<key> {"text": "..."}   your own lines, for your next sessions; empty clears them
//   POST /api/my/files/<key>/reset             clears them: the image's file alone again
//   GET  /api/my/repos[/<project>[/env/<key>|/instructions|/files]]   your own repo settings, for a repo you can write to (repoSettings.mjs)
//   POST /api/my/repos/<project>/env/<key>|/instructions   {"text": "..."}   yours; empty clears them
//   POST /api/my/repos/<project>/files   {"path": "app/.env.production", "text": "..."}   one of your own whole files, which your
//                                        sessions on that repo write into the checkout; empty text removes it
//   GET  /api/my/own-files, POST /api/my/own-files   the same, from before they were per repo: the default project's
//   GET  /auth/connect           Connect GitHub: sign in once more and keep the token, so your sessions push as you
//   POST /api/my/github/identity {"name": "...", "email": "..."}   what your sessions' commits say
//   POST /api/my/github/disconnect
//   POST /api/my/home/forget     deletes your saved Claude home: MCP logins, memory, transcripts
//   POST /api/my/sessions/<id>/resume   a stopped private session again, claude's conversation and all; {"herdrParent": true}
//                                       as a start's, for that run alone
//   POST /api/my/sessions/<id>/remove   a private session (a running one is stopped first) off the list, with the Claude home it kept
//   POST /api/my/databases       your own databases, made, or copied from the template again ({"confirm": "reset"} once made)
//   POST /api/my/databases/restore?name=<file>   a pg_dump or mongodump as the body, restored into a copy of your database to check;
//                                POST /api/my/databases/restore/apply {"confirm": "apply"} swaps it in, /discard drops it (dbRestore.mjs)
//   POST /api/my/tunnel-token    a token for woodshed-db.mjs, shown once; POST /api/my/tunnel-token/remove revokes it
//   GET  /api/tunnel/connection, UPGRADE /api/tunnel/pg|mongo   your databases from your computer, by that token (dbTunnel.mjs)
//   POST /api/cli/device, /api/cli/token, GET /api/cli/me, POST /api/cli/logout   the woodshed command line's sign-in by a
//                                device code, and its token's calls (cliSignIn.mjs); GET/POST /cli is the page the code is
//                                approved on, signed in
//   GET/POST /api/cli/settings[/repos|/files/<project>|/dotfiles[/<key>]]   that token's turn at your shared Claude and
//                                Codex settings, your own files for a repo, and your own dotfile lines (cliSettings.mjs)
//   POST /api/my/cli-tokens/<id>/revoke   ends one computer's command line sign-in, from My settings
//   Its token also signs in to GET /api/sessions, GET /api/my/projects, POST /api/my/sessions,
//   POST /api/my/sessions/<id>/resume|remove, POST /api/sessions/<id>/stop|extend|limits and GET /api/review-readiness,
//   as its person (cliSessions.mjs); and to GET /api/cli/config, its person's choices on My settings and never a secret, and the
//   writes of them: POST /api/my/terminal, /reviews, /codex-auth/reviews, /claude-token/shared, /projects/default and
//   /github/identity, each answering with that config alone (cliConfig.mjs)
//   POST /api/sessions           {"number": 123, "startedBy": "login", "prompt": "..."}
//   POST /api/sessions/<id>/stop
//   POST /api/sessions/<id>/pin     {"on": true}   pinned to the top of your rail; yours alone
//   POST /api/sessions/<id>/rename  {"title": "..."}   the name every page shows
//   POST /api/sessions/<id>/extend  its pause or stop, whichever comes first, an hour later. These two are a private
//                                session's owner's and a shared one's assignee's alone: 403 for anyone else
//   POST /api/sessions/<id>/limits  {"idleHours": 2, "lifetimeHours": 12}   this session's own pause and stop; a key
//                                left out or null goes back to its owner's or the console's
//   POST /api/my/uploads?name=<file>   one file for your next New session, as the body; {"id"} names it in
//                                POST /api/my/sessions's "attachments" (attachments.mjs)
//   POST /api/sessions/<id>/upload?name=<file>&pane=agent|terminal|none   a file pasted or dropped on a terminal,
//                                saved in the session with its path typed at that pane's prompt (none: not typed)
//   POST /api/sessions/<id>/send    {"text": "..."}   the phone's message box: typed into claude, then Enter
//   GET  /api/sessions/<id>/image?path=<path>   a picture a terminal path names, from the session
//   GET  /qa/<id>/video/<n>       a QA run's recording, for whoever may open the session (qaRecordings.mjs)
//   GET  /qa-poster/<id>/<secret>.png   its still, with no sign-in: the QA comment shows it, through GitHub's image proxy
//   POST /api/sessions/<id>/scroll  {"steps": -3, "pane": "agent"}   a swipe or wheel past the browser's own scrollback
//   GET  /api/skills             the repo's skills and commands, for New session's / list
//   GET  /api/pulls?project=<name>   the project's open pull requests, for New session's Work on list
//   GET  /api/sessions/<id>/applog  the end of the session's app logs: its start, the backend's and the frontend's
//   GET  /api/sessions/<id>/diff    the Diff tab: the checkout against the default branch, uncommitted work included, as a plain diff
//   POST /api/sessions/<id>/interrupt  Esc to the session's agent, the Chat tab's Stop: it ends the agent's turn
//   GET  /api/sessions/<id>/prompt  what the agent's pane asks now (a question picker, an approval), for the Chat tab
//   POST /api/sessions/<id>/answer  the Chat tab's answer to it, which the session types only once its pane shows that
//        same prompt: {"kind": "question", "questions": [{question, options, pick}]} or {"kind": "approval",
//        "decision": "approve"|"deny", "key": <GET /prompt's key, the hash of exactly what it asks>} (session/panePrompt.mjs)
//   GET  /api/sessions/<id>/transcript?limit=<n>&since=<writtenAt>  the conversation so far (what was asked, said and
//        run), for the Chat tab; `since` answers {unchanged: true} while the agent wrote nothing newer
//        (session/sessionTranscript.mjs)
//   GET  /review?session=claude-<id>, /reviews/claude-<id>/...   the Review tab: the shed's own review page and its calls,
//                                carried to the session that answers them (reviewProxy.mjs)
//   GET  /manifest.webmanifest, the icons   install as an app (the shed's pwa.mjs), before sign-in
//   GET  /.well-known/openid-configuration, /.well-known/jwks.json   the console as an OpenID Connect issuer, whose
//                                tokens its MCP relay adds for a server whose auth is oidc (oidcIssuer.mjs, mcpRelay.mjs),
//                                such as woodshed-prod-mcp; before sign-in
//   POST /api/sessions/<id>/resume  {"message": "..."}  a stopped shared session again, its conversation and all
//   POST /api/sessions/<id>/delete  a shared session's conversation and databases, deleted now (a running one is stopped first)
//   POST /api/sessions/<id>/remove  a shared session already deleted, off the list for everyone
//   Admins only (members.mjs), with 403 for anyone else: /api/people*, /api/secrets*, /api/webhook*,
//   /api/console-settings*, the API behind People, Secrets & webhooks, Webhook events and Console settings.
//   GET  /api/webhook-events     what the console did with each queued webhook, and which sources are switched off
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
//   POST /api/people/add|role   {"login": "<handle>", "role": "owner"|"member"}   behind a hosting proxy with the program's
//                                list (hostedMembers.mjs): add someone, or change their role, through the program; remove
//                                takes them off there. Invite, accept, decline and admin are not there
//   POST /api/sessions/<id>/assign  {"to": "<handle>"|null}   a change of who has a shared session, by someone who can be assigned
//   POST /api/people/slack       {"login": "<handle>", "slack": "U01ABC2DEF3" | "@handle" | ""}   links a member's Slack user by hand (slackPeople.mjs)
//   POST /api/access/ask|withdraw  a visitor, signed in but not on the list, asks to join or takes it back
//   POST /api/console-settings   {"values": {"maxRunning": 6, ...}, "slackChannel": "C..."}   one card's changes, all or none
//   POST /api/console-settings/webhooks  {"source": "github"|"slack", "off": true|false}   drop that source's webhooks (webhookSwitch.mjs)
//   GET  /api/console-settings/slack   the Slack card: who the bot is (never a key), the channel, the events Request URL,
//                                the app manifest and the embedding program's install option (slackSetup.mjs)
//   POST /api/console-settings/slack   {"botToken"?, "signingSecret"?, "channel"?}   the Set up Slack dialog's save: an empty
//                                field keeps its value, and a token is checked with Slack's auth.test before anything is kept
//   POST /api/console-settings/slack/check   {"botToken"}   who a pasted token is, by auth.test, keeping nothing
//   POST /api/console-settings/slack/recheck  {}   the saved token asked about again (its scopes after a reinstall), as GET answers
//   GET  /api/console-settings/slack/channels?q=   the channel picker: channels whose name has that text, and whether the bot
//                                is in each; POST with {"q", "botToken"} lists them with a token pasted but not saved yet
//   POST /api/console-settings/slack/disconnect  {"confirm": "slack"}   both Slack secrets deleted, where the store can make them again
//   POST /api/console-settings/projects         {"repo": "owner/name", "name": "optional"}   add a repo sessions can start on (addedProjects.mjs)
//   GET  /api/console-settings/projects/repos   the repos the GitHub App may reach that are not projects yet, for Add a repo
//   POST /api/console-settings/projects/remove  {"name": "<project>"}   take an added repo off, with its repo settings
//   GET  /api/console-settings/repos/<project>[/env/<key>|/instructions]   a repo's settings, the installation's values (repoSettings.mjs)
//   POST /api/console-settings/repos/<project>/env/<key>[/remove]|/instructions   {"text": "..."}   the installation's; empty clears
//   POST /api/console-settings/projects/triggers   {"name": "<project>", "label": "woodshed"|null, "labels": bool, "comments": bool}
//        a repo's session label and whether its label and /woodshed comments start anything (repoTriggers.mjs); each optional
//   POST /api/console-settings/projects/color   {"name": "<project>", "color": "teal"}   a project's colour on the rail, from the palette (projectColors.mjs)
//   POST /api/console-settings/projects/slack-channel  {"name": "<project>", "channel": "C..."|""}   a repo's own Slack channel, from its settings page
//   POST /api/console-settings/clean  {"kind": "stuck"|"databases"|"home", "id": "<session id>"}  a stalled row's fix
//   GET  /api/console-settings/mcp-servers   the MCP servers sessions get through the relay (mcpServers.mjs), never a
//                                header's value, whether this console can lock a session down for a production one, and
//                                the issuer and JWKS a server whose auth is oidc trusts
//   POST /api/console-settings/mcp-servers   {"server": {"name", "url", "production", "shared", "people", "repos", "auth",
//                                "audience", "header"}}   adds one, or replaces the one of that name; answers the list
//   POST /api/console-settings/mcp-servers/remove  {"name": "<server>"}
//   POST /api/console-settings/mcp-servers/header  {"name": "<server>", "value": "..."|""}   the header the console adds
//                                to a server whose auth is header, kept in the secret store and never shown again
//   POST /api/console-settings/mcp-servers/test  {"server": {...as above}, "value"?: "..."} or {"name": "<server>"}
//                                calls the server as the relay would, with the same auth (mcpTest.mjs): initialize, then
//                                tools/list. `value` is a header value to use instead of the saved one. Answers
//                                {"ok": true, "status", "serverInfo": {"name", "version"}|null, "tools": <count>|null, "ms"}
//                                or {"ok": false, "status": <number>|null, "error": "<what to do>"}; never a body or a secret
//   GET  /api/console-settings/updates         the Woodshed commit this console runs, the newer ones on the branch its
//                                git clone follows, and an update's steps (woodshedUpdate.mjs)
//   POST /api/console-settings/updates/check   fetch that branch again, now
//   POST /api/console-settings/updates/update  pull the new commits, build the session image if it changed, restart
//   GET  /api/webhook/deliveries GitHub's last 10 deliveries to the App's webhook, with their status codes
//   POST /api/webhook/rotate     {"confirm": "github-webhook-secret"}
//   POST /api/webhook/apply      {"confirm": "webhook"}   the Lambda's URL and the stored secret, set on the App
//   POST /api/webhook/url        {"url": "https://...", "confirm": "webhook"}
//   *    /term/<id>/...          the session's ttyd on claude's tmux (the TUI tab), proxied with its credentials
//   *    /shell/<id>/...         its second ttyd, on a plain shell in the repo (the Terminal tab)
//   *    /redis/<id>/...         the session's redis-commander, through its statusd
//   *    /pg/<id>/..., /mongo/<id>/...   a session's pgweb and mongo-express, on the databases the console made for it
//   GET  /login, /auth/start, /auth/callback, POST /auth/sign-out   sign-in with GitHub (auth.mjs); behind a hosting
//                                proxy, POST /auth/sign-out alone, which the program embedding the console answers
//   GET  /api/me                 who is signed in, and whether sign-in is on
//   POST /api/sessions/<id>/app/start  start the session's app: {"app": "<name>"} picks one of several; the answer has `started`, false when the session took no start
//   POST /api/sessions/<id>/app/stop   stop it; the answer has `stopping`, false when no stop ran
//   POST /api/sessions/<id>/app/setup  ask its claude to write the project file's app, when it has none
//   POST /api/sessions/<id>/claude-login   type woodshed-login at the session's Terminal tab (a My Woodshed session)
//   GET  /api/sessions/<id>/review     what the session's branch changes, from GitHub (review.mjs)
//   *    https://<id>.<app domain>/...  the session's running app, through its statusd (appProxy.mjs)
//   GET  /auth/app?id=&next=     a one-time code that signs this browser in to that app (auth.mjs)
//   GET  /auth/desktop, POST /auth/desktop/claim   the desktop app's sign-in through the browser (desktopSignIn.mjs)
//   GET  https://<id>.<app domain>/__woodshed/auth   claims the code: the app's own sign-in cookie
//   GET  /api/sessions/<id>/app-share   who else may open a My Woodshed session's app, and its links (owner only; appShares.mjs)
//   POST /api/sessions/<id>/app-share/members  {"on": true}   every signed-in member may open the app
//   POST /api/sessions/<id>/app-share/links    {"hours": 24, "path"?: "/landing"}  a link anyone can open, with its
//        expiry and, if asked, the app's page it lands on; the token is shown once
//   POST /api/sessions/<id>/app-share/links/<linkId>/revoke   ends one link
//        These four take the command line's token too, for woodshed session app <id> share (cliSessions.mjs)
//   GET  https://<id>.<app domain>/__woodshed/share?t=<token>[&next=<path>]   claims a link: a cookie for that one app,
//        until the link ends, then the app's `next` page (shareNext in appShares.mjs: a path on the app, or /)
//   *    https://<id>.<app domain>/__woodshed/code/...   the session's VS Code, through its statusd, websockets too:
//        Editor ↗, for whoever can open the session itself (editorProxy.mjs)
//
// In AWS it sits behind Caddy, open to the internet, and every page, API call and terminal needs a GitHub
// sign-in with write access (auth.mjs, always required there by WOODSHED_REQUIRE_SIGN_IN). Locally it
// listens on loopback and has no sign-in. Hosted, a trusted proxy in front of it signs people in instead, with a
// header on every request (trustedIdentity.mjs), and there is no GitHub sign-in at all. Every request must name a
// host the console answers to, which stops DNS rebinding, and writes and terminal websockets must
// come from the console's own origin, checked with Woodshed's sameOrigin.mjs.
// Writes also need the `x-woodshed: 1` header, which a cross-site form cannot send. The console's own pages
// (People, secrets, webhook history, Console settings) are an admin's: ADMIN_API_RE below.
//
// A session started from My Woodshed is private: every route that reaches it (its page's data, terminal,
// Redis, app, review, Stop, the websockets) answers anyone but its owner as it would an id that does not exist.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_NAMES, viewersOf } from '../shared/databases/index.mjs';
import { handlePwaRequest, MANIFEST } from '../shared/pwa.mjs';
import { createReviewProxy, isReviewPath } from './reviewProxy.mjs';
import { isKnownHost, isSameOrigin } from '../shared/sameOrigin.mjs';
import { shareNext } from './appShares.mjs';
import { safeNext, signInFailure } from './auth.mjs';
import { handleDesktopSignIn } from './desktopSignIn.mjs';
import { handleCliApi, handleCliPage, sessionSignInsOf } from './cliSignIn.mjs';
import { CLI_REPOS_PATH, handleCliRepos } from './cliRepos.mjs';
import { carriesCliToken, handleCliCall } from './cliSessions.mjs';
import { REVIEW_READINESS_PATH, reviewReadinessReply } from './reviewReadiness.mjs';
import { answerWithView, CLI_CONFIG_PATH, configView, isConfigWrite } from './cliConfig.mjs';
import { handleCliSettings } from './cliSettings.mjs';
import { DEFAULT_CONSOLE_NAME, loadConfig } from './config.mjs';
import { MAX_ATTACHMENT_BYTES } from './attachments.mjs';
import { QA_POSTER_RE, QA_VIDEO_RE } from './qaRecordings.mjs';
import { CONNECTION_PATH } from './dbTunnel.mjs';
import { checkGh } from './github.mjs';
import { BUILT_IN as BUILT_IN_CODEX_MODELS } from './codexModels.mjs';
import { applyStored, createGitHubAppSetup, supervisorOf } from './githubAppSetup.mjs';
import { createInstallation } from './installation.mjs';
import { ACTIVE_STATUSES, activePrivateCount, canSee, linkQueryString, prUrlsOf, publicSession, sharedRunningCount } from './sessions.mjs';
import { WEBHOOK_SECRET } from './settings.mjs';
import { openStore } from './store.mjs';
import { parseHandle } from './members.mjs';
import { handleTerminalRequest, handleTerminalUpgrade } from './terminalProxy.mjs';
import { appIdFor, handleAppRequest, handleAppUpgrade } from './appProxy.mjs';
import { handleEditorRequest, handleEditorUpgrade, isEditorPath } from './editorProxy.mjs';
import { startTlsAsk } from './tlsAsk.mjs';
import { providerMetaContent } from './providerWords.mjs';
import { createTrustedIdentity } from './trustedIdentity.mjs';
import projectColorsShared from './public/projectColors.cjs';
import { allProjects, defaultProject, hasRepo, projectFor, projectNamed } from './projects.mjs';
import { readMyPulls } from './myPulls.mjs';
import { createRepoSettingsApi, repoSettingsRoute } from './repoSettings.mjs';
import { countRequests, createShutdown } from './shutdown.mjs';
import { DISCOVERY_PATH, JWKS_PATH } from './oidcIssuer.mjs';
import { createMcpTester } from './mcpTest.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
// /, /all and a session's page are one page, session.js last.
// The settings pages are one page too: each address loads every settings page's script, and common.js shows the one the
// address names, then moves between them in place (settingsPage), so switching pages never reloads.
// The most one message to an agent may be: statusd's own limit (session/statusd.mjs, MAX_SEND_CHARS).
export const MAX_MESSAGE_CHARS = 8000;
const SETTINGS_SCRIPTS = ['dbRestoreStates.js', 'dbRestore.js', 'repoLayers.js', 'myRepoSettings.js', 'mySettings.js', 'slackSetup.js', 'consoleSettings.js', 'repoSettings.js', 'webhookSetup.js', 'secrets.js', 'people.js', 'events.js', 'usage.js'];
const SHELL_SCRIPTS = ['terminalCache.js', 'terminalScroll.cjs', 'terminalFind.cjs', 'sessionTabs.cjs', 'terminal.js', 'dictation.js', 'launcher.js', 'sharedHome.js', 'messageBox.js', 'chatThread.cjs', 'chat.js', 'appShare.js', 'session.js'];
const STATIC_FILES = {
  'style.css': 'text/css; charset=utf-8',
  'logins.cjs': 'text/javascript; charset=utf-8',
  'setupSteps.cjs': 'text/javascript; charset=utf-8',
  'inviteLink.cjs': 'text/javascript; charset=utf-8',
  'openPulls.cjs': 'text/javascript; charset=utf-8',
  'settingsIndex.cjs': 'text/javascript; charset=utf-8',
  'settingsSearch.js': 'text/javascript; charset=utf-8',
  'keys.cjs': 'text/javascript; charset=utf-8',
  'projectColors.cjs': 'text/javascript; charset=utf-8',
  'common.js': 'text/javascript; charset=utf-8',
  'theme.js': 'text/javascript; charset=utf-8',
  'shell.js': 'text/javascript; charset=utf-8',
  'hostSettings.js': 'text/javascript; charset=utf-8',
  'terminalCache.js': 'text/javascript; charset=utf-8',
  'terminalScroll.cjs': 'text/javascript; charset=utf-8',
  'terminalFind.cjs': 'text/javascript; charset=utf-8',
  'sessionTabs.cjs': 'text/javascript; charset=utf-8',
  'terminal.js': 'text/javascript; charset=utf-8',
  'sharedHome.js': 'text/javascript; charset=utf-8',
  'dictation.js': 'text/javascript; charset=utf-8',
  'messageBox.js': 'text/javascript; charset=utf-8',
  'chatThread.cjs': 'text/javascript; charset=utf-8',
  'chat.js': 'text/javascript; charset=utf-8',
  'appShare.js': 'text/javascript; charset=utf-8',
  'session.js': 'text/javascript; charset=utf-8',
  'events.js': 'text/javascript; charset=utf-8',
  'usage.js': 'text/javascript; charset=utf-8',
  'secrets.js': 'text/javascript; charset=utf-8',
  'webhookSetup.js': 'text/javascript; charset=utf-8',
  'slackSetup.js': 'text/javascript; charset=utf-8',
  'githubSetup.js': 'text/javascript; charset=utf-8',
  'login.js': 'text/javascript; charset=utf-8',
  'launcher.js': 'text/javascript; charset=utf-8',
  'mySettings.js': 'text/javascript; charset=utf-8',
  'dbRestore.js': 'text/javascript; charset=utf-8',
  'dbRestoreStates.js': 'text/javascript; charset=utf-8',
  'consoleSettings.js': 'text/javascript; charset=utf-8',
  'repoSettings.js': 'text/javascript; charset=utf-8',
  'repoLayers.js': 'text/javascript; charset=utf-8',
  'myRepoSettings.js': 'text/javascript; charset=utf-8',
  'people.js': 'text/javascript; charset=utf-8',
  // Run on people's own computers, so it is served before sign-in; it holds nothing secret.
  'woodshed-db.mjs': 'text/javascript; charset=utf-8',
};
const MAX_BODY_BYTES = 16 * 1024;
// A whole .env file, JSON-escaped, under Secrets Manager's 64 KB.
const MAX_SECRET_BODY_BYTES = 160 * 1024;
const PEOPLE_RE = /^\/api\/people\/(invite|accept|decline|remove|slack|assignable|github-sessions|admin|add|role)$/;
const SESSION_PAGE_RE = /^\/s\/([0-9a-f]{8})$/;
// A repo's settings page: its project's name, as Console settings' Repos card links it.
const REPO_SETTINGS_PAGE_RE = /^\/console-settings\/repos\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The console's own settings pages, served as one page with /settings (SETTINGS_SCRIPTS).
const SETTINGS_PAGE_RE = new RegExp(`^/(?:events|secrets|people|console-settings|usage)$|${REPO_SETTINGS_PAGE_RE.source}`);
const MY_CODEX_AUTH_RE = /^\/api\/my\/codex-auth(?:\/(remove|reviews))?$/;
const MY_LIMITS_PATH = '/api/my/limits';
const PROJECTS_PATH = '/api/console-settings/projects';
const UPDATES_PATH = '/api/console-settings/updates';
const UPDATES_CHECK_PATH = `${UPDATES_PATH}/check`;
const UPDATES_UPDATE_PATH = `${UPDATES_PATH}/update`;
const PROJECT_COLOR_PATH = '/api/console-settings/projects/color';
const PROJECT_CHANNEL_PATH = `${PROJECTS_PATH}/slack-channel`;
const SLACK_SETUP_PATH = '/api/console-settings/slack';
const SLACK_SETUP_WRITE_RE = /^\/api\/console-settings\/slack(?:\/(check|recheck|channels|disconnect))?$/;
const PROJECT_TRIGGERS_PATH = `${PROJECTS_PATH}/triggers`;
const MCP_SERVERS_PATH = '/api/console-settings/mcp-servers';
const MCP_SERVERS_TEST_PATH = `${MCP_SERVERS_PATH}/test`;
const MCP_SERVERS_WRITES = new Set([MCP_SERVERS_PATH, `${MCP_SERVERS_PATH}/remove`, `${MCP_SERVERS_PATH}/header`, MCP_SERVERS_TEST_PATH]);
const MY_DEFAULT_PROJECT_PATH = '/api/my/projects/default';
// The tab a session opens on when none was picked for it, on a desktop and on a phone (viewPrefs.mjs).
const MY_SESSION_VIEW_PATH = '/api/my/session-view';
const MY_TOKEN_RE = /^\/api\/my\/claude-token(?:\/(remove|shared))?$/;
const PULLS_FRESH_MS = 60_000;
const MY_FILE_RE = /^\/api\/my\/files\/([a-z-]+)(\/reset)?$/;
const MY_GITHUB_RE = /^\/api\/my\/github\/(identity|disconnect)$/;
const MY_SESSION_ACTION_RE = /^\/api\/my\/sessions\/([0-9a-f]{8})\/(resume|remove)$/;
const MY_PULL_REVIEW_RE = /^\/api\/my\/pulls\/([1-9][0-9]{0,8})\/review$/;
const MY_TUNNEL_RE = /^\/api\/my\/tunnel-token(\/remove)?$/;
const MY_CLI_REVOKE_RE = /^\/api\/my\/cli-tokens\/([0-9a-f]{16})\/revoke$/;
const MY_RESTORE_RE = /^\/api\/my\/databases\/restore\/(apply|discard)$/;
// A whole .env file, JSON-escaped, under Secrets Manager's 64 KB; own files' limit follows the secret store's.
const MAX_FILE_BODY_BYTES = 160 * 1024;
const DATABASES_NOT_READY = 'your own databases are not ready yet: My settings shows how far along they are';
const STOP_RE = /^\/api\/sessions\/([0-9a-f]{8})\/stop$/;
const ASSIGN_RE = /^\/api\/sessions\/([0-9a-f]{8})\/assign$/;
const SHARED_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(resume|delete|remove)$/;
const VIEW_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(pin|rename)$/;
const LIMIT_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(extend|limits)$/;
const TERMINAL_RE = /^\/api\/sessions\/([0-9a-f]{8})\/(upload|image|scroll|send|interrupt|answer|prompt|applog|diff|transcript)$/;
// The skills in the repo change with a merge; an hour is soon enough for a / list.
const SKILLS_FRESH_MS = 60 * 60_000;
// A project's open pull requests, for New session's Work on list: every launcher that opens asks.
const OPEN_PULLS_FRESH_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
// The shed's mark and install details, under the console's name (config.consoleName), made once for each name.
// Served before sign-in: a browser fetches the manifest without cookies.
const consoleManifests = new Map();
function consoleManifest(name) {
  if (!consoleManifests.has(name)) {
    consoleManifests.set(name, JSON.stringify({ ...MANIFEST, name, short_name: name, description: 'Claude sessions in containers.' }, null, 2));
  }
  return consoleManifests.get(name);
}
const PWA_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
const MAX_RESUME_MESSAGE_CHARS = 4000;
const CLAUDE_LOGIN_RE = /^\/api\/sessions\/([0-9a-f]{8})\/claude-login$/;
const APP_ACTION_RE = /^\/api\/sessions\/([0-9a-f]{8})\/app\/(start|stop|setup)$/;
const REVIEW_RE = /^\/api\/sessions\/([0-9a-f]{8})\/review$/;
const SECRET_RE = /^\/api\/secrets\/([a-z0-9-]+)(\/reveal)?$/;
const SETUP_WRITE_RE = /^\/api\/setup\/github\/(manifest|paste|installation|restart)$/;
const REVIEWER_SETUP_PATH = '/api/setup/github/reviewer';
const WEBHOOK_RE = /^\/api\/webhook\/(rotate|apply|url)$/;
// The calls behind People, Secrets & webhooks, Webhook events and Console settings. Their pages load for anyone signed
// in, and say what these calls answer.
const ADMIN_API_RE = /^\/api\/(?:people|secrets|secrets-manager|webhook|console-settings|setup)(?:\/|$)|^\/api\/webhook-events$/;
const APP_ID_RE = /^[0-9a-f]{8}$/;
const APP_AUTH_PATH = '/__woodshed/auth';
const APP_SHARE_PATH = '/__woodshed/share';
// The GitHub App setup page and its calls, which a console that borrows its GitHub access has none of.
const SETUP_PATH_RE = /^\/(?:api\/)?setup\/github(?:\/|$)/;
// What a program embedding the console may add to the user menu (menuOf): how much of it, and how long each text.
const MENU_TEXT_CHARS = 100;
const MENU_ITEMS = 50;
// The most tabs a program embedding the console may add beside Settings' own (settingsTabsOf).
const SETTINGS_TABS = 8;
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

// A link from a program embedding the console goes into an href: a path on the console's own name, or the web.
function menuHref(href) {
  if (typeof href !== 'string' || href.length > 2000) return null;
  // A browser drops tabs and newlines from a URL and trims control characters and spaces, so `/\t/host` is `//host`.
  if (/[\u0000-\u001f\u007f\s]/.test(href)) return null;
  if (/^https?:\/\//i.test(href)) return href;
  // `//host` and `/\\host` are both another site to a browser.
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\') ? href : null;
}

function menuText(value) {
  return typeof value === 'string' ? value.slice(0, MENU_TEXT_CHARS) : '';
}

/**
 * The tabs a program embedding the console adds to Settings (createInstallation's `settingsTabs`), as /api/me sends
 * them: each a label and a path on the console's own name, drawn after General and Secrets & webhooks (common.js,
 * settingsTabs). A tab is the program's own page, which shows in the settings frame by `settingsFrame`; anything that is
 * not a path is dropped, since a tab never leaves the console.
 * @param {(headers: object) => {label: string, href: string}[]|null} settingsTabs
 * @param {object} headers  the request's
 * @returns {{settingsTabs?: {label: string, href: string}[]}}
 */
export function settingsTabsOf(settingsTabs, headers) {
  let given;
  try {
    given = settingsTabs(headers) ?? [];
  } catch (err) {
    console.warn('console: settings tabs not given', { message: String(err?.message ?? err).split('\n')[0] });
    return {};
  }
  const tabs = (Array.isArray(given) ? given : []).map((tab) => ({ label: menuText(tab?.label), href: menuHref(tab?.href) }))
    .filter((tab) => tab.label && tab.href?.startsWith('/')).slice(0, SETTINGS_TABS);
  return tabs.length ? { settingsTabs: tabs } : {};
}

/**
 * What a program embedding the console adds to the user menu and the settings list (createInstallation's `userMenu`),
 * as /api/me sends it: text cut short, each link a path or an http(s) address, and the rest dropped, fifty links in all.
 * common.js draws it (designSystem/components/MenuGroups).
 * @param {(headers: object) => {subtitle?: string, you?: {label: string, href: string}[],
 *          groups?: {label?: string, items: {label: string, href?: string, current?: boolean, note?: string}[]}[],
 *          sections?: {label: string, items: {label: string, href: string, items?: {label: string, href: string}[]}[]}[]}|null} userMenu
 *   `subtitle` goes under the person's name on the user button. `you` are the person's own pages, after My settings
 *   under their name and in the settings list's You group. `groups` are the switcher, after those: a `label` and its
 *   items, each with `current`, `current: true` the one in use (it needs no `href`). `sections` follow the Console
 *   group, each a heading and its pages, a page with its own pages under it (`items`) as Settings has its tabs. A group
 *   with no label and no choices in it is read as `you` links, which it was drawn as before there were any
 * @param {object} headers  the request's
 * @returns {{menuSubtitle?: string, menuYou?: object[], menuGroups?: object[], menuSections?: object[]}}
 */
export function menuOf(userMenu, headers) {
  let given;
  try {
    given = userMenu(headers) ?? {};
  } catch (err) {
    console.warn('console: user menu not given', { message: String(err?.message ?? err).split('\n')[0] });
    return {};
  }
  let room = MENU_ITEMS;
  const listOf = (value) => (Array.isArray(value) ? value : []);
  const take = (items) => {
    const kept = items.slice(0, Math.max(room, 0));
    room -= kept.length;
    return kept;
  };
  const link = (item) => ({ label: menuText(item?.label), href: menuHref(item?.href) });
  const links = (items) => take(listOf(items).map(link).filter((item) => item.label && item.href));
  const you = links(given.you);
  const groups = listOf(given.groups).map((group) => {
    const items = take(listOf(group?.items).map((item) => ({
      label: menuText(item?.label),
      href: item?.current === true ? null : menuHref(item?.href),
      ...(typeof item?.current === 'boolean' ? { current: item.current } : {}),
      note: menuText(item?.note) || null,
    })).filter((item) => item.label && (item.href || item.current === true)));
    return { label: menuText(group?.label) || null, items };
  }).filter((group) => {
    if (!group.items.length) return false;
    // The old way to put links under the name: a group of plain links with no label of its own.
    if (group.label || group.items.some((item) => typeof item.current === 'boolean')) return true;
    you.push(...group.items.map(({ label, href }) => ({ label, href })));
    return false;
  });
  // A section with no heading takes no room from those after it.
  const sections = listOf(given.sections).filter((section) => menuText(section?.label)).map((section) => ({
    label: menuText(section.label),
    items: listOf(section.items).map((item) => {
      const [entry] = links([item]);
      return entry && { ...entry, items: links(item?.items) };
    }).filter(Boolean),
  })).filter((section) => section.items.length);
  const subtitle = menuText(given.subtitle);
  return {
    ...(subtitle ? { menuSubtitle: subtitle } : {}), ...(you.length ? { menuYou: you } : {}),
    ...(groups.length ? { menuGroups: groups } : {}), ...(sections.length ? { menuSections: sections } : {}),
  };
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

/** @returns {string}  the text with what HTML reads in an attribute or between tags escaped */
function escapeHtml(text) {
  return String(text).replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @returns {string}  the file's URL, versioned */
function staticUrl(file) {
  return `/static/${file}?v=${staticHash(file)}`;
}

/**
 * @param {{title: string, script: string|string[], login?: string|null, provider?: {name: string, words?: object}|null,
 *          linkQuery?: Record<string, string>|null, hostPage?: string, styles?: string[]}} args
 *   `title` is the console's name (config.consoleName): the page's title, the installed app's on a home screen, and
 *   what the scripts call the console (common.js, W.consoleName); `script` is the page's scripts, loaded in order
 *   after common.js; `provider`'s words are what the page says about where sessions run (providerWords.mjs), the
 *   defaults where it has none; `linkQuery` is config.linkQuery; `hostPage` is settingsFrame's template, after #app, and
 *   `styles` its program's stylesheets, after the console's
 * @returns {string}  the page shell; the script renders everything from /api/sessions
 */
export function pageShell({ title, script, login = null, provider = null, linkQuery = null, hostPage = '', styles = [] }) {
  // Whose page it is, for session.js to draw from what it kept only for the same person. A GitHub login, or nothing.
  const who = /^[A-Za-z0-9-]{1,39}$/.test(String(login ?? '')) ? `\n<meta name="woodshed-login" content="${login}">` : '';
  // What the links a page copies carry (config.linkQuery). URLSearchParams leaves nothing an attribute needs escaped.
  const query = linkQueryString(linkQuery);
  const queryMeta = query ? `\n<meta name="woodshed-link-query" content="${query}">` : '';
  const name = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${who}${queryMeta}
<meta name="woodshed-provider" content="${providerMetaContent(provider)}">
<meta name="woodshed-console-name" content="${name}">
<title>${name}</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1b2232">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${name}">
<script src="${staticUrl('theme.js')}"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Red+Hat+Display:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="${staticUrl('style.css')}">${styles.map((href) => `\n<link rel="stylesheet" href="${escapeHtml(href)}">`).join('')}
</head>
<body>
<div id="app"></div>${hostPage}
<script src="${staticUrl('logins.cjs')}"></script>
<script src="${staticUrl('setupSteps.cjs')}"></script>
<script src="${staticUrl('inviteLink.cjs')}"></script>
<script src="${staticUrl('openPulls.cjs')}"></script>
<script src="${staticUrl('projectColors.cjs')}"></script>
<script src="${staticUrl('settingsIndex.cjs')}"></script>
<script src="${staticUrl('common.js')}"></script>
<script src="${staticUrl('settingsSearch.js')}"></script>
<script src="${staticUrl('keys.cjs')}"></script>
<script src="${staticUrl('shell.js')}"></script>
${[script].flat().map((s) => `<script src="${staticUrl(s)}"></script>`).join('\n')}
</body>
</html>
`;
}

/**
 * A page of a program embedding the console, in the settings pages' frame: the side list, the avatar menu, and the title
 * Settings over its tabs, with `current` marked (a tab `settingsTabs` gave). The program renders `body` itself, as HTML
 * it has escaped; it is shown as it is, under the tabs (public/hostSettings.js). Its forms and links are the program's,
 * so a click on another tab loads that page.
 * A page that is one of the program's own entries in the menu (`userMenu`'s `you` or `sections`) rather than a tab of
 * Settings gives its own `heading`, and `tabs`, the row under it (its entry's own pages), or none: `current` then marks
 * its entry, and the tab of that row it is.
 * @param {{title: string, body: string, current: string, heading?: string|null, tabs?: {label: string, href: string}[]|null,
 *          login?: string|null, linkQuery?: object|null, styles?: string[]}} page
 *   `title` is the browser tab's (the console's name, as on its own pages); `styles` are the program's stylesheets for
 *   its part, each a path on the console's name (anything else is dropped), loaded after the console's, so its rules
 *   can use the design system's colours (`var(--ink)` and the rest) and follow the theme; `tabs` are paths on the
 *   console's name too, as Settings' are
 * @returns {string}  the whole page
 */
export function settingsFrame({ title, body, current, heading = null, tabs = null, login = null, linkQuery = null, styles = [] }) {
  // A template is never drawn by the browser, and its contents are not run: hostSettings.js moves them into the frame.
  // "</template" in the body would end it early, so the body cannot hold one.
  const html = String(body ?? '').replace(/<\/template/gi, '&lt;/template');
  const own = menuText(heading);
  const row = (Array.isArray(tabs) ? tabs : []).map((tab) => ({ label: menuText(tab?.label), href: menuHref(tab?.href) }))
    .filter((tab) => tab.label && tab.href?.startsWith('/')).slice(0, SETTINGS_TABS);
  const attrs = [`data-current="${escapeHtml(String(current ?? ''))}"`,
    ...(own ? [`data-heading="${escapeHtml(own)}"`, `data-tabs="${escapeHtml(JSON.stringify(row))}"`] : [])].join(' ');
  const hostPage = `\n<template id="woodshed-host-page" ${attrs}>${html}</template>`;
  const sheets = styles.filter((href) => typeof href === 'string' && href.startsWith('/') && !href.startsWith('//'));
  return pageShell({ title, script: 'hostSettings.js', login, linkQuery, hostPage, styles: sheets });
}

/**
 * What the console serves to anyone, signed in or not: the page scripts and styles, the same for every installation,
 * and the install-as-an-app manifest, under the console's name, and its icons (a browser fetches the manifest without
 * cookies).
 * @param {string} [consoleName]  config.consoleName
 * @returns {boolean}  whether it answered
 */
export function servePublic(req, res, url, consoleName = DEFAULT_CONSOLE_NAME) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(consoleManifest(consoleName));
    return true;
  }
  if (PWA_PATHS.has(url.pathname) && handlePwaRequest(req, res)) return true;
  const file = url.pathname.startsWith('/static/') ? url.pathname.slice('/static/'.length) : null;
  if (!file || !STATIC_FILES[file]) return false;
  // Only the version a page names is kept: an old or missing ?v= is asked for again each time.
  const current = url.searchParams.get('v') === staticHash(file);
  res.writeHead(200, { 'content-type': STATIC_FILES[file], 'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
  return true;
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

// The app states in which a session's app holds one of WOODSHED_APP_PORTS (appPorts.mjs).
const APP_HOLDS_PORT = new Set(['starting', 'running', 'api-down', 'frontend-down']);

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

// The hosting proxy signed the browser in on the console's name, but sent nothing on the app's: its setup, not the
// person's, so the page says so rather than sending them round again.
function noIdentityPage(id, publicUrl) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Not signed in to the app</title>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1rem; line-height: 1.5">
<h1 style="font-size: 1.4rem">This app's name did not say who you are</h1>
<p>The service that hosts this console signs you in to it, and must do the same on its apps' names.</p>
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
 * Websockets to a session's app. Once sign-in is required they need the app's own cookie, as its pages do, or the
 * hosting proxy's identity header.
 * @param {{config: object, fleet: object, auth?: object|null, trusted?: ReturnType<typeof createTrustedIdentity>|null}} deps
 */
export function createAppUpgrade({ config, fleet, auth = null, members = null, appShares = null, trusted = null }) {
  return function appUpgrade(req, socket, head, id) {
    if (isEditorPath(new URL(req.url || '/', 'http://app.invalid').pathname)) return editorUpgrade(req, socket, head, id);
    const allowed = trusted || auth?.enabled()
      ? appViewerFor({ auth, trusted, appShares, headers: req.headers, appId: id })
      : Promise.resolve({ login: soloLoginOf(config), link: false });
    allowed.then((viewer) => {
      if (!viewer) {
        console.warn('app: websocket refused, not signed in', { id });
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      const targetFor = appTarget({ fleet, login: viewer.login, members: accessList(auth, members), shares: appShares, link: viewer.link });
      handleAppUpgrade(req, socket, head, { id, targetFor, dropCookie: [auth?.appCookie, appShares?.cookieName] });
    }, () => socket.destroy());
  };

  // The editor's websocket: the app's own sign-in, never a share link's cookie.
  function editorUpgrade(req, socket, head, id) {
    const user = trusted || auth?.enabled() ? appUserFor({ auth, trusted, headers: req.headers, appId: id }) : Promise.resolve({ login: soloLoginOf(config) });
    user.then((viewer) => {
      if (!viewer) {
        console.warn('editor: websocket refused, not signed in', { id });
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      handleEditorUpgrade(req, socket, head, { id, target: editorTarget({ fleet, login: viewer.login, members: accessList(auth, members), id }) });
    }, () => socket.destroy());
  }
}

/**
 * @param {{config: object, fleet: object, settings?: ReturnType<typeof import('./settings.mjs').createSettings>|null,
 *          events?: {list: () => object[]}, review?: ReturnType<typeof createReviewSource>|null,
 *          people?: {names: (logins: Iterable<string>) => Record<string, string>}|null}} deps
 *   `settings` only where the Secrets page works (AWS); `people` gives the pages each handle's display name
 */
export function createHandler({
  config, fleet, settings = null, events = { list: () => [] }, webhookSwitch = null, reviewAgents = null, auth = null, review = null, userSettings = null, github = null,
  githubUser = null, homes = null, databases = null, tunnel = null, slack = null, consoleSettings = null, heldData = null,
  people = null, slackPeople = null, claudeSettings = null, viewPrefs = null, attachments = null, qaRecordings = null, prChips = null, members = null, asks = null,
  dbRestore = null, githubSetup = null, reviewerApp = null, secrets = null, appShares = null, provider = null, appIdentity = null, databaseGate = null, projectAccess = null, addedProjects = null,
  projectColors = null, githubFor = null, trusted = null, userMenu = null, settingsTabs = null, signOut = null, woodshedUpdate = null, codexModels = null, appPorts = null,
  openaiTeamKey = null, repoSettings = null, repoTriggers = null, workflowLinks = null, slackSetup = null, githubConnectHref = null, githubConnectAutomatic = false, oidc = null, mcpServers = null,
  cli = null, reviewReadiness = null, usage = null,
}) {
  // Tests an MCP server as the relay would call it, from the Console settings page (mcpTest.mjs).
  const mcpTester = mcpServers ? createMcpTester({ servers: mcpServers, issuer: oidc }) : null;
  const repoSettingsApi = repoSettings ? createRepoSettingsApi({ repoSettings, config, projectAccess, slackOf: repoSlack, triggersOf: repoTriggersView, myView: (login) => myView(login) }) : null;
  const hosts = knownHosts(config);
  const soloLogin = soloLoginOf(config);
  // A config made in a test or by a program embedding the console may not have been through loadConfig.
  const consoleName = config.consoleName || DEFAULT_CONSOLE_NAME;
  // Who may open a shared session is the People list's to say, once sign-in tells people apart.
  const access = accessList(auth, members);
  // Each project's skills, by project name: one read of GitHub at a time for each, since every keystroke after `/` asks.
  const skillsCaches = new Map();
  const skillsReadings = new Map();
  // Each project's open pull requests, by project name, read once at a time like the skills.
  const openPullsCaches = new Map();
  const openPullsReadings = new Map();
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

  // Sign-in is required: by the hosting proxy's header, or by GitHub sign-in once it is turned on.
  function signInOn() {
    return Boolean(trusted) || Boolean(auth?.enabled());
  }

  // A console one person uses: as WOODSHED_ONE_PERSON says when it is set (hosted mode keeps no People list, so the host
  // says it), else one nobody signs in to (loopback only: requireClosedWhenReachable) or whose People list has one
  // member. Every shared session there is that person's, so the rail shows one list with no Mine and Everyone.
  function onePersonConsole() {
    if (typeof config.onePerson === 'boolean') return config.onePerson;
    if (!signInOn()) return true;
    // A program's own list (hostedMembers.mjs) is not counted: the program says it, as without one.
    return Boolean(members) && !members.hosted && members.view().members.length === 1;
  }

  // What `woodshed status` says of the console besides who is signed in: its name, and the GitHub account its repos are
  // on (the default project's owner), as the org. Null with no repo yet.
  function cliAbout() {
    const repo = defaultProject(config).repo || null;
    return { console: consoleName, org: repo ? repo.split('/')[0] : null };
  }

  // Who is signed in to the console: the hosting proxy's identity, or the browser's session cookie.
  async function consoleUser(headers) {
    if (trusted) return trusted.userFor(headers);
    return auth.sessionFor(headers.cookie);
  }

  // The hosting proxy says who is an admin: its owners. Otherwise a console with no sign-in, or no list of people, has
  // nobody to tell apart, and everyone is an admin there. So is everyone on a list with no admin yet, so the first can
  // be switched on; setAdmin keeps the last one from going.
  function isAdmin(user) {
    if (trusted) return user?.role === 'owner';
    const login = user?.login;
    return !auth?.enabled() || !login || !members || !members.hasAdmin() || members.isAdmin(login);
  }

  function cliRepoRole(login) {
    if (!trusted) return isAdmin({ login }) ? 'owner' : 'member';
    return members?.hosted ? members.currentRole(login) : undefined;
  }

  function redirect(res, location, setCookie) {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...(setCookie ? { 'set-cookie': setCookie } : {}) });
    res.end();
  }

  // The menu's workflow links, for the default project's repo: its project file's (`workflowLinks`, read from the default
  // branch), or the installation's WOODSHED_ACTIONS_WORKFLOWS where the file leaves them out or cannot be read, so a
  // console set up before the field keeps its links.
  async function menuWorkflows() {
    return (await workflowLinks?.()) ?? config.actionsWorkflows ?? [];
  }

  // The sign-in and sign-out routes, open to anyone who reaches the console: GitHub's, or behind a hosting proxy the
  // program's sign-out. Answers and returns true for its own paths.
  async function authRoute(req, res, url) {
    const { pathname } = url;
    if (pathname === '/login' && req.method === 'GET') {
      html(res, pageShell({ title: consoleName, script: 'login.js' }));
      return true;
    }
    if (pathname === '/api/me' && req.method === 'GET' && trusted) {
      const user = trusted.userFor(req.headers);
      reply(res, 200, {
        supported: true, signIn: true, available: true, hosted: true, login: user?.login ?? null, visitor: null, asked: null,
        admin: Boolean(user) && isAdmin(user), asking: 0, names: namesFor([user?.login]),
        // People, as a tab of Settings, when the program hands over its list of who is in (hostedMembers.mjs).
        people: Boolean(members?.hosted),
        ...(woodshedUpdate && { updates: user && isAdmin(user) ? woodshedUpdate.behindBy() : 0 }),
        repo: user ? defaultProject(config).repo : null, workflows: user ? await menuWorkflows() : [],
        ...(user && userMenu ? menuOf(userMenu, req.headers) : {}),
        ...(user && settingsTabs ? settingsTabsOf(settingsTabs, req.headers) : {}),
        // The user menu's Sign out, which only the program can do behind its proxy (signOut, below).
        ...(user && signOut ? { signOut: true } : {}),
      });
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
        admin: !auth?.enabled() || Boolean(user && isAdmin(user)),
        asking: user && members && isAdmin(user) ? members.view().requests.length : 0,
        // Admins see how many Woodshed commits the console lacks, on the menu's Console settings.
        ...(woodshedUpdate && { updates: !auth?.enabled() || (user && isAdmin(user)) ? woodshedUpdate.behindBy() : 0 }),
        names: namesFor([user?.login ?? visitor?.login]),
        // The menu's workflow links. A signed-out browser is not told which repo this is: it may be private.
        repo: user || !auth?.enabled() ? defaultProject(config).repo : null,
        workflows: user || !auth?.enabled() ? await menuWorkflows() : [],
        ...((user || !auth?.enabled()) && userMenu ? menuOf(userMenu, req.headers) : {}),
        ...((user || !auth?.enabled()) && settingsTabs ? settingsTabsOf(settingsTabs, req.headers) : {}),
      });
      return true;
    }
    if ((pathname === '/api/access/ask' || pathname === '/api/access/withdraw') && req.method === 'POST') {
      await accessRequest(req, res, pathname);
      return true;
    }
    // Behind a hosting proxy the program signs people in, so it signs them out: it ends its own sign-in and says where
    // to go, and the console answers as for its own (createInstallation's `signOut`).
    if (pathname === '/auth/sign-out' && req.method === 'POST' && trusted && signOut) {
      if (!isSameOrigin(req.headers)) {
        reply(res, 403, { error: 'sign out from the console itself' });
        return true;
      }
      let out;
      try {
        out = (await signOut(req)) ?? {};
      } catch (err) {
        console.error('console: sign-out failed', { message: String(err?.message ?? err).split('\n')[0] });
        reply(res, 500, { error: 'could not sign out' });
        return true;
      }
      const location = typeof out.location === 'string' && menuHref(out.location) ? out.location : '/';
      const setCookie = [out.setCookie].flat().filter((c) => typeof c === 'string' && c);
      res.writeHead(303, { location, 'cache-control': 'no-store', ...(setCookie.length ? { 'set-cookie': setCookie } : {}) });
      res.end();
      return true;
    }
    // Behind a hosting proxy there is no GitHub sign-in to start or finish: the proxy's header is the sign-in. What
    // follows is the console's own GitHub sign-in.
    if (!auth || trusted) return false;
    // The desktop app's sign-in through the person's browser (desktopSignIn.mjs).
    if (pathname.startsWith('/auth/desktop') && auth.desktopCode && await handleDesktopSignIn({ req, res, url, auth, consoleName })) return true;
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

  // `extra` is what a change has to say beside the list: an add's `told`.
  async function peopleReply(res, extra = {}) {
    if (!members) return reply(res, 404, { error: 'this console has no list of people' });
    // A program's list is read fresh for the page, so it shows who the program has now.
    if (members.hosted) {
      try {
        await members.load();
      } catch (err) {
        console.error('console: the program\'s list of people not read', { message: String(err?.message ?? err).split('\n')[0] });
        return reply(res, 500, { error: 'the list of people could not be read; try again' });
      }
    }
    const view = members.view();
    const logins = [...view.members, ...view.requests].flatMap((p) => [p.login, p.addedBy]).filter(Boolean);
    return reply(res, 200, {
      ...view, hosted: Boolean(members.hosted), names: namesFor(logins), slack: slackPeople ? slackPeople.links(view.members.map((m) => m.login)) : null, ...extra,
    });
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

  // Behind a hosting proxy with the program's list, the program adds, removes and sets each role (hostedMembers.mjs).
  // Its refusal is shown as it said it; any other failure was logged there, and is a 500 here.
  async function hostedPeopleWrite(res, { action, handle, body, by }) {
    const call = {
      add: () => members.add({ login: handle, role: body?.role, by }),
      remove: () => members.remove({ login: handle, by }),
      role: () => members.setRole({ login: handle, role: body?.role, by }),
    }[action];
    if (!call) return reply(res, 404, { error: 'the program embedding this console keeps who is in: People adds, removes and sets each role here' });
    let done;
    try {
      done = await call();
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      return reply(res, 500, { error: 'not done: try again' });
    }
    if (action === 'remove') {
      fleet.releaseAssignments?.({ login: handle, by });
      tunnel?.revoke(handle);
    }
    // What the program did about the add (an email sent, say), for People to say in place of its own hint.
    return peopleReply(res, action === 'add' ? { told: done?.told ?? null } : {});
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
    if (members.hosted && ['add', 'remove', 'role', 'admin', 'invite', 'accept', 'decline'].includes(action)) {
      return hostedPeopleWrite(res, { action, handle, body, by: login });
    }
    if (action === 'add' || action === 'role') return reply(res, 404, { error: 'this console keeps its own list: invite instead' });
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
      cli?.revokeAll(handle, `People, by @${login}`);
    }
    return peopleReply(res);
  }

  // Once sign-in is on, every page, API call and terminal needs a session; the login page's own files do not.
  // @returns {Promise<{login: string|null}|null>}  who is asking (login null with sign-in off), or null once answered
  async function signedIn(req, res, url) {
    if (!signInOn() || url.pathname === '/healthz' || url.pathname.startsWith('/static/')) return { login: soloLogin };
    const user = await consoleUser(req.headers);
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
    if (!signInOn()) return handleAppRequest(req, res, ctx({ login: soloLogin }));
    // Behind a hosting proxy the app's name gets the identity header too, so there is no code to claim: a signed-in
    // browser goes on, and one the proxy sent here with nothing is told so rather than sent round again.
    if (url.pathname === APP_AUTH_PATH && req.method === 'GET' && trusted) {
      if (trusted.userFor(req.headers)) return redirect(res, safeNext(url.searchParams.get('next')));
      console.warn('app: no identity from the hosting proxy on the app\'s name', { id });
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(noIdentityPage(id, config.publicUrl));
    }
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
      res.writeHead(302, { location: shareNext(url.searchParams.get('next')) ?? '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': claimed.setCookie });
      return res.end();
    }
    const viewer = await appViewerFor({ auth, trusted, appShares, headers: req.headers, appId: id });
    if (viewer) return handleAppRequest(req, res, ctx(viewer));
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 401, { error: 'sign in first: open the app from the console' });
    console.log('app: sending to the console to sign in', { id });
    return redirect(res, `${config.publicUrl}/auth/app?id=${id}&next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  // The issuer's discovery document and keys. A key that cannot be read answers 503, which a relying party retries; it
  // never answers an empty key set, which would read as "trust nothing" until its cache ran out.
  async function oidcDocument(req, res, pathname) {
    if (!oidc) return reply(res, 404, { error: 'this console signs no tokens' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'method not allowed' });
    let body;
    try {
      body = pathname === DISCOVERY_PATH ? oidc.discovery() : await oidc.jwks();
    } catch (err) {
      if (!err.shown) throw err;
      return reply(res, err.status ?? 503, { error: err.message });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    return res.end(JSON.stringify(body));
  }

  // A request on one of WOODSHED_APP_PORTS: the app of the session the port is lent to (appPorts.mjs).
  function appPortRequest(req, res, port) {
    // The name is the console's, so the same check as its own pages: a rebinding page's name is refused (sameOrigin.mjs).
    if (!isKnownHost(req.headers.host, hosts)) {
      console.warn('appPorts: unknown host refused', { port, host: String(req.headers.host).slice(0, 100) });
      return reply(res, 421, { error: 'unknown host' });
    }
    // A cookie is the name's, whatever the port, so with sign-in on these apps could not keep theirs apart.
    if (signInOn()) return reply(res, 403, { error: 'app ports are for a console nobody signs in to: use WOODSHED_APP_DOMAIN' });
    const id = appPorts.idFor(port);
    if (!id) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('no session\'s app is on this port: open it from the console\n');
    }
    return appRequest(req, res, id);
  }

  // The editor, on the app's name, for whoever can open the session itself: the app's sign-in cookie says who, and a
  // share link's cookie never counts (editorProxy.mjs).
  async function editorRequest(req, res, id, url) {
    const viewer = signInOn() ? await appUserFor({ auth, trusted, headers: req.headers, appId: id }) : { login: soloLogin };
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
    if ((!config.appDomain && !appPorts) || !APP_ID_RE.test(id) || !findAppFor(id, login)) return reply(res, 404, { error: 'no such session' });
    if (appPorts) {
      const at = appPorts.urlFor(id, next);
      return at ? redirect(res, at) : reply(res, 503, { error: 'every app port is lent to another session: stop one, or add ports to WOODSHED_APP_PORTS' });
    }
    if (!signInOn()) return redirect(res, appUrl(config, id, next));
    // The hosting proxy signs the app's name in itself (appRequest).
    if (trusted) return redirect(res, appUrl(config, id, `${APP_AUTH_PATH}?next=${encodeURIComponent(next)}`));
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

  const proxyReview = createReviewProxy({ findFor, fleet, cli });

  /** @returns {object[]}  every project, the default first, each with its colour key (null past the palette's six) */
  function projectsWithColors() {
    const projects = allProjects(config);
    const colors = projectColors?.view() ?? projectColorsShared.projectColors({ names: projects.map((p) => p.name) });
    return projects.map((p) => ({ ...p, default: Boolean(p.default), color: colors[p.name] ?? null }));
  }

  // Every shared session for someone with sessions from GitHub, and the asker's own private ones. The counts are the
  // fleet's, which say nothing of whose.
  function sessionsBody(login) {
    const all = fleet.sessions();
    const sessions = all.filter((s) => canOpen(s, login, access));
    const slackWaiting = fleet.slackWaiting?.() ?? new Set();
    return {
      repo: defaultProject(config).repo,
      // The rail marks each session's project, in its colour, only when there is more than one to tell apart.
      // Each with its own label (repoTriggers.mjs), which a session's details name; `label` is the default project's.
      projects: projectsWithColors().map(({ name, color, default: main }) => ({ name, color, default: main, ...(repoTriggers ? { label: repoTriggers.of(name).label } : {}) })),
      label: repoTriggers?.of(defaultProject(config).name).label ?? config.label,
      maxRunning: config.maxRunning,
      login,
      // Whether session apps are on: their name's domain, or with app ports the console's own name.
      appDomain: config.appDomain || (appPorts ? new URL(config.publicUrl).hostname : null),
      // With app ports each running session carries its `appUrl`, and an app is not shared: nobody signs in to it.
      appPorts: Boolean(appPorts),
      // Whether a browser must sign in to open a session's app, as to open the console: the command line says so.
      signIn: signInOn(),
      // The databases the console makes each session a copy of, and every engine's viewers. Open ▾ offers a session
      // the viewers it says it runs (its `viewers`, statusd's), which is also how a session given its databases by
      // its environment gets them; one from an image before statusd said so gets those of `databases`.
      databases: databases?.available ? databases.engines : [],
      viewers: viewersOf(ENGINE_NAMES).filter((v) => !v.own).map(({ route, name, program, engine }) => ({ route, name, program, engine })),
      idleHours: config.limits.idleMs / 3_600_000,
      askIdleHours: config.limits.askIdleMs / 3_600_000,
      lifetimeHours: config.limits.lifetimeMs / 3_600_000,
      // The asker's own, which only their private sessions use.
      myIdleHours: (login && userSettings?.limitsFor(login).idleMs / 3_600_000) || null,
      myLifetimeHours: (login && userSettings?.limitsFor(login).lifetimeMs / 3_600_000) || null,
      afterCloseDays: (config.retention?.afterCloseMs ?? 3 * 86_400_000) / 86_400_000,
      maxPrivate: config.maxPrivatePerPerson,
      // The slots are shared sessions' alone: My Woodshed's start at once.
      running: sharedRunningCount(all),
      queued: all.filter((s) => s.status === 'queued' && !s.owner).length,
      sessions: sessions.map((s) => ({ ...publicSession(s), ...limitView(s), project: projectFor(config, s).name, slackWaiting: slackWaiting.has(s.id), pr: prChips?.view(s.prUrl) ?? null,
        // A port is lent once the app is up or starting; until then `appUrl` is null and the page opens it through
        // /auth/app, which lends one.
        ...(appPorts && s.status === 'running' && s.kind !== 'ask' ? { appUrl: APP_HOLDS_PORT.has(s.app) ? appPorts.urlFor(s.id) : null } : {}),
        // Every pull request it opened, oldest first, for its chips (common.js shownPrs).
        prs: prUrlsOf(s).map((url) => ({ url, pr: prChips?.view(url) ?? null })) })).reverse(),
      // Who may have a shared session, and whether the asker is one: the Assign menu and the rail's Mine read them.
      // `shared` is whether the rail has an Everyone tab.
      assignables: members?.assignables() ?? [],
      assignable: Boolean(login && members?.isAssignable(login)),
      shared: seesShared(login),
      // One list of every session, with no Mine and Everyone (onePersonConsole).
      onePerson: onePersonConsole(),
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

  // GitHub sends the browser back from creating the reviewer App the same way.
  async function reviewerSetupCreated(res, url) {
    if (!reviewerApp) return redirect(res, '/setup/github');
    try {
      await reviewerApp.completeManifest({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      return redirect(res, '/setup/github?reviewer=created');
    } catch (err) {
      if (!err.shown) console.error('console: reviewer App creation failed', { message: String(err?.message ?? err).split('\n')[0] });
      return redirect(res, `/setup/github?error=${encodeURIComponent(err.shown ? err.message : 'the console could not keep the reviewer App: its log says why')}`);
    }
  }

  async function reviewerSetupWrite(req, res) {
    if (!reviewerApp) return reply(res, 404, { error: 'this console cannot make a reviewer App' });
    let body;
    try {
      body = await readJson(req, MAX_SECRET_BODY_BYTES);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      return reply(res, 200, reviewerApp.startManifest({ ownerType: body?.ownerType }));
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
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
    if (!repo) return { projects: [], defaultProject: null, saved: false };
    return { projects: [{ name, repo }], defaultProject: name, saved: false };
  }

  // Whether the console has the team's OpenAI key, as last read: Codex runs on it for someone with no sign-in of their own.
  // A read that fails keeps the last answer, so a blip in the store does not take Codex away from New session.
  let teamOpenAiKey = false;
  async function readTeamOpenAiKey() {
    if (!openaiTeamKey) return false;
    try {
      teamOpenAiKey = Boolean(await openaiTeamKey());
    } catch (err) {
      console.warn('console: team OpenAI key not read', { message: String(err?.message ?? err).split('\n')[0] });
    }
    return teamOpenAiKey;
  }

  // The blockers each person's projects had at their last look at /api/my, for the answers that cannot wait for a read.
  const blockersSeen = new Map();
  async function readProjectBlockers(login) {
    if (!databaseGate) return {};
    const { projects } = await projectsView(login);
    const found = await databaseGate.blockers(projects.map((p) => projectNamed(config, p.name) ?? p));
    blockersSeen.set(login, found);
    return found;
  }

  function myView(login) {
    const view = userSettings ? userSettings.view(login) : { claudeToken: { set: false, savedAt: null }, codexAuth: { set: false, savedAt: null }, setUp: false, available: false };
    return {
      login, ...view,
      // The agents New session offers: each only with something to run it on.
      agents: { claude: Boolean(view.claudeToken?.set), codex: Boolean(view.codexAuth?.set) || teamOpenAiKey }, databases: databases?.view(login) ?? null, databasesRefusal: databaseGate?.last(defaultProject(config).name) ?? null,
      // Each project the person may start on that is not ready, by name (databaseGate.mjs), as last read.
      projectBlockers: blockersSeen.get(login) ?? {}, restore: dbRestore?.view(login) ?? null, tunnel: tunnel?.view(login) ?? null, running: activePrivateCount(fleet.sessions(), login),
      // The computers the woodshed command line is signed in on as this person (cliSignIn.mjs), never a token.
      cli: cli ? { tokens: cli.list(login) } : null,
      limit: config.maxPrivatePerPerson, limitDefaults: { idleHours: config.limits.idleMs / 3_600_000, lifetimeHours: config.limits.lifetimeMs / 3_600_000 }, names: namesFor([login]),
      // A console that started with no repo: the setup card sends an admin to add one on Console settings.
      repoNeeded: !hasRepo(config),
      // A console with a secret store and no GitHub App: the setup card sends whoever opens it to /setup/github. On
      // one person's own machine with a gh token it is optional, and does not hold New session back.
      githubSetupNeeded: Boolean(githubSetup?.available()) && !githubSetup.optional?.(),
      githubSetupOptional: Boolean(githubSetup?.optional?.()),
      // The console has its App and could make the reviewer App, but has not: the setup card offers it next, to an admin,
      // since /setup/github is theirs alone.
      reviewerSetupNeeded: Boolean(config.githubApp && secrets && reviewerApp && !reviewerApp.configured() && isAdmin({ login })),
      // Whether My settings offers Connect GitHub: only with the App's own sign-in to connect through.
      githubConnect: Boolean(githubUser),
      // Where Connect GitHub starts: the console's own sign-in, or the host's page for a console behind one.
      githubConnectHref: githubConnectHref ?? '/auth/connect',
      // The host connects people on its own (installation.mjs's githubConnect.automatic): Connect is a way back, not a step.
      githubConnectAutomatic: Boolean(githubConnectAutomatic),
      // Who sessions push as without the person's own GitHub, `<slug>[bot]`: each installation names its App.
      app: appIdentity?.known() ?? null,
      // With no App, sessions push with this machine's gh login, as its owner.
      pushesWithGh: !config.githubApp && !config.githubBroker && Boolean(config.ghToken),
    };
  }

  // Every repo the person may start on, each on its own project's client; a console without projects asks its one.
  // Each answer names whose pull requests they are, so a page drawn for someone else (the account changed in another
  // browser tab) neither draws nor keeps them (session.js).
  async function pullsReply(res, login) {
    if (!login || !github) return reply(res, 200, { pulls: [], login: login ?? null });
    const cached = pullsCache.get(login);
    if (cached && Date.now() - cached.at < PULLS_FRESH_MS) return reply(res, 200, { pulls: cached.pulls, login });
    const named = (await projectsView(login)).projects;
    // A name the installation no longer has (removed since the access check was kept) is left out.
    const projects = named.map((p) => projectNamed(config, p.name)).filter(Boolean);
    const clientFor = (project) => (project.default ? github : (githubFor?.(project) ?? null));
    const { pulls, stale } = await readMyPulls({ login, projects, githubFor: clientFor, kept: cached?.pulls ?? [] });
    // Kept for the minute even when a repo failed, with that repo's last rows: every page asks on each refresh.
    pullsCache.set(login, { at: Date.now(), pulls });
    return reply(res, 200, stale ? { pulls, stale: true, login } : { pulls, login });
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
    // Before the record that lists them goes with removeAll.
    if (repoSettings) await repoSettings.forgetPerson(login);
    if (userSettings) await userSettings.removeAll(login);
    const { stopped, removed } = await fleet.removePrivate(login);
    if (databases) await databases.remove(login);
    dbRestore?.forget(login);
    tunnel?.revoke(login);
    cli?.revokeAll(login, 'Remove My Woodshed');
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
        // Whose it is before anything of it is read: someone else's private session answers as one that does not exist.
        if (!resuming || resuming.owner !== login) return reply(res, 409, { error: 'no session you can open with that id' });
        await userSettings?.refresh?.(login, { force: true });
        if (resuming?.options?.agent !== 'codex' && !userSettings?.view(login).claudeToken.set) return reply(res, 409, { error: 'save your Claude token on My settings first' });
        if (!databasesReady(login)) return reply(res, 409, { error: DATABASES_NOT_READY });
        // Write access to a project's repo can be taken away after a session started on it: Resume asks again, as a start does.
        if (resuming?.owner === login && projectAccess && (await projectAccess.forStart(login, resuming.project)) === null) {
          console.log('console: session resume refused, project not open to the person', { login, sessionId: resuming.id, project: resuming.project ?? null });
          return reply(res, 403, { error: `you can no longer start sessions on ${resuming.project}: you have no write access to its repo, or it is not one of this console's` });
        }
        return reply(res, 201, publicSession(await fleet.resumePrivate({ owner: login, id: actionMatch[1], background: true, herdrParent: body?.herdrParent === true })));
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
        const herdrParent = body.herdrParent === true;
        await userSettings?.refresh?.(login, { force: true });
        // A Codex session signs in with its own login or the team's OpenAI key: it needs no Claude token.
        if (agent !== 'codex' && !userSettings?.view(login).claudeToken.set) return reply(res, 409, { error: 'save your Claude token on My settings first' });
        if (agent === 'codex' && !userSettings?.view(login).codexAuth?.set && !(await readTeamOpenAiKey())) {
          return reply(res, 409, { error: 'save your Codex sign-in on My settings first: the console has no OpenAI key' });
        }
        // A Codex model or effort is one OpenAI's catalog offers this person now, as New session listed it.
        const codexRefusal = agent === 'codex' && codexModels ? await codexModels.allows(login, String(model ?? ''), String(effort ?? '')) : null;
        if (codexRefusal) return reply(res, 400, { error: codexRefusal });
        if (!databasesReady(login)) return reply(res, 409, { error: DATABASES_NOT_READY });
        const project = projectAccess ? await projectAccess.forStart(login, body.project) : undefined;
        if (project === null) {
          console.log('console: session start refused, project not open to the person', { login, project: String(body.project ?? '').slice(0, 40) });
          return reply(res, 403, { error: `you cannot start sessions on a project named ${String(body.project ?? '').slice(0, 40)}: it is not one of this console's, or you have no write access to its repo` });
        }
        return reply(res, 201, publicSession(await fleet.startPrivate({ owner: login, prompt, name, workOn, agent, model, effort, permissionMode, attachmentIds, background: true, project, herdrParent })));
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
        if (codexMatch[1] === 'reviews') {
          if (typeof body.on !== 'boolean') return reply(res, 400, { error: 'on must be true or false' });
          userSettings.setOwnCodexForReviews(login, body.on);
          return reply(res, 200, myView(login));
        }
        if (codexMatch[1]) await userSettings.removeCodexAuth(login);
        else {
          await userSettings.setCodexAuth(login, body.value);
          await firstDatabases(login);
        }
        // The models list was read on the sign-in that is gone: the next look reads it on the new one.
        codexModels?.forget(login);
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

  // The Chat tab's answer, with only the fields statusd reads: it checks them against the pane before typing.
  function answerBody(body) {
    const str = (v) => typeof v === 'string' && v.length <= 1000;
    if (body?.kind === 'question' && Array.isArray(body.questions) && body.questions.length >= 1 && body.questions.length <= 4) {
      const descriptionsOf = (q) => (Array.isArray(q.descriptions) && q.descriptions.length === q.options.length
        && q.descriptions.every((d) => typeof d === 'string' && d.length <= 300) ? { descriptions: q.descriptions } : {});
      const questions = body.questions.map((q) => (str(q?.question) && Array.isArray(q.options) && q.options.length <= 8 && q.options.every(str)
        && Number.isInteger(q.pick) && q.pick >= 0 && q.pick < q.options.length ? { question: q.question, options: q.options, ...descriptionsOf(q), pick: q.pick } : null));
      return questions.every(Boolean) ? { kind: 'question', questions } : null;
    }
    if (body?.kind === 'approval' && (body.decision === 'approve' || body.decision === 'deny')
      && typeof body.key === 'string' && /^[0-9a-f]{64}$/.test(body.key)) {
      return { kind: 'approval', decision: body.decision, key: body.key };
    }
    return null;
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
    if (action === 'interrupt') {
      console.log('console: agent interrupted from the page', { id: session.id });
      return toStatusd(req, res, session, { method: 'POST', path: '/interrupt', body: {} });
    }
    if (action === 'answer') {
      const sent = answerBody(body);
      if (!sent) return reply(res, 400, { error: 'not an answer: a question\'s picks, or approve or deny' });
      // Which picks, never their text: an answer can say anything.
      console.log('console: answer typed in from the page', {
        id: session.id, kind: sent.kind,
        ...(sent.kind === 'question' ? { questions: sent.questions.length, picks: sent.questions.map((q) => q.pick + 1) } : { decision: sent.decision }),
      });
      return toStatusd(req, res, session, { method: 'POST', path: '/answer', body: sent });
    }
    if (action === 'send') {
      if (typeof body?.text !== 'string' || !body.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\s]/g, '')) return reply(res, 400, { error: 'nothing to send' });
      // statusd takes no more (session/statusd.mjs, MAX_SEND_CHARS): said now, not queued to fail behind the others.
      if (body.text.length > MAX_MESSAGE_CHARS) return reply(res, 400, { error: `too long: at most ${MAX_MESSAGE_CHARS} characters in one message` });
      // A statusd from before the guarded send types blind, Enter and all: a message from here could answer an approval
      // that came up after the last status read. The person's own words never go that way; the TUI tab shows the screen.
      if (session.safeSend !== true) {
        // Not read since the console started (an upgrade, a restart): not known yet, which a status read says soon.
        const unread = session.safeSend === undefined;
        console.log('console: message from the page refused, the session cannot send safely', { id: session.id, unread });
        return reply(res, 409, { error: unread
          ? 'the console has not read this session since it started: try again in a few seconds'
          : 'this session started before Chat could send safely: type it in the TUI tab' });
      }
      console.log('console: message typed in from the page', { id: session.id, chars: body.text.length });
      // Through the fleet, which holds it in the session's saved pendingMessages while the agent is busy (mid-turn, at a
      // prompt) and sends it once it is back at its prompt: kept across a console restart and a stop mid-turn.
      // The page's own id for it, which the console gives back when it sends a message it held (deliveredIds). One made
      // here when the page sent none (the phone's message box): a held message with an id is a person's, which the fleet
      // never types through a statusd that types blind.
      const id = typeof body.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.id) ? body.id : randomUUID();
      const outcome = await fleet.send(session, body.text, { id });
      // Typed with no Enter: not sent, and not to send again, since it is in the agent's box.
      if (outcome === 'in-box') return reply(res, 409, { typed: true, error: 'it went into the agent\'s box but was not sent: a prompt came up as it was typed. Answer it, then send or clear the box in the TUI tab' });
      return reply(res, 200, { ok: true, held: outcome === 'queued', ...(outcome === 'unknown' && { unknown: true }) });
    }
    return toStatusd(req, res, session, { method: 'POST', path: '/scroll', body: { steps: body?.steps, pane: body?.pane } });
  }

  // The open pull requests of the project New session has picked (`project`), or of the default project, as for the
  // skills. A read that fails keeps the last list, marked `stale`.
  async function openPullsReply(res, projectName = null) {
    const project = (projectName && projectNamed(config, projectName)) || defaultProject(config);
    const repoGitHub = project.default ? github : (githubFor?.(project) ?? null);
    if (!repoGitHub?.openPulls) return reply(res, 200, { pulls: [], total: 0, stale: false });
    const key = project.name;
    const cached = openPullsCaches.get(key);
    if (!cached || Date.now() - cached.at >= OPEN_PULLS_FRESH_MS) {
      if (!openPullsReadings.has(key)) {
        const extra = project.default ? {} : { project: project.name };
        openPullsReadings.set(key, repoGitHub.openPulls().then(({ pulls, total }) => {
          openPullsCaches.set(key, { at: Date.now(), pulls, total, stale: false });
          console.log('console: open pull requests read', { count: pulls.length, total, ...extra });
        }, (err) => {
          console.warn('console: open pull requests not readable', { message: String(err?.message ?? err).split('\n')[0], ...extra });
          const was = openPullsCaches.get(key);
          openPullsCaches.set(key, { at: Date.now(), pulls: was?.pulls ?? [], total: was?.total ?? 0, stale: true });
        }).finally(() => { openPullsReadings.delete(key); }));
      }
      await openPullsReadings.get(key);
    }
    const { pulls, total, stale } = openPullsCaches.get(key);
    return reply(res, 200, { pulls, total, stale });
  }

  // The skills of the project New session has picked (`project`), or of the default project when it names none or
  // one this console does not have.
  async function skillsReply(res, projectName = null) {
    const project = (projectName && projectNamed(config, projectName)) || defaultProject(config);
    const repoGitHub = project.default ? github : (githubFor?.(project) ?? null);
    if (!repoGitHub?.skills) return reply(res, 200, { skills: [] });
    const key = project.name;
    const cached = skillsCaches.get(key);
    if (cached && Date.now() - cached.at < SKILLS_FRESH_MS) return reply(res, 200, { skills: cached.skills });
    if (!skillsReadings.has(key)) {
      const extra = project.default ? {} : { project: project.name };
      skillsReadings.set(key, repoGitHub.skills().then((skills) => {
        skillsCaches.set(key, { at: Date.now(), skills });
        console.log('console: skills read', { count: skills.length, ...extra });
      }, (err) => {
        console.warn('console: skills not readable', { message: String(err?.message ?? err).split('\n')[0], ...extra });
        // Asked again in a minute, not on every launcher that opens meanwhile.
        skillsCaches.set(key, { at: Date.now() - SKILLS_FRESH_MS + 60_000, skills: skillsCaches.get(key)?.skills ?? [] });
      }).finally(() => { skillsReadings.delete(key); }));
    }
    await skillsReadings.get(key);
    return reply(res, 200, { skills: skillsCaches.get(key)?.skills ?? [] });
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

  // Extend and a session's own limits: the fleet lets a private session's owner and a shared session's assignee alone.
  async function limitAction(req, res, [, id, action], login) {
    const session = findFor(id, login);
    if (!session) return reply(res, 404, { error: 'no such session' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      if (action === 'extend') fleet.extend(session, login);
      else fleet.setLimits(session, body ?? {}, login);
      return reply(res, 200, { ...publicSession(session), ...limitView(session) });
    } catch (err) {
      if (err.shown) return reply(res, err.forbidden ? 403 : 400, { error: err.message });
      throw err;
    }
  }

  // When the session pauses or stops by itself, and the hours it runs on with its own taken into account.
  function limitView(session) {
    if (!fleet.limitsOf) return {};
    const limits = fleet.limitsOf(session);
    return { pause: fleet.pauseOf(session), runsOn: { idleHours: limits.idleMs / 3_600_000, lifetimeHours: limits.lifetimeMs / 3_600_000 } };
  }

  // A repo's label and its switches for labels and /woodshed comments, for its settings page (repoTriggers.mjs).
  function repoTriggersView(project) {
    if (!repoTriggers) return null;
    return { ...repoTriggers.of(project), consoleLabel: config.label };
  }

  // A repo's Slack channel for its settings page: none where PROJECT_CHANNEL_PATH would refuse to set one.
  function repoSlack(project) {
    if (!slack || !addedProjects) return null;
    const { channel, canPost } = slack.view();
    return { channel: slack.projectChannel(project), consoleChannel: channel, canPost };
  }

  async function consoleSettingsReply(res) {
    if (!consoleSettings) return reply(res, 404, { error: 'this console has no settings page' });
    const colors = new Map(projectsWithColors().map((p) => [p.name, p.color]));
    // Each repo's readiness, so an admin sees which one cannot start sessions and how to fix it.
    const blockers = databaseGate ? await databaseGate.blockers(allProjects(config)) : {};
    return reply(res, 200, {
      settings: consoleSettings.view(),
      slack: slack?.view() ?? null,
      webhooks: webhookState(),
      projects: addedProjects?.view().map((p) => ({ ...p, color: colors.get(p.name) ?? null, slackChannel: slack?.projectChannel(p.name) ?? '', blocker: blockers[p.name] ?? null })) ?? null,
      // False where the program the console is embedded in names each repo itself: Add a repo asks for no name.
      repoNames: addedProjects ? addedProjects.names !== false : null,
      palette: projectColorsShared.PALETTE,
      data: heldData ? await heldData.report() : null,
    });
  }

  // `repos: null` where the console has no App to ask: the page then takes owner/name typed in.
  async function repoChoicesReply(res) {
    if (!addedProjects) return reply(res, 404, { error: 'this console keeps no list of repos' });
    try {
      const found = await addedProjects.choices();
      return reply(res, 200, found ?? { repos: null, grant: [], install: null });
    } catch (err) {
      if (err.shown) return reply(res, 502, { error: err.message });
      throw err;
    }
  }

  // When the bot was last mentioned, from the Webhook events log (kept a week): the first thing to look at when
  // questions go quiet.
  function lastMentionAt() {
    let last = null;
    for (const e of events.list()) if (e.type === 'mention' && (!last || e.handledAt > last)) last = e.handledAt;
    return last;
  }

  async function slackSetupReply(res) {
    if (!slackSetup) return reply(res, 404, { error: 'this console posts nothing to Slack' });
    return reply(res, 200, { ...(await slackSetup.view()), lastMention: lastMentionAt() });
  }

  // A pasted token goes in a POST's body, never in a URL, so the channel list with one is a POST too.
  async function slackChannelsReply(res, { query, botToken = null }) {
    if (!slackSetup) return reply(res, 404, { error: 'this console posts nothing to Slack' });
    try {
      const found = await slackSetup.channels({ query: String(query ?? '').slice(0, 80), botToken });
      if (!found) return reply(res, 409, { error: 'Paste the bot token first: the channels are listed with it.' });
      if (found.error) return reply(res, 400, { error: `Slack would not list the channels (${found.error}).` });
      return reply(res, 200, found);
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      console.error('console: Slack channels not listed', { message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'Slack did not answer; try again' });
    }
  }

  async function slackSetupWrite(req, res, action, login) {
    if (!slackSetup) return reply(res, 404, { error: 'this console posts nothing to Slack' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    const by = login ?? 'console';
    try {
      if (action === 'channels') return await slackChannelsReply(res, { query: body.q, botToken: body.botToken ?? null });
      if (action === 'check') return reply(res, 200, await slackSetup.check(body.botToken));
      if (action === 'recheck') return reply(res, 200, { ...(await slackSetup.recheck({ by })), lastMention: lastMentionAt() });
      if (action === 'disconnect') {
        if (body.confirm !== 'slack') return reply(res, 400, { error: 'type slack to confirm' });
        await slackSetup.disconnect({ by });
      } else {
        for (const key of ['botToken', 'signingSecret', 'channel']) {
          if (body[key] !== undefined && typeof body[key] !== 'string') return reply(res, 400, { error: `${key} must be text` });
        }
        await slackSetup.save({ botToken: body.botToken, signingSecret: body.signingSecret, channel: body.channel, by });
      }
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      console.error('console: Slack setup failed', { action: action ?? 'save', message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'Slack or the secret store did not answer; nothing more was changed. The console log says why' });
    }
    return slackSetupReply(res);
  }

  // `receiving`: whether webhooks reach this console at all, by a queue or from the program it is embedded in. Each
  // source's switch is null where there is none: Slack's only where Slack questions are answered at all.
  function webhookState() {
    const view = webhookSwitch?.view() ?? null;
    // Until the GitHub start says how (it waits for the App key), a webhook source configured is taken as read, but not
    // on a console that borrows its GitHub access: that one never reads its own (installation.mjs, startGitHub).
    const receiving = Boolean(view?.receiving ?? (!config.githubBroker && (config.webhookQueue || config.localWebhooks)));
    return { receiving, github: view?.github ?? null, slack: view && asks ? view.slack : null };
  }

  async function webhookSwitchWrite(req, res, login) {
    if (!webhookSwitch) return reply(res, 404, { error: 'this console has no webhook switch' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      webhookSwitch.set({ source: body?.source, off: body?.off, by: login ?? 'console' });
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      throw err;
    }
    return reply(res, 200, { webhooks: webhookState() });
  }

  /** My settings' Reviews card: who reviews my pull requests, and what this console can run for me (reviewAgents.mjs). */
  async function myReviewsView(login) {
    if (!reviewAgents) return { available: { claude: false, codex: false }, best: 'none', choice: null };
    const { available, own, best } = await reviewAgents.options(login);
    return { available, own, best, choice: userSettings?.reviewAgents(login) ?? null };
  }

  // `woodshed review start`: the console's review of one of the person's own open pull requests, now (fleet.mjs,
  // reviewOnDemand). The project is one they may start sessions on: GitHub is asked for their write access to an added
  // project's repo, and the default project's (also the one used when none is named) was proved at sign-in, and is
  // checked again on each command line call (cliSignIn.mjs authenticate).
  async function myPullReviewWrite(req, res, number, login) {
    if (!login) return reply(res, 409, { error: 'a review asked for by hand needs GitHub sign-in, which this console does not have' });
    if (!fleet.reviewOnDemand) return reply(res, 404, { error: 'this console cannot start a review by hand' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (body?.project != null && typeof body.project !== 'string') return reply(res, 400, { error: 'project must be a project\'s name' });
    const project = projectAccess ? await projectAccess.forStart(login, body?.project) : defaultProject(config);
    if (!project) return reply(res, 403, { error: `you cannot start sessions on a project named ${String(body?.project ?? '').slice(0, 40)}: it is not one of this console's, or you have no write access to its repo` });
    const result = await fleet.reviewOnDemand({ project, number, login });
    if (result.outcome === 'refused') return reply(res, result.status, { error: result.reason });
    return reply(res, result.outcome === 'started' ? 201 : 200, { outcome: result.outcome, sessionId: result.sessionId, project: project.name, repo: project.repo, number });
  }

  async function myReviewsWrite(req, res, login) {
    if (!login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    if (!userSettings) return reply(res, 409, { error: 'this console has no secret store, so My settings cannot be saved' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      userSettings.setReviewAgents(login, body?.choice ?? null);
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      throw err;
    }
    return reply(res, 200, await myReviewsView(login));
  }

  /** My settings' Terminal row: what the person's private sessions run claude or codex in (userSettings.setTerminal). */
  async function myTerminalWrite(req, res, login) {
    if (!login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    if (!userSettings) return reply(res, 409, { error: 'this console has no secret store, so My settings cannot be saved' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      userSettings.setTerminal(login, body?.terminal);
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      throw err;
    }
    return reply(res, 200, { terminal: userSettings.terminal(login) });
  }

  // Kept with the person's pins, so it needs no secret store, and with no sign-in it is the console's one person's.
  async function mySessionViewWrite(req, res, login) {
    if (!viewPrefs) return reply(res, 404, { error: 'this console keeps no view preferences' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    try {
      return reply(res, 200, viewPrefs.setSessionView(login, body));
    } catch (err) {
      if (err.shown) return reply(res, 400, { error: err.message });
      throw err;
    }
  }

  async function removeRepo(name, by) {
    // Clear the repo's values first, so a failed delete can be retried. A repo that Remove would refuse keeps them.
    if (addedProjects.view().some((p) => p.name === name && p.removable && !p.sessions)) await repoSettings?.forget(name);
    await addedProjects.remove({ name, by });
    projectColors?.forget({ name });
    repoTriggers?.forget(name);
    slack?.setProjectChannel({ project: name, channel: '', by });
  }

  // The server checks the value's bounds.
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
      if (pathname === PROJECT_COLOR_PATH) {
        if (!projectColors) return reply(res, 404, { error: 'this console keeps no project colours' });
        projectColors.set({ name: body.name, color: body.color, by: login ?? 'console' });
      } else if (pathname === PROJECT_TRIGGERS_PATH) {
        if (!repoTriggers) return reply(res, 404, { error: 'this console keeps no settings for its repos\' labels' });
        if (!allProjects(config).some((p) => p.name === body.name)) return reply(res, 400, { error: `There is no project called ${body.name}.` });
        await repoTriggers.set({ project: body.name, label: body.label, labels: body.labels, comments: body.comments, by: login ?? 'console' });
        return reply(res, 200, { triggers: repoTriggersView(body.name) });
      } else if (pathname === PROJECT_CHANNEL_PATH) {
        if (!addedProjects) return reply(res, 404, { error: 'this console keeps no list of repos' });
        if (!slack) return reply(res, 404, { error: 'this console posts nothing to Slack' });
        if (!addedProjects.view().some((p) => p.name === body.name)) return reply(res, 400, { error: `There is no project called ${body.name}.` });
        slack.setProjectChannel({ project: body.name, channel: body.channel, by: login ?? 'console' });
      } else if (pathname === PROJECTS_PATH || pathname === `${PROJECTS_PATH}/remove`) {
        if (!addedProjects) return reply(res, 404, { error: 'this console keeps no list of repos' });
        const by = login ?? 'console';
        if (pathname === PROJECTS_PATH) await addedProjects.add({ repo: body.repo, name: body.name, by });
        else await removeRepo(body.name, by);
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
      if (err.shown) return reply(res, err.status ?? (pathname === '/api/console-settings' || pathname.startsWith(PROJECTS_PATH) ? 400 : 409), { error: err.message, ...(err.link && { link: err.link }) });
      console.error('console: console settings change failed', { pathname, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'The change failed; the console log says why' });
    }
    return consoleSettingsReply(res);
  }

  // The MCP servers sessions get (mcpServers.mjs): the Console settings page's card, and a hosting program's calls.
  async function mcpServersWrite(req, res, pathname, login) {
    if (!mcpServers) return reply(res, 404, { error: 'this console hands its sessions no MCP servers' });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(res, 400, { error: err.message });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return reply(res, 400, { error: 'body must be a JSON object' });
    const by = login ?? 'console';
    if (pathname === MCP_SERVERS_TEST_PATH) {
      try {
        return reply(res, 200, await mcpTester.run({ name: body.name, server: body.server, value: body.value, by }));
      } catch (err) {
        if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
        console.error('console: MCP server test failed', { message: String(err?.message ?? err).split('\n')[0] });
        return reply(res, 502, { error: 'The test failed; the console log says why' });
      }
    }
    try {
      if (pathname === MCP_SERVERS_PATH) await mcpServers.save({ server: body.server, by });
      else if (pathname === `${MCP_SERVERS_PATH}/remove`) await mcpServers.remove({ name: body.name, by });
      else await mcpServers.setHeader({ name: body.name, value: body.value, by });
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      console.error('console: MCP server change failed', { pathname, message: String(err?.message ?? err).split('\n')[0] });
      return reply(res, 502, { error: 'The change failed; the console log says why' });
    }
    return reply(res, 200, mcpServers.view());
  }

  async function woodshedUpdateReply(res, status = 200) {
    const view = woodshedUpdate ? await woodshedUpdate.view() : null;
    if (!view) return reply(res, 404, { error: 'this console does not run from a git clone, so it follows no Woodshed updates' });
    return reply(res, status, view);
  }

  // Check now, or Update: an update answers at once, and the page follows its steps.
  async function woodshedUpdateWrite(res, pathname, login) {
    if (!woodshedUpdate) return woodshedUpdateReply(res);
    try {
      if (pathname === UPDATES_CHECK_PATH) await woodshedUpdate.check();
      else {
        await woodshedUpdate.update({ by: login ?? 'console' });
        return woodshedUpdateReply(res, 202);
      }
    } catch (err) {
      if (err.shown) return reply(res, 409, { error: err.message });
      throw err;
    }
    return woodshedUpdateReply(res);
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
    // Nobody outside its owner sees a session that has seen production data: its shares ended when it was tainted.
    if (session.taintedAt && !revoke && (kind !== 'members' || body?.on)) return reply(res, 409, { error: 'this session has seen production data, so its app is not shared' });
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
    const next = body?.path === undefined || body?.path === null ? null : shareNext(body.path);
    if (next === null && body?.path !== undefined && body?.path !== null) return reply(res, 400, { error: 'path must be a page of the app, starting with /, such as /landing-a' });
    try {
      const link = appShares.createLink({ sessionId: id, hours: body?.hours, by: login });
      const landing = next && next !== '/' ? `&next=${encodeURIComponent(next)}` : '';
      return reply(res, 201, { ...shareView(), url: appUrl(config, id, `${APP_SHARE_PATH}?t=${link.token}${landing}`), created: link.id, path: next });
    } catch (err) {
      if (err.shown) return reply(res, 400, { error: err.message });
      throw err;
    }
  }

  async function write(req, res, pathname, login) {
    if (req.headers['x-woodshed'] !== '1') return reply(res, 403, { error: 'missing x-woodshed header' });
    if (!isSameOrigin(req.headers)) return reply(res, 403, { error: 'cross-origin request refused' });
    return writeRoute(req, res, pathname, login);
  }

  // A write past its sign-in and the page's own checks: the page's, through write(), and the command line's few
  // (cliSessions.mjs).
  async function writeRoute(req, res, pathname, login) {
    if (pathname === '/api/secrets-manager') return managerWrite(req, res, login);
    if (SECRET_RE.test(pathname) || WEBHOOK_RE.test(pathname)) return settingsWrite(req, res, pathname);
    if (SETUP_WRITE_RE.test(pathname)) return githubSetupWrite(req, res, pathname, login);
    if (pathname === `${REVIEWER_SETUP_PATH}/manifest`) return reviewerSetupWrite(req, res);
    if (pathname === '/api/my/uploads') return stageUpload(req, res, login);
    const cliRevoke = MY_CLI_REVOKE_RE.exec(pathname);
    if (cliRevoke) {
      if (!cli) return reply(res, 404, { error: 'this console has no command line sign-in' });
      if (!cli.revoke(login, cliRevoke[1])) return reply(res, 404, { error: 'no such sign-in' });
      return reply(res, 200, myView(login));
    }
    if (pathname === '/api/my/databases/restore') return restoreUpload(req, res, login);
    const repoRoute = repoSettingsApi && repoSettingsRoute(pathname);
    if (repoRoute) return repoSettingsApi(req, res, { route: repoRoute, login });
    const terminalWrite = TERMINAL_RE.exec(pathname);
    if (terminalWrite && ['upload', 'scroll', 'send', 'interrupt', 'answer'].includes(terminalWrite[2])) return terminalAction(req, res, terminalWrite, login);
    if (pathname === UPDATES_CHECK_PATH || pathname === UPDATES_UPDATE_PATH) return woodshedUpdateWrite(res, pathname, login);
    if (pathname === '/api/console-settings/webhooks') return webhookSwitchWrite(req, res, login);
    if (MCP_SERVERS_WRITES.has(pathname)) return mcpServersWrite(req, res, pathname, login);
    const slackWrite = SLACK_SETUP_WRITE_RE.exec(pathname);
    if (slackWrite) return slackSetupWrite(req, res, slackWrite[1] ?? null, login);
    if (pathname === '/api/my/reviews') return myReviewsWrite(req, res, login);
    const pullReview = MY_PULL_REVIEW_RE.exec(pathname);
    if (pullReview) return myPullReviewWrite(req, res, Number(pullReview[1]), login);
    if (pathname === '/api/my/terminal') return myTerminalWrite(req, res, login);
    if (pathname === MY_SESSION_VIEW_PATH) return mySessionViewWrite(req, res, login);
    if (pathname === '/api/console-settings' || pathname === '/api/console-settings/clean' || pathname === PROJECTS_PATH || pathname === `${PROJECTS_PATH}/remove` || pathname === PROJECT_COLOR_PATH || pathname === PROJECT_CHANNEL_PATH || pathname === PROJECT_TRIGGERS_PATH) return consoleSettingsWrite(req, res, pathname, login);
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
        const { where } = await fleet.startClaudeLogin(session);
        return reply(res, 200, { ok: true, where });
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
        if (action === 'setup') {
          const { session: after, sent } = await fleet.setupApp(session);
          return reply(res, 200, { ...publicSession(after), sent });
        }
        if (action === 'start') {
          // Which of several apps, by name; none is the default. A console page from before several apps sends no body.
          const body = await readJson(req).catch(() => null);
          if (!body || (body.app !== undefined && typeof body.app !== 'string')) return reply(res, 400, { error: 'app must be an app\'s name' });
          // `started`: whether the session took it (none while a stop script runs), for the command line.
          const said = {};
          const after = await fleet.startApp(session, { app: body.app || null, said });
          return reply(res, 200, { ...publicSession(after), ...said });
        }
        // `stopping`: whether a stop ran (none with no stop command, or one already running).
        const said = {};
        const after = await fleet.stopApp(session, { said });
        return reply(res, 200, { ...publicSession(after), ...said });
      } catch (err) {
        if (err.notRunning) return reply(res, 409, { error: 'the session is not running' });
        if (err.refused) return reply(res, 409, { error: err.message });
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
    const limitMatch = LIMIT_ACTION_RE.exec(pathname);
    if (limitMatch) return limitAction(req, res, limitMatch, login);
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

  // The command line token's reads and writes, past handleCliCall's checks (cliSessions.mjs). A config write answers
  // with the config alone (cliConfig.mjs).
  async function cliRead(req, res, url, login) {
    const { pathname } = url;
    if (pathname === REVIEW_READINESS_PATH) return reviewReadinessReply({ req, res, url, login, readiness: reviewReadiness, config, reply });
    if (pathname === CLI_CONFIG_PATH) return reply(res, 200, await configView({ userSettings, projectsView }, login));
    if (pathname === '/api/my/pulls') return pullsReply(res, login);
    const shareRead = APP_SHARE_RE.exec(pathname);
    if (shareRead && !shareRead[2]) return appShareAction(req, res, shareRead, login);
    return reply(res, 200, pathname === '/api/sessions' ? sessionsBody(login) : await projectsView(login));
  }
  function cliWrite(req, res, pathname, login) {
    if (!isConfigWrite(pathname)) return writeRoute(req, res, pathname, login);
    return answerWithView(res, (held) => writeRoute(req, held, pathname, login), () => configView({ userSettings, projectsView }, login), reply);
  }

  return async function handle(req, res) {
    // An app port answers its session's app and nothing else: the console's own pages there would share the app's origin.
    if (appPorts?.owns(req.socket?.localPort)) return appPortRequest(req, res, req.socket.localPort);
    const appId = appIdFor(req.headers.host, config.appDomain);
    if (appId) return appRequest(req, res, appId);
    if (!isKnownHost(req.headers.host, hosts)) {
      console.warn('console: unknown host refused', { host: String(req.headers.host).slice(0, 100) });
      return reply(res, 421, { error: 'unknown host' });
    }
    const url = new URL(req.url || '/', 'http://console.invalid');
    // woodshed-prod-mcp fetches these to check a token the relay added: public, on whatever name the issuer is.
    if (url.pathname === DISCOVERY_PATH || url.pathname === JWKS_PATH) return oidcDocument(req, res, url.pathname);
    // woodshed-db.mjs has no cookie: its token is its sign-in.
    if (url.pathname === CONNECTION_PATH && req.method === 'GET') {
      return tunnel ? tunnel.connection(req, res) : reply(res, 404, { error: 'this console has no tunnel to your databases' });
    }
    // The woodshed command line has no cookie either: a device code, then its token, is its sign-in.
    // The shared gate for session, config and review calls as the token's person.
    const cliCall = () => handleCliCall({ req, res, url, cli, reply, read: cliRead, write: cliWrite });
    if (url.pathname.startsWith('/api/cli/')) {
      if (!cli) return reply(res, 404, { error: 'this console has no command line sign-in' });
      if (url.pathname === CLI_CONFIG_PATH) return cliCall();
      if (url.pathname === CLI_REPOS_PATH || url.pathname === `${CLI_REPOS_PATH}/remove`) {
        return handleCliRepos({ req, res, url, cli, reply, readJson, addedProjects, roleFor: cliRepoRole, projectsView, removeRepo });
      }
      if (await handleCliSettings({ req, res, url, cli, claudeSettings, repoSettingsApi, userSettings })) return;
      return handleCliApi({ req, res, url, cli, publicUrl: config.publicUrl, about: cliAbout, sessionSignIns: sessionSignInsOf(userSettings) });
    }
    // `woodshed review <id>`: the review's calls with the token, checked and carried as the page's are (reviewProxy.mjs).
    if (carriesCliToken(req.headers) && isReviewPath(url.pathname)) return proxyReview.forCli(req, res, url);
    if (carriesCliToken(req.headers)) return cliCall();
    // Sign-in's cookies belong to one host name, and GitHub sends people back only to publicUrl's. Once sign-in
    // can be used, a page opened on another public name (the bare IP) moves there.
    const stays = url.pathname === '/healthz';
    if (auth?.available() && req.method === 'GET' && !stays && otherPublicNames.has(hostnameOf(req.headers.host))) {
      return redirect(res, `${config.publicUrl}${url.pathname}${url.search}`);
    }
    if (servePublic(req, res, url, consoleName)) return;
    // A QA comment's still: GitHub's image proxy fetches it with no sign-in, so its unguessable name is its only lock.
    const poster = req.method === 'GET' && QA_POSTER_RE.exec(url.pathname);
    if (poster) return qaRecordings ? qaRecordings.servePoster(req, res, { id: poster[1], secret: poster[2] }) : reply(res, 404, { error: 'this console keeps no QA recordings' });
    if (await authRoute(req, res, url)) return;
    const user = await signedIn(req, res, url);
    if (!user) return;
    if (config.githubBroker && SETUP_PATH_RE.test(url.pathname)) {
      return reply(res, 404, { error: 'this console borrows its GitHub access from its host, so it has no GitHub App to set up' });
    }
    if (url.pathname === '/auth/app' && req.method === 'GET') return appSignIn(req, res, url, user.login);
    // Connect GitHub is a sign-in like any other, by the person already signed in, that keeps its token.
    if (url.pathname === '/auth/connect' && req.method === 'GET') {
      if (!auth?.enabled() || !githubUser) return reply(res, 404, { error: 'this console has no GitHub sign-in to connect with' });
      const { location, setCookie } = await auth.start('/settings?connected=1', { connect: true });
      console.log('console: Connect GitHub started', { login: user.login });
      return redirect(res, location, setCookie);
    }
    // The page a command line's sign-in code is approved on: its form posts without x-woodshed, as a page's form does.
    if (cli && await handleCliPage({ req, res, url, cli, login: user.login, consoleName, about: cliAbout })) return;
    if (handleTerminalRequest(req, res, { targetFor: terminalTarget(fleet, user.login, access) })) return;
    if (isReviewPath(url.pathname)) return proxyReview(req, res, url, user.login);
    const { pathname } = url;
    if (ADMIN_API_RE.test(pathname) && !isAdmin(user)) {
      console.log('console: admin call refused', { login: user.login, pathname, method: req.method });
      return reply(res, 403, { error: 'only an admin can do this' });
    }
    if (req.method === 'POST') return write(req, res, pathname, user.login);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'method not allowed' });
    const repoRead = repoSettingsApi && repoSettingsRoute(pathname);
    if (repoRead) return repoSettingsApi(req, res, { route: repoRead, login: user.login });
    // One page for the three: session.js moves between them in place, so each loads what any of them needs.
    if (pathname === '/' || pathname === '/all' || SESSION_PAGE_RE.test(pathname)) return html(res, pageShell({ title: consoleName, script: SHELL_SCRIPTS, login: user.login, provider, linkQuery: config.linkQuery }));
    if (pathname === '/settings' || SETTINGS_PAGE_RE.test(pathname)) return html(res, pageShell({ title: consoleName, script: SETTINGS_SCRIPTS, login: user.login, provider, linkQuery: config.linkQuery }));
    if (pathname === '/setup/github') return html(res, pageShell({ title: consoleName, script: 'githubSetup.js' }));
    if (pathname === '/setup/github/created') return githubSetupCreated(res, url);
    if (pathname === '/setup/github/reviewer-created') return reviewerSetupCreated(res, url);
    if (pathname === REVIEW_READINESS_PATH) return reviewReadinessReply({ req, res, url, login: user.login, readiness: reviewReadiness, config, reply });
    if (pathname === REVIEWER_SETUP_PATH) return reviewerApp ? reply(res, 200, await reviewerApp.view()) : reply(res, 404, { error: 'this console cannot make a reviewer App' });
    if (pathname === '/api/setup/github') return githubSetup ? reply(res, 200, await githubSetup.view()) : reply(res, 404, { error: 'this console has no secret store, so it cannot keep a GitHub App' });
    if (pathname === '/api/console-settings') return consoleSettingsReply(res);
    if (pathname === MCP_SERVERS_PATH) return mcpServers ? reply(res, 200, mcpServers.view()) : reply(res, 404, { error: 'this console hands its sessions no MCP servers' });
    if (pathname === UPDATES_PATH) return woodshedUpdateReply(res);
    if (pathname === SLACK_SETUP_PATH) return slackSetupReply(res);
    if (pathname === `${SLACK_SETUP_PATH}/channels`) return slackChannelsReply(res, { query: url.searchParams.get('q') });
    if (pathname === `${PROJECTS_PATH}/repos`) return repoChoicesReply(res);
    if (pathname === '/api/people') return peopleReply(res);
    if (pathname === '/api/people/slack-search') return slackSearchReply(res, url.searchParams.get('q'));
    if (pathname === '/api/sessions') return reply(res, 200, sessionsBody(user.login));
    if (pathname === '/api/my') {
      // The first look waits for the store, so the page never shows a sign-in missing that is there. Later ones ask it in
      // the background: the page polls, and sees a change on a later poll.
      const first = userSettings?.askedAbout ? !userSettings.askedAbout(user.login) : false;
      const looking = userSettings?.refresh?.(user.login)?.catch((err) => {
        console.warn('userSettings: stored sign-ins not followed', { message: String(err?.message ?? err).split('\n')[0] });
      });
      await Promise.all([readProjectBlockers(user.login), first ? looking : null, readTeamOpenAiKey()]);
      return reply(res, 200, myView(user.login));
    }
    if (pathname === '/api/my/reviews') return reply(res, 200, await myReviewsView(user.login));
    if (pathname === MY_SESSION_VIEW_PATH) {
      if (!viewPrefs) return reply(res, 404, { error: 'this console keeps no view preferences' });
      return reply(res, 200, viewPrefs.sessionView(user.login));
    }
    if (pathname === '/api/my/pulls') return pullsReply(res, user.login);
    if (pathname === '/api/my/projects') return reply(res, 200, await projectsView(user.login));
    if (pathname === '/api/my/codex-models') return reply(res, 200, codexModels ? await codexModels.list(user.login) : { models: BUILT_IN_CODEX_MODELS, source: 'built-in', note: null });
    if (pathname === '/api/skills') {
      // Another project's list only for someone who may start sessions on it, as New session offers it; anyone else,
      // and a project this console does not have, gets the default project's.
      const asked = new URL(req.url || '/', 'http://app.invalid').searchParams.get('project');
      const allowed = asked && projectAccess ? await projectAccess.forStart(user.login, asked) : null;
      if (asked && projectAccess && !allowed) console.log('console: skills of a project not open to the person, the default\'s instead', { login: user.login, project: String(asked).slice(0, 40) });
      return skillsReply(res, projectAccess ? allowed?.name ?? null : asked);
    }
    if (pathname === '/api/pulls') {
      // Like the skills: another project's list only for someone who may start sessions on it.
      const asked = new URL(req.url || '/', 'http://app.invalid').searchParams.get('project');
      const allowed = asked && projectAccess ? await projectAccess.forStart(user.login, asked) : null;
      if (asked && projectAccess && !allowed) console.log('console: open pull requests of a project not open to the person, the default\'s instead', { login: user.login, project: String(asked).slice(0, 40) });
      return openPullsReply(res, projectAccess ? allowed?.name ?? null : asked);
    }
    const qaVideo = QA_VIDEO_RE.exec(pathname);
    if (qaVideo) {
      // Whoever may open the QA session watches its recording; the session's id is no secret. One no longer listed
      // (removed by hand) has none to watch, which the page says as for one past its days.
      if (!qaRecordings) return reply(res, 404, { error: 'this console keeps no QA recordings' });
      if (!findFor(qaVideo[1], user.login)) return qaRecordings.gone(res);
      return qaRecordings.serveVideo(req, res, { id: qaVideo[1], n: Number(qaVideo[2]) });
    }
    const shareRead = APP_SHARE_RE.exec(pathname);
    if (shareRead && !shareRead[2]) return appShareAction(req, res, shareRead, user.login);
    const imageMatch = TERMINAL_RE.exec(pathname);
    if (imageMatch?.[2] === 'applog' || imageMatch?.[2] === 'diff' || imageMatch?.[2] === 'transcript' || imageMatch?.[2] === 'prompt') {
      const session = runningFor(imageMatch[1], user.login);
      if (!session) return reply(res, findFor(imageMatch[1], user.login) ? 409 : 404, { error: 'the session is not running' });
      const limit = imageMatch[2] === 'transcript' ? url.searchParams.get('limit') : null;
      const since = imageMatch[2] === 'transcript' ? url.searchParams.get('since') : null;
      const params = new URLSearchParams({
        ...(limit && /^\d{1,4}$/.test(limit) && { limit }),
        ...(since && /^\d{1,16}(\.\d{1,6})?$/.test(since) && { since }),
      });
      const query = params.size ? `?${params}` : '';
      return toStatusd(req, res, session, { method: 'GET', path: `/${imageMatch[2]}${query}` });
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
    // The Usage page (usage.mjs): the viewer's own sessions', or with ?everyone=1 an admin's whole console's.
    if (pathname === '/api/usage') {
      if (!usage) return reply(res, 404, { error: 'this console keeps no usage' });
      const admin = isAdmin(user);
      const view = usage.summary({ login: user?.login ?? null, admin, everyone: url.searchParams.get('everyone') === '1', days: Number(url.searchParams.get('days')) || 30, seesShared: seesShared(user?.login ?? null) });
      const listed = new Set(fleet.sessions().map((s) => s.id));
      const bySession = view.bySession.map((row) => (row.hidden ? row : { ...row, listed: listed.has(row.sessionId) }));
      return reply(res, 200, { ...view, bySession, admin, names: namesFor(view.byPerson.map((p) => p.person).filter(Boolean)) });
    }
    if (pathname === '/api/webhook-events') {
      const list = events.list();
      const state = webhookState();
      return reply(res, 200, { repo: defaultProject(config).repo, queue: state.receiving, webhooks: state, events: list, names: namesFor(list.map((e) => e.login)) });
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
    return reply(res, 404, { error: 'not found' });
  };
}

/**
 * A local console with no sign-in has one person at the keyboard, who gets a login of their own so My Woodshed works:
 * their Claude token, private sessions and settings are kept under it. Elsewhere, with a GitHub App or behind a hosting
 * proxy, nobody has one until they sign in.
 * @returns {string|null}
 */
export function soloLoginOf(config) {
  return config.launcher?.kind === 'docker' && !config.githubApp && !config.trustedIdentitySecret ? config.localLogin ?? null : null;
}

/**
 * The list that says who may open a shared session: the People list once GitHub sign-in tells people apart, or behind
 * a hosting proxy the program's own (hostedMembers.mjs). Behind one without it, or with no sign-in, nobody is told apart.
 * @returns {object|null}
 */
function accessList(auth, members) {
  return auth || members?.hosted ? members : null;
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
  // A tainted session's app is its owner's alone, whatever was shared before (fleet.taint ends the shares too).
  if (session.taintedAt) return false;
  return Boolean(sharedWithMembers && session.owner && login && (!members || members.isMember(login)));
}

// The app alone, for someone who signed in to the console, or holds a share link's cookie: only what the app proxy
// needs, so no other port of the session is ever handed to the app's path.
function appTarget({ fleet, login, members, shares, link }) {
  return function targetFor(id) {
    const session = fleet.find(id);
    if (!session?.endpoint || session.status !== 'running') return null;
    if (link && session.taintedAt) return null;
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
  // Off for a tainted session: the editor fetches its extensions and the rest from the internet, which its lockdown refuses.
  if (!session?.endpoint || session.status !== 'running' || session.editor !== true || session.taintedAt || !canOpen(session, login, members)) return null;
  return { host: session.endpoint.host, statusPort: session.endpoint.statusPort, sessionToken: session.token };
}

/**
 * Who is signed in on a session's app's name: whoever the hosting proxy's header names, or else the app's own sign-in
 * cookie, which leans on a console session.
 * @returns {Promise<{login: string}|null>}
 */
async function appUserFor({ auth, trusted, headers, appId }) {
  if (trusted) return trusted.userFor(headers);
  return auth.appSessionFor({ cookieHeader: headers.cookie, appId });
}

/**
 * Who a request for a session's app comes from: a member signed in to the console (the proxy's header, or their app
 * cookie), or a holder of a share link (its cookie). Both can be absent.
 * @returns {Promise<{login: string|null, link: boolean}|null>}
 */
async function appViewerFor({ auth, trusted, appShares, headers, appId }) {
  const user = await appUserFor({ auth, trusted, headers, appId });
  const link = Boolean(appShares?.viewerFor({ cookieHeader: headers.cookie, appId }));
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
 * Every websocket the console takes: a session app's (createAppUpgrade), woodshed-db.mjs's tunnel, and the terminals,
 * which need the console's own origin and whoever is signed in: the session cookie, or a hosting proxy's header.
 * @param {{config: object, fleet: object, auth?: object|null, members?: object|null, appShares?: object|null,
 *          tunnel?: {handleUpgrade: Function}|null, trusted?: ReturnType<typeof createTrustedIdentity>|null,
 *          execPipe?: {handleUpgrade: Function}|null}} deps
 * @returns {(req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) => void}
 */
export function createConsoleUpgrade({ config, fleet, auth = null, members = null, appShares = null, tunnel = null, trusted = null, appPorts = null, execPipe = null }) {
  const hosts = knownHosts(config);
  const appUpgrade = createAppUpgrade({ config, fleet, auth, members, appShares, trusted });
  return function upgrade(req, socket, head) {
    // An error on a socket nobody listens to is an uncaught exception.
    socket.on('error', () => socket.destroy());
    // An app port's websockets are its app's alone, as its requests are (appPortRequest).
    if (appPorts?.owns(socket.localPort)) {
      if (!isKnownHost(req.headers.host, hosts)) {
        console.warn('appPorts: unknown host refused', { port: socket.localPort, host: String(req.headers.host).slice(0, 100) });
        return socket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n');
      }
      const portId = !auth?.enabled() && !trusted ? appPorts.idFor(socket.localPort) : null;
      if (!portId) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return appUpgrade(req, socket, head, portId);
    }
    const appId = appIdFor(req.headers.host, config.appDomain);
    if (appId) return appUpgrade(req, socket, head, appId);
    // woodshed-db.mjs is no browser: no Origin, no cookie, and a token that does what the same-origin check does here.
    if (isKnownHost(req.headers.host, hosts) && tunnel?.handleUpgrade(req, socket, head)) return;
    // `woodshed tunnel`'s pipe into a session (execPipe.mjs): no browser either, and the command line's token.
    if (isKnownHost(req.headers.host, hosts) && execPipe?.handleUpgrade(req, socket, head)) return;
    // A websocket is not covered by the same-origin policy, and this one types into claude.
    if (!isKnownHost(req.headers.host, hosts) || !isSameOrigin(req.headers)) {
      console.warn('console: terminal websocket refused', { host: String(req.headers.host).slice(0, 100), origin: String(req.headers.origin).slice(0, 100) });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const allowed = trusted ? Promise.resolve(trusted.userFor(req.headers))
      : auth?.enabled() ? auth.sessionFor(req.headers.cookie) : Promise.resolve({ login: soloLoginOf(config) });
    allowed.then((user) => {
      if (!user) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      if (!handleTerminalUpgrade(req, socket, head, { targetFor: terminalTarget(fleet, user.login, accessList(auth, members)) })) socket.destroy();
    }, () => socket.destroy());
  };
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
 *   `repos` and `projectReadiness` are an embedding program's hooks, passed on to createInstallation (installation.mjs):
 *   only the dev console's stand-in (scripts/devHostConsole.mjs) passes them here
 */
export async function startConsole({ provider, config: given = null, repos = null, projectReadiness = null, hostApp = null }) {
  const first = given ?? loadConfig();
  const store = openStore(first.stateDir);
  // An App saved on the setup page is the console's own from the next start.
  const loaded = applyStored({ config: first, store, secrets: provider.secrets });
  // A console that borrows its GitHub access keeps no App, so there is nothing to set up.
  const githubSetup = provider.secrets && !loaded.githubBroker ? createGitHubAppSetup({ store, secrets: provider.secrets, config: loaded, supervisor: supervisorOf(process.env) }) : null;
  const trusted = loaded.trustedIdentitySecret ? createTrustedIdentity({ secret: loaded.trustedIdentitySecret }) : null;
  console.log('console: hosted mode', { githubBroker: Boolean(loaded.githubBroker), trustedIdentity: Boolean(trusted) });
  await checkGh();
  const installation = await createInstallation({ config: loaded, store, provider, trusted, githubSetup, repos, projectReadiness, hostApp });
  const { config, handle } = installation;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('console: request failed', { url: req.url, message: err?.message });
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    });
  });
  // A dump of a gigabyte or two takes longer to send than Node's 5-minute default for a whole request. Caddy is in front.
  server.requestTimeout = 60 * 60_000;
  server.on('upgrade', installation.upgrade);
  const servers = [{ server, open: countRequests(server) }];
  server.listen(config.port, config.host, () => {
    console.log('console: listening', { host: config.host, port: config.port, ...installation.summary() });
  });
  // Each app port is the same server: a request's own port says which session's app it is (appPorts.mjs).
  for (const appPort of installation.appPorts?.ports ?? []) {
    const onPort = http.createServer(server.listeners('request')[0]);
    onPort.requestTimeout = server.requestTimeout;
    onPort.on('upgrade', installation.upgrade);
    onPort.on('error', (err) => console.error('appPorts: could not listen', { port: appPort, message: err?.message }));
    onPort.listen(appPort, config.host);
    servers.push({ server: onPort, open: countRequests(onPort) });
  }
  if (installation.appPorts) console.log('appPorts: listening', { host: config.host, ports: installation.appPorts.ports.length, first: installation.appPorts.ports[0] });
  if (installation.sessionApi) {
    const api = listenSessionApi({ config, handle: installation.sessionApi });
    servers.push({ server: api, open: countRequests(api) });
  }
  // A tainted session's one way out, beside the session API, on the address only sessions reach (egressProxy.mjs).
  if (installation.egressProxy) {
    const { server: egress, port } = installation.egressProxy;
    egress.on('error', (err) => console.error('egress: could not listen', { port, message: err?.message }));
    egress.listen(port, config.sessionApi.host, () => console.log('egress: listening', { host: config.sessionApi.host, port }));
    servers.push({ server: egress, open: countRequests(egress) });
  }
  const tlsAsk = await startTlsAsk({ config, sessions: () => installation.fleet.sessions() });
  if (tlsAsk) servers.push({ server: tlsAsk, open: countRequests(tlsAsk) });
  // Docker's stop on every redeploy (shutdown.mjs): sessions retry their calls to the console while it is away.
  const shutdown = createShutdown({ servers, stop: () => installation.stop() });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown(signal));
  installation.start({ webhooks: provider.webhooks ?? null });
}

/**
 * The session API's own server, on the one address sessions reach (config.sessionApi).
 * @param {{config: {sessionApi: {host: string, port: number}}, handle: (req: object, res: object) => Promise<void>}} args
 * @returns {http.Server}
 */
export function listenSessionApi({ config, handle }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('sessionApi: request failed', { message: err?.message });
      if (!res.headersSent) reply(res, 502, { error: 'could not get a GitHub token' });
    });
  });
  server.listen(config.sessionApi.port, config.sessionApi.host, () => console.log('sessionApi: listening', config.sessionApi));
  return server;
}
