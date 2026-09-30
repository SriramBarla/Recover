-- 0010 private helpers shared by the api_* and system_* families (BUILD-CONTRACT sections 3-5).
-- Helpers are SECURITY INVOKER: they run with the privileges of the calling SECURITY DEFINER function's
-- owner. The only SECURITY DEFINER helper here is private.verify_staff_mac (owner: recover_attestation_owner).
set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------- errors (section 4) ----------
create function private.fail(p_code text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'RV001', message = p_code, detail = coalesce(p_detail, '');
end $$;

-- ---------- encoding ----------
create function private.b64url_encode(p bytea) returns text
language sql immutable strict set search_path = '' as $$
  select rtrim(translate(replace(encode(p, 'base64'), E'\n', ''), '+/', '-_'), '=')
$$;

create function private.b64url_decode(p text) returns bytea
language sql immutable strict set search_path = '' as $$
  select decode(rpad(translate(p, '-_', '+/'), length(p) + (4 - length(p) % 4) % 4, '='), 'base64')
$$;

create function private.sha256_hex(p text) returns text
language sql immutable strict set search_path = '' as $$
  select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex')
$$;

-- Canonical JSON identical to packages/shared/src/assertion.ts canonicalJson (G-16):
-- keys sorted by UTF-8 bytes, no whitespace, NFC strings escaped like JSON.stringify, integers only.
create function private.canonical_json(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  t text := jsonb_typeof(p);
  r text;
begin
  if p is null or t = 'null' then
    return 'null';
  elsif t = 'object' then
    select '{' || coalesce(string_agg(to_json(normalize(e.k, NFC))::text || ':' || private.canonical_json(e.v), ','
                                      order by convert_to(e.k, 'UTF8')), '') || '}'
      into r from jsonb_each(p) as e(k, v);
    return r;
  elsif t = 'array' then
    select '[' || coalesce(string_agg(private.canonical_json(a.v), ',' order by a.i), '') || ']'
      into r from jsonb_array_elements(p) with ordinality as a(v, i);
    return r;
  elsif t = 'string' then
    return to_json(normalize(p #>> '{}', NFC))::text;
  else
    return p::text; -- number (integers only by contract) or boolean
  end if;
end $$;

-- ---------- roles and operations (section 5) ----------
create function private.role_rank(p public.staff_role) returns int
language sql immutable set search_path = '' as $$
  select case p when 'reviewer' then 1 when 'office' then 2 when 'school_admin' then 3 when 'district_admin' then 4 end
$$;

create function private.op_min_role(p_operation text) returns int
language sql immutable set search_path = '' as $$
  select case
    when p_operation in ('queue.read', 'item.read', 'item.approve', 'item.reject', 'item.bulk_reject', 'item.pull',
                         'item.create', 'item.complete', 'media.read', 'reports.read', 'report.close', 'stats.read') then 1
    when p_operation in ('item.receive', 'item.transfer', 'item.claim', 'item.dispose', 'item.bulk_dispose', 'item.edit',
                         'item.delete', 'item.photo_drop', 'item.confirm_publish', 'device.block', 'device.unblock') then 2
    when p_operation in ('roster.read', 'roster.invite', 'roster.update', 'locations.read', 'locations.write', 'zones.write',
                         'map.read', 'map.create', 'map.upload', 'map.submit', 'config.read', 'config.write',
                         'calendar.write', 'audit.read') then 3
    when p_operation = 'map.activate' or p_operation like 'district.%' then 4
    else 99
  end
$$;

create type private.staff_ctx as (
  member_id    uuid,
  user_id      uuid,
  role         public.staff_role,
  school_id    uuid,
  is_district  boolean
);

-- The only code that touches the assertion key. It never returns the key or the expected MAC (F-104).
-- Accepts only key versions named by the Vault pointers staff_assertion_key_current/_previous (G-17).
create function private.verify_staff_mac(p_canonical text, p_key_version int, p_mac text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_current text;
  v_previous text;
  v_key text;
  v_expected text;
begin
  select btrim(decrypted_secret) into v_current from vault.decrypted_secrets where name = 'staff_assertion_key_current';
  select nullif(btrim(decrypted_secret), '') into v_previous from vault.decrypted_secrets where name = 'staff_assertion_key_previous';
  if p_key_version is null
     or (p_key_version::text is distinct from v_current and p_key_version::text is distinct from v_previous) then
    return false;
  end if;
  select btrim(decrypted_secret) into v_key from vault.decrypted_secrets
   where name = 'staff_assertion_key_v' || p_key_version::text;
  if v_key is null or p_mac is null then
    return false;
  end if;
  v_expected := private.b64url_encode(extensions.hmac(convert_to(p_canonical, 'UTF8'), private.b64url_decode(v_key), 'sha256'));
  -- compare digests of both values so timing does not track the MAC prefix
  return extensions.digest(p_mac, 'sha256') = extensions.digest(v_expected, 'sha256');
end $$;
alter function private.verify_staff_mac(text, int, text) owner to recover_attestation_owner;

create function private.verify_assertion(
  p_assert jsonb, p_operation text, p_scope text, p_target uuid, p_row_version bigint, p_body jsonb
) returns void
language plpgsql set search_path = '' as $$
declare
  v_now bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_iat bigint;
  v_exp bigint;
  v_kv int;
  v_canonical text;
begin
  if p_assert is null or jsonb_typeof(p_assert) <> 'object' or p_assert->>'v' is distinct from 'v1'
     or p_assert->>'operation' is distinct from p_operation
     or p_assert->>'scope' is distinct from p_scope
     or p_assert->>'target_id' is distinct from lower(p_target::text)
     or p_assert->>'row_version' is distinct from p_row_version::text
     or p_assert->>'body_sha256' is distinct from private.sha256_hex(private.canonical_json(p_body))
     or coalesce(p_assert->>'request_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_assert->>'google_sub', '') !~ '^[^\n\r]{1,255}$'
     or coalesce(p_assert->>'idempotency_key_sha256', '0000000000000000000000000000000000000000000000000000000000000000') !~ '^[0-9a-f]{64}$'
     or coalesce(p_assert->>'iat', '') !~ '^[0-9]{1,12}$'
     or coalesce(p_assert->>'exp', '') !~ '^[0-9]{1,12}$'
     or coalesce(p_assert->>'key_version', '') !~ '^[0-9]{1,6}$' then
    perform private.fail('assertion_invalid');
  end if;
  v_iat := (p_assert->>'iat')::bigint;
  v_exp := (p_assert->>'exp')::bigint;
  v_kv := (p_assert->>'key_version')::int;
  -- G-15: bound iat as well as exp so a future-dated assertion cannot outlive its 30-second window.
  if v_exp < v_now or v_exp < v_iat or v_exp - v_iat > 30 or v_iat > v_now + 60 then
    perform private.fail('assertion_invalid');
  end if;
  v_canonical := array_to_string(array[
    'v1',
    p_assert->>'request_id',
    p_assert->>'google_sub',
    p_assert->>'scope',
    p_assert->>'operation',
    coalesce(p_assert->>'target_id', '-'),
    coalesce(p_assert->>'row_version', '-'),
    p_assert->>'body_sha256',
    coalesce(p_assert->>'idempotency_key_sha256', '-'),
    v_kv::text,
    v_iat::text,
    v_exp::text
  ], E'\n');
  if not private.verify_staff_mac(v_canonical, v_kv, p_assert->>'mac') then
    perform private.fail('assertion_invalid');
  end if;
end $$;

-- Membership is resolved from the ATTESTED subject; a district_admin membership covers every school.
create function private.staff_context(p_google_sub text, p_school_id uuid, p_operation text) returns private.staff_ctx
language plpgsql stable set search_path = '' as $$
declare
  v_user uuid;
  v_member uuid;
  v_role public.staff_role;
begin
  select id into v_user from public.staff_users where google_sub = p_google_sub;
  if v_user is null then
    perform private.fail('forbidden');
  end if;
  select m.id, m.role into v_member, v_role
    from public.staff_members m
   where m.user_id = v_user and m.status <> 'deactivated'
     and (m.role = 'district_admin' or (p_school_id is not null and m.school_id = p_school_id))
   order by private.role_rank(m.role) desc
   limit 1;
  if v_member is null or private.role_rank(v_role) < private.op_min_role(p_operation) then
    perform private.fail('forbidden');
  end if;
  return row(v_member, v_user, v_role, p_school_id, v_role = 'district_admin')::private.staff_ctx;
end $$;

create function private.assert_staff(
  p_assert jsonb, p_operation text, p_school_id uuid, p_target uuid, p_row_version bigint, p_body jsonb
) returns private.staff_ctx
language plpgsql set search_path = '' as $$
begin
  perform private.verify_assertion(p_assert, p_operation,
    case when p_school_id is null then 'district' else 'school:' || p_school_id::text end,
    p_target, p_row_version, p_body);
  return private.staff_context(p_assert->>'google_sub', p_school_id, p_operation);
end $$;

-- ---------- tenancy and settings ----------
create function private.school_by_code(p_code text) returns public.schools
language plpgsql stable set search_path = '' as $$
declare
  s public.schools;
begin
  select * into s from public.schools where code = upper(btrim(coalesce(p_code, ''))) and active;
  if not found then
    perform private.fail('not_found');
  end if;
  return s;
end $$;

create function private.district() returns public.district_settings
language sql stable set search_path = '' as $$
  select * from public.district_settings where id = 1
$$;

-- Effective availability = district global switch AND school switch; global OFF always wins (§5.5).
create function private.feature_on(p_school public.schools, p_feature text) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  d public.district_settings := private.district();
begin
  return case p_feature
    when 'student_posting' then coalesce(d.student_posting_global_enabled, false) and p_school.student_posting_enabled
    when 'lost_reports' then coalesce(d.lost_reports_global_enabled, false) and p_school.lost_reports_enabled
    when 'cross_school_search' then coalesce(d.cross_school_search_global_enabled, false) and p_school.cross_school_search_enabled
    else false
  end;
end $$;

-- ---------- outbox and audit ----------
create function private.enqueue(
  p_kind text, p_payload jsonb, p_school_id uuid, p_dedupe text,
  p_run_after timestamptz default now(), p_priority smallint default 100, p_max_attempts int default 5
) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_id bigint;
begin
  insert into public.jobs (kind, payload, school_id, dedupe_key, run_after, priority, max_attempts)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), p_school_id, p_dedupe, coalesce(p_run_after, now()), p_priority, p_max_attempts)
  on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing
  returning id into v_id;
  return v_id;
end $$;

-- F-74: audit payloads never carry free text, pins, digests, storage paths, emails, bodies or credentials.
create function private.audit_guard(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  v jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return;
  end if;
  for k, v in select e.key, e.value from jsonb_each(p) as e loop
    if lower(k) in ('description', 'note', 'location_note_private', 'pin', 'pin_x', 'pin_y', 'device_token_hash',
                    'digest', 'email', 'google_sub', 'storage_path', 'incoming_path', 'original_path', 'review_path',
                    'thumb_path', 'medium_path', 'path', 'body', 'token', 'mac', 'query', 'redacted_query', 'ip',
                    'display_name') then
      raise exception 'audit payload key % is forbidden (F-74)', k;
    end if;
    if jsonb_typeof(v) = 'object' then
      perform private.audit_guard(v);
    end if;
  end loop;
end $$;

create function private.audit(
  p_school_id uuid, p_actor_kind text, p_actor_id text, p_request_id uuid, p_action text,
  p_target_table text, p_target_id text,
  p_before jsonb default '{}'::jsonb, p_after jsonb default '{}'::jsonb, p_metadata jsonb default '{}'::jsonb
) returns void
language plpgsql set search_path = '' as $$
begin
  perform private.audit_guard(p_before);
  perform private.audit_guard(p_after);
  perform private.audit_guard(p_metadata);
  insert into public.audit_log (school_id, actor_kind, actor_id, request_id, action, target_table, target_id,
                                state_before, state_after, metadata)
  values (p_school_id, p_actor_kind, p_actor_id, p_request_id, p_action, p_target_table, p_target_id,
          coalesce(p_before, '{}'::jsonb), coalesce(p_after, '{}'::jsonb), coalesce(p_metadata, '{}'::jsonb));
end $$;

-- Cache invalidation intent committed with the business state (§7.6).
create function private.invalidate(p_school_id uuid, p_item_id uuid default null) returns void
language plpgsql set search_path = '' as $$
declare
  v_tags jsonb := case when p_item_id is null
                       then jsonb_build_array('school:' || p_school_id::text)
                       else jsonb_build_array('school:' || p_school_id::text, 'item:' || p_item_id::text) end;
begin
  perform private.enqueue('invalidate_cache', jsonb_build_object('tags', v_tags), p_school_id,
    'invalidate_cache:' || coalesce(p_item_id::text, p_school_id::text) || ':' || txid_current()::text,
    now(), 50::smallint);
end $$;

-- ---------- ids, deadlines, zones ----------
-- §7.4: per-location sequence; the location row lock is the serialization point; tenant asserted.
create function private.next_public_id(p_school_id uuid, p_location_id uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_seq bigint;
  v_loc text;
  v_school text;
begin
  update public.locations set item_seq = item_seq + 1
   where id = p_location_id and school_id = p_school_id
   returning item_seq, code into v_seq, v_loc;
  if v_seq is null then
    perform private.fail('tenant_mismatch');
  end if;
  select code into v_school from public.schools where id = p_school_id;
  return v_school || '-' || v_loc || '-' || lpad(v_seq::text, 6, '0');
end $$;

-- G-01: the close of the n-th open school day strictly after the local date of p_from.
-- NULL when the calendar does not cover it (expiry then fails safe and the horizon monitor warns).
create function private.calendar_next_close(p_school_id uuid, p_from timestamptz, p_n int) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_tz text;
  v_local date;
  v_day date;
  v_close time;
begin
  select timezone into v_tz from public.schools where id = p_school_id;
  if v_tz is null then
    return null;
  end if;
  v_local := (p_from at time zone v_tz)::date;
  select d.day, d.close_at into v_day, v_close
    from public.school_calendar_days d
   where d.school_id = p_school_id and d.day > v_local and d.is_open
   order by d.day
   offset greatest(coalesce(p_n, 1), 1) - 1
   limit 1;
  if v_day is null then
    return null;
  end if;
  return (v_day + v_close) at time zone v_tz;
end $$;

-- Nearest active zone whose aspect-scaled distance is within its radius (05 map_zones comment).
create function private.resolve_zone(p_map_version_id uuid, p_x double precision, p_y double precision) returns uuid
language sql stable set search_path = '' as $$
  select z.id
    from public.map_zones z
    join public.map_versions v on v.id = z.map_version_id
   where z.map_version_id = p_map_version_id and z.active and p_x is not null and p_y is not null
     and v.width_px is not null and v.height_px is not null
     and sqrt(power((p_x - z.cx) * v.width_px, 2) + power((p_y - z.cy) * v.height_px, 2))
         / greatest(v.width_px, v.height_px) <= z.radius
   order by sqrt(power((p_x - z.cx) * v.width_px, 2) + power((p_y - z.cy) * v.height_px, 2))
   limit 1
$$;

-- ---------- media deletion (§9.6, F-75) ----------
-- Ledger rows are derived from the exact photo generations inside the business transaction;
-- every path must carry the item's own school/item prefix or the transaction fails.
create function private.create_deletion_ledger(
  p_item_id uuid, p_school_id uuid, p_reason text,
  p_photo_ids uuid[] default null, p_run_after timestamptz default now()
) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_ledger bigint;
  v_n int;
  v_bad int;
  v_prefix text := p_school_id::text || '/' || p_item_id::text || '/';
begin
  select count(*) into v_bad
    from public.item_photos p
    cross join lateral (values (p.incoming_path), (p.original_path), (p.review_path), (p.thumb_path), (p.medium_path)) as o(path)
   where p.item_id = p_item_id and p.school_id = p_school_id and o.path is not null
     and (p_photo_ids is null or p.id = any (p_photo_ids))
     and left(o.path, length(v_prefix)) <> v_prefix;
  if v_bad > 0 then
    raise exception 'deletion ledger prefix violation (F-75)';
  end if;

  insert into public.media_deletion_ledger (school_id, item_id, reason)
  values (p_school_id, p_item_id, p_reason)
  returning id into v_ledger;

  insert into public.media_deletion_objects (ledger_id, school_id, item_id, item_photo_id, storage_path, object_kind)
  select v_ledger, p.school_id, p.item_id, p.id, o.path, o.kind
    from public.item_photos p
    cross join lateral (values ('incoming', p.incoming_path), ('original', p.original_path), ('review', p.review_path),
                               ('thumb', p.thumb_path), ('medium', p.medium_path)) as o(kind, path)
   where p.item_id = p_item_id and p.school_id = p_school_id and o.path is not null and p.status <> 'deleted'
     and (p_photo_ids is null or p.id = any (p_photo_ids));
  get diagnostics v_n = row_count;
  if v_n = 0 then
    delete from public.media_deletion_ledger where id = v_ledger;
    return null;
  end if;
  perform private.enqueue('delete_media', jsonb_build_object('ledgerId', v_ledger), p_school_id,
    'delete_media:' || v_ledger::text, p_run_after, 100::smallint);
  return v_ledger;
end $$;

-- G-01 late arrival: cancel the NEVER-ARRIVED deletion that has not started; returns false if any of its
-- objects is already gone. Deletions for any other reason (claimed, pulled, photo drop, severe content,
-- rejected retention) are never cancelled here.
create function private.cancel_pending_deletion(p_item_id uuid) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_started boolean;
begin
  select exists (
           select 1 from public.media_deletion_objects o
             join public.media_deletion_ledger l on l.id = o.ledger_id
            where l.item_id = p_item_id and l.reason = 'never_arrived' and l.verified_at is null and o.deleted_at is not null)
      or exists (
           select 1 from public.jobs j
            where j.kind = 'delete_media' and j.status = 'running'
              and (j.payload->>'ledgerId')::bigint in
                  (select id from public.media_deletion_ledger
                    where item_id = p_item_id and reason = 'never_arrived' and verified_at is null))
    into v_started;
  if v_started then
    return false;
  end if;
  update public.jobs set status = 'done', finished_at = now(), last_error_code = 'cancelled'
   where kind = 'delete_media' and status = 'queued'
     and (payload->>'ledgerId')::bigint in
         (select id from public.media_deletion_ledger
           where item_id = p_item_id and reason = 'never_arrived' and verified_at is null);
  delete from public.media_deletion_ledger
   where item_id = p_item_id and reason = 'never_arrived' and verified_at is null;
  return true;
end $$;

-- ---------- device reputation (G-12, G-34) ----------
create function private.device_rejections_30d(p_school_id uuid, p_digest bytea) returns int
language sql stable set search_path = '' as $$
  select count(*)::int from public.device_rejections
   where school_id = p_school_id and device_token_hash = p_digest and rejected_at > now() - interval '30 days'
$$;

create function private.maybe_auto_block(p_school_id uuid, p_digest bytea) returns boolean
language plpgsql set search_path = '' as $$
begin
  if p_digest is null or private.device_rejections_30d(p_school_id, p_digest) < 5 then
    return false;
  end if;
  insert into public.devices (school_id, token_hash, blocked_until, block_reason)
  values (p_school_id, p_digest, now() + interval '30 days', 'auto_rejections')
  on conflict (school_id, token_hash) do update
    set blocked_until = greatest(coalesce(public.devices.blocked_until, now()), now() + interval '30 days'),
        block_reason = 'auto_rejections';
  return true;
end $$;

-- ---------- staff post publication (G-08) ----------
-- hidden -> generating once every current photo is canonical and screening has finished (or is off),
-- unless screening placed a hold/quarantine. Called by canonicalization/screening and by confirm-publish.
create function private.staff_publish_ready(p_item_id uuid, p_force boolean default false) returns boolean
language plpgsql set search_path = '' as $$
declare
  i public.items;
  v_cur int;
  v_bad int;
  v_screening boolean := coalesce((private.district()).screening_enabled, false);
begin
  select * into i from public.items where id = p_item_id for update;
  if not found or i.posted_by_kind = 'student' or i.review_status <> 'approved' or i.publication_status <> 'hidden'
     or i.deleted_at is not null or i.custody not in ('with_finder', 'at_location') then
    return false;
  end if;
  -- Quarantine (severe content, G-24) always blocks; p_force (staff confirm-publish) releases only a hold.
  if coalesce((i.screening_flags->>'quarantine')::boolean, false) then
    return false;
  end if;
  if not p_force and coalesce((i.screening_flags->>'hold')::boolean, false) then
    return false;
  end if;
  if not p_force and v_screening and i.screening_status = 'unscreened' then
    return false;
  end if;
  select count(*), count(*) filter (where status not in ('canonical_ready', 'public_ready'))
    into v_cur, v_bad
    from public.item_photos where item_id = p_item_id and is_current;
  if v_cur = 0 or v_bad > 0 then
    return false;
  end if;
  update public.items set publication_status = 'generating' where id = p_item_id;
  perform private.enqueue('make_variants', jsonb_build_object('itemId', p_item_id), i.school_id,
    'make_variants:' || p_item_id::text, now(), 50::smallint);
  return true;
end $$;
