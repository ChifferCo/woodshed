// The window's header on macOS, as Notion, Granola and T3 Code have it: no title bar, the console's own bars running to
// the window's top edge, the traffic lights inside the rail's head row, and that row and the pane bar as the handle the
// window is dragged by. The console's page knows nothing of it: the app adds these rules to the console's pages in its
// main window alone, so the console in a browser is as it was. Kept free of Electron so `node --test` reads it.

// Where macOS draws the traffic lights: centred on the rail head's row, whose controls are 30px tall in 10px of padding.
export const TRAFFIC_LIGHTS = Object.freeze({ x: 16, y: 19 });
// The room the lights take at the left of the row: 16px in, three lights 52px across, and a gap. `!important`, since the
// console sets each bar's padding in more than one rule.
const LIGHTS_ROOM = 80;
// The rail's width less the lights' room: 412px at 100%, the row's 360 with its 10px to spare kept, and 448px with the
// app's notifications bell in the row, which a console from before the bell does not draw (designSystem/README.md).
const RAIL_BASE = 332;
const BELL_ROOM = 36;

// Anything a person clicks, types in or opens, inside a bar the window is dragged by, stays a control.
const CONTROLS = ':is(a, button, input, select, textarea, label, summary, details, [role="button"], [role="tab"], [role="menu"], [tabindex], .who-list, .menu, [contenteditable])';

/**
 * The rules for the console's pages, under a window with no title bar.
 * @param {number} [zoom]  the page's zoom factor: the lights do not zoom with the page, so their room in the page's own
 *   pixels is 80 at 100%, 120 at 67%, 64 at 125%; the rail grows by as much, so its row still fits
 * @returns {string}
 */
export function consoleChromeCss(zoom = 1) {
  const room = Math.ceil(LIGHTS_ROOM / (zoom > 0 ? zoom : 1));
  return `
/* A thin strip along the top edge drags the window on every page, whatever is under it. */
html::before { content: ""; position: fixed; top: 0; left: 0; right: 0; height: 10px; z-index: 2147483647; -webkit-app-region: drag; pointer-events: none; }
/* The rail's head: the traffic lights at its left, and the row the window is dragged by. */
.rail-head { padding-left: ${room}px !important; -webkit-app-region: drag; }
/* The row keeps Mine | Everyone, People, + New session and the bell beside the lights: the rail is wider than in a browser by the
   room the lights take, less what the row had to spare. */
@media (min-width: 900px) { .rail { flex-basis: ${RAIL_BASE + room}px !important; } .shell:has(.rail-head.has-bell) .rail { flex-basis: ${RAIL_BASE + BELL_ROOM + room}px !important; } }
/* The pane bar is the handle on the right. With the rail hidden it starts under the lights, so it makes room for them. */
.pane-bar { -webkit-app-region: drag; }
.shell.is-railless .pane-bar { padding-left: ${Math.max(0, room - 40)}px !important; }
/* The settings pages' head, with Back to sessions, the same way. */
.side-head { padding-left: ${room}px !important; -webkit-app-region: drag; }
.rail-head ${CONTROLS}, .pane-bar ${CONTROLS}, .side-head ${CONTROLS} { -webkit-app-region: no-drag; }
`;
}

/** At 100%, as a page is first shown. */
export const CONSOLE_CHROME_CSS = consoleChromeCss(1);

/** The rules for the app's own pages (setup, signing in): the page around the card drags the window. */
export const APP_PAGE_CHROME_CSS = `
body { -webkit-app-region: drag; }
main, ${CONTROLS} { -webkit-app-region: no-drag; }
`;
