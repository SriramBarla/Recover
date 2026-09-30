-- 0999 runs after every function family (F-94, G-21): nothing in public or private is reachable by
-- PUBLIC or by the Supabase Data API roles, even if the Data API is re-enabled later.
set lock_timeout = '5s';
set statement_timeout = '60s';

revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated, service_role;
revoke all on schema private from anon, authenticated, service_role;

-- The function owners needed CREATE only to receive ownership during migrations (see 0002).
revoke create on schema public, private from recover_api_owner, recover_system_owner, recover_attestation_owner;
