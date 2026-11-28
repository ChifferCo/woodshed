Trend bars show how a count moves over a window: sessions started each week, pull requests merged each week. The
Analytics page (`console/public/analytics.js`) uses them under its figures.

- They sit in a group's box, under its figures, split from them by a `line-soft` rule: never a card of their own.
- One chart component draws every chart on Analytics (`trendBars` in `public/analytics.js`), so they stay alike.
- A head row: the label in `group-label` type (uppercase, `label`) and a legend whenever there is more than one series.
- A y axis: about four ticks at round numbers (1, 2 or 5 times a power of ten) from 0, in mono `meta` to the left of the
  plot, each on a light gridline (`line-soft`); the base line is `line`. Never a `max N` in the corner.
- An x axis: about seven days (or weeks) labelled evenly under the bars in mono `meta`, the last one `today`.
- One bar per day for a window of two weeks or less, else one per week or so, ending today. Bars are flat-topped with a
  2px radius, 150px tall, with a gap between them.
- Hover or keyboard focus on a bar tints its column `slate-tint` and shows a tooltip (`ink` ground, `ground` text, 12px):
  the day in bold, a row for each series with its swatch and count in words, and `N in all` under a rule when there are
  several. The bar's `aria-label` says the same.
- A chart of one measure that splits by agent is stacked by agent, in the Agent bar's colours (Claude `amber`, Codex
  `proj-teal`, Grok Build `proj-violet`, OpenCode `proj-rose`, other `idle-dot`) with a legend: a total never takes one
  agent's colour, which would read as that agent alone.
- One series is `slate`. Two are stacked: Woodshed's own in `slate` at the bottom, the rest in `idle-dot` grey on top,
  with 2px of `ground` between them. Never a status colour, a project colour or orange: a bar is a count, not a state.
- A bar's numbers are in its tooltip (`From Nov 3: 9 through Woodshed, 4 without`) and the chart's `aria-label`; the
  colour never says them alone, and the legend names each series.
- Never two scales on one chart: a second measure is a second chart.

On Analytics a chart may take a colour of its own (a day-by-day bar chart of pull requests opened, one of sessions started) (still never a status colour or orange): pull requests
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

- **By person table**: the merge risk column is the risk bar's shape at 8px with `N low`, `N med`, `N high` in words under it
  (`high` in `bad`, bold, when any); a dash means none of their pull requests was reviewed. A column that shows two numbers
  with a slash says what they are in a `meta` sub-header under its name (`opened / merged`, `Woodshed / without`), and in its tooltip.
