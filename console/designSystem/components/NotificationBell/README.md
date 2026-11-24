The desktop app's notifications, under a bell in the rail's foot, between the user menu and the hide button (`console/public/notificationBell.js`). The rail keeps its width. Only in
the app, which hands the page its list (desktop/README.md, "Notifications and the badge"); a browser has no bell.

- The bell is a square quiet button, 34px, `line` border, `radius-md`, a `sub` stroke icon that turns `ink` on
  `chip-count` when hovered or open, as the rail foot's hide button. Never orange: it is not the view's primary action.
- What has not been seen is a count on its corner: a `menu-count` pill (`amber-tint`, `amber-ink` mono), never yellow,
  since a notification is not always a session that needs you. Opening the list sees them all and the count goes.
- The list is a `menu` surface (`ground`, `line` border, `menu` shadow) opening upward over the rail, as the user menu
  does, the rail's width less its padding, never taller than the screen: a `menu-label` Notifications, then a row per notification, newest first, each a link to its session.
- A row: a dot, the session's name (`ink` 600 while new, `sub` 500 once seen), what the notification said in `sub`, and
  when in `meta` mono. The text starts with its word (Needs you, Done, Failed), so the dot is never alone: `wait` for
  needs you, `bad` for failed, `green` for done, merged, a review or QA finished, `slate` for the rest.
- Empty, it says so in `sub`. Escape or a click outside closes it.
- With the app in front, a notification shows as a card at the window's bottom right rather than the OS's: the bell's
  row (dot, name, what it said) on a `menu` surface, 340px, with a quiet × to dismiss. The card opens its session, goes
  after 10 seconds unless the pointer is on it, and goes when its session is opened. Cards stack upward, newest last.
