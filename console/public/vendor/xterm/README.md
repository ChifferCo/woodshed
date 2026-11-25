# xterm.js, as the console's terminal page loads it

The browser terminal behind the TUI and Terminal tabs (`../../terminalPage.js`, in the page the console serves as
`/static/term.html`). These files are copied as they are from npm, not built here: the console has no dependencies and
no build step, so the one library a page needs is kept in the repo, served from `/static/` with the rest and cached by
its hash like them.

They are the versions ttyd 1.7.7 bundles in its own page, which the tabs framed before, so `terminal.js` (find, copy,
links, scrolling back, files dropped) kept the xterm API it was written for. ttyd's page also has the image, zmodem and
trzsz add-ons; it loads them only when the session asks for sixel or file transfer, which a Woodshed session never does,
so they are left out.

| File | Package | sha256 |
| --- | --- | --- |
| `xterm.js`, `xterm.css` | `@xterm/xterm@5.4.0` (`lib/xterm.js`, `css/xterm.css`) | `32900c1a490da904f7042f1257c54c259d05c21d220624854c87829fb018e106`, `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `addon-fit.js` | `@xterm/addon-fit@0.9.0` | `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089` |
| `addon-webgl.js` | `@xterm/addon-webgl@0.17.0` | `f5d52521f980bb2381e19adce03b4639691ad6fbd370921cf54bb07845d2160f` |
| `addon-canvas.js` | `@xterm/addon-canvas@0.6.0` | `e6caa1340238166a83c33f041237b2b699c78b49a9d9a7b8c4e8d24969f27d0f` |
| `addon-web-links.js` | `@xterm/addon-web-links@0.10.0` | `f230a6c8211ce4614dda5441f27b603c7c1ca95151a655bc0efac6377ee643f0` |
| `addon-unicode11.js` | `@xterm/addon-unicode11@0.7.0` | `b0c3be540a9984713aea996966c24ed1a639d11f60d44986b22661e3a8a148d0` |

Each is the package's UMD build, which sets a global (`Terminal`, `FitAddon`, …) for a plain `<script>`. MIT, by the
xterm.js authors: `LICENSE` is `@xterm/xterm`'s, and each add-on's is the same text.

To change versions: `npm pack @xterm/xterm@<version>` (and each add-on) in an empty folder, copy the same files here,
update this table with `sha256sum`, and add any new file to `STATIC_FILES` in `../../../server.mjs`. Check the
console's `terminal.js` against the new API, then the TUI tab in the dev console's live terminal, `/s/c0ffee11`.
