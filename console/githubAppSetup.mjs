// Setting up the GitHub App from the console, for an installation that has none. Two ways in: GitHub's App Manifest
// flow (the console sends GitHub the App's whole definition, GitHub makes it after one click and hands back its ID,
// private key and client secret), or pasting the details of an App someone already made. Either ends the same way:
// the key and client secret in the secret store, the App ID and installation ID in the console's state, and a restart
// (the page's own button where systemd or Docker starts the console again, a shell elsewhere), which is when
// config.githubApp comes from here (applyStored). Only a console with a secret store can do this, since
// the key must never sit in state.json.

import crypto from 'node:crypto';

import { appJwt, createAppApi, createTokenSource } from './githubApp.mjs';
import { APP_KEY_SECRET } from './settings.mjs';
import { checkValue, secretSpecs } from './secrets.mjs';
import { defaultProject } from './projects.mjs';

const GITHUB = 'https://github.com';
const GITHUB_API = 'https://api.github.com';
const CLIENT_SECRET = 'github-app-client-secret';
// The manifest's `redirect_url` comes back with a code that is good for an hour; the state it was started with, 15 minutes.
const STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING = 20;
// Non-zero on purpose: systemd's Restart=on-failure starts a unit again only after a non-zero exit (or a signal), and
// Docker's on-failure policy likewise; always and unless-stopped take any. 75 is EX_TEMPFAIL, "try again".
export const RESTART_EXIT_CODE = 75;
// Long enough for the 202 to reach the browser before the process goes.
const RESTART_DELAY_MS = 300;

// What the console and its sessions use (projectTokens.mjs's SESSION_PERMISSIONS is the narrower set sessions get). Projects is
// an organization permission. GitHub refuses a manifest that asks for the account permission Email addresses ("Default
// permission records resource is not included in the list"), so the Slack match's verified emails are added to the App
// by hand; without them sign-in matches on the public email alone (auth.mjs, emailsOf).
const PERMISSIONS = {
  contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write',
  metadata: 'read', checks: 'read', statuses: 'read', organization_projects: 'write',
};

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, 300);
}

// checkValue's errors are written for the page, so they are shown as they are.
function checked(name, value) {
  try {
    return checkValue(secretSpecs({ envFiles: [] }).find((spec) => spec.name === name), value);
  } catch (err) {
    throw refusal(err.message);
  }
}

function refusal(message) {
  return Object.assign(new Error(message), { shown: true });
}

/**
 * The manifest GitHub makes the App from. No webhook: the Secrets & webhooks page sets that up once the console has
 * somewhere for GitHub to post, and the console polls until then.
 * @returns {object}
 */
export function appManifest({ publicUrl, repo }) {
  const [owner] = repo.split('/');
  return {
    name: `Woodshed Cloud ${owner}`.slice(0, 34),
    url: publicUrl,
    redirect_url: `${publicUrl}/setup/github/created`,
    callback_urls: [`${publicUrl}/auth/callback`],
    public: false,
    default_permissions: PERMISSIONS,
    default_events: [],
  };
}

/**
 * Where the browser sends the manifest: the owner's page for an organization's App, the person's own for a user's.
 * @param {{repo: string, state: string, ownerType: 'Organization'|'User'}} args
 */
export function manifestPostUrl({ repo, state, ownerType }) {
  const [owner] = repo.split('/');
  const base = ownerType === 'User' ? `${GITHUB}/settings/apps/new` : `${GITHUB}/organizations/${encodeURIComponent(owner)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/**
 * What starts this console again when it exits, so the setup page can restart it. Docker does not tell a container
 * its restart policy, so a container says it with WOODSHED_CLOUD_SUPERVISED=1; systemd sets INVOCATION_ID in every
 * unit it runs, which must then have Restart=on-failure or always. WOODSHED_CLOUD_SUPERVISED=0 says nothing will.
 * @param {NodeJS.ProcessEnv} env
 * @returns {'setting'|'systemd'|null}  null when nothing is known to start it again: a plain `node` in a shell
 */
export function supervisorOf(env = process.env) {
  if (env.WOODSHED_CLOUD_SUPERVISED === '0') return null;
  if (env.WOODSHED_CLOUD_SUPERVISED === '1') return 'setting';
  return env.INVOCATION_ID ? 'systemd' : null;
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: Function, save: Function, list: Function}|null,
 *          config: {githubApp: object|null, publicUrl: string, repo: string}, fetchImpl?: typeof fetch, now?: () => number,
 *          supervisor?: 'setting'|'systemd'|null, exit?: (code: number) => void}} deps
 *   `supervisor` is supervisorOf()'s: without one the page offers no Restart button. `exit` ends the process.
 */
export function createGitHubAppSetup({ store, secrets, config, fetchImpl = fetch, now = Date.now, supervisor = null, exit = (code) => process.exit(code) }) {
  // States this console started a manifest with, so the redirect GitHub sends the browser back with is one we asked for.
  const pending = new Map();
  let restarting = false;
  if (secrets && !config.githubApp) console.log('githubSetup: restart from the page', { offered: Boolean(supervisor), supervisor });

  function stored() {
    return store.state.githubAppSetup ?? null;
  }

  function saveStored(patch) {
    // An installation belongs to one App: a different App starts without the old one's.
    const keep = patch.appId && patch.appId !== stored()?.appId ? {} : stored();
    store.state.githubAppSetup = { ...keep, ...patch };
    store.save();
  }

  /** @returns {boolean}  this console can be set up here: it has a secret store and no App in force */
  function available() {
    return Boolean(secrets) && !config.githubApp;
  }

  function requireAvailable() {
    if (!secrets) throw refusal('this console has no secret store, so it cannot keep an App key: see woodshed/providers/local/README.md for the secrets folder');
    if (secrets.configured?.() === false) throw refusal('this console has no secrets manager yet: choose one on the Secrets page first, then come back');
    if (config.githubApp) throw refusal('this console already runs on a GitHub App: change it on the Secrets page, or in its settings');
  }

  async function keyIsSet() {
    const list = await secrets.list();
    return Boolean(list.find((s) => s.name === APP_KEY_SECRET)?.set);
  }

  /** @returns {Promise<object>}  what the page shows: never a secret, only whether each is set */
  async function view() {
    const found = stored();
    const needsRestart = Boolean(found?.installationId) && !config.githubApp;
    return {
      available: available(),
      hasSecretStore: Boolean(secrets),
      configuredBy: config.githubApp ? (found && found.appId === String(config.githubApp.appId) ? 'setup' : 'environment') : null,
      repo: defaultProject(config).repo,
      publicUrl: config.publicUrl,
      appId: found?.appId ?? null,
      slug: found?.slug ?? null,
      installationId: found?.installationId ?? null,
      keySet: secrets ? await keyIsSet().catch(() => false) : false,
      // The console reads its App at start: what was saved takes effect after a restart.
      needsRestart,
      // Only when something will start it again: a plain `node` that exits stays down.
      canRestart: needsRestart && Boolean(supervisor),
      restarting,
      manifestHost: new URL(config.publicUrl).host,
    };
  }

  /**
   * Starts the manifest flow.
   * @param {{ownerType?: string}} args  `User` for an App under the person's own account, else the repo owner's organization
   * @returns {{url: string, manifest: object}}  the page posts `manifest` to `url`, a form field of that name
   */
  function startManifest({ ownerType } = {}) {
    requireAvailable();
    const state = crypto.randomBytes(24).toString('base64url');
    for (const [key, at] of pending) if (now() - at > STATE_TTL_MS) pending.delete(key);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(state, now());
    console.log('githubSetup: manifest started', { ownerType: ownerType === 'User' ? 'User' : 'Organization' });
    return {
      url: manifestPostUrl({ repo: defaultProject(config).repo, state, ownerType: ownerType === 'User' ? 'User' : 'Organization' }),
      manifest: appManifest({ publicUrl: config.publicUrl, repo: defaultProject(config).repo }),
    };
  }

  /**
   * GitHub sent the browser back with a code: trade it for the App's details and keep them.
   * @returns {Promise<{appId: string, slug: string}>}
   */
  async function completeManifest({ code, state }) {
    requireAvailable();
    const startedAt = pending.get(state);
    pending.delete(state);
    if (!startedAt || now() - startedAt > STATE_TTL_MS) throw refusal('this page was not opened from the console\'s Create button, or it took over 15 minutes: start again');
    if (!/^[a-f0-9]{10,64}$/i.test(String(code ?? ''))) throw refusal('GitHub sent no code: start again');
    const res = await fetchImpl(`${GITHUB_API}/app-manifests/${code}/conversions`, {
      method: 'POST', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    const made = await res.json().catch(() => ({}));
    if (!res.ok || !made.id || !made.pem) {
      console.warn('githubSetup: manifest conversion refused', { status: res.status });
      throw refusal(`GitHub would not hand over the App (HTTP ${res.status}): the code is single use and lasts an hour, so start again`);
    }
    await secrets.save(APP_KEY_SECRET, checked(APP_KEY_SECRET, made.pem));
    if (made.client_secret) await secrets.save(CLIENT_SECRET, checked(CLIENT_SECRET, made.client_secret));
    saveStored({ appId: String(made.id), slug: made.slug, clientId: made.client_id ?? null, createdBy: 'manifest' });
    console.log('githubSetup: App created from the manifest', { appId: made.id, slug: made.slug, clientSecret: Boolean(made.client_secret) });
    return { appId: String(made.id), slug: made.slug };
  }

  /**
   * An App made by hand: check its ID and key against GitHub, then keep them.
   * @param {{appId: string, privateKey: string, clientSecret?: string, installationId?: string}} fields
   */
  async function saveManual({ appId, privateKey, clientSecret, installationId }) {
    requireAvailable();
    if (!/^\d{1,12}$/.test(String(appId ?? '').trim())) throw refusal('the App ID is the number at the top of the App\'s settings page');
    const id = String(appId).trim();
    if (installationId && !/^\d{1,12}$/.test(String(installationId).trim())) throw refusal('the installation ID is the number that ends the installation page\'s URL');
    const key = checked(APP_KEY_SECRET, privateKey);
    let app;
    try {
      app = await createAppApi({ appId: id, privateKey: key, fetchImpl, now }).app();
    } catch (err) {
      console.warn('githubSetup: App check refused', { message: firstLine(err) });
      throw refusal(`GitHub did not accept that App ID with that key (${firstLine(err)})`);
    }
    await secrets.save(APP_KEY_SECRET, key);
    if (clientSecret) await secrets.save(CLIENT_SECRET, checked(CLIENT_SECRET, clientSecret));
    saveStored({ appId: id, slug: app.slug, clientId: app.clientId || null, createdBy: 'paste', ...(installationId ? { installationId: String(installationId).trim() } : {}) });
    console.log('githubSetup: App details saved', { appId: id, slug: app.slug, installationGiven: Boolean(installationId), clientSecret: Boolean(clientSecret) });
    return { appId: id, slug: app.slug };
  }

  /**
   * Finds where the App is installed on the repo, and checks that a token can be minted there. Safe to ask before the
   * person has installed it: that is the "not yet" answer.
   * @param {{installationId?: string}} args  to give it by hand, when the App is installed under another account than the repo's
   * @returns {Promise<{installed: boolean, installationId?: string}>}
   */
  async function findInstallation({ installationId } = {}) {
    requireAvailable();
    const found = stored();
    if (!found?.appId) throw refusal('create the App first');
    const privateKey = await secrets.read(APP_KEY_SECRET);
    if (!privateKey) throw refusal('the App\'s key is not saved: create the App again, or paste it');
    let id = installationId ? String(installationId).trim() : null;
    if (id && !/^\d{1,12}$/.test(id)) throw refusal('the installation ID is the number that ends the installation page\'s URL');
    if (!id) {
      const res = await fetchImpl(`${GITHUB_API}/repos/${defaultProject(config).repo}/installation`, {
        headers: {
          authorization: `Bearer ${appJwt({ appId: found.appId, privateKey, nowMs: now() })}`,
          accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        },
      });
      if (res.status === 404) {
        console.log('githubSetup: App not installed on the repo yet', { repo: defaultProject(config).repo });
        return { installed: false };
      }
      const answer = await res.json().catch(() => ({}));
      if (!res.ok || !answer.id) throw refusal(`GitHub would not say where the App is installed (HTTP ${res.status})`);
      id = String(answer.id);
    }
    try {
      await createTokenSource({ appId: found.appId, installationId: id, privateKey, repo: defaultProject(config).repo, label: 'setup check', fetchImpl, now }).token();
    } catch (err) {
      throw refusal(`the App is not installed on ${defaultProject(config).repo} under that installation (${firstLine(err)})`);
    }
    saveStored({ installationId: id });
    console.log('githubSetup: installation saved', { installationId: id });
    return { installed: true, installationId: id };
  }

  /**
   * Ends the process so its supervisor starts it again, which is when the saved App comes into force (applyStored).
   * @param {{by: string|null}} args  who asked, for the log
   * @returns {{restarting: true}}  answered before the process exits
   */
  function restart({ by }) {
    requireAvailable();
    if (!stored()?.installationId) throw refusal('make the App and install it first (steps 1 and 2)');
    if (!supervisor) {
      console.warn('githubSetup: restart refused, nothing would start the console again', { by });
      throw refusal('nothing would start this console again: restart it from its shell, or set WOODSHED_CLOUD_SUPERVISED=1 where a supervisor restarts it');
    }
    if (!restarting) {
      restarting = true;
      console.log('githubSetup: restart asked', { by, supervisor, appId: stored().appId, exitCode: RESTART_EXIT_CODE });
      setTimeout(() => exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
    }
    return { restarting: true };
  }

  return { available, view, startManifest, completeManifest, saveManual, findInstallation, restart };
}

/**
 * Starting up: an App saved by the setup page counts as the console's own, unless the environment names one.
 * @param {object} config  loadConfig()'s; its `githubApp` is filled in, and `ghToken` dropped, when there is a saved App
 * @param {{state: object}} store
 * @param {object|null} secrets
 * @returns {object}  the config, changed only when something saved was applied
 */
export function applyStored({ config, store, secrets }) {
  const found = store.state.githubAppSetup;
  if (config.githubApp || !secrets || !found?.appId || !found?.installationId) return config;
  console.log('console: GitHub App from the setup page', { appId: found.appId, installationId: found.installationId });
  return { ...config, githubApp: { appId: found.appId, installationId: found.installationId, keyFile: null, keyFromSecret: true }, ghToken: null };
}
