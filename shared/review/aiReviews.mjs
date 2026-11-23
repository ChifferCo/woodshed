// The AI reviews on a pull request: the verdicts Woodshed's review session posts (console/fleet.mjs, submitReview) and
// the Actions review that shares its prompt, read back out of GitHub's reviews into something the page and the terminal
// can draw: who reviewed (Claude Code, Codex or both), the verdict, each reviewer's part, and each finding on its line.
//
// Nothing here is new data. The review's verdict is a GitHub review whose body opens `## <name> review — <CONCLUSION>`
// (reviewHeading in console/reviewSessions.mjs; a project file may name another heading), written by an App. When both
// reviewed, the body has a `### Claude Code: <CONCLUSION>` and a `### Codex: <CONCLUSION>` section, and each inline
// comment opens `**Claude Code:**` or `**Codex:**` (mergeVerdicts in shared/codeReview/codeReview.mjs). When GitHub
// refused the inline comments, they are folded into the body under `**Inline comments**`, one `` - `path:line`: body ``
// a line (withFoldedComments in console/fleet.mjs). A review by a person, or a body shaped otherwise, is not an AI review.
//
// Pure: GraphQL nodes in, plain objects out.

const CONCLUSIONS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
const HEADING_RE = /^##[ \t]+(.{1,120}?)[ \t]+[—–-][ \t]+(APPROVE|REQUEST_CHANGES|COMMENT)\b/;
const SECTION_RE = /^###[ \t]+(Claude Code|Codex):[ \t]+(APPROVE|REQUEST_CHANGES|COMMENT)[ \t]*$/;
const MARK_RE = /^\*\*(Claude Code|Codex):\*\*[ \t]*/;
const FOLDED_HEAD = '**Inline comments**';
const FOLDED_RE = /^- `([^`\n]+):([0-9]{1,7})`: (.*)$/;

/** Whether a GitHub author is an App: a review by a person is never read as an AI review, whatever it says. */
export function isBotAuthor(author) {
  if (!author) return false;
  const login = String(author.login || '');
  return author.__typename === 'Bot' || /\[bot\]$/.test(login) || login === 'github-actions';
}

/** The reviewers a heading names: `Claude review` is Claude Code's, `Claude Code and Codex review` both. */
export function agentsOfHeading(name) {
  const agents = [];
  if (/claude/i.test(name)) agents.push('Claude Code');
  if (/codex/i.test(name)) agents.push('Codex');
  return agents;
}

/**
 * One review's body, read: its heading, its conclusion, each reviewer's part, and the findings folded into it.
 * @returns {{heading: string, conclusion: string, agents: string[], parts: {agent: string|null, conclusion: string, body: string}[],
 *   folded: {agent: string|null, path: string, line: number, body: string}[]} | null}  null when it is not an AI review's body
 */
export function parseAiReviewBody(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const head = HEADING_RE.exec(lines[0].trim());
  if (!head || !/review/i.test(head[1])) return null;
  const heading = head[1].trim();
  const conclusion = head[2];
  const agents = agentsOfHeading(heading);
  const only = agents.length === 1 ? agents[0] : null;
  let rest = lines.slice(1);

  const folded = [];
  const foldAt = rest.findIndex((l) => l.trim() === FOLDED_HEAD);
  if (foldAt >= 0) {
    for (const l of rest.slice(foldAt + 1)) {
      const m = FOLDED_RE.exec(l.trim());
      if (!m) continue;
      const mark = MARK_RE.exec(m[3]);
      folded.push({ agent: mark ? mark[1] : only, path: m[1], line: Number(m[2]), body: m[3].slice(mark ? mark[0].length : 0).trim() });
    }
    rest = rest.slice(0, foldAt);
  }

  const parts = [];
  let at = { agent: only, conclusion, lines: [] };
  for (const l of rest) {
    const section = SECTION_RE.exec(l.trim());
    if (section) {
      if (at.lines.join('\n').trim() || parts.length) parts.push(at);
      at = { agent: section[1], conclusion: section[2], lines: [] };
      continue;
    }
    at.lines.push(l);
  }
  parts.push(at);
  return {
    heading, conclusion,
    // A section names a reviewer the heading may not (a project's own heading): those count too.
    agents: [...new Set([...agents, ...parts.map((p) => p.agent).filter(Boolean)])],
    parts: parts.map((p) => ({ agent: p.agent, conclusion: p.conclusion, body: p.lines.join('\n').trim() })).filter((p) => p.body || p.agent),
    folded,
  };
}

/**
 * The AI reviews among a pull request's reviews, newest first, each with its findings: the inline comments it posted
 * (with the replies on their threads), or the ones folded into its body.
 *
 * @param {{verdicts: object[], threads: object[], headSha: string|null}} nodes  GraphQL's `reviews` and `reviewThreads`
 *   nodes, as fetchReviewState reads them, and the pull request's head
 * @returns {object[]}
 */
export function aiReviewsOf({ verdicts = [], threads = [], headSha = null }) {
  const out = [];
  for (const v of verdicts) {
    if (!v || v.isMinimized || !isBotAuthor(v.author)) continue;
    const read = parseAiReviewBody(v.body);
    if (!read) continue;
    const only = read.agents.length === 1 ? read.agents[0] : null;
    const findings = [];
    for (const t of threads) {
      const comments = t?.comments?.nodes || [];
      const first = comments[0];
      if (!first || first.pullRequestReview?.id !== v.id) continue;
      const body = String(first.body || '');
      const mark = MARK_RE.exec(body);
      const line = t.line ?? t.originalLine ?? null;
      findings.push({
        id: first.id,
        agent: mark ? mark[1] : only,
        path: t.path,
        line: Number.isInteger(line) ? line : null,
        side: t.diffSide === 'LEFT' ? 'old' : 'new',
        body: body.slice(mark ? mark[0].length : 0).trim(),
        url: first.url || null,
        resolved: !!t.isResolved,
        outdated: !!t.isOutdated || t.line === null || t.line === undefined,
        folded: false,
        replies: comments.slice(1).map((c) => ({ author: c.author?.login || 'someone', body: String(c.body || '').trim(), url: c.url || null, at: c.createdAt || null })),
      });
    }
    read.folded.forEach((f, i) => {
      findings.push({
        id: `${v.id}:f${i + 1}`, agent: f.agent, path: f.path, line: f.line, side: 'new', body: f.body,
        url: v.url || null, resolved: false, outdated: false, folded: true, replies: [],
      });
    });
    findings.sort((a, b) => (a.path === b.path ? (a.line ?? 0) - (b.line ?? 0) : a.path < b.path ? -1 : 1));
    const commit = v.commit?.oid || null;
    out.push({
      id: v.id,
      author: v.author?.login || 'someone',
      heading: read.heading,
      conclusion: CONCLUSIONS.includes(read.conclusion) ? read.conclusion : 'COMMENT',
      state: String(v.state || '').toLowerCase(),
      agents: read.agents,
      parts: read.parts,
      findings,
      commit,
      current: Boolean(commit && headSha && commit === headSha),
      url: v.url || null,
      at: v.submittedAt || null,
    });
  }
  out.sort((a, b) => (a.at === b.at ? 0 : !a.at ? 1 : !b.at ? -1 : a.at < b.at ? 1 : -1));
  return out;
}

/**
 * What a follow-up on a finding (or on a review as a whole) tells the agent: the point, and where it is. The page and
 * the terminal send it with the question as the chat's `about`, so both say it the same way.
 */
export function aboutFinding(review, finding) {
  if (!finding) {
    const text = [`${review.heading}: ${review.conclusion}`, ...review.parts.map((p) => (p.agent ? `${p.agent} (${p.conclusion}):\n${p.body}` : p.body))].join('\n\n');
    return { id: review.id, label: `${review.heading}, ${review.conclusion}`, text };
  }
  const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
  return { id: finding.id, label: `${finding.agent ? `${finding.agent} on ` : ''}${where}`, text: finding.body };
}
