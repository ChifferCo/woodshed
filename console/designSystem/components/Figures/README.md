Figures are a group's numbers, read at a glance: how many people, what is held, how full a pool is. A program's
admin pages use them (`figures` in `console/settingsMarkup.mjs`), where a column of cards used to be.

- They sit in a group's box (`set-rows-box`), under the group's label and note, as rows do: never a card of their own.
- Each figure is three lines: its label in `group-label` (uppercase, `label`), its value in the `figure` type style
  (mono, 20px, `ink`), and an optional line under it in `sub` (`38 signed in this week`, `72%`, `$0.36 an hour`).
- As many to a row as fit, at least 190px each, so a row of three, four or five reads across on a desktop and two or
  one on a phone; a last row left part full shares its width, so it has no hole. Figures are split by `line-soft` rules,
  inside the box's own `line` border.
- A value is a number with its unit as a person reads it (`$3,412.80`, `92 / 128`, `4 vCPU · 16 GB`), never a bar or a
  color alone. A figure that needs a status says it in its line under (`full`), or the page puts it in a row.
- On Analytics a figure also has a 16px line icon before its label and a 2px top rule, and its value takes one tone (`slate`,
  `proj-violet`, `proj-teal`, `green`, `amber-ink` or `proj-rose`, each 4.5:1 or more on `ground`) instead of `ink`. The tone only
  groups; the label and line under say the meaning.
- A list read across (people, hosts, a ledger) is a table, not figures: figures are totals, not records.
