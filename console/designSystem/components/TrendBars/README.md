Trend bars show how a count moves over a window: sessions started each week, pull requests merged each week. The
Analytics page (`console/public/analytics.js`) uses them under its figures.

- They sit in a group's box, under its figures, split from them by a `line-soft` rule: never a card of their own.
- A head row: the label in `group-label` type (uppercase, `label`), a legend when there are two series, and on the
  right `max N` in mono, `meta`. Under the bars, the first day and `today` in mono, `meta`. No other axis or grid.
- One bar per day for a window of two weeks or less, else one per week or so, ending today. Bars are flat-topped with a
  2px radius, 120px tall at most, with a gap between them.
- One series is `slate`. Two are stacked: Woodshed's own in `slate` at the bottom, the rest in `idle-dot` grey on top,
  with 2px of `ground` between them. Never a status colour, a project colour or orange: a bar is a count, not a state.
- A bar's numbers are in its tooltip (`From Nov 3: 9 through Woodshed, 4 without`) and the chart's `aria-label`; the
  colour never says them alone, and the legend names each series.
- Never two scales on one chart: a second measure is a second chart.

On Analytics a chart may take a colour of its own (a day-by-day bar chart of pull requests opened, one of sessions started) (still never a status colour or orange): sessions started in `proj-violet`, pull requests
through Woodshed in `slate` or violet and without in `proj-teal`. The page's figures carry a 2px top rule, an icon and a
value in one of the project colours; tier pills are green, amber and red; lines added are `add`, removed `del`.

Also on Analytics, in the same box as the bars:

- **Risk bar**: a 12px stacked bar, one for each kind of pull request, split into Low (`add`), Medium (`amber`), High (`del`) and
  Not reviewed (`idle-dot`) with 2px between, and under or beside it a pill with the count for each level, in words. The
  count is in the pill and the bar's `aria-label`, never the colour alone.
- **Agent bar**: the risk bar's shape under the Sessions figures: one segment for each agent the sessions ran on, in its tag's
  colour (Claude `amber`, Codex `proj-teal`, Grok Build `proj-violet`, OpenCode `proj-rose`, any other `idle-dot`), with the
  agent's tag and count beside it. The count is in the tag and the bar's `aria-label`, never the colour alone.
- **Sessions bar**: in the by-person table, a 6px `proj-violet` bar at 55% opacity before the session count, up to 70px for the
  person with the most. The number is always beside it.
- **Split bar**: an 8px bar in the by-repo table, `proj-violet` through Woodshed and `proj-teal` without, widths against the largest repo.
- **Agent tag** (Claude amber, Codex teal, Grok violet, OpenCode rose) and **Woodshed / models pills**: a pill on the tint of the
  colour, the agent's name in it.
- **Person menu**: a plain select beside the window's buttons, `Everyone` first; picking a person filters every group below it.
- **Repo menu**: the same select (`person-pick`, a repo icon and the word Repo) before the Person menu, `All repos` first, shown only with two or more repos and listing every repo the viewer may open, a quiet one too; picking one filters every group below it, the by-repo table excepted, which keeps every repo to pick from.
- **Show more / Show all**: outline buttons (`analytics-btn`, only on this page) under a list of more than 25 rows.
- **Lines**: `+added` in `add` and `−removed` in `del`, in mono, bold.
