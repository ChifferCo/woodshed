// What the console and the project file's check read from a GitHub Actions workflow file. A whole workflow
// (expressions, long scripts) is more YAML than yamlLite reads, so each reader takes only the part it needs.

import { parseYaml } from './yamlLite.mjs';

/**
 * The `on:` section of a workflow file, read on its own: the rest of a workflow (expressions, long scripts) is more
 * YAML than yamlLite reads, and the path filters are all that is needed.
 * @returns {{pathsIgnore: string[]|null, paths: string[]|null}}
 * @throws {Error}  when the section is not there or is not read as YAML
 */
export function pullRequestFilters(workflowText) {
  const lines = String(workflowText).replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^(?:on|'on'|"on")\s*:/.test(l));
  if (at < 0) throw new Error('the workflow has no on: section');
  const end = lines.findIndex((l, i) => i > at && /^[^\s#]/.test(l));
  const on = Object.values(parseYaml(lines.slice(at, end < 0 ? undefined : end).join('\n')) ?? {})[0];
  const pullRequest = on && typeof on === 'object' && !Array.isArray(on) ? on.pull_request : null;
  const list = (value) => (Array.isArray(value) ? value.map(String) : null);
  return { pathsIgnore: list(pullRequest?.['paths-ignore']), paths: list(pullRequest?.paths) };
}

const indentOf = (line) => line.length - line.trimStart().length;
const meaningful = (line) => Boolean(line.trim()) && !line.trim().startsWith('#');

// A one-line value as YAML reads it, and as written when yamlLite refuses it (an expression with `: ` in it, say).
function scalar(text) {
  try {
    const value = parseYaml(`v: ${text}`)?.v;
    return value === null || value === undefined ? null : String(value);
  } catch {
    return text.replace(/\s+#.*$/, '').trim();
  }
}

/**
 * The jobs of a workflow file, read line by line: each job's id, and its `name` and `uses` when it has them.
 * @returns {{id: string, name: string|null, uses: string|null}[]}
 * @throws {Error}  when the file has no jobs: section
 */
export function workflowJobs(workflowText) {
  const lines = String(workflowText).replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^(?:jobs|'jobs'|"jobs")\s*:/.test(l));
  if (at < 0) throw new Error('the workflow has no jobs: section');
  const body = lines.slice(at + 1);
  const end = body.findIndex((l) => /^[^\s#]/.test(l));
  const section = (end < 0 ? body : body.slice(0, end)).filter(meaningful);
  if (!section.length) return [];
  const jobIndent = indentOf(section[0]);
  const jobs = [];
  let job = null;
  let childIndent = null;
  for (const line of section) {
    const indent = indentOf(line);
    if (indent === jobIndent) {
      const id = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(?:#.*)?$/.exec(line);
      if (!id) throw new Error(`the jobs: section has ${line.trim()}, which is not a job`);
      job = { id: id[1] ?? id[2] ?? id[3], name: null, uses: null };
      jobs.push(job);
      childIndent = null;
    } else if (job && indent > jobIndent) {
      childIndent ??= indent;
      const key = indent === childIndent && /^\s*(name|uses)\s*:\s*(.*)$/.exec(line);
      if (key) job[key[1]] = scalar(key[2]);
    }
  }
  return jobs;
}

/**
 * Whether a job's check runs have names starting with `prefix`, as the console's suites match them (pullGates.mjs).
 * A check run is named for the job's `name`, or its id without one; a matrix's add ` (<values>)`, and a called
 * workflow's jobs ` / <their name>`. A name with an expression counts by its text before the expression, or by a
 * name quoted in it, since what the expression makes cannot be told here (and a skipped matrix's one run keeps it whole).
 * @param {{id: string, name: string|null}} job
 */
export function jobMatches(job, prefix) {
  const name = job.name ?? job.id;
  const literal = name.split('${{')[0];
  if (literal.startsWith(prefix)) return true;
  if (name.includes('${{')) {
    if (literal.trim() && prefix.startsWith(literal)) return true;
    // A quoted name in the expression, up to a format()'s first `{0}`: `'E2E ({0}/2)'` names runs `E2E (1/2)`.
    const quotedNames = [...name.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'").split('{')[0]).filter((q) => q.trim());
    if (quotedNames.some((q) => q.startsWith(prefix) || prefix.startsWith(q))) return true;
  }
  return prefix.startsWith(`${name} (`) || prefix.startsWith(`${name} / `);
}
