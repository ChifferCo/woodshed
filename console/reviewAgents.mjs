// Who reviews a pull request in a review session (pullRequests.review.runner: woodshed), as its author chose on My
// settings' Reviews card: no review, or any of Claude Code, Codex, Grok Build and OpenCode, whose verdicts become one
// (shared/codeReview/codeReview.mjs, mergeVerdicts). A choice is offered only while something can run it:
//
//   Claude Code   the team's anthropic-api-key, or the author's own Claude token while they run shared sessions on it
//   Codex         the team's openai-api-key, or the author's own Codex sign-in while they use it for reviews
//   Grok Build    the author's own Grok sign-in (an xAI key, or a login that has not expired) while they use it for
//                 reviews. There is no team key for it
//   OpenCode      the author's own OpenCode sign-ins while they use them for reviews, and only an API key of a provider
//                 the proxy forwards (shared/agents.cjs, OPENCODE_REVIEW_PROVIDERS). There is no team key for it either
//
// With no choice saved, a review runs every reviewer that can: Claude Code and Codex from the team keys or the author's
// own sign-ins, and Grok Build and OpenCode when the author's own sign-in is on for reviews. A sign-in for one of those
// two already saved when that default shipped, or found in the secret store afterwards without a save on My settings,
// stays out of it (userSettings.mjs, reviewDefault `legacy`) until the author sets reviews back to the default: the
// switch was already on, and it used to mean "when you pick this agent". Saving a different sign-in first does not
// cover one this console has not looked up yet. A sign-in first saved from the command line starts that switch off
// before the secret is stored, and again in the same settings update as the sign-in (server.mjs), so a stop after
// the secret lands still leaves it out until they turn it on; replacing one already saved leaves the switch as it is.
// A saved choice that can no longer run (a key removed, a sign-in turned off or expired since) keeps what of it can,
// else falls back the same way, and says why. Either way the console's proxies add the credential to each call
// (anthropicProxy.mjs, openaiProxy.mjs, reviewAgentProxy.mjs): no sign-in enters the review session. The choice itself is kept with the person's settings
// (userSettings.mjs, reviewAgents), as shared/agents.cjs names it (`both`, or ids joined with `+`).
import { credentialOf } from './codexModels.mjs';
import { credentialOf as grokCredentialOf } from './grokModels.mjs';
import agentsRegistry from '../shared/agents.cjs';

export const CHOICES = Object.keys(agentsRegistry.REVIEW_PRESETS);
/** The agents a review may run on its author's own sign-in alone: no team key runs them. */
export const OWN_ONLY_REVIEWERS = Object.freeze(agentsRegistry.REVIEW_AGENT_IDS.filter((id) => agentsRegistry.OWN_SIGN_IN_AGENTS.includes(id)));

/**
 * The OpenCode provider a review runs on, from the author's auth.json: the first of OPENCODE_REVIEW_PROVIDERS saved
 * with an API key. Never a login: see shared/agents.cjs.
 * @param {string|null} saved  the auth.json as saved (checkSignIn)
 * @returns {{provider: string, key: string}|null}
 */
export function opencodeReviewCredential(saved) {
  if (typeof saved !== 'string' || !saved.startsWith('{')) return null;
  let auth;
  try {
    auth = JSON.parse(saved);
  } catch {
    return null;
  }
  if (!auth || typeof auth !== 'object') return null;
  for (const provider of agentsRegistry.OPENCODE_REVIEW_PROVIDERS) {
    const entry = Object.hasOwn(auth, provider) ? auth[provider] : null;
    if (entry?.type === 'api' && typeof entry.key === 'string' && /^[\x21-\x7e]{8,500}$/.test(entry.key)) return { provider, key: entry.key };
  }
  return null;
}

/**
 * How a review's grok or opencode reaches the author's own sign-in, if it can: what the proxy will add, and what the
 * fleet records (`via` for grok, `provider` for opencode); else why not.
 * @param {string} id  grok or opencode
 * @param {string|null} saved
 * @returns {{via?: 'key'|'login', provider?: string, base?: string, authorization?: string, key?: string}|{why: string}}
 */
export function ownReviewCredential(id, saved, now = Date.now()) {
  if (!saved) return { why: `the author has no ${agentsRegistry.agent(id).product} sign-in saved` };
  if (id === 'grok') {
    const cred = grokCredentialOf(saved, now);
    if (!cred) return { why: 'the author\'s saved Grok Build sign-in has no token' };
    if (cred.expired) return { why: 'the author\'s saved Grok Build login has expired' };
    // A login whose end is not known is not offered: the console never refreshes one, so a review could start on a login
    // that has already ended and spend its run on refusals.
    if (cred.source === 'login' && cred.expiresAt === null) return { why: 'the author\'s saved Grok Build login does not say when it expires' };
    if (!/^[\x21-\x7e]+ [\x21-\x7e]+$/.test(cred.authorization)) return { why: 'the author\'s saved Grok Build sign-in has a token that cannot be sent' };
    return { via: cred.source, base: cred.base, authorization: cred.authorization };
  }
  const cred = opencodeReviewCredential(saved);
  if (!cred) return { why: `the author's saved OpenCode sign-ins have no API key of ${agentsRegistry.OPENCODE_REVIEW_PROVIDERS.join(' or ')}, which a review runs on` };
  return cred;
}

/**
 * Every reviewer that can run, when its author chose nothing, named as a choice (shared/agents.cjs, reviewChoiceOf):
 * all of them, else what there is, else none. Grok Build and OpenCode are in it when `available` says they can run.
 * `expanded: false` is the previous default, Claude Code and Codex only, for an author who has not accepted the wider
 * one (userSettings.mjs, reviewDefault `legacy`).
 * @param {Record<string, boolean>} available
 * @param {{expanded?: boolean}} [opts]
 * @returns {string}
 */
export function bestChoice(available, { expanded = true } = {}) {
  const ids = expanded ? agentsRegistry.REVIEW_AGENT_IDS : ['claude', 'codex'];
  return agentsRegistry.reviewChoiceOf(ids.filter((id) => available?.[id]));
}

/**
 * @param {{connected: () => Promise<{claude: boolean, codex: boolean}>,
 *          userSettings?: {reviewAgents: (login: string) => string|null, usesOwnTokenForShared: (login: string) => boolean,
 *            usesOwnCodexForReviews: (login: string) => boolean, codexAuth: (login: string) => Promise<string|null>,
 *            usesOwnAgentForReviews?: (login: string, id: string) => boolean,
 *            usesExpandedReviewDefault?: (login: string) => boolean,
 *            agentAuth?: (login: string, id: string) => Promise<string|null>}|null,
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

  // False only for an author whose Grok Build or OpenCode sign-in was already saved when the default grew, or was found
  // in the secret store without a save on My settings since, and who has not set reviews back to the default. Missing
  // means the wider default, so a stand-in without the method does too.
  function expandedDefault(login) {
    return !login || userSettings?.usesExpandedReviewDefault?.(login) !== false;
  }

  // The author's own sign-in for an agent with no team key (Grok Build, OpenCode), when they use it for reviews and it
  // can still be used: what the review records of it (never the credential itself), else why not. `off` says they did
  // not turn it on for reviews, or saved none, which is no failure.
  async function ownAgent(login, id) {
    const product = agentsRegistry.agent(id).product;
    if (!login || !userSettings?.usesOwnAgentForReviews?.(login, id)) return { use: null, off: true, why: `the author has no ${product} sign-in on for reviews` };
    try {
      const cred = ownReviewCredential(id, await userSettings.agentAuth(login, id), now());
      if (cred.why) return { use: null, why: cred.why };
      return { use: id === 'grok' ? { login, via: cred.via } : { login, provider: cred.provider }, why: null };
    } catch (err) {
      return { use: null, unread: true, why: `the author's ${product} sign-in could not be read: ${String(err?.message ?? err).split('\n')[0]}` };
    }
  }

  async function ownAgents(login) {
    return Object.fromEntries(await Promise.all(OWN_ONLY_REVIEWERS.map(async (id) => [id, await ownAgent(login, id)])));
  }

  /**
   * What `login` may choose from, and what they get with no choice saved. `ownWhy` says, for Grok Build and OpenCode
   * turned on for reviews, why one cannot run now (an expired login, no provider a review runs on). `expanded` is false
   * while this author still has the previous default.
   * @param {string|null} login  null for nobody's own sign-ins: team keys only
   */
  async function options(login) {
    const team = await teamKeys();
    const others = await ownAgents(login);
    const own = { claude: Boolean(login && userSettings?.usesOwnTokenForShared(login)), codex: Boolean((await ownCodex(login)).cred) };
    for (const id of OWN_ONLY_REVIEWERS) own[id] = Boolean(others[id].use);
    const available = { claude: team.claude || own.claude, codex: team.codex || own.codex };
    for (const id of OWN_ONLY_REVIEWERS) available[id] = own[id];
    const ownWhy = Object.fromEntries(OWN_ONLY_REVIEWERS.map((id) => [id, others[id].use || others[id].off ? null : others[id].why]));
    const expanded = expandedDefault(login);
    return { available, own, ownWhy, best: bestChoice(available, { expanded }), expanded };
  }

  /**
   * The agents a review of `login`'s pull request runs, starting now. `codexLogin` when Codex runs on that person's own
   * sign-in, `codexVia` how the session's codex reaches its credential (`chatgpt` for a ChatGPT login, `key` for an API
   * key, the author's or the team's) with `codexAccount` for a ChatGPT login, `ownSignIns` for Grok Build and OpenCode
   * (only ever on their author's own sign-in: `{grok: {login, via: 'key'|'login'}, opencode: {login, provider}}`, for
   * those that run), `choice` what they chose (null for none saved), `why` when what runs is not what they chose, or
   * not on their own sign-in, and `keysUnread` when the team keys or the author's own sign-ins could not be read: then
   * what runs is a guess, and no review is not a choice anyone made.
   * @param {{login?: string|null}} [args]  the pull request's author, or null when nobody's own sign-in may be used
   * @returns {Promise<{agents: string[], choice: string|null, codexLogin: string|null, codexVia: 'chatgpt'|'key'|null,
   *   codexAccount?: string, ownSignIns?: Record<string, {login: string, via?: string, provider?: string}>, why: string|null,
   *   keysUnread: boolean, expanded: boolean}>}
   */
  async function forReview({ login = null } = {}) {
    const team = await teamKeys();
    const codexOwn = await ownCodex(login);
    const others = await ownAgents(login);
    const claudeOwn = Boolean(login && userSettings?.usesOwnTokenForShared(login));
    const available = { claude: team.claude || claudeOwn, codex: team.codex || Boolean(codexOwn.cred) };
    for (const id of OWN_ONLY_REVIEWERS) available[id] = Boolean(others[id].use);
    const saved = login ? userSettings?.reviewAgents?.(login) ?? null : null;
    const chosen = agentsRegistry.reviewersOf(saved);
    const choice = chosen ? saved : null;
    const why = [];
    const expanded = expandedDefault(login);
    const fallback = agentsRegistry.reviewersOf(bestChoice(available, { expanded }));
    let agents = chosen ?? fallback;
    // Each reviewer the author chose that the console left out, for the note on the review (reviewSessions.mjs
    // leftOutNote). Only ids: the session record reaches other people, and why is the state of the author's sign-in.
    const leftOut = [];
    if (chosen && agents.some((a) => !available[a])) {
      const left = agents.filter((a) => available[a]);
      why.push(`the author chose ${choice}, which this console cannot run now`);
      // Grok Build and OpenCode run on nothing but the author's own sign-in: why each was left out.
      for (const id of agents.filter((a) => !available[a] && OWN_ONLY_REVIEWERS.includes(a))) {
        why.push(`${agentsRegistry.agent(id).product} left out: ${others[id].why}`);
        leftOut.push({ agent: id });
      }
      for (const id of agents.filter((a) => !available[a] && !OWN_ONLY_REVIEWERS.includes(a))) leftOut.push({ agent: id });
      agents = left.length ? left : fallback;
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
    const ownSignIns = Object.fromEntries(OWN_ONLY_REVIEWERS.filter((id) => agents.includes(id)).map((id) => [id, others[id].use]));
    // An own sign-in that could not be read counts as unread too, whether or not its agent was left out for it.
    const unread = [codexOwn, ...Object.values(others)].filter((o) => o.unread);
    for (const o of unread) if (!why.some((w) => w.endsWith(o.why))) why.push(o.why);
    return {
      agents, choice, leftOut, ...codex, ...(Object.keys(ownSignIns).length ? { ownSignIns } : {}),
      why: why.length ? why.join('; ') : null, keysUnread: Boolean(team.why || unread.length), expanded,
    };
  }

  return { forReview, options };
}
