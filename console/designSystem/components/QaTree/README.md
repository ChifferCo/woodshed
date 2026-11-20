The Q&A tree is the review page's **Q&A** tab: questions a newcomer to the codebase asked about the change, each answered
from the code, with the follow-ups an answer raised nested under it. A reader opens only the questions they have.

It is drawn by the review page (`shared/review/page.mjs`, `.qa-*`), the shed's own document, framed by the console's
**Review** tab. That page has its own palette, so the tree uses the page's variables rather than `style.css`'s; the
preview shows it in the console's nearest tokens. The pairs: `--ink` is `ink`, `--muted` is `meta`, `--faint` is
`label`, `--rule` is `line-soft`, `--sunk` is the hover wash on `ground`, `--c-act` is `slate`.

- One list per level. A question is a full-width button: a `▶` that turns to point down when open, the question in
  `ink` (600 at the top level, 500 below), and, while folded, a mono chip with how many follow-ups it holds
  ("1 follow-up", "3 follow-ups") in `meta` on a `line` border.
- Every question starts folded. Opening one shows its answer, rendered markdown at 14px in `ink` (code in the page's
  `pre`), then its follow-ups as the next list, indented with a 2px `line-soft` rule on its left, three levels at most.
- A question still being answered is disabled, with a spinner and "being answered" in `meta`; one left without an
  answer says "not answered".
- No section head and no intro sentence: the tab's name says what it is. The tree opens with its tools row, **Open
  all**, **Close all** and **Ask again** as quiet buttons, set as far below the tab bar as the first section head on
  the other tabs. Never orange: asking again
  is not the page's primary action. While a run is going, the line reads what it is doing ("Reading the code to answer
  6 questions…") beside a spinner, and Ask again is not offered.
- An empty or replaced Q&A says so in a sentence ("There is no Q&A for this diff yet.") with **Ask the questions**, a
  quiet button too. A failure says what went wrong, as every error does.
- The reader asks their own. An open answer ends, after its follow-ups, with a one-line field ("Ask a follow-up about
  this answer…") and a quiet **Ask** button, never orange since there is one under every open answer, in the review page's ask panel
  row (`.askrow`: the field on `panel` with a `line` border); the tree ends with the same row for a question of their own ("Ask a
  question of your own about this change…"). Enter asks. Neither is shown while a run is going. The question joins the
  tree at once where it was asked, "being answered", and "you asked" in `meta` beside it, folded like the rest once
  answered. A question that comes back unanswered is put back in its field, with "Not answered: <why>" under it in
  the page's `--del`, as the ask panel says its errors.
- Opening or closing a question keeps the keyboard focus on it, and a refresh while a run goes keeps it there too.
  A field being typed in keeps the focus, its caret and what was typed through every refresh.
