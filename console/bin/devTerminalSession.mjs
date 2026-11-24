// A made-up session for the dev console with a live TUI: ttyd in front of a tmux of its own, on the
// session's tmux.conf, as the entrypoint starts them (session/entrypoint.sh), with a few screens of a made-up
// conversation printed in it and a shell after. For what the page does on a real terminal: find, copy, links, scroll.
// Only where ttyd and tmux are on the PATH (a Woodshed session has both); elsewhere it returns null and the session is
// left out. No statusd: its Diff, App log and app go nowhere.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMUX_CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'session', 'tmux.conf');
// The entrypoint's theme and scrollback.
const THEME = 'theme={"background":"#14171d","foreground":"#d6d3cd","cursor":"#E87D09","cursorAccent":"#14171d","selectionBackground":"#2c2013"}';

const CONVERSATION = `#!/bin/sh
printf '\\033[1m> Why do webhook deliveries fail after a deploy?\\033[0m\\n\\n'
i=1
while [ $i -le 60 ]; do
  printf '⏺ Read(console/webhookDispatch.mjs) step %s: the queue is read again after %s s\\n' "$i" "$((i * 2))"
  i=$((i + 1))
done
printf '\\n⏺ The retry waits 2 s, then 4 s, then 8 s, and gives up after the fifth try.\\n'
printf '  A deploy stops the console for a few seconds, so the first retry lands while it is away.\\n\\n'
printf '\\033[1m> Make it back off for longer\\033[0m\\n\\n'
printf '⏺ Changed the backoff to 5 s, 15 s and 45 s (console/webhookDispatch.mjs:42).\\n\\n'
exec sh
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const onPath = (bin) => {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * @returns {Promise<{port: number, shellPort: number, close: () => void}|null>}  null where ttyd or tmux is missing;
 *   `port` is the TUI tab's ttyd, `shellPort` the Terminal tab's, on a plain shell in a tmux session of its own
 */
export async function startDevTerminal({ id, terminalToken }) {
  if (!onPath('ttyd') || !onPath('tmux')) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-dev-terminal-'));
  const script = path.join(root, 'conversation.sh');
  fs.writeFileSync(script, CONVERSATION, { mode: 0o755 });
  // A socket of its own, so it never meets the session's own tmux.
  const socket = path.join(root, 'tmux.sock');
  execFileSync('tmux', ['-S', socket, '-f', TMUX_CONF, 'new-session', '-d', '-s', 'claude', '-x', '120', '-y', '30', script]);
  const port = await freePort();
  const ttyd = spawn('ttyd', ['--writable', '--interface', '127.0.0.1', '--port', String(port), '--base-path', `/term/${id}`,
    '--credential', `woodshed:${terminalToken}`, '-t', THEME, '-t', 'scrollback=10000', '-t', 'disableLeaveAlert=true',
    'tmux', '-S', socket, 'attach', '-t', 'claude'], { stdio: 'ignore' });
  // The Terminal tab, as a session's second ttyd: a shell in its own tmux session, made again after an `exit` (-A).
  const shellPort = await freePort();
  const shell = spawn('ttyd', ['--writable', '--interface', '127.0.0.1', '--port', String(shellPort), '--base-path', `/shell/${id}`,
    '--credential', `woodshed:${terminalToken}`, '-t', THEME, '-t', 'scrollback=10000', '-t', 'disableLeaveAlert=true',
    'tmux', '-S', socket, 'new-session', '-A', '-s', 'shell', '-c', root], { stdio: 'ignore' });
  return {
    port,
    shellPort,
    close() {
      ttyd.kill();
      shell.kill();
      try {
        execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // Already gone.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
