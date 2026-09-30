-- District admin api family (BUILD-CONTRACT 6.3; §5.6, §9.4.1, §14, §17, §24; F-45, F-64, F-74, F-101,
-- F-112; G-06, G-16). Everything runs in one transaction that is rolled back, so nothing persists.
-- Assertions are minted here exactly like packages/shared/src/assertion.ts: the canonical body through
-- private.canonical_json, the twelve-line MAC input, and HMAC-SHA256 with key = 32 bytes of 0x42.
-- Every api call runs under `set local role recover_web`.
begin;
set local lock_timeout = '20s';

-- The runner connects as postgres, which may SET ROLE only to roles it belongs to. 0002 grants recover_web
-- to postgres; on a database migrated before that grant, add it here (undone by the rollback).
do $$
begin
  if not pg_has_role(current_user, 'recover_web', 'member') then
    grant recover_web to postgres;
  end if;
end $$;

-- Vault: the test key as v1; only version 1 verifies (G-17).
do $$
declare
  r record;
begin
  for r in select x.name, x.secret
             from (values ('staff_assertion_key_v1', private.b64url_encode(decode(repeat('42', 32), 'hex'))),
                          ('staff_assertion_key_current', '1'),
                          ('staff_assertion_key_previous', '')) as x(name, secret)
  loop
    if exists (select 1 from vault.secrets s where s.name = r.name) then
      perform vault.update_secret((select s.id from vault.secrets s where s.name = r.name), r.secret);
    else
      perform vault.create_secret(r.secret, r.name);
    end if;
  end loop;
end $$;

-- Attested subjects for the seeded district admin and the seeded FCHS school admin.
update public.staff_users set google_sub = 'sub-0310-district-admin' where id = '00000000-5a00-4000-8000-000000000001';
update public.staff_users set google_sub = 'sub-0310-fchs-admin' where id = '00000000-5a00-4000-8000-000000000002';

-- ---------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------

-- Test-only mint: same canonical body, twelve lines, and MAC as assertion.ts (mint + canonicalLines).
create function pg_temp.mint(p_sub text, p_operation text, p_target uuid, p_body jsonb,
                             p_scope text default 'district')
returns jsonb
language plpgsql as $$
declare
  v_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_request_id text := gen_random_uuid()::text;
  v_body_sha256 text := encode(extensions.digest(convert_to(private.canonical_json(p_body), 'UTF8'), 'sha256'), 'hex');
  v_lines text;
begin
  v_lines := array_to_string(array[
    'v1', v_request_id, p_sub, p_scope, p_operation, coalesce(lower(p_target::text), '-'), '-', v_body_sha256, '-',
    '1', v_iat::text, (v_iat + 30)::text], E'\n');
  return jsonb_build_object(
    'v', 'v1', 'request_id', v_request_id, 'google_sub', p_sub, 'scope', p_scope, 'operation', p_operation,
    'target_id', lower(p_target::text), 'row_version', null, 'body_sha256', v_body_sha256,
    'idempotency_key_sha256', null, 'key_version', 1, 'iat', v_iat, 'exp', v_iat + 30,
    'mac', private.b64url_encode(extensions.hmac(convert_to(v_lines, 'UTF8'), decode(repeat('42', 32), 'hex'), 'sha256')));
end $$;

-- One api call as recover_web; returns its jsonb (an error fails the whole file).
create function pg_temp.web(p_sql text) returns jsonb
language plpgsql as $$
declare
  r jsonb;
begin
  set local role recover_web;
  execute p_sql into r;
  reset role;
  return r;
end $$;

-- One api call as recover_web that must fail with RV001 p_code (and p_detail when given).
create function pg_temp.fails(p_label text, p_sql text, p_code text, p_detail text default null) returns void
language plpgsql as $$
declare
  v_state text;
  v_msg text;
  v_detail text;
begin
  begin
    set local role recover_web;
    execute p_sql;
    reset role;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
    if v_state = 'RV001' and v_msg = p_code and (p_detail is null or v_detail = p_detail) then
      raise notice 'PASS %', p_label;
      return;
    end if;
    raise exception 'FAIL %: expected % %, got % % %', p_label, p_code, coalesce(p_detail, ''),
      v_state, v_msg, coalesce(v_detail, '');
  end;
  raise exception 'FAIL %: expected % but the call succeeded', p_label, p_code;
end $$;

create function pg_temp.ok(p_label text, p_cond boolean) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL %', p_label;
  end if;
  raise notice 'PASS %', p_label;
end $$;

-- Call builders: each mints over the same body the function rebuilds from its own arguments.
create function pg_temp.q_noarg(p_sub text, p_fn text, p_op text) returns text
language sql as $$
  select format('select public.%I(p_assert => %L::jsonb)', p_fn, pg_temp.mint(p_sub, p_op, null, '{}'::jsonb))
$$;

create function pg_temp.q_create(p_sub text, p_code text, p_name text, p_tz text, p_email text, p_admin_name text)
returns text
language sql as $$
  select format('select public.api_district_school_create(p_assert => %L::jsonb, p_code => %L, p_name => %L, '
                'p_timezone => %L, p_admin_email => %L, p_admin_name => %L)',
                pg_temp.mint(p_sub, 'district.school.create', null,
                             jsonb_build_object('code', p_code, 'name', p_name, 'timezone', p_tz,
                                                'admin_email', p_email, 'admin_name', p_admin_name)),
                p_code, p_name, p_tz, p_email, p_admin_name)
$$;

create function pg_temp.q_settings(p_sub text, p_changes jsonb) returns text
language sql as $$
  select format('select public.api_district_settings_update(p_assert => %L::jsonb, p_changes => %L::jsonb)',
                pg_temp.mint(p_sub, 'district.settings.write', null, jsonb_build_object('changes', p_changes)),
                p_changes)
$$;

create function pg_temp.q_reject(p_sub text, p_id uuid, p_reason text) returns text
language sql as $$
  select format('select public.api_district_map_reject(p_assert => %L::jsonb, p_map_version_id => %L::uuid, '
                'p_reason => %L)',
                pg_temp.mint(p_sub, 'district.map.reject', p_id,
                             jsonb_build_object('map_version_id', lower(p_id::text), 'reason', p_reason)),
                p_id, p_reason)
$$;

create function pg_temp.q_rebind(p_sub text, p_user uuid) returns text
language sql as $$
  select format('select public.api_district_identity_rebind(p_assert => %L::jsonb, p_staff_user_id => %L::uuid)',
                pg_temp.mint(p_sub, 'district.identity.rebind', p_user,
                             jsonb_build_object('staff_user_id', lower(p_user::text))),
                p_user)
$$;

create function pg_temp.q_stats(p_sub text, p_from date, p_to date) returns text
language sql as $$
  select format('select public.api_district_stats(p_assert => %L::jsonb, p_from => %L::date, p_to => %L::date)',
                pg_temp.mint(p_sub, 'district.stats.read', null, jsonb_build_object('from', p_from, 'to', p_to)),
                p_from, p_to)
$$;

create function pg_temp.q_alerts(p_sub text, p_limit int) returns text
language sql as $$
  select format('select public.api_district_alerts(p_assert => %L::jsonb, p_limit => %L::int)',
                pg_temp.mint(p_sub, 'district.alerts.read', null, jsonb_build_object('limit', p_limit)), p_limit)
$$;

create function pg_temp.q_onboarding(p_sub text, p_code text) returns text
language sql as $$
  select format('select public.api_district_onboarding(p_assert => %L::jsonb, p_school_code => %L)',
                pg_temp.mint(p_sub, 'district.onboarding.read', null, jsonb_build_object('school_code', p_code)),
                p_code)
$$;

-- ---------------------------------------------------------------------------------------------------
-- template: owner, SECURITY DEFINER, search_path, lock_timeout, EXECUTE to recover_web only
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  f record;
  n int := 0;
begin
  for f in select p.oid, p.oid::regprocedure::text as sig, pg_get_userbyid(p.proowner) as owner, p.prosecdef,
                  p.proconfig
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname like 'api\_district\_%'
  loop
    n := n + 1;
    perform pg_temp.ok('template ' || f.sig,
      f.owner = 'recover_api_owner' and f.prosecdef
      and 'search_path=""' = any (f.proconfig) and 'lock_timeout=3s' = any (f.proconfig)
      and has_function_privilege('recover_web', f.oid, 'execute')
      and not has_function_privilege('recover_worker', f.oid, 'execute')
      and not has_function_privilege('public', f.oid, 'execute')
      and not has_function_privilege('anon', f.oid, 'execute')
      and not has_function_privilege('authenticated', f.oid, 'execute')
      and not has_function_privilege('service_role', f.oid, 'execute'));
  end loop;
  perform pg_temp.ok('all ten api_district functions exist', n = 10);
  perform pg_temp.ok('dapi helpers belong to recover_api_owner and are not executable by login roles',
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'private' and p.proname like 'dapi\_%'
                   and (pg_get_userbyid(p.proowner) <> 'recover_api_owner'
                        or has_function_privilege('recover_web', p.oid, 'execute')
                        or has_function_privilege('recover_worker', p.oid, 'execute')
                        or has_function_privilege('recover_system_owner', p.oid, 'execute'))));
end $$;

-- ---------------------------------------------------------------------------------------------------
-- a school admin is forbidden from every district function (district_admin via op_min_role)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  s constant text := 'sub-0310-fchs-admin';
begin
  perform pg_temp.fails('school admin forbidden: schools_list',
    pg_temp.q_noarg(s, 'api_district_schools_list', 'district.schools.read'), 'forbidden');
  perform pg_temp.fails('school admin forbidden: school_create',
    pg_temp.q_create(s, 'DZQY', 'Forbidden Academy', 'America/New_York', 'nobody.0310@recover.test', null), 'forbidden');
  perform pg_temp.fails('school admin forbidden: settings_get',
    pg_temp.q_noarg(s, 'api_district_settings_get', 'district.settings.read'), 'forbidden');
  perform pg_temp.fails('school admin forbidden: settings_update',
    pg_temp.q_settings(s, '{"workerMode": "quarantine"}'), 'forbidden');
  perform pg_temp.fails('school admin forbidden: maps_pending',
    pg_temp.q_noarg(s, 'api_district_maps_pending', 'district.maps.read'), 'forbidden');
  perform pg_temp.fails('school admin forbidden: map_reject',
    pg_temp.q_reject(s, '0a0a0a0a-2000-4000-8000-000000000001', 'no'), 'forbidden');
  perform pg_temp.fails('school admin forbidden: identity_rebind',
    pg_temp.q_rebind(s, '00000000-5a00-4000-8000-000000000003'), 'forbidden');
  perform pg_temp.fails('school admin forbidden: stats', pg_temp.q_stats(s, null, null), 'forbidden');
  perform pg_temp.fails('school admin forbidden: alerts', pg_temp.q_alerts(s, 10), 'forbidden');
  perform pg_temp.fails('school admin forbidden: onboarding', pg_temp.q_onboarding(s, 'FCHS'), 'forbidden');
  perform pg_temp.ok('forbidden calls changed nothing',
    not exists (select 1 from public.schools where code = 'DZQY')
    and not exists (select 1 from public.audit_log
                     where created_at = now()
                       and action in ('school.create', 'district.config', 'map.reject', 'identity.rebind')));
end $$;

-- ---------------------------------------------------------------------------------------------------
-- the assertion binds operation, scope, target, and body (section 5, G-16)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
begin
  perform pg_temp.fails('stats: arguments that differ from the attested body are assertion_invalid',
    format('select public.api_district_stats(p_assert => %L::jsonb, p_from => %L::date, p_to => null)',
           pg_temp.mint(a, 'district.stats.read', null, jsonb_build_object('from', null, 'to', null)), '2026-01-01'),
    'assertion_invalid');
  perform pg_temp.fails('schools_list: another operation is assertion_invalid',
    pg_temp.q_noarg(a, 'api_district_schools_list', 'district.settings.read'), 'assertion_invalid');
  perform pg_temp.fails('schools_list: a school scope is assertion_invalid',
    format('select public.api_district_schools_list(p_assert => %L::jsonb)',
           pg_temp.mint(a, 'district.schools.read', null, '{}', 'school:0a0a0a0a-0000-4000-8000-000000000001')),
    'assertion_invalid');
  perform pg_temp.fails('map_reject: a missing target is assertion_invalid',
    format('select public.api_district_map_reject(p_assert => %L::jsonb, p_map_version_id => %L::uuid, p_reason => %L)',
           pg_temp.mint(a, 'district.map.reject', null,
                        jsonb_build_object('map_version_id', '0a0a0a0a-2000-4000-8000-000000000001', 'reason', 'x')),
           '0a0a0a0a-2000-4000-8000-000000000001', 'x'),
    'assertion_invalid');
  perform pg_temp.fails('settings_get: a tampered MAC is assertion_invalid',
    format('select public.api_district_settings_get(p_assert => %L::jsonb)',
           jsonb_set(pg_temp.mint(a, 'district.settings.read', null, '{}'), '{mac}', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"')),
    'assertion_invalid');
end $$;

-- ---------------------------------------------------------------------------------------------------
-- schools_list
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  r jsonb;
  f jsonb;
  f2 jsonb;
begin
  r := pg_temp.web(pg_temp.q_noarg(a, 'api_district_schools_list', 'district.schools.read'));
  perform pg_temp.ok('schools_list returns every school',
    jsonb_typeof(r->'schools') = 'array'
    and jsonb_array_length(r->'schools') = (select count(*) from public.schools));
  select x.e into f from jsonb_array_elements(r->'schools') as x(e) where x.e->>'code' = 'FCHS';
  perform pg_temp.ok('schools_list FCHS row has code, name, timezone, active, flags, counts, onboarding',
    f ?& array['id', 'code', 'name', 'timezone', 'active', 'retentionDays', 'createdAt', 'flags', 'counts', 'onboarding']
    and f->>'name' = 'Forsyth Central High School' and f->>'timezone' = 'America/New_York'
    and f->'flags' ?& array['studentPosting', 'lostReports', 'crossSchoolSearch']
    and f->'counts' ?& array['pending', 'published', 'atLocation']
    and f->'onboarding' ?& array['done', 'total', 'complete'] and (f->'onboarding'->>'total')::int = 8
    and not (f->'onboarding' ? 'steps'));

  -- a pending student post and a staff item on the shelf move the live counts
  insert into public.items (school_id, public_id, category, description, dropoff_location_id, review_status,
                            posted_by_kind, device_token_hash)
  values ('0a0a0a0a-0000-4000-8000-000000000001', 'FCHS-W-931001', 'bag', 'test navy bag',
          '0a0a0a0a-1000-4000-8000-000000000001', 'pending', 'student', decode('01' || repeat('ab', 32), 'hex'));
  insert into public.items (school_id, public_id, category, description, dropoff_location_id, current_location_id,
                            review_status, reviewed_at, posted_by_kind, posted_by_staff_id, custody, received_at,
                            expires_at)
  values ('0a0a0a0a-0000-4000-8000-000000000001', 'FCHS-W-931002', 'book', 'test green book',
          '0a0a0a0a-1000-4000-8000-000000000001', '0a0a0a0a-1000-4000-8000-000000000001', 'approved', now(),
          'staff', '00000000-5b00-4000-8000-000000000003', 'at_location', now(), now() + interval '30 days');
  r := pg_temp.web(pg_temp.q_noarg(a, 'api_district_schools_list', 'district.schools.read'));
  select x.e into f2 from jsonb_array_elements(r->'schools') as x(e) where x.e->>'code' = 'FCHS';
  perform pg_temp.ok('schools_list counts pending and at_location items live',
    (f2->'counts'->>'pending')::int = (f->'counts'->>'pending')::int + 1
    and (f2->'counts'->>'atLocation')::int = (f->'counts'->>'atLocation')::int + 1
    and (f2->'counts'->>'published')::int = (f->'counts'->>'published')::int);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- school_create (§24 step 1, F-101)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  r jsonb;
  v_id uuid;
begin
  perform pg_temp.fails('school_create refuses a timezone missing from pg_timezone_names (F-101)',
    pg_temp.q_create(a, 'DZQX', 'Dzqx Test Academy', 'Mars/Olympus_Mons', 'new.principal.0310@recover.test', 'New Principal'),
    'invalid_input', 'timezone');
  perform pg_temp.fails('school_create refuses a malformed code',
    pg_temp.q_create(a, 'DZ1', 'Dzqx Test Academy', 'America/Chicago', 'new.principal.0310@recover.test', 'New Principal'),
    'invalid_input', 'code');
  perform pg_temp.fails('school_create refuses an admin email outside the allowed domains',
    pg_temp.q_create(a, 'DZQX', 'Dzqx Test Academy', 'America/Chicago', 'new.principal.0310@evil.test', 'New Principal'),
    'invalid_input', 'admin_email');
  perform pg_temp.fails('school_create never suffix-matches a domain (§14.1)',
    pg_temp.q_create(a, 'DZQX', 'Dzqx Test Academy', 'America/Chicago', 'p@sub.recover.test', 'New Principal'),
    'invalid_input', 'admin_email');
  perform pg_temp.fails('school_create requires the admin email',
    pg_temp.q_create(a, 'DZQX', 'Dzqx Test Academy', 'America/Chicago', null, 'New Principal'),
    'invalid_input', 'admin_email');
  perform pg_temp.fails('school_create refuses bidi controls in the name',
    pg_temp.q_create(a, 'DZQX', 'Dzqx ' || chr(8238) || 'Test', 'America/Chicago', 'new.principal.0310@recover.test', null),
    'invalid_input', 'name');
  perform pg_temp.ok('refused creates left no school', not exists (select 1 from public.schools where code = 'DZQX'));

  r := pg_temp.web(pg_temp.q_create(a, 'dzqx', '  Dzqx   Test Academy ', 'America/Chicago',
                                    'New.Principal.0310@Recover.test', 'New Principal'));
  v_id := (r->>'schoolId')::uuid;
  perform pg_temp.ok('school_create returns the new school with every flag off',
    r->>'code' = 'DZQX' and r->>'name' = 'Dzqx Test Academy' and r->>'timezone' = 'America/Chicago'
    and r->'flags' = '{"studentPosting": false, "lostReports": false, "crossSchoolSearch": false}'::jsonb
    and r->'admin'->>'status' = 'invited' and r->'admin'->>'role' = 'school_admin'
    and (r->'admin'->>'userCreated')::boolean);
  perform pg_temp.ok('school_create stores the flags off and retention inside [floor, ceiling]',
    exists (select 1 from public.schools s cross join public.district_settings d
             where s.id = v_id and d.id = 1 and s.code = 'DZQX' and s.active and s.timezone = 'America/Chicago'
               and not s.student_posting_enabled and not s.lost_reports_enabled and not s.cross_school_search_enabled
               and s.retention_days between d.retention_days_floor and d.retention_days_ceiling
               and s.retention_days = (r->>'retentionDays')::int));
  perform pg_temp.ok('school_create creates the staff user and an invited school_admin membership',
    exists (select 1 from public.staff_users u join public.staff_members m on m.user_id = u.id
             where u.email = 'new.principal.0310@recover.test' and u.google_sub is null
               and u.display_name = 'New Principal' and u.id = (r->'admin'->>'userId')::uuid
               and m.id = (r->'admin'->>'memberId')::uuid and m.school_id = v_id and m.role = 'school_admin'
               and m.status = 'invited' and m.invited_by = '00000000-5b00-4000-8000-000000000001'));
  perform pg_temp.ok('school_create audits school.create without the email or the name (F-74)',
    exists (select 1 from public.audit_log l
             where l.action = 'school.create' and l.target_table = 'schools' and l.target_id = v_id::text
               and l.school_id = v_id and l.actor_kind = 'staff' and l.actor_id = '00000000-5b00-4000-8000-000000000001'
               and l.state_after->>'code' = 'DZQX' and l.metadata->>'admin_member_id' = r->'admin'->>'memberId'
               and position('@' in l.state_before::text || l.state_after::text || l.metadata::text) = 0
               and position('Academy' in l.state_after::text || l.metadata::text) = 0
               and position('Principal' in l.state_after::text || l.metadata::text) = 0));
  perform pg_temp.fails('school_create refuses a code that is taken',
    pg_temp.q_create(a, 'DZQX', 'Another Academy', 'America/Chicago', 'second.0310@recover.test', null),
    'invalid_input', 'code');

  r := pg_temp.web(pg_temp.q_create(a, 'DZQZ', 'Dzqz Test Middle', 'America/New_York', 'office.fchs@recover.test', null));
  perform pg_temp.ok('school_create invites an existing staff user without a second user row',
    r->'admin'->>'userId' = '00000000-5a00-4000-8000-000000000003' and not (r->'admin'->>'userCreated')::boolean
    and (select count(*) from public.staff_users where lower(email) = 'office.fchs@recover.test') = 1
    and exists (select 1 from public.staff_members m
                 where m.user_id = '00000000-5a00-4000-8000-000000000003' and m.school_id = (r->>'schoolId')::uuid
                   and m.role = 'school_admin' and m.status = 'invited'));
end $$;

-- ---------------------------------------------------------------------------------------------------
-- settings_get and settings_update
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  r jsonb;
begin
  r := pg_temp.web(pg_temp.q_noarg(a, 'api_district_settings_get', 'district.settings.read'));
  perform pg_temp.ok('settings_get returns every district setting in camelCase',
    r ?& array['retentionDaysFloor', 'retentionDaysCeiling', 'staffEmailDomains', 'lostReportTtlDays',
               'studentPostingGlobalEnabled', 'lostReportsGlobalEnabled', 'crossSchoolSearchGlobalEnabled',
               'screeningEnabled', 'screeningDailyCeiling', 'rejectedMediaRetentionDays', 'workerMode',
               'campusCidrs', 'redactedSearchEnabled', 'updatedAt', 'schoolRetention']
    and jsonb_typeof(r->'staffEmailDomains') = 'array' and jsonb_typeof(r->'campusCidrs') = 'array'
    and (r->>'retentionDaysFloor')::int = (select retention_days_floor from public.district_settings where id = 1)
    and r->>'workerMode' = (select worker_mode from public.district_settings where id = 1)
    and (r->'schoolRetention'->>'min')::int = (select min(retention_days) from public.schools));
end $$;

do $$
declare
  a constant text := 'sub-0310-district-admin';
  v_before public.district_settings;
begin
  select * into v_before from public.district_settings where id = 1;
  perform pg_temp.fails('settings_update refuses an unknown key',
    pg_temp.q_settings(a, '{"bogus": 1}'), 'invalid_input', 'changes');
  perform pg_temp.fails('settings_update refuses a known key mixed with an unknown one',
    pg_temp.q_settings(a, '{"workerMode": "quarantine", "retentionDays": 30}'), 'invalid_input', 'changes');
  perform pg_temp.fails('settings_update refuses an empty change set',
    pg_temp.q_settings(a, '{}'), 'invalid_input', 'changes');
  perform pg_temp.fails('settings_update refuses a non-object change set',
    pg_temp.q_settings(a, '["workerMode"]'), 'invalid_input', 'changes');
  perform pg_temp.fails('settings_update refuses a CIDR with host bits set',
    pg_temp.q_settings(a, '{"campusCidrs": ["10.1.2.3/8"]}'), 'invalid_input', 'campusCidrs');
  perform pg_temp.fails('settings_update refuses a string that is not a CIDR',
    pg_temp.q_settings(a, '{"campusCidrs": ["10.0.0.0/8", "campus-wifi"]}'), 'invalid_input', 'campusCidrs');
  perform pg_temp.fails('settings_update refuses a CIDR that is not a string',
    pg_temp.q_settings(a, '{"campusCidrs": [10]}'), 'invalid_input', 'campusCidrs');
  perform pg_temp.fails('settings_update refuses a non-boolean switch',
    pg_temp.q_settings(a, '{"screeningEnabled": "yes"}'), 'invalid_input', 'screeningEnabled');
  perform pg_temp.fails('settings_update refuses an unknown worker mode (G-06)',
    pg_temp.q_settings(a, '{"workerMode": "panic"}'), 'invalid_input', 'workerMode');
  perform pg_temp.fails('settings_update refuses an out-of-range lost-report TTL',
    pg_temp.q_settings(a, '{"lostReportTtlDays": 181}'), 'invalid_input', 'lostReportTtlDays');
  perform pg_temp.fails('settings_update refuses a fractional screening ceiling',
    pg_temp.q_settings(a, '{"screeningDailyCeiling": 1.5}'), 'invalid_input', 'screeningDailyCeiling');
  perform pg_temp.fails('settings_update refuses a floor above the ceiling',
    pg_temp.q_settings(a, jsonb_build_object('retentionDaysFloor', v_before.retention_days_ceiling + 1)),
    'invalid_input', 'retentionDaysFloor');
  perform pg_temp.fails('settings_update refuses a malformed staff domain',
    pg_temp.q_settings(a, '{"staffEmailDomains": ["recover.test", "*.example.org"]}'), 'invalid_input', 'staffEmailDomains');
  perform pg_temp.fails('settings_update refuses dropping the acting admin''s own domain',
    pg_temp.q_settings(a, '{"staffEmailDomains": ["k12.example.org"]}'), 'invalid_input', 'staffEmailDomains');
  perform pg_temp.ok('refused updates changed nothing',
    (select d from public.district_settings d where d.id = 1) = v_before);
end $$;

-- F-64: a floor or ceiling that would strand a school raises, in the function and in the trigger backstop.
do $$
declare
  a constant text := 'sub-0310-district-admin';
  v_min int := (select min(retention_days) from public.schools);
  v_max int := (select max(retention_days) from public.schools);
begin
  perform pg_temp.fails('settings_update refuses a floor that strands a school (F-64)',
    pg_temp.q_settings(a, jsonb_build_object('retentionDaysFloor', v_min + 1)), 'invalid_input', 'retentionDaysFloor');
  perform pg_temp.fails('settings_update refuses a ceiling that strands a school (F-64)',
    pg_temp.q_settings(a, jsonb_build_object('retentionDaysCeiling', v_max - 1)), 'invalid_input', 'retentionDaysCeiling');
  begin
    update public.district_settings set retention_days_floor = v_min + 1 where id = 1;
    raise exception 'FAIL district_retention trigger accepted a stranding floor';
  exception when sqlstate 'RV001' then
    raise notice 'PASS district_retention trigger refuses a stranding floor on a direct write';
  end;
end $$;

do $$
declare
  a constant text := 'sub-0310-district-admin';
  v_posting boolean := (select student_posting_global_enabled from public.district_settings where id = 1);
  v_audits int;
  r jsonb;
  d public.district_settings;
begin
  r := pg_temp.web(pg_temp.q_settings(a, jsonb_build_object(
         'campusCidrs', jsonb_build_array('192.168.1.7', '10.0.0.0/8', '10.0.0.0/8'),
         'workerMode', 'quarantine',
         'screeningDailyCeiling', 250,
         'staffEmailDomains', jsonb_build_array('Recover.test', 'k12.example.org'),
         'studentPostingGlobalEnabled', not v_posting)));
  select * into d from public.district_settings where id = 1;
  perform pg_temp.ok('settings_update stores canonical CIDRs, domains, worker mode, ceiling, and switch',
    d.campus_cidrs = array['10.0.0.0/8', '192.168.1.7/32'] and d.worker_mode = 'quarantine'
    and d.screening_daily_ceiling = 250 and d.staff_email_domains = array['k12.example.org', 'recover.test']
    and d.student_posting_global_enabled = not v_posting
    and r->'campusCidrs' = '["10.0.0.0/8", "192.168.1.7/32"]'::jsonb and r->>'workerMode' = 'quarantine'
    and r->'staffEmailDomains' = '["k12.example.org", "recover.test"]'::jsonb);
  perform pg_temp.ok('settings_update reports the changed keys',
    r->'changedKeys' = '["campusCidrs", "screeningDailyCeiling", "staffEmailDomains",
                         "studentPostingGlobalEnabled", "workerMode"]'::jsonb);
  perform pg_temp.ok('settings_update audits district.config with changed_keys only',
    exists (select 1 from public.audit_log l
             where l.action = 'district.config' and l.target_table = 'district_settings' and l.target_id = '1'
               and l.school_id is null and l.actor_id = '00000000-5b00-4000-8000-000000000001'
               and l.metadata = jsonb_build_object('changed_keys', r->'changedKeys')
               and l.state_before = '{}'::jsonb and l.state_after = '{}'::jsonb));
  perform pg_temp.ok('a global switch change invalidates every active school through the outbox',
    (select count(*) from public.jobs j
      where j.kind = 'invalidate_cache' and j.status = 'queued'
        and j.dedupe_key like ('invalidate_cache:%:' || txid_current()::text))
    = (select count(*) from public.schools where active));

  select count(*) into v_audits from public.audit_log where action = 'district.config';
  r := pg_temp.web(pg_temp.q_settings(a, '{"workerMode": "quarantine"}'));
  perform pg_temp.ok('a no-op update reports no changed keys and writes no audit row',
    r->'changedKeys' = '[]'::jsonb
    and (select count(*) from public.audit_log where action = 'district.config') = v_audits);
end $$;

-- The default retention of a new school is clamped into the district bounds.
do $$
declare
  a constant text := 'sub-0310-district-admin';
  v_ceiling int := (select retention_days_ceiling from public.district_settings where id = 1);
  v_floor int;
  r jsonb;
begin
  v_floor := v_ceiling - 5;
  update public.schools set retention_days = v_ceiling;
  r := pg_temp.web(pg_temp.q_settings(a, jsonb_build_object('retentionDaysFloor', v_floor)));
  perform pg_temp.ok('settings_update raises the floor once no school would be stranded',
    (r->>'retentionDaysFloor')::int = v_floor and r->'changedKeys' = '["retentionDaysFloor"]'::jsonb);
  r := pg_temp.web(pg_temp.q_create(a, 'DZQW', 'Dzqw Test Elementary', 'America/Denver', 'third.0310@recover.test', null));
  perform pg_temp.ok('school_create clamps the default retention into [floor, ceiling]',
    (r->>'retentionDays')::int = greatest(v_floor, least(v_ceiling, 30))
    and (select retention_days from public.schools where code = 'DZQW') = greatest(v_floor, least(v_ceiling, 30)));
end $$;

-- ---------------------------------------------------------------------------------------------------
-- maps_pending and map_reject (§9.4.1, G-07, F-112)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  v_map constant uuid := 'd0d0d0d0-0310-4000-8000-000000000001';
  v_school constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  r jsonb;
  m jsonb;
  j public.jobs;
begin
  insert into public.map_versions (id, school_id, draft_storage_path, draft_canonical_path, width_px, height_px,
                                   approval_status, created_by)
  values (v_map, v_school, v_school::text || '/' || v_map::text || '/draft',
          v_school::text || '/' || v_map::text || '/canonical.jpg', 1200, 800, 'draft',
          '00000000-5b00-4000-8000-000000000002');
  insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius)
  values (v_school, v_map, 'Front Steps', 0.5, 0.25, 0.1);
  insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y)
  values (v_school, '0a0a0a0a-1000-4000-8000-000000000001', v_map, 0.2, 0.3);
  update public.map_versions set approval_status = 'pending_district', submitted_at = now() where id = v_map;

  r := pg_temp.web(pg_temp.q_noarg(a, 'api_district_maps_pending', 'district.maps.read'));
  select x.e into m from jsonb_array_elements(r->'maps') as x(e) where x.e->>'mapVersionId' = v_map::text;
  perform pg_temp.ok('maps_pending lists the version with school, size, zones, pins, and submittedAt',
    m is not null and m->>'schoolCode' = 'FCHS' and m->>'schoolName' = 'Forsyth Central High School'
    and (m->>'width')::int = 1200 and (m->>'height')::int = 800 and m->>'submittedAt' is not null
    and jsonb_array_length(m->'zones') = 1 and m->'zones'->0->>'name' = 'Front Steps'
    and (m->'zones'->0->>'cx')::float8 = 0.5 and (m->'zones'->0->>'cy')::float8 = 0.25
    and (m->'zones'->0->>'radius')::float8 = 0.1
    and jsonb_array_length(m->'pins') = 1 and m->'pins'->0->>'code' = 'W'
    and (m->'pins'->0->>'x')::float8 = 0.2 and (m->'pins'->0->>'y')::float8 = 0.3
    and jsonb_array_length(m->'unpinnedLocations')
        = (select count(*) from public.locations where school_id = v_school and active) - 1);
  perform pg_temp.ok('maps_pending never returns a storage path',
    position('/draft' in r::text) = 0 and position('canonical.jpg' in r::text) = 0
    and position('5eed' in r::text) = 0
    and not exists (select 1 from jsonb_object_keys(m) as x(key) where x.key ilike '%path%'));

  perform pg_temp.fails('map_reject refuses a reason over 200 characters',
    pg_temp.q_reject(a, v_map, repeat('x', 201)), 'invalid_input', 'reason');
  perform pg_temp.fails('map_reject requires a reason',
    pg_temp.q_reject(a, v_map, '   '), 'invalid_input', 'reason');
  perform pg_temp.fails('map_reject refuses a version that is not pending_district',
    pg_temp.q_reject(a, '0a0a0a0a-2000-4000-8000-000000000001', 'Not pending'), 'state_changed');
  perform pg_temp.fails('map_reject on an unknown version is not_found',
    pg_temp.q_reject(a, 'd0d0d0d0-0310-4000-8000-00000000ffff', 'Missing'), 'not_found');

  r := pg_temp.web(pg_temp.q_reject(a, v_map, 'Remove the clinic label before resubmitting.'));
  perform pg_temp.ok('map_reject moves pending_district to rejected and keeps the reason on the version',
    r->>'approvalStatus' = 'rejected' and r->>'schoolCode' = 'FCHS' and r->>'mapVersionId' = v_map::text
    and exists (select 1 from public.map_versions v
                 where v.id = v_map and v.approval_status = 'rejected' and not v.active
                   and v.rejected_reason = 'Remove the clinic label before resubmitting.'));
  select * into j from public.jobs
   where kind = 'delete_map_draft' and dedupe_key = 'delete_map_draft:' || v_map::text and status = 'queued';
  perform pg_temp.ok('map_reject enqueues delete_map_draft {mapVersionId} with run_after 7 days out (F-112)',
    j.id is not null and j.payload = jsonb_build_object('mapVersionId', v_map) and j.school_id = v_school
    and j.run_after >= now() + interval '6 days 23 hours' and j.run_after <= now() + interval '7 days 1 minute');
  perform pg_temp.ok('map_reject audits map.reject without the reason text (F-74)',
    exists (select 1 from public.audit_log l
             where l.action = 'map.reject' and l.target_table = 'map_versions' and l.target_id = v_map::text
               and l.school_id = v_school and l.state_after = '{"approval_status": "rejected"}'::jsonb
               and position('clinic' in l.state_before::text || l.state_after::text || l.metadata::text) = 0));
  perform pg_temp.fails('map_reject of an already rejected version is state_changed',
    pg_temp.q_reject(a, v_map, 'Again'), 'state_changed');
  r := pg_temp.web(pg_temp.q_noarg(a, 'api_district_maps_pending', 'district.maps.read'));
  perform pg_temp.ok('a rejected version leaves the pending list',
    not exists (select 1 from jsonb_array_elements(r->'maps') as x(e) where x.e->>'mapVersionId' = v_map::text));
end $$;

-- ---------------------------------------------------------------------------------------------------
-- identity_rebind (F-45)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  v_user constant uuid := '00000000-5a00-4000-8000-000000000003';
  r jsonb;
begin
  update public.staff_users set google_sub = 'sub-0310-office-old' where id = v_user;
  r := pg_temp.web(pg_temp.q_rebind(a, v_user));
  perform pg_temp.ok('identity_rebind clears google_sub so the next sign-in rebinds by invitation',
    r->>'staffUserId' = v_user::text and (r->>'wasBound')::boolean and not (r->>'bound')::boolean
    and (select google_sub from public.staff_users where id = v_user) is null);
  perform pg_temp.ok('identity_rebind audits identity.rebind without the email or the subject',
    exists (select 1 from public.audit_log l
             where l.action = 'identity.rebind' and l.target_table = 'staff_users' and l.target_id = v_user::text
               and l.school_id is null and l.state_before = '{"bound": true}'::jsonb
               and l.state_after = '{"bound": false}'::jsonb
               and position('@' in l.state_before::text || l.state_after::text || l.metadata::text) = 0
               and position('sub-0310' in l.state_before::text || l.state_after::text || l.metadata::text) = 0));
  r := pg_temp.web(pg_temp.q_rebind(a, v_user));
  perform pg_temp.ok('identity_rebind of an unbound user is a no-op', not (r->>'wasBound')::boolean);
  perform pg_temp.fails('identity_rebind refuses the acting admin''s own identity',
    pg_temp.q_rebind(a, '00000000-5a00-4000-8000-000000000001'), 'invalid_input', 'staff_user_id');
  perform pg_temp.fails('identity_rebind of an unknown user is not_found',
    pg_temp.q_rebind(a, '00000000-5a00-4000-8000-00000000ffff'), 'not_found');
end $$;

-- ---------------------------------------------------------------------------------------------------
-- stats (§17)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  r jsonb;
  f jsonb;
begin
  insert into public.daily_school_stats (school_id, day, posted, approved, rejected, received, claimed, searches,
                                         queue_age_p95_hours)
  values ('0a0a0a0a-0000-4000-8000-000000000001', '2001-02-03', 5, 4, 1, 3, 2, 40, 5.5),
         ('0a0a0a0a-0000-4000-8000-000000000001', '2001-02-04', 2, 2, 0, 1, 1, 10, 7.25),
         ('0b0b0b0b-0000-4000-8000-000000000002', '2001-02-03', 1, 1, 0, 0, 0, 3, null);
  r := pg_temp.web(pg_temp.q_stats(a, '2001-02-01', '2001-02-28'));
  select x.e into f from jsonb_array_elements(r->'schools') as x(e) where x.e->>'code' = 'FCHS';
  perform pg_temp.ok('stats sums daily_school_stats per school over the range',
    r->>'from' = '2001-02-01' and r->>'to' = '2001-02-28'
    and (f->'totals'->>'posted')::int = 7 and (f->'totals'->>'approved')::int = 6
    and (f->'totals'->>'claimed')::int = 3 and (f->'totals'->>'searches')::int = 50
    and (f->'totals'->>'days')::int = 2 and (f->'totals'->>'queueAgeP95HoursMax')::float8 = 7.25
    and jsonb_array_length(r->'schools') = (select count(*) from public.schools));
  perform pg_temp.ok('stats adds district totals across schools',
    (r->'district'->'totals'->>'posted')::int = 8 and (r->'district'->'totals'->>'days')::int = 3
    and (r->'district'->'totals'->>'queueAgeP95HoursMax')::float8 = 7.25);
  perform pg_temp.ok('stats reports live review-queue and job-queue ages',
    f->'queue' ?& array['pending', 'oldestPendingAgeS'] and (f->'queue'->>'pending')::int >= 1
    and (f->'queue'->>'oldestPendingAgeS') is not null
    and (r->'district'->'queue'->>'pending')::int >= (f->'queue'->>'pending')::int
    and r->'district'->'jobs' ?& array['queued', 'oldestQueuedAgeS', 'dead']);
  r := pg_temp.web(pg_temp.q_stats(a, null, null));
  perform pg_temp.ok('stats defaults to the last 30 days',
    (r->>'to')::date = current_date and (r->>'from')::date = current_date - 29);
  perform pg_temp.fails('stats refuses from after to',
    pg_temp.q_stats(a, '2001-03-01', '2001-02-01'), 'invalid_input', 'from');
  perform pg_temp.fails('stats refuses a range over 366 days',
    pg_temp.q_stats(a, '2000-01-01', '2001-06-01'), 'invalid_input', 'to');
end $$;

-- ---------------------------------------------------------------------------------------------------
-- alerts (§17: audit rows named alert.<name>)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  r jsonb;
begin
  insert into public.audit_log (school_id, actor_kind, actor_id, action, target_table, target_id, metadata, created_at)
  values ('0a0a0a0a-0000-4000-8000-000000000001', 'system', 'evaluate_alerts', 'alert.queue_age_high', 'schools',
          '0a0a0a0a-0000-4000-8000-000000000001', '{"p95_hours": 30}', now() + interval '2 hours'),
         (null, 'system', 'evaluate_alerts', 'alert.dead_jobs', 'jobs', 'district', '{"count": 2}',
          now() + interval '1 hour');
  r := pg_temp.web(pg_temp.q_alerts(a, 2));
  perform pg_temp.ok('alerts returns the newest alert rows first with the school code',
    jsonb_array_length(r->'alerts') = 2
    and r->'alerts'->0->>'action' = 'alert.queue_age_high' and r->'alerts'->0->>'name' = 'queue_age_high'
    and r->'alerts'->0->>'schoolCode' = 'FCHS'
    and r->'alerts'->0->>'schoolId' = '0a0a0a0a-0000-4000-8000-000000000001'
    and r->'alerts'->0->'metadata' = '{"p95_hours": 30}'::jsonb
    and r->'alerts'->1->>'action' = 'alert.dead_jobs' and r->'alerts'->1->'schoolCode' = 'null'::jsonb
    and r->'alerts'->1->'schoolId' = 'null'::jsonb and r->'alerts'->1->>'createdAt' is not null);
  perform pg_temp.ok('alert rows carry exactly id, action, name, schoolId, schoolCode, createdAt, metadata',
    not exists (select 1 from jsonb_array_elements(r->'alerts') as x(e)
                 where (select array_agg(k.key order by k.key collate "C") from jsonb_object_keys(x.e) as k(key))
                       <> array['action', 'createdAt', 'id', 'metadata', 'name', 'schoolCode', 'schoolId']));
  r := pg_temp.web(pg_temp.q_alerts(a, 1000));
  perform pg_temp.ok('alerts caps the page at 200 rows of alert.* actions only',
    jsonb_array_length(r->'alerts') between 2 and 200
    and not exists (select 1 from jsonb_array_elements(r->'alerts') as x(e) where x.e->>'action' not like 'alert.%'));
  r := pg_temp.web(pg_temp.q_alerts(a, 0));
  perform pg_temp.ok('alerts clamps a limit below 1 to one row', jsonb_array_length(r->'alerts') = 1);
end $$;

-- ---------------------------------------------------------------------------------------------------
-- onboarding (§24)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  a constant text := 'sub-0310-district-admin';
  r jsonb;
  v_steps jsonb;
  v_pinned boolean;
begin
  r := pg_temp.web(pg_temp.q_onboarding(a, 'fchs'));
  select jsonb_object_agg(x.e->>'key', x.e->'done') into v_steps from jsonb_array_elements(r->'steps') as x(e);
  select not exists (select 1 from public.locations l
                      where l.school_id = '0a0a0a0a-0000-4000-8000-000000000001' and l.active
                        and not exists (select 1 from public.location_map_pins p
                                         where p.location_id = l.id
                                           and p.map_version_id = '0a0a0a0a-2000-4000-8000-000000000001'))
    into v_pinned;
  perform pg_temp.ok('onboarding lists the eight §24 steps for the seeded FCHS in order',
    r->'school'->>'code' = 'FCHS' and (r->>'total')::int = 8
    and (select array_agg(x.e->>'key' order by x.i) from jsonb_array_elements(r->'steps') with ordinality as x(e, i))
        = array['timezoneValid', 'calendar90Days', 'activeMap', 'activeMapZone', 'locationsPinned',
                'adminInvited', 'adminActive', 'studentPosting']);
  perform pg_temp.ok('onboarding marks the seeded FCHS setup steps done',
    v_steps->'timezoneValid' = 'true'::jsonb and v_steps->'calendar90Days' = 'true'::jsonb
    and v_steps->'activeMap' = 'true'::jsonb and v_steps->'activeMapZone' = 'true'::jsonb
    and v_steps->'adminInvited' = 'true'::jsonb and v_steps->'locationsPinned' = to_jsonb(v_pinned)
    and v_steps->'studentPosting' = to_jsonb((select student_posting_enabled from public.schools where code = 'FCHS'))
    and (r->>'done')::int = (select count(*) from jsonb_each(v_steps) as x(k, v) where x.v = 'true'::jsonb)
    and (r->>'complete')::boolean = ((r->>'done')::int = 8));

  update public.staff_members set status = 'active' where id = '00000000-5b00-4000-8000-000000000002';
  r := pg_temp.web(pg_temp.q_onboarding(a, 'FCHS'));
  perform pg_temp.ok('onboarding sees the first school admin become active',
    exists (select 1 from jsonb_array_elements(r->'steps') as x(e)
             where x.e->>'key' = 'adminActive' and x.e->'done' = 'true'::jsonb));

  r := pg_temp.web(pg_temp.q_onboarding(a, 'DZQX'));
  select jsonb_object_agg(x.e->>'key', x.e->'done') into v_steps from jsonb_array_elements(r->'steps') as x(e);
  perform pg_temp.ok('onboarding shows a newly created school at the start of the checklist',
    v_steps = '{"timezoneValid": true, "calendar90Days": false, "activeMap": false, "activeMapZone": false,
                "locationsPinned": false, "adminInvited": true, "adminActive": false, "studentPosting": false}'::jsonb
    and (r->>'done')::int = 2 and not (r->>'complete')::boolean);
  perform pg_temp.fails('onboarding of an unknown school is not_found',
    pg_temp.q_onboarding(a, 'QQQQQQ'), 'not_found');
end $$;

rollback;
