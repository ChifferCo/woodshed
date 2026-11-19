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
// The GraphQL mutations `gh pr` and `gh issue` make, as the top-level fields of a mutation document.
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

// A GraphQL document, read as GitHub's server reads it (the spec's lexical grammar: strings, block strings, comments,
// commas as whitespace), so nothing in a string or a comment can hide an operation or a field from the check below.
const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

/** @returns {{kind: string, value: string}[]}  the document's tokens: punct, name, number, string */
export function graphqlTokens(text) {
  const src = String(text);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if (PUNCTUATORS.has(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (src.startsWith('"""', i)) {
      let j = i + 3;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new Error('an unterminated block string');
        if (src.startsWith('\\"""', j)) { value += '"""'; j += 4; continue; }
        if (src.startsWith('"""', j)) break;
        value += src[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value });
      i = j + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length || src[j] === '\n' || src[j] === '\r') throw new Error('an unterminated string');
        if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '"') break;
        value += src[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i, i + 256));
    if (name) { tokens.push({ kind: 'name', value: name[0] }); i += name[0].length; continue; }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (number) { tokens.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
    throw new Error(`a character GraphQL does not have: ${JSON.stringify(c)}`);
  }
  return tokens;
}

/**
 * The document's operations and fragments, enough to check a mutation: each operation's kind, its variables' types, and
 * its top-level selections with their arguments as values ({var}, {literal}, {list}, {object}).
 * @throws {Error}  for a document GraphQL would not parse
 */
export function parseGraphql(text) {
  const tokens = graphqlTokens(text);
  let at = 0;
  const peek = (value) => tokens[at] && tokens[at].value === value && tokens[at].kind !== 'string';
  const next = () => {
    if (at >= tokens.length) throw new Error('the document ends too soon');
    return tokens[at++];
  };
  const expect = (value) => {
    const token = next();
    if (token.value !== value || token.kind === 'string') throw new Error(`expected ${value}`);
    return token;
  };
  const name = () => {
    const token = next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  };
  function value() {
    if (peek('$')) { next(); return { var: name() }; }
    if (peek('[')) {
      next();
      const items = [];
      while (!peek(']')) items.push(value());
      next();
      return { list: items };
    }
    if (peek('{')) {
      next();
      const fields = [];
      while (!peek('}')) {
        const key = name();
        expect(':');
        fields.push([key, value()]);
      }
      next();
      return { object: fields };
    }
    const token = next();
    if (token.kind === 'punct') throw new Error('expected a value');
    return { literal: token.value };
  }
  function args() {
    const out = [];
    if (!peek('(')) return out;
    next();
    while (!peek(')')) {
      const key = name();
      expect(':');
      out.push([key, value()]);
    }
    next();
    return out;
  }
  function directives() {
    while (peek('@')) { next(); name(); args(); }
  }
  function type() {
    let base;
    if (peek('[')) { next(); base = type().base; expect(']'); } else base = name();
    if (peek('!')) next();
    return { base };
  }
  function selectionSet() {
    expect('{');
    const selections = [];
    while (!peek('}')) {
      if (peek('...')) {
        next();
        if (peek('on')) { next(); name(); directives(); selections.push({ fragment: 'inline', selections: selectionSet() }); continue; }
        if (peek('{') || peek('@')) { directives(); selections.push({ fragment: 'inline', selections: selectionSet() }); continue; }
        selections.push({ fragment: name() });
        directives();
        continue;
      }
      let field = name();
      let alias = null;
      if (peek(':')) { next(); alias = field; field = name(); }
      const fieldArgs = args();
      directives();
      selections.push({ field, alias, args: fieldArgs, selections: peek('{') ? selectionSet() : [] });
    }
    next();
    return selections;
  }
  const operations = [];
  const fragments = [];
  while (at < tokens.length) {
    if (peek('{')) { operations.push({ kind: 'query', variables: {}, defaults: [], selections: selectionSet() }); continue; }
    const keyword = name();
    if (keyword === 'fragment') {
      const fragmentName = name();
      expect('on');
      fragments.push({ name: fragmentName, on: name() });
      directives();
      selectionSet();
      continue;
    }
    if (!['query', 'mutation', 'subscription'].includes(keyword)) throw new Error(`${keyword} is not an operation`);
    if (tokens[at]?.kind === 'name') next();
    const variables = {};
    const defaults = [];
    if (peek('(')) {
      next();
      while (!peek(')')) {
        expect('$');
        const variable = name();
        expect(':');
        variables[variable] = type().base;
        if (peek('=')) { next(); value(); defaults.push(variable); }
        directives();
      }
      next();
    }
    directives();
    operations.push({ kind: keyword, variables, defaults, selections: selectionSet() });
  }
  if (!operations.length) throw new Error('no operation');
  return { operations, fragments };
}

// Fields of GitHub's input objects that name what a mutation acts on: `id`, and every `…Id` and `…Ids`. Their names are
// GitHub's schema's, not the caller's.
const ID_KEY = /^(id|.+Ids?)$/;

// Every string under an id field of a value the request passes.
function idsIn(value, key = '', found = []) {
  if (typeof value === 'string') {
    if (ID_KEY.test(key)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) idsIn(item, key, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) idsIn(v, k, found);
  }
  return found;
}

// What a mutation's arguments name: each variable they use, with the id field it lands in (null for none). A literal
// anywhere in them is refused, since only what the variables hold is checked.
function argumentVariables(args, found = [], key = '') {
  for (const [name, val] of args) walkValue(val, ID_KEY.test(name) ? name : key, found);
  return found;
}
function walkValue(val, key, found) {
  if (val.var) found.push({ name: val.var, idField: key || null });
  else if (val.list) for (const item of val.list) walkValue(item, key, found);
  else if (val.object) for (const [k, v] of val.object) walkValue(v, ID_KEY.test(k) ? k : '', found);
  else throw new Error('a GraphQL mutation must pass its values as variables');
}

/**
 * @param {unknown} body  the request's JSON: {query, variables, operationName}
 * @returns {{kind: 'query'} | {kind: 'mutation', mutations: string[], ids: string[]} | {kind: 'deny', why: string}}
 *   a mutation is allowed only once each of `ids` is found to be the session's own repo's or a person
 */
export function graphqlRule(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.query !== 'string') return deny('not a GraphQL request');
  let doc;
  try {
    doc = parseGraphql(body.query);
  } catch (err) {
    return deny(`a GraphQL document the proxy could not read (${err.message})`);
  }
  if (doc.operations.some((o) => o.kind === 'subscription')) return deny('GraphQL subscriptions are not allowed');
  if (!doc.operations.some((o) => o.kind === 'mutation')) {
    // A fragment on Mutation can only be spread into a mutation, which a query document has none of.
    return { kind: 'query' };
  }
  // A mutation stands alone: one operation, no fragment definitions (so nothing is spread into it from elsewhere), every
  // top-level selection a field it may make. What it asks back is read only, inline fragments and all.
  if (doc.operations.length !== 1 || doc.fragments.length) return deny('a GraphQL mutation must be the document\'s only operation, with no fragments');
  const [operation] = doc.operations;
  // A default would be a value GitHub uses that the request's variables, which are what is checked, never held.
  if (operation.defaults.length) return deny('a GraphQL mutation\'s variables may not have defaults');
  const mutations = [];
  const used = [];
  for (const selection of operation.selections) {
    if (!selection.field) return deny('a GraphQL mutation must name each mutation as a field');
    if (!ALLOWED_MUTATIONS.has(selection.field)) return deny(`GraphQL mutation not allowed from a tainted session: ${selection.field}`);
    mutations.push(selection.field);
    try {
      argumentVariables(selection.args, used);
    } catch (err) {
      return deny(err.message);
    }
  }
  if (!mutations.length) return deny('not a GraphQL mutation a tainted session may make');
  const variables = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : {};
  const ids = [];
  for (const { name, idField } of used) {
    if (!(name in operation.variables)) return deny(`a GraphQL mutation uses $${name}, which it does not declare`);
    const given = variables[name];
    // A variable of type ID, or one that lands in an id field, is what the mutation acts on, whatever it is called.
    if (operation.variables[name] === 'ID' || idField) {
      for (const item of [given].flat(Infinity)) {
        if (item === undefined || item === null) continue;
        if (typeof item !== 'string') return deny(`$${name} must hold ids`);
        ids.push(item);
      }
    } else idsIn(given, '', ids);
  }
  const unique = [...new Set(ids)];
  if (!unique.length) return deny('a GraphQL mutation with nothing to check it against');
  return { kind: 'mutation', mutations, ids: unique };
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
