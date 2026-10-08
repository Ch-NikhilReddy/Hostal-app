# Backup, restore, and migrations

Operational runbook for the HostelMitra database. Written for the case where something
has gone wrong and someone is reading this for the first time.

---

## 1. Backups

```
node scripts/db-backup.mjs          # take one
node scripts/db-backup.mjs --list   # what exists
node scripts/db-backup.mjs --prune  # apply retention
```

`pg_dump` runs inside the Postgres container, so no client is needed on the host.
Output is `api/backups/hostelmitra-<timestamp>.dump` in PostgreSQL custom format
(compressed, and restorable table-by-table if that is ever needed), with a `.json`
manifest beside it recording exact row counts per table.

**The manifest is not decoration.** It is what makes a restore checkable. Without it,
"the restore ran" and "the restore produced the data" are different claims and only the
first is easy to assert.

`api/backups/` is gitignored. A database dump in version control is a data leak
waiting to be found.

### Scheduling

Not automated yet, and that is a real gap. Until it is:

| Environment | How |
|---|---|
| development | on demand; the seed rebuilds anything worth keeping |
| staging | on demand before any risky change |
| production | **needs a decision — see §5** |

### Retention

| Rule | Value | Why |
|---|---|---|
| keep | 30 days | enough to notice a slow corruption |
| format | custom (`-Fc`) | compressed, selective restore |
| never prune the last N | 3 | so `--prune` cannot delete the only copy |

A production deployment should keep daily for 30 days and monthly for a year. That is a
storage-cost decision rather than a correctness one, and it is deliberately left open
rather than guessed at here.

---

## 2. Verifying a backup — do this, do not skip it

```
node scripts/db-backup.mjs --verify api/backups/hostelmitra-<timestamp>.dump
```

This restores into a **scratch database** (`hostelmitra_restore_check`), compares every
table's row count against the manifest, and drops the scratch database.

It never touches the live database. A restore that overwrites the only good copy turns a
backup into an outage, and the person doing the restore is by definition already under
pressure.

Exit code is non-zero if any table is missing or any count differs. Verified to fail
correctly:

```
  FAILED: docker exec ... exited 1: pg_restore: error: could not read from input file: end of file
```

That was a deliberately truncated dump. The live database was unaffected throughout.

**Verified working on this database:** 15 tables, all counts matching —
`beds 230 · bookings 16 · colleges 15 · hostels 29 · owners 7 · users 45 · payments 16 ·
room_types 18 · commission_configs 80 · refresh_tokens 281 · notifications 280 ·
otp_codes 4626 · booking_status_events 54 · owner_documents 2 · push_tokens 0`.

Note the counts come from `count(*)`, not `pg_stat_user_tables.n_live_tup`. The latter
is a planner estimate that reads `0` until `ANALYZE` has run, which would have let a
restore check pass against an empty database.

---

## 3. Recovering

There is no endpoint or script that restores over the live database, and that is
deliberate. Recovery is a human decision, made deliberately, with the current state
preserved first.

```bash
# 1. Preserve what is there now, whatever state it is in.
node scripts/db-backup.mjs

# 2. Verify the backup you intend to use, before you need it.
node scripts/db-backup.mjs --verify api/backups/hostelmitra-<timestamp>.dump

# 3. Restore it.
#    Deliberately a manual command with no wrapper: step 1 and step 2 must be
#    conscious choices, and a one-liner invites skipping both.
docker compose exec db psql -U hostelmitra -d postgres -c 'DROP DATABASE hostelmitra'
docker compose exec db psql -U hostelmitra -d postgres -c 'CREATE DATABASE hostelmitra'
docker cp api/backups/hostelmitra-<timestamp>.dump hostelmitra-db:/tmp/restore.dump
docker compose exec db pg_restore -U hostelmitra -d hostelmitra --no-owner --no-privileges --exit-on-error /tmp/restore.dump

# 4. Check the schema is in step with the code, then restart the API.
npm run db:migrate --workspace api
```

---

## 4. Migrations

The baseline is `api/prisma/migrations/0_init_baseline/`.

The schema was originally created with `prisma db push`, which writes directly to the
database and records nothing. That works fine in development and is catastrophic in
production: there is no history, no way to review what a deploy will do, and no way to
roll one back. Every `db push` is an unreviewed `ALTER TABLE`.

The baseline was established without touching data, by generating the full schema as
SQL and marking it applied:

```
prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
  > prisma/migrations/0_init_baseline/migration.sql
prisma migrate resolve --applied 0_init_baseline
```

Confirmed afterwards: `migrate status` reports "Database schema is up to date", and the
row counts are unchanged.

### Rules now in force

| Situation | Command |
|---|---|
| development, schema change | `npm run db:migrate --workspace api` (`migrate dev`) |
| **any deploy, including CI** | `npm run db:deploy --workspace api` (`migrate deploy`) |
| never in production | `db push`, `migrate dev`, `migrate reset` |

`migrate deploy` applies pending migrations and never prompts, which is what a deploy
needs. `db push` and `migrate dev` both prompt and both drop things when they disagree
with the migrations directory, which is exactly the wrong behaviour in production.

Migrations are checked in. Editing an applied migration is not allowed — it has already
run somewhere.

---

## 5. Open decisions

Stated rather than guessed at, because each one needs an account or a budget decision
that is not the engineer's to make.

| Question | Why it is not decided here |
|---|---|
| Where do production backups go? | Object storage needs a provider account. Local disk does not survive the host. |
| How often, and who is paged on failure? | A nightly job nobody is told about when it fails is not a backup. |
| Where does the app run? | Determines whether the container-based backup script is the right tool at all. |
| Who holds the Razorpay and MSG91 keys? | Needed for Phase 13 and for real SMS; see the final report. |