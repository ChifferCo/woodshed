import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { countRequests, createShutdown } from './shutdown.mjs';

async function serve(handler) {
  const server = http.createServer(handler);
  const open = countRequests(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, open, url: `http://127.0.0.1:${server.address().port}` };
}

test('on SIGTERM the console stops its loops and takes no new connection, lets a request in flight answer, then exits', async () => {
  const app = await serve((req, res) => setTimeout(() => res.end('done'), 300));
  let stopped = 0;
  let exited = null;
  const exitedAt = new Promise((resolve) => {
    const shutdown = createShutdown({ servers: [app], stop: () => { stopped += 1; }, exit: (code) => { exited = code; resolve(Date.now()); } });
    app.shutdown = shutdown;
  });
  const inFlight = fetch(`${app.url}/slow`).then(async (r) => ({ status: r.status, text: await r.text() }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.open(), 1);
  const startedAt = Date.now();
  app.shutdown('SIGTERM');
  app.shutdown('SIGTERM');
  assert.equal(stopped, 1, 'a second signal does not stop twice');
  await assert.rejects(fetch(`${app.url}/new`, { headers: { connection: 'close' } }), 'a new connection is refused');
  assert.deepEqual(await inFlight, { status: 200, text: 'done' });
  const at = await exitedAt;
  assert.equal(exited, 0);
  assert.ok(at - startedAt < 1_000, `it exits once the request answered (${at - startedAt} ms)`);
});

test('a request still open at the grace period is cut off, and the console exits in time anyway', async () => {
  const app = await serve(() => {});
  const api = await serve((req, res) => res.end('ok'));
  const hung = fetch(`${app.url}/hangs`).catch((err) => err);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startedAt = Date.now();
  const exited = await new Promise((resolve) => {
    createShutdown({ servers: [app, api], stop: () => {}, graceMs: 300, exit: resolve })('SIGTERM');
  });
  assert.equal(exited, 0);
  const took = Date.now() - startedAt;
  assert.ok(took >= 300 && took < 1_000, `it waited the grace period and no longer (${took} ms)`);
  app.server.closeAllConnections();
  assert.ok((await hung) instanceof Error);
});
