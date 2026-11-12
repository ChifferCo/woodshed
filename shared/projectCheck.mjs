// `node project.mjs check`: the project file read as a session's start reads it, then checked against the checkout it
// is in, so a repo needs no tests of its own against Woodshed's code. Read-only, and offline: files in the checkout,
// and git only to ask what it ignores and tracks. Every problem is named with its field, all of them at once.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { databaseEnv, ENGINES } from './databases/index.mjs';
import { PROJECT_FILE, SINGLE_APP_NAME, readRepoFile } from './project.mjs';
import { envKeys } from './repoSettings.mjs';
import { isSessionVariable, SESSION_PORTS } from './reservedNames.mjs';
import { jobMatches, pullRequestFilters, workflowJobs } from './workflowFile.mjs';

const PLACEHOLDER = /^[A-Z_][A-Z0-9_]*\??$/;
// A `#` comment is dotenv's too (parseProject refuses an empty line).
const ENV_LINE = /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*=|\s*#)/;
const SCRIPT_RUNNERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'ruby']);
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn']);

const exists = (repoDir, file) => fs.existsSync(path.join(repoDir, file));
const isDir = (repoDir, file) => fs.statSync(path.join(repoDir, file), { throwIfNoEntry: false })?.isDirectory() ?? false;
const quoted = (value) => JSON.stringify(value);

// `{{ PGHOST }}` or `{{pgHost}}`: almost a placeholder, which renderLine leaves as it is, so the line keeps the braces.
function nearPlaceholders(text) {
  return [...String(text).matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1]).filter((inner) => !PLACEHOLDER.test(inner) && /^\s*[A-Za-z_][A-Za-z0-9_]*\??\s*$/.test(inner));
}

function placeholderNames(text) {
  return [...String(text).matchAll(/\{\{([A-Z_][A-Z0-9_]*)\??\}\}/g)].map((m) => m[1]);
}

function packageScripts(repoDir, dir) {
  const file = path.join(repoDir, dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {};
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

// What a command runs that the checkout must have: the script a shell or node is given, a path run as a program, and
// a package script. Each part of `a && b; c` alike, up to a `cd`, after which the folder is the command's own.
export function commandProblems(command, { repoDir, dir, field }) {
  const problems = [];
  const inDir = (file) => path.posix.join(dir, file);
  for (const part of command.split(/&&|\|\||[;|]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const [first, ...rest] = words;
    if (!first) continue;
    if (first === 'cd' || first === 'pushd') break;
    if (/['"`$~\\]/.test(first)) continue;
    const plain = (word) => word && !word.startsWith('-') && !/['"`$~\\*?]/.test(word) && !path.isAbsolute(word);
    const script = SCRIPT_RUNNERS.has(first) ? rest[0] : first.includes('/') ? first : null;
    if (plain(script) && (!SCRIPT_RUNNERS.has(first) || /\.\w+$|\//.test(script))) {
      if (leavesRepo(inDir(script))) problems.push(`${field} runs ${inDir(script)}, which is outside the repo`);
      // One git ignores is made by an install or a build (`dist/server.js`, `node_modules/.bin/x`), not committed.
      else if (!exists(repoDir, inDir(script)) && gitStatusOf(repoDir, inDir(script)) !== 'ignored') {
        problems.push(`${field} runs ${inDir(script)}, which is not in the checkout`);
      }
    }
    const run = PACKAGE_RUNNERS.has(first) && (rest[0] === 'run' || rest[0] === 'run-script') ? rest[1] : null;
    if (plain(run)) {
      const scripts = packageScripts(repoDir, dir);
      if (!scripts) problems.push(`${field} runs \`${first} run ${run}\`, and ${inDir('package.json')} is not in the checkout`);
      else if (!Object.hasOwn(scripts, run)) problems.push(`${field} runs \`${first} run ${run}\`, and ${inDir('package.json')} has no ${run} script`);
    }
  }
  return problems;
}

// `../setup.sh` from the root, or `api/../../x`: a path git refuses to answer for (exit 128), and no session has.
function leavesRepo(file) {
  const normal = path.posix.normalize(file);
  return path.posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../');
}

// Whether git ignores or tracks a file: an env file holds its secret's text, so a session must never commit it.
function gitStatusOf(repoDir, file) {
  if (leavesRepo(file)) return 'outside';
  const git = (args) => execFileSync('git', ['-C', repoDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    return 'no git';
  }
  if (git(['ls-files', '--', file]).trim()) return 'tracked';
  try {
    git(['check-ignore', '-q', '--', file]);
    return 'ignored';
  } catch (err) {
    if (err.status === 1) return 'not ignored';
    throw err;
  }
}

function repeated(values) {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

function envProblems(project) {
  const problems = [];
  for (const [name, value] of Object.entries(project.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) problems.push(`env.${name} is not a variable name`);
    else if (isSessionVariable(name)) problems.push(`env.${name} is one of Woodshed's own session variables, which the project cannot set`);
    for (const near of nearPlaceholders(value)) problems.push(`env.${name} has {{${near}}}, which is not a placeholder: write {{NAME}} or {{NAME?}}, in capitals`);
  }
  return problems;
}

function envFileProblems(project, repoDir) {
  const problems = [];
  const files = project.envFiles;
  for (const p of repeated(files.map((f) => f.path))) problems.push(`envFiles has ${p} more than once: one entry a file`);
  files.forEach((file, i) => {
    const at = `envFiles[${i}]`;
    if (file.path.split('/')[0] === '.git' || file.path === PROJECT_FILE) problems.push(`${at}.path is ${file.path}, which a session cannot write over`);
    else if (isDir(repoDir, file.path)) problems.push(`${at}.path is ${file.path}, which is a folder in the checkout`);
    else {
      const status = gitStatusOf(repoDir, file.path);
      if (status === 'tracked') problems.push(`${at}.path ${file.path} is tracked by git: a session would write its secret over it, where a commit takes it`);
      if (status === 'not ignored') problems.push(`${at}.path ${file.path} is not ignored by git (.gitignore): a session could commit its secret`);
    }
    file.defaults.forEach((line, j) => {
      if (!ENV_LINE.test(line)) problems.push(`${at}.defaults[${j}] is not NAME=value: ${quoted(line.slice(0, 40))}`);
    });
    file.lines.forEach((line, j) => {
      if (!ENV_LINE.test(line)) problems.push(`${at}.lines[${j}] is not NAME=value: ${quoted(line.slice(0, 40))}`);
      for (const near of nearPlaceholders(line)) problems.push(`${at}.lines[${j}] has {{${near}}}, which is not a placeholder: write {{NAME}} or {{NAME?}}, in capitals`);
    });
  });
  return problems;
}

const GLOB = /[*?[]/;

function installProblems(project, repoDir) {
  return project.dependencies.installs.flatMap((install, i) => {
    const at = `dependencies.installs[${i}]`;
    if (!isDir(repoDir, install.dir)) return [`${at}.dir is ${install.dir}, which is not a folder in the checkout`];
    const missing = install.files.map((file, j) => [file, j]).filter(([file]) => !GLOB.test(file) && !exists(repoDir, path.join(install.dir, file)));
    return [
      ...missing.map(([file, j]) => `${at}.files[${j}] is ${file}, and ${install.dir}/${file} is not in the checkout`),
      ...commandProblems(install.command, { repoDir, dir: install.dir, field: `${at}.command` }),
    ];
  });
}

function databaseProblems(project, repoDir) {
  return project.databases.flatMap((db, i) => {
    const at = `databases[${i}]`;
    if (!isDir(repoDir, db.dir)) return [`${at}.dir is ${db.dir}, which is not a folder in the checkout`];
    const problems = db.paths.map((p, j) => [p, j]).filter(([p]) => !exists(repoDir, p)).map(([p, j]) => `${at}.paths[${j}] is ${p}, which is not in the checkout`);
    if (db.migrations && !isDir(repoDir, db.migrations)) problems.push(`${at}.migrations is ${db.migrations}, which is not a folder in the checkout`);
    const under = (p) => db.migrations === p || db.migrations.startsWith(`${p.replace(/\/$/, '')}/`);
    if (db.migrations && db.paths.length && !db.paths.some(under)) {
      problems.push(`${at}.migrations is ${db.migrations}, which is under none of its paths: a new migration would not reach the template`);
    }
    for (const name of ['migrate', 'seed']) if (db[name]) problems.push(...commandProblems(db[name], { repoDir, dir: db.dir, field: `${at}.${name}` }));
    return problems;
  });
}

// An `app.paths` entry is a prefix: `web/` is a folder, and `web` also matches `webhooks.md`, so something in the
// checkout must start with it.
function prefixExists(repoDir, prefix) {
  if (exists(repoDir, prefix)) return true;
  const parent = path.posix.dirname(prefix.replace(/\/$/, ''));
  const base = path.posix.basename(prefix);
  try {
    return fs.readdirSync(path.join(repoDir, parent)).some((name) => name.startsWith(base));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

// The field an app's problems name: `app` for the one a project file's `app` gives, `apps[i]` for one of `apps`.
export function appField(project, i) {
  return project.apps.length === 1 && project.apps[0].name === SINGLE_APP_NAME ? 'app' : `apps[${i}]`;
}

function appProblems(project, repoDir) {
  const taken = { ...SESSION_PORTS, ...Object.fromEntries(Object.values(ENGINES).flatMap((e) => e.viewers.map((v) => [v.port, `the ${v.name} viewer (${v.program})`]))) };
  return project.apps.flatMap((app, i) => {
    const at = appField(project, i);
    const problems = [];
    for (const name of ['frontendPort', 'backendPort']) {
      const port = app[name];
      if (port < 1024) problems.push(`${at}.${name} is ${port}: a session runs the app as an unprivileged user, which cannot listen below 1024`);
      if (taken[port]) problems.push(`${at}.${name} is ${port}, which ${taken[port]} listens on in every session`);
    }
    for (const name of ['start', 'stop']) if (app[name]) problems.push(...commandProblems(app[name], { repoDir, dir: '.', field: `${at}.${name}` }));
    app.paths.forEach((p, j) => { if (!prefixExists(repoDir, p)) problems.push(`${at}.paths[${j}] is ${p}, and nothing in the checkout starts with it`); });
    for (const [name, file] of Object.entries(app.logs)) {
      if (!file.startsWith('~/') && (path.isAbsolute(file) || file.split('/').includes('..'))) problems.push(`${at}.logs.${name} must be under the home (~/...) or a path inside the repo`);
    }
    return problems;
  });
}

function workflowText(repoDir, file, field) {
  const read = readRepoFile(repoDir, file);
  if (!read) throw new Error(`${field} is ${file}, which is not in the checkout or on the default branch`);
  return read.text;
}

function pullRequestProblems(project, repoDir) {
  const gates = project.pullRequests;
  if (!gates) return [];
  const problems = [];
  const attempt = (fn) => {
    try {
      fn();
    } catch (err) {
      problems.push(err.message);
    }
  };
  if (gates.review) attempt(() => workflowText(repoDir, gates.review.workflow, 'pullRequests.review.workflow'));
  gates.suites.forEach((suite, i) => attempt(() => {
    const at = `pullRequests.suites[${i}]`;
    const text = workflowText(repoDir, suite.workflow, `${at}.workflow`);
    try {
      pullRequestFilters(text);
    } catch (err) {
      problems.push(`${at}.workflow ${suite.workflow}'s on: section is not read (${err.message}): the console reads its paths-ignore from it`);
    }
    let jobs;
    try {
      jobs = workflowJobs(text);
    } catch (err) {
      throw new Error(`${at}.workflow ${suite.workflow}'s jobs are not read (${err.message})`);
    }
    if (!jobs.some((job) => jobMatches(job, suite.jobs))) {
      const names = jobs.slice(0, 12).map((job) => (job.name ? `${job.id} (${quoted(job.name)})` : job.id)).join(', ');
      problems.push(`${at}.jobs is ${quoted(suite.jobs)}, and no job of ${suite.workflow} has a name starting with it (its jobs: ${names || 'none'})`);
    }
  }));
  return problems;
}

/**
 * Everything the checkout must have for the project file to work, beyond what parseProject reads in the file alone.
 * @returns {string[]}  each problem, naming its field; none when the file is right
 */
export function repoProblems(project, repoDir) {
  if (project.from === 'none') return [];
  const problems = [];
  for (const name of ['rules', 'setup']) {
    if (project[name] && !readRepoFile(repoDir, project[name])) problems.push(`${name} names ${project[name]}, which is not in the checkout or on the default branch`);
  }
  return [
    ...problems, ...envProblems(project), ...envFileProblems(project, repoDir), ...installProblems(project, repoDir),
    ...databaseProblems(project, repoDir), ...appProblems(project, repoDir), ...pullRequestProblems(project, repoDir),
  ];
}

// The variables an install's .npmrc reads (`${NAME}`): each reaches the image build and a session only as an
// install secret of the installation's.
function installVariables(project, repoDir) {
  return project.dependencies.installs.flatMap((install) => install.files.filter((f) => path.basename(f) === '.npmrc' && exists(repoDir, path.join(install.dir, f)))
    .flatMap((f) => [...fs.readFileSync(path.join(repoDir, install.dir, f), 'utf8').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => `${m[1]} in ${install.dir}/${f}`)));
}

// The variables the env and the env files' lines take from the session that neither the project's env nor its
// databases give: the installation's shared services, the app's key, and the like.
function takenFromSession(project) {
  const texts = [...Object.values(project.env), ...project.envFiles.flatMap((f) => f.lines)];
  const given = new Set([...Object.keys(project.env), ...Object.keys(databaseEnv({ project, env: { PGSSLMODE: 'x' } }))]);
  return [...new Set(texts.flatMap(placeholderNames))].filter((name) => !given.has(name) && !isSessionVariable(name));
}

/**
 * The keys each env file's `lines` set with no `{{…}}`: the same in every session, and still the session's, so no
 * installation's or person's value replaces them. Not a problem, since a file may mean "always": a hint, one an env file.
 * @returns {string[]}
 */
export function literalLineHints(project) {
  return project.envFiles.flatMap((file, i) => {
    const keys = envKeys(file.lines.filter((line) => !line.includes('{{')).join('\n'));
    if (!keys.length) return [];
    return [`hint: envFiles[${i}] (${file.path}) lines set ${keys.join(', ')} with no {{…}}: a line with none is the same in every session, so move it to defaults if a person may change it`];
  });
}

// One app as it always read; several by name, the default first.
function appLine({ apps }) {
  if (!apps.length) return 'app: none (no Start app)';
  if (apps.length === 1 && apps[0].name === SINGLE_APP_NAME) return `app: \`${apps[0].start}\`, frontend on ${apps[0].frontendPort}`;
  return `apps: ${apps.length} (${apps.map((a, i) => `${a.name}: \`${a.start}\`, frontend on ${a.frontendPort}${i === 0 ? ', the default' : ''}`).join('; ')})`;
}

// An env file as the summary names it: its path, its secret or the key made from its path, and its defaults.
function envFileLine(file) {
  // The key names its values in Repo settings, whether a `secret` gave it or the path made it.
  return `${file.path} (key ${file.key})${file.defaults.length ? `, ${file.defaults.length} default${file.defaults.length > 1 ? 's' : ''}` : ''}`;
}

/**
 * What a session would take from the project file, one line each, for someone (or their agent) writing one: it
 * throws as a session's start would, and with every problem repoProblems finds in the checkout.
 */
export function checkSummary(project, repoDir) {
  if (project.from === 'none') return [`no ${PROJECT_FILE}: sessions get no installs, databases or app (project.reference.yaml has every field)`];
  const label = project.from === 'installation' ? "the installation's project file" : PROJECT_FILE;
  const problems = repoProblems(project, repoDir);
  if (problems.length) throw new Error(problems.map((p) => `${label}: ${p}`).join('\n'));
  const list = (items) => (items.length ? `${items.length} (${items.join(', ')})` : 'none');
  const { pullRequests: gates } = project;
  return [
    `${PROJECT_FILE}: read from the ${project.from}`,
    `installs: ${list(project.dependencies.installs.map((i) => i.dir))}`,
    `install variables: ${list(installVariables(project, repoDir))}`,
    `databases: ${list(project.databases.map((d) => d.engine))}`,
    `env files: ${list(project.envFiles.map(envFileLine))}`,
    `from the session: ${list(takenFromSession(project))}`,
    appLine(project),
    `pull requests: ${gates ? `review ${gates.review ? gates.review.workflow : 'none'}, suites ${list(gates.suites.map((s) => `${s.name} in ${s.workflow}`))}` : 'none'}`,
    `rules: ${project.rules ?? 'none'}, setup: ${project.setup ?? 'none'}`,
    ...literalLineHints(project),
  ];
}
