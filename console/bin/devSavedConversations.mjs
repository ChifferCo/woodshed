// The conversations the dev console's stopped sessions kept at their last save (shared/savedConversation.mjs), written
// where the console's home store keeps them (console/homes.mjs, conversationKey), for their Chat while they are stopped:
// a private claude paused when idle, a private codex that stopped, and a shared session kept for its Resume.
import fs from 'node:fs';
import path from 'node:path';

import { conversationKey } from '../homes.mjs';

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const CLAUDE = [
  { role: 'user', text: 'The invoice totals are off by a cent on some orders. Can you find out why?', at: at(95) },
  { role: 'assistant', text: 'I will look at how the totals are summed first.', at: at(94) },
  { role: 'tool', tool: 'Grep', text: 'roundCents', at: at(94) },
  { role: 'tool', tool: 'Read', text: 'src/invoices/totals.ts', at: at(93) },
  {
    role: 'assistant', at: at(92),
    text: 'Found it: each line is rounded **before** the lines are added up, so an order of many small lines drifts.\n\n'
      + '- `lineTotal()` rounds to cents\n- `invoiceTotal()` adds the rounded lines\n\nI will sum the exact amounts and round once.',
  },
  {
    role: 'tool', tool: 'Edit', text: 'src/invoices/totals.ts', at: at(90),
    diffs: [{ path: 'src/invoices/totals.ts', op: 'edit', add: 1, del: 1, hunks: [{ head: '@@ -12,1 +12,1 @@', lines: ['-  return lines.reduce((sum, l) => sum + roundCents(l.amount), 0);', '+  return roundCents(lines.reduce((sum, l) => sum + l.amount, 0));'] }] }],
  },
  { role: 'tool', tool: 'Bash', text: 'npm test -- totals', at: at(89) },
  { role: 'assistant', text: 'The totals tests pass, with a new one for a 40-line order. Shall I open a pull request?', at: at(88) },
];

const CODEX = [
  { role: 'user', text: 'Add a --dry-run flag to the import script.', at: at(240) },
  { role: 'tool', tool: 'shell', text: 'rg -n "parseArgs" scripts/import.mjs', at: at(239) },
  { role: 'tool', tool: 'apply_patch', text: 'scripts/import.mjs', at: at(237) },
  { role: 'assistant', text: 'Added `--dry-run`: it reads and checks every row, prints what it would write, and writes nothing.', at: at(236) },
];

const SHARED = [
  { role: 'user', text: 'manage_datasets query returns too many rows when a filter is empty.', at: at(600) },
  { role: 'assistant', text: 'An empty filter was read as no filter at all. It now matches nothing, and the query says so.', at: at(560) },
  { role: 'tool', tool: 'Bash', text: 'gh pr create --fill', at: at(555) },
  { role: 'assistant', text: 'Opened the pull request; the review approved it and the suite passed.', at: at(540) },
];

/** The sessions' ids, owners and agents, with what each kept. */
export const SAVED_CONVERSATIONS = [
  { id: 'ba5ed001', owner: 'local', agent: 'claude', entries: CLAUDE, savedAt: at(60) },
  { id: 'c0dec0d1', owner: 'local', agent: 'codex', entries: CODEX, savedAt: at(200) },
  { id: 'ab12cd34', owner: null, agent: 'claude', entries: SHARED, savedAt: at(530) },
];

/**
 * @param {string} homesDir  the local home store's folder (providers/local/homeStore.mjs)
 * @returns {Record<string, string>}  each session's savedAt, by id, for its record's conversationSavedAt
 */
export function writeSavedConversations(homesDir) {
  const savedAt = {};
  for (const c of SAVED_CONVERSATIONS) {
    const home = c.owner ? `${c.owner}/sessions/${c.id}` : `_sessions/${c.id}`;
    const file = path.join(homesDir, ...conversationKey(home).split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = { agent: c.agent, entries: c.entries, partial: false, writtenAt: Date.parse(c.entries.at(-1).at), savedAt: c.savedAt };
    fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    savedAt[c.id] = c.savedAt;
  }
  return savedAt;
}
