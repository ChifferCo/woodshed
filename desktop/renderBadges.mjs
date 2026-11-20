// Renders badges/badge-1.png … badge-9.png and badge-9plus.png: the count Windows draws over the taskbar button
// (main.mjs, overlay.mjs), since Windows has no badge count of its own (app.setBadgeCount does nothing there). The
// design system's rule: yellow (`wait`) only for a session that needs a person, and a status is a word, so the
// overlay's description says it in words too. Run with Electron after changing the look, and commit the files:
//
//   cd desktop && npx electron renderBadges.mjs
//
// Rendered once, as renderIcon.mjs's icon is: a build machine with no display cannot start Electron's renderer.
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BADGE_LABELS } from './overlay.mjs';

const SIZE = 32;
// `wait` from console/designSystem/tokens.json, light theme: white on it is 4.9:1.
const WAIT = '#8a6700';

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  for (const [name, text] of Object.entries(BADGE_LABELS)) {
    const size = text.length > 1 ? 15 : 20;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`
      + `<circle cx="16" cy="16" r="15" fill="${WAIT}" stroke="#ffffff" stroke-width="2"/>`
      + `<text x="16" y="16" text-anchor="middle" dominant-baseline="central" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#ffffff">${text}</text></svg>`;
    const page = `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${SIZE}px;height:${SIZE}px}</style>`
      + `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
    await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const image = (await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })).resize({ width: SIZE, height: SIZE });
    writeFileSync(fileURLToPath(new URL(`./badges/${name}.png`, import.meta.url)), image.toPNG());
  }
  console.log(`badges written: ${Object.keys(BADGE_LABELS).join(', ')}`);
  app.quit();
});
