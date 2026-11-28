// One installation of the console: everything a console is (its fleet, GitHub clients, secrets, settings, pages and
// session API), built from its config and the services that hold its data and run its sessions, with its background
// loops. Nothing here listens on a port: startConsole (server.mjs) builds one from the environment and serves it, and
// another program can build one from services of its own and serve it from its own servers (README.md, "Embedding the
// console").

import { createAnalytics } from './analytics.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { hostedEngines } from '../shared/databases/index.mjs';
import { installationProjectFile } from '../shared/project.mjs';
import { createAsks } from './asks.mjs';
import { CLIENT_SECRET, createAuth } from './auth.mjs';
import { createAttachments } from './attachments.mjs';
import { createQaRecordings } from './qaRecordings.mjs';
import { createAutoNamer } from './autoName.mjs';
import { createProjectPrChips } from './prChips.mjs';
import { createPullWebhooks } from './pullWebhooks.mjs';
import { createDatabaseGate } from './databaseGate.mjs';
import { createDatabases } from './databases.mjs';
import { createDbRestore } from './dbRestore.mjs';
import { createSlack } from './slack.mjs';
import { checkSlackInstall, createSlackSetup } from './slackSetup.mjs';
import { createTunnel, tunnelTargetsFor } from './dbTunnel.mjs';
import { createCliSignIn, createWriteAccess, sessionSignInsOf } from './cliSignIn.mjs';
import { createExecPipe } from './execPipe.mjs';
import { callStatusd, createFleet } from './fleet.mjs';
import { createGitHub } from './github.mjs';
import { createAppApi } from './githubApp.mjs';
import { appOwnerCheck } from './appOwner.mjs';
import { createAppIdentity, hostAppIdentity } from './appIdentity.mjs';
import { createAnthropicProxy } from './anthropicProxy.mjs';
import { createEgressCerts } from './egressCerts.mjs';
import { createEgressProxy } from './egressProxy.mjs';
import { GITHUB_HOSTS } from './githubEgress.mjs';
import { createOidcIssuer } from './oidcIssuer.mjs';
import { createMcpRelay } from './mcpRelay.mjs';
import { createMcpServers, mcpSettings } from './mcpServers.mjs';
import { createOpenAiProxy } from './openaiProxy.mjs';
import { createGeminiProxy } from './geminiProxy.mjs';
import { createReviewAgentProxy } from './reviewAgentProxy.mjs';
import { createCodexModels } from './codexModels.mjs';
import { createGrokModels } from './grokModels.mjs';
import { createSessionApi, sessionForToken } from './sessionApi.mjs';
import { createSessionStarts, sessionForStartToken } from './sessionStarts.mjs';
import { createReviewSource } from './review.mjs';
import { createConsoleSettings, liveConfig } from './consoleSettings.mjs';
import { CHECK_EVERY_MS, createWoodshedUpdate } from './woodshedUpdate.mjs';
import { supervisorOf } from './githubAppSetup.mjs';
import { createHeldData } from './heldData.mjs';
import { ACTIVE_STATUSES, prUrlsOf } from './sessions.mjs';
import { APP_KEY_SECRET, createSettings } from './settings.mjs';
import { createGitHubUser } from './githubUser.mjs';
import { createClaudeSettings } from './claudeSettings.mjs';
import { createProjectReader } from './projectFile.mjs';
import { checkEnvSources, createRepoSettings } from './repoSettings.mjs';
import { createRepoTriggers } from './repoTriggers.mjs';
import { createUserSettings } from './userSettings.mjs';
import { createViewPrefs } from './viewPrefs.mjs';
import { createGitHubPeople } from './githubPeople.mjs';
import { createSlackPeople } from './slackPeople.mjs';
import { createAssigneePings } from './assigneePings.mjs';
import { createMembers } from './members.mjs';
import { checkMembersHook, createHostedMembers } from './hostedMembers.mjs';
import { createAppShares } from './appShares.mjs';
import { createWebhookDispatch } from './webhookDispatch.mjs';
import { createWebhookEvents, SWEEP_MS as EVENTS_SWEEP_MS } from './webhookEvents.mjs';
import { createWebhookSwitch } from './webhookSwitch.mjs';
import { createReviewAgents } from './reviewAgents.mjs';
import { createProjectTokens } from './projectTokens.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import { createAddedProjects, createHostProjects, ghRepoLister, repoChecker, repoLister } from './addedProjects.mjs';
import { createProjectColors } from './projectColors.mjs';
import { createAppPorts } from './appPorts.mjs';
import { createConsoleUpgrade, createHandler } from './server.mjs';
import { createReviewReadiness } from './reviewReadiness.mjs';
import { createReviewerApp } from './reviewerApp.mjs';
import { withAppLogins } from './reviewLogins.mjs';
import { withDefaultReview } from './defaultReview.mjs';
import { allProjects, defaultProject, hasRepo, projectFor, projectForRepo, projectNamed } from './projects.mjs';

// A caller that delivers GitHub's webhooks itself (dispatchWebhook) tells the fleet they arrive this often, as the local
// provider's receiver does, so the GitHub poll slows to its fallback.
const DELIVERED_WEBHOOKS_ALIVE_MS = 20_000;

/**
 * Background work, each on its own timer, every one of which `stop` ends. A run that throws is logged and the next
 * one goes ahead: one failing loop never stops the others.
 * @returns {{every: (ms: number, what: string, fn: () => unknown) => void, wait: (ms: number) => Promise<boolean>,
 *            stop: () => void, stopped: () => boolean}}
 */
export function createLoops() {
  const timers = new Set();
  const waiting = new Set();
  let stopped = false;

  function later(ms, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  function every(ms, what, fn) {
    async function run() {
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        console.error(`console: ${what} failed`, { message: String(err?.message ?? err).split('\n')[0] });
      }
      if (!stopped) later(ms, run);
    }
    run();
  }

  /** @returns {Promise<boolean>}  true after `ms`, false at once when the loops stop first */
  function wait(ms) {
    if (stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value) => {
        waiting.delete(done);
        resolve(value);
      };
      waiting.add(done);
      later(ms, () => done(true));
    });
  }

  function stop() {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const done of [...waiting]) done(false);
  }

  return { every, wait, stop, stopped: () => stopped };
}

/**
 * Sign-in, with the App's client secret read from Secrets Manager at start and kept in memory. Setting the
 * secret on the Secrets page makes sign-in available without a restart; the first one to complete makes it required.
 */
async function startAuth({ config, store, secrets, appApi, github, userSettings, people, members, slackPeople }) {
  const ownsApp = appOwnerCheck({ appApi, installationId: config.githubApp?.installationId ?? null });
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
    // With no repo yet, the App's owner signs in to add the first (appOwner.mjs); then write access to it, as before.
    canWrite: (login) => (hasRepo(config) ? github.canWrite(login) : ownsApp(login)),
    noAccess: (login) => (hasRepo(config)
      ? `@${login} has no write access to the repository, so cannot sign in.`
      : `The console has no repo yet, so only the owner of the account its GitHub App is installed on (an admin, for an organization) can sign in to add one. @${login} is not.`),
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

// The MCP servers' side of the console (mcpServers.mjs, mcpRelay.mjs): the console as the OIDC issuer whose tokens the
// relay adds, its key a secret where there is a store and otherwise a file in the state folder, made the first time a
// token is signed; and, where a session can be locked down, the certificate authority the egress proxy shows tainted
// sessions for GitHub.
function mcpAccess({ loaded: given, secrets, launcher }) {
  // A config an embedding program built by hand may have neither: no production server, and no egress proxy.
  const loaded = { ...given, mcp: given.mcp ?? mcpSettings({}, given.publicUrl ?? 'http://localhost'), egress: given.egress ?? { port: 7693, sessionUrl: null } };
  // A secret store with no backend yet (the local provider before one is picked) keeps nothing: the key goes in a file.
  const keyStore = secrets && secrets.configured?.() !== false ? secrets : null;
  const issuer = createOidcIssuer({ issuer: loaded.mcp.issuer, secrets: keyStore, keyFile: keyStore || !loaded.stateDir ? null : path.join(loaded.stateDir, 'oidc-signing-key.pem') });
  const lockdown = () => {
    if (typeof launcher?.lockDown !== 'function') return { available: false, why: 'its launcher cannot move a running session onto a locked network' };
    if ('guardsEgress' in launcher && !launcher.guardsEgress) return { available: false, why: 'on AWS, sessions that may use production start on the guarded network Terraform makes with prod_mcp, and this installation has none' };
    if (!loaded.sessionApi?.host) return { available: false, why: 'it has no session API (WOODSHED_SESSION_API_HOST)' };
    if (!loaded.egress.sessionUrl) return { available: false, why: 'it has no address for its egress proxy (WOODSHED_EGRESS_PROXY_URL, or WOODSHED_CONSOLE_URL in the session env)' };
    return { available: true, why: null };
  };
  const can = lockdown();
  const certs = can.available ? createEgressCerts({ dir: path.join(loaded.stateDir, 'egress'), hosts: GITHUB_HOSTS }) : null;
  const environment = loaded.mcp.environment;
  if (environment) {
    const people = environment.people === '*' ? 'everyone' : environment.people.length;
    console.log('mcpServers: production server from the environment', { server: new URL(environment.url).host, people, repos: environment.repos, issuer: loaded.mcp.issuer, egress: loaded.egress.sessionUrl, lockdown: can.available });
    if (!people || (Array.isArray(environment.repos) && !environment.repos.length)) console.warn('mcpServers: WOODSHED_PROD_MCP_PEOPLE or WOODSHED_PROD_MCP_REPOS lists nobody, so no session gets production access');
    if (!can.available) console.warn('mcpServers: production access is off, this console cannot lock a session down', { why: can.why });
    // Made or read now rather than at the first call, so a key that cannot be made shows at start.
    issuer.load().catch(() => {});
  }
  // Every relying party fetches the keys over https from the issuer's own name.
  if (!loaded.mcp.issuer.startsWith('https://') && environment) console.warn('oidcIssuer: the issuer is not https, which an MCP server may refuse', { issuer: loaded.mcp.issuer });
  if (certs) certs.caPem().catch((err) => console.error('egress: certificate authority not ready', { message: err.message }));
  return { issuer, certs, lockdown, settings: loaded.mcp, egress: certs ? { sessionUrl: loaded.egress.sessionUrl, caPem: () => certs.caPem() } : null };
}

/**
 * @param {{config: object, store: {state: object, save: () => void}, provider: {name?: string|null, words?: object|null,
 *          launcher: object, secrets: object|null, homes: object|null, dbAdmin: object|null, databases?: string[],
 *          recordings?: object|null (where QA recordings are kept: qaRecordings.mjs),
 *          webhookUrl?: (() => Promise<string|null>)|null, slackEventsUrl?: (() => Promise<string|null>)|null}, trusted?: {userFor: Function}|null, githubSetup?: object|null,
 *          userMenu?: ((headers: object) => object)|null, settingsTabs?: ((headers: object) => object[])|null,
 *          repoPage?: ((repo: {name: string, repo: string, headers: object}) => Promise<string|object|null>)|null,
 *          envSources?: {view: (args: {name: string, repo: string, keys: string[], headers: object}) => Promise<object|null>,
 *            forSession: (args: {name: string, repo: string, session: {id: string, owner: string|null}}) => Promise<Record<string, string>|null>}|null,
 *          signOut?: ((req: object) => Promise<{location?: string, setCookie?: string|string[]}>)|null, newId?: () => string, repos?: object|null,
 *          projectReadiness?: ((project: {name: string, repo: string}) => Promise<object|null>)|null,
 *          stillSignedIn?: ((who: {login: string, headers: object}) => boolean|Promise<boolean>)|null,
 *          hostApp?: object|null, woodshedUpdate?: boolean, slackEventsUrl?: (() => Promise<string|null>)|null,
 *          slackInstall?: {label: string, description?: string, available?: boolean|(() => boolean|Promise<boolean>),
 *            href?: string, installed?: () => boolean|Promise<boolean>}|null,
 *          githubConnect?: {clientId: () => string|Promise<string>, clientSecret: () => string|null, href: string,
 *                           automatic?: boolean}|null,
 *          members?: {list: () => Promise<{login: string, role: 'owner'|'member'}[]>,
 *            add: (args: {login: string, role: 'owner'|'member', by: string}) => Promise<void>,
 *            remove: (args: {login: string, by: string}) => Promise<void>,
 *            setRole: (args: {login: string, role: 'owner'|'member', by: string}) => Promise<void>}|null}} args
 *   `config` is in loadConfig()'s shape, before the Console settings page's values go over it; `config.linkQuery`, when
 *   set, is query parameters every link the console hands out carries. `trusted` says who a request is from where
 *   something in front of the console signs people in; `userMenu(headers)` adds to the user menu and the settings
 *   list for that person (`{subtitle, you, groups, sections}`, server.mjs's menuOf), and `settingsTabs(headers)` adds
 *   tabs of its own pages to Settings (`[{label, href}]`, server.mjs's settingsTabsOf; each page is drawn with
 *   settingsFrame, as are the menu's own pages). `repoPage({name, repo, headers})` adds groups of its own after a
 *   repo's settings page's (repoSettings.mjs, `host`): markup made with settingsMarkup.mjs, or null for none.
 *   `envSources` says which of a repo's env files get their installation values from a source of the program's own,
 *   such as a secret manager, in place of the values typed on the repo's page: `view` for the pages (each file's
 *   `{label, on, keys?, markup?, scripts?}`, never a value), `forSession` the text of each file whose source is on, at a
 *   session's start (repoSettings.mjs, README.md "Embedding the console"). Behind `trusted`,
 *   `signOut(req)` ends the person's sign-in for the user menu's Sign out, answering where to go and the cookies to
 *   set (`{location?, setCookie?}`); without it a hosted console has no Sign out; `newId` makes a session
 *   id, for ids unique beyond this installation.
 *   `repos` is where the program keeps the installation's repo list, which `config.projects` was built from, so the
 *   Console settings page's Add a repo and Remove change it there (addedProjects.mjs, README.md "Embedding the
 *   console"): `{list?(), add({repo, name?, by}), remove({name, repo, by}), names?}`. `projectReadiness` says why
 *   sessions cannot start on a project, where the program knows (its image not built, a secret missing): null, or
 *   `{reason, fix: [{text, href?, label?}], ask?: {who, text?}}` (databaseGate.mjs, README.md "Embedding the console").
 *   `stillSignedIn({login, headers})`, behind `trusted` only, says whether the person who opened the page's live session
 *   list (liveSessions.mjs) is still signed in with the program, asked before each change sent on it, with the headers
 *   of the request that opened it. Without it a hosted console pushes no live list, and its pages poll (README.md
 *   "Embedding the console").
 *   `woodshedUpdate: false` turns off the Console settings Woodshed card and its check, for a program that deploys
 *   Woodshed itself (README.md "Embedding the console").
 *   `githubConnect`, behind `trusted` only, is Connect GitHub on the host's GitHub App: My settings' Connect sends
 *   people to `href`, where the host signs them in with GitHub and hands the answer to `connectGitHub`; the console
 *   keeps it in `provider.secrets` and refreshes it with the App's `clientId` and `clientSecret` (githubUser.mjs).
 *   `automatic: true` says the host connects people on its own, so My settings shows it as a status with a way to
 *   connect again, not as a step to take.
 *   `members`, behind `trusted` only, is the program's own list of who is in and their role, which the People page shows
 *   and changes there (hostedMembers.mjs, README.md "Embedding the console"); core keeps only each person's switches.
 *   `slackEventsUrl` is the Slack events Request URL the Set up Slack dialog and its manifest show, over the
 *   provider's; `slackInstall` is the program's own way to put a Slack app in a workspace, offered beside "Use your
 *   own Slack app" (slackSetup.mjs, README.md "Embedding the console").
 *   `cliDevices` (cliSignIn.mjs, createCliDevices) is the command line's waiting room for sign-ins, for a program that
 *   gives several installations behind one address the same one: the token is made by the installation it is approved
 *   on, and `cli.owns(headers)` says whose a request's token is (README.md "Embedding the console").
 * @returns {Promise<object>}  the installation: `handle` and `upgrade` for the console's server, `sessionApi` for the
 *   session API's, `start` and `stop` for its loops
 */
export async function createInstallation({ config: loaded, store, provider, trusted = null, githubSetup = null, userMenu = null, settingsTabs = null, repoPage = null, envSources = null, signOut = null, newId = undefined, repos = null, projectReadiness = null, stillSignedIn = null, hostApp = null, woodshedUpdate: followUpdates = true, githubConnect = null, slackEventsUrl = null, slackInstall = null, members: memberList = null, mcpServers: mcpServersHook = null, cliDevices = undefined }) {
  checkMembersHook(memberList, trusted);
  if (mcpServersHook && ['list', 'save', 'remove'].some((f) => typeof mcpServersHook[f] !== 'function')) throw new Error('mcpServers needs list, save and remove');
  if (projectReadiness != null && typeof projectReadiness !== 'function') throw new Error('projectReadiness must be a function');
  if (repoPage != null && typeof repoPage !== 'function') throw new Error('repoPage must be a function');
  checkEnvSources(envSources);
  if (stillSignedIn != null && typeof stillSignedIn !== 'function') throw new Error('stillSignedIn must be a function');
  if (slackEventsUrl != null && typeof slackEventsUrl !== 'function') throw new Error('slackEventsUrl must be a function');
  checkSlackInstall(slackInstall);
  if (hostApp && (typeof hostApp.login !== 'function' || (hostApp.reviewer != null && ['login', 'configured', 'submitReview'].some((f) => typeof hostApp.reviewer[f] !== 'function')))) {
    throw new Error('hostApp needs login, and a reviewer with login, configured and submitReview when it has one');
  }
  if (githubConnect && (!trusted || typeof githubConnect.clientId !== 'function' || typeof githubConnect.clientSecret !== 'function' || typeof githubConnect.href !== 'string' || !githubConnect.href.startsWith('/') || (githubConnect.automatic != null && typeof githubConnect.automatic !== 'boolean'))) {
    throw new Error('githubConnect is for a console behind trusted sign-in, and needs clientId, clientSecret and a path for href (automatic, when given, true or false)');
  }
  if (repos && (typeof repos.add !== 'function' || typeof repos.remove !== 'function' || (repos.list != null && typeof repos.list !== 'function'))) {
    throw new Error('repos needs add and remove, and list when it has one');
  }
  // What the program's repos hook added or removed since this installation was built, applied to its live list.
  const hostProjects = repos ? createHostProjects() : null;
  // The limits and retention numbers are the Console settings page's, read each time they are used.
  const config = liveConfig(loaded, store, { hostProjects });
  const consoleSettings = createConsoleSettings({ store, config: loaded });
  const { secrets, homes, dbAdmin } = provider;
  const appKey = config.githubApp ? await loadAppKey(config, secrets) : null;
  const tokens = createProjectTokens({ config, privateKey: () => appKey.current() });
  // The default project's repo, read on each call: a console that started with none works on the first one added.
  const github = createGitHub({ repo: () => defaultProject(config).repo, token: tokens && (async () => (await tokens.console.token()).token) });
  // Each project's repo, on that project's own token: the default project's is the console's own client.
  const projectClients = new Map();
  const githubFor = (project) => {
    if (project.name === defaultProject(config).name) return github;
    // A repo an admin removed and added again is a new client, since it may be on another installation.
    const key = `${project.name}\n${project.repo}\n${project.installationId ?? ''}`;
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
  // The program's events address wins: it receives Slack's events itself. Without either, the dialog says it is unknown.
  const slackSetup = createSlackSetup({
    store, secrets, slack, consoleName: config.consoleName, eventsUrl: slackEventsUrl ?? provider.slackEventsUrl ?? null, install: slackInstall,
  });
  const claudeSettings = homes ? createClaudeSettings({ store: homes }) : null;
  // A repo with no project file of its own reads the installation's for it, when it keeps one (shared/project.mjs).
  const installationFileOf = (repo) => () => installationProjectFile({ dir: config.projectFilesDir, repo });
  const projectReader = createProjectReader({ github, installationFile: () => installationFileOf(defaultProject(config).repo)() });
  // Each project's file, from its own repo: the gates its pull requests wait for. The default project's is the one above.
  const projectReaders = new Map();
  const readerOf = (name) => {
    const project = (name && projectNamed(config, name)) || defaultProject(config);
    if (project.name === defaultProject(config).name) return projectReader;
    // Keyed by repo too: a repo removed and added again may be another repo under the same name.
    const key = `${project.name}\n${project.repo}`;
    if (!projectReaders.has(key)) {
      projectReaders.set(key, createProjectReader({ github: githubFor(project), installationFile: installationFileOf(project.repo) }));
    }
    return projectReaders.get(key);
  };
  // A local install that named no repo hosts no database: install.sh, given the repo, builds its image and starts them.
  const databasesFix = (project) => (provider.name === 'local' && project.clonedAtStart
    ? [{ text: `Run WOODSHED_REPO=${project.repo} bash install.sh again on this machine, which builds ${project.repo}'s session image and starts its databases.` }]
    : null);
  // Whom someone who cannot fix a project asks: the People list's admins (the program's owners, when it hands over its
  // list). Behind a hosting proxy with no list, the program's own hook names them.
  const admins = () => (members ? members.view().members.filter((m) => m.admin).map((m) => m.login) : null);
  const databaseGate = createDatabaseGate({
    projectDatabases: (project) => readerOf(project.name).databases(), hosted, provider: provider.name ?? null, fix: databasesFix, admins,
    readiness: projectReadiness,
  });
  const userSettings = createUserSettings({ store, secrets });
  const repoSettings = createRepoSettings({ store, secrets, config, readerOf, envSources });
  // A repo's label may not be its QA label, which its project file names.
  const repoTriggers = createRepoTriggers({ store, config, qaLabelOf: async (name) => (await readerOf(name).pullRequests())?.qa?.label ?? null });
  const people = createGitHubPeople({ store, github });
  // Behind a hosting proxy the host says who is in: no write access asked of those it signs in, and no People list
  // unless the program hands over its own (hostedMembers.mjs). Someone it takes off in its own pages gives their
  // sessions back to Unassigned at the next read of its list, once the fleet below is made (whenGone).
  const members = !trusted ? createMembers({ store }) : memberList ? createHostedMembers({ hook: memberList, store }) : null;
  if (members?.hosted) {
    // The first read, so a label or a page right after start is answered from the list; a failure lets nobody in yet.
    await members.refresh().catch((err) => console.warn('members: the program\'s list not read at start', { message: String(err?.message ?? err).split('\n')[0] }));
  }
  const appShares = createAppShares({ store, secure: loaded.publicUrl.startsWith('https:') });
  const slackPeople = createSlackPeople({ store, slack });
  // In AWS the team key is the console's alone; the docker launcher's sessions keep the one in its env file.
  const openai = createOpenAiProxy({ secrets, teamKey: config.sessionEnv.OPENAI_API_KEY ?? null, userSettings });
  // The team's Gemini key is read from the secret store alone, never from `config.sessionEnv`: that map is what the fleet
  // copies into every session's environment (the docker launcher passes it as it is), so a key there is every session's.
  const gemini = createGeminiProxy({ secrets });
  const codexModels = createCodexModels({ userSettings, teamCredential: openai.teamCredential });
  // A review's Grok Build and OpenCode, on its author's own sign-in alone: there is no team key for them.
  const reviewAgentProxy = createReviewAgentProxy({ userSettings });
  const grokModels = createGrokModels({ userSettings });
  const anthropic = createAnthropicProxy({ userSettings, secrets, teamKey: config.sessionEnv.ANTHROPIC_API_KEY ?? null });
  const attachments = createAttachments({ dir: path.join(loaded.stateDir, 'attachments') });
  const access = mcpAccess({ loaded, secrets, launcher: provider.launcher });
  const mcpServers = createMcpServers({ store, settings: access.settings, secrets, host: mcpServersHook, lockdown: access.lockdown });
  await mcpServers.load().catch((err) => console.warn('mcpServers: starting with none from the program', { message: err.message }));
  // Who reviews a pull request in a review session, as its author chose on My settings, from what the team keys and their
  // own sign-ins can run.
  const reviewAgents = createReviewAgents({
    userSettings,
    connected: async () => {
      const [claude, codex] = await Promise.all([anthropic.teamCredential(), openai.teamCredential()]);
      return { claude: Boolean(claude), codex: Boolean(codex) };
    },
  });
  const qaRecordings = provider.recordings ? createQaRecordings({ store: provider.recordings }) : null;
  const pullWebhooks = createPullWebhooks();
  const prChips = createProjectPrChips({ projects: () => allProjects(config), githubFor, webhooksFlowing: pullWebhooks.flowing, fallbackMs: config.fallbackPollMs, polled: Boolean(tokens) });
  const pings = createAssigneePings({ slack, slackPeople, publicUrl: config.publicUrl, linkQuery: config.linkQuery ?? null });
  const appApi = appKey ? createAppApi({ appId: config.githubApp.appId, privateKey: () => appKey.current() }) : null;
  // A host that lends its GitHub access (hosted.mjs) also says who its App is, and lends its reviewer App: the
  // console has neither of its own, and without them no review or console-added QA label is trusted.
  const appIdentity = hostApp ? hostAppIdentity(hostApp.login) : createAppIdentity({ appApi });
  const ownReviewer = hostApp ? null : createReviewerApp({ store, secrets, config });
  const reviewerApp = hostApp ? hostApp.reviewer ?? null : ownReviewer;
  if (hostApp) console.log('console: GitHub App from the host', { login: hostApp.login() ?? null, reviewer: Boolean(hostApp.reviewer) });
  const logins = async () => ({ reviewerLogin: reviewerApp?.login() ?? null, ownLogin: await appIdentity.login() });
  // A project's pull request gates from its project file, with the Apps' logins the file leaves out (reviewLogins.mjs).
  const fileGatesOf = async (name) => withAppLogins(await readerOf(name).pullRequests(), await logins());
  // A pull request's gates (the Slack post, QA's wait) are the file's alone, as before: the default review only starts a
  // review on the tag and gives sessions the tag (defaultReview.mjs), since it may have no reviewer App to approve with.
  const gatesOf = fileGatesOf;
  // What starts a review, by the tag or on demand, and the tag sessions are told: the file's, with every repo's default.
  const reviewGatesOf = async (name) => withAppLogins(withDefaultReview(await readerOf(name).pullRequests()), await logins());
  // Made below, once sign-in and the view prefs are; the fleet asks it only on status reads, after the start.
  let projectAccess = null;
  const fleet = createFleet({
    // The repos a session's owner may start on, where it may report a pull request opened from another clone.
    startableRepos: async (login) => (projectAccess ? (await projectAccess.startable(login)).map((p) => p.repo) : []),
    config, store, launcher: provider.launcher, github, databases, slack, homes, userSettings, people, members, pings,
    autoName: createAutoNamer({ teamKey: anthropic.teamCredential }), attachments, qaRecordings, pullWebhooksFlowing: pullWebhooks.flowing,
    pullRequests: gatesOf, reviewGates: reviewGatesOf,
    projectBlocker: databaseGate.blocker, githubFor,
    consoleLinks: (name) => readerOf(name).consoleLinks(), ...(newId ? { newId } : {}),
    // The App that posts a QA session's check, so the brief trusts it.
    ownApp: () => appIdentity.known(),
    reviewerApp,
    repoTriggers,
    reviewAgents,
    mcpServers,
    appShares,
    egress: access.egress,
  });
  // The relay and the egress proxy need the fleet, which locks a session down and says whether it is.
  const mcpRelay = createMcpRelay({ servers: mcpServers, issuer: access.issuer, fleet, repoOf: (session) => projectFor(config, session).repo ?? null });
  const egressProxy = access.certs ? createEgressProxy({
    sessions: () => fleet.sessions(), isLocked: fleet.isLocked, certs: access.certs,
    orgOf: (session) => projectFor(config, session).repo?.split('/')[0] ?? null,
    repoOf: (session) => projectFor(config, session).repo ?? null,
    // Untainted sessions use it only where their launcher sends them out through it: AWS's guarded network, which only a
    // session that may use production starts on.
    passThrough: (session) => Boolean(provider.launcher?.guardsEgress) && Boolean(session.mayUseProduction),
  }) : null;
  // What a session has open that its lockdown would not close goes the moment it starts.
  if (egressProxy) fleet.onLocking((id) => egressProxy.cut(id));
  fleet.onLocking((id) => mcpRelay.cut(id));
  // A Codex agent's calls on the team key, opened before its session's lockdown (session/agents.mjs).
  fleet.onLocking((id) => openai.cut(id));
  fleet.onLocking((id) => gemini.cut(id));
  // Sessions of anyone the program's list does not have go back to Unassigned, now for the first read and at each after.
  members?.whenGone?.((login) => fleet.releaseAssignments({ login, by: 'the program' }));
  pullWebhooks.watch({ name: 'chip', stale: prChips.stale });
  pullWebhooks.watch({ name: 'Slack post or retention', stale: fleet.pullsChanged });
  // Questions need the bot token to answer, and the session API to hear the answer.
  const asks = slack.canReply && config.sessionApi.host ? createAsks({
    store, fleet, slack, publicUrl: config.publicUrl, linkQuery: config.linkQuery ?? null,
    issues: { projectForRepo: (repo) => projectForRepo(config, repo), githubOf: githubFor, loginFor: (id) => slackPeople.loginFor(id) },
  }) : null;
  console.log('console: Slack questions', { available: Boolean(asks) });
  const events = createWebhookEvents({ file: path.join(loaded.stateDir, 'webhookEvents.jsonl'), store });
  const webhookSwitch = createWebhookSwitch({ store, onOff: (source) => { if (source === 'github') pullWebhooks.forget(); } });
  // Borrowed GitHub access has no App to ask about a repo, nor a gh login of its own: the broker's answer is the check.
  const brokerRead = tokens?.borrowFor
    ? (repo) => createGitHub({ repo, token: async () => (await tokens.borrowFor(repo)).token }).defaultBranch()
    : undefined;
  const appSlug = async () => ((await appIdentity.login()) ? appIdentity.known()?.slug ?? null : null);
  const addedProjects = createAddedProjects({
    store, config, check: repoChecker({ appApi, read: brokerRead, appSlug }),
    // With no App, a console on its own gh login lists what that login can push to; borrowed access lists nothing.
    list: appApi ? repoLister({ appApi, appSlug }) : config.ghToken && !brokerRead ? ghRepoLister() : null,
    // A program that keeps the repo list lists, checks, adds and removes them itself.
    host: repos, hostProjects,
  });
  const projectColors = createProjectColors({ store, config });
  // The proxy's header is the only sign-in behind one, so GitHub's (and Connect GitHub, which rides on it) is off.
  const auth = !trusted && secrets && appApi ? await startAuth({ config, store, secrets, appApi, github, userSettings, people, members, slackPeople }) : null;
  // Without sign-in every gate lets a request through, which a console the internet reaches must never do.
  // A store the dashboard has not chosen yet holds no client secret either, so sign-in could never come on.
  if (config.requireSignIn && !trusted && (!auth || secrets?.configured?.() === false)) {
    throw new Error('WOODSHED_REQUIRE_SIGN_IN needs the GitHub App (WOODSHED_GITHUB_APP_ID) and Secrets Manager, or WOODSHED_TRUSTED_IDENTITY_SECRET');
  }
  // Borrowed GitHub access has no App key, and the Secrets page then keeps everything but the App's own secrets.
  const settings = secrets && (appKey || config.githubBroker)
    ? createSettings({ config, secrets, appKey, appApi, webhookUrl: provider.webhookUrl ?? (async () => null), onReplace: (name, value) => auth?.secretReplaced(name, value) })
    : null;
  // Connect GitHub through the host's App, which a console behind a host has no sign-in of its own for. That App is
  // installed beyond this console's repos, so a person's token is always scoped by GitHub, to this console's repos or
  // the session's alone (sessionApi.mjs, `ownerTokenRepos`).
  const hostConnect = githubConnect && secrets
    ? createGitHubUser({ clientId: async () => githubConnect.clientId(), clientSecret: githubConnect.clientSecret, userSettings })
    : null;
  if (githubConnect && !secrets) console.warn('console: Connect GitHub off, the host gave no secret store to keep tokens in');
  const githubUser = auth?.githubUser ?? hostConnect;
  // A tunnel token lasts 12 hours; who may use it is asked at each connection, as sign-in asks for each request.
  const tunnel = createTunnel({ store, targets: databaseTargets, databases, allowed: (login) => members?.hosted ? members.isMember(login) : !auth?.enabled() || members.isMember(login) });
  // Behind a hosting proxy, whoever leaves the program's list loses their token and open tunnels at once, as People's Remove does.
  members?.whenLeft?.((login) => tunnel.revoke(login), { also: () => Object.keys(store.state.tunnelTokens ?? {}) });
  // The woodshed command line's sign-ins, one per computer (cliSignIn.mjs): asked who may use them as the tunnel is, and
  // whether their person keeps write access on GitHub as a browser's sign-in is, only where GitHub sign-in is on: with
  // none, or behind a hosting proxy, nobody's access is asked there either.
  // `cliDevices` is a waiting room a program running several consoles gives them all (console/README.md, "Embedding the console").
  const cli = createCliSignIn({
    store, devices: cliDevices, trustedProxies: config.trustedProxies,
    allowed: (login) => members?.hosted ? members.isMember(login) : !auth?.enabled() || members.isMember(login),
    canWrite: auth?.canWrite ? (login) => (auth.enabled() ? auth.canWrite(login) : true) : null,
  });
  members?.whenLeft?.((login) => cli.revokeAll(login, 'the program\'s list'), { also: () => cli.logins().filter(Boolean) });
  const dbRestore = createDbRestore({
    store, dir: path.join(loaded.stateDir, 'restores'), databases, targets: databaseTargets,
    defaultBranchMigrations: tokens ? () => projectReader.migrationFiles('postgres') : null,
    projectDatabases: projectReader.databases,
  });
  await dbRestore.recover();
  const viewPrefs = createViewPrefs(store);
  // The Review tab reads the session's branch on its project's repo.
  const reviewSources = new Map();
  const projectReview = (session) => {
    const project = projectFor(config, session);
    const key = `${project.name}\n${project.repo}\n${project.installationId ?? ''}`;
    if (!reviewSources.has(key)) reviewSources.set(key, createReviewSource({ github: githubFor(project) }));
    return reviewSources.get(key)(session);
  };
  // Session apps on ports of the console's own name, where it has one name and nobody signs in (appPorts.mjs).
  const appPorts = config.appPorts?.length ? createAppPorts({
    store, config, isActive: (id) => ACTIVE_STATUSES.has(fleet.find(id)?.status),
  }) : null;
  // Woodshed's own updates, from the git clone the console runs from (woodshedUpdate.mjs): none without one. The image
  // is built for the environment's repo, not one an admin added, so a console that started with none builds it with no
  // checkout again, as install.sh did. A program that deploys Woodshed itself turns it off: an Update here would go
  // around its deploy, and restart a console that may serve more than one team.
  const woodshedUpdate = followUpdates ? createWoodshedUpdate({
    config, store, supervisor: supervisorOf(process.env), repo: () => defaultProject(loaded).repo || null,
    token: tokens ? async () => (await tokens.console.token()).token : null,
  }) : null;
  // Behind a hosting proxy nobody's write access is asked: the host says who is in.
  projectAccess = createProjectAccess({ config, githubFor, viewPrefs, signIn: () => !trusted && Boolean(auth?.enabled()), hosted: () => Boolean(trusted) });
  const handle = createHandler({
    config, fleet, settings, events, webhookSwitch, reviewAgents, auth, review: projectReview, userSettings, github, githubUser, homes, databases, tunnel, slack,
    consoleSettings, heldData: createHeldData({ store, fleet, databases, homes }), people, slackPeople, claudeSettings, viewPrefs, attachments, qaRecordings,
    prChips, members, asks, dbRestore, githubSetup, reviewerApp: ownReviewer, secrets, appShares, codexModels, grokModels, openaiTeamKey: openai.teamCredential, geminiTeamKey: gemini.teamCredential, oidc: access.issuer, mcpServers, provider: { name: provider.name ?? null, words: provider.words ?? null }, appIdentity,
    databaseGate, addedProjects, projectColors, repoSettings, repoTriggers,
    workflowLinks: () => projectReader.workflowLinks(),
    projectAccess,
    githubFor,
    trusted,
    userMenu,
    settingsTabs,
    repoPage,
    stillSignedIn,
    signOut,
    appPorts,
    githubConnectHref: hostConnect ? githubConnect.href : null,
    githubConnectAutomatic: Boolean(hostConnect && githubConnect.automatic),
    woodshedUpdate,
    slackSetup,
    cli,
    // The Analytics page: the fleet's sessions and those kept since they left its list, and each repo's pull requests.
    analytics: createAnalytics({
      config, sessions: () => fleet.sessions(), state: () => store.state, githubFor, gatesOf: fileGatesOf,
      members: () => (members ? members.view().members.map((m) => m.login) : []),
    }),
    // Whether a repo's review can run in a session, for `woodshed review`: none with no GitHub App to run it.
    reviewReadiness: config.githubApp || hostApp ? createReviewReadiness({
      publicUrl: config.publicUrl, reviewer: reviewerApp, ownReviewer: !hostApp, appLogin: () => appIdentity.login(),
      pullRequestsOf: fileGatesOf,
      runsOnName: config.runsOnName ?? null,
      // A token's person must still write to the repo, as sign-in asks of a browser's (auth.mjs). With no sign-in, or
      // behind a hosting proxy, nobody's access is asked there either.
      canWrite: auth && !trusted ? async (login, project) => {
        const gh = auth.enabled() && login ? githubFor(project) : null;
        return gh ? gh.canWrite(login) : true;
      } : null,
    }) : null,
  });
  // `woodshed tunnel <id> -- <line>`: a pipe into a running session of the token's person, through its statusd.
  const execPipe = createExecPipe({ fleet, cli });
  const upgrade = createConsoleUpgrade({ config, fleet, auth, members, appShares, tunnel, trusted, appPorts, execPipe });
  // Without a GitHub App the API still answers what it can: a session's settings, Claude token and home. It mints no GitHub token.
  // A session starting sessions of its person's (sessionStarts.mjs), with New session's own checks, and the command
  // line's for whether the person may still use the console and still writes to its repo: the same check, cached an
  // hour per person (createWriteAccess). It ends no sign-in of theirs: the command line's own check does that.
  const startsWriteAccess = createWriteAccess({ canWrite: auth?.canWrite ? (login) => (auth.enabled() ? auth.canWrite(login) : true) : null, revokeAll: () => {}, logAs: 'sessionStarts' });
  const sessionStarts = createSessionStarts({
    fleet, config, startMine: (login, body) => handle.startMine(login, body, { startedFrom: body.startedFrom, startedApart: body.startedApart === true }),
    resumeMine: (login, id) => handle.resumeMine(login, id), statusd: callStatusd,
    agentAction: (req, res, route, login, opts) => handle.agentAction(req, res, route, login, opts),
    allowed: (login) => (members?.hosted ? members.isMember(login) : !auth?.enabled() || members.isMember(login)),
    canWrite: (login) => startsWriteAccess.allowed(login),
  });
  const sessionApi = config.sessionApi.host ? createSessionApi({
    fleet, tokens: tokens?.sessions ?? null, tokensFor: tokens?.forSession ?? null, userSettings, repoSettings, githubUser, homes, databases, claudeSettings, anthropic, openai, gemini, reviewAgentProxy, attachments, askTokens: tokens?.asks ?? null, asks,
    githubAccess: (name) => readerOf(name).githubAccess(),
    mcpRelay, egress: access.egress, sessionStarts,
    ownerTokenRepos: hostConnect ? () => allProjects(config).map((p) => p.repo).filter(Boolean) : null,
  }) : null;
  const webhookDispatch = createWebhookDispatch({ label: config.label, labelOf: (name) => repoTriggers.of(name ?? defaultProject(config).name).label, config, fleet, asks, pulls: pullWebhooks, events, appIdentity, webhookSwitch });
  const loops = createLoops();

  // Neither the poll nor the webhooks start without an App key: a message read then would fail its three tries and
  // land in the dead-letter queue. `webhooks` is the provider's source; `deliveredWebhooks` says the caller hands each
  // event to dispatchWebhook instead.
  async function startGitHub({ webhooks, deliveredWebhooks }) {
    while (appKey && !appKey.current()) {
      if (!(await loops.wait(config.pollMs))) return;
      await appKey.reload();
    }
    if (loops.stopped()) return;
    loops.every(config.pollMs, 'github poll', () => fleet.pollGitHub());
    appIdentity.login();
    if (deliveredWebhooks) {
      webhookSwitch.receiving('delivered');
      loops.every(DELIVERED_WEBHOOKS_ALIVE_MS, 'webhooks alive', () => webhookDispatch.alive());
    // Nobody points a webhook at a single console with no App of its own: it polls.
    } else if (webhooks && config.githubBroker) console.log('console: webhooks off, GitHub access is borrowed', { pollSeconds: config.pollMs / 1000 });
    else if (webhooks) {
      webhookSwitch.receiving('queue');
      webhooks.run(webhookDispatch);
    }
    if (webhookSwitch.off('github')) console.log('console: GitHub webhooks are switched off on Console settings, polling', { pollSeconds: config.pollMs / 1000 });
    if (webhookSwitch.off('slack')) console.log('console: Slack questions are switched off on Console settings');
  }

  /**
   * The installation's background work. In ECS, sessions get their GitHub token from the task definition's secret,
   * which says what it is; a docker console without one warns that sessions push with its own.
   * @param {{webhooks?: {run: Function}|null, deliveredWebhooks?: boolean}} [opts]
   */
  function start({ webhooks = null, deliveredWebhooks = false } = {}) {
    if (config.launcher.kind === 'docker' && !tokens && !config.sessionEnv.GH_TOKEN) {
      console.warn('console: sessions push with the console\'s own gh token; set GH_TOKEN in the session env file to give them a narrower one');
    }
    repoSettings.moveOwnFiles().catch((err) => console.error('repoSettings: own files not moved', { message: String(err?.message ?? err).split('\n')[0] }));
    loops.every(60 * 60_000, 'attachments sweep', () => attachments.sweep());
    if (qaRecordings) loops.every(60 * 60_000, 'QA recordings sweep', () => qaRecordings.sweep());
    loops.every(EVENTS_SWEEP_MS, 'webhook events sweep', () => events.sweep());
    // Every session someone can still open: a stopped one's pull request still merges or closes.
    // Every 10 seconds, so a chip a webhook marked due changes soon; only due pull requests are asked for.
    if (tokens) loops.every(10_000, 'pull request chips', () => prChips.refresh(fleet.sessions().filter((s) => prUrlsOf(s).length && !s.cleanedAt)));
    loops.every(config.tickMs, 'tick', () => fleet.tick());
    loops.every(config.tickMs, 'app shares sweep', () => appShares.sweep(fleet.sessions().filter((s) => ACTIVE_STATUSES.has(s.status)).map((s) => s.id)));
    if (asks) loops.every(config.tickMs, 'asks', () => asks.tick());
    loops.every(config.startingCheckMs, 'starting check', () => fleet.checkStarting());
    loops.every(config.liveCheckMs ?? 2_000, 'live check', () => fleet.checkLive());
    loops.every(config.startingCheckMs, 'wait progress', () => fleet.checkWaiting());
    if (woodshedUpdate) loops.every(CHECK_EVERY_MS, 'Woodshed update check', () => woodshedUpdate.check());
    if (databases.available) loops.every(databases.POLL_MS, 'databases', () => databases.poll());
    if (config.pollGitHub) {
      startGitHub({ webhooks, deliveredWebhooks }).catch((err) => console.error('console: GitHub start failed', { message: String(err?.message ?? err).split('\n')[0] }));
    }
  }

  return {
    config,
    fleet,
    tunnel,
    cli,
    tokens,
    handle,
    upgrade,
    sessionApi,
    // The port a tainted session leaves through, on the session API's address (server.mjs listens).
    egressProxy: egressProxy && sessionApi ? { server: egressProxy, port: loaded.egress.port } : null,
    appPorts,
    start,
    /** Stops the loops; requests already in flight finish. */
    stop: () => { members?.stop?.(); loops.stop(); handle.liveSessions?.closeAll(); },
    /**
     * `GET /api/cli/me`'s `sessionSignIns`, for a program that answers that route itself (a host serving several
     * installations passes it to handleCliApi): without it, `woodshed setup` cannot tell whether Claude Code and Codex
     * are connected.
     */
    sessionSignIns: sessionSignInsOf(userSettings),
    /** @returns {boolean}  whether an active session of this installation holds `token` (the session API's bearer) */
    ownsSessionToken: (token) => Boolean(sessionForToken(token, fleet.sessions()) || sessionForStartToken(token, fleet.sessions())),
    /** One GitHub or Slack message, as the provider's webhook source hands it (webhookDispatch.mjs). */
    dispatchWebhook: (message) => webhookDispatch.dispatch(message),
    /**
     * Keeps a Connect GitHub sign-in the host ran (`githubConnect`): GitHub's answer to the code, and who signed in
     * here, whom GitHub must say it is. Throws `shown` when GitHub says otherwise.
     */
    connectGitHub: async ({ login, answer }) => {
      if (!hostConnect) throw new Error('this console was given no githubConnect');
      await hostConnect.connect({ login, answer });
    },
    /** Disconnect, for the host when the person leaves: the stored token goes and GitHub ends it. */
    disconnectGitHub: async (login) => { if (githubUser) await githubUser.disconnect(login); },
    /**
     * The Slack match core's own sign-in makes (slackPeople.mjs, matchOnSignIn), for a host that signs people in
     * itself: `emails()` answers the verified emails on their GitHub account, and is only called when a look is due
     * (at most once a day, never over a link set by hand). As at sign-in, only a member is matched, so someone the
     * host's list does not have leaves nothing behind. Never throws.
     * @param {{login: string, emails: () => Promise<string[]>}} args
     * @returns {Promise<'linked'|'unmatched'|'manual'|'skipped'>}
     */
    matchSlack: async ({ login, emails }) => {
      if (members && !members.isMember(login)) return 'skipped';
      return slackPeople.matchOnSignIn({ login, emails });
    },
    summary: () => ({
      repo: defaultProject(config).repo, projects: config.projects?.map((p) => p.name), label: config.label,
      launcher: config.launcher.kind, maxRunning: config.maxRunning, pollGitHub: config.pollGitHub,
      githubApp: Boolean(config.githubApp), githubBroker: Boolean(config.githubBroker), ownDatabases: databases.available, tunnel: tunnel.available,
      appPorts: appPorts ? appPorts.ports.length : 0, githubConnect: Boolean(hostConnect),
      mcpServers: mcpServers.list().length, lockdown: access.lockdown().available,
    }),
  };
}
