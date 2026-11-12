// What the Secrets & webhooks tab does: list the secrets, show or replace a
// value, and keep the GitHub App's webhook settings in step with where the
// provider receives webhooks and the webhook secret. server.mjs checks the request's origin and its
// typed confirmation before calling any of these.

import { createTokenSource } from './githubApp.mjs';
import { checkValue, newWebhookSecret, secretSpecs } from './secrets.mjs';
import { defaultProject } from './projects.mjs';

export const WEBHOOK_SECRET = 'github-webhook-secret';
export const APP_KEY_SECRET = 'github-app-key';
// The GitHub App's own secrets, which a console that borrows its GitHub access has none of.
const APP_SECRETS = [APP_KEY_SECRET, WEBHOOK_SECRET, 'github-app-client-secret'];
// What the console acts on; the webhook receiver drops every other event. Without the last two, pull requests are still read,
// on the polls' full speed (pullWebhooks.mjs).
export const WEBHOOK_EVENTS = ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'workflow_run'];

const NO_WEBHOOK = 'this console borrows its GitHub access from its host, so it has no GitHub App webhook: it polls GitHub';

/** @returns {Error & {shown: true}}  a refusal the page shows as it is */
export function refusal(message) {
  return Object.assign(new Error(message), { shown: true });
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, 300);
}

/**
 * @param {{config: object, secrets: {list: Function, read: Function, write: Function, save: Function, remove: Function},
 *          appKey: {current: () => string|null, set: (pem: string) => void},
 *          appApi: ReturnType<import('./githubApp.mjs').createAppApi>,
 *          webhookUrl: () => Promise<string|null>, checkKey?: (pem: string) => Promise<void>,
 *          onReplace?: (name: string, value: string) => void}} deps
 *   `webhookUrl` is where the provider receives GitHub's webhooks, null where it has nowhere; `checkKey` mints a token with a new App key before it is kept; tests pass a fake.
 *   `onReplace` hears of every replaced value, for the parts of the console that hold one (sign-in)
 */
export function createSettings({ config, secrets, appKey, appApi, webhookUrl, checkKey, onReplace = () => {} }) {
  // A console that borrows its GitHub access has no App: no key, no client secret, no webhook of its own to keep.
  const borrowed = Boolean(config.githubBroker);
  const specs = secretSpecs({ installSecrets: config.installSecrets ?? [] })
    .filter((spec) => !borrowed || !APP_SECRETS.includes(spec.name));
  // One change at a time, so two Replaces of the App key cannot store one and keep the other in memory.
  let changing = Promise.resolve();
  function oneAtATime(fn) {
    return (...args) => {
      const run = changing.then(() => fn(...args));
      changing = run.catch(() => {});
      return run;
    };
  }

  const mintWith = checkKey ?? (async (pem) => {
    const { appId, installationId } = config.githubApp;
    await createTokenSource({ appId, installationId, privateKey: pem, repo: defaultProject(config).repo, label: 'new key check' }).token();
  });

  // GitHub's side, or why it could not be read: without a key there is no JWT to ask with.
  async function githubSide() {
    if (!appKey.current()) return { error: 'the GitHub App key is not set yet' };
    try {
      const [hook, app] = await Promise.all([appApi.hookConfig(), appApi.app()]);
      return { active: hook.active, url: hook.url, contentType: hook.contentType, insecureSsl: hook.insecureSsl, slug: app.slug, events: app.events };
    } catch (err) {
      console.warn('settings: GitHub App settings not readable', { message: firstLine(err) });
      return { error: firstLine(err) };
    }
  }

  async function view() {
    if (borrowed) {
      const list = await secrets.list();
      return { repo: defaultProject(config).repo, secrets: list.filter((s) => !APP_SECRETS.includes(s.name)), webhook: null };
    }
    const [list, expectedUrl, github] = await Promise.all([
      secrets.list(),
      webhookUrl().catch((err) => {
        console.warn('settings: webhook function URL not readable', { message: firstLine(err) });
        return null;
      }),
      githubSide(),
    ]);
    const hookSecret = list.find((s) => s.name === WEBHOOK_SECRET);
    return {
      repo: defaultProject(config).repo,
      secrets: list,
      webhook: {
        expectedUrl,
        secretSet: Boolean(hookSecret?.set),
        secretChangedAt: hookSecret?.changedAt ?? null,
        events: WEBHOOK_EVENTS,
        github,
      },
    };
  }

  function specOrThrow(name) {
    const spec = specs.find((s) => s.name === name);
    if (!spec) throw refusal(`no secret called ${name}`);
    return spec;
  }

  /** @returns {Promise<string>} */
  async function reveal(name) {
    const spec = specOrThrow(name);
    if (!spec.readable) throw refusal(`${name} is write-only`);
    const value = await secrets.read(name);
    if (value === null) throw refusal(`${name} has no value yet`);
    console.log('settings: value shown', { name });
    return value;
  }

  async function replace(name, value) {
    const spec = specOrThrow(name);
    if (spec.kind === 'webhook') throw refusal('rotate the webhook secret instead: the console makes it');
    let text;
    try {
      text = checkValue(spec, value);
    } catch (err) {
      throw refusal(err.message);
    }
    if (name === APP_KEY_SECRET) {
      try {
        await mintWith(text);
      } catch (err) {
        console.warn('settings: new App key refused, the old one kept', { message: firstLine(err) });
        throw refusal(`GitHub did not accept this key, so the old one is kept: ${firstLine(err)}`);
      }
    }
    await secrets.write(name, text);
    if (name === APP_KEY_SECRET) appKey.set(text);
    onReplace(name, text);
  }

  async function setOnGitHub({ url, secret }) {
    if (borrowed) throw refusal(NO_WEBHOOK);
    try {
      await appApi.setHookConfig(secret ? { url, secret } : { url });
    } catch (err) {
      if (err.status === 404) throw refusal('the GitHub App’s webhook is switched off: tick Active in the App’s settings first');
      throw refusal(firstLine(err));
    }
  }

  // The secret goes in first: until GitHub has it too, deliveries fail with a 401 and the poll picks up the slack.
  async function rotateWebhookSecret() {
    if (borrowed) throw refusal(NO_WEBHOOK);
    const secret = newWebhookSecret();
    await secrets.write(WEBHOOK_SECRET, secret);
    try {
      await setOnGitHub({ url: (await webhookUrl()) ?? undefined, secret });
    } catch (err) {
      throw refusal(`The new secret is saved, but GitHub refused it: ${err.message}. Set it on the GitHub App again.`);
    }
  }

  async function applyWebhook() {
    if (borrowed) throw refusal(NO_WEBHOOK);
    const secret = await secrets.read(WEBHOOK_SECRET);
    if (!secret) throw refusal('the webhook secret has no value yet: rotate it first');
    const url = await webhookUrl();
    if (!url) throw refusal('the webhook function has no URL to point GitHub at');
    await setOnGitHub({ url, secret });
  }

  async function setWebhookUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw refusal('that is not a URL');
    }
    if (parsed.protocol !== 'https:') throw refusal('GitHub must post over https');
    await setOnGitHub({ url: parsed.href });
  }

  // GitHub's own record of what it sent and what came back: the only place a 401 from a mismatched secret shows.
  async function deliveries() {
    if (borrowed) throw refusal(NO_WEBHOOK);
    if (!appKey.current()) throw refusal('the GitHub App key is not set yet');
    return appApi.deliveries();
  }

  return {
    view, reveal, deliveries,
    replace: oneAtATime(replace),
    rotateWebhookSecret: oneAtATime(rotateWebhookSecret),
    applyWebhook: oneAtATime(applyWebhook),
    setWebhookUrl: oneAtATime(setWebhookUrl),
  };
}
