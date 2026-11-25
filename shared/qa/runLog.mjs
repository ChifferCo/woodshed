// What a QA run's claude did, in words, for the run log a QA session sends the console (POST /qa-log) and for the
// reason a run ended with no verdict. Read from claude's `--output-format stream-json` stream, which session/qa.sh keeps
// for each pass (plan.jsonl, test.jsonl): how the pass ended, how long it ran, what it last said and what failed.
//
//   node runLog.mjs <phase> <stream.jsonl>         prints the pass's summary
//   node runLog.mjs --why <phase> <stream.jsonl>   prints one line saying how the pass ended, nothing when it ended well
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

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {string} stream  claude's stream-json output, with anything else it printed (errors) among the lines
 * @returns {{result: object|null, said: string[], tools: number, errors: string[], other: string[], turns: number}}
 */
export function readStream(stream) {
  const said = [];
  const errors = [];
  const other = [];
  let result = null;
  let tools = 0;
  let turns = 0;
  for (const line of String(stream ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      other.push(line);
      continue;
    }
    if (event?.type === 'result') result = event;
    if (event?.type === 'assistant') {
      turns += 1;
      for (const part of event.message?.content ?? []) {
        if (part.type === 'text' && part.text?.trim()) said.push(part.text.trim());
        if (part.type === 'tool_use') tools += 1;
      }
    }
    if (event?.type === 'user') {
      for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (part.type === 'tool_result' && part.is_error) {
          const text = Array.isArray(part.content) ? part.content.map((c) => c.text ?? '').join(' ') : part.content;
          errors.push(oneLine(text));
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
  if (ENDINGS[result.subtype]) return `the ${phase} pass ${ENDINGS[result.subtype]}${result.num_turns ? ` (${result.num_turns} turns)` : ''}`;
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
    const ending = ENDINGS[result.subtype] ?? (result.is_error ? 'ended in an error' : 'finished');
    lines.push(`Ended: ${ending} (${result.subtype ?? 'unknown'}${result.is_error ? ', is_error' : ''})`);
    if (Array.isArray(result.permission_denials) && result.permission_denials.length) {
      const names = [...new Set(result.permission_denials.map((d) => d.tool_name).filter(Boolean))];
      lines.push(`Permission denied: ${result.permission_denials.length} call${result.permission_denials.length === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}`);
    }
  }
  const numbers = [
    `${result?.num_turns ?? turns} turns`, `${tools} tool calls`,
    Number.isFinite(result?.duration_ms) && `${Math.round(result.duration_ms / 1000)} s`,
    Number.isFinite(result?.total_cost_usd) && `$${result.total_cost_usd.toFixed(2)}`,
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
