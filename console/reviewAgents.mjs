// The Reviews card on Console settings: which agents review a pull request in a review session
// (pullRequests.review.runner: woodshed). Claude Code alone, or Claude Code and Codex together, whose verdicts become one
// (shared/codeReview/codeReview.mjs, mergeVerdicts). Codex runs on the pull request author's own Codex sign-in when
// they turned that on for reviews on My settings (userSettings.mjs, ownCodexForReviews), and on the team's OpenAI key
// otherwise. Either way the console's proxy adds it (openaiProxy.mjs), so no sign-in enters the review session. A review
// with neither runs on Claude Code alone.
import { credentialOf } from './codexModels.mjs';
// Kept in state.json under `reviewAgents`, so it survives a restart.

export const CHOICES = ['claude', 'both'];

/**
 * @param {{store: {state: object, save: () => void},
 *          connected: () => Promise<{claude: boolean, codex: boolean}>,
 *          userSettings?: {usesOwnCodexForReviews: (login: string) => boolean, codexAuth: (login: string) => Promise<string|null>}|null,
 *          now?: () => number}} deps
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
   * The agents a review of `login`'s pull request runs, starting now: `codexLogin` when Codex runs on that person's own
   * sign-in, `codexVia` how the session's codex reaches it (`chatgpt` for a ChatGPT login, `key` for an API key, the
   * author's or the team's) with `codexAccount` for a ChatGPT login, and why when Codex was asked for and is left out, or its author's sign-in was not used.
   * @param {{login?: string|null}} [args]  the pull request's author, or null when nobody's own sign-in may be used
   * @returns {Promise<{agents: string[], codexLogin: string|null, codexVia: 'chatgpt'|'key'|null, why: string|null}>}
   */
  async function forReview({ login = null } = {}) {
    const claudeAlone = (why) => ({ agents: ['claude'], codexLogin: null, codexVia: null, why });
    if (choice() !== 'both') return claudeAlone(null);
    let ownWhy = null;
    if (login && userSettings?.usesOwnCodexForReviews(login)) {
      let cred = null;
      try {
        cred = credentialOf(await userSettings.codexAuth(login), now());
      } catch (err) {
        ownWhy = `the author's Codex sign-in could not be read: ${String(err?.message ?? err).split('\n')[0]}`;
      }
      if (cred && !cred.expired) {
        // A ChatGPT login's account, an id and no credential: the session's stand-in login names it, as codex checks.
        const account = cred.apiKey ? null : cred.headers['chatgpt-account-id'] ?? null;
        return { agents: ['claude', 'codex'], codexLogin: login, codexVia: cred.apiKey ? 'key' : 'chatgpt', ...(account ? { codexAccount: account } : {}), why: null };
      }
      ownWhy ??= cred?.expired ? 'the author\'s saved Codex sign-in has expired' : 'the author\'s saved Codex sign-in has no access token';
    }
    let codex = false;
    try {
      ({ codex } = await connected());
    } catch (err) {
      return claudeAlone(`the OpenAI key could not be read: ${String(err?.message ?? err).split('\n')[0]}`);
    }
    if (codex) return { agents: ['claude', 'codex'], codexLogin: null, codexVia: 'key', why: ownWhy };
    return claudeAlone(ownWhy ? `${ownWhy}, and the console has no OpenAI key`
      : 'the author uses no Codex sign-in of their own for reviews, and the console has no OpenAI key');
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
