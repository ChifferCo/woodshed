// The Reviews card on Console settings: which agents review a pull request in a review session
// (pullRequests.review.runner: woodshed). Claude Code alone, or Claude Code and Codex together, whose verdicts become one
// (shared/codeReview/codeReview.mjs, mergeVerdicts). Codex runs on the pull request author's own Codex sign-in when
// they turned that on for reviews on My settings (userSettings.mjs, ownCodexForReviews), and on the team's OpenAI key,
// through the console's proxy (openaiProxy.mjs), otherwise. A review with neither runs on Claude Code alone.
// Kept in state.json under `reviewAgents`, so it survives a restart.

export const CHOICES = ['claude', 'both'];

/**
 * @param {{store: {state: object, save: () => void},
 *          connected: () => Promise<{claude: boolean, codex: boolean}>,
 *          userSettings?: {usesOwnCodexForReviews: (login: string) => boolean}|null, now?: () => number}} deps
 *   `connected` says whether the console reaches each on its team keys: Anthropic's and OpenAI's
 */
export function createReviewAgents({ store, connected, userSettings = null, now = Date.now }) {
  const saved = () => store.state.reviewAgents ?? {};
  const choice = () => (CHOICES.includes(saved().agents) ? saved().agents : 'claude');

  /** @returns {boolean}  whether it changed */
  function set({ agents, by }) {
    if (!CHOICES.includes(agents)) throw Object.assign(new Error(`agents must be ${CHOICES.join(' or ')}`), { shown: true, status: 400 });
    if (choice() === agents) return false;
    store.state.reviewAgents = { agents, by, at: new Date(now()).toISOString() };
    store.save();
    console.log('reviewAgents: changed', { agents, by });
    return true;
  }

  /**
   * The agents a review of `login`'s pull request runs, starting now; `codexLogin` when Codex runs on that person's own
   * sign-in, and why when Codex was asked for and is left out.
   * @param {{login?: string|null}} [args]  the pull request's author, or null when nobody's own sign-in may be used
   * @returns {Promise<{agents: string[], codexLogin: string|null, why: string|null}>}
   */
  async function forReview({ login = null } = {}) {
    if (choice() !== 'both') return { agents: ['claude'], codexLogin: null, why: null };
    if (login && userSettings?.usesOwnCodexForReviews(login)) return { agents: ['claude', 'codex'], codexLogin: login, why: null };
    let codex = false;
    try {
      ({ codex } = await connected());
    } catch (err) {
      return { agents: ['claude'], codexLogin: null, why: `the OpenAI key could not be read: ${String(err?.message ?? err).split('\n')[0]}` };
    }
    return codex
      ? { agents: ['claude', 'codex'], codexLogin: null, why: null }
      : { agents: ['claude'], codexLogin: null, why: 'the author uses no Codex sign-in of their own for reviews, and the console has no OpenAI key' };
  }

  async function view() {
    let state = { claude: false, codex: false };
    try {
      state = await connected();
    } catch (err) {
      console.warn('reviewAgents: connections not read', { message: String(err?.message ?? err).split('\n')[0] });
    }
    return { agents: choice(), by: saved().by ?? null, at: saved().at ?? null, connected: state };
  }

  return { set, forReview, view, choice };
}
