-- 0001 extensions and schemas (§7; 05 migration plan).
set lock_timeout = '5s';
set statement_timeout = '60s';

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

-- Helpers that are never part of the callable surface live in `private`.
create schema if not exists private;
revoke all on schema private from public;
