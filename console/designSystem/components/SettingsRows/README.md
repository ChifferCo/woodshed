Settings rows are how a settings page shows what it holds, My settings first: groups of rows, each row one setting with its name, what it is
now and its status word, opening in place on its form (`public/settingsRows.js`, `row`, `line` and `group`, which each settings page makes with its own render; `.set-group`,
`.set-fold` and `.set-line` in `public/style.css`). The page reads in one screen, and nothing is hidden: a closed row
still says its value.

- A group is a `group-label` over one box with a `line` border and `radius-lg`, its rows divided by `line-soft`. A
  sentence that holds for the whole group sits under the label in `sub`, never in each row.
- A row is its name (`ink`, 600) over one line in `sub` saying what it is now ("Pause after 1 hour waiting for you ·
  stop after 8 hours working"), then its pill, then a `meta` ▸ that turns when open. The whole row is the button, on
  `slate-tint` when hovered; open, its head is on `stopped` and its form is under it on `ground`.
- Several rows may be open at once. Opening one never closes another, and a row a link or the search names opens by
  itself. A job the person waits on (their databases being copied, a restore) keeps its row open.
- A setting with nothing to change is a plain row: its sentence and pill, no ▸ and no button.
- A list people add to (Settings' repos, its MCP servers) is a row per thing, then **Add a …** as the group's last
  row. A thing's row opens on its own form, with Remove outlined in `bad` beside its Save: there is no Edit button,
  and closing the row is its Cancel. With nothing yet, a plain row says so above the Add row.
- A row of numbers says **Defaults** or **Changed** (`is-ok`) on its pill, and **Not saved** (`is-warn`) while a typed
  number waits for its Save. Numbers that are saved together are one row; ones that are not are two.
- A setting that is one pick (the theme, the default project) has its control on the row and no form to open: a
  segmented control or a select, saved as it is picked.
- A row that removes things has its name in `bad`; its button is inside, outlined in `bad`. Never a red border on the
  group.
- Steps to get something to paste show in full until it is saved, then fold under a `slate` line ("How to make a
  token"), as Commands to copy says.
- One row per repo, never a strip of repo tabs: each repo's row says what the person keeps for it. Open, a repo shows
  one part at a time on a segmented control (Instructions, Env files, Your files), with a `•` on a part that holds
  something of theirs.
- On a phone the pill moves under the row's text, and a row's control under its help.
