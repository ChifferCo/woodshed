// A session's conversation as its Chat tab draws it (statusd's `GET /transcript`, session/sessionTranscript.mjs), kept by
// the console beside the session's saved Claude home, so a stopped or paused session's Chat still shows what was asked and
// said. statusd sends it at the stop's checkpoint and every few minutes while it changes (POST /conversation to the
// session API); the console keeps the last one whole, and the page reads it while the session is not running. It is a
// copy of the agent's own record, never a second one: once the session runs again, Chat reads the live record.
//
// One file for statusd, which fits it to the size the console takes, and for the console, which checks its shape.

import agents from './agents.cjs';

// What the console keeps of one: the newest MAX_ENTRIES the Chat tab reads, each cut to its MAX_TEXT, fit well inside
// this. A conversation over it loses its oldest entries first, and says so (`partial`), as a long live one does.
export const MAX_CONVERSATION_BYTES = 4 * 1024 * 1024;
// As many entries as the Chat tab asks for (sessionTranscript.mjs, MAX_ENTRIES).
export const MAX_CONVERSATION_ENTRIES = 300;
const ROLES = new Set(['user', 'assistant', 'tool']);

/**
 * The body statusd sends: the read's entries, the oldest dropped until the JSON fits `maxBytes`.
 * @param {{agent: string, entries: object[], partial?: boolean, writtenAt: number|null}} read
 * @param {number} [maxBytes]
 * @returns {string|null}  null when nothing fits, or there is nothing to keep
 */
export function fitConversation(read, maxBytes = MAX_CONVERSATION_BYTES) {
  if (!read || !Array.isArray(read.entries) || !read.entries.length) return null;
  let entries = read.entries.slice(-MAX_CONVERSATION_ENTRIES);
  let partial = Boolean(read.partial) || entries.length < read.entries.length;
  for (;;) {
    const body = JSON.stringify({ agent: read.agent, entries, partial, writtenAt: read.writtenAt ?? null });
    if (Buffer.byteLength(body) <= maxBytes) return body;
    if (entries.length <= 1) return null;
    // The oldest quarter goes each round, at least one entry: a conversation far over the limit takes a few rounds, not hundreds.
    entries = entries.slice(Math.max(1, Math.floor(entries.length / 4)));
    partial = true;
  }
}

/**
 * The console's check of what a session sent: the shape the Chat tab reads, and nothing it does not.
 * @param {string} text
 * @returns {{agent: string, entries: object[], partial: boolean, writtenAt: number|null, savedAt: string|null}|null}  null
 *   for anything else. savedAt: when the console kept it, in what the console wrote (a session's own is replaced)
 */
export function parseSavedConversation(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!agents.isAgent(body.agent)) return null;
  if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > MAX_CONVERSATION_ENTRIES) return null;
  const shaped = body.entries.every((e) => e && typeof e === 'object' && !Array.isArray(e) && ROLES.has(e.role) && typeof e.text === 'string');
  if (!shaped) return null;
  const writtenAt = body.writtenAt === null || body.writtenAt === undefined ? null : Number(body.writtenAt);
  if (writtenAt !== null && !Number.isFinite(writtenAt)) return null;
  const savedAt = typeof body.savedAt === 'string' && Number.isFinite(Date.parse(body.savedAt)) ? body.savedAt : null;
  return { agent: body.agent, entries: body.entries, partial: body.partial === true, writtenAt, savedAt };
}
