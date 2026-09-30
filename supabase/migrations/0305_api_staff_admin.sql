-- 0305 school-admin staff functions (BUILD-CONTRACT section 6.2, school-admin part; §5.5, §14.3, §17, §24).
-- Roster, locations and pins, map versions, drafts, zones, submit, config, calendar, stats, and audit.
--
-- Every function is SECURITY DEFINER with search_path '' and lock_timeout 3s (G-20), owned by recover_api_owner,
-- EXECUTE to recover_web only.
-- Its first statement verifies the staff assertion (section 5) with scope school:<id> derived from the school code
-- (G-39). The asserted body is rebuilt here from the function's own arguments, keyed without the p_ prefix; pins
-- and zone geometry arrive as text so JS and SQL hash identical strings, and are cast only after verification.
-- Audit payloads carry roles, states, ids, and changed-key names only: never emails, names, pins, or paths (F-74).
set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------- private helpers (this family only) ----------

-- Decimal text as sent by JS (toFixed / String) to double precision. NaN, Infinity, and malformed text are
-- invalid_input naming the field; the exponent is bounded so the cast itself can never overflow.
-- The raising helpers are STABLE rather than IMMUTABLE so the planner never pre-evaluates them.
create or replace function private.admin_float(p text, p_field text) returns double precision
language plpgsql stable set search_path = '' as $$
begin
  if p is null or p !~ '^[+-]?([0-9]{1,20}(\.[0-9]{0,20})?|\.[0-9]{1,20})([eE][+-]?[0-9]{1,2})?$' then
    perform private.fail('invalid_input', p_field);
  end if;
  return p::double precision;
end $$;

-- §5.5 / §14.3: a school roster manages reviewer, office, and school_admin; district_admin is never grantable here.
create or replace function private.admin_role(p text) returns public.staff_role
language plpgsql stable set search_path = '' as $$
begin
  if p = 'district_admin' then
    perform private.fail('forbidden', 'role');
  end if;
  if p is null or p not in ('reviewer', 'office', 'school_admin') then
    perform private.fail('invalid_input', 'role');
  end if;
  return p::public.staff_role;
end $$;

-- Strict YYYY-MM-DD to date without raising; NULL for malformed or impossible dates (2026-02-30).
create or replace function private.admin_day(p text) returns date
language plpgsql immutable set search_path = '' as $$
declare
  y int;
  m int;
  d int;
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  y := substr(p, 1, 4)::int;
  m := substr(p, 6, 2)::int;
  d := substr(p, 9, 2)::int;
  if y not between 2000 and 2100 or m not between 1 and 12 or d < 1
     or d > extract(day from (make_date(y, m, 1) + interval '1 month - 1 day'))::int then
    return null;
  end if;
  return make_date(y, m, d);
end $$;

-- Calendar coverage ahead of the school's local today: days from today to the last calendar row on file (F-88).
create or replace function private.admin_calendar_horizon(p_school_id uuid) returns int
language sql stable set search_path = '' as $$
  select coalesce(greatest(max(c.day) - (now() at time zone s.timezone)::date, 0), 0)
    from public.schools s
    left join public.school_calendar_days c on c.school_id = s.id
   where s.id = p_school_id
   group by s.id, s.timezone
$$;

-- The school settings DTO. `config` carries exactly the keys api_staff_config_update accepts (§5.5).
create or replace function private.admin_config(p_school_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'school', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name, 'timezone', s.timezone),
    'config', jsonb_build_object(
      'studentPostingEnabled', s.student_posting_enabled,
      'lostReportsEnabled', s.lost_reports_enabled,
      'crossSchoolSearchEnabled', s.cross_school_search_enabled,
      'retentionDays', s.retention_days,
      'neverArrivedSchoolDays', s.never_arrived_school_days,
      'lateArrivalGraceDays', s.late_arrival_grace_days,
      'terminalTextRetentionDays', s.terminal_text_retention_days,
      'enabledCategories', to_jsonb(s.enabled_categories)),
    -- effective availability is district switch AND school switch; the floor/ceiling bound retentionDays (F-64)
    'district', jsonb_build_object(
      'retentionDaysFloor', d.retention_days_floor,
      'retentionDaysCeiling', d.retention_days_ceiling,
      'studentPostingGlobalEnabled', coalesce(d.student_posting_global_enabled, false),
      'lostReportsGlobalEnabled', coalesce(d.lost_reports_global_enabled, false),
      'crossSchoolSearchGlobalEnabled', coalesce(d.cross_school_search_global_enabled, false)),
    'calendarHorizonDays', private.admin_calendar_horizon(s.id),
    'updatedAt', s.updated_at)
    from public.schools s
    left join public.district_settings d on d.id = 1
   where s.id = p_school_id
$$;

-- ---------- roster (§5.5, §14.1, §14.3) ----------

create or replace function public.api_staff_roster_list(p_assert jsonb, p_school_code text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
begin
  ctx := private.assert_staff(p_assert, 'roster.read', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code));
  -- school_id = this school: district_admin memberships (school_id null) are never listed or reachable here.
  return jsonb_build_object('members', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', sm.id, 'email', su.email, 'displayName', su.display_name, 'role', sm.role,
             'status', sm.status, 'lastLoginAt', su.last_login_at)
           order by su.email, sm.id)
      from public.staff_members sm
      join public.staff_users su on su.id = sm.user_id
     where sm.school_id = ctx.school_id), '[]'::jsonb));
end $$;

-- Invite by district email (§24 step 4). Recover sends nothing: the roster shows the sign-in path to copy.
-- A repeated invite with the same role is a no-op; a different role on a live membership is a roster_update.
create or replace function public.api_staff_roster_invite(
  p_assert jsonb, p_school_code text, p_email text, p_role text, p_display_name text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_role public.staff_role;
  v_email text;
  v_name text;
  v_user uuid;
  r_member public.staff_members;
begin
  ctx := private.assert_staff(p_assert, 'roster.invite', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code, 'email', p_email, 'role', p_role,
                                                 'display_name', p_display_name));
  v_role := private.admin_role(p_role);
  v_email := lower(btrim(p_email));
  -- §14.1: the domain must equal an allowlisted domain exactly (never suffix or substring matching).
  if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+$'
     or not exists (select 1 from unnest((private.district()).staff_email_domains) as a(domain)
                     where ltrim(lower(btrim(a.domain)), '@') = split_part(v_email, '@', 2)) then
    perform private.fail('invalid_input', 'email');
  end if;
  v_name := nullif(btrim(p_display_name), '');
  if char_length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
    perform private.fail('invalid_input', 'display_name');
  end if;

  select su.id into v_user from public.staff_users su where lower(su.email) = v_email;
  if v_user is null then
    insert into public.staff_users (email, display_name) values (v_email, v_name)
    on conflict ((lower(email))) do nothing
    returning id into v_user;
    if v_user is null then
      select su.id into v_user from public.staff_users su where lower(su.email) = v_email;
    end if;
  end if;

  insert into public.staff_members (user_id, school_id, role, status, invited_by)
  values (v_user, ctx.school_id, v_role, 'invited', ctx.member_id)
  on conflict (user_id, school_id) do nothing
  returning * into r_member;
  if not found then
    select * into r_member from public.staff_members
     where user_id = v_user and school_id = ctx.school_id
       for update;
    if r_member.status = 'deactivated' then
      update public.staff_members set role = v_role, status = 'invited', invited_by = ctx.member_id
       where id = r_member.id
      returning * into r_member;
    elsif r_member.role = v_role then
      return jsonb_build_object('memberId', r_member.id, 'signInPath', '/staff/signin');
    else
      perform private.fail('state_changed', 'already_member');
    end if;
  end if;

  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'staff.invite', 'staff_members', r_member.id::text,
    '{}'::jsonb, jsonb_build_object('role', r_member.role, 'school_id', ctx.school_id), '{}'::jsonb);
  return jsonb_build_object('memberId', r_member.id, 'signInPath', '/staff/signin');
end $$;

-- Role and status changes for this school's memberships. NULL arguments leave the field unchanged.
create or replace function public.api_staff_roster_update(
  p_assert jsonb, p_school_code text, p_member_id uuid, p_role text, p_status text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_role public.staff_role;
  v_status text;
  r_member public.staff_members;
begin
  ctx := private.assert_staff(p_assert, 'roster.update', (private.school_by_code(p_school_code)).id, p_member_id, null,
                              jsonb_build_object('school_code', p_school_code, 'member_id', p_member_id,
                                                 'role', p_role, 'status', p_status));
  if p_role is not null then
    v_role := private.admin_role(p_role);
  end if;
  if p_status is not null and p_status not in ('active', 'deactivated', 'invited') then
    perform private.fail('invalid_input', 'status');
  end if;
  -- school_id = this school: district_admin memberships (school_id null) and other schools are unreachable.
  select * into r_member from public.staff_members
   where id = p_member_id and school_id = ctx.school_id
     for update;
  if not found then
    perform private.fail('not_found');
  end if;
  v_role := coalesce(v_role, r_member.role);
  v_status := coalesce(p_status, r_member.status);
  if v_role = r_member.role and v_status = r_member.status then
    return jsonb_build_object('memberId', r_member.id, 'role', r_member.role, 'status', r_member.status);
  end if;
  -- An admin never demotes or deactivates their own membership, so a school cannot lock itself out.
  if r_member.id = ctx.member_id then
    perform private.fail('forbidden', 'self');
  end if;
  update public.staff_members set role = v_role, status = v_status where id = r_member.id;
  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'staff.update', 'staff_members', r_member.id::text,
    jsonb_build_object('role', r_member.role, 'status', r_member.status),
    jsonb_build_object('role', v_role, 'status', v_status), '{}'::jsonb);
  return jsonb_build_object('memberId', r_member.id, 'role', v_role, 'status', v_status);
end $$;

-- ---------- locations and pins (§5.5) ----------

create or replace function public.api_staff_locations_list(p_assert jsonb, p_school_code text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
begin
  ctx := private.assert_staff(p_assert, 'locations.read', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code));
  return jsonb_build_object('locations', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', lo.id, 'code', lo.code, 'name', lo.name, 'hours', lo.hours, 'active', lo.active,
             'atLocationCount', (select count(*) from public.items it
                                  where it.school_id = lo.school_id and it.current_location_id = lo.id
                                    and it.custody = 'at_location' and it.deleted_at is null),
             'pins', coalesce((select jsonb_agg(jsonb_build_object('mapVersionId', lp.map_version_id,
                                                                   'x', lp.pin_x, 'y', lp.pin_y)
                                                order by lp.map_version_id)
                                 from public.location_map_pins lp
                                where lp.location_id = lo.id and lp.school_id = lo.school_id), '[]'::jsonb))
           order by lo.active desc, lo.code)
      from public.locations lo
     where lo.school_id = ctx.school_id), '[]'::jsonb));
end $$;

-- Create (p_location_id null) or update. On update a NULL argument leaves the field unchanged and a blank
-- p_hours clears the hours. Codes are immutable: they prefix public IDs drawn from the per-location sequence
-- (§7.4), so renaming a code could let a later location reuse it and collide with issued IDs.
create or replace function public.api_staff_location_upsert(
  p_assert jsonb, p_school_code text, p_location_id uuid, p_code text, p_name text, p_hours text, p_active boolean
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_code text;
  v_name text;
  v_hours text;
  v_changed text[];
  r_loc public.locations;
begin
  ctx := private.assert_staff(p_assert, 'locations.write', (private.school_by_code(p_school_code)).id, p_location_id, null,
                              jsonb_build_object('school_code', p_school_code, 'location_id', p_location_id,
                                                 'code', p_code, 'name', p_name, 'hours', p_hours, 'active', p_active));
  v_code := upper(btrim(p_code));
  v_name := btrim(p_name);
  v_hours := btrim(p_hours);
  if v_code is not null and v_code !~ '^[A-Z0-9]{1,6}$' then
    perform private.fail('invalid_input', 'code');
  end if;
  if v_name is not null and (char_length(v_name) not between 2 and 60 or v_name ~ '[[:cntrl:]]') then
    perform private.fail('invalid_input', 'name');
  end if;
  if v_hours is not null and (char_length(v_hours) > 120 or v_hours ~ '[[:cntrl:]]') then
    perform private.fail('invalid_input', 'hours');
  end if;

  if p_location_id is null then
    if v_code is null then
      perform private.fail('invalid_input', 'code');
    end if;
    if v_name is null then
      perform private.fail('invalid_input', 'name');
    end if;
    if exists (select 1 from public.locations lo where lo.school_id = ctx.school_id and lo.code = v_code) then
      perform private.fail('invalid_input', 'code');
    end if;
    begin
      insert into public.locations (school_id, code, name, hours, active)
      values (ctx.school_id, v_code, v_name, nullif(v_hours, ''), coalesce(p_active, true))
      returning * into r_loc;
    exception when unique_violation then
      perform private.fail('invalid_input', 'code');
    end;
    perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
      'location.create', 'locations', r_loc.id::text,
      '{}'::jsonb, jsonb_build_object('code', r_loc.code, 'active', r_loc.active), '{}'::jsonb);
  else
    select * into r_loc from public.locations
     where id = p_location_id and school_id = ctx.school_id
       for update;
    if not found then
      perform private.fail('not_found');
    end if;
    if v_code is not null and v_code <> r_loc.code then
      perform private.fail('invalid_input', 'code');
    end if;
    -- §5.5: deactivate only while no item is physically held here.
    if p_active is false and r_loc.active and exists (
         select 1 from public.items it
          where it.school_id = ctx.school_id and it.current_location_id = r_loc.id
            and it.custody = 'at_location' and it.deleted_at is null) then
      perform private.fail('invalid_input', 'active');
    end if;
    v_changed := array_remove(array[
      case when v_name is not null and v_name <> r_loc.name then 'name' end,
      case when v_hours is not null and nullif(v_hours, '') is distinct from r_loc.hours then 'hours' end,
      case when p_active is not null and p_active <> r_loc.active then 'active' end], null);
    if cardinality(v_changed) = 0 then
      return jsonb_build_object('id', r_loc.id, 'code', r_loc.code, 'name', r_loc.name, 'hours', r_loc.hours,
                                'active', r_loc.active);
    end if;
    update public.locations
       set name = coalesce(v_name, name),
           hours = case when v_hours is null then hours else nullif(v_hours, '') end,
           active = coalesce(p_active, active)
     where id = r_loc.id
    returning * into r_loc;
    perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
      'location.update', 'locations', r_loc.id::text,
      '{}'::jsonb, jsonb_build_object('active', r_loc.active), jsonb_build_object('changed_keys', to_jsonb(v_changed)));
  end if;
  -- locations (names, hours, active) are part of the public school meta
  perform private.invalidate(ctx.school_id);
  return jsonb_build_object('id', r_loc.id, 'code', r_loc.code, 'name', r_loc.name, 'hours', r_loc.hours,
                            'active', r_loc.active);
end $$;

-- Pin a location on one of this school's map versions (drafts for submission; approved maps for new locations).
-- The composite (location, school) and (map version, school) FKs are the final tenant boundary.
create or replace function public.api_staff_location_pin_set(
  p_assert jsonb, p_school_code text, p_location_id uuid, p_map_version_id uuid, p_x text, p_y text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_x double precision;
  v_y double precision;
  r_map public.map_versions;
begin
  ctx := private.assert_staff(p_assert, 'locations.write', (private.school_by_code(p_school_code)).id, p_location_id, null,
                              jsonb_build_object('school_code', p_school_code, 'location_id', p_location_id,
                                                 'map_version_id', p_map_version_id, 'x', p_x, 'y', p_y));
  v_x := private.admin_float(p_x, 'x');
  v_y := private.admin_float(p_y, 'y');
  if v_x < 0 or v_x > 1 then
    perform private.fail('invalid_input', 'x');
  end if;
  if v_y < 0 or v_y > 1 then
    perform private.fail('invalid_input', 'y');
  end if;
  perform 1 from public.locations where id = p_location_id and school_id = ctx.school_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  select * into r_map from public.map_versions
   where id = p_map_version_id and school_id = ctx.school_id
     for share;
  if not found then
    perform private.fail('not_found');
  end if;
  if r_map.approval_status in ('rejected', 'retired') then
    perform private.fail('state_changed', 'approval_status');
  end if;
  insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y)
  values (ctx.school_id, p_location_id, p_map_version_id, v_x, v_y)
  on conflict (location_id, map_version_id) do update set pin_x = excluded.pin_x, pin_y = excluded.pin_y;
  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'location.pin_set', 'locations', p_location_id::text,
    '{}'::jsonb, '{}'::jsonb, jsonb_build_object('map_version_id', p_map_version_id));
  if r_map.active then
    perform private.invalidate(ctx.school_id); -- the active map's pins are public meta
  end if;
  return jsonb_build_object('locationId', p_location_id, 'mapVersionId', p_map_version_id, 'x', v_x, 'y', v_y);
end $$;

-- ---------- map versions, drafts, zones, submit (§5.5, §24 steps 2-3; G-07) ----------

-- Staff never receive storage keys: only whether the draft slot and a canonical image exist.
create or replace function public.api_staff_map_versions(p_assert jsonb, p_school_code text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
begin
  ctx := private.assert_staff(p_assert, 'map.read', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code));
  return jsonb_build_object('versions', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', mv.id, 'approvalStatus', mv.approval_status, 'active', mv.active,
             'width', mv.width_px, 'height', mv.height_px,
             'zoneCount', (select count(*) from public.map_zones mz
                            where mz.map_version_id = mv.id and mz.school_id = mv.school_id and mz.active),
             'createdAt', mv.created_at, 'submittedAt', mv.submitted_at, 'approvedAt', mv.approved_at,
             'rejectedReason', mv.rejected_reason,
             'hasDraft', mv.draft_storage_path is not null,
             'hasCanonical', mv.draft_canonical_path is not null or mv.public_storage_path is not null)
           order by mv.created_at desc, mv.id)
      from public.map_versions mv
     where mv.school_id = ctx.school_id), '[]'::jsonb));
end $$;

-- The version id is in the draft key (section 8), so the row exists before the brokered upload (G-07).
create or replace function public.api_staff_map_create_draft(p_assert jsonb, p_school_code text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_id uuid;
begin
  ctx := private.assert_staff(p_assert, 'map.create', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code));
  v_id := gen_random_uuid();
  insert into public.map_versions (id, school_id, draft_storage_path, approval_status, created_by)
  values (v_id, ctx.school_id, ctx.school_id::text || '/' || v_id::text || '/draft', 'draft', ctx.member_id);
  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'map.create_draft', 'map_versions', v_id::text,
    '{}'::jsonb, jsonb_build_object('approval_status', 'draft'), '{}'::jsonb);
  return jsonb_build_object('mapVersionId', v_id);
end $$;

-- Create (p_zone_id null) or update a zone on a draft. On update a NULL argument leaves the field unchanged;
-- p_active false soft-disables. Zone names are public labels reviewed with the package, so they freeze with it.
create or replace function public.api_staff_zone_upsert(
  p_assert jsonb, p_school_code text, p_map_version_id uuid, p_zone_id uuid, p_name text,
  p_cx text, p_cy text, p_radius text, p_active boolean
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_name text;
  v_cx double precision;
  v_cy double precision;
  v_radius double precision;
  r_map public.map_versions;
  r_zone public.map_zones;
begin
  ctx := private.assert_staff(p_assert, 'zones.write', (private.school_by_code(p_school_code)).id, p_zone_id, null,
                              jsonb_build_object('school_code', p_school_code, 'map_version_id', p_map_version_id,
                                                 'zone_id', p_zone_id, 'name', p_name, 'cx', p_cx, 'cy', p_cy,
                                                 'radius', p_radius, 'active', p_active));
  -- The version row lock serializes zone edits with api_staff_map_submit. G-07: drafts only; the
  -- private.zones_frozen trigger raises the same state_changed if this check is ever bypassed.
  select * into r_map from public.map_versions
   where id = p_map_version_id and school_id = ctx.school_id
     for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if r_map.approval_status <> 'draft' then
    perform private.fail('state_changed', 'zones_frozen');
  end if;
  if p_zone_id is not null then
    select * into r_zone from public.map_zones
     where id = p_zone_id and map_version_id = r_map.id and school_id = ctx.school_id
       for update;
    if not found then
      perform private.fail('not_found');
    end if;
  end if;

  v_name := coalesce(btrim(p_name), r_zone.name);
  if v_name is null or char_length(v_name) not between 2 and 40 or v_name ~ '[[:cntrl:]]' then
    perform private.fail('invalid_input', 'name');
  end if;
  -- on create every geometry field is required: parsing NULL raises invalid_input naming the field
  if p_cx is null and r_zone.id is not null then
    v_cx := r_zone.cx;
  else
    v_cx := private.admin_float(p_cx, 'cx');
  end if;
  if p_cy is null and r_zone.id is not null then
    v_cy := r_zone.cy;
  else
    v_cy := private.admin_float(p_cy, 'cy');
  end if;
  if p_radius is null and r_zone.id is not null then
    v_radius := r_zone.radius;
  else
    v_radius := private.admin_float(p_radius, 'radius');
  end if;
  if v_cx < 0 or v_cx > 1 then
    perform private.fail('invalid_input', 'cx');
  end if;
  if v_cy < 0 or v_cy > 1 then
    perform private.fail('invalid_input', 'cy');
  end if;
  if v_radius <= 0 or v_radius > 0.5 then
    perform private.fail('invalid_input', 'radius');
  end if;
  if exists (select 1 from public.map_zones mz
              where mz.map_version_id = r_map.id and lower(mz.name) = lower(v_name)
                and mz.id is distinct from p_zone_id) then
    perform private.fail('invalid_input', 'name');
  end if;

  begin
    if p_zone_id is null then
      insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius, active)
      values (ctx.school_id, r_map.id, v_name, v_cx, v_cy, v_radius, coalesce(p_active, true))
      returning * into r_zone;
    else
      update public.map_zones
         set name = v_name, cx = v_cx, cy = v_cy, radius = v_radius, active = coalesce(p_active, active)
       where id = r_zone.id
      returning * into r_zone;
    end if;
  exception when unique_violation then
    perform private.fail('invalid_input', 'name');
  end;
  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    case when p_zone_id is null then 'zone.create' else 'zone.update' end, 'map_zones', r_zone.id::text,
    '{}'::jsonb, jsonb_build_object('active', r_zone.active), jsonb_build_object('map_version_id', r_map.id));
  return jsonb_build_object('zoneId', r_zone.id, 'mapVersionId', r_zone.map_version_id, 'name', r_zone.name,
                            'cx', r_zone.cx, 'cy', r_zone.cy, 'radius', r_zone.radius, 'active', r_zone.active);
end $$;

-- draft -> pending_district. §24 step 3: the package is the canonical map, at least one active zone, and a pin
-- on this version for every active location. Readiness failures name what is missing in `detail`.
create or replace function public.api_staff_map_submit(p_assert jsonb, p_school_code text, p_map_version_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  r_map public.map_versions;
begin
  ctx := private.assert_staff(p_assert, 'map.submit', (private.school_by_code(p_school_code)).id, p_map_version_id, null,
                              jsonb_build_object('school_code', p_school_code, 'map_version_id', p_map_version_id));
  select * into r_map from public.map_versions
   where id = p_map_version_id and school_id = ctx.school_id
     for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if r_map.approval_status <> 'draft' then
    perform private.fail('state_changed', 'approval_status');
  end if;
  if r_map.width_px is null or r_map.height_px is null then
    perform private.fail('invalid_input', 'map_image');
  end if;
  if not exists (select 1 from public.map_zones mz where mz.map_version_id = r_map.id and mz.active) then
    perform private.fail('invalid_input', 'zones');
  end if;
  if exists (select 1 from public.locations lo
              where lo.school_id = ctx.school_id and lo.active
                and not exists (select 1 from public.location_map_pins lp
                                 where lp.location_id = lo.id and lp.map_version_id = r_map.id)) then
    perform private.fail('invalid_input', 'pins');
  end if;
  update public.map_versions set approval_status = 'pending_district', submitted_at = now()
   where id = r_map.id
  returning * into r_map;
  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'map.submit', 'map_versions', r_map.id::text,
    jsonb_build_object('approval_status', 'draft'), jsonb_build_object('approval_status', r_map.approval_status),
    '{}'::jsonb);
  return jsonb_build_object('mapVersionId', r_map.id, 'approvalStatus', r_map.approval_status,
                            'submittedAt', r_map.submitted_at);
end $$;

-- ---------- configuration and calendar (§5.5; F-64) ----------

create or replace function public.api_staff_config_get(p_assert jsonb, p_school_code text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
begin
  ctx := private.assert_staff(p_assert, 'config.read', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code));
  return private.admin_config(ctx.school_id);
end $$;

-- p_changes is a partial object over the config keys of api_staff_config_get. Unknown keys and wrong types are
-- invalid_input naming the key; the schools_retention trigger enforces the district floor and ceiling (F-64)
-- and its invalid_input 'retention_days' passes through unchanged.
create or replace function public.api_staff_config_update(p_assert jsonb, p_school_code text, p_changes jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_key text;
  v_val jsonb;
  v_int int;
  v_cats public.item_category[];
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
begin
  ctx := private.assert_staff(p_assert, 'config.write', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code, 'changes', p_changes));
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    perform private.fail('invalid_input', 'changes');
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p_changes) as e loop
    case v_key
      when 'studentPostingEnabled', 'lostReportsEnabled', 'crossSchoolSearchEnabled' then
        if jsonb_typeof(v_val) <> 'boolean' then
          perform private.fail('invalid_input', v_key);
        end if;
      when 'retentionDays', 'neverArrivedSchoolDays', 'lateArrivalGraceDays', 'terminalTextRetentionDays' then
        if jsonb_typeof(v_val) <> 'number' or v_val::text !~ '^-?[0-9]{1,6}$' then
          perform private.fail('invalid_input', v_key);
        end if;
        v_int := (v_val::text)::int;
        -- the column CHECK ranges (0004); the district floor/ceiling is the trigger's job
        if (v_key = 'retentionDays' and v_int not between 1 and 365)
           or (v_key = 'neverArrivedSchoolDays' and v_int not between 1 and 10)
           or (v_key in ('lateArrivalGraceDays', 'terminalTextRetentionDays') and v_int not between 0 and 30) then
          perform private.fail('invalid_input', v_key);
        end if;
      when 'enabledCategories' then
        -- students may only ever post low-value categories (§5.3.1); the high-value five stay staff-only
        if jsonb_typeof(v_val) <> 'array' then
          perform private.fail('invalid_input', v_key);
        end if;
        if jsonb_array_length(v_val) = 0
           or exists (select 1 from jsonb_array_elements(v_val) as a(x)
                       where jsonb_typeof(a.x) <> 'string'
                          or (a.x #>> '{}') not in ('bag', 'clothing', 'bottle', 'book', 'electronics_low',
                                                    'jewelry', 'sports', 'other')) then
          perform private.fail('invalid_input', v_key);
        end if;
        v_cats := array(select c from unnest(enum_range(null::public.item_category)) as c
                         where c::text in (select a.x #>> '{}' from jsonb_array_elements(v_val) as a(x)));
      else
        perform private.fail('invalid_input', left(v_key, 60));
    end case;
  end loop;

  perform 1 from public.schools where id = ctx.school_id for update;
  v_before := private.admin_config(ctx.school_id) -> 'config';
  update public.schools
     set student_posting_enabled = coalesce((p_changes->>'studentPostingEnabled')::boolean, student_posting_enabled),
         lost_reports_enabled = coalesce((p_changes->>'lostReportsEnabled')::boolean, lost_reports_enabled),
         cross_school_search_enabled = coalesce((p_changes->>'crossSchoolSearchEnabled')::boolean,
                                                cross_school_search_enabled),
         retention_days = coalesce((p_changes->>'retentionDays')::int, retention_days),
         never_arrived_school_days = coalesce((p_changes->>'neverArrivedSchoolDays')::int, never_arrived_school_days),
         late_arrival_grace_days = coalesce((p_changes->>'lateArrivalGraceDays')::int, late_arrival_grace_days),
         terminal_text_retention_days = coalesce((p_changes->>'terminalTextRetentionDays')::int,
                                                 terminal_text_retention_days),
         enabled_categories = coalesce(v_cats, enabled_categories)
   where id = ctx.school_id;
  v_after := private.admin_config(ctx.school_id);
  select coalesce(array_agg(k.key order by k.key collate "C"), '{}') into v_changed
    from jsonb_object_keys(v_after -> 'config') as k(key)
   where (v_after -> 'config' -> k.key) is distinct from (v_before -> k.key);
  if cardinality(v_changed) > 0 then
    perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
      'school.config', 'schools', ctx.school_id::text,
      '{}'::jsonb, '{}'::jsonb, jsonb_build_object('changed_keys', to_jsonb(v_changed)));
    perform private.invalidate(ctx.school_id);
  end if;
  return v_after;
end $$;

-- Operating calendar rows (§24 step 1 coverage, G-01 deadlines). Every entry is validated before any write;
-- the table CHECK enforces the same open/close rule as a backstop.
create or replace function public.api_staff_calendar_upsert(p_assert jsonb, p_school_code text, p_days jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_entry jsonb;
  v_day date;
  v_open time;
  v_close time;
  v_days date[] := '{}';
  v_is_open boolean[] := '{}';
  v_open_at time[] := '{}';
  v_close_at time[] := '{}';
  v_n int;
begin
  ctx := private.assert_staff(p_assert, 'calendar.write', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code, 'days', p_days));
  -- Type checks run as separate statements before any function that needs that type (a single OR chain
  -- gives no evaluation-order guarantee, and custom plans may fold a variable's value at plan time).
  if jsonb_typeof(p_days) is distinct from 'array' then
    perform private.fail('invalid_input', 'days');
  end if;
  if jsonb_array_length(p_days) not between 1 and 400 then
    perform private.fail('invalid_input', 'days');
  end if;
  for v_entry in select a.x from jsonb_array_elements(p_days) as a(x) loop
    if jsonb_typeof(v_entry) <> 'object' then
      perform private.fail('invalid_input', 'days');
    end if;
    if exists (select 1 from jsonb_object_keys(v_entry) as k(key)
                where k.key not in ('day', 'isOpen', 'openAt', 'closeAt'))
       or jsonb_typeof(v_entry -> 'isOpen') is distinct from 'boolean'
       or jsonb_typeof(v_entry -> 'day') is distinct from 'string'
       or coalesce(jsonb_typeof(v_entry -> 'openAt'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(v_entry -> 'closeAt'), 'null') not in ('string', 'null')
       or (v_entry ->> 'openAt') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_entry ->> 'closeAt') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      perform private.fail('invalid_input', 'days');
    end if;
    v_day := private.admin_day(v_entry ->> 'day');
    v_open := (v_entry ->> 'openAt')::time;
    v_close := (v_entry ->> 'closeAt')::time;
    if v_day is null or v_day = any (v_days)
       or ((v_entry ->> 'isOpen')::boolean and (v_open is null or v_close is null or v_open >= v_close))
       or (not (v_entry ->> 'isOpen')::boolean and (v_open is not null or v_close is not null)) then
      perform private.fail('invalid_input', 'days');
    end if;
    v_days := v_days || v_day;
    v_is_open := v_is_open || (v_entry ->> 'isOpen')::boolean;
    v_open_at := v_open_at || v_open;
    v_close_at := v_close_at || v_close;
  end loop;

  insert into public.school_calendar_days (school_id, day, is_open, open_at, close_at, source)
  select ctx.school_id, u.day, u.is_open, u.open_at, u.close_at, 'school'
    from unnest(v_days, v_is_open, v_open_at, v_close_at) as u(day, is_open, open_at, close_at)
  on conflict (school_id, day) do update
    set is_open = excluded.is_open, open_at = excluded.open_at, close_at = excluded.close_at, source = excluded.source;
  get diagnostics v_n = row_count;
  perform private.audit(ctx.school_id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
    'calendar.update', 'school_calendar_days', ctx.school_id::text,
    '{}'::jsonb, '{}'::jsonb, jsonb_build_object('days', v_n));
  return jsonb_build_object('upserted', v_n, 'horizonDays', private.admin_calendar_horizon(ctx.school_id));
end $$;

-- ---------- dashboard (§17 metrics; §24 week-4 review) ----------

-- Nightly rollup rows for [p_from, p_to] (school-local dates; default the last 30 days, at most 367) plus live
-- counts. The pending queue matches the staff queue: pending, not deleted, custody not terminal (G-02).
create or replace function public.api_staff_stats(p_assert jsonb, p_school_code text, p_from date, p_to date)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
  v_today date;
  v_from date;
  v_to date;
  v_days jsonb;
  v_live jsonb;
begin
  ctx := private.assert_staff(p_assert, 'stats.read', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code, 'from', p_from, 'to', p_to));
  select (now() at time zone sc.timezone)::date into v_today from public.schools sc where sc.id = ctx.school_id;
  v_to := coalesce(p_to, v_today);
  v_from := coalesce(p_from, v_to - 29);
  if v_from > v_to or v_to - v_from > 366 then
    perform private.fail('invalid_input', 'from');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'day', ds.day, 'posted', ds.posted, 'approved', ds.approved, 'rejected', ds.rejected,
           'received', ds.received, 'claimed', ds.claimed, 'expired', ds.expired, 'searches', ds.searches,
           'zeroResultSearches', ds.zero_result_searches, 'lostReports', ds.lost_reports,
           'matchesSurfaced', ds.matches_surfaced, 'matchesViewed', ds.matches_viewed,
           'reportsClosedFound', ds.reports_closed_found, 'receivedCohort7d', ds.received_cohort_7d,
           'receivedCohort30d', ds.received_cohort_30d, 'queueAgeP95Hours', ds.queue_age_p95_hours,
           'screeningImages', ds.screening_images, 'highValueRedirects', ds.high_value_redirects)
         order by ds.day), '[]'::jsonb)
    into v_days
    from public.daily_school_stats ds
   where ds.school_id = ctx.school_id and ds.day between v_from and v_to;

  select jsonb_build_object(
           'pendingQueue', q.n,
           'oldestPendingAgeHours', case when q.oldest is null then null
                                         else round((extract(epoch from (now() - q.oldest)) / 3600)::numeric, 1) end,
           'atLocation', (select count(*) from public.items it
                           where it.school_id = ctx.school_id and it.custody = 'at_location' and it.deleted_at is null),
           'dispositionDue', (select count(*) from public.items it
                               where it.school_id = ctx.school_id and it.custody = 'at_location'
                                 and it.deleted_at is null and it.expires_at <= now()),
           'openLostReports', (select count(*) from public.lost_reports lr
                                where lr.school_id = ctx.school_id and lr.status = 'open'))
    into v_live
    from (select count(*) as n, min(it.created_at) as oldest
            from public.items it
           where it.school_id = ctx.school_id and it.review_status = 'pending' and it.deleted_at is null
             and it.custody in ('with_finder', 'at_location')) as q;

  return jsonb_build_object('from', v_from, 'to', v_to, 'days', v_days, 'live', v_live);
end $$;

-- The most recent audit rows for this school (§14.3: school_admin reads its own school's log). p_limit
-- defaults to 50 and is clamped to [1, 200]. Payloads are already allowlisted at write time (F-74).
create or replace function public.api_staff_audit(p_assert jsonb, p_school_code text, p_limit int) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  ctx private.staff_ctx;
begin
  ctx := private.assert_staff(p_assert, 'audit.read', (private.school_by_code(p_school_code)).id, null, null,
                              jsonb_build_object('school_code', p_school_code, 'limit', p_limit));
  return jsonb_build_object('entries', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', al.id, 'action', al.action, 'actorKind', al.actor_kind, 'createdAt', al.created_at,
             'targetTable', al.target_table, 'targetId', al.target_id,
             'stateAfter', al.state_after, 'metadata', al.metadata)
           order by al.created_at desc, al.id desc)
      from (select a.id, a.action, a.actor_kind, a.created_at, a.target_table, a.target_id, a.state_after, a.metadata
              from public.audit_log a
             where a.school_id = ctx.school_id
             order by a.created_at desc, a.id desc
             limit least(greatest(coalesce(p_limit, 50), 1), 200)) as al), '[]'::jsonb));
end $$;

-- ---------- ownership and grants ----------

revoke all on function private.admin_float(text, text) from public;
revoke all on function private.admin_role(text) from public;
revoke all on function private.admin_day(text) from public;
revoke all on function private.admin_calendar_horizon(uuid) from public;
revoke all on function private.admin_config(uuid) from public;
grant execute on function private.admin_float(text, text) to recover_api_owner;
grant execute on function private.admin_role(text) to recover_api_owner;
grant execute on function private.admin_day(text) to recover_api_owner;
grant execute on function private.admin_calendar_horizon(uuid) to recover_api_owner;
grant execute on function private.admin_config(uuid) to recover_api_owner;

alter function public.api_staff_roster_list(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_roster_invite(jsonb, text, text, text, text) owner to recover_api_owner;
alter function public.api_staff_roster_update(jsonb, text, uuid, text, text) owner to recover_api_owner;
alter function public.api_staff_locations_list(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_location_upsert(jsonb, text, uuid, text, text, text, boolean) owner to recover_api_owner;
alter function public.api_staff_location_pin_set(jsonb, text, uuid, uuid, text, text) owner to recover_api_owner;
alter function public.api_staff_map_versions(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_map_create_draft(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_zone_upsert(jsonb, text, uuid, uuid, text, text, text, text, boolean) owner to recover_api_owner;
alter function public.api_staff_map_submit(jsonb, text, uuid) owner to recover_api_owner;
alter function public.api_staff_config_get(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_config_update(jsonb, text, jsonb) owner to recover_api_owner;
alter function public.api_staff_calendar_upsert(jsonb, text, jsonb) owner to recover_api_owner;
alter function public.api_staff_stats(jsonb, text, date, date) owner to recover_api_owner;
alter function public.api_staff_audit(jsonb, text, int) owner to recover_api_owner;

revoke all on function public.api_staff_roster_list(jsonb, text) from public;
revoke all on function public.api_staff_roster_invite(jsonb, text, text, text, text) from public;
revoke all on function public.api_staff_roster_update(jsonb, text, uuid, text, text) from public;
revoke all on function public.api_staff_locations_list(jsonb, text) from public;
revoke all on function public.api_staff_location_upsert(jsonb, text, uuid, text, text, text, boolean) from public;
revoke all on function public.api_staff_location_pin_set(jsonb, text, uuid, uuid, text, text) from public;
revoke all on function public.api_staff_map_versions(jsonb, text) from public;
revoke all on function public.api_staff_map_create_draft(jsonb, text) from public;
revoke all on function public.api_staff_zone_upsert(jsonb, text, uuid, uuid, text, text, text, text, boolean) from public;
revoke all on function public.api_staff_map_submit(jsonb, text, uuid) from public;
revoke all on function public.api_staff_config_get(jsonb, text) from public;
revoke all on function public.api_staff_config_update(jsonb, text, jsonb) from public;
revoke all on function public.api_staff_calendar_upsert(jsonb, text, jsonb) from public;
revoke all on function public.api_staff_stats(jsonb, text, date, date) from public;
revoke all on function public.api_staff_audit(jsonb, text, int) from public;

grant execute on function public.api_staff_roster_list(jsonb, text) to recover_web;
grant execute on function public.api_staff_roster_invite(jsonb, text, text, text, text) to recover_web;
grant execute on function public.api_staff_roster_update(jsonb, text, uuid, text, text) to recover_web;
grant execute on function public.api_staff_locations_list(jsonb, text) to recover_web;
grant execute on function public.api_staff_location_upsert(jsonb, text, uuid, text, text, text, boolean) to recover_web;
grant execute on function public.api_staff_location_pin_set(jsonb, text, uuid, uuid, text, text) to recover_web;
grant execute on function public.api_staff_map_versions(jsonb, text) to recover_web;
grant execute on function public.api_staff_map_create_draft(jsonb, text) to recover_web;
grant execute on function public.api_staff_zone_upsert(jsonb, text, uuid, uuid, text, text, text, text, boolean) to recover_web;
grant execute on function public.api_staff_map_submit(jsonb, text, uuid) to recover_web;
grant execute on function public.api_staff_config_get(jsonb, text) to recover_web;
grant execute on function public.api_staff_config_update(jsonb, text, jsonb) to recover_web;
grant execute on function public.api_staff_calendar_upsert(jsonb, text, jsonb) to recover_web;
grant execute on function public.api_staff_stats(jsonb, text, date, date) to recover_web;
grant execute on function public.api_staff_audit(jsonb, text, int) to recover_web;
