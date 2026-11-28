// The per-run settings Antigravity CLI (`agy`) is started with (`--settings <file>`, merged over the user's
// ~/.gemini/antigravity-cli/settings.json and never saved), so what Woodshed's permission modes mean and which credential
// agy uses are decided for each agy on its own: the session's own agent and each one started beside another (agents.mjs)
// share one home, whose settings.json can say neither.
//
// Measured with agy 1.5.18 against a stand-in Gemini server (PR for Antigravity):
//   - Workspace edits are never asked for, in any mode, `default` included: the checkout is "auto-allowed". `--mode plan`
//     only puts `/plan` in front of the first message, and refuses nothing. Woodshed's modes therefore come from the
//     permission rules, which hold in every mode (deny > ask > allow, and over the workspace default).
//   - A command asks in `default`, `plan` and `accept-edits` when the terminal sandbox is off (it is, by default).
//   - agentMode is "auto" where agy finds it available (v1.5.7+), so `default` must say "" itself.
//   - `modelProvider: "gemini"` takes the Gemini API key from GEMINI_API_KEY and calls GOOGLE_GEMINI_BASE_URL (session/bin/agy);
//     with it unset agy signs in with Google instead, which is the owner's own login.

import { isMain } from '../shared/isMain.mjs';

export const MODES = ['auto', 'acceptEdits', 'plan', 'default'];

// Files Woodshed itself leaves for the agent to read, which sit outside the checkout (the same ones claudeHooks.json lets
// claude read without asking: session/README.md, "Why permissions are off").
const READABLE = ['/tmp/woodshed-setup.md', '/tmp/woodshed-deps', '/tmp/woodshed-docker-ports.log', '/tmp/woodshed-dockerd.log', '/tmp/answer.md', '/tmp/issue.json'];

/**
 * @param {{mode: string, team: boolean, repoDir: string}} want  team: the team's Gemini key through the console's proxy;
 *   otherwise the owner's own Google login
 * @returns {object}  settings.json's keys for this run
 */
export function runSettings({ mode, team, repoDir }) {
  if (!MODES.includes(mode)) throw new Error(`no permission mode ${String(mode).slice(0, 40)}`);
  const permissions = { allow: READABLE.map((file) => `read_file(${file})`) };
  // plan refuses every edit in the checkout, default asks for each one. Everything else about them is agy's own.
  if (mode === 'plan') permissions.deny = [`write_file(${repoDir})`];
  if (mode === 'default') permissions.ask = [`write_file(${repoDir})`];
  return {
    ...(team ? { modelProvider: 'gemini' } : {}),
    // "" is agy's default mode: left out, agy starts in auto mode where it is available.
    agentMode: '',
    toolPermission: 'request-review',
    permissions,
  };
}

/** agy's flags for a permission mode and nothing else (the settings come from `--settings`). */
export function modeFlags(mode) {
  if (mode === 'auto') return ['--dangerously-skip-permissions'];
  if (mode === 'acceptEdits') return ['--mode', 'accept-edits'];
  if (mode === 'plan') return ['--mode', 'plan'];
  return [];
}

if (isMain(import.meta.url)) {
  const [mode, auth, repoDir] = process.argv.slice(2);
  if (!repoDir || (auth !== 'key' && auth !== 'own')) {
    console.error('usage: antigravitySettings.mjs <mode> <key|own> <repo dir>');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(runSettings({ mode, team: auth === 'key', repoDir }), null, 2)}\n`);
}
