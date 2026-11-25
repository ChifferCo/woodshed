One line of text from the person, in the console's own dialog (`W.askText` in `public/common.js`): Rename… on a
session, and the payload URL on Secrets & webhooks.

- The `confirm` dialog's look: `ground`, a `line` border, 8px radius, 20px padding, at most 500px wide, over a dimmed
  backdrop. No shadow.
- A heading that says what is asked, as a sentence: **Rename this session**, **Set the GitHub App's payload URL**.
- One field under its label (`field-label`), filled with what is there now and selected, so typing replaces it. An
  address is `mono`.
- No length limit on the field: a field that cuts a paste can keep a shorter text that still looks right (a URL
  without its last parameter). What a caller keeps, it cuts itself, after collapsing spaces (Rename keeps 120).
- Cancel, quiet, then the one action, orange, on the right: a verb (**Rename**, **Next**). Enter takes the text, Escape
  or Cancel drops it. An empty field is dropped, as Cancel.
- Never `window.prompt`: the desktop app has none (Electron returns nothing), and in a browser it is the browser's box,
  not the console's.
- What is done with the text (a toast, a confirm step such as the payload URL's) is the caller's.

**Pause and stop…** on a session's ⋯ (`W.sessionLimitsDialog`), offered only to whoever has the session, is the same dialog with two fields: a sentence first
saying it is for this session alone and what an empty field falls back to (with the hours), then each `mono` number
field under its label with the hours it falls back to as its placeholder and the range on the input. Cancel, then
**Save**. The server's refusal shows in the dialog (`form-error`), which stays open; a save closes it with a toast. While a save is on its way, Cancel and Save are disabled and Escape does not close it. A lifetime shorter than the session has already run, entered or the one an empty field falls back to, is said first, in the same `form-error` line (when, if an Extend holds the stop back, it says so), and a second Save goes ahead.

**Hand off…** on a running My Woodshed session's ⋯ (`handOff` in `public/session.js`, console/handoff.mjs) is the same
dialog: a sentence first saying the agent stops here with its work pushed to its branch (the branch in `code`), then
**Hand off to** and **Model** as `field` selects (it opens on the other agent), the **Hand over the conversation**
switch as a `toggle-row` (on by default, its `sub` line saying what goes or that the new agent starts clean, `is-off`
when off), and **Note to the new agent**, an optional `field` textarea. Cancel quiet, then **Hand off**, the dialog's one
orange action (`btn-primary`; `Handing off…` while the console stops the session and starts the next, Cancel and
Escape disabled meanwhile). A refusal is a `form-error` in the dialog, which stays open; a hand-off opens the new
session's Chat.
**Hand over…** on a shared session's ⋯ (`W.askChoice`) is the same dialog with a dropdown in place of the field: one
row in the menu however many people can be assigned, never a row each. Heading **Hand over this session**, the label
**To**, each person by name with the handle after it, sorted, the first picked. Cancel, then **Hand over**.
