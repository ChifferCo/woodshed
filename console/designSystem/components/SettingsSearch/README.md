The settings search sits at the top of the settings pages' rail, under Back to sessions, the same box on every settings
page (My settings, Settings and its Secrets & webhooks tab, Repo settings, People, Webhook events); on a phone it sits
above the row of pages. It lists every section of every page the person can open, narrows as they type, and takes
them to the section, on its page, outlined for a moment. `public/settingsSearch.js` draws it; `public/settingsIndex.cjs`
says what each section is called and what people call it (`repo`, `token`, `timeout`), so a new card on a settings page
is added there too.

- The box fills the rail's width, 14px type, `radius`, with the `amber` focus ring. It is not a primary action: no `action` fill.
- The list opens on focus, under the box, wider than the rail (480px, over the page beside it), on `ground` with a `line`
  border and the menu shadow, 70vh at most. With nothing
  typed it is every section, grouped by page; typed, it is a flat list, best match first, each with its page and scope.
- A row: the section's name (600), a quiet tag with its page and `only you` or `everyone`, and one line of what it holds in
  `sub`. The current row has `slate-tint` and the `amber` edge, as the settings list's current page does.
- Scope is the point of the tag: **Only you** is your My Woodshed sessions, **Everyone** is shared sessions and the console.
  The same tag sits beside each page's title.
- Keys: ↓ ↑ move, Enter goes, Esc closes. The section it lands on gets a 2px `amber` outline for 2.5 seconds.
- A page that draws itself again (Webhook events every 5 s, People every 30 s) keeps the box: it keeps its focus, caret and
  open list across the redraw.
