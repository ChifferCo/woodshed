// The mongo engine: one server on the base box on AWS, a container on the local provider. A session gets
// `MONGODB_URI`, its own database with its own user; what an app calls it is the project file's to say.
//
// Mongo cannot copy a database or rename one into place, so every copy is each collection copied inside the server,
// and the template says it is ready with a collection of its own, written last, which no copy takes.
import crypto from 'node:crypto';

import { PERSON_RE, SEEDER, TEMPLATE, TEMPLATE_NEXT, restoreNames } from './names.mjs';

// Written last into the template: a copy waits for it. It also says which commit the template was built from.
export const MONGO_READY = '_woodshed_template_ready';
const NAMESPACE_NOT_FOUND = 26;

function uri({ host, user, password, name }) {
  // The passwords Woodshed makes are hex, so nothing in the URI needs escaping; anyone else's is escaped.
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${name}?authSource=${name}`;
}

/**
 * @param {{env: Record<string, string|undefined>, database: {user: string|null, name: string|null}|null,
 *          credentials: {user: string, password: string, name: string}|null}} args
 *   `env.MONGODB_URI` set whole is used as it is (the docker launcher); otherwise it is made from the installation's
 *   WOODSHED_MONGO_HOST (host:port) and the console's credentials
 * @returns {Record<string, string>}
 */
function sessionEnv({ env, database, credentials }) {
  if (env.MONGODB_URI) return { MONGODB_URI: env.MONGODB_URI };
  if (!env.WOODSHED_MONGO_HOST) return { MONGODB_URI: '' };
  const name = credentials?.name || database?.name || '';
  return { MONGODB_URI: uri({ host: env.WOODSHED_MONGO_HOST, user: credentials?.user || database?.user || '', password: credentials?.password || '', name }) };
}

function seedEnv({ flags, user, password, name }) {
  return { MONGODB_URI: uri({ host: flags['mongo-host'], user, password, name }) };
}

function randomHex() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * mongo-express on the session's database, and a private session's second one on the copy My settings' Restore a dump
 * makes beside it (console/dbRestore.mjs): mongo-express shows only the database its URL names. Same user, which
 * db-admin gives rights on the copy (restoreNames). The URL goes in the environment, never the arguments.
 */
function startViewers({ env, sessionId, own, start, log }) {
  const { MONGODB_URI: live } = sessionEnv({ env, database: null, credentials: null });
  const one = (name, target, route, port) => start({
    name, command: 'node', args: ['app.js'], cwd: '/opt/mongo-express',
    env: {
      ME_CONFIG_MONGODB_URL: target, ME_CONFIG_MONGODB_ENABLE_ADMIN: 'false', ME_CONFIG_BASICAUTH: 'false',
      ME_CONFIG_SITE_BASEURL: `/${route}/${sessionId}/`, ME_CONFIG_SITE_COOKIESECRET: randomHex(), ME_CONFIG_SITE_SESSIONSECRET: randomHex(),
      VCAP_APP_HOST: '127.0.0.1', PORT: String(port),
    },
  });
  one('mongo-express', live, 'mongo', 7686);
  if (!own) return;
  const match = /\/([^/?]+)\?/.exec(live.replace(/^mongodb:\/\/[^@]*@/, ''));
  if (!match) {
    log('WARNING: no viewer for the Mongo restore copy', '(MONGODB_URI names no database)');
    return;
  }
  one('mongo-express-copy', live.replace(`/${match[1]}?`, `/${match[1]}__restore?`), 'mongo-copy', 7687);
}

/**
 * Every collection with its options and indexes, then its documents, all inside the server. The indexes go first:
 * `$out` keeps those of the collection it replaces.
 * @returns {Promise<number>}  how many collections
 */
export async function copyMongo(mongo, from, to) {
  const source = mongo.db(from);
  const target = mongo.db(to);
  const collections = (await source.listCollections({ type: 'collection' }).toArray())
    .filter((c) => !c.name.startsWith('system.') && c.name !== MONGO_READY);
  for (const { name, options } of collections) {
    await target.createCollection(name, options);
    const indexes = (await source.collection(name).listIndexes().toArray())
      .filter((i) => i.name !== '_id_')
      .map(({ v, ns, ...index }) => index);
    if (indexes.length) await target.collection(name).createIndexes(indexes);
    await source.collection(name).aggregate([{ $out: { db: to, coll: name } }]).toArray();
  }
  return collections.length;
}

const rolesOn = (names) => names.flatMap((d) => [{ role: 'readWrite', db: d }, { role: 'dbAdmin', db: d }]);

/**
 * What the db-admin task does on Mongo, as its root user.
 * @param {{flags: Record<string, string>, env: Record<string, string|undefined>, driver: {MongoClient: Function},
 *          log: Function, refuse: (message: string) => Error}} args
 */
function admin({ flags, env, driver, refuse }) {
  async function open() {
    if (!env.MONGO_ROOT_PASSWORD) throw refuse('MONGO_ROOT_PASSWORD must come from the task definition\'s secrets, with --mongo-host');
    const url = `mongodb://root:${encodeURIComponent(env.MONGO_ROOT_PASSWORD)}@${flags['mongo-host']}/admin?authSource=admin`;
    const mongo = new driver.MongoClient(url, { serverSelectionTimeoutMS: 15_000 });
    await mongo.connect();

    // Mongo has no owner of a database: what a user may touch is its roles, so a person's also name their restore's two.
    async function ensureUser({ name, user = name, password, restore = false }) {
      const db = mongo.db(name);
      const roles = rolesOn([name, ...(restore ? restoreNames(name) : [])]);
      const exists = (await db.command({ usersInfo: user })).users.length > 0;
      await db.command(exists ? { updateUser: user, pwd: password, roles } : { createUser: user, pwd: password, roles });
    }

    async function readyDoc() {
      return mongo.db(TEMPLATE).collection(MONGO_READY).findOne();
    }

    return {
      ensureUser,

      async dropCopies(name) {
        for (const db of [name, ...restoreNames(name)]) await mongo.db(db).dropDatabase();
        return {};
      },

      async template() {
        const doc = await readyDoc();
        return doc ? { ready: true, builtFrom: doc.builtFrom ?? null, marker: doc._id.toHexString() } : { ready: false, builtFrom: null, marker: null };
      },

      /** @returns {Promise<{collections: number}|null>}  null when a refresh dropped a collection from under the copy */
      async copyTemplate(name) {
        try {
          return { collections: await copyMongo(mongo, TEMPLATE, name) };
        } catch (err) {
          if (err.code === NAMESPACE_NOT_FOUND) return null;
          throw err;
        }
      },

      async dropAll(name) {
        const db = mongo.db(name);
        await db.command({ dropAllUsersFromDatabase: 1 });
        await db.dropDatabase();
      },

      async prepareNext({ password, fromCurrent }) {
        await mongo.db(TEMPLATE_NEXT).dropDatabase();
        if (fromCurrent) await copyMongo(mongo, TEMPLATE, TEMPLATE_NEXT);
        await ensureUser({ name: TEMPLATE_NEXT, user: SEEDER, password });
      },

      async swapIn({ buildSha }) {
        const live = mongo.db(TEMPLATE);
        await live.dropDatabase();
        const collections = await copyMongo(mongo, TEMPLATE_NEXT, TEMPLATE);
        await live.collection(MONGO_READY).insertOne({ readyAt: new Date(), builtFrom: buildSha });
        await mongo.db(TEMPLATE_NEXT).command({ dropAllUsersFromDatabase: 1 });
        await mongo.db(TEMPLATE_NEXT).dropDatabase();
        return { collections };
      },

      /**
       * People made before restores had them get the roles on their restore's two databases here, on every run, since
       * a reset would also empty their data. A person's user is the one named after its own database, without `__`.
       */
      async maintain() {
        const { users } = await mongo.db('admin').command({ usersInfo: { forAllDBs: true } });
        const people = users.filter((u) => u.user === u.db && PERSON_RE.test(u.user));
        let granted = 0;
        for (const { user, roles } of people) {
          const has = new Set(roles.map((r) => `${r.role}@${r.db}`));
          const missing = rolesOn(restoreNames(user)).filter((r) => !has.has(`${r.role}@${r.db}`));
          if (!missing.length) continue;
          await mongo.db(user).command({ grantRolesToUser: user, roles: missing });
          granted++;
        }
        return { message: 'Restore roles checked', fields: { granted } };
      },

      close: () => mongo.close(),
    };
  }

  return { open };
}

export default Object.freeze({
  name: 'mongo',
  label: 'Mongo',
  // The db-admin task's entryPoint flag: the server, host:port.
  flags: ['mongo-host'],
  rootPassword: 'MONGO_ROOT_PASSWORD',
  // The project's own mongoose, from the database's `dir`, until the image ships a driver of its own.
  loadDriver: (require) => ({ MongoClient: require('mongoose').mongo.MongoClient }),
  hostedIn: (env) => Boolean(env.WOODSHED_MONGO_HOST || env.MONGODB_URI),
  givenIn: (env) => Boolean(env.MONGODB_URI),
  secretVariables: ['MONGODB_URI'],
  sessionEnv,
  seedEnv,
  viewers: [
    { route: 'mongo', port: 7686, name: 'Mongo', program: 'mongo-express' },
    // A private session's second mongo-express, on its owner's restore copy.
    { route: 'mongo-copy', port: 7687, name: 'Mongo copy', program: 'mongo-express', own: true },
  ],
  startViewers,
  admin,
});
