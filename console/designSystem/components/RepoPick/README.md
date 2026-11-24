The repo pick chooses some of the console's repos, or all of them, where a setting applies per repo: Console settings'
MCP servers card, **Repos** (`mcpRepos` in `public/consoleSettings.js`, `.repo-pick` in `public/style.css`).

- A `details` fold whose summary is a `field` saying the pick in mono (`All repos`, or the repos, cut to one line with
  an ellipsis), with a `meta` ▾. 280px on a desktop, the full width under 560px. It opens in place, under the summary,
  never as a floating menu, so it fits a phone with no sideways scroll.
- Inside, on `ground` with a `line` border: **All repos** first (`.repo-check.is-all`: 600, its own rule under it), then a native checkbox
  per repo in mono, `slate` as its accent as People's checkboxes are; hover is `slate-tint`. While All repos is ticked
  the repos show ticked and disabled. Unticking it ticks every listed repo, so nothing changes until one is unticked.
- A saved repo the console no longer lists stays, ticked, with a `meta` note `not a repo of this console`: a save never
  drops what was saved unseen.
- No repo ticked says so in words under it.
- A long list (a program's pick of many repositories) may start with a filter (`.repo-pick-filter`): a `field` across
  the list, `type="search"`, its placeholder saying how many it filters (`Filter 24 repositories`), hiding the rows
  that do not match as it is typed. It stays at the list's top as the list scrolls.
