Figures are a group's numbers, read at a glance: how many people, what is held, how full a pool is. A program's
admin pages use them (`figures` in `console/settingsMarkup.mjs`), where a column of cards used to be.

- They sit in a group's box (`set-rows-box`), under the group's label and note, as rows do: never a card of their own.
- Each figure is three lines: its label in `group-label` (uppercase, `label`), its value in the `figure` type style
  (mono, 20px, `ink`), and an optional line under it in `sub` (`38 signed in this week`, `72%`, `$0.36 an hour`).
- As many to a row as fit, at least 190px each, so a row of three, four or five reads across on a desktop and two or
  one on a phone. Figures are split by `line-soft` rules, inside the box's own `line` border.
- A value is a number with its unit as a person reads it (`$3,412.80`, `92 / 128`, `4 vCPU · 16 GB`), never a bar or a
  color alone. A figure that needs a status says it in its line under (`full`), or the page puts it in a row.
- A list read across (people, hosts, a ledger) is a table, not figures: figures are totals, not records.
