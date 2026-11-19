// What a tainted session may still do on GitHub (egressProxy.mjs reads each request inside the TLS it opens for these
// hosts): git over HTTPS and the API, on the private repos of its own project's owner, and nothing else. A token alone
// cannot say that: a person's own token reaches public repos, gists and other organizations too.
//
// Allowed: git fetch and push, archives, API reads of those repos, the API writes a pull request needs (open, edit,
// comment, label, request reviews), and GraphQL queries plus the same pull request mutations, every id in them one of
// those repos' objects or a person. Refused: anything on another owner's repo or a public one (the org's open-source
// repos included), gists, creating, forking, transferring a repo or changing its settings (making it public among them),
// webhooks, deploy keys, collaborators, Actions secrets, and every other host.

export const GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com']);

// A repo name as GitHub allows it, the owner's likewise.
const NAME = '[A-Za-z0-9_.-]+';
const GIT_RE = new RegExp(`^/(${NAME})/(${NAME}?)(?:\\.git)?/(info/refs|git-upload-pack|git-receive-pack)$`);
const CODELOAD_RE = new RegExp(`^/(${NAME})/(${NAME})/`);
const REPO_RE = new RegExp(`^/repos/(${NAME})/(${NAME})(/.*)?$`);
// The API calls a pull request needs, after /repos/<owner>/<name>.
const WRITES = [
  ['POST', /^\/pulls$/],
  ['PATCH', /^\/pulls\/\d+$/],
  ['POST', /^\/pulls\/\d+\/(comments|reviews)$/],
  ['POST', /^\/pulls\/\d+\/reviews\/\d+\/events$/],
  ['POST', /^\/pulls\/\d+\/comments\/\d+\/replies$/],
  ['POST', /^\/pulls\/\d+\/requested_reviewers$/],
  ['DELETE', /^\/pulls\/\d+\/requested_reviewers$/],
  ['POST', /^\/issues$/],
  ['PATCH', /^\/issues\/\d+$/],
  ['POST', /^\/issues\/\d+\/comments$/],
  ['PATCH', /^\/issues\/comments\/\d+$/],
  ['DELETE', /^\/issues\/comments\/\d+$/],
  ['POST', /^\/issues\/\d+\/labels$/],
  ['PUT', /^\/issues\/\d+\/labels$/],
  ['DELETE', /^\/issues\/\d+\/labels(\/[^/]+)?$/],
  ['POST', /^\/issues\/\d+\/assignees$/],
  ['DELETE', /^\/issues\/\d+\/assignees$/],
];
// The GraphQL mutations `gh pr` and `gh issue` make. Each takes `input:`, which is how they are found in a document.
export const ALLOWED_MUTATIONS = new Set([
  'createPullRequest', 'updatePullRequest', 'closePullRequest', 'reopenPullRequest', 'markPullRequestReadyForReview',
  'convertPullRequestToDraft', 'requestReviews', 'addPullRequestReview', 'submitPullRequestReview', 'addPullRequestReviewThread',
  'addComment', 'updateIssueComment', 'createIssue', 'updateIssue', 'closeIssue', 'reopenIssue',
  'addLabelsToLabelable', 'removeLabelsFromLabelable', 'addAssigneesToAssignable', 'removeAssigneesFromAssignable',
]);
export const MAX_GRAPHQL_BYTES = 1024 * 1024;

const deny = (why) => ({ kind: 'deny', why });

/**
 * @param {{host: string, method: string, path: string}} request  path without the query
 * @returns {{kind: 'repo', owner: string, name: string, write: boolean} | {kind: 'open'} | {kind: 'graphql'} |
 *           {kind: 'deny', why: string}}  `repo`: allowed if that repo is the session's org's and not public
 */
export function githubRequestRule({ host, method, path }) {
  const m = String(method).toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  if (host === 'github.com') {
    const git = GIT_RE.exec(path);
    if (!git) return deny('only git over HTTPS reaches github.com from a tainted session');
    const [, owner, name, what] = git;
    const write = what === 'git-receive-pack';
    if (what === 'info/refs' ? !read : m !== 'POST') return deny('not a git call');
    return { kind: 'repo', owner, name, write };
  }
  if (host === 'codeload.github.com') {
    const archive = CODELOAD_RE.exec(path);
    if (!archive || !read) return deny('only archive downloads reach codeload.github.com');
    return { kind: 'repo', owner: archive[1], name: archive[2], write: false };
  }
  if (host !== 'api.github.com') return deny(`${host} is not one of GitHub's hosts a tainted session reaches`);
  if (read && ['/user', '/rate_limit', '/meta'].includes(path)) return { kind: 'open' };
  if (m === 'POST' && path === '/graphql') return { kind: 'graphql' };
  const repo = REPO_RE.exec(path);
  if (!repo) return deny(read ? 'only reads of the session\'s own repos' : 'not one of the writes a tainted session may make');
  const [, owner, name, rest = ''] = repo;
  if (read) return { kind: 'repo', owner, name, write: false };
  if (!WRITES.some(([method, re]) => method === m && re.test(rest))) return deny('not one of the writes a tainted session may make (pull requests, issues, comments, labels, reviewers)');
  return { kind: 'repo', owner, name, write: true };
}

/** @returns {string}  a GraphQL document without its comments, which may say `mutation` in words */
function withoutComments(query) {
  return String(query).replace(/#[^\n]*/g, '');
}

// Every string a variable holds under a key ending in Id or Ids: what a mutation acts on.
function idsIn(value, key = '', found = []) {
  if (typeof value === 'string') {
    if (/Ids?$/.test(key)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) idsIn(item, key, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) idsIn(v, k, found);
  }
  return found;
}

/**
 * @param {unknown} body  the request's JSON: {query, variables, operationName}
 * @returns {{kind: 'query'} | {kind: 'mutation', mutations: string[], ids: string[]} | {kind: 'deny', why: string}}
 *   a mutation is allowed only once each of `ids` is found to be the session's own repo's or a person
 */
export function graphqlRule(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.query !== 'string') return deny('not a GraphQL request');
  const query = withoutComments(body.query);
  if (/\bsubscription\b/.test(query)) return deny('GraphQL subscriptions are not allowed');
  if (!/\bmutation\b/.test(query)) return { kind: 'query' };
  // Ids reach a mutation only through variables, which are checked: a quoted value inside the document is not.
  if (query.includes('"')) return deny('a GraphQL mutation must pass its values as variables');
  const mutations = [...query.matchAll(/([A-Za-z_]\w*)\s*\(\s*input\s*:/g)].map((m) => m[1]);
  if (!mutations.length) return deny('not a GraphQL mutation a tainted session may make');
  const refused = mutations.filter((name) => !ALLOWED_MUTATIONS.has(name));
  if (refused.length) return deny(`GraphQL mutation not allowed from a tainted session: ${refused.slice(0, 3).join(', ')}`);
  const ids = [...new Set(idsIn(body.variables ?? {}))];
  if (!ids.length) return deny('a GraphQL mutation with nothing to check it against');
  return { kind: 'mutation', mutations, ids };
}

// The query that says what each id is, asked with the request's own credential, so it shows only what the session sees.
export const NODES_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){__typename
... on Repository{nameWithOwner visibility}
... on PullRequest{repository{nameWithOwner visibility}}
... on Issue{repository{nameWithOwner visibility}}
... on IssueComment{repository{nameWithOwner visibility}}
... on PullRequestReview{repository{nameWithOwner visibility}}
... on PullRequestReviewComment{repository{nameWithOwner visibility}}
... on Label{repository{nameWithOwner visibility}}
... on User{login} ... on Team{slug} ... on Bot{login}}}`;
const ACTORS = new Set(['User', 'Team', 'Bot']);

/**
 * @param {unknown} answer  GitHub's answer to NODES_QUERY
 * @param {number} count  how many ids were asked about
 * @param {string} org  the owner the session's repos belong to
 * @returns {string|null}  why the mutation is refused, or null when every id is the org's private repo's or a person
 */
export function nodesRefusal(answer, count, org) {
  const nodes = answer?.data?.nodes;
  if (!Array.isArray(nodes) || nodes.length !== count) return 'GitHub did not say what the mutation acts on';
  for (const node of nodes) {
    if (!node) return 'the mutation names something the session cannot see';
    if (ACTORS.has(node.__typename)) continue;
    const repo = node.__typename === 'Repository' ? node : node.repository;
    if (!repo?.nameWithOwner) return `the mutation acts on a ${node.__typename}, which a tainted session may not change`;
    const refusal = repoRefusal({ owner: repo.nameWithOwner.split('/')[0], name: repo.nameWithOwner.split('/')[1], org, visibility: String(repo.visibility ?? '').toLowerCase() });
    if (refusal) return refusal;
  }
  return null;
}

/**
 * @param {{owner: string, name: string, org: string|null, visibility: 'public'|'private'|'internal'|'unknown'|string}} repo
 *   `unknown`: GitHub would not say (anonymously a private repo and a missing one look the same: a 404)
 * @returns {string|null}  why the repo is refused, or null
 */
export function repoRefusal({ owner, name, org, visibility }) {
  if (!org || owner.toLowerCase() !== org.toLowerCase()) return `${owner}/${name} is not ${org ?? 'the session\'s organization'}'s`;
  if (visibility === 'public') return `${owner}/${name} is public, and a tainted session may only reach private repos`;
  if (!['private', 'internal', 'unknown'].includes(visibility)) return `GitHub did not say whether ${owner}/${name} is private`;
  return null;
}
