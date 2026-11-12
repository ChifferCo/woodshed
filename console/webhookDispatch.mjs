// GitHub webhooks and Slack mentions, as the console sees them: the provider's event source (the SQS queue on AWS,
// providers/aws/webhookQueue.mjs) hands each message here, and this hands each GitHub one to the fleet the way the
// poll would, each change to a pull request to pullWebhooks.mjs, and each Slack mention to asks.mjs. The polls stay as
// a slower fallback for GitHub.

import { parseCommand } from './sessions.mjs';
import { defaultProject, projectForRepo } from './projects.mjs';

/**
 * @param {object} message  one queued message's body
 * @param {{label: string}} opts
 * @returns {object|null}  a trigger in the shape fleet.handleTrigger takes, plus `at`, or null to drop it
 */
export function messageToTrigger(message, { label }) {
  if (message?.source !== 'github' || !Number.isInteger(message.number) || !message.login) return null;
  // Another project's issue or pull request: its #12 is not the default project's #12.
  const project = message.project ? { project: message.project } : {};
  if (message.type === 'label') {
    // Any other label on a pull request may be its project's QA label, which only its project file names: the fleet
    // reads that and drops the rest (qaSessions.mjs).
    if (message.label !== label && message.kind === 'pr') {
      return { trigger: 'qa', number: message.number, label: message.label, login: message.login, ...project };
    }
    if (message.label !== label) return null;
    return {
      trigger: 'label', number: message.number, title: message.title ?? '', kind: message.kind === 'pr' ? 'pr' : 'issue',
      login: message.login, at: message.receivedAt, ...project,
    };
  }
  if (message.type === 'comment') {
    const command = parseCommand(message.body);
    if (!command || !message.commentId) return null;
    return { trigger: 'comment', number: message.number, login: message.login, text: command.text, commentId: message.commentId, ...project };
  }
  return null;
}

/**
 * @param {{label: string, config?: object|null, fleet: {handleWebhookTrigger: Function, handleQaLabel: Function, handleNeedsHuman: Function, webhooksAlive: Function},
 *          asks?: {handleMention: Function}|null, pulls?: {handle: Function}|null, events?: {record: Function},
 *          appIdentity?: {available: boolean, login: () => Promise<string|null>}|null}} opts
 *   `events` keeps what happened to each message (webhookEvents.mjs); without `asks`, a Slack mention is dropped, and
 *   without `pulls` a pull request change; a result with `unrecorded` is left out of `events`. `appIdentity`
 *   (appIdentity.mjs) says whose comment a session's "Needs a human:" must be; without one, those are dropped.
 *   `config` names the console's projects: a GitHub message about a repo that is no project's is dropped, and one
 *   about another project's repo is handed on naming that project (`project`), so it acts on that repo's numbers
 * @returns {{dispatch: (message: {text: string, id?: string|null, attempt?: string|null}) => Promise<boolean>, alive: () => void}}
 *   `dispatch` takes one message's raw body, and `attempt` is how the source counts its tries ("try 2 of 3"), for the
 *   events log. It resolves true when the source may forget the message, false to have it come back for a retry.
 *   `alive` is called on each receive, so the fleet knows webhooks are arriving.
 */
export function createWebhookDispatch({ label, config = null, fleet, asks = null, pulls = null, events = { record() {} }, appIdentity = null }) {
  // Every GitHub message below acts on an issue or pull request number, which means nothing without its repo: another
  // project's #12 is not the default project's #12. So a message about another project's repo carries that project's
  // name from here on (`project`), and one about a repo that is no project's is dropped. A message with no repo was
  // queued by a Lambda from before it named one, during a deploy, and is the default project's, as every message was
  // then: so the Lambda and the console can be deployed in either order.
  // Returns the message to hand on, or null to drop it.
  function routed(body) {
    if (!config || !body.repo) return body;
    const project = projectForRepo(config, body.repo);
    if (!project) {
      console.log('webhooks: message from a repo that is not a project, dropped', { repo: String(body.repo).slice(0, 100), type: body.type ?? null });
      return null;
    }
    if (project.name === defaultProject(config).name) return body;
    console.log('webhooks: message for another project', { project: project.name, type: body.type ?? null, number: body.number ?? null });
    return { ...body, project: project.name };
  }

  async function dispatch({ text, id = null, attempt = null }) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.warn('webhooks: unreadable message, deleted', { id });
      events.record(null, { outcome: 'failed', reason: 'the message was not JSON' });
      return true;
    }
    if (body?.source === 'slack') return dispatchSlack(body, attempt);
    if (body?.source === 'github') {
      body = routed(body);
      if (!body) return true;
    }
    if (body?.source === 'github' && body.type === 'needsHuman') {
      // Anyone could type the words; only the App's own comment is a session asking. Left out of the events log, as
      // any other comment that is not for the console is.
      if (!appIdentity?.available) {
        console.log('webhooks: a Needs a human comment, but the console has no GitHub App to have written it', { number: body.number ?? null });
        return true;
      }
      const appLogin = await appIdentity.login();
      if (!appLogin) {
        console.warn('webhooks: a Needs a human comment kept for a retry, the App login not read', { number: body.number ?? null });
        return false;
      }
      if (body.login !== appLogin) {
        console.log('webhooks: a Needs a human comment not from the App, ignored', { number: body.number ?? null });
        return true;
      }
      console.log('webhooks: a session asked for a person', { number: body.number ?? null, delivery: body.deliveryId ?? null });
      return settle(body, () => fleet.handleNeedsHuman(body), body.number ?? null, attempt);
    }
    if (body?.source === 'github' && body.type === 'pr') {
      // A review may have approved a pull request that waits on it for QA (fleet.qaAfterReview).
      if (body.what === 'review submitted' && fleet.qaAfterReview) await qaAfterReview(body);
      if (!pulls) return true;
      return settle(body, () => pulls.handle(body), body.number ?? null, attempt);
    }
    const trigger = messageToTrigger(body, { label });
    if (!trigger) {
      // Left out of the events log: every other label in the repo would push the ones that matter off it.
      console.log('webhooks: message not for the console, deleted', { type: body?.type ?? null, number: body?.number ?? null });
      return true;
    }
    if (trigger.trigger === 'qa') return settle(body, () => fleet.handleQaLabel(trigger), trigger.number, attempt);
    console.log('webhooks: message received', { type: body.type, number: trigger.number, delivery: body.deliveryId ?? null });
    return settle(body, () => fleet.handleWebhookTrigger(trigger), trigger.number, attempt);
  }

  // QA is the fleet's to start; the pull request's refresh goes on whatever it answered.
  async function qaAfterReview(body) {
    for (const number of (Array.isArray(body.numbers) ? body.numbers : [body.number]).filter(Number.isInteger)) {
      try {
        await fleet.qaAfterReview({ number, project: body.project ?? null });
      } catch (err) {
        console.warn('webhooks: QA after a review failed', { number, message: String(err?.message ?? err).split('\n')[0] });
      }
    }
  }

  function dispatchSlack(body, attempt) {
    if (!asks || body.type !== 'mention') {
      console.log('webhooks: Slack message not for the console, deleted', { type: body.type ?? null, asks: Boolean(asks) });
      if (body.type === 'mention') events.record(body, { outcome: 'ignored', reason: 'Slack questions are off on this console' });
      return true;
    }
    console.log('webhooks: Slack mention received', { event: body.eventId ?? null, channel: body.channel ?? null });
    return settle(body, () => asks.handleMention(body), body.eventId ?? null, attempt);
  }

  // Done once handled. One that throws is left with the source for a retry.
  async function settle(body, work, what, attempt) {
    let result;
    try {
      result = await work();
    } catch (err) {
      const reason = String(err?.message ?? err).split('\n')[0];
      console.error('webhooks: handling failed, left for a retry', { what, attempt, message: reason });
      events.record(body, { outcome: 'failed', reason: attempt ? `${reason} (${attempt})` : reason });
      return false;
    }
    if (!result?.unrecorded) events.record(body, result ?? { outcome: 'ignored' });
    return true;
  }

  return { dispatch, alive: () => fleet.webhooksAlive() };
}
