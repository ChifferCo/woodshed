// The merge risk and QA a pull request carries, read back from GitHub for the AI reviews tab: the `Merge risk` check
// the review posts on the commit it reviewed (console/fleet.mjs, submitReview; the Actions review's the same), with its
// `merge risk: <tier>` label, and the QA check a QA run posts (fleet.mjs qaFinished, .github/actions/qa/report). Their
// names are the project file's `pullRequests.mergeRisk.check` and `pullRequests.qa.check` on the default branch, as the
// console reads them; `Merge risk` and `QA` when it names none.
//
// Nothing here is new data, and nothing is a gate: the page shows what GitHub has, and the decision brief stays the
// console's. Pure: GraphQL nodes in, plain objects out.

import { parseProject } from '../project.mjs';
import { parseYaml } from '../yamlLite.mjs';

export const DEFAULT_NAMES = Object.freeze({ mergeRisk: 'Merge risk', qa: 'QA' });
const TIERS = ['Low', 'Medium', 'High'];
const TIER_RE = /^(Low|Medium|High)\b[ \t]*:?[ \t]*/i;
const LABEL_RE = /^merge risk:[ \t]*(low|medium|high)$/i;

/**
 * The check names a project file's text gives, and whether it asks for each at all. A file that does not read, or none,
 * gives the defaults with neither asked for: the page then shows a check only when GitHub has one.
 *
 * @param {string|null} text  `.woodshed/project.yaml` on the default branch
 * @returns {{mergeRisk: string, qa: string, asks: {mergeRisk: boolean, qa: boolean}}}
 */
export function checkNamesOf(text) {
  let gates = null;
  try {
    gates = text ? parseProject(parseYaml(text)).pullRequests : null;
  } catch {
    gates = null;
  }
  return {
    mergeRisk: gates?.mergeRisk?.check || DEFAULT_NAMES.mergeRisk,
    qa: gates?.qa?.check || DEFAULT_NAMES.qa,
    asks: { mergeRisk: Boolean(gates?.mergeRisk), qa: Boolean(gates?.qa) },
  };
}

/** The check runs on a commit, flat: GraphQL's `checkSuites { app, checkRuns }`. */
export function checkRunsOf(commit) {
  const runs = [];
  for (const suite of commit?.checkSuites?.nodes || []) {
    for (const run of suite?.checkRuns?.nodes || []) {
      if (run?.name) runs.push({ ...run, app: suite.app?.slug || suite.app?.name || null });
    }
  }
  return runs;
}

// The newest run of that name: a later run (a QA run again, a review of a pushed commit) replaces the one before.
function newest(runs, name) {
  const named = runs.filter((r) => r.name === name);
  named.sort((a, b) => String(b.completedAt || b.startedAt || '').localeCompare(String(a.completedAt || a.startedAt || '')));
  return named[0] || null;
}

function shape(run, headSha) {
  return {
    name: run.name,
    status: String(run.status || '').toLowerCase() || null,
    conclusion: run.conclusion ? String(run.conclusion).toLowerCase() : null,
    title: String(run.title || '').trim(),
    summary: String(run.summary || '').trim(),
    url: run.permalink || run.detailsUrl || null,
    app: run.app || null,
    at: run.completedAt || run.startedAt || null,
    commit: headSha,
    current: true,
  };
}

/**
 * The merge risk and QA on the pull request's head commit, for the AI reviews tab. Merge risk is the check's tier and
 * reason (its title, `High: touches the billing path`), else the `merge risk: <tier>` label, which stays on the pull
 * request after a push the review has not read yet, so it is said to be of an older commit. Null for one neither found
 * nor asked for by the project file; `{missing: true}` for one asked for and not found on the head commit.
 *
 * @param {{runs: object[], labels: string[], headSha: string|null, names: ReturnType<typeof checkNamesOf>}} read
 */
export function prChecksOf({ runs = [], labels = [], headSha = null, names = checkNamesOf(null) }) {
  let mergeRisk = null;
  const risk = newest(runs, names.mergeRisk);
  if (risk) {
    const c = shape(risk, headSha);
    const m = TIER_RE.exec(c.title);
    const tier = m ? TIERS.find((t) => t.toLowerCase() === m[1].toLowerCase()) : null;
    mergeRisk = { ...c, tier, reason: m ? c.title.slice(m[0].length).trim() : c.title, fromLabel: false };
  } else {
    const label = labels.map((l) => LABEL_RE.exec(String(l).trim())).find(Boolean);
    if (label) {
      const tier = TIERS.find((t) => t.toLowerCase() === label[1].toLowerCase());
      mergeRisk = {
        name: names.mergeRisk, status: 'completed', conclusion: null, title: '', summary: '', url: null, app: null, at: null,
        commit: null, current: false, tier, reason: '', fromLabel: true,
      };
    } else if (names.asks.mergeRisk) {
      mergeRisk = { name: names.mergeRisk, missing: true };
    }
  }
  let qa = null;
  const q = newest(runs, names.qa);
  if (q) qa = shape(q, headSha);
  else if (names.asks.qa) qa = { name: names.qa, missing: true };
  return { mergeRisk, qa };
}
