// Run by mongosh for dbRestore.mjs, as the person's own Mongo user, which has readWrite and dbAdmin on their database
// and on its `__restore` and `__previous` beside it (session/dbAdmin.mjs, restoreNames). Mongo cannot rename a
// database, so Apply copies, one step a run so the page can show each: `backup` copies the database to `__previous`,
// `replace` empties it and copies the restore in (and on a failure copies `__previous` back), `cleanup` drops both.
//
// `__previous` is the person's data only while it holds the marker: `backup` writes it last, once the copy is whole,
// and `replace` takes it out once the database is right again, applied or rolled back. A `__previous` without it is
// a backup cut short, or one left by a cleanup that failed after the database was already right: never copied back.
// Each copy is the collections with their options and indexes, then their documents through `$out`, inside the server.
//
// Environment: WOODSHED_MONGO_URI (holding the password, so it is never an argument), WOODSHED_MONGO_ACTION
// (`summary` | `drop-copy` | `backup` | `replace` | `cleanup`) and WOODSHED_MONGO_DB (the person's database).
// Prints one JSON line.

/* global connect, process, print */
const conn = connect(process.env.WOODSHED_MONGO_URI);
const live = process.env.WOODSHED_MONGO_DB;
const named = (name) => conn.getSiblingDB(name);
const target = named(live);
const copy = named(`${live}__restore`);
const previous = named(`${live}__previous`);
const MARKER = '_woodshed_backup_complete';

function collections(from) {
  return from.getCollectionInfos({ type: 'collection' }).filter((c) => !c.name.startsWith('system.') && c.name !== MARKER);
}

function copyAll(from, to) {
  for (const { name, options } of collections(from)) {
    to.createCollection(name, options);
    const indexes = from.getCollection(name).getIndexes().filter((i) => i.name !== '_id_').map(({ v, ns, ...index }) => index);
    if (indexes.length) to.runCommand({ createIndexes: name, indexes });
    from.getCollection(name).aggregate([{ $out: { db: to.getName(), coll: name } }]).toArray();
  }
  return collections(from).length;
}

function summary(of) {
  const counts = collections(of).map(({ name }) => ({ name, rows: of.getCollection(name).estimatedDocumentCount() }));
  counts.sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
  return { tables: counts.length, rows: counts.reduce((n, c) => n + c.rows, 0), top: counts.slice(0, 8) };
}

function complete(of) {
  return of.getCollectionInfos({ name: MARKER }).length > 0;
}

// A whole backup still marked means an earlier Apply stopped inside `replace`, or its rollback did: it is the
// person's data, so it goes back before anything copies over it. Any other leftover is dropped.
function backup() {
  let putBack = false;
  if (complete(previous)) {
    target.dropDatabase();
    copyAll(previous, target);
    putBack = true;
  }
  previous.dropDatabase();
  const copied = copyAll(target, previous);
  previous.getCollection(MARKER).insertOne({ at: new Date() });
  return { putBack, collections: copied };
}

function replace() {
  if (!collections(copy).length) throw new Error('there is no restored copy to apply');
  if (!complete(previous)) throw new Error('the backup of your Mongo data did not finish, so nothing was replaced: apply again');
  try {
    target.dropDatabase();
    const copied = copyAll(copy, target);
    previous.getCollection(MARKER).drop();
    return { collections: copied };
  } catch (err) {
    target.dropDatabase();
    copyAll(previous, target);
    previous.getCollection(MARKER).drop();
    throw new Error(`the copy could not be applied, and your Mongo data is as it was: ${err.message}`);
  }
}

const actions = {
  summary: () => ({ summary: summary(copy) }),
  'drop-copy': () => ({ dropped: copy.dropDatabase().ok === 1 }),
  backup,
  replace,
  cleanup: () => {
    copy.dropDatabase();
    previous.dropDatabase();
    return { summary: summary(target) };
  },
};

let result;
try {
  const run = actions[process.env.WOODSHED_MONGO_ACTION];
  result = run ? { ok: true, ...run() } : { ok: false, error: `unknown action: ${process.env.WOODSHED_MONGO_ACTION}` };
} catch (err) {
  result = { ok: false, error: String(err.message).slice(0, 400) };
}
print(JSON.stringify(result));
