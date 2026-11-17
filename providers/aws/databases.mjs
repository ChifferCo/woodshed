// The project file's databases (docs/reference.md, "Databases") against the engines the installation's tfvars
// `databases` pays for: RDS, Mongo on the base box and the db-admin task exist only for the engines it names, so it
// stays the installation's choice, and a project-file change never plans to make or destroy one. What this adds is
// the disagreement caught before the plan, not at a session's start (console/databaseGate.mjs):
//
//   node woodshed/providers/aws/databases.mjs check --tfvars <the installation's terraform.tfvars>
//
// run in the deploy workflow's plan job, on its checkout of the default branch (providers/aws/README.md, "The deploy
// workflow"). It exits 1 when the project file needs an engine the tfvars leaves out, and only warns, on stderr, when
// the tfvars hosts one the file does not use: another project's file may, and an engine dropped is an apply that
// destroys its data, which is for the installation to decide.
import fs from 'node:fs';

import { ENGINE_NAMES, projectEngines } from '../../shared/databases/index.mjs';
import { isMain } from '../../shared/isMain.mjs';
import { loadProject } from '../../shared/project.mjs';

function fail(message) {
  throw new Error(`databases: ${message}`);
}

/**
 * The `databases` a tfvars file sets: one assignment of a list of quoted engine names, on one line or several. Anything
 * else (a variable, a function, no assignment) is refused rather than read wrong.
 * @param {string} text  the tfvars file's
 * @returns {string[]}
 */
export function tfvarsDatabases(text) {
  // Comments first, so a commented-out assignment or a `#` inside the list is not read as one.
  const code = text.replace(/("(?:[^"\\]|\\.)*")|#[^\n]*|\/\/[^\n]*|\/\*[^]*?\*\//g, (m, quoted) => quoted ?? '');
  const found = [...code.matchAll(/^[ \t]*databases[ \t]*=[ \t]*([^\n]*)/gm)];
  if (found.length !== 1) fail(found.length ? 'the tfvars sets databases more than once' : 'the tfvars does not set databases, which has no default: set it, such as databases = ["postgres"], or [] for none');
  const list = /^\[([^\]]*)\]/.exec(code.slice(found[0].index + found[0][0].indexOf('=') + 1).trimStart());
  if (!list) fail('the tfvars\' databases is not a list of engines, such as ["postgres", "mongo"]');
  const items = list[1].split(',').map((s) => s.trim()).filter(Boolean);
  const names = items.map((item) => /^"([a-z]+)"$/.exec(item)?.[1]);
  if (names.some((n) => !n)) fail(`the tfvars' databases has ${items.filter((_, i) => !names[i]).join(', ')}, which is not an engine's name in quotes`);
  const unknown = names.filter((n) => !ENGINE_NAMES.includes(n));
  if (unknown.length) fail(`the tfvars' databases has ${unknown.join(', ')}, which is not an engine (${ENGINE_NAMES.join(' or ')})`);
  return names;
}

/**
 * @param {{databases: {engine: string}[]}} project  loadProject()'s
 * @param {string[]} hosted  the tfvars' databases
 * @returns {{problems: string[], warnings: string[]}}  `problems` stop the deploy; `warnings` do not
 */
export function databasesCheck(project, hosted) {
  const needed = projectEngines(project);
  const missing = needed.filter((name) => !hosted.includes(name));
  const unused = hosted.filter((name) => !needed.includes(name));
  const has = hosted.length ? `hosts ${hosted.join(' and ')}` : 'hosts none';
  // The tfvars' list with what is missing added, in the engines' own order, as the tfvars writes it.
  const wanted = `[${ENGINE_NAMES.filter((n) => hosted.includes(n) || missing.includes(n)).map((n) => `"${n}"`).join(', ')}]`;
  return {
    problems: missing.length
      ? [`the project file's databases need ${missing.join(' and ')}, and the tfvars' databases ${has}: set databases = ${wanted} in the tfvars${missing.includes('postgres') ? ' (with database_name and database_user, which postgres needs)' : ''}, or take ${missing.length === 1 ? 'it' : 'them'} out of the project file`]
      : [],
    warnings: unused.length
      ? [`the tfvars' databases hosts ${unused.join(' and ')}, which this project file does not use: leave ${unused.length === 1 ? 'it' : 'them'} if another project's file does, or take ${unused.length === 1 ? 'it' : 'them'} out of the tfvars, which destroys ${unused.length === 1 ? 'its' : 'their'} data at the apply`]
      : [],
  };
}

function main([command, ...rest]) {
  if (command !== 'check') fail(`unknown command: ${command} (expected check)`);
  if (rest.length !== 2 || rest[0] !== '--tfvars') fail('check takes --tfvars <the installation\'s terraform.tfvars>');
  let text;
  try {
    text = fs.readFileSync(rest[1], 'utf8');
  } catch (err) {
    fail(`${rest[1]} could not be read (${err.code ?? err.message})`);
  }
  const { problems, warnings } = databasesCheck(loadProject(process.env.REPO_DIR || process.cwd()), tfvarsDatabases(text));
  for (const w of warnings) process.stderr.write(`databases: warning: ${w}\n`);
  if (problems.length) fail(problems.join('\n'));
  process.stdout.write('databases: the tfvars hosts every engine the project file\'s databases need\n');
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
