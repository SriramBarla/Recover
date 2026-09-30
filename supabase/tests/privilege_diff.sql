-- privilege_diff.sql: role attributes and privilege boundaries (§7.5, F-114, F-115, D-14, G-21).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/privilege_diff.sql
-- Read-only catalog checks inside a transaction that is rolled back. Prints the api-owner and system-owner table
-- privilege sets and fails on any shared privilege outside the reviewed allowlist below.
\set ON_ERROR_STOP 1
\set QUIET 1
begin;

create temp sequence t_checks;
create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'privilege_diff.sql FAILED: %', p_label;
  end if;
  perform nextval('pg_temp.t_checks');
end $$;

-- Reviewed overlap between recover_api_owner and recover_system_owner (the spec's minimum is jobs/audit_log
-- INSERT; every other row is a table both families legitimately touch). Anything not listed here fails the test.
create temp table t_allowed_overlap (relname text primary key, privs text[] not null, reason text not null);
insert into t_allowed_overlap values
  ('audit_log',              '{INSERT}',                 'both families append audit rows; nobody may UPDATE/DELETE'),
  ('jobs',                   '{INSERT,SELECT,UPDATE}',   'shared outbox: api enqueues and cancels (G-01), system leases'),
  ('media_deletion_ledger',  '{DELETE,INSERT,SELECT}',   'api writes ledgers in business transactions, cancels on late arrival (G-01)'),
  ('media_deletion_objects', '{DELETE,INSERT,SELECT}',   'same as media_deletion_ledger'),
  ('items',                  '{SELECT,UPDATE}',          'api: staff/student transitions; system: pipeline and retention'),
  ('item_photos',            '{SELECT,UPDATE}',          'api: drafts/drops; system: canonical, variants, deletion'),
  ('lost_reports',           '{SELECT,UPDATE}',          'api: device/staff close; system: expiry, matches, purge'),
  ('lost_report_matches',    '{SELECT,UPDATE}',          'api: seen_at; system: record/evict'),
  ('map_versions',           '{SELECT,UPDATE}',          'api: drafts/submit/reject; system: canonical, activate (G-07)'),
  ('devices',                '{INSERT,SELECT,UPDATE}',   'api: touch/block; system: purge (0098 grant is broader than needed)'),
  ('rate_counters',          '{INSERT,SELECT,UPDATE}',   'api: rate limits; system: screening budget (G-35), alert markers, purge'),
  ('daily_school_stats',     '{INSERT,SELECT,UPDATE}',   'api: live counters; system: rollup and pipeline counters'),
  ('error_rollup',           '{INSERT,SELECT,UPDATE}',   'api_record_error and system_record_error (G-29)'),
  ('search_events',          '{SELECT,UPDATE}',          'api: insert/click; system: purge'),
  ('schools',                '{SELECT}',                 'reference data'),
  ('district_settings',      '{SELECT}',                 'reference data'),
  ('locations',              '{SELECT}',                 'reference data'),
  ('location_map_pins',      '{SELECT}',                 'reference data'),
  ('map_zones',              '{SELECT}',                 'reference data'),
  ('school_calendar_days',   '{SELECT}',                 'reference data'),
  ('synonyms',               '{SELECT}',                 'reference data'),
  ('screening_runs',         '{SELECT}',                 'api reads for the queue; system writes'),
  ('media_tickets',          '{SELECT}',                 'api issues, system redeems (G-04)'),
  ('idempotency_keys',       '{SELECT}',                 'api writes, system purges'),
  ('device_rejections',      '{SELECT}',                 'api writes, system purges (G-12)'),
  ('health_checks',          '{SELECT}',                 'system writes, api_health reads'),
  ('worker_heartbeats',      '{SELECT}',                 'system writes, api_health reads'),
  ('visible_items',          '{SELECT}',                 'internal projection (§7.2)'),
  ('public_items',           '{SELECT}',                 'internal projection (§7.2)'),
  ('public_item_photos',     '{SELECT}',                 'internal projection (§7.2)');

create temp view t_rels as
  select c.oid, n.nspname, c.relname, c.relkind, c.relowner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S');

create temp view t_privs as
  select r.oid, r.relname, p.priv, has_table_privilege('recover_api_owner', r.oid, p.priv) as api,
         has_table_privilege('recover_system_owner', r.oid, p.priv) as sys
    from t_rels r
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
   where r.nspname = 'public' and r.relkind <> 'S';

-- The two owner privilege sets, side by side (F-114/F-115 evidence).
select t.relname,
       coalesce(string_agg(t.priv, ',' order by t.priv) filter (where t.api), '-') as api_owner,
       coalesce(string_agg(t.priv, ',' order by t.priv) filter (where t.sys), '-') as system_owner,
       coalesce(string_agg(t.priv, ',' order by t.priv) filter (where t.api and t.sys), '-') as shared
  from t_privs t
 group by t.relname
 order by t.relname;

do $$
declare
  v_role text;
  v_bad text;
begin
  -- D-14: login roles and owners: no BYPASSRLS, no INHERIT, no superuser powers
  foreach v_role in array array['recover_web', 'recover_worker'] loop
    perform pg_temp.expect((select not rolbypassrls and not rolinherit and not rolsuper and not rolcreaterole
                                   and not rolcreatedb and not rolreplication and rolcanlogin
                              from pg_roles where rolname = v_role), v_role || ' attributes');
    perform pg_temp.expect(not exists (select 1 from pg_auth_members m where m.member = v_role::regrole),
                           v_role || ' is a member of no role');
  end loop;
  foreach v_role in array array['recover_api_owner', 'recover_system_owner', 'recover_attestation_owner'] loop
    perform pg_temp.expect((select not rolbypassrls and not rolinherit and not rolsuper and not rolcanlogin
                                   and not rolcreaterole and not rolcreatedb
                              from pg_roles where rolname = v_role), v_role || ' attributes');
    -- owners never own tables, views or sequences (functions only)
    select string_agg(r.nspname || '.' || r.relname, ', ') into v_bad from t_rels r where r.relowner = v_role::regrole;
    perform pg_temp.expect(v_bad is null, v_role || ' owns no relation (' || coalesce(v_bad, '') || ')');
  end loop;

  -- F-114: login roles hold NO privilege on any relation or sequence, table-level or column-level
  foreach v_role in array array['recover_web', 'recover_worker'] loop
    select string_agg(r.nspname || '.' || r.relname, ', ') into v_bad
      from t_rels r
     where (r.relkind = 'S' and (has_sequence_privilege(v_role, r.oid, 'USAGE') or has_sequence_privilege(v_role, r.oid, 'SELECT')
                                 or has_sequence_privilege(v_role, r.oid, 'UPDATE')))
        or (r.relkind <> 'S' and (has_table_privilege(v_role, r.oid, 'SELECT') or has_table_privilege(v_role, r.oid, 'INSERT')
                                  or has_table_privilege(v_role, r.oid, 'UPDATE') or has_table_privilege(v_role, r.oid, 'DELETE')
                                  or has_table_privilege(v_role, r.oid, 'TRUNCATE') or has_table_privilege(v_role, r.oid, 'REFERENCES')
                                  or has_table_privilege(v_role, r.oid, 'TRIGGER')
                                  or has_any_column_privilege(v_role, r.oid, 'SELECT, INSERT, UPDATE, REFERENCES')));
    perform pg_temp.expect(v_bad is null, v_role || ' has no table privileges (' || coalesce(v_bad, '') || ')');
    perform pg_temp.expect(not has_schema_privilege(v_role, 'public', 'CREATE') and not has_schema_privilege(v_role, 'private', 'USAGE')
                           and not has_schema_privilege(v_role, 'private', 'CREATE')
                           and not has_schema_privilege(v_role, 'extensions', 'USAGE')
                           and not has_schema_privilege(v_role, 'vault', 'USAGE')
                           and (to_regnamespace('storage') is null or not has_schema_privilege(v_role, 'storage', 'USAGE'))
                           and (to_regnamespace('cron') is null or not has_schema_privilege(v_role, 'cron', 'USAGE')),
                           v_role || ' schema privileges (public USAGE only)');
  end loop;

  -- the owners never received CREATE for good (0999) and cannot touch Vault, except the attestation owner
  foreach v_role in array array['recover_api_owner', 'recover_system_owner', 'recover_attestation_owner'] loop
    perform pg_temp.expect(not has_schema_privilege(v_role, 'public', 'CREATE') and not has_schema_privilege(v_role, 'private', 'CREATE'),
                           v_role || ' has no CREATE on public/private');
  end loop;
  perform pg_temp.expect(not has_schema_privilege('recover_api_owner', 'vault', 'USAGE')
                         and not has_schema_privilege('recover_system_owner', 'vault', 'USAGE'),
                         'only the attestation owner reads Vault');

  -- function surface: recover_web executes only api_%, recover_worker only system_% (public); nothing in private
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('recover_web', p.oid, 'EXECUTE') and p.proname not like 'api\_%';
  perform pg_temp.expect(v_bad is null, 'recover_web executes only api_% (' || coalesce(v_bad, '') || ')');
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('recover_worker', p.oid, 'EXECUTE') and p.proname not like 'system\_%';
  perform pg_temp.expect(v_bad is null, 'recover_worker executes only system_% (' || coalesce(v_bad, '') || ')');
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and ((p.proname like 'api\_%' and not has_function_privilege('recover_web', p.oid, 'EXECUTE'))
          or (p.proname like 'system\_%' and not has_function_privilege('recover_worker', p.oid, 'EXECUTE')));
  perform pg_temp.expect(v_bad is null, 'every catalog function is callable by its login role (' || coalesce(v_bad, '') || ')');
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and (has_function_privilege('recover_web', p.oid, 'EXECUTE') or has_function_privilege('recover_worker', p.oid, 'EXECUTE'));
  perform pg_temp.expect(v_bad is null, 'login roles execute nothing in private (' || coalesce(v_bad, '') || ')');

  -- F-94, G-21: no function in public or private is executable by PUBLIC, anon, authenticated or service_role
  select string_agg(n.nspname || '.' || p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and (p.proacl is null  -- NULL acl means the default: EXECUTE for PUBLIC
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  perform pg_temp.expect(v_bad is null, 'no function reachable by PUBLIC or the Data API roles (' || coalesce(v_bad, '') || ')');
  select string_agg(r.relname, ', ') into v_bad
    from t_rels r
   where r.nspname = 'public'
     and (has_table_privilege('anon', r.oid, 'SELECT') or has_table_privilege('authenticated', r.oid, 'SELECT')
          or has_table_privilege('service_role', r.oid, 'SELECT') or has_table_privilege('anon', r.oid, 'INSERT')
          or has_table_privilege('authenticated', r.oid, 'UPDATE') or has_table_privilege('service_role', r.oid, 'DELETE'));
  perform pg_temp.expect(v_bad is null, 'Data API roles have no table privileges (' || coalesce(v_bad, '') || ')');

  -- SECURITY DEFINER hygiene: empty search_path and a narrow family owner
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and (not coalesce('search_path=""' = any (p.proconfig), false)
          or pg_get_userbyid(p.proowner) not in ('recover_api_owner', 'recover_system_owner'));
  perform pg_temp.expect(v_bad is null, 'public SECURITY DEFINER functions: search_path='''' and family owner (' || coalesce(v_bad, '') || ')');
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and ((p.proname like 'api\_%' and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'recover_api_owner'))
          or (p.proname like 'system\_%' and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'recover_system_owner')));
  perform pg_temp.expect(v_bad is null, 'api_% owned by recover_api_owner, system_% by recover_system_owner, all definer ('
                                        || coalesce(v_bad, '') || ')');
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.prosecdef
     and (not coalesce('search_path=""' = any (p.proconfig), false)
          or pg_get_userbyid(p.proowner) not in ('recover_api_owner', 'recover_system_owner', 'recover_attestation_owner'));
  perform pg_temp.expect(v_bad is null, 'private SECURITY DEFINER functions are narrow and pinned (' || coalesce(v_bad, '') || ')');

  -- F-114: the system family has no path to the staff identity tables (no grant, no column grant, no policy)
  perform pg_temp.expect(not has_table_privilege('recover_system_owner', 'public.staff_users', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                         and not has_table_privilege('recover_system_owner', 'public.staff_members', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                         and not has_any_column_privilege('recover_system_owner', 'public.staff_users', 'SELECT, INSERT, UPDATE, REFERENCES')
                         and not has_any_column_privilege('recover_system_owner', 'public.staff_members', 'SELECT, INSERT, UPDATE, REFERENCES'),
                         'recover_system_owner has no privilege on staff_users/staff_members');
  perform pg_temp.expect(not exists (select 1 from pg_policy pol
                                      where pol.polrelid in ('public.staff_users'::regclass, 'public.staff_members'::regclass)
                                        and ('recover_system_owner'::regrole = any (pol.polroles) or 0::oid = any (pol.polroles))),
                         'no RLS policy lets the system owner (or PUBLIC) reach staff identity rows');

  -- audit_log is append-only for both families
  perform pg_temp.expect(not has_table_privilege('recover_api_owner', 'public.audit_log', 'UPDATE, DELETE, TRUNCATE')
                         and not has_table_privilege('recover_system_owner', 'public.audit_log', 'UPDATE, DELETE, TRUNCATE, SELECT'),
                         'audit_log cannot be rewritten by either family');

  -- RLS stays enabled on every table (defense in depth, §7.5)
  select string_agg(r.relname, ', ') into v_bad
    from t_rels r join pg_class c on c.oid = r.oid
   where r.nspname = 'public' and r.relkind = 'r' and not c.relrowsecurity;
  perform pg_temp.expect(v_bad is null, 'RLS enabled on every public table (' || coalesce(v_bad, '') || ')');

  -- F-115: owner overlap only within the reviewed allowlist
  select string_agg(t.relname || '.' || t.priv, ', ' order by t.relname, t.priv) into v_bad
    from t_privs t
   where t.api and t.sys
     and not exists (select 1 from t_allowed_overlap a where a.relname = t.relname and t.priv = any (a.privs));
  perform pg_temp.expect(v_bad is null, 'api/system owner overlap outside the allowlist: ' || coalesce(v_bad, ''));
end $$;

do $$
begin
  raise notice 'privilege_diff.sql: % checks passed', currval('pg_temp.t_checks');
end $$;

rollback;
