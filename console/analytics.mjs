// The Analytics page (admins only): how the team uses Woodshed, for whoever leads it. Who starts sessions and how often,
// the pull requests opened through Woodshed beside those opened without it, by each person, how long each kind takes
// from opened to merged, and the merge risk the review gave them. Lines changed are there, kept quiet: a rough size,
// never a measure of anyone's output.
//
// Sessions come from the console's own list, and from `usageKept` in state.json: a compact record of each session taken
// off the list (Remove, a deleted shared session's last day), so a cleaned-up list does not empty the page. A record holds
// no prompt, and a private session's holds no title either: My Woodshed sessions stay their owner's, so the page counts
// them and links their pull requests (which GitHub shows anyway), never what they were about. Remove My Woodshed keeps
// none of its person's.
//
// Pull requests come from GitHub: each project's repo searched for those opened in the window (github.mjs,
// recentPulls), read again in the background once it is REFRESH_MS old. One is through Woodshed when a session reported it or worked on its
// branch, and is then that session's person's, whoever GitHub says opened it (a shared session's opens as the App).

import { isAsk, isQa, isReview, prUrlsOf } from './sessions.mjs';
import { allProjects, projectFor } from './projects.mjs';

export const WINDOWS = [7, 30, 90];
const DAY_MS = 86_400_000;
// The saved read is always shown, however old. A view past this age starts a new read in the background; the page says
// what the data is as of, and has a button to read again before it.
const REFRESH_MS = 60 * 60_000;
// After a failed background refresh the last read is kept and no other starts on its own for this long.
const RETRY_MS = 60_000;
// Kept records older than this are dropped; the widest window is 90 days.
const KEEP_MS = 180 * DAY_MS;
const KEEP_MAX = 5000;
// The newest pull requests with no merge risk label whose check is asked (github.mjs, checkTiers).
const CHECK_MAX = 100;
const TIERS = ['Low', 'Medium', 'High'];
// A session that ended on one of these was not working on a branch of its own: no pull request is its by the name.
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'trunk', 'staging', 'production']);

/** Which kind of session it is, for the page's counts. */
export function sessionKind(session) {
  if (isReview(session)) return 'review';
  if (isQa(session)) return 'qa';
  if (isAsk(session)) return 'ask';
  return 'work';
}

/** Whose a session is on the page: its owner's, else whoever started it (a label, a comment, the console). */
function personOf(session) {
  const login = session.owner ?? session.startedBy ?? null;
  return login && !String(login).startsWith('slack:') ? login : null;
}

/**
 * A session as the page keeps it once it is off the list: no prompt, and a private one's title left out.
 * @param {object} session
 * @param {{name: string, repo: string}|null} project  its project (projects.mjs, projectFor): a session on the default
 *   project may name none itself
 * @returns {object}
 */
export function usageRecord(session, project = null) {
  // A session that has seen production data keeps nothing it held past it (CLAUDE.md, "Production data"): its branch,
  // which statusd reports, and its pull requests are left out with its title. It is still counted.
  const tainted = Boolean(session.taintedAt);
  return {
    id: session.id, project: session.project ?? project?.name ?? null, repo: session.repo ?? project?.repo ?? null, kind: sessionKind(session),
    login: personOf(session), private: Boolean(session.owner), agent: session.options?.agent ?? 'claude',
    createdAt: session.createdAt ?? null, title: session.owner || tainted ? null : String(session.title ?? '').slice(0, 200) || null,
    branch: tainted ? null : session.branch ?? null, prUrls: tainted ? [] : prUrlsOf(session), number: session.number ?? null,
    tier: session.review?.tier ?? null, status: session.status ?? null,
    // The models a review session ran (none named: the default, Claude), once it reported.
    // Done once it reported a verdict (a run that wrote none ran nothing to count): a queued or failed review ran nothing to count.
    reviewDone: isReview(session) ? Boolean(session.review?.reported) && session.review?.conclusion !== null : null,
    // The agents its report named, else those scheduled: one that timed out reported nothing.
    reviewAgents: isReview(session) ? (session.review?.reportedAgents?.length ? session.review.reportedAgents : session.review?.agents?.length ? session.review.agents : ['claude']) : null,
  };
}

/**
 * Keeps the usage of sessions leaving the console's list, in `state.usageKept`, dropping what is past KEEP_MS.
 * @param {object} state  store.state
 * @param {object[]} records  usageRecord of each
 * @param {number} [now]
 */
export function keepUsage(state, records, now = Date.now()) {
  const kept = (state.usageKept ?? []).filter((r) => now - Date.parse(r.createdAt) < KEEP_MS);
  const ids = new Set(kept.map((r) => r.id));
  for (const record of records) {
    const fresh = now - Date.parse(record?.createdAt) < KEEP_MS;
    if (record?.id && fresh && !ids.has(record.id)) kept.push(record);
  }
  state.usageKept = kept.slice(-KEEP_MAX);
}

/**
 * Remove My Woodshed: the person's My Woodshed sessions leave the kept records too. Shared sessions they started are
 * the team's, and stay.
 * @param {object} state  store.state
 * @param {string} login
 * @returns {number}  how many records went
 */
export function forgetUsage(state, login) {
  const before = state.usageKept?.length ?? 0;
  state.usageKept = (state.usageKept ?? []).filter((r) => !(r.private && lower(r.login) === lower(login)));
  return before - state.usageKept.length;
}

// gh's own error (`gh: HTTP 502`), which comes after the command it ran: the first line alone names the command.
function ghSaid(err) {
  const said = `${err?.stderr ?? ''}\n${err?.message ?? err}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return said.find((l) => /^gh: |HTTP \d{3}/.test(l)) ?? said.at(-1) ?? null;
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const hoursBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
const lower = (v) => String(v ?? '').toLowerCase();
const emptyPulls = () => ({ opened: 0, merged: 0, open: 0, mergeHours: [], tiers: { Low: 0, Medium: 0, High: 0 }, added: 0, removed: 0 });
const pullsView = (p) => ({
  opened: p.opened, merged: p.merged, open: p.open, medianMergeHours: median(p.mergeHours),
  tiers: p.tiers, added: p.added, removed: p.removed,
});

/**
 * The page's report, from the sessions and each project's pull requests. Pure: `build` below reads what it needs.
 * @param {{records: object[], pulls: {project: string, repo: string, pulls: object[]}[], members?: string[], days: number,
 *   now: number}} input  `records`: usageRecord of every session, live and kept; `members`: who is on People, so someone
 *   who has started nothing is on the page too
 */
export function analyticsReport({ records, pulls, members = [], days, now }) {
  const since = now - days * DAY_MS;
  const inWindow = (at) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= since && Date.parse(at) <= now;
  const people = new Map();
  const person = (login) => {
    const key = lower(login);
    if (!people.has(key)) people.set(key, { login, sessions: 0, days: new Set(), lastAt: null, agents: {}, woodshed: emptyPulls(), other: emptyPulls() });
    return people.get(key);
  };
  for (const login of members) if (login) person(login);

  // Which pull requests are Woodshed's, and whose: by the URL a session reported, else by the branch it worked on.
  const byUrl = new Map();
  const byBranch = new Map();
  // A review's tier for each pull request: the newest review's.
  const reviewTier = new Map();
  // The models Woodshed's review sessions ran on each pull request.
  const reviewModels = new Map();
  for (const r of [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    if (r.kind === 'review' && r.number) {
      const key = `${lower(r.repo)}#${r.number}`;
      if (r.tier) reviewTier.set(key, r.tier);
      const models = reviewModels.get(key) ?? new Set();
      // A record kept before `reviewDone` counts when its review gave a tier.
      if (r.reviewDone ?? Boolean(r.tier)) for (const a of r.reviewAgents ?? ['claude']) models.add(a);
      reviewModels.set(key, models);
    }
    if (r.kind !== 'work') continue;
    for (const url of r.prUrls ?? []) byUrl.set(lower(url), r);
    // Every session on the branch, oldest first (records are sorted above): a pull request is the newest one's that had
    // started when it was opened.
    if (r.branch && r.repo && !SHARED_BRANCHES.has(lower(r.branch))) {
      const key = `${lower(r.repo)}:${r.branch}`;
      byBranch.set(key, [...(byBranch.get(key) ?? []), r]);
    }
  }

  const counts = { work: 0, private: 0, shared: 0, review: 0, qa: 0, ask: 0 };
  const agents = {};
  const sessions = [];
  for (const r of records) {
    if (!inWindow(r.createdAt)) continue;
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    if (r.kind !== 'work') continue;
    counts[r.private ? 'private' : 'shared']++;
    agents[r.agent] = (agents[r.agent] ?? 0) + 1;
    sessions.push(r);
    if (!r.login) continue;
    const p = person(r.login);
    p.sessions++;
    p.days.add(new Date(r.createdAt).toISOString().slice(0, 10));
    p.agents[r.agent] = (p.agents[r.agent] ?? 0) + 1;
    if (!p.lastAt || r.createdAt > p.lastAt) p.lastAt = r.createdAt;
  }

  const totals = { woodshed: emptyPulls(), other: emptyPulls() };
  const list = [];
  for (const { project, repo, pulls: found } of pulls) {
    for (const pull of found) {
      if (!inWindow(pull.createdAt)) continue;
      // A branch is a session's only on the repo it pushed to: a fork's pull request may reuse the name.
      // And only one opened once the session had started: an older one on a common name (`patch-1`) is not its.
      const ownBranch = !pull.headRepo || lower(pull.headRepo) === lower(repo);
      const onBranch = ownBranch ? byBranch.get(`${lower(repo)}:${pull.branch}`) ?? [] : [];
      const named = onBranch.findLast((r) => Date.parse(pull.createdAt) >= Date.parse(r.createdAt)) ?? null;
      const session = byUrl.get(lower(pull.url)) ?? named ?? null;
      // A bot's own pull request (Dependabot, Renovate) is nobody's work to count, unless a session opened it.
      if (!session && pull.bot) continue;
      const via = session ? 'woodshed' : 'other';
      const login = session?.login ?? pull.author;
      const tier = pull.tier ?? reviewTier.get(`${lower(repo)}#${pull.number}`) ?? null;
      // Models: the agents of Woodshed's own reviews when there were any (they post as a bot too, so the bots are not
      // counted again), else the distinct bots that reviewed on GitHub.
      const ran = reviewModels.get(`${lower(repo)}#${pull.number}`);
      const models = ran?.size ? [...ran] : pull.botReviewers ?? [];
      // Not the session's person: on a pull request the App opened, their own review of their own change is no second pair of eyes.
      const humanReviewers = (pull.humanReviewers ?? []).filter((l) => lower(l) !== lower(login));
      const add = (p) => {
        p.opened++;
        if (pull.state === 'merged') {
          p.merged++;
          if (pull.mergedAt) p.mergeHours.push(hoursBetween(pull.createdAt, pull.mergedAt));
        }
        if (pull.state === 'open' || pull.state === 'draft') p.open++;
        if (tier) p.tiers[tier]++;
        p.added += pull.additions;
        p.removed += pull.deletions;
      };
      add(totals[via]);
      if (login) add(person(login)[via]);
      list.push({
        project, number: pull.number, url: pull.url, title: pull.title, login, via, state: pull.state, createdAt: pull.createdAt,
        mergedAt: pull.mergedAt, mergeHours: pull.mergedAt ? hoursBetween(pull.createdAt, pull.mergedAt) : null, tier,
        additions: pull.additions, deletions: pull.deletions, repo, humanReviewers, humanUnknown: Boolean(pull.reviewsPartial) && !humanReviewers.length, models, sessionId: session?.id ?? null,
        // A page to open only for a shared session still on the list: a kept one is gone, a private one its owner's.
        sessionLink: session && !session.kept && !session.private ? session.id : null,
      });
    }
  }

  // Days for a short window, else about a week each, ending now and starting where the window does.
  const buckets = days <= 14 ? days : Math.max(1, Math.round(days / 7));
  const step = (days * DAY_MS) / buckets;
  const trend = Array.from({ length: buckets }, (_, i) => ({ start: new Date(now - (buckets - i) * step).toISOString(), sessions: 0, woodshed: 0, other: 0 }));
  const bucketOf = (at) => Math.min(buckets - 1, Math.floor((Date.parse(at) - (now - buckets * step)) / step));
  for (const r of sessions) trend[bucketOf(r.createdAt)].sessions++;
  for (const p of list) if (p.mergedAt && inWindow(p.mergedAt)) trend[bucketOf(p.mergedAt)][p.via]++;

  const merged = totals.woodshed.merged + totals.other.merged;
  const peopleRows = [...people.values()].map((p) => ({
    login: p.login, sessions: p.sessions, activeDays: p.days.size, lastAt: p.lastAt, agents: p.agents,
    woodshed: pullsView(p.woodshed), other: pullsView(p.other),
    share: p.woodshed.opened + p.other.opened ? p.woodshed.opened / (p.woodshed.opened + p.other.opened) : null,
  })).filter((p) => p.sessions || p.woodshed.opened || p.other.opened || members.some((m) => lower(m) === lower(p.login)))
    .sort((a, b) => b.sessions - a.sessions || (b.woodshed.opened + b.other.opened) - (a.woodshed.opened + a.other.opened) || a.login.localeCompare(b.login));

  return {
    days, since: new Date(since).toISOString(), until: new Date(now).toISOString(), step: days <= 14 ? 'day' : 'week',
    sessions: {
      ...counts, people: peopleRows.filter((p) => p.sessions).length, members: members.length, agents,
      activeMembers: peopleRows.filter((p) => p.sessions && members.some((m) => lower(m) === lower(p.login))).length,
      recent: sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({
        id: r.id, createdAt: r.createdAt, login: r.login, project: r.project, private: r.private, agent: r.agent,
        title: r.private ? null : r.title, prUrls: r.prUrls, status: r.status, kept: Boolean(r.kept),
      })),
    },
    pulls: {
      woodshed: pullsView(totals.woodshed), other: pullsView(totals.other),
      mergedShare: merged ? totals.woodshed.merged / merged : null,
      recent: list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      tiered: list.filter((p) => p.tier).length,
    },
    trend,
    people: peopleRows,
  };
}

/**
 * @param {{config: object, sessions: () => object[], state: () => object, githubFor: (project: object) => object|null,
 *   gatesOf?: (name: string) => Promise<object|null>, members?: () => string[], now?: () => number}} deps  `gatesOf`: the
 *   project file's pull request gates, whose `mergeRisk.check` tiers a pull request the review's label does not
 */
export function createAnalytics({ config, sessions, state, githubFor, gatesOf = async () => null, members = () => [], now = Date.now }) {
  // Each project's search, by project: {at, value} once read, or the read in flight. One read of the widest window serves
  // all three, since the report filters by date itself, so the first view of 7 days warms the 30 and the 90.
  const reads = new Map();

  function startRead(project, key, held) {
    const reading = (async () => {
      const gh = githubFor(project);
      if (!gh?.recentPulls) throw new Error('this console has no GitHub access for it');
      const since = new Date(now() - Math.max(...WINDOWS) * DAY_MS).toISOString().slice(0, 10);
      // Both reads name the repo the viewer was let see: the default project's client follows the default repo, which an
      // admin may change between them, and a number on another repo is another pull request.
      const found = await gh.recentPulls({ since, repo: project.repo });
      // A review that runs as a workflow posts its check and no label: those are asked apart, the newest first. A failure
      // there keeps what the labels said.
      const check = (await gatesOf(project.name).catch(() => null))?.mergeRisk?.check ?? null;
      const untiered = found.pulls.filter((p) => !p.tier).slice(0, CHECK_MAX).map((p) => p.number);
      if (!check || !untiered.length || !gh.checkTiers) return found;
      try {
        const tiers = await gh.checkTiers(untiered, check, { repo: project.repo });
        return { ...found, pulls: found.pulls.map((p) => (tiers.has(p.number) ? { ...p, tier: tiers.get(p.number) } : p)) };
      } catch (err) {
        console.warn('analytics: merge risk checks not read, the labels only', { project: project.name, asked: untiered.length, message: ghSaid(err) });
        return found;
      }
    })();
    reads.set(key, { ...held, reading });
    const done = reading.then((value) => { reads.set(key, { at: now(), value }); return value; }, (err) => {
      // A failed read keeps the last one, if any.
      if (held?.value) reads.set(key, { at: held.at, value: held.value, retryAt: now() + RETRY_MS, failed: true });
      else reads.set(key, { error: err, retryAt: now() + RETRY_MS });
      throw err;
    });
    return done;
  }

  const keyOf = (project) => `${project.name}\n${project.repo}`;
  const logRefreshFailed = (project, kept = true) => (err) => console.warn(kept ? 'analytics: refresh failed, keeping the last read' : 'analytics: first read failed', { project: project.name, message: ghSaid(err) });

  // The saved read at once, whatever its age. With none the viewer waits for the first. One past REFRESH_MS old starts a
  // new read in the background, unless one is running or just failed.
  async function projectPulls(project) {
    const key = keyOf(project);
    const held = reads.get(key);
    // With no read yet, a failure is kept for the retry interval so a poll for another repo does not repeat the search; the
    // button reads again at once.
    if (!held?.value && !held?.reading && held?.error && held.retryAt > now()) throw held.error;
    if (!held?.value) await (held?.reading ?? startRead(project, key, held));
    else if (!held.reading && now() - held.at >= REFRESH_MS && !(held.retryAt > now())) startRead(project, key, held).catch(logRefreshFailed(project));
    const read = reads.get(key);
    return { found: read.value, at: read.at, reading: Boolean(read.reading), failed: Boolean(read.failed) };
  }

  /**
   * Reads the repos again now, in the background, for the button on the page: those not already being read.
   * @param {{repos?: string[]|null, missing?: boolean}} opts  as for report; `missing`: only those with no read yet
   * @returns {number}  how many reads it started
   */
  function refresh({ repos = null, missing = false } = {}) {
    const allowed = repos ? new Set(repos.map(lower)) : null;
    let started = 0;
    for (const project of allProjects(config).filter((p) => p.repo && (!allowed || allowed.has(lower(p.repo))))) {
      const key = keyOf(project);
      const held = reads.get(key);
      if (held?.reading || (missing && held?.value)) continue;
      startRead(project, key, held).catch(logRefreshFailed(project, Boolean(held?.value)));
      started++;
    }
    return started;
  }

  /**
   * @param {{days: number, repos?: string[]|null}} opts  `days`: one of WINDOWS; `repos`: the repos the viewer may open
   *   (projectAccess.mjs, startable), so a repo they cannot reach on GitHub gives nothing to the page, not its pull
   *   requests, its sessions or a link to one; null for every repo (a console that cannot tell)
   */
  async function report({ days, repos = null }) {
    const at = now();
    const allowed = repos ? new Set(repos.map(lower)) : null;
    const visible = (repo) => !allowed || allowed.has(lower(repo));
    const projects = allProjects(config).filter((p) => p.repo && visible(p.repo));
    const failed = [];
    const reads_ = [];
    let truncated = false;
    const pulls = (await Promise.all(projects.map(async (project) => {
      try {
        const { found, ...read } = await projectPulls(project);
        reads_.push(read);
        // Newest first: a cut-off list still covers this window when its oldest pull request is older than the window.
        const oldest = found.pulls.at(-1)?.createdAt;
        truncated ||= Boolean(found.truncated && (!oldest || Date.parse(oldest) >= at - days * DAY_MS));
        return { project: project.name, repo: project.repo, pulls: found.pulls };
      } catch (err) {
        console.warn('analytics: pull requests not read', { project: project.name, message: ghSaid(err) });
        failed.push({ project: project.name, repo: project.repo });
        return null;
      }
    }))).filter(Boolean);
    const live = sessions();
    const liveIds = new Set(live.map((s) => s.id));
    const urlRepo = (u) => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/i.exec(u)?.[1] ?? null;
    const records = [
      ...live.map((s) => usageRecord(s, projectFor(config, s))),
      ...(state().usageKept ?? []).filter((r) => !liveIds.has(r.id)).map((r) => ({ ...r, kept: true })),
    ].filter((r) => visible(r.repo)).map((r) => ({ ...r, prUrls: (r.prUrls ?? []).filter((u) => visible(urlRepo(u))) }));
    return {
      ...analyticsReport({ records, pulls, members: members(), days, now: at }),
      projects: projects.map((p) => p.name), failed, truncated,
      // What the pull request data is as of (the oldest repo's read), whether a read is running now, and whether the last
      // background read failed, so the page can say so and offer to read again.
      asOf: reads_.length ? new Date(Math.min(...reads_.map((r) => r.at))).toISOString() : null,
      refreshing: reads_.some((r) => r.reading), refreshFailed: reads_.some((r) => r.failed),
    };
  }

  return { report, refresh };
}
