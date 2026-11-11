// QA's prompts and verdict, the same wherever QA runs: the QA actions in a repo's own CI and a QA session both build
// their prompts and read their report with this, so they agree on what was tested and what it means.
//
//   node qa.mjs prompts <dir> --app-url <url> --base <branch> [--notes <file>]
//       writes <dir>/plan-prompt.md, <dir>/test-prompt.md and <dir>/rubric.md
//   node qa.mjs verdict <dir> [--not-covered <why>]
//       prints {conclusion, title, status, total, passed, failed, unverified, edgeWarnings} as JSON
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isMain } from '../isMain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(HERE, name), 'utf8');
const NOTES_HEADING = "# The repository's QA notes";
const NO_NOTES = 'No QA notes on the base branch';

/**
 * @param {{kind: 'plan'|'test', appUrl: string, base: string, rubric: string, notes: string|null}} args
 *   `rubric` is the path the session reads the rubric at; `notes` the repo's QA notes, null when it has none
 * @returns {string}
 */
export function promptFor({ kind, appUrl, base, rubric, notes }) {
  const filled = read(`${kind}.txt`).replaceAll('{{APP_URL}}', appUrl).replaceAll('{{BASE}}', base).replaceAll('{{RUBRIC}}', rubric);
  return `${filled}\n${NOTES_HEADING}\n\n${notes?.trim() || NO_NOTES}\n`;
}

/** Writes both prompts and the rubric into `dir`, the rubric as `dir`/rubric.md, which the prompts point to. */
export function writePrompts({ dir, appUrl, base, notes }) {
  fs.mkdirSync(dir, { recursive: true });
  const rubric = path.join(dir, 'rubric.md');
  fs.writeFileSync(rubric, read('rubric.txt'));
  for (const kind of ['plan', 'test']) {
    fs.writeFileSync(path.join(dir, `${kind}-prompt.md`), promptFor({ kind, appUrl, base, rubric, notes }));
  }
}

const headed = (report, prefix, mark) => report.split('\n')
  .filter((l) => new RegExp(`^## ${prefix}-\\d+:.*${mark ?? ''}\\s*$`, 'u').test(l)).length;

/**
 * The run's verdict from its report's test case headings and the files the plan left. A failed test case fails it;
 * anything that kept the run from a verdict is neutral, so a broken run never reads as a broken pull request. Edge
 * cases are the planner's guesses, not agreed criteria: flagged, never part of the verdict.
 * @param {{report: string|null, skip: string|null, noPlan: string|null, notCovered: string|null}} args
 *   the report, the first lines of SKIP.md and NO_PLAN.md, and why the app could not start; null for what is not there
 * @returns {{conclusion: 'success'|'failure'|'neutral', title: string, status: string, total: number, passed: number,
 *   failed: number, unverified: number, edgeWarnings: number}}
 */
export function verdictOf({ report, skip, noPlan, notCovered }) {
  const text = report ?? '';
  const total = headed(text, 'TC');
  const passed = headed(text, 'TC', '✅');
  const failed = headed(text, 'TC', '❌');
  const edgeWarnings = headed(text, 'EC', '⚠️');
  const unverified = total - passed - failed;
  const counts = { total, passed, failed, unverified, edgeWarnings };
  const notCoveredBy = (status, title) => ({ conclusion: 'neutral', status, title, ...counts });
  let result;
  if (notCovered) result = notCoveredBy(`🔌 **Not covered**: ${notCovered}`, `Not covered: ${notCovered}`);
  else if (skip != null) result = notCoveredBy(`⏭️ **Not covered**: ${skip}`, 'Not covered: nothing to test');
  else if (noPlan != null) result = notCoveredBy(`⚠️ **Not covered**: ${noPlan}`, 'Not covered: no test plan');
  else if (total === 0) result = notCoveredBy('⚠️ **Not covered**: the run ended without a QA report', 'Not covered: no QA report');
  else if (failed > 0) {
    result = { conclusion: 'failure', status: `❌ **Fail**: ${failed} of ${total} test cases failed`,
      title: `Fail: ${failed} of ${total} test cases failed`, ...counts };
  } else if (unverified > 0) {
    result = notCoveredBy(`❓ **Not covered**: ${unverified} of ${total} test cases could not be verified`,
      `Not covered: ${unverified} of ${total} test cases unverified`);
  } else {
    result = { conclusion: 'success', status: `✅ **Pass**: all ${total} test cases passed`,
      title: `Pass: ${total} test cases passed`, ...counts };
  }
  if (edgeWarnings === 1) result.status += ' · ⚠️ 1 edge case to look at';
  if (edgeWarnings > 1) result.status += ` · ⚠️ ${edgeWarnings} edge cases to look at`;
  return result;
}

const firstLine = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[0].trim() : null);

/** The verdict of the run whose files are in `dir`: report.md, and plan/SKIP.md or plan/NO_PLAN.md. */
export function verdictIn({ dir, notCovered }) {
  const reportFile = path.join(dir, 'report.md');
  const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : null;
  return verdictOf({ report, skip: firstLine(path.join(dir, 'plan', 'SKIP.md')),
    noPlan: firstLine(path.join(dir, 'plan', 'NO_PLAN.md')), notCovered: notCovered || null });
}

function main(argv) {
  const [command, dir, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    'app-url': { type: 'string' }, base: { type: 'string' }, notes: { type: 'string' }, 'not-covered': { type: 'string' },
  } });
  if (command === 'prompts' && dir && values['app-url'] && values.base) {
    const notes = values.notes && fs.existsSync(values.notes) ? fs.readFileSync(values.notes, 'utf8') : null;
    writePrompts({ dir, appUrl: values['app-url'], base: values.base, notes });
    return;
  }
  if (command === 'verdict' && dir) {
    process.stdout.write(`${JSON.stringify(verdictIn({ dir, notCovered: values['not-covered'] }))}\n`);
    return;
  }
  throw new Error('usage: qa.mjs prompts <dir> --app-url <url> --base <branch> [--notes <file>] | verdict <dir> [--not-covered <why>]');
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`qa: ${err.message}\n`);
    process.exit(1);
  }
}
