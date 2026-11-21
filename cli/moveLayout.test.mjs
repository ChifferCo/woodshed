import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWithApp, buildWithLabels, choose, leavesOf, localLayout, placesOf, prune, readDoc } from './moveLayout.mjs';
import { fakeHerdr } from './moveFixtures.mjs';

const sleep = async () => {};

test('this computer\'s layout is read from the app\'s document, and a labelled terminal it has not placed joins its tab', async () => {
  const h = fakeHerdr();
  const [a, b, c, d] = ['claude', 'bash', 'npm', 'bash'].map((name) => h.add({ argv: [name], cwd: '/w/app' }));
  const api = h.space('api', [['main', { row: [a, { column: [b, c] }] }]]);
  h.add({ argv: ['bash'], cwd: '/w/app', labels: { 'herdr.space': api.id, 'herdr.tab': api.tabs[0].id } });
  const doc = await readDoc(h.hc, 'herdr-app');
  const terminals = [...h.terminals.values()];
  const layout = localLayout(doc, terminals);
  assert.equal(layout.length, 1);
  assert.equal(layout[0].name, 'api');
  assert.deepEqual(layout[0].tabs[0].tree, {
    split: 'right', weight: null, children: [{ terminal: a, weight: null }, { split: 'down', weight: null, children: [{ terminal: b, weight: null }, { terminal: c, weight: null }] }, { terminal: 't5', weight: null }],
  }, 'last of the tab\'s row, as the app adopts it');
  assert.deepEqual(leavesOf(layout[0].tabs[0].tree), [a, b, c, 't5']);
  assert.ok(!leavesOf(layout[0].tabs[0].tree).includes(d), 'an unlabelled terminal is in no space');
});

test('a move takes a space or a tab by id or name, or terminals one by one, each tree kept to what it takes', async () => {
  const h = fakeHerdr();
  const [a, b, c, d] = ['claude', 'bash', 'npm', 'bash'].map((name) => h.add({ argv: [name], cwd: '/w/app' }));
  const api = h.space('api', [['main', { row: [a, { column: [b, c] }] }], ['logs', d]]);
  const loose = h.add({ argv: ['bash'], cwd: '/w' });
  const terminals = [...h.terminals.values()];
  const layout = localLayout(await readDoc(h.hc, 'herdr-app'), terminals);

  const bySpace = choose(layout, terminals, { space: 'api' });
  assert.deepEqual(bySpace.spaces.map((s) => [s.name, s.tabs.map((t) => [t.name, leavesOf(t.tree)])]), [['api', [['main', [a, b, c]], ['logs', [d]]]]]);
  assert.deepEqual(choose(layout, terminals, { space: api.id }), bySpace);
  assert.deepEqual(choose(layout, terminals, { tab: 'logs' }).spaces[0].tabs.map((t) => t.name), ['logs']);
  const two = choose(layout, terminals, { terminal: [c, a] });
  assert.deepEqual(two.spaces[0].tabs[0].tree, { split: 'right', weight: null, children: [{ terminal: a, weight: null }, { terminal: c, weight: null }] }, 'the split down with one left is that one');
  const alone = choose(layout, terminals, { terminal: [loose] });
  assert.deepEqual(alone.spaces, [{ name: '', from: null, tabs: [{ name: '', from: null, tree: { terminal: loose, weight: null } }] }]);
  assert.match(choose(layout, terminals, { space: 'web' }).error, /no space web on this computer/);
  assert.match(choose(layout, terminals, { terminal: ['t99'] }).error, /no live terminal t99/);

  const places = placesOf(bySpace.spaces);
  assert.deepEqual(places.get(a), { space: 'api', tab: 'main', split: null, ratio: null });
  assert.deepEqual(places.get(b), { space: 'api', tab: 'main', split: 'right', ratio: null });
  assert.deepEqual(places.get(c), { space: 'api', tab: 'main', split: 'down', ratio: null });
  assert.equal(prune({ terminal: a }, new Set()), null);
});

test('the layout is made again on a machine through the window, and a terminal already there takes its stand-in\'s place', async () => {
  const machine = 'woodshed-dddd0004';
  const h = fakeHerdr();
  const own = h.add({ machine, argv: ['claude'], cwd: '/work/app', name: 'claude' });
  const spaces = [{
    name: 'api',
    tabs: [
      { name: 'main', tree: { split: 'right', children: [{ terminal: 't1' }, { split: 'down', children: [{ terminal: 't2' }, { terminal: 't3' }] }] } },
      { name: 'logs', tree: { terminal: 't4' } },
    ],
  }];
  const start = (address) => (address === 't1' ? { adopt: 'claude', folder: '/work/app' }
    : { folder: '/work/app', argv: ['/bin/bash', '-lc', `cd /work/app && exec ${address === 't3' ? 'npm run dev' : 'bash -l'}`] });
  const seen = [];
  const built = await buildWithApp({ app: h.app, hc: h.hc, machine, spaces, start, sleep, onSpace: (s) => seen.push(s.id) });
  assert.equal(built.spaces.length, 1);
  assert.deepEqual(seen, [built.spaces[0].id]);
  assert.equal(built.terminals.get('t1'), own, 'the session\'s own agent, adopted');
  assert.deepEqual(h.shape(built.spaces[0].id), {
    name: 'api',
    tabs: [
      { name: 'main', tree: { row: [`${own}:claude`, { column: [`${built.terminals.get('t2')}:bash`, `${built.terminals.get('t3')}:npm`] }] } },
      { name: 'logs', tree: `${built.terminals.get('t4')}:bash` },
    ],
  });
  assert.equal(h.terminals.get(own).labels['herdr.space'], built.spaces[0].id.split('/')[1], 'its labels name the space as its machine has it');
  assert.ok([...h.terminals.values()].some((t) => t.address.startsWith(machine) && t.state === 'finished'), 'the stand-in shell was closed');
});

test('with no window the terminals are started with the labels the app adopts them by', async () => {
  const machine = 'woodshed-dddd0004';
  const h = fakeHerdr({ window: false });
  const own = h.add({ machine, argv: ['claude'], cwd: '/work/app', name: 'claude' });
  const made = [];
  const built = await buildWithLabels({
    hc: h.hc, machine, tag: 'move-1234abcd', onTerminal: (t) => made.push(t),
    spaces: [{ name: 'api', tabs: [{ name: 'main', tree: { split: 'right', children: [{ terminal: 't1' }, { terminal: 't2' }] } }] }],
    start: (a) => (a === 't1' ? { adopt: 'claude' } : { folder: '/work/app', argv: ['/bin/bash', '-lc', 'cd /work/app && exec bash -l'] }),
  });
  assert.equal(built.terminals.get('t1'), own);
  const other = h.terminals.get(built.terminals.get('t2'));
  assert.deepEqual([other.labels, other.cwd], [{ 'herdr.space': 'move-1234abcd-s1', 'herdr.tab': 'move-1234abcd-s1-t1' }, '/work/app']);
  assert.deepEqual(h.terminals.get(own).labels, { 'herdr.space': 'move-1234abcd-s1', 'herdr.tab': 'move-1234abcd-s1-t1' });
  assert.deepEqual(made, [built.terminals.get('t2')], 'only what it started is the move\'s to undo');
});
