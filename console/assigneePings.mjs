// Direct messages to the person a shared session is assigned to (fleet.mjs keeps the assignee), from the Woodshed
// bot, to the Slack user People links to their handle (slackPeople.mjs). Three moments only, all needing them before the
// pull request is done: the session stopped to ask them something, it left a `Needs a human:` comment, and its pull
// request gave up waiting for an approval with green checks. A ready pull request is not one: its brief is in the channel's thread, which mentions them. Someone with no Slack link gets nothing new, and the console logs
// that it skipped them. Best effort: a message Slack refuses changes nothing else, and is not sent again.

import { sessionLink } from './sessions.mjs';
import { plainText } from './slack.mjs';

/**
 * @param {{slack: {dm: Function}|null, slackPeople: {slackUserFor: (login: string) => string|null}|null, publicUrl: string}} deps
 */
export function createAssigneePings({ slack, slackPeople, publicUrl, org = null }) {
  /**
   * The rules every message here follows: a shared session, assigned, to someone People links to a Slack user.
   * @returns {string|null}  the assignee's Slack member ID, or null when they are not to be told, logged with `why`
   */
  function assigneeUser(session, why) {
    if (!session?.assignee || session.owner) return null;
    const user = slackPeople?.slackUserFor(session.assignee) ?? null;
    if (!user) console.log('pings: skipped, the assignee has no Slack link', { id: session.id, assignee: session.assignee, why });
    return user;
  }

  async function send(session, why, markdown) {
    if (!session?.assignee || session.owner) return false;
    if (!slack) {
      console.log('pings: skipped, this console has no Slack', { id: session.id, why });
      return false;
    }
    const user = assigneeUser(session, why);
    if (!user) return false;
    try {
      const sent = await slack.dm({ user, markdown });
      console.log('pings: assignee told', { id: session.id, assignee: session.assignee, why, sent });
      return sent;
    } catch (err) {
      console.warn('pings: message not sent', { id: session.id, why, message: String(err?.message ?? err).split('\n')[0] });
      return false;
    }
  }

  const link = (session) => sessionLink(publicUrl, session.id, org);
  // The title goes in quotes, not bold, so a `*` or `_` in it cannot break the formatting around it.
  const title = (session) => plainText(session.title ?? 'A session');

  /** The session stopped to ask its assignee something. */
  function needsYou(session) {
    return send(session, 'needs you', `“${title(session)}” needs you: it is waiting for an answer. ${link(session)}`);
  }

  /**
   * Its pull request was not approved with green checks in time, so it was not posted to the channel.
   * @param {object} session
   * @param {{number: number, url: string, review: string, suites: {name: string, outcome: string}[]}} pull  each
   *   suite's name, from the project file, and its outcome
   */
  function gaveUp(session, { number, url, review, suites = [] }) {
    const outcomes = suites.map((s) => `${plainText(s.name.charAt(0).toUpperCase() + s.name.slice(1))}: ${plainText(s.outcome)}. `).join('');
    return send(session, 'pull request gave up',
      `“${title(session)}”: #${number} was not approved with green checks in time, so it was not posted. Review: ${plainText(review)}. `
      + `${outcomes}${url} · ${link(session)}`);
  }

  /**
   * The session asked for a person in a `Needs a human:` comment, such as when its change could not be proven here.
   * @param {object} session
   * @param {{number: number, url: string|null}} comment
   */
  function needsHuman(session, { number, url }) {
    return send(session, 'needs a human',
      `“${title(session)}” needs a person: it left a “Needs a human” comment on #${number}. ${url ?? ''} · ${link(session)}`);
  }

  /**
   * Who to mention in the thread of the pull request's post, by the same rules as a message.
   * @returns {string|null}  a Slack member ID
   */
  function mentionFor(session) {
    return assigneeUser(session, 'thread mention');
  }

  return { needsYou, gaveUp, needsHuman, mentionFor };
}
