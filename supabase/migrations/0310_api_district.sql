-- 0310 district api family: every api_district_* function (BUILD-CONTRACT sections 3, 4, 5, 6.3; §5.6,
-- §9.4.1, §14, §17, §24; F-45, F-64, F-74, F-101, F-112; G-06, G-07, G-16, G-17, G-20, G-42).
--
-- Template (same as the other api families): SECURITY DEFINER, search_path '', lock_timeout 3s (G-20),
-- owner recover_api_owner, EXECUTE revoked from PUBLIC and granted to recover_web only, camelCase jsonb
-- built from explicit columns. The first statement of every function is private.assert_staff at DISTRICT
-- scope (p_school_id NULL, row_version NULL); district_admin is required through op_min_role('district.*').
--
-- Assertion operation, target and body per function (section 5, G-16). The body is jsonb_build_object of
-- every business argument, keyed by the argument name without p_, with uuids lowercased:
--   api_district_schools_list      district.schools.read     target -               body {}
--   api_district_school_create     district.school.create    target -               body {code, name, timezone, admin_email, admin_name}
--   api_district_settings_get      district.settings.read    target -               body {}
--   api_district_settings_update   district.settings.write   target -               body {changes}
--   api_district_maps_pending      district.maps.read        target -               body {}
--   api_district_map_reject        district.map.reject       target map_version_id  body {map_version_id, reason}
--   api_district_identity_rebind   district.identity.rebind  target staff_user_id   body {staff_user_id}
--   api_district_stats             district.stats.read       target -               body {from, to}  (dates as 'YYYY-MM-DD' or null)
--   api_district_alerts            district.alerts.read      target -               body {limit}
--   api_district_onboarding        district.onboarding.read  target -               body {school_code}
--
-- The private.dapi_* helpers are SECURITY INVOKER and owned by recover_api_owner, so they run with the
-- calling api function's privileges and are unreachable by any login role.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- =====================================================================================================
-- private helpers
-- =====================================================================================================

-- Admin-entered text: NFC, trimmed, whitespace runs collapsed, bounded; C0/C1 and bidi controls refused.
create or replace function private.dapi_text(p text, p_field text, p_min int, p_max int, p_required boolean)
returns text
language plpgsql stable set search_path = '' as $$
declare
  v text;
begin
  if p is null or btrim(p) = '' then
    if p_required then
      perform private.fail('invalid_input', p_field);
    end if;
    return null;
  end if;
  if p ~ '[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]' then
    perform private.fail('invalid_input', p_field);
  end if;
  v := regexp_replace(btrim(normalize(p, NFC)), '\s+', ' ', 'g');
  if char_length(v) < p_min or char_length(v) > p_max then
    perform private.fail('invalid_input', p_field);
  end if;
  return v;
end $$;

-- Typed readers for p_changes values. Each check is its own statement so a cast never runs on bad input.
create or replace function private.dapi_int(p jsonb, p_field text, p_min int, p_max int) returns int
language plpgsql stable set search_path = '' as $$
declare
  v int;
begin
  if p is null or jsonb_typeof(p) is distinct from 'number' then
    perform private.fail('invalid_input', p_field);
  end if;
  if (p #>> '{}') !~ '^-?[0-9]{1,9}$' then
    perform private.fail('invalid_input', p_field);
  end if;
  v := (p #>> '{}')::int;
  if v < p_min or v > p_max then
    perform private.fail('invalid_input', p_field);
  end if;
  return v;
end $$;

create or replace function private.dapi_bool(p jsonb, p_field text) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) is distinct from 'boolean' then
    perform private.fail('invalid_input', p_field);
  end if;
  return p = 'true'::jsonb;
end $$;

-- §14.1: exact parsed domains (never suffix matching), lowercased, deduplicated, 1 to 20 entries.
create or replace function private.dapi_domains(p jsonb) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  e jsonb;
  s text;
  v text[] := '{}';
begin
  if p is null or jsonb_typeof(p) is distinct from 'array' then
    perform private.fail('invalid_input', 'staffEmailDomains');
  end if;
  if jsonb_array_length(p) not between 1 and 20 then
    perform private.fail('invalid_input', 'staffEmailDomains');
  end if;
  for e in select x.value from jsonb_array_elements(p) as x(value) loop
    if jsonb_typeof(e) is distinct from 'string' then
      perform private.fail('invalid_input', 'staffEmailDomains');
    end if;
    s := lower(btrim(e #>> '{}'));
    if char_length(s) > 253 or s !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
      perform private.fail('invalid_input', 'staffEmailDomains');
    end if;
    v := array_append(v, s);
  end loop;
  return (select array_agg(distinct x order by x) from unnest(v) as x);
end $$;

-- O-3 / G-42: campus ranges. Each entry must cast to cidr; stored in canonical cidr text, deduplicated.
create or replace function private.dapi_cidrs(p jsonb) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  e jsonb;
  c text;
  v text[] := '{}';
begin
  if p is null or jsonb_typeof(p) is distinct from 'array' then
    perform private.fail('invalid_input', 'campusCidrs');
  end if;
  if jsonb_array_length(p) > 200 then
    perform private.fail('invalid_input', 'campusCidrs');
  end if;
  for e in select x.value from jsonb_array_elements(p) as x(value) loop
    if jsonb_typeof(e) is distinct from 'string' or char_length(e #>> '{}') > 64 then
      perform private.fail('invalid_input', 'campusCidrs');
    end if;
    begin
      c := ((e #>> '{}')::cidr)::text;
    exception when others then
      c := null;
    end;
    if c is null then
      perform private.fail('invalid_input', 'campusCidrs');
    end if;
    v := array_append(v, c);
  end loop;
  return coalesce((select array_agg(z.c order by z.c::cidr) from (select distinct y as c from unnest(v) as y) as z),
                  '{}'::text[]);
end $$;

-- Same address shape as the staff family's invitation check (§14.1): lowercase, one @, allowed domain.
create or replace function private.dapi_email_allowed(p_email text, p_domains text[]) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
           p_email = lower(p_email)
           and char_length(p_email) <= 254
           and p_email ~ '^[^@[:space:]]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           and split_part(p_email, '@', 2) = any (p_domains),
         false)
$$;

-- F-101: a timezone is valid only if the server's tz database names it.
create or replace function private.dapi_tz_valid(p_tz text) returns boolean
language sql stable set search_path = '' as $$
  select p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = p_tz)
$$;

create or replace function private.dapi_settings_json(d public.district_settings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'retentionDaysFloor', d.retention_days_floor,
    'retentionDaysCeiling', d.retention_days_ceiling,
    'staffEmailDomains', to_jsonb(d.staff_email_domains),
    'lostReportTtlDays', d.lost_report_ttl_days,
    'studentPostingGlobalEnabled', d.student_posting_global_enabled,
    'lostReportsGlobalEnabled', d.lost_reports_global_enabled,
    'crossSchoolSearchGlobalEnabled', d.cross_school_search_global_enabled,
    'screeningEnabled', d.screening_enabled,
    'screeningDailyCeiling', d.screening_daily_ceiling,
    'rejectedMediaRetentionDays', d.rejected_media_retention_days,
    'workerMode', d.worker_mode,
    'campusCidrs', to_jsonb(d.campus_cidrs),
    'redactedSearchEnabled', d.redacted_search_enabled,
    'updatedAt', d.updated_at)
$$;

-- §24 checklist for one school. p_tz_valid is passed in so a list can resolve pg_timezone_names once.
create or replace function private.dapi_onboarding(p_school public.schools, p_tz_valid boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_today date := case when p_tz_valid then (now() at time zone p_school.timezone)::date else current_date end;
  v_calendar int;
  v_map uuid;
  v_zones int := 0;
  v_locations int;
  v_unpinned int;
  v_invited int;
  v_active int;
  v_steps jsonb;
  v_done int;
begin
  -- every date of the next 90 local days carries an explicit open/closed row (F-88 horizon)
  select count(*) into v_calendar
    from public.school_calendar_days c
   where c.school_id = p_school.id and c.day >= v_today and c.day < v_today + 90;
  select v.id into v_map
    from public.map_versions v
   where v.school_id = p_school.id and v.active and v.approval_status = 'approved';
  if v_map is not null then
    select count(*) into v_zones
      from public.map_zones z
     where z.map_version_id = v_map and z.school_id = p_school.id and z.active;
  end if;
  select count(*),
         count(*) filter (where v_map is null or not exists (
           select 1 from public.location_map_pins p where p.location_id = l.id and p.map_version_id = v_map))
    into v_locations, v_unpinned
    from public.locations l
   where l.school_id = p_school.id and l.active;
  select count(*) filter (where m.status <> 'deactivated'), count(*) filter (where m.status = 'active')
    into v_invited, v_active
    from public.staff_members m
   where m.school_id = p_school.id and m.role = 'school_admin';

  v_steps := jsonb_build_array(
    jsonb_build_object('key', 'timezoneValid', 'done', p_tz_valid),
    jsonb_build_object('key', 'calendar90Days', 'done', v_calendar >= 90, 'coveredDays', v_calendar, 'requiredDays', 90),
    jsonb_build_object('key', 'activeMap', 'done', v_map is not null, 'mapVersionId', v_map),
    jsonb_build_object('key', 'activeMapZone', 'done', v_zones > 0, 'zones', v_zones),
    jsonb_build_object('key', 'locationsPinned', 'done', v_map is not null and v_locations > 0 and v_unpinned = 0,
                       'activeLocations', v_locations, 'unpinned', v_unpinned),
    jsonb_build_object('key', 'adminInvited', 'done', v_invited > 0),
    jsonb_build_object('key', 'adminActive', 'done', v_active > 0),
    jsonb_build_object('key', 'studentPosting', 'done', p_school.student_posting_enabled));
  select count(*) into v_done from jsonb_array_elements(v_steps) as e(step) where e.step -> 'done' = 'true'::jsonb;
  return jsonb_build_object('steps', v_steps, 'done', v_done, 'total', jsonb_array_length(v_steps),
                            'complete', v_done = jsonb_array_length(v_steps));
end $$;

-- =====================================================================================================
-- schools
-- =====================================================================================================

-- Every school with its own switches, live item counts, and §24 onboarding completeness.
create or replace function public.api_district_schools_list(p_assert jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v_out jsonb;
begin
  v_ctx := private.assert_staff(p_assert, 'district.schools.read', null, null, null, jsonb_build_object());

  with counts as (
    select i.school_id,
           count(*) filter (where i.review_status = 'pending' and i.custody in ('with_finder', 'at_location')) as pending,
           count(*) filter (where i.review_status = 'approved' and i.publication_status = 'published'
                              and i.custody in ('with_finder', 'at_location')) as published,
           count(*) filter (where i.custody = 'at_location') as at_location
      from public.items i
     where i.deleted_at is null
     group by i.school_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'code', s.code,
           'name', s.name,
           'timezone', s.timezone,
           'active', s.active,
           'retentionDays', s.retention_days,
           'createdAt', s.created_at,
           'flags', jsonb_build_object('studentPosting', s.student_posting_enabled,
                                       'lostReports', s.lost_reports_enabled,
                                       'crossSchoolSearch', s.cross_school_search_enabled),
           'counts', jsonb_build_object('pending', coalesce(c.pending, 0),
                                        'published', coalesce(c.published, 0),
                                        'atLocation', coalesce(c.at_location, 0)),
           'onboarding', private.dapi_onboarding(s, s.timezone in (select t.name from pg_catalog.pg_timezone_names t))
                         - 'steps')
         order by s.code), '[]'::jsonb)
    into v_out
    from public.schools s
    left join counts c on c.school_id = s.id;
  return jsonb_build_object('schools', v_out);
end $$;

-- §24 step 1: create the school (every switch off, retention inside the district bounds) and invite its
-- first school_admin. No JIT provisioning beyond the invitation itself (§14.1).
create or replace function public.api_district_school_create(
  p_assert jsonb, p_code text, p_name text, p_timezone text, p_admin_email text, p_admin_name text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  d public.district_settings;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
  v_name text;
  v_admin_name text;
  v_retention int;
  v_school_id uuid;
  v_user_id uuid;
  v_user_created boolean := false;
  v_member_id uuid;
begin
  v_ctx := private.assert_staff(p_assert, 'district.school.create', null, null, null,
    jsonb_build_object('code', p_code, 'name', p_name, 'timezone', p_timezone,
                       'admin_email', p_admin_email, 'admin_name', p_admin_name));

  if v_code !~ '^[A-Z]{2,6}$' then
    perform private.fail('invalid_input', 'code');
  end if;
  v_name := private.dapi_text(p_name, 'name', 2, 120, true);
  if not private.dapi_tz_valid(p_timezone) then
    perform private.fail('invalid_input', 'timezone');  -- F-101
  end if;
  v_admin_name := private.dapi_text(p_admin_name, 'admin_name', 1, 120, false);

  -- F-64: hold the policy row so a concurrent floor/ceiling change serializes with this insert.
  select * into d from public.district_settings where id = 1 for share;
  if not found then
    perform private.fail('not_found', 'district_settings');
  end if;
  if not private.dapi_email_allowed(v_email, d.staff_email_domains) then
    perform private.fail('invalid_input', 'admin_email');
  end if;
  v_retention := greatest(d.retention_days_floor, least(d.retention_days_ceiling, 30));

  insert into public.schools (code, name, timezone, student_posting_enabled, lost_reports_enabled,
                              cross_school_search_enabled, retention_days, active)
  values (v_code, v_name, p_timezone, false, false, false, v_retention, true)
  on conflict (code) do nothing
  returning id into v_school_id;
  if v_school_id is null then
    perform private.fail('invalid_input', 'code');  -- codes are permanent and never reused (§4)
  end if;

  select u.id into v_user_id from public.staff_users u where lower(u.email) = v_email for update;
  if v_user_id is null then
    insert into public.staff_users (email, display_name) values (v_email, v_admin_name)
    on conflict ((lower(email))) do nothing
    returning id into v_user_id;
    if v_user_id is null then
      select u.id into v_user_id from public.staff_users u where lower(u.email) = v_email for update;
    else
      v_user_created := true;
    end if;
  elsif v_admin_name is not null then
    update public.staff_users set display_name = v_admin_name where id = v_user_id and display_name is null;
  end if;

  insert into public.staff_members (user_id, school_id, role, status, invited_by)
  values (v_user_id, v_school_id, 'school_admin', 'invited', v_ctx.member_id)
  returning id into v_member_id;

  -- F-74: identifiers and settings only; never the school name, the email, or the display name.
  perform private.audit(v_school_id, 'staff', v_ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'school.create', 'schools', v_school_id::text, '{}'::jsonb,
    jsonb_build_object('code', v_code, 'timezone', p_timezone, 'retention_days', v_retention, 'active', true,
                       'student_posting_enabled', false, 'lost_reports_enabled', false,
                       'cross_school_search_enabled', false),
    jsonb_build_object('admin_member_id', v_member_id, 'admin_user_id', v_user_id,
                       'admin_user_created', v_user_created));

  return jsonb_build_object(
    'schoolId', v_school_id,
    'code', v_code,
    'name', v_name,
    'timezone', p_timezone,
    'retentionDays', v_retention,
    'active', true,
    'flags', jsonb_build_object('studentPosting', false, 'lostReports', false, 'crossSchoolSearch', false),
    'admin', jsonb_build_object('userId', v_user_id, 'memberId', v_member_id, 'role', 'school_admin',
                                'status', 'invited', 'userCreated', v_user_created));
end $$;

-- =====================================================================================================
-- district settings
-- =====================================================================================================

create or replace function public.api_district_settings_get(p_assert jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  d public.district_settings;
begin
  v_ctx := private.assert_staff(p_assert, 'district.settings.read', null, null, null, jsonb_build_object());
  select * into d from public.district_settings where id = 1;
  if not found then
    perform private.fail('not_found', 'district_settings');
  end if;
  -- the current school range tells the UI which floor/ceiling values would strand a school (F-64)
  return private.dapi_settings_json(d) || jsonb_build_object('schoolRetention',
    (select jsonb_build_object('min', min(s.retention_days), 'max', max(s.retention_days)) from public.schools s));
end $$;

-- Partial update from an allowlisted camelCase change set. Unknown keys and any invalid value refuse the
-- whole change; nothing is half-applied. Audited as district.config with the changed keys only.
create or replace function public.api_district_settings_update(p_assert jsonb, p_changes jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v_allowed constant text[] := array[
    'retentionDaysFloor', 'retentionDaysCeiling', 'staffEmailDomains', 'lostReportTtlDays',
    'studentPostingGlobalEnabled', 'lostReportsGlobalEnabled', 'crossSchoolSearchGlobalEnabled',
    'screeningEnabled', 'screeningDailyCeiling', 'rejectedMediaRetentionDays', 'workerMode',
    'campusCidrs', 'redactedSearchEnabled'];
  d public.district_settings;
  n public.district_settings;
  k text;
  v jsonb;
  v_actor_domain text;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
begin
  v_ctx := private.assert_staff(p_assert, 'district.settings.write', null, null, null,
    jsonb_build_object('changes', p_changes));

  if p_changes is null or jsonb_typeof(p_changes) is distinct from 'object' or p_changes = '{}'::jsonb then
    perform private.fail('invalid_input', 'changes');
  end if;
  if exists (select 1 from jsonb_object_keys(p_changes) as x(key) where x.key <> all (v_allowed)) then
    perform private.fail('invalid_input', 'changes');
  end if;

  select * into d from public.district_settings where id = 1 for update;
  if not found then
    perform private.fail('not_found', 'district_settings');
  end if;
  n := d;

  for k, v in select e.key, e.value from jsonb_each(p_changes) as e(key, value) loop
    case k
      when 'retentionDaysFloor' then n.retention_days_floor := private.dapi_int(v, k, 1, 365);
      when 'retentionDaysCeiling' then n.retention_days_ceiling := private.dapi_int(v, k, 1, 365);
      when 'staffEmailDomains' then n.staff_email_domains := private.dapi_domains(v);
      when 'lostReportTtlDays' then n.lost_report_ttl_days := private.dapi_int(v, k, 1, 180);
      when 'studentPostingGlobalEnabled' then n.student_posting_global_enabled := private.dapi_bool(v, k);
      when 'lostReportsGlobalEnabled' then n.lost_reports_global_enabled := private.dapi_bool(v, k);
      when 'crossSchoolSearchGlobalEnabled' then n.cross_school_search_global_enabled := private.dapi_bool(v, k);
      when 'screeningEnabled' then n.screening_enabled := private.dapi_bool(v, k);
      when 'screeningDailyCeiling' then n.screening_daily_ceiling := private.dapi_int(v, k, 0, 1000000);
      when 'rejectedMediaRetentionDays' then n.rejected_media_retention_days := private.dapi_int(v, k, 1, 90);
      when 'workerMode' then  -- G-06
        if v is null or v not in ('"normal"'::jsonb, '"quarantine"'::jsonb) then
          perform private.fail('invalid_input', 'workerMode');
        end if;
        n.worker_mode := v #>> '{}';
      when 'campusCidrs' then n.campus_cidrs := private.dapi_cidrs(v);
      when 'redactedSearchEnabled' then n.redacted_search_enabled := private.dapi_bool(v, k);
      else
        perform private.fail('invalid_input', 'changes');
    end case;
  end loop;

  if n.retention_days_floor > n.retention_days_ceiling then
    perform private.fail('invalid_input',
      case when p_changes ? 'retentionDaysFloor' then 'retentionDaysFloor' else 'retentionDaysCeiling' end);
  end if;

  -- F-64: refuse bounds that would strand a school (the district_retention trigger is the backstop).
  -- Share-locking every school first serializes with concurrent school retention writes.
  if n.retention_days_floor <> d.retention_days_floor or n.retention_days_ceiling <> d.retention_days_ceiling then
    perform 1 from public.schools s for share;
    if exists (select 1 from public.schools s where s.retention_days < n.retention_days_floor) then
      perform private.fail('invalid_input', 'retentionDaysFloor');
    end if;
    if exists (select 1 from public.schools s where s.retention_days > n.retention_days_ceiling) then
      perform private.fail('invalid_input', 'retentionDaysCeiling');
    end if;
  end if;

  -- §14.1: the acting admin may not remove the domain they sign in with (self-lockout guard).
  if p_changes ? 'staffEmailDomains' then
    select split_part(u.email, '@', 2) into v_actor_domain from public.staff_users u where u.id = v_ctx.user_id;
    if v_actor_domain is null or not (v_actor_domain = any (n.staff_email_domains)) then
      perform private.fail('invalid_input', 'staffEmailDomains');
    end if;
  end if;

  v_before := private.dapi_settings_json(d);
  v_after := private.dapi_settings_json(n);
  select coalesce(array_agg(x.key order by x.key collate "C"), '{}'::text[]) into v_changed
    from jsonb_object_keys(p_changes) as x(key)
   where v_before -> x.key is distinct from v_after -> x.key;
  if cardinality(v_changed) = 0 then
    return v_before || jsonb_build_object('changedKeys', '[]'::jsonb);
  end if;

  update public.district_settings
     set retention_days_floor = n.retention_days_floor,
         retention_days_ceiling = n.retention_days_ceiling,
         staff_email_domains = n.staff_email_domains,
         lost_report_ttl_days = n.lost_report_ttl_days,
         student_posting_global_enabled = n.student_posting_global_enabled,
         lost_reports_global_enabled = n.lost_reports_global_enabled,
         cross_school_search_global_enabled = n.cross_school_search_global_enabled,
         screening_enabled = n.screening_enabled,
         screening_daily_ceiling = n.screening_daily_ceiling,
         rejected_media_retention_days = n.rejected_media_retention_days,
         worker_mode = n.worker_mode,
         campus_cidrs = n.campus_cidrs,
         redacted_search_enabled = n.redacted_search_enabled
   where id = 1
  returning * into n;

  -- §5.5: global switches are AND-ed into every school's public meta, so every cached school is stale.
  if v_changed && array['studentPostingGlobalEnabled', 'lostReportsGlobalEnabled', 'crossSchoolSearchGlobalEnabled'] then
    perform private.invalidate(s.id) from public.schools s where s.active;
  end if;

  perform private.audit(null, 'staff', v_ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'district.config', 'district_settings', '1', '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object('changed_keys', to_jsonb(v_changed)));

  return private.dapi_settings_json(n) || jsonb_build_object('changedKeys', to_jsonb(v_changed));
end $$;

-- =====================================================================================================
-- map review (§9.4.1, G-07). Activation is worker-brokered (map.activate ticket), so only reject lives here.
-- =====================================================================================================

-- Versions awaiting district review with their zone package and location pins. Never a storage path.
create or replace function public.api_district_maps_pending(p_assert jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v_out jsonb;
begin
  v_ctx := private.assert_staff(p_assert, 'district.maps.read', null, null, null, jsonb_build_object());

  select coalesce(jsonb_agg(jsonb_build_object(
           'mapVersionId', v.id,
           'schoolId', s.id,
           'schoolCode', s.code,
           'schoolName', s.name,
           'width', v.width_px,
           'height', v.height_px,
           'submittedAt', v.submitted_at,
           'zones', (select coalesce(jsonb_agg(jsonb_build_object('id', z.id, 'name', z.name, 'cx', z.cx, 'cy', z.cy,
                                                                   'radius', z.radius) order by z.name), '[]'::jsonb)
                       from public.map_zones z
                      where z.map_version_id = v.id and z.school_id = v.school_id and z.active),
           'pins', (select coalesce(jsonb_agg(jsonb_build_object('locationId', l.id, 'code', l.code, 'name', l.name,
                                                                  'active', l.active, 'x', p.pin_x, 'y', p.pin_y)
                                              order by l.code), '[]'::jsonb)
                      from public.location_map_pins p
                      join public.locations l on l.id = p.location_id and l.school_id = p.school_id
                     where p.map_version_id = v.id and p.school_id = v.school_id),
           -- activation is refused until every active pickup location is pinned (§24 step 3)
           'unpinnedLocations', (select coalesce(jsonb_agg(jsonb_build_object('locationId', l.id, 'code', l.code,
                                                                               'name', l.name) order by l.code),
                                                 '[]'::jsonb)
                                   from public.locations l
                                  where l.school_id = v.school_id and l.active
                                    and not exists (select 1 from public.location_map_pins p
                                                     where p.location_id = l.id and p.map_version_id = v.id)))
         order by v.submitted_at nulls last, v.id), '[]'::jsonb)
    into v_out
    from public.map_versions v
    join public.schools s on s.id = v.school_id
   where v.approval_status = 'pending_district';
  return jsonb_build_object('maps', v_out);
end $$;

-- pending_district -> rejected. F-112: the private draft bytes are purged after the 7-day window.
create or replace function public.api_district_map_reject(p_assert jsonb, p_map_version_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v public.map_versions;
  v_reason text;
  v_code text;
  v_delete_after timestamptz := now() + interval '7 days';
begin
  v_ctx := private.assert_staff(p_assert, 'district.map.reject', null, p_map_version_id, null,
    jsonb_build_object('map_version_id', lower(p_map_version_id::text), 'reason', p_reason));

  if p_map_version_id is null then
    perform private.fail('invalid_input', 'map_version_id');
  end if;
  v_reason := private.dapi_text(p_reason, 'reason', 1, 200, true);

  select * into v from public.map_versions where id = p_map_version_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v.approval_status <> 'pending_district' then
    perform private.fail('state_changed', 'map_not_pending');
  end if;

  update public.map_versions
     set approval_status = 'rejected', rejected_reason = v_reason, active = false
   where id = v.id;

  perform private.enqueue('delete_map_draft', jsonb_build_object('mapVersionId', v.id), v.school_id,
    'delete_map_draft:' || v.id::text, v_delete_after);

  -- the reason is free text: it stays on the version row and never reaches the audit log (F-74)
  perform private.audit(v.school_id, 'staff', v_ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'map.reject', 'map_versions', v.id::text,
    jsonb_build_object('approval_status', 'pending_district'),
    jsonb_build_object('approval_status', 'rejected'),
    jsonb_build_object('draft_delete_after_days', 7));

  select s.code into v_code from public.schools s where s.id = v.school_id;
  return jsonb_build_object('mapVersionId', v.id, 'schoolId', v.school_id, 'schoolCode', v_code,
                            'approvalStatus', 'rejected', 'draftDeleteAfter', v_delete_after);
end $$;

-- =====================================================================================================
-- identity (F-45)
-- =====================================================================================================

-- Clears the bound Google subject so the next sign-in binds again through the invitation email
-- (api_staff_bind_identity). The email and the subject never reach the audit row.
create or replace function public.api_district_identity_rebind(p_assert jsonb, p_staff_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v_user_id uuid;
  v_was_bound boolean;
begin
  v_ctx := private.assert_staff(p_assert, 'district.identity.rebind', null, p_staff_user_id, null,
    jsonb_build_object('staff_user_id', lower(p_staff_user_id::text)));

  if p_staff_user_id is null or p_staff_user_id = v_ctx.user_id then
    perform private.fail('invalid_input', 'staff_user_id');  -- never the acting admin's own identity
  end if;
  select u.id, u.google_sub is not null into v_user_id, v_was_bound
    from public.staff_users u where u.id = p_staff_user_id for update;
  if v_user_id is null then
    perform private.fail('not_found');
  end if;
  if v_was_bound then
    update public.staff_users set google_sub = null where id = v_user_id;
  end if;

  perform private.audit(null, 'staff', v_ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'identity.rebind', 'staff_users', v_user_id::text,
    jsonb_build_object('bound', v_was_bound), jsonb_build_object('bound', false), '{}'::jsonb);

  return jsonb_build_object('staffUserId', v_user_id, 'wasBound', v_was_bound, 'bound', false);
end $$;

-- =====================================================================================================
-- dashboard (§5.6, §17)
-- =====================================================================================================

-- Per-school sums of daily_school_stats over [from, to] (default: the last 30 days, at most 366), district
-- totals, and live queue ages: pending review per school and district, plus the job queue.
create or replace function public.api_district_stats(p_assert jsonb, p_from date, p_to date)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v_to date;
  v_from date;
  v_schools jsonb;
  v_totals jsonb;
  v_queue jsonb;
  v_jobs jsonb;
begin
  v_ctx := private.assert_staff(p_assert, 'district.stats.read', null, null, null,
    jsonb_build_object('from', p_from, 'to', p_to));

  v_to := coalesce(p_to, current_date);
  v_from := coalesce(p_from, v_to - 29);
  if v_from > v_to then
    perform private.fail('invalid_input', 'from');
  end if;
  if v_to - v_from > 365 then
    perform private.fail('invalid_input', 'to');
  end if;

  with per as (
    select s.id, s.code, s.name, s.active, grouping(s.id) as g,
           jsonb_build_object(
             'days', count(d.day),
             'posted', coalesce(sum(d.posted), 0),
             'approved', coalesce(sum(d.approved), 0),
             'rejected', coalesce(sum(d.rejected), 0),
             'received', coalesce(sum(d.received), 0),
             'claimed', coalesce(sum(d.claimed), 0),
             'expired', coalesce(sum(d.expired), 0),
             'searches', coalesce(sum(d.searches), 0),
             'zeroResultSearches', coalesce(sum(d.zero_result_searches), 0),
             'lostReports', coalesce(sum(d.lost_reports), 0),
             'matchesSurfaced', coalesce(sum(d.matches_surfaced), 0),
             'matchesViewed', coalesce(sum(d.matches_viewed), 0),
             'reportsClosedFound', coalesce(sum(d.reports_closed_found), 0),
             'receivedCohort7d', coalesce(sum(d.received_cohort_7d), 0),
             'receivedCohort30d', coalesce(sum(d.received_cohort_30d), 0),
             'screeningImages', coalesce(sum(d.screening_images), 0),
             'highValueRedirects', coalesce(sum(d.high_value_redirects), 0),
             'queueAgeP95HoursMax', max(d.queue_age_p95_hours)) as totals
      from public.schools s
      left join public.daily_school_stats d on d.school_id = s.id and d.day between v_from and v_to
     group by grouping sets ((s.id, s.code, s.name, s.active), ())
  ), live as (
    select i.school_id, count(*) as pending, min(i.created_at) as oldest
      from public.items i
     where i.review_status = 'pending' and i.deleted_at is null and i.custody in ('with_finder', 'at_location')
     group by i.school_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'schoolId', p.id,
           'code', p.code,
           'name', p.name,
           'active', p.active,
           'totals', p.totals,
           'queue', jsonb_build_object('pending', coalesce(l.pending, 0),
                                       'oldestPendingAgeS', floor(extract(epoch from now() - l.oldest))::bigint))
           order by p.code) filter (where p.g = 0), '[]'::jsonb),
         (array_agg(p.totals) filter (where p.g = 1))[1]
    into v_schools, v_totals
    from per p
    left join live l on l.school_id = p.id and p.g = 0;

  select jsonb_build_object('pending', count(*),
                            'oldestPendingAgeS', floor(extract(epoch from now() - min(i.created_at)))::bigint)
    into v_queue
    from public.items i
   where i.review_status = 'pending' and i.deleted_at is null and i.custody in ('with_finder', 'at_location');

  select jsonb_build_object(
           'queued', (select count(*) from public.jobs j where j.status = 'queued'),
           'oldestQueuedAgeS', (select floor(extract(epoch from now() - min(j.run_after)))::bigint
                                  from public.jobs j where j.status = 'queued' and j.run_after <= now()),
           'dead', (select count(*) from public.jobs j where j.status = 'dead' and j.disposed_at is null))
    into v_jobs;

  return jsonb_build_object('from', v_from, 'to', v_to, 'schools', v_schools,
    'district', jsonb_build_object('totals', v_totals, 'queue', v_queue, 'jobs', v_jobs));
end $$;

-- §17: alerts are audit rows named alert.<name>; newest first, p_limit clamped to 1..200 (default 50).
create or replace function public.api_district_alerts(p_assert jsonb, p_limit int)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  v_limit int;
  v_out jsonb;
begin
  v_ctx := private.assert_staff(p_assert, 'district.alerts.read', null, null, null,
    jsonb_build_object('limit', p_limit));
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id,
           'action', a.action,
           'name', substr(a.action, 7),
           'schoolId', a.school_id,
           'schoolCode', s.code,
           'createdAt', a.created_at,
           'metadata', a.metadata)
           order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_out
    from (select l.id, l.action, l.school_id, l.created_at, l.metadata
            from public.audit_log l
           where l.action like 'alert.%'
           order by l.created_at desc, l.id desc
           limit v_limit) as a
    left join public.schools s on s.id = a.school_id;
  return jsonb_build_object('alerts', v_out);
end $$;

-- §24 checklist for one school (active or not) with each step's done state.
create or replace function public.api_district_onboarding(p_assert jsonb, p_school_code text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_ctx private.staff_ctx;
  s public.schools;
begin
  v_ctx := private.assert_staff(p_assert, 'district.onboarding.read', null, null, null,
    jsonb_build_object('school_code', p_school_code));

  select * into s from public.schools where code = upper(btrim(coalesce(p_school_code, '')));
  if not found then
    perform private.fail('not_found');
  end if;
  return jsonb_build_object('school', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name,
                                                         'timezone', s.timezone, 'active', s.active))
         || private.dapi_onboarding(s, private.dapi_tz_valid(s.timezone));
end $$;

-- =====================================================================================================
-- ownership and grants
-- =====================================================================================================

alter function private.dapi_text(text, text, int, int, boolean) owner to recover_api_owner;
alter function private.dapi_int(jsonb, text, int, int) owner to recover_api_owner;
alter function private.dapi_bool(jsonb, text) owner to recover_api_owner;
alter function private.dapi_domains(jsonb) owner to recover_api_owner;
alter function private.dapi_cidrs(jsonb) owner to recover_api_owner;
alter function private.dapi_email_allowed(text, text[]) owner to recover_api_owner;
alter function private.dapi_tz_valid(text) owner to recover_api_owner;
alter function private.dapi_settings_json(public.district_settings) owner to recover_api_owner;
alter function private.dapi_onboarding(public.schools, boolean) owner to recover_api_owner;
revoke all on function private.dapi_text(text, text, int, int, boolean) from public;
revoke all on function private.dapi_int(jsonb, text, int, int) from public;
revoke all on function private.dapi_bool(jsonb, text) from public;
revoke all on function private.dapi_domains(jsonb) from public;
revoke all on function private.dapi_cidrs(jsonb) from public;
revoke all on function private.dapi_email_allowed(text, text[]) from public;
revoke all on function private.dapi_tz_valid(text) from public;
revoke all on function private.dapi_settings_json(public.district_settings) from public;
revoke all on function private.dapi_onboarding(public.schools, boolean) from public;

alter function public.api_district_schools_list(jsonb) owner to recover_api_owner;
alter function public.api_district_school_create(jsonb, text, text, text, text, text) owner to recover_api_owner;
alter function public.api_district_settings_get(jsonb) owner to recover_api_owner;
alter function public.api_district_settings_update(jsonb, jsonb) owner to recover_api_owner;
alter function public.api_district_maps_pending(jsonb) owner to recover_api_owner;
alter function public.api_district_map_reject(jsonb, uuid, text) owner to recover_api_owner;
alter function public.api_district_identity_rebind(jsonb, uuid) owner to recover_api_owner;
alter function public.api_district_stats(jsonb, date, date) owner to recover_api_owner;
alter function public.api_district_alerts(jsonb, int) owner to recover_api_owner;
alter function public.api_district_onboarding(jsonb, text) owner to recover_api_owner;

revoke all on function public.api_district_schools_list(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_district_school_create(jsonb, text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.api_district_settings_get(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_district_settings_update(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_district_maps_pending(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.api_district_map_reject(jsonb, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.api_district_identity_rebind(jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.api_district_stats(jsonb, date, date) from public, anon, authenticated, service_role;
revoke all on function public.api_district_alerts(jsonb, int) from public, anon, authenticated, service_role;
revoke all on function public.api_district_onboarding(jsonb, text) from public, anon, authenticated, service_role;

grant execute on function public.api_district_schools_list(jsonb) to recover_web;
grant execute on function public.api_district_school_create(jsonb, text, text, text, text, text) to recover_web;
grant execute on function public.api_district_settings_get(jsonb) to recover_web;
grant execute on function public.api_district_settings_update(jsonb, jsonb) to recover_web;
grant execute on function public.api_district_maps_pending(jsonb) to recover_web;
grant execute on function public.api_district_map_reject(jsonb, uuid, text) to recover_web;
grant execute on function public.api_district_identity_rebind(jsonb, uuid) to recover_web;
grant execute on function public.api_district_stats(jsonb, date, date) to recover_web;
grant execute on function public.api_district_alerts(jsonb, int) to recover_web;
grant execute on function public.api_district_onboarding(jsonb, text) to recover_web;
