// What `woodshed review <id>` draws (reviewTui.mjs): the shed's review page (shared/review/page.mjs) as lines of a
// terminal, in the page's order. The header and its facts, the note on what was read with the analysis's state under
// it, then the tabs: Overview (the pull request's description, the overview, the decisions, the architecture), Q&A,
// Discussion (with a pull request), Files changed (one file at a time, in the analysis's reading order, with the
// conversations beside their lines), and Chat, the page's conversation panel, which a terminal has no room beside.
//
// Everything here is pure: a state in, lines out. A line is a list of segments, [style, text], and `toAnsi` makes the
// escape codes. Only the terminal's own palette is used (bold, dim, reverse and the eight basic colours, foreground
// only), so it reads on a light terminal as on a dark one; NO_COLOR keeps bold, dim and reverse and drops colour.
// Every piece of text from the session (titles, code, answers) goes through `clean`, so none of it can move the
// cursor or retitle the window. A segment may carry a third element, a link (only the header's pull request number
// does, underlined so it reads as one): `toAnsi` draws it as a terminal hyperlink (OSC 8) that takes no columns, once
// `linkUrl` passed it, and says which columns it took, for a click on them (reviewTui.mjs).

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Text from the session, made safe to draw: no control character but a newline, tabs as spaces. */
export function clean(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(CONTROL_RE, ' ');
}

// Wide characters (CJK, most emoji) take two columns; combining marks none.
function charWidth(cp) {
  if (cp === 0) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200d) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** @returns {number}  the columns `text` takes */
export function width(text) {
  let n = 0;
  for (const ch of String(text)) n += charWidth(ch.codePointAt(0));
  return n;
}

/** `text` cut to `most` columns, with an ellipsis where it was cut. */
export function cut(text, most) {
  if (most <= 0) return '';
  if (width(text) <= most) return text;
  let out = '';
  let n = 0;
  for (const ch of String(text)) {
    const w = charWidth(ch.codePointAt(0));
    if (n + w > most - 1) break;
    out += ch;
    n += w;
  }
  return `${out}…`;
}

// An address in a hyperlink is printable ASCII only (no control character, space or escape that could end the
// sequence early), https, with no user name or password in it.
const LINK_RE = /^[\x21-\x7e]{1,2000}$/;

/** `url` when it may go into a terminal hyperlink, else null. */
export function linkUrl(url) {
  if (typeof url !== 'string' || !LINK_RE.test(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return url;
}

/**
 * `url` when the review may open it in a browser itself (the o key, a click): a pull request's page on github.com,
 * as `linkUrl` passed it. Anything else is left to the terminal, or not opened.
 */
export function githubPullUrl(url) {
  const ok = linkUrl(url);
  if (!ok) return null;
  const u = new URL(ok);
  if (u.origin !== 'https://github.com' || u.search || u.hash) return null;
  return /^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d{0,8}\/?$/.test(u.pathname) ? ok : null;
}

/** `text` as a terminal hyperlink to `url` (OSC 8): terminals that do not know it draw `text` alone. */
export function hyperlink(url, text) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** The text a terminal shows of a line `toAnsi` made: no SGR code and no hyperlink's address. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\]8;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const STYLES = {
  bold: '1', dim: '2', under: '4', rev: '7',
  red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36',
};
const COLOURS = new Set(['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']);

/**
 * One line's segments as text with escape codes, cut to `columns`. `fill` reverses the whole width (a cursor). A
 * segment's link is measured as its text alone, and is cut with it: the sequence is opened and closed around what is
 * drawn, never split. Each link drawn is pushed onto `links` as {from, to, url}: the columns it takes, from 0, `to`
 * past its last.
 */
export function toAnsi(line, { columns, color = true, fill = null, links = null } = {}) {
  let out = '';
  let used = 0;
  // Neighbours in one style (and one link) are drawn as one run: wrapping splits a sentence into words.
  const runs = [];
  for (const [style, text, link] of line) {
    const last = runs[runs.length - 1];
    if (last && (last[0] ?? '') === (style ?? '') && (last[2] ?? null) === (link ?? null)) last[1] += text;
    else runs.push([style, text, link ?? null]);
  }
  for (const [style, raw, link] of runs) {
    if (used >= columns) break;
    const text = cut(raw, columns - used);
    const room = width(text);
    const codes = String(style ?? '').split(' ').filter((s) => STYLES[s] && (color || !COLOURS.has(s))).map((s) => STYLES[s]);
    if (fill) codes.push(STYLES.rev);
    const url = link && linkUrl(link);
    const shown = url && text ? hyperlink(url, text) : text;
    if (url && text && links) links.push({ from: used, to: used + room, url });
    out += codes.length ? `\x1b[${codes.join(';')}m${shown}\x1b[0m` : shown;
    used += room;
  }
  if (fill && used < columns) out += `\x1b[7m${' '.repeat(columns - used)}\x1b[0m`;
  return out;
}

/** The plain text of a line, for a test or a pipe. */
export function plainText(line) {
  return line.map(([, t]) => t).join('');
}

// --- wrapping -----------------------------------------------------------------

/**
 * Segments laid out in `columns`, words kept whole where they fit, the first line after `first` and the rest after
 * `rest` (a hanging indent).
 * @returns {Array<Array<[string|null, string]>>}
 */
export function wrapSegments(segments, columns, { first = '', rest = first, firstStyle = null, restStyle = firstStyle } = {}) {
  const lines = [];
  let line = first ? [[firstStyle, first]] : [];
  let used = width(first);
  let lead = width(first);
  const push = () => {
    lines.push(line);
    line = rest ? [[restStyle, rest]] : [];
    used = width(rest);
    lead = used;
  };
  for (const [style, text, link] of segments) {
    const seg = (piece) => (link ? [style, piece, link] : [style, piece]);
    for (const part of String(text).split('\n').flatMap((p, i) => (i ? ['\n', p] : [p]))) {
      if (part === '\n') {
        push();
        continue;
      }
      for (const word of part.split(/( +)/)) {
        if (!word) continue;
        const space = /^ +$/.test(word);
        if (space) {
          if (used > lead) {
            line.push([style, ' ']);
            used += 1;
          }
          continue;
        }
        let rest2 = word;
        while (rest2) {
          const w = width(rest2);
          if (used + w <= columns) {
            line.push(seg(rest2));
            used += w;
            break;
          }
          if (used > lead) {
            // Drop the space the word would have followed.
            if (line.length && line[line.length - 1][1] === ' ') line.pop();
            push();
            continue;
          }
          // A word longer than the line: cut where the line ends.
          let piece = '';
          let n = 0;
          for (const ch of rest2) {
            const cw = charWidth(ch.codePointAt(0));
            if (used + n + cw > columns) break;
            piece += ch;
            n += cw;
          }
          if (!piece) piece = [...rest2][0];
          line.push(seg(piece));
          rest2 = rest2.slice(piece.length);
          push();
        }
      }
    }
  }
  if (used > lead || !lines.length) lines.push(line);
  return lines;
}

/** Plain text wrapped, each line one segment in `style`. */
export function wrapText(text, columns, style = null, indent = '') {
  return wrapSegments([[style, clean(text)]], columns, { first: indent, rest: indent });
}

// --- markdown -------------------------------------------------------------------

/** A line of markdown's inline marks as segments: `code`, **bold**, [links](url). */
export function inlineSegments(text, base = null) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  let m;
  const plain = clean(text);
  while ((m = re.exec(plain))) {
    if (m.index > at) out.push([base, plain.slice(at, m.index)]);
    if (m[1] !== undefined) out.push([`${base ?? ''} cyan`.trim(), m[1]]);
    else if (m[2] !== undefined) out.push([`${base ?? ''} bold`.trim(), m[2]]);
    else out.push([`${base ?? ''} under`.trim(), m[3]]);
    at = m.index + m[0].length;
  }
  if (at < plain.length) out.push([base, plain.slice(at)]);
  return out;
}

/**
 * Markdown as the page draws it, simplified for a terminal: headings, lists, fenced code, tables and paragraphs.
 * @returns {Array<Array<[string|null, string]>>}
 */
export function markdownLines(text, columns, { indent = '' } = {}) {
  const lines = [];
  const source = clean(text).split('\n');
  let inCode = false;
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    lines.push(...wrapSegments(inlineSegments(paragraph.join(' ')), columns, { first: indent, rest: indent }));
    paragraph = [];
  };
  for (const raw of source) {
    if (/^\s*```/.test(raw)) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      lines.push([[null, indent], ['dim', cut(`  ${raw}`, Math.max(1, columns - width(indent)))]]);
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      if (lines.length && lines[lines.length - 1].length) lines.push([]);
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      lines.push(...wrapSegments(inlineSegments(heading[1], 'bold'), columns, { first: indent, rest: indent }));
      continue;
    }
    if (/^\s*\|?\s*:?-{3,}/.test(line) && line.includes('-') && /^[\s|:-]+$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const segs = [];
      cells.forEach((c, i) => {
        if (i) segs.push(['dim', ' │ ']);
        segs.push(...inlineSegments(c));
      });
      lines.push(...wrapSegments(segs, columns, { first: indent, rest: `${indent}  ` }));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const depth = Math.min(3, Math.floor(item[1].length / 2));
      const mark = /\d/.test(item[2]) ? `${item[2]} ` : '• ';
      const lead = `${indent}${'  '.repeat(depth)}`;
      lines.push(...wrapSegments(inlineSegments(item[3]), columns, { first: `${lead}${mark}`, rest: `${lead}${' '.repeat(width(mark))}` }));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      lines.push(...wrapSegments(inlineSegments(quote[1], 'dim'), columns, { first: `${indent}│ `, rest: `${indent}│ `, firstStyle: 'dim' }));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  while (lines.length && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

// --- facts ------------------------------------------------------------------------

const VERDICTS = { approved: ['green', '✓ approved'], changes: ['red', '✗ changes requested'], pending: ['yellow', '• review required'] };

/** The pull request's state, verdict and checks, as the page's header line has them (prStatusBits). */
export function prFacts(pr) {
  if (!pr) return [];
  const segs = [];
  const tone = { open: 'green', draft: 'dim', merged: 'magenta', closed: 'red', queued: 'yellow' }[pr.state] ?? null;
  segs.push([`${tone ?? ''} bold`.trim(), String(pr.state ?? 'open').replace(/^./, (c) => c.toUpperCase())]);
  const verdict = VERDICTS[pr.review === 'changes_requested' ? 'changes' : pr.review];
  if (verdict) segs.push([null, '  '], [verdict[0], verdict[1]]);
  const c = pr.checks;
  if (c && c.total) {
    segs.push([null, '  ']);
    if (c.fail) segs.push(['red', `✗ ${c.fail} of ${c.total} checks failing`]);
    else if (c.pending) segs.push(['yellow', `• ${c.pending} of ${c.total} checks running`]);
    else segs.push(['green', `✓ ${c.total} checks passing`]);
  }
  return segs;
}

/**
 * The address of pull request `number`, as the review has it (the live pull request's, else what was read at launch),
 * else the one of the session's pull requests with that number; null when none passes `linkUrl` or names that pull
 * request (a path that ends /pull/<number>).
 */
export function pullRequestUrl(state, number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return null;
  const s = state?.status ?? {};
  const pulls = (Array.isArray(state?.pulls) ? state.pulls : []).filter((p) => Number(p?.number) === n);
  const found = [
    Number(s.livePr?.number) === n ? s.livePr.url : null,
    Number(s.meta?.number) === n ? s.meta.url : null,
    pulls.length === 1 ? pulls[0].url : null,
  ];
  for (const url of found) {
    const ok = linkUrl(url);
    if (ok && new RegExp(`^/[^/]+/[^/]+/pull/${n}/?$`).test(new URL(ok).pathname)) return ok;
  }
  return null;
}

/** The title the page puts in its heading: the pull request's own, else what the shed made up for the branch. */
export function reviewTitle(status) {
  if (status?.livePr?.title) return clean(status.livePr.title);
  if (status?.meta?.title) return clean(status.meta.title);
  if (status?.kind === 'pr' && status.pr) return `PR #${status.pr}`;
  return `Work in ${clean(status?.branch ?? status?.session ?? '')}`;
}

function when(iso, nowMs) {
  const at = Date.parse(iso ?? '');
  if (!at) return 'when this review was taken';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date(nowMs).toDateString() === d.toDateString();
  return today ? `${hh}:${mm}` : `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })}, ${hh}:${mm}`;
}

/** The header: the title, the fact line, what was read and the analysis's state (renderHeader, worktreeNote, renderStatus). */
export function headerLines(state, columns, nowMs = Date.now()) {
  const s = state.status;
  const meta = s.meta ?? {};
  const lines = [];
  // The pull request's number links to it on GitHub, where the terminal makes links clickable, as the page's does.
  const title = [['bold', reviewTitle(s)]];
  // Underlined where it is a link, as the description's links are: a click on it, or o, opens it.
  const titleUrl = meta.number ? pullRequestUrl(state, meta.number) : null;
  if (meta.number) title.push(['dim', ' '], [titleUrl ? 'dim under' : 'dim', `#${meta.number}`, titleUrl]);
  lines.push(...wrapSegments(title, columns, { first: 'Review: ', firstStyle: 'dim', rest: '  ' }));
  const facts = [];
  if (meta.author?.login) facts.push([null, clean(meta.author.login)], [null, '  ']);
  if (meta.headRefName) facts.push(['cyan', clean(meta.headRefName)], ['dim', ' → '], ['cyan', clean(meta.baseRefName ?? s.baseRef ?? '')], [null, '  ']);
  if (s.livePr) {
    if (!meta.number) {
      const url = pullRequestUrl(state, s.livePr.number);
      facts.push([url ? 'bold under' : 'bold', `#${s.livePr.number}`, url], [null, ' ']);
    }
    facts.push(...prFacts(s.livePr), [null, '  ']);
  }
  const sha = String(meta.headRefOid ?? s.headSha ?? '').slice(0, 8);
  if (sha) facts.push(['dim', sha], [null, '  ']);
  facts.push(['green', `+${Number(meta.additions) || 0}`], [null, ' '], ['red', `−${Number(meta.deletions) || 0}`]);
  if (s.session) facts.push([null, '  '], ['dim', String(s.session).replace(/^claude-/, '')]);
  lines.push(...wrapSegments(facts, columns));
  // What was read, as worktreeNote and targetNote say it.
  const note = [];
  if (s.kind === 'worktree') {
    note.push(`Working tree as of ${when(s.createdAt, nowMs)}`);
    const ahead = [];
    if (meta.commits) ahead.push(`${meta.commits} commit${meta.commits === 1 ? '' : 's'}`);
    if (meta.dirtyFiles) ahead.push(`${meta.dirtyFiles} uncommitted file${meta.dirtyFiles === 1 ? '' : 's'}`);
    if (ahead.length) note.push(` — ${ahead.join(' and ')} ahead of ${clean(meta.baseRefName ?? s.baseRef ?? 'the default branch')}`);
    note.push('. It may have changed since.');
    if (s.pull?.commits) note.push(` Pulled ${s.pull.commits} new commit${s.pull.commits === 1 ? '' : 's'} from origin/${clean(s.pull.branch)} first.`);
    else if (s.pull?.refused) note.push(` Not pulled from origin: ${clean(s.pull.refused)}.`);
    if (state.draft?.headSha && s.headSha && state.draft.headSha !== s.headSha && !s.pull?.refused) {
      note.push(` The pull request's head on GitHub is ${state.draft.headSha.slice(0, 8)}, not the commit read here.`);
    }
  } else {
    note.push(`${s.kind === 'pr' ? 'This pull request' : 'This branch'}${s.createdAt ? ` as of ${when(s.createdAt, nowMs)}` : ''}${sha ? `, at ${sha}` : ''}. Anything pushed since is not in it.`);
  }
  lines.push(...wrapText(note.join(''), columns, 'dim'));
  const strip = statusStrip(s);
  if (strip) lines.push(...wrapSegments(strip, columns));
  return lines;
}

/** The analysis's state, as renderStatus says it, or null once it is ready. */
export function statusStrip(s) {
  const st = s.status;
  if (!st || st === 'ready') return null;
  if (st === 'unknown') return [['yellow', 'No analysis has been run on this diff.'], ['dim', ' The diff is complete and in git order. a runs it.']];
  if (st === 'running' || st === 'queued') {
    const p = s.progress ?? {};
    const facts = [s.waiting ? `waiting: ${clean(s.waiting)}` : st === 'queued' ? 'queued' : 'reading the code'];
    if (p.currentFile) facts.push(clean(p.currentFile));
    if (p.toolCalls) facts.push(`${p.toolCalls} file${p.toolCalls === 1 ? '' : 's'} read`);
    if (p.elapsedMs) facts.push(`${Math.round(p.elapsedMs / 1000)}s`);
    return [['yellow', `⋯ ${facts.join(' · ')}`], ['dim', '  the diff is already complete']];
  }
  const why = st === 'interrupted' ? 'The analysis was interrupted: the shed restarted while it was running.' : `The analysis failed${s.error ? `: ${clean(s.error)}` : '.'}`;
  return [['red', why], ['dim', ' a retries it.']];
}

// --- tabs ---------------------------------------------------------------------------

const NBSP = '\u00a0';

export const TABS = [
  { key: 'analysis', label: 'Overview', n: '1' },
  { key: 'qa', label: 'Q&A', n: '2' },
  { key: 'discussion', label: 'Discussion', n: '3' },
  { key: 'files', label: 'Files changed', n: '4' },
  { key: 'chat', label: 'Chat', n: '5' },
];

/** The tabs there are: Discussion only with a pull request, as the page has it. */
export function tabsOf(state) {
  return TABS.filter((t) => t.key !== 'discussion' || state.status?.livePr);
}

/**
 * The tabs, each after the number key that reaches it (`1 Overview │ 2 Q&A │ …`), and nothing on a tab is a count. A
 * tab keeps its number when Discussion is not there, so 4 is always Files changed. The bar wraps between tabs only, and
 * a line never starts with a separator; at 80 columns it is one line, a count of draft comments with it.
 */
export function tabBar(state, columns) {
  const units = tabsOf(state).map((t) => {
    // No-break spaces: the selected tab's padding is kept in its reversed block.
    const name = `${t.label.replace(/ /g, NBSP)}${NBSP}`;
    return state.tab === t.key ? [['rev bold', `${NBSP}${t.n}${NBSP}${name}`]] : [[null, NBSP], ['dim', t.n], [null, `${NBSP}${name}`]];
  });
  const drafts = state.status?.livePr ? state.draft?.comments?.length ?? 0 : 0;
  if (drafts) units.push([['yellow', `${drafts}${NBSP}draft${drafts === 1 ? '' : 's'}`]]);
  const span = (segs) => segs.reduce((n, [, text]) => n + width(text), 0);
  const lines = [[]];
  let used = 0;
  units.forEach((unit, i) => {
    const gap = i === 0 ? [] : drafts && i === units.length - 1 ? [[null, '  ']] : [['dim', '│']];
    if (used && used + span(gap) + span(unit) > columns) {
      lines.push([]);
      used = 0;
    }
    const put = used ? [...gap, ...unit] : unit;
    lines[lines.length - 1].push(...put);
    used += span(put);
  });
  return lines;
}

// --- Overview -------------------------------------------------------------------------

function sectionHead(lines, text) {
  if (lines.length) lines.push([]);
  lines.push([['bold under', text]]);
}

/** The Overview tab, as renderAnalysis orders it. */
export function analysisLines(state, columns) {
  const lines = [];
  const s = state.status;
  if (s.livePr) {
    sectionHead(lines, 'Description');
    const d = state.draft?.description;
    if (state.draftLoading) lines.push([['dim', 'Loading the description from GitHub…']]);
    else if (!d?.body) lines.push([['dim', 'No description provided.']]);
    else {
      lines.push([['bold', clean(d.author ?? 'someone')], ['dim', ' commented']]);
      lines.push(...markdownLines(d.body, columns, { indent: '  ' }));
    }
  }
  const review = s.review;
  if (review?.overview) {
    sectionHead(lines, 'Overview');
    lines.push(...markdownLines(review.overview, columns));
  }
  const decisions = [...(review?.decisions ?? []), ...(review?.questions ?? []).map((q) => ({ title: q.question, why: q.why, files: q.files }))];
  if (decisions.length) {
    sectionHead(lines, 'Decisions');
    decisions.forEach((d, i) => {
      const mark = `${i + 1}. `;
      lines.push(...wrapSegments(inlineSegments(d.title ?? '', 'bold'), columns, { first: mark, rest: ' '.repeat(mark.length) }));
      if (d.why) lines.push(...wrapSegments(inlineSegments(d.why), columns, { first: '   ', rest: '   ' }));
      const files = (d.files ?? []).filter((f) => state.diff?.files?.some((x) => x.path === f));
      if (files.length) lines.push(...wrapSegments([['cyan', files.map(clean).join(', ')]], columns, { first: '   ', rest: '   ' }));
    });
  }
  if (review?.architecture) {
    sectionHead(lines, 'Architecture');
    lines.push(...diagramLines(review.diagram, columns));
    lines.push(...markdownLines(review.architecture, columns));
  }
  if (!review?.overview) {
    if (lines.length) lines.push([]);
    lines.push([['dim', 'There is no analysis to show yet.']]);
  }
  lines.push([], [['dim', 'Read the changes: 4 Files changed lists every file; Enter opens one, i chats about it.']]);
  return lines;
}

const CHANGE = { added: ['green', '+'], removed: ['red', '−'], changed: ['yellow', '~'], unchanged: ['dim', ' '] };

/** The diagram as text: its pieces and how they connect, each marked added, removed or changed. */
export function diagramLines(diagram, columns) {
  if (!diagram?.nodes?.length) return [];
  const label = new Map(diagram.nodes.map((n) => [n.id, clean(n.label)]));
  const lines = [];
  for (const edge of diagram.edges ?? []) {
    const [tone, mark] = CHANGE[edge.change] ?? CHANGE.unchanged;
    lines.push(...wrapSegments([[tone, `${mark} `], [null, label.get(edge.from) ?? clean(edge.from)], ['dim', ' → '], [null, label.get(edge.to) ?? clean(edge.to)],
      ...(edge.label ? [['dim', `  ${clean(edge.label)}`]] : [])], columns, { rest: '    ' }));
  }
  const alone = diagram.nodes.filter((n) => !(diagram.edges ?? []).some((e) => e.from === n.id || e.to === n.id));
  for (const n of alone) {
    const [tone, mark] = CHANGE[n.change] ?? CHANGE.unchanged;
    lines.push([[tone, `${mark} `], [null, clean(n.label)]]);
  }
  lines.push([['dim', '+ added  − removed  ~ changed']], []);
  return lines;
}

// --- Q&A --------------------------------------------------------------------------------

/** The Q&A's items by parent id ('' for the top), in the order they were written. */
function qaKids(items) {
  const kids = new Map();
  for (const item of items ?? []) {
    const parent = item.parent || '';
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(item);
  }
  return kids;
}

/**
 * The questions on screen, in order: the top ones, and under each open one its follow-ups, as the page folds them.
 * `state.qa.open` is the open path, the top question first: one open at a time, with the ones above it.
 * @returns {object[]}
 */
export function qaVisible(state) {
  const items = state.qa?.data?.items ?? [];
  const kids = qaKids(items);
  const open = new Set(state.qa?.open ?? []);
  const out = [];
  const walk = (parent) => {
    for (const item of kids.get(parent) ?? []) {
      out.push(item);
      if (open.has(item.id) && item.answer) walk(item.id);
    }
  };
  walk('');
  return out;
}

/**
 * The Q&A tab, as renderQa draws it: every question folded, the one open showing its answer and its follow-ups (folded
 * too), and what a follow-up asked from a box failed with. `item` on a question's line is its place in qaVisible, for
 * the cursor; an answer's lines have none.
 * @returns {{lines: Array<Array<[string|null, string]>>, items: number[]|null, cursor: number}}
 */
export function qaLines(state, columns) {
  const qa = state.qa ?? {};
  const d = qa.data;
  const lines = [];
  const items = [];
  const add = (line, item = -1) => {
    lines.push(line);
    items.push(item);
  };
  if (qa.error) for (const l of wrapText(`Could not read the Q&A: ${qa.error}`, columns, 'red')) add(l);
  if (!d) {
    // As renderQa says it: after a Discard nothing asks again by itself, since it is a paid run (a Re-review's is the shed's).
    if (qa.error) add([['dim', 'A tries again.']]);
    else if (qa.started && !qa.loading) for (const l of wrapText('There is no Q&A for this diff yet. A asks the questions.', columns, 'dim')) add(l);
    else for (const l of wrapText('Starting the Q&A: the questions someone new to this code would ask, each answered from the code…', columns, 'dim')) add(l);
    return { lines, items: null, cursor: -1 };
  }
  const all = d.items ?? [];
  const running = d.status === 'running';
  if (running) {
    const open = all.filter((i) => !i.answer).length;
    for (const l of wrapText(d.phase === 'answering' ? `⋯ Reading the code to answer ${open} question${open === 1 ? '' : 's'}${d.depth > 1 ? ` (follow-ups, level ${d.depth})` : ''}…`
      : d.depth > 1 ? '⋯ Writing follow-up questions about the answers…' : '⋯ Writing the questions someone new to this code would ask…', columns, 'yellow')) add(l);
  } else if (d.status === 'failed') for (const l of wrapText(`The Q&A failed: ${d.error ?? 'no reason given'}`, columns, 'red')) add(l);
  else if (d.status === 'interrupted') for (const l of wrapText('The Q&A was cut off before it finished. A asks again.', columns, 'red')) add(l);
  else if (d.status === 'ready' && !all.length) for (const l of wrapText('There was nothing to ask about.', columns, 'dim')) add(l);
  const kids = qaKids(all);
  const open = new Set(qa.open ?? []);
  const visible = qaVisible(state);
  // The rows a cursor stands on: each question on screen, then, when nothing is being written, the row that asks one of
  // your own. A question is asked where the cursor is: under the question, or at the end from that last row.
  const rowsCount = visible.length + (running ? 0 : 1);
  const cursor = rowsCount ? Math.min(Math.max(0, qa.cursor ?? 0), rowsCount - 1) : -1;
  const depthOf = (item) => {
    let n = 0;
    for (let p = item.parent; p && n < 20; n += 1) p = all.find((x) => x.id === p)?.parent;
    return n;
  };
  const failedAt = (parent) => {
    const failed = d.askErrors?.[parent];
    if (!failed) return;
    for (const l of wrapText(`Not answered: ${failed.error}. Your question was: ${failed.question}`, columns, 'red', '  '.repeat(parent ? depthOf(all.find((x) => x.id === parent) ?? {}) + 1 : 0))) add(l);
  };
  if (all.length) add([]);
  visible.forEach((item, at) => {
    const pad = '  '.repeat(depthOf(item));
    const isOpen = open.has(item.id) && item.answer;
    const children = kids.get(item.id) ?? [];
    const tail = [];
    if (!item.answer) tail.push(['yellow', running || item.asking ? '  ⋯ being answered' : '  not answered']);
    else if (!isOpen && children.length) tail.push(['dim', `  ${children.length} follow-up${children.length === 1 ? '' : 's'}`]);
    if (item.mine && item.answer) tail.push(['cyan', '  you asked']);
    for (const l of wrapSegments([...inlineSegments(item.question ?? '', isOpen ? 'bold' : null), ...tail], columns, { first: `${pad}${isOpen ? '▾' : '▸'} `, rest: `${pad}  ` })) add(l, at);
    if (isOpen) {
      for (const l of markdownLines(item.answer, columns, { indent: `${pad}  ` })) add(l);
      add([]);
      failedAt(item.id);
    }
  });
  failedAt('');
  if (!running) {
    if (all.length) add([]);
    add([['cyan', '＋ Ask a question of your own']], visible.length);
  }
  return { lines, items, cursor };
}

// --- Discussion -------------------------------------------------------------------------

export function discussionLines(state, columns) {
  if (state.draftLoading) return [[['dim', 'Loading the comments from GitHub…']]];
  const said = state.draft?.said ?? [];
  if (!said.length) return [[['dim', 'Nobody has said anything about the change as a whole yet.']]];
  const lines = [];
  for (const one of said) {
    if (lines.length) lines.push([]);
    const word = one.kind === 'review' ? ({ approved: 'approved', changes_requested: 'requested changes', commented: 'reviewed' }[one.state] ?? 'reviewed') : 'commented';
    const tone = one.state === 'approved' ? 'green' : one.state === 'changes_requested' ? 'red' : 'dim';
    lines.push([['bold', clean(one.author)], [tone, ` ${word}`], ['dim', one.at ? `  ${String(one.at).slice(0, 16).replace('T', ' ')}` : '']]);
    lines.push(...markdownLines(one.body, columns, { indent: '  ' }));
  }
  if (state.draft?.truncated) lines.push([], ...wrapText('This pull request has more comments than the review reads in one go. Some are only on GitHub.', columns, 'yellow'));
  return lines;
}

// --- Files changed ------------------------------------------------------------------------

/** The files in the analysis's reading order, each once, then any it did not place in git order (groupsToRender). */
export function fileOrder(state) {
  const files = state.diff?.files ?? [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = [];
  const seen = new Set();
  for (const group of state.status?.review?.groups ?? []) {
    for (const entry of group.files ?? []) {
      const file = byPath.get(entry.path);
      if (!file || seen.has(file.path)) continue;
      seen.add(file.path);
      out.push({ file, entry, group });
    }
  }
  for (const file of files) if (!seen.has(file.path)) out.push({ file, entry: { path: file.path, preamble: '', role: '' }, group: null });
  return out;
}

/** The lines of one file's diff a cursor can stand on: each with the hunk it is in. */
export function diffRows(file) {
  const rows = [];
  for (const hunk of file?.hunks ?? []) for (const line of hunk.lines ?? []) rows.push(line);
  return rows;
}

function threadsAt(state, file, line) {
  const no = line.newNo ?? line.oldNo;
  const side = line.newNo !== null && line.newNo !== undefined ? 'new' : 'old';
  return (state.draft?.threads ?? []).filter((t) => t.path === file.path && t.line === no && t.side === side);
}

/**
 * Files changed as a list: every file, grouped in the analysis's reading order with each group's reason, and under
 * each file what it does in the change (its role and the analysis's note on it), as the page's cards show them folded.
 * `item` on a line is the file it belongs to, for the cursor; Enter opens that file's diff (fileLines).
 * @returns {{lines: Array<Array<[string|null, string]>>, items: number[], cursor: number}}
 */
export function fileListLines(state, columns) {
  const order = fileOrder(state);
  const lines = [];
  const items = [];
  const add = (line, item = -1) => {
    lines.push(line);
    items.push(item);
  };
  if (!order.length) {
    add([['dim', 'This change has no files.']]);
    return { lines, items, cursor: -1 };
  }
  const cursor = Math.min(Math.max(0, state.fileIndex ?? 0), order.length - 1);
  let group;
  order.forEach(({ file, entry, group: g }, i) => {
    if (i === 0 || g !== group) {
      if (i) add([]);
      add([['bold under', clean(g?.title ?? (order.some((x) => x.group) ? 'Everything else' : 'Files'))]]);
      if (g?.why) for (const l of wrapSegments(inlineSegments(g.why, 'dim'), columns)) add(l);
      group = g;
    }
    const threads = (state.draft?.threads ?? []).filter((t) => t.path === file.path).length;
    const head = [['bold', clean(file.path)]];
    if (entry.role) head.push(['magenta', ` ${clean(entry.role)}`]);
    if (file.status && file.status !== 'modified') head.push([file.status === 'deleted' ? 'red' : 'green', ` ${clean(file.status)}`]);
    if (file.isBinary) head.push(['dim', ' binary']);
    head.push([null, '  '], ['green', `+${file.additions ?? 0}`], [null, ' '], ['red', `−${file.deletions ?? 0}`]);
    if (threads) head.push(['yellow', `  ${threads} conversation${threads === 1 ? '' : 's'}`]);
    for (const l of wrapSegments(head, columns, { first: '▸ ', rest: '  ' })) add(l, i);
    if (entry.preamble) for (const l of wrapSegments(inlineSegments(entry.preamble), columns, { first: '  ', rest: '  ' })) add(l, i);
  });
  return { lines, items, cursor };
}

/**
 * One file of Files changed: where it sits in the reading order, the analysis's note on it, then its lines with the
 * conversations under them. `item` on a line is the diff row it draws, for the cursor.
 * @returns {{lines: Array<Array<[string|null, string]>>, items: number[]}}
 */
export function fileLines(state, columns) {
  const order = fileOrder(state);
  const lines = [];
  const items = [];
  const add = (line, item = -1) => {
    lines.push(line);
    items.push(item);
  };
  if (!order.length) {
    add([['dim', 'This change has no files.']]);
    return { lines, items, cursor: -1 };
  }
  const index = Math.min(Math.max(0, state.fileIndex ?? 0), order.length - 1);
  const { file, entry, group } = order[index];
  add([['dim', `File ${index + 1} of ${order.length} (Esc: all files)`], ...(group?.title ? [['dim', ' · '], ['bold', clean(group.title)]] : [])]);
  if (group?.why && (index === 0 || order[index - 1].group !== group)) for (const l of wrapSegments(inlineSegments(group.why, 'dim'), columns)) add(l);
  add([]);
  const chips = [];
  if (entry.role) chips.push(['magenta', ` ${clean(entry.role)}`]);
  if (file.status && file.status !== 'modified') chips.push([file.status === 'deleted' ? 'red' : 'green', ` ${clean(file.status)}`]);
  if (file.isBinary) chips.push(['dim', ' binary']);
  const threads = (state.draft?.threads ?? []).filter((t) => t.path === file.path).length;
  for (const l of wrapSegments([['bold', clean(file.path)], ...chips, [null, '  '], ['green', `+${file.additions ?? 0}`], [null, ' '], ['red', `−${file.deletions ?? 0}`],
    ...(threads ? [['yellow', `  ${threads} conversation${threads === 1 ? '' : 's'}`]] : [])], columns)) add(l);
  if (entry.preamble) for (const l of wrapSegments(inlineSegments(entry.preamble), columns)) add(l);
  add([]);
  if (file.isBinary) add([['dim', 'A binary file: nothing to show.']]);
  else if (!file.hunks?.length) add([['dim', file.truncated ? 'Too large to show here.' : 'No lines changed.']]);
  const numberWidth = Math.max(3, ...diffRows(file).map((l) => String(l.newNo ?? l.oldNo ?? '').length));
  const gutter = numberWidth * 2 + 4;
  const textWidth = Math.max(10, columns - gutter);
  let row = 0;
  (file.hunks ?? []).forEach((hunk, h) => {
    if (h) add([['dim', '⋯']]);
    for (const line of hunk.lines ?? []) {
      const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
      const tone = line.type === 'add' ? 'green' : line.type === 'del' ? 'red' : null;
      const numbers = `${String(line.oldNo ?? '').padStart(numberWidth)} ${String(line.newNo ?? '').padStart(numberWidth)} ${sign} `;
      const text = clean(line.text);
      const pieces = [];
      let restText = text;
      do {
        const piece = cut(restText, textWidth);
        // A cut line ends in an ellipsis; take what fits before it and go on.
        const taken = piece.endsWith('…') && piece !== restText ? piece.slice(0, -1) : piece;
        pieces.push(taken);
        restText = restText.slice(taken.length);
      } while (restText && pieces.length < 20);
      pieces.forEach((piece, i) => add([['dim', i ? ' '.repeat(gutter) : numbers], [tone, piece]], row));
      for (const thread of threadsAt(state, file, line)) {
        for (const c of thread.comments ?? []) {
          const head = [['bold', clean(c.author)], ...(c.pending ? [['yellow', ' draft']] : []), ...(thread.resolved ? [['dim', ' resolved']] : [])];
          for (const l of wrapSegments(head, columns, { first: `${' '.repeat(gutter - 2)}┃ `, firstStyle: 'yellow' })) add(l, row);
          for (const l of markdownLines(c.body, columns, { indent: `${' '.repeat(gutter - 2)}┃ ` })) add(l, row);
        }
      }
      row += 1;
    }
  });
  if (state.draft?.outdated) add([['dim', `${state.draft.outdated} outdated conversation${state.draft.outdated === 1 ? ' is' : 's are'} on GitHub only.`]]);
  return { lines, items, cursor: state.cursor };
}

// --- Chat -------------------------------------------------------------------------------

const GENERAL_STARTERS = [
  'What should I look at first?',
  'What could this break, and for whom?',
  'What is not covered by tests?',
  'Why was it done this way rather than the obvious alternative?',
  'What should I try by hand before approving?',
];

/** What the page offers to start the conversation with (chatStarters): the analysis's own, then general ones, five. */
export function chatStarters(review) {
  const out = [];
  for (const q of review?.questions ?? []) if (out.length < 3) out.push(clean(q.question).split('`').join(''));
  for (const d of review?.decisions ?? []) if (out.length < 3) out.push(`Talk me through this decision: ${clean(d.title).split('`').join('')}`);
  for (const g of GENERAL_STARTERS) if (out.length < 5) out.push(g);
  return out;
}

export function chatLines(state, columns, nowMs = Date.now()) {
  const chat = state.chat ?? {};
  const lines = [];
  if (!chat.messages?.length && !chat.pending) {
    lines.push(...wrapText('A conversation about the change as a whole, with the branch checked out to read from. Enter starts a question; ↑ and ↓ in the box offer these:', columns, 'dim'));
    for (const s of chatStarters(state.status?.review)) lines.push(...wrapSegments([[null, s]], columns, { first: '  • ', rest: '    ' }));
  }
  const all = [...(chat.messages ?? []), ...(chat.pending ? [{ role: 'user', text: chat.pending }] : [])];
  for (const m of all) {
    if (lines.length) lines.push([]);
    if (m.role !== 'assistant') {
      lines.push(...wrapSegments([['bold', clean(m.text)]], columns, { first: 'You  ', firstStyle: 'cyan bold', rest: '     ' }));
      continue;
    }
    lines.push([['magenta bold', 'Claude']]);
    lines.push(...markdownLines(m.text ?? '', columns, { indent: '  ' }));
    const foot = [];
    if (m.steps) foot.push(`${m.steps} step${m.steps === 1 ? '' : 's'}`);
    if (m.durationMs) foot.push(`${Math.round(m.durationMs / 1000)}s`);
    if (state.status?.showCosts && typeof m.costUsd === 'number') foot.push(`$${m.costUsd.toFixed(3)}`);
    if (foot.length) lines.push([['dim', `  ${foot.join(' · ')}`]]);
  }
  if (chat.busy) {
    const seconds = chat.since ? Math.max(0, Math.round((nowMs - chat.since) / 1000)) : 0;
    lines.push([], [['yellow', `⋯ reading the code… ${seconds}s`]]);
  }
  if (chat.error) lines.push([], ...wrapText(chat.error, columns, 'red'));
  return lines;
}
