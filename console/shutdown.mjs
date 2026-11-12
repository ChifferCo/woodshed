// The console's stop on SIGTERM, which Docker sends on every redeploy (`docker compose up` with a new image) and then
// follows with SIGKILL 10 s later. The console runs as the container's PID 1, where a signal with no handler does
// nothing, so without this it always waited the 10 s out and was killed mid-request.
//
// On the signal it stops its loops, stops taking connections on each of its servers, and exits once the requests
// already in flight have answered, or at GRACE_MS, well inside Docker's 10 s, whatever is still open. A terminal's or a
// tunnel's websocket is no request: it is cut at the exit, and the browser's terminal reconnects to the new console.

export const GRACE_MS = 7_000;
const CHECK_MS = 50;

/**
 * Counts `server`'s requests that have not answered yet. Attach it before the server takes its first request.
 * @param {import('node:http').Server} server
 * @returns {() => number}
 */
export function countRequests(server) {
  let open = 0;
  server.on('request', (req, res) => {
    open += 1;
    res.once('close', () => { open -= 1; });
  });
  return () => open;
}

/**
 * @param {{servers: Array<{server: import('node:net').Server, open: () => number}>, stop: () => void,
 *          graceMs?: number, exit?: (code: number) => void}} args
 *   `stop` ends the background work (installation.stop); `exit` is process.exit but in tests
 * @returns {(signal: string) => Promise<void>}  the stop, which runs once however often the signal comes
 */
export function createShutdown({ servers, stop, graceMs = GRACE_MS, exit = (code) => process.exit(code) }) {
  let stopping = null;
  return function shutdown(signal) {
    stopping ??= (async () => {
      const startedAt = Date.now();
      const open = () => servers.reduce((sum, s) => sum + s.open(), 0);
      console.log('console: stopping', { signal, openRequests: open() });
      try {
        stop();
      } catch (err) {
        console.error('console: loops not stopped', { message: String(err?.message ?? err).split('\n')[0] });
      }
      for (const { server } of servers) {
        server.close();
        // Keep-alive connections with no request on them would otherwise hold their socket until they time out.
        server.closeIdleConnections?.();
      }
      while (open() > 0 && Date.now() - startedAt < graceMs) await new Promise((resolve) => setTimeout(resolve, CHECK_MS));
      const left = open();
      if (left) console.warn('console: requests still open at the stop, cut off', { openRequests: left, graceMs });
      console.log('console: stopped', { seconds: Math.round((Date.now() - startedAt) / 100) / 10 });
      exit(0);
    })();
    return stopping;
  };
}
