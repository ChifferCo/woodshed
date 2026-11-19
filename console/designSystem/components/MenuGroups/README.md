Menu groups are what a program embedding the console adds to the user menu, the user button and the settings pages'
side list (`createInstallation`'s `userMenu`, `/api/me`'s `menuSubtitle`, `menuYou`, `menuGroups` and
`menuSections`). `common.js` draws them; a console nothing embeds has none.

- `menuSubtitle` goes under the person's name on the user button, in mono 11px, `meta`, cut with an ellipsis. On a
  phone it is hidden with the rest of the button's text; the menu still has the groups.
- The menu, top to bottom: the name and @handle; the person's own pages, My settings then the program's (`menuYou`),
  each a plain `menu-item`, and a `line-soft` rule; the program's switcher (`menuGroups`); the console's **Console**
  group; the program's sections (`menuSections`); Sign out. With no program, My settings alone is under the name.
- A switcher group is a `menu-label` (when it has one), then a `menu-item` per item. A choice (an item with `current`)
  has a 12px column for the `green` ✓ on the one in use, its label, and its note in mono 11px `meta` at the right end.
  The one in use is 600 weight, `aria-current`, and not a link; each other one is a link.
- A section is a `menu-label` and a `menu-item` link per entry. An entry with its own pages has them under it as
  Settings has its tabs (`menu-subs` / `menu-sub`), always in the menu; on one of them the entry is
  `aria-current="true"` and the page `aria-current="page"`.
- In the side list the program's pages for you follow My settings in **You**, and its sections follow **Console**, each
  a `side-group` heading and a `side-item` per entry with a `○` in the icon column (`meta`). An entry's own pages open
  under it (`side-subs` / `side-sub`) only on those pages, as Settings' tabs do.
- Nothing in it is orange: these are navigation, not the view's primary action.
