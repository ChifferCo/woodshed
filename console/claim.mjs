// Which console runs a session a GitHub event starts, when a repo is connected to more than one (Woodshed Internal and a
// Woodshed Cloud org, say): each reacts 👀 on the issue or pull request, and the earliest bot 👀 owns its automatic
// work, then and on every later event. Consoles that share one App login (two Woodshed Cloud orgs) cannot tell their
// reactions apart, so this does not separate them.

/** @returns {string|null}  the login of the earliest 👀 a bot left, which owns the work */
export function claimOwner(reactions) {
  const bots = (reactions ?? []).filter((r) => r.content === 'eyes' && r.user?.type === 'Bot');
  bots.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  return bots[0]?.user?.login ?? null;
}

/**
 * @param {{gh: object, number: number, login: string|null, authoredByUs?: boolean, waitMs: number,
 *          wait: (ms: number) => Promise<void>}} args
 *   login  this console's App login; without one there is nothing to claim with, and it goes ahead as before
 *   authoredByUs  the pull request was opened by this console's App, so it is this console's without a race
 *   waitMs  how long after reacting the others' reactions are read, so a console reacting at the same moment is seen
 * @returns {Promise<{claimed: boolean, owner: string|null, reason: string}>}
 */
export async function claimEvent({ gh, number, login, authoredByUs = false, waitMs, wait }) {
  if (!login) return { claimed: true, owner: null, reason: 'no App login to claim with' };
  if (authoredByUs) {
    await gh.reactToIssue(number);
    return { claimed: true, owner: login, reason: 'opened by this console\'s App' };
  }
  let owner = claimOwner(await gh.issueReactions(number));
  if (!owner) {
    await gh.reactToIssue(number);
    await wait(waitMs);
    owner = claimOwner(await gh.issueReactions(number));
  }
  return { claimed: owner === login, owner, reason: owner === login ? 'the earliest 👀' : 'another console\'s 👀 came first' };
}
