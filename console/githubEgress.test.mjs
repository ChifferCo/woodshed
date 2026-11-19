import { test } from 'node:test';
import assert from 'node:assert/strict';

import { githubRequestRule, graphqlRule, nodesRefusal, repoRefusal } from './githubEgress.mjs';

const rule = (host, method, path) => githubRequestRule({ host, method, path });

test('git over HTTPS is a call on its repo, fetch and push alike; nothing else on github.com is', () => {
  assert.deepEqual(rule('github.com', 'GET', '/acme/api.git/info/refs'), { kind: 'repo', owner: 'acme', name: 'api', write: false });
  assert.deepEqual(rule('github.com', 'POST', '/acme/api/git-upload-pack'), { kind: 'repo', owner: 'acme', name: 'api', write: false });
  assert.deepEqual(rule('github.com', 'POST', '/acme/api.git/git-receive-pack'), { kind: 'repo', owner: 'acme', name: 'api', write: true });
  assert.deepEqual(rule('github.com', 'GET', '/acme/my.repo.git/info/refs'), { kind: 'repo', owner: 'acme', name: 'my.repo', write: false });
  for (const path of ['/acme/api', '/acme/api/settings', '/login', '/acme/api/archive/main.zip', '/new']) assert.equal(rule('github.com', 'GET', path).kind, 'deny', path);
  assert.equal(rule('github.com', 'POST', '/acme/api.git/info/refs').kind, 'deny');
  assert.equal(rule('gist.github.com', 'GET', '/').kind, 'deny');
});

test('the API: reads of a repo, the writes a pull request needs, and nothing that makes, opens or hands over a repo', () => {
  assert.deepEqual(rule('api.github.com', 'GET', '/repos/acme/api/pulls/3'), { kind: 'repo', owner: 'acme', name: 'api', write: false });
  assert.deepEqual(rule('api.github.com', 'POST', '/repos/acme/api/pulls'), { kind: 'repo', owner: 'acme', name: 'api', write: true });
  assert.equal(rule('api.github.com', 'POST', '/repos/acme/api/issues/3/comments').kind, 'repo');
  assert.equal(rule('api.github.com', 'GET', '/user').kind, 'open');
  assert.equal(rule('api.github.com', 'POST', '/graphql').kind, 'graphql');
  for (const [method, path] of [
    ['POST', '/gists'], ['POST', '/user/repos'], ['POST', '/orgs/acme/repos'], ['PATCH', '/repos/acme/api'], ['DELETE', '/repos/acme/api'],
    ['POST', '/repos/acme/api/forks'], ['POST', '/repos/acme/api/transfer'], ['POST', '/repos/acme/api/hooks'], ['POST', '/repos/acme/api/keys'],
    ['PUT', '/repos/acme/api/collaborators/eve'], ['PUT', '/repos/acme/api/actions/secrets/X'], ['POST', '/repos/acme/api/releases'],
    ['GET', '/gists/abc'], ['GET', '/search/code'], ['PUT', '/repos/acme/api/contents/x.txt'],
  ]) assert.equal(rule('api.github.com', method, path).kind, 'deny', `${method} ${path}`);
  assert.equal(rule('uploads.github.com', 'POST', '/repos/acme/api/releases/1/assets').kind, 'deny');
});

test('a repo is reachable only when it is the session\'s organization\'s and not public', () => {
  assert.equal(repoRefusal({ owner: 'Acme', name: 'api', org: 'acme', visibility: 'private' }), null);
  assert.equal(repoRefusal({ owner: 'acme', name: 'api', org: 'acme', visibility: 'unknown' }), null, 'a 404 anonymously: private, or no repo at all');
  assert.match(repoRefusal({ owner: 'acme', name: 'site', org: 'acme', visibility: 'public' }), /public/);
  assert.match(repoRefusal({ owner: 'octocat', name: 'Hello-World', org: 'acme', visibility: 'private' }), /not acme's/);
  assert.match(repoRefusal({ owner: 'acme', name: 'api', org: null, visibility: 'private' }), /not the session's organization's/);
});

test('GraphQL: queries pass, and only the pull request mutations, with every id they name checked', () => {
  assert.deepEqual(graphqlRule({ query: 'query { viewer { login } } # no mutation here' }), { kind: 'query' });
  const create = graphqlRule({
    query: 'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }',
    variables: { input: { repositoryId: 'R_1', headRepositoryId: 'R_2', title: 'x', body: 'y', headRefName: 'b' } },
  });
  assert.deepEqual(create, { kind: 'mutation', mutations: ['createPullRequest'], ids: ['R_1', 'R_2'] });
  assert.match(graphqlRule({ query: 'mutation($i: CreateRepositoryInput!) { createRepository(input: $i) { repository { url } } }', variables: { i: { name: 'x' } } }).why, /createRepository/);
  assert.match(graphqlRule({ query: 'mutation { updateRepository(input: {repositoryId: "R_1", visibility: PUBLIC}) { clientMutationId } }' }).why, /updateRepository/);
  assert.match(graphqlRule({ query: 'mutation { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } }' }).why, /variables/);
  assert.match(graphqlRule({ query: 'mutation($i: AddCommentInput!) { addComment(input: $i) { clientMutationId } }', variables: { i: { body: 'x' } } }).why, /nothing to check/);
  assert.equal(graphqlRule({ query: 'subscription { x }' }).kind, 'deny');
  assert.equal(graphqlRule('nope').kind, 'deny');
});

test('GraphQL is read as GitHub reads it: no string, comment, comma, alias or variable name hides a mutation or its target', () => {
  // A # inside a string, with the mutation in a fragment on Mutation.
  const hidden = graphqlRule({
    query: 'fragment F on Mutation { createIssue(input:{repositoryId:$r, title:"#", body:$b}){issue{url}} } mutation($r:ID!,$b:String!){ ...F }',
    variables: { r: 'R_public', b: 'data' },
  });
  assert.equal(hidden.kind, 'deny');
  assert.match(hidden.why, /only operation, with no fragments/);
  // A leading comma, beside an allowed mutation.
  const comma = graphqlRule({
    query: 'mutation($a:AddCommentInput!,$c:CreateRepositoryInput!){ addComment(input:$a){clientMutationId} createRepository(,input:$c){repository{url}} }',
    variables: { a: { subjectId: 'PR_ok', body: 'x' }, c: { name: 'leak', visibility: 'PUBLIC' } },
  });
  assert.match(comma.why, /createRepository/);
  // An alias does not rename the field.
  assert.match(graphqlRule({ query: 'mutation($c:CreateRepositoryInput!){ x: createRepository(input:$c){clientMutationId} }', variables: { c: { name: 'x' } } }).why, /createRepository/);
  // Every target is checked, whatever its variable is called, and updateIssue's `id` too.
  const names = graphqlRule({
    query: 'mutation($s:ID!,$b:String!,$okId:ID!){ addComment(input:{subjectId:$s,body:$b}){clientMutationId} b:addComment(input:{subjectId:$okId,body:$b}){clientMutationId} }',
    variables: { s: 'I_public', b: 'data', okId: 'PR_ok' },
  });
  assert.deepEqual(names, { kind: 'mutation', mutations: ['addComment', 'addComment'], ids: ['I_public', 'PR_ok'] });
  assert.deepEqual(graphqlRule({ query: 'mutation($i:UpdateIssueInput!){ updateIssue(input:$i){clientMutationId} }', variables: { i: { id: 'I_1', body: 'x' } } }).ids, ['I_1']);
  // A default is a value GitHub would use that the request's variables never held, so never checked.
  assert.match(graphqlRule({ query: 'mutation($s:ID=\"I_public\",$ok:ID!){ a:addComment(input:{subjectId:$s,body:\"x\"}){clientMutationId} }', variables: { ok: 'PR_ok' } }).why, /defaults|variables/);
  assert.match(graphqlRule({ query: 'mutation($s:ID="I_public",$ok:ID!,$b:String!){ a:addComment(input:{subjectId:$s,body:$b}){clientMutationId} b:addComment(input:{subjectId:$ok,body:$b}){clientMutationId} }', variables: { ok: 'PR_ok', b: 'x' } }).why, /defaults/);
  // What it asks back may use inline fragments: they are reads.
  assert.equal(graphqlRule({ query: 'mutation($i:AddCommentInput!){ addComment(input:$i){ subject { ... on PullRequest { url } } } }', variables: { i: { subjectId: 'PR_1' } } }).kind, 'mutation');
  assert.match(graphqlRule({ query: 'mutation($i:AddCommentInput!){ ...M }', variables: { i: { subjectId: 'PR_1' } } }).why, /field/);
  // The word mutation in a string or a comment, in a query, is only a query.
  assert.deepEqual(graphqlRule({ query: '# mutation\nquery { search(query: "mutation { x }", type: ISSUE, first: 1) { issueCount } }' }), { kind: 'query' });
  // A block string and an escaped quote; a document GraphQL would not read; more than one operation; an undeclared variable.
  assert.deepEqual(graphqlRule({ query: 'query { a(b: """x " # y""", c: "d\\"e") { f } }' }), { kind: 'query' });
  assert.match(graphqlRule({ query: 'mutation { addComment(input: $a' }).why, /could not read/);
  assert.match(graphqlRule({ query: 'query { a } mutation($a:AddCommentInput!){ addComment(input:$a){clientMutationId} }', variables: { a: { subjectId: 'x' } } }).why, /only operation/);
  assert.match(graphqlRule({ query: 'mutation($a:AddCommentInput!){ addComment(input:$x){clientMutationId} }', variables: { a: { subjectId: 'x' } } }).why, /does not declare/);
});

test('a mutation\'s ids must each be the organization\'s private repo\'s, or a person', () => {
  const ok = { data: { nodes: [{ __typename: 'Repository', nameWithOwner: 'acme/api', visibility: 'PRIVATE' }, { __typename: 'User', login: 'ana' }, { __typename: 'PullRequest', repository: { nameWithOwner: 'acme/api', visibility: 'INTERNAL' } }] } };
  assert.equal(nodesRefusal(ok, 3, 'acme'), null);
  assert.match(nodesRefusal({ data: { nodes: [{ __typename: 'Repository', nameWithOwner: 'acme/site', visibility: 'PUBLIC' }] } }, 1, 'acme'), /public/);
  assert.match(nodesRefusal({ data: { nodes: [{ __typename: 'Issue', repository: { nameWithOwner: 'eve/x', visibility: 'PRIVATE' } }] } }, 1, 'acme'), /not acme's/);
  assert.match(nodesRefusal({ data: { nodes: [null] } }, 1, 'acme'), /cannot see/);
  assert.match(nodesRefusal({ data: { nodes: [{ __typename: 'Gist' }] } }, 1, 'acme'), /Gist/);
  assert.match(nodesRefusal({ errors: [{}] }, 1, 'acme'), /did not say/);
});
