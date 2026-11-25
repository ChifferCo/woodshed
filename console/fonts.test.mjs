import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fontFaces, pageShell, servePublic } from './server.mjs';

const FONTS = path.join(import.meta.dirname, 'public/fonts');

test('every font file is the one its README names, and has a rule', () => {
  const readme = fs.readFileSync(path.join(FONTS, 'README.md'), 'utf8');
  const rules = fontFaces();
  const files = fs.readdirSync(FONTS).filter((f) => f.endsWith('.woff2')).sort();
  assert.equal(files.length, 4, 'Red Hat Display and Red Hat Mono, one variable file per subset each');
  for (const file of files) {
    const sha = createHash('sha256').update(fs.readFileSync(path.join(FONTS, file))).digest('hex');
    assert.ok(readme.includes(`| \`${file}\` |`) && readme.includes(`\`${sha}\``), `${file} with its sha256 in the README's table`);
    const at = rules.indexOf(`/static/fonts/${file}?v=`);
    assert.ok(at >= 0, `${file} in a rule`);
    assert.match(rules.slice(at), /^\/static\/fonts\/[\w.-]+\?v=[0-9a-f]{12}\)/, `${file} by its hash`);
  }
  assert.equal((rules.match(/@font-face/g) ?? []).length, files.length, 'no rule for a file that is not there');
});

test('each rule says its face, its weights and its subset as Google\'s stylesheet did', () => {
  const rules = fontFaces();
  const rule = (file) => rules.split('\n').find((line) => line.includes(`/static/fonts/${file}?`)) ?? '';
  const latin = rule('red-hat-display-latin-wght-normal.woff2');
  assert.match(latin, /font-family: 'Red Hat Display'; font-style: normal; font-weight: 300 900; font-display: swap;/);
  assert.match(latin, /unicode-range: U\+0000-00FF,/);
  assert.match(rule('red-hat-display-latin-ext-wght-normal.woff2'), /unicode-range: U\+0100-02BA,/);
  assert.match(rule('red-hat-mono-latin-wght-normal.woff2'), /font-family: 'Red Hat Mono'; font-style: normal; font-weight: 300 700;/);
});

test('the console names no face it does not serve', () => {
  // The design system's families, and every stylesheet and page of the console's: a face named but not served draws in
  // the system's font with no error.
  const served = new Set(['Red Hat Display', 'Red Hat Mono']);
  const tokens = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'designSystem/tokens.json'), 'utf8'));
  for (const stack of Object.values(tokens.type.families)) assert.ok(served.has(stack.match(/^"?([^",]+)/)[1]), stack);
  for (const file of ['public/style.css', 'cliSignIn.mjs', 'desktopSignIn.mjs', 'public/terminalPage.js']) {
    const text = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(text, /Merriweather|JetBrains/, file);
  }
});

test('a page loads its fonts from the console, kept by hash, and asks Google for nothing', async (t) => {
  const html = pageShell({ title: 'Woodshed', script: 'session.js' });
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.ok(html.includes(fontFaces()));
  const server = http.createServer((req, res) => {
    if (!servePublic(req, res, new URL(req.url, 'http://console.invalid'))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = /url\((\/static\/fonts\/red-hat-display-latin-wght-normal\.woff2\?v=[0-9a-f]{12})\)/.exec(html)[1];
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 4).toString('latin1'), 'wOF2', 'a woff2 file');
});
