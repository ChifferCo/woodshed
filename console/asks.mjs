// Questions from Slack. Mentioning the bot in any channel it is in starts an ask session: a container on the default branch,
// with no databases and a read-only GitHub token, whose claude reads the code and posts its answer in the thread
// through the session API (POST /answer). Another mention in that thread is typed into the same session, or resumes
// it once it has stopped. Ask sessions are shared, like GitHub's, and run on the team key.
//
// Who asked is kept as `slack:<user id>`, with their Slack name in state.json under `slackPeople`, for the pages.
// Only full members of the workspace may ask: never a guest, a bot, or someone from another organization in a shared
// channel. Someone Slack will not tell us about is refused too.

import { isAsk, ACTIVE_STATUSES, sessionLink } from './sessions.mjs';

const TITLE_CHARS = 80;
const EVENTS_KEPT = 200;
// The session API takes an answer up to this; Slack's own limit is per part, and slack.mjs splits a long one.
export const MAX_ANSWER_CHARS = 40_000;
const MAX_ISSUE_TITLE = 200;
export const MAX_ISSUE_BODY_CHARS = 20_000;
const MAX_ISSUE_LABELS = 5;

/** @returns {string}  the question without the mention of the bot that leads it */
export function questionText(text) {
  return String(text ?? '').replace(/^(\s*<@[A-Z0-9]+>)+/, '').trim();
}

function titleFrom(text) {
  const line = text.split('\n')[0].trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/**
 * @param {{store: {state: object, save: () => void}, fleet: object, slack: object, publicUrl: string, now?: () => number,
 *          issues?: {projectForRepo: (repo: string) => object|null, githubOf: (project: object) => object,
 *                    loginFor: (slackId: string) => string|null}|null}} deps
 *   `fleet` is fleet.mjs's: createSession, send, resumeShared, sessions
 *   `issues` lets a question open GitHub issues (openIssue): the console's repos, their clients, and who a Slack user is on GitHub
 */
export function createAsks({ store, fleet, slack, publicUrl, linkQuery = null, issues = null, now = Date.now }) {
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
    await slack.reply({ channel, threadTs, markdown: `Looking into it. [Watch it read the code](${sessionLink(publicUrl, session.id, linkQuery)}).` })
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
      session.slack.lastUser = user;
      const sent = await fleet.send(session, followUp());
      console.log('asks: follow-up typed in', { id: session.id, outcome: sent });
      return { outcome: 'sent', sessionId: session.id };
    }
    if (session?.kept) {
      session.slack.lastUser = user;
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

  function refuseIssue(session, why, extra = {}) {
    console.warn('asks: issue refused', { id: session.id, why, ...extra });
    return Object.assign(new Error(why), { shown: true });
  }

  /**
   * Opens a GitHub issue for a question, as the console's App: the session's token never writes. For whoever last
   * mentioned the bot in the thread, only when Slack's user is linked to a GitHub login that writes to the repo.
   * @param {object} session  an ask session
   * @param {{repo?: string, title?: string, body?: string, labels?: string[]}} issue
   * @returns {Promise<{number: number, url: string, labels: string[], labelsIgnored: string[]}>}
   * @throws {Error}  `shown`, with why it was refused
   */
  async function openIssue(session, issue) {
    if (!isAsk(session) || !session.slack) throw Object.assign(new Error('only a question from Slack opens issues'), { shown: true });
    if (!issues) throw refuseIssue(session, 'this console opens no issues');
    // Asks are never tainted today; a session that had seen production data must not file anything.
    if (session.taintedAt || session.tainted) throw refuseIssue(session, 'a session that has seen production data opens no issues');
    const title = String(issue?.title ?? '').trim();
    const body = String(issue?.body ?? '').trim();
    if (!title || title.length > MAX_ISSUE_TITLE || typeof issue?.body !== 'string' || body.length > MAX_ISSUE_BODY_CHARS) {
      throw refuseIssue(session, `give a title (at most ${MAX_ISSUE_TITLE} characters) and a body (at most ${MAX_ISSUE_BODY_CHARS})`);
    }
    if (issue.labels !== undefined && (!Array.isArray(issue.labels) || issue.labels.length > MAX_ISSUE_LABELS || issue.labels.some((l) => typeof l !== 'string'))) {
      throw refuseIssue(session, `labels are a list of at most ${MAX_ISSUE_LABELS} names`);
    }
    const repo = String(issue?.repo ?? '');
    const project = issues.projectForRepo(repo);
    if (!project) throw refuseIssue(session, `${repo || 'no repo'} is not one of this console's repos`, { repo });
    const asker = session.slack.lastUser ?? session.slack.user;
    const login = issues.loginFor(asker);
    if (!login) throw refuseIssue(session, 'the person who asked is not linked to a GitHub account on People', { repo, asker });
    const gh = issues.githubOf(project);
    let writes;
    try {
      writes = await gh.canWrite(login);
    } catch (err) {
      throw refuseIssue(session, 'GitHub would not say whether the person can write to the repo: try again', { repo, asker: login, message: String(err?.message ?? err).split('\n')[0] });
    }
    if (!writes) throw refuseIssue(session, `@${login} has no write access to ${project.repo}`, { repo: project.repo, asker: login });
    let known = [];
    const asked = (issue.labels ?? []).map((l) => l.trim()).filter(Boolean);
    if (asked.length) known = await gh.labelNames().catch((err) => {
      console.warn('asks: repo labels not read, none applied', { id: session.id, repo: project.repo, message: String(err?.message ?? err).split('\n')[0] });
      return [];
    });
    const labels = asked.map((l) => known.find((k) => k.toLowerCase() === l.toLowerCase())).filter(Boolean);
    const labelsIgnored = asked.filter((l) => !known.some((k) => k.toLowerCase() === l.toLowerCase()));
    let created;
    try {
      created = await gh.createIssue({ title, body, labels });
    } catch (err) {
      const message = String(err?.message ?? err).split('\n')[0];
      throw refuseIssue(session, `GitHub would not open the issue (the App may lack Issues: write on ${project.repo})`, { repo: project.repo, asker: login, message });
    }
    console.log('asks: issue opened', { id: session.id, repo: project.repo, number: created.number, asker: login });
    // The console posts the link itself, so the thread has it whatever the session goes on to say.
    await slack.reply({ channel: session.slack.channel, threadTs: session.slack.threadTs, markdown: `Opened [${project.repo}#${created.number}](${created.url}): ${title}` })
      .catch((err) => console.warn('asks: issue link not posted', { id: session.id, message: String(err?.message ?? err) }));
    return { number: created.number, url: created.url, labels, labelsIgnored };
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

  return { handleMention, answer, openIssue, tick, names };
}
