// Posts the decision brief of a pull request a session opened to Slack once it has earned it, by the gates in the
// repo's project file (`pullRequests`, docs/reference.md, "The project file"): the review's latest verdict is APPROVE and every
// suite's jobs passed on its head commit, and then the QA check on that commit finished, or the wait for it ran out
// (decisionBrief.mjs builds the brief). A repo with no gates has a pull request posted once it is out of draft and its
// checks pass. Until then it waits in state.json, past the session's end, since a review and a suite often outlast the
// session. A verdict asking for changes, or a suite that failed or was skipped, is handed to the session to act on,
// once for each. An approval is handed over too, once, and the post waits a short grace period so the session can
// read the review's notes first. The brief goes in the thread of the post, and is kept as one PR comment, updated in
// place, which the brief links to. A pull request goes to its project's own channel when the project has one, and
// otherwise to the console's; where it went is kept with the post (`slackPost` on the session, by the fleet).
//
// A My Woodshed session's pull request is watched instead (`watch` on its item): never posted, with or without Slack,
// it hands the session the same feedback, and once the gates pass on a head commit, the approval's notes, once for each
// commit. It keeps watching while the session runs, so a fix pushed after an approval is watched to its own verdict, and
// stops when the pull request closes, the session ends, or the wait runs out, with nothing written on GitHub.

import { DEFAULT_RETENTION } from './consoleSettings.mjs';
import { briefCommentIn, buildBrief, mergeRiskRunIds, qaCheckFrom } from './decisionBrief.mjs';
import { approvalNotesFor, feedbackFor, gaveUpComment, passedNotesFor } from './prMessages.mjs';
import { checksPass, reviewVerdict, suiteNeverRuns, suiteOutcome } from './pullGates.mjs';
import { pullRequestFilters } from '../shared/workflowFile.mjs';

const CHECK_EVERY_MS = 60_000;
const APPROVAL_GRACE_MS = 5 * 60_000;
// With no gates, how long a pull request with no checks at all waits for some to show before it is posted: GitHub
// Actions shows a run within seconds, so this is mostly how long a repo with no CI waits.
const NO_CHECKS_WAIT_MS = 2 * 60_000;

function firstLine(err) {
  return String(err?.stderr?.trim() || err?.message || err).split('\n')[0].slice(0, 300);
}

// A My Woodshed session's pull request is its owner's when they opened it, or, since a session that pushes as the App
// opens it as the App, when the console's App opened it from the branch the console made for this session
// (`woodshed/<owner>-<id>`, or `woodshed/<issue>-<id>` for one started on an issue; never an existing branch it was
// started on, which another session may share), in the repo itself and not a fork, after the session started. Nothing a teammate writes in a body counts. An app's pull request while the App's
// login is not read yet throws, so it is decided on a later tick.
function ownersPull(pull, session, app) {
  const login = String(session.owner ?? '').toLowerCase();
  if (!login) return false;
  const author = String(pull.user?.login ?? '').toLowerCase();
  if (author === login) return true;
  if (pull.user?.type === 'Bot' && !app?.login) throw new Error('the App login is not read yet');
  const fromTheApp = author === String(app?.login ?? '').toLowerCase();
  const sameRepo = Boolean(pull.base?.repo?.full_name) && pull.head?.repo?.full_name === pull.base.repo.full_name;
  // The very branch the console made for it at its start (fleet.mjs, createSession: `madeBranch`, which nothing the
  // session reports changes), matched exactly, as Git's refs are case-sensitive.
  return fromTheApp && sameRepo && Boolean(session.madeBranch) && pull.head?.ref === session.madeBranch
    && Date.parse(pull.created_at) >= Date.parse(session.createdAt);
}

// No review and no suite: nothing to wait for but the pull request itself.
const hasNoGates = (gates) => !gates || (!gates.review && !gates.suites.length);

/**
 * @param {{store: {state: object, save: () => void}, github: object, slack: {available: boolean, postPr: Function}|null,
 *          ownApp?: () => {slug: string, login: string}|null,
 *          githubOf?: ((project: string) => object)|null, defaultProjectName?: () => string|null, gates?: (project: string|null) => Promise<object|null>, now?: () => number, giveUpMs?: () => number, qaWaitMs?: () => number,
 *          events?: {dropped?: (item: object, why: string) => Promise<void>|void,
 *                    feedback?: (item: object, text: string) => Promise<boolean|'later'>|boolean|'later',
                    listening?: (item: object) => 'yes'|'elsewhere'|'ended',
 *                    mention?: (item: object) => Promise<string|null>|string|null}}} deps
 *   `gates` is the project file's `pullRequests` from the default branch (projectFile.mjs) of the pull request's project
 *   (null for the default project's), null for a repo with none; `githubOf` is another project's GitHub client, for a
 *   pull request a session on that project opened (an item with `project`),
 *   and throws when the file could not be read, which leaves each pull request waiting for its next check;
 *   `giveUpMs` is how long a pull request may wait, and `qaWaitMs` how long an approved, green one waits for its QA
 *   check, both read at each check (the Console settings page's numbers); `events` tells the fleet a pull request stopped
 *   waiting (`why` is `posted` once it is in Slack), hands it what the session should hear, and asks it
 *   whose Slack member ID to mention in the post's thread; `listening` says whether a watched pull request's session
 *   can still be told about it (`yes`), is on another pull request or none for now (`elsewhere`), or ended (`ended`), and `feedback` answers true when it was, and `later` when a watched one's session
 *   could not be typed into just now. While pull request webhooks arrive (`webhooksFlowing`), a
 *   webhook marks its pull request due (`stale`) and the rest are read only every `fallbackMs`, except one waiting out
 *   a deadline of its own, which is still read every minute
 */
export function createPrAnnouncer({
  store, github, githubOf = null, defaultProjectName = () => null, slack, gates: gatesOf = async () => null, now = Date.now, giveUpMs = () => DEFAULT_RETENTION.slackGiveUpMs,
  qaWaitMs = () => DEFAULT_RETENTION.qaWaitMs, events = {}, webhooksFlowing = () => false, fallbackMs = CHECK_EVERY_MS, ownApp = () => null,
}) {
  const { state } = store;
  // When each waiting pull request was last read, by number. Not kept: after a restart each is read at once.
  const checkedAt = new Map();
  // When each session's app pull request was last found waiting for the App's login, by session id.
  const appWaits = new Map();
  const pending = () => (state.slackPending ??= []);
  // Watches that ran out, by item key: one is not started again for the same session until it is resumed (renew), so
  // a session back on an old pull request does not start its wait over. Kept to the latest few hundred.
  const expired = () => (state.watchesExpired ??= []);
  const EXPIRED_KEPT = 500;
  // A pull request is its repo's: another project's #12 is not the default project's #12. Items of the default
  // project carry no `project`, as they did before projects.
  const keyOf = (number, project = null) => (project ? `${project}#${number}` : number);
  // Each watch is its session's own, so two My Woodshed sessions on one pull request are each told, and neither takes
  // the place of a shared session's post.
  const itemKey = (item) => (item.watch ? `${keyOf(item.number, item.project)}@${item.sessionId}` : keyOf(item.number, item.project));
  // The client a check started with, for each item being checked: a project removed during its reads must not move the
  // rest of them to another repo.
  const pinned = new Map();
  const gh = (item) => pinned.get(item) ?? (item.project && githubOf ? githubOf(item.project) : github);
  const projectOf = (item) => item.project ?? defaultProjectName();
  const watched = (item) => item.watch === true;
  const hasChannel = (name) => (slack?.channelFor ? Boolean(slack.channelFor(name).channel) : Boolean(slack?.available));

  /**
   * Whether a project's pull requests have a channel to go to: its own, or the console's. One with neither is not
   * tracked, as every pull request was not before projects had channels, so it is tracked once one is set.
   * @param {{name: string}|null} [project]  null for the default project
   */
  function postsFor(project = null) {
    return Boolean(slack?.available) && hasChannel(project?.name ?? defaultProjectName());
  }

  async function drop(item, why) {
    state.slackPending = pending().filter((p) => p !== item);
    checkedAt.delete(itemKey(item));
    store.save();
    console.log('slack: pull request no longer waiting', { number: item.number, why });
    await events.dropped?.(item, why);
  }

  /**
   * A resumed My Woodshed session: each watch of its pull request still waiting (one whose stop was not read yet)
   * starts a new run, its wait over and with nothing told, so the new run hears where the pull request stands rather
   * than running out on the old run's clock. A check reading GitHub meanwhile acts on nothing it read.
   * @param {string} sessionId
   */
  function renew(sessionId) {
    const ran = expired().filter((key) => String(key).endsWith(`@${sessionId}`));
    if (ran.length) state.watchesExpired = expired().filter((key) => !ran.includes(key));
    const items = pending().filter((p) => watched(p) && p.sessionId === sessionId);
    for (const item of items) {
      Object.assign(item, { since: new Date(now()).toISOString(), run: (item.run ?? 0) + 1 });
      for (const key of ['fedReview', 'fedSuite', 'passedSha', 'untoldSaid']) delete item[key];
      checkedAt.delete(itemKey(item));
    }
    if (items.length || ran.length) store.save();
  }

  /**
   * Once per session, and only for a pull request it opened: a resumed branch or a PR's own session finds one
   * older than the session. The URL is the session's word, so only its number is used. A watched one (a My Woodshed
   * session's) is never posted, and is watched only when it is the session's owner's (ownersPull), whenever it was
   * opened, so no session is told to push to a teammate's.
   * @param {object} session
   * @param {{name: string, default?: boolean}|null} [project]  the session's project: its pull request is on that repo
   * @param {{watch?: boolean}} [opts]
   * @returns {Promise<boolean|'later'>}  `later` for an app's pull request while the App's login is not read yet
   * @throws {Error}  when GitHub could not be read, which is worth trying again
   */
  async function track(session, project = null, { watch = false } = {}) {
    const number = Number(/\/pull\/(\d+)$/.exec(session.prUrl ?? '')?.[1]);
    if (!number) return false;
    const other = project && !project.default ? project.name : null;
    // An app's pull request waiting for the App's login is read again a minute later, not at every tick.
    const waited = appWaits.get(session.id);
    if (watch && waited !== undefined && now() - waited < CHECK_EVERY_MS) return 'later';
    const pull = await gh({ project: other }).pull(number);
    let owners;
    try {
      owners = !watch || ownersPull(pull, session, ownApp());
    } catch (err) {
      if (waited === undefined) console.log('slack: an app\'s pull request waits for the App\'s login before it is watched', { id: session.id, number });
      appWaits.set(session.id, now());
      return 'later';
    }
    appWaits.delete(session.id);
    if (!owners) {
      console.log('slack: someone else\'s pull request, not watched', { id: session.id, number, author: pull.user?.login ?? null });
      return false;
    }
    if (!watch && Date.parse(pull.created_at) < Date.parse(session.createdAt)) {
      console.log('slack: pull request older than the session, not posted', { id: session.id, number });
      return false;
    }
    const same = (p) => p.number === number && (p.project ?? null) === other && (watch ? p.watch && p.sessionId === session.id : !p.watch);
    const known = pending().find(same);
    const key = itemKey({ number, project: other, sessionId: session.id, watch });
    if (watch && !known && expired().includes(key)) {
      console.log('slack: pull request watched as long as it may wait already, not watched again until the session is resumed', { id: session.id, number });
      return false;
    }
    if (!known) {
      pending().push({
        number, sessionId: session.id, since: new Date(now()).toISOString(), ...(other ? { project: other } : {}),
        // A watch keeps its repo: a default project replaced since is another repo, whose pull request it is not.
        ...(watch ? { watch: true, ...(project?.repo ? { repo: project.repo } : {}) } : {}),
      });
      store.save();
      console.log(watch ? 'slack: pull request watched for its session, until its review and suites pass' : 'slack: pull request waiting for its review and suites', { id: session.id, number });
    }
    return true;
  }

  // Each verdict and each commit's broken suites are handed over once; the item remembers which it last handed over.
  async function feedBack(item, pull, review, suites, runs, gates) {
    const sha = pull.head.sha;
    const asks = review?.state === 'CHANGES_REQUESTED' && review.commit_id === sha && item.fedReview !== review.id;
    const broken = suites.filter((s) => s.outcome === 'failed' || s.outcome === 'skipped');
    const suiteKey = `${sha}:${broken.map((s) => `${s.name}=${s.outcome}`).join(',')}`;
    const fedSuites = broken.length > 0 && item.fedSuite !== suiteKey;
    if (!asks && !fedSuites) return;
    const text = feedbackFor({ number: item.number, sha, review: asks ? review : null, broken: fedSuites ? broken : [], runs, gates, watch: watched(item) });
    const before = { fedReview: item.fedReview, fedSuite: item.fedSuite, run: item.run ?? 0 };
    if (asks) item.fedReview = review.id;
    if (fedSuites) item.fedSuite = suiteKey;
    store.save();
    console.log('slack: pull request feedback for its session', {
      number: item.number, sessionId: item.sessionId, changesRequested: asks, suites: fedSuites ? broken.map((s) => `${s.name}: ${s.outcome}`) : null,
    });
    const heard = await events.feedback?.(item, text);
    if (heard === 'later') untold(item, before);
    else if (heard === true) told(item);
    return heard;
  }

  // A watched session that could not be typed into just now (claude not open, or statusd not answering) is told again
  // at the next check: nothing is held for it, which a later Resume would type in long after.
  // Told at last: the watch goes back to being read when a webhook says so, and logs the next miss again.
  function told(item) {
    if (!item.untoldSaid) return;
    delete item.untoldSaid;
    store.save();
  }

  function untold(item, { run, ...before }) {
    // A resume while the session was being told has already started the watch over: its reset stands.
    if ((item.run ?? 0) !== run) return;
    const said = item.untoldSaid;
    Object.assign(item, before, { untoldSaid: true });
    store.save();
    // Once until it is told: claude may stay closed for a while, and it is tried every minute.
    if (!said) console.log('slack: watched pull request\'s session not told yet, tried again at each check', { number: item.number, sessionId: item.sessionId });
  }

  // A watched pull request passed its gates on its head commit: the session hears it once for that commit, with the
  // approval's notes to read. It stays watched, so a fix pushed after it is followed to its own verdict.
  async function tellPassed(item, pull, review, suites, gates) {
    const sha = pull.head.sha;
    if (item.passedSha === sha) return undefined;
    const before = { passedSha: item.passedSha, run: item.run ?? 0 };
    item.passedSha = sha;
    store.save();
    console.log('slack: watched pull request passed its review and suites', { number: item.number, sessionId: item.sessionId, sha: sha.slice(0, 7) });
    const heard = await events.feedback?.(item, passedNotesFor({ number: item.number, sha, review, suites, gates }));
    if (heard === 'later') untold(item, before);
    else if (heard === true) told(item);
    return heard;
  }

  // A My Woodshed session's pull request: its session hears each verdict and broken suite, and the pass, and nothing
  // is posted or written on GitHub.
  // Whether a watch is over: its session no longer listens for this pull request, or its wait ran out. Asked before
  // GitHub is read and again before the session is told, since the reads take a while.
  function watchOver(item) {
    if (listening(item) === 'ended') return 'its session ended';
    if (now() - Date.parse(item.since) > giveUpMs()) return 'watched as long as a pull request may wait';
    return null;
  }

  const listening = (item) => events.listening?.(item) ?? 'yes';

  // A watch dropped for its wait running out is remembered, so it is not started again by the session coming back.
  async function endWatch(item, why) {
    if (why === 'watched as long as a pull request may wait') state.watchesExpired = [...expired().filter((k) => k !== itemKey(item)), itemKey(item)].slice(-EXPIRED_KEPT);
    return drop(item, why);
  }

  async function watchOne(item) {
    if (watchOver(item)) return endWatch(item, watchOver(item));
    // A resume while GitHub is read starts a new run of the watch: nothing read for the old one is acted on, not even
    // to drop it. Asked after each read.
    const run = item.run ?? 0;
    const renewed = () => (item.run ?? 0) !== run || !pending().includes(item);
    // A session on another pull request, or a branch with none, for now (or statusd's lookup failed): the watch waits,
    // keeping what it told, so nothing is told twice when the session is back on it. It still ends if the pull request
    // closes meanwhile.
    // Its session ended, or its project left or changed, during a read: nothing read is acted on.
    const over = () => watchOver(item);
    if (listening(item) === 'elsewhere') {
      const pull = await gh(item).pull(item.number);
      if (renewed()) return;
      if (over()) return endWatch(item, over());
      if (pull.state !== 'open') return drop(item, 'closed');
      return;
    }
    const gates = await gatesOf(item.project ?? null, item.number);
    if (renewed()) return;
    if (over()) return endWatch(item, over());
    if (hasNoGates(gates)) return drop(item, 'no review or suite to watch');
    const pull = await gh(item).pull(item.number);
    if (renewed()) return;
    if (over()) return endWatch(item, over());
    if (pull.state !== 'open') return drop(item, 'closed');
    const runs = await gh(item).checkRuns(pull.head.sha);
    const { passed, review, suites } = await gatesPassed(item, pull, runs, gates);
    if (renewed()) return;
    if (watchOver(item)) return endWatch(item, watchOver(item));
    if (listening(item) === 'elsewhere') return;
    const heard = passed ? await tellPassed(item, pull, review, suites, gates) : await feedBack(item, pull, review, suites, runs, gates);
    if (heard === false) return drop(item, 'its session ended');
  }

  // Once per pull request: the session is told of the approval and the post waits, so the review's notes are at least read.
  async function holdForNotes(item, pull, review, gates) {
    if (!item.heldAt) {
      const notes = approvalNotesFor({ number: item.number, sha: pull.head.sha, review, gates, graceMinutes: APPROVAL_GRACE_MS / 60_000 });
      const heard = await events.feedback?.(item, notes);
      item.heldAt = new Date(now()).toISOString();
      store.save();
      console.log('slack: approved, holding the post for the session to read the notes', { number: item.number, sessionId: item.sessionId, heard: heard === true });
      if (heard !== true) item.heldAt = new Date(now() - APPROVAL_GRACE_MS).toISOString();
      return heard === true;
    }
    return now() - Date.parse(item.heldAt) < APPROVAL_GRACE_MS;
  }

  // The session may be gone by now, so the console speaks for it, and tags whoever started it.
  async function escalate(item, pull, review, suites, gates) {
    const starter = /Started by @([A-Za-z0-9-]+)/.exec(pull.body ?? '')?.[1] ?? null;
    const body = gaveUpComment({ starter, pull, review, suites, gates: hasNoGates(gates) ? null : gates });
    // The ticket is read from the PR body's `Closes #N` / `Part of #N` line, so a stuck PR is not lost in the ticket either.
    const ticket = Number(/\b(?:closes|fixes|resolves|part of)\s+#(\d+)/i.exec(pull.body ?? '')?.[1]) || null;
    const targets = ticket && ticket !== item.number ? [item.number, ticket] : [item.number];
    for (const number of targets) {
      try {
        await gh(item).comment(number, number === item.number ? body : `${body} The pull request is #${item.number}: ${pull.html_url}`);
        console.log('slack: told a thread why the pull request gave up', {
          number, pull: item.number, tagged: Boolean(starter), review: review?.state ?? null, suites: suites.map((s) => s.outcome),
        });
      } catch (err) {
        console.warn('slack: could not comment on a thread', { number, pull: item.number, message: firstLine(err) });
      }
    }
  }

  // A suite's workflow path filters, read from the default branch. Null when they cannot be read: the suite is then
  // waited for, as one that runs.
  async function filtersOf(item, suite) {
    try {
      const text = await gh(item).defaultBranchFile(suite.workflow);
      if (text === null) throw new Error('the workflow file is not on the default branch');
      return pullRequestFilters(text);
    } catch (err) {
      console.warn('slack: a suite\'s path filters not read, waiting for it', { number: item.number, suite: suite.name, workflow: suite.workflow, message: firstLine(err) });
      return null;
    }
  }

  // A pull request touching only paths a suite's workflow ignores gets no jobs from it, ever, so it must not wait for
  // them. Kept for each head commit, unless a workflow could not be read, which is tried again at the next check.
  async function suitesNeverRunning(item, sha, gates) {
    if (item.suitesPathsSha === sha) return new Set(item.suitesNever);
    const files = await gh(item).pullFiles(item.number);
    const never = [];
    let unread = false;
    for (const suite of gates.suites) {
      const filters = await filtersOf(item, suite);
      unread ||= !filters;
      if (filters && suiteNeverRuns(files, filters)) never.push(suite.name);
    }
    if (!unread) {
      item.suitesPathsSha = sha;
      item.suitesNever = never;
      store.save();
    }
    if (never.length) console.log('slack: a suite does not run for these paths, not waiting for it', { number: item.number, sha: sha.slice(0, 7), suites: never });
    return new Set(never);
  }

  /** @returns {Promise<{name: string, suite: object, outcome: string}[]>}  each suite's outcome on the head commit */
  async function suiteOutcomes(item, sha, runs, gates) {
    const outcomes = gates.suites.map((suite) => ({ name: suite.name, suite, outcome: suiteOutcome(runs, suite) }));
    if (!outcomes.some((s) => s.outcome === 'none')) return outcomes;
    const never = await suitesNeverRunning(item, sha, gates);
    return outcomes.map((s) => (s.outcome === 'none' && never.has(s.name) ? { ...s, outcome: 'green', notRun: true } : s));
  }

  // The QA check runs once the review approves, on a pull request with its label, and is posted when it has a verdict.
  // The brief waits for that check on the head commit, from when the commit was first seen approved and green.
  function qaFor(item, pull, runs, qa) {
    if (!qa) return { waiting: false, check: null, notRun: 'not configured' };
    const sha = pull.head.sha;
    const { finished, check } = qaCheckFrom(runs, qa, ownApp());
    if (finished) return { waiting: false, check, notRun: null };
    if (!(pull.labels ?? []).some((l) => l.name === qa.label)) return { waiting: false, check: null, notRun: `no ${qa.label} label` };
    if (item.qaSha !== sha) {
      item.qaSha = sha;
      item.qaSince = new Date(now()).toISOString();
      store.save();
      console.log('slack: approved and green, waiting for the QA check', { number: item.number, sha: sha.slice(0, 7), check: qa.check, waitMinutes: qaWaitMs() / 60_000 });
    }
    if (now() - Date.parse(item.qaSince) < qaWaitMs()) return { waiting: true };
    console.log('slack: the QA check did not finish in time, the brief says it was not run', { number: item.number, sha: sha.slice(0, 7) });
    return { waiting: false, check: null, notRun: `it did not finish within ${Math.round(qaWaitMs() / 60_000)} minutes` };
  }

  // One brief comment for each pull request, kept up to date: the one this console left before is edited.
  async function writeBriefComment(item, comments, body) {
    const existing = comments.find((c) => c.id === item.briefCommentId) ?? briefCommentIn(comments);
    if (existing) {
      await gh(item).updateComment(existing.id, body);
      return { id: existing.id, updated: true };
    }
    const id = await gh(item).comment(item.number, body);
    item.briefCommentId = id;
    store.save();
    return { id, updated: false };
  }

  // A merge risk check's details_url is only a claim: GitHub says which workflow the run it links really is.
  async function reviewRunsFor(item, runs, sha, gates) {
    const trusted = new Set();
    for (const id of mergeRiskRunIds(runs, sha, gates?.mergeRisk?.check ?? null)) {
      const run = await gh(item).workflowRun(id);
      const path = String(run?.path ?? '').split('@')[0];
      // The run's own commit too, so a link to the review of another pull request does not pass.
      if (path === gates.review.workflow && run?.head_sha === sha) trusted.add(id);
      else console.warn('slack: a merge risk check not from the review\'s workflow, ignored', { number: item.number, runId: id, path, sameCommit: run?.head_sha === sha });
    }
    return trusted;
  }

  async function announce(item, { pull, review, runs, suites, qa, gates }) {
    const [comments, reviewRuns] = await Promise.all([gh(item).issueComments(item.number), reviewRunsFor(item, runs, pull.head.sha, gates)]);
    const args = { pull, review, runs, comments: comments ?? [], suites, qa, gates, reviewRuns, ownApp: ownApp() };
    const written = await writeBriefComment(item, comments ?? [], buildBrief(args).comment);
    const brief = buildBrief({ ...args, commentUrl: written.id ? `${pull.html_url}#issuecomment-${written.id}` : null });
    console.log('slack: decision brief written on the pull request', { number: item.number, commentId: written.id, updated: written.updated, ...brief.facts });
    // No `mergeRisk`, no risk tag on the post: undefined leaves it out, where null says the check was not posted.
    const tier = gates?.mergeRisk ? brief.tier : undefined;
    const posted = await slack.postPr({
      title: pull.title, url: pull.html_url, tier, brief: brief.slack, mention: (await events.mention?.(item)) ?? null, project: projectOf(item),
    });
    if (posted?.channel) item.post = { channel: posted.channel, ts: posted.ts ?? null };
    return drop(item, posted ? 'posted' : 'Slack did not take it');
  }

  /** @returns {Promise<{passed: boolean, review: object|null, suites: object[]}>}  whether the gates passed on the head */
  async function gatesPassed(item, pull, runs, gates) {
    if (hasNoGates(gates)) {
      if (!item.noGatesSaid) {
        item.noGatesSaid = true;
        store.save();
        console.log('slack: no review or suite configured, waiting for the pull request to be out of draft with its checks passing', { number: item.number });
      }
      // A pull request's checks show a few seconds after it opens: none yet is not passing, until a repo with no CI
      // has had time to show some.
      const settled = runs.length > 0 || now() - Date.parse(item.since) >= NO_CHECKS_WAIT_MS;
      return { passed: !pull.draft && settled && checksPass(runs), review: null, suites: [] };
    }
    const reviews = gates.review ? await gh(item).reviews(item.number) : [];
    const review = reviewVerdict(reviews, gates.review);
    const suites = await suiteOutcomes(item, pull.head.sha, runs, gates);
    // An approval of an older commit does not cover a fix pushed since: wait for the review of the head.
    const approved = !gates.review || (review?.state === 'APPROVED' && (!review.commit_id || review.commit_id === pull.head.sha));
    return { passed: approved && suites.every((s) => s.outcome === 'green'), review, suites };
  }

  async function checkOne(item) {
    if (watched(item)) {
      pinned.set(item, gh(item));
      try {
        return await watchOne(item);
      } finally {
        pinned.delete(item);
      }
    }
    const gates = await gatesOf(item.project ?? null, item.number);
    const pull = await gh(item).pull(item.number);
    if (pull.state !== 'open') return drop(item, 'closed');
    const gaveUp = now() - Date.parse(item.since) > giveUpMs();
    const runs = await gh(item).checkRuns(pull.head.sha);
    const { passed, review, suites } = await gatesPassed(item, pull, runs, gates);
    if (gaveUp && !passed) {
      await escalate(item, pull, review, suites, gates);
      const reviewState = gates?.review ? review?.state ?? 'none' : 'not configured';
      await events.gaveUp?.(item, { number: item.number, url: pull.html_url, review: reviewState, suites: suites.map(({ name, outcome }) => ({ name, outcome })) });
      return drop(item, 'not approved and green in time');
    }
    if (passed) {
      // Its channel was cleared after it was tracked: it waits for one, and gives up in time like any other.
      if (!hasChannel(projectOf(item))) {
        if (gaveUp) return drop(item, 'no Slack channel');
        console.log('slack: ready, but its project has no channel now', { number: item.number, project: projectOf(item) });
        return;
      }
      const holding = gates?.review ? await holdForNotes(item, pull, review, gates) : false;
      const qa = qaFor(item, pull, runs, gates?.qa ?? null);
      if (holding || qa.waiting) return;
      return announce(item, { pull, review, runs, suites, qa, gates });
    }
    if (!hasNoGates(gates)) await feedBack(item, pull, review, suites, runs, gates);
  }

  // The grace period after an approval and the wait for the QA check end on the clock, with no webhook to say so. The
  // grace period counts a minute past its end, so a check lands after it and not a fallback period later.
  function waitsOnTheClock(item) {
    const holding = item.heldAt && now() - Date.parse(item.heldAt) < APPROVAL_GRACE_MS + CHECK_EVERY_MS;
    // A watched session not told yet is tried again each minute, with no webhook to say claude opened.
    return Boolean(holding || item.qaSince || item.untoldSaid);
  }

  function due(item) {
    const last = checkedAt.get(itemKey(item));
    if (last === undefined) return true;
    const everyMs = webhooksFlowing() && !waitsOnTheClock(item) ? Math.max(fallbackMs, CHECK_EVERY_MS) : CHECK_EVERY_MS;
    return now() - last >= everyMs;
  }

  /**
   * A webhook said these pull requests changed: each one waiting is read at the next check.
   * @param {number[]} numbers
   * @param {string|null} [project]  another project's name, for its repo's pull requests; none for the default project's
   * @returns {number[]}  the numbers that are waiting
   */
  function stale(numbers, project = null) {
    const items = pending().filter((p) => numbers.includes(p.number) && (p.project ?? null) === project);
    for (const item of items) checkedAt.delete(itemKey(item));
    return numbers.filter((n) => items.some((p) => p.number === n));
  }

  /** Each waiting pull request that is due. GitHub or Slack failing leaves it for its next check. Without Slack, only
   * the watched ones are read. */
  async function check() {
    for (const item of pending().filter((p) => (watched(p) || slack?.available) && due(p))) {
      checkedAt.set(itemKey(item), now());
      try {
        await checkOne(item);
      } catch (err) {
        console.warn('slack: pull request check failed', { number: item.number, message: firstLine(err) });
      }
    }
  }

  /** @returns {Set<string>}  the sessions whose pull request is still waiting to be posted */
  function waitingSessions() {
    return new Set(pending().filter((p) => !watched(p)).map((p) => p.sessionId));
  }

  // A getter: the channel is a setting, and can be set or cleared while the console runs.
  return { get available() { return Boolean(slack?.available); }, postsFor, track, renew, check, stale, waitingSessions };
}
