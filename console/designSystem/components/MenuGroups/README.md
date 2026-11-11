Menu groups are what a program embedding the console adds to the user menu and the user button (`createInstallation`'s
`userMenu`, `/api/me`'s `menuSubtitle` and `menuGroups`). `common.js` draws them; a console nothing embeds has none.

- `menuSubtitle` goes under the person's name on the user button, in mono 11px, `meta`, cut with an ellipsis. On a
  phone it is hidden with the rest of the button's text; the menu still has the groups.
- At the top of the menu, each group is a `menu-label` (when it has one), then a `menu-item` per item. A choice (an
  item with `current`) has a 12px column for the `green` ✓ on the one in use, its label, and its note in mono 11px
  `meta` at the right end. The one in use is 600 weight, `aria-current`, and not a link; each other one is a link.
- A plain item is a `menu-item` link. A `line-soft` rule follows the last group, before My settings.
- Nothing in it is orange: these are navigation, not the view's primary action.
