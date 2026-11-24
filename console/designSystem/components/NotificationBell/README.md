Notifications, under a bell in the rail's foot, between the user menu and the hide button (`console/public/notificationBell.js`). The rail keeps its width. In the desktop app,
which hands the page its list, and in a browser, which keeps its own (desktop/README.md, "Notifications and the badge").
In a browser the list ends, until the person answers, with a quiet `sub` line over a `line-soft` rule, **Notify me
outside this tab**, which asks for the browser's own notifications (`ink` on `stopped` when hovered).

- The bell is a square quiet button, 34px, `line` border, `radius-md`, a `sub` stroke icon that turns `ink` on
  `chip-count` when hovered or open, as the rail foot's hide button. Never orange: it is not the view's primary action.
- What has not been seen is a count on its corner: a `menu-count` pill (`amber-tint`, `amber-ink` mono), never yellow,
  since a notification is not always a session that needs you. It counts sessions with something new, not
  notifications, each until its session is opened; opening the list marks nothing, and its Mark all read clears it.
- The list is a `menu` surface (`ground`, `line` border, `menu` shadow) opening upward over the rail, as the user menu
  does, the rail's width less its padding, never taller than the screen: a `menu-label` Notifications, with a quiet
  `sub` Mark all read at its right while something is new (`ink` on `chip-count` when hovered), then a row per
  notification, newest first, each a link to its session.
- One row per session, its latest notification: a dot, the session's name (`ink` 600 while new, `sub` 500 once seen),
  what it said in `sub` (`meta` once seen), and when in `meta` mono, then `· N notifications` when it notified more than
  once. Sessions with something new come first; the rest follow, their dot at 45%. Each part is named, New and
  Earlier, in the palette's group label (mono 9.5px, `meta`, spaced capitals), only when both are there. The text starts with its word (Needs you, Done, Failed), so the dot is never alone: `wait` for
  needs you, `bad` for failed, `green` for done, merged, a review or QA finished, `slate` for the rest.
- Empty, it says so in `sub`. Escape or a click outside closes it.
- ⌘J (Ctrl+J) opens the same list in the middle of the screen, on any page, in the command palette's frame (`overlay`,
  the `palette` surface, 520px), centred both ways: the head over a `line` rule, the rows, and the palette's foot of
  key hints. The row the keys are on is the palette's cursor row (`amber-tint` with an `amber` border); ↑↓ move it, ⏎
  opens its session, esc or a click outside closes it.
- With the app in front, a notification shows as a card at the window's bottom right rather than the OS's: the bell's
  row (dot, name, what it said) on a `menu` surface, 340px, with a quiet × to dismiss. The card opens its session, goes
  after 10 seconds unless the pointer is on it, and goes when its session is opened. Cards stack upward, newest last. Narrower than the desktop layout they sit above the rail's foot, which they
  would otherwise cover.
