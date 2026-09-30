-- 0300 staff api family, part 1: identity, review, custody, item changes, staff posts, devices, media
-- tickets, and lost reports (BUILD-CONTRACT sections 3, 5, 6.2; §5.3-§5.6, §6, Appendix C, §13.3, §14;
-- G-01, G-02, G-04, G-05, G-08, G-12, G-23, G-24, G-34, G-40, G-43). Roster, locations, maps, zones,
-- config, calendar, stats, and audit live in 0305_api_staff_admin.sql; district functions in 0310.
--
-- Template for every public function: SECURITY DEFINER, search_path '', lock_timeout 3s (G-20), owner
-- recover_api_owner, EXECUTE revoked from PUBLIC and granted to recover_web only. The first statement
-- verifies the staff assertion (private.assert_staff, or private.verify_assertion for the two identity
-- functions) over a body rebuilt from the function's own arguments (section 5, G-16): every business
-- argument, nulls included, keyed without the p_ prefix. Operation, scope, and target follow the lead's
-- mapping (apps/web/lib/ops.ts FNS). Decimals and timestamps are text arguments cast inside.
--
-- The private.sapi_* helpers are SECURITY INVOKER and owned by recover_api_owner, so they run with the
-- calling api function's privileges and no login role can reach them.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- =====================================================================================================
-- private helpers
-- =====================================================================================================

-- Staff-entered text (F-102 mirror of unicode.ts): NFC, trimmed, bounded, no C0/C1 or bidi controls.
create or replace function private.sapi_text(p text, p_field text, p_min int, p_max int, p_required boolean)
returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text;
begin
  if p is null or btrim(p) = '' then
    if p_required then
      perform private.fail('invalid_input', p_field);
    end if;
    return null;
  end if;
  v := btrim(normalize(p, NFC));
  if char_length(v) < p_min or char_length(v) > p_max
     or v ~ '[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]' then
    perform private.fail('invalid_input', p_field);
  end if;
  return v;
end $$;

-- Section 5: non-integer numbers arrive as text (JS x.toFixed(6)); plain decimals only, no exponents.
create or replace function private.sapi_num(p text, p_field text) returns double precision
language plpgsql immutable set search_path = '' as $$
begin
  if p is null then
    return null;
  end if;
  if p !~ '^-?[0-9]{1,6}(\.[0-9]{1,12})?$' then
    perform private.fail('invalid_input', p_field);
  end if;
  return p::double precision;
end $$;

-- Section 5: timestamps arrive as the exact ISO text the client received from us.
create or replace function private.sapi_ts(p text, p_field text) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v timestamptz;
begin
  if p is null then
    return null;
  end if;
  if char_length(p) > 40 or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+Z-]+$' then
    perform private.fail('invalid_input', p_field);
  end if;
  begin
    v := p::timestamptz;
  exception when others then
    v := null;
  end;
  if v is null then
    perform private.fail('invalid_input', p_field);
  end if;
  return v;
end $$;

-- A uuid inside a jsonb argument (edits).
create or replace function private.sapi_uuid(p jsonb, p_field text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'string'
     or (p #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.fail('invalid_input', p_field);
  end if;
  return (p #>> '{}')::uuid;
end $$;

-- G-24: only a JSON true counts; quarantined items are school_admin+ only.
create or replace function private.sapi_quarantined(p_flags jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_flags -> 'quarantine' = 'true'::jsonb, false)
$$;

-- Audit state snapshot: allowlisted, non-content columns only (F-74).
create or replace function private.sapi_state(p public.items) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('review_status', p.review_status, 'publication_status', p.publication_status,
                            'custody', p.custody, 'row_version', p.row_version)
$$;

-- Transition result (BUILD-CONTRACT 6.2): {itemId, reviewStatus, publicationStatus, custody, rowVersion}.
create or replace function private.sapi_result(p public.items) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('itemId', p.id, 'reviewStatus', p.review_status, 'publicationStatus', p.publication_status,
                            'custody', p.custody, 'rowVersion', p.row_version)
$$;

-- Lock one item of this school (tenant assertion). Drafts are invisible to staff. With p_gate, a
-- quarantined item needs school_admin+ (G-24): review and content operations are gated, custody and
-- exposure-reducing operations (receive, transfer, claim, dispose, pull, delete) are not, because the
-- physical item still has to be handled and they reveal no content. Row-version and predecessor
-- guards stay in each caller.
create or replace function private.sapi_lock_item(
  p_school_id uuid, p_item_id uuid, p_role public.staff_role, p_gate boolean
) returns public.items
language plpgsql set search_path = '' as $$
declare
  i public.items;
begin
  select * into i from public.items where id = p_item_id and school_id = p_school_id for update;
  if not found or i.review_status = 'draft' then
    perform private.fail('not_found');
  end if;
  if p_gate and private.sapi_quarantined(i.screening_flags) and private.role_rank(p_role) < 3 then
    perform private.fail('forbidden');
  end if;
  return i;
end $$;

create or replace function private.sapi_active_location(p_school_id uuid, p_location_id uuid, p_field text)
returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_location_id is null or not exists (
       select 1 from public.locations l where l.id = p_location_id and l.school_id = p_school_id and l.active) then
    perform private.fail('invalid_input', p_field);
  end if;
end $$;

-- daily_school_stats counters, keyed on the school's local date.
create or replace function private.sapi_stat(p_school_id uuid, p_field text, p_n int default 1) returns void
language plpgsql set search_path = '' as $$
declare
  v_day date;
begin
  if p_field not in ('posted', 'approved', 'rejected', 'received', 'claimed', 'expired') then
    raise exception 'sapi_stat: unknown counter %', p_field;
  end if;
  select (now() at time zone s.timezone)::date into v_day from public.schools s where s.id = p_school_id;
  execute format(
    'insert into public.daily_school_stats (school_id, day, %1$I) values ($1, $2, $3)
     on conflict (school_id, day) do update set %1$I = public.daily_school_stats.%1$I + excluded.%1$I', p_field)
    using p_school_id, v_day, p_n;
end $$;

-- StaffItemRow (BUILD-CONTRACT 6.2). Flags: true-valued screening flags except quarantine (its own
-- field), plus repeat_device (§13.3, >= 3 rejections in 30 days) and screening_error (G-40).
create or replace function private.sapi_item_json(p_item_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id,
    'publicId', i.public_id,
    'category', i.category,
    'description', i.description,
    'note', i.location_note_private,
    'pin', case when i.pin_x is null then null else jsonb_build_object('x', i.pin_x, 'y', i.pin_y) end,
    'mapVersionId', i.map_version_id,
    'zoneId', i.zone_id,
    'zoneName', z.name,
    'dropoffLocationId', i.dropoff_location_id,
    'currentLocationId', i.current_location_id,
    'reviewStatus', i.review_status,
    'publicationStatus', i.publication_status,
    'custody', i.custody,
    'postedByKind', i.posted_by_kind,
    'createdAt', i.created_at,
    'arrivalDeadlineAt', i.arrival_deadline_at,
    'expiresAt', i.expires_at,
    'dispositionDueAt', i.disposition_due_at,
    'rowVersion', i.row_version,
    'screeningStatus', i.screening_status,
    'flags', (select coalesce(jsonb_agg(f.k order by f.k), '[]'::jsonb)
                from (select e.key as k from jsonb_each(i.screening_flags) e
                       where e.value = 'true'::jsonb and e.key <> 'quarantine'
                      union
                      select 'repeat_device' where d.n >= 3
                      union
                      select 'screening_error' where i.screening_status = 'error') f),
    'quarantine', private.sapi_quarantined(i.screening_flags),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object('photoId', p.id, 'position', p.position,
                                                            'generation', p.generation, 'status', p.status,
                                                            'isCurrent', p.is_current)
                                         order by p.position, p.generation desc), '[]'::jsonb)
                 from public.item_photos p where p.item_id = i.id and p.school_id = i.school_id),
    'deviceRejections30d', d.n)
  from public.items i
  left join public.map_zones z
    on z.id = i.zone_id and z.map_version_id = i.map_version_id and z.school_id = i.school_id
  cross join lateral (select case when i.device_token_hash is null then null
                                  else private.device_rejections_30d(i.school_id, i.device_token_hash) end as n) d
  where i.id = p_item_id
$$;

-- §5.3 step 4 edits (approve with edits, PATCH): description, category, zoneId (same map version),
-- dropoffLocationId. Returns the validated values plus `fields`, the edited keys in order.
create or replace function private.sapi_edits(p_item public.items, p_edits jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  k text;
  v jsonb;
  v_out jsonb := '{}'::jsonb;
  v_fields text[] := '{}';
  v_cat public.item_category;
  v_id uuid;
begin
  if p_edits is null or jsonb_typeof(p_edits) = 'null' then
    return jsonb_build_object('fields', '[]'::jsonb);
  end if;
  if jsonb_typeof(p_edits) <> 'object' then
    perform private.fail('invalid_input', 'edits');
  end if;
  for k, v in select e.key, e.value from jsonb_each(p_edits) as e loop
    case k
      when 'description' then
        if jsonb_typeof(v) <> 'string' then
          perform private.fail('invalid_input', 'description');
        end if;
        v_out := v_out || jsonb_build_object('description', private.sapi_text(v #>> '{}', 'description', 2, 120, true));
      when 'category' then
        if jsonb_typeof(v) <> 'string' or not ((v #>> '{}') = any (enum_range(null::public.item_category)::text[])) then
          perform private.fail('invalid_input', 'category');
        end if;
        v_cat := (v #>> '{}')::public.item_category;
        -- §5.3.1: IDs and medication are handled offline; student rows never carry high-value categories.
        if v_cat in ('id_card', 'medication')
           or (p_item.posted_by_kind = 'student' and v_cat in ('phone', 'wallet', 'keys')) then
          perform private.fail('invalid_input', 'category');
        end if;
        v_out := v_out || jsonb_build_object('category', v_cat);
      when 'zoneId' then
        if jsonb_typeof(v) = 'null' then
          v_out := v_out || jsonb_build_object('zoneId', null);
        else
          v_id := private.sapi_uuid(v, 'zoneId');
          if p_item.map_version_id is null or not exists (
               select 1 from public.map_zones z
                where z.id = v_id and z.map_version_id = p_item.map_version_id
                  and z.school_id = p_item.school_id and z.active) then
            perform private.fail('invalid_input', 'zoneId');
          end if;
          v_out := v_out || jsonb_build_object('zoneId', v_id);
        end if;
      when 'dropoffLocationId' then
        v_id := private.sapi_uuid(v, 'dropoffLocationId');
        perform private.sapi_active_location(p_item.school_id, v_id, 'dropoffLocationId');
        v_out := v_out || jsonb_build_object('dropoffLocationId', v_id);
      else
        perform private.fail('invalid_input', 'edits');
    end case;
    v_fields := v_fields || k;
  end loop;
  return v_out || jsonb_build_object('fields', to_jsonb(v_fields));
end $$;

-- §14.1: exact parsed domain match against the district allowlist (never suffix matching).
create or replace function private.sapi_email_allowed(p_email text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
           p_email = lower(p_email)
           and char_length(p_email) <= 254
           and p_email ~ '^[^@[:space:]]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           and split_part(p_email, '@', 2) = any ((private.district()).staff_email_domains),
         false)
$$;

-- Terminal custody shared by claim, dispose, and bulk dispose (§5.4, Appendix C, G-02, G-14):
-- a live publication is withdrawn in the same statement; ledger, invalidation, audit, and stats commit
-- with the transition. A hidden (unreviewed or rejected) item stays hidden.
create or replace function private.sapi_terminal(
  p_item public.items, p_custody public.custody_status, p_ctx private.staff_ctx, p_request_id uuid,
  p_action text, p_meta jsonb
) returns public.items
language plpgsql set search_path = '' as $$
declare
  i public.items;
  v_live boolean := p_item.publication_status in ('generating', 'published');
begin
  update public.items
     set custody = p_custody,
         terminal_at = now(),
         claimed_at = case when p_custody = 'claimed' then now() else claimed_at end,
         disposed_at = case when p_custody in ('expired_donated', 'expired_disposed') then now() else disposed_at end,
         disposition_due_at = case when p_custody = 'claimed' then null else disposition_due_at end,
         publication_status = case when v_live then 'withdrawn'::public.publication_status else publication_status end,
         withdrawn_at = case when v_live then now() else withdrawn_at end
   where id = p_item.id
   returning * into i;
  perform private.create_deletion_ledger(i.id, i.school_id, p_custody::text);
  perform private.invalidate(i.school_id, i.id);
  perform private.sapi_stat(i.school_id, case when p_custody = 'claimed' then 'claimed' else 'expired' end);
  perform private.audit(i.school_id, 'staff', p_ctx.member_id::text, p_request_id, p_action, 'items', i.id::text,
                        private.sapi_state(p_item), private.sapi_state(i), p_meta);
  return i;
end $$;

-- Reject shared by reject and bulk reject (§5.3, G-12, G-34). Media deletion is left to the periodic
-- anonymize_rejected job (rejected_media_retention_days).
create or replace function private.sapi_reject(
  p_item public.items, p_reason text, p_ctx private.staff_ctx, p_request_id uuid, p_bulk boolean
) returns public.items
language plpgsql set search_path = '' as $$
declare
  i public.items;
  v_blocked boolean := false;
begin
  update public.items
     set review_status = 'rejected', reject_reason = p_reason, reviewed_by = p_ctx.member_id, reviewed_at = now()
   where id = p_item.id
   returning * into i;
  if i.device_token_hash is not null then
    insert into public.device_rejections (school_id, device_token_hash) values (i.school_id, i.device_token_hash);
    v_blocked := private.maybe_auto_block(i.school_id, i.device_token_hash);
  end if;
  perform private.sapi_stat(i.school_id, 'rejected');
  perform private.audit(i.school_id, 'staff', p_ctx.member_id::text, p_request_id, 'item.reject', 'items', i.id::text,
                        private.sapi_state(p_item),
                        private.sapi_state(i) || jsonb_build_object('reject_reason', i.reject_reason),
                        jsonb_build_object('bulk', p_bulk, 'auto_blocked', v_blocked));
  return i;
end $$;

-- F-85: the digest is resolved server-side from an item or report of this school; never an argument.
create or replace function private.sapi_digest(p_school_id uuid, p_item_id uuid, p_report_id uuid)
returns bytea
language plpgsql stable set search_path = '' as $$
declare
  v bytea;
begin
  if (p_item_id is null) = (p_report_id is null) then
    perform private.fail('invalid_input', 'item_id');
  end if;
  if p_item_id is not null then
    select device_token_hash into v from public.items where id = p_item_id and school_id = p_school_id;
  else
    select device_token_hash into v from public.lost_reports where id = p_report_id and school_id = p_school_id;
  end if;
  if not found then
    perform private.fail('not_found');
  end if;
  if v is null then
    perform private.fail('not_found', 'device');
  end if;
  return v;
end $$;

-- §24 step 3 / §9.4.1: a map package is ready when canonical dimensions exist, at least one active zone
-- exists, and every active location has a pin on it. Returns NULL when ready, else the failing detail.
create or replace function private.sapi_map_gap(p_map_version_id uuid) returns text
language sql stable set search_path = '' as $$
  select case
    when v.width_px is null or v.height_px is null then 'map_not_canonical'
    when not exists (select 1 from public.map_zones z where z.map_version_id = v.id and z.active) then 'no_zones'
    when exists (select 1 from public.locations l
                  where l.school_id = v.school_id and l.active
                    and not exists (select 1 from public.location_map_pins p
                                     where p.location_id = l.id and p.map_version_id = v.id)) then 'locations_unpinned'
  end
  from public.map_versions v where v.id = p_map_version_id
$$;

do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname like 'sapi\_%'
  loop
    execute format('alter function %s owner to recover_api_owner', f.sig);
    execute format('revoke all on function %s from public', f.sig);
  end loop;
end $$;

-- =====================================================================================================
-- identity (G-05, §14.1, F-45): district scope, assertion verified before any lookup, no membership yet
-- =====================================================================================================

-- Sub first; the email fallback binds only an unbound invitation with a live membership in an allowed
-- domain. A row bound to another sub is denied (rebind is the audited district procedure).
create or replace function public.api_staff_bind_identity(p_assert jsonb, p_google_sub text, p_email text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  u public.staff_users;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_status text;
begin
  perform private.verify_assertion(p_assert, 'identity.bind', 'district', null, null,
    jsonb_build_object('google_sub', p_google_sub, 'email', p_email));
  if p_google_sub is null or p_assert->>'google_sub' is distinct from p_google_sub then
    perform private.fail('assertion_invalid');
  end if;

  select * into u from public.staff_users where google_sub = p_google_sub for update;
  if found then
    v_status := 'already_bound';
  else
    select * into u from public.staff_users where lower(email) = v_email for update;
    if not found then
      v_status := 'no_invite';
    elsif u.google_sub is not null then
      v_status := case when u.google_sub = p_google_sub then 'already_bound' else 'denied' end;
    elsif not private.sapi_email_allowed(v_email)
       or not exists (select 1 from public.staff_members m where m.user_id = u.id and m.status <> 'deactivated') then
      v_status := 'no_invite'; -- §14.1: no JIT provisioning; a fully deactivated account is not an invitation
    else
      update public.staff_users set google_sub = p_google_sub where id = u.id;
      v_status := 'bound';
    end if;
  end if;

  if v_status in ('bound', 'already_bound') then
    update public.staff_users set last_login_at = now() where id = u.id;
  end if;
  if u.id is not null then
    perform private.audit(null, 'staff', null, (p_assert->>'request_id')::uuid, 'identity.bind', 'staff_users',
                          u.id::text, '{}'::jsonb, jsonb_build_object('status', v_status), '{}'::jsonb);
  end if;
  return jsonb_build_object('status', v_status);
end $$;

-- Memberships are loaded per request (§14.1); invited memberships become active on first resolve (§6.3).
create or replace function public.api_staff_resolve_session(p_assert jsonb, p_google_sub text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  u public.staff_users;
  m record;
begin
  perform private.verify_assertion(p_assert, 'session.resolve', 'district', null, null,
    jsonb_build_object('google_sub', p_google_sub));
  if p_google_sub is null or p_assert->>'google_sub' is distinct from p_google_sub then
    perform private.fail('assertion_invalid');
  end if;

  select * into u from public.staff_users where google_sub = p_google_sub;
  if not found then
    perform private.fail('forbidden');
  end if;

  for m in
    update public.staff_members sm set status = 'active'
     where sm.user_id = u.id and sm.status = 'invited'
       and (sm.school_id is null or exists (select 1 from public.schools s where s.id = sm.school_id and s.active))
    returning sm.id, sm.school_id
  loop
    perform private.audit(m.school_id, 'staff', m.id::text, (p_assert->>'request_id')::uuid, 'staff.activate',
                          'staff_members', m.id::text, jsonb_build_object('status', 'invited'),
                          jsonb_build_object('status', 'active'), '{}'::jsonb);
  end loop;

  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'displayName', u.display_name),
    'memberships', (
      select coalesce(jsonb_agg(jsonb_build_object('memberId', sm.id, 'schoolId', sm.school_id, 'schoolCode', s.code,
                                                   'schoolName', s.name, 'role', sm.role, 'status', sm.status)
                                order by private.role_rank(sm.role) desc, s.name nulls first), '[]'::jsonb)
        from public.staff_members sm
        left join public.schools s on s.id = sm.school_id
       where sm.user_id = u.id and sm.status <> 'deactivated' and (sm.school_id is null or s.active)));
end $$;

-- =====================================================================================================
-- queue and item read (§5.3, §10 implementation guide, G-24, G-40)
-- =====================================================================================================

-- Pending items, not deleted, non-terminal custody; unscreened/error/flagged sort ahead of clean (G-40),
-- then oldest first. 50 per page. The cursor is the last row's (createdAt, id); its sort bucket is read
-- from that row, so the keyset is (bucket, created_at, id). Quarantined items only for school_admin+.
create or replace function public.api_staff_queue(
  p_assert jsonb, p_school_code text, p_cursor_created text, p_cursor_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  v_admin boolean;
  v_created timestamptz;
  v_bucket int;
  v_ids uuid[];
begin
  ctx := private.assert_staff(p_assert, 'queue.read', s.id, null, null,
    jsonb_build_object('school_code', p_school_code, 'cursor_created', p_cursor_created, 'cursor_id', p_cursor_id));
  v_admin := private.role_rank(ctx.role) >= 3;
  v_created := private.sapi_ts(p_cursor_created, 'cursor_created');
  if (v_created is null) <> (p_cursor_id is null) then
    perform private.fail('invalid_input', 'cursor_id');
  end if;
  if p_cursor_id is not null then
    select case when i.screening_status = 'clean' then 1 else 0 end into v_bucket
      from public.items i where i.id = p_cursor_id and i.school_id = s.id;
    v_bucket := coalesce(v_bucket, 0);
  end if;

  select array_agg(q.id order by q.b, q.created_at, q.id) into v_ids
    from (select i.id, i.created_at, case when i.screening_status = 'clean' then 1 else 0 end as b
            from public.items i
           where i.school_id = s.id and i.review_status = 'pending' and i.deleted_at is null
             and i.custody in ('with_finder', 'at_location')
             and (v_admin or not private.sapi_quarantined(i.screening_flags))
             and (p_cursor_id is null
                  or (case when i.screening_status = 'clean' then 1 else 0 end, i.created_at, i.id)
                     > (v_bucket, v_created, p_cursor_id))
           order by 3, 2, 1
           limit 51) q;

  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(private.sapi_item_json(x.id) order by x.n), '[]'::jsonb)
                from unnest(v_ids[1:50]) with ordinality as x(id, n)),
    'nextCursor', case when coalesce(cardinality(v_ids), 0) > 50
                       then (select jsonb_build_object('createdAt', i.created_at, 'id', i.id)
                               from public.items i where i.id = v_ids[50])
                  end);
end $$;

create or replace function public.api_staff_item_get(p_assert jsonb, p_school_code text, p_item_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
begin
  ctx := private.assert_staff(p_assert, 'item.read', s.id, p_item_id, null,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id));
  select * into i from public.items where id = p_item_id and school_id = s.id;
  if not found or i.review_status = 'draft' or i.deleted_at is not null then
    perform private.fail('not_found');
  end if;
  if private.sapi_quarantined(i.screening_flags) and private.role_rank(ctx.role) < 3 then
    perform private.fail('forbidden');
  end if;
  return private.sapi_item_json(i.id);
end $$;

-- =====================================================================================================
-- review (Appendix C item_approve / item_reject; §5.3; G-02, G-12, G-24, G-34)
-- =====================================================================================================

-- pending -> approved, publication hidden -> generating, make_variants enqueued. Every current photo
-- must be canonical (or already public-ready) and there must be at least one (F-18, G-23).
create or replace function public.api_staff_item_approve(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_edits jsonb
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_before jsonb;
  e jsonb;
  v_cur int;
  v_bad int;
begin
  ctx := private.assert_staff(p_assert, 'item.approve', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'edits', p_edits));
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, true);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  -- G-02: a pending item already in terminal custody stays hidden; it cannot start publication.
  if i.review_status <> 'pending' or i.deleted_at is not null or i.custody not in ('with_finder', 'at_location') then
    perform private.fail('state_changed', 'review_status');
  end if;
  select count(*), count(*) filter (where p.status not in ('canonical_ready', 'public_ready'))
    into v_cur, v_bad
    from public.item_photos p where p.item_id = i.id and p.is_current;
  if v_cur = 0 or v_bad > 0 then
    perform private.fail('state_changed', 'photos_not_ready');
  end if;
  e := private.sapi_edits(i, p_edits);
  v_before := private.sapi_state(i);

  update public.items
     set description = case when e->'fields' ? 'description' then e->>'description' else description end,
         category = case when e->'fields' ? 'category' then (e->>'category')::public.item_category else category end,
         zone_id = case when e->'fields' ? 'zoneId' then (e->>'zoneId')::uuid else zone_id end,
         dropoff_location_id = case when e->'fields' ? 'dropoffLocationId' then (e->>'dropoffLocationId')::uuid
                                    else dropoff_location_id end,
         review_status = 'approved',
         publication_status = 'generating',
         reviewed_by = ctx.member_id,
         reviewed_at = now()
   where id = i.id
   returning * into i;

  perform private.enqueue('make_variants', jsonb_build_object('itemId', i.id), s.id,
                          'make_variants:' || i.id::text, now(), 50::smallint);
  perform private.sapi_stat(s.id, 'approved');
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.approve', 'items',
                        i.id::text, v_before, private.sapi_state(i),
                        jsonb_build_object('edited_fields', e->'fields'));
  return private.sapi_result(i);
end $$;

create or replace function public.api_staff_item_reject(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
begin
  ctx := private.assert_staff(p_assert, 'item.reject', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'reason', p_reason));
  if p_reason is null or p_reason not in ('inappropriate', 'not_an_item', 'duplicate', 'pii_visible', 'spam', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, true);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.review_status <> 'pending' or i.deleted_at is not null then
    perform private.fail('state_changed', 'review_status');
  end if;
  i := private.sapi_reject(i, p_reason, ctx, (p_assert->>'request_id')::uuid, false);
  return private.sapi_result(i);
end $$;

-- <= 50 ids, one reason (§8.2). Rows are locked in id order; anything not rejectable is skipped.
create or replace function public.api_staff_bulk_reject(
  p_assert jsonb, p_school_code text, p_item_ids uuid[], p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_admin boolean;
  v_req uuid := (p_assert->>'request_id')::uuid;
  v_done uuid[] := '{}';
begin
  ctx := private.assert_staff(p_assert, 'item.bulk_reject', s.id, null, null,
    jsonb_build_object('school_code', p_school_code, 'item_ids', p_item_ids, 'reason', p_reason));
  if p_reason is null or p_reason not in ('inappropriate', 'not_an_item', 'duplicate', 'pii_visible', 'spam', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 or cardinality(p_item_ids) > 50
     or array_position(p_item_ids, null) is not null then
    perform private.fail('invalid_input', 'item_ids');
  end if;
  v_admin := private.role_rank(ctx.role) >= 3;
  for i in select * from public.items where id = any (p_item_ids) and school_id = s.id order by id for update loop
    if i.review_status = 'pending' and i.deleted_at is null
       and (v_admin or not private.sapi_quarantined(i.screening_flags)) then
      perform private.sapi_reject(i, p_reason, ctx, v_req, true);
      v_done := v_done || i.id;
    end if;
  end loop;
  return jsonb_build_object(
    'rejected', cardinality(v_done),
    'skipped', (select coalesce(jsonb_agg(x.id order by x.n), '[]'::jsonb)
                  from (select u.id, min(u.n) as n from unnest(p_item_ids) with ordinality as u(id, n) group by u.id) x
                 where not (x.id = any (v_done))));
end $$;

-- =====================================================================================================
-- custody (Appendix C item_receive / item_transfer / item_claim / item_dispose; §5.4; G-01, G-02)
-- =====================================================================================================

-- with_finder -> at_location for any non-draft item, or the G-01 late arrival: expired_never_arrived
-- within late_arrival_grace_days of terminal_at. The late path cancels deletion that has not started and,
-- when the withdrawal came from that expiry and every current photo is still public_ready, republishes.
create or replace function public.api_staff_item_receive(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_location_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_before jsonb;
  v_late boolean := false;
  v_cancelled boolean := false;
  v_republish boolean := false;
  v_cur int;
  v_bad int;
begin
  ctx := private.assert_staff(p_assert, 'item.receive', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'location_id', p_location_id));
  perform private.sapi_active_location(s.id, p_location_id, 'location_id');
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.deleted_at is not null then
    perform private.fail('state_changed', 'deleted');
  end if;
  if i.custody = 'expired_never_arrived' and i.text_cleared_at is null
     and i.terminal_at >= now() - make_interval(days => s.late_arrival_grace_days) then
    v_late := true;
  elsif i.custody <> 'with_finder' then
    perform private.fail('state_changed', 'custody');
  end if;
  v_before := private.sapi_state(i);

  if v_late then
    v_cancelled := private.cancel_pending_deletion(i.id);
    select count(*), count(*) filter (where p.status <> 'public_ready')
      into v_cur, v_bad
      from public.item_photos p where p.item_id = i.id and p.is_current;
    v_republish := v_cancelled and i.publication_status = 'withdrawn' and i.withdrawn_at >= i.terminal_at
                   and i.description is not null and v_cur > 0 and v_bad = 0;
  end if;

  update public.items
     set custody = 'at_location',
         received_at = now(),
         current_location_id = p_location_id,
         expires_at = now() + make_interval(days => s.retention_days),
         terminal_at = null,
         publication_status = case when v_republish then 'published'::public.publication_status
                                   else publication_status end,
         withdrawn_at = case when v_republish then null else withdrawn_at end
   where id = i.id
   returning * into i;

  if i.publication_status in ('generating', 'published') then
    perform private.invalidate(s.id, i.id);
  end if;
  perform private.sapi_stat(s.id, 'received');
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid,
                        case when v_late then 'item.receive_late' else 'item.receive' end, 'items', i.id::text,
                        v_before,
                        private.sapi_state(i) || jsonb_build_object('current_location_id', i.current_location_id,
                                                                    'expires_at', i.expires_at),
                        case when v_late then jsonb_build_object('deletion_cancelled', v_cancelled,
                                                                 'republished', v_republish)
                             else '{}'::jsonb end);
  return private.sapi_result(i);
end $$;

-- at_location -> at_location at another active location of the same school.
create or replace function public.api_staff_item_transfer(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_location_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_from uuid;
begin
  ctx := private.assert_staff(p_assert, 'item.transfer', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'location_id', p_location_id));
  perform private.sapi_active_location(s.id, p_location_id, 'location_id');
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.custody <> 'at_location' or i.deleted_at is not null then
    perform private.fail('state_changed', 'custody');
  end if;
  if i.current_location_id = p_location_id then
    perform private.fail('invalid_input', 'location_id');
  end if;
  v_from := i.current_location_id;

  update public.items set current_location_id = p_location_id where id = i.id returning * into i;

  if i.publication_status in ('generating', 'published') then
    perform private.invalidate(s.id, i.id);
  end if;
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.transfer', 'items',
                        i.id::text, jsonb_build_object('current_location_id', v_from, 'row_version', p_row_version),
                        jsonb_build_object('current_location_id', i.current_location_id, 'row_version', i.row_version),
                        '{}'::jsonb);
  return private.sapi_result(i);
end $$;

-- at_location -> claimed (terminal). Review state is left as is (G-02: pending or rejected may be claimed).
create or replace function public.api_staff_item_claim(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
begin
  ctx := private.assert_staff(p_assert, 'item.claim', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version));
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.custody <> 'at_location' or i.deleted_at is not null then
    perform private.fail('state_changed', 'custody');
  end if;
  i := private.sapi_terminal(i, 'claimed', ctx, (p_assert->>'request_id')::uuid, 'item.claim', '{}'::jsonb);
  return private.sapi_result(i);
end $$;

-- at_location -> expired_donated | expired_disposed. Needs disposition due (mark_disposition_due) or an
-- authorized early disposal by school_admin+ (Appendix C "disposition due or authorized early policy").
create or replace function public.api_staff_item_dispose(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_disposition text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
begin
  ctx := private.assert_staff(p_assert, 'item.dispose', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'disposition', p_disposition));
  if p_disposition is null or p_disposition not in ('donated', 'disposed') then
    perform private.fail('invalid_input', 'disposition');
  end if;
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.custody <> 'at_location' or i.deleted_at is not null then
    perform private.fail('state_changed', 'custody');
  end if;
  if i.disposition_due_at is null and private.role_rank(ctx.role) < 3 then
    perform private.fail('forbidden');
  end if;
  i := private.sapi_terminal(i, ('expired_' || p_disposition)::public.custody_status, ctx,
                             (p_assert->>'request_id')::uuid, 'item.dispose',
                             jsonb_build_object('disposition', p_disposition, 'early', i.disposition_due_at is null));
  return private.sapi_result(i);
end $$;

-- End-of-term disposition day (runbook 7): <= 50 ids; each item must be disposable on its own terms.
create or replace function public.api_staff_bulk_dispose(
  p_assert jsonb, p_school_code text, p_item_ids uuid[], p_disposition text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_admin boolean;
  v_req uuid := (p_assert->>'request_id')::uuid;
  v_done uuid[] := '{}';
begin
  ctx := private.assert_staff(p_assert, 'item.bulk_dispose', s.id, null, null,
    jsonb_build_object('school_code', p_school_code, 'item_ids', p_item_ids, 'disposition', p_disposition));
  if p_disposition is null or p_disposition not in ('donated', 'disposed') then
    perform private.fail('invalid_input', 'disposition');
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 or cardinality(p_item_ids) > 50
     or array_position(p_item_ids, null) is not null then
    perform private.fail('invalid_input', 'item_ids');
  end if;
  v_admin := private.role_rank(ctx.role) >= 3;
  for i in select * from public.items where id = any (p_item_ids) and school_id = s.id order by id for update loop
    if i.custody = 'at_location' and i.deleted_at is null and i.review_status <> 'draft'
       and (i.disposition_due_at is not null or v_admin) then
      perform private.sapi_terminal(i, ('expired_' || p_disposition)::public.custody_status, ctx, v_req,
                                    'item.dispose', jsonb_build_object('disposition', p_disposition, 'bulk', true,
                                                                       'early', i.disposition_due_at is null));
      v_done := v_done || i.id;
    end if;
  end loop;
  return jsonb_build_object(
    'disposed', cardinality(v_done),
    'skipped', (select coalesce(jsonb_agg(x.id order by x.n), '[]'::jsonb)
                  from (select u.id, min(u.n) as n from unnest(p_item_ids) with ordinality as u(id, n) group by u.id) x
                 where not (x.id = any (v_done))));
end $$;

-- =====================================================================================================
-- item changes (Appendix C item_pull; §5.3 step 6, §5.4 delete, §10.2 step 5; G-08, G-23)
-- =====================================================================================================

-- Incident pull (§23 runbook 3): generating|published -> withdrawn, immediate deletion ledger, cache purge.
-- Reason codes only (no free text reaches audit): the contract set plus the staff UI's codes.
create or replace function public.api_staff_item_pull(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_before jsonb;
begin
  ctx := private.assert_staff(p_assert, 'item.pull', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'reason', p_reason));
  if p_reason is null or p_reason not in ('inappropriate', 'privacy', 'duplicate', 'other',
                                          'pii_visible', 'not_an_item', 'owner_request') then
    perform private.fail('invalid_input', 'reason');
  end if;
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.publication_status not in ('generating', 'published') or i.deleted_at is not null then
    perform private.fail('state_changed', 'publication_status');
  end if;
  v_before := private.sapi_state(i);

  update public.items set publication_status = 'withdrawn', withdrawn_at = now()
   where id = i.id returning * into i;

  perform private.create_deletion_ledger(i.id, s.id, 'pulled');
  perform private.invalidate(s.id, i.id);
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.pull', 'items',
                        i.id::text, v_before, private.sapi_state(i), jsonb_build_object('reason', p_reason));
  return private.sapi_result(i);
end $$;

-- Soft delete (§5.4, §15.4): deleted_at set, a live publication withdrawn, deletion ledger, cache purge.
create or replace function public.api_staff_item_delete(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_before jsonb;
  v_live boolean;
begin
  ctx := private.assert_staff(p_assert, 'item.delete', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'reason', p_reason));
  if p_reason is null or p_reason not in ('staff_mistake', 'duplicate', 'test_post', 'owner_request', 'privacy',
                                          'inappropriate', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.deleted_at is not null then
    perform private.fail('state_changed', 'deleted');
  end if;
  v_before := private.sapi_state(i);
  v_live := i.publication_status in ('generating', 'published');

  update public.items
     set deleted_at = now(),
         publication_status = case when v_live then 'withdrawn'::public.publication_status else publication_status end,
         withdrawn_at = case when v_live then now() else withdrawn_at end
   where id = i.id
   returning * into i;

  perform private.create_deletion_ledger(i.id, s.id, 'deleted');
  perform private.invalidate(s.id, i.id);
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.delete', 'items',
                        i.id::text, v_before, private.sapi_state(i) || jsonb_build_object('deleted', true),
                        jsonb_build_object('reason', p_reason));
  return private.sapi_result(i);
end $$;

-- PATCH (§5.3 step 6): same edit allowlist as approve, on live pending or approved items. A published
-- item gets cache invalidation and a new matching generation (match_item:<id>:<row_version>).
create or replace function public.api_staff_item_edit(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint, p_edits jsonb
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_before jsonb;
  e jsonb;
begin
  ctx := private.assert_staff(p_assert, 'item.edit', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version,
                       'edits', p_edits));
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, true);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.deleted_at is not null or i.review_status not in ('pending', 'approved')
     or i.custody not in ('with_finder', 'at_location') then
    perform private.fail('state_changed', 'review_status');
  end if;
  e := private.sapi_edits(i, p_edits);
  if jsonb_array_length(e->'fields') = 0 then
    perform private.fail('invalid_input', 'edits');
  end if;
  v_before := private.sapi_state(i);

  update public.items
     set description = case when e->'fields' ? 'description' then e->>'description' else description end,
         category = case when e->'fields' ? 'category' then (e->>'category')::public.item_category else category end,
         zone_id = case when e->'fields' ? 'zoneId' then (e->>'zoneId')::uuid else zone_id end,
         dropoff_location_id = case when e->'fields' ? 'dropoffLocationId' then (e->>'dropoffLocationId')::uuid
                                    else dropoff_location_id end
   where id = i.id
   returning * into i;

  if i.publication_status = 'published' then
    perform private.invalidate(s.id, i.id);
    perform private.enqueue('match_item', jsonb_build_object('itemId', i.id), s.id,
                            'match_item:' || i.id::text || ':' || i.row_version::text);
  end if;
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.edit', 'items',
                        i.id::text, v_before, private.sapi_state(i),
                        jsonb_build_object('edited_fields', e->'fields'));
  return private.sapi_result(i);
end $$;

-- G-08 step 6: release a screening hold on a staff/backfill post, then run publish-ready with force
-- (hidden -> generating + make_variants once every current photo is canonical).
create or replace function public.api_staff_item_confirm_publish(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_row_version bigint
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  v_before jsonb;
  v_started boolean;
begin
  ctx := private.assert_staff(p_assert, 'item.confirm_publish', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'row_version', p_row_version));
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, true);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.posted_by_kind = 'student' or i.review_status <> 'approved' or i.publication_status <> 'hidden'
     or i.deleted_at is not null or i.custody not in ('with_finder', 'at_location') then
    perform private.fail('state_changed', 'publication_status');
  end if;
  v_before := private.sapi_state(i);

  update public.items set screening_flags = screening_flags - 'hold' where id = i.id;
  v_started := private.staff_publish_ready(i.id, true);
  select * into i from public.items where id = i.id;

  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.confirm_publish',
                        'items', i.id::text, v_before, private.sapi_state(i),
                        jsonb_build_object('publication_started', v_started));
  return private.sapi_result(i);
end $$;

-- G-23: drop one current photo generation (never the last one). The generation leaves the current set and
-- gets its own deletion ledger. A staff post still hidden re-runs publish-ready (screening rules apply).
create or replace function public.api_staff_photo_drop(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_photo_id uuid, p_row_version bigint
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  p public.item_photos;
  v_before jsonb;
  v_cur int;
begin
  ctx := private.assert_staff(p_assert, 'item.photo_drop', s.id, p_item_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'photo_id', p_photo_id,
                       'row_version', p_row_version));
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, true);
  if i.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if i.deleted_at is not null or i.custody not in ('with_finder', 'at_location') then
    perform private.fail('state_changed', 'custody');
  end if;
  select * into p from public.item_photos where id = p_photo_id and item_id = i.id and school_id = s.id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if not p.is_current then
    perform private.fail('state_changed', 'photo_not_current');
  end if;
  select count(*) into v_cur from public.item_photos where item_id = i.id and is_current;
  if v_cur <= 1 then
    perform private.fail('state_changed', 'last_photo');
  end if;
  v_before := private.sapi_state(i);

  update public.item_photos set is_current = false where id = p.id;
  perform private.create_deletion_ledger(i.id, s.id, 'photo_dropped', array[p.id]);
  update public.items set photo_count = (v_cur - 1)::smallint where id = i.id returning * into i;

  if i.publication_status in ('generating', 'published') then
    perform private.invalidate(s.id, i.id);
  elsif i.posted_by_kind <> 'student' and i.review_status = 'approved' and i.publication_status = 'hidden' then
    perform private.staff_publish_ready(i.id, false);
    select * into i from public.items where id = i.id;
  end if;
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.photo_drop',
                        'items', i.id::text, v_before, private.sapi_state(i),
                        jsonb_build_object('photo_id', p.id, 'position', p.position, 'generation', p.generation));
  return private.sapi_result(i);
end $$;

-- =====================================================================================================
-- staff posts (G-08 steps 1-3; §5.3.1, §5.3.2, §24 backfill)
-- =====================================================================================================

-- Step 1: approved / hidden / at_location with public_id at create, received now at p_location_id, and
-- generation-1 photo rows whose incoming keys follow BUILD-CONTRACT section 8. No arrival deadline.
create or replace function public.api_staff_create_item(
  p_assert jsonb, p_school_code text, p_mode text, p_category text, p_description text, p_note text,
  p_map_version_id uuid, p_pin_x text, p_pin_y text, p_location_id uuid, p_photo_count int
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  v_cat public.item_category;
  v_desc text;
  v_note text;
  v_x double precision;
  v_y double precision;
  v_zone uuid;
  v_id uuid := gen_random_uuid();
  v_pid uuid;
  v_public text;
  v_photos jsonb := '[]'::jsonb;
  n int;
begin
  ctx := private.assert_staff(p_assert, 'item.create', s.id, null, null,
    jsonb_build_object('school_code', p_school_code, 'mode', p_mode, 'category', p_category,
                       'description', p_description, 'note', p_note, 'map_version_id', p_map_version_id,
                       'pin_x', p_pin_x, 'pin_y', p_pin_y, 'location_id', p_location_id,
                       'photo_count', p_photo_count));
  if p_mode is null or p_mode not in ('staff', 'backfill') then
    perform private.fail('invalid_input', 'mode');
  end if;
  -- §5.3.1: ID cards and medication are handled offline and never get a row with photos.
  if p_category is null or not (p_category = any (enum_range(null::public.item_category)::text[]))
     or p_category in ('id_card', 'medication') then
    perform private.fail('invalid_input', 'category');
  end if;
  v_cat := p_category::public.item_category;
  v_desc := private.sapi_text(p_description, 'description', 2, 120, true);
  v_note := private.sapi_text(p_note, 'note', 1, 80, false);
  v_x := private.sapi_num(p_pin_x, 'pin_x');
  v_y := private.sapi_num(p_pin_y, 'pin_y');
  if (v_x is null) <> (v_y is null) or v_x not between 0 and 1 or v_y not between 0 and 1 then
    perform private.fail('invalid_input', 'pin');
  end if;
  if v_x is not null and p_map_version_id is null then
    perform private.fail('invalid_input', 'map_version_id');
  end if;
  if p_map_version_id is not null and not exists (
       select 1 from public.map_versions v
        where v.id = p_map_version_id and v.school_id = s.id and v.approval_status in ('approved', 'retired')) then
    perform private.fail('invalid_input', 'map_version_id');
  end if;
  perform private.sapi_active_location(s.id, p_location_id, 'location_id');
  if p_photo_count is null or p_photo_count not between 1 and 3 then
    perform private.fail('invalid_input', 'photo_count');
  end if;
  if v_x is not null then
    v_zone := private.resolve_zone(p_map_version_id, v_x, v_y);
  end if;
  v_public := private.next_public_id(s.id, p_location_id);

  insert into public.items (id, school_id, public_id, category, description, location_note_private, zone_id,
                            map_version_id, pin_x, pin_y, dropoff_location_id, current_location_id, photo_count,
                            review_status, publication_status, custody, posted_by_kind, posted_by_staff_id,
                            received_at, expires_at, reviewed_by, reviewed_at)
  values (v_id, s.id, v_public, v_cat, v_desc, v_note, v_zone,
          p_map_version_id, v_x, v_y, p_location_id, p_location_id, p_photo_count::smallint,
          'approved', 'hidden', 'at_location', p_mode, ctx.member_id,
          now(), now() + make_interval(days => s.retention_days), ctx.member_id, now());

  for n in 0 .. p_photo_count - 1 loop
    v_pid := gen_random_uuid();
    insert into public.item_photos (id, school_id, item_id, position, generation, is_current, incoming_path, status)
    values (v_pid, s.id, v_id, n::smallint, 1, true,
            s.id::text || '/' || v_id::text || '/' || v_pid::text || '/raw', 'uploaded');
    v_photos := v_photos || jsonb_build_array(jsonb_build_object('photoId', v_pid, 'position', n, 'generation', 1));
  end loop;

  perform private.sapi_stat(s.id, 'posted');
  perform private.sapi_stat(s.id, 'received');
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.create', 'items',
                        v_id::text, '{}'::jsonb,
                        jsonb_build_object('review_status', 'approved', 'publication_status', 'hidden',
                                           'custody', 'at_location', 'posted_by_kind', p_mode),
                        jsonb_build_object('category', v_cat, 'photo_count', p_photo_count,
                                           'current_location_id', p_location_id));
  return jsonb_build_object('itemId', v_id, 'publicId', v_public, 'photos', v_photos);
end $$;

-- Steps 2-3: after the worker complete-check, verify every declared incoming object for the current
-- generations (exists, magic, raw size) and enqueue canonicalize_photo per photo. Idempotent: once every
-- current photo has been accepted, a repeat returns the same result and enqueues nothing.
create or replace function public.api_staff_complete_item(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_objects jsonb
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  i public.items;
  p public.item_photos;
  o jsonb;
  v_n int := 0;
begin
  ctx := private.assert_staff(p_assert, 'item.complete', s.id, p_item_id, null,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'objects', p_objects));
  i := private.sapi_lock_item(s.id, p_item_id, ctx.role, false);
  if i.posted_by_kind = 'student' then
    perform private.fail('state_changed', 'posted_by_kind');
  end if;
  if not exists (select 1 from public.item_photos
                  where item_id = i.id and is_current and status = 'uploaded' and raw_bytes is null) then
    return private.sapi_result(i) || jsonb_build_object('publicId', i.public_id);
  end if;
  if i.review_status <> 'approved' or i.publication_status <> 'hidden' or i.deleted_at is not null
     or i.custody not in ('with_finder', 'at_location') then
    perform private.fail('state_changed', 'publication_status');
  end if;
  if p_objects is null or jsonb_typeof(p_objects) <> 'array' or jsonb_array_length(p_objects) > 3 then
    perform private.fail('invalid_input', 'objects');
  end if;
  -- no undeclared slot (§9.2): every reported object must be a current photo of this item
  if exists (select 1 from jsonb_array_elements(p_objects) as e(v)
              where jsonb_typeof(e.v) <> 'object'
                 or not exists (select 1 from public.item_photos x
                                 where x.item_id = i.id and x.is_current and x.id::text = lower(e.v->>'photoId'))) then
    perform private.fail('invalid_input', 'objects');
  end if;

  for p in select * from public.item_photos
            where item_id = i.id and is_current and status = 'uploaded' and raw_bytes is null
            order by position for update loop
    select e.v into o from jsonb_array_elements(p_objects) as e(v) where lower(e.v->>'photoId') = p.id::text limit 1;
    if o is null or o->'exists' is distinct from 'true'::jsonb or o->'magicOk' is distinct from 'true'::jsonb
       or jsonb_typeof(o->'rawBytes') is distinct from 'number' or (o->>'rawBytes') !~ '^[0-9]{1,7}$'
       or (o->>'rawBytes')::int not between 1 and 1048576 then
      perform private.fail('invalid_input', 'objects');
    end if;
    update public.item_photos set raw_bytes = (o->>'rawBytes')::int where id = p.id;
    perform private.enqueue('canonicalize_photo', jsonb_build_object('photoId', p.id), s.id,
                            'canonicalize_photo:' || p.id::text, now(), 50::smallint);
    v_n := v_n + 1;
  end loop;

  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'item.complete', 'items',
                        i.id::text, '{}'::jsonb, private.sapi_state(i), jsonb_build_object('photos', v_n));
  return private.sapi_result(i) || jsonb_build_object('publicId', i.public_id);
end $$;

-- =====================================================================================================
-- devices (§13.3, F-85): the digest is resolved from an item or report of this school
-- =====================================================================================================

create or replace function public.api_staff_block_device(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_report_id uuid, p_days int, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  v_digest bytea;
  v_until timestamptz;
begin
  ctx := private.assert_staff(p_assert, 'device.block', s.id, coalesce(p_item_id, p_report_id), null,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'report_id', p_report_id,
                       'days', p_days, 'reason', p_reason));
  if p_days is null or p_days not between 1 and 90 then
    perform private.fail('invalid_input', 'days');
  end if;
  -- Reason codes for the audit row; devices.block_reason is always 'staff' so staff blocks stay
  -- distinguishable from auto_rejections.
  if p_reason is null or p_reason not in ('spam', 'abuse', 'staff', 'inappropriate', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  v_digest := private.sapi_digest(s.id, p_item_id, p_report_id);

  insert into public.devices (school_id, token_hash, blocked_until, block_reason, blocked_by)
  values (s.id, v_digest, now() + make_interval(days => p_days), 'staff', ctx.member_id)
  on conflict (school_id, token_hash) do update
    set blocked_until = excluded.blocked_until, block_reason = 'staff', blocked_by = excluded.blocked_by
  returning blocked_until into v_until;

  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'device.block',
                        case when p_item_id is not null then 'items' else 'lost_reports' end,
                        coalesce(p_item_id, p_report_id)::text, '{}'::jsonb,
                        jsonb_build_object('blocked_until', v_until),
                        jsonb_build_object('days', p_days, 'reason', p_reason));
  return jsonb_build_object('blocked', true, 'blockedUntil', v_until);
end $$;

create or replace function public.api_staff_unblock_device(
  p_assert jsonb, p_school_code text, p_item_id uuid, p_report_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  v_digest bytea;
  v_was timestamptz;
begin
  ctx := private.assert_staff(p_assert, 'device.unblock', s.id, coalesce(p_item_id, p_report_id), null,
    jsonb_build_object('school_code', p_school_code, 'item_id', p_item_id, 'report_id', p_report_id));
  v_digest := private.sapi_digest(s.id, p_item_id, p_report_id);
  select blocked_until into v_was from public.devices
   where school_id = s.id and token_hash = v_digest for update;
  update public.devices set blocked_until = null, block_reason = null, blocked_by = null
   where school_id = s.id and token_hash = v_digest;
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'device.unblock',
                        case when p_item_id is not null then 'items' else 'lost_reports' end,
                        coalesce(p_item_id, p_report_id)::text,
                        jsonb_build_object('blocked_until', v_was), jsonb_build_object('blocked_until', null),
                        '{}'::jsonb);
  return jsonb_build_object('blocked', false, 'blockedUntil', null);
end $$;

-- =====================================================================================================
-- media tickets (G-04, G-07): single-use, 30-second capabilities redeemed by the worker
-- =====================================================================================================

-- The attested operation IS p_operation. media.read: a canonical photo of an item of this school
-- (quarantined items need school_admin+). map.upload (draft only) and map.read: this school's versions.
-- map.activate: district scope; the version must be pending_district with a complete package.
create or replace function public.api_staff_media_ticket(
  p_assert jsonb, p_school_code text, p_operation text, p_photo_id uuid, p_map_version_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_scope uuid := case when p_operation = 'map.activate' then null
                       else (private.school_by_code(p_school_code)).id end;
  ctx private.staff_ctx;
  v_school uuid;
  v_item uuid;
  v_flags jsonb;
  v_status text;
  v_gap text;
  t public.media_tickets;
begin
  ctx := private.assert_staff(p_assert, p_operation, v_scope, coalesce(p_photo_id, p_map_version_id), null,
    jsonb_build_object('school_code', p_school_code, 'operation', p_operation, 'photo_id', p_photo_id,
                       'map_version_id', p_map_version_id));
  if p_operation is null or p_operation not in ('media.read', 'map.upload', 'map.read', 'map.activate') then
    perform private.fail('invalid_input', 'operation');
  end if;

  if p_operation = 'media.read' then
    if p_photo_id is null or p_map_version_id is not null then
      perform private.fail('invalid_input', 'photo_id');
    end if;
    select p.school_id, p.item_id, i.screening_flags into v_school, v_item, v_flags
      from public.item_photos p
      join public.items i on i.id = p.item_id and i.school_id = p.school_id
     where p.id = p_photo_id and p.school_id = v_scope and p.original_path is not null
       and i.review_status <> 'draft';
    if v_school is null then
      perform private.fail('not_found');
    end if;
    if private.sapi_quarantined(v_flags) and private.role_rank(ctx.role) < 3 then
      perform private.fail('forbidden');
    end if;
  else
    if p_map_version_id is null or p_photo_id is not null then
      perform private.fail('invalid_input', 'map_version_id');
    end if;
    select v.school_id, v.approval_status into v_school, v_status
      from public.map_versions v
     where v.id = p_map_version_id
       and (v_scope is null or v.school_id = v_scope)
       and (p_operation <> 'map.activate' or p_school_code is null
            or v.school_id = (select sc.id from public.schools sc where sc.code = upper(btrim(p_school_code))));
    if v_school is null then
      perform private.fail('not_found');
    end if;
    if p_operation = 'map.upload' and v_status <> 'draft' then
      perform private.fail('state_changed', 'approval_status');
    end if;
    if p_operation = 'map.activate' then
      if v_status <> 'pending_district' then
        perform private.fail('state_changed', 'approval_status');
      end if;
      v_gap := private.sapi_map_gap(p_map_version_id);
      if v_gap is not null then
        perform private.fail('state_changed', v_gap);
      end if;
    end if;
  end if;

  insert into public.media_tickets (school_id, operation, item_id, item_photo_id, map_version_id, staff_member_id,
                                    expires_at)
  values (v_school, p_operation, v_item, case when p_operation = 'media.read' then p_photo_id end,
          case when p_operation <> 'media.read' then p_map_version_id end, ctx.member_id,
          now() + interval '30 seconds')
  returning * into t;
  return jsonb_build_object('ticketId', t.id, 'expiresAt', t.expires_at);
end $$;

-- =====================================================================================================
-- lost reports, staff view (§12.3, G-43): open reports of this school, never any device data
-- =====================================================================================================

create or replace function public.api_staff_lost_reports(p_assert jsonb, p_school_code text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
begin
  ctx := private.assert_staff(p_assert, 'reports.read', s.id, null, null,
    jsonb_build_object('school_code', p_school_code));
  return jsonb_build_object('reports', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', r.id, 'category', r.category, 'description', r.description,
             'pin', case when r.pin_x is null then null else jsonb_build_object('x', r.pin_x, 'y', r.pin_y) end,
             'mapVersionId', r.map_version_id, 'createdAt', r.created_at, 'matchCount', r.match_count,
             'status', r.status, 'rowVersion', r.row_version)
           order by r.created_at desc, r.id), '[]'::jsonb)
      from (select * from public.lost_reports
             where school_id = s.id and status = 'open'
             order by created_at desc, id
             limit 200) r));
end $$;

-- open -> closed_by_staff (G-43, §15.4); the content clear is scheduled by terminal_at.
create or replace function public.api_staff_report_close(
  p_assert jsonb, p_school_code text, p_report_id uuid, p_row_version bigint
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  s public.schools := private.school_by_code(p_school_code);
  ctx private.staff_ctx;
  r public.lost_reports;
begin
  ctx := private.assert_staff(p_assert, 'report.close', s.id, p_report_id, p_row_version,
    jsonb_build_object('school_code', p_school_code, 'report_id', p_report_id, 'row_version', p_row_version));
  select * into r from public.lost_reports where id = p_report_id and school_id = s.id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if r.row_version is distinct from p_row_version then
    perform private.fail('state_changed', 'row_version');
  end if;
  if r.status <> 'open' then
    perform private.fail('state_changed', 'status');
  end if;
  update public.lost_reports set status = 'closed_by_staff', terminal_at = now()
   where id = r.id returning * into r;
  perform private.audit(s.id, 'staff', ctx.member_id::text, (p_assert->>'request_id')::uuid, 'report.close',
                        'lost_reports', r.id::text, jsonb_build_object('status', 'open', 'row_version', p_row_version),
                        jsonb_build_object('status', r.status, 'row_version', r.row_version), '{}'::jsonb);
  return jsonb_build_object('reportId', r.id, 'status', r.status, 'rowVersion', r.row_version);
end $$;

-- =====================================================================================================
-- ownership and grants: owner recover_api_owner; EXECUTE only to recover_web (§7.5, F-114)
-- =====================================================================================================

alter function public.api_staff_bind_identity(jsonb, text, text) owner to recover_api_owner;
alter function public.api_staff_resolve_session(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_queue(jsonb, text, text, uuid) owner to recover_api_owner;
alter function public.api_staff_item_get(jsonb, text, uuid) owner to recover_api_owner;
alter function public.api_staff_item_approve(jsonb, text, uuid, bigint, jsonb) owner to recover_api_owner;
alter function public.api_staff_item_reject(jsonb, text, uuid, bigint, text) owner to recover_api_owner;
alter function public.api_staff_bulk_reject(jsonb, text, uuid[], text) owner to recover_api_owner;
alter function public.api_staff_item_receive(jsonb, text, uuid, bigint, uuid) owner to recover_api_owner;
alter function public.api_staff_item_transfer(jsonb, text, uuid, bigint, uuid) owner to recover_api_owner;
alter function public.api_staff_item_claim(jsonb, text, uuid, bigint) owner to recover_api_owner;
alter function public.api_staff_item_dispose(jsonb, text, uuid, bigint, text) owner to recover_api_owner;
alter function public.api_staff_bulk_dispose(jsonb, text, uuid[], text) owner to recover_api_owner;
alter function public.api_staff_item_pull(jsonb, text, uuid, bigint, text) owner to recover_api_owner;
alter function public.api_staff_item_delete(jsonb, text, uuid, bigint, text) owner to recover_api_owner;
alter function public.api_staff_item_edit(jsonb, text, uuid, bigint, jsonb) owner to recover_api_owner;
alter function public.api_staff_item_confirm_publish(jsonb, text, uuid, bigint) owner to recover_api_owner;
alter function public.api_staff_photo_drop(jsonb, text, uuid, uuid, bigint) owner to recover_api_owner;
alter function public.api_staff_create_item(jsonb, text, text, text, text, text, uuid, text, text, uuid, int)
  owner to recover_api_owner;
alter function public.api_staff_complete_item(jsonb, text, uuid, jsonb) owner to recover_api_owner;
alter function public.api_staff_block_device(jsonb, text, uuid, uuid, int, text) owner to recover_api_owner;
alter function public.api_staff_unblock_device(jsonb, text, uuid, uuid) owner to recover_api_owner;
alter function public.api_staff_media_ticket(jsonb, text, text, uuid, uuid) owner to recover_api_owner;
alter function public.api_staff_lost_reports(jsonb, text) owner to recover_api_owner;
alter function public.api_staff_report_close(jsonb, text, uuid, bigint) owner to recover_api_owner;

revoke all on function public.api_staff_bind_identity(jsonb, text, text) from public;
revoke all on function public.api_staff_resolve_session(jsonb, text) from public;
revoke all on function public.api_staff_queue(jsonb, text, text, uuid) from public;
revoke all on function public.api_staff_item_get(jsonb, text, uuid) from public;
revoke all on function public.api_staff_item_approve(jsonb, text, uuid, bigint, jsonb) from public;
revoke all on function public.api_staff_item_reject(jsonb, text, uuid, bigint, text) from public;
revoke all on function public.api_staff_bulk_reject(jsonb, text, uuid[], text) from public;
revoke all on function public.api_staff_item_receive(jsonb, text, uuid, bigint, uuid) from public;
revoke all on function public.api_staff_item_transfer(jsonb, text, uuid, bigint, uuid) from public;
revoke all on function public.api_staff_item_claim(jsonb, text, uuid, bigint) from public;
revoke all on function public.api_staff_item_dispose(jsonb, text, uuid, bigint, text) from public;
revoke all on function public.api_staff_bulk_dispose(jsonb, text, uuid[], text) from public;
revoke all on function public.api_staff_item_pull(jsonb, text, uuid, bigint, text) from public;
revoke all on function public.api_staff_item_delete(jsonb, text, uuid, bigint, text) from public;
revoke all on function public.api_staff_item_edit(jsonb, text, uuid, bigint, jsonb) from public;
revoke all on function public.api_staff_item_confirm_publish(jsonb, text, uuid, bigint) from public;
revoke all on function public.api_staff_photo_drop(jsonb, text, uuid, uuid, bigint) from public;
revoke all on function public.api_staff_create_item(jsonb, text, text, text, text, text, uuid, text, text, uuid, int)
  from public;
revoke all on function public.api_staff_complete_item(jsonb, text, uuid, jsonb) from public;
revoke all on function public.api_staff_block_device(jsonb, text, uuid, uuid, int, text) from public;
revoke all on function public.api_staff_unblock_device(jsonb, text, uuid, uuid) from public;
revoke all on function public.api_staff_media_ticket(jsonb, text, text, uuid, uuid) from public;
revoke all on function public.api_staff_lost_reports(jsonb, text) from public;
revoke all on function public.api_staff_report_close(jsonb, text, uuid, bigint) from public;

grant execute on function public.api_staff_bind_identity(jsonb, text, text) to recover_web;
grant execute on function public.api_staff_resolve_session(jsonb, text) to recover_web;
grant execute on function public.api_staff_queue(jsonb, text, text, uuid) to recover_web;
grant execute on function public.api_staff_item_get(jsonb, text, uuid) to recover_web;
grant execute on function public.api_staff_item_approve(jsonb, text, uuid, bigint, jsonb) to recover_web;
grant execute on function public.api_staff_item_reject(jsonb, text, uuid, bigint, text) to recover_web;
grant execute on function public.api_staff_bulk_reject(jsonb, text, uuid[], text) to recover_web;
grant execute on function public.api_staff_item_receive(jsonb, text, uuid, bigint, uuid) to recover_web;
grant execute on function public.api_staff_item_transfer(jsonb, text, uuid, bigint, uuid) to recover_web;
grant execute on function public.api_staff_item_claim(jsonb, text, uuid, bigint) to recover_web;
grant execute on function public.api_staff_item_dispose(jsonb, text, uuid, bigint, text) to recover_web;
grant execute on function public.api_staff_bulk_dispose(jsonb, text, uuid[], text) to recover_web;
grant execute on function public.api_staff_item_pull(jsonb, text, uuid, bigint, text) to recover_web;
grant execute on function public.api_staff_item_delete(jsonb, text, uuid, bigint, text) to recover_web;
grant execute on function public.api_staff_item_edit(jsonb, text, uuid, bigint, jsonb) to recover_web;
grant execute on function public.api_staff_item_confirm_publish(jsonb, text, uuid, bigint) to recover_web;
grant execute on function public.api_staff_photo_drop(jsonb, text, uuid, uuid, bigint) to recover_web;
grant execute on function public.api_staff_create_item(jsonb, text, text, text, text, text, uuid, text, text, uuid, int)
  to recover_web;
grant execute on function public.api_staff_complete_item(jsonb, text, uuid, jsonb) to recover_web;
grant execute on function public.api_staff_block_device(jsonb, text, uuid, uuid, int, text) to recover_web;
grant execute on function public.api_staff_unblock_device(jsonb, text, uuid, uuid) to recover_web;
grant execute on function public.api_staff_media_ticket(jsonb, text, text, uuid, uuid) to recover_web;
grant execute on function public.api_staff_lost_reports(jsonb, text) to recover_web;
grant execute on function public.api_staff_report_close(jsonb, text, uuid, bigint) to recover_web;
