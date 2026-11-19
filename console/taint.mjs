// What a session is told when it is tainted (fleet.taint): typed into claude as it reopens on the console's Anthropic
// proxy (session/statusd.mjs, POST /taint), with session/tainted.md added to its rules. Kept short: the rules say the rest.

export const TAINT_MESSAGE = [
  '[Woodshed] This session has just connected to production through woodshed-prod-mcp, so it is now locked down',
  '("tainted"), for good. claude was reopened on the same conversation.',
  '',
  'From now on this session reaches only: the Woodshed console (models, the production MCP server, the session API),',
  'its own databases and shared services, and git and the API on its organization\'s private GitHub repos.',
  'Everything else is refused by the network, not by a setting you can change: package registries (npm, PyPI and the',
  'rest), any other website, public repos, gists, web search and fetch, Docker, and your other MCP servers. Do not',
  'retry those calls or look for a way round: work with what is installed.',
  '',
  'Production values must not leave through the paths that remain. Never put customer data, secrets or other values you',
  'read from production into a commit, a pull request, a comment or an issue: describe them instead ("the row\'s email',
  'is null"). Everything this session holds is deleted when it is removed.',
].join('\n');
