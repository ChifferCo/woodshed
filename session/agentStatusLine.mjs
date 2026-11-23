// Antigravity's status line (its settings.json `statusLine`, which configureAntigravity in entrypoint.sh writes): agy
// runs it with a JSON of its state on stdin each time it draws the line (antigravity.google/docs/cli/statusline). It
// keeps that JSON for statusd, which reads the agent's state (`agent_state`, `tool_confirmation_pending`), its quota
// for the pane bar's meter (agentPlanUsage.mjs) and its transcript's path for the Chat tab (sessionTranscript.mjs), and
// prints a short line for agy to draw.
//
// What it keeps is agy's own words about itself: no credential is in them (agy never puts its key in its status line).

import fs from 'node:fs';
import { isMain } from '../shared/isMain.mjs';

// WOODSHED_AGENT_STATUS_FILE moves it, for a test or a second agent on one machine; the fleet never sets it.
export const STATUS_FILE = process.env.WOODSHED_AGENT_STATUS_FILE || '/tmp/woodshed-agent-status.json';
// The most of agy's JSON kept: a status line's input is small, and anything far past it is not one.
const MAX_BYTES = 256 * 1024;

/**
 * @param {any} input  agy's status-line JSON, parsed
 * @returns {string}  the line drawn: the model and what it does, in a few words
 */
export function statusLineText(input) {
  const model = typeof input?.model === 'string' ? input.model : input?.model?.display_name ?? input?.model?.id ?? '';
  const state = typeof input?.agent_state === 'string' ? input.agent_state.replace(/_/g, ' ') : '';
  const asking = input?.tool_confirmation_pending === true ? 'waiting for you' : '';
  return [model, asking || state].filter(Boolean).join(' · ');
}

/** Keeps agy's JSON in STATUS_FILE, whole, written in one rename. @returns {any|null}  what was kept */
export function keepStatus(text, file = STATUS_FILE) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) return null;
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(input), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return input;
}

/**
 * The last status agy gave, with when it was written: null when there is none, or it does not read.
 * @returns {Promise<(object & {at: number})|null>}
 */
export async function readStatus(file = STATUS_FILE) {
  try {
    const [text, stat] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
    const input = JSON.parse(text);
    return input && typeof input === 'object' ? { ...input, at: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function main() {
  let text = '';
  try {
    text = fs.readFileSync(0, 'utf8');
  } catch {
    // Nothing on stdin: nothing to keep, and an empty line drawn.
  }
  let input = null;
  try {
    input = keepStatus(text);
  } catch {
    // A status line that fails to save still draws: agy shows what it prints.
  }
  process.stdout.write(`${statusLineText(input)}\n`);
}

if (isMain(import.meta.url)) main();
