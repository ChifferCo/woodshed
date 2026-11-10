// Questions from Slack. Mentioning the bot in any channel it is in starts an ask session: a container on the default branch,
// with no databases and a read-only GitHub token, whose claude reads the code and posts its answer in the thread
// through the session API (POST /answer). Another mention in that thread is typed into the same session, or resumes
// it once it has stopped. Ask sessions are shared, like GitHub's, and run on the team key.
//
// Who asked is kept as `slack:<user id>`, with their Slack name in state.json under `slackPeople`, for the pages.
// Only full members of the workspace may ask: never a guest, a bot, or someone from another organization in a shared
// channel. Someone Slack will not tell us about is refused too.

import { isAsk, ACTIVE_STATUSES } from './sessions.mjs';

const TITLE_CHARS = 80;
const EVENTS_KEPT = 200;
// The session API takes an answer up to this; Slack's own limit is per part, and slack.mjs splits a long one.
export const MAX_ANSWER_CHARS = 40_000;

/** @returns {string}  the question without the mention of the bot that leads it */
export function questionText(text) {
  return String(text ?? '').replace(/^(\s*<@[A-Z0-9]+>)+/, '').trim();
}

function titleFrom(text) {
  const line = text.split('\n')[0].trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/**
 * @param {{store: {state: object, save: () => void}, fleet: object, slack: object, publicUrl: string, now?: () => number}} deps
 *   `fleet` is fleet.mjs's: createSession, send, resumeShared, sessions
 */
export function createAsks({ store, fleet, slack, publicUrl, now = Date.now }) {
  const { state } = store;

  // Events being handled now, and those handled. One is marked handled only once it is, so a mention whose handling
  // threw is taken up again when the queue hands it back.
  const handling = new Set();

  function seenEvent(eventId) {
    return Boolean(eventId) && (handling.has(eventId) || (state.slackEvents ?? []).includes(eventId));
  }

  function markHandled(eventId) {
    if (!eventId) return;
    state.slackEvents = [...(state.slackEvents ?? []), eventId].slice(-EVENTS_KEPT);
    store.save();
  }

  function sessionFor(channel, threadTs) {
    return fleet.sessions()
      .filter((s) => isAsk(s) && s.slack?.channel === channel && s.slack?.threadTs === threadTs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  function nameOf(user, name) {
    const key = `slack:${user}`;
    if (name && state.slackPeople?.[key] !== name) {
      state.slackPeople = { ...state.slackPeople, [key]: name };
      store.save();
    }
    return name ?? state.slackPeople?.[key] ?? null;
  }

  async function start({ channel, threadTs, user, name: slackName, text }) {
    const name = nameOf(user, slackName);
    const session = await fleet.createSession({
      kind: 'ask', number: null, title: titleFrom(text), startedBy: `slack:${user}`, trigger: 'slack', prompt: text,
      slack: { channel, threadTs, user, name },
    });
    await slack.reply({ channel, threadTs, markdown: `Looking into it. [Watch it read the code](${publicUrl}/s/${session.id}).` })
      .catch((err) => console.warn('asks: start reply not posted', { id: session.id, message: String(err?.message ?? err) }));
    return { outcome: 'started', sessionId: session.id };
  }

  /**
   * @param {{eventId: string, team?: string|null, channel: string, user: string, ts: string, threadTs: string|null,
   *          text: string}} mention  a queued Slack mention (../providers/aws/webhooks/index.mjs)
   * @returns {Promise<{outcome: 'started'|'sent'|'resumed'|'ignored'|'duplicate', sessionId?: string, reason?: string}>}
   * @throws {Error}  when Slack or the fleet could not be reached; the mention is not marked handled, so a retry runs it
   */
  async function handleMention(mention) {
    const { eventId } = mention;
    if (seenEvent(eventId)) {
      console.log('asks: Slack event already handled', { eventId });
      return { outcome: 'duplicate', reason: 'Slack sent this event again' };
    }
    handling.add(eventId);
    try {
      const result = await handleNew(mention);
      markHandled(eventId);
      return result;
    } finally {
      handling.delete(eventId);
    }
  }

  async function handleNew({ team = null, channel, user, ts, threadTs, text }) {
    const thread = threadTs ?? ts;
    const who = await slack.person(user);
    const refusal = !who ? 'someone Slack would not say anything about'
      : !who.member ? 'not a full member of the workspace'
        : team && who.team && who.team !== team ? 'from another workspace' : null;
    if (refusal) {
      await slack.reply({ channel, threadTs: thread, markdown: 'I only answer questions from people in the company\'s Slack workspace.' });
      console.log('asks: mention refused', { channel, user, reason: refusal });
      return { outcome: 'ignored', reason: `refused: the asker is ${refusal}` };
    }
    const question = questionText(text);
    if (!question) {
      await slack.reply({ channel, threadTs: thread, markdown: 'Ask me something about how the code works, after the mention.' });
      console.log('asks: mention with no question', { channel });
      return { outcome: 'ignored', reason: 'no question after the mention' };
    }
    await slack.react({ channel, ts, name: 'eyes' });
    const session = sessionFor(channel, thread);
    const followUp = () => `Follow-up in the Slack thread from ${session.slack?.user === user ? 'the person who asked' : 'someone else'}:\n${question}`;
    if (session && ACTIVE_STATUSES.has(session.status)) {
      if (session.status === 'stopping') {
        await slack.reply({ channel, threadTs: thread, markdown: 'That session is stopping. Mention me again in a minute and it picks up from here.' });
        console.log('asks: follow-up for a stopping session', { id: session.id });
        return { outcome: 'ignored', reason: 'its session is stopping' };
      }
      const sent = await fleet.send(session, followUp());
      console.log('asks: follow-up typed in', { id: session.id, outcome: sent });
      return { outcome: 'sent', sessionId: session.id };
    }
    if (session?.kept) {
      await fleet.resumeShared(session, { text: followUp(), by: `slack:${user}`, why: 'slack' });
      update(session, { noticedAt: null });
      return { outcome: 'resumed', sessionId: session.id };
    }
    console.log('asks: new question', { channel, threaded: Boolean(threadTs), chars: question.length });
    return start({ channel, threadTs: thread, user, name: who.name, text: question });
  }

  function update(session, fields) {
    Object.assign(session, fields);
    store.save();
  }

  /**
   * The answer claude posts through the session API, as Markdown.
   * @returns {Promise<boolean>}  whether Slack took it
   * @throws {Error}  `shown`, for a session that is not a question
   */
  async function answer(session, markdown) {
    if (!isAsk(session) || !session.slack) throw Object.assign(new Error('only a question from Slack has a thread to answer in'), { shown: true });
    const text = String(markdown ?? '').trim();
    if (!text) throw Object.assign(new Error('the answer is empty'), { shown: true });
    const posted = await slack.reply({ channel: session.slack.channel, threadTs: session.slack.threadTs, markdown: text });
    if (posted) update(session, { answeredAt: new Date(now()).toISOString(), answers: (session.answers ?? 0) + 1 });
    console.log('asks: answer posted', { id: session.id, posted, chars: text.length });
    return posted;
  }

  // A question whose session failed, or stopped before it answered, is told so in its thread, once per run.
  async function tick() {
    for (const session of fleet.sessions()) {
      if (!isAsk(session) || session.noticedAt || !['failed', 'stopped'].includes(session.status)) continue;
      const answeredThisRun = session.answeredAt && Date.parse(session.answeredAt) >= Date.parse(session.startedAt ?? session.createdAt);
      update(session, { noticedAt: new Date(now()).toISOString() });
      if (answeredThisRun) continue;
      const why = session.status === 'failed' ? 'it failed to start' : `it stopped (${session.stopReason ?? 'no reason recorded'})`;
      console.log('asks: question left unanswered', { id: session.id, status: session.status });
      await slack.reply({
        channel: session.slack.channel, threadTs: session.slack.threadTs,
        markdown: `Sorry, no answer: ${why} before answering. Mention me again in this thread to try again.`,
      }).catch((err) => console.warn('asks: unanswered notice not posted', { id: session.id, message: String(err?.message ?? err) }));
    }
  }

  /** @returns {Record<string, string>}  the Slack name of each `slack:<id>` asker that has one, for the pages */
  function names(logins) {
    const out = {};
    for (const login of logins) if (state.slackPeople?.[login]) out[login] = state.slackPeople[login];
    return out;
  }

  return { handleMention, answer, tick, names };
}
