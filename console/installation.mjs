// One installation of the console: everything a console is (its fleet, GitHub clients, secrets, settings, pages and
// session API), built from its config and the services that hold its data and run its sessions, with its background
// loops. Nothing here listens on a port: startConsole (server.mjs) builds one from the environment and serves it, and
// another program can build one from services of its own and serve it from its own servers (README.md, "Embedding the
// console").

import fs from 'node:fs';
import path from 'node:path';

import { hostedEngines } from '../shared/databases/index.mjs';
import { installationProjectFile } from '../shared/project.mjs';
import { createAsks } from './asks.mjs';
import { CLIENT_SECRET, createAuth } from './auth.mjs';
import { createAttachments } from './attachments.mjs';
import { createAutoNamer } from './autoName.mjs';
import { createProjectPrChips } from './prChips.mjs';
import { createPullWebhooks } from './pullWebhooks.mjs';
import { createDatabaseGate } from './databaseGate.mjs';
import { createDatabases } from './databases.mjs';
import { createDbRestore } from './dbRestore.mjs';
import { createSlack } from './slack.mjs';
import { createTunnel, tunnelTargetsFor } from './dbTunnel.mjs';
import { createFleet } from './fleet.mjs';
import { createGitHub } from './github.mjs';
import { createAppApi } from './githubApp.mjs';
import { appOwnerCheck } from './appOwner.mjs';
import { createAppIdentity } from './appIdentity.mjs';
import { createAnthropicProxy } from './anthropicProxy.mjs';
import { createOpenAiProxy } from './openaiProxy.mjs';
import { createCodexModels } from './codexModels.mjs';
import { createSessionApi, sessionForToken } from './sessionApi.mjs';
import { createReviewSource } from './review.mjs';
import { createConsoleSettings, liveConfig } from './consoleSettings.mjs';
import { CHECK_EVERY_MS, createWoodshedUpdate } from './woodshedUpdate.mjs';
import { supervisorOf } from './githubAppSetup.mjs';
import { createHeldData } from './heldData.mjs';
import { ACTIVE_STATUSES } from './sessions.mjs';
import { APP_KEY_SECRET, createSettings } from './settings.mjs';
import { createGitHubUser } from './githubUser.mjs';
import { createClaudeSettings } from './claudeSettings.mjs';
import { createProjectReader } from './projectFile.mjs';
import { createUserSettings } from './userSettings.mjs';
import { createViewPrefs } from './viewPrefs.mjs';
import { createGitHubPeople } from './githubPeople.mjs';
import { createSlackPeople } from './slackPeople.mjs';
import { createAssigneePings } from './assigneePings.mjs';
import { createMembers } from './members.mjs';
import { createAppShares } from './appShares.mjs';
import { createWebhookDispatch } from './webhookDispatch.mjs';
import { createWebhookEvents, SWEEP_MS as EVENTS_SWEEP_MS } from './webhookEvents.mjs';
import { createProjectTokens } from './projectTokens.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import { createAddedProjects, ghRepoLister, repoChecker, repoLister } from './addedProjects.mjs';
import { createProjectColors } from './projectColors.mjs';
import { createAppPorts } from './appPorts.mjs';
import { createConsoleUpgrade, createHandler } from './server.mjs';
import { createReviewerApp } from './reviewerApp.mjs';
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

/**
 * @param {{config: object, store: {state: object, save: () => void}, provider: {name?: string|null, words?: object|null,
 *          launcher: object, secrets: object|null, homes: object|null, dbAdmin: object|null, databases?: string[],
 *          webhookUrl?: (() => Promise<string|null>)|null}, trusted?: {userFor: Function}|null, githubSetup?: object|null,
 *          userMenu?: ((headers: object) => object)|null, newId?: () => string}} args
 *   `config` is in loadConfig()'s shape, before the Console settings page's values go over it; `config.linkQuery`, when
 *   set, is query parameters every link the console hands out carries. `trusted` says who a request is from where
 *   something in front of the console signs people in; `userMenu(headers)` adds to the user menu for that person
 *   (`{subtitle, groups}`, server.mjs's menuOf); `newId` makes a session id, for ids unique beyond this installation
 * @returns {Promise<object>}  the installation: `handle` and `upgrade` for the console's server, `sessionApi` for the
 *   session API's, `start` and `stop` for its loops
 */
export async function createInstallation({ config: loaded, store, provider, trusted = null, githubSetup = null, userMenu = null, newId = undefined }) {
  // The limits and retention numbers are the Console settings page's, read each time they are used.
  const config = liveConfig(loaded, store);
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
  const databasesFix = () => {
    const project = defaultProject(config);
    return provider.name === 'local' && project.clonedAtStart
      ? `run WOODSHED_REPO=${project.repo} bash install.sh again on this machine, which builds ${project.repo}'s session image and starts its databases`
      : null;
  };
  const databaseGate = createDatabaseGate({ projectDatabases: projectReader.databases, hosted, fix: databasesFix });
  // An env file of one repo (an embedding program's `repo`) lists what that repo's project file appends to it.
  const appendedFor = (secret, repo) => readerOf(repo ? projectForRepo(config, repo)?.name : null).appendedFor(secret);
  const userSettings = createUserSettings({ store, secrets, envFiles: config.envFiles, appendedFor });
  const people = createGitHubPeople({ store, github });
  // Behind a hosting proxy the host says who is in: no People list, and no write access asked of those it signs in.
  const members = trusted ? null : createMembers({ store });
  const appShares = createAppShares({ store, secure: loaded.publicUrl.startsWith('https:') });
  const slackPeople = createSlackPeople({ store, slack });
  // In AWS the team key is the console's alone; the docker launcher's sessions keep the one in its env file.
  const openai = createOpenAiProxy({ secrets, teamKey: config.sessionEnv.OPENAI_API_KEY ?? null });
  const codexModels = createCodexModels({ userSettings, teamCredential: openai.teamCredential });
  const anthropic = createAnthropicProxy({ userSettings, secrets, teamKey: config.sessionEnv.ANTHROPIC_API_KEY ?? null });
  const attachments = createAttachments({ dir: path.join(loaded.stateDir, 'attachments') });
  const pullWebhooks = createPullWebhooks();
  const prChips = createProjectPrChips({ projects: () => allProjects(config), githubFor, webhooksFlowing: pullWebhooks.flowing, fallbackMs: config.fallbackPollMs });
  const pings = createAssigneePings({ slack, slackPeople, publicUrl: config.publicUrl, linkQuery: config.linkQuery ?? null });
  const appApi = appKey ? createAppApi({ appId: config.githubApp.appId, privateKey: () => appKey.current() }) : null;
  const appIdentity = createAppIdentity({ appApi });
  const reviewerApp = createReviewerApp({ store, secrets, config });
  const fleet = createFleet({
    config, store, launcher: provider.launcher, github, databases, slack, homes, userSettings, people, members, pings,
    autoName: createAutoNamer({ teamKey: anthropic.teamCredential }), attachments, pullWebhooksFlowing: pullWebhooks.flowing,
    pullRequests: (name) => readerOf(name).pullRequests(), databasesRefusal: databaseGate.refusal, githubFor,
    consoleLinks: (name) => readerOf(name).consoleLinks(), ...(newId ? { newId } : {}),
    // The App that posts a QA session's check, so the brief trusts it.
    ownApp: () => appIdentity.known(),
    reviewerApp,
  });
  pullWebhooks.watch({ name: 'chip', stale: prChips.stale });
  pullWebhooks.watch({ name: 'Slack post or retention', stale: fleet.pullsChanged });
  // Questions need the bot token to answer, and the session API to hear the answer.
  const asks = slack.canReply && config.sessionApi.host ? createAsks({ store, fleet, slack, publicUrl: config.publicUrl, linkQuery: config.linkQuery ?? null }) : null;
  console.log('console: Slack questions', { available: Boolean(asks) });
  const events = createWebhookEvents({ file: path.join(loaded.stateDir, 'webhookEvents.jsonl'), store });
  // Borrowed GitHub access has no App to ask about a repo, nor a gh login of its own: the broker's answer is the check.
  const brokerRead = tokens?.borrowFor
    ? (repo) => createGitHub({ repo, token: async () => (await tokens.borrowFor(repo)).token }).defaultBranch()
    : undefined;
  const appSlug = async () => ((await appIdentity.login()) ? appIdentity.known()?.slug ?? null : null);
  const addedProjects = createAddedProjects({
    store, config, check: repoChecker({ appApi, read: brokerRead, appSlug }), 
    // With no App, a console on its own gh login lists what that login can push to; borrowed access lists nothing.
    list: appApi ? repoLister({ appApi, appSlug }) : config.ghToken && !brokerRead ? ghRepoLister() : null,
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
  // checkout again, as install.sh did.
  const woodshedUpdate = createWoodshedUpdate({
    config, store, supervisor: supervisorOf(process.env), repo: () => defaultProject(loaded).repo || null,
    token: tokens ? async () => (await tokens.console.token()).token : null,
  });
  const handle = createHandler({
    config, fleet, settings, events, auth, review: projectReview, userSettings, github, githubUser, homes, databases, tunnel, slack,
    consoleSettings, heldData: createHeldData({ store, fleet, databases, homes }), people, slackPeople, claudeSettings, viewPrefs, attachments,
    prChips, members, asks, dbRestore, githubSetup, reviewerApp, secrets, appShares, codexModels, openaiTeamKey: openai.teamCredential, provider: { name: provider.name ?? null, words: provider.words ?? null }, appIdentity,
    databaseGate, addedProjects, projectColors,
    // Behind a hosting proxy nobody's write access is asked: the host says who is in.
    projectAccess: createProjectAccess({ config, githubFor, viewPrefs, signIn: () => !trusted && Boolean(auth?.enabled()) }),
    githubFor,
    trusted,
    userMenu,
    appPorts,
    woodshedUpdate,
  });
  const upgrade = createConsoleUpgrade({ config, fleet, auth, members, appShares, tunnel, trusted, appPorts });
  // Without a GitHub App the API still answers what it can: a session's settings, Claude token and home. It mints no GitHub token.
  const sessionApi = config.sessionApi.host ? createSessionApi({
    fleet, tokens: tokens?.sessions ?? null, tokensFor: tokens?.forSession ?? null, userSettings, githubUser, homes, databases, claudeSettings, anthropic, openai, attachments, askTokens: tokens?.asks ?? null, asks,
    githubAccess: (name) => readerOf(name).githubAccess(),
  }) : null;
  const webhookDispatch = createWebhookDispatch({ label: config.label, config, fleet, asks, pulls: pullWebhooks, events, appIdentity });
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
    if (deliveredWebhooks) loops.every(DELIVERED_WEBHOOKS_ALIVE_MS, 'webhooks alive', () => webhookDispatch.alive());
    // Nobody points a webhook at a single console with no App of its own: it polls.
    else if (webhooks && config.githubBroker) console.log('console: webhooks off, GitHub access is borrowed', { pollSeconds: config.pollMs / 1000 });
    else if (webhooks) webhooks.run(webhookDispatch);
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
    loops.every(60 * 60_000, 'attachments sweep', () => attachments.sweep());
    loops.every(EVENTS_SWEEP_MS, 'webhook events sweep', () => events.sweep());
    // Every session someone can still open: a stopped one's pull request still merges or closes.
    // Every 10 seconds, so a chip a webhook marked due changes soon; only due pull requests are asked for.
    if (tokens) loops.every(10_000, 'pull request chips', () => prChips.refresh(fleet.sessions().filter((s) => s.prUrl && !s.cleanedAt)));
    loops.every(config.tickMs, 'tick', () => fleet.tick());
    loops.every(config.tickMs, 'app shares sweep', () => appShares.sweep(fleet.sessions().filter((s) => ACTIVE_STATUSES.has(s.status)).map((s) => s.id)));
    if (asks) loops.every(config.tickMs, 'asks', () => asks.tick());
    loops.every(config.startingCheckMs, 'starting check', () => fleet.checkStarting());
    loops.every(config.startingCheckMs, 'wait progress', () => fleet.checkWaiting());
    loops.every(CHECK_EVERY_MS, 'Woodshed update check', () => woodshedUpdate.check());
    if (databases.available) loops.every(databases.POLL_MS, 'databases', () => databases.poll());
    if (config.pollGitHub) {
      startGitHub({ webhooks, deliveredWebhooks }).catch((err) => console.error('console: GitHub start failed', { message: String(err?.message ?? err).split('\n')[0] }));
    }
  }

  return {
    config,
    fleet,
    tunnel,
    tokens,
    handle,
    upgrade,
    sessionApi,
    appPorts,
    start,
    /** Stops the loops; requests already in flight finish. */
    stop: () => loops.stop(),
    /** @returns {boolean}  whether an active session of this installation holds `token` (the session API's bearer) */
    ownsSessionToken: (token) => Boolean(sessionForToken(token, fleet.sessions())),
    /** One GitHub or Slack message, as the provider's webhook source hands it (webhookDispatch.mjs). */
    dispatchWebhook: (message) => webhookDispatch.dispatch(message),
    summary: () => ({
      repo: defaultProject(config).repo, projects: config.projects?.map((p) => p.name), label: config.label,
      launcher: config.launcher.kind, maxRunning: config.maxRunning, pollGitHub: config.pollGitHub,
      githubApp: Boolean(config.githubApp), githubBroker: Boolean(config.githubBroker), ownDatabases: databases.available, tunnel: tunnel.available,
      appPorts: appPorts ? appPorts.ports.length : 0,
    }),
  };
}
