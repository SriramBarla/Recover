-- 0001 extensions and schemas (§7; 05 migration plan).
set lock_timeout = '5s';
set statement_timeout = '60s';

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists supabase_vault with schema vault;
-- The cron drain calls the worker with the synchronous http extension (0450). Its functions live in
-- `extensions`, where the login roles have no USAGE, and it keeps no tables.
create extension if not exists http with schema extensions;
-- pg_net stays off. Its `net` schema and request queue keep PUBLIC grants that the migration role cannot
-- revoke, so recover_web/recover_worker could send HTTP from the database and read queued request headers,
-- including the scheduler bearer. The drop covers a project where it was enabled in the dashboard.
drop extension if exists pg_net;

-- Helpers that are never part of the callable surface live in `private`.
create schema if not exists private;
revoke all on schema private from public;
