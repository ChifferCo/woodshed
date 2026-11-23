// `woodshed review <session id | pull request>`: the review the console's Review tab shows, on this terminal
// (reviewTui.mjs), or with --json, or with no terminal, its analysis and the diff's summary printed once.
//
// The session is one of the person's own My Woodshed sessions, as for `session connect`: a pull request (123, #123, or
// its URL) is taken to the session that opened it. A paused one is resumed first. Every call is the page's own,
// /reviews/claude-<id>/..., with this computer's token, which the console checks and carries to the session's statusd
// (console/reviewProxy.mjs forCli): never a shared session's, nor one that has seen production data. Opening a review
// that has no analysis yet starts it, as opening the tab does.
//
// A session with more than one pull request has a review of each: a pull request asked for by number or URL opens its
// own, /reviews/claude-<id>-pr<n> (session/reviewShed/host.mjs), unless it is the branch checked out, whose review is the
// checkout's, /reviews/claude-<id>.

import { runReviewTui } from './reviewTui.mjs';
import { clean, fileOrder, markdownLines, plainText, pullRequestUrl, reviewTitle, statusStrip } from './reviewView.mjs';
import { parsePullUrl, printable } from './sessions.mjs';

// A review call may take a while: opening one makes it and fetches the branch, a Re-review pulls and diffs it.
const REVIEW_CALL_MS = 125_000;
const ID_RE = /^[0-9a-f]{8}$/;

/**
 * What `woodshed review` was given: a session id, or a pull request by number or URL.
 * @returns {{id: string}|{number: number, repo: string|null}|null}
 */
export function parseReviewTarget(words) {
  const text = words.join(' ').trim();
  if (ID_RE.test(text)) return { id: text };
  const url = parsePullUrl(text, { loose: true });
  if (url) return { number: url.number, repo: url.repo.toLowerCase() };
  const number = /^(?:pr\s*)?#?(\d{1,9})$/i.exec(text);
  if (number) return { number: Number(number[1]), repo: null };
  return null;
}

/** Every pull request a session opened, as {url, number, repo}. */
export function sessionPulls(s) {
  const urls = [...new Set([s.prUrl, ...(Array.isArray(s.prs) ? s.prs.map((p) => p?.url) : [])].filter(Boolean))];
  return urls.map((url) => {
    const pull = parsePullUrl(url, { loose: true });
    return pull ? { url, number: pull.number, repo: pull.repo.toLowerCase() } : null;
  }).filter(Boolean);
}

/**
 * The session a target names, among those listed: by id, or the newest of the sessions that opened that pull request,
 * the person's own first.
 * @returns {{session: object|null, others: object[], ambiguous?: string[]}}  `others`: sessions with that pull request that
 *   are not theirs; `ambiguous`: the repos a bare number matched more than one of
 */
export function findTarget(target, sessions, login) {
  if (target.id) return { session: sessions.find((s) => s.id === target.id) ?? null, others: [] };
  const matching = sessions.filter((s) => sessionPulls(s).some((p) => p.number === target.number && (!target.repo || p.repo === target.repo)));
  const mine = matching.filter((s) => s.owner && s.owner === login);
  // A bare number on sessions of more than one repo names no one pull request: the person says which, by its URL.
  const repos = [...new Set(mine.flatMap((s) => sessionPulls(s).filter((p) => p.number === target.number).map((p) => p.repo)))].sort();
  if (!target.repo && repos.length > 1) return { session: null, others: [], ambiguous: repos };
  const live = mine.find((s) => s.status === 'running') ?? mine.find((s) => !s.cleanedAt && s.status !== 'failed') ?? mine[0] ?? null;
  return { session: live, others: matching.filter((s) => !mine.includes(s)) };
}

/**
 * @param {{origin: string, words: string[]}} args
 * @param {{call: Function, token: string|null, say: (t: string) => void, emit: (o: object) => void, json: boolean,
 *          stdout: object, stdin: object, stderr: object, tty: boolean, color: boolean, fail: Function, EXIT: object,
 *          session?: Function, sessionCtx?: object, tui?: typeof runReviewTui}} ctx
 * @returns {Promise<number>}
 */
export async function reviewOpenCommand({ origin, words }, ctx) {
  const { call, say, emit, json, fail, EXIT } = ctx;
  const target = parseReviewTarget(words);
  if (!target) throw fail(`woodshed review takes a session id (eight letters and digits, as woodshed session list shows) or a pull request (123, #123 or its URL), or enable or status: woodshed review --help`);
  if (!ctx.token) {
    if (json) emit({ event: 'error', status: 'signed-out', error: `not signed in to ${origin}` });
    say(`Not signed in to ${origin}. Run: woodshed login --console ${origin}`);
    return EXIT.waiting;
  }
  const ended = (out) => fail(`The sign-in to ${origin} ended: ${printable(out.body?.error) ?? 'it was revoked, or it expired'}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });

  const listed = await call(origin, '/api/sessions', { token: ctx.token });
  if (listed.status === 401) throw ended(listed);
  if (listed.status >= 400 || !Array.isArray(listed.body?.sessions)) throw fail(printable(listed.body?.error) ?? `${origin} answered ${listed.status}: a console from before the command line could start sessions`);
  const login = typeof listed.body.login === 'string' ? listed.body.login : null;
  const sessions = listed.body.sessions.filter((s) => s && ID_RE.test(s.id));
  const { session: found, others, ambiguous } = findTarget(target, sessions, login);
  if (ambiguous) {
    throw fail(`Pull request #${target.number} is on more than one of your sessions' repos (${ambiguous.map((r) => printable(r, 100)).join(', ')}): give its URL, woodshed review https://github.com/<owner>/<name>/pull/${target.number}`, { code: EXIT.refused, status: 'refused' });
  }
  if (!found) {
    if (target.id) throw fail(`No session ${target.id} that you can see on ${origin}. woodshed session list shows yours.`);
    if (others.length) throw fail(`Pull request #${target.number} is ${others[0].owner ? `@${printable(others[0].owner, 60)}'s` : 'a shared'} session's, ${others[0].id}: woodshed review opens your own My Woodshed sessions only. Open ${origin}/s/${others[0].id}?tab=review`, { code: EXIT.refused, status: 'refused' });
    throw fail(`No session of yours has pull request #${target.number}. Start one on it: woodshed session new --branch ${target.number}${target.repo ? ` --repo ${target.repo}` : ''}`);
  }
  const id = found.id;
  if (!found.owner || found.owner !== login) {
    throw fail(`${id} is ${found.owner ? `@${printable(found.owner, 60)}'s` : 'a shared'} session: woodshed review opens your own My Woodshed sessions only. Open ${origin}/s/${id}?tab=review`, { code: EXIT.refused, status: 'refused' });
  }
  // A pull request named by its URL on another repo than the session's: the session reviews its own repo's pull
  // requests only, and one of the same number there is another pull request.
  if (target.number && target.repo && found.repo && String(found.repo).toLowerCase() !== target.repo) {
    throw fail(`Session ${id} is on ${printable(found.repo, 100)}, not ${printable(target.repo, 100)}: its reviews are of its own repo's pull requests. Review #${target.number} on GitHub.`, { code: EXIT.refused, status: 'refused' });
  }
  if (found.kind === 'ask') throw fail(`${id} is a question from Slack: it has no change to review.`, { code: EXIT.refused, status: 'refused' });
  if (found.taintedAt) throw fail(`Session ${id} has seen production data: nothing reads its review from this computer. Open ${origin}/s/${id}?tab=review`, { code: EXIT.refused, status: 'refused' });
  if (found.status !== 'running') {
    if (!ctx.session) throw fail(`Session ${id} is not running: resume it with woodshed session resume ${id}`);
    const resumed = await ctx.session({ origin, rest: ['resume', id] }, ctx.sessionCtx);
    if (resumed !== EXIT.done && resumed !== EXIT.waiting) return resumed;
  }

  // The review of the pull request asked for, else of the session's checkout.
  let base = target.number ? `/reviews/claude-${id}-pr${target.number}` : `/reviews/claude-${id}`;
  async function api(method, path, body) {
    const out = await call(origin, `${base}${path}`, { method, body, token: ctx.token, deadlineMs: REVIEW_CALL_MS });
    if (out.status === 401) throw Object.assign(ended(out), { ended: true });
    const data = out.body;
    if (!data || typeof data !== 'object') throw Object.assign(new Error(`${origin} answered ${out.status} with no JSON: a console from before woodshed review`), { status: out.status });
    if (out.status >= 400 || data.ok === false) {
      const message = printable(data.error, 400) ?? `${origin} answered ${out.status}`;
      // `review`: the review to open instead, when the pull request asked for is the branch checked out.
      throw Object.assign(new Error(message), { status: out.status, code: data.code ?? null, review: data.status === 'checkout' ? data.review : null });
    }
    return data;
  }

  let status;
  let diff;
  // Only the session's checkout review: a console or session image from before a review of each pull request.
  let checkoutOnly = false;
  try {
    try {
      status = await api('GET', '');
    } catch (err) {
      if (!target.number || err.ended) throw err;
      if (err.review === `claude-${id}`) {
        base = `/reviews/claude-${id}`;
      } else if (err.status === 404 && !/is not one of this session's pull requests/.test(err.message)) {
        base = `/reviews/claude-${id}`;
        checkoutOnly = true;
      } else {
        throw err;
      }
      status = await api('GET', '');
    }
    diff = await api('GET', '/diff');
  } catch (err) {
    if (err.ended) throw err;
    if (err.status === 404 && /no session of yours/.test(err.message)) throw fail(`${err.message} on ${origin}`, { code: EXIT.refused, status: 'refused' });
    if (err.status === 409 && /production data/.test(err.message)) throw fail(`Session ${id}: ${err.message}`, { code: EXIT.refused, status: 'refused' });
    if (err.status === 404 && /from before/.test(err.message)) throw fail(err.message);
    throw fail(`Session ${id}'s review: ${err.message}`);
  }

  // A pull request asked for by number or URL: the review must post to that one, whichever review answered (its own,
  // the checkout's it was sent to, or the checkout's alone on a session from before a review of each), before any of
  // its writes is offered.
  if (target.number) {
    const wanted = target.repo ?? sessionPulls(found).find((p) => p.number === target.number)?.repo ?? null;
    const dest = status.livePr ?? (status.kind === 'pr' && status.pr ? { number: status.pr, url: status.meta?.url ?? null } : null);
    const live = dest?.url ? parsePullUrl(dest.url) : null;
    const elsewhere = dest && (Number(dest.number) !== target.number || (wanted && live && live.repo.toLowerCase() !== wanted));
    if (elsewhere && checkoutOnly) {
      throw fail(`Session ${id} opened #${target.number}, but it reviews only its checkout, whose pull request is #${dest.number}${live ? ` (${live.repo})` : ''} now: it runs from before a review of each pull request. Open #${target.number} on GitHub, or start a new session.`, { code: EXIT.refused, status: 'refused' });
    }
    if (elsewhere) {
      throw fail(`Session ${id}'s review answered for #${dest.number}${live ? ` (${live.repo})` : ''}, not the #${target.number} asked for: nothing was written. Try again in a minute, or review #${target.number} on GitHub.`, { code: EXIT.refused, status: 'refused' });
    }
  }

  // The session's pull requests as the console lists them: the header links its number to one when the review's own
  // data has no address for it.
  const pulls = sessionPulls(found).map(({ number, url }) => ({ number, url }));
  if (json || !ctx.tty) return printReview({ id, origin, status, diff, pulls }, ctx);
  const tui = ctx.tui ?? runReviewTui;
  const done = await tui({ api, initial: { status, diff, session: id, pulls }, stdin: ctx.stdin, stdout: ctx.stdout, color: ctx.color });
  if (done.code === 'ended') {
    ctx.stderr.write(`woodshed: ${done.message}\n`);
    return EXIT.waiting;
  }
  return EXIT.done;
}

/** The analysis and the diff's summary, for --json or a pipe: what an agent needs to say what the change is. */
export function reviewSummary({ id, origin, status, diff, pulls = [] }) {
  const review = status.review ?? null;
  const groups = new Map();
  for (const { file, entry, group } of fileOrder({ status, diff })) {
    const title = group?.title ?? null;
    if (!groups.has(title)) groups.set(title, { title: title && clean(title), why: group?.why ? clean(group.why) : null, files: [] });
    groups.get(title).files.push({
      path: clean(file.path), status: file.status ?? 'modified', additions: file.additions ?? 0, deletions: file.deletions ?? 0,
      binary: Boolean(file.isBinary), role: entry.role ? clean(entry.role) : null, preamble: entry.preamble ? clean(entry.preamble) : null,
    });
  }
  const pr = status.livePr;
  // The session's other reviews, one per pull request it opened besides the one this is (session/reviewShed/host.mjs).
  const others = (Array.isArray(status.reviews) ? status.reviews : [])
    .filter((r) => r && typeof r.review === 'string' && r.review !== status.session && (r.checkout === true || (Number.isInteger(r.number) && r.number > 0)))
    .map((r) => {
      const number = Number.isInteger(r.number) && r.number > 0 ? r.number : null;
      return { number, checkout: r.checkout === true, url: number ? pullRequestUrl({ status, pulls }, number) ?? pulls.find((p) => p.number === number)?.url ?? null : null };
    });
  return {
    session: id,
    url: `${origin}/s/${id}?tab=review`,
    title: reviewTitle(status),
    kind: status.kind ?? null,
    branch: status.branch ? clean(status.branch) : null,
    baseRef: status.baseRef ? clean(status.baseRef) : null,
    headSha: status.headSha ?? null,
    takenAt: status.createdAt ?? null,
    otherPullRequests: others,
    pullRequest: pr ? { number: pr.number, url: pullRequestUrl({ status, pulls }, pr.number), title: clean(pr.title), state: pr.state ?? null, review: pr.review ?? null, checks: pr.checks ?? null } : null,
    analysis: {
      status: status.status ?? null,
      error: status.error ? clean(status.error) : null,
      overview: review?.overview ? clean(review.overview) : null,
      decisions: (review?.decisions ?? []).map((d) => ({ title: clean(d.title), why: clean(d.why), files: (d.files ?? []).map(clean) })),
      architecture: review?.architecture ? clean(review.architecture) : null,
    },
    diff: {
      files: (diff?.files ?? []).length,
      additions: (diff?.files ?? []).reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: (diff?.files ?? []).reduce((n, f) => n + (f.deletions ?? 0), 0),
      truncated: Boolean(diff?.truncated),
      groups: [...groups.values()],
    },
  };
}

function printReview(args, ctx) {
  const summary = reviewSummary(args);
  if (ctx.json) {
    ctx.emit({ event: 'review', review: summary });
    return ctx.EXIT.done;
  }
  const say = ctx.say;
  const columns = 100;
  const pr = summary.pullRequest;
  say(`Review: ${summary.title}${pr ? ` (#${pr.number}, ${pr.state}${pr.url ? `, ${pr.url}` : ''})` : ''}`);
  say(`Session ${summary.session}, ${summary.diff.files} file${summary.diff.files === 1 ? '' : 's'}, +${summary.diff.additions} −${summary.diff.deletions}. ${summary.url}`);
  const strip = statusStrip(args.status);
  if (strip) say(plainText(strip));
  if (summary.analysis.overview) {
    say('\nOverview');
    for (const l of markdownLines(summary.analysis.overview, columns, { indent: '  ' })) say(plainText(l));
  }
  if (summary.analysis.decisions.length) {
    say('\nDecisions');
    summary.analysis.decisions.forEach((d, i) => say(`  ${i + 1}. ${d.title}${d.why ? `: ${d.why}` : ''}`));
  }
  say('\nFiles, in reading order');
  for (const g of summary.diff.groups) {
    if (g.title) say(`  ${g.title}`);
    for (const f of g.files) say(`    ${f.path}  +${f.additions} −${f.deletions}${f.role ? `  ${f.role}` : ''}${f.status !== 'modified' ? `  ${f.status}` : ''}`);
  }
  if (summary.otherPullRequests.length) {
    say('\nThe session\'s other pull requests, each with a review of its own:');
    for (const o of summary.otherPullRequests) {
      if (o.number === null) say(`  The branch checked out, with no pull request yet: woodshed review ${summary.session}`);
      else say(`  #${o.number}${o.checkout ? ' (checked out)' : ''}: woodshed review ${o.url ?? `#${o.number}`}`);
    }
  }
  // A review of another pull request is opened by that pull request; the session's id opens its checkout's.
  const again = summary.kind === 'pr' && pr ? (pr.url ?? `#${pr.number}`) : summary.session;
  say(`\nRun woodshed review ${again} on a terminal for the whole review: the diff, the conversation and the actions.`);
  return ctx.EXIT.done;
}
