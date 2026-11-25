# The console's fonts

The faces the design system names (`../../designSystem/tokens.json`, `type.families`): Merriweather for page titles,
Red Hat Display for text, JetBrains Mono for code and figures. The console serves them from `/static/fonts/`, named by
hash and kept by the browser like its scripts, instead of loading them from Google Fonts: no third-party request holds
up a page, nothing about who opens the console goes to Google, and a console that cannot reach Google still draws them.
`fontFaces` in `../../server.mjs` writes their `@font-face` rules into each page's head.

They are the files Google Fonts serves, as Fontsource publishes them on npm, copied as they are: only the weights the
console uses, in the Latin and Latin Extended subsets, each with the `unicode-range` Google gives it so a browser
downloads a file only for text that needs it. Cyrillic, Greek and Vietnamese are left out: such text is drawn in the
system's font. SIL Open Font License 1.1: `LICENSE-<family>` is each package's.

| File | Package | sha256 |
| --- | --- | --- |
| `jetbrains-mono-latin-400-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb` |
| `jetbrains-mono-latin-500-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | `cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a` |
| `jetbrains-mono-latin-ext-400-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | `505dfba8ecbe77e82765f36d317ed7ef4ac42719dc5f4ae68d1c483fd22d0d14` |
| `jetbrains-mono-latin-ext-500-normal.woff2` | `@fontsource/jetbrains-mono@5.3.0` | `879df9319f1cbf633bee1dd489e376a9e1e8c458f4abddcfe381cb83b5e6b027` |
| `merriweather-latin-700-normal.woff2` | `@fontsource/merriweather@5.3.0` | `4e1ab49396c02be0d9a2a25eed7bc73781c047d85fcb5dfc2889873eaf992b09` |
| `merriweather-latin-ext-700-normal.woff2` | `@fontsource/merriweather@5.3.0` | `c4d28d6ee3414f8e0482f1acd62a35ea6409a2447c427191bcfa2f4f4ee670ff` |
| `red-hat-display-latin-400-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `131f293be2bb64d87a5ea2a90dadb934df94d976071e220dd685f2a036e5cf90` |
| `red-hat-display-latin-500-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `482366a12be7caca759ef249a9e793f295f5bb2df0b155f7f02b72daba00ef73` |
| `red-hat-display-latin-600-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `69eb3fa1ef788d887adadc9b8bf14ce517a0a879724b22a5fb8b5e3122f7e72c` |
| `red-hat-display-latin-700-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `9abd8177653672bb520e522ed9796479d67d1e71f198695d790813c1a11933a6` |
| `red-hat-display-latin-ext-400-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `08ee8f706c8a6db20d5cad26c992a970519504525881e16e9faadab3bac53c09` |
| `red-hat-display-latin-ext-500-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `7684d225f30c0af7b1070d9e959adcf101d7b109ea7f0dd640a5c30544dda67c` |
| `red-hat-display-latin-ext-600-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `1d0929d4ba3c096f44887e6402183128079fb5a777246dc75781432e489a0f00` |
| `red-hat-display-latin-ext-700-normal.woff2` | `@fontsource/red-hat-display@5.3.0` | `4e62513569bb41184e39fd017799a241aee8d0df034ce0a9c73f7546d2a994a2` |

To change a version or add a weight: `npm pack @fontsource/<family>@<version>` in an empty folder, copy the file from
its `files/`, update this table with `sha256sum`, and add it to `FONT_FACES` in `../../server.mjs` with its weight and
subset. `console/fonts.test.mjs` checks each file here is in the table and in a rule.
