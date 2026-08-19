-- ─────────────────────────────────────────────────────────────────────────────
-- Family App — first-boot database bootstrap.
--
-- Executed by the postgres entrypoint EXACTLY ONCE, when the data volume is
-- empty, as the superuser against $POSTGRES_DB. Editing this file has no effect
-- on an existing volume — anything that must change later belongs in a drizzle
-- migration, not here.
-- ─────────────────────────────────────────────────────────────────────────────

-- pgcrypto: gen_random_uuid() for every `id uuid primary key default random()`
-- column, plus digest()/hmac() for the refresh-token hashing helpers.
--
-- Postgres 13+ ships gen_random_uuid() in core, so this is strictly speaking
-- belt-and-braces for that one function. It is kept because drizzle emits
-- `gen_random_uuid()` and because pgcrypto is what actually provides
-- digest()/encode() if a migration ever needs to hash server-side.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- citext: case-insensitive text. Worth having for `users.email` — nobody should
-- be able to register Ivan@example.com after ivan@example.com exists, and a
-- citext column enforces that in the UNIQUE index instead of in application
-- code that someone will forget to call.
--
-- Caveat for whoever writes the schema: citext comparison is locale-dependent
-- for non-ASCII, and D3 says email is NEVER a join key (the key is always
-- (provider, provider_sub)). So use citext for the uniqueness guarantee, not as
-- an identity.
CREATE EXTENSION IF NOT EXISTS citext;

-- btree_gin: lets a GIN index mix a scalar column with an array/jsonb column in
-- one index — needed for the activity log and for permission_grants/denies
-- text[] lookups filtered by user.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- pg_trgm: trigram similarity for the shopping-list / task quick-search boxes.
-- Cheap to have, impossible to add without a lock later on a busy table.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Session defaults ────────────────────────────────────────────────────────
-- UTC, deliberately, even though the family lives in Europe/Moscow.
--
-- Per docs/DECISIONS.md D2 the app stores a floating local wall-clock string
-- plus an IANA timezone id, and resolves instants in application code with
-- Temporal. The database must therefore never apply a timezone of its own:
-- a server default of 'Europe/Moscow' would silently rewrite every
-- `timestamptz` -> `timestamp` cast in a psql session or an ad-hoc report and
-- make DST bugs look like data bugs. UTC keeps the DB boring and truthful.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
  EXECUTE format('ALTER DATABASE %I SET datestyle TO %L', current_database(), 'ISO, YMD');
  EXECUTE format('ALTER DATABASE %I SET intervalstyle TO %L', current_database(), 'iso_8601');
  -- Kill a statement that has been running for two minutes: a runaway report
  -- must not hold locks that block a migration.
  EXECUTE format('ALTER DATABASE %I SET statement_timeout TO %L', current_database(), '120s');
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout TO %L', current_database(), '60s');
END
$$;

SET timezone TO 'UTC';

-- ── Template database ───────────────────────────────────────────────────────
-- Integration tests create throwaway databases with `CREATE DATABASE x`, which
-- clones template1. Installing the extensions there too means a test database
-- is usable the moment it is created, with no per-test bootstrap step.
\connect template1
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
