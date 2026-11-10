import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, 'mongoRestore.js'), 'utf8');
const LIVE = 'woodshed_joel';

// What mongosh gives the script, over databases kept as { name: { collection: [documents] } }. `failOut` names a
// database whose `$out` throws, to stand in for a copy that fails half way.
function fakeMongo(dbs, { failOut = null } = {}) {
  const db = (name) => {
    dbs[name] ??= {};
    const self = {
      getName: () => name,
      getCollectionInfos: (filter = {}) => Object.keys(dbs[name])
        .filter((c) => !filter.name || c === filter.name)
        .map((c) => ({ name: c, type: 'collection', options: {} })),
      createCollection: (c) => { dbs[name][c] ??= []; },
      runCommand: () => ({ ok: 1 }),
      dropDatabase: () => { dbs[name] = {}; return { ok: 1 }; },
      getCollection: (c) => ({
        getIndexes: () => [{ name: '_id_', key: { _id: 1 } }],
        estimatedDocumentCount: () => (dbs[name][c] ?? []).length,
        insertOne: (doc) => { (dbs[name][c] ??= []).push(doc); },
        drop: () => { delete dbs[name][c]; },
        aggregate: ([{ $out }]) => ({
          toArray: () => {
            if (failOut === name) throw new Error('$out failed');
            dbs[$out.db] ??= {};
            dbs[$out.db][$out.coll] = [...dbs[name][c]];
            return [];
          },
        }),
      }),
    };
    return self;
  };
  return { getSiblingDB: db };
}

function run(action, dbs, opts) {
  let printed = null;
  vm.runInNewContext(SCRIPT, {
    connect: () => fakeMongo(dbs, opts),
    process: { env: { WOODSHED_MONGO_URI: 'mongodb://x', WOODSHED_MONGO_ACTION: action, WOODSHED_MONGO_DB: LIVE } },
    print: (line) => { printed = JSON.parse(line); },
    Date,
  });
  return printed;
}

const names = (dbs, name) => Object.keys(dbs[name] ?? {}).sort();
const MARKER = '_woodshed_backup_complete';

test('a whole Apply: backup marked, the copy in, the marker gone once the database is right', () => {
  const dbs = { [LIVE]: { original: [{ v: 1 }] }, [`${LIVE}__restore`]: { restored: [{ v: 2 }] } };
  assert.deepEqual(run('backup', dbs), { ok: true, putBack: false, collections: 1 });
  assert.deepEqual(names(dbs, `${LIVE}__previous`), [MARKER, 'original']);
  assert.deepEqual(run('replace', dbs), { ok: true, collections: 1 });
  assert.deepEqual(names(dbs, LIVE), ['restored']);
  assert.deepEqual(names(dbs, `${LIVE}__previous`), ['original'], 'the database is right again, so the backup is no longer the person\'s data');
});

test('a backup left by a cleanup that failed after a good replace is never copied back over newer data', () => {
  const dbs = {
    [LIVE]: { restored: [{}], written_after_apply: [{}] },
    [`${LIVE}__previous`]: { original: [{}] },
    [`${LIVE}__restore`]: { restored2: [{}] },
  };
  assert.equal(run('backup', dbs).putBack, false);
  assert.deepEqual(names(dbs, LIVE), ['restored', 'written_after_apply']);
  assert.deepEqual(names(dbs, `${LIVE}__previous`), [MARKER, 'restored', 'written_after_apply']);
});

test('a backup cut short is dropped, and the database is not touched', () => {
  const dbs = { [LIVE]: { a: [{}], b: [{}], c: [{}] }, [`${LIVE}__previous`]: { a: [{}] } };
  assert.equal(run('backup', dbs).putBack, false);
  assert.deepEqual(names(dbs, LIVE), ['a', 'b', 'c']);
});

test('a marked backup means an Apply stopped inside replace: it goes back first', () => {
  const dbs = { [LIVE]: { half: [{}] }, [`${LIVE}__previous`]: { a: [{}], b: [{}], [MARKER]: [{}] } };
  assert.equal(run('backup', dbs).putBack, true);
  assert.deepEqual(names(dbs, LIVE), ['a', 'b']);
});

test('replace refuses without a whole backup, and rolls back to it when the copy fails', () => {
  const unmarked = { [LIVE]: { a: [{}] }, [`${LIVE}__previous`]: { a: [{}] }, [`${LIVE}__restore`]: { x: [{}] } };
  assert.match(run('replace', unmarked).error, /backup .* did not finish/);
  assert.deepEqual(names(unmarked, LIVE), ['a']);

  const dbs = { [LIVE]: { a: [{}] }, [`${LIVE}__previous`]: { a: [{ v: 1 }], [MARKER]: [{}] }, [`${LIVE}__restore`]: { x: [{}] } };
  const out = run('replace', dbs, { failOut: `${LIVE}__restore` });
  assert.equal(out.ok, false);
  assert.match(out.error, /your Mongo data is as it was/);
  assert.deepEqual(dbs[LIVE], { a: [{ v: 1 }] }, 'copied back from the backup');
  assert.ok(!names(dbs, `${LIVE}__previous`).includes(MARKER), 'rolled back, so the next Apply does not copy it back again');
});
