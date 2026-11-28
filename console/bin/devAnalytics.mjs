// Made-up history for the dev console's Analytics page (console/analytics.mjs): sessions taken off the list over the last
// 90 days (state.json's `usageKept`), and the pull requests devGh.mjs's stand-in gh answers the page's search with, some
// opened by those sessions and some without Woodshed, by a made-up team that uses it more or less. Nothing here is real.

const DAY = 86_400_000;
const REPO = 'example-org/example-repo';
// A console with a second repo (DEV_CONSOLE_REPO_SETTINGS=1) has about one change in four on it, for the Repo menu.
const TOOLS = 'example-org/example-tools';
const repoOf = (n) => (process.env.DEV_CONSOLE_REPO_SETTINGS === '1' && n % 4 === 0 ? TOOLS : REPO);
// Each person: sessions a week, pull requests a week without Woodshed, and how many of their sessions open one.
const TEAM = [
  { login: 'octocat', sessions: 9, without: 1, opens: 0.6, agent: 'claude' },
  { login: 'ana-dev', sessions: 6, without: 2, opens: 0.5, agent: 'codex' },
  { login: 'mia-dev', sessions: 2, without: 4, opens: 0.5, agent: 'claude' },
  { login: 'zed-qa', sessions: 0.5, without: 5, opens: 0.4, agent: 'claude' },
  { login: 'sam-ops', sessions: 0, without: 3, opens: 0, agent: 'claude' },
];
const TITLES = [
  'Retry the image pull when the registry answers 429', 'Show the currency on every invoice line', 'Fold the stopped zones on a phone',
  'Answer a follow-up in the same Slack thread', 'Rate limit the public API', 'Fix CSV upload for large files', 'Cache the project file per commit',
  'Explain a failed start in the session log', 'Move the session API onto its own port', 'Upgrade pgweb and pin its version',
];
const TIERS = ['Low', 'Low', 'Low', 'Medium', 'Medium', 'High'];

// The same made-up history on every start: a small seeded random.
function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

/**
 * @param {number} now
 * @returns {{usageKept: object[], pulls: object[]}}  `pulls` as GitHub's search nodes (github.mjs, RecentPulls)
 */
export function devAnalytics(now) {
  const rand = seeded(42);
  const usageKept = [];
  const pulls = [];
  let number = 25000;
  let id = 0;
  const pull = ({ login, at, bot = false, branch, woodshed }) => {
    number += 1;
    const ageDays = (now - at) / DAY;
    // Woodshed's merge a little sooner here: made up, to show the comparison.
    const mergeHours = (woodshed ? 4 : 10) + rand() * (woodshed ? 30 : 60);
    const merged = ageDays * 24 > mergeHours && rand() < 0.85;
    const closed = !merged && ageDays > 5 && rand() < 0.3;
    const size = Math.round(20 + rand() * (woodshed ? 400 : 250));
    const tier = rand() < 0.8 ? TIERS[Math.floor(rand() * TIERS.length)] : null;
    // Who reviewed, made up: a teammate about half the time, and one or two review bots.
    const reviews = [];
    if (rand() < 0.5) reviews.push({ state: 'APPROVED', author: { login: TEAM[Math.floor(rand() * TEAM.length)].login === login ? 'sam-ops' : TEAM[Math.floor(rand() * TEAM.length)].login, __typename: 'User' } });
    if (rand() < 0.7) reviews.push({ state: 'COMMENTED', author: { login: 'claude[bot]', __typename: 'Bot' } });
    if (rand() < 0.35) reviews.push({ state: 'COMMENTED', author: { login: 'codex-reviewer[bot]', __typename: 'Bot' } });
    pulls.push({
      __repo: repoOf(number),
      number, url: `https://github.com/${repoOf(number)}/pull/${number}`, title: TITLES[number % TITLES.length],
      createdAt: new Date(at).toISOString(), mergedAt: merged ? new Date(at + mergeHours * 3_600_000).toISOString() : null,
      closedAt: merged ? new Date(at + mergeHours * 3_600_000).toISOString() : closed ? new Date(at + 3 * DAY).toISOString() : null,
      state: merged ? 'MERGED' : closed ? 'CLOSED' : 'OPEN', isDraft: false, additions: size, deletions: Math.round(size * rand() * 0.6),
      headRefName: branch, author: bot ? { login: 'renovate', __typename: 'Bot' } : { login: woodshed && rand() < 0.5 ? 'woodshed-dev' : login, __typename: woodshed ? 'Bot' : 'User' },
      // The review's label, as a review in a session puts on (github.mjs reads the tier from it).
      reviews: { nodes: reviews },
      labels: { nodes: tier ? [{ name: `merge risk: ${tier.toLowerCase()}` }] : [] },
    });
    return pulls.at(-1);
  };
  for (let week = 12; week >= 0; week--) {
    // Adoption grows over the weeks, as it does on a team that takes it up.
    const growth = 0.4 + 0.6 * ((12 - week) / 12);
    for (const person of TEAM) {
      const count = Math.round(person.sessions * growth + rand() - 0.5);
      for (let i = 0; i < count; i++) {
        const at = now - week * 7 * DAY - rand() * 7 * DAY;
        if (at > now) continue;
        id += 1;
        const sessionId = (0xd0000000 + id).toString(16);
        const branch = `woodshed/${person.login}-${sessionId}`;
        const opened = rand() < person.opens ? pull({ login: person.login, at: at + 2 * 3_600_000, branch, woodshed: true }) : null;
        usageKept.push({
          id: sessionId, project: opened && opened.__repo === TOOLS ? 'example-tools' : 'example-repo', repo: opened?.__repo ?? REPO, kind: 'work', login: person.login, private: rand() < 0.7,
          agent: id % 17 === 0 ? 'grok' : id % 29 === 0 ? 'opencode' : rand() < 0.8 ? person.agent : 'codex', createdAt: new Date(at).toISOString(), title: TITLES[id % TITLES.length],
          branch, prUrls: opened ? [opened.url] : [], number: null, tier: null, status: 'stopped',
        });
      }
      const without = Math.round(person.without * (1.2 - growth * 0.4) + rand() - 0.5);
      for (let i = 0; i < without; i++) pull({ login: person.login, at: now - week * 7 * DAY - rand() * 7 * DAY, branch: `${person.login}/change-${number}`, woodshed: false });
    }
    if (week % 3 === 0) pull({ login: 'renovate', at: now - week * 7 * DAY, bot: true, branch: 'renovate/deps', woodshed: false });
  }
  for (const r of usageKept) if (r.private) r.title = null;
  return { usageKept, pulls: pulls.filter((p) => Date.parse(p.createdAt) <= now).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}
