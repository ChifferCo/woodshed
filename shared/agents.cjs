// The agents a session can run, in one place: Claude Code, Codex, Grok Build and OpenCode. One file for
// the console (imported), its pages (served as /static/agents.cjs, a script that sets `WoodshedAgents`), the command line
// and the session image (/opt/woodshed/shared), so each names, offers and checks the same agents the same way.
//
// Claude Code and Codex are the two the console can run on a team's credential, through its own proxies
// (anthropicProxy.mjs, openaiProxy.mjs). The two others run only on their owner's own sign-in, saved on My settings as
// `users/<login>/<agent>-auth` and handed to that person's private sessions alone (sessionApi.mjs, /settings): never to a
// shared session, a question from Slack, a QA run or a review, which hold no one's sign-in. A review of a person's own
// pull request may still run them on that person's sign-in (console/reviewAgents.mjs), as Codex's does: the console's
// proxy adds it to each call (console/reviewAgentProxy.mjs), and the review session holds only its own token.
(function (root, factory) {
  const agents = factory();
  if (typeof module === 'object' && module.exports) module.exports = agents;
  else root.WoodshedAgents = agents;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /**
   * @typedef {{text: string, command?: string}} Step
   * @typedef {{secret: string, label: string, placeholder: string, steps: Step[], maxChars: number, rotates: boolean,
   *   kinds: string}} SignIn
   *   secret: the name under `users/<login>/`. rotates: the agent refreshes a login and its refresh token works once, so a
   *   session sends the refreshed one back at stop (sessionApi.mjs, /agent-auth). kinds: what the card says it takes.
   * @typedef {{id: string, name: string, product: string, command: string, processNames: string[], quit: string,
   *   teamCredential: boolean, signIn: SignIn|null, permissionModes: string[], modeRanks: Record<string, number>,
   *   modeWords?: Record<string, string>, efforts: string[]|null, modelHint: string, modelRe: RegExp|null, reviews: boolean,
   *   usageUrl: string|null, docsUrl: string}} Agent
   *   processNames: what tmux names the pane's command, and hc the program, while the agent runs. modelRe: the shape of a
   *   model name the console accepts for it (null: its own fixed list, sessions.mjs MODELS). efforts: what its effort
   *   menu offers, the default first (null: none, the agent has no such setting on its command line).
   *   modeRanks: how much each of its permission modes lets it do unasked, on one scale for every agent (RANKS), so a
   *   session started from another never gets a looser one (looserModeThan). modeWords: New session's words for a mode
   *   where this agent's differ from the menu's own.
   */

  // What a permission mode lets an agent do without asking a person, from least to most. Each agent's modes are placed
  // on it by what its session's flags and config make them (session/entrypoint.sh: claudeFlags, codexFlags, grokFlags,
  // configureOpencode).
  const RANKS = Object.freeze({
    // No change to any file: edits refused, and a command asks or runs in a read-only sandbox.
    readOnly: 0,
    // Every edit and every command asks first.
    asksFirst: 1,
    // Edits without asking, every command asks first.
    edits: 2,
    // Edits and commands in the checkout without asking, sandboxed: Codex's own policy for a trusted folder.
    workspace: 3,
    // Nothing asks (or the model alone decides when to).
    everything: 4,
  });

  // A model name as each agent's own `--model` takes it: letters, digits, dots, dashes and underscores, and for OpenCode
  // its `provider/model`. Never a space or a quote: it ends up on a command line.
  const MODEL_NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
  const PROVIDER_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:\/-]{0,127}$/i;

  /** @type {Record<string, Agent>} */
  const AGENTS = {
    claude: {
      id: 'claude', name: 'Claude', product: 'Claude Code', command: 'claude', processNames: ['claude'], quit: '/exit',
      teamCredential: true, signIn: null, permissionModes: ['auto', 'acceptEdits', 'plan', 'default'],
      // auto has Anthropic's classifier refuse what looks risky, but asks nobody.
      modeRanks: { plan: RANKS.readOnly, default: RANKS.asksFirst, acceptEdits: RANKS.edits, auto: RANKS.everything },
      efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'], modelHint: '', modelRe: null, reviews: true,
      usageUrl: 'https://claude.ai/settings/usage', docsUrl: 'https://code.claude.com/docs',
    },
    codex: {
      id: 'codex', name: 'Codex', product: 'Codex', command: 'codex', processNames: ['codex'], quit: '/quit',
      teamCredential: true, signIn: null, permissionModes: ['auto', 'plan', 'default'],
      // plan is its read-only sandbox, where a write asks for approval; default its own policy for the trusted checkout,
      // workspace-write with approval on request: edits and sandboxed commands run unasked.
      modeRanks: { plan: RANKS.readOnly, default: RANKS.workspace, auto: RANKS.everything },
      efforts: null, modelHint: '', modelRe: /^[a-z0-9][a-z0-9._-]{0,63}$/, reviews: true,
      usageUrl: 'https://chatgpt.com/codex/settings/usage', docsUrl: 'https://developers.openai.com/codex',
    },
    grok: {
      id: 'grok', name: 'Grok', product: 'Grok Build', command: 'grok', processNames: ['grok'], quit: '/quit',
      teamCredential: false,
      signIn: {
        secret: 'grok-auth', label: 'Grok Build', placeholder: 'xai-… or the contents of ~/.grok/auth.json', maxChars: 20_000, rotates: true,
        kinds: 'an xAI API key, or the login file grok login saves',
        steps: [
          { text: 'Sign in to Grok Build on your laptop:', command: 'grok login' },
          { text: 'Copy the saved sign-in without printing it. On Linux, use wl-copy or xclip -selection clipboard from the same file:', command: 'pbcopy < ~/.grok/auth.json' },
          { text: 'Or paste an xAI API key (xai-…) from console.x.ai.' },
        ],
      },
      permissionModes: ['auto', 'acceptEdits', 'plan', 'default'],
      // Its own modes of Claude Code's names (grok --help: default, acceptEdits, plan), and --always-approve for auto.
      modeRanks: { plan: RANKS.readOnly, default: RANKS.asksFirst, acceptEdits: RANKS.edits, auto: RANKS.everything },
      efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'], modelHint: 'grok-build', modelRe: MODEL_NAME, reviews: true,
      usageUrl: 'https://grok.com/build', docsUrl: 'https://docs.x.ai/build/overview',
    },
    opencode: {
      id: 'opencode', name: 'OpenCode', product: 'OpenCode', command: 'opencode', processNames: ['opencode', 'opencode.exe'], quit: '/exit',
      teamCredential: false,
      signIn: {
        secret: 'opencode-auth', label: 'OpenCode', placeholder: 'the contents of ~/.local/share/opencode/auth.json', maxChars: 20_000, rotates: true,
        kinds: 'the sign-ins file opencode auth login saves',
        steps: [
          { text: 'Sign in to a provider with OpenCode on your laptop:', command: 'opencode auth login' },
          { text: 'Copy the saved sign-ins without printing them. On Linux, use wl-copy or xclip -selection clipboard from the same file:', command: 'pbcopy < ~/.local/share/opencode/auth.json' },
        ],
      },
      permissionModes: ['auto', 'acceptEdits', 'plan', 'default'],
      // Each held by the `permission` rules configureOpencode writes for it (measured with 1.19.6), and --auto for auto,
      // which answers every ask itself.
      modeRanks: { plan: RANKS.readOnly, default: RANKS.asksFirst, acceptEdits: RANKS.edits, auto: RANKS.everything },
      modeWords: { default: 'Asks before edits and commands' },
      efforts: ['', 'low', 'medium', 'high', 'max'], modelHint: 'anthropic/claude-sonnet-4-5', modelRe: PROVIDER_MODEL, reviews: true,
      usageUrl: null, docsUrl: 'https://opencode.ai/docs',
    },
  };

  /** Every agent's id, Claude Code first: the order menus offer them in. */
  const AGENT_IDS = Object.freeze(Object.keys(AGENTS));
  /** The agents that run only on their owner's own sign-in. */
  const OWN_SIGN_IN_AGENTS = Object.freeze(AGENT_IDS.filter((id) => AGENTS[id].signIn));
  /** The agents that may review a pull request, in the order a review's comment names them. */
  const REVIEW_AGENT_IDS = Object.freeze(AGENT_IDS.filter((id) => AGENTS[id].reviews));
  /**
   * The OpenCode providers a review may run on, in the order one is picked from the author's auth.json: an API key
   * (`{type: 'api'}`) for a provider whose API the console's proxy forwards as it is, with the key in a known header.
   * Never a login (`oauth`): those rotate, and OpenCode's plugins reshape their calls in ways no proxy should copy.
   */
  const OPENCODE_REVIEW_PROVIDERS = Object.freeze(['anthropic', 'openai']);
  // Who reviews a person's pull requests, as a choice is saved and typed (console/reviewAgents.mjs, `woodshed config set
  // reviews`): a name for the choices from before Grok Build and OpenCode reviewed, and otherwise the reviewers' ids
  // joined with `+` in the order above, such as `claude+grok`.
  const REVIEW_PRESETS = Object.freeze({ none: [], claude: ['claude'], codex: ['codex'], both: ['claude', 'codex'] });

  /**
   * The reviewers a choice names, in the registry's order, or null for anything that is not a choice. Takes the ids in
   * any order (`grok+claude`), each once.
   * @param {unknown} choice
   * @returns {string[]|null}
   */
  function reviewersOf(choice) {
    if (typeof choice !== 'string' || !choice) return null;
    if (Object.hasOwn(REVIEW_PRESETS, choice)) return [...REVIEW_PRESETS[choice]];
    const ids = choice.split('+');
    if (ids.some((id) => !REVIEW_AGENT_IDS.includes(id)) || new Set(ids).size !== ids.length) return null;
    return REVIEW_AGENT_IDS.filter((id) => ids.includes(id));
  }

  /**
   * The choice that names these reviewers, as it is saved: a preset's name where one fits, else the ids joined.
   * @param {string[]} reviewers  ids of agents that review
   * @returns {string}
   */
  function reviewChoiceOf(reviewers) {
    const ids = REVIEW_AGENT_IDS.filter((id) => reviewers.includes(id));
    const preset = Object.keys(REVIEW_PRESETS).find((name) => REVIEW_PRESETS[name].join('+') === ids.join('+'));
    return preset ?? ids.join('+');
  }

  /**
   * The model each reviewer runs on when its author picked none: Claude Code's `opus`, as reviews always ran. The others
   * run on their own default (no entry), which each agent's own sign-in decides.
   */
  const REVIEW_DEFAULT_MODELS = Object.freeze({ claude: 'opus' });
  /** What a review's Claude Code may be told with `--model`: the same list New session offers. */
  const REVIEW_CLAUDE_MODELS = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);

  // The start of a known kind of key, and the look of any other: a long run of letters and digits in mixed case, which no
  // model name is. Not the whole of shared/secretLike.mjs (an ES module, and this file is also the browser's): the console
  // checks a pick against that as well (userSettings.mjs).
  function looksLikeSecret(part) {
    return /^(?:gh[pousr]_|github_pat_|glpat-|sk-|sk_|rk_|xai-|gsk_|hf_|npm_|pplx-|AIza|AKIA|ASIA|xox[a-z]-|xapp-|xoxe\.|wsc_|wt_)/i.test(part)
      || (part.length >= 32 && /^[A-Za-z0-9_]+$/.test(part) && /[a-z]/.test(part) && /[A-Z]/.test(part) && /\d/.test(part));
  }

  /** @returns {boolean}  whether `model` is one a review of this reviewer may run on (never empty: that is no pick) */
  function reviewModelOk(id, model) {
    if (!REVIEW_AGENT_IDS.includes(id) || typeof model !== 'string' || !model) return false;
    // A model name is never a credential: one pasted into the box by mistake is refused, never kept or logged.
    // Each part of `provider/model` is checked, as OpenCode's pick has the model after a slash.
    if (model.split('/').some(looksLikeSecret)) return false;
    if (id === 'claude') return REVIEW_CLAUDE_MODELS.includes(model);
    // A review runs OpenCode on one provider's key (OPENCODE_REVIEW_PROVIDERS), spelt as review.sh compares it.
    if (id === 'opencode' && !OPENCODE_REVIEW_PROVIDERS.includes(model.split('/')[0])) return false;
    return modelShapeOk(id, model);
  }

  /**
   * The picks in `models` a review may use, in the registry's order: a reviewer's id and a model it takes. Anything else
   * (an unknown reviewer, an empty or misshapen model) is left out, so the result is safe to put on a command line.
   * @param {unknown} models  `{claude: 'sonnet', codex: 'gpt-5'}`
   * @returns {Record<string, string>}
   */
  function reviewModelsOf(models) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) return {};
    return Object.fromEntries(REVIEW_AGENT_IDS.filter((id) => Object.hasOwn(models, id) && reviewModelOk(id, models[id])).map((id) => [id, models[id]]));
  }

  /** The picks as one line, `claude=sonnet codex=gpt-5`, the form REVIEW_MODELS takes; empty for none. */
  function reviewModelsText(models) {
    return Object.entries(reviewModelsOf(models)).map(([id, model]) => `${id}=${model}`).join(' ');
  }

  /** The picks of a line typed as `claude=sonnet,codex=gpt-5` (or spaces), or null when any word is not one. */
  function parseReviewModels(text) {
    const out = {};
    for (const word of String(text).split(/[\s,]+/).filter(Boolean)) {
      const [id, model, ...more] = word.split('=');
      if (more.length || !reviewModelOk(id, model) || Object.hasOwn(out, id)) return null;
      out[id] = model;
    }
    return reviewModelsOf(out);
  }

  /** Every name tmux or hc gives the agent's program, whichever agent it is. */
  const PROCESS_NAMES = Object.freeze([...new Set(AGENT_IDS.flatMap((id) => AGENTS[id].processNames))]);

  /** @returns {boolean}  whether this is an agent's id */
  function isAgent(id) {
    return typeof id === 'string' && Object.hasOwn(AGENTS, id);
  }

  /** @returns {Agent}  the agent of that id, or Claude Code for anything else: what a session with no agent runs */
  function agent(id) {
    return isAgent(id) ? AGENTS[id] : AGENTS.claude;
  }

  /** @returns {string}  the agent a session runs, from its options: claude unless it was started on another */
  function agentOfSession(s) {
    return isAgent(s?.options?.agent) ? s.options.agent : 'claude';
  }

  /**
   * The mode a session of `toAgent` gets when a session of `fromAgent` in `fromMode` starts it (console/sessionStarts.mjs):
   * the loosest of its own modes that lets it do no more unasked than the starting session may, so it is never looser.
   * Every agent has a read-only mode, so there always is one. A mode the starting agent does not have counts as
   * read-only: never guessed looser.
   * @returns {string}
   */
  function modeForStartedSession(fromAgent, fromMode, toAgent) {
    const from = agent(fromAgent).modeRanks;
    const limit = Object.hasOwn(from, fromMode) ? from[fromMode] : RANKS.readOnly;
    const to = agent(toAgent).modeRanks;
    return Object.keys(to).filter((m) => to[m] <= limit).sort((a, b) => to[b] - to[a])[0];
  }

  /**
   * Whether a model name is one this agent's command line takes. Claude Code's are a fixed list, checked elsewhere.
   * @returns {boolean}
   */
  function modelShapeOk(id, model) {
    const re = agent(id).modelRe;
    return !model || (re ? re.test(model) : false);
  }

  /**
   * An own sign-in, as the person pasted it, checked and made the form it is stored in: a key as it is, a login file as
   * compact JSON. Throws with a message the page shows.
   * @param {string} id  the agent
   * @param {unknown} value
   * @returns {string}
   */
  function checkSignIn(id, value) {
    const a = agent(id);
    const fail = (message) => Object.assign(new Error(message), { shown: true });
    if (!a.signIn) throw fail(`${a.product} has no own sign-in here`);
    if (typeof value !== 'string') throw fail('the sign-in must be text');
    const text = value.trim();
    if (!text) throw fail(`paste your ${a.product} sign-in first`);
    if (text.length > a.signIn.maxChars) throw fail(`that is too long for a ${a.product} sign-in`);
    if (id === 'grok' && /^xai-[0-9A-Za-z_-]{10,200}$/.test(text)) return text;
    let json;
    try {
      // zsh ends output with no final newline in a `%`, which a copy of `cat …auth.json` takes along.
      json = JSON.parse(text.replace(/\}\s*%$/, '}'));
    } catch {
      throw fail(id === 'grok' ? 'paste an xAI API key (xai-…) or the contents of ~/.grok/auth.json' : 'paste the contents of ~/.local/share/opencode/auth.json');
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json) || !Object.keys(json).length) throw fail(`that holds no ${a.product} sign-in: paste the whole auth.json`);
    const entries = Object.values(json);
    if (id === 'grok') {
      // A map of scope to login: each with the token Grok calls with (`key`), and a refresh token for a login.
      if (!entries.every((e) => e && typeof e === 'object' && typeof e.key === 'string' && e.key)) {
        throw fail('that is not a Grok Build auth.json: run grok login, then paste ~/.grok/auth.json');
      }
    } else if (!entries.every((e) => e && typeof e === 'object' && ['api', 'oauth', 'wellknown'].includes(e.type))) {
      throw fail('that is not an OpenCode auth.json: run opencode auth login, then paste ~/.local/share/opencode/auth.json');
    }
    return JSON.stringify(json);
  }

  /**
   * Which sign-in this is, whatever its spacing: the sha256 of a login file as compact JSON, or of a key as it is. A
   * session sends the one it was given back with a refreshed login, and the console keeps the refresh only while that is
   * still what it holds (sessionApi.mjs, /agent-auth): a sign-in saved since, or another session's refresh, is never
   * written over. Node only: the pages never call it.
   * @param {string} text
   * @returns {string}
   */
  function signInDigest(text) {
    let canonical = String(text ?? '').trim();
    try {
      if (canonical.startsWith('{')) canonical = JSON.stringify(JSON.parse(canonical));
    } catch {
      // Not JSON after all: digested as it is.
    }
    return require('node:crypto').createHash('sha256').update(canonical).digest('hex');
  }

  return { AGENTS, AGENT_IDS, RANKS, modeForStartedSession, OWN_SIGN_IN_AGENTS, REVIEW_AGENT_IDS, OPENCODE_REVIEW_PROVIDERS, REVIEW_PRESETS, reviewersOf, reviewChoiceOf, REVIEW_DEFAULT_MODELS, REVIEW_CLAUDE_MODELS, reviewModelOk, reviewModelsOf, reviewModelsText, parseReviewModels, PROCESS_NAMES, isAgent, agent, agentOfSession, modelShapeOk, checkSignIn, signInDigest };
});
