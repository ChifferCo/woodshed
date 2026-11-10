import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createIssueTracking, inProgressMoves } from './issueTracking.mjs';

function card({ id, title, status, options }) {
  return {
    id, status: status ? { name: status } : null,
    project: { id: `p-${id}`, title, field: options ? { id: `f-${id}`, options: options.map((name, i) => ({ id: `${id}-${i}`, name })) } : null },
  };
}

test('inProgressMoves moves each card whose board has an In progress status, whatever its case', () => {
  const { moves, skipped } = inProgressMoves([
    card({ id: 'a', title: 'Acme', status: 'Priority', options: ['Backlog', 'Priority', 'In progress', 'Done'] }),
    card({ id: 'b', title: 'Support', status: null, options: ['Waiting Eng', 'In Progress', 'Resolved'] }),
    card({ id: 'c', title: 'Billing', status: 'Todo', options: ['Todo', 'Doing'] }),
    card({ id: 'd', title: 'Roadmap', status: null, options: null }),
    card({ id: 'e', title: 'Acme 2', status: 'in progress', options: ['In progress'] }),
  ]);
  assert.deepEqual(moves, [
    { projectId: 'p-a', itemId: 'a', fieldId: 'f-a', optionId: 'a-2', project: 'Acme' },
    { projectId: 'p-b', itemId: 'b', fieldId: 'f-b', optionId: 'b-1', project: 'Support' },
  ]);
  assert.deepEqual(skipped, [
    { project: 'Billing', why: 'no In progress status' },
    { project: 'Roadmap', why: 'no In progress status' },
    { project: 'Acme 2', why: 'already in progress' },
  ]);
  assert.deepEqual(inProgressMoves(null), { moves: [], skipped: [] });
});

function fakeGitHub({ assignees = [] } = {}) {
  const calls = [];
  return {
    calls,
    async issue() { return { assignees: assignees.map((login) => ({ login })) }; },
    async addAssignees(number, logins) { calls.push(['add', number, logins]); },
    async removeAssignees(number, logins) { calls.push(['remove', number, logins]); },
    async issueProjectItems() { return [card({ id: 'a', title: 'Acme', status: 'Backlog', options: ['Backlog', 'In progress'] })]; },
    async setProjectStatus(move) { calls.push(['status', move.itemId, move.optionId]); },
  };
}

test('syncAssignee adds the new assignee and takes off only the one it added', async () => {
  const github = fakeGitHub();
  const { syncAssignee } = createIssueTracking({ github });
  assert.equal(await syncAssignee({ number: 1, to: 'joel', added: null }), 'joel');
  assert.equal(await syncAssignee({ number: 1, to: 'JOEL', added: 'joel' }), 'joel', 'the same person in another case is no change');
  assert.equal(await syncAssignee({ number: 1, to: 'ana', added: 'joel' }), 'ana');
  assert.equal(await syncAssignee({ number: 1, to: null, added: 'ana' }), null);
  assert.deepEqual(github.calls, [['add', 1, ['joel']], ['remove', 1, ['joel']], ['add', 1, ['ana']], ['remove', 1, ['ana']]]);
});

test('syncAssignee leaves someone already assigned on GitHub, and does not claim them', async () => {
  const github = fakeGitHub({ assignees: ['Ana'] });
  const { syncAssignee } = createIssueTracking({ github });
  assert.equal(await syncAssignee({ number: 2, to: 'ana', added: null }), null);
  assert.deepEqual(github.calls, []);
});

test('markInProgress sets each card it can and says how many moved', async () => {
  const github = fakeGitHub();
  assert.equal(await createIssueTracking({ github }).markInProgress(3), 1);
  assert.deepEqual(github.calls, [['status', 'a', 'a-1']]);
});
