// A QA run's recordings: the browser's video of each page the tests opened (session/qa.sh sends them through the
// session API's POST /qa-video), and one still from it (POST /qa-poster) for the QA comment to show. They are kept
// where the provider keeps files only the console reaches (S3 on AWS, the state folder on a local install) for
// QA_RECORDING_DAYS, then deleted, never in the repo.
//
//   GET /qa/<session id>/video/<n>              behind the console's sign-in, for whoever may open the session: S3
//                                               answers it (a five-minute link the console redirects to), or the
//                                               console from its folder, so a browser plays it and seeks in it
//   GET /qa-poster/<session id>/<secret>.png    with no sign-in, since GitHub's image proxy fetches every image a
//                                               comment shows without one: the still alone, at an unguessable name
//
// The store (providers/aws/recordingStore.mjs, providers/local/recordingStore.mjs) keeps each under the same key:
//   <session id>/video-<n>.webm
//   <session id>/poster-<secret>.png

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

export const QA_RECORDING_DAYS = 14;
export const MAX_QA_POSTER_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}$/;
const SECRET_RE = /^[0-9a-f]{32}$/;
const TYPES = { webm: 'video/webm', png: 'image/png' };
// The videos' route is the page a comment links to; the poster's sits outside sign-in.
export const QA_VIDEO_RE = /^\/qa\/([0-9a-f]{8})\/video\/([1-9][0-9]?)$/;
export const QA_POSTER_RE = /^\/qa-poster\/([0-9a-f]{8})\/([0-9a-f]{32})\.png$/;

export function isPng(buffer) {
  return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

/** @returns {string}  where a run's video `n` is watched, for the QA comment */
export function qaVideoPath(id, n) {
  return `/qa/${id}/video/${n}`;
}

export function contentTypeOf(key) {
  return TYPES[String(key).split('.').pop()] ?? 'application/octet-stream';
}

/**
 * @param {{store: {put: Function, get: Function, list: Function, remove: Function, link?: Function, file?: Function},
 *   now?: () => number}} opts
 */
export function createQaRecordings({ store, now = Date.now }) {
  function checkId(id) {
    if (!ID_RE.test(String(id))) throw new Error(`not a session id: ${id}`);
  }

  /** @returns {Promise<{key: string}>} */
  async function saveVideo(id, n, video) {
    checkId(id);
    const key = `${id}/video-${n}.webm`;
    await store.put(key, video, TYPES.webm);
    return { key };
  }

  /** @returns {Promise<{path: string}>}  the poster's public path, whose secret is its only lock */
  async function savePoster(id, png) {
    checkId(id);
    const secret = randomBytes(16).toString('hex');
    await store.put(`${id}/poster-${secret}.png`, png, TYPES.png);
    return { path: `/qa-poster/${id}/${secret}.png` };
  }

  function gone(res) {
    res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`This QA recording is no longer kept: recordings are deleted ${QA_RECORDING_DAYS} days after their run.\n`);
  }

  /** A video, to a browser the caller has let through. S3 answers it through a short link; a folder, here. */
  async function serveVideo(req, res, { id, n }) {
    const key = `${id}/video-${n}.webm`;
    if (store.link) {
      const url = await store.link(key);
      if (!url) return gone(res);
      res.writeHead(302, { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      return res.end();
    }
    const file = await store.file(key);
    if (!file) return gone(res);
    return sendFile(req, res, file, TYPES.webm);
  }

  /** The still, to anyone with its name: GitHub's image proxy keeps a copy, so it is asked for rarely. */
  async function servePoster(_req, res, { id, secret }) {
    if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return gone(res);
    const found = await store.get(`${id}/poster-${secret}.png`);
    if (!found) return gone(res);
    res.writeHead(200, { 'content-type': TYPES.png, 'content-length': found.bytes, 'cache-control': 'public, max-age=86400' });
    found.stream.pipe(res);
  }

  /** Every recording older than QA_RECORDING_DAYS, deleted. @returns {Promise<number>}  how many */
  async function sweep() {
    const cutoff = now() - QA_RECORDING_DAYS * 86_400_000;
    const old = (await store.list()).filter((o) => o.modifiedAt && Date.parse(o.modifiedAt) < cutoff).map((o) => o.key);
    if (old.length) {
      await store.remove(old);
      console.log('qaRecordings: old recordings deleted', { count: old.length, days: QA_RECORDING_DAYS });
    }
    return old.length;
  }

  return { saveVideo, savePoster, serveVideo, servePoster, sweep };
}

// A file with HTTP ranges, which a browser's video player asks for to seek.
function sendFile(req, res, { path: file, bytes }, type) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0;
  let end = bytes - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), bytes - 1);
    } else {
      start = Math.max(0, bytes - Number(range[2]));
    }
    if (start > end || start >= bytes) {
      res.writeHead(416, { 'content-range': `bytes */${bytes}` });
      return res.end();
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${bytes}`, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' });
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': bytes, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' });
  }
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file, { start, end }).pipe(res);
}
