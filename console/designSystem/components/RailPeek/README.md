The hover card of a rail card: what the card has no room for, beside it. `session.js` shows it 500 ms after the pointer
rests on a card, or when keyboard focus reaches the card's name, and hides it on leave, a click, a key, the rail's
scroll or a window made phone-wide. The rail's redraw every 5 s draws it again beside the same card, once the list is
back at its scroll position. `common.js` `peekView` says what goes in it.

- A `menu` surface: `ground`, `line` border, 8px radius, the `menu` shadow, 320px wide. It takes no pointer, so the
  card under it keeps the hover and the click.
- Placed to the right of the card, its top level with the card's and kept 8px inside the window; under the card when
  the window has no room to its right.
- Line one: the whole title (`card-title` at 13.5px, 600), which the card cuts. Its project's name is a row, below, when
  the rail shows more than one project. The card's own tooltip then says nothing: never both.
- Line two: the status word in its color, as on the card (`wait`, `slate`, `green`, `bad`), then in `sub` what comes
  next on its own: `pauses at 14:32, in 40 min`, `stops at …`, `never pauses while it works`, or since when and why a
  stopped one stopped.
- The agent's last line on `stopped`, cut to three lines, its speaker (`Claude:`, `Codex:`, `Asked:`) in `ink` 600. A
  failed start's reason is in `bad`.
- Every pull request the session opened, a merged or closed one its chips no longer show too: the mono `slate` number and its title on one line, then in `meta` mono its state, its checks in
  their color (`bad` failing, `slate` running, `green` passing) and its review, in words. One the console has not read
  yet is its number alone.
- Then rows over a `line-soft` rule, `meta` terms and `ink` values: Project, Works on (an issue, or a pull request it did
  not open), Branch (mono), Agent (with its model and effort when picked), Last activity (`Working now`, or how long
  since), Started (by whom on a shared session, and when), Assigned to (`Nobody` on an unassigned shared one; none on a
  private session or a review or QA run), Production data.
- Never on a phone, which has no hover. The chips, the star, ⋯ and the buttons on a card keep their own tooltips: the
  card hides while the pointer is on one. Never an action in it: the card is still what opens the session.
