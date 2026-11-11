The org switcher is the top of the user menu in a console serving many orgs (`console/hosted.mjs`, `docs/hosting.md`).
`common.js` draws it from `/api/me`'s `org`, `orgs` and `hostLinks`; a self-hosted console has none of them and no
switcher.

- The user button shows the person's name, and the current org's name under it in mono 11px, `meta`, cut with an
  ellipsis. On a phone the name and org are hidden with the rest of the button's text; the menu still lists the orgs.
- In the menu: a `menu-label`, "Switch organization" (or "Organization" when the person is in one), then a
  `menu-item` per org: a 12px column for the `green` ✓ on the current one, the org's name, and the person's role there
  ("Owner" or "Member") in mono 11px `meta` at the right end. The current row is 600 weight, `aria-current`, and not a
  link; each other row is a link to the host's switch, which brings the person back to the console in that org.
- The host's links (Account, Members, Credits) follow as plain `menu-item`s, then a `line-soft` rule before My settings.
- Nothing in it is orange: switching org is navigation, not the view's primary action.
