// The design system's tokens (designSystem/tokens.json) are the ones the console really ships (public/style.css).
// This fails when someone changes a color in one and not the other, so the two copies cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
const tokens = JSON.parse(readFileSync(new URL('./designSystem/tokens.json', import.meta.url), 'utf8'));

// The variables of the first block that opens with `selector {`, as { name: value }.
function declarations(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `style.css has no ${selector} block`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const out = {};
  for (const [, name, value] of body.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out[name] = value.trim().toLowerCase();
  return out;
}

// Colors the console does not define yet, kept in the design system for the change that adds them.
const PLANNED = new Set();

test('every color token matches style.css in light and in both dark blocks', () => {
  const light = declarations(':root');
  // Dark is declared twice: when the device asks for it, and when the settings sheet picks it.
  const dark = { ...light, ...declarations(':root[data-theme="dark"]') };
  const darkByDevice = { ...light, ...declarations(':root:not([data-theme="light"])') };
  const wrong = [];
  for (const token of tokens.color.tokens) {
    if (PLANNED.has(token.name)) continue;
    const want = { light: token.value.light.toLowerCase(), dark: token.value.dark.toLowerCase() };
    if (light[token.name] !== want.light) wrong.push(`${token.name} light: style.css ${light[token.name]}, tokens.json ${want.light}`);
    if (dark[token.name] !== want.dark) wrong.push(`${token.name} dark: style.css ${dark[token.name]}, tokens.json ${want.dark}`);
    if (darkByDevice[token.name] !== want.dark) wrong.push(`${token.name} dark (device): style.css ${darkByDevice[token.name]}, tokens.json ${want.dark}`);
  }
  assert.deepEqual(wrong, []);
});
