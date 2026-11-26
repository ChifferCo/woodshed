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
