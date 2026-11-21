The merge hint is the review page's reason an approved pull request has no **Squash and merge** button yet: new commits
since the review, uncommitted changes the review read, checks failing or running, or the merge queue. It sits at the
right end of the tab bar, after **Submit review**, where the merge button would be.

It is drawn by the review page (`shared/review/page.mjs`, `mergeHint()` and `.mergehint`), which has its own palette, so
it uses the page's variables; the preview shows it in the console's nearest tokens: `--muted` is `meta`, `--ink` is
`ink`, `--sunk` is the hover wash on `ground`.

- An icon, never a sentence in the bar: a sentence there squeezed the tabs and Submit review onto two lines each. The
  icon is Octicons' 16px `info`, 15px in a 22px round target, in `meta`; on hover, `ink` on the hover wash, with the
  help cursor.
- The reason is its tooltip, the page's own `data-tip` (dark, 12px, opening above and anchored right since it ends the
  row), on hover and on keyboard focus: the icon is in the tab order. The reason is a whole sentence that says what to
  do ("New commits since this review. Re-review to merge."), never a code or a bare count.
- The same sentence is inside the element, hidden but read by a screen reader, so the icon is never announced alone.
- On a touch screen up to 720px, where the page turns tips off because a tap leaves them stuck, the sentence shows
  beside the icon in `meta` at 12px, wrapping, with the controls on their own row under the tabs.
- Never orange and never a status colour: it explains a wait, it does not ask for an action or report a failure.
