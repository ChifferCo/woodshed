# Plan: a team template from a restored dump

Status: proposal. Nothing here is built yet. This replaces a first draft that proposed a snapshot store and upload
pipeline of its own; "What changed from the first draft" says why.

## Why

Every session, QA included, works on a copy of a template that only the repo's `migrate` and `seed` commands build
(`session/dbAdmin.mjs`). Seeds are thin, and even a good one misses what only real data shows: legacy rows that break
today's assumptions, odd combinations, a migration that fails on old rows. Those are the bugs a reviewer cannot see in
a diff, and the ones QA should catch.

Restore a dump (My settings → Your databases, `console/dbRestore.mjs`) already takes one person's dump into a copy
beside their database, checks it, and applies it. It never reaches anyone else. This plan lets a repo's data owner
turn such a copy into the base every session's template is built from.

## Alternatives first

Most teams should not need this. Before it, in order:

1. **A better seed.** A seed written against the bugs the team has had: the legacy shapes, the nulls, the old enum
   values. It is reviewed code, holds no one's data, and every session gets it today.
2. **Production-shaped synthetic data.** A script the team runs against production that reads aggregates only (row
   counts, null rates, enum frequencies, length distributions) and writes a seed that matches them. No row leaves
   production. Worth its own plan.

This feature is for a team whose bugs come from real legacy data that neither can reproduce, and that has someone
who can decide what of production may leave it: the data owner below.

## What changed from the first draft

- **No parallel pipeline or store.** The first draft added an upload API, a token for CI, a snapshot bucket and a check
  step. Restore a dump already has the upload (2 GB, pg_dump 16's custom format), the copy, the checklist, the
  migration comparison and `databases[].dump`'s `skip` and `extensions`. Promote is one step on top of it.
- **Repo code was not kept off the raw data.** db-admin runs the repo's `migrate` and `seed` as its own user
  (`seedWith`: "Not a boundary"), so "only db-admin reads the dump" did not hold. Here the step that reads the
  restored copy runs no repo code (design 3).
- **A regex PII scan is false assurance.** It misses jsonb, free text and rare rows, and says nothing of credentials in
  rows: customers' OAuth and refresh tokens, API keys, webhook secrets, password hashes. It is gone. A columns file
  classifies every column instead (design 1). It advises; it does not decide.
- **Any admin with a typed confirm is not a decision about production data.** A per-repo data owner promotes (design 3,
  Governance).
- **Size was not budgeted.** RDS on the default install is `db.t4g.micro` with 20 GB (`database.tf`), and every copy
  (`copyTemplate` in `shared/databases/postgres.mjs`, `CREATE DATABASE … TEMPLATE`) is a full copy. A size budget is
  part of the design (design 2).
- **Migration state was assumed simple.** Production can be ahead of the default branch, or hold DDL no migration made;
  today's fallback when migrating a copy fails is to build from empty, which is wrong for a base (design 4).
- **Smaller:** the base was restored twice (check, then build); a new database is open to `PUBLIC` until `maintain`
  unless revoked when made; Postgres errors quote values in `DETAIL` (`Key (email)=(…)`); pending and refused dumps had
  no retention, and a deletion request no answer.

## What stays true

- **Woodshed never connects to production.** The dump is made by the team, with its own access, and uploaded through
  Restore a dump as now.
- **Masked is the recommended path.** Woodshed offers masking first and warns plainly when a copy looks unmasked. If the
  data owner promotes unmasked data anyway, that is their choice: Woodshed records it and tells every session.
- **Nothing logs a value.** Checks, logs and records hold table and column names, counts and sizes, never a row. The
  restore's own errors stay on the page, never in the log, as today.
- **One base per installation.** Promoting replaces it; the old one is dropped.

## The flow

```
data owner's machine          console (as the owner's user)        db-admin (root)             sessions
pg_dump -Fc of a masked,  ──▶ Restore a dump: send, check,
subsetted copy                copy, restore, count, columns check
                              Promote (warnings, typed confirm) ──▶ promote: copy, reassign,
                                                                    no repo code
                                                                    template: copy base,
                                                                    migrate, base seed      ──▶ copy, plus a note
                                                                                                on what the data is
```

## Design

### 1. The columns file

`.woodshed/columns.yaml` in the repo classifies every column of every table the migrations make:

```yaml
public.users:
  id: keep
  email: fake email
  display_name: fake name
  password_hash: secret
  created_at: keep
public.events:
  kind: keep
  payload: null
public.audit_log: { rows: none }   # the table's rows are left out, as databases[].dump.skip does
```

- `keep`: copied as it is. `fake <kind>`: replaced by a made-up value of that kind (`email`, `name`, `phone`, `text`).
  `null`: emptied. `secret`: must be emptied, and the check says so loudest when it is not.
- A column the file does not list is emptied by the masking (null, or its type's zero value when it is `NOT NULL`).
  The default is deny.
- `{ rows: none }` on a table is the same as listing it in `databases[].dump.skip`; the check says when the two
  disagree.

A new `shared/columns.mjs` reads the file and runs in three places. It only ever advises: it warns and says what is at
risk, and never refuses a restore, an Apply or a Promote.

- **In the repo's CI**, after migrations on an empty database: `node shared/columns.mjs check` lists columns the file
  does not name and columns whose name looks like a credential (`token`, `secret`, `password`, `api_key`, `hash`)
  classified `keep`. A team that wants its CI to fail on them passes `--strict`; that is the team's rule, not
  Woodshed's.
- **After every restore** of Postgres (design 6), the console runs it against the copy's own columns
  (`information_schema.columns`, as the person's user) and counts, for each `secret` and `null` column, the rows that
  still hold a value: `count(*) … WHERE col IS NOT NULL`, never the values. A column the copy has and the file lacks
  is how DDL made outside the migrations shows.
- **At Promote**, again, on the copy about to be promoted, so the warnings are current.

The result goes in the restore's `summary` beside `tables`, `rows`, `top` and `newest`: `columns: { file, unclassified,
secretsWithValues, nullsWithValues, unknownTables }`, names and counts only.

`shared/columns.mjs mask-sql` writes the masking as SQL from the file, for the recipe in design 6. Teams already on
Greenmask keep their config; the check reads only `columns.yaml`.

### 2. Subsetting and the size budget

A promoted base is copied whole for the template, the next template while it builds, every person's database and their
restore copy and backup, and every shared session, kept ones included. On the default AWS install that is one 20 GB
RDS volume for all of them. With a base of size B, it needs about:

- 3B for the base, the template and the next template;
- B for each person with own databases, and 2B more while one restores and applies;
- B for each shared session, running or kept (kept up to 14 days after it stopped, by Console settings' defaults).

Ten people and ten kept sessions need about 25B, so the default 20 GB holds a base of about 700 MB, and less with
WAL and free space for `VACUUM`. The base box's 20 GB data volume (`baseBox.tf`) holds the dump file during a restore
(up to `MAX_DUMP_BYTES`, 2 GB) beside Mongo and the console's state; it does not hold copies.

So:

- **A budget, on Console settings:** the largest base Promote takes, as `pg_database_size` of the copy. Default 500 MB.
  A copy over it is refused with its size and the budget: this is capacity, not a judgment of the data, and an admin
  may raise it.
- **Subsetting is part of the recipe.** The card's commands (design 6) take a subset before the dump: the team's own
  conditions (recent accounts and what they point at), or Greenmask's subset settings. `dump.skip` leaves out tables
  whose rows nobody needs (logs, events).
- **Raising it is a Terraform change.** `allocated_storage` in `database.tf` is fixed today; this plan adds a variable
  for it and for `max_allocated_storage`, and docs/reference.md says what the budget needs of them. RDS storage is
  billed per GB-month, and `budget.tf`'s alarm should be checked when it is raised. `db.t4g.micro` (1 GB of memory)
  copies by file, so a bigger base costs I/O time on each copy rather than memory.
- **Time.** The restore has 2 hours (`RESTORE_TIMEOUT_MS` in `console/restoreRunners.mjs`). A clone task has 30
  minutes before the console calls it failed (`TASK_TIMEOUT_MS` in `console/databases.mjs`), which a base within the
  budget copies in well under.

### 3. The data owner and Promote

**The data owner** is a per-repo role, named by an admin on the repo's settings page
(`/console-settings/repos/<project>`): one or more logins, kept in `state.json` under `dataOwners.<project>`. An admin
is not a data owner unless named. Only a data owner sees Promote, and only for the installation's default project,
since there is one template per installation (`--project` on db-admin).

**Promote** is a button on a data owner's Your databases card once a Postgres restore is `ready` (restored, not
applied). Before it the page shows what is in the copy and what promoting means:

- the summary: tables, rows, the biggest tables, the newest migration and how many of the default branch's it lacks
  or has beyond them (design 4);
- the columns check's warnings, by column name and count;
- that every session, person and QA run will hold these rows, that agents read them and send what they read to
  Anthropic's API, and may quote them into commits, fixtures, pull request bodies, QA comments and Slack. On a public
  repo the page says that pull requests and QA comments are public.

The confirm is typed: `promote`, or `promote with warnings` when the check warned. The choice is recorded in
`state.json` under `templateBase`: `{ promotedBy, promotedAt, fromRestore: { fileName, bytes, finishedAt }, tables,
rows, columns, migrations, warningsAcknowledged }`. No values. The console logs `templateBase: promoted` with the same
fields.

**The promote step runs no repo code.** It is a new db-admin action, `promote <login>` (beside `template`, `reset`,
`clone` in `ACTIONS`, `session/dbAdmin.mjs`), that runs SQL alone, as root, and never calls `seedWith`:

1. Close the person's connections to `woodshed_<login>__restore` (the owner's sessions' pgweb may hold one).
2. `CREATE DATABASE woodshed__base_next TEMPLATE woodshed_<login>__restore`, root being made a member of the person's
   role first, as `dropAll` does, then `REVOKE CONNECT, TEMPORARY … FROM PUBLIC` in the same step, as `copyTemplate`
   and `prepareNext` do, so it is never open until `maintain`.
3. Inside it, reassign what the person's user owns to the template's role (`woodshed__template`), as `swapIn` does
   with its `GRANT CREATE ON SCHEMA public` around the `REASSIGN OWNED`. The restore ran with `--no-owner --no-acl`, so
   the person's user owns everything and holds no grants; a query for anything still owned by another role fails the
   step.
4. Compare the table count and row total with the restore's summary: a copy the owner's sessions changed since is
   promoted only after a second confirm.
5. Swap it in as `woodshed__base`, drop the old base, and comment the database with `{ promotedAt, by }`, as the
   template's marker is written. Drop the person's restore copy.

Then the console starts a `template` run, which builds from the new base (design 4).

The data in the base is no harder to reach for repo code than the template is: the template build's `migrate` and
seed run with the root password reachable (`seedWith`'s note), and every session gets a copy anyway. What this step
guarantees is that nothing the repo ships runs while the restored copy is read and its ownership moved.

### 4. The template build on a base, and migration state

The project file's database gains `base`:

```yaml
databases:
  - engine: postgres
    dir: api
    migrate: npm run migrate
    seed: npm run seed                 # on an empty database, as now
    migrations: api/migrations
    migrationsTable: { table: public.knex_migrations, column: name }
    base:
      seed: npm run seed:on-base       # after migrations on the base: QA logins and the few rows QA relies on
      columns: .woodshed/columns.yaml
```

`base.seed` must be additive and safe to run on real rows: upserts by natural key, ids from sequences, never fixed
ids that collide with the base's. A seed written for an empty database does not run on a base. Without `base.seed`,
nothing is seeded. `migrationsTable` and `migrations` are required with `base`. `shared/project.mjs` checks it;
`project.reference.yaml` and docs/reference.md describe it.

With a base, db-admin's `template` run builds the next template by `prepareNext` copying `woodshed__base` instead of
making an empty one, then runs `migrate` and `base.seed` as the seeder. `templateDecision` takes the base's marker:
a base promoted since the template was built is `rebuild` (from the base); a change of `paths` that today rebuilds
from empty rebuilds from the base instead. The template's marker records the base's `promotedAt` beside the commit.

Migration state, from the copy's `migrationsTable` against the default branch's `migrations` folder (the comparison
`lackingMigrations` and `migrationStem` already make in `console/dbRestore.mjs`):

- **Behind** (the copy lacks some of the branch's migrations): the normal case. The build runs them.
- **Ahead** (the copy has migrations the branch does not): some tools refuse (knex: "migration directory is corrupt"),
  others skip them. Promote warns, naming how many; the build tries, and a failure is handled as below.
- **Diverged** (DDL no migration made): the columns check shows it as unknown tables and columns. Promote warns; the
  build tries.

**A failing migration or base seed keeps the old template.** Today's fallback when migrating a copy fails is to build
from empty (`Migrating the copy failed, building the template again` in `dbAdmin.mjs`): with a base, it rebuilds from
the base once, and when that fails too, the run stops, the old template stays, and the template is not marked with the
new commit. The console shows it to the data owners on their card and on the repo's settings page, with the failing
step. The commands' output goes to the db-admin log as now, which can quote rows in `DETAIL` lines: with a base, the
run drops lines starting `DETAIL:` from what it logs. That is best effort, since a repo's tool may print values its
own way; docs/reference.md says the db-admin log stream then holds production data, kept 14 days
(`retention_in_days` in `ecs.tf`).

### 5. Telling sessions and QA

The console's databases answer to a session gains `base`: `{ promotedAt, by, tables, rows, warningsAcknowledged }`.
The entrypoint adds a paragraph to the environment notes (`/tmp/woodshed-setup.md`):

> This database is built from production data a data owner chose on 2026-11-16: 48 tables, about 400,000 rows. Woodshed
> recommends masked data; this one was promoted with 2 warnings about unmasked columns. Treat every row as real. Do not
> copy rows into fixtures, commits, pull requests, QA comments or Slack: write made-up values with the same shape.
> Odd rows may be real legacy shapes: do not "fix" them as bad seed data.

The wording without warnings says the masking the columns check found. `shared/qa/plan.txt` gets the same paragraph
in its context, so QA plans for legacy rows and writes no row into its report. Data ▾ says `built from production data
of 2026-11-16`.

### 6. A safer Restore a dump

The card today offers `pg_dump --format=custom --no-owner --no-privileges --no-comments` first. It changes to:

- **Lead with the team's template.** "Your databases start as a copy of the team's template", with its source: the
  seed at a commit, or the base promoted by a data owner on a date, and whether it was promoted with warnings.
- **Masking first.** With a columns file, the first recipe restores the production dump into a throwaway `postgres:16`
  container, applies the subset and `node shared/columns.mjs mask-sql`'s SQL, and only then runs pg_dump. The plain
  pg_dump stays, second, under "Without masking".
- **The columns check on every restore,** shown in the summary with the warnings, and the same notice before Apply on
  a personal restore: rows reach your private sessions' agents and Anthropic's API.
- Mongo keeps today's card. Promote is Postgres only at first.

## Governance

- **docs/reference.md, "What a session can reach",** says sessions never have production data. It changes on purpose,
  in the phase that ships Promote, to: sessions may hold production data when a repo's data owner promoted it into the
  template, and are told so; Woodshed recommends masked, subsetted data and warns when it is not.
- **CLAUDE.md's first rule** forbids production credentials in a session. Credentials in rows (customers' tokens,
  API keys, webhook secrets, password hashes) are that. The rule gains a sentence: a data owner's promoted base is the
  one way production rows reach a session; the `secret` class is how credentials in rows are kept out, and promoting
  with a `secret` column holding values is the data owner's recorded choice against Woodshed's advice.
- **The data owner** is a per-repo role, not admin. Promote, the warnings acknowledged, and who named the owner are all
  recorded and logged (`dataOwners: changed` with `by`).
- **Public repos** are not blocked. The warning before Promote says plainly that pull requests and QA comments there are
  public.
- **Anthropic's API.** What an agent reads is sent to Anthropic's API, through the console's proxy or the owner's own
  token. Whether that is allowed is the team's agreement with Anthropic and its own policy, which the data owner
  answers for.
- **Retention.** The uploaded dump is deleted once restored, as now. Promote drops the restore copy and the old base.
  There is one base. Copies made from an older base live on in people's databases until Reset my data, and in shared
  sessions until they are cleaned up.
- **Erasure.** A deletion request is honoured by promoting a new dump without the subject, then resetting every copy
  made before it: the repo's settings page lists the people and kept sessions whose databases predate the base, with
  **Reset all**. Claude homes in S3 (transcripts) and the db-admin log can hold rows a session read: the page says so,
  and how to delete them. Commits, pull requests, QA comments and Slack messages are out of Woodshed's reach.

## Phases

Each phase is its own pull request, proven with a made-up database and a dump of it (never real data), in the dev
console and on the local provider.

1. **The columns file and check.** `shared/columns.mjs` (`check`, `--strict`, `mask-sql`), its CI usage in
   docs/reference.md, and the check in every Postgres restore's summary. Advisory only.
2. **Budget and data owner.** The Console settings budget, `dataOwners` on the repo's settings page, the Terraform
   variables for RDS storage.
3. **Promote.** db-admin's `promote <login>`, the warnings page, the typed confirm, `templateBase` in `state.json`.
   Proven by a base whose objects the template's role owns and that `PUBLIC` cannot connect to.
4. **The template on a base.** `base` in the project file, `prepareNext` from the base, `templateDecision`'s new
   reason, migration states, keeping the old template on failure, dropping `DETAIL` lines. Proven by a base behind
   the branch, one ahead, and one whose base seed fails.
5. **Sessions know.** `base` in the databases answer, the environment notes paragraph, QA's context, Data ▾. Proven in
   a session's notes and a QA plan.
6. **The card.** Template first, the masking recipe, the notice before Apply.

The docs/reference.md and CLAUDE.md changes in Governance ship with phase 3. Each phase adds its log lines to CLAUDE.md's
"By symptom" (`templateBase: promoted`, `promote refused` with the size, `databases: template kept, the base build
failed`).

## Open questions

- **Greenmask.** Does its dump restore with pg_restore 16 alone? If not, its output goes through the throwaway
  container's pg_dump, as the masking recipe does.
- **A real seed boundary.** The base seed runs with root's password reachable. Running it as another OS user, or in a
  task without root's password, would make that a boundary for every template, not only this one.
- **The owner's restore copy before Promote** is reachable from their private sessions (pgweb's `restored-copy`
  bookmark, `shared/databases/postgres.mjs`). Should a copy meant for promotion be kept from sessions until then?
- **Ahead migrations.** Refuse Promote for tools known to fail on them, or always let the build try?
- **Mongo.** `mongodump` and the team's own masking, the same promote, later.
- **More than one project.** One template per installation today; a base per project follows if templates do.
