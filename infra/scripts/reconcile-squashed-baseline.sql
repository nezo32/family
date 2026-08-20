-- One-time reconciliation for the squashed migration baseline.
--
-- WHY THIS EXISTS
--
-- Removing the score system regenerated the migration set from scratch into a
-- single `0000_initial_schema`. That is fine for a database created after the
-- change and fatal for one created before it: Drizzle records a hash per
-- migration, the regenerated baseline hashes differently, so it is treated as
-- unapplied and replayed from the top — landing on
-- `type "user_role" already exists` before it changes anything.
--
-- Production's schema was compared object-by-object and column-by-column
-- against a database migrated purely from the new baseline. The entire
-- difference is the score-era objects below; nothing was missing from
-- production. So bringing it to the baseline means dropping exactly these, then
-- recording the new hash against the migration that is now, in effect, applied.
--
-- The dropped rows are the score data itself — points and streaks — which the
-- product deliberately no longer has (see D5 in docs/DECISIONS.md). Take a
-- backup first anyway; `infra/scripts/backup.sh` is the one to run.
--
-- Safe to re-run: every statement is guarded.

BEGIN;

-- Score tables. `CASCADE` is not used: if anything unexpected still references
-- these, the transaction should fail loudly rather than quietly widen.
DROP TABLE IF EXISTS "public"."points_ledger";
DROP TABLE IF EXISTS "public"."user_streaks";

DROP TYPE IF EXISTS "public"."points_reason";

ALTER TABLE "public"."task_series"      DROP COLUMN IF EXISTS "points";
ALTER TABLE "public"."task_occurrences" DROP COLUMN IF EXISTS "points_override";
ALTER TABLE "public"."chore_swaps"      DROP COLUMN IF EXISTS "bonus_points";

-- Re-stamp the baseline.
--
-- `created_at` is the field that actually decides. Drizzle's migrator does not
-- compare hashes to choose what to run: it takes the newest `created_at` in
-- this table and applies every journal entry whose `when` is greater. The
-- regenerated baseline carries a newer `when` than the row production already
-- had, so it was replayed no matter what the hash said — which is why fixing
-- only the hash changed nothing.
--
-- There is exactly one migration in this project, so this updates the single
-- row rather than inserting; inserting would leave the older row as well and
-- change nothing about the comparison.
UPDATE "drizzle"."__drizzle_migrations"
   SET "hash"       = '2daa99d1dd9dfff6b7bb36b30c198b1122bdd723dd46d2ff35f7d9625fc248fd',
       "created_at" = 1787178882529
 WHERE "created_at" = 1787174177346;

COMMIT;
