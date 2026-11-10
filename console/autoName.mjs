// A name for a My Woodshed session started with none, after the shed's auto-name: Haiku reads the prompt and coins
// a few words. It runs on the team's Anthropic key, which the console's Anthropic proxy reads and keeps; the session
// never sees it. The session starts without waiting for it. Best effort: no key, a slow answer or an empty one gives
// '', and the session keeps the prompt's first line.
//
// Raw fetch, not the SDK: the console has no dependencies.

const MODEL = 'claude-haiku-5-5';
// Nobody waits on it; this only ends a call Anthropic never answers.
const TIMEOUT_MS = 15_000;
const MAX_PROMPT_CHARS = 4000;
const MAX_NAME_CHARS = 60;

const SYSTEM = 'Name the coding task the user describes, for a list of work sessions. Reply with only the name: '
  + '2 to 6 words, under 50 characters, sentence case, like "Fix the reflect button" or "OAuth callback errors". '
  + 'No quotes, no full stop, no explanation.';

/** @returns {string}  the name as a list shows it, or '' for nothing usable */
export function cleanName(raw) {
  const line = String(raw ?? '').trim().split('\n')[0].replace(/^["'`*]+|["'`*.]+$/g, '').trim();
  return line.length > MAX_NAME_CHARS ? `${line.slice(0, MAX_NAME_CHARS - 1)}…` : line;
}

/**
 * @param {{teamKey: (() => Promise<string|null>)|null, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number}} deps
 * @returns {(prompt: string) => Promise<string>}  a name, or ''
 */
export function createAutoNamer({ teamKey, fetchImpl = fetch, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  return async function autoName(prompt) {
    if (!teamKey) return '';
    const from = now();
    try {
      const value = (await teamKey())?.trim();
      if (!value) {
        console.warn('autoName: no team Anthropic key, the prompt names it');
        return '';
      }
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': value, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 64,
          // A few words need no thinking; Haiku allows it off at low effort.
          thinking: { type: 'disabled' },
          output_config: { effort: 'low' },
          system: SYSTEM,
          messages: [{ role: 'user', content: String(prompt).slice(0, MAX_PROMPT_CHARS) }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // Anthropic's own words say which field it refused; they hold no secret.
        const error = (await res.json().catch(() => null))?.error;
        console.warn('autoName: Anthropic refused', {
          status: res.status, type: error?.type ?? null, message: String(error?.message ?? '').slice(0, 200) || null, ms: now() - from,
        });
        return '';
      }
      const body = await res.json();
      const name = cleanName((body?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''));
      console.log('autoName: named', { named: Boolean(name), stopReason: body?.stop_reason ?? null, ms: now() - from });
      return name;
    } catch (err) {
      console.warn('autoName: failed', { message: String(err?.message ?? err).split('\n')[0], ms: now() - from });
      return '';
    }
  };
}
