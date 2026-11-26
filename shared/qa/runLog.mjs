// What a QA run's claude did, in words, for the run log a QA session sends the console (POST /qa-log) and for the
// reason a run ended with no verdict. Read from claude's `--output-format stream-json` stream, which session/qa.sh keeps
// for each pass (plan.jsonl, test.jsonl): how the pass ended, how long it ran, what it last said and what failed.
//
//   node runLog.mjs <phase> <stream.jsonl>          prints the pass's summary
//   node runLog.mjs --why <phase> <stream.jsonl>   prints one line saying how the pass ended, nothing when it ended well
//   node runLog.mjs --redact                        copies stdin to stdout with credentials taken out (redact)
import fs from 'node:fs';
import { isMain } from '../isMain.mjs';

const LAST_SAID = 3;
const SAID_CHARS = 600;
const ERROR_LINES = 5;
const ERROR_CHARS = 300;
const NOT_JSON_LINES = 15;

// What claude's result event's `subtype` means for a QA pass.
const ENDINGS = {
  error_max_turns: 'ran out of turns before it finished',
  error_during_execution: 'hit an error while it ran',
  error_max_budget_usd: 'ran out of its budget',
};

// The console keeps the log, and an admin or whoever started the run reads it. The run's tools print what they like (a failed
// install shows the registry token it used), so the whole log is scrubbed before it is sent: the values of this
// environment's own secrets, then what credentials look like.
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTH)/i;
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-ant-|sk-|npm_|AKIA|ASIA|AIza)[A-Za-z0-9_\-]{8,}/g,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=\-]{8,}/gi,
  // `name=value`, `name: value` and JSON's `"name": "value"`, the value quoted or not.
  /([?&;]|\b)((?:[A-Za-z0-9]+_)*(?:access_?|auth_?|api_?|private_?|client_?)?(?:token|secret|password|passwd|key|signature|sig|credential)s?|authorization|_authToken)(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s&;,"'}\]]+)/gi,
  /\b([a-z][a-z0-9+.\-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
];

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]  whose secrets' own values are taken out too
 * @returns {string}  the text with credentials replaced by `[redacted]`
 */
export function redact(text, env = process.env) {
  let out = String(text ?? '');
  // Also the variables the installation names as its install secrets (WOODSHED_INSTALL_SECRETS), whatever they are called.
  const named = new Set(String(env.WOODSHED_INSTALL_SECRETS ?? '').split(/[\s,]+/).filter(Boolean));
  // A secret-like name's value must be 8 characters to be taken out by value (shorter ones are ordinary words and numbers);
  // one the installation names as a secret is taken out at 4 (a PIN), since it is known to be one.
  const values = Object.entries(env).filter(([k, v]) => typeof v === 'string' && ((named.has(k) && v.length >= 4) || (SECRET_NAME_RE.test(k) && v.length >= 8))).map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('[redacted]');
  out = out.replace(PATTERNS[0], '[redacted]').replace(PATTERNS[1], '[redacted]').replace(PATTERNS[2], '[redacted]')
    .replace(PATTERNS[3], '$1 [redacted]').replace(PATTERNS[4], '$1$2$3[redacted]').replace(PATTERNS[5], '$1[redacted]@');
  return out;
}

// A result event is read from a file the run's own code can write, so what is printed from it is validated: a count is a
// whole number and a subtype is a short lowercase word, never a string that could carry anything else.
const count = (n) => (Number.isInteger(n) && n >= 0 ? n : null);
// The result subtypes claude writes; any other value is shown as `unknown`, so a value a run made up never gets printed.
export const SUBTYPES = ['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries'];
const subtypeOf = (t) => (SUBTYPES.includes(t) ? t : 'unknown');

// Own keys only: a subtype a run made up (`constructor`) must not find a function on the prototype.
const endingOf = (subtype) => (typeof subtype === 'string' && Object.hasOwn(ENDINGS, subtype) ? ENDINGS[subtype] : null);

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {string} stream  claude's stream-json output, with anything else it printed (errors) among the lines
 * @returns {{result: object|null, said: string[], tools: number, errors: string[], other: string[], turns: number}}
 */
export function readStream(stream, env = process.env) {
  const said = [];
  const errors = [];
  const other = [];
  let result = null;
  let tools = 0;
  let turns = 0;
  for (const line of String(stream ?? '').split('\n')) {
    if (!line.trim()) continue;
    // Parsed first and scrubbed after, by field: scrubbing the raw line can break its JSON (a quoted value's escape). Each
    // text is scrubbed whole here, before anything is clipped: a clip inside a secret would leave a piece no scrub can match.
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      other.push(redact(line, env));
      continue;
    }
    if (event?.type === 'result') result = { ...event, ...(typeof event.result === 'string' ? { result: redact(event.result, env) } : {}) };
    if (event?.type === 'assistant') {
      turns += 1;
      for (const part of event.message?.content ?? []) {
        if (part.type === 'text' && part.text?.trim()) said.push(redact(part.text.trim(), env));
        if (part.type === 'tool_use') tools += 1;
      }
    }
    if (event?.type === 'user') {
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (part.type === 'tool_result' && part.is_error) {
          const text = Array.isArray(part.content) ? part.content.map((c) => c.text ?? '').join(' ') : part.content;
          errors.push(oneLine(redact(String(text ?? ''), env)));
        }
      }
    }
  }
  return { result, said, tools, errors, other, turns };
}

/**
 * @param {string} phase  `plan` or `test`
 * @param {string} stream  the pass's stream-json
 * @returns {string|null}  one line on how the pass ended when that kept it from finishing, null when it ended well. It
 *   goes into the pull request's QA comment and check, which anyone who reads the pull request sees, so it is fixed
 *   phrases and a turn count: never anything claude or its tools printed, which the run log (console only) keeps
 */
export function whyEnded(phase, stream) {
  const { result } = readStream(stream);
  if (!result) return `the ${phase} pass ended without a result: claude was stopped or crashed`;
  if (endingOf(result.subtype)) return `the ${phase} pass ${endingOf(result.subtype)}${count(result.num_turns) ? ` (${count(result.num_turns)} turns)` : ''}`;
  if (result.is_error) return `the ${phase} pass ended in an error`;
  return null;
}

/**
 * @param {string} phase  `plan` or `test`
 * @param {string|null} stream  null when the pass never ran
 * @returns {string}  the pass as a short text for a person: how it ended, its numbers, its last words and its tool errors
 */
export function summarize(phase, stream) {
  if (stream == null) return `## ${phase}\nDid not run.\n`;
  const { result, said, tools, errors, other, turns } = readStream(stream);
  const lines = [`## ${phase}`];
  if (!result) {
    lines.push('Ended: no result from claude, so it was stopped or crashed before it finished.');
  } else {
    const ending = endingOf(result.subtype) ?? (result.is_error ? 'ended in an error' : 'finished');
    lines.push(`Ended: ${ending} (${subtypeOf(result.subtype)}${result.is_error ? ', is_error' : ''})`);
    if (Array.isArray(result.permission_denials) && result.permission_denials.length) {
      const names = [...new Set(result.permission_denials.map((d) => d.tool_name).filter((n) => typeof n === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(n)))];
      lines.push(`Permission denied: ${result.permission_denials.length} call${result.permission_denials.length === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}`);
    }
  }
  const numbers = [
    `${count(result?.num_turns) ?? turns} turns`, `${tools} tool calls`,
    Number.isFinite(result?.duration_ms) && result.duration_ms >= 0 && `${Math.round(result.duration_ms / 1000)} s`,
    Number.isFinite(result?.total_cost_usd) && result.total_cost_usd >= 0 && `$${result.total_cost_usd.toFixed(2)}`,
  ].filter(Boolean);
  lines.push(`Ran: ${numbers.join(', ')}`);
  if (errors.length) {
    lines.push(`Tool errors: ${errors.length}, the last ${Math.min(ERROR_LINES, errors.length)}:`);
    for (const e of errors.slice(-ERROR_LINES)) lines.push(`  - ${clip(e, ERROR_CHARS)}`);
  }
  if (result?.result && result.is_error) lines.push(`Result: ${clip(oneLine(result.result), SAID_CHARS)}`);
  if (said.length) {
    lines.push(`Last said (${Math.min(LAST_SAID, said.length)} of ${said.length}):`);
    for (const s of said.slice(-LAST_SAID)) lines.push(`  > ${clip(oneLine(s), SAID_CHARS)}`);
  } else {
    lines.push('It said nothing.');
  }
  if (other.length) {
    lines.push('Other output (not claude\'s stream), the last lines:');
    for (const o of other.slice(-NOT_JSON_LINES)) lines.push(`  ${clip(o, ERROR_CHARS)}`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  if (argv[0] === '--redact') {
    process.stdout.write(redact(fs.readFileSync(0, 'utf8')));
    return;
  }
  const why = argv[0] === '--why';
  const [phase, file] = why ? argv.slice(1) : argv;
  if (!phase || !file) throw new Error('usage: runLog.mjs [--why] <phase> <stream.jsonl>');
  const stream = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (why) {
    const text = stream == null ? null : whyEnded(phase, stream);
    if (text) process.stdout.write(`${text}\n`);
    return;
  }
  process.stdout.write(summarize(phase, stream));
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`runLog: ${err.message}\n`);
    process.exit(1);
  }
}
