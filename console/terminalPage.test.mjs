import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { pageShell, servePublic, terminalPageHtml, terminalPageUrl } from './server.mjs';

const VENDOR = path.join(import.meta.dirname, 'public/vendor/xterm');

async function serve(t) {
  const server = http.createServer((req, res) => {
    if (!servePublic(req, res, new URL(req.url, 'http://console.invalid'))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('the terminal page names each of its files by hash, and each is served to be kept', async (t) => {
  const base = await serve(t);
  const html = terminalPageHtml();
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(urls.map((u) => u.replace(/\?v=[0-9a-f]{12}$/, '')), [
    '/static/vendor/xterm/xterm.css', '/static/vendor/xterm/xterm.js', '/static/vendor/xterm/addon-fit.js',
    '/static/vendor/xterm/addon-web-links.js', '/static/vendor/xterm/addon-unicode11.js', '/static/vendor/xterm/addon-webgl.js',
    '/static/vendor/xterm/addon-canvas.js', '/static/terminalPage.js',
  ]);
  for (const url of urls) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', url);
    await res.arrayBuffer();
  }
});

test('the terminal page is kept by its own hash, and only the console\'s pages may frame it', async (t) => {
  const base = await serve(t);
  const url = terminalPageUrl();
  assert.match(url, /^\/static\/term\.html\?v=[0-9a-f]{12}$/);
  const res = await fetch(`${base}${url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(await res.text(), terminalPageHtml());

  const old = await fetch(`${base}/static/term.html?v=000000000000`);
  assert.equal(old.headers.get('cache-control'), 'no-cache', 'an address from before a deploy is asked for again');
  assert.equal(old.headers.get('content-security-policy'), "frame-ancestors 'self'");
});

test('every console page tells session.js where the terminal page is', () => {
  const html = pageShell({ title: 'Woodshed', script: 'session.js' });
  assert.ok(html.includes(`<meta name="woodshed-terminal-page" content="${terminalPageUrl()}">`));
});

test('the vendored xterm files are the ones its README names', () => {
  const readme = fs.readFileSync(path.join(VENDOR, 'README.md'), 'utf8');
  const named = [...readme.matchAll(/`([0-9a-f]{64})`/g)].map((m) => m[1]);
  const files = fs.readdirSync(VENDOR).filter((f) => /\.(js|css)$/.test(f)).sort();
  assert.deepEqual(files, ['addon-canvas.js', 'addon-fit.js', 'addon-unicode11.js', 'addon-web-links.js', 'addon-webgl.js', 'xterm.css', 'xterm.js']);
  for (const file of files) {
    const sha = createHash('sha256').update(fs.readFileSync(path.join(VENDOR, file))).digest('hex');
    assert.ok(named.includes(sha), `${file}'s sha256 is in the README's table`);
  }
});
