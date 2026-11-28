import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadCommon(page) {
  const window = Object.assign(page, { WoodshedLogins: require('./public/logins.cjs'), WoodshedAgents: require('../shared/agents.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') });
  const context = vm.createContext({
    window, console, document: { addEventListener() {}, createElement: () => ({}) }, matchMedia: () => ({}), fetch: () => new Promise(() => {}),
  });
  vm.runInContext(fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8'), context);
  return window.Woodshed;
}

// A scroller whose offset is clamped by what the textarea's height does to the layout, as a browser does when the field
// collapses to measure: collapsed, the thread is taller and its offset is cut to the shorter range.
function layout() {
  const state = { collapsed: false };
  const thread = { _top: 300, get scrollTop() { return this._top; }, set scrollTop(v) { this._top = Math.min(v, state.collapsed ? 0 : 1000); } };
  const pane = { scrollTop: 0, parentElement: null };
  const footer = { scrollTop: 0, parentElement: pane };
  const field = {
    parentElement: footer,
    style: { _h: '44px', get height() { return this._h; }, set height(v) { this._h = v; state.collapsed = v === 'auto'; if (v === 'auto') thread._top = 0; } },
    get scrollHeight() { return 80; },
  };
  return { field, thread, pane, footer };
}

test('fitField grows the field and puts back the scroll that measuring it cut off, of a sibling scroller too', () => {
  const { field, thread } = layout();
  const W = loadCommon({ scrollX: 0, scrollY: 0, scrollTo() {} });
  W.fitField(field, 240, [thread]);
  assert.equal(field.style.height, '80px');
  assert.equal(thread.scrollTop, 300);
});

test('fitField without the sibling scroller leaves it clamped (the regression the argument covers)', () => {
  const { field, thread } = layout();
  const W = loadCommon({ scrollX: 0, scrollY: 0, scrollTo() {} });
  W.fitField(field, 240);
  assert.equal(thread.scrollTop, 0);
});

test('fitField puts back an ancestor scroll and the page scroll, and keeps the field within its cap', () => {
  const { field, footer } = layout();
  footer.scrollTop = 50;
  const calls = [];
  const win = { scrollX: 0, scrollY: 120, scrollTo(x, y) { calls.push([x, y]); } };
  const W = loadCommon(win);
  // Collapsing moves the ancestor and the page, as a shrunk layout does.
  const set = Object.getOwnPropertyDescriptor(field.style, 'height').set;
  Object.defineProperty(field.style, 'height', { get() { return this._h; }, set(v) { if (v === 'auto') { footer.scrollTop = 0; win.scrollY = 0; } set.call(this, v); } });
  W.fitField(field, 60);
  assert.equal(field.style.height, '60px');
  assert.equal(footer.scrollTop, 50);
  assert.deepEqual(calls, [[0, 120]]);
});
