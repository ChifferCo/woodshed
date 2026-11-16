The terminal's find bar. `terminal.js` opens it over the shown terminal frame on ⌘F (Ctrl+Shift+F off a Mac), from
inside the terminal or the page around it, or from **find** on a phone's key bar. It searches the terminal's buffer
(`terminalFind.cjs`), since xterm paints on a canvas the browser's own find cannot read.

- Fixed 8px inside the frame's top right corner, over the terminal. `bar` ground, `bar-line` border, 8px radius, the
  image peek's shadow. The same in both themes, as the terminal is.
- A monospace field on `bar-well`, its border `bar-slate` while focused and `bar-amber-line` when nothing matches.
- The count in `bar-sub`: `3 of 12`, `No match`, or nothing while the field is empty. Its title on `No match` says the
  bar searches what the terminal showed since it opened.
- Then ↑ (older, Enter), ↓ (newer, Shift+Enter) and ✕ (Esc), outlined `bar-well` buttons as the image viewer's.
- Every match is washed `bar-amber-line`, and the one shown `bar-amber` with the terminal's ground as its text, as a
  browser's find marks them. They are xterm decorations, not its selection, which ttyd copies to the clipboard. The
  view scrolls to put the one shown a third of the way down.
