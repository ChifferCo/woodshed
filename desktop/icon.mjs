// Writes icon.png, the window's and the installers' icon, from the mark the console serves (shared/pwa.mjs), so the
// desktop app and an installed web app look the same in the Dock. Run before `start` and `dist`; the file is ignored by
// git, since its bytes are already in pwa.mjs.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { iconPng } from '../shared/pwa.mjs';

const out = fileURLToPath(new URL('./icon.png', import.meta.url));
writeFileSync(out, iconPng('icon-512.png'));
console.log(`icon written: ${out}`);
