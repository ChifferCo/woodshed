The key hint is a small tooltip that names a control's keyboard shortcut. `shell.js` shows it 400 ms after the pointer
rests on an element with `data-keys`, or when keyboard focus reaches it, and hides it on leave, a click, a key or a
scroll.

- `ink` fill, `ground` text, 6px radius, the toast's shadow. It is the same in both themes, inverted from the page.
- Line one: what the control does (its `data-hint`, or the shortcut's words), then its keys as caps: the combo, `or`,
  then the key alone.
- Line two, at 75%: "Press ? for every shortcut". Left off the hint of Keyboard shortcuts itself.
- Keys are one cap each, outlined in the text color: `⇧` `⌘` `O` on a Mac, `Ctrl` `Shift` `O` elsewhere.
- Placed under the control, centred and kept 8px inside the window; above it when there is no room below.

The prefix's mode is the same caps in a toast: while ⌘B's mode is on (Ctrl+B off a Mac), the toast's place says
`⌘B J K 1–4 N · esc to stop`, each key a cap outlined in the toast's text color, for as long as the mode is on: until Esc,
a click, a tab picked, another toast or any other key. It takes the place of a toast still showing, never sits over it.
