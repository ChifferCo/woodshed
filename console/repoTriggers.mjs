// How each repo's sessions start from GitHub, set on its settings page (Console settings → Repos → Settings): whether
// its label starts one, the label's name, and whether `/woodshed` comments act. Kept in state.json under
// `repoTriggers`, by project name, as each repo's colour and Slack channel are; a repo never set is on, with the
// console's label (`WOODSHED_LABEL`, `woodshed` by default). The poll (fleet.pollProject) and the webhooks
// (webhookDispatch.mjs) both read it, so a change applies to the next label or comment with no restart.

// What GitHub takes as a label's name, kept to what a person types: at most 50 characters, no commas (GitHub's search
// splits on them), no control characters, nothing before or after.
export const LABEL_MAX = 50;

/** @returns {string|null}  why `name` cannot be a label, as the page says it */
export function labelProblem(name) {
  if (typeof name !== 'string' || name.trim() === '') return 'Give the label a name.';
  if (name !== name.trim()) return 'The label cannot start or end with a space.';
  if ([...name].length > LABEL_MAX) return `GitHub takes labels of at most ${LABEL_MAX} characters.`;
  if (name.includes(',')) return 'A label cannot have a comma in it.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A label cannot have a control character in it.';
  return null;
}

/** GitHub matches label names whatever their case, so the console does too. */
export const sameLabel = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * @param {{store: {state: object, save: () => void}, config: {label: string},
 *          qaLabelOf?: (project: string) => Promise<string|null>}} deps
 *   `qaLabelOf` reads the repo's QA label from its project file (`pullRequests.qa.label`), null when it has none or the
 *   file could not be read: a label equal to it is refused, since the fleet tells them apart by name
 * @returns {{of: (project: string|null) => {label: string, labels: boolean, comments: boolean, labelSet: boolean},
 *            set: (args: {project: string, label?: string|null, labels?: boolean, comments?: boolean, by: string}) => Promise<number>,
 *            forget: (project: string) => void}}
 */
export function createRepoTriggers({ store, config, qaLabelOf = async () => null }) {
  const saved = (project) => (project ? store.state.repoTriggers?.[project] : null) ?? {};

  function of(project) {
    const s = saved(project);
    return {
      label: typeof s.label === 'string' && s.label ? s.label : config.label,
      labels: s.labelsOff !== true,
      comments: s.commentsOff !== true,
      labelSet: typeof s.label === 'string' && s.label !== '',
    };
  }

  const refused = (message) => Object.assign(new Error(message), { shown: true, status: 400 });

  /**
   * Checks every change before any is kept. `label` null or '' goes back to the console's.
   * @returns {Promise<number>}  how many changed
   */
  async function set({ project, label, labels, comments, by }) {
    if (typeof project !== 'string' || !project) throw refused('name the repo');
    if (labels !== undefined && typeof labels !== 'boolean') throw refused('labels must be true or false');
    if (comments !== undefined && typeof comments !== 'boolean') throw refused('comments must be true or false');
    const now = of(project);
    let nextLabel;
    if (label !== undefined) {
      // The console's own label is kept as none, so the repo follows WOODSHED_LABEL if it changes.
      nextLabel = label === null || label === '' || label === config.label ? null : label;
      if (nextLabel !== null) {
        const problem = labelProblem(nextLabel);
        if (problem) throw refused(problem);
        let qa = null;
        try {
          qa = await qaLabelOf(project);
        } catch {
          qa = null;
        }
        if (sameLabel(qa, nextLabel)) throw refused(`${nextLabel} is this repo's QA label (its project file's pullRequests.qa.label). Give the session label another name.`);
      }
    }
    const changes = [];
    const next = { ...saved(project) };
    if (label !== undefined && (nextLabel ?? config.label) !== now.label) {
      changes.push({ key: 'label', from: now.label, to: nextLabel ?? config.label });
      if (nextLabel === null) delete next.label;
      else next.label = nextLabel;
    }
    if (labels !== undefined && labels !== now.labels) {
      changes.push({ key: 'labels', from: now.labels, to: labels });
      if (labels) delete next.labelsOff;
      else next.labelsOff = true;
    }
    if (comments !== undefined && comments !== now.comments) {
      changes.push({ key: 'comments', from: now.comments, to: comments });
      if (comments) delete next.commentsOff;
      else next.commentsOff = true;
    }
    const before = JSON.stringify(saved(project));
    if (JSON.stringify(next) === before) return 0;
    const all = { ...store.state.repoTriggers };
    if (Object.keys(next).length) all[project] = next;
    else delete all[project];
    store.state.repoTriggers = all;
    store.save();
    for (const c of changes) console.log('repoTriggers: changed', { project, key: c.key, from: c.from, to: c.to, by });
    return changes.length;
  }

  /** A removed repo's: one added again later starts from the console's defaults. */
  function forget(project) {
    if (!store.state.repoTriggers?.[project]) return;
    const { [project]: _gone, ...rest } = store.state.repoTriggers;
    store.state.repoTriggers = rest;
    store.save();
  }

  return { of, set, forget };
}
