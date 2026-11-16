// readyGate: a PreToolUse hook (claudeHooks.json) that refuses to open or mark ready a pull request that changes an
// app when that app was never started in this session, since nothing can have been checked in it (#26686 did this
// with the proof rules in its prompt). A draft is always allowed: the session opens one, says under `## Proof` why
// the change cannot be shown here, and asks for a person with a `Needs a human:` comment.
//
// It only says no. Anything it cannot work out, such as git failing, lets the call through: a broken hook must not
// stop a session's work. Exit code 2 is Claude Code's "block this call", and what goes to stderr is shown to claude.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { defaultBranchOf } from '../shared/defaultBranch.mjs';
import { PROJECT_FILE, expandPath, loadProject } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';

const FILES_NAMED = 5;

/**
 * Whether this tool call opens a pull request for review or marks one ready, as opposed to opening a draft.
 * @param {{tool_name?: string, tool_input?: any}} payload  the hook's stdin, parsed
 * @returns {boolean}
 */
export function marksReady(payload) {
  const input = payload?.tool_input ?? {};
  if (payload?.tool_name === 'Bash') {
    const command = String(input.command ?? '');
    const creates = /\bgh\s+pr\s+create\b/.test(command) && !/\s(--draft|-d)\b/.test(command);
    const readies = /\bgh\s+pr\s+ready\b/.test(command) && !/\s--undo\b/.test(command);
    return creates || readies;
  }
  if (payload?.tool_name === 'mcp__github__create_pull_request') return input.draft !== true;
  if (payload?.tool_name === 'mcp__github__update_pull_request') return input.draft === false;
  return false;
}

/**
 * @param {{payload: any, changedFiles: string[]|null, appStarted?: boolean, app?: {paths: string[], howToProve: string}|null,
 *   apps?: {name: string, label: string, paths: string[], howToProve: string, started: boolean}[]}} args
 *   `changedFiles` is what the branch changes against the default branch, null when git could not say. `app` and
 *   `appStarted` are a project's one app; `apps` its several, each with whether it was started. A project with no app
 *   has its pull requests never refused
 * @returns {string|null}  why the call is refused, or null to let it through
 */
export function refusal({ payload, changedFiles, appStarted, app, apps = app ? [{ ...app, started: appStarted }] : [] }) {
  if (!apps.length || !marksReady(payload) || !changedFiles) return null;
  // A change under an app's paths needs that app started: another app having run checked nothing of it.
  for (const one of apps) {
    if (one.started) continue;
    const appFiles = changedFiles.filter((f) => one.paths.some((prefix) => f.startsWith(prefix)));
    if (appFiles.length) return refusalText(one, appFiles, apps.length > 1);
  }
  return null;
}

function refusalText(app, appFiles, several) {
  const named = appFiles.slice(0, FILES_NAMED).map((f) => `\`${f}\``).join(', ');
  const which = several ? `the ${app.label} app` : 'the app';
  return [
    `Not opened: this branch changes ${which} (${named}${appFiles.length > FILES_NAMED ? ', …' : ''}), but ${which} was never started in this session, so nothing was checked in it.`,
    `${app.howToProve} Put what you saw under \`## Proof\`, then run this again.`,
    'If it really cannot be shown here, open the pull request as a draft (`gh pr create --draft`) with the reason under `## Proof`, '
      + 'post a PR comment that opens with `Needs a human:`, tags the person on the PR body\'s `Started by @…` line and says what could not be proven and why, then stop.',
  ].join('\n\n');
}

function changedFilesIn(cwd) {
  try {
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const base = git(['merge-base', `origin/${defaultBranchOf(cwd)}`, 'HEAD']);
    // Against the working tree, new files included, so uncommitted work counts too: a session may open the PR before
    // its last commit.
    const changed = [...git(['diff', '--name-only', base]).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')];
    return changed.filter(Boolean);
  } catch {
    return null;
  }
}

function checkoutOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// An app was started when one of its logs has something in it. They are outside the Claude home a session keeps (the
// project file's app.logs, such as ~/.cache/<app>/<checkout>/), so a log there was written in this container. Each of
// several apps counts by its own logs alone.
export function appStartedIn({ repoDir, app, home = os.homedir() }) {
  return Object.values(app?.logs ?? {}).some((log) => {
    try {
      return fs.statSync(expandPath(log, { repoDir, home })).size > 0;
    } catch {
      return false;
    }
  });
}

// A project file that does not read refuses the call: a branch can break its own file, and the gate must not open
// because of it.
export function projectRefusal(err) {
  return `Not opened: ${err.message}. Fix the project file on this branch (README.md in woodshed, "The project file"), then run this again.`;
}

/**
 * A branch that breaks its own project file is refused even where the installation's file stands in for it
 * (`repoFileError`, shared/project.mjs): that file keeps this installation running and would hide the break from every
 * other. A repo whose file the default branch already broke is not refused for it: this branch did not break it.
 * @param {{project: {repoFileError?: string}, changedFiles: string[]|null}} args
 * @returns {string|null}
 */
export function brokenFileRefusal({ project, changedFiles }) {
  if (!project.repoFileError || !changedFiles?.includes(PROJECT_FILE)) return null;
  return projectRefusal({ message: project.repoFileError });
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!marksReady(payload)) return;
  const cwd = payload.cwd || process.cwd();
  const repoDir = checkoutOf(cwd);
  if (!repoDir) return;
  let project;
  try {
    project = loadProject(repoDir);
  } catch (err) {
    process.stderr.write(`${projectRefusal(err)}\n`);
    process.exit(2);
  }
  const changedFiles = changedFilesIn(cwd);
  const apps = project.apps.map((app) => ({ ...app, started: appStartedIn({ repoDir, app }) }));
  const reason = brokenFileRefusal({ project, changedFiles }) ?? refusal({ payload, changedFiles, apps });
  if (!reason) return;
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

if (isMain(import.meta.url)) main();
