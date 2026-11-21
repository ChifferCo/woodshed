// The TCP ports something in a session listens on, read from the kernel's own tables (/proc/net/tcp and tcp6), for
// `woodshed forward --auto` (cli/forward.mjs) to follow, and the session's own ports, which are never forwarded.

// The session's own: its Redis, then its terminals, status, viewers and editor (session/entrypoint.sh's header). The
// console reaches these itself, behind its sign-in; they are no app's.
export const SESSION_PORTS = Object.freeze([6379, 7681, 7682, 7683, 7684, 7685, 7686, 7687, 7688]);

// What a TCP socket that listens says in /proc/net/tcp's `st` column.
const LISTEN = '0A';
// Addresses a connection to localhost reaches: any address, 127.0.0.1, ::, ::1 and ::ffff:127.0.0.1, as the kernel
// writes them (each 32-bit word in the machine's own byte order, little-endian here).
const REACHABLE = new Set([
  '00000000', '0100007F',
  '00000000000000000000000000000000', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F',
]);

/**
 * @param {string} text  /proc/net/tcp and /proc/net/tcp6, one after the other
 * @returns {number[]}  each port listened on where localhost reaches it, once, in order; the session's own left out
 */
export function listeningPorts(text, { skip = SESSION_PORTS } = {}) {
  const ports = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== LISTEN) continue;
    const match = /^([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i.exec(fields[1]);
    if (!match || !REACHABLE.has(match[1].toUpperCase())) continue;
    const port = parseInt(match[2], 16);
    if (port > 0 && !skip.includes(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** @returns {number|null}  a TCP port, 1 to 65535, from text */
export function portNumber(text) {
  if (!/^\d{1,5}$/.test(String(text ?? ''))) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}
