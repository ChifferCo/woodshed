New session's **Work on** (labelled **Continue a PR or branch**), a combobox over the picked project's open pull requests (`GET /api/pulls`, the 100 updated
last). `launcher.js` draws it (`createPullPicker`); `public/openPulls.cjs` says what matches what is typed.

- **The field**: the form's `field`, in `mono`, with a quiet ▾ at its right end behind a `line` divider: `meta`, and
  `ink` on `slate-tint` while the list is open. Typing still takes anything: a number, `PR #123` or a branch.
- **The list**: the `menu` surface (`ground`, `line` border, `menu` shadow), right-aligned under the field and at least
  460px wide, so each row says enough to pick from:
  - line one: the number in `slate` `mono` 600, then the title in `ink` 600, one line, with an outlined **Draft** in
    `sub` for a draft;
  - line two, under the title: `@author · branch · updated 2 h ago` in `sub` `mono`, wrapped on a phone.
  - The row Enter picks, the hovered one and the one in the field are on `slate-tint`.
- **Focus or typing** opens it narrowed to what is typed (a number by its start, words by title, branch or author); **▾**
  or ↓ shows them all. A pick writes `PR #123`, and under the field a `sub` line names it: the title in `ink` 600, then
  the author and branch.
- A note row in `sub` says when nothing is open, nothing matches (Start still takes what is typed), only the 100
  updated last of more are listed, or GitHub did not answer and the list is from before.
- No status colors: the list names pull requests, it does not judge them.
