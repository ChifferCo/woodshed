The codebase map is the review page's interactive whole-repository map on the **Overview** tab (`shared/review/page.mjs`,
`.cmap-*`), fed by `GET /reviews/<session>/map` (`shared/review/codebaseMap.mjs`) and laid out in the browser by
`shared/review/codebaseMapLayout.mjs`.

It is drawn by the review page inside the console's **Review** tab, so it uses the review page's own palette. Key-change
emphasis stays off orange (`--accent` is reserved for **Submit review**): key changes use `--cmap-key` (matching the
Architecture section's teal `--c-arch`: `#0f766e` in light with `#ffffff` badge text, `#2dd4bf` in dark with `#14171d`
badge text), additions use `--add`, deletions use `--del`, and interactive links, hovers, focus outlines and the minimap
viewport use `--slate`. The preview shows it in the console's nearest tokens: `--ink` is `ink`, `--muted` is `meta`,
`--rule` is `line-soft`, `--rule-strong` is `line`, `--panel` is `ground`, `--sunk` is `stopped`, `--add` is `green`,
`--del` is `bad`, `--cmap-key` is `proj-teal`, `--slate` is `slate`.

- **Semantic zoom.** Zoomed out, each module district shows its name, a short plain-English summary (from its README,
  package description or entrypoint doc comment), file and line counts, and its change badge (`2 key · 1 minor +71 −9`).
  Zooming in reveals file parcels and dotted file-to-file import lines; zooming further reveals each changed file's full
  markdown change description and clickable changed sections (hunks).
- **Key vs. minor hierarchy.** Key changes carry a solid `--cmap-key` border (`--add` when all changes in a module are
  additions, `--del` when all are deletions) and a `KEY` badge. Supporting/minor changes (tests, docs, config) stay
  dashed on `stopped` with a `MINOR` tag and never fade their text, keeping 4.5:1 contrast in both themes.
- **Quiet HUD controls.** Top-left holds search (`Find module or file…`) and changed-module quick-jump pills. Top-right
  holds quiet buttons (`Focus key changes`, `Fit all`, `Full screen`), never orange. Bottom-left holds the legend;
  bottom-right holds the interactive minimap and `+ / % / −` zoom buttons. On screens up to 720px, the legend and minimap
  hide and the search row wraps cleanly below the top-right controls.
- **Direct navigation to Files changed.** Clicking a changed file's title (which carries an inline link-out box icon) or
  any hunk button inside a zoomed card or the floating inspector drawer switches to **Files changed**, opens that file
  card, scrolls the targeted file or hunk below the sticky header, and briefly flashes it in `slate`.
- **Gestures.** Drag pans (pointer capture begins only past the 4px drag threshold so stationary clicks always reach
  module headers and file cards); scroll wheel, trackpad pinch, two-finger touch pinch and `+ / −` buttons zoom.
