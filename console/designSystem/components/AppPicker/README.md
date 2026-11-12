The app's controls in the pane bar when a project has several apps (`apps`): one runs at a time, so Start app picks
which, and the pane says which runs. `common.js` draws them (`appButton`), in the page's one menu.

- **Nothing running**: an outline **Start app ▾**. It opens the menu: one row per app, its label in `ink` 600 and a note
  in `sub` saying what picking it does ("Start it in this session").
- **One running**: the green-dot **App ↗** (Open app) as with one app, then an outline button with the running app's
  label and ▾ (`Admin ▾`), then Stop. The label is how the pane says which app runs; its menu is the same list, the
  running one noted "Running now: starts it again" and each other "Stops Admin first, then starts this one".
- **Starting**: the spinning ring and `Starting Admin…`, as with one app.
- Never orange: starting an app is not the view's primary action. Never a status color on the label: it names an app,
  not a state.
- A project with one app shows none of this: Start app is one button, and its request names no app.
