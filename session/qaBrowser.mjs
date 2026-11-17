#!/usr/bin/env node
// The browser a QA run's tests drive (session/qa.sh): Playwright's MCP server, run behind this proxy so the video it
// records is whole. Playwright writes a page's video only when its browser closes; the MCP server exits as soon as
// claude goes (its stdin ends, or a signal) without closing it, which kills the recorder mid-file. So when claude goes,
// this sends the server `browser_close` itself, waits for its answer, and only then lets it exit.
//
//   node qaBrowser.mjs <command> [args...]   the MCP server's command, as claude would run it
import { spawn } from 'node:child_process';

const CLOSE_ID = 'woodshed-qa-browser-close';
// Closing the browser flushes the video; past this the server is let go anyway, with what it wrote.
const CLOSE_TIMEOUT_MS = Number(process.env.QA_BROWSER_CLOSE_TIMEOUT_MS) || 30_000;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: qaBrowser.mjs <command> [args...]');
  process.exit(2);
}

// Its own process group, so a signal to claude's group reaches this proxy and not the server before the close.
const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
let closing = null;
let answered = () => {};

// The server's lines go to claude, all but the answer to our own close.
let pending = '';
server.stdout.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end + 1);
    pending = pending.slice(end + 1);
    if (line.includes(CLOSE_ID) && isCloseAnswer(line)) {
      answered();
      continue;
    }
    if (!process.stdout.destroyed) process.stdout.write(line);
  }
});
server.stdin.on('error', () => {});
process.stdout.on('error', () => {});

function isCloseAnswer(line) {
  try {
    return JSON.parse(line).id === CLOSE_ID;
  } catch {
    return false;
  }
}

function closeBrowser(why) {
  if (closing) return closing;
  closing = new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`qaBrowser: the browser did not close in ${CLOSE_TIMEOUT_MS / 1000}s (${why}), the video may be cut short`);
      resolve();
    }, CLOSE_TIMEOUT_MS);
    answered = () => {
      clearTimeout(timer);
      resolve();
    };
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: CLOSE_ID, method: 'tools/call', params: { name: 'browser_close', arguments: {} } })}\n`);
  }).then(() => server.stdin.end());
  return closing;
}

process.stdin.on('data', (chunk) => {
  if (!closing) server.stdin.write(chunk);
});
process.stdin.on('end', () => closeBrowser('claude closed the connection'));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => closeBrowser(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
