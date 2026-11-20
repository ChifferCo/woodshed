// Renders icon.png, the app's icon on the Dock, the taskbar and in its installers, from the console's mark
// (shared/pwa.mjs). Run it with Electron after the mark changes, and commit the result:
//
//   cd desktop && npx electron renderIcon.mjs
//
// Not the web app's icon-512.png: that one is full bleed, a square edge to edge, which a browser's install crops to its
// own shape. The Dock shows a PNG as it is, so a full-bleed square sits there as a hard box among rounded icons. This
// draws Apple's icon grid instead: on a 1024 canvas, a rounded square of 824 at 100 from each edge with a corner of
// 185, a soft shadow under it, and the mark inside it with a margin of its own.
// Windows and Linux take the same file, where a rounded tile with a margin reads as an icon too.
//
// Rendered once and committed, as pwa.mjs's icons are, rather than at each build: a build machine with no display (CI)
// cannot start Electron's renderer.
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WOODSHED_MARK_SVG } from '../shared/pwa.mjs';

const SIZE = 1024;
const mark = `data:image/svg+xml;base64,${Buffer.from(WOODSHED_MARK_SVG).toString('base64')}`;
// The mark's own square, drawn at 86% of the tile and centred: its bridge then spans about 70% of the tile, as the
// glyph of a Dock icon does. Its field is the tile's colour, and the tile's clip trims its corners.
const MARK = 708;
const AT = (SIZE - MARK) / 2;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185" ry="185"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#1b2232" filter="url(#shadow)"/>
  <image href="${mark}" x="${AT}" y="${AT}" width="${MARK}" height="${MARK}" clip-path="url(#tile)"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const page = `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${SIZE}px;height:${SIZE}px}</style>`
    + `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = (await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })).resize({ width: SIZE, height: SIZE });
  const out = fileURLToPath(new URL('./icon.png', import.meta.url));
  writeFileSync(out, image.toPNG());
  console.log(`icon written: ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});
