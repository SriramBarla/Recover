-- 0002 roles (§7.5, F-68, F-114, F-115; G-20, G-21).
-- Login roles are created WITHOUT passwords. Local development sets throwaway passwords in seed.sql;
-- staging/production passwords are set by the migration operator and never live in the repository.
set lock_timeout = '5s';
set statement_timeout = '60s';

do $$
begin
  if not exists (select from pg_roles where rolname = 'recover_api_owner') then
    create role recover_api_owner nologin nobypassrls noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'recover_system_owner') then
    create role recover_system_owner nologin nobypassrls noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'recover_attestation_owner') then
    create role recover_attestation_owner nologin nobypassrls noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'recover_web') then
    create role recover_web login nobypassrls noinherit connection limit 40;
  end if;
  if not exists (select from pg_roles where rolname = 'recover_worker') then
    create role recover_worker login nobypassrls noinherit connection limit 20;
  end if;
end
$$;

-- The migration role must be able to transfer function ownership to the NOLOGIN owners.
grant recover_api_owner, recover_system_owner, recover_attestation_owner to postgres;
-- SQL test suites run as postgres and switch to the login roles to exercise real privileges.
grant recover_web, recover_worker to postgres;
-- ALTER ... OWNER TO requires CREATE on the schema for the new owner. Granted only while the function
-- families are being created; 0999_final_revokes.sql removes it again (final state: no CREATE).
grant create on schema public, private to recover_api_owner, recover_system_owner, recover_attestation_owner;

-- G-20: statement timeouts are role-level (a SET inside a function cannot bound the running statement).
alter role recover_web set statement_timeout = '8s';
alter role recover_web set lock_timeout = '3s';
alter role recover_web set idle_in_transaction_session_timeout = '15s';
alter role recover_worker set statement_timeout = '60s';
alter role recover_worker set lock_timeout = '5s';
alter role recover_worker set idle_in_transaction_session_timeout = '30s';

grant usage on schema public to recover_web, recover_worker, recover_api_owner, recover_system_owner, recover_attestation_owner;
grant usage on schema private to recover_api_owner, recover_system_owner, recover_attestation_owner;
grant usage on schema extensions to recover_api_owner, recover_system_owner, recover_attestation_owner;

-- G-21: Supabase grants new public objects to its API roles through default privileges.
-- Strip them for everything the migration role creates from here on (re-asserted in 0999).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role, public;
alter default privileges for role postgres in schema private revoke all on functions from public;
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
