The rail's one-row head: the Mine | Everyone switch, the People filter, and + New session.

- The switch is two links (`/` and `/all`), the open one on `ground` with a small shadow over a `chip-count` track. Where there is one list (no shared sessions for you, or a console one person uses), the switch gives way to the words My sessions (`rail-only`).
- People is a pill (`radius-pill`) shown on Everyone only; it reads "People" when nobody is picked.
- + New session is the primary button, right-aligned, always enabled. It needs about 360px with the People filter shown.
- In the desktop app on macOS the row starts 80px in, after the window's traffic lights, and is the handle the window is
  dragged by (its controls are not). The rail is 412px there, so the row keeps its 10px to spare (`desktop/windowChrome.mjs`).
- On Mine, + New session carries your running sessions against your limit (`2/3`) after a divider. Everyone's row has no room for it, so the team's count is in the button's tooltip.
- With more than one project, a row of filter chips under the head (`rail-projects`): All with its count, then each project with its `proj-*` swatch, name and the number of sessions the rail shows on it. Pills (`radius-pill`), `sub` text on `ground`; the picked one is `aria-pressed`, with an `ink` border and its `proj-*-tint` fill (`chip-count` for All). They wrap on a desktop and scroll sideways on a phone, above Everyone's status chips there. The pick is kept in the browser; one naming a project that is gone is All. No row on a rail with no sessions.
- The user menu is not here. It is in the footer and opens upward.
- The consumer provides the open view and the people list.
