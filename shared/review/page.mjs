// The review page — a second document served at /review, separate from the
// launcher at /.
//
// It is per SESSION: /review?session=claude-<8hex>, reached from the Review
// link on that session's row in Active sessions. There is no landing page and
// no "open a PR" form any more — a review is created by launching a session
// with a target in the launcher's "PR or branch" field, which is what put the
// worktree, the diff and the analysis on disk in the first place.
//
// Bare /review, with no session, renders an empty state pointing back at the
// launcher. It must keep answering 200: install.sh fetches exactly that URL
// with `curl -fsS` and re-parses the inline script out of it.
//
// Why its own page rather than a section of /: the launcher rebuilds its
// session list from scratch on every 5s poll (replaceChildren), which would
// destroy a diff viewer's scroll position, its open files and any answer panel
// mid-read. It also wants a stylesheet the launcher has no use for.
//
// TWO CONSTRAINTS ON EVERYTHING BELOW, both inherited from server.mjs:
//
//  1. No backticks and no ${ inside the template literal, except the deliberate
//     interpolations of tokenizeLine and createAskState. A stray backtick
//     corrupts the *client* script while the server still parses and serves
//     200s — which is why install.sh re-parses the served page rather than just
//     the source.
//  2. DOM is built with createElement + textContent, never innerHTML. Every
//     string on this page comes from a PR title, a diff hunk or a model, i.e.
//     from somewhere untrusted.

import { tokenizeLine } from './highlight.mjs';
import { createAskState } from './askState.mjs';

// The dark palette, written once here and interpolated into both blocks that
// need it — the device query and the explicit [data-theme="dark"] stamp. Two
// hand-kept copies of twenty-odd colours drift, and the failure is a page that
// is dark one way and half-dark the other.
//
// The values are the launcher's own, from server.mjs: the two pages sit in one
// window, the review framed inside the launcher, and a pane a shade lighter
// than the rail beside it reads as a different application. Body #14171d, rail
// #191d26, panels #2a3142, rules #3a4152, text #e8ecf5 over #8a93a8 over
// #6b7488, orange #f59433, link blue #9cb8ff.
//
// The diff and code colours are the deliberate exception. They are pitched for
// contrast rather than for matching anything, because a changed line has to be
// unmistakable at a glance and the muted washes this page used before were not.
const DARK_PALETTE = [
  '        --bg: #14171d;',
  '        --panel: #1e232e;',
  '        --sunk: #191d26;',
  '        --ink: #e8ecf5;',
  '        --muted: #8a93a8;',
  '        --faint: #6b7488;',
  '        --rule: #2a3142;',
  '        --rule-strong: #3a4152;',
  '        --accent: #f59433;',
  '        --slate: #9cb8ff;',
  '        --add: #56d364;',
  '        --add-bg: #10291b;',
  '        --add-word: rgba(63, 185, 80, 0.4);',
  '        --del: #f85149;',
  '        --del-bg: #2d1517;',
  '        --del-word: rgba(248, 81, 73, 0.35);',
  '        --warn: #f0b45f;',
  '        --code-comment: #8b949e;',
  '        --code-string: #a5d6ff;',
  '        --code-keyword: #ff7b72;',
  '        --c-arch: #2dd4bf;',
  '        --c-dec: #c4a5ff;',
  '        --c-act: #9cb8ff;',
].join('\n');

export const REVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review a PR — Woodshed</title>
  <!-- Same three faces the launcher loads. This page is one click from it, and
       a review that renders in a different typeface than the page that opened
       it reads as a different application. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&family=Red+Hat+Display:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
  <style>
    :root {
      color-scheme: light dark;
      /* The document's outer width, and the width running prose stops at
         inside it. They are separate because the two want opposite things:
         the diff reads better the wider it gets — fewer wrapped lines — and
         a paragraph reads worse. So the shell grows to the window and the
         extra goes to the diff, while prose holds the measure it already
         had. Both are read twice: the shell also positions the chat panel,
         which is fixed rather than a grid item. */
      --shell: 2100px;
      --prose-measure: 70rem;
      --bg: #fcfcfc;
      --panel: #ffffff;
      --sunk: #f4f4f3;
      --ink: #1b2232;
      --muted: #666;
      --faint: #999;
      --rule: #e2e2e2;
      --rule-strong: #ccc;
      --accent: #E87D09;
      --slate: #526288;
      --add: #1a7f37;
      --add-bg: #e6ffec;
      --add-word: #abf2bc;
      --del: #cf222e;
      --del-bg: #ffebe9;
      --del-word: #ffc9c6;
      --warn: #b45309;
      /* Syntax gets its own three rather than borrowing --add and --slate,
         which are a status colour and a button colour: both were chosen to
         sit quietly, and a keyword that sits quietly is not highlighted. */
      --code-comment: #6e7781;
      --code-string: #0a3069;
      --code-keyword: #cf222e;
      /* One hue per kind of section, carried by the tick on its label and by
         whatever chips sit under it. Three, not one per act: the acts are the
         repeated thing, so they stay the neutral one and the two sections
         that appear once each get the identity. Colour never touches text or
         a background — only a 3px mark and a chip — which is what keeps three
         hues reading as one document. */
      --c-arch: #0f766e;
      --c-dec: #6d28d9;
      --c-act: #526288;
    }
    /* Three theme states, not two. The launcher's picker writes 'system',
       'light' or 'dark' to localStorage and this page follows it (see
       followLauncherTheme in the script): 'system' leaves the root unstamped,
       where only the device query separates the two, while an explicit choice
       stamps data-theme and must beat the device in BOTH directions — hence
       the :not() guard on the query and the second block after it. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
${DARK_PALETTE}
      }
    }
    :root[data-theme="dark"] {
${DARK_PALETTE}
    }

    * { box-sizing: border-box; }
    body.embedded { padding-top: 1.25rem; }
    body {
      font: 15px/1.5 "Red Hat Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      max-width: var(--shell); margin: 0 auto; padding: 2rem 1.25rem 5rem;
      background: var(--bg); color: var(--ink);
    }

    /* --- layout: the file tree beside the document ---
       The tree is a second way in: the acts below give a reading order, the
       tree answers "where is X" and "how far through am I". It sticks while
       the document scrolls, and folds away on anything narrower than a
       laptop, where a sidebar would leave the diff no room to wrap in. */
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 2rem; align-items: start; }
    /* The chat column is a reserved track: the panel itself is fixed, so it
       is placed over this track rather than inside it. */
    /* The panel is fixed, so this track is what stops the document spreading
       under it. Both read the same variable, or a widened panel would sit on
       top of the diff instead of beside it. */
    .layout.with-chat { grid-template-columns: minmax(0, 1fr) var(--chat-w, 24rem); }
    /* Collapsed, the conversation keeps a track of its own — narrow, but
       reserved. Both it and the panel are fixed rather than grid items, so
       without a track to sit in the rail would stand on top of the diff. */
    .layout.with-rail { grid-template-columns: minmax(0, 1fr) 2.9rem; }
    /* The tree belongs to the half of the page that has a diff, so it is a
       column inside that half rather than of the whole document. That is what
       lets the title, the state box and the tabs run the full width instead of
       starting at the tree's right edge. */
    .filesplit { display: grid; grid-template-columns: 17rem minmax(0, 1fr); gap: 0 2rem; align-items: start; }
    /* A grid item's automatic minimum is its content, so without this a long
       unbroken line in a diff widens the column instead of scrolling inside
       it. */
    .filelist { min-width: 0; }
    .tree {
      position: sticky; top: 0.75rem; max-height: calc(100vh - 1.5rem); overflow-y: auto;
      overscroll-behavior: contain; padding: 0 0.25rem 1rem 0;
    }
    .tree-dir, .tree-file {
      display: flex; align-items: center; gap: 0.35rem; width: 100%; min-width: 0;
      padding: 0.15rem 0.4rem; border: none; border-radius: 4px; background: none;
      font: 12.5px/1.5 "Red Hat Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-weight: 400; color: var(--ink); text-align: left; cursor: pointer;
    }
    .tree-dir:hover, .tree-file:hover { background: var(--sunk); filter: none; }
    .tree-dir { color: var(--muted); }
    .tree-dir .tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-file .tname {
      font: 12px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tree-file.added .tname { color: var(--add); }
    .tree-file.deleted .tname { color: var(--del); text-decoration: line-through; }
    /* The row of the file whose card is under the top of the viewport. */
    .tree-file.on { background: var(--sunk); box-shadow: inset 2px 0 0 var(--accent); }
    .tree-file .chip { font-size: 8.5px; padding: 0 0.25rem; }
    .tree-file .tcount {
      margin-left: auto; flex: none; white-space: nowrap;
      font: 10.5px/1.5 ui-monospace, monospace; font-variant-numeric: tabular-nums;
    }
    .tree-file .tcount .p { color: var(--add); }
    .tree-file .tcount .m { color: var(--del); margin-left: 0.25rem; }
    .tree-kids { margin-left: 0.6rem; padding-left: 0.35rem; border-left: 1px solid var(--rule); }
    /* The glyph carries the kind so the name does not have to: a directory
       and a file are otherwise two words in the same face, told apart only by
       indentation, which is exactly what is lost when a chain of single-child
       directories folds into one row. currentColor, so a row's status colour
       reaches the icon without a second rule per status. */
    .ticon { width: 13px; height: 13px; flex: none; fill: currentColor; }
    .tree-dir .ticon { opacity: 0.75; }
    .tree-file .ticon { opacity: 0.55; }
    /* Only where the shell has room to spare. The tree truncates basenames at
       its narrow width, and the basename is the one thing the tree exists to
       show; the diff can afford the extra 4rem on a screen this wide and on a
       laptop it cannot, which is why this is a ceiling and not a new default. */
    @media (min-width: 1700px) {
      .filesplit { grid-template-columns: 21rem minmax(0, 1fr); }
    }
    @media (max-width: 900px) {
      .layout.with-chat { grid-template-columns: minmax(0, 1fr); }
      /* The collapsed conversation stays on a phone — it is the only way back
         to it — but it stops reserving a column. At this width the panel
         covers the document instead of sitting beside it, so there is no
         track for the rail to be the narrow end of, and holding one spent
         2.4rem plus the grid's 2rem gap: ~70px of a 390px screen, more than
         the old-number column this block drops for being worth 15%. It
         becomes a corner button instead — see the chat section. */
      .layout.with-rail { grid-template-columns: minmax(0, 1fr); }
      .filesplit { grid-template-columns: minmax(0, 1fr); }
      .tree { display: none; }
    }

    /* --- chat: a conversation about the change as a whole ---
       Sticks beside the document like the tree, and keeps its own scroller so
       a long conversation never moves the diff. The panel lives outside
       #content, so a render() cannot take a half-typed message with it. */
    .chat {
      position: fixed; top: 0.75rem; bottom: 0.75rem; width: var(--chat-w, 24rem); z-index: 20;
      /* The body is centred at --shell with 1.25rem of side padding; this
         is its right edge, so the panel lands on the track the grid
         reserved. Tied to the same variable, or a wider shell would slide
         the document out from under the panel. */
      right: max(1.25rem, calc((100vw - var(--shell)) / 2 + 1.25rem));
      display: flex; flex-direction: column; min-height: 0;
      background: var(--panel); border: 1px solid var(--rule); border-radius: 6px;
    }
    /* A grip on the panel's left edge, outside its rounded corner so the
       corner stays a corner. Wider than it looks: a 1px line is the right
       thing to see and the wrong thing to aim at. */
    .chat-grip {
      position: absolute; top: 0; bottom: 0; left: -7px; width: 14px;
      cursor: col-resize; background: none; border: 0; padding: 0; z-index: 1;
    }
    .chat-grip::after {
      content: ''; position: absolute; top: 12px; bottom: 12px; left: 6px; width: 2px;
      border-radius: 2px; background: transparent; transition: background 0.12s;
    }
    .chat-grip:hover::after, .chat-grip:focus-visible::after, .chat.resizing .chat-grip::after {
      background: var(--rule-strong);
    }
    /* While dragging, nothing else should take the pointer or start selecting
       text under it. */
    body.resizing-chat { cursor: col-resize; user-select: none; }
    body.resizing-chat .chat { transition: none; }
    .chat-head {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--rule);
    }
    .chat-head b { font-family: Merriweather, Georgia, serif; font-size: 0.95rem; flex: 1; min-width: 0; }
    /* Collapse, not close: the conversation is kept and the button at the
       corner brings it back. A chevron toward the edge it goes to says that
       in less room than the word did, and stops a control the size of the
       title competing with it. */
    .chat-collapse {
      display: flex; align-items: center; justify-content: center; flex: none;
      width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px;
      background: none; color: var(--faint); cursor: pointer;
    }
    .chat-collapse:hover { background: var(--sunk); color: var(--ink); filter: none; }
    .chat-collapse svg { width: 15px; height: 15px; fill: currentColor; }
    .chat-log { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0.75rem; }
    /* Before anything is said the panel is mostly empty, and the prompt to
       say something reads better held in that space than pinned to the top
       of it. */
    .chat-log.blank { display: flex; flex-direction: column; justify-content: center; }
    .chat-hint { color: var(--faint); font-size: 13px; line-height: 1.55; }
    .chat-hint p { margin: 0 0 0.6rem; }
    .msg { margin-bottom: 0.75rem; font-size: 13.5px; line-height: 1.55; }
    .msg.user {
      margin-left: 2rem; padding: 0.45rem 0.65rem; border-radius: 8px 8px 2px 8px;
      background: var(--sunk); border: 1px solid var(--rule); white-space: pre-wrap; word-break: break-word;
    }
    .msg.bot { padding: 0 0.1rem; }
    .msg.bot .prose code, .msg.bot .prose pre { background: var(--sunk); }
    .msg.wait {
      display: flex; align-items: center; gap: 0.4rem;
      font: 12px/1.5 ui-monospace, monospace; color: var(--muted);
    }
    .msg .foot { font: 11px/1.5 ui-monospace, monospace; color: var(--faint); margin-top: 0.25rem; }
    .chat-err {
      background: var(--del-bg); color: var(--del); border-radius: 4px;
      padding: 0.4rem 0.6rem; font-size: 13px; margin-bottom: 0.5rem;
    }
    .chat-form { display: flex; gap: 0.4rem; align-items: flex-end; padding: 0.6rem 0.75rem; border-top: 1px solid var(--rule); }
    /* One row until it is typed into. At two the box stood 20px taller than
       the button beside it, and a bottom-aligned button under a half-empty
       box reads as hanging even though the two edges line up exactly. */
    .chat-form textarea {
      flex: 1; min-width: 0; resize: none; padding: 0.45rem 0.55rem; font: inherit; font-size: 13.5px;
      line-height: 1.4; min-height: 34px; max-height: 9rem;
      border: 1px solid var(--rule-strong); border-radius: 4px;
      background: var(--panel); color: var(--ink);
    }
    .chat-form button { flex: none; height: 34px; padding: 0 0.85rem; font-size: 13px; }
    /* Collapsed, the panel becomes a rail down the same edge it left, at the
       same top and bottom — so collapsing reads as the panel narrowing rather
       than as it vanishing and a button appearing somewhere else. It was a
       floating button at the corner, which said nothing about where the thing
       it opened would come from. */
    .chat-rail {
      position: fixed; top: 0.75rem; bottom: 0.75rem; width: 34px; z-index: 20;
      right: max(1.25rem, calc((100vw - var(--shell)) / 2 + 1.25rem));
      display: flex; flex-direction: column; align-items: center; gap: 0.55rem;
      padding: 0.5rem 0; margin: 0;
      border: 1px solid var(--rule); border-radius: 6px;
      background: var(--panel); color: var(--muted); cursor: pointer;
    }
    .chat-rail:hover { background: var(--sunk); color: var(--ink); filter: none; }
    .chat-rail svg { width: 14px; height: 14px; fill: currentColor; flex: none; }
    .rail-label {
      writing-mode: vertical-rl; min-height: 0; overflow: hidden;
      font: 500 12px/1 "Red Hat Display", -apple-system, system-ui, sans-serif;
      letter-spacing: 0.02em; white-space: nowrap; text-overflow: ellipsis;
    }
    /* The button carries both glyphs and each width picks one. */
    .rail-bubble { display: none; }
    /* On a phone the chat takes the whole viewport, over the document. After
       the base rule on purpose: same specificity, so order decides. */
    @media (max-width: 900px) {
      .chat { inset: 0; width: auto; border-radius: 0; z-index: 30; }
      /* Which is what takes the rail's reason to run down that edge: the panel
         it stands for does not come from there any more, it covers the page.
         So it becomes a round button in the corner a thumb already rests in,
         sitting over the diff rather than narrowing it — and still reachable
         in the middle of a long file, which is the one thing an entry in the
         tab bar could not do, the bar having scrolled off by then. The
         chevron goes with the edge it pointed at: in a corner it reads as
         "back", so the button shows what it opens rather than where from. */
      .chat-rail {
        top: auto; right: 0.9rem;
        bottom: max(0.9rem, env(safe-area-inset-bottom, 0px));
        width: 44px; height: 44px; padding: 0;
        justify-content: center; border-radius: 50%;
        box-shadow: 0 2px 10px rgba(27, 34, 50, 0.16);
      }
      .chat-rail svg { width: 17px; height: 17px; }
      .rail-chevron, .rail-label { display: none; }
      .rail-bubble { display: block; }
    }

    /* --- prose: everything the model wrote, rendered from markdown ---
       One set of rules for the overview, the architecture note, each act's
       "why", each file's preamble, the decisions and the answers, so a
       backticked identifier looks the same wherever it appears. */
    .prose p { margin: 0 0 0.6rem; }
    .prose p:last-child { margin-bottom: 0; }
    .prose ul, .prose ol { margin: 0 0 0.6rem; padding-left: 1.4rem; }
    .prose ul:last-child, .prose ol:last-child { margin-bottom: 0; }
    .prose li { margin-bottom: 0.2rem; }
    .prose h4 { font: 600 1em/1.4 inherit; margin: 0.8rem 0 0.3rem; color: var(--ink); }
    .prose h4:first-child { margin-top: 0; }
    .prose strong { font-weight: 700; color: var(--ink); }
    .prose code {
      background: var(--sunk); border: 1px solid var(--rule);
      padding: 0.05em 0.3em; border-radius: 3px; font-size: 0.9em; overflow-wrap: anywhere;
    }
    /* A bullet that opens with a bold lead-in is a term and its note, so the
       term takes its own line — the same shape the decisions list uses. */
    .prose li > strong:first-child { display: block; color: var(--ink); }
    .prose blockquote {
      margin: 0 0 0.7rem; padding: 0.15rem 0 0.15rem 0.85rem;
      border-left: 2px solid var(--rule-strong); color: var(--muted);
    }
    .prose blockquote p:last-child { margin-bottom: 0; }
    /* Its own scroller: the column holds the prose measure, and a table with
       three columns of paths will not. */
    .prose .tablewrap { overflow-x: auto; margin: 0 0 0.8rem; }
    .prose table { border-collapse: collapse; font-size: 0.95em; }
    .prose th, .prose td {
      text-align: left; vertical-align: top; padding: 0.35rem 1rem 0.35rem 0;
      border-bottom: 1px solid var(--rule);
    }
    .prose th {
      font: 600 10.5px/1.7 ui-monospace, monospace; letter-spacing: 0.07em;
      text-transform: uppercase; color: var(--faint); border-bottom-color: var(--rule-strong);
    }
    .prose td:first-child { color: var(--ink); }
    .prose tr:last-child td { border-bottom: 0; }
    .prose pre {
      background: var(--sunk); border: 1px solid var(--rule); border-radius: 4px;
      padding: 0.5rem 0.6rem; overflow-x: auto; font-size: 12px; margin: 0 0 0.6rem;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    h1 { margin: 0 0 0.25rem; font-family: Merriweather, Georgia, serif; font-size: 1.6rem; }
    a { color: var(--slate); }
    code { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }

    /* The UA rule for [hidden] is display:none at (0,1,0), so any author rule
       that sets display on the same element beats it and the element stays on
       screen with its hidden attribute set — silently, since nothing errors.
       The backlink hides itself when this page is embedded in the launcher's
       pane, and did not: it was still there, offering to load the launcher
       inside the launcher. Same guard the launcher itself carries. */
    [hidden] { display: none !important; }

    /* Hidden until the script says otherwise, which is the opposite of how
       this started: it was visible and the embed check took it away, so every
       load inside the launcher's pane showed a link for one frame and then
       swallowed it. The standalone tab is the rarer case, so it is the one
       that pays the frame — and an element appearing late is not something a
       reader notices, while one vanishing is. */
    .backlink { display: none; }
    body.standalone .backlink {
      display: inline-block; margin-bottom: 1.25rem;
      font-size: 13px; color: var(--slate); text-decoration: none;
    }
    .backlink:hover { text-decoration: underline; }

    button {
      padding: 0.55rem 1.25rem; font: inherit; font-weight: 600;
      background: var(--accent); color: #fff; border: none; border-radius: 6px; cursor: pointer;
    }
    button:hover { filter: brightness(0.93); }
    button:disabled { opacity: 0.5; cursor: wait; }
    button.quiet {
      background: none; color: var(--slate); border: 1px solid var(--rule-strong);
      font-weight: 600; font-size: 12px; padding: 0.3rem 0.6rem;
    }
    button.quiet:hover { background: var(--sunk); filter: none; }
    :focus-visible { outline: 2px solid var(--slate); outline-offset: 2px; }

    /* The same tooltip the launcher uses, because these are the same kind of
       control and a browser's own title tip takes a second to arrive and
       cannot be styled. Pure CSS on whatever is hovered, so it survives the
       re-render that follows every click here. */
    [data-tip] { position: relative; }
    [data-tip]:hover::after, [data-tip]:focus-visible::after {
      content: attr(data-tip);
      position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 30;
      width: max-content; max-width: 240px;
      white-space: normal; text-align: left;
      font: 400 12px/1.35 "Red Hat Display", -apple-system, system-ui, sans-serif;
      letter-spacing: normal; text-transform: none;
      color: #fff; background: #1b2232;
      padding: 0.4rem 0.55rem; border-radius: 4px;
      box-shadow: 0 4px 14px rgba(27, 34, 50, 0.22);
      pointer-events: none;
    }
    /* Anything tipped that sits at the right end of its row: a tip anchored
       left would open toward the edge and hang off the card. */
    .fbar [data-tip]:hover::after, .fbar [data-tip]:focus-visible::after,
    .cmthead [data-tip]:hover::after, .cmthead [data-tip]:focus-visible::after,
    .saidhead [data-tip]:hover::after, .saidhead [data-tip]:focus-visible::after,
    .pickbar [data-tip]:hover::after, .pickbar [data-tip]:focus-visible::after,
    .tabbar [data-tip]:hover::after, .tabbar [data-tip]:focus-visible::after {
      left: auto; right: 0;
    }
    /* On a phone a tap leaves :hover stuck on, so the tip glues itself over
       the bar until something else is tapped. The launcher suppresses them at
       the same width for the same reason. */
    @media (hover: none) and (max-width: 720px) {
      [data-tip]:hover::after { content: none; }
    }

    .err {
      background: var(--del-bg); color: var(--del); border-left: 3px solid var(--del);
      padding: 0.7rem 0.85rem; border-radius: 4px; margin-bottom: 1.25rem; font-size: 14px;
    }

    /* --- PR header --- */
    /* The page's only heading now, so it is set at h1 size: a standing
       "Review a change" above it said the same thing on every review and
       spent the top inch of the page saying it. */
    .prtitle { font-family: Merriweather, Georgia, serif; font-size: 1.6rem; margin: 0 0 0.35rem; }
    /* The word, not the name — quieter than what follows it, so the title
       still reads first. */
    .prtitle .kind { color: var(--muted); font-weight: 400; }
    .prnum { color: var(--accent); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.8em; }
    /* Six facts of quite different weight, which read as one grey chain when
       they are set as one. The branches are what the eye goes to first, so
       they are the only thing boxed; the counts carry the page's own green and
       red; and the session id is shed bookkeeping rather than part of the
       change, so it goes to the far end. Separators are gaps, not middots:
       with the chips in there the dots were only noise. */
    .prmeta {
      display: flex; align-items: center; gap: 0.4rem 0.8rem; flex-wrap: wrap;
      font: 12px/1.6 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--faint); margin-bottom: 1rem;
    }
    .prmeta .who { color: var(--muted); }
    .prmeta .sha { color: var(--muted); }
    .prmeta .refs { display: inline-flex; align-items: center; gap: 0.35rem; min-width: 0; }
    .prmeta .ref {
      background: var(--sunk); border: 1px solid var(--rule); border-radius: 4px;
      padding: 0 0.35rem; color: var(--ink); word-break: break-all;
    }
    .prmeta .ref.base { color: var(--muted); }
    .prmeta .arrow { flex: none; }
    .prmeta .dstat { display: inline-flex; align-items: center; gap: 0.35rem; font-variant-numeric: tabular-nums; }
    .prmeta .dstat .p { color: var(--add); }
    .prmeta .dstat .m { color: var(--del); }
    /* Five blocks in the ratio of the two counts, the way a pull request list
       draws it. It says the same thing as the numbers beside it, but as a
       shape: mostly-additions and mostly-deletions are told apart without
       reading. */
    .prmeta .bar { display: inline-flex; gap: 2px; }
    .prmeta .bar i { width: 7px; height: 7px; border-radius: 1px; background: var(--add); }
    .prmeta .bar i.m { background: var(--del); }
    .prmeta .draft {
      border: 1px solid var(--rule-strong); border-radius: 3px;
      padding: 0 0.3rem; color: var(--warn);
    }
    .prmeta .openedpr {
      font: 600 11.5px/1.6 ui-monospace, monospace; color: var(--accent);
      text-decoration: none; border-bottom: 1px solid transparent;
    }
    .prmeta .openedpr:hover { border-bottom-color: var(--accent); }
    /* GitHub's own pill, in GitHub's own colours. This is the one element on
       the page deliberately not in the shed's palette: it is quoting a status
       people read on another site every day, and a warm-neutral version of it
       would be a worse signal for being prettier. */
    .prstate {
      display: inline-flex; align-items: center; gap: 0.3rem; flex: none;
      font: 600 11px/1.6 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: #fff; border-radius: 999px; padding: 0.1rem 0.5rem 0.1rem 0.4rem;
      background: #6b7280;
    }
    .prstate svg { width: 12px; height: 12px; fill: currentColor; }
    .prstate.open { background: #1a7f37; }
    .prstate.draft { background: #59636e; }
    .prstate.merged { background: #8250df; }
    .prstate.closed { background: #cf222e; }
    /* The two facts GitHub puts under the pill. They were grey words beside a
       green pill, which made the one coloured thing on the line the one fact
       that never changes — the pill says Open for weeks while these two are
       what actually move. They are chips now, in the colour of what they say,
       and each is a link to the part of GitHub that explains it. */
    .prmeta .fact {
      display: inline-flex; align-items: center; gap: 0.3rem; flex: none;
      font: 600 11px/1.6 "Red Hat Display", -apple-system, system-ui, sans-serif;
      border: 1px solid transparent; border-radius: 999px;
      padding: 0.05rem 0.5rem 0.05rem 0.4rem;
      text-decoration: none; color: var(--muted); background: var(--sunk);
      border-color: var(--rule);
    }
    .prmeta .fact svg { width: 11px; height: 11px; fill: currentColor; flex: none; }
    .prmeta .fact:hover { filter: none; border-color: currentColor; }
    .prmeta .fact.good { color: var(--add); background: var(--add-bg); border-color: transparent; }
    .prmeta .fact.bad { color: var(--del); background: var(--del-bg); border-color: transparent; }
    .prmeta .fact.busy { color: var(--warn); background: var(--sunk); border-color: var(--rule); }
    .prmeta .fact .n { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
    .prmeta button.fact { cursor: pointer; }

    /* One entry on the Discussion tab: the description, a review's body or a
       plain comment. As tall as what it holds; the page scrolls. */
    .saidbox {
      margin: 0 0 0.9rem; border: 1px solid var(--rule); border-left: 3px solid var(--rule-strong);
      border-radius: 5px; background: var(--panel);
    }
    .saidbox.good { border-left-color: var(--add); }
    .saidbox.bad { border-left-color: var(--del); }
    .saidhead {
      display: flex; align-items: center; gap: 0.45rem;
      padding: 0.45rem 0.7rem; border-bottom: 1px solid var(--rule); background: var(--sunk);
      font: 600 11.5px/1.6 "Red Hat Display", -apple-system, system-ui, sans-serif; color: var(--muted);
    }
    .saidhead + .saidbody + .saidhead { border-top: 1px solid var(--rule); }
    .saidhead .who { color: var(--ink); }
    .saidhead .when { font: 11px/1.6 ui-monospace, monospace; color: var(--faint); }
    .saidhead .grow { flex: 1; }
    .saidhead button {
      background: none; border: 0; padding: 0.1rem 0.3rem; border-radius: 4px;
      font: inherit; font-size: 11.5px; color: var(--del); cursor: pointer;
    }
    .saidhead button:hover { background: var(--del-bg); filter: none; }
    .saidhead button.sure { background: var(--del-bg); border: 1px solid var(--del); }
    .saidhead .cannot { font-size: 11px; color: var(--faint); font-style: italic; }
    .verdictword {
      font: 600 9.5px/1.6 ui-monospace, monospace; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--muted); border: 1px solid var(--rule-strong); border-radius: 3px; padding: 0 0.3rem;
    }
    .verdictword.good { color: var(--add); border-color: var(--add); }
    .verdictword.bad { color: var(--del); border-color: var(--del); }
    .saidbody {
      padding: 0.6rem 0.7rem; font-size: 13.5px; line-height: 1.55; color: var(--ink);
      max-width: var(--prose-measure);
    }
    .saidhead.toggles { cursor: pointer; user-select: none; }
    .saidhead .caret { font-size: 9px; width: 0.6rem; color: var(--faint); }
    .saidbox.folded .saidhead { border-bottom: 0; }

    /* Always out, not revealed on hover. Hover-to-reveal was tried and it
       hides the control from anyone who does not already know it is there,
       which is everyone the first time. Faint is enough to keep it out of the
       way of a title people mostly just read. */
    .retitle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0; margin-left: 0.15rem;
      vertical-align: middle; border: 0; border-radius: 5px;
      background: none; color: var(--faint); cursor: pointer;
    }
    .retitle:hover { background: var(--sunk); color: var(--ink); filter: none; }
    .retitle svg { width: 14px; height: 14px; fill: currentColor; }

    /* The heading becomes the field, at the heading's own size, so the rename
       happens where the title is rather than in a box somewhere else. */
    .retitle-form { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; }
    .retitle-form input {
      flex: 1; min-width: 0; font-family: Merriweather, Georgia, serif;
      font-size: 1.5rem; line-height: 1.25; font-weight: 700;
      padding: 0.15rem 0.5rem; color: var(--ink); background: var(--panel);
      border: 1px solid var(--rule-strong); border-radius: 5px;
    }
    .retitle-form button { flex: none; padding: 0.4rem 0.9rem; font-size: 13px; border-radius: 5px; }
    .retitle-form .quiet { font-size: 13px; padding: 0.4rem 0.8rem; }
    @media (max-width: 560px) { .retitle-form input { font-size: 1.1rem; } }
    .prmeta .sess { margin-left: auto; opacity: 0.8; }

    /* A ring that turns, rather than a glyph that claims to. One class, used
       by the analysis strip and by both places a question is waiting on an
       answer, so "something is running" looks the same wherever it appears. */
    .spin {
      width: 11px; height: 11px; flex: none; border-radius: 50%;
      border: 2px solid var(--rule-strong); border-top-color: var(--slate);
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* One box, two rows. Both are about the state of this review — what it is
       OF, and what is happening to it — so they share a border, a radius and
       a ground, and a hairline divides them instead of a gap.

       No colour on it by default. Every pull request review carries this box
       for as long as it exists, and a caveat that is permanently amber is a
       caveat nobody reads by the second day — it was also close enough to the
       overview's orange, an inch below, to look related to it. Colour is kept
       for the one state that is not permanent: a run that failed. */
    .statebox {
      border: 1px solid var(--rule); border-left: 3px solid var(--rule-strong);
      border-radius: 5px; overflow: hidden; background: var(--sunk);
      margin: 0.7rem 0 1.4rem;
    }
    .statebox.bad { border-left-color: var(--del); }
    .status, .livenote {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      border: 0; border-radius: 0; margin: 0; padding: 0.45rem 0.7rem; background: none;
    }
    .statebox .status { border-top: 1px solid var(--rule); }
    .status .grow, .livenote .grow { flex: 1; }
    /* The right-hand half of either strip is a reassurance, not news. */
    .status .aside, .livenote .aside { color: var(--faint); font-size: 11.5px; }

    .status {
      font: 12px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--muted);
    }
    .status .what { color: var(--ink); }
    .status .dot { color: var(--rule-strong); }
    .status.bad, .status.bad .what { color: var(--del); }

    /* Prose, so it is set in the page's own face: a sentence in the code face
       is slower to read, and this one is a sentence. What stays monospace is
       what is literally an identifier — a time, a sha, a branch. */
    .livenote {
      font: 13px/1.5 "Red Hat Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: var(--muted);
    }
    .livenote b { color: var(--ink); font-weight: 600; }
    .livenote .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
    .livenote .bad { color: var(--del); }
    .livenote .dim { color: var(--faint); }

    /* The lede, and now a section like the rest: it used to be the one block
       with no label and an accent rail instead, which read as an oversight
       once every other block grew a label and a tick. It keeps the accent —
       as the tick — and the slightly larger type that says read this first. */
    .overview {
      max-width: var(--prose-measure);
      font-size: 16px; color: var(--ink); line-height: 1.7;
      margin-bottom: 1.5rem;
    }
    /* The one paragraph everybody reads, so it is the largest body text on
       the page and the only one set above regular weight. The second
       paragraph, where there is one, carries the decision behind the first
       and steps back down to the size the rest of the page is set in. */
    .overview p:first-child { font-weight: 500; }
    .overview p + p { font-size: 14.5px; line-height: 1.65; color: var(--muted); }
    .overview code { font-size: 0.85em; }
    .s-over { --sec: var(--accent); }
    /* No rule above the first label on the page: a rule separates a section
       from the one before it, and above this one there is only the header. */
    .secthead.first { border-top: none; padding-top: 0; margin-top: 1.5rem; }

    /* The author's words, in a card shaped like GitHub's opening comment so
       they never read as the model's prose around them. */
    .s-desc { --sec: var(--slate); }
    .desccard { border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--panel); overflow: hidden; }
    .deschead {
      display: flex; align-items: center; gap: 0.35rem;
      padding: 0.5rem 1rem; background: var(--sunk); border-bottom: 1px solid var(--rule-strong);
      font-size: 13px; color: var(--muted);
    }
    .deschead b { color: var(--ink); }
    .deschead .when { margin-left: 0.2rem; }
    .deschead .grow { flex: 1; }
    .desc { position: relative; padding: 1rem; font-size: 14px; line-height: 1.6; color: var(--ink); }
    .desc.clamped { max-height: 22rem; overflow: hidden; }
    .desc.clamped::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4rem;
      background: linear-gradient(to bottom, transparent, var(--panel));
    }
    .desc .nodesc { color: var(--faint); font-style: italic; }
    .descmore { margin: 0.5rem 0 0; font-size: 12.5px; }

    /* GitHub's markdown, close enough to read as the same document. */
    .gh > :first-child { margin-top: 0; }
    .gh > :last-child { margin-bottom: 0; }
    .gh p, .gh ul, .gh ol, .gh blockquote, .gh pre, .gh table, .gh details { margin: 0 0 1rem; }
    .gh h1, .gh h2, .gh h3, .gh h4, .gh h5, .gh h6 {
      margin: 1.5rem 0 1rem; font-weight: 600; line-height: 1.25; color: var(--ink);
      font-family: "Red Hat Display", -apple-system, system-ui, sans-serif;
    }
    .gh h1 { font-size: 1.6em; padding-bottom: 0.3em; border-bottom: 1px solid var(--rule); }
    .gh h2 { font-size: 1.35em; padding-bottom: 0.3em; border-bottom: 1px solid var(--rule); }
    .gh h3 { font-size: 1.15em; }
    .gh h4, .gh h5, .gh h6 { font-size: 1em; }
    .gh ul, .gh ol { padding-left: 2em; }
    .gh li + li { margin-top: 0.25em; }
    .gh li > ul, .gh li > ol { margin: 0.25em 0 0; }
    .gh li:has(> input[type=checkbox]) { list-style: none; }
    .gh li > input[type=checkbox] { margin: 0 0.35em 0 -1.4em; vertical-align: middle; }
    .gh blockquote { padding: 0 1em; color: var(--muted); border-left: 0.25em solid var(--rule-strong); }
    .gh code { font: 0.85em/1.5 ui-monospace, monospace; background: var(--sunk); border-radius: 4px; padding: 0.15em 0.35em; }
    .gh pre { background: var(--sunk); border-radius: 6px; padding: 0.9rem 1rem; overflow-x: auto; }
    .gh pre code { background: none; padding: 0; font-size: 0.85em; }
    .gh table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
    .gh th, .gh td { border: 1px solid var(--rule-strong); padding: 0.35rem 0.8rem; }
    .gh th { font-weight: 600; background: var(--sunk); }
    .gh img, .gh video { max-width: 100%; height: auto; border-radius: 4px; }
    .gh hr { border: 0; border-top: 3px solid var(--rule); margin: 1.5rem 0; }
    .gh summary { cursor: pointer; }

    /* --- the sections above the acts: what makes this a document worth
       reading before the diff rather than just an ordering. --- */
    /* A rule only where prose meets prose. Between the decisions their own
       numbers already say where each one starts, and under an act head the
       file cards are boxed, so an act is bounded whether or not a line says
       so — drawing all three was seven hairlines on one screen. What every
       label does carry is a tick in its section's hue, which marks the
       boundary at the label instead of across the column. */
    .secthead {
      border-top: 1px solid var(--rule); padding-top: 1.3rem; margin-top: 2rem;
      font: 600 11.5px/1.6 ui-monospace, monospace; letter-spacing: 0.09em;
      text-transform: uppercase; color: var(--muted); margin-bottom: 0.65rem;
      display: flex; align-items: center; gap: 0.45rem;
    }
    .secthead::before {
      content: ''; width: 3px; height: 0.9em; border-radius: 2px;
      background: var(--sec, var(--slate)); flex: none;
    }
    .s-arch { --sec: var(--c-arch); }
    .s-dec { --sec: var(--c-dec); }
    .arch { font-size: 14px; line-height: 1.65; color: var(--ink); margin-bottom: 1.4rem; max-width: var(--prose-measure); }
    .arch p { margin-bottom: 0.8rem; }
    /* --- decisions: what was chosen, and why --- */
    .decisions { margin: 0 0 1.4rem; padding: 0; list-style: none; counter-reset: decision; max-width: var(--prose-measure); }
    .decisions li {
      position: relative; padding: 0.5rem 0 0.5rem 2.5rem;
      font-size: 13.5px; line-height: 1.55;
    }
    .decisions li::before {
      counter-increment: decision; content: counter(decision);
      /* Flush with the column's left edge, where the section tick and the
         paragraphs above it also start, and centred on the first line rather
         than hung off its top. The indent past it is the gap — it was 2px,
         which read as the number touching the title. */
      position: absolute; left: 0; top: 0.62rem;
      font: 600 10px/1.6 ui-monospace, monospace; color: #fff; background: var(--c-dec);
      border-radius: 3px; padding: 0 0.35rem; min-width: 1.2rem; text-align: center;
    }
    .decisions b { display: block; color: var(--ink); margin-bottom: 0.1rem; }
    .decisions .why { color: var(--muted); }
    /* --- questions: what a reviewer has to answer, above the decisions --- */
    .subhead {
      font: 600 13px/1.5 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: var(--ink); margin: 0.2rem 0 0.25rem;
    }
    .questions { margin: 0 0 1.1rem; padding: 0; list-style: none; counter-reset: question; max-width: var(--prose-measure); }
    .questions li { position: relative; padding: 0.5rem 0 0.55rem 2.5rem; font-size: 13.5px; line-height: 1.55; }
    /* Outlined where a decision's number is filled: the same family, and a
       question is the open one of the two. */
    .questions li::before {
      counter-increment: question; content: 'Q' counter(question);
      position: absolute; left: 0; top: 0.62rem;
      font: 600 10px/1.6 ui-monospace, monospace; color: var(--c-dec);
      border: 1px solid var(--c-dec); border-radius: 3px; padding: 0 0.3rem; min-width: 1.2rem; text-align: center;
    }
    .questions b { display: block; color: var(--ink); margin-bottom: 0.1rem; }
    .questions .why { color: var(--muted); }
    .qacts { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin-top: 0.4rem; }
    .qfile, .qask {
      display: inline-flex; align-items: center; gap: 0.3rem; height: 24px; padding: 0 0.5rem;
      border: 1px solid var(--rule-strong); border-radius: 4px; background: var(--panel);
      font: 500 12px/1 ui-monospace, monospace; color: var(--slate); cursor: pointer;
    }
    .qask { font-family: "Red Hat Display", -apple-system, system-ui, sans-serif; color: var(--muted); }
    .qfile:hover, .qask:hover { border-color: var(--slate); color: var(--ink); filter: none; }
    .qask svg { width: 12px; height: 12px; fill: currentColor; flex: none; }
    /* The way from the prose to the diff, at the end of the prose. */
    .tofiles { margin: 1.4rem 0 2.5rem; font-size: 13.5px; }
    /* Above the file list: how it is ordered, and folding every file at once. */
    .filesbar {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      margin: -0.4rem 0 0.9rem; font-size: 12.5px; color: var(--muted);
    }
    .filesbar .grow { flex: 1; }
    .filesbar button { height: 26px; padding: 0 0.6rem; font-size: 12.5px; }
    /* Starters in the empty conversation: the analysis's own questions first. */
    .chat-starters { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.2rem 0 0.4rem; }
    .chat-starter {
      text-align: left; padding: 0.45rem 0.65rem; border: 1px solid var(--rule-strong); border-radius: 8px;
      background: var(--panel); color: var(--ink); font-size: 13px; line-height: 1.45; cursor: pointer;
    }
    .chat-starter:hover { border-color: var(--slate); filter: none; }
    .chat-starter:disabled { opacity: 0.55; cursor: default; }
    /* --- acts --- */
    /* The chip beside a column holding the title and its note, so the note
       starts exactly under the title however wide the chip is — a fixed
       indent was a guess at that width, and ACT 1 and ACT 12 are not the
       same width. */
    .act-head { display: flex; align-items: flex-start; gap: 0.5rem; margin: 2rem 0 0.5rem; }
    .act-head.first { margin-top: 1rem; }
    .act-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
    .act-n {
      font: 600 10px/1.7 ui-monospace, monospace; letter-spacing: 0.08em;
      color: #fff; background: var(--c-act); border-radius: 3px; padding: 0 0.4rem; flex: none;
    }
    .act-head b { font-size: 1.02rem; line-height: 1.35; }
    /* Optically centred against the title's cap height; flex-start alone
       hangs it a touch high. */
    .act-n { margin-top: 2px; }
    .act-why { font-size: 13px; color: var(--muted); margin: 0; line-height: 1.5; max-width: var(--prose-measure); }

    /* --- file cards ---
       No overflow:hidden on the card, deliberately, even though it is what
       would clip a child's background at the rounded corners: overflow on an
       ancestor makes position:sticky a no-op against the viewport, and the
       file's bar has to stick. The clipping job moves to .fcard-last below,
       which is put on whichever child renders last. */
    /* The whole card toggles, so the whole card says so — except the parts
       that are for reading rather than pressing. A diff you are selecting
       from must not collapse under the pointer. */
    .fcard { border: 1px solid var(--rule); border-radius: 5px; margin-bottom: 0.5rem; background: var(--panel); cursor: pointer; }
    .fcard .dlines, .fcard .askpanel, .fcard .note { cursor: auto; }
    /* Sticks while its own file is on screen, and is pushed off by the next
       card's bar — the card is the containing block, so it cannot outlive it.
       It already has a solid background, so the diff scrolls under it rather
       than through it. */
    /* The bar was one button. It cannot stay one now that it carries a
       control of its own: a button inside a button is invalid, and the inner
       one stops working in some browsers. So the bar is a row, and the part
       that opens the file is a button filling it — which is also what keeps
       the path truncating rather than pushing the controls off the end. */
    .fbar {
      display: flex; align-items: center; gap: 0.5rem; width: 100%;
      padding: 0.45rem 0.55rem; background: var(--sunk);
      position: sticky; top: 0; z-index: 5;
      border-radius: 4px 4px 0 0;
    }
    /* Shrinks but does not grow, so what follows it sits against the path
       rather than against the right edge. The gap between is still part of the
       bar, and clicking it still folds the file — the card's own handler
       catches that. */
    .fbar-toggle {
      display: flex; align-items: center; gap: 0.5rem; flex: 0 1 auto; min-width: 0;
      padding: 0; margin: 0; border: none; background: none;
      font: inherit; color: inherit; text-align: left; cursor: pointer;
    }
    /* A labelled control, not a glyph. This is the one thing on the card the
       page most wants a reader to discover, and a bare question mark asked
       them to guess. */
    .fask {
      display: inline-flex; align-items: center; gap: 0.3rem; flex: none;
      font: 600 11.5px/1.7 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: var(--slate); background: none;
      border: 1px solid var(--rule-strong); border-radius: 4px;
      padding: 0.05rem 0.45rem 0.05rem 0.35rem; cursor: pointer;
    }
    .fask:hover { background: var(--panel); color: var(--ink); border-color: var(--slate); filter: none; }
    .fask.on { color: var(--accent); border-color: var(--accent); }
    .fask svg { width: 13px; height: 13px; fill: currentColor; flex: none; }

    /* Copy is a glyph rather than a word: it is the one control here whose
       meaning a single icon actually carries, and it would otherwise crowd
       the two that need their labels. */
    .fcopy {
      display: inline-flex; align-items: center; justify-content: center; flex: none;
      width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px;
      background: none; color: var(--faint); cursor: pointer;
    }
    .fcopy:hover { background: var(--rule); color: var(--ink); filter: none; }
    .fcopy.done { color: var(--add); }
    .fcopy svg { width: 13px; height: 13px; fill: currentColor; }
    /* Sent somewhere else on the page rather than answered here, so it is a
       glyph beside Ask rather than a third word on the bar. */
    .ftochat { width: 24px; height: 24px; }
    .ftochat svg { width: 14px; height: 14px; }

    /* The only control on the bar that remembers anything. Its tick is
       filled rather than outlined so a scanned column of bars says how far
       through you are without reading a word. */
    .fviewed {
      display: inline-flex; align-items: center; gap: 0.3rem; flex: none;
      font: 500 11.5px/1.7 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: var(--muted); background: none;
      border: 1px solid var(--rule-strong); border-radius: 4px;
      padding: 0.05rem 0.45rem 0.05rem 0.35rem; cursor: pointer;
    }
    .fviewed:hover { background: var(--panel); color: var(--ink); filter: none; }
    .fviewed .box {
      width: 12px; height: 12px; flex: none; border-radius: 2px;
      border: 1px solid var(--rule-strong);
      display: inline-flex; align-items: center; justify-content: center;
    }
    /* On its way to GitHub. The tick has already moved, because waiting for a
       round trip before it does feels broken; this is what says the round trip
       is still happening. */
    /* A fact about the file, not something to press, so it sits with the path
       rather than among the controls. */
    .fcmt {
      display: inline-flex; align-items: center; gap: 0.25rem; flex: none;
      font: 600 11px/1.6 ui-monospace, monospace; color: var(--slate);
    }
    .fcmt svg { width: 12px; height: 12px; fill: currentColor; }
    .fviewed.busy { opacity: 0.55; cursor: wait; }
    .fviewed.on { color: var(--add); border-color: var(--add); }
    .fviewed.on .box { background: var(--add); border-color: var(--add); }
    .fviewed.on .box svg { width: 9px; height: 9px; fill: var(--panel); }
    /* A file you have seen keeps its place in the reading order — the acts
       only make sense in order — and stops competing for attention. */
    .fcard.seen .fbar-toggle, .fcard.seen .counts { opacity: 0.5; }
    .fcard.seen .fname { font-weight: 500; }
    .tree-file.seen { opacity: 0.45; }
    .tcmt {
      flex: none; font: 600 10px/1.5 ui-monospace, monospace; color: var(--slate);
      background: var(--sunk); border: 1px solid var(--rule); border-radius: 999px;
      padding: 0 0.3rem; margin-left: 0.2rem;
    }
    /* How far through, where the files are. */
    /* The two halves of the page, and the controls that belong to the whole
       review rather than to either. Modelled on the row GitHub puts above a
       diff, because the job is the same one. */
    .tabbar {
      display: flex; align-items: flex-end; gap: 1.1rem;
      border-bottom: 1px solid var(--rule); margin: 1.9rem 0 1.4rem;
    }
    .tab {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.5rem 0.15rem 0.6rem; margin-bottom: -1px;
      border: 0; border-bottom: 2px solid transparent; background: none;
      font: 600 13.5px/1.4 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: var(--muted); cursor: pointer;
    }
    .tab:hover { color: var(--ink); filter: none; }
    .tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
    .tab .n {
      font: 600 11px/1.5 ui-monospace, monospace; color: var(--muted);
      background: var(--sunk); border: 1px solid var(--rule);
      border-radius: 999px; padding: 0 0.42rem;
    }
    .tabbar .right { margin-left: auto; display: flex; align-items: center; gap: 0.7rem; padding-bottom: 0.45rem; }
    .tally {
      font: 500 11.5px/1.6 ui-monospace, monospace; letter-spacing: 0.04em; color: var(--faint);
    }
    .tally b { color: var(--add); font-weight: 600; }
    /* Nothing to read yet on this half — the box above already says whether
       that is because the analysis is running or because it failed. */
    .tabnote { color: var(--muted); font-size: 13.5px; padding: 1rem 0 2rem; }
    .loadingnote { display: flex; align-items: center; gap: 0.55rem; }
    .submit-review {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.35rem 0.85rem; font-size: 13px; border-radius: 5px;
    }
    .submit-review .n {
      font: 600 11px/1.5 ui-monospace, monospace; font-variant-numeric: tabular-nums;
      background: rgba(255, 255, 255, 0.25); border-radius: 999px; padding: 0 0.35rem;
    }
    /* Once a pull request is approved, merging is the next thing to do, so
       Submit review steps back to an outline beside it. */
    .submit-review.quiet { font-size: 13px; padding: 0.35rem 0.85rem; }
    /* GitHub's merge green, for the same reason the state pill is in GitHub's
       colours: it quotes a button people press on GitHub every day. */
    button.merge-pr {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.35rem 0.85rem; font-size: 13px; border-radius: 5px;
      background: #1f883d; color: #fff;
    }
    button.merge-pr:disabled { cursor: not-allowed; }
    /* Why an approved pull request has no merge button. */
    .mergehint { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .flash .flash-act { margin-left: 0.8rem; padding: 0.25rem 0.7rem; font-size: 12.5px; }
    .mergelist {
      list-style: none; margin: 0.9rem 0 0; padding: 0;
      display: flex; flex-direction: column; gap: 0.3rem; font-size: 13px;
    }
    .mergelist li { display: flex; gap: 0.5rem; align-items: baseline; }
    .mergelist .mark { width: 1rem; flex: none; text-align: center; font-weight: 700; }
    .mergelist .ok { color: var(--add); }
    .mergelist .no { color: var(--del); }
    .mergelist .wait { color: var(--warn); }
    .mergelabel { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 0.3rem; }
    #mergeSubject {
      width: 100%; padding: 0.5rem 0.65rem; font: inherit; font-size: 13.5px;
      border: 1px solid var(--rule-strong); border-radius: 4px; background: var(--panel); color: var(--ink);
    }
    .mergeblock {
      margin-top: 0.9rem; padding: 0.55rem 0.75rem; border-radius: 4px; font-size: 13px;
      background: var(--del-bg); color: var(--del); border-left: 3px solid var(--del);
    }

    /* The loudest thing on this page that writes to GitHub, so it is the only
       thing that takes the screen: a native dialog, for the escape key, the
       focus trap and the backdrop that come with it. */
    .sheet {
      width: min(40rem, calc(100vw - 2rem)); padding: 0; border: 1px solid var(--rule-strong);
      border-radius: 8px; background: var(--panel); color: var(--ink);
      box-shadow: 6px 8px 28px rgba(27, 34, 50, 0.18);
    }
    .sheet::backdrop { background: rgba(27, 34, 50, 0.45); }
    .sheet-head {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.85rem 1rem; border-bottom: 1px solid var(--rule);
    }
    .sheet-head b { font-family: Merriweather, Georgia, serif; font-size: 1rem; flex: 1; min-width: 0; }
    .sheet-x {
      display: flex; align-items: center; justify-content: center; flex: none;
      width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px;
      background: none; color: var(--faint); cursor: pointer; font-size: 17px; line-height: 1;
    }
    .sheet-x:hover { background: var(--sunk); color: var(--ink); filter: none; }
    .sheet-body { padding: 1rem; }
    .sheet-body textarea {
      width: 100%; resize: vertical; padding: 0.55rem 0.65rem; font: inherit; font-size: 13.5px;
      line-height: 1.5; border: 1px solid var(--rule-strong); border-radius: 4px;
      background: var(--panel); color: var(--ink);
    }
    .sheet-choice { display: flex; gap: 0.6rem; margin-top: 0.9rem; cursor: pointer; }
    .sheet-choice input { margin-top: 0.25rem; flex: none; accent-color: var(--accent); }
    .sheet-choice b { display: block; font-size: 13.5px; }
    .sheet-choice span { display: block; font-size: 12.5px; color: var(--muted); }
    /* Said once, plainly, because nothing else on this page leaves the box. */
    .sheet-where {
      margin: 1.1rem 0 0; padding-top: 0.8rem; border-top: 1px solid var(--rule);
      font-size: 12.5px; color: var(--muted);
    }
    .sheet-foot {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.8rem 1rem; border-top: 1px solid var(--rule); background: var(--sunk);
      border-radius: 0 0 7px 7px;
    }
    .sheet-foot .grow { flex: 1; min-width: 0; font-size: 12.5px; color: var(--del); }
    .sheet-foot .quiet { font-size: 13px; padding: 0.45rem 0.9rem; }
    .sheet-foot .go { padding: 0.45rem 1rem; font-size: 13px; border-radius: 5px; }
    /* The house style for destructive: red text on white, not a red button.
       Nothing here is unrecoverable — the diff and the branch survive — so it
       should not shout like something that is. */
    /* Left of everything else, away from Submit, because it destroys written
       work and the two should not be neighbours. */
    .sheet-foot .drop {
      margin-right: auto; background: none; color: var(--del);
      border: 1px solid transparent; font-size: 13px; padding: 0.45rem 0.7rem; border-radius: 5px;
    }
    .sheet-foot .drop:hover { background: var(--del-bg); border-color: var(--del); filter: none; }
    .sheet-foot .drop.sure { border-color: var(--del); background: var(--del-bg); }

    /* What is about to go out, so the discard above has something to be about
       and the submit below is not a leap of faith. */
    .pending {
      margin-top: 1rem; border: 1px solid var(--rule); border-radius: 5px;
      max-height: 12rem; overflow-y: auto;
    }
    .pending-head {
      padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--rule); background: var(--sunk);
      font: 600 11px/1.6 ui-monospace, monospace; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted);
    }
    .pending-one { padding: 0.45rem 0.6rem; border-top: 1px solid var(--rule); }
    .pending-one:first-of-type { border-top: none; }
    .pending-one .at {
      font: 11.5px/1.6 ui-monospace, monospace; color: var(--slate); display: block;
    }
    .pending-one .said {
      font-size: 13px; line-height: 1.5; color: var(--ink);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .sheet-foot .danger { background: none; color: var(--del); border: 1px solid var(--del); }
    .sheet-foot .danger:hover { background: var(--del-bg); filter: none; }
    .sheet-body ul { margin: 0.6rem 0 0; padding-left: 1.1rem; font-size: 13.5px; line-height: 1.7; }
    .sheet-body .keeps {
      color: var(--muted); font-size: 13px;
      margin-top: 0.9rem; padding-top: 0.8rem; border-top: 1px solid var(--rule);
    }
    /* Said where the pointer already is, rather than in a strip at the top of
       a page the reader has scrolled away from. */
    /* Only a posted verdict reaches this, and a verdict going out is the one
       thing on the page worth saying twice. */
    .flash {
      background: var(--add-bg); color: var(--add); border-left: 3px solid var(--add);
      padding: 0.7rem 0.85rem; border-radius: 4px; margin-bottom: 1.25rem; font-size: 14px;
    }
    /* The card no longer clips, so the last child rounds its own bottom
       corners — without this the final diff row's --add-bg/--del-bg squares
       them off. Applied by renderFile to whatever ends up last.

       It used to do that with overflow:hidden, which also clipped every
       tooltip inside the diff: a comment's Delete sits near the right edge of
       a card, and its tip was cut off at the card's border with half a
       sentence showing. Rounding the last descendant instead costs two more
       selectors and clips nothing. */
    .fcard-last { border-radius: 0 0 4px 4px; }
    .fcard-last > :last-child,
    .fcard-last > :last-child > :last-child {
      border-bottom-left-radius: 4px; border-bottom-right-radius: 4px;
    }
    .fbar:hover { background: var(--rule); }
    .chev { color: var(--faint); font-size: 10px; width: 0.7rem; flex: none; }
    /* The basename is what you navigate by, so it never truncates; the
       directory ahead of it does. */
    .fpath {
      display: flex; align-items: baseline; min-width: 0;
      font: 12.5px/1.4 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .fpath .fdir {
      color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fpath .fname { font-weight: 600; flex: none; }
    .counts {
      margin-left: auto; flex: none; white-space: nowrap;
      font: 11.5px/1.4 ui-monospace, monospace; font-variant-numeric: tabular-nums;
    }
    .counts .p { color: var(--add); }
    .counts .m { color: var(--del); margin-left: 0.3rem; }
    .chip {
      flex: none; font: 600 9.5px/1.6 ui-monospace, monospace; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted);
      border: 1px solid var(--rule-strong); border-radius: 3px; padding: 0 0.3rem;
    }
    .chip.added { color: var(--add); }
    .chip.deleted { color: var(--del); }
    .preamble {
      /* Inside a full-width card, so the text holds the measure while the
         bar above it and the diff below keep the card's width. */
      max-width: var(--prose-measure);
      font-size: 13.5px; line-height: 1.55; color: var(--ink);
      padding: 0.6rem 0.8rem 0.6rem 1.8rem; border-top: 1px solid var(--rule);
    }
    .preamble.none { color: var(--faint); font-style: italic; }
    .note {
      padding: 0.7rem; border-top: 1px solid var(--rule);
      font-size: 13px; color: var(--muted);
    }

    /* --- diff --- */
    .dlines {
      border-top: 1px solid var(--rule);
      font: 12px/1.6 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .dhunk {
      background: var(--sunk); color: var(--faint); font-size: 11px;
      padding: 0.2rem 0.6rem; border-bottom: 1px solid var(--rule); border-top: 1px solid var(--rule);
      white-space: pre-wrap; word-break: break-word;
    }
    .dlines > .dhunk:first-child { border-top: none; }
    /* Five columns, one per child, all auto-placed in source order:
       old number, new number, ask button, +/- sign, code. The ask button gets
       a column of its own so showing it never reflows the code beside it. */
    .dl { display: grid; grid-template-columns: 2.7rem 2.7rem 1.4rem 1.1rem 1fr; align-items: start; }
    .dl .ln {
      color: var(--faint); text-align: right; padding: 0 0.4rem; font-size: 11px;
      font-variant-numeric: tabular-nums; user-select: none;
    }
    .dl .sg { color: var(--faint); text-align: center; user-select: none; }
    /* pre-wrap rather than a horizontal scroller: the page must never scroll
       sideways on a phone, and a wrapped long line is far better than a
       diff you have to pan across. */
    .dl .tx { padding-right: 0.5rem; white-space: pre-wrap; word-break: break-word; }
    .dl.add { background: var(--add-bg); }
    .dl.add .sg { color: var(--add); }
    .dl.del { background: var(--del-bg); }
    .dl.del .sg { color: var(--del); }
    .dl.add .word { background: var(--add-word); border-radius: 2px; }
    .dl.del .word { background: var(--del-word); border-radius: 2px; }
    .tk-c { color: var(--code-comment); font-style: italic; }
    .tk-s { color: var(--code-string); }
    .tk-k { color: var(--code-keyword); font-weight: 600; }

    /* The ask button lives in its own grid column so it never reflows the
       code when it appears. Visibility is split by input capability, because
       one setting cannot serve both: on a phone there is no hover, so a
       hidden button is an unreachable button; on a desktop a permanently
       visible one puts a column of question marks down the middle of every
       diff. Reserve the column either way so nothing shifts. */
    .dl .ask {
      display: flex; align-items: center; justify-content: center;
      background: none; border: none; padding: 0;
      color: var(--slate); cursor: pointer; opacity: 0.3;
    }
    .dl .ask svg { width: 13px; height: 13px; fill: currentColor; }
    @media (hover: hover) {
      .dl .ask { opacity: 0; }
      .dl:hover .ask { opacity: 0.55; }
      .dl .ask:hover { opacity: 1; }
    }
    /* Keyboard users must always be able to see where they are. */
    .dl .ask:focus-visible { opacity: 1; }
    .dl .ask.on { opacity: 1; color: var(--accent); }

    /* One control per row, and the whole interaction hangs off it: click to
       pick a line, shift-click or drag to take a span, then choose what to do
       with it. Two per-row buttons were tried first — a robot and a bubble —
       and they asked a reader to decide which thing they wanted before they
       had decided which lines they meant. */
    .dl .pick {
      display: flex; align-items: center; justify-content: center;
      background: none; border: none; padding: 0;
      color: var(--slate); cursor: pointer; opacity: 0.3;
      font: 600 13px/1 ui-monospace, monospace;
    }
    @media (hover: hover) {
      .dl .pick { opacity: 0; }
      .dl:hover .pick { opacity: 0.55; }
      .dl .pick:hover { opacity: 1; }
    }
    .dl .pick:focus-visible { opacity: 1; }
    .dl.picked { background: var(--pick-bg, rgba(232, 125, 9, 0.09)); }
    .dl.picked .pick { opacity: 1; color: var(--accent); }

    /* What to do with the lines, once there are some. */
    .pickbar {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      margin: 0.35rem 0.7rem 0.5rem 7rem; padding: 0.45rem 0.6rem;
      border: 1px solid var(--accent); border-radius: 6px; background: var(--panel);
    }
    .pickbar .where {
      font: 600 11.5px/1.6 ui-monospace, monospace; color: var(--muted); flex: 1; min-width: 0;
    }
    .pickbar button {
      display: inline-flex; align-items: center; gap: 0.35rem; flex: none;
      padding: 0.3rem 0.7rem; font-size: 12.5px; border-radius: 4px;
    }
    .pickbar button svg { width: 12px; height: 12px; fill: currentColor; }
    .pickbar .quiet { font-size: 12.5px; padding: 0.25rem 0.6rem; }
    @media (max-width: 560px) { .pickbar { margin-left: 1rem; } }

    /* --- draft comments --- */
    /* A comment is a person's, so it sits in the page's own type rather than
       the diff's monospace, indented past the gutter to the code it is about. */
    .cmtbox {
      margin: 0.35rem 0.7rem 0.5rem 7rem;
      border: 1px solid var(--rule-strong); border-radius: 6px;
      background: var(--panel);
    }
    .cmtbox.draft { border-color: var(--accent); }
    /* Settled conversations step back rather than disappear: still readable,
       no longer competing with the line they sit under. */
    .cmtbox.resolved { opacity: 0.6; }
    .cmtbox.stale { border-style: dashed; }
    .cmtbox .cmthead + .cmtbody + .cmthead { border-top: 1px solid var(--rule); }
    .cmtlink {
      font: 600 11.5px/1.6 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: var(--slate); text-decoration: none; padding: 0.1rem 0.3rem; border-radius: 4px;
    }
    .cmtlink:hover { background: var(--sunk); color: var(--ink); }
    .cmthead {
      display: flex; align-items: center; gap: 0.45rem;
      padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--rule);
      font: 600 11.5px/1.6 "Red Hat Display", -apple-system, system-ui, sans-serif;
      color: var(--muted);
    }
    .cmthead .who { color: var(--ink); }
    .cmthead .pending {
      font: 600 9.5px/1.6 ui-monospace, monospace; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--accent);
      border: 1px solid var(--accent); border-radius: 3px; padding: 0 0.3rem;
    }
    .cmthead .stale {
      font: 600 9.5px/1.6 ui-monospace, monospace; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted);
      border: 1px solid var(--rule-strong); border-radius: 3px; padding: 0 0.3rem;
    }
    .cmthead .grow { flex: 1; }
    .cmthead button {
      background: none; border: 0; padding: 0.1rem 0.3rem; border-radius: 4px;
      font: inherit; font-size: 11.5px; color: var(--del); cursor: pointer;
    }
    .cmthead button:hover { background: var(--del-bg); filter: none; }
    .cmthead button.sure { background: var(--del-bg); border: 1px solid var(--del); }
    /* The diff around it is monospace and a comment is not code, so the family
       has to be said rather than inherited. */
    .cmtbody {
      padding: 0.55rem 0.6rem; color: var(--ink);
      font: 13.5px/1.55 "Red Hat Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    .cmtbody p { margin-bottom: 0.5rem; }
    .cmtbody p:last-child { margin-bottom: 0; }
    .cmtform { padding: 0.55rem 0.6rem; }
    .cmtform textarea {
      width: 100%; resize: vertical; min-height: 4.5rem; padding: 0.45rem 0.55rem;
      font: inherit; font-size: 13.5px; line-height: 1.5;
      border: 1px solid var(--rule-strong); border-radius: 4px;
      background: var(--panel); color: var(--ink);
    }
    .cmthint {
      margin-top: 0.4rem;
      font: 11.5px/1.5 "Red Hat Display", -apple-system, system-ui, sans-serif; color: var(--faint);
    }
    .cmtrow { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
    .cmtrow .grow { flex: 1; min-width: 0; font-size: 12px; color: var(--del); }
    .cmtrow button { padding: 0.35rem 0.8rem; font-size: 12.5px; border-radius: 4px; }
    .cmtrow .quiet { font-size: 12.5px; padding: 0.3rem 0.7rem; }
    @media (max-width: 560px) { .cmtbox { margin-left: 1rem; } }

    /* --- ask panel --- */
    .askpanel {
      border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
      border-left: 2px solid var(--slate);
      background: var(--sunk); padding: 0.65rem 0.7rem;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    .askwhere {
      display: flex; align-items: center; gap: 0.4rem;
      font: 11px/1.5 ui-monospace, monospace; color: var(--faint); margin-bottom: 0.4rem;
    }
    .askwhere .grow { flex: 1; min-width: 0; }
    /* The panel used to be closed by pressing the same control that opened it.
       Once that control became the line picker there was nothing left that
       closed it, and a reader who had asked a question was stuck with the
       panel and a highlighted span they could not clear. */
    .askwhere button {
      background: none; border: 0; padding: 0 0.25rem; border-radius: 4px;
      font: inherit; font-size: 14px; line-height: 1; color: var(--faint); cursor: pointer;
    }
    .askwhere button:hover { background: var(--rule); color: var(--ink); filter: none; }
    .askrow { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .askrow input {
      flex: 1; min-width: 10rem; padding: 0.4rem 0.5rem; font: inherit; font-size: 13px;
      border: 1px solid var(--rule-strong); border-radius: 4px;
      background: var(--panel); color: var(--ink);
    }
    .askrow button { padding: 0.4rem 0.8rem; font-size: 13px; }
    .aska { font-size: 13.5px; line-height: 1.6; margin-bottom: 0.6rem; }
    .aska:empty { display: none; }
    .askq {
      margin: 0.5rem 0 0.2rem; padding: 0.3rem 0.5rem; border-radius: 4px;
      background: var(--panel); color: var(--ink); font-size: 13px; white-space: pre-wrap;
    }
    .askq:first-child { margin-top: 0; }
    .askerr { color: var(--del); margin: 0.4rem 0 0; }
    /* The panel sits on --sunk already, so the code background steps up. */
    .prose a { color: var(--slate); }
    .prose a:hover { color: var(--ink); }
    .aska code, .aska pre { background: var(--panel); }
    .askfoot { font: 11px/1.5 ui-monospace, monospace; color: var(--faint); margin-top: 0.5rem; }
    .askwait {
      display: flex; align-items: center; gap: 0.4rem;
      font: 12px/1.5 ui-monospace, monospace; color: var(--muted); margin-top: 0.5rem;
    }

    .empty { color: var(--faint); font-style: italic; font-size: 13px; padding: 1rem 0; }
    /* A footnote to the diff, not a notice about it: quiet, at the end, where
       somebody who has finished reading will find it and nobody else is
       interrupted by it. */
    .leftout {
      margin-top: 1.4rem; padding-top: 0.9rem; border-top: 1px solid var(--rule);
      font-size: 12.5px; line-height: 1.55; color: var(--faint);
    }
    .leftout b { color: var(--muted); font-weight: 600; }
    .leftout a { color: var(--slate); }

    /* Phones. The old-line-number column is the first thing to go — the new
       numbering is what anyone actually navigates by. */
    @media (max-width: 560px) {
      body { padding: 1.25rem 0.6rem 4rem; }
      /* The old-side number is the first thing to go: you navigate by the new
         numbering, and the column is worth ~15% of a phone's width. */
      .dl { grid-template-columns: 2.4rem 1.4rem 1.1rem 1fr; }
      .dl .ln.old { display: none; }
      .preamble { padding-left: 0.7rem; }
      .act-why { margin-left: 0; }
      /* The bar carries four controls and a path. On a phone the path is the
         thing that has to give: the directory goes, and the basename
         truncates, rather than the controls overlapping it. */
      .fpath .fdir { display: none; }
      .fpath .fname { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fbar .chip { display: none; }
      .counts { display: none; }
      /* The label wraps to three lines at this width; a tab that reads down
         the page is worse than one that scrolls off it. */
      .tabbar { flex-wrap: wrap; row-gap: 0.2rem; }
      .tab { white-space: nowrap; }
      .tabbar .right { width: 100%; justify-content: flex-end; }
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
  </style>
</head>
<body>
  <!-- Hidden when the launcher embeds this page in its pane: there is nothing
       to go back to, and following it would load the launcher inside the pane
       it is already in. See the embed check in the script below. -->
  <a class="backlink" id="backlink" href="/">&larr; Woodshed</a>
  <div id="error" class="err" hidden></div>
  <div id="flash" class="flash" hidden></div>
  <dialog class="sheet" id="discardSheet" aria-labelledby="discardTitle">
    <div class="sheet-head">
      <b id="discardTitle">Discard this review?</b>
      <button type="button" class="sheet-x" id="discardX" aria-label="Close">&times;</button>
    </div>
    <div class="sheet-body">
      <div>This throws away, for this review:</div>
      <ul>
        <li>the overview, questions, decisions, architecture and reading order</li>
        <li>the conversation about the change</li>
      </ul>
      <div class="keeps" id="discardKeeps"></div>
    </div>
    <div class="sheet-foot">
      <span class="grow" id="discardErr"></span>
      <button type="button" class="quiet" id="discardCancel">Cancel</button>
      <button type="button" class="go danger" id="discardGo">Discard</button>
    </div>
  </dialog>
  <dialog class="sheet" id="submitSheet" aria-labelledby="sheetTitle">
    <div class="sheet-head">
      <b id="sheetTitle">Finish your review</b>
      <button type="button" class="sheet-x" id="sheetClose" aria-label="Close">&times;</button>
    </div>
    <div class="sheet-body">
      <textarea id="sheetBody" rows="6" placeholder="Leave a comment" aria-label="Your review comment"></textarea>
      <label class="sheet-choice">
        <input type="radio" name="reviewEvent" value="comment" checked>
        <span><b>Comment</b><span>Submit general feedback without explicit approval.</span></span>
      </label>
      <label class="sheet-choice">
        <input type="radio" name="reviewEvent" value="approve">
        <span><b>Approve</b><span>Submit feedback and approve merging these changes.</span></span>
      </label>
      <label class="sheet-choice">
        <input type="radio" name="reviewEvent" value="request-changes">
        <span><b>Request changes</b><span>Submit feedback suggesting changes.</span></span>
      </label>
      <div id="sheetPending"></div>
      <p class="sheet-where" id="sheetWhere"></p>
    </div>
    <div class="sheet-foot">
      <button type="button" class="drop" id="sheetDrop" hidden>Discard review</button>
      <span class="grow" id="sheetErr"></span>
      <button type="button" class="quiet" id="sheetCancel">Cancel</button>
      <button type="button" class="go" id="sheetGo">Submit review</button>
    </div>
  </dialog>
  <dialog class="sheet" id="mergeSheet" aria-labelledby="mergeTitle">
    <div class="sheet-head">
      <b id="mergeTitle">Squash and merge</b>
      <button type="button" class="sheet-x" id="mergeX" aria-label="Close">&times;</button>
    </div>
    <div class="sheet-body">
      <div id="mergeSubjectRow" hidden>
        <label class="mergelabel" for="mergeSubject">Commit title</label>
        <input type="text" id="mergeSubject" maxlength="256" autocomplete="off">
      </div>
      <ul class="mergelist" id="mergeList"></ul>
      <div id="mergeBlock"></div>
      <p class="sheet-where" id="mergeWhere"></p>
    </div>
    <div class="sheet-foot">
      <span class="grow" id="mergeErr"></span>
      <button type="button" class="quiet" id="mergeCancel">Cancel</button>
      <button type="button" class="go merge-pr" id="mergeGo" disabled>Squash and merge</button>
    </div>
  </dialog>
  <div class="layout" id="layout">
    <div id="content"></div>
    <aside class="chat" id="chat" aria-label="Chat about this change" hidden>
      <div class="chat-grip" id="chatGrip" role="separator" aria-orientation="vertical"
        aria-label="Resize the conversation" tabindex="0"
        title="Drag to resize. Double-click to reset."></div>
      <div class="chat-head">
        <b>Talk about this change</b>
        <button type="button" class="chat-collapse" id="chatClose"
          title="Collapse the conversation" aria-label="Collapse the conversation">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 0 1 0-1.06Z"/>
            <rect x="12" y="3" width="1.5" height="10" rx=".75"/>
          </svg>
        </button>
      </div>
      <div class="chat-log" id="chatLog"></div>
      <form class="chat-form" id="chatForm">
        <textarea id="chatInput" rows="1" placeholder="Ask anything about this change" aria-label="Your message"></textarea>
        <button type="submit" id="chatSend">Send</button>
      </form>
    </aside>
  </div>
  <button type="button" class="chat-rail" id="chatOpen" hidden
    title="Talk about this change" aria-label="Open the conversation">
    <svg class="rail-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.78 12.78a.75.75 0 0 1-1.06 0L5.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 1 1 1.06 1.06L7.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"/>
    </svg>
    <svg class="rail-bubble" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
    </svg>
    <span class="rail-label">Talk about this change</span>
  </button>

  <script>
    // Inlined from review/highlight.mjs so the tokenizer has exactly one
    // source of truth. It must be self-contained — see the note in that file.
    ${tokenizeLine.toString()}

    // Inlined from review/askState.mjs, same contract, same reason: it is unit
    // tested there, and this page is the only thing that runs it.
    ${createAskState.toString()}

    // The launcher owns the theme for both pages. It is the same origin, so
    // its choice is readable here directly rather than passed through the
    // frame URL — which also means a review opened in its own tab matches the
    // launcher the viewer set it from. The storage event fires in every OTHER
    // document of the origin, so toggling in the launcher repaints this frame
    // without a reload; the launcher's own root is stamped by its own handler.
    function followLauncherTheme() {
      var choice = null;
      try {
        choice = localStorage.getItem('shed.theme');
      } catch (e) {
        // A browser with site data blocked. The device query still applies.
      }
      if (choice === 'dark' || choice === 'light') document.documentElement.dataset.theme = choice;
      else document.documentElement.removeAttribute('data-theme');
    }
    followLauncherTheme();
    window.addEventListener('storage', function onThemeChange(ev) {
      // A null key is a clear(); anything else is only our business when it
      // is the theme.
      if (!ev || ev.key === null || ev.key === 'shed.theme') followLauncherTheme();
      // The same sheet owns how a review opens. Repaint rather than reload:
      // a reader with files open and a question half-typed should keep both.
      if (!ev || ev.key === null || ev.key === 'shed.review.expand') {
        if (state.meta) render();
      }
    });

    // Both icon builders below draw with it, and they sit far apart.
    var SVG_NS = 'http://www.w3.org/2000/svg';

    var state = {
      session: null, meta: null, diff: null, review: null, status: null,
      // Which half of the page is on screen. The prose and the diff are two
      // different jobs — read what was done, then check it — and the tree
      // belongs only to the second. It rides in the URL so a link can point
      // at either.
      tab: 'analysis',
      // Whether the harness's total_cost_usd means money here. False on an
      // OAuth subscription, where it is a notional API-rate valuation and
      // showing it implies a bill that does not exist.
      showCosts: false,
    };
    // Explicit per-file state only. A path absent from here follows the
    // launcher's setting, so switching that moves every file the reader has
    // not touched and leaves the ones they have.
    var openFiles = {};

    // The draft review living on GitHub: its id, and the line comments in it.
    //
    // Not a note this page keeps, for the same reason the Viewed tick is not:
    // a comment written here shows up in GitHub's review UI at once, and one
    // written there shows up here, because there is only ever one draft.
    var draft = { prId: null, headSha: null, reviewId: null, description: null, comments: [], threads: [], outdated: 0, said: [] };
    // True until the first read from GitHub settles, either way. The
    // Discussion tab is empty until then, and empty has to look like waiting
    // rather than like a pull request nobody has said anything on.
    var draftLoading = false;
    // Which line is being written on, and what has been typed there. Keyed by
    // the same anchor the ask panel uses, so it survives a re-render.
    var composingAt = null;
    var composeDraft = '';

    // Which lines are picked out, if any: one file, one side of the diff, and
    // a span. GitHub's model, because it is the one that maps onto what can be
    // done with a selection — a comment takes a span, and so, now, does a
    // question.
    var picked = null;

    function pickedRange() {
      if (!picked) return null;
      var from = Math.min(picked.from, picked.to);
      var to = Math.max(picked.from, picked.to);
      return { path: picked.path, side: picked.side, from: from, to: to };
    }

    function isPicked(file, line) {
      var range = pickedRange();
      if (!range || range.path !== file.path) return false;
      var no = line.newNo !== null ? line.newNo : line.oldNo;
      var side = line.newNo !== null ? 'new' : 'old';
      return side === range.side && no >= range.from && no <= range.to;
    }

    // The last row of the selection, which is where the bar goes.
    function isPickEnd(file, line) {
      var range = pickedRange();
      if (!range || range.path !== file.path) return false;
      var no = line.newNo !== null ? line.newNo : line.oldNo;
      var side = line.newNo !== null ? 'new' : 'old';
      return side === range.side && no === range.to;
    }

    function clearPick() {
      picked = null;
      pickAction = null;
      render();
    }

    // Which composer the selection has been pointed at: null, 'comment' or
    // 'ask'. Separate from the selection so choosing one does not lose the lines.
    var pickAction = null;
    // Live while the pointer is down on a row control.
    var dragging = null;
    window.addEventListener('pointerup', function endDrag() { dragging = null; });

    // Both of these are GitHub's state, and GitHub is a tab away. Ticking a
    // file or writing a comment over there and coming back here has to show
    // it, or the two look out of step and neither can be trusted. Reading on
    // load alone was not enough: the commonest way to use this is with both
    // open side by side.
    document.addEventListener('visibilitychange', function onBack() {
      if (document.hidden || !state.session || !state.livePr) return;
      loadViewed().then(render).catch(function ignore() {});
      loadDraft().then(render).catch(function ignore() {});
    });

    // One key out of every transient thing on this page. A composer or a
    // dialog handles its own Escape and stops it here; what reaches this is a
    // selection or an open question with nothing focused, which is exactly the
    // state a reader gets stuck in.
    window.addEventListener('keydown', function onEscape(ev) {
      if (ev.key !== 'Escape' || ev.defaultPrevented) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (!ask.openAnchor() && !picked) return;
      ask.close();
      clearPick();
    });

    async function loadDraft() {
      draft = { prId: null, headSha: null, reviewId: null, description: null, comments: [], threads: [], outdated: 0, said: [] };
      if (!state.session || !state.livePr) return;
      var got = await api('GET', '/reviews/' + state.session + '/comments');
      draft = {
        prId: got.prId || null,
        headSha: got.headSha || null,
        reviewId: got.reviewId || null,
        description: got.description || null,
        comments: got.comments || [],
        threads: got.threads || [],
        outdated: got.outdated || 0,
        said: got.said || [],
        truncated: !!got.truncated,
      };
      // Better said than drawn: part of a conversation shown as the whole one
      // is the kind of wrong a reader cannot see.
      if (draft.truncated) {
        showFlash('This pull request has more comments than the page reads in one go. Some are only on GitHub.');
      }
    }

    // Every conversation that belongs beside this row: other people's,
    // yours from an earlier review, and your unsent drafts. Not only the
    // drafts — a page that showed just those would hide every comment already
    // on the pull request, which is most of what a reviewer comes back for.
    function threadsOn(file, line) {
      if (!draft.threads.length || !line) return [];
      var no = line.newNo !== null ? line.newNo : line.oldNo;
      var side = line.newNo !== null ? 'new' : 'old';
      var out = [];
      for (var i = 0; i < draft.threads.length; i++) {
        var t = draft.threads[i];
        if (t.path === file.path && t.line === no && t.side === side) out.push(t);
      }
      return out;
    }

    // How many conversations this file is carrying, wherever they sit. A
    // folded file draws none of them, so without this a comment on a file you
    // have not opened is invisible — which is most of them, most of the time.
    function threadCountFor(file) {
      var n = 0;
      for (var i = 0; i < draft.threads.length; i++) {
        if (draft.threads[i].path === file.path) n += 1;
      }
      return n;
    }

    // Which files this account has ticked on the pull request.
    //
    // GitHub's own state, read from it and written back to it, not a note this
    // page keeps. Ticking here and ticking on github.com have to be the same
    // act: two sets of ticks that drift apart are worse than one set, because
    // neither can be trusted and the reader has no way to tell which is stale.
    //
    // This replaced a browser-local version that stored each file's +/- counts
    // so it could drop a mark when the file changed underneath it. That was an
    // approximation of what GitHub does natively, and it is gone: GitHub
    // un-ticks a file whose content moved, and now so does this.
    var viewedMarks = {};
    // The pull request's GraphQL node id, which every tick needs. Handed over
    // by the read so a tick costs one round trip rather than two.
    var viewedPrId = null;

    async function loadViewed() {
      viewedMarks = {};
      viewedPrId = null;
      if (!state.session || !state.livePr) return;
      var got = await api('GET', '/reviews/' + state.session + '/viewed');
      var marks = {};
      for (var i = 0; i < (got.viewed || []).length; i++) marks[got.viewed[i]] = true;
      viewedMarks = marks;
      viewedPrId = got.prId || null;
    }

    // Viewed is a pull request reviewer's own bookkeeping — the thing that
    // lets a fourteen-file review be put down and picked up. A branch with no
    // pull request has nowhere to keep it, so it does without.
    //
    // The gate is here rather than only at the control, so everything the
    // mark drives stands down with it: the tally, the dimmed bar, the dimmed
    // tree row and the fold.
    function marksViewed() {
      return !!state.livePr;
    }

    function isViewed(file) {
      return marksViewed() && !!viewedMarks[file.path];
    }

    // Optimistic, and put back if GitHub refuses. A tick is a round trip, and
    // a checkbox that waits for one before moving feels broken; the case it
    // has to be honest about is a worktree review showing a file that has not
    // been pushed, which the pull request does not contain and GitHub will not
    // tick.
    // Paths with a tick still on its way to GitHub. A round trip here is
    // two gh spawns and takes a couple of seconds, which is long enough that
    // someone who ticks a file and immediately looks at github.com sees
    // nothing and concludes it does not sync. The control says it is working.
    var viewedInFlight = {};

    function setViewed(file, on) {
      if (on) viewedMarks[file.path] = true;
      else delete viewedMarks[file.path];
      viewedInFlight[file.path] = true;
      api('POST', '/reviews/' + state.session + '/viewed', {
        path: file.path, viewed: on, prId: viewedPrId,
      }).then(function landed() {
        delete viewedInFlight[file.path];
        render();
      }).catch(function refused(e) {
        delete viewedInFlight[file.path];
        if (on) delete viewedMarks[file.path];
        else viewedMarks[file.path] = true;
        showFlash(e.message);
        render();
      });
    }

    function viewedCount() {
      var files = (state.diff && state.diff.files) || [];
      var seen = 0;
      for (var i = 0; i < files.length; i++) if (isViewed(files[i])) seen += 1;
      return { seen: seen, total: files.length };
    }

    // Every file's diff shows unless the reader folded them: 'collapsed'
    // folds them, anything else ('all', or nothing saved) opens them. Folded
    // by default, the diff was the hardest thing on the page to find. Written
    // by the launcher's settings sheet and by the files tab's own Fold all,
    // and read here the way the theme is: same origin, so the choice needs no
    // URL of its own, and a review opened in its own tab obeys it too.
    function expandsByDefault() {
      try {
        return localStorage.getItem('shed.review.expand') !== 'collapsed';
      } catch (e) {
        return true;
      }
    }

    function setExpandAll(open) {
      try {
        if (open) localStorage.removeItem('shed.review.expand');
        else localStorage.setItem('shed.review.expand', 'collapsed');
      } catch (e) {}
      // A file opened or folded by hand goes with the rest.
      openFiles = {};
      render();
    }

    function isFileOpen(path) {
      if (openFiles[path] !== undefined) return openFiles[path];
      var file = fileByPath()[path];
      // Marked seen outranks open-everything: the point of the mark is to get
      // the file out of the way.
      if (file && isViewed(file)) return false;
      return expandsByDefault();
    }
    // Directories folded shut in the tree, by path prefix. Survives a
    // render, which rebuilds the tree from scratch every time.
    var foldedDirs = {};
    // The file whose card is under the top of the viewport, as the tree shows it.
    var activePath = null;
    // Every piece of ask-panel state, and the only place any of it lives. See
    // review/askState.mjs for why it is a module rather than four variables.
    var ask = createAskState();
    var pollTimer = null;

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    }

    function loadingNote(text) {
      var note = el('div', 'tabnote loadingnote');
      note.appendChild(spinner());
      note.appendChild(el('span', null, text));
      return note;
    }

    function spinner() {
      var ring = el('span', 'spin');
      ring.setAttribute('aria-hidden', 'true');
      return ring;
    }

    function mono(text) { return el('span', 'mono', text); }

    function showError(msg) {
      var box = document.getElementById('error');
      box.textContent = msg;
      box.hidden = !msg;
    }

    async function api(method, url, body) {
      var opts = { method: method };
      if (body) {
        opts.headers = { 'content-type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      var res = await fetch(url, opts);
      var data;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error('the shed returned a non-JSON response (HTTP ' + res.status + ')');
      }
      if (!res.ok || data.ok === false) {
        var err = new Error(data.error || 'HTTP ' + res.status);
        // The merge sheet keys its wording on why a merge was refused.
        err.code = data.code || null;
        throw err;
      }
      return data;
    }

    // --- rendering ----------------------------------------------------------

    function fileByPath() {
      var map = {};
      var files = (state.diff && state.diff.files) || [];
      for (var i = 0; i < files.length; i++) map[files[i].path] = files[i];
      return map;
    }

    // The artifact's order where it has one, git order for anything it did not
    // place. Every file in the diff appears exactly once either way — a model
    // that omits or invents a path must never cost you a file.
    function groupsToRender() {
      var files = (state.diff && state.diff.files) || [];
      var review = state.review;
      if (!review || !review.groups || !review.groups.length) {
        return [{ title: null, why: null, files: files.map(function plain(f) {
          return { path: f.path, preamble: '', role: '' };
        }) }];
      }
      return review.groups;
    }

    function render() {
      var content = document.getElementById('content');
      // Emptying the page collapses its height, and the browser clamps the
      // scroll to whatever is left — so pressing anything that re-renders
      // threw the reader back to the top. Hiding a review from a panel forty
      // rows down is the case that found it. Put back after the rebuild, when
      // the page is tall again; the browser still clamps if the content
      // genuinely got shorter, which is the right answer.
      var wasAt = window.scrollY;
      function keepScroll() {
        if (window.scrollY !== wasAt) window.scrollTo(0, wasAt);
      }
      // Nothing is collected off the DOM before this wipes it. The ask panel is
      // the one thing a user can be mid-sentence in, and everything it holds —
      // the draft, the answer, which panel is open — lives in the askState
      // object, written as it happens rather than scraped back out here.
      // Scraping is what filed a draft under the wrong anchor twice.
      content.replaceChildren();
      if (!state.meta) return;

      content.appendChild(renderHeader());
      // The caveat and the run report, in one box. The caveat is always
      // there; the run report only while there is a run to report on, which
      // is why the divider belongs to it rather than to the box.
      var box = el('div', 'statebox');
      box.appendChild(state.meta.state === 'WORKTREE' ? worktreeNote() : targetNote());
      var status = renderStatus();
      if (status) {
        status.id = 'statusStrip';
        if (status.classList.contains('bad')) box.classList.add('bad');
        box.appendChild(status);
      }
      content.appendChild(box);

      var byPath = fileByPath();
      var fileCount = Object.keys(byPath).length;
      if (!fileCount) {
        content.appendChild(el('div', 'empty', 'This pull request has no file changes.'));
        keepScroll();
        return;
      }
      content.appendChild(renderTabs(fileCount));
      if (state.tab === 'discussion' && state.livePr) {
        renderDiscussion(content);
        keepScroll();
        return;
      }
      if (state.tab !== 'files') {
        renderAnalysis(content);
        keepScroll();
        return;
      }
      // Tree beside the cards, both inside the tab. Built fresh every render
      // like everything else here; nothing is read back off it.
      var split = el('div', 'filesplit');
      var aside = buildTree();
      if (aside) split.appendChild(aside);
      var list = el('div', 'filelist');
      list.appendChild(renderFilesBar());
      renderFiles(list, byPath);
      split.appendChild(list);
      content.appendChild(split);
      spy();
      keepScroll();
    }

    // The tabs, and beside them what acts on the review as a whole.
    function renderTabs(fileCount) {
      var bar = el('div', 'tabbar');
      bar.setAttribute('role', 'tablist');
      bar.appendChild(tabButton('analysis', 'Overview', null));
      // Only a pull request has a description and a discussion, so a branch
      // with none has no tab rather than an empty one.
      if (state.livePr) {
        bar.appendChild(tabButton('discussion', 'Discussion', draftLoading ? 'loading' : (draft.said.length || null)));
      }
      bar.appendChild(tabButton('files', 'Files changed', fileCount));
      var right = el('div', 'right');
      var tally = viewedCount();
      if (tally.seen) {
        var count = el('span', 'tally');
        count.appendChild(el('b', null, String(tally.seen)));
        count.appendChild(document.createTextNode(' of ' + tally.total + ' viewed'));
        right.appendChild(count);
      }
      // Only a pull request has somewhere for a verdict to go, and a branch
      // whose work GitHub has never been told about is not one. The control is
      // absent there rather than greyed: a disabled button is still something
      // to read past on every such review, and this page serves more of them
      // than it does pull requests.
      if (state.livePr) {
        var submit = el('button', 'submit-review');
        submit.type = 'button';
        submit.appendChild(el('span', null, 'Submit review'));
        // What is waiting to go out with the verdict. Without it a draft
        // written yesterday is invisible from the top of the page, which is
        // where the decision to submit gets made.
        if (draft.comments.length) submit.appendChild(el('span', 'n', String(draft.comments.length)));
        submit.addEventListener('click', openSubmitSheet);
        var merge = mergeControl();
        if (merge && merge.tagName === 'BUTTON') submit.classList.add('quiet');
        right.appendChild(submit);
        if (merge) right.appendChild(merge);
      }
      bar.appendChild(right);
      return bar;
    }

    function tabButton(name, label, count) {
      var tab = el('button', 'tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', state.tab === name ? 'true' : 'false');
      tab.appendChild(el('span', null, label));
      if (count === 'loading') tab.appendChild(spinner());
      else if (count !== null) tab.appendChild(el('span', 'n', String(count)));
      tab.addEventListener('click', function onTab() { showTab(name); });
      return tab;
    }

    function showTab(name) {
      if (state.tab === name) return;
      state.tab = name;
      // Pressed, so it earns a history entry: the two halves are two places,
      // and back out of the diff should land on the analysis rather than off
      // the page altogether.
      stampTab(true);
      render();
      // Each half has a scroll position of its own to a reader, and carrying
      // one over to the other lands them in the middle of something they have
      // not seen the top of. After the render, which now puts the scroll back
      // where it was.
      window.scrollTo(0, 0);
    }

    // Both halves name themselves in the URL, including the default one. A
    // link copied off the analysis half has to keep pointing at it even after
    // the page's default changes, and a bare ?session= that means "whichever
    // half is default" is not a link to anything in particular.
    function tabFromUrl(value) {
      return value === 'files' || value === 'analysis' || value === 'discussion' ? value : null;
    }

    function stampTab(push) {
      var url = new URL(window.location.href);
      url.searchParams.set('tab', state.tab);
      if (url.toString() === window.location.href) return;
      // Arriving is not a navigation; pressing a tab is. Stamping the default
      // on load with pushState would put an entry between the reader and
      // whatever they came from.
      if (push) history.pushState(null, '', url.toString());
      else history.replaceState(null, '', url.toString());
    }

    // Back and Forward move between the halves, because they are now entries.
    // The chat's own flag rides along: it is written with replaceState, so
    // whatever it was when this entry was pushed is what belongs with it.
    window.addEventListener('popstate', function onPop() {
      if (!state.session) return;
      var params = new URL(window.location.href).searchParams;
      var wanted = tabFromUrl(params.get('tab')) || 'analysis';
      if (wanted !== state.tab) {
        state.tab = wanted;
        render();
      }
      var wantChat = params.get('chat') === '1';
      if (wantChat !== chat.open) setChatOpen(wantChat);
    });

    // Puts the path in the composer rather than sending it. A path is not a
    // question, and what you want to ask about it is the half only you can
    // write — so this opens the conversation, hands you the reference and
    // leaves the caret after it. Press it on three files and ask once.
    function referenceInChat(path) {
      if (!chat.open) setChatOpen(true);
      var input = chatEls().input;
      var base = input.value;
      if (base && base.charAt(base.length - 1) !== ' ') base += ' ';
      // The bare path. It was wrapped in backticks at first, on the assumption
      // they would render as code — but a message you send is painted with
      // textContent, not through the markdown renderer the answers use, so
      // they only ever showed up as two stray characters in the box and two
      // more in the transcript.
      input.value = base + path + ' ';
      autosize(input);
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }

    function showFlash(msg, action) {
      var box = document.getElementById('flash');
      box.textContent = msg || '';
      box.hidden = !msg;
      if (msg && action) {
        var act = el('button', 'flash-act ' + (action.cls || ''), action.label);
        act.type = 'button';
        act.addEventListener('click', action.onClick);
        box.appendChild(act);
      }
    }

    function openSubmitSheet() {
      var sheet = document.getElementById('submitSheet');
      document.getElementById('sheetErr').textContent = '';
      // Named, not described. This is the last sentence read before something
      // is posted publicly, and "whichever account gh is signed in as" sent a
      // reader off to find out at the one moment they should not have to.
      var who = state.ghAccount
        ? 'as ' + state.ghAccount
        : 'as whichever account gh is signed in as on this box';
      var where = 'This posts publicly to pull request #' + state.livePr.number
        + ' on GitHub, ' + who + '.';
      if (draft.comments.length) {
        where += ' Your ' + draft.comments.length
          + (draft.comments.length === 1 ? ' draft comment goes' : ' draft comments go')
          + ' out with it.';
      }
      // A worktree review read the working tree, which is not what the pull
      // request shows: uncommitted work is in one and not the other. Saying so
      // here is the only place it can be said before a verdict goes out.
      if (state.kind !== 'pr') {
        where += ' What you have been reading is the working tree of this session, which may not match what the pull request shows.';
      }
      document.getElementById('sheetWhere').textContent = where;
      renderPendingList();
      // Two presses, in place. A second dialog on top of this one to confirm a
      // discard is a modal over a modal, and the thing being confirmed is
      // right there to read.
      var drop = document.getElementById('sheetDrop');
      drop.hidden = !draft.reviewId;
      drop.classList.remove('sure');
      drop.textContent = 'Discard review';
      sheet.showModal();
      document.getElementById('sheetBody').focus();
    }

    function renderPendingList() {
      var host = document.getElementById('sheetPending');
      host.replaceChildren();
      if (!draft.comments.length) return;
      var box = el('div', 'pending');
      box.appendChild(el('div', 'pending-head',
        draft.comments.length + (draft.comments.length === 1 ? ' pending comment' : ' pending comments')));
      for (var i = 0; i < draft.comments.length; i++) {
        var c = draft.comments[i];
        var one = el('div', 'pending-one');
        var at = c.startLine && c.startLine !== c.line
          ? c.path + ':' + c.startLine + '-' + c.line
          : c.path + ':' + c.line;
        one.appendChild(el('span', 'at', at));
        one.appendChild(el('div', 'said', c.body));
        box.appendChild(one);
      }
      host.appendChild(box);
    }

    function discardDraft() {
      var drop = document.getElementById('sheetDrop');
      // First press asks, second one does it. What it would throw away is
      // listed a few inches above, which is the whole reason this can be
      // confirmed in place rather than in another dialog.
      if (!drop.classList.contains('sure')) {
        drop.classList.add('sure');
        drop.textContent = 'Discard ' + draft.comments.length
          + (draft.comments.length === 1 ? ' comment?' : ' comments?');
        return;
      }
      drop.disabled = true;
      api('DELETE', '/reviews/' + state.session + '/comments', {
        all: true, reviewId: draft.reviewId,
      })
        .then(function gone() {
          drop.disabled = false;
          draft.reviewId = null;
          draft.comments = [];
          document.getElementById('submitSheet').close();
          showFlash('Draft review discarded. Nothing was posted.');
          render();
        })
        .catch(function failed(e) {
          drop.disabled = false;
          document.getElementById('sheetErr').textContent = e.message;
        });
    }

    function chosenEvent() {
      var picked = document.querySelector('input[name="reviewEvent"]:checked');
      return picked ? picked.value : 'comment';
    }

    function submitReview() {
      var sheet = document.getElementById('submitSheet');
      var go = document.getElementById('sheetGo');
      var problem = document.getElementById('sheetErr');
      var event = chosenEvent();
      var body = document.getElementById('sheetBody').value;
      problem.textContent = '';
      go.disabled = true;
      api('POST', '/reviews/' + state.session + '/submit', { event: event, body: body })
        .then(function posted() {
          go.disabled = false;
          sheet.close();
          document.getElementById('sheetBody').value = '';
          // An approval is usually the last thing standing between a pull
          // request and merging it, so the next step is offered right here.
          // The merge sheet asks GitHub afresh, so this local guess at the
          // new review state never decides anything on its own.
          if (event === 'approve') {
            state.livePr.review = 'approved';
            render();
            showFlash(SUBMIT_DONE[event] + ' on #' + state.livePr.number + '.',
              { label: 'Merge now', cls: 'merge-pr', onClick: openMergeSheet });
          } else {
            showFlash(SUBMIT_DONE[event] + ' on #' + state.livePr.number + '.');
          }
          window.scrollTo(0, 0);
        })
        .catch(function failed(e) {
          go.disabled = false;
          // Kept inside the sheet: the comment is still in the box behind it,
          // and closing to show the error would be the one place this page
          // could lose someone's writing.
          problem.textContent = e.message;
        });
    }

    var SUBMIT_DONE = {
      comment: 'Comment posted',
      approve: 'Approved',
      'request-changes': 'Changes requested',
    };

    // The merge button, the sentence that stands in for it, or nothing. Only
    // an open, approved pull request gets either: before approval there is
    // nothing to explain. Drawn from what the page already knows; the sheet
    // then asks GitHub again before anything can be pressed.
    function mergeControl() {
      var pr = state.livePr;
      if (!pr || pr.state !== 'open' || pr.review !== 'approved') return null;
      if (pr.queued) return el('span', 'mergehint', 'In the merge queue.');
      if (draft.headSha && state.headSha && draft.headSha !== state.headSha) {
        return el('span', 'mergehint', 'New commits since this review. Re-review to merge.');
      }
      // The same rule the server applies: a worktree review read files that
      // are not in any commit, and unknown counts as some.
      if (state.kind === 'worktree' && (state.meta && state.meta.dirtyFiles) !== 0) {
        return el('span', 'mergehint', 'This review read uncommitted changes. Commit, push and re-review to merge.');
      }
      var c = pr.checks;
      if (c && c.fail) return el('span', 'mergehint', 'Merge when checks pass: ' + c.fail + ' failing');
      if (c && c.pending) return el('span', 'mergehint', 'Merge when checks pass: ' + c.pending + ' running');
      var button = el('button', 'merge-pr', 'Squash and merge');
      button.type = 'button';
      button.addEventListener('click', openMergeSheet);
      return button;
    }

    function openMergeSheet() {
      var sheet = document.getElementById('mergeSheet');
      var go = document.getElementById('mergeGo');
      var list = document.getElementById('mergeList');
      document.getElementById('mergeTitle').textContent = 'Squash and merge #' + state.livePr.number;
      document.getElementById('mergeErr').textContent = '';
      document.getElementById('mergeBlock').replaceChildren();
      document.getElementById('mergeSubjectRow').hidden = true;
      document.getElementById('mergeWhere').textContent = '';
      list.replaceChildren(mergeItem('wait', 'Asking GitHub where this pull request stands\\u2026'));
      go.disabled = true;
      sheet.showModal();
      api('GET', '/reviews/' + state.session + '/merge')
        .then(function read(got) {
          describeMergeWay(got.readiness);
          renderMergeReadiness(got);
          go.disabled = !!got.blocker;
        })
        .catch(function failed(e) {
          list.replaceChildren();
          document.getElementById('mergeErr').textContent = e.message;
        });
    }

    // GitHub decides this per pull request, and only the queue needs saying: a
    // base branch with one takes the pull request into it and titles the
    // commit itself, so there is no title to edit. The button reads the same
    // either way.
    function describeMergeWay(r) {
      var n = state.livePr.number;
      var who = state.ghAccount ? 'as ' + state.ghAccount : 'as whichever account gh is signed in as on this box';
      document.getElementById('mergeWhere').textContent = r.mergeQueue
        ? 'This repository uses the merge queue for all merges into the ' + r.baseRef + ' branch. This adds pull request #'
          + n + ' to it on GitHub ' + who + ', and GitHub merges it once the queue\\u2019s checks pass.'
        : 'This merges pull request #' + n + ' on GitHub ' + who + ', and GitHub then deletes its branch.';
      var row = document.getElementById('mergeSubjectRow');
      if (r.mergeQueue || !row.hidden) return;
      // GitHub's own default squash title, editable.
      var subject = document.getElementById('mergeSubject');
      subject.value = (state.livePr.title || (state.meta && state.meta.title) || '') + ' (#' + n + ')';
      row.hidden = false;
      subject.focus();
    }

    function mergeItem(tone, text) {
      var li = el('li', null);
      var mark = tone === 'ok' ? '\\u2713' : (tone === 'no' ? '\\u2715' : '\\u2022');
      li.appendChild(el('span', 'mark ' + tone, mark));
      li.appendChild(el('span', null, text));
      return li;
    }

    // What GitHub said, one line per rule the server applies, so a refusal
    // points at the line it came from.
    function renderMergeReadiness(got) {
      var r = got.readiness;
      var list = document.getElementById('mergeList');
      list.replaceChildren();
      list.appendChild(r.reviewDecision === 'APPROVED' ? mergeItem('ok', 'Approved') : mergeItem('no', 'Not approved'));
      var c = r.checks;
      if (!c) list.appendChild(mergeItem('ok', 'No checks reported'));
      else if (c.fail) list.appendChild(mergeItem('no', c.fail + ' of ' + c.total + ' checks failing'));
      else if (c.pending) list.appendChild(mergeItem('wait', c.pending + ' of ' + c.total + ' checks still running'));
      else list.appendChild(mergeItem('ok', 'All ' + c.total + ' checks passing'));
      var head = (r.headSha || '').slice(0, 8);
      var read = (got.reviewedSha || '').slice(0, 8);
      list.appendChild(head && head === read
        ? mergeItem('ok', 'Head is ' + head + ', the commit this review read')
        : mergeItem('no', 'Head is ' + (head || 'unknown') + ', but this review read ' + (read || 'nothing')));
      if (r.queued) list.appendChild(mergeItem('no', 'Already in the merge queue'));
      if (r.mergeState === 'DIRTY') list.appendChild(mergeItem('no', 'Conflicts with ' + r.baseRef));
      else if (r.mergeState === 'UNKNOWN') list.appendChild(mergeItem('wait', 'GitHub is still checking for conflicts with ' + r.baseRef));
      else list.appendChild(mergeItem('ok', 'No conflicts with ' + r.baseRef));
      if (got.blocker) showMergeBlock(got.blocker);
    }

    var MERGE_NEXT = {
      moved: ' Use Re-review at the top of the page to read the new commits first.',
      uncommitted: ' Commit and push them, then Re-review.',
      'checks-failing': ' Fix them on the branch, then merge.',
      'checks-running': ' Merge once they have finished.',
      queued: ' GitHub merges it once the queue\\u2019s checks pass.',
    };

    function showMergeBlock(blocker) {
      var text = 'Can\\u2019t merge: ' + blocker.error + '.' + (MERGE_NEXT[blocker.code] || '');
      document.getElementById('mergeBlock').replaceChildren(el('div', 'mergeblock', text));
      document.getElementById('mergeGo').disabled = true;
    }

    function mergePullRequest() {
      var sheet = document.getElementById('mergeSheet');
      var go = document.getElementById('mergeGo');
      var problem = document.getElementById('mergeErr');
      problem.textContent = '';
      go.disabled = true;
      api('POST', '/reviews/' + state.session + '/merge', { subject: document.getElementById('mergeSubject').value })
        .then(function merged(got) {
          sheet.close();
          if (got.queued) {
            state.livePr.queued = true;
            render();
            showFlash('Added #' + got.pr + ' to the ' + got.baseRef + ' merge queue'
              + (got.position ? ' at position ' + got.position : '')
              + '. GitHub merges it once the queue\\u2019s checks pass; then kill this session from Woodshed to remove its worktree.');
            window.scrollTo(0, 0);
            return;
          }
          state.livePr.state = 'merged';
          state.livePr.review = null;
          state.livePr.checks = null;
          render();
          showFlash('Merged #' + got.pr + ' into ' + got.baseRef + ' as ' + String(got.sha || '').slice(0, 8)
            + '. Kill this session from Woodshed to remove its worktree.');
          window.scrollTo(0, 0);
        })
        .catch(function failed(e) {
          // A refusal the server found on its fresh read is shown the same
          // way as one found when the sheet opened, and the checklist is read
          // again so it agrees with it. Anything else sits beside the
          // buttons, and the button comes back for a retry.
          if (e.code) {
            showMergeBlock({ code: e.code, error: e.message });
            api('GET', '/reviews/' + state.session + '/merge').then(renderMergeReadiness).catch(function ignore() {});
            return;
          }
          problem.textContent = e.message;
          go.disabled = false;
        });
    }

    // What the model made of the change: what it does, what a reviewer has to
    // make up their mind about, how it fits. Order is deliberate: the
    // questions and decisions come straight after the overview because they
    // are what a reviewer is here for, and the architecture is reference.
    // It ends on the way into the diff, which is the next thing to do.
    function renderAnalysis(content) {
      var described = renderDescription(content);
      if (state.review && state.review.overview) {
        content.appendChild(el('div', 'secthead s-over' + (described ? '' : ' first'), 'Overview'));
        var overview = el('div', 'overview prose');
        renderMarkdown(overview, state.review.overview);
        content.appendChild(overview);
      }
      renderWhatMatters(content);
      renderArchitecture(content);
      if (!state.review || !state.review.overview) {
        content.appendChild(el('div', 'tabnote', 'There is no analysis to show yet.'));
      }
      content.appendChild(toFilesButton());
    }

    function toFilesButton() {
      var n = ((state.diff && state.diff.files) || []).length;
      var go = el('button', 'quiet tofiles', 'Read the diff: ' + n + (n === 1 ? ' file' : ' files') + ' changed \u2192');
      go.type = 'button';
      go.addEventListener('click', function onGo() { showTab('files'); });
      return go;
    }

    // The author's own account, above the model's. Set in a box so the two
    // are never read as one voice, and held to a screenful until asked for,
    // because a long template description would otherwise push the overview
    // out of sight.
    var descOpen = false;
    var DESC_CLAMP_CHARS = 900;

    function renderDescription(content) {
      if (!state.livePr) return false;
      content.appendChild(el('div', 'secthead s-desc first', 'Description'));
      if (draftLoading) {
        content.appendChild(loadingNote('Loading the description from GitHub\\u2026'));
        return true;
      }
      var d = draft.description;
      // Drawn the way GitHub draws the opening comment: a bordered card with
      // who wrote it on a bar across the top.
      var card = el('div', 'desccard');
      var head = el('div', 'deschead');
      if (d) {
        head.appendChild(el('b', null, d.author));
        head.appendChild(document.createTextNode(' commented'));
        if (d.at) head.appendChild(el('span', 'when', fmtWhen(d.at)));
        head.appendChild(el('span', 'grow'));
        if (d.url) head.appendChild(openOnGitHub(d.url, 'Edit on GitHub'));
      }
      card.appendChild(head);
      var box = el('div', 'desc gh');
      card.appendChild(box);
      content.appendChild(card);
      if (!d || !d.body) {
        box.appendChild(el('span', 'nodesc', 'No description provided.'));
        return true;
      }
      if (d.html) renderGithubHtml(box, d.html);
      else renderMarkdown(box, d.body);
      var long = d.body.length > DESC_CLAMP_CHARS;
      if (long && !descOpen) box.classList.add('clamped');
      if (long) {
        var more = el('button', 'quiet descmore', descOpen ? 'Show less' : 'Show the whole description');
        more.type = 'button';
        more.addEventListener('click', function onMore() {
          descOpen = !descOpen;
          render();
        });
        content.appendChild(more);
      }
      return true;
    }

    // GitHub's rendered HTML, rebuilt node by node through an allowlist.
    // DOMParser gives an inert document: nothing in it runs or loads. Only
    // listed tags are recreated; anything else is unwrapped to its children,
    // except the few whose content is itself the danger, which are dropped.
    // Only listed attributes are copied, and a URL only when it is http(s).
    var GH_TAGS = {
      P: 1, BR: 1, HR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
      UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1, KBD: 1,
      STRONG: 1, B: 1, EM: 1, I: 1, DEL: 1, S: 1, SUP: 1, SUB: 1,
      A: 1, IMG: 1, VIDEO: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1,
      DETAILS: 1, SUMMARY: 1, INPUT: 1,
    };
    var GH_DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, FORM: 1, TEMPLATE: 1, SVG: 1, MATH: 1 };

    function renderGithubHtml(root, html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      copyGithubNodes(root, doc.body.childNodes);
    }

    function webUrl(value) {
      return /^https?:/i.test(value || '') ? value : null;
    }

    function copyGithubNodes(into, nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.nodeType === 3) {
          into.appendChild(document.createTextNode(node.nodeValue));
          continue;
        }
        if (node.nodeType !== 1) continue;
        // Upper-cased, because an element inside an svg or math island keeps
        // its source case and would otherwise slip past both lists.
        var tag = node.tagName.toUpperCase();
        if (GH_DROP[tag]) continue;
        if (!GH_TAGS[tag]) {
          copyGithubNodes(into, node.childNodes);
          continue;
        }
        var made = copyGithubElement(node);
        if (!made) continue;
        into.appendChild(made);
        copyGithubNodes(made, node.childNodes);
      }
    }

    function copyGithubElement(node) {
      var tag = node.tagName.toUpperCase();
      if (tag === 'INPUT') {
        // Task-list boxes only, and never clickable: ticking one here would
        // change nothing on GitHub.
        if (node.getAttribute('type') !== 'checkbox') return null;
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = node.hasAttribute('checked');
        return box;
      }
      var made = document.createElement(tag.toLowerCase());
      if (tag === 'A') {
        var href = webUrl(node.getAttribute('href'));
        if (href) {
          made.href = href;
          made.target = '_blank';
          made.rel = 'noopener noreferrer';
        }
      } else if (tag === 'IMG' || tag === 'VIDEO') {
        var src = webUrl(node.getAttribute('src'));
        if (!src) return null;
        made.src = src;
        if (tag === 'VIDEO') made.controls = true;
        else made.alt = node.getAttribute('alt') || '';
        var w = parseInt(node.getAttribute('width'), 10);
        if (w > 0) made.style.width = Math.min(w, 2000) + 'px';
      } else if (tag === 'TH' || tag === 'TD') {
        var align = node.getAttribute('align');
        if (align === 'left' || align === 'right' || align === 'center') made.style.textAlign = align;
      } else if (tag === 'OL') {
        var start = parseInt(node.getAttribute('start'), 10);
        if (start > 0) made.start = start;
      } else if (tag === 'DETAILS' && node.hasAttribute('open')) {
        made.open = true;
      }
      return made;
    }

    // The files, in the order the analysis put them in, under the acts that
    // say why that is the order.
    function renderFilesBar() {
      var bar = el('div', 'filesbar');
      var acts = groupsToRender().filter(function titled(g) { return g.title; }).length;
      bar.appendChild(el('span', null, acts
        ? 'In reading order: ' + acts + (acts === 1 ? ' act' : ' acts') + ', the one to understand first at the top.'
        : 'In the order git lists them.'));
      bar.appendChild(el('span', 'grow'));
      var open = el('button', 'quiet', 'Expand all');
      open.type = 'button';
      open.addEventListener('click', function onOpen() { setExpandAll(true); });
      var fold = el('button', 'quiet', 'Collapse all');
      fold.type = 'button';
      fold.addEventListener('click', function onFold() { setExpandAll(false); });
      bar.appendChild(open);
      bar.appendChild(fold);
      return bar;
    }

    function renderFiles(content, byPath) {
      var groups = groupsToRender();
      var rendered = {};
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        if (group.title) {
          var head = el('div', 'act-head' + (g === 0 ? ' first' : ''));
          head.appendChild(el('span', 'act-n', 'ACT ' + (g + 1)));
          var body = el('div', 'act-body');
          body.appendChild(el('b', null, group.title));
          if (group.why) {
            var why = el('div', 'act-why prose');
            renderMarkdown(why, group.why);
            body.appendChild(why);
          }
          head.appendChild(body);
          content.appendChild(head);
        }
        for (var i = 0; i < group.files.length; i++) {
          var entry = group.files[i];
          var file = byPath[entry.path];
          if (!file || rendered[entry.path]) continue;
          rendered[entry.path] = true;
          content.appendChild(renderFile(file, entry));
        }
      }

      // Belt to the server-side reconciliation's braces. Losing a file from a
      // diff because a model forgot to mention it is the one failure this
      // feature must never have, so it is guarded in both places.
      var files = state.diff.files;
      var missed = [];
      for (var k = 0; k < files.length; k++) {
        if (!rendered[files[k].path]) missed.push(files[k]);
      }
      if (missed.length) {
        var head2 = el('div', 'act-head');
        head2.appendChild(el('span', 'act-n', 'ALSO'));
        var body2 = el('div', 'act-body');
        body2.appendChild(el('b', null, 'Not classified'));
        head2.appendChild(body2);
        content.appendChild(head2);
        for (var j = 0; j < missed.length; j++) {
          content.appendChild(renderFile(missed[j], { path: missed[j].path, preamble: '', role: '' }));
        }
      }

      // The comments this page left on GitHub, said once at the end rather
      // than in a banner over the title. An outdated comment is advice about
      // a diff that no longer exists, so it is not drawn — but dropping one
      // without a word would be the page deciding for a reader what they get
      // to see. Here it is a footnote to the files, which is what it is.
      if (draft.outdated) {
        var note = el('div', 'leftout');
        note.appendChild(el('b', null, String(draft.outdated)));
        note.appendChild(document.createTextNode(
          (draft.outdated === 1 ? ' outdated comment is' : ' outdated comments are')
          + ' not shown here: the code each was written about has moved. '
        ));
        if (state.livePr && state.livePr.url) {
          var link = document.createElement('a');
          link.href = state.livePr.url + '/files';
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = 'Read them on GitHub';
          note.appendChild(link);
        }
        content.appendChild(note);
      }
    }

    // Prose, so it goes through the same small markdown renderer the answers
    // use — the model writes paragraphs and backticked identifiers, and this
    // page never uses innerHTML.
    function renderArchitecture(content) {
      var text = state.review && state.review.architecture;
      if (!text) return;
      content.appendChild(el('div', 'secthead s-arch', 'Architecture'));
      var box = el('div', 'arch prose');
      renderMarkdown(box, text);
      content.appendChild(box);
    }

    // Shared by the failed strip's Retry and by the offer a Re-review makes
    // when it finds no new commits. Both ask the same thing \u2014 read this
    // commit again \u2014 from the two states where it is the useful answer.
    function startAnalysis(button) {
      button.disabled = true;
      api('POST', '/reviews/' + state.session + '/analyze', {})
        .then(function started() {
          state.status = 'running';
          render();
          schedulePoll();
        })
        .catch(function failed(e) {
          button.disabled = false;
          showError(e.message);
        });
    }

    // The questions a reviewer has to answer before approving, then the
    // choices the change made: one section, because the two are the same
    // job. Each question links to the files that answer it and can be taken
    // to the conversation; an analysis from before questions has decisions
    // alone.
    function renderWhatMatters(content) {
      var questions = (state.review && state.review.questions) || [];
      var decisions = (state.review && state.review.decisions) || [];
      if (!questions.length && !decisions.length) return;
      content.appendChild(el('div', 'secthead s-dec', 'The questions and decisions that matter most'));
      if (questions.length) {
        content.appendChild(el('div', 'subhead', 'Questions to answer before approving'));
        var qlist = el('ol', 'questions');
        for (var i = 0; i < questions.length; i++) qlist.appendChild(renderQuestion(questions[i]));
        content.appendChild(qlist);
      }
      if (decisions.length) {
        if (questions.length) content.appendChild(el('div', 'subhead', 'Decisions this change made'));
        renderDecisions(content, decisions);
      }
    }

    function renderQuestion(q) {
      var li = document.createElement('li');
      var b = document.createElement('b');
      inline(b, q.question);
      li.appendChild(b);
      if (q.why) {
        var why = el('span', 'why prose');
        inline(why, q.why);
        li.appendChild(why);
      }
      var acts = el('div', 'qacts');
      var files = q.files || [];
      var byPath = fileByPath();
      for (var f = 0; f < files.length; f++) {
        if (!byPath[files[f]]) continue;
        acts.appendChild(fileLink(files[f]));
      }
      var askIt = el('button', 'qask');
      askIt.type = 'button';
      askIt.appendChild(svgIcon(BOT_D));
      askIt.appendChild(el('span', null, 'Ask in the conversation'));
      askIt.addEventListener('click', function onAsk() { askInChat(q.question); });
      acts.appendChild(askIt);
      li.appendChild(acts);
      return li;
    }

    // A changed file named in the analysis, as a way to its diff.
    function fileLink(path) {
      var link = el('button', 'qfile');
      link.type = 'button';
      // The name and its folder: a bare action.yml or index.mjs could be any of several.
      link.textContent = path.split('/').slice(-2).join('/');
      link.dataset.tip = path;
      link.setAttribute('aria-label', 'Show the diff of ' + path);
      link.addEventListener('click', function onFile() {
        openFiles[path] = true;
        showTab('files');
        jumpToFile(path);
      });
      return link;
    }

    // A numbered list of a bold title and a sentence of why.
    function renderDecisions(content, items) {
      var list = el('ol', 'decisions');
      for (var i = 0; i < items.length; i++) {
        var li = document.createElement('li');
        var b = document.createElement('b');
        inline(b, items[i].title);
        li.appendChild(b);
        var why = el('span', 'why prose');
        inline(why, items[i].why || '');
        li.appendChild(why);
        list.appendChild(li);
      }
      content.appendChild(list);
    }

    // The counts, and the same ratio as five blocks. Both ends are floors
    // rather than a plain round: a change with one deleted line must not draw
    // five green blocks, and one with a single added line must not draw five
    // red, which is what rounding alone does at either extreme.
    function diffStat(additions, deletions) {
      var add = Number(additions) || 0;
      var del = Number(deletions) || 0;
      var box = el('span', 'dstat');
      box.appendChild(el('span', 'p', '+' + add));
      box.appendChild(el('span', 'm', '\\u2212' + del));
      var total = add + del;
      if (!total) return box;
      var greens = Math.round((add / total) * 5);
      if (add > 0 && greens < 1) greens = 1;
      if (del > 0 && greens > 4) greens = 4;
      var bar = el('span', 'bar');
      bar.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 5; i++) bar.appendChild(el('i', i < greens ? null : 'm'));
      box.appendChild(bar);
      return box;
    }

    // Octicons' git-pull-request, and its closed and merged siblings. The
    // shape says which kind of thing the pill is about before the word does.
    var PR_STATE_D = {
      open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
      merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z',
      closed: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 1 1 1.06 1.06l-.97.97.97.97a.749.749 0 1 1-1.06 1.06l-.97-.97-.97.97a.749.749 0 1 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
    };
    PR_STATE_D.draft = PR_STATE_D.open;

    // check, x, dot-fill, eye — Octicons, at the size the pill's glyph uses.
    var FACT_D = {
      good: 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L1.72 8.78a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
      bad: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
      busy: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
      eye: 'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
    };

    // Each fact carries its tone, its glyph, what it says, and what a reader
    // who wants more should be looking at on GitHub.
    var VERDICT_FACT = {
      approved: { tone: 'good', glyph: 'good', word: 'approved', tip: 'A reviewer has approved this pull request.' },
      changes: { tone: 'bad', glyph: 'bad', word: 'changes requested', tip: 'A reviewer has asked for changes.' },
      pending: { tone: null, glyph: 'eye', word: 'review requested', tip: 'Nobody has reviewed this yet.' },
    };

    function factChip(opts) {
      // A chip that has something to show becomes a button that shows it.
      // The alternative was a link away to GitHub for a paragraph that fits
      // here, which is the page giving up on the question it just raised.
      var node;
      if (opts.opens) {
        node = el('button', null);
        node.type = 'button';
        node.addEventListener('click', function onOpen() { showTab(opts.opens); });
      } else if (opts.href) {
        node = document.createElement('a');
        node.href = opts.href;
        node.target = '_blank';
        node.rel = 'noopener';
      } else {
        node = el('span', null);
      }
      node.className = 'fact' + (opts.tone ? ' ' + opts.tone : '');
      node.appendChild(svgIcon(FACT_D[opts.glyph]));
      if (opts.count !== undefined) node.appendChild(el('span', 'n', String(opts.count)));
      node.appendChild(el('span', null, opts.word));
      node.dataset.tip = opts.tip;
      return node;
    }

    // The most recent verdict with something written in it. An approval with
    // an empty body has nothing to open, so the chip stays a plain chip.
    function latestVerdict() {
      for (var i = draft.said.length - 1; i >= 0; i--) {
        var one = draft.said[i];
        if (one.kind === 'review' && (one.state === 'approved' || one.state === 'changes_requested')) return one;
      }
      return null;
    }

    // GitHub's header line, as much of it as this page has room for: the state,
    // then what reviewers said, then how the checks are doing.
    function prStatusBits(pr) {
      var bits = [];
      var pill = el('span', 'prstate ' + pr.state);
      pill.appendChild(svgIcon(PR_STATE_D[pr.state] || PR_STATE_D.open));
      pill.appendChild(el('span', null, pr.state.charAt(0).toUpperCase() + pr.state.slice(1)));
      bits.push(pill);

      var verdict = VERDICT_FACT[pr.review];
      if (verdict) {
        var written = latestVerdict();
        bits.push(factChip({
          tone: verdict.tone,
          glyph: verdict.glyph,
          word: verdict.word,
          tip: written ? 'What the reviewer said' : verdict.tip,
          opens: written ? 'discussion' : null,
          href: written ? null : pr.url,
        }));
      }
      var c = pr.checks;
      if (c && c.total) {
        // Failing first, then still running, then done: the reader is looking
        // for a reason not to merge, and that is the order the reasons come in.
        var fact = c.fail
          ? { tone: 'bad', glyph: 'bad', count: c.fail, word: 'failing', tip: c.fail + ' of ' + c.total + ' checks failed.' }
          : (c.pending
            ? { tone: 'busy', glyph: 'busy', count: c.pending, word: 'running', tip: c.pass + ' of ' + c.total + ' checks done, ' + c.pending + ' still running.' }
            : { tone: 'good', glyph: 'good', count: c.total, word: 'checks passing', tip: 'All ' + c.total + ' checks passed.' });
        fact.href = pr.url ? pr.url + '/checks' : null;
        bits.push(factChip(fact));
      }
      return bits;
    }

    var PENCIL_D = 'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z';

    // Which heading is being renamed, if any. A flag rather than DOM state,
    // because every render rebuilds the header from scratch and a half-typed
    // title has to survive that.
    var renaming = false;
    var renameDraft = '';

    // The heading, replaced by a field at the same size. Renaming happens
    // where the title is, not in a box somewhere else.
    function renderTitleEditor() {
      var form = el('div', 'retitle-form');
      var input = document.createElement('input');
      input.type = 'text';
      input.value = renameDraft;
      input.setAttribute('aria-label', 'Pull request title');
      input.maxLength = 256;
      form.appendChild(input);

      var save = el('button', null, 'Save');
      save.type = 'button';
      var cancel = el('button', 'quiet', 'Cancel');
      cancel.type = 'button';
      form.appendChild(save);
      form.appendChild(cancel);

      function stop() {
        renaming = false;
        renameDraft = '';
        render();
      }
      function commit() {
        var text = input.value.trim();
        if (!text || text === prTitle()) return stop();
        save.disabled = true;
        api('PATCH', '/reviews/' + state.session + '/title', { title: text })
          .then(function renamed(data) {
            // The live answer wins over what was typed: GitHub trims, and the
            // heading should show what the pull request now says, not what was
            // sent to it.
            if (state.livePr) state.livePr.title = data.title || text;
            document.title = titleFor({ livePr: state.livePr, kind: state.kind, pr: state.pr, branch: state.meta.headRefName, session: state.session }) + ' \\u2014 Woodshed';
            stop();
          })
          .catch(function failed(e) {
            save.disabled = false;
            showFlash(e.message);
          });
      }

      save.addEventListener('click', commit);
      cancel.addEventListener('click', stop);
      input.addEventListener('keydown', function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); stop(); }
      });
      // Typed into, then a poll re-renders: without this the draft is lost.
      input.addEventListener('input', function onType() { renameDraft = input.value; });
      setTimeout(function focusIt() { input.focus(); input.select(); }, 0);
      return form;
    }

    function renderHeader() {
      var wrap = document.createElement('div');
      if (renaming) {
        wrap.appendChild(renderTitleEditor());
        wrap.appendChild(renderMeta());
        return wrap;
      }
      var title = el('h1', 'prtitle');
      title.appendChild(el('span', 'kind', 'Review: '));
      // The pull request's own title wins over the one the shed made up for a
      // branch. "Work in progress on woodshed-review-tree-chat" was the best
      // that could be said before there was a pull request; once there is one,
      // somebody has written a better sentence than any this page can build,
      // and it is the sentence everyone else is reading.
      title.appendChild(document.createTextNode(prTitle() + ' '));
      // A branch target has no number. Link to the pull request where there is
      // one — that is the thing you go to in order to comment.
      if (state.meta.number) {
        if (state.meta.url) {
          var link = document.createElement('a');
          link.className = 'prnum';
          link.href = state.meta.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = '#' + state.meta.number;
          title.appendChild(link);
        } else {
          title.appendChild(el('span', 'prnum', '#' + state.meta.number));
        }
      }
      // Only a pull request has a name anyone else reads. A branch review's
      // heading is a sentence this page made up, and renaming it would change
      // nothing outside this tab.
      if (state.livePr) {
        var pencil = el('button', 'retitle');
        pencil.type = 'button';
        pencil.dataset.tip = 'Rename this pull request on GitHub';
        pencil.setAttribute('aria-label', 'Rename this pull request');
        pencil.appendChild(svgIcon(PENCIL_D));
        pencil.addEventListener('click', function onRename() {
          renaming = true;
          renameDraft = prTitle();
          render();
        });
        title.appendChild(pencil);
      }
      wrap.appendChild(title);
      wrap.appendChild(renderMeta());
      return wrap;
    }

    function renderMeta() {
      var meta = el('div', 'prmeta');
      if (state.meta.author && state.meta.author.login) {
        meta.appendChild(el('span', 'who', state.meta.author.login));
      }
      var refs = el('span', 'refs');
      refs.appendChild(el('span', 'ref', state.meta.headRefName));
      refs.appendChild(el('span', 'arrow', '\\u2192'));
      refs.appendChild(el('span', 'ref base', state.meta.baseRefName));
      meta.appendChild(refs);
      // A worktree review whose branch has since been opened as a pull
      // request. It goes on the fact line rather than in the title, because
      // the title is about the working tree that was read and the pull
      // request is a fact about the branch underneath it — and without it the
      // Submit review button appears with nothing on the page saying what it
      // would post to.
      if (state.livePr) {
        // The number only where the title is not already carrying it. On a
        // pull request review it is up there in the heading, and twice on one
        // screen is once too many.
        if (!state.meta.number) {
          var opened = document.createElement('a');
          opened.className = 'openedpr';
          opened.href = state.livePr.url || '#';
          opened.target = '_blank';
          opened.rel = 'noopener';
          opened.textContent = '#' + state.livePr.number;
          opened.dataset.tip = 'This branch has a pull request. Submit review posts to it.';
          meta.appendChild(opened);
        }
        var bits = prStatusBits(state.livePr);
        for (var b = 0; b < bits.length; b++) meta.appendChild(bits[b]);
      }
      var sha = (state.meta.headRefOid || '').slice(0, 8);
      if (sha) meta.appendChild(el('span', 'sha', sha));
      meta.appendChild(diffStat(state.meta.additions, state.meta.deletions));
      // The state pill below says Draft where this chip did, so it is left
      // only to a review that has no pull request to draw a pill for.
      if (state.meta.isDraft && !state.livePr) meta.appendChild(el('span', 'draft', 'draft'));
      // Which session this is, because the review IS a session now: the
      // worktree in that row is the code this page is describing. Last and
      // set apart, because it is the one fact here about the shed rather
      // than about the change.
      if (state.session) meta.appendChild(el('span', 'sess', state.session));
      return meta;
    }

    // The Discussion tab: everything said about the change as a whole rather
    // than about a line, oldest first. GitHub's Conversation tab without the
    // description, which heads the Analysis tab, and without the line
    // comments, which are already beside their code.
    function renderDiscussion(content) {
      if (draftLoading) {
        content.appendChild(loadingNote('Loading the comments from GitHub\\u2026'));
        return;
      }
      // CI bots post on every push, and a pull request that has been round
      // the loop a dozen times buries the people under them. Only the latest
      // bot entry is current, so it is the only one left open.
      var lastBot = -1;
      for (var b = 0; b < draft.said.length; b++) {
        if (isBotAuthor(draft.said[b].author)) lastBot = b;
      }
      for (var i = 0; i < draft.said.length; i++) {
        var one = draft.said[i];
        var open = one.id in saidOpen ? saidOpen[one.id] : !isBotAuthor(one.author) || i === lastBot;
        var item = el('div', 'saidbox' + (verdictTone(one) ? ' ' + verdictTone(one) : '') + (open ? '' : ' folded'));
        var head = saidHead(one, one.kind === 'review' ? SAID_WORD[one.state] : null);
        foldable(head, one.id, open);
        item.appendChild(head);
        if (open) {
          var said = el('div', 'saidbody prose');
          renderMarkdown(said, one.body);
          item.appendChild(said);
        }
        content.appendChild(item);
      }
      if (!draft.said.length) {
        content.appendChild(el('div', 'tabnote', 'Nothing has been said about this pull request yet.'));
      }
    }

    // Explicit per-entry choices only, keyed by GitHub's id. An entry absent
    // from here follows the default, so the newest bot comment stays open as
    // new ones arrive and the one it replaces folds away.
    var saidOpen = {};

    function isBotAuthor(login) {
      return login === 'github-actions' || /\\[bot\\]$/.test(login || '');
    }

    // The whole header toggles, except the buttons and links on it, which
    // keep doing their own job.
    function foldable(head, id, open) {
      head.classList.add('toggles');
      head.insertBefore(el('span', 'caret', open ? '\\u25be' : '\\u25b8'), head.firstChild);
      head.addEventListener('click', function onFold(ev) {
        if (ev.target.closest('button, a')) return;
        saidOpen[id] = !open;
        render();
      });
    }

    function saidHead(one, word) {
      var head = el('div', 'saidhead');
      head.appendChild(el('span', 'who', one.author));
      if (word) head.appendChild(el('span', 'verdictword ' + verdictTone(one), word));
      if (one.at) head.appendChild(el('span', 'when', fmtWhen(one.at)));
      head.appendChild(el('span', 'grow'));
      // A plain comment of yours can go. A submitted review cannot, by
      // anyone, so rather than a button that would fail the line says why
      // and points at the one thing GitHub does allow.
      if (one.kind === 'comment' && one.canDelete) {
        head.appendChild(deleteButton({ id: one.restId, pending: false }));
      } else if (one.kind === 'review' && one.mine) {
        head.appendChild(hideButton(one));
      }
      if (one.url) head.appendChild(openOnGitHub(one.url, 'Open on GitHub'));
      return head;
    }

    var SAID_WORD = {
      approved: 'approved',
      changes_requested: 'requested changes',
      commented: 'commented',
      dismissed: 'dismissed',
    };

    function verdictTone(one) {
      if (!one || one.kind !== 'review') return '';
      if (one.state === 'approved') return 'good';
      if (one.state === 'changes_requested') return 'bad';
      return '';
    }

    // The strip under the header, and the button that takes the review again.
    // One function for both kinds: they differ in what they say and in which
    // route they POST to, and in nothing else.
    // Takes pieces rather than one string, so a number can be set apart from
    // the sentence carrying it.
    function reviewNote(parts, opts) {
      var live = el('div', 'livenote');
      var line = el('span', null);
      for (var i = 0; i < parts.length; i++) {
        var piece = parts[i];
        line.appendChild(typeof piece === 'string' ? document.createTextNode(piece) : piece);
      }
      live.appendChild(line);
      live.appendChild(el('span', 'grow'));
      var note = null;
      var offer = null;
      var again = el('button', 'quiet', 'Re-review');
      again.dataset.tip = opts.tip;
      // Before the button rather than after it, so a long refusal \\u2014 the
      // worktree has uncommitted changes, say \\u2014 pushes the button right
      // instead of wrapping underneath where it is easy to miss.
      function say(cls, message) {
        again.disabled = false;
        again.textContent = 'Re-review';
        if (note) note.remove();
        note = el('span', cls, message);
        live.insertBefore(note, again);
      }

      // Nothing new on origin. There is a second thing the reader might have
      // wanted \\u2014 the same commit read again, because the write-up is
      // poor or the prompt has improved \\u2014 and this is the one moment it
      // is worth naming. It used to be a second button in the header, which
      // asked every reader to tell two near-synonyms apart before either was
      // relevant; offering it only here means the choice appears exactly when
      // there is a choice to make.
      function offerReanalysis() {
        say('dim', 'no new commits.');
        if (offer) offer.remove();
        offer = el('button', 'quiet', 'Read it again anyway');
        offer.dataset.tip = 'Read the same commit again and rebuild the overview, questions, decisions, architecture and reading order. A minute or two.';
        offer.addEventListener('click', function onReanalyse() {
          offer.textContent = 'reading\\u2026';
          startAnalysis(offer);
        });
        live.insertBefore(offer, again);
      }

      again.addEventListener('click', function onAgain() {
        again.disabled = true;
        again.textContent = 'reading\\u2026';
        if (note) { note.remove(); note = null; }
        if (offer) { offer.remove(); offer = null; }
        api('POST', '/reviews/' + state.session + opts.path, {})
          .then(function (data) {
            // No new commits: nothing was rebuilt and no run was paid for, so
            // reloading would redraw the same page and read as a button that
            // did nothing. Say so, and offer the other thing instead.
            if (data && data.unchanged) return offerReanalysis();
            // Re-read in place rather than reloading the document. A reload
            // throws away the conversation, the scroll and which files were
            // open, to arrive at the same page with a newer diff in it.
            loadReview(state.session).catch(function (err) {
              showError(err && err.message ? err.message : 'could not re-read the review');
            });
          })
          .catch(function (err) {
            say('bad', err && err.message ? err.message : 'failed');
          });
      });
      live.appendChild(again);

      var discard = el('button', 'quiet', 'Discard');
      discard.dataset.tip = 'Throw away the analysis and the conversation. The diff, the branch, the worktree and your viewed ticks stay.';
      discard.addEventListener('click', openDiscardSheet);
      live.appendChild(discard);
      return live;
    }

    // Named for what survives, because that is the half a person hesitating
    // over a red button actually wants to know.
    function openDiscardSheet() {
      document.getElementById('discardErr').textContent = '';
      document.getElementById('discardKeeps').textContent =
        'The diff stays, and so do this session, its worktree and its branch. '
        + 'Your viewed ticks stay too: they live on the pull request, not here. '
        + 'You can read it again afterwards.';
      document.getElementById('discardSheet').showModal();
      // Cancel takes the focus, not Discard. A dialog that destroys something
      // must not be one Enter away from doing it.
      document.getElementById('discardCancel').focus();
    }

    function discardReview() {
      var sheet = document.getElementById('discardSheet');
      var go = document.getElementById('discardGo');
      var problem = document.getElementById('discardErr');
      problem.textContent = '';
      go.disabled = true;
      api('POST', '/reviews/' + state.session + '/discard', {})
        .then(function done() {
          go.disabled = false;
          sheet.close();
          // The ticks are not this review's to throw away: they live on the
          // pull request and belong to whoever ticked them, here or on
          // github.com. Discard empties what the shed made.
          openFiles = {};
          chat.messages = [];
          chat.pending = null;
          chat.error = null;
          chat.loaded = false;
          // A fresh state object rather than a reset method: every answer this
          // page memoised describes a review that no longer exists.
          ask = createAskState();
          renderChat();
          return loadReview(state.session);
        })
        .catch(function failed(e) {
          go.disabled = false;
          problem.textContent = e.message;
        });
    }

    // A worktree review is a snapshot of work still being written: everything
    // below it was true when the button was pressed.
    function worktreeNote() {
      var ahead = [];
      if (state.meta.commits) {
        ahead.push(state.meta.commits + ' commit' + (state.meta.commits === 1 ? '' : 's'));
      }
      if (state.meta.dirtyFiles) {
        ahead.push(state.meta.dirtyFiles + ' uncommitted file' + (state.meta.dirtyFiles === 1 ? '' : 's'));
      }
      var parts = ['Working tree as of ', mono(fmtWhen(state.createdAt))];
      if (ahead.length) {
        parts.push(' \\u2014 ');
        for (var a = 0; a < ahead.length; a++) {
          if (a) parts.push(' and ');
          parts.push(el('b', null, ahead[a]));
        }
        parts.push(' ahead of ', mono(state.meta.baseRefName));
      }
      parts.push('. It may have changed since.');
      return reviewNote(parts, {
        path: '',
        tip: 'Take the diff again from the worktree as it is now, and re-run the analysis',
      });
    }

    // A pull request or branch review is pinned to one commit, which is exactly
    // why it goes stale: the head moves and the page cannot tell on its own.
    function targetNote() {
      var sha = (state.meta.headRefOid || '').slice(0, 8);
      var what = state.kind === 'pr' ? 'This pull request' : 'This branch';
      // fmtWhen has a fallback for a missing timestamp that reads as a clause
      // rather than a time, and 'as of this review was taken, at 1244f59e' is
      // not a sentence. The sha alone says the same thing, and it is what the
      // button acts on anyway.
      var when = state.createdAt ? ' as of ' + fmtWhen(state.createdAt) : '';
      var parts = [what];
      if (when) parts.push(' as of ', mono(fmtWhen(state.createdAt)));
      if (sha) parts.push(when ? ', at ' : ' is at ', mono(sha));
      parts.push('. Anything pushed since is not in it.');
      return reviewNote(parts, {
        path: '/refresh',
        tip: 'Fetch what origin has now, move this session worktree onto it, and re-run the analysis',
      });
    }

    function renderStatus() {
      var s = state.status;
      if (!s || s === 'ready') return null;
      var box = el('div', 'status');

      // 'unknown' is an artifact with no job breadcrumb behind it: nothing was
      // interrupted, there simply is no analysis. It used to be painted as an
      // interruption, which was a guess that has since become a lie — Discard
      // produces this state on purpose, and telling someone the shed restarted
      // when they pressed a button a second ago is the kind of small untruth
      // that costs a page its credibility.
      if (s === 'unknown') {
        box.appendChild(el('span', 'what', 'No analysis has been run on this diff.'));
        box.appendChild(el('span', 'grow'));
        box.appendChild(el('span', 'aside', 'the diff below is complete and in git order'));
        var run = el('button', 'quiet', 'Run analysis');
        run.dataset.tip = 'Read the diff and build the overview, questions, decisions, architecture and reading order. A minute or two.';
        run.addEventListener('click', function onRun() { startAnalysis(run); });
        box.appendChild(run);
        return box;
      }

      if (s === 'running' || s === 'queued') {
        var p = state.progress || {};
        // Waiting for memory is not the same as reading the code, and saying
        // "reading the code" while nothing is running is the kind of small lie
        // that makes a user distrust the rest of the page.
        box.appendChild(spinner());
        box.appendChild(el('span', 'what', state.waiting
          ? 'waiting: ' + state.waiting
          : (s === 'queued' ? 'queued' : 'reading the code')));
        // Each fact as its own element rather than one joined string, so the
        // thing it is reading now can sit apart from the counts beside it.
        var facts = [];
        if (p.currentFile) facts.push(p.currentFile);
        if (p.toolCalls) facts.push(p.toolCalls + (p.toolCalls === 1 ? ' file read' : ' files read'));
        if (p.elapsedMs) facts.push(fmtElapsed(p.elapsedMs));
        for (var f = 0; f < facts.length; f++) {
          box.appendChild(el('span', 'dot', '\\u00b7'));
          box.appendChild(el('span', null, facts[f]));
        }
        box.appendChild(el('span', 'grow'));
        box.appendChild(el('span', 'aside', 'the diff below is already complete'));
        return box;
      }

      box.className = 'status bad';
      var why =
        s === 'interrupted'
          ? 'The analysis was interrupted \\u2014 the shed restarted while it was running.'
          : 'The analysis failed' + (state.error ? ': ' + state.error : '.');
      box.appendChild(el('span', 'what', why));
      box.appendChild(el('span', 'grow'));
      box.appendChild(el('span', 'aside', 'the diff below is complete and in git order'));
      var retry = el('button', 'quiet', 'Retry analysis');
      retry.addEventListener('click', function onRetry() { startAnalysis(retry); });
      box.appendChild(retry);
      return box;
    }

    // Clock time, not \"3 minutes ago\": the question this answers is whether
    // the tree has moved since, and a reader compares it against when they
    // last typed something, which they remember as a time.
    function fmtWhen(iso) {
      if (!iso) return 'this review was taken';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return 'this review was taken';
      var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // The date too, once it is not today's. A worktree review is kept for as
      // long as its session is, so it is entirely normal to open one the next
      // morning — and a bare clock time then reads as an hour ago, which is
      // the single thing this line exists to stop it saying.
      var now = new Date();
      var sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
      if (sameDay) return time;
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
    }

    function fmtElapsed(ms) {
      var sec = Math.floor(ms / 1000);
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // Every glyph on a file bar comes from Octicons, drawn on the same 16px
    // grid, so one builder covers all of them.
    function svgIcon(d) {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      // Harmless on every Octicon here, which has no enclosed subpath, and
      // required by the one glyph that does.
      path.setAttribute('fill-rule', 'evenodd');
      svg.appendChild(path);
      return svg;
    }

    // A robot head, and the only glyph on this page not taken from Octicons.
    //
    // Ask was a comment bubble on the file bar and a bare "?" on a diff line:
    // two marks for one action, and neither of them true. A bubble is what a
    // person leaving a comment gets, which this page is about to need for
    // real; a question mark reads as "help". What Ask actually does is put a
    // question to a model, so it says so, and it says it the same way in both
    // places.
    //
    // fill-rule evenodd: the eyes are subpaths inside the head, and crossing
    // two boundaries leaves them unfilled.
    // Squat, with big eyes. A taller head and smaller eyes was drawn first and
    // measured at 64, 20, 14 and 12px side by side: below about 16px its eyes
    // closed up and it read as a plain rounded square. This one still has a
    // face at 12, which is the size it is actually used at.
    var BOT_D = 'M7.25 1.25a.75.75 0 0 1 1.5 0V4.5h-1.5ZM5 4.5h6A2.5 2.5 0 0 1 13.5 7v4A2.5 2.5 0 0 1 11 13.5H5A2.5 2.5 0 0 1 2.5 11V7A2.5 2.5 0 0 1 5 4.5Zm.9 3.15a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Zm4.2 0a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7Z';
    var COPY_D = 'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z';
    // Octicons' paper-aeroplane. A reply arrow was tried first and reads as
    // "answer this", which is Ask's job two controls along; and it points left
    // while the conversation it feeds is on the right. Sending is the one
    // gesture a single glyph carries without a label.
    // The comment bubble, back where it belongs now that Ask wears a robot:
    // this is the mark for a person saying something to another person.
    var CMT_D = 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z';
    var TOCHAT_D = 'M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-5.288L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.538L13.929 8Z';
    var TICK_D = 'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L1.72 8.78a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';

    // navigator.clipboard needs a secure context, and the shed is reached over
    // plain HTTP on the tailnet as often as through a TLS proxy. The old
    // execCommand path is deprecated and still the only one that works there.
    function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
      return new Promise(function (resolve, reject) {
        var pad = document.createElement('textarea');
        pad.value = text;
        pad.setAttribute('readonly', '');
        pad.style.position = 'fixed';
        pad.style.opacity = '0';
        document.body.appendChild(pad);
        pad.select();
        var ok = false;
        try {
          ok = document.execCommand('copy');
        } catch (e) {
          ok = false;
        }
        pad.remove();
        if (ok) resolve();
        else reject(new Error('the browser would not copy'));
      });
    }

    function renderFile(file, entry) {
      var card = el('div', 'fcard');
      card.dataset.path = file.path;

      var isOpen = isFileOpen(file.path);
      if (isOpen) card.classList.add('open');
      if (isViewed(file)) card.classList.add('seen');

      var bar = el('div', 'fbar');
      var toggle = el('button', 'fbar-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggle.appendChild(el('span', 'chev', isOpen ? '\\u25be' : '\\u25b8'));
      var cut = file.path.lastIndexOf('/');
      var pathWrap = el('span', 'fpath');
      if (cut !== -1) pathWrap.appendChild(el('span', 'fdir', file.path.slice(0, cut + 1)));
      pathWrap.appendChild(el('span', 'fname', file.path.slice(cut + 1)));
      toggle.appendChild(pathWrap);
      if (entry.role) toggle.appendChild(el('span', 'chip', entry.role));
      if (file.status !== 'modified') toggle.appendChild(el('span', 'chip ' + file.status, file.status));
      if (file.isBinary) toggle.appendChild(el('span', 'chip', 'binary'));
      bar.appendChild(toggle);

      var copy = el('button', 'fcopy');
      copy.type = 'button';
      copy.dataset.tip = 'Copy path';
      copy.setAttribute('aria-label', 'Copy path');
      copy.appendChild(svgIcon(COPY_D));
      copy.addEventListener('click', function onCopy(ev) {
        ev.stopPropagation();
        copyText(file.path).then(function () {
          // Said on the control itself rather than in a toast: the pointer is
          // already here, and a message anywhere else is one nobody sees.
          copy.classList.add('done');
          copy.dataset.tip = 'Copied';
          setTimeout(function () {
            copy.classList.remove('done');
            copy.dataset.tip = 'Copy path';
          }, 1200);
        }).catch(function () {
          copy.dataset.tip = 'The browser would not copy';
        });
      });
      bar.appendChild(copy);

      // Beside copy, because the two do the same kind of thing: take this file
      // somewhere else. The controls that act on the file itself stay on the
      // right.
      var toChat = el('button', 'fcopy ftochat');
      toChat.type = 'button';
      toChat.dataset.tip = 'Send to the conversation';
      toChat.setAttribute('aria-label', 'Send this file to the conversation');
      toChat.appendChild(svgIcon(TOCHAT_D));
      toChat.addEventListener('click', function onToChat(ev) {
        ev.stopPropagation();
        referenceInChat(file.path);
      });
      bar.appendChild(toChat);

      var counts = el('span', 'counts');
      counts.appendChild(el('span', 'p', '+' + file.additions));
      counts.appendChild(el('span', 'm', '\\u2212' + file.deletions));
      bar.appendChild(counts);

      var talks = threadCountFor(file);
      if (talks) {
        var badge = el('span', 'fcmt');
        badge.appendChild(svgIcon(CMT_D));
        badge.appendChild(el('span', null, String(talks)));
        badge.dataset.tip = talks === 1
          ? 'One conversation on this file'
          : talks + ' conversations on this file';
        bar.appendChild(badge);
      }

      var fileAnchor = ask.anchorKey(file.path, null, null);
      var askFile = el('button', 'fask' + (ask.isOpen(fileAnchor) ? ' on' : ''));
      askFile.type = 'button';
      askFile.dataset.tip = 'Ask about this file';
      askFile.appendChild(svgIcon(BOT_D));
      askFile.appendChild(el('span', null, 'Ask'));
      askFile.addEventListener('click', function askAboutFile(ev) {
        ev.stopPropagation();
        // Deliberately does not open the file: the answer renders under the
        // preamble, which is on screen whether the diff is or not, and
        // unfolding a thousand lines to ask a question is not what was asked.
        ask.toggle(fileAnchor);
        render();
      });
      bar.appendChild(askFile);

      if (marksViewed()) {
        var seen = isViewed(file);
        var viewed = el('button', 'fviewed' + (seen ? ' on' : '')
          + (viewedInFlight[file.path] ? ' busy' : ''));
        viewed.type = 'button';
        viewed.dataset.tip = seen
          ? 'Mark as not viewed'
          : 'Mark as viewed. It collapses, and dims in the tree.';
        var box = el('span', 'box');
        if (seen) box.appendChild(svgIcon(TICK_D));
        viewed.appendChild(box);
        viewed.appendChild(el('span', null, 'Viewed'));
        viewed.addEventListener('click', function onViewed(ev) {
          ev.stopPropagation();
          setViewed(file, !seen);
          // Marking it seen folds it away; unmarking leaves it to the setting
          // rather than forcing it open, since you may only be correcting a
          // mis-click.
          if (!seen) openFiles[file.path] = false;
          else delete openFiles[file.path];
          render();
        });
        bar.appendChild(viewed);
      }

      function toggleFile() {
        openFiles[file.path] = !isFileOpen(file.path);
        render();
      }

      // One handler, on the card. The bar's toggle is still a button — it
      // carries aria-expanded and takes the keyboard — and its click simply
      // bubbles to here, so there is no second listener to keep in step.
      // Everything else the reader can operate is left alone, and so is the
      // diff, which is for selecting text out of.
      card.addEventListener('click', function onCardClick(ev) {
        var selection = window.getSelection && window.getSelection();
        // A click that ends a drag is the end of a selection, not a press.
        if (selection && !selection.isCollapsed) return;
        var target = ev.target;
        if (!target || !target.closest) return;
        var control = target.closest('button, a, input, textarea, .askpanel');
        if (control && control !== toggle) return;
        if (target.closest('.dlines')) return;
        toggleFile();
      });
      card.appendChild(bar);

      // The preamble is the point of the whole feature, so it shows while the
      // file is still collapsed. Scrolling the list is how you decide what to
      // open, and a preamble you have to open the file to read helps nobody.
      var placeholder = state.status === 'ready' ? 'No summary was generated for this file.' : '';
      var pre = el('div', 'preamble prose' + (entry.preamble ? '' : ' none'));
      if (entry.preamble) renderMarkdown(pre, entry.preamble);
      else if (placeholder) pre.appendChild(el('p', null, placeholder));
      card.appendChild(pre);

      if (ask.isOpen(fileAnchor)) card.appendChild(renderAsk(file, null, fileAnchor));

      if (!isOpen) return roundLast(card);

      if (file.isBinary) {
        card.appendChild(el('div', 'note', 'Binary file \\u2014 no textual diff to show.'));
        return roundLast(card);
      }
      if (file.truncated) {
        var note = el('div', 'note',
          'This file is too large to render inline (' + (file.additions + file.deletions) +
          ' changed lines). Read it in the session worktree with: git diff ' +
          (state.meta && state.meta.baseRefName ? 'origin/' + state.meta.baseRefName + '... ' : '') +
          '-- ' + file.path);
        card.appendChild(note);
        return roundLast(card);
      }
      if (!file.hunks.length) {
        card.appendChild(el('div', 'note',
          file.status === 'renamed' ? 'Renamed with no content change.' : 'No textual changes.'));
        return roundLast(card);
      }

      card.appendChild(renderHunks(file));
      return roundLast(card);
    }

    // The card cannot clip its children any more — overflow:hidden on it would
    // stop .fbar sticking — so whichever child happens to render last takes
    // the bottom corners. Which one that is depends on state: .dlines for an
    // open file, .note for a binary or truncated one, .preamble for a collapsed
    // one, and .askpanel when a file-level question is open under it.
    function roundLast(card) {
      var last = card.lastElementChild;
      if (last && last !== card.firstElementChild) last.classList.add('fcard-last');
      return card;
    }

    function renderHunks(file) {
      var box = el('div', 'dlines');
      for (var h = 0; h < file.hunks.length; h++) {
        var hunk = file.hunks[h];
        box.appendChild(el('div', 'dhunk', hunk.header));
        for (var i = 0; i < hunk.lines.length; i++) {
          var line = hunk.lines[i];
          box.appendChild(renderLine(file, line));
          var lineAnchor = anchorFor(file, line);
          // What has been said, then what is being said, then what was asked.
          var said = threadsOn(file, line);
          for (var c = 0; c < said.length; c++) box.appendChild(renderThread(said[c]));
          if (isPickEnd(file, line)) {
            if (pickAction === 'comment') box.appendChild(renderComposer(file));
            else if (pickAction !== 'ask') box.appendChild(renderPickBar(file));
          }
          if (ask.isOpen(lineAnchor)) box.appendChild(renderAsk(file, line, lineAnchor));
        }
      }
      return box;
    }

    // Ask anchors on the new-side number where there is one, and on the old
    // side for a deletion, so the anchor is stable across a re-render — which
    // is what lets a draft, an answer and "which panel is open" all survive
    // one. Built by askState so the page and the state agree by construction.
    function anchorFor(file, line) {
      if (!line) return ask.anchorKey(file.path, null, null);
      return line.newNo !== null
        ? ask.anchorKey(file.path, line.newNo, 'new')
        : ask.anchorKey(file.path, line.oldNo, 'old');
    }

    function spanLabel(range) {
      return range.from === range.to
        ? 'Line ' + range.from
        : 'Lines ' + range.from + ' to ' + range.to;
    }

    // What can be done with the lines that are picked out. Two things, and
    // they are different in kind: one leaves a mark on the pull request that
    // other people will read, the other asks a model a question that nobody
    // else ever sees.
    function renderPickBar(file) {
      var range = pickedRange();
      var bar = el('div', 'pickbar');
      bar.appendChild(el('span', 'where', spanLabel(range) + ' of ' + file.path.split('/').pop()));

      if (state.livePr) {
        var comment = el('button', null);
        comment.type = 'button';
        comment.appendChild(svgIcon(CMT_D));
        comment.appendChild(el('span', null, 'Comment'));
        comment.dataset.tip = 'Add this to your draft review on GitHub';
        comment.addEventListener('click', function onComment() {
          pickAction = 'comment';
          render();
        });
        bar.appendChild(comment);
      }

      var askIt = el('button', 'quiet');
      askIt.type = 'button';
      askIt.appendChild(svgIcon(BOT_D));
      askIt.appendChild(el('span', null, 'Ask'));
      askIt.dataset.tip = 'Ask about these lines. Nobody else sees this.';
      askIt.addEventListener('click', function onAsk() {
        // Anchored on the LAST line of the span, which is where the bar that
        // opened it already is: the box appearing above the lines a reader
        // just dragged over moves the page under them.
        pickAction = 'ask';
        ask.open(ask.anchorKey(file.path, range.to, range.side));
        render();
      });
      bar.appendChild(askIt);

      var drop = el('button', 'quiet');
      drop.type = 'button';
      drop.textContent = 'Cancel';
      drop.addEventListener('click', clearPick);
      bar.appendChild(drop);
      return bar;
    }

    // One conversation, with everyone who has spoken in it. A thread whose
    // first comment is still a draft is yours and unsent; anything else is on
    // the pull request and belongs to whoever wrote it, so this page shows it
    // and does not offer to change it.
    function renderThread(thread) {
      var unsent = thread.comments.length && thread.comments[0].pending;
      var box = el('div', 'cmtbox' + (unsent ? ' draft' : '') + (thread.resolved ? ' resolved' : ''));

      for (var i = 0; i < thread.comments.length; i++) {
        var c = thread.comments[i];
        var head = el('div', 'cmthead');
        head.appendChild(el('span', 'who', c.pending ? (state.ghAccount || 'you') : c.author));
        if (c.pending) head.appendChild(el('span', 'pending', 'pending'));
        if (!i && thread.resolved) {
          var done = el('span', 'stale', 'resolved');
          done.dataset.tip = 'This conversation was marked resolved on GitHub.';
          head.appendChild(done);
        }
        head.appendChild(el('span', 'grow'));
        if (c.url) head.appendChild(openOnGitHub(c.url));
        // Unsent, or posted and yours to take back. Whether it is yours is
        // GitHub's answer rather than a login comparison here: an admin can
        // delete what they did not write, and an author sometimes cannot
        // delete what they did.
        if (c.pending || c.canDelete) head.appendChild(deleteButton(c));
        box.appendChild(head);

        var body = el('div', 'cmtbody prose');
        renderMarkdown(body, c.body);
        box.appendChild(body);
      }
      return box;
    }

    // Which comments are one press from gone, and which have been asked about
    // once already. Keyed by id and kept outside the render, since every
    // render rebuilds these buttons.
    var confirmingDelete = {};

    function deleteButton(comment) {
      var asked = !!confirmingDelete[comment.id];
      // A draft is yours alone and unsent, so it goes on one press. A posted
      // one is on the pull request and other people may have read it, so it
      // asks first — same two-press confirmation the draft review uses, for
      // the same reason.
      var needsAsking = !comment.pending;
      var drop = el('button', asked ? 'sure' : null, asked ? 'Delete for everyone?' : 'Delete');
      drop.type = 'button';
      if (needsAsking && !asked) {
        drop.dataset.tip = 'This comment is on the pull request. Deleting it removes it for everyone.';
      }
      drop.addEventListener('click', function onDrop(ev) {
        ev.stopPropagation();
        if (needsAsking && !asked) {
          confirmingDelete[comment.id] = true;
          render();
          return;
        }
        delete confirmingDelete[comment.id];
        drop.disabled = true;
        api('DELETE', '/reviews/' + state.session + '/comments', { id: comment.id })
          .then(function gone() {
            // Re-read rather than splice: the threads, the draft and the
            // conversation all hold comments, and keeping three copies in
            // step by hand is how one of them goes stale.
            return loadDraft();
          })
          .then(render)
          .catch(function failed(e) {
            drop.disabled = false;
            showFlash(e.message);
            render();
          });
      });
      return drop;
    }

    // What a submitted review gets instead of a delete, because GitHub allows
    // no delete: it collapses behind a reason, stays readable to anyone who
    // unfolds it, and can be put back — over there. Saying "cannot be
    // deleted" and stopping was true and useless.
    function hideButton(one) {
      var asked = !!confirmingDelete[one.id];
      var hide = el('button', asked ? 'sure' : null, asked ? 'Hide as outdated?' : 'Hide');
      hide.type = 'button';
      if (!asked) hide.dataset.tip = 'GitHub will not delete a submitted review. This folds it away as outdated, which anyone can undo there.';
      hide.addEventListener('click', function onHide(ev) {
        ev.stopPropagation();
        if (!asked) {
          confirmingDelete[one.id] = true;
          render();
          return;
        }
        delete confirmingDelete[one.id];
        hide.disabled = true;
        api('DELETE', '/reviews/' + state.session + '/comments', {
          id: one.id, hide: true, reason: 'outdated',
        })
          .then(loadDraft)
          .then(render)
          .catch(function failed(e) {
            hide.disabled = false;
            showFlash(e.message);
            render();
          });
      });
      return hide;
    }

    // Replying, resolving and editing all live on GitHub. Rather than half a
    // conversation UI, this is the way to the whole one.
    function openOnGitHub(url, word) {
      var link = document.createElement('a');
      link.className = 'cmtlink';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      // "Reply" beside a line comment, because that is what you would go and
      // do. Beside a verdict there is nothing to reply to.
      link.textContent = word || 'Reply on GitHub';
      return link;
    }

    // Writing one. It posts straight to the draft on GitHub rather than
    // queueing here: a comment you have written should survive closing the
    // tab, and GitHub's own draft is the only place that can be true.
    function renderComposer(file) {
      var range = pickedRange();
      var box = el('div', 'cmtbox');
      var head = el('div', 'cmthead');
      head.appendChild(el('span', 'who', 'Comment on ' + spanLabel(range).toLowerCase()));
      box.appendChild(head);

      var form = el('div', 'cmtform');
      var area = document.createElement('textarea');
      area.value = composeDraft;
      area.placeholder = 'Leave a comment';
      area.setAttribute('aria-label', 'Your comment');
      area.addEventListener('input', function onType() { composeDraft = area.value; });
      form.appendChild(area);

      // GitHub offers no image upload outside its own site, so this says what
      // it can rather than a paperclip that would not work.
      var hint = el('div', 'cmthint', 'Markdown works. Images have to be dragged onto GitHub itself.');
      form.appendChild(hint);

      var row = el('div', 'cmtrow');
      var problem = el('span', 'grow');
      var cancel = el('button', 'quiet', 'Cancel');
      cancel.type = 'button';
      row.appendChild(problem);
      row.appendChild(cancel);

      function close() {
        composeDraft = '';
        clearPick();
      }
      cancel.addEventListener('click', close);

      function send(mode, button) {
        var text = area.value.trim();
        if (!text) return close();
        button.disabled = true;
        problem.textContent = '';
        api('POST', '/reviews/' + state.session + '/comments', {
          mode: mode,
          prId: draft.prId,
          headSha: draft.headSha,
          reviewId: draft.reviewId,
          path: file.path,
          line: range.to,
          startLine: range.from === range.to ? null : range.from,
          side: range.side,
          body: text,
        })
          .then(function sent() {
            // Re-read, both ways. What the page draws beside a line is
            // draft.threads, which is GitHub's list of every conversation —
            // so a new comment only appears once that list is fetched again.
            // This used to push the new comment onto draft.comments instead,
            // which was what the page drew when the composer was written and
            // has not been since; the comment went to GitHub and the page
            // showed nothing until a reload.
            //
            // The same read covers the posted case, where there is no local
            // object to push at all.
            composeDraft = '';
            picked = null;
            pickAction = null;
            return loadDraft();
          })
          .then(render)
          .catch(function failed(e) {
            button.disabled = false;
            // Kept in the box: the comment is still in the textarea behind it,
            // and closing to show the error would lose what was written.
            problem.textContent = e.message;
          });
      }

      // Only where there is no draft yet. Once a review is open, a comment
      // that jumps the queue ahead of it is a trap rather than a choice, and
      // GitHub stops offering it at the same point for the same reason.
      if (!draft.reviewId) {
        var now = el('button', 'quiet', 'Comment');
        now.type = 'button';
        now.dataset.tip = 'Post this on its own, right now. Everyone watching the pull request sees it.';
        now.addEventListener('click', function onNow() { send('now', now); });
        row.appendChild(now);
      }

      var add = el('button', null, draft.reviewId ? 'Add to review' : 'Start a review');
      add.type = 'button';
      add.dataset.tip = draft.reviewId
        ? 'Add this to your draft. It goes out when you submit the review.'
        : 'Begin a draft review. Nothing goes out until you submit it.';
      add.addEventListener('click', function onAdd() { send('draft', add); });
      row.appendChild(add);

      form.appendChild(row);
      box.appendChild(form);
      area.addEventListener('keydown', function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      });
      setTimeout(function focusIt() { area.focus(); }, 0);
      return box;
    }

    function renderLine(file, line) {
      var row = el('div', 'dl ' + (line.type === 'ctx' ? 'ctx' : line.type)
        + (isPicked(file, line) ? ' picked' : ''));
      row.appendChild(el('span', 'ln old', line.oldNo === null ? '' : line.oldNo));
      row.appendChild(el('span', 'ln new', line.newNo === null ? '' : line.newNo));

      var no = line.newNo !== null ? line.newNo : line.oldNo;
      var side = line.newNo !== null ? 'new' : 'old';
      var pickBtn = el('button', 'pick', '+');
      pickBtn.type = 'button';
      pickBtn.dataset.tip = 'Pick this line. Shift-click or drag for a span.';
      pickBtn.setAttribute('aria-label', 'Pick line ' + no);
      pickBtn.addEventListener('click', function onPick(ev) {
        ev.stopPropagation();
        // Shift extends the current selection when it is in the same file and
        // on the same side; anything else starts a new one. A span across the
        // two sides of a diff is not a thing GitHub can take a comment on.
        var same = picked && picked.path === file.path && picked.side === side;
        if (ev.shiftKey && same) {
          picked = { path: file.path, side: side, from: picked.from, to: no };
        } else if (same && isPicked(file, line)) {
          // Pressing inside the current selection puts it down. Only the line
          // itself used to do that, which left no way to clear a span except
          // starting another one somewhere else.
          picked = null;
          ask.close();
        } else {
          picked = { path: file.path, side: side, from: no, to: no };
        }
        pickAction = null;
        render();
      });
      // Drag to take a span, which is how a reader reaches for one without
      // knowing there is a modifier.
      pickBtn.addEventListener('pointerdown', function onDown(ev) {
        if (ev.shiftKey) return;
        dragging = { path: file.path, side: side, from: no };
      });
      row.addEventListener('pointerenter', function onOver() {
        if (!dragging || dragging.path !== file.path || dragging.side !== side) return;
        picked = { path: file.path, side: side, from: dragging.from, to: no };
        pickAction = null;
        render();
      });
      row.appendChild(pickBtn);

      row.appendChild(el('span', 'sg', line.type === 'add' ? '+' : line.type === 'del' ? '\\u2212' : ' '));
      row.appendChild(renderText(line, file.language));
      return row;
    }

    // Syntax spans first, then the intra-line range painted over them. Doing it
    // in this order means a one-character change inside a string still shows as
    // a one-character change.
    function renderText(line, language) {
      var tx = el('span', 'tx');
      var spans = tokenizeLine(line.text, language);
      var at = 0;
      // A zero-width range marks nothing; treated as absent so it cannot
      // produce an empty highlight span. The server already declines to send
      // one, but ranges arrive over the wire and this is where the damage
      // would show.
      var range = line.range && line.range[1] > line.range[0] ? line.range : null;
      for (var i = 0; i < spans.length; i++) {
        var span = spans[i];
        var start = at;
        var end = at + span.text.length;
        at = end;
        if (!range || end <= range[0] || start >= range[1]) {
          tx.appendChild(mkSpan(span.cls, span.text, false));
          continue;
        }
        // The span straddles the changed range: emit up to three pieces.
        var a = Math.max(start, range[0]);
        var b = Math.min(end, range[1]);
        if (a > start) tx.appendChild(mkSpan(span.cls, span.text.slice(0, a - start), false));
        tx.appendChild(mkSpan(span.cls, span.text.slice(a - start, b - start), true));
        if (b < end) tx.appendChild(mkSpan(span.cls, span.text.slice(b - start), false));
      }
      if (!spans.length) tx.textContent = line.text;
      return tx;
    }

    function mkSpan(cls, text, isWord) {
      var classes = [];
      if (cls) classes.push('tk-' + cls);
      if (isWord) classes.push('word');
      return el('span', classes.join(' '), text);
    }

    // --- file tree ----------------------------------------------------------
    //
    // Built from the diff, not the artifact, so it is there before the
    // analysis lands and complete whatever the model returned. Directories
    // with a single child fold into their parent the way GitHub draws them,
    // so web/src/features/orders/detail reads as one row, not four.

    function roleByPath() {
      var roles = {};
      var groups = (state.review && state.review.groups) || [];
      for (var g = 0; g < groups.length; g++) {
        var files = groups[g].files || [];
        for (var i = 0; i < files.length; i++) {
          if (files[i] && files[i].path && files[i].role) roles[files[i].path] = files[i].role;
        }
      }
      return roles;
    }

    function buildTreeIndex(files) {
      var root = { dirs: {}, files: [] };
      for (var i = 0; i < files.length; i++) {
        var parts = files[i].path.split('/');
        var node = root;
        for (var d = 0; d < parts.length - 1; d++) {
          if (!node.dirs[parts[d]]) node.dirs[parts[d]] = { dirs: {}, files: [] };
          node = node.dirs[parts[d]];
        }
        node.files.push(files[i]);
      }
      return root;
    }

    // The tree that navigates the diff. Only the files half of the page has
    // one to navigate: beside the prose it was a column of filenames with
    // nothing to point at.
    function buildTree() {
      var files = (state.diff && state.diff.files) || [];
      if (!files.length) return null;
      var aside = el('aside', 'tree');
      aside.id = 'tree';
      aside.setAttribute('aria-label', 'Changed files');
      renderTreeNode(aside, buildTreeIndex(files), '', roleByPath());
      return aside;
    }

    // Octicons' file-directory-fill and file, at 16 and drawn at 13. Built
    // node by node like the rest of the page rather than through innerHTML,
    // which is the rule these two are the only markup on the page tempted to
    // break.
    var TREE_ICON_PATHS = {
      dir: 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z',
      file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z',
    };

    function treeIcon(kind) {
      var svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'ticon');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', TREE_ICON_PATHS[kind]);
      svg.appendChild(path);
      return svg;
    }

    function renderTreeNode(container, node, prefix, roles) {
      var names = Object.keys(node.dirs).sort();
      for (var i = 0; i < names.length; i++) {
        // Fold a chain of single-child directories into one row.
        var label = names[i];
        var child = node.dirs[names[i]];
        while (!child.files.length && Object.keys(child.dirs).length === 1) {
          var only = Object.keys(child.dirs)[0];
          label += '/' + only;
          child = child.dirs[only];
        }
        var dirPath = prefix + label + '/';
        var folded = !!foldedDirs[dirPath];
        var row = el('button', 'tree-dir');
        row.type = 'button';
        row.setAttribute('aria-expanded', folded ? 'false' : 'true');
        row.appendChild(el('span', 'chev', folded ? '\\u25b8' : '\\u25be'));
        row.appendChild(treeIcon('dir'));
        row.appendChild(el('span', 'tname', label));
        row.title = dirPath;
        row.addEventListener('click', function fold(path) {
          return function onFold() {
            foldedDirs[path] = !foldedDirs[path];
            renderTree();
            spy();
          };
        }(dirPath));
        container.appendChild(row);
        var kids = el('div', 'tree-kids');
        kids.hidden = folded;
        renderTreeNode(kids, child, dirPath, roles);
        container.appendChild(kids);
      }
      var files = node.files.slice().sort(function byName(a, b) {
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      for (var f = 0; f < files.length; f++) container.appendChild(renderTreeFile(files[f], roles[files[f].path]));
    }

    function renderTreeFile(file, role) {
      var row = el('button', 'tree-file'
        + (file.status === 'added' || file.status === 'deleted' ? ' ' + file.status : '')
        + (isViewed(file) ? ' seen' : ''));
      row.type = 'button';
      row.dataset.path = file.path;
      row.title = file.path;
      if (file.path === activePath) row.classList.add('on');
      row.appendChild(treeIcon('file'));
      row.appendChild(el('span', 'tname', file.path.slice(file.path.lastIndexOf('/') + 1)));
      var talks = threadCountFor(file);
      if (talks) {
        var mark = el('span', 'tcmt', String(talks));
        mark.dataset.tip = talks === 1 ? 'One conversation' : talks + ' conversations';
        row.appendChild(mark);
      }
      // Only the roles that tell you to skip a file. "core" is the default
      // reading and a chip on every row would be noise.
      if (role && role !== 'core' && role !== 'support') row.appendChild(el('span', 'chip', role));
      var counts = el('span', 'tcount');
      counts.appendChild(el('span', 'p', '+' + file.additions));
      counts.appendChild(el('span', 'm', '\\u2212' + file.deletions));
      row.appendChild(counts);
      row.addEventListener('click', function onJump() { jumpToFile(file.path); });
      return row;
    }

    function cardFor(path) {
      var cards = document.querySelectorAll('.fcard');
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].dataset.path === path) return cards[i];
      }
      return null;
    }

    function jumpToFile(path) {
      // Only when it is not already showing — under the launcher's
      // expand-everything setting most files are, and re-rendering to open
      // one that is open throws away the scroll this is about to set.
      if (!isFileOpen(path)) {
        openFiles[path] = true;
        render();
      }
      var card = cardFor(path);
      if (!card) return;
      // The bar sticks at the top edge, so putting the card's top there is
      // exactly where a reader expects it to land.
      var top = card.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, top - 4), behavior: 'auto' });
      setActive(path);
    }

    // Which file is under the top of the viewport: the last card whose top
    // has scrolled past it. Cheap enough to run on every scroll frame.
    var spyQueued = false;
    function spy() {
      spyQueued = false;
      var cards = document.querySelectorAll('.fcard');
      var best = null;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].getBoundingClientRect().top > 48) break;
        best = cards[i];
      }
      setActive(best ? best.dataset.path : null);
    }

    function setActive(path) {
      activePath = path;
      var rows = document.querySelectorAll('.tree-file');
      var aside = document.getElementById('tree');
      // There is no tree on the analysis half of the page, and the scroll
      // listener does not know which half it is on.
      if (!aside) return;
      for (var i = 0; i < rows.length; i++) {
        var on = rows[i].dataset.path === path;
        rows[i].classList.toggle('on', on);
        if (!on) continue;
        // Keep the active row in view in the tree's own scroller. Not
        // scrollIntoView, which would also scroll the window the reader is
        // in the middle of scrolling.
        var rowTop = rows[i].offsetTop;
        var rowBottom = rowTop + rows[i].offsetHeight;
        if (rowTop < aside.scrollTop) aside.scrollTop = rowTop - 8;
        else if (rowBottom > aside.scrollTop + aside.clientHeight) aside.scrollTop = rowBottom - aside.clientHeight + 8;
      }
    }

    window.addEventListener('scroll', function onScroll() {
      if (spyQueued) return;
      spyQueued = true;
      requestAnimationFrame(spy);
    }, { passive: true });

    // --- ask ----------------------------------------------------------------
    //
    // Every panel is rebuilt from askState on every render, and holds no state
    // of its own. The three rules that keep it that way:
    //
    //   * the draft is written to askState on every keystroke, never read back
    //     off the DOM at render time;
    //   * an answer is stored against (anchor, question), so the panel shows
    //     one only when it answers what is currently typed;
    //   * focus is taken from askState exactly once, by the render that
    //     follows the click that opened the panel. Any other render — a poll,
    //     another file being expanded, the artifact landing — finds the
    //     one-shot already spent and leaves the caret where the user put it.

    // One place that paints the conversation at an anchor, used both when an
    // answer arrives and when a panel is rebuilt, so the two cannot drift apart.
    function paintThread(out, anchor) {
      out.replaceChildren();
      var turns = ask.thread(anchor);
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        if (t.role !== 'assistant') { out.appendChild(el('div', 'askq', t.text)); continue; }
        var reply = el('div', 'askreply');
        renderMarkdown(reply, t.text || '');
        out.appendChild(reply);
        var foot = [];
        if (t.steps) foot.push(t.steps + ' steps');
        if (t.durationMs) foot.push(Math.round(t.durationMs / 1000) + 's');
        // Only when a dollar figure means a dollar. On this box the harness
        // reports total_cost_usd against an OAuth subscription, where it is a
        // notional API-rate valuation and not a charge. The server still logs it.
        if (state.showCosts && typeof t.costUsd === 'number') foot.push('$' + t.costUsd.toFixed(3));
        if (foot.length) out.appendChild(el('div', 'askfoot', foot.join(' \\u00b7 ')));
      }
    }

    function waitingRow() {
      var waiting = el('div', 'askwait');
      waiting.appendChild(spinner());
      waiting.appendChild(el('span', null, 'reading the code\\u2026'));
      return waiting;
    }

    function renderAsk(file, line, anchor) {
      var panel = el('div', 'askpanel');
      // The panel carries its own identity. Nothing has to infer which anchor
      // a panel belongs to from a variable that may already have moved on —
      // that inference is exactly what filed drafts under the wrong key.
      panel.dataset.anchor = anchor;

      var lineNo = line ? (line.newNo !== null ? line.newNo : line.oldNo) : null;
      var span = pickedRange();
      var spanned = line && span && span.path === file.path && span.to === lineNo && span.to !== span.from;
      var where = line
        ? file.path + ':' + (spanned ? span.from + '-' + span.to : lineNo)
        : file.path;
      var head = el('div', 'askwhere');
      head.appendChild(el('span', 'grow', where));
      var shut = el('button', null, '\\u00d7');
      shut.type = 'button';
      shut.dataset.tip = 'Close (or press Escape)';
      shut.setAttribute('aria-label', 'Close this question');
      shut.addEventListener('click', function onShut(ev) {
        ev.stopPropagation();
        ask.close();
        clearPick();
      });
      head.appendChild(shut);
      panel.appendChild(head);

      // The thread sits above the box, like a chat: the first question opens
      // it and every later one is a follow-up that carries the turns before it.
      var out = el('div', 'aska');
      panel.appendChild(out);
      paintThread(out, anchor);
      var failed = ask.error(anchor);
      if (failed) out.appendChild(el('p', 'askerr', failed));

      var row = el('div', 'askrow');
      var input = document.createElement('input');
      input.type = 'text';
      var followUp = ask.thread(anchor).length > 0;
      input.placeholder = followUp
        ? 'Ask a follow-up\\u2026'
        : (line
          ? (spanned ? 'What should I explain about these lines?' : 'What should I explain about this line?')
          : 'What should I explain about this file?');
      input.setAttribute('aria-label', (followUp ? 'Follow-up about ' : 'Question about ') + where);
      input.value = ask.draft(anchor);
      var go = el('button', null, followUp ? 'Send' : 'Explain');
      row.appendChild(input);
      row.appendChild(go);
      panel.appendChild(row);

      // A run that is still going when the panel is rebuilt: say so rather
      // than showing an idle box that looks like nothing was asked.
      if (ask.isBusy(anchor)) {
        go.disabled = true;
        input.disabled = true;
        out.appendChild(waitingRow());
      }

      input.addEventListener('input', function onEdit() {
        ask.setDraft(anchor, input.value);
      });

      function run() {
        var asked = input.value.trim();
        if (!asked && followUp) return;
        // Sent before this turn is added, so the server sees only what came before it.
        var before = ask.thread(anchor);
        ask.setDraft(anchor, input.value);
        ask.setBusy(anchor, true);
        go.disabled = true;
        input.disabled = true;
        var oldErr = out.querySelector('.askerr');
        if (oldErr) oldErr.remove();
        out.appendChild(waitingRow());
        askServer(file, line, asked, before)
          .then(function done(answer) {
            ask.setBusy(anchor, false);
            ask.addTurn(anchor, asked, answer);
            ask.setDraft(anchor, '');
            // The panel may have been rebuilt or closed while the run was in
            // flight. Rebuild whatever is on screen for this anchor now; if
            // nothing is, the turn is in askState for when it reopens.
            var live = livePanel(anchor);
            if (!live) return;
            // The box was disabled during the run, so focus fell to the body.
            // Give it back only if nothing else has taken it since.
            var active = document.activeElement;
            var hadFocus = !active || active === document.body || live.contains(active);
            var fresh = renderAsk(file, line, anchor);
            live.replaceWith(fresh);
            var freshInput = fresh.querySelector('input');
            if (hadFocus && freshInput) freshInput.focus({ preventScroll: true });
          })
          .catch(function failedRun(e) {
            ask.setBusy(anchor, false);
            ask.setError(anchor, e.message);
            var live = livePanel(anchor);
            if (!live) return;
            live.replaceWith(renderAsk(file, line, anchor));
          });
      }
      go.addEventListener('click', run);
      input.addEventListener('keydown', function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); run(); }
      });

      // The one-shot. Only the render that follows an open gets it.
      if (ask.takeFocus(anchor)) {
        setTimeout(function focusIt() {
          if (document.body.contains(input)) input.focus();
        }, 0);
      }
      return panel;
    }

    // The panel currently on screen for an anchor, if any. Found by the
    // anchor the panel itself carries, so an async callback never has to
    // guess whether the DOM it captured is still the DOM there is.
    function livePanel(anchor) {
      var panels = document.querySelectorAll('.askpanel');
      for (var i = 0; i < panels.length; i++) {
        if (panels[i].dataset.anchor === anchor) return panels[i];
      }
      return null;
    }

    async function askServer(file, line, question, history) {
      var body = { path: file.path, question: question };
      if (history && history.length) {
        body.history = history.map(function slim(t) { return { role: t.role, text: t.text }; });
      }
      if (line) body.line = line.newNo !== null ? line.newNo : line.oldNo;
      if (line) body.side = line.newNo !== null ? 'new' : 'old';
      // A span, when the question came from one. The panel is anchored on its
      // first line, so this is the only thing carrying the rest of it.
      var span = pickedRange();
      if (line && span && span.path === file.path && span.to === body.line && span.to !== span.from) {
        // The panel sits on the last line, so that is what the row gave us;
        // the question is about the whole span.
        body.line = span.from;
        body.endLine = span.to;
      }
      var started = await api('POST', '/reviews/' + state.session + '/explain', body);
      if (started.answer) return started.answer;
      return pollAnswer(started.askId);
    }

    // Poll until a one-shot run lands. Explains and chat turns are short; a
    // 1.5s cadence is responsive without hammering.
    async function pollAnswer(askId) {
      for (var i = 0; i < 160; i++) {
        await new Promise(function wait(r) { setTimeout(r, 1500); });
        var got = await api('GET', '/reviews/' + state.session + '/explain/' + askId);
        if (got.status === 'ready') return got.answer;
        if (got.status === 'failed') throw new Error(got.error || 'the run failed');
      }
      throw new Error('timed out waiting for an answer');
    }

    // --- chat ---------------------------------------------------------------
    //
    // The transcript is the server's: every answered turn is appended to the
    // session's chat.json there, and the page re-reads it after each answer
    // rather than keeping a copy that could drift. What the page holds is only
    // the turn in flight — the question just sent and not yet answered — so a
    // reload mid-answer picks the poll back up from the askId the server
    // reports and shows the question where it was.

    var chat = { messages: [], pending: null, busy: false, error: null, open: false, loaded: false };

    function chatEls() {
      return {
        aside: document.getElementById('chat'),
        log: document.getElementById('chatLog'),
        input: document.getElementById('chatInput'),
        send: document.getElementById('chatSend'),
        open: document.getElementById('chatOpen'),
      };
    }

    function renderChat() {
      var els = chatEls();
      els.log.replaceChildren();
      els.log.classList.toggle('blank', !chat.messages.length && !chat.pending && !chat.busy);
      if (!chat.messages.length && !chat.pending) {
        var hint = el('div', 'chat-hint');
        hint.appendChild(el('p', null, 'A conversation about the change as a whole, with the branch checked out to read from. Start with one of these, or ask your own:'));
        var starters = el('div', 'chat-starters');
        var picks = chatStarters();
        for (var s = 0; s < picks.length; s++) starters.appendChild(starterButton(picks[s]));
        hint.appendChild(starters);
        els.log.appendChild(hint);
      }
      for (var i = 0; i < chat.messages.length; i++) els.log.appendChild(renderChatMessage(chat.messages[i]));
      if (chat.pending) els.log.appendChild(renderChatMessage({ role: 'user', text: chat.pending }));
      if (chat.busy) {
        var busy = el('div', 'msg wait');
        busy.appendChild(spinner());
        busy.appendChild(el('span', null, 'reading the code\\u2026'));
        els.log.appendChild(busy);
      }
      if (chat.error) els.log.appendChild(el('div', 'chat-err', chat.error));
      els.send.disabled = chat.busy;
      els.log.scrollTop = els.log.scrollHeight;
    }

    // The analysis's own questions first, since they are about this change,
    // then general ones to fill out to five.
    var GENERAL_STARTERS = [
      'What should I look at first?',
      'What could this break, and for whom?',
      'What is not covered by tests?',
      'Why was it done this way rather than the obvious alternative?',
      'What should I try by hand before approving?',
    ];
    function chatStarters() {
      var out = [];
      var qs = (state.review && state.review.questions) || [];
      for (var i = 0; i < qs.length && out.length < 3; i++) out.push(qs[i].question);
      for (var j = 0; j < GENERAL_STARTERS.length && out.length < 5; j++) out.push(GENERAL_STARTERS[j]);
      return out;
    }

    function starterButton(text) {
      var b = el('button', 'chat-starter');
      // The analysis writes its questions as markdown, so a name in one is drawn as code here.
      inline(b, text);
      b.type = 'button';
      b.disabled = chat.busy;
      b.addEventListener('click', function onStarter() { askInChat(text); });
      return b;
    }

    // Opens the conversation and sends the question as if it had been typed:
    // without the analysis's code marks, which a typed message would show as
    // they are.
    function askInChat(markdown) {
      var text = String(markdown).split(String.fromCharCode(96)).join('');
      if (!chat.open) setChatOpen(true);
      if (chat.busy) {
        // Something is being answered: leave it in the box to send after.
        var input = chatEls().input;
        input.value = text;
        autosize(input);
        return;
      }
      chatEls().input.value = text;
      sendChat();
    }

    function renderChatMessage(m) {
      if (m.role !== 'assistant') return el('div', 'msg user', m.text);
      var box = el('div', 'msg bot');
      var body = el('div', 'prose');
      renderMarkdown(body, m.text || '');
      box.appendChild(body);
      var foot = [];
      if (m.steps) foot.push(m.steps + ' steps');
      if (m.durationMs) foot.push(Math.round(m.durationMs / 1000) + 's');
      if (state.showCosts && typeof m.costUsd === 'number') foot.push('$' + m.costUsd.toFixed(3));
      if (foot.length) box.appendChild(el('div', 'foot', foot.join(' \\u00b7 ')));
      return box;
    }

    async function loadChat() {
      if (!state.session) return;
      var got = await api('GET', '/reviews/' + state.session + '/chat');
      chat.messages = got.messages || [];
      chat.loaded = true;
      renderChat();
      // A turn still being answered when the page loaded: pick the poll up.
      if (got.running && !chat.busy) {
        chat.busy = true;
        renderChat();
        await settleChat(pollAnswer(got.running));
      }
    }

    async function settleChat(answering) {
      try {
        await answering;
        chat.error = null;
        var got = await api('GET', '/reviews/' + state.session + '/chat');
        chat.messages = got.messages || [];
      } catch (e) {
        chat.error = e.message;
        // The question goes back into the box: a failed turn is not on the
        // record, and retyping it is the one thing this must not cost.
        if (chat.pending) chatEls().input.value = chat.pending;
      }
      chat.busy = false;
      chat.pending = null;
      renderChat();
    }

    async function sendChat() {
      var els = chatEls();
      var text = els.input.value.trim();
      if (!text || chat.busy) return;
      chat.pending = text;
      chat.busy = true;
      chat.error = null;
      els.input.value = '';
      autosize(els.input);
      renderChat();
      await settleChat(
        api('POST', '/reviews/' + state.session + '/chat', { question: text })
          .then(function started(res) { return pollAnswer(res.askId); }));
      if (chat.open) els.input.focus({ preventScroll: true });
    }

    function autosize(ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 144) + 'px';
    }

    // Open state is remembered per browser and reachable from the URL, so a
    // link with chat=1 lands with the conversation showing.
    function setChatOpen(open) {
      chat.open = open;
      var els = chatEls();
      els.aside.hidden = !open;
      els.open.hidden = open || !state.session;
      var layout = document.getElementById('layout');
      layout.classList.toggle('with-chat', open);
      // The rail gets a track of its own whenever there is a session to talk
      // about. Without one the document would spread under it — the rail is
      // fixed, not a grid item — and the last inch of every diff row would
      // sit behind it.
      layout.classList.toggle('with-rail', !open && !!state.session);
      try { localStorage.setItem('shed.review.chat', open ? '1' : '0'); } catch (e) {}
      var url = new URL(window.location.href);
      if (open) url.searchParams.set('chat', '1'); else url.searchParams.delete('chat');
      history.replaceState(null, '', url.toString());
      if (open) {
        if (!chat.loaded) loadChat().catch(function failed(e) { chat.error = e.message; renderChat(); });
        else renderChat();
        setTimeout(function focusIt() { els.input.focus({ preventScroll: true }); }, 0);
      }
    }

    // How wide the conversation is, in rem, remembered per browser beside the
    // theme and the fold setting. Bounded: narrower than this and the composer
    // cannot hold a sentence, wider and the diff it is about stops being
    // readable beside it.
    var CHAT_MIN_REM = 20;
    var CHAT_MAX_REM = 54;
    var CHAT_DEFAULT_REM = 24;

    function rootFontPx() {
      return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    }

    function applyChatWidth(rem) {
      var clamped = Math.min(CHAT_MAX_REM, Math.max(CHAT_MIN_REM, rem));
      document.documentElement.style.setProperty('--chat-w', clamped + 'rem');
      return clamped;
    }

    function loadChatWidth() {
      var rem = CHAT_DEFAULT_REM;
      try {
        var saved = parseFloat(localStorage.getItem('shed.review.chatw'));
        if (saved > 0) rem = saved;
      } catch (e) {
        // Blocked site data. The default is a fine answer.
      }
      applyChatWidth(rem);
    }

    function saveChatWidth(rem) {
      try { localStorage.setItem('shed.review.chatw', String(rem)); } catch (e) {}
    }

    function initChatResize() {
      var grip = document.getElementById('chatGrip');
      var aside = document.getElementById('chat');
      var startX = 0;
      var startRem = CHAT_DEFAULT_REM;

      function onMove(ev) {
        // Dragging left widens: the panel is anchored to the right edge, so
        // the pointer moving away from it is the panel growing toward it.
        var deltaRem = (startX - ev.clientX) / rootFontPx();
        applyChatWidth(startRem + deltaRem);
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing-chat');
        aside.classList.remove('resizing');
        var now = parseFloat(document.documentElement.style.getPropertyValue('--chat-w'));
        if (now > 0) saveChatWidth(now);
      }
      grip.addEventListener('pointerdown', function onDown(ev) {
        ev.preventDefault();
        startX = ev.clientX;
        startRem = parseFloat(document.documentElement.style.getPropertyValue('--chat-w')) || CHAT_DEFAULT_REM;
        document.body.classList.add('resizing-chat');
        aside.classList.add('resizing');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      // Back to where it started, for anyone who has dragged it somewhere odd.
      grip.addEventListener('dblclick', function onReset() {
        saveChatWidth(applyChatWidth(CHAT_DEFAULT_REM));
      });
      // The keyboard gets the same control, since the grip takes focus.
      grip.addEventListener('keydown', function onKey(ev) {
        var step = ev.shiftKey ? 4 : 1;
        var now = parseFloat(document.documentElement.style.getPropertyValue('--chat-w')) || CHAT_DEFAULT_REM;
        if (ev.key === 'ArrowLeft') { ev.preventDefault(); saveChatWidth(applyChatWidth(now + step)); }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); saveChatWidth(applyChatWidth(now - step)); }
      });
    }

    function initChat() {
      var els = chatEls();
      loadChatWidth();
      initChatResize();
      els.open.addEventListener('click', function onOpen() { setChatOpen(true); });
      document.getElementById('chatClose').addEventListener('click', function onClose() { setChatOpen(false); });
      document.getElementById('chatForm').addEventListener('submit', function onSubmit(ev) {
        ev.preventDefault();
        sendChat();
      });
      els.input.addEventListener('input', function onType() { autosize(els.input); });
      // Enter sends; shift+enter is a newline, the way every chat box works.
      els.input.addEventListener('keydown', function onKey(ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChat(); }
      });
      // A restored draft has to size the box before it is shown, or a two
      // line question opens in a one line slot.
      autosize(els.input);
      var wanted = initialUrl.searchParams.get('chat') === '1';
      if (!wanted) {
        try { wanted = localStorage.getItem('shed.review.chat') === '1'; } catch (e) {}
      }
      setChatOpen(wanted);
    }

    // A deliberately small markdown renderer: paragraphs, headings, fenced
    // code, bullet and numbered lists, all built with createElement. The model
    // returns markdown and this page never uses innerHTML, so without this
    // you read literal asterisks. Everything the model wrote goes through it —
    // overview, architecture, each act's why, each preamble, the answers.
    function renderMarkdown(root, text) {
      // Raw HTML and horizontal rules are dropped rather than printed. A
      // GitHub review body is written for GitHub, which renders <details> and
      // <summary>; this page does not, and showing the tags as words is worse
      // than showing neither. Nothing is interpreted as markup — the lines
      // are simply not drawn.
      var lines = [];
      var raw = String(text).split('\\n');
      for (var r = 0; r < raw.length; r++) {
        // Tags come out wherever they are, not only on lines of their own:
        // GitHub's own review bodies write <summary>Heading</summary> with the
        // words inside, and dropping the whole line would drop the heading
        // with it. Nothing is interpreted as markup either way — every node
        // below is built with textContent.
        var line = raw[r].replace(/<\\/?[a-zA-Z][^>]*>/g, '');
        var bare = line.trim();
        if (/^-{3,}$/.test(bare) || /^\\*{3,}$/.test(bare)) continue;
        lines.push(line);
      }
      var i = 0;
      var para = [];
      var list = null;

      function flushPara() {
        if (!para.length) return;
        var p = document.createElement('p');
        inline(p, para.join(' '));
        root.appendChild(p);
        para = [];
      }
      function flushList() {
        if (list) root.appendChild(list);
        list = null;
      }

      while (i < lines.length) {
        var line = lines[i];
        if (line.slice(0, 3) === '\\u0060\\u0060\\u0060') {
          flushPara(); flushList();
          i++;
          var code = [];
          while (i < lines.length && lines[i].slice(0, 3) !== '\\u0060\\u0060\\u0060') { code.push(lines[i]); i++; }
          i++;
          var pre = document.createElement('pre');
          pre.textContent = code.join('\\n');
          root.appendChild(pre);
          continue;
        }
        var heading = /^#{1,4}\\s+(.*?)\\s*#*\\s*$/.exec(line);
        if (heading) {
          flushPara(); flushList();
          var h = document.createElement('h4');
          inline(h, heading[1]);
          root.appendChild(h);
          i++;
          continue;
        }
        // A caution pulled out of the flow. Rendered through this same
        // function so a quote can hold a paragraph and its inline code.
        if (/^\\s*>\\s?/.test(line)) {
          flushPara(); flushList();
          var quoted = [];
          while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\\s*>\\s?/, ''));
            i++;
          }
          var quote = document.createElement('blockquote');
          renderMarkdown(quote, quoted.join('\\n'));
          root.appendChild(quote);
          continue;
        }
        // A table, recognised by the dashed row under its header rather than
        // by the pipes alone — a sentence about a || operator has pipes too.
        if (line.indexOf('|') !== -1 && i + 1 < lines.length
          && /^\\s*\\|?[\\s:|-]*-[\\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
          flushPara(); flushList();
          var rows = [];
          while (i < lines.length && lines[i].indexOf('|') !== -1) { rows.push(lines[i]); i++; }
          root.appendChild(buildTable(rows));
          continue;
        }
        var bullet = /^\\s*(?:[-*]|\\d+[.)])\\s+(.*)$/.exec(line);
        if (bullet) {
          flushPara();
          var tag = /^\\s*\\d/.test(line) ? 'ol' : 'ul';
          if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); }
          var li = document.createElement('li');
          inline(li, bullet[1]);
          list.appendChild(li);
          i++;
          continue;
        }
        if (!line.trim()) { flushPara(); flushList(); i++; continue; }
        // An indented line under an open list item is that item wrapping,
        // not a new paragraph.
        if (list && /^\\s/.test(line) && list.lastChild) {
          list.lastChild.appendChild(document.createTextNode(' '));
          inline(list.lastChild, line.trim());
          i++;
          continue;
        }
        flushList();
        para.push(line.trim());
        i++;
      }
      flushPara();
      flushList();
    }

    // Header row, a dashed row, then the body. Its own scroller, because a
    // table is one of the three things allowed to be wider than the column.
    function buildTable(rows) {
      var wrap = el('div', 'tablewrap');
      var table = document.createElement('table');
      var head = document.createElement('thead');
      head.appendChild(tableRow(rows[0], 'th'));
      table.appendChild(head);
      var body = document.createElement('tbody');
      for (var r = 2; r < rows.length; r++) body.appendChild(tableRow(rows[r], 'td'));
      if (body.childNodes.length) table.appendChild(body);
      wrap.appendChild(table);
      return wrap;
    }

    function tableRow(line, cellTag) {
      var row = document.createElement('tr');
      var cells = String(line).replace(/^\\s*\\|/, '').replace(/\\|\\s*$/, '').split('|');
      for (var c = 0; c < cells.length; c++) {
        var cell = document.createElement(cellTag);
        inline(cell, cells[c].trim());
        row.appendChild(cell);
      }
      return row;
    }

    // Inline code, bold and italics. Everything else stays literal, which is
    // the right failure mode: an unrendered marker is readable, a broken
    // parser is not. Italics only match a single marker with no space inside
    // it, so a stray asterisk in prose stays an asterisk.
    // A markdown link, matched whole so its text and its target do not get
    // split apart by the emphasis pass below.
    var LINK_RE = /^\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)$/;

    function inline(node, text) {
      var parts = String(text).split(/(\\u0060[^\\u0060]+\\u0060|\\[[^\\]]+\\]\\(https?:\\/\\/[^\\s)]+\\)|\\*\\*[^*]+\\*\\*|\\*[^*\\s][^*]*?\\*|\\b_[^_\\s][^_]*?_\\b)/);
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (!part) continue;
        var link = LINK_RE.exec(part);
        if (part.length > 1 && part[0] === '\\u0060' && part[part.length - 1] === '\\u0060') {
          node.appendChild(el('code', null, part.slice(1, -1)));
        } else if (link) {
          // http and https only, and built rather than parsed from markup:
          // this text is a model's or another person's, and javascript: in an
          // href is the one thing a link can be that a reader cannot see.
          var a = document.createElement('a');
          a.href = link[2];
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = link[1];
          node.appendChild(a);
        } else if (part.slice(0, 2) === '**' && part.slice(-2) === '**') {
          var strong = document.createElement('strong');
          inline(strong, part.slice(2, -2));
          node.appendChild(strong);
        } else if (part.length > 2 && ((part[0] === '*' && part.slice(-1) === '*') || (part[0] === '_' && part.slice(-1) === '_'))) {
          var em = document.createElement('em');
          inline(em, part.slice(1, -1));
          node.appendChild(em);
        } else {
          node.appendChild(document.createTextNode(part));
        }
      }
    }

    // --- loading ------------------------------------------------------------

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 2000);
    }

    async function poll() {
      if (!state.session) return;
      try {
        var data = await api('GET', '/reviews/' + state.session);
        var was = state.status;
        state.status = data.status;
        state.progress = data.progress || null;
        state.error = data.error || null;
        state.waiting = data.waiting || null;
        // A re-review replaces the record, so this moves. Polling through one
        // and leaving the old timestamp on screen would be the one lie this
        // line exists to prevent.
        state.createdAt = data.createdAt || state.createdAt || null;
        var arrived = !!data.review && !state.review;
        if (data.review) state.review = data.review;

        // Only rebuild the page when something structural happened: the status
        // changed, or the artifact arrived and the files need reordering.
        // Otherwise refresh the strip in place — render() replaces all of
        // content, which would destroy an open ask panel mid-question every
        // two seconds, and a re-ask after that starts a second paid run.
        var shouldRender = arrived || was !== state.status;
        var again = data.status === 'running' || data.status === 'queued';
        // Rendering happens outside the catch below: that catch is for a failed
        // fetch, and swallowing a rendering throw there would turn a real bug
        // into a silent two-second retry loop.
        if (shouldRender) render();
        else refreshStatusStrip();
        if (again) schedulePoll();
      } catch (e) {
        // A transient poll failure should not blank a page you are reading.
        schedulePoll();
      }
    }

    // Swap the strip's contents without touching the rest of the document.
    function refreshStatusStrip() {
      var existing = document.getElementById('statusStrip');
      if (!existing) return;
      var fresh = renderStatus();
      if (!fresh) {
        existing.remove();
        return;
      }
      fresh.id = 'statusStrip';
      var box = existing.parentNode;
      existing.replaceWith(fresh);
      if (box && box.classList) box.classList.toggle('bad', fresh.classList.contains('bad'));
    }

    // Everything a first open does except binding the chat, so a re-review
    // can reuse it: binding twice would leave two handlers on one Send button.
    async function loadReview(session) {
      var got = await api('GET', '/reviews/' + session);
      state.session = session;
      state.meta = got.meta;
      state.status = got.status;
      state.review = got.review || null;
      state.progress = got.progress || null;
      state.error = got.error || null;
      state.waiting = got.waiting || null;
      state.showCosts = !!got.showCosts;
      // Whose name a verdict will carry. Resolved once at boot on the server;
      // null on a box whose gh cannot say.
      state.ghAccount = got.ghAccount || null;
      state.kind = got.kind;
      state.pr = got.pr || null;
      // Where a verdict can go NOW, which is not the same question as what
      // this review is of. A session reviewing its own work opens the pull
      // request hours later, from that same session.
      state.livePr = got.livePr || null;
      draftLoading = !!state.livePr;
      // The commit this review read. Merging is offered only while the pull
      // request is still at it.
      state.headSha = got.headSha || null;
      stampTab();
      state.reviewBranch = got.reviewBranch || null;
      // The worktree header's "as of" timestamp, and the only answer this
      // feature has to "has the tree moved since". Missing it here made
      // fmtWhen fall back on every render, so the line always read "Working
      // tree as of this review was taken".
      state.createdAt = got.createdAt || null;

      document.title = titleFor(got) + ' \\u2014 Woodshed';

      var diff = await api('GET', '/reviews/' + session + '/diff');
      state.diff = diff;
      render();
      // After the first paint, not before it: the ticks are one more round
      // trip, and a diff that waits on GitHub to draw is a diff that is slower
      // than it was before any of this existed.
      loadViewed().then(render).catch(function failed(e) {
        showFlash('Could not read which files you have viewed on GitHub: ' + e.message);
      });
      loadDraft()
        .catch(function failed(e) {
          showFlash('Could not read your draft review on GitHub: ' + e.message);
        })
        .then(function settled() {
          draftLoading = false;
          render();
        });
      if (state.status === 'running' || state.status === 'queued') schedulePoll();
    }

    async function openSession(session) {
      showError('');
      // The review and its diff are two round trips before anything can be
      // drawn, and a blank page for that long reads as a broken one.
      document.getElementById('content').replaceChildren(loadingNote('Loading the review\\u2026'));
      try {
        await loadReview(session);
        initChat();
      } catch (e) {
        showError(e.message);
      }
    }

    function prTitle() {
      if (state.livePr && state.livePr.title) return state.livePr.title;
      return state.meta.title;
    }

    function titleFor(got) {
      // Whatever the pull request calls itself, where there is one: this is
      // the string a reader scans a row of tabs for.
      if (got.livePr && got.livePr.title) return got.livePr.title;
      if (got.kind === 'pr' && got.pr) return 'PR #' + got.pr;
      // A worktree review is of work in progress, not of a branch as a thing
      // that was pushed somewhere. Naming the branch is still the most useful
      // identifier, but calling it "Branch x" invites reading it as settled.
      if (got.kind === 'worktree') return 'Work in ' + (got.branch || got.session);
      return 'Branch ' + (got.branch || got.session);
    }

    // No session in the URL: this page has nothing to show and no way to be
    // given one — a review is created by launching a session. Say so, and point
    // back at the place where that happens. This is also the state install.sh
    // fetches, so it must render without any network call.
    function renderEmptyState() {
      var content = document.getElementById('content');
      content.replaceChildren();
      content.appendChild(el('h1', 'prtitle', 'Review a change'));
      var box = el('div', 'empty');
      box.appendChild(document.createTextNode(
        'Nothing to review here yet. A review belongs to a session: launch one from the '));
      var link = document.createElement('a');
      link.href = '/';
      link.textContent = 'Woodshed launcher';
      box.appendChild(link);
      box.appendChild(document.createTextNode(
        ' with a pull request number or a branch in the "PR or branch" field, then follow the '
        + 'Review link on that session row.'));
      content.appendChild(box);
    }

    var initialUrl = new URL(window.location.href);
    // The launcher embeds this page in its pane, where a link back to the
    // launcher would load it inside itself and the rail behind is already the
    // way out. So the link is revealed only in a tab of its own, rather than
    // shown to everyone and taken away from the common case.
    if (initialUrl.searchParams.get('embed') === '1') document.body.classList.add('embedded');
    else document.body.classList.add('standalone');

    document.getElementById('discardGo').addEventListener('click', discardReview);
    document.getElementById('discardCancel').addEventListener('click', function cancel() {
      document.getElementById('discardSheet').close();
    });
    document.getElementById('discardX').addEventListener('click', function close() {
      document.getElementById('discardSheet').close();
    });

    document.getElementById('sheetDrop').addEventListener('click', discardDraft);
    document.getElementById('sheetGo').addEventListener('click', submitReview);
    document.getElementById('sheetCancel').addEventListener('click', function cancel() {
      document.getElementById('submitSheet').close();
    });
    document.getElementById('sheetClose').addEventListener('click', function close() {
      document.getElementById('submitSheet').close();
    });
    document.getElementById('mergeGo').addEventListener('click', mergePullRequest);
    document.getElementById('mergeCancel').addEventListener('click', function cancel() {
      document.getElementById('mergeSheet').close();
    });
    document.getElementById('mergeX').addEventListener('click', function close() {
      document.getElementById('mergeSheet').close();
    });

    state.tab = tabFromUrl(initialUrl.searchParams.get('tab')) || state.tab;

    var initialSession = initialUrl.searchParams.get('session');
    if (initialSession && /^claude-[0-9a-f]{8}$/.test(initialSession)) openSession(initialSession);
    else renderEmptyState();
  </script>
</body>
</html>`;
