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
  assert.match(graphqlRule({ query: 'mutation { updateRepository(input: {repositoryId: "R_1", visibility: PUBLIC}) { clientMutationId } }' }).why, /variables/);
  assert.match(graphqlRule({ query: 'mutation($i: AddCommentInput!) { addComment(input: $i) { clientMutationId } }', variables: { i: { body: 'x' } } }).why, /nothing to check/);
  assert.equal(graphqlRule({ query: 'subscription { x }' }).kind, 'deny');
  assert.equal(graphqlRule('nope').kind, 'deny');
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
