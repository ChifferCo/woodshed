# Plan: masked database snapshots for the template

Status: proposal. Nothing here is built yet.

## Why

Every session, QA included, works on a copy of a template that only the repo's `migrate` and `seed` commands build
(`session/dbAdmin.mjs`). Seeds are thin, and even a good one misses what only production-shaped data shows: legacy
rows that break today's assumptions, volume, odd combinations, a migration that fails on real rows. Those are the bugs
a reviewer cannot see in a diff, and the ones QA should catch.

A team can make a masked copy of production with a tool such as Greenmask, but Woodshed has nowhere to keep it, no way
to build the template from it, and its sessions would not know it is there. Restore a dump (`console/dbRestore.mjs`) is
one person's upload into their own databases, deleted once restored, and never reaches shared or QA sessions.

## Goal

A team's own job masks production and pushes the dump to Woodshed. Woodshed checks it, an admin accepts it, and the
template is built from it: the branch's migrations on top, then a small seed for the known QA logins. Every session
gets a copy as now, and is told what the data is.

## What stays true

- **No production credentials in Woodshed.** The masking job runs in the team's own infrastructure, with its own
  access, and only pushes. Woodshed never connects to production.
- **Sessions never touch the dump.** Only db-admin reads it, to build the template. A session gets its own copy of the
  template, as now, and no access to the snapshot store.
- **Nothing logs a value.** Checks and logs report tables, columns, counts and sizes, never a row.
- **The masking is reviewed code.** The Greenmask config lives in the team's repo. Woodshed can check it against the
  schema (phase 5), but it does not run it.

## The flow

```
team's CI (has prod access)          Woodshed console                    db-admin             sessions
greenmask dump  ── upload token ──▶  snapshot store (pending)
                                     check: format, restore, stats,
                                     PII scan
                                     admin accepts  ───────────────▶  restore into base
                                                                       migrate + QA seed
                                                                       → template ready ──▶ copy, plus a note
                                                                                           on what the data is
```

## Design

### 1. The project file

A database names a snapshot as where its template starts:

```yaml
databases:
  - engine: postgres
    dir: api
    migrate: npm run migrate
    seed: npm run seed:qa        # runs after the snapshot: QA logins and the few rows QA relies on
    migrationsTable: { table: public.knex_migrations, column: name }
    snapshot:
      # Default: 3. How many accepted snapshots the store keeps, the newest used, the others for going back.
      keep: 3
      # Default: null. The columns file phase 5 checks each snapshot against.
      columns: .woodshed/snapshotColumns.yaml
```

Postgres only at first. Greenmask also does MySQL, which Woodshed does not host. Mongo can follow with `mongodump`
and the team's own masking.

`migrationsTable` becomes required with `snapshot`: db-admin needs it to know which of the branch's migrations the
snapshot already has.

`shared/project.mjs` checks the new field; `project.reference.yaml` and docs/reference.md describe it.

### 2. The snapshot store

A store for each provider, behind one interface (`put`, `list`, `get` as a stream, `delete`), as
`providers/local/homeStore.mjs` is for Claude homes:

- **Local:** `<state dir>/snapshots/<project>/<id>.dump`, mode 600, owned by the console.
- **AWS:** a bucket of its own, `<prefix>-snapshots-<account id>`, with SSE-KMS, public access blocked and no
  versioning (the store keeps its own `keep`). The console's role may put, list and delete; db-admin may get. No
  session can reach it: sessions have no task role.

`state.json` keeps, under `snapshots.<project>`, each snapshot's id, when and how it came (`upload token <name>` or
`<login>`), its size, the check's result (tables, row counts, the scan's findings by column), its status (`pending`,
`checking`, `refused`, `ready to accept`, `accepted`, `superseded`) and who accepted it. Never a value.

### 3. Getting a dump in

Two ways, both on the repo's settings page (`/console-settings/repos/<project>`, a new **Snapshot** tab):

- **Upload by hand,** for an admin's first try: the page streams the file to the store, as Restore a dump does, never
  through the console's memory (its container has 512 MB on AWS).
- **An upload token for CI:** an admin makes one on the tab, named (`nightly greenmask`). It is shown once, kept as a
  hash, may only upload snapshots for that one repo, and can be revoked. The team's job runs:

  ```bash
  greenmask --config greenmask.yml dump
  tar -C <dump dir> -cf - . | curl -sf -K - -T - https://<console>/api/snapshots/<project> <<< "header = \"Authorization: Bearer $WOODSHED_SNAPSHOT_TOKEN\""
  ```

  On AWS the console answers with a pre-signed S3 upload instead of taking the bytes, so large dumps never pass
  through the base box.

Accepted formats: `pg_dump -Fc` and a tar of a `pg_dump -Fd` directory. To verify before building: whether a Greenmask
dump restores with `pg_restore` alone, or needs `greenmask restore` in the image (see Open questions).

### 4. Checking a dump

The console, or a db-admin run on AWS, takes a pending snapshot through:

1. **Format:** a dump `pg_restore -l` can list.
2. **Restore:** into a scratch database (`woodshed__snapshot_check`), dropped afterwards. A restore that fails is
   refused with `pg_restore`'s error, which names objects, never rows.
3. **Stats:** the tables, each one's row count and size, and the migration the snapshot is at (the last row of
   `migrationsTable`).
4. **PII scan:** a sample of each text column (1,000 rows), checked for real-looking emails (any domain but
   `example.com`, `.test`, `.invalid`, `.example` and the columns file's `fakeDomains`), phone numbers, Luhn-valid card
   numbers outside the published test numbers, and national ID shapes. Findings are listed by column with counts.

The tab shows the result. **Accept** needs a typed confirm, and an extra one when the scan found anything. The first
accepted snapshot, and each later one, starts a template rebuild.

### 5. Building the template from it

db-admin gets a two-stage build, so a branch change does not restore a big dump again:

1. **Base:** on a new accepted snapshot, restore it into `woodshed__base`. Mark it with the snapshot's id.
2. **Template:** copy the base (`CREATE DATABASE … TEMPLATE woodshed__base`, fast), run the migrations the snapshot
   does not have (by `migrationsTable`), then `seed`. Swap it in as now.

`templateDecision` gains one reason: `rebuild` when the accepted snapshot differs from the one the template was built
from. A change to `paths` rebuilds from the base, never by restoring again. The template's marker records the snapshot
id beside the commit.

A migration that fails on the snapshot fails the build with the migration's error, and the old template stays. That is
itself a finding worth showing: the repo's tab says the default branch's migrations fail on production-shaped data.

### 6. Telling sessions

The console's databases answer to a session gains `snapshot`: its id, when it was taken, who accepted it, its table
count and row total. The entrypoint adds a paragraph to the environment notes (`/tmp/woodshed-setup.md`):

> This database is a masked snapshot of production from 2026-11-16, accepted by an admin: 48 tables, about 2.1M rows.
> Personal data in it is fake. Odd rows may be real production shapes: do not "fix" them as bad seed data. QA logins
> are in `.woodshed/qa.md`.

`shared/qa/plan.txt` gets the same paragraph in its context, so QA plans for volume and legacy rows. The session's
Data ▾ menu says `snapshot of 2026-11-16`.

Private sessions get it too: their owner's databases are copies of the same template. Restore a dump stays as it is.

### 7. The columns check (phase 5)

`.woodshed/snapshotColumns.yaml` lists every column of the schema as `keep`, `masked` or `dropped`, and the
`fakeDomains` the masking writes. A check Woodshed ships (`shared/snapshotColumns.mjs`) compares it with the schema
after migrations: a column the file does not list fails it. Two places run it:

- the repo's CI, on each pull request that adds a migration, so new personal data cannot slip past the masking;
- the accept step, against the snapshot's own columns, so a snapshot with an unclassified column cannot be accepted.

The check reads the Greenmask config to warn when a column the file calls `masked` has no transformer.

## Phases

Each phase is its own pull request, proven in the dev console and with a sample dump made by Greenmask from a made-up
database (never real data).

1. **Store and upload by hand.** The local store, the Snapshot tab, upload, the format and restore check, stats, the
   PII scan, accept. Proven on the local provider and the dev console.
2. **Template from the snapshot.** The base and template stages in `dbAdmin.mjs` and the local runner, the new
   `templateDecision` reason, the marker. Proven by a template build whose copy has the snapshot's rows and the
   branch's newer migrations.
3. **Sessions know.** The `snapshot` field, the environment notes paragraph, QA's plan context, Data ▾. Proven in a
   session's notes and a QA plan.
4. **Upload tokens.** Tokens on the tab, `POST /api/snapshots/<project>`, a sample workflow for the team's CI in
   docs/reference.md.
5. **AWS.** The bucket and roles in Terraform, pre-signed uploads, db-admin's read, the check in a db-admin run.
   Proven with `terraform plan` and a run in a test account.
6. **The columns check.** `snapshotColumns.yaml`, the shipped check, accept blocking on unclassified columns.

Each phase updates docs/reference.md, console/README.md, `project.reference.yaml`, and CLAUDE.md's "By symptom" with
the log lines it adds (`snapshots: uploaded`, `checked`, `refused`, `accepted`, `databases: base restored`).

## Open questions

- **Greenmask's format.** Does its dump restore with `pg_restore`, or must the image carry `greenmask restore`? Try it
  in phase 1 before the format check is written.
- **Size.** What dumps do teams have? The restore time decides whether the base stage is enough or the check must
  sample instead of restoring whole. A limit per project (say 20 GB) to start.
- **Who accepts.** Admins only, or a per-repo "data owner"? Automatic accept when the scan finds nothing and the
  columns check passes?
- **db-admin's access on AWS.** A task role with read on the bucket, or a short-lived pre-signed URL in the run's
  overrides (visible to anyone who can describe the task)? The role is safer.
- **Prod-shaped synthetic data as a lighter option:** a script that reads only aggregates from production (row counts,
  null rates, enum frequencies) to steer a synthetic seed. Out of scope here; worth its own plan if teams cannot run
  masking.
