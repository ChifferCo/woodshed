// Restore a dump's commands, read from public/dbRestore.js the way the page loads it: what they leave out is the
// project file's `databases[].dump`, and nothing without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadRestore() {
  const window = { Woodshed: { h: () => ({}) } };
  vm.runInContext(fs.readFileSync(new URL('./public/dbRestore.js', import.meta.url), 'utf8'), vm.createContext({ window, console }));
  return window.WoodshedRestore;
}

const { dumpCommands } = loadRestore();
const command = (commands, key) => commands.find((c) => c.key === key)?.command ?? null;

test('the dump commands leave out the project\'s own tables, collections and extensions', () => {
  const dump = { postgres: { skip: ['public.audit_log', 'events'], extensions: ['postgis'] }, mongo: { skip: ['cache'], extensions: [] } };
  const commands = dumpCommands({ pgMajor: 16, kinds: { postgres: true, mongo: true }, dump });
  assert.equal(command(commands, 'pg'), [
    'pg_dump \\', '  --format=custom --no-owner \\', '  --no-privileges --no-comments \\', '  --extension=postgis \\',
    "  --exclude-table-data='public.audit_log' \\", "  --exclude-table-data='events' \\",
    '  --file=woodshed.dump "postgres://USER:PASSWORD@HOST:5432/DATABASE"',
  ].join('\n'));
  assert.match(command(commands, 'docker'), /postgres:16 pg_dump \\\n[\s\S]*--extension=postgis[\s\S]*--file=\/dump\/woodshed\.dump/);
  assert.match(command(commands, 'mongo'), /--excludeCollection=cache \\\n  --archive=woodshed-mongo\.gz --gzip$/);
});

test('with no dump settings, nothing is left out and no extension is named', () => {
  const commands = dumpCommands({ pgMajor: 16, kinds: { postgres: true, mongo: true }, dump: undefined });
  assert.doesNotMatch(command(commands, 'pg'), /--extension|--exclude-table-data/);
  assert.doesNotMatch(command(commands, 'mongo'), /--excludeCollection/);
  assert.equal(command(dumpCommands({ pgMajor: 16, kinds: { postgres: true, mongo: false } }), 'mongo'), null);
});
