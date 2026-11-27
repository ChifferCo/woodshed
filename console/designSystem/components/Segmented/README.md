The segmented choice picks one of two or three short words, side by side in one bordered strip. My settings' **Display**
card uses it for the theme (device, light, dark), review files (folded, expanded) and the tab a session opens on, on a
desktop and on a phone (Chat, TUI) (`public/mySettings.js`, `.theme-seg` and `.theme-opt` in `public/style.css`).

- Buttons with `aria-pressed`, in a `role="group"` named for the setting. The pick is `amber-tint` with `amber-ink`
  text: it marks the choice in use, not a primary action. The others are `meta`, `stopped` on hover.
- A pick applies at once and says so in the card's `form-note` when it is saved on the console. No Save button.
- Lowercase words for a value (`device`, `folded`), the tab's own name for a tab (`Chat`, `TUI`), each with a `title`
  that says it in full.
- While a save is on its way the strip is disabled, at 60% opacity.
- It also switches what a part of a page shows, with nothing saved: a repo's Instructions, Env files or Your files on
  My settings (`public/myRepoSettings.js`), and, on a repo's settings page, where an env file's installation values come
  from, **Typed here** or a program's own source by its name (`public/repoSettings.js`, `components/LayeredFile`). It
  opens on the side in use and a pick only shows the other side; a line under it says which is in use.
- Use it for two or three options of a word or two. More, or options that need a line each, are ChoiceCards or a select.
