// The decision brief for a shared session's pull request: what was decided, what was proven, what was not, and what
// is risky, so whoever merges it can decide in minutes. Every signal is quoted from what others posted on GitHub, as
// the repo's project file names them (`pullRequests`, docs/reference.md, "The project file"): the merge risk check and the risk
// areas from the review's workflow, the QA check and its comment, and the PR body's own sections. Nothing here works
// out a tier, a QA result or a risk area itself: a signal that is missing, or not configured, is said to be.

import { reviewSummaryOf } from './pullGates.mjs';
import { plainText } from './slack.mjs';

export const BRIEF_HEADING = '## 🧭 Decision brief';
// The review's own (review.yml) lists what merging accepts and what is untested; a repo whose review is its own may
// still write the one list it had before.
const ACCEPT_HEADING = '**What you accept by merging**';
const UNTESTED_HEADING = '**Not tested: check before merging**';
const RISK_HEADING = '**Risk areas to eyeball manually**';
const NOTHING_RISKY = /^(No breaking or hard-to-undo changes|None)\.?$/i;
// A workflow posts its checks with its GITHUB_TOKEN, so they come from GitHub Actions' app. Any workflow can post a
// check with these names; one from another app (a session's own token, say) is not the review's or QA's. A QA check
// may also come from the console's own App, which posts a QA session's: sessions' tokens cannot post checks.
const TRUSTED_CHECK_APP = 'github-actions';
const qaPostedBy = (slug, ownApp) => slug === TRUSTED_CHECK_APP || (Boolean(ownApp?.slug) && slug === ownApp.slug);
const SLACK_ITEM_CHARS = 160;
// A safety net only: a headline is a bold lead or one sentence, and is shown whole.
const HEADLINE_CHARS = 300;
// One or more code spans, joined by `with`, `and` or commas, then a colon: the references a review item opens with.
const LEADING_REFS = /^(?:`[^`]+`(?:\s*(?:,|and|with|\+)\s*)?)+:\s*/;
const CHECKS_NAMED = 5;
const PASSING = new Set(['success', 'neutral', 'skipped']);

const runIdIn = (text) => /\/actions\/runs\/(\d+)/.exec(text ?? '')?.[1] ?? null;

/**
 * GitHub points a check posted with GITHUB_TOKEN's `details_url` at the check itself, so the workflow run is the one
 * the summary's last line links: `Set by the AI review ([run](…/actions/runs/<id>))`.
 * @returns {string|null}
 */
function reviewRunIdOf(check) {
  const signed = /Set by the AI review \(\[run\]\(([^)\s]+)\)\)/.exec(check.output?.summary ?? '')?.[1];
  return runIdIn(check.details_url) ?? runIdIn(signed);
}

/**
 * Merge risk checks worth asking GitHub about: from GitHub Actions, on the head commit, linking a workflow run.
 * @param {object[]} runs  the head commit's latest check runs
 * @param {string} sha  the pull request's head
 * @param {string|null} check  the project file's `pullRequests.mergeRisk.check`; null when there is none
 * @returns {string[]}  the workflow run ids they link
 */
export function mergeRiskRunIds(runs, sha, check) {
  if (!check) return [];
  return [...new Set((runs ?? []).filter((r) => r.name === check && r.app?.slug === TRUSTED_CHECK_APP && r.head_sha === sha)
    .map(reviewRunIdOf).filter(Boolean))];
}

/**
 * The review's tier, as its workflow posts it: `Low|Medium|High: <reason>`. Any workflow can post a check by that name
 * with GitHub Actions' token, so only one on the head commit whose `details_url` is a run GitHub says is the review's
 * workflow on that commit counts; a tier from an older commit does not.
 * @param {object[]} runs
 * @param {{sha: string, reviewRuns: Set<string>, check: string|null}} trust  `reviewRuns` are the ids of
 *   `mergeRiskRunIds` GitHub confirmed as the review workflow's runs; `check` the check's name, null when there is none
 * @returns {{title: string, tier: 'Low'|'Medium'|'High'|null, summary: string, url: string|null}
 *   |{missing: 'not configured'|'not posted'|'not posted by the AI review', apps: string[]}}
 */
export function mergeRiskFrom(runs, { sha, reviewRuns, check }) {
  if (!check) return { missing: 'not configured', apps: [] };
  const named = (runs ?? []).filter((r) => r.name === check);
  const trusted = named.find((r) => r.app?.slug === TRUSTED_CHECK_APP && r.head_sha === sha && r.status === 'completed'
    && reviewRuns.has(reviewRunIdOf(r)));
  if (!trusted) {
    return { missing: named.length ? 'not posted by the AI review' : 'not posted', apps: named.map((r) => r.app?.slug ?? 'unknown') };
  }
  const title = trusted.output?.title ?? '';
  return {
    title, tier: /^(Low|Medium|High):/.exec(title)?.[1] ?? null, summary: trusted.output?.summary ?? '', url: trusted.html_url ?? trusted.details_url ?? null,
  };
}

/**
 * The QA workflow posts its check once it has a verdict, or a neutral one when it skips. A check whose title starts
 * with `Waiting`, such as one posted before the review approved, is not a result.
 * @param {object[]} runs
 * @param {{check: string}|null} qa  the project file's `pullRequests.qa`
 * @param {{slug: string}|null} [ownApp]  the console's own App, which posts a QA session's check
 * @returns {{finished: boolean, check: object|null}}
 */
export function qaCheckFrom(runs, qa, ownApp = null) {
  if (!qa) return { finished: false, check: null };
  const trusted = (runs ?? []).find((r) => r.name === qa.check && qaPostedBy(r.app?.slug, ownApp)) ?? null;
  const finished = Boolean(trusted) && trusted.status === 'completed' && !/^Waiting\b/.test(trusted.output?.title ?? '');
  return { finished, check: finished ? trusted : null };
}

/**
 * @param {string} body  the QA comment: `## TC-n: <title> <mark>` and `## EC-n: …` headings, and an `**Untested:**` item
 * @returns {{cases: {title: string, mark: string}[], edges: {title: string, mark: string}[], untested: string|null}}
 */
export function qaReportFrom(body) {
  const lines = String(body ?? '').split('\n');
  const headed = (prefix) => lines.map((l) => new RegExp(`^## ${prefix}-\\d+:\\s*(.*?)\\s*(✅|❌|❓|⚠️)\\s*$`).exec(l))
    .filter(Boolean).map((m) => ({ title: m[1], mark: m[2] }));
  const untested = lines.map((l) => /^\s*[-*]\s*\*\*Untested:\*\*\s*(.+)$/.exec(l)?.[1]).find(Boolean) ?? null;
  return { cases: headed('TC'), edges: headed('EC'), untested: untested?.trim() ?? null };
}

/**
 * Only the QA workflow's author is trusted, never the console's own App: sessions comment as that App too, so a
 * session could post a QA report of its own. A QA session's report reaches the brief through the console's check.
 * @param {object[]} comments
 * @param {{author: string, heading: string}} qa  the project file's `pullRequests.qa`
 * @returns {object|null}  the latest QA comment
 */
export function qaCommentIn(comments, qa) {
  return (comments ?? []).filter((c) => c.user?.login === qa.author && (c.body ?? '').startsWith(qa.heading)).at(-1) ?? null;
}

/**
 * The review lists its risk areas at the top of its PR comment, before the review folded under its heading: what
 * merging accepts, then what is untested, which the brief quotes as `Not tested: …`. The list may be in an alert, a
 * blockquote.
 * The comment of the run that approved is preferred: the review links that run, and so does the comment.
 * @param {{comments: object[], review: object|null, gate: {heading: string, commentAuthor: string|null}|null}} args
 *   `gate` is the project file's `pullRequests.review`
 * @returns {{found: boolean, items: string[]}}  `found` is false when there is no review comment to read them from
 */
export function riskAreasFrom({ comments, review, gate }) {
  if (!gate?.commentAuthor) return { found: false, items: [] };
  const summary = reviewSummaryOf(gate);
  const reviews = (comments ?? []).filter((c) => c.user?.login === gate.commentAuthor && (c.body ?? '').includes(summary));
  const runId = runIdIn(review?.body);
  // Else the one edited last: each run edits the same comment, which may sit above older ones from before it did.
  const latest = reviews.reduce((a, c) => (!a || (c.updated_at ?? '') >= (a.updated_at ?? '') ? c : a), null);
  const comment = (runId && reviews.find((c) => runIdIn(c.body) === runId)) || latest;
  if (!comment) return { found: false, items: [] };
  // The folded review starts at the first `<details>` outside the alert: the alert's own items fold too, in its quote.
  const lines = comment.body.replace(/\r\n/g, '\n').split('\n');
  const fold = lines.findIndex((l) => l.startsWith('<details>'));
  const top = (fold < 0 ? lines : lines.slice(0, fold)).map((l) => l.replace(/^>\s?/, '')).join('\n');
  const accepted = [...listUnder(top, ACCEPT_HEADING), ...listUnder(top, RISK_HEADING)];
  const untested = listUnder(top, UNTESTED_HEADING).map((i) => `Not tested: ${i}`);
  const items = [...accepted, ...untested];
  // A box or a list that gave no item is one whose headings the reviewer wrote differently: never shown as no risks.
  const headed = [ACCEPT_HEADING, UNTESTED_HEADING, RISK_HEADING].some((h) => top.includes(h));
  const unreadable = !items.length && (listsSomething(top) || (!headed && top.includes('**Merge risk:')));
  if (unreadable) console.warn('decisionBrief: the review comment\'s risks could not be read', { commentId: comment.id ?? null });
  return { found: true, items, ...(unreadable ? { unreadable: true } : {}) };
}

// Whether text has a fold or a bullet that is not a "None".
function listsSomething(text) {
  return text.split('\n').some((l) => /^<details>/.test(l) || (/^[-*]\s+\S/.test(l) && !NOTHING_RISKY.test(l.replace(/^[-*]\s+/, '').trim())));
}

// The items under one of the review's headings: each folded item's one line, or else the bullets.
function listUnder(text, heading) {
  const at = text.indexOf(heading);
  if (at < 0) return [];
  const rest = text.slice(at + heading.length);
  // Up to the next of the review's own headings: an item's body may have bold lines of its own.
  const ends = [ACCEPT_HEADING, UNTESTED_HEADING, RISK_HEADING].map((h) => rest.indexOf(h)).filter((i) => i >= 0);
  const next = ends.length ? Math.min(...ends) : -1;
  const section = next < 0 ? rest : rest.slice(0, next);
  // Only a fold that starts its line: a diff quoted in an item's body has a `+`, `-` or space first.
  const folded = [...section.matchAll(/^<details>\s*<summary>([\s\S]*?)<\/summary>/gm)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  return (folded.length ? folded : bulletsOf(section)).filter((i) => i && !NOTHING_RISKY.test(i));
}

/** Top-level `- `, `* ` or `1. ` items, each with its continuation lines. */
function bulletsOf(text) {
  const items = [];
  for (const line of String(text).split('\n')) {
    const item = /^[-*]\s+(.*)$|^\d+[.)]\s+(.*)$/.exec(line);
    if (item) items.push((item[1] ?? item[2]).trim());
    else if (line.trim() && /^\s/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.filter(Boolean);
}

/** @returns {string|null}  what is under the body's `## <name>` heading, up to the next heading of that level or higher */
export function sectionOf(body, name) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${name}\\s*$`, 'i').test(l));
  if (at < 0) return null;
  const level = /^#+/.exec(lines[at])[0].length;
  const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l) && /^#+/.exec(l)[0].length <= level);
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** @returns {string[]}  the body's `## Decisions`, one item each */
export function decisionsFrom(body) {
  const section = sectionOf(body, 'Decisions');
  if (!section) return [];
  const bullets = bulletsOf(section);
  return bullets.length ? bullets : section.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** @returns {string|null}  the session's own `Risk: …` line in the PR body */
export function riskLineFrom(body) {
  for (const line of String(body ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s+)?\**Risk\**\s*:\s*\**\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// A decision touches a risk area when both name the same file or code span.
function touches(decision, riskAreas) {
  const names = new Set(riskAreas.flatMap((r) => [...r.matchAll(/`([^`]+)`|([\w./-]+\.[a-z]{2,4})\b/g)])
    .map((m) => (m[1] ?? m[2]).split(':')[0].split('/').pop()).filter((n) => n && n.length > 2));
  return [...names].some((n) => decision.includes(n));
}

/** Failing or still running checks, other than the merge risk and QA ones this brief quotes on their own. */
function notGreen(runs, gates) {
  const quoted = [gates?.mergeRisk?.check, gates?.qa?.check].filter(Boolean);
  return (runs ?? []).filter((r) => !quoted.includes(r.name))
    .filter((r) => r.status !== 'completed' || !PASSING.has(r.conclusion));
}

/** Plain text for Slack: one line, no Slack link or mention, no emphasis that a cut could leave open. */
function forSlack(text, chars = SLACK_ITEM_CHARS) {
  let one = String(text).replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
  if (one.length > chars) one = `${one.slice(0, chars - 1).trimEnd()}…`;
  if ((one.match(/`/g) ?? []).length % 2) one = one.replace(/`/g, '');
  return plainText(one);
}

// GitHub would notify anyone `@named` in a quote, and another bot reacts to its own name: a zero-width space stops both.
const forGithub = (text) => String(text).replace(/@/g, '@​');

/**
 * An item's headline for Slack: its bold lead when it has one, else its first sentence, whole. File references the
 * item opens with (`path:line` with `path:line`: …) go: they are what makes it hard to read in Slack, and the comment
 * keeps them.
 */
function headline(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  const bold = /^\*\*(.+?)\*\*/.exec(one)?.[1];
  if (bold) return forSlack(bold.replace(/[.:]$/, ''), HEADLINE_CHARS);
  const rest = one.replace(LEADING_REFS, '');
  const sentence = (/^(.+?[.!?])(?:\s|$)/.exec(rest)?.[1] ?? rest).replace(/[.:]$/, '');
  return forSlack(sentence, HEADLINE_CHARS);
}

/** A labelled list, every item's headline on a line of its own; on the label's line when there is nothing to list,
 * or left out when `empty` is null. */
function bulleted(label, items, empty) {
  if (!items.length) return empty === null ? null : `**${label}:** ${empty}`;
  const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  return [`**${label}**`, ...items.map((i) => `• ${capital(headline(i))}`)].join('\n');
}

/**
 * @param {{check: object|null, report: ReturnType<typeof qaReportFrom>|null, notRun: string|null}} qa
 * @returns {string}  the check's own verdict, in its own numbers
 */
function qaLine({ check, report, notRun }) {
  if (!check) return `not run (${notRun})`;
  const title = check.output?.title ?? '';
  const pass = /^Pass: (\d+) test cases? passed/.exec(title);
  const fail = /^Fail: (\d+) of (\d+)/.exec(title);
  const covered = /^Not covered: (.*)$/.exec(title);
  const head = pass ? `✅ ${pass[1]}/${pass[1]} passed`
    : fail ? `❌ ${fail[1]} of ${fail[2]} failed`
      : covered ? `not covered: ${forSlack(covered[1])}`
        : `${forSlack(check.conclusion ?? 'unknown')}: ${forSlack(title)}`;
  const untested = report?.untested && !/^nothing\b/i.test(report.untested) ? ` · not covered: ${headline(report.untested)}` : '';
  return head + untested;
}

/** What the gates were, in words, for the brief's own lines: only names the project file gave. */
function gateWords(gates) {
  const suites = (gates?.suites ?? []).map((s) => `the ${s.name}`);
  const checks = [gates?.mergeRisk?.check, gates?.qa?.check].filter(Boolean);
  const sources = [gates?.review ? 'the AI review' : null, checks.length ? `the ${checks.join(' and ')} ${checks.length > 1 ? 'checks' : 'check'}` : null].filter(Boolean);
  return {
    // Null with no `mergeRisk`: the brief then has no merge risk section at all.
    riskCheck: gates?.mergeRisk?.check ?? null,
    green: `${gates?.review ? 'Approved by the AI review, with ' : 'With '}${suites.length ? `${suites.join(', ')} and ` : ''}every other check green.`,
    notGreen: [gates?.review ? 'the review' : null, ...suites].filter(Boolean).join(' or '),
    sources: `${sources.join(', ')}${sources.length ? ' and ' : ''}the PR body`,
    riskAreas: gates?.review?.commentAuthor ? null : 'not configured',
  };
}

/**
 * @param {{pull: object, review: object|null, runs: object[], comments: object[], suites: {name: string, outcome: string}[],
 *          qa: {finished: boolean, check: object|null, notRun: string|null}, gates: object|null, reviewRuns?: Set<string>,
 *          commentUrl?: string|null, ownApp?: {slug: string, login: string}|null}} args
 *   `suites` are each suite's outcome; `qa.notRun` says why there is no QA check: no label, not configured, or it did
 *   not finish in time; `gates` is the project file's `pullRequests`; `reviewRuns` as for `mergeRiskFrom`
 * @returns {{slack: string, tier: 'Low'|'Medium'|'High'|null, comment: string, canMerge: boolean, facts: object}}
 *   `slack` is the thread reply; `tier` is the trusted merge risk's, null without one
 */
export function buildBrief({ pull, review, runs, comments, suites, qa, gates, reviewRuns = new Set(), commentUrl = null, ownApp = null }) {
  const words = gateWords(gates);
  const mergeRisk = mergeRiskFrom(runs, { sha: pull.head?.sha, reviewRuns, check: gates?.mergeRisk?.check ?? null });
  const qaComment = qa.check && gates?.qa ? qaCommentIn(comments, gates.qa) : null;
  const report = qaComment ? qaReportFrom(qaComment.body) : null;
  const risk = riskAreasFrom({ comments, review, gate: gates?.review ?? null });
  const decisions = decisionsFrom(pull.body);
  const ranked = [...decisions.filter((d) => touches(d, risk.items)), ...decisions.filter((d) => !touches(d, risk.items))];
  const pending = notGreen(runs, gates);
  const approved = !gates?.review || review?.state === 'APPROVED';
  const green = approved && suites.every((s) => s.outcome === 'green') && !pending.length;
  const canMerge = mergeRisk.tier === 'Low' && qa.check?.conclusion === 'success' && green;
  const riskLine = riskLineFrom(pull.body);
  const facts = {
    mergeRisk: mergeRisk.tier ?? mergeRisk.missing ?? 'untiered', qa: qa.check?.conclusion ?? 'not run', riskAreas: risk.items.length,
    decisions: decisions.length, notGreen: pending.length, canMerge,
  };

  const ask = canMerge ? 'Can be merged without further review!' : ranked.length ? 'Please confirm before merging' : 'Please look before merging';
  const riskMissing = words.riskAreas ? 'the review comment is not configured' : 'the AI review comment was not found';
  // The verdict comes first, as it is what the reader came for; the tier is on the post above the thread.
  const sections = [
    `👉 **${ask}**`,
    mergeRisk.title || !words.riskCheck ? null
      : `**Self-assessed risk** (no ${words.riskCheck} check): ${riskLine ? forSlack(riskLine, 120) : 'the PR body has no Risk line'}`,
    bulleted('Decisions', ranked, null),
    bulleted('Risks', risk.items, risk.unreadable ? 'could not be read, see the review comment' : risk.found ? 'none listed' : riskMissing),
    `QA ${qaLine({ check: qa.check, report, notRun: qa.notRun })}${commentUrl ? ` · [Full brief →](${commentUrl})` : ''}`,
  ].filter(Boolean);
  // A blank line between sections, so each reads on its own.
  const slack = sections.join('\n\n');

  const comment = briefComment({ pull, mergeRisk, riskLine, qa, qaComment, report, risk, ranked, pending, green, canMerge, words });
  return { slack, tier: mergeRisk.tier ?? null, comment, canMerge, facts };
}

function riskAreasText({ risk, words, list }) {
  if (words.riskAreas) return 'No review comment is configured to quote risk areas from.';
  if (risk.unreadable) return 'The AI review comment lists risks this brief could not read: see the review comment.';
  return risk.found ? list(risk.items, 'None listed by the AI review.') : 'The AI review comment was not found, so its risk areas are unknown.';
}

function checksText({ green, pending, words }) {
  if (green) return words.green;
  if (!pending.length) return words.notGreen ? `Not all green: ${words.notGreen}.` : 'Not all green.';
  return `Not all green: ${pending.length} ${pending.length === 1 ? 'check' : 'checks'}, such as `
    + `${pending.slice(0, CHECKS_NAMED).map((r) => `\`${r.name}\` ${r.status === 'completed' ? r.conclusion : r.status}`).join(', ')}.`;
}

function briefComment({ pull, mergeRisk, riskLine, qa, qaComment, report, risk, ranked, pending, green, canMerge, words }) {
  const short = String(pull.head?.sha ?? '').slice(0, 7);
  const list = (items, empty) => (items.length ? items.map((i) => `- ${forGithub(i)}`).join('\n') : empty);
  const marked = (items) => items.map((i) => `- ${i.mark} ${forGithub(i.title)}`).join('\n');
  const proof = sectionOf(pull.body, 'Proof');
  const others = mergeRisk.apps?.length
    ? ` A \`${words.riskCheck}\` check from ${mergeRisk.apps.map((a) => `\`${a}\``).join(', ')} was ignored: only the AI review's run on this commit counts.` : '';
  return [
    BRIEF_HEADING,
    '',
    `For \`${short}\`. ${canMerge ? '**Can be merged without further review!**' : ranked.length ? '**Please confirm the decisions below before merging.**' : '**Please look before merging.**'} `
      + 'This is only a suggestion: nothing merges by itself.',
    '',
    ...(words.riskCheck ? [
      '### Merge risk',
      mergeRisk.title
        ? `**${forGithub(mergeRisk.title)}**${mergeRisk.url ? ` ([check](${mergeRisk.url}))` : ''}\n\n${forGithub(mergeRisk.summary)}`
        : `${words.riskCheck} not posted.${others} `
          + `Self-assessed by the session: ${riskLine ? `“${forGithub(riskLine)}”` : 'the PR body has no Risk line.'}`,
      '',
    ] : []),
    '### Decisions to confirm',
    list(ranked, 'None listed under `## Decisions` in the PR body.'),
    '',
    '### Proof',
    proof ? `See [## Proof](${pull.html_url}#proof) in the PR body.` : 'The PR body has no `## Proof` section.',
    '',
    '### QA',
    qa.check
      ? [
        `**${forGithub(qa.check.output?.title ?? qa.check.conclusion)}**${qa.check.html_url ? ` ([check](${qa.check.html_url}))` : ''}`
          + `${qaComment?.html_url ? ` · [QA comment](${qaComment.html_url})` : ''}`,
        report?.cases.length ? `\nCovered:\n${marked(report.cases)}` : '',
        report?.edges.length ? `\nEdge cases tried:\n${marked(report.edges)}` : '',
        `\nNot covered: ${report?.untested ? forGithub(report.untested) : 'the QA comment does not say.'}`,
      ].filter(Boolean).join('\n')
      : `QA not run: ${qa.notRun}.`,
    '',
    '### Risk areas',
    riskAreasText({ risk, words, list }),
    '',
    '### Checks',
    checksText({ green, pending, words }),
    '',
    `<sub>Quoted from ${words.sources} by Woodshed, which works out none of it. Kept up to date in place.</sub>`,
  ].join('\n');
}

/** @returns {object|null}  the brief this console already left on the pull request */
export function briefCommentIn(comments) {
  return (comments ?? []).find((c) => c.user?.type === 'Bot' && (c.body ?? '').startsWith(BRIEF_HEADING)) ?? null;
}
