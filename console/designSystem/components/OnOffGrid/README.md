The on/off grid sets a few things on or off at once, one row each, with radios under **Off** and **On** across the
top. My settings' **Reviews of my pull requests** card uses it, with a row for Claude Code and one for Codex: both on is
both reviewing, both off is no code review (`public/mySettings.js`, `.onoff-grid` in `public/style.css`).

- A plain table: the row's name in `ink`, 600 weight; the column heads in `label`, 12px, 600; rows divided by
  `line-soft`, the head by `line`.
- Native radios, one group per row, filled `green` (`accent-color`) as the choice in use is elsewhere, never orange:
  picking one is not the page's primary action.
- A pick saves at once, like a switch, and says so in the card's `form-note`. No Save button.
- An option that cannot be chosen now is a disabled radio, and its row says what it needs in `meta` under the name,
  with the name in `sub`. Never hide the row: the person sees what turning it on would take.
- Use it for two to four rows. One thing on or off is a switch (`toggle-row`); several exclusive choices are a select.
