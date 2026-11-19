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
- Above the tree: the section head ("Questions from a newcomer", the section tick in `slate`), one sentence on how it
  was made in `meta`, then **Open all**, **Close all** and **Ask again** as quiet buttons. Never orange: asking again
  is not the page's primary action. While a run is going, the line reads what it is doing ("Reading the code to answer
  6 questions…") beside a spinner, and Ask again is not offered.
- An empty or replaced Q&A says so in a sentence ("There is no Q&A for this diff yet.") with **Ask the questions**, a
  quiet button too. A failure says what went wrong, as every error does.
- Opening or closing a question keeps the keyboard focus on it, and a refresh while a run goes keeps it there too.
