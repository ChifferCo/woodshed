// What a codex pane says its session is doing. Codex has no hooks to tell statusd, so the screen is all there is.
// Only the bottom of the screen is read: codex's own printed output stays on screen and can hold any marker.

const BOTTOM_LINES = 14;
const APPROVAL_RE = /(press enter to confirm|esc to cancel|would you like to run)/i;
const WORKING_RE = /esc to interrupt/i;
const COMPOSER_RE = /^\s*[›>]\s/m;

/**
 * @param {string} paneText  raw `tmux capture-pane -p` output
 * @returns {'working'|'needs-you'|'done'|null}  null when codex is not open (a bare shell, a dead pane)
 */
export function classifyCodexPane(paneText) {
  if (typeof paneText !== 'string' || !paneText.trim()) return null;
  const bottom = paneText.split('\n').filter((line) => line.trim()).slice(-BOTTOM_LINES).join('\n');
  if (APPROVAL_RE.test(bottom)) return 'needs-you';
  if (WORKING_RE.test(bottom)) return 'working';
  return COMPOSER_RE.test(bottom) ? 'done' : null;
}
