import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMyPulls } from './myPulls.mjs';

const projects = [
  { name: 'shop', repo: 'acme/shop', default: true },
  { name: 'app', repo: 'acme/app' },
];

test('every repo is asked on its own client, and the rows are yours then reviews, newest first, each with its project', async () => {
  const asked = [];
  const rows = {
    'acme/shop': [{ number: 1, why: 'yours', updatedAt: '2026-11-01T00:00:00Z' }, { number: 2, why: 'review', updatedAt: '2026-11-03T00:00:00Z' }],
    'acme/app': [{ number: 1, why: 'yours', updatedAt: '2026-11-02T00:00:00Z' }],
  };
  const githubFor = (project) => ({ openPullsFor: async (login) => { asked.push([project.repo, login]); return rows[project.repo]; } });
  const { pulls, stale } = await readMyPulls({ login: 'mia', projects, githubFor });
  assert.deepEqual(asked, [['acme/shop', 'mia'], ['acme/app', 'mia']]);
  assert.equal(stale, false);
  assert.deepEqual(pulls.map((p) => `${p.why} ${p.repo}#${p.number} ${p.project}`),
    ['yours acme/app#1 app', 'yours acme/shop#1 shop', 'review acme/shop#2 shop'],
    'two repos can both have a #1: each row says which');
});

test('a repo that fails keeps its last rows, and the others are read', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const kept = [{ number: 9, why: 'yours', project: 'app', repo: 'acme/app' }, { number: 3, why: 'yours', project: 'shop', repo: 'acme/shop' }];
  const githubFor = (project) => ({
    openPullsFor: async () => {
      if (project.name === 'app') throw new Error('HTTP 502\nmore');
      return [{ number: 4, why: 'yours' }];
    },
  });
  const { pulls, stale } = await readMyPulls({ login: 'mia', projects, githubFor, kept });
  assert.equal(stale, true);
  assert.deepEqual(pulls.map((p) => `${p.project}#${p.number}`).sort(), ['app#9', 'shop#4']);
  assert.deepEqual(console.warn.mock.calls[0].arguments, ['console: pull requests not readable', { login: 'mia', project: 'app', message: 'HTTP 502' }]);
});

test('a project with no GitHub client is left out', async () => {
  const githubFor = (project) => (project.default ? { openPullsFor: async () => [{ number: 1, why: 'yours' }] } : null);
  const { pulls } = await readMyPulls({ login: 'mia', projects, githubFor });
  assert.deepEqual(pulls.map((p) => p.project), ['shop']);
});
