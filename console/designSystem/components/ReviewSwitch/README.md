The review switch is the review page's row of a session's pull requests, one review each: the branch checked out, and
every other pull request the session opened. It sits above the title, and only when there are two or more; with one,
there is nothing to switch to and the row is not drawn. It also shows on a review that could not be opened (a checkout
with nothing to review), so the session's pull requests are still in reach.

It is drawn by the review page (`shared/review/page.mjs`, `renderReviewSwitch()` and `.reviewswitch`), which has its own
palette, so it uses the page's variables; the preview shows it in the console's nearest tokens: `--faint` and `--muted`
are `meta`, `--slate` is `slate`, the console's link colour, `--ink` is `ink`, `--sunk` is the hover wash on `ground`, `--rule` is `line`.

- A lead word, **Pull requests**, in `meta`, then one pill per review, in the page's mono at 12px: the number (`#26701`),
  and for the branch checked out `· checked out` after it, or **Checked out** alone before it has a pull request. The
  checkout's comes first, then the others newest first.
- A pill for another review is a link (`slate`, on the hover wash, a `line` outline that turns `slate` on hover), opening
  that review in the same frame, so the Review tab stays.
- The one on screen is not a link: `ink`, 600, no wash, the page's stronger rule as its outline, with `aria-current="page"`.
- Its tip says what the review reads: the working tree for the checkout, GitHub's copy of the pull request for another.
- Quiet, above the title: it is a way to another review, not a fact about this change. Never orange (the page's accent,
  12px orange on the wash, is 2.6:1 in the light theme) and never a status colour; it wraps on a narrow screen rather
  than scrolling. Slate on the wash is 5.5:1 in the light theme and 8.6:1 in the dark one; the lead word, `meta`, 5.6:1.
