# The console's fonts

The faces the design system names (`../../designSystem/tokens.json`, `type.families`): Red Hat Display for text and
titles, Red Hat Mono for meta lines, counts, PR chips and code. One design family, so the two read as one tool. The
console serves them from `/static/fonts/`, named by hash and kept by the browser like its scripts, instead of loading
them from Google Fonts: no third-party request holds up a page, nothing about who opens the console goes to Google, and
a console that cannot reach Google still draws them. `fontFaces` in `../../server.mjs` writes their `@font-face` rules
into each page's head.

They are the files Google Fonts serves, as Fontsource publishes them on npm, copied as they are: each face is one
variable file holding every weight (Red Hat Display 300 to 900, Red Hat Mono 300 to 700), in the Latin and Latin
Extended subsets, each with the `unicode-range` Google gives it so a browser downloads a file only for text that needs
it. Cyrillic, Greek and Vietnamese are left out: such text is drawn in the system's font. SIL Open Font License 1.1:
`LICENSE-<family>` is each package's.

| File | Package | sha256 |
| --- | --- | --- |
| `red-hat-display-latin-ext-wght-normal.woff2` | `@fontsource-variable/red-hat-display@5.3.0` | `500d3bfa4e42db97b676a8f1ae3fea651011fd4b73fee592b80b242353da9ead` |
| `red-hat-display-latin-wght-normal.woff2` | `@fontsource-variable/red-hat-display@5.3.0` | `f7a7830b81e351f89b91f0201de71c8d937e25df5a3e31ecca9b4ee877abedb7` |
| `red-hat-mono-latin-ext-wght-normal.woff2` | `@fontsource-variable/red-hat-mono@5.3.0` | `772e09e0b85fae466ecf6f2e337b856e6aa0a7b68447dfb91341ed7419353a52` |
| `red-hat-mono-latin-wght-normal.woff2` | `@fontsource-variable/red-hat-mono@5.3.0` | `f4bef0a36dbd4f8a34ce60ba67af24babb1334de1637c0f2680e2e18c112c2b3` |

To change a version: `npm pack @fontsource-variable/<family>@<version>` in an empty folder, copy the files from its
`files/`, and update this table with `sha256sum`. A new face also goes in `FONT_FACES` in `../../server.mjs`, with its
weight range. `console/fonts.test.mjs` checks each file here is in the table and in a rule.
