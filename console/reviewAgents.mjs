// The Reviews card on Console settings: which agents review a pull request in a review session
// (pullRequests.review.runner: woodshed). Claude Code alone, or Claude Code and Codex together, whose verdicts become one
// (shared/codeReview/codeReview.mjs, mergeVerdicts). Codex runs on the team's OpenAI key, through the console's proxy
// (openaiProxy.mjs), never on anyone's own sign-in, since a review session is a shared one. So both are offered only
// while the console has a way to Claude and an OpenAI key, and a review started without the key runs on Claude alone.
// Kept in state.json under `reviewAgents`, so it survives a restart.

export const CHOICES = ['claude', 'both'];

/**
 * @param {{store: {state: object, save: () => void},
 *          connected: () => Promise<{claude: boolean, codex: boolean}>, now?: () => number}} deps
 *   `connected` says whether the console reaches each: Claude by its team Anthropic key (or a Claude plan the review
 *   runs on), Codex by its team OpenAI key
 */
export function createReviewAgents({ store, connected, now = Date.now }) {
  const saved = () => store.state.reviewAgents ?? {};
  const choice = () => (CHOICES.includes(saved().agents) ? saved().agents : 'claude');

  /** @returns {boolean}  whether it changed */
  async function set({ agents, by }) {
    if (!CHOICES.includes(agents)) throw Object.assign(new Error(`agents must be ${CHOICES.join(' or ')}`), { shown: true, status: 400 });
    if (choice() === agents) return false;
    if (agents === 'both') {
      const { claude, codex } = await connected();
      if (!claude || !codex) {
        throw Object.assign(new Error(`Codex can review beside Claude Code only while both are connected: ${[!claude && 'set anthropic-api-key', !codex && 'set openai-api-key'].filter(Boolean).join(' and ')} on Secrets & webhooks first.`), { shown: true, status: 409 });
      }
    }
    store.state.reviewAgents = { agents, by, at: new Date(now()).toISOString() };
    store.save();
    console.log('reviewAgents: changed', { agents, by });
    return true;
  }

  /**
   * The agents a review starting now runs, and why when Codex was asked for and is left out.
   * @returns {Promise<{agents: string[], why: string|null}>}
   */
  async function forReview() {
    if (choice() !== 'both') return { agents: ['claude'], why: null };
    let codex = false;
    try {
      ({ codex } = await connected());
    } catch (err) {
      return { agents: ['claude'], why: `the OpenAI key could not be read: ${String(err?.message ?? err).split('\n')[0]}` };
    }
    return codex ? { agents: ['claude', 'codex'], why: null } : { agents: ['claude'], why: 'the console has no OpenAI key' };
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
