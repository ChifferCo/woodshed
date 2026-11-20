The segmented choice picks one of two or three short words, side by side in one bordered strip. My settings' **Display**
card uses it for the theme (device, light, dark), review files (folded, expanded) and the tab a session opens on, on a
desktop and on a phone (Chat, TUI) (`public/mySettings.js`, `.theme-seg` and `.theme-opt` in `public/style.css`).

- Buttons with `aria-pressed`, in a `role="group"` named for the setting. The pick is `amber-tint` with `amber-ink`
  text: it marks the choice in use, not a primary action. The others are `meta`, `stopped` on hover.
- A pick applies at once and says so in the card's `form-note` when it is saved on the console. No Save button.
- Lowercase words for a value (`device`, `folded`), the tab's own name for a tab (`Chat`, `TUI`), each with a `title`
  that says it in full.
- While a save is on its way the strip is disabled, at 60% opacity.
- Use it for two or three options of a word or two. More, or options that need a line each, are ChoiceCards or a select.
