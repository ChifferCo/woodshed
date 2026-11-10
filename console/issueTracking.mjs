// Keeps a GitHub issue in step with the shared session working on it (fleet.mjs): the session's assignee is on the
// issue, and the issue's project cards say In progress once a session starts on it. Both go with the console's App
// token, which needs Issues write and the org's Projects write; without them the console logs the refusal and the
// session runs as before.

const IN_PROGRESS = /^in progress$/i;

/**
 * @param {object[]} items  an issue's project items, as `issueProjectItems` answers
 * @returns {{moves: {projectId: string, itemId: string, fieldId: string, optionId: string, project: string}[],
 *            skipped: {project: string, why: string}[]}}  the cards to move to In progress, and why the rest stay
 */
export function inProgressMoves(items) {
  const moves = [];
  const skipped = [];
  for (const item of items ?? []) {
    const project = item?.project?.title ?? '?';
    const field = item?.project?.field;
    const option = field?.options?.find((o) => IN_PROGRESS.test(String(o?.name ?? '').trim()));
    if (!field?.id || !option) skipped.push({ project, why: 'no In progress status' });
    else if (IN_PROGRESS.test(String(item.status?.name ?? '').trim())) skipped.push({ project, why: 'already in progress' });
    else moves.push({ projectId: item.project.id, itemId: item.id, fieldId: field.id, optionId: option.id, project });
  }
  return { moves, skipped };
}

/**
 * @param {{github: {issueProjectItems: (number: number) => Promise<object[]>,
 *                   setProjectStatus: (move: object) => Promise<void>,
 *                   issue: (number: number) => Promise<object>,
 *                   addAssignees: (number: number, logins: string[]) => Promise<void>,
 *                   removeAssignees: (number: number, logins: string[]) => Promise<void>}}} deps
 */
export function createIssueTracking({ github }) {
  /** @returns {Promise<number>}  how many cards moved */
  async function markInProgress(number) {
    const { moves, skipped } = inProgressMoves(await github.issueProjectItems(number));
    for (const move of moves) await github.setProjectStatus(move);
    console.log('issueTracking: issue marked in progress', { number, moved: moves.map((m) => m.project), skipped });
    return moves.length;
  }

  /**
   * Puts `to` on the issue, and takes off `added`: the person the console itself put there before. Someone assigned
   * on GitHub by hand stays.
   * @param {{number: number, to: string|null, added: string|null}} args
   * @returns {Promise<string|null>}  who the console has put on the issue now, to take off at the next change
   */
  async function syncAssignee({ number, to, added }) {
    if (added && (!to || added.toLowerCase() !== to.toLowerCase())) {
      await github.removeAssignees(number, [added]);
      console.log('issueTracking: assignee taken off the issue', { number, login: added });
    }
    if (!to) return null;
    if (added && added.toLowerCase() === to.toLowerCase()) return added;
    const issue = await github.issue(number);
    if ((issue?.assignees ?? []).some((a) => String(a?.login ?? '').toLowerCase() === to.toLowerCase())) {
      console.log('issueTracking: assignee already on the issue', { number, login: to });
      return null;
    }
    await github.addAssignees(number, [to]);
    console.log('issueTracking: assignee put on the issue', { number, login: to });
    return to;
  }

  return { markInProgress, syncAssignee };
}
