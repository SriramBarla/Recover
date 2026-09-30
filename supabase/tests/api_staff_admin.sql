-- School-admin staff functions (0305; BUILD-CONTRACT 6.2 school-admin part, section 5 role matrix, §5.5, §24).
-- One transaction, rolled back at the end. Every failed check raises; every passing check prints NOTICE PASS.
-- Calls run as recover_web with named arguments and an assertion minted here exactly like assertion.ts.
\set ON_ERROR_STOP 1
begin;

-- ---------- setup (migration role, a member of recover_web since 0002; everything below is rolled back) ----------

-- The test key is 32 bytes of 0x42 (tests/vectors); version 1 is current and there is no previous version.
do $$
declare
  v_id uuid;
  s record;
begin
  for s in select * from (values ('staff_assertion_key_v1', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI'),
                                 ('staff_assertion_key_current', '1'),
                                 ('staff_assertion_key_previous', '')) as t(name, secret) loop
    select id into v_id from vault.secrets where name = s.name;
    if v_id is null then
      perform vault.create_secret(s.secret, s.name);
    else
      perform vault.update_secret(v_id, s.secret);
    end if;
  end loop;
end $$;

-- Seeded identities (supabase/seed.sql) bound to test subjects; seeded memberships forced to active.
update public.staff_users u set google_sub = 't305-' || v.sub
  from (values ('00000000-5a00-4000-8000-000000000001'::uuid, 'district'),
               ('00000000-5a00-4000-8000-000000000002'::uuid, 'fchs-admin'),
               ('00000000-5a00-4000-8000-000000000003'::uuid, 'fchs-office'),
               ('00000000-5a00-4000-8000-000000000004'::uuid, 'fchs-reviewer'),
               ('00000000-5a00-4000-8000-000000000005'::uuid, 'multi'),
               ('00000000-5a00-4000-8000-000000000006'::uuid, 'sfhs-admin'),
               ('00000000-5a00-4000-8000-000000000007'::uuid, 'nfms-admin')) as v(id, sub)
 where u.id = v.id;
update public.staff_members set status = 'active' where id::text like '00000000-5b00-4000-8000-00000000000_';
update public.district_settings
   set staff_email_domains = '{recover.test}', retention_days_floor = 14, retention_days_ceiling = 60
 where id = 1;
update public.schools set retention_days = 30, enabled_categories = '{bag,clothing,bottle,book,electronics_low,jewelry,sports,other}',
       student_posting_enabled = true
 where code = 'FCHS';

-- Assertion v1 (section 5): canonical body via private.canonical_json, the twelve lines of canonicalLines,
-- HMAC-SHA256 with the 0x42 key, base64url without padding.
create function pg_temp.mint(p_sub text, p_scope text, p_op text, p_target uuid, p_row_version bigint, p_body jsonb)
returns jsonb language plpgsql as $$
declare
  v_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_req text := lower(gen_random_uuid()::text);
  v_sha text := encode(extensions.digest(convert_to(private.canonical_json(p_body), 'UTF8'), 'sha256'), 'hex');
  v_lines text;
begin
  v_lines := array_to_string(array[
    'v1', v_req, p_sub, lower(p_scope), p_op, coalesce(lower(p_target::text), '-'),
    coalesce(p_row_version::text, '-'), v_sha, '-', '1', v_iat::text, (v_iat + 30)::text], E'\n');
  return jsonb_build_object(
    'v', 'v1', 'request_id', v_req, 'google_sub', p_sub, 'scope', lower(p_scope), 'operation', p_op,
    'target_id', lower(p_target::text), 'row_version', p_row_version, 'body_sha256', v_sha,
    'idempotency_key_sha256', null, 'key_version', 1, 'iat', v_iat, 'exp', v_iat + 30,
    'mac', rtrim(translate(encode(extensions.hmac(convert_to(v_lines, 'UTF8'), decode(repeat('42', 32), 'hex'), 'sha256'),
                                  'base64'), '+/', '-_'), '='));
end $$;

-- Calls public.<p_fn> as recover_web. p_args holds the business arguments keyed without the p_ prefix (absent
-- keys are NULL); the asserted body is every argument of the signature, as the web builds it from the values
-- it passes. The scope defaults to school:<id of p_args.school_code>.
create function pg_temp.call(p_sub text, p_fn text, p_op text, p_target uuid, p_args jsonb, p_scope text default null)
returns jsonb language plpgsql as $$
declare
  a record;
  v_body jsonb := '{}'::jsonb;
  v_list text := 'p_assert => $1';
  v_assert jsonb;
  r jsonb;
begin
  for a in
    select x.name, format_type(x.typ, null) as typ
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      cross join lateral unnest(p.proargnames, p.proargtypes::oid[]) with ordinality as x(name, typ, ord)
     where p.proname = p_fn and x.name <> 'p_assert'
     order by x.ord
  loop
    v_body := v_body || jsonb_build_object(substr(a.name, 3), coalesce(p_args -> substr(a.name, 3), 'null'::jsonb));
    v_list := v_list || format(', %I => ', a.name) ||
      case when a.typ = 'jsonb' then format('nullif($2 -> %L, ''null''::jsonb)', substr(a.name, 3))
           else format('($2 ->> %L)::%s', substr(a.name, 3), a.typ) end;
  end loop;
  v_assert := pg_temp.mint(p_sub,
    coalesce(p_scope, 'school:' || (select s.id::text from public.schools s where s.code = upper(p_args ->> 'school_code'))),
    p_op, p_target, null, v_body);
  set local role recover_web;
  execute format('select public.%I(%s)', p_fn, v_list) into r using v_assert, p_args;
  reset role;
  return r;
end $$;

-- 'ok', or the RV001 code with its detail ('invalid_input:email'), or the raw SQLSTATE for anything else.
create function pg_temp.err(p_sub text, p_fn text, p_op text, p_target uuid, p_args jsonb, p_scope text default null)
returns text language plpgsql as $$
declare
  v_detail text;
begin
  perform pg_temp.call(p_sub, p_fn, p_op, p_target, p_args, p_scope);
  return 'ok';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlstate = 'RV001' then
    return sqlerrm || coalesce(':' || nullif(v_detail, ''), '');
  end if;
  return 'sqlstate ' || sqlstate || ': ' || sqlerrm;
end $$;

create function pg_temp.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.eq(p_got text, p_want text, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL: % (got %, want %)', p_label, p_got, p_want;
  end if;
  raise notice 'PASS %', p_label;
end $$;

create function pg_temp.keyset(p jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(p) as k
$$;

create function pg_temp.fchs() returns uuid language sql as $$
  select id from public.schools where code = 'FCHS'
$$;

-- independent statement of the horizon: offset of the first day from today with no calendar row
create function pg_temp.coverage(p_school uuid, p_today date) returns int language sql as $$
  select min(g.d::date) - p_today
    from generate_series(p_today, p_today + 3000, interval '1 day') as g(d)
   where not exists (select 1 from public.school_calendar_days c where c.school_id = p_school and c.day = g.d::date)
$$;

-- ---------- catalog: definer, owner, search_path, lock_timeout, grants ----------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'api_staff_roster_list', 'api_staff_roster_invite', 'api_staff_roster_update', 'api_staff_locations_list',
    'api_staff_location_upsert', 'api_staff_location_pin_set', 'api_staff_map_versions', 'api_staff_map_create_draft',
    'api_staff_zone_upsert', 'api_staff_map_submit', 'api_staff_config_get', 'api_staff_config_update',
    'api_staff_calendar_upsert', 'api_staff_stats', 'api_staff_audit'] loop
    perform pg_temp.ok((
      select count(*) = 1 and bool_and(
               p.prosecdef and pg_get_userbyid(p.proowner) = 'recover_api_owner'
               and p.proconfig @> array['search_path=""', 'lock_timeout=3s']
               and p.proargnames[1] = 'p_assert' and p.prorettype = 'jsonb'::regtype
               and has_function_privilege('recover_web', p.oid, 'execute')
               and not has_function_privilege('recover_worker', p.oid, 'execute')
               and not exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn), v_fn || ': definer/owner/search_path/grants');
  end loop;
end $$;

-- ---------- roster: role matrix, domain allowlist, district_admin never grantable ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
  v_member uuid;
  v_again uuid;
begin
  r := pg_temp.call('t305-fchs-admin', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}');
  perform pg_temp.ok(jsonb_array_length(r -> 'members') >= 4
                     and exists (select 1 from jsonb_array_elements(r -> 'members') m
                                  where m ->> 'id' = '00000000-5b00-4000-8000-000000000003'
                                    and m ->> 'email' = 'office.fchs@recover.test' and m ->> 'role' = 'office'),
                     'roster_list: school_admin lists the school roster');
  perform pg_temp.eq(pg_temp.keyset(r -> 'members' -> 0), 'displayName,email,id,lastLoginAt,role,status',
                     'roster_list: member shape');
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(r -> 'members') m
                                  where m ->> 'id' in ('00000000-5b00-4000-8000-000000000001',
                                                       '00000000-5b00-4000-8000-000000000007')),
                     'roster_list: no district_admin and no other-school memberships');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'roster_list: reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'roster_list: office forbidden');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@recover.test","role":"reviewer"}'),
                     'forbidden', 'roster_invite: reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_roster_update', 'roster.update',
                                 '00000000-5b00-4000-8000-000000000003',
                                 '{"school_code":"FCHS","member_id":"00000000-5b00-4000-8000-000000000003","role":"reviewer"}'),
                     'forbidden', 'roster_update: reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-district', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}'),
                     'ok', 'roster_list: district_admin authorizes any school');
  perform pg_temp.eq(pg_temp.err('t305-sfhs-admin', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'roster_list: school_admin of another school forbidden');
  perform pg_temp.eq(pg_temp.err('t305-multi', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"SFHS"}'),
                     'forbidden', 'roster_list: multi-school office forbidden at SFHS');
  perform pg_temp.eq(pg_temp.err('t305-nobody', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'roster_list: unknown subject forbidden');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_list', 'roster.invite', null, '{"school_code":"FCHS"}'),
                     'assertion_invalid', 'assertion: operation mismatch rejected');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_list', 'roster.read', null, '{"school_code":"FCHS"}',
                                 'school:' || (select id from public.schools where code = 'SFHS')),
                     'assertion_invalid', 'assertion: scope mismatch rejected');

  -- §14.1 exact domain match
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@evil.test","role":"reviewer"}'),
                     'invalid_input:email', 'roster_invite: wrong domain refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@sub.recover.test","role":"reviewer"}'),
                     'invalid_input:email', 'roster_invite: subdomain refused (no suffix match)');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@recover.test.evil.com","role":"reviewer"}'),
                     'invalid_input:email', 'roster_invite: allowlisted prefix refused (no substring match)');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x","role":"reviewer"}'),
                     'invalid_input:email', 'roster_invite: malformed email refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@recover.test","role":"district_admin"}'),
                     'forbidden:role', 'roster_invite: district_admin cannot be granted');
  perform pg_temp.eq(pg_temp.err('t305-district', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@recover.test","role":"district_admin"}'),
                     'forbidden:role', 'roster_invite: not even a district_admin grants district_admin here');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.x@recover.test","role":"janitor"}'),
                     'invalid_input:role', 'roster_invite: unknown role refused');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                    '{"school_code":"FCHS","email":"  T305.New@Recover.TEST ","role":"office","display_name":"New Person"}');
  v_member := (r ->> 'memberId')::uuid;
  perform pg_temp.eq(pg_temp.keyset(r) || '|' || (r ->> 'signInPath'), 'memberId,signInPath|/staff/signin',
                     'roster_invite: returns memberId and the sign-in path');
  perform pg_temp.ok(exists (select 1 from public.staff_members sm join public.staff_users su on su.id = sm.user_id
                              where sm.id = v_member and sm.school_id = v_fchs and sm.role = 'office'
                                and sm.status = 'invited' and sm.invited_by = '00000000-5b00-4000-8000-000000000002'
                                and su.email = 't305.new@recover.test' and su.display_name = 'New Person'
                                and su.google_sub is null),
                     'roster_invite: staff_users created (lowercased) and membership invited');
  perform pg_temp.ok((select count(*) = 1 and bool_and(a.state_after = jsonb_build_object('role', 'office', 'school_id', v_fchs)
                                                        and a.actor_kind = 'staff'
                                                        and a.actor_id = '00000000-5b00-4000-8000-000000000002'
                                                        and a.target_table = 'staff_members' and a.request_id is not null)
                        from public.audit_log a where a.action = 'staff.invite' and a.target_id = v_member::text),
                     'roster_invite: audit staff.invite with {role, school_id}');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                    '{"school_code":"FCHS","email":"t305.new@recover.test","role":"office"}');
  perform pg_temp.ok((r ->> 'memberId')::uuid = v_member
                     and (select count(*) from public.audit_log a where a.action = 'staff.invite' and a.target_id = v_member::text) = 1,
                     'roster_invite: repeating the same invite is a no-op');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                                 '{"school_code":"FCHS","email":"t305.new@recover.test","role":"reviewer"}'),
                     'state_changed:already_member', 'roster_invite: a live membership is changed by roster_update, not invite');

  -- an existing user from another school gets a second membership; no second staff_users row
  r := pg_temp.call('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                    '{"school_code":"FCHS","email":"admin.sfhs@recover.test","role":"reviewer"}');
  perform pg_temp.ok((select count(*) from public.staff_users where lower(email) = 'admin.sfhs@recover.test') = 1
                     and exists (select 1 from public.staff_members
                                  where id = (r ->> 'memberId')::uuid and school_id = v_fchs
                                    and user_id = '00000000-5a00-4000-8000-000000000006' and role = 'reviewer'),
                     'roster_invite: existing user joins this school without a new identity');
  -- deactivating that membership removes the SFHS admin's FCHS access although the user stays active at SFHS
  perform pg_temp.call('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', (r ->> 'memberId')::uuid,
                       jsonb_build_object('school_code', 'FCHS', 'member_id', r ->> 'memberId', 'status', 'deactivated'));
  perform pg_temp.eq(pg_temp.err('t305-sfhs-admin', 'api_staff_stats', 'stats.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'roster_update: a deactivated membership at the target school authorizes nothing');

  -- roster_update
  r := pg_temp.call('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', v_member,
                    jsonb_build_object('school_code', 'FCHS', 'member_id', v_member, 'role', 'reviewer'));
  perform pg_temp.ok(r = jsonb_build_object('memberId', v_member, 'role', 'reviewer', 'status', 'invited')
                     and exists (select 1 from public.audit_log a
                                  where a.action = 'staff.update' and a.target_id = v_member::text
                                    and a.state_before = '{"role":"office","status":"invited"}'
                                    and a.state_after = '{"role":"reviewer","status":"invited"}'),
                     'roster_update: role change with audit staff.update');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', v_member,
                                 jsonb_build_object('school_code', 'FCHS', 'member_id', v_member, 'role', 'district_admin')),
                     'forbidden:role', 'roster_update: district_admin cannot be granted');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', v_member,
                                 jsonb_build_object('school_code', 'FCHS', 'member_id', v_member, 'status', 'suspended')),
                     'invalid_input:status', 'roster_update: unknown status refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_update', 'roster.update',
                                 '00000000-5b00-4000-8000-000000000001',
                                 '{"school_code":"FCHS","member_id":"00000000-5b00-4000-8000-000000000001","status":"deactivated"}'),
                     'not_found', 'roster_update: district_admin membership untouchable');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_update', 'roster.update',
                                 '00000000-5b00-4000-8000-000000000007',
                                 '{"school_code":"FCHS","member_id":"00000000-5b00-4000-8000-000000000007","status":"deactivated"}'),
                     'not_found', 'roster_update: another school''s membership unreachable');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_roster_update', 'roster.update',
                                 '00000000-5b00-4000-8000-000000000002',
                                 '{"school_code":"FCHS","member_id":"00000000-5b00-4000-8000-000000000002","status":"deactivated"}'),
                     'forbidden:self', 'roster_update: an admin cannot deactivate their own membership');

  -- a deactivated member loses access immediately; reactivation restores it
  perform pg_temp.call('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', '00000000-5b00-4000-8000-000000000003',
                       '{"school_code":"FCHS","member_id":"00000000-5b00-4000-8000-000000000003","status":"deactivated"}');
  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_stats', 'stats.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'roster_update: deactivated member is forbidden');
  perform pg_temp.call('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', '00000000-5b00-4000-8000-000000000003',
                       '{"school_code":"FCHS","member_id":"00000000-5b00-4000-8000-000000000003","status":"active"}');
  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_stats', 'stats.read', null, '{"school_code":"FCHS"}'),
                     'ok', 'roster_update: reactivated member regains access');

  -- a deactivated membership is reactivated to invited by a new invite
  perform pg_temp.call('t305-fchs-admin', 'api_staff_roster_update', 'roster.update', v_member,
                       jsonb_build_object('school_code', 'FCHS', 'member_id', v_member, 'status', 'deactivated'));
  r := pg_temp.call('t305-fchs-admin', 'api_staff_roster_invite', 'roster.invite', null,
                    '{"school_code":"FCHS","email":"t305.new@recover.test","role":"school_admin"}');
  v_again := (r ->> 'memberId')::uuid;
  perform pg_temp.ok(v_again = v_member and exists (select 1 from public.staff_members
                                                    where id = v_member and status = 'invited' and role = 'school_admin'),
                     'roster_invite: deactivated membership reactivated to invited');

  -- the district admin manages school rosters too
  r := pg_temp.call('t305-district', 'api_staff_roster_update', 'roster.update', v_member,
                    jsonb_build_object('school_code', 'fchs', 'member_id', v_member, 'role', 'office'));
  perform pg_temp.ok(r ->> 'role' = 'office'
                     and exists (select 1 from public.audit_log a where a.action = 'staff.update'
                                    and a.target_id = v_member::text and a.actor_id = '00000000-5b00-4000-8000-000000000001'),
                     'roster_update: district_admin acts on a school roster (lowercase code)');
  perform pg_temp.eq(pg_temp.err('t305-nfms-admin', 'api_staff_roster_update', 'roster.update', v_member,
                                 jsonb_build_object('school_code', 'NFMS', 'member_id', v_member, 'status', 'deactivated')),
                     'not_found', 'roster_update: an FCHS member is unreachable through NFMS');
end $$;

-- ---------- locations ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
  v_a uuid;
  v_b uuid;
begin
  r := pg_temp.call('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', null,
                    '{"school_code":"FCHS","code":"T305A","name":"Test Booth","hours":"Lunch only","active":true}');
  v_a := (r ->> 'id')::uuid;
  perform pg_temp.ok(r - 'id' = '{"code":"T305A","name":"Test Booth","hours":"Lunch only","active":true}',
                     'location_upsert: create returns the location');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', null,
                    '{"school_code":"FCHS","code":" t305b ","name":"  Side Door  "}');
  v_b := (r ->> 'id')::uuid;
  perform pg_temp.ok(r ->> 'code' = 'T305B' and r ->> 'name' = 'Side Door' and (r -> 'hours') = 'null'
                     and (r -> 'active') = 'true', 'location_upsert: code uppercased, text trimmed, active by default');
  perform set_config('t305.loc_a', v_a::text, true);
  perform set_config('t305.loc_b', v_b::text, true);
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', null,
                                 '{"school_code":"FCHS","code":"t305a","name":"Duplicate"}'),
                     'invalid_input:code', 'location_upsert: code unique per school');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', null,
                                 '{"school_code":"FCHS","code":"TOO-LONG","name":"Bad Code"}'),
                     'invalid_input:code', 'location_upsert: code format');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', null,
                                 '{"school_code":"FCHS","code":"T305C","name":"X"}'),
                     'invalid_input:name', 'location_upsert: name length');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', v_a,
                                 jsonb_build_object('school_code', 'FCHS', 'location_id', v_a, 'code', 'T305Z')),
                     'invalid_input:code', 'location_upsert: code immutable after create');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write',
                                 '0b0b0b0b-1000-4000-8000-000000000001',
                                 '{"school_code":"FCHS","location_id":"0b0b0b0b-1000-4000-8000-000000000001","name":"Hijack"}'),
                     'not_found', 'location_upsert: another school''s location unreachable');
  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_location_upsert', 'locations.write', null,
                                 '{"school_code":"FCHS","code":"T305C","name":"Office Try"}'),
                     'forbidden', 'location_upsert: office forbidden');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_locations_list', 'locations.read', null,
                                 '{"school_code":"FCHS"}'),
                     'forbidden', 'locations_list: reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-nfms-admin', 'api_staff_location_upsert', 'locations.write', null,
                                 '{"school_code":"FCHS","code":"T305C","name":"Other School"}'),
                     'forbidden', 'location_upsert: school_admin of another school forbidden');

  -- one item physically held at T305A (and past its retention, so it is also disposition-due)
  insert into public.items (school_id, public_id, category, description, dropoff_location_id, current_location_id,
                            review_status, reviewed_at, reviewed_by, publication_status, custody, received_at,
                            expires_at, posted_by_kind, posted_by_staff_id)
  values (v_fchs, 'FCHS-T305A-990001', 'bag', 'Blue test bag', v_a, v_a, 'approved', now(),
          '00000000-5b00-4000-8000-000000000002', 'hidden', 'at_location', now() - interval '31 days',
          now() - interval '1 day', 'staff', '00000000-5b00-4000-8000-000000000003');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', v_a,
                                 jsonb_build_object('school_code', 'FCHS', 'location_id', v_a, 'active', false)),
                     'invalid_input:active', 'location_upsert: deactivation refused while an item is at_location there');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', v_b,
                    jsonb_build_object('school_code', 'FCHS', 'location_id', v_b, 'active', false));
  perform pg_temp.ok((r -> 'active') = 'false', 'location_upsert: deactivation allowed with no items held');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', v_b,
                    jsonb_build_object('school_code', 'FCHS', 'location_id', v_b, 'active', true));
  perform pg_temp.ok((r -> 'active') = 'true', 'location_upsert: reactivation');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_location_upsert', 'locations.write', v_a,
                    jsonb_build_object('school_code', 'FCHS', 'location_id', v_a, 'code', 'T305A',
                                       'name', 'Test Booth East', 'hours', ''));
  perform pg_temp.ok(r ->> 'name' = 'Test Booth East' and (r -> 'hours') = 'null'
                     and exists (select 1 from public.audit_log a
                                  where a.action = 'location.update' and a.target_id = v_a::text
                                    and a.metadata = '{"changed_keys":["name","hours"]}'),
                     'location_upsert: rename, blank hours clears, audit lists changed keys');
  perform pg_temp.ok(exists (select 1 from public.jobs j
                              where j.kind = 'invalidate_cache' and j.school_id = v_fchs and j.status = 'queued'
                                and j.dedupe_key = 'invalidate_cache:' || v_fchs || ':' || txid_current()),
                     'location_upsert: invalidates the school meta cache in the same transaction');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_locations_list', 'locations.read', null, '{"school_code":"FCHS"}');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(r -> 'locations') l
                              where l ->> 'id' = v_a::text and (l -> 'atLocationCount') = '1' and (l -> 'pins') = '[]')
                     and exists (select 1 from jsonb_array_elements(r -> 'locations') l
                                  where l ->> 'code' = 'W' and jsonb_array_length(l -> 'pins') >= 1),
                     'locations_list: held-item counts and pins per map version');
  perform pg_temp.eq(pg_temp.keyset(r -> 'locations' -> 0), 'active,atLocationCount,code,hours,id,name,pins',
                     'locations_list: location shape');
end $$;

-- ---------- map drafts, zones, pins, submit ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
  v_map uuid;
  v_zone uuid;
  v_loc record;
  v_approved uuid := '0a0a0a0a-2000-4000-8000-000000000001';
  v_sfhs_map uuid := '0b0b0b0b-2000-4000-8000-000000000001';
begin
  r := pg_temp.call('t305-fchs-admin', 'api_staff_map_create_draft', 'map.create', null, '{"school_code":"FCHS"}');
  v_map := (r ->> 'mapVersionId')::uuid;
  perform pg_temp.ok(pg_temp.keyset(r) = 'mapVersionId'
                     and exists (select 1 from public.map_versions
                                  where id = v_map and school_id = v_fchs and approval_status = 'draft' and not active
                                    and draft_storage_path = v_fchs || '/' || v_map || '/draft'
                                    and created_by = '00000000-5b00-4000-8000-000000000002'),
                     'map_create_draft: draft row with the section 8 draft key');
  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_map_create_draft', 'map.create', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'map_create_draft: office forbidden');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                    jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Front Steps',
                                       'cx', '0.250000', 'cy', '0.500000', 'radius', '0.100000'));
  v_zone := (r ->> 'zoneId')::uuid;
  perform pg_temp.ok(r - 'zoneId' = jsonb_build_object('mapVersionId', v_map, 'name', 'Front Steps', 'cx', 0.25, 'cy', 0.5,
                                                       'radius', 0.1, 'active', true),
                     'zone_upsert: create on a draft');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'front steps',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.1')),
                     'invalid_input:name', 'zone_upsert: name unique per version (case-insensitive)');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'A',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.1')),
                     'invalid_input:name', 'zone_upsert: name 2 to 40 characters');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Far Away',
                                                    'cx', '1.5', 'cy', '0.5', 'radius', '0.1')),
                     'invalid_input:cx', 'zone_upsert: cx within 0..1');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Not A Number',
                                                    'cx', '0.5', 'cy', 'NaN', 'radius', '0.1')),
                     'invalid_input:cy', 'zone_upsert: NaN refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Garbage',
                                                    'cx', '0.5', 'cy', 'abc', 'radius', '0.1')),
                     'invalid_input:cy', 'zone_upsert: malformed number refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Point',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0')),
                     'invalid_input:radius', 'zone_upsert: radius above 0');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Huge',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.500001')),
                     'invalid_input:radius', 'zone_upsert: radius at most 0.5');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'No Radius',
                                                    'cx', '0.5', 'cy', '0.5')),
                     'invalid_input:radius', 'zone_upsert: geometry required on create');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_approved, 'name', 'Late Zone',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.1')),
                     'state_changed:zones_frozen', 'zone_upsert: approved map refused (G-07)');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_sfhs_map, 'name', 'Other',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.1')),
                     'not_found', 'zone_upsert: another school''s map version unreachable');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Reviewer',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.1')),
                     'forbidden', 'zone_upsert: reviewer forbidden');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', v_zone,
                    jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'zone_id', v_zone,
                                       'name', 'Front Stairs'));
  perform pg_temp.ok(r ->> 'name' = 'Front Stairs' and (r -> 'cx') = '0.25' and (r -> 'radius') = '0.1',
                     'zone_upsert: partial update keeps geometry');

  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_map_submit', 'map.submit', v_map,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map)),
                     'invalid_input:map_image', 'map_submit: refused until the canonical map is ready');
  -- the worker's system_map_canonical_ready would record these
  update public.map_versions set width_px = 1600, height_px = 1000,
         draft_canonical_path = v_fchs || '/' || v_map || '/canonical.jpg'
   where id = v_map;
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_map_submit', 'map.submit', v_map,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map)),
                     'invalid_input:pins', 'map_submit: refused without a pin for every active location');

  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_pin_set', 'locations.write',
                                 current_setting('t305.loc_a')::uuid,
                                 jsonb_build_object('school_code', 'FCHS', 'location_id', current_setting('t305.loc_a'),
                                                    'map_version_id', v_map, 'x', '1.200000', 'y', '0.5')),
                     'invalid_input:x', 'location_pin_set: x within 0..1');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_pin_set', 'locations.write',
                                 current_setting('t305.loc_a')::uuid,
                                 jsonb_build_object('school_code', 'FCHS', 'location_id', current_setting('t305.loc_a'),
                                                    'map_version_id', v_map, 'x', '0.5', 'y', '-0.000001')),
                     'invalid_input:y', 'location_pin_set: y within 0..1');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_pin_set', 'locations.write',
                                 current_setting('t305.loc_a')::uuid,
                                 jsonb_build_object('school_code', 'FCHS', 'location_id', current_setting('t305.loc_a'),
                                                    'map_version_id', v_sfhs_map, 'x', '0.5', 'y', '0.5')),
                     'not_found', 'location_pin_set: another school''s map version unreachable');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_location_pin_set', 'locations.write',
                                 '0b0b0b0b-1000-4000-8000-000000000001',
                                 jsonb_build_object('school_code', 'FCHS', 'location_id', '0b0b0b0b-1000-4000-8000-000000000001',
                                                    'map_version_id', v_map, 'x', '0.5', 'y', '0.5')),
                     'not_found', 'location_pin_set: another school''s location unreachable');
  for v_loc in select id from public.locations where school_id = v_fchs and active order by code loop
    r := pg_temp.call('t305-fchs-admin', 'api_staff_location_pin_set', 'locations.write', v_loc.id,
                      jsonb_build_object('school_code', 'FCHS', 'location_id', v_loc.id, 'map_version_id', v_map,
                                         'x', '0.123456', 'y', '0.654321'));
  end loop;
  perform pg_temp.ok(r = jsonb_build_object('locationId', v_loc.id, 'mapVersionId', v_map, 'x', 0.123456, 'y', 0.654321)
                     and (select count(*) from public.location_map_pins p where p.map_version_id = v_map)
                         = (select count(*) from public.locations where school_id = v_fchs and active)
                     and not exists (select 1 from public.audit_log a
                                      where a.action = 'location.pin_set' and (a.metadata ? 'x' or a.state_after ? 'x')),
                     'location_pin_set: pins every active location; no coordinates in audit (F-74)');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', v_zone,
                    jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'zone_id', v_zone, 'active', false));
  perform pg_temp.ok((r -> 'active') = 'false' and exists (select 1 from public.map_zones where id = v_zone and not active),
                     'zone_upsert: p_active false soft-disables');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_map_submit', 'map.submit', v_map,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map)),
                     'invalid_input:zones', 'map_submit: refused without an active zone');
  perform pg_temp.call('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', v_zone,
                       jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'zone_id', v_zone, 'active', true));

  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_map_submit', 'map.submit', v_map,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map)),
                     'forbidden', 'map_submit: office forbidden');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_map_submit', 'map.submit', v_map,
                    jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map));
  perform pg_temp.ok(r ->> 'approvalStatus' = 'pending_district' and r ->> 'submittedAt' is not null
                     and exists (select 1 from public.map_versions
                                  where id = v_map and approval_status = 'pending_district' and submitted_at is not null)
                     and exists (select 1 from public.audit_log a
                                  where a.action = 'map.submit' and a.target_id = v_map::text
                                    and a.state_after = '{"approval_status":"pending_district"}'),
                     'map_submit: draft -> pending_district with audit map.submit');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', v_zone,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'zone_id', v_zone,
                                                    'name', 'Renamed Late')),
                     'state_changed:zones_frozen', 'zone_upsert: update fails after submit');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_zone_upsert', 'zones.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map, 'name', 'Added Late',
                                                    'cx', '0.5', 'cy', '0.5', 'radius', '0.1')),
                     'state_changed:zones_frozen', 'zone_upsert: create fails after submit');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_map_submit', 'map.submit', v_map,
                                 jsonb_build_object('school_code', 'FCHS', 'map_version_id', v_map)),
                     'state_changed:approval_status', 'map_submit: only from draft');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_map_versions', 'map.read', null, '{"school_code":"FCHS"}');
  perform pg_temp.eq(pg_temp.keyset(r -> 'versions' -> 0),
                     'active,approvalStatus,approvedAt,createdAt,hasCanonical,hasDraft,height,id,rejectedReason,submittedAt,width,zoneCount',
                     'map_versions: version shape');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(r -> 'versions') v
                              where v ->> 'id' = v_map::text and v ->> 'approvalStatus' = 'pending_district'
                                and (v -> 'zoneCount') = '1' and (v -> 'hasDraft') = 'true' and (v -> 'hasCanonical') = 'true'
                                and (v -> 'width') = '1600' and (v -> 'active') = 'false')
                     and exists (select 1 from jsonb_array_elements(r -> 'versions') v
                                  where v ->> 'id' = v_approved::text and (v -> 'active') = 'true'
                                    and (v -> 'hasCanonical') = 'true' and (v -> 'zoneCount') = '5')
                     and position('/draft' in r::text) = 0 and position('.jpg' in r::text) = 0,
                     'map_versions: states, zone counts, image flags, and never a storage path');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_map_versions', 'map.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'map_versions: reviewer forbidden');
end $$;

-- ---------- config ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
  v_audits int;
begin
  r := pg_temp.call('t305-fchs-admin', 'api_staff_config_get', 'config.read', null, '{"school_code":"FCHS"}');
  perform pg_temp.eq(pg_temp.keyset(r -> 'config'),
                     'crossSchoolSearchEnabled,enabledCategories,lateArrivalGraceDays,lostReportsEnabled,neverArrivedSchoolDays,retentionDays,studentPostingEnabled,terminalTextRetentionDays',
                     'config_get: config keys mirror config_update');
  perform pg_temp.ok((r -> 'config' -> 'retentionDays') = '30' and (r -> 'district' -> 'retentionDaysFloor') = '14'
                     and (r -> 'district' -> 'retentionDaysCeiling') = '60' and r -> 'school' ->> 'code' = 'FCHS'
                     and jsonb_typeof(r -> 'calendarHorizonDays') = 'number',
                     'config_get: settings, district bounds, and calendar horizon');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_config_get', 'config.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'config_get: reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-multi', 'api_staff_config_get', 'config.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'config_get: multi-school reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-fchs-office', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"retentionDays":45}}'),
                     'forbidden', 'config_update: office forbidden');

  -- F-64 bounds come from the schools_retention trigger, which the function lets through
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"retentionDays":5}}'),
                     'invalid_input:retention_days', 'config_update: retention below the district floor');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"retentionDays":90}}'),
                     'invalid_input:retention_days', 'config_update: retention above the district ceiling');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"retentionDays":400}}'),
                     'invalid_input:retentionDays', 'config_update: retention outside the column range');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"retentionDays":"45"}}'),
                     'invalid_input:retentionDays', 'config_update: integers must be JSON numbers');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"studentPostingEnabled":"yes"}}'),
                     'invalid_input:studentPostingEnabled', 'config_update: flags must be JSON booleans');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"neverArrivedSchoolDays":11}}'),
                     'invalid_input:neverArrivedSchoolDays', 'config_update: never-arrived days range');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"retentionDays":45,"timezone":"UTC"}}'),
                     'invalid_input:timezone', 'config_update: unknown key refused by name');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{}}'),
                     'invalid_input:changes', 'config_update: empty change set refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"enabledCategories":["bag","phone"]}}'),
                     'invalid_input:enabledCategories', 'config_update: high-value categories refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"enabledCategories":[]}}'),
                     'invalid_input:enabledCategories', 'config_update: at least one category');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                                 '{"school_code":"FCHS","changes":{"enabledCategories":"bag"}}'),
                     'invalid_input:enabledCategories', 'config_update: categories must be an array');
  perform pg_temp.ok((select retention_days = 30 from public.schools where id = v_fchs),
                     'config_update: refused updates change nothing');

  r := pg_temp.call('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                    '{"school_code":"FCHS","changes":{"retentionDays":45,"studentPostingEnabled":false,"enabledCategories":["book","bag","bag"]}}');
  perform pg_temp.ok((r -> 'config' -> 'retentionDays') = '45' and (r -> 'config' -> 'studentPostingEnabled') = 'false'
                     and (r -> 'config' -> 'enabledCategories') = '["bag","book"]'
                     and exists (select 1 from public.schools where id = v_fchs and retention_days = 45
                                    and not student_posting_enabled and enabled_categories = '{bag,book}'),
                     'config_update: applies accepted keys; categories deduplicated in enum order');
  perform pg_temp.ok(exists (select 1 from public.audit_log a
                              where a.action = 'school.config' and a.school_id = v_fchs and a.target_id = v_fchs::text
                                and a.metadata = '{"changed_keys":["enabledCategories","retentionDays","studentPostingEnabled"]}'
                                and a.state_before = '{}' and a.state_after = '{}'),
                     'config_update: audit school.config with changed_keys only');
  perform pg_temp.ok(exists (select 1 from public.jobs j
                              where j.kind = 'invalidate_cache' and j.school_id = v_fchs
                                and j.payload = jsonb_build_object('tags', jsonb_build_array('school:' || v_fchs))),
                     'config_update: invalidates school:<id>');
  select count(*) into v_audits from public.audit_log where action = 'school.config' and school_id = v_fchs;
  r := pg_temp.call('t305-fchs-admin', 'api_staff_config_update', 'config.write', null,
                    '{"school_code":"FCHS","changes":{"retentionDays":45}}');
  perform pg_temp.ok((select count(*) from public.audit_log where action = 'school.config' and school_id = v_fchs) = v_audits,
                     'config_update: an unchanged value writes no audit row');
end $$;

-- ---------- calendar ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
  v_today date := (now() at time zone 'America/New_York')::date;
  v_bad jsonb;
  v_label text;
begin
  r := pg_temp.call('t305-fchs-admin', 'api_staff_calendar_upsert', 'calendar.write', null,
                    jsonb_build_object('school_code', 'FCHS', 'days', jsonb_build_array(
                      jsonb_build_object('day', (v_today + 200)::text, 'isOpen', true, 'openAt', '08:00', 'closeAt', '15:30'),
                      jsonb_build_object('day', (v_today + 201)::text, 'isOpen', false, 'openAt', null, 'closeAt', null),
                      jsonb_build_object('day', (v_today + 202)::text, 'isOpen', true, 'openAt', '07:45', 'closeAt', '16:00'))));
  perform pg_temp.ok(r = jsonb_build_object('upserted', 3, 'horizonDays', pg_temp.coverage(v_fchs, v_today)),
                     'calendar_upsert: returns {upserted, horizonDays}');
  -- the horizon is unbroken coverage from today: days far ahead do not count until the gap before them is filled
  insert into public.school_calendar_days (school_id, day, is_open, source)
  select v_fchs, d::date, false, 'test'
    from generate_series(v_today, v_today + 199, interval '1 day') as d
  on conflict (school_id, day) do nothing;
  r := pg_temp.call('t305-fchs-admin', 'api_staff_calendar_upsert', 'calendar.write', null,
                    jsonb_build_object('school_code', 'FCHS', 'days', jsonb_build_array(
                      jsonb_build_object('day', (v_today + 200)::text, 'isOpen', true, 'openAt', '08:00', 'closeAt', '15:30'))));
  perform pg_temp.ok((r -> 'horizonDays')::int = pg_temp.coverage(v_fchs, v_today) and (r -> 'horizonDays')::int >= 203,
                     'calendar_upsert: horizon counts consecutive days from today');
  perform pg_temp.ok(exists (select 1 from public.school_calendar_days
                              where school_id = v_fchs and day = v_today + 200 and is_open
                                and open_at = '08:00' and close_at = '15:30' and source = 'school')
                     and exists (select 1 from public.school_calendar_days
                                  where school_id = v_fchs and day = v_today + 201 and not is_open and open_at is null),
                     'calendar_upsert: rows written');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_calendar_upsert', 'calendar.write', null,
                    jsonb_build_object('school_code', 'FCHS', 'days', jsonb_build_array(
                      jsonb_build_object('day', (v_today + 3)::text, 'isOpen', false))));
  perform pg_temp.ok((r -> 'upserted') = '1' and exists (select 1 from public.school_calendar_days
                                                          where school_id = v_fchs and day = v_today + 3 and not is_open),
                     'calendar_upsert: existing day updated (emergency closure)');
  perform pg_temp.ok(exists (select 1 from public.audit_log a
                              where a.action = 'calendar.update' and a.school_id = v_fchs and a.metadata = '{"days":3}'),
                     'calendar_upsert: audit calendar.update with {days}');

  for v_bad, v_label in select * from (values
      ('[{"day":"2031-01-06","isOpen":true}]'::jsonb, 'open day without hours'),
      ('[{"day":"2031-01-06","isOpen":true,"openAt":"15:00","closeAt":"08:00"}]', 'close before open'),
      ('[{"day":"2031-01-06","isOpen":false,"openAt":"08:00","closeAt":"15:00"}]', 'closed day with hours'),
      ('[{"day":"2031-02-30","isOpen":false}]', 'impossible date'),
      ('[{"day":"31-01-06","isOpen":false}]', 'malformed date'),
      ('[{"day":"2031-01-06","isOpen":true,"openAt":"7:30","closeAt":"15:00"}]', 'malformed time'),
      ('[{"day":"2031-01-06","isOpen":true,"openAt":"08:00","closeAt":"24:00"}]', 'hour out of range'),
      ('[{"day":"2031-01-06","isOpen":"true"}]', 'isOpen not boolean'),
      ('[{"day":"2031-01-06","isOpen":false,"note":"x"}]', 'unknown entry key'),
      ('[{"day":"2031-01-06","isOpen":false},{"day":"2031-01-06","isOpen":false}]', 'duplicate day'),
      ('[]', 'empty list'),
      ('{"day":"2031-01-06","isOpen":false}', 'not an array'),
      ('["2031-01-06"]', 'entry not an object')) as t(days, label) loop
    perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_calendar_upsert', 'calendar.write', null,
                                   jsonb_build_object('school_code', 'FCHS', 'days', v_bad)),
                       'invalid_input:days', 'calendar_upsert: ' || v_label);
  end loop;
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_calendar_upsert', 'calendar.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'days',
                                   (select jsonb_agg(jsonb_build_object('day', (date '2031-01-01' + g)::text, 'isOpen', false))
                                      from generate_series(0, 400) g))),
                     'invalid_input:days', 'calendar_upsert: at most 400 entries');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_calendar_upsert', 'calendar.write', null,
                                 jsonb_build_object('school_code', 'FCHS', 'days',
                                   jsonb_build_array(jsonb_build_object('day', '2031-01-06', 'isOpen', false)))),
                     'forbidden', 'calendar_upsert: reviewer forbidden');
end $$;

-- ---------- stats ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
  v_today date := (now() at time zone 'America/New_York')::date;
begin
  insert into public.daily_school_stats (school_id, day, posted, approved, queue_age_p95_hours)
  values (v_fchs, v_today - 1, 7, 5, 2.5)
  on conflict (school_id, day) do update set posted = 7, approved = 5, queue_age_p95_hours = 2.5;
  -- a pending item five hours old (staff-posted so no device digest is needed)
  insert into public.items (school_id, public_id, category, description, dropoff_location_id, review_status, custody,
                            posted_by_kind, posted_by_staff_id, created_at)
  values (v_fchs, 'FCHS-W-990002', 'book', 'Math textbook', '0a0a0a0a-1000-4000-8000-000000000001', 'pending',
          'with_finder', 'staff', '00000000-5b00-4000-8000-000000000003', now() - interval '5 hours');

  r := pg_temp.call('t305-fchs-reviewer', 'api_staff_stats', 'stats.read', null,
                    jsonb_build_object('school_code', 'FCHS', 'from', (v_today - 7)::text, 'to', v_today::text));
  perform pg_temp.eq(pg_temp.keyset(r), 'days,from,live,to', 'stats: response shape');
  perform pg_temp.eq(pg_temp.keyset(r -> 'live'), 'atLocation,dispositionDue,oldestPendingAgeHours,openLostReports,pendingQueue',
                     'stats: live counts shape');
  perform pg_temp.ok(r ->> 'from' = (v_today - 7)::text and r ->> 'to' = v_today::text
                     and exists (select 1 from jsonb_array_elements(r -> 'days') d
                                  where d ->> 'day' = (v_today - 1)::text and (d -> 'posted') = '7'
                                    and (d -> 'approved') = '5' and (d -> 'queueAgeP95Hours') = '2.5'),
                     'stats: rollup rows for the range (reviewer may read stats)');
  perform pg_temp.eq(pg_temp.keyset(r -> 'days' -> 0),
                     'approved,claimed,day,expired,highValueRedirects,lostReports,matchesSurfaced,matchesViewed,posted,queueAgeP95Hours,received,receivedCohort30d,receivedCohort7d,rejected,reportsClosedFound,screeningImages,searches,zeroResultSearches',
                     'stats: day row shape');
  perform pg_temp.ok((r -> 'live' ->> 'pendingQueue')::int >= 1 and (r -> 'live' ->> 'oldestPendingAgeHours')::numeric >= 5
                     and (r -> 'live' ->> 'atLocation')::int >= 1 and (r -> 'live' ->> 'dispositionDue')::int >= 1
                     and jsonb_typeof(r -> 'live' -> 'openLostReports') = 'number',
                     'stats: live queue, custody, disposition-due, and report counts');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_stats', 'stats.read', null, '{"school_code":"FCHS"}');
  perform pg_temp.ok(r ->> 'to' = v_today::text and r ->> 'from' = (v_today - 29)::text,
                     'stats: defaults to the last 30 school-local days');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_stats', 'stats.read', null,
                                 jsonb_build_object('school_code', 'FCHS', 'from', v_today::text, 'to', (v_today - 1)::text)),
                     'invalid_input:from', 'stats: from after to refused');
  perform pg_temp.eq(pg_temp.err('t305-fchs-admin', 'api_staff_stats', 'stats.read', null,
                                 jsonb_build_object('school_code', 'FCHS', 'from', (v_today - 400)::text, 'to', v_today::text)),
                     'invalid_input:from', 'stats: range bounded');
  perform pg_temp.eq(pg_temp.err('t305-multi', 'api_staff_stats', 'stats.read', null, '{"school_code":"SFHS"}'),
                     'ok', 'stats: multi-school user reads the school of its assertion');
  perform pg_temp.eq(pg_temp.err('t305-sfhs-admin', 'api_staff_stats', 'stats.read', null, '{"school_code":"FCHS"}'),
                     'forbidden', 'stats: staff at another school forbidden');
end $$;

-- ---------- audit ----------
do $$
declare
  r jsonb;
  v_fchs uuid := pg_temp.fchs();
begin
  r := pg_temp.call('t305-fchs-admin', 'api_staff_audit', 'audit.read', null, '{"school_code":"FCHS","limit":3}');
  perform pg_temp.ok(jsonb_array_length(r -> 'entries') = 3
                     and (select jsonb_agg(x.e -> 'id' order by x.o)
                            from jsonb_array_elements(r -> 'entries') with ordinality as x(e, o))
                         = (select jsonb_agg(to_jsonb(a.id) order by a.created_at desc, a.id desc)
                              from (select id, created_at from public.audit_log where school_id = v_fchs
                                     order by created_at desc, id desc limit 3) as a),
                     'audit: this school''s newest rows, newest first, limited');
  perform pg_temp.eq(pg_temp.keyset(r -> 'entries' -> 0),
                     'action,actorKind,createdAt,id,metadata,stateAfter,targetId,targetTable', 'audit: entry shape');
  r := pg_temp.call('t305-fchs-admin', 'api_staff_audit', 'audit.read', null, '{"school_code":"FCHS","limit":1000}');
  perform pg_temp.ok(jsonb_array_length(r -> 'entries') between 1 and 200
                     and exists (select 1 from jsonb_array_elements(r -> 'entries') e
                                  where e ->> 'action' = 'calendar.update' and e ->> 'actorKind' = 'staff'
                                    and e ->> 'targetTable' = 'school_calendar_days' and e ->> 'targetId' = v_fchs::text
                                    and (e -> 'metadata') = '{"days":1}'),
                     'audit: limit clamped to 200; entries carry action, actor kind, target, metadata');
  perform pg_temp.eq(pg_temp.err('t305-fchs-reviewer', 'api_staff_audit', 'audit.read', null, '{"school_code":"FCHS","limit":5}'),
                     'forbidden', 'audit: reviewer forbidden');
  perform pg_temp.eq(pg_temp.err('t305-nfms-admin', 'api_staff_audit', 'audit.read', null, '{"school_code":"FCHS","limit":5}'),
                     'forbidden', 'audit: school_admin of another school forbidden');
  -- F-74: nothing this family wrote carries an email, a display name, or a storage key
  perform pg_temp.ok(not exists (select 1 from public.audit_log a
                                  where a.school_id = v_fchs and a.created_at = now()
                                    and (a.state_before::text || a.state_after::text || a.metadata::text)
                                        ~ '(@|New Person|/draft|canonical\.jpg|0\.123456)'),
                     'audit: payloads carry no emails, names, paths, or pins');
end $$;

rollback;
