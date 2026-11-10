// The postgres engine: RDS on AWS, a container on the local provider. A session gets libpq's own variables, so psql and
// most drivers connect with no setup, and `PG_URL` for an app that reads one URL. What an app calls them is the
// project file's to say, in its env file lines (docs/reference.md, "The project file").
//
// Every database is a copy of the template, `CREATE DATABASE ... TEMPLATE`, owned by its owner's role. The template's
// comment says which commit it was built from, and is written last: a copy waits for it.
import fs from 'node:fs';
import path from 'node:path';

import { SEEDER, TEMPLATE, TEMPLATE_NEXT } from './names.mjs';

// The RDS CA bundle the session image adds (session/Dockerfile), for a session whose PGSSLMODE verifies the server.
const RDS_CA = '/etc/ssl/certs/rds-global-bundle.pem';
const UNDEFINED_DATABASE = '3D000';
// Every role may connect to these, by design: `postgres` is where a role goes to create or drop its own databases.
const OPEN_DATABASES = ['postgres', 'rdsadmin'];
const PGWEB_BOOKMARKS = '/tmp/woodshed-pgweb-bookmarks';

function url({ PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE, PGSSLMODE }) {
  if (!PGHOST) return '';
  const auth = PGUSER ? `${encodeURIComponent(PGUSER)}${PGPASSWORD ? `:${encodeURIComponent(PGPASSWORD)}` : ''}@` : '';
  return `postgres://${auth}${PGHOST}:${PGPORT}/${encodeURIComponent(PGDATABASE)}${PGSSLMODE ? `?sslmode=${PGSSLMODE}` : ''}`;
}

/**
 * @param {{env: Record<string, string|undefined>, database: {user: string|null, name: string|null}|null,
 *          credentials: {user: string, password: string, name: string}|null}} args
 *   `credentials` the console's, for the databases it made; without them the environment's, then the project file's
 * @returns {Record<string, string>}
 */
function sessionEnv({ env, database, credentials }) {
  const vars = {
    PGHOST: env.PGHOST || '',
    PGPORT: env.PGPORT || '5432',
    PGUSER: credentials?.user || env.PGUSER || database?.user || '',
    PGPASSWORD: credentials?.password || env.PGPASSWORD || '',
    PGDATABASE: credentials?.name || env.PGDATABASE || database?.name || '',
    ...(env.PGSSLMODE ? { PGSSLMODE: env.PGSSLMODE } : {}),
  };
  return { ...vars, PG_URL: url(vars) };
}

/** The next template's, for its migrate and seed: the host the db-admin task's flags give, as the seeder. */
function seedEnv({ flags, user, password, name }) {
  const ssl = flags['pg-ca'] === 'none' ? { PGSSLMODE: 'disable' } : { PGSSLMODE: 'verify-full', PGSSLROOTCERT: flags['pg-ca'], NODE_EXTRA_CA_CERTS: flags['pg-ca'] };
  const vars = { PGHOST: flags['pg-host'], PGPORT: '5432', PGUSER: user, PGPASSWORD: password, PGDATABASE: name, ...ssl };
  return { ...vars, PG_URL: url(vars) };
}

function sslQuery(env) {
  const mode = env.PGSSLMODE || 'disable';
  return mode === 'verify-full' ? `sslmode=${mode}&sslrootcert=${env.PGSSLROOTCERT || RDS_CA}` : `sslmode=${mode}`;
}

/**
 * pgweb on the session's database, as its own user. A private session's also opens the copy My settings' Restore a
 * dump makes (console/dbRestore.mjs), through two bookmarks: --bookmarks-only connects to them and to no other host.
 * The bookmarks hold the password, so they are the session user's alone; a connection string goes in the environment,
 * never the arguments, where `ps` would show it.
 */
function startViewers({ env, sessionId, own, start }) {
  const vars = sessionEnv({ env, database: null, credentials: null });
  const prefix = `--prefix=pg/${sessionId}/`;
  if (!own) {
    // Encoded, as url() does: a password from the docker launcher's environment may hold `@`, `/` or `#`.
    const auth = `${encodeURIComponent(vars.PGUSER)}:${encodeURIComponent(vars.PGPASSWORD)}`;
    const target = `postgres://${auth}@${vars.PGHOST}:${vars.PGPORT}/${encodeURIComponent(vars.PGDATABASE)}?${sslQuery(env)}`;
    start({ name: 'pgweb', command: 'pgweb', args: ['--bind=127.0.0.1', '--listen=7685', prefix, '--lock-session', '--skip-open'], env: { PGWEB_DATABASE_URL: target } });
    return;
  }
  fs.mkdirSync(PGWEB_BOOKMARKS, { recursive: true, mode: 0o700 });
  for (const [bookmark, database] of [['your-database', vars.PGDATABASE], ['restored-copy', `${vars.PGDATABASE}__restore`]]) {
    const text = `host = "${vars.PGHOST}"\nport = ${vars.PGPORT}\nuser = "${vars.PGUSER}"\npassword = "${vars.PGPASSWORD}"\ndatabase = "${database}"\nsslmode = "${env.PGSSLMODE || 'disable'}"\n`;
    fs.writeFileSync(path.join(PGWEB_BOOKMARKS, `${bookmark}.toml`), text, { mode: 0o600 });
  }
  start({
    name: 'pgweb', command: 'pgweb',
    args: ['--bind=127.0.0.1', '--listen=7685', prefix, `--bookmarks-dir=${PGWEB_BOOKMARKS}`, '--bookmarks-only', '--bookmark=your-database', '--skip-open'],
    env: { PGSSLROOTCERT: env.PGSSLROOTCERT || RDS_CA },
  });
}

/**
 * What the db-admin task does on Postgres, as its root user: the only code that holds RDS's master password.
 * @param {{flags: Record<string, string>, env: Record<string, string|undefined>, driver: {Client: Function},
 *          log: (message: string, fields?: object) => void, refuse: (message: string) => Error}} args
 */
function admin({ flags, env, driver, log, refuse }) {
  const ca = flags['pg-ca'] === 'none' ? null : fs.readFileSync(flags['pg-ca'], 'utf8');
  const client = (database = 'postgres') => new driver.Client({
    host: flags['pg-host'], port: 5432, user: flags['pg-root-user'], password: env.PG_ROOT_PASSWORD, database,
    ssl: ca ? { ca, rejectUnauthorized: true } : false,
  });

  async function inside(database, work) {
    const c = client(database);
    await c.connect();
    try {
      return await work(c);
    } finally {
      await c.end();
    }
  }

  async function open() {
    if (!env.PG_ROOT_PASSWORD) throw refuse('PG_ROOT_PASSWORD must come from the task definition\'s secrets, with --pg-host');
    const root = client();
    await root.connect();
    const ident = (name) => root.escapeIdentifier(name);
    const exists = async (sql, name) => (await root.query(sql, [name])).rowCount > 0;
    const roleExists = (name) => exists('SELECT 1 FROM pg_roles WHERE rolname = $1', name);
    const databaseExists = (name) => exists('SELECT 1 FROM pg_database WHERE datname = $1', name);

    async function ensureRole(name, password, { createdb }) {
      const options = `LOGIN ${createdb ? 'CREATEDB' : 'NOCREATEDB'} PASSWORD ${root.escapeLiteral(password)}`;
      await root.query(`${(await roleExists(name)) ? 'ALTER' : 'CREATE'} ROLE ${ident(name)} WITH ${options}`);
      // Root joins the role, which dropping its databases and taking their objects need.
      await root.query(`GRANT ${ident(name)} TO CURRENT_USER`);
    }

    // Every database the role owns goes, its tests' copies too.
    async function dropOwned(name) {
      const { rows } = await root.query('SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = $1)', [name]);
      for (const { datname } of rows) await root.query(`DROP DATABASE ${ident(datname)} WITH (FORCE)`);
      return rows.length;
    }

    async function comment() {
      const { rows } = await root.query("SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1", [TEMPLATE]);
      return rows[0]?.comment ?? null;
    }

    // Each object in a copy still belongs to the role it was made by; this moves only what is inside it.
    async function reassign(database, from, to) {
      await inside(database, (c) => c.query(`REASSIGN OWNED BY ${c.escapeIdentifier(from)} TO ${c.escapeIdentifier(to)}`));
    }

    return {
      ensureUser: ({ name, password }) => ensureRole(name, password, { createdb: true }),

      /** @returns {Promise<object>}  what to log */
      async dropCopies(name) {
        return { droppedPostgres: await dropOwned(name) };
      },

      /** @returns {Promise<{ready: boolean, builtFrom: string|null, marker: string|null}>} */
      async template() {
        const isTemplate = await exists('SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate', TEMPLATE);
        const marker = isTemplate ? await comment() : null;
        if (!marker) return { ready: false, builtFrom: null, marker: null };
        try {
          return { ready: true, builtFrom: JSON.parse(marker).builtFrom ?? null, marker };
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          log('The Postgres template\'s comment is not one this task wrote, so it says no commit');
          return { ready: true, builtFrom: null, marker };
        }
      },

      /** @returns {Promise<object>}  what to log; never null, since the copy is one statement that sees no change midway */
      async copyTemplate(name) {
        const db = ident(name);
        await root.query(`CREATE DATABASE ${db} TEMPLATE ${ident(TEMPLATE)} OWNER ${db} ALLOW_CONNECTIONS true IS_TEMPLATE false`);
        // Nobody else's role may connect.
        await root.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
        // Every table, sequence and type in the copy still belongs to the template's role, which owns no database.
        await reassign(name, TEMPLATE, name);
        return {};
      },

      async dropAll(name) {
        if (!(await roleExists(name))) return;
        await root.query(`GRANT ${ident(name)} TO CURRENT_USER`);
        await dropOwned(name);
        await root.query(`DROP ROLE ${ident(name)}`);
      },

      /**
       * The next template, empty or as a copy of the current one, as the seeder's. A copy's objects pass from the
       * template's role to the seeder, so its migrations can alter them.
       */
      async prepareNext({ password, fromCurrent }) {
        if (!(await roleExists(TEMPLATE))) await root.query(`CREATE ROLE ${ident(TEMPLATE)} NOLOGIN`);
        await root.query(`GRANT ${ident(TEMPLATE)} TO CURRENT_USER`);
        await ensureRole(SEEDER, password, { createdb: false });
        const next = ident(TEMPLATE_NEXT);
        if (await databaseExists(TEMPLATE_NEXT)) await root.query(`DROP DATABASE ${next} WITH (FORCE)`);
        const source = fromCurrent ? ` TEMPLATE ${ident(TEMPLATE)} ALLOW_CONNECTIONS true IS_TEMPLATE false` : '';
        await root.query(`CREATE DATABASE ${next} OWNER ${ident(SEEDER)}${source}`);
        await root.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${next} FROM PUBLIC`);
        if (fromCurrent) await reassign(TEMPLATE_NEXT, TEMPLATE, SEEDER);
      },

      /** The seeded next template becomes the template, and its comment, written last, says it is ready. */
      async swapIn({ buildSha }) {
        const next = ident(TEMPLATE_NEXT);
        const live = ident(TEMPLATE);
        await root.query(`ALTER ROLE ${ident(SEEDER)} NOLOGIN`);
        // Root's first, so the REASSIGN below moves only what is inside it; then everything in it is the template role's.
        await root.query(`ALTER DATABASE ${next} OWNER TO CURRENT_USER`);
        await inside(TEMPLATE_NEXT, async (c) => {
          // A function's or a type's new owner needs CREATE on its schema, unless it is a superuser; tables skip the check.
          await c.query(`GRANT CREATE ON SCHEMA public TO ${live}`);
          await c.query(`REASSIGN OWNED BY ${c.escapeIdentifier(SEEDER)} TO ${live}`);
          await c.query(`REVOKE CREATE ON SCHEMA public FROM ${live}`);
        });
        if (await databaseExists(TEMPLATE)) {
          await root.query(`ALTER DATABASE ${live} WITH IS_TEMPLATE false`);
          await root.query(`DROP DATABASE ${live} WITH (FORCE)`);
        }
        await root.query(`ALTER DATABASE ${next} RENAME TO ${live}`);
        // Closed to connections, since a copy needs the template to have none.
        await root.query(`ALTER DATABASE ${live} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
        await root.query(`COMMENT ON DATABASE ${live} IS ${root.escapeLiteral(JSON.stringify({ builtFrom: buildSha, readyAt: new Date().toISOString() }))}`);
      },

      /**
       * Postgres lets every role connect to a new database and make temporary tables in it, and a database never takes
       * its template's permissions. Each copy here takes that away when it is made, but a session's own user makes
       * more (its tests' copies), which anyone's user could then connect to. No user can read another's tables there,
       * but it can see their schema and hold connections that stop a copy. Every run of this task closes them all.
       * @returns {Promise<{message: string, fields: {closed: number, stillOpen: string[]}}>}
       */
      async maintain() {
        const open = async () => (await root.query(
          "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND NOT (datname = ANY($1)) AND has_database_privilege('public', datname, 'CONNECT')",
          [OPEN_DATABASES],
        )).rows.map((r) => r.datname);
        const before = await open();
        // A database whose owner root is not a member of only warns, and stays open: it is named in the log.
        for (const name of before) {
          // A session's test run drops and makes its copies again at any moment: one gone since the SELECT is skipped.
          await root.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(name)} FROM PUBLIC`).catch((err) => {
            if (err.code !== UNDEFINED_DATABASE) throw err;
          });
        }
        const stillOpen = await open();
        const fields = { closed: before.length - stillOpen.length, stillOpen };
        return { message: stillOpen.length ? 'WARNING: some databases are still open to every user' : 'Closed databases to other users', fields };
      },

      close: () => root.end(),
    };
  }

  return { open };
}

export default Object.freeze({
  name: 'postgres',
  label: 'Postgres',
  // The db-admin task's entryPoint flags: the host, its root user, and the CA its certificate is checked against
  // (`none` for a server with no TLS). All or none.
  flags: ['pg-host', 'pg-root-user', 'pg-ca'],
  rootPassword: 'PG_ROOT_PASSWORD',
  // The project's own dependency the task borrows, from the database's `dir`.
  loadDriver: (require) => require('pg'),
  // The installation's, in a session's environment: where the server is. PGUSER and the rest come from the console.
  hostedIn: (env) => Boolean(env.PGHOST),
  // A database the environment names whole (the docker launcher): used as it is, and the console is not asked.
  givenIn: (env) => Boolean(env.PGPASSWORD),
  // What a question from Slack, which gets no database, has taken out of its environment.
  secretVariables: ['PGPASSWORD', 'PG_URL'],
  sessionEnv,
  seedEnv,
  viewers: [{ route: 'pg', port: 7685, name: 'Postgres', program: 'pgweb' }],
  startViewers,
  admin,
});
