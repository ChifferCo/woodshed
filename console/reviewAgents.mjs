// Who reviews a pull request in a review session (pullRequests.review.runner: woodshed), as its author chose on My
// settings' Reviews card: no review, Claude Code, Codex, or both, whose verdicts become one
// (shared/codeReview/codeReview.mjs, mergeVerdicts). A choice is offered only while something can run it:
//
//   Claude Code   the team's anthropic-api-key, or the author's own Claude token while they run shared sessions on it
//   Codex         the team's openai-api-key, or the author's own Codex sign-in while they use it for reviews
//
// With no choice saved, a review runs the most it can: both, else the one there is, else none. A saved choice that can
// no longer run (a key removed since) falls back the same way, and says why. Either way the console's proxies add the
// credential to each call (anthropicProxy.mjs, openaiProxy.mjs): no sign-in enters the review session.
// The choice itself is kept with the person's settings (userSettings.mjs, reviewAgents).
import { credentialOf } from './codexModels.mjs';

export const CHOICES = ['none', 'claude', 'codex', 'both'];
const AGENTS_OF = { none: [], claude: ['claude'], codex: ['codex'], both: ['claude', 'codex'] };

/** The most a review can run with these: both, else the one there is, else none. */
export function bestChoice({ claude, codex }) {
  if (claude && codex) return 'both';
  if (claude) return 'claude';
  return codex ? 'codex' : 'none';
}

/**
 * @param {{connected: () => Promise<{claude: boolean, codex: boolean}>,
 *          userSettings?: {reviewAgents: (login: string) => string|null, usesOwnTokenForShared: (login: string) => boolean,
 *            usesOwnCodexForReviews: (login: string) => boolean, codexAuth: (login: string) => Promise<string|null>}|null,
 *          now?: () => number}} deps
 *   `connected` says whether the console has each team key: Anthropic's and OpenAI's
 */
export function createReviewAgents({ connected, userSettings = null, now = Date.now }) {
  async function teamKeys() {
    try {
      return { ...(await connected()), why: null };
    } catch (err) {
      return { claude: false, codex: false, why: `the team keys could not be read: ${String(err?.message ?? err).split('\n')[0]}` };
    }
  }

  // The author's own Codex sign-in, when they use it for reviews and it can still be used: how codex reaches it.
  async function ownCodex(login) {
    if (!login || !userSettings?.usesOwnCodexForReviews(login)) return { cred: null, why: null };
    try {
      const cred = credentialOf(await userSettings.codexAuth(login), now());
      if (!cred) return { cred: null, why: 'the author\'s saved Codex sign-in has no access token' };
      if (cred.expired) return { cred: null, why: 'the author\'s saved Codex sign-in has expired' };
      return { cred, why: null };
    } catch (err) {
      return { cred: null, unread: true, why: `the author's Codex sign-in could not be read: ${String(err?.message ?? err).split('\n')[0]}` };
    }
  }

  /**
   * What `login` may choose from, and what they get with no choice saved.
   * @param {string|null} login  null for nobody's own sign-ins: team keys only
   */
  async function options(login) {
    const team = await teamKeys();
    const own = { claude: Boolean(login && userSettings?.usesOwnTokenForShared(login)), codex: Boolean((await ownCodex(login)).cred) };
    const available = { claude: team.claude || own.claude, codex: team.codex || own.codex };
    return { available, own, best: bestChoice(available) };
  }

  /**
   * The agents a review of `login`'s pull request runs, starting now. `codexLogin` when Codex runs on that person's own
   * sign-in, `codexVia` how the session's codex reaches its credential (`chatgpt` for a ChatGPT login, `key` for an API
   * key, the author's or the team's) with `codexAccount` for a ChatGPT login, `choice` what they chose (null for none
   * saved), `why` when what runs is not what they chose, or not on their own sign-in, and `keysUnread` when the team
   * keys or the author's own Codex sign-in could not be read: then what runs is a guess, and no review is not a choice
   * anyone made.
   * @param {{login?: string|null}} [args]  the pull request's author, or null when nobody's own sign-in may be used
   * @returns {Promise<{agents: string[], choice: string|null, codexLogin: string|null, codexVia: 'chatgpt'|'key'|null,
   *   codexAccount?: string, why: string|null, keysUnread: boolean}>}
   */
  async function forReview({ login = null } = {}) {
    const team = await teamKeys();
    const codexOwn = await ownCodex(login);
    const claudeOwn = Boolean(login && userSettings?.usesOwnTokenForShared(login));
    const available = { claude: team.claude || claudeOwn, codex: team.codex || Boolean(codexOwn.cred) };
    const saved = login ? userSettings?.reviewAgents?.(login) ?? null : null;
    const choice = CHOICES.includes(saved) ? saved : null;
    const why = [];
    let agents = AGENTS_OF[choice ?? bestChoice(available)];
    if (choice && agents.some((a) => !available[a])) {
      const left = agents.filter((a) => available[a]);
      agents = left.length ? left : AGENTS_OF[bestChoice(available)];
      why.push(`the author chose ${choice}, which this console cannot run now`);
    }
    if (team.why) why.push(team.why);
    let codex = { codexLogin: null, codexVia: null };
    if (agents.includes('codex')) {
      if (codexOwn.cred) {
        const account = codexOwn.cred.apiKey ? null : codexOwn.cred.headers['chatgpt-account-id'] ?? null;
        codex = { codexLogin: login, codexVia: codexOwn.cred.apiKey ? 'key' : 'chatgpt', ...(account ? { codexAccount: account } : {}) };
      } else {
        codex = { codexLogin: null, codexVia: 'key' };
        if (codexOwn.why) why.push(codexOwn.why);
      }
    }
    // An own sign-in that could not be read counts as unread too, whether or not Codex was left out for it.
    if (codexOwn.unread && !why.includes(codexOwn.why)) why.push(codexOwn.why);
    return { agents, choice, ...codex, why: why.length ? why.join('; ') : null, keysUnread: Boolean(team.why || codexOwn.unread) };
  }

  return { forReview, options };
}
