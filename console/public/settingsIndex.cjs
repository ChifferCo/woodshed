// What the settings search knows: every section of every settings page, with the words people reach for when they look
// for it. One file for the page (a script that sets `WoodshedSettingsIndex`) and the tests (required), as openPulls.cjs is.
// Adding a card to a settings page means adding it here, and settingsIndex.test.mjs fails for a `to` whose page or
// anchor is not there.
(function (root, factory) {
  const index = factory();
  if (typeof module === 'object' && module.exports) module.exports = index;
  else root.WoodshedSettingsIndex = index;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // `scope` says whose sessions a section changes, which is the confusing part: `you` is your private (My Woodshed)
  // sessions alone, `everyone` the console's. `words` are what people type that the title and note do not say.
  const PAGES = {
    '/settings': { label: 'My settings', scope: 'you' },
    '/console-settings': { label: 'Settings', scope: 'everyone', admin: true },
    '/secrets': { label: 'Secrets & webhooks', scope: 'everyone', admin: true },
    '/people': { label: 'People', scope: 'everyone', admin: true },
    '/events': { label: 'Webhook events', scope: 'everyone', admin: true },
  };

  const ENTRIES = [
    // My settings
    { page: '/settings', id: 'claude', title: 'Claude sign-in', note: 'Your Claude token, so your private sessions run on your plan.',
      words: 'anthropic token plan login log in subscription api key oauth setup-token claude max pro credentials sign in auth shared sessions switch use mine' },
    { page: '/settings', id: 'codex', title: 'Codex sign-in', note: 'Your OpenAI login for private Codex sessions, and for reviews of your pull requests if you turn that on.',
      words: 'openai chatgpt gpt api key auth.json token login log in credentials sign in agent review reviews pull request plan subscription' },
    { page: '/settings', id: 'my-reviews', title: 'Reviews of my pull requests', note: 'Who reviews the pull requests you open: Claude Code, Codex, both, or no code review.',
      words: 'review reviewer reviews codex openai claude code both none no off agents second opinion verdict approve merge risk pull request pr' },
    { page: '/settings', id: 'my-project', title: 'My default project', note: 'The repo New session starts on for you.',
      words: 'repo repository default project which repo new session start on pick choose' },
    { page: '/settings', id: 'my-timeouts', title: 'My session timeouts', note: 'How long your sessions wait for you, and how long they may run. Overrides the console\'s numbers for you.',
      words: 'idle pause paused lifetime stop hours limit time out timeout expire how long wait auto stop sleep override' },
    { page: '/settings', id: 'my-databases', title: 'My databases', note: 'Your own copy of the databases, restore a dump, reset your data.',
      words: 'postgres postgresql mongo mongodb redis database db restore dump reset data copy pgweb tunnel psql migrate seed' },
    { page: '/settings', id: 'my-github', title: 'My GitHub connection', note: 'Connect GitHub so your sessions push and review as you; your git name and email.',
      words: 'git github connect push commit author name email identity gh token pull request pr review as me bot app' },
    { page: '/settings', id: 'my-home', title: 'MCP logins and Claude memory', note: 'What your private sessions keep of ~/.claude between runs.',
      words: 'mcp slack notion plugins memory claude home claude.md skills settings sync login' },
    { page: '/settings', id: 'repo-settings', title: 'My repo settings', note: 'Your own env file values, instructions and files for each repo, in your private sessions.',
      words: 'repo repository env environment variables dotenv .env secrets keys instructions prompt rules files claude.md per repo override mine own' },
    { page: '/settings', id: 'my-tmux', title: 'My tmux', note: 'Your own lines for the terminal\'s tmux config.',
      words: 'terminal shell keys keybindings mouse scroll config tmux.conf' },
    { page: '/settings', id: 'my-remove', title: 'Remove My Woodshed', note: 'Stop your private sessions and delete everything saved for you.',
      words: 'delete leave wipe reset account remove everything uninstall clean up' },

    // Settings, General (admins)
    { page: '/console-settings', id: 'card-updates', title: 'Update Woodshed', note: 'Newer Woodshed commits, and the Update button.',
      words: 'upgrade version git pull restart release check now commits' },
    { page: '/console-settings', id: 'card-projects', title: 'Repos the console runs sessions on', note: 'Add a repo, pick the default, set each repo\'s colour. Each repo\'s Settings has its env files and instructions.',
      words: 'repo repository project add remove default colour color needs setup ready database env files instructions team installation' },
    { page: '/console-settings', id: 'card-sessions', title: 'Session limits for everyone', note: 'How many shared sessions run at once, and when one stops by itself.',
      words: 'max concurrent running at once idle pause paused lifetime stop hours limit capacity queue time out timeout my woodshed per person' },
    { page: '/console-settings', id: 'card-retention', title: 'Retention', note: 'How long a stopped shared session keeps its conversation and databases.',
      words: 'delete cleanup clean up days keep kept resume merged closed expire old databases storage' },
    { page: '/console-settings', id: 'card-slack', title: 'Slack', note: 'Set up the bot, the channel for pull requests, and questions from Slack.',
      words: 'slack set up setup connect bot token signing secret manifest app install channel post notify announce pr pull request review qa brief channel id questions ask mention answer thread follow-up running at once limits disconnect' },
    { page: '/console-settings', id: 'card-webhooks', title: 'Webhooks', note: 'Turn GitHub\'s webhooks off, so the console polls instead.',
      words: 'webhook github events off on switch poll polling deliveries' },
    { page: '/console-settings', id: 'card-data', title: 'Sessions holding data', note: 'Databases and Claude homes kept by stopped sessions.',
      words: 'stalled drop delete cleanup storage homes databases kept' },

    // Settings, Secrets & webhooks (admins)
    { page: '/secrets', id: 'group-manager', title: 'Secrets manager', note: 'Where the console keeps its secrets.',
      words: 'aws secrets manager store vault prefix keys storage' },
    { page: '/secrets', id: 'group-session', title: 'Session secrets', note: 'What every session reads when it starts.',
      words: 'secret key token env credentials api key password value replace show' },
    { page: '/secrets', id: 'group-console', title: 'Console-only secrets', note: 'Anthropic and OpenAI keys, GitHub App key. Sessions cannot read these.',
      words: 'anthropic openai api key github app key client secret team key password rotate' },
    { page: '/secrets', id: 'hook-title', title: 'GitHub webhook', note: 'Whether GitHub\'s webhooks reach the console.',
      words: 'webhook github events deliveries label comment lambda queue app check again reconnect' },

    // People (admins)
    { page: '/people', id: 'invite-card', title: 'Invite someone', note: 'Let a GitHub user sign in.',
      words: 'add member user person engineer access join sign in handle github login invite link' },
    { page: '/people', id: 'members', title: 'Members and what each can do', note: 'Admin, can be assigned, sessions from GitHub, Slack link.',
      words: 'people team users admin permissions access assign assignable sessions from github slack link remove member role who can' },
    { page: '/people', id: 'requests', title: 'Asking to join', note: 'Accept or decline people who asked in.',
      words: 'request accept decline approve join pending access' },

    // Webhook events (admins)
    { page: '/events', id: 'events', title: 'Webhook events', note: 'Every delivery the console took off the queue, and what it did.',
      words: 'webhook log deliveries github slack events debug queue ignored queued label comment mention history' },
  ];

  const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9.#]+/).filter(Boolean);

  /**
   * How well one entry matches what is typed, or 0. Every typed word must match something: the title (best), the
   * words people reach for, the page's name or the note. A word counts when a word of the entry starts with it, and a
   * little less when it is only inside one, so `repo` finds `repository` and `ostgr` finds Postgres.
   * @param {object} entry
   * @param {string[]} typed  the typed words, lower case
   * @returns {number}
   */
  function scoreEntry(entry, typed) {
    const fields = [
      [words(entry.title), 10, entry.title.toLowerCase()],
      [words(entry.words), 6, entry.words.toLowerCase()],
      [words(PAGES[entry.page].label), 5, PAGES[entry.page].label.toLowerCase()],
      [words(entry.note), 3, entry.note.toLowerCase()],
    ];
    let total = 0;
    for (const word of typed) {
      let best = 0;
      for (const [list, weight, whole] of fields) {
        if (list.includes(word)) best = Math.max(best, weight + 2);
        else if (list.some((w) => w.startsWith(word))) best = Math.max(best, weight);
        else if (word.length >= 3 && whole.includes(word)) best = Math.max(best, weight / 2);
      }
      if (!best) return 0;
      total += best;
    }
    return total;
  }

  /**
   * The sections to show for what is typed: all of them, in page order, when nothing is, and otherwise those every typed
   * word matches, best first (a tie keeps the page order, My settings first).
   * @param {string} query
   * @param {{allowed?: (page: string) => boolean}} [opts]  `allowed` is false for a page this person cannot open
   * @returns {(object & {href: string, pageLabel: string, scope: string})[]}
   */
  function search(query, { allowed = () => true } = {}) {
    const typed = words(query);
    const open = ENTRIES.filter((e) => allowed(e.page)).map((e, order) => ({
      ...e, order, href: `${e.page}#${e.id}`, pageLabel: PAGES[e.page].label, scope: PAGES[e.page].scope,
    }));
    if (!typed.length) return open;
    return open.map((e) => ({ e, score: scoreEntry(e, typed) })).filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.e.order - b.e.order).map((m) => m.e);
  }

  return { PAGES, ENTRIES, search };
});
