// What makes the launcher installable as a desktop app.
//
// The shed is the thing you keep open all day, and in a browser it is one
// tab among thirty with a blank favicon. Installed, it is a window in cmd+tab
// with its own icon. That is the whole feature: a manifest, a set of icons,
// and a handful of <link> tags in the page head.
//
// Deliberately NOT here: a service worker. Chrome dropped the requirement for
// one on desktop in M112 and Safari's Add to Dock never wanted one, so the
// only thing a worker would buy is a nicer error page when the tailnet is
// down. Against that, every embedded terminal opens as a top-level tab on
// this origin (server.mjs's webTerminalUrl/webShellUrl buttons), so a worker
// would sit in front of those too — and a worker that misbehaves cannot be
// retired by redeploying, only through each browser's devtools. Not worth it
// for a prettier failure.
//
// The icon bytes live in this file as base64 rather than as files in a
// directory, because a *.mjs in woodshed/shared/ is already shipped by the
// shed's install.sh and both Woodshed Cloud images, and already hashed by
// selfUpdate.mjs, all by glob. Image files would mean teaching each of those
// a second kind of file to move 32 KB.
//
// They are a one-off render of WOODSHED_MARK_SVG below, not a build step. This
// directory has no dependencies and no toolchain, and a generator that drives
// a headless browser to produce five files that change once a year would be
// the first — so the render was done once and the result pasted in. To redo
// it after editing the mark, from a checkout with Playwright installed in a
// folder of it (web/ below):
//
//   node --input-type=module -e '
//     import { createRequire } from "node:module";
//     import { WOODSHED_MARK_SVG, ICON_SIZES, maskableMark }
//       from "./woodshed/shared/pwa.mjs";
//     const { chromium } = createRequire("./web/package.json")("playwright");
//     const b = await chromium.launch();
//     for (const [name, { size, maskable }] of Object.entries(ICON_SIZES)) {
//       const p = await b.newPage({ viewport: { width: size, height: size } });
//       const svg = maskable ? maskableMark() : WOODSHED_MARK_SVG;
//       await p.setContent(`<style>html,body{margin:0}img{width:${size}px;
//         height:${size}px;display:block}</style><img src="data:image/svg+xml;
//         base64,${Buffer.from(svg).toString("base64")}">`.replace(/\s+/g, " "));
//       const png = (await p.screenshot({ omitBackground: true })).toString("base64");
//       console.log(name, png.match(/.{1,96}/g).join("\n"));
//     }
//     await b.close();'
//
// Then rewrap the output to match the shape below — the `+` between the
// chunks is load-bearing, since adjacent string literals are not
// concatenation in JavaScript.

// Still the bridge: a deck, an arch over it, and two towers. The app is called
// Woodshed now and this mark is not a shed, which is deliberate — an installed
// app is found by its icon, and changing the drawing turns a rename into "my
// app disappeared from the Dock". Redrawing it as a shed is a separate
// decision, taken when someone wants it, not a side effect of the rename.
//
// Not the repo's own app logo either. That app may sit next to it in the Dock,
// so it is drawn to be told apart at 32px:
// different silhouette, different field colour, sharing only the orange.
//
// One path set at two content scales. `scale` is about the maskable icon:
// Android and macOS crop a maskable icon to a shape of their choosing, and
// only the middle 80% is guaranteed to survive, so the maskable render draws
// the same mark smaller inside the same field.
function markSvg(scale) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    + '<rect width="512" height="512" fill="#1b2232"/>'
    + `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)" `
    + 'fill="none" stroke="#E87D09" stroke-width="38" stroke-linecap="round">'
    + '<path d="M64 277H448"/>'
    + '<path d="M110 277C110 116 402 116 402 277"/>'
    + '<path d="M110 277V357"/>'
    + '<path d="M402 277V357"/>'
    + '</g></svg>';
}

export const WOODSHED_MARK_SVG = markSvg(1);

// 0.72 keeps the mark inside the 80% safe circle: the deck is the widest
// part at 422px across including its round caps, and 422 * 0.72 / 2 = 152,
// comfortably inside the 205px radius the safe zone guarantees.
export function maskableMark() {
  return markSvg(0.72);
}

// 192 and 512 are Chrome's installability minimums, the maskable 512 is what
// keeps the mark from being letterboxed inside a platform's icon shape, 180
// is what Safari and iOS reach for first, and 32 is the tab favicon.
export const ICON_SIZES = {
  'favicon-32.png': { size: 32 },
  'apple-touch-icon.png': { size: 180 },
  'icon-192.png': { size: 192 },
  'icon-512.png': { size: 512 },
  'icon-maskable-512.png': { size: 512, maskable: true },
};

// Rendered from WOODSHED_MARK_SVG by the recipe at the top of this file. Do not
// hand-edit:
// change the mark above and re-run the generator, or the icon the box
// serves stops matching the one in this file.
const ICON_PNG_BASE64 = {
  'favicon-32.png':
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAACLklEQVR4nOxWS2sTURS+8x7jPDLJlETT1hohxT4EJbpwVay4'
    + 'cyfoQlHBhQvBtb/AhQvpSnRRnwu3LhWpSkFEK9bqYBVqU53Sd5OZhGbe4x1HaZhM2oHSruZbnXvPvee753znXi6eyx8B2wkc'
    + 'bDNigphghwho1MmxRo4x2lkTDuUqMVsjZ6uk5qBbJUhR5rXDS6fzFRRBAi7bcZ9NJe98blvViQ0iIK1uMoE6V/qWz/es0NgG'
    + '24Fmg0dSelgSzRbZhBPwpDU0IPe31f2TjvzmxhYS0wo1pVBw5gCv7+f1YmZtsFP1M5tYoq+/6lBNPCrB3cFSMetFf/A19Xgy'
    + 'XdHDKynQ5sWDKxd6ytD+MJe4OrKveQ3GCXsCUyc6lEu93p4n34Sh8axmt1RSs7B380ySsvtELceaP8pUSaUCa0I2ny140Ufl'
    + '3bc/ZkAE3BrLjMoMNM51rzZ7gwRJyvKLc++LCJo6JxQuQIalNDSOZutQvID3vwaue+PYfBevc4RVEAyAgIll2rA3b3MfFOb0'
    + 'ixqk+l4mqyZeUqib77P++f6pd3xv7Uyh8td0vLRc95BYDy1gCzjARWDEbu9wZjFTfyMzb+dY0NhFJzvVPOw/TjvVVYPD+1Iq'
    + 'egYk5lzu9QR4UWKmVfqnQr38xfmu9f7zpwbaVZ/goZSumlFfKpawfILnM/xrmWt0xc/1pgje5BmVXFjDn04KUCsQGYaDji/u'
    + '+rSYgBrAxml0IfG/KCaICcAfAAAA//8KYusqAAAABklEQVQDAHKbxQ7XJ1pkAAAAAElFTkSuQmCC',
  'apple-touch-icon.png':
      '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'
    + 'TkSuQmCC',
  'icon-192.png':
      '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',
  'icon-512.png':
      'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAQAElEQVR4nOzdCZRc1X2g8Vv70l3Ve1fvrRVJCFloYREWtlgE'
    + 'wTBh4jMzcU5mkgmOHRzb4MTjJOMlzswZT+xznGUwMXEgJMHjJXZsjoPtWAtI2AgMaAMhoZ1epJa6equurn17eZIXbNRSd0td'
    + '792q//c7Ok0jgYoj3rvfW+91dy5aqwAA8rgVAEAkAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAA'
    + 'EIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCK'
    + 'AACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAA'
    + 'gFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQ'
    + 'BAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQA'
    + 'AIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACE'
    + 'IgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIA'
    + 'ACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAg'
    + 'FAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAFA92oO55kCxxlP0uUtepzK/+l0ln9Pwuswf'
    + 'JZ/LOPfD/CXzb51GwPxVd6lkOHJFR7rgzJXOfZMtOLPm16L5vTN7/mcy5jfnflWZX5N512jadSblVUBVIACoGC6H0RwoNPvz'
    + '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'
    + '5c2fPD3lMe9lDcS9e6PBfdEghyHAlWNfKx8CAABCMT0eAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUA'
    + 'AEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABA'
    + 'KAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgC'
    + 'AABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAA'
    + 'QhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIR'
    + 'AAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAA'
    + 'EIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQio1/6GYAAACfSURBVAAAgFAEAACEIgAAIBQBAAChCAAACEUA'
    + 'AEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABA'
    + 'KAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAg1L8DAAD//wh3UBoAAAAG'
    + 'SURBVAMAWzYGz9cJAkgAAAAASUVORK5CYII=',
  'icon-maskable-512.png':
      'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAQAElEQVR4nOzdeZhdZX3A8ffcZe42M/fOktmzTchCAggTgoQg'
    + 'qCBiCWofsQjU6tMFrVZRWsG2Km5PedSidXlqra1tpcWVRUUQAjaBBEJWICELk0kmk5nMPnPvnbnL3O30DGANkPXOOXfOub/v'
    + '58kzz2R55o/c95zvOe97Fk9re4cCAMjjUQAAkQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAo'
    + 'AgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIA'
    + 'AEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABC'
    + 'EQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEA'
    + 'ABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQ'
    + 'igAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoA'
    + 'AIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACA'
    + 'UAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAE'
    + 'AACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAA'
    + 'hCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQi'
    + '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'
    + 'hnomij/y2DEY+OxTrQVm/22PADiAsSH9oitS688trzuDrTGbV597uuWe/RyFoUhP91f2TFRc1jrhPpPZoJ93Rj69sS2vs/d3'
    + 'AALgDLrSNvZVHYz5VtSlqioKp/z3zw75b9/Ytrm/UgEzcCDq33S0sj2cbgqd+gT06KTny880/3BPvc6xv0Nore0dCo7y3sVj'
    + 'Vy2IdzSkXv9XqZz2TH/o/gORjUe55gdmurRl4t2Lohc3JwJe/fV/u3PI/0h3+GedTDY6DAFwqmrv9IxQfTBX58/lCtpo2jOU'
    + '8OwYNvPmYeD1OuYkGkLTo87r1kdSnuGkZ++oP57lqWKORAAAQCi6DQBCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABA'
    + 'KAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgC'
    + 'AABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAA'
    + 'QhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIR'
    + 'AAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAA'
    + 'EIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCK'
    + 'AACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAA'
    + 'gFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQ'
    + 'BAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQA'
    + 'AIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACE'
    + 'IgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQKj/AwAA//8VloSBAAAABklEQVQD'
    + 'AOD5LR4ALQWFAAAAAElFTkSuQmCC',
};

export const MANIFEST = {
  // Pins the app's identity to the origin, so start_url can move later
  // without the browser deciding it is looking at a different app.
  id: '/',
  name: 'Woodshed',
  // What the Dock and the iOS home screen label with. Same as `name` on
  // purpose: this used to be an abbreviation because "Claude Bridge" was too
  // long to survive there, and "Woodshed" is not — so the shortened form would
  // only cost the app its name. Keep them equal unless the name grows.
  short_name: 'Woodshed',
  description: 'Launch and watch claude sessions on the dev box.',
  start_url: '/',
  // Everything the shed serves lives under /, including the session pages,
  // the review page and the terminals, so all of it stays in the app window.
  // The links out to claude.ai are a different origin and so are outside it,
  // which is what hands them to the real browser — the behaviour we want.
  scope: '/',
  // What puts it in cmd+tab with its own window and no address bar.
  // minimal-ui would keep a back button, which this page could use since it
  // drives session selection through pushState — but minimal-ui falls back to
  // a plain browser tab where it isn't supported, and losing the app window
  // is a worse trade than losing the button. Cmd+[ still goes back.
  display: 'standalone',
  theme_color: '#1b2232',
  background_color: '#1b2232',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

// Goes in the launcher's <head> only. The review page is loaded in an iframe,
// and a <link rel="manifest"> in a nested browsing context is ignored, so the
// same tags there would be bytes fetched on every panel open for nothing.
export const HEAD_TAGS = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color" content="#1b2232">',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">',
  // Safari resolves apple-touch-icon before it looks at the manifest, and
  // falls back to a screenshot of the page if it finds neither. Without this
  // line Add to Dock can land a thumbnail in the Dock instead of the mark.
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="Woodshed">',
].join('\n  ');

// Decoded once at load rather than per request: five small buffers held for
// the life of the process is cheaper than base64-decoding on every cold page.
const ASSETS = new Map();
for (const [name, b64] of Object.entries(ICON_PNG_BASE64)) {
  ASSETS.set(`/${name}`, { type: 'image/png', body: Buffer.from(b64, 'base64') });
}
ASSETS.set('/favicon.svg', { type: 'image/svg+xml', body: Buffer.from(WOODSHED_MARK_SVG) });

/**
 * The PWA routes: the manifest, the icons, and the SVG favicon.
 *
 * Same contract as handleReviewRequest and handleTerminalProxy — returns
 * false for a URL that is not ours, so server.mjs falls through to its own
 * routes. It sits after the host check there on purpose: a manifest request
 * carrying a Host this box does not answer to should get the same 421 as
 * everything else, and there is nothing here worth making an exception for.
 *
 * @returns {boolean} whether this request was handled
 */
export function handlePwaRequest(req, res) {
  if (req.method !== 'GET') return false;

  if (req.url === '/manifest.webmanifest') {
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      // Not no-store: browsers re-read this rarely and a stale one is
      // harmless. But not a long max-age either — renaming the app or
      // repointing an icon and then waiting out a day of cache is a
      // genuinely baffling ten minutes.
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(MANIFEST, null, 2));
    return true;
  }

  const asset = ASSETS.get(req.url || '');
  if (asset) {
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
      // These change only when someone regenerates them, and a day-stale icon
      // is invisible. The manifest above is the one that needs to stay fresh.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      // The SVG is the reason this header is here. Navigating straight to
      // /favicon.svg renders it as a document on this origin, and SVG can
      // carry script — and same-origin script on the shed can drive the
      // whole launcher, which is exactly why /doc/* pages are served
      // sandboxed. Today the mark is a compile-time constant with nothing but
      // <rect> and <path> in it, so there is nothing to run. This keeps that
      // true if someone later adds a <foreignObject> or an <a> to it.
      ...(asset.type === 'image/svg+xml'
        ? { 'Content-Security-Policy': "default-src 'none'; sandbox" }
        : {}),
    });
    res.end(asset.body);
    return true;
  }

  return false;
}
