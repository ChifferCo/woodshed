One line of text from the person, in the console's own dialog (`W.askText` in `public/common.js`): Rename… on a
session, and the payload URL on Secrets & webhooks.

- The `confirm` dialog's look: `ground`, a `line` border, 8px radius, 20px padding, at most 500px wide, over a dimmed
  backdrop. No shadow.
- A heading that says what is asked, as a sentence: **Rename this session**, **Set the GitHub App's payload URL**.
- One field under its label (`field-label`), filled with what is there now and selected, so typing replaces it. An
  address is `mono`.
- Cancel, quiet, then the one action, orange, on the right: a verb (**Rename**, **Next**). Enter takes the text, Escape
  or Cancel drops it. An empty field is dropped, as Cancel.
- Never `window.prompt`: the desktop app has none (Electron returns nothing), and in a browser it is the browser's box,
  not the console's.
- What is done with the text (a toast, a confirm step such as the payload URL's) is the caller's.
