import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_PAGE_CHROME_CSS, CONSOLE_CHROME_CSS, consoleChromeCss, TRAFFIC_LIGHTS } from './windowChrome.mjs';

const room = (css) => Number(/\.rail-head \{ padding-left: (\d+)px/.exec(css)[1]);
const rail = (css) => Number(/flex-basis: (\d+)px/.exec(css)[1]);

test('the lights get 80px at 100%, and the rail keeps its row', () => {
  assert.equal(CONSOLE_CHROME_CSS, consoleChromeCss(1));
  assert.equal(room(CONSOLE_CHROME_CSS), 80);
  assert.equal(rail(CONSOLE_CHROME_CSS), 412);
  assert.deepEqual(TRAFFIC_LIGHTS, { x: 16, y: 19 });
});

test('zoomed, the room is the same on screen, in the page\'s own pixels', () => {
  for (const zoom of [0.5, 0.67, 0.8, 1.25, 1.5, 2]) {
    assert.ok(room(consoleChromeCss(zoom)) * zoom >= 80, `${zoom}: ${room(consoleChromeCss(zoom))}px`);
    assert.equal(rail(consoleChromeCss(zoom)) - room(consoleChromeCss(zoom)), 332, `${zoom}: the row's own width is kept`);
  }
  assert.equal(room(consoleChromeCss(0)), 80, 'a zoom of nothing is 100%');
});

test('bars drag the window, their controls do not', () => {
  for (const bar of ['.rail-head', '.pane-bar', '.side-head']) assert.match(CONSOLE_CHROME_CSS, new RegExp(`\\${bar} \\{[^}]*-webkit-app-region: drag`));
  assert.match(CONSOLE_CHROME_CSS, /\.rail-head :is\(a, button, input[^)]*\)[^{]*\{ -webkit-app-region: no-drag; \}/);
  assert.match(APP_PAGE_CHROME_CSS, /body \{ -webkit-app-region: drag; \}/);
});
