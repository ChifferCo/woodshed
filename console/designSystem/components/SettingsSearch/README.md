The settings search sits under the title of every settings page (My settings, Console settings, Secrets & webhooks,
People, Webhook events). It lists every section of every page the person can open, narrows as they type, and takes
them to the section, on its page, outlined for a moment. `public/settingsSearch.js` draws it; `public/settingsIndex.cjs`
says what each section is called and what people call it (`repo`, `token`, `timeout`), so a new card on a settings page
is added there too.

- The box is wide (640px max), 16px type, `radius-lg`, with the `amber` focus ring. It is not a primary action: no `action` fill.
- The list opens on focus, under the box, on `ground` with a `line` border and the menu shadow, 60vh at most. With nothing
  typed it is every section, grouped by page; typed, it is a flat list, best match first, each with its page and scope.
- A row: the section's name (600), a quiet tag with its page and `only you` or `everyone`, and one line of what it holds in
  `sub`. The current row has `slate-tint` and the `amber` edge, as the settings list's current page does.
- Scope is the point of the tag: **Only you** is your My Woodshed sessions, **Everyone** is shared sessions and the console.
  The same tag sits beside each page's title.
- Keys: ↓ ↑ move, Enter goes, Esc closes. The section it lands on gets a 2px `amber` outline for 2.5 seconds.
