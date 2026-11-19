import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MANIFEST, ICON_SIZES, HEAD_TAGS, WOODSHED_MARK_SVG, maskableMark, handlePwaRequest,
} from './pwa.mjs';

// A fake ServerResponse that records what was written, so the routes can be
// exercised without a socket. Only the three methods handlePwaRequest calls.
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    end(body) { res.body = body; },
  };
  return res;
}

function get(url) {
  const res = fakeRes();
  const handled = handlePwaRequest({ method: 'GET', url }, res);
  return { handled, res };
}

// ---- the icon bytes -------------------------------------------------------
//
// These are base64 in pwa.mjs rather than files on disk, rendered once by the
// recipe in that file's header. Nothing here can re-run it — it needs a
// browser — so what is checkable is that what got pasted in is a PNG of the
// size the manifest claims. That catches a truncated copy-paste and a
// mismatched size, which are the two ways this actually goes wrong.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR is the first chunk of every PNG, so width and height are big-endian
// uint32s at a fixed offset. No decoder needed for the only two fields that
// matter here. Shared with the negative control below, which is the point:
// a control that re-implements the thing it is controlling proves nothing.
function pngSize(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('every declared icon is served as a real PNG', () => {
  for (const name of Object.keys(ICON_SIZES)) {
    const { handled, res } = get(`/${name}`);
    assert.equal(handled, true, `${name} is not routed`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.notEqual(pngSize(res.body), null, `${name} is not a PNG`);
  }
});

test("each icon's real dimensions are the ones its name promises", () => {
  for (const [name, { size }] of Object.entries(ICON_SIZES)) {
    const { width, height } = pngSize(get(`/${name}`).res.body);
    assert.equal(width, size, `${name} is ${width}px wide`);
    assert.equal(height, size, `${name} is ${height}px tall`);
  }
});

test('pngSize reports a wrong size rather than the expected one', () => {
  // Negative control over the function the two tests above rely on. They pass
  // on the real icons, which on its own proves nothing: a pngSize() reading
  // the wrong offset, or returning a constant, would pass exactly the same
  // way. So run a synthetic header that declares 64x64 through the real
  // function and require it to say 64 — the size no icon here has.
  const header = Buffer.alloc(24);
  PNG_MAGIC.copy(header, 0);
  header.writeUInt32BE(64, 16);
  header.writeUInt32BE(64, 20);

  assert.deepEqual(pngSize(header), { width: 64, height: 64 });
  for (const { size } of Object.values(ICON_SIZES)) {
    assert.notEqual(size, 64, 'pick a size no real icon uses for this control');
  }

  // And it has to be able to say no, or "is a real PNG" above is satisfied
  // by anything at all.
  assert.equal(pngSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
});

// ---- the manifest ---------------------------------------------------------

test('the manifest carries what makes a page installable', () => {
  // Chrome will not offer to install without these, and each one is a silent
  // failure rather than an error in the console.
  for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    assert.ok(key in MANIFEST, `manifest is missing ${key}`);
  }
  assert.equal(MANIFEST.display, 'standalone');
  const at = (size, purpose) => MANIFEST.icons.some(
    (i) => i.sizes === size && (i.purpose || 'any') === purpose,
  );
  assert.ok(at('192x192', 'any'), 'no 192 icon');
  assert.ok(at('512x512', 'any'), 'no 512 icon');
  assert.ok(at('512x512', 'maskable'), 'no maskable icon');
});

test('every icon the manifest points at is actually served', () => {
  // The manifest and the route table are written separately, so a renamed
  // icon would leave the manifest pointing at a 404 — which Chrome reports
  // only in the install dialog, by not appearing.
  for (const icon of MANIFEST.icons) {
    assert.equal(get(icon.src).handled, true, `${icon.src} is not routed`);
  }
});

// ---- the head tags --------------------------------------------------------
//
// That the tags are present on the launcher and absent from the framed review
// page is asserted by install.sh against the pages as served, which is where
// that property can actually break. What is worth checking here is the half
// install.sh cannot see: that each tag points at something real.

test('every icon the head tags point at is actually served', () => {
  for (const href of HEAD_TAGS.matchAll(/href="(\/[^"]+)"/g)) {
    if (href[1] === '/manifest.webmanifest') continue;
    assert.equal(get(href[1]).handled, true, `${href[1]} is not routed`);
  }
});

// ---- the mark and the route contract --------------------------------------

test('the maskable mark is drawn smaller than the plain one', () => {
  // The two differ only by the scale transform. If they ever come out equal
  // the maskable icon has stopped being maskable, and the mark gets cropped
  // by whatever shape the platform imposes.
  const scaleOf = (svg) => Number(/scale\(([\d.]+)\)/.exec(svg)[1]);
  assert.notEqual(maskableMark(), WOODSHED_MARK_SVG);
  assert.equal(scaleOf(WOODSHED_MARK_SVG), 1);
  assert.ok(scaleOf(maskableMark()) < 1, 'maskable mark is not scaled down');

  // The safe zone is the middle 80%, i.e. a radius of 205 in a 512 box. The
  // deck is the widest part at 422px across including its round caps.
  assert.ok((422 * scaleOf(maskableMark())) / 2 < 205, 'mark escapes the safe zone');
});

test('it returns false for a URL that is not its own', () => {
  // The contract every feature module in here shares: server.mjs must be able
  // to fall through to its own routes.
  for (const url of ['/', '/sessions', '/review', '/doc/x.html', '/manifest.json']) {
    assert.equal(get(url).handled, false, `${url} was wrongly claimed`);
  }
});

test('it ignores methods other than GET', () => {
  // Everything here is a static read. A POST to an icon is not a thing, and
  // claiming it would take it out of reach of the origin check in server.mjs.
  const res = fakeRes();
  assert.equal(handlePwaRequest({ method: 'POST', url: '/icon-192.png' }, res), false);
});
