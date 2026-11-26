The AI reviews are the review page's **AI reviews** tab: what Woodshed's review (Claude Code, Codex or both) posted on
the pull request, read back from GitHub (`shared/review/aiReviews.mjs`), with the follow-ups a reader asked about each
point, and over them the merge risk and QA checks on the pull request's head commit. `woodshed review`'s `6 AI
reviews` draws the same in the terminal's own colours.

It is drawn by the review page (`shared/review/page.mjs`, `.ai*` on the Discussion tab's `.saidbox`), framed by the
console's **Review** tab. That page has its own palette, so it uses the page's variables; the preview shows it in the
console's nearest tokens: `--ink` is `ink`, `--muted` is `meta`, `--rule` is `line-soft`, `--rule-strong` is `line`,
`--panel` is `ground`, `--sunk` is `stopped`, `--add` is `green`, `--del` is `bad`, `--warn` is `amber-ink`, `--accent`
is `amber`.

- Over the reviews, the **Merge risk** and **QA** the pull request's head commit carries (`shared/review/prChecks.mjs`):
  two boxes side by side, one under the other on a narrow screen, each the `saidbox` with a head of its name in `ink`,
  its word as a `verdictword` (the tier `low` in `green`, `medium` in `amber-ink`, `high` in `bad`; QA `passed` in
  `green`, `failed` in `bad`, `running` in `amber-ink`, else `meta`) and its left edge in the same tone, the tag
  `latest commit` (`older commit` in `amber-ink` for a tier read off the `merge risk: <tier>` label, `not run` for a
  check the project file asks for and the commit lacks), the time and **Open on GitHub**. Under it the check's title
  in `ink` (`meta` for a sentence saying why there is none), then a native **Details** disclosure in `meta` holding
  the check's summary as markdown. Either box is left out when there is no such check and the project file asks for
  none. The head wraps whole words onto a second line rather than breaking them.
- A sentence in `meta` opens the tab: what it holds, and that a follow-up is checked against the code. Then one box per
  review, newest first, the Discussion tab's `saidbox`, its left edge `green` for an approval, `bad` for changes
  requested, `line` otherwise.
- The box's head is a disclosure: a caret, the reviewers ("Claude Code and Codex") in `ink`, the verdict as a
  `verdictword` (approves, requests changes, comments) in its tone, then mono tags in `meta` on a `line-soft` border:
  `dismissed` when a maintainer dismissed it, `latest commit` (or `older commit <sha>` in `amber-ink`), how many
  findings, the time, and **Open on GitHub**. The newest is open, older ones folded. It takes the focus, says
  `aria-expanded`, and Enter or Space folds it, as a click does. On narrow screens the header wraps onto more
  lines, keeping the caret beside the reviewer’s first line and each badge, time and link together. **Open on GitHub** aligns to the right on its line.
- Each reviewer's part follows, its name and verdict over its markdown at 13.5px; parts are split by a dashed
  `line-soft` rule. A follow-up box about the review as a whole ends them.
- The findings: "2 findings" in `meta`, then a card each on `ground` with a `line-soft` border, radius 5: the
  reviewer's tag, its `path:line` as the page's `qfile` button (opens the diff) or plain code when the file is not in
  it, state tags (`resolved`, `outdated` in `amber-ink`, `in the review's body` for one GitHub refused as a line
  comment), **Reply on GitHub** at the right, the finding's markdown, then the replies on its thread, each indented
  with a 2px `line-soft` rule, the author in `ink`.
- A resolved or outdated card has a dashed border and its label, and never fades: its text stays at full colour, so
  `meta` keeps 4.5:1 on `ground` in both themes.
- Under each point, the follow-ups asked about it: the question as the chat's user bubble, the answer as its markdown
  with a 2px `amber` rule on its left, so it reads as the agent's, then the ask panel's one-line field and a quiet
  **Ask**, never orange since there is one under every point. While a question is answered, "checking it against the
  code…" in `meta` beside a spinner, and every **Ask** waits (the conversation answers one at a time). One that fails
  goes back in its field with why under it, in `bad`. A transcript that could not be read says so once with a quiet
  **Try again**.
