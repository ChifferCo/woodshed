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
  assert.equal(files.length, 14, 'Merriweather 700, Red Hat Display 400 to 700, JetBrains Mono 400 and 500, two subsets each');
  for (const file of files) {
    const sha = createHash('sha256').update(fs.readFileSync(path.join(FONTS, file))).digest('hex');
    assert.ok(readme.includes(`| \`${file}\` |`) && readme.includes(`\`${sha}\``), `${file} with its sha256 in the README's table`);
    const at = rules.indexOf(`/static/fonts/${file}?v=`);
    assert.ok(at >= 0, `${file} in a rule`);
    assert.match(rules.slice(at), /^\/static\/fonts\/[\w.-]+\?v=[0-9a-f]{12}\)/, `${file} by its hash`);
  }
  assert.equal((rules.match(/@font-face/g) ?? []).length, files.length, 'no rule for a file that is not there');
});

test('each rule says its face, weight and subset as Google\'s stylesheet did', () => {
  const rules = fontFaces();
  const rule = (file) => rules.split('\n').find((line) => line.includes(`/static/fonts/${file}?`)) ?? '';
  const latin = rule('red-hat-display-latin-600-normal.woff2');
  assert.match(latin, /font-family: 'Red Hat Display'; font-style: normal; font-weight: 600; font-display: swap;/);
  assert.match(latin, /unicode-range: U\+0000-00FF,/);
  assert.match(rule('red-hat-display-latin-ext-600-normal.woff2'), /unicode-range: U\+0100-02BA,/);
  assert.match(rule('merriweather-latin-700-normal.woff2'), /font-family: 'Merriweather'; font-style: normal; font-weight: 700;/);
  assert.match(rule('jetbrains-mono-latin-500-normal.woff2'), /font-family: 'JetBrains Mono'; font-style: normal; font-weight: 500;/);
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
  const url = /url\((\/static\/fonts\/red-hat-display-latin-400-normal\.woff2\?v=[0-9a-f]{12})\)/.exec(html)[1];
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 4).toString('latin1'), 'wOF2', 'a woff2 file');
});
