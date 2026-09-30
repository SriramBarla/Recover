-- supabase/tests/api_staff.sql: staff api family part 1 (0300_api_staff.sql). Plain SQL that RAISEs on the
-- first failure. Everything runs in one transaction and is rolled back, so seed rows are never changed.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/api_staff.sql
--
-- Calls run as recover_web (the only role with EXECUTE). Assertions are minted by pg_temp.mint, which
-- builds the same canonical body and twelve-line MAC input as packages/shared/src/assertion.ts, with the
-- test key (32 bytes of 0x42) placed in Vault inside this transaction. The pg_temp wrappers build each
-- call's body from their own arguments exactly as apps/web/lib/ops.ts does (args keyed without p_).
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '20s';

-- ---------- keys, identities, role (all rolled back) ----------
grant recover_web to postgres; -- lets this migration-role session SET ROLE recover_web; rolled back
delete from vault.secrets
 where name in ('staff_assertion_key_v1', 'staff_assertion_key_current', 'staff_assertion_key_previous');
select vault.create_secret(private.b64url_encode(decode(repeat('42', 32), 'hex')), 'staff_assertion_key_v1');
select vault.create_secret('1', 'staff_assertion_key_current');
select vault.create_secret('', 'staff_assertion_key_previous');

update public.staff_users set google_sub = 'sapi-district'      where id = '00000000-5a00-4000-8000-000000000001';
update public.staff_users set google_sub = 'sapi-fchs-admin'    where id = '00000000-5a00-4000-8000-000000000002';
update public.staff_users set google_sub = 'sapi-fchs-office'   where id = '00000000-5a00-4000-8000-000000000003';
update public.staff_users set google_sub = 'sapi-fchs-reviewer' where id = '00000000-5a00-4000-8000-000000000004';
update public.staff_users set google_sub = 'sapi-multi'         where id = '00000000-5a00-4000-8000-000000000005';
update public.staff_users set google_sub = 'sapi-sfhs-admin'    where id = '00000000-5a00-4000-8000-000000000006';
update public.staff_users set google_sub = null                 where id = '00000000-5a00-4000-8000-000000000007';

-- ---------- assertion minting (mirror of assertion.ts mint) ----------
create function pg_temp.mint(p_sub text, p_scope text, p_op text, p_target uuid, p_rv bigint, p_body jsonb,
                             p_skew int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint + p_skew;
  v_exp bigint := v_iat + 30;
  v_req text := gen_random_uuid()::text;
  v_sha text := private.sha256_hex(private.canonical_json(p_body));
  v_canon text;
begin
  v_canon := array_to_string(array['v1', v_req, p_sub, p_scope, p_op, coalesce(lower(p_target::text), '-'),
                                   coalesce(p_rv::text, '-'), v_sha, '-', '1', v_iat::text, v_exp::text], E'\n');
  return jsonb_build_object(
    'v', 'v1', 'request_id', v_req, 'google_sub', p_sub, 'scope', p_scope, 'operation', p_op,
    'target_id', lower(p_target::text), 'row_version', p_rv, 'body_sha256', v_sha, 'idempotency_key_sha256', null,
    'key_version', 1, 'iat', v_iat, 'exp', v_exp,
    'mac', private.b64url_encode(extensions.hmac(convert_to(v_canon, 'UTF8'), decode(repeat('42', 32), 'hex'), 'sha256')));
end $$;

create function pg_temp.sc(p_code text) returns text language sql security definer set search_path = '' as $$
  select case when p_code is null then 'district'
              else 'school:' || (select s.id::text from public.schools s where s.code = p_code) end
$$;

create function pg_temp.a(p_sub text, p_code text, p_op text, p_target uuid, p_rv bigint, p_body jsonb)
returns jsonb language sql as $$ select pg_temp.mint(p_sub, pg_temp.sc(p_code), p_op, p_target, p_rv, p_body) $$;

-- ---------- call wrappers: the web's catalog (operation, scope, target, body) in SQL ----------
create function pg_temp.bind(p_sub text, p_email text, p_attested text default null) returns jsonb language sql as $$
  select public.api_staff_bind_identity(pg_temp.mint(coalesce(p_attested, p_sub), 'district', 'identity.bind', null, null,
    jsonb_build_object('google_sub', p_sub, 'email', p_email)), p_sub, p_email) $$;
create function pg_temp.session(p_sub text, p_attested text default null) returns jsonb language sql as $$
  select public.api_staff_resolve_session(pg_temp.mint(coalesce(p_attested, p_sub), 'district', 'session.resolve',
    null, null, jsonb_build_object('google_sub', p_sub)), p_sub) $$;
create function pg_temp.queue(p_sub text, p_code text, p_cc text default null, p_cid uuid default null) returns jsonb
language sql as $$
  select public.api_staff_queue(pg_temp.a(p_sub, p_code, 'queue.read', null, null,
    jsonb_build_object('school_code', p_code, 'cursor_created', p_cc, 'cursor_id', p_cid)), p_code, p_cc, p_cid) $$;
create function pg_temp.custody(p_sub text, p_code text, p_loc uuid) returns jsonb language sql as $$
  select public.api_staff_custody_list(pg_temp.a(p_sub, p_code, 'item.read', null, null,
    jsonb_build_object('school_code', p_code, 'location_id', p_loc)), p_code, p_loc) $$;
create function pg_temp.get(p_sub text, p_code text, p_item uuid) returns jsonb language sql as $$
  select public.api_staff_item_get(pg_temp.a(p_sub, p_code, 'item.read', p_item, null,
    jsonb_build_object('school_code', p_code, 'item_id', p_item)), p_code, p_item) $$;
create function pg_temp.approve(p_sub text, p_code text, p_item uuid, p_rv bigint, p_edits jsonb default null)
returns jsonb language sql as $$
  select public.api_staff_item_approve(pg_temp.a(p_sub, p_code, 'item.approve', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'edits', p_edits)),
    p_code, p_item, p_rv, p_edits) $$;
create function pg_temp.reject(p_sub text, p_code text, p_item uuid, p_rv bigint, p_reason text) returns jsonb
language sql as $$
  select public.api_staff_item_reject(pg_temp.a(p_sub, p_code, 'item.reject', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'reason', p_reason)),
    p_code, p_item, p_rv, p_reason) $$;
create function pg_temp.bulk_reject(p_sub text, p_code text, p_ids uuid[], p_reason text) returns jsonb
language sql as $$
  select public.api_staff_bulk_reject(pg_temp.a(p_sub, p_code, 'item.bulk_reject', null, null,
    jsonb_build_object('school_code', p_code, 'item_ids', p_ids, 'reason', p_reason)), p_code, p_ids, p_reason) $$;
create function pg_temp.receive(p_sub text, p_code text, p_item uuid, p_rv bigint, p_loc uuid) returns jsonb
language sql as $$
  select public.api_staff_item_receive(pg_temp.a(p_sub, p_code, 'item.receive', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'location_id', p_loc)),
    p_code, p_item, p_rv, p_loc) $$;
create function pg_temp.transfer(p_sub text, p_code text, p_item uuid, p_rv bigint, p_loc uuid) returns jsonb
language sql as $$
  select public.api_staff_item_transfer(pg_temp.a(p_sub, p_code, 'item.transfer', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'location_id', p_loc)),
    p_code, p_item, p_rv, p_loc) $$;
create function pg_temp.claim(p_sub text, p_code text, p_item uuid, p_rv bigint) returns jsonb language sql as $$
  select public.api_staff_item_claim(pg_temp.a(p_sub, p_code, 'item.claim', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv)), p_code, p_item, p_rv) $$;
create function pg_temp.dispose(p_sub text, p_code text, p_item uuid, p_rv bigint, p_disp text) returns jsonb
language sql as $$
  select public.api_staff_item_dispose(pg_temp.a(p_sub, p_code, 'item.dispose', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'disposition', p_disp)),
    p_code, p_item, p_rv, p_disp) $$;
create function pg_temp.bulk_dispose(p_sub text, p_code text, p_ids uuid[], p_disp text) returns jsonb
language sql as $$
  select public.api_staff_bulk_dispose(pg_temp.a(p_sub, p_code, 'item.bulk_dispose', null, null,
    jsonb_build_object('school_code', p_code, 'item_ids', p_ids, 'disposition', p_disp)), p_code, p_ids, p_disp) $$;
create function pg_temp.pull(p_sub text, p_code text, p_item uuid, p_rv bigint, p_reason text) returns jsonb
language sql as $$
  select public.api_staff_item_pull(pg_temp.a(p_sub, p_code, 'item.pull', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'reason', p_reason)),
    p_code, p_item, p_rv, p_reason) $$;
create function pg_temp.del(p_sub text, p_code text, p_item uuid, p_rv bigint, p_reason text) returns jsonb
language sql as $$
  select public.api_staff_item_delete(pg_temp.a(p_sub, p_code, 'item.delete', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'reason', p_reason)),
    p_code, p_item, p_rv, p_reason) $$;
create function pg_temp.edit(p_sub text, p_code text, p_item uuid, p_rv bigint, p_edits jsonb) returns jsonb
language sql as $$
  select public.api_staff_item_edit(pg_temp.a(p_sub, p_code, 'item.edit', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv, 'edits', p_edits)),
    p_code, p_item, p_rv, p_edits) $$;
create function pg_temp.confirm(p_sub text, p_code text, p_item uuid, p_rv bigint) returns jsonb language sql as $$
  select public.api_staff_item_confirm_publish(pg_temp.a(p_sub, p_code, 'item.confirm_publish', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'row_version', p_rv)), p_code, p_item, p_rv) $$;
create function pg_temp.drop_photo(p_sub text, p_code text, p_item uuid, p_photo uuid, p_rv bigint) returns jsonb
language sql as $$
  select public.api_staff_photo_drop(pg_temp.a(p_sub, p_code, 'item.photo_drop', p_item, p_rv,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'photo_id', p_photo, 'row_version', p_rv)),
    p_code, p_item, p_photo, p_rv) $$;
create function pg_temp.create_item(p_sub text, p_code text, p_mode text, p_cat text, p_desc text, p_note text,
                                    p_map uuid, p_x text, p_y text, p_loc uuid, p_n int) returns jsonb
language sql as $$
  select public.api_staff_create_item(pg_temp.a(p_sub, p_code, 'item.create', null, null,
    jsonb_build_object('school_code', p_code, 'mode', p_mode, 'category', p_cat, 'description', p_desc, 'note', p_note,
                       'map_version_id', p_map, 'pin_x', p_x, 'pin_y', p_y, 'location_id', p_loc, 'photo_count', p_n)),
    p_code, p_mode, p_cat, p_desc, p_note, p_map, p_x, p_y, p_loc, p_n) $$;
create function pg_temp.complete(p_sub text, p_code text, p_item uuid, p_objects jsonb) returns jsonb
language sql as $$
  select public.api_staff_complete_item(pg_temp.a(p_sub, p_code, 'item.complete', p_item, null,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'objects', p_objects)), p_code, p_item, p_objects) $$;
create function pg_temp.block(p_sub text, p_code text, p_item uuid, p_report uuid, p_days int, p_reason text)
returns jsonb language sql as $$
  select public.api_staff_block_device(pg_temp.a(p_sub, p_code, 'device.block', coalesce(p_item, p_report), null,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'report_id', p_report, 'days', p_days,
                       'reason', p_reason)), p_code, p_item, p_report, p_days, p_reason) $$;
create function pg_temp.unblock(p_sub text, p_code text, p_item uuid, p_report uuid) returns jsonb language sql as $$
  select public.api_staff_unblock_device(pg_temp.a(p_sub, p_code, 'device.unblock', coalesce(p_item, p_report), null,
    jsonb_build_object('school_code', p_code, 'item_id', p_item, 'report_id', p_report)), p_code, p_item, p_report) $$;
create function pg_temp.ticket(p_sub text, p_code text, p_op text, p_photo uuid, p_map uuid) returns jsonb
language sql as $$
  select public.api_staff_media_ticket(
    pg_temp.mint(p_sub, case when p_op = 'map.activate' then 'district' else pg_temp.sc(p_code) end, p_op,
                 coalesce(p_photo, p_map), null,
                 jsonb_build_object('school_code', p_code, 'operation', p_op, 'photo_id', p_photo,
                                    'map_version_id', p_map)),
    p_code, p_op, p_photo, p_map) $$;
create function pg_temp.reports(p_sub text, p_code text) returns jsonb language sql as $$
  select public.api_staff_lost_reports(pg_temp.a(p_sub, p_code, 'reports.read', null, null,
    jsonb_build_object('school_code', p_code)), p_code) $$;
create function pg_temp.report_close(p_sub text, p_code text, p_report uuid, p_rv bigint) returns jsonb
language sql as $$
  select public.api_staff_report_close(pg_temp.a(p_sub, p_code, 'report.close', p_report, p_rv,
    jsonb_build_object('school_code', p_code, 'report_id', p_report, 'row_version', p_rv)), p_code, p_report, p_rv) $$;

-- ---------- checks ----------
create function pg_temp.ok(p boolean, p_msg text) returns void language plpgsql as $$
begin
  if p is not true then
    raise exception 'TEST FAILED: %', p_msg;
  end if;
end $$;

create function pg_temp.eq(p_got text, p_want text, p_msg text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'TEST FAILED: % (got %, want %)', p_msg, coalesce(p_got, 'NULL'), coalesce(p_want, 'NULL');
  end if;
end $$;

-- Runs p_sql as the current role; returns 'ok', the RV001 code (with '/detail' when present), or the SQLSTATE.
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare
  v_msg text;
  v_detail text;
  v_state text;
begin
  execute p_sql;
  return 'ok';
exception
  when sqlstate 'RV001' then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    return v_msg || case when coalesce(v_detail, '') <> '' then '/' || v_detail else '' end;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    return 'sqlstate ' || v_state || ': ' || v_msg;
end $$;

-- ---------- fixtures and inspection (run as the migration role) ----------
create function pg_temp.n(p_sql text) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v bigint;
begin
  execute p_sql into v;
  return v;
end $$;

create function pg_temp.q(p_sql text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  execute p_sql into v;
  return v;
end $$;

create function pg_temp.item(p uuid) returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(i) - 'search_tsv' from public.items i where i.id = p
$$;

create function pg_temp.rv(p uuid) returns bigint language sql security definer set search_path = '' as $$
  select i.row_version from public.items i where i.id = p
$$;

create function pg_temp.loc(p_code text, p_loc text) returns uuid language sql security definer set search_path = '' as $$
  select l.id from public.locations l join public.schools s on s.id = l.school_id where s.code = p_code and l.code = p_loc
$$;

create function pg_temp.map(p_code text) returns uuid language sql security definer set search_path = '' as $$
  select v.id from public.map_versions v join public.schools s on s.id = v.school_id where s.code = p_code and v.active
$$;

create function pg_temp.zone(p_code text, p_name text) returns uuid language sql security definer set search_path = '' as $$
  select z.id from public.map_zones z where z.map_version_id = pg_temp.map(p_code) and z.name = p_name
$$;

create function pg_temp.photos(p_item uuid) returns uuid[] language sql security definer set search_path = '' as $$
  select array_agg(p.id order by p.position, p.generation) from public.item_photos p where p.item_id = p_item
$$;

create function pg_temp.exec(p_sql text) returns void language plpgsql security definer set search_path = '' as $$
begin
  execute p_sql;
end $$;

-- One item in an explicit, CHECK-consistent state. p_photos lists one status per current photo.
create function pg_temp.mk_item(
  p_code text, p_loc text, p_review text, p_pub text, p_custody text,
  p_photos text[] default '{canonical_ready}', p_device boolean default true, p_kind text default 'student'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_loc uuid := pg_temp.loc(p_code, p_loc);
  v_member uuid;
  v_id uuid := gen_random_uuid();
  v_pid uuid;
  v_tok bytea;
  v_status text;
  v_prefix text;
  v_terminal boolean := p_custody in ('claimed', 'expired_donated', 'expired_disposed', 'expired_never_arrived');
  v_received boolean := p_custody in ('at_location', 'claimed', 'expired_donated', 'expired_disposed');
  n int := 0;
begin
  select * into s from public.schools where code = p_code;
  select m.id into v_member from public.staff_members m where m.school_id = s.id order by m.id limit 1;
  insert into public.items (
    id, school_id, public_id, category, description, location_note_private, map_version_id, pin_x, pin_y,
    dropoff_location_id, current_location_id, photo_count, review_status, publication_status, custody,
    posted_by_kind, posted_by_staff_id, device_token_hash, device_link_cleared_at, received_at, claimed_at,
    expires_at, disposed_at, terminal_at, withdrawn_at, reviewed_by, reviewed_at, reject_reason,
    arrival_deadline_at, screening_status)
  values (
    v_id, s.id, case when p_review <> 'draft' then 'T-' || replace(v_id::text, '-', '') end, 'bottle',
    'blue metal water bottle', 'near C214', pg_temp.map(p_code), 0.45, 0.70,
    v_loc, case when v_received then v_loc end, cardinality(p_photos),
    p_review::public.review_status, p_pub::public.publication_status, p_custody::public.custody_status,
    p_kind, case when p_kind <> 'student' then v_member end,
    case when p_kind = 'student' and p_device then '\x01'::bytea || extensions.gen_random_bytes(32) end,
    case when p_kind = 'student' and not p_device then now() end,
    case when v_received then now() - interval '1 day' end,
    case when p_custody = 'claimed' then now() end,
    case when v_received then now() + interval '29 days' end,
    case when p_custody in ('expired_donated', 'expired_disposed') then now() end,
    case when v_terminal then now() end,
    case when p_pub = 'withdrawn' then now() end,
    case when p_review in ('approved', 'rejected') then v_member end,
    case when p_review in ('approved', 'rejected') then now() end,
    case when p_review = 'rejected' then 'spam' end,
    now() + interval '1 day', 'clean');
  foreach v_status in array p_photos loop
    v_pid := gen_random_uuid();
    v_tok := extensions.gen_random_bytes(16);
    v_prefix := s.id::text || '/' || v_id::text || '/' || v_pid::text || '/';
    insert into public.item_photos (id, school_id, item_id, position, generation, is_current, incoming_path,
                                    original_path, review_path, thumb_path, medium_path, public_object_token,
                                    width, height, bytes, status, failure_code)
    values (v_pid, s.id, v_id, n, 1, true,
            case when v_status in ('uploaded', 'canonicalizing', 'failed') then v_prefix || 'raw' end,
            case when v_status in ('canonical_ready', 'public_ready') then v_prefix || 'canonical.jpg' end,
            case when v_status in ('canonical_ready', 'public_ready') then v_prefix || 'review.jpg' end,
            case when v_status = 'public_ready' then v_prefix || encode(v_tok, 'hex') || '/thumb.jpg' end,
            case when v_status = 'public_ready' then v_prefix || encode(v_tok, 'hex') || '/medium.jpg' end,
            case when v_status = 'public_ready' then v_tok end,
            case when v_status in ('canonical_ready', 'public_ready') then 1600 end,
            case when v_status in ('canonical_ready', 'public_ready') then 1200 end,
            case when v_status in ('canonical_ready', 'public_ready') then 200000 end,
            v_status, case when v_status = 'failed' then 'decode_failed' end);
    n := n + 1;
  end loop;
  return v_id;
end $$;

create function pg_temp.mk_report(p_code text) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v uuid;
begin
  insert into public.lost_reports (school_id, category, description, map_version_id, pin_x, pin_y, device_token_hash,
                                   expires_at)
  select s.id, 'bottle', 'lost my blue bottle near the gym', pg_temp.map(p_code), 0.30, 0.40,
         '\x01'::bytea || extensions.gen_random_bytes(32), now() + interval '60 days'
    from public.schools s where s.code = p_code
  returning id into v;
  return v;
end $$;

-- A map version with canonical dimensions; zones are added while it is still a draft (G-07 freeze).
create function pg_temp.mk_map(p_code text, p_status text, p_zone boolean, p_pins boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v uuid := gen_random_uuid();
begin
  select * into s from public.schools where code = p_code;
  insert into public.map_versions (id, school_id, draft_storage_path, draft_canonical_path, width_px, height_px)
  values (v, s.id, s.id::text || '/' || v::text || '/draft', s.id::text || '/' || v::text || '/canonical.jpg', 2400, 1500);
  if p_zone then
    insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius) values (s.id, v, 'Front Lawn', 0.5, 0.5, 0.2);
  end if;
  if p_pins then
    insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y)
    select s.id, l.id, v, 0.25, 0.25 from public.locations l where l.school_id = s.id and l.active;
  end if;
  update public.map_versions set approval_status = p_status,
         submitted_at = case when p_status <> 'draft' then now() end
   where id = v;
  return v;
end $$;

create function pg_temp.publish_ready(p uuid) returns boolean language sql security definer set search_path = '' as $$
  select private.staff_publish_ready(p, false)
$$;

-- Everything below runs as the web login.
set local role recover_web;

-- =====================================================================================================
-- 1. identity: bind and resolve (G-05, §14.1, F-45)
-- =====================================================================================================
do $$
declare
  r jsonb;
begin
  r := pg_temp.bind('sapi-nfms-new', 'admin.nfms@recover.test');
  perform pg_temp.eq(r->>'status', 'bound', 'bind: an unbound invitation binds to the new sub');
  r := pg_temp.bind('sapi-nfms-new', 'admin.nfms@recover.test');
  perform pg_temp.eq(r->>'status', 'already_bound', 'bind: lookup by sub first');
  r := pg_temp.bind('sapi-nfms-other', 'admin.nfms@recover.test');
  perform pg_temp.eq(r->>'status', 'denied', 'bind: email already bound to another sub');
  r := pg_temp.bind('sapi-nobody', 'nobody@recover.test');
  perform pg_temp.eq(r->>'status', 'no_invite', 'bind: no staff row for the email');
  perform pg_temp.eq(pg_temp.err($q$select pg_temp.bind('sapi-victim', 'office.fchs@recover.test', 'sapi-attacker')$q$),
                     'assertion_invalid', 'bind: the attested sub must be the sub being bound');
  perform pg_temp.eq(pg_temp.err($q$select public.api_staff_bind_identity(null, 'sapi-x', 'x@recover.test')$q$),
                     'assertion_invalid', 'bind: no assertion, no bind');
  perform pg_temp.ok(pg_temp.n($q$select count(*) from public.staff_users
                                  where google_sub = 'sapi-nfms-new' and last_login_at is not null$q$) = 1,
                     'bind: last_login_at set');
  perform pg_temp.ok(pg_temp.n($q$select count(*) from public.audit_log where action = 'identity.bind'
                                  and state_after->>'status' in ('bound', 'already_bound', 'denied')
                                  and not (state_after ? 'email') and not (metadata ? 'email')$q$) >= 3,
                     'bind: audited without the email');

  r := pg_temp.session('sapi-nfms-new');
  perform pg_temp.eq(r#>>'{user,email}', 'admin.nfms@recover.test', 'resolve: user');
  perform pg_temp.eq(r#>>'{memberships,0,schoolCode}', 'NFMS', 'resolve: membership school code');
  perform pg_temp.eq(r#>>'{memberships,0,schoolName}', 'North Forsyth Middle School', 'resolve: school name');
  perform pg_temp.eq(r#>>'{memberships,0,role}', 'school_admin', 'resolve: role');
  perform pg_temp.eq(r#>>'{memberships,0,status}', 'active', 'resolve: invited membership activated');
  r := pg_temp.session('sapi-multi');
  perform pg_temp.eq(jsonb_array_length(r->'memberships')::text, '2', 'resolve: multi-school user sees both schools');
  r := pg_temp.session('sapi-district');
  perform pg_temp.ok(r#>>'{memberships,0,schoolId}' is null and r#>>'{memberships,0,role}' = 'district_admin',
                     'resolve: district membership has no school');
  perform pg_temp.eq(pg_temp.err($q$select pg_temp.session('sapi-nobody')$q$), 'forbidden', 'resolve: unknown sub');
  perform pg_temp.eq(pg_temp.err($q$select pg_temp.session('sapi-fchs-admin', 'sapi-fchs-office')$q$),
                     'assertion_invalid', 'resolve: attested sub must match');
end $$;

-- =====================================================================================================
-- 2. assertion binding: tampered body, wrong operation/target/scope/row_version, stale assertion
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  rv bigint := pg_temp.rv(v);
  a jsonb;
begin
  a := pg_temp.a('sapi-fchs-reviewer', 'FCHS', 'item.approve', v, rv,
                 jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv,
                                    'edits', jsonb_build_object('description', 'red bottle')));
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, %L)', a, 'FCHS', v, rv,
                                        jsonb_build_object('description', 'blue bottle'))),
                     'assertion_invalid', 'tampered body is refused');
  a := pg_temp.a('sapi-fchs-reviewer', 'FCHS', 'item.reject', v, rv,
                 jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv, 'edits', null));
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, null)', a, 'FCHS', v, rv)),
                     'assertion_invalid', 'operation mismatch is refused');
  a := pg_temp.a('sapi-fchs-reviewer', 'FCHS', 'item.approve', gen_random_uuid(), rv,
                 jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv, 'edits', null));
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, null)', a, 'FCHS', v, rv)),
                     'assertion_invalid', 'target mismatch is refused');
  a := pg_temp.mint('sapi-fchs-reviewer', 'district', 'item.approve', v, rv,
                    jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv, 'edits', null));
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, null)', a, 'FCHS', v, rv)),
                     'assertion_invalid', 'scope mismatch is refused');
  a := pg_temp.a('sapi-fchs-reviewer', 'FCHS', 'item.approve', v, rv + 1,
                 jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv + 1, 'edits', null));
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, null)', a, 'FCHS', v, rv)),
                     'assertion_invalid', 'row_version mismatch is refused');
  a := pg_temp.mint('sapi-fchs-reviewer', pg_temp.sc('FCHS'), 'item.approve', v, rv,
                    jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv, 'edits', null), -120);
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, null)', a, 'FCHS', v, rv)),
                     'assertion_invalid', 'expired assertion is refused');
  a := pg_temp.a('sapi-fchs-reviewer', 'FCHS', 'item.approve', v, rv,
                 jsonb_build_object('school_code', 'FCHS', 'item_id', v, 'row_version', rv, 'edits', null));
  a := jsonb_set(a, '{mac}', to_jsonb('A' || substr(a->>'mac', 2)));
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_item_approve(%L, %L, %L, %s, null)', a, 'FCHS', v, rv)),
                     'assertion_invalid', 'bad MAC is refused');
  perform pg_temp.eq(pg_temp.item(v)->>'review_status', 'pending', 'no refused call changed the item');
end $$;

-- =====================================================================================================
-- 3. queue and item read: ordering (G-40), pagination, quarantine (G-24), tenant isolation
-- =====================================================================================================
do $$
declare
  v_clean uuid;
  v_flag uuid;
  v_unscreened uuid;
  v_quar uuid;
  r jsonb;
  r2 jsonb;
  v_ids uuid[] := '{}';
  i int;
begin
  -- NFMS starts with no items: 52 clean ones plus one flagged and one unscreened.
  for i in 1 .. 52 loop
    v_ids := v_ids || pg_temp.mk_item('NFMS', 'F', 'pending', 'hidden', 'with_finder');
  end loop;
  v_clean := v_ids[1];
  perform pg_temp.exec(format('update public.items set created_at = now() - interval ''3 days'' where id = %L', v_clean));
  v_flag := pg_temp.mk_item('NFMS', 'F', 'pending', 'hidden', 'with_finder');
  perform pg_temp.exec(format($f$update public.items set screening_status = 'flagged',
                                   screening_flags = '{"has_face": true, "has_text": false}', created_at = now() - interval '1 hour'
                                 where id = %L$f$, v_flag));
  v_unscreened := pg_temp.mk_item('NFMS', 'F', 'pending', 'hidden', 'with_finder');
  perform pg_temp.exec(format($f$update public.items set screening_status = 'unscreened', created_at = now() - interval '2 hours'
                                 where id = %L$f$, v_unscreened));

  r := pg_temp.queue('sapi-nfms-new', 'NFMS');
  perform pg_temp.eq(jsonb_array_length(r->'items')::text, '50', 'queue: 50 per page');
  perform pg_temp.eq(r#>>'{items,0,id}', v_unscreened::text, 'queue: unscreened (older) first in the non-clean bucket');
  perform pg_temp.eq(r#>>'{items,1,id}', v_flag::text, 'queue: flagged in the non-clean bucket');
  perform pg_temp.eq(r#>>'{items,2,id}', v_clean::text, 'queue: then the oldest clean item');
  perform pg_temp.eq(r#>>'{items,1,flags,0}', 'has_face', 'queue: chips are true-valued flags only');
  perform pg_temp.eq(jsonb_array_length(r#>'{items,1,flags}')::text, '1', 'queue: false flags are not chips');
  perform pg_temp.ok(r#>'{items,0}' ?& array['id', 'publicId', 'category', 'description', 'note', 'pin', 'mapVersionId',
                       'zoneId', 'zoneName', 'dropoffLocationId', 'currentLocationId', 'reviewStatus', 'publicationStatus',
                       'custody', 'postedByKind', 'createdAt', 'arrivalDeadlineAt', 'expiresAt', 'dispositionDueAt',
                       'rowVersion', 'screeningStatus', 'flags', 'quarantine', 'photos', 'deviceRejections30d'],
                     'queue: StaffItemRow keys');
  perform pg_temp.ok(r->'nextCursor' is not null and r#>>'{nextCursor,id}' = r#>>'{items,49,id}', 'queue: next cursor');
  r2 := pg_temp.queue('sapi-nfms-new', 'NFMS', r#>>'{nextCursor,createdAt}', (r#>>'{nextCursor,id}')::uuid);
  perform pg_temp.eq(jsonb_array_length(r2->'items')::text, '4', 'queue: second page holds the rest');
  perform pg_temp.ok(r2->'nextCursor' = 'null'::jsonb, 'queue: last page has no cursor');
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(r->'items') a, jsonb_array_elements(r2->'items') b
                                  where a->>'id' = b->>'id'), 'queue: pages do not overlap');
  perform pg_temp.eq(pg_temp.err($q$select pg_temp.queue('sapi-nfms-new', 'NFMS', 'not-a-time', gen_random_uuid())$q$),
                     'invalid_input/cursor_created', 'queue: malformed cursor');

  -- quarantine: hidden from reviewers, visible to school_admin+
  v_quar := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  perform pg_temp.exec(format($f$update public.items set screening_status = 'flagged',
                                   screening_flags = '{"nsfw": true, "quarantine": true}' where id = %L$f$, v_quar));
  r := pg_temp.queue('sapi-fchs-reviewer', 'FCHS');
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(r->'items') x where x->>'id' = v_quar::text),
                     'queue: quarantined item hidden from reviewers');
  r := pg_temp.queue('sapi-fchs-admin', 'FCHS');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(r->'items') x
                              where x->>'id' = v_quar::text and (x->>'quarantine')::boolean), 'queue: admin sees quarantine');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.get(%L, %L, %L)', 'sapi-fchs-reviewer', 'FCHS', v_quar)),
                     'forbidden', 'item_get: quarantined item is school_admin+');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v_quar,
                                        pg_temp.rv(v_quar))), 'forbidden', 'approve: quarantined item is school_admin+');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.reject(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v_quar,
                                        pg_temp.rv(v_quar), 'spam')), 'forbidden', 'reject: quarantined item is school_admin+');
  perform pg_temp.eq(pg_temp.get('sapi-district', 'FCHS', v_quar)->>'id', v_quar::text, 'item_get: district admin any school');
  -- custody is not gated: the office still receives the physical item (it reveals no content)
  perform pg_temp.eq(pg_temp.receive('sapi-fchs-office', 'FCHS', v_quar, pg_temp.rv(v_quar),
                                     pg_temp.loc('FCHS', 'W'))->>'custody', 'at_location',
                     'receive: quarantine does not block custody');

  -- tenant isolation: other-school staff are forbidden; a wrong school code finds nothing
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.get(%L, %L, %L)', 'sapi-sfhs-admin', 'FCHS', v_clean)),
                     'forbidden', 'item_get: SFHS admin at FCHS');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.get(%L, %L, %L)', 'sapi-fchs-admin', 'NFMS', v_clean)),
                     'forbidden', 'item_get: FCHS admin at NFMS');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.get(%L, %L, %L)', 'sapi-sfhs-admin', 'SFHS', v_clean)),
                     'not_found', 'item_get: an NFMS item is not found through SFHS');
  perform pg_temp.eq(pg_temp.err($q$select pg_temp.queue('sapi-fchs-reviewer', 'ZZZZ')$q$), 'not_found', 'unknown school');
end $$;

-- =====================================================================================================
-- 4. review: approve with edits, reject, the approve-vs-reject race, bulk reject, auto-block (G-34)
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  rv bigint := pg_temp.rv(v);
  v_zone uuid := pg_temp.zone('FCHS', 'Library');
  v_east uuid := pg_temp.loc('FCHS', 'E');
  r jsonb;
  it jsonb;
  v_race uuid;
  v_rej uuid;
  v_digest text;
  b1 uuid;
  b2 uuid;
  b3 uuid;
begin
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v, rv,
                                        '{"price": 3}')), 'invalid_input/edits', 'approve: unknown edit key');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v, rv,
                                        jsonb_build_object('zoneId', pg_temp.zone('SFHS', 'Library')))),
                     'invalid_input/zoneId', 'approve: zone must be on the item map version');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v, rv,
                                        '{"category": "phone"}')), 'invalid_input/category',
                     'approve: a student item never becomes high-value');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v, rv,
                                        '{"description": "x"}')), 'invalid_input/description', 'approve: description bounds');

  r := pg_temp.approve('sapi-fchs-reviewer', 'FCHS', v, rv,
                       jsonb_build_object('description', 'navy metal water bottle', 'category', 'bottle',
                                          'zoneId', v_zone, 'dropoffLocationId', v_east));
  perform pg_temp.eq(r->>'reviewStatus', 'approved', 'approve: review');
  perform pg_temp.eq(r->>'publicationStatus', 'generating', 'approve: publication generating');
  perform pg_temp.eq(r->>'rowVersion', (rv + 1)::text, 'approve: row version bumped once');
  it := pg_temp.item(v);
  perform pg_temp.eq(it->>'description', 'navy metal water bottle', 'approve: description edit applied');
  perform pg_temp.eq(it->>'zone_id', v_zone::text, 'approve: zone edit applied');
  perform pg_temp.eq(it->>'dropoff_location_id', v_east::text, 'approve: dropoff edit applied');
  perform pg_temp.eq(it->>'reviewed_by', '00000000-5b00-4000-8000-000000000004', 'approve: reviewer recorded');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs where kind = 'make_variants'
                                         and dedupe_key = 'make_variants:%s' and payload = '{"itemId": "%s"}'$f$, v, v)) = 1,
                     'approve: make_variants enqueued');
  r := pg_temp.q(format($f$select metadata from public.audit_log where action = 'item.approve' and target_id = %L$f$, v));
  perform pg_temp.eq(jsonb_array_length(r->'edited_fields')::text, '4', 'approve: audit edited_fields');
  perform pg_temp.ok(pg_temp.n($q$select count(*) from public.daily_school_stats
                                  where school_id = '0a0a0a0a-0000-4000-8000-000000000001' and approved >= 1$q$) = 1,
                     'approve: daily approved counter');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v, rv + 1)),
                     'state_changed/review_status', 'approve: only from pending');

  -- photos must be canonical before approval
  v := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder', '{canonical_ready,uploaded}');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        pg_temp.rv(v))), 'state_changed/photos_not_ready', 'approve: photos not canonical');

  -- the race (§7.6, B.2): approve and reject hold the same row version; exactly one wins
  v_race := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  rv := pg_temp.rv(v_race);
  perform pg_temp.approve('sapi-fchs-reviewer', 'FCHS', v_race, rv);
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.reject(%L, %L, %L, %s, %L)', 'sapi-fchs-admin', 'FCHS', v_race, rv,
                                        'spam')), 'state_changed/row_version', 'race: the loser gets state_changed');
  perform pg_temp.eq(pg_temp.item(v_race)->>'review_status', 'approved', 'race: the winner stands');

  -- reject: reason list, device rejection row, no media deletion here
  v_rej := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.reject(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v_rej,
                                        pg_temp.rv(v_rej), 'ugly')), 'invalid_input/reason', 'reject: reason list');
  r := pg_temp.reject('sapi-fchs-reviewer', 'FCHS', v_rej, pg_temp.rv(v_rej), 'pii_visible');
  perform pg_temp.eq(r->>'reviewStatus', 'rejected', 'reject: review');
  perform pg_temp.eq(r->>'publicationStatus', 'hidden', 'reject: stays hidden');
  it := pg_temp.item(v_rej);
  perform pg_temp.eq(it->>'reject_reason', 'pii_visible', 'reject: reason stored');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.device_rejections d join public.items i
                                          on i.device_token_hash = d.device_token_hash and i.school_id = d.school_id
                                         where i.id = %L$f$, v_rej)) = 1, 'reject: device_rejections row');
  perform pg_temp.ok(pg_temp.n(format('select count(*) from public.media_deletion_ledger where item_id = %L', v_rej)) = 0,
                     'reject: media deletion is left to anonymize_rejected');

  -- auto-block (G-34): the fifth rejection within 30 days blocks the device for 30 days
  v_rej := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  v_digest := pg_temp.item(v_rej)->>'device_token_hash';
  perform pg_temp.exec(format($f$insert into public.device_rejections (school_id, device_token_hash)
                                 select school_id, device_token_hash from public.items, generate_series(1, 4)
                                  where id = %L$f$, v_rej));
  r := pg_temp.reject('sapi-fchs-reviewer', 'FCHS', v_rej, pg_temp.rv(v_rej), 'spam');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.devices d join public.items i
                                          on i.device_token_hash = d.token_hash and i.school_id = d.school_id
                                         where i.id = %L and d.block_reason = 'auto_rejections'
                                           and d.blocked_until > now() + interval '29 days'$f$, v_rej)) = 1,
                     'reject: fifth rejection auto-blocks the device');
  perform pg_temp.eq(pg_temp.get('sapi-fchs-reviewer', 'FCHS', v_rej)->>'deviceRejections30d', '5',
                     'item_get: device reputation count');

  -- bulk reject: pending rows rejected, anything else skipped
  b1 := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  b2 := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'at_location');
  b3 := pg_temp.mk_item('FCHS', 'W', 'approved', 'hidden', 'with_finder');
  r := pg_temp.bulk_reject('sapi-fchs-reviewer', 'FCHS', array[b1, b3, b2], 'spam');
  perform pg_temp.eq(r->>'rejected', '2', 'bulk reject: count');
  perform pg_temp.eq(r->>'skipped', jsonb_build_array(b3)::text, 'bulk reject: skipped ids');
  perform pg_temp.eq(pg_temp.item(b2)->>'review_status', 'rejected', 'bulk reject: row rejected');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.audit_log where action = 'item.reject'
                                         and target_id in (%L, %L) and metadata->>'bulk' = 'true'$f$, b1, b2)) = 2,
                     'bulk reject: one audit row per item');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.bulk_reject(%L, %L, %L, %L)', 'sapi-fchs-reviewer', 'FCHS',
                                        (select array_agg(gen_random_uuid()) from generate_series(1, 51)), 'spam')),
                     'invalid_input/item_ids', 'bulk reject: at most 50 ids');
end $$;

-- =====================================================================================================
-- 5. custody: receive, transfer, claim (ledger + delete_media), role and tenant checks (§5.4)
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'published', 'with_finder', '{public_ready,public_ready}');
  v_west uuid := pg_temp.loc('FCHS', 'W');
  v_east uuid := pg_temp.loc('FCHS', 'E');
  r jsonb;
  it jsonb;
  v_pending uuid;
  v_ledger bigint;
  v_sf uuid;
begin
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.receive(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        pg_temp.rv(v), v_west)), 'forbidden', 'receive: office+ only');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.receive(%L, %L, %L, %s, %L)', 'sapi-fchs-office', 'FCHS', v,
                                        pg_temp.rv(v), pg_temp.loc('SFHS', 'M'))),
                     'invalid_input/location_id', 'receive: location must belong to the school');
  r := pg_temp.receive('sapi-fchs-office', 'FCHS', v, pg_temp.rv(v), v_west);
  perform pg_temp.eq(r->>'custody', 'at_location', 'receive: custody');
  perform pg_temp.eq(r->>'publicationStatus', 'published', 'receive: publication unchanged');
  it := pg_temp.item(v);
  perform pg_temp.eq(it->>'current_location_id', v_west::text, 'receive: current location');
  perform pg_temp.ok((it->>'received_at')::timestamptz = now(), 'receive: received_at');
  perform pg_temp.ok((it->>'expires_at')::timestamptz = now() + interval '30 days', 'receive: expires_at = retention');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs where kind = 'invalidate_cache'
                                         and payload->'tags' ? 'item:%s'$f$, v)) >= 1, 'receive: cache invalidation');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.audit_log where action = 'item.receive'
                                         and target_id = %L and state_after->>'current_location_id' = %L$f$, v, v_west)) = 1,
                     'receive: audited');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.receive(%L, %L, %L, %s, %L)', 'sapi-fchs-office', 'FCHS', v,
                                        pg_temp.rv(v), v_west)), 'state_changed/custody', 'receive: not twice');

  perform pg_temp.eq(pg_temp.err(format('select pg_temp.transfer(%L, %L, %L, %s, %L)', 'sapi-fchs-office', 'FCHS', v,
                                        pg_temp.rv(v), v_west)), 'invalid_input/location_id', 'transfer: to a new location');
  r := pg_temp.transfer('sapi-fchs-office', 'FCHS', v, pg_temp.rv(v), v_east);
  perform pg_temp.eq(pg_temp.item(v)->>'current_location_id', v_east::text, 'transfer: moved');

  -- a reviewer cannot claim; office can
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.claim(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        pg_temp.rv(v))), 'forbidden', 'claim: reviewer is forbidden');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.claim(%L, %L, %L, %s)', 'sapi-fchs-office', 'FCHS', v,
                                        pg_temp.rv(v) - 1)), 'state_changed/row_version', 'claim: stale row version');
  r := pg_temp.claim('sapi-fchs-office', 'FCHS', v, pg_temp.rv(v));
  perform pg_temp.eq(r->>'custody', 'claimed', 'claim: custody');
  perform pg_temp.eq(r->>'publicationStatus', 'withdrawn', 'claim: publication withdrawn');
  it := pg_temp.item(v);
  perform pg_temp.ok(it->>'claimed_at' is not null and it->>'terminal_at' is not null and it->>'withdrawn_at' is not null,
                     'claim: claimed_at, terminal_at, withdrawn_at');
  v_ledger :=pg_temp.n(format($f$select id from public.media_deletion_ledger where item_id = %L and reason = 'claimed'$f$, v));
  perform pg_temp.ok(v_ledger is not null, 'claim: deletion ledger');
  perform pg_temp.eq(pg_temp.n(format('select count(*) from public.media_deletion_objects where ledger_id = %s', v_ledger))::text,
                     '8', 'claim: ledger objects = 2 photos x (original, review, thumb, medium)');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs where kind = 'delete_media'
                                         and dedupe_key = 'delete_media:%s' and status = 'queued'$f$, v_ledger)) = 1,
                     'claim: delete_media job');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.claim(%L, %L, %L, %s)', 'sapi-fchs-office', 'FCHS', v,
                                        pg_temp.rv(v))), 'state_changed/custody', 'claim: terminal custody is final');

  -- G-02: an unreviewed item at the office can be claimed; it stays hidden
  v_pending := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'at_location');
  r := pg_temp.claim('sapi-fchs-office', 'FCHS', v_pending, pg_temp.rv(v_pending));
  perform pg_temp.ok(r->>'custody' = 'claimed' and r->>'publicationStatus' = 'hidden' and r->>'reviewStatus' = 'pending',
                     'claim: pending item claimed, still hidden');

  -- multi-school user: reviewer at FCHS, office at SFHS
  v_sf := pg_temp.mk_item('SFHS', 'M', 'approved', 'hidden', 'at_location');
  perform pg_temp.eq(pg_temp.claim('sapi-multi', 'SFHS', v_sf, pg_temp.rv(v_sf))->>'custody', 'claimed',
                     'claim: multi-school office membership at SFHS');
  v_pending := pg_temp.mk_item('FCHS', 'W', 'approved', 'hidden', 'at_location');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.claim(%L, %L, %L, %s)', 'sapi-multi', 'FCHS', v_pending,
                                        pg_temp.rv(v_pending))), 'forbidden', 'claim: multi-school reviewer at FCHS');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.claim(%L, %L, %L, %s)', 'sapi-sfhs-admin', 'FCHS', v_pending,
                                        pg_temp.rv(v_pending))), 'forbidden', 'claim: other-school admin');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.claim(%L, %L, %L, %s)', 'sapi-sfhs-admin', 'SFHS', v_pending,
                                        pg_temp.rv(v_pending))), 'not_found', 'claim: FCHS item through SFHS');
end $$;

-- =====================================================================================================
-- 6. dispose: disposition due or school_admin+; bulk dispose (Appendix C item_dispose, runbook 7)
-- =====================================================================================================
do $$
declare
  v_early uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'published', 'at_location', '{public_ready}');
  v_due uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'hidden', 'at_location');
  b1 uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'hidden', 'at_location');
  b2 uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'hidden', 'at_location');
  r jsonb;
begin
  perform pg_temp.exec(format('update public.items set disposition_due_at = now() where id in (%L, %L)', v_due, b1));
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.dispose(%L, %L, %L, %s, %L)', 'sapi-fchs-office', 'FCHS', v_early,
                                        pg_temp.rv(v_early), 'donated')), 'forbidden',
                     'dispose: office cannot dispose before disposition is due');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.dispose(%L, %L, %L, %s, %L)', 'sapi-fchs-admin', 'FCHS', v_early,
                                        pg_temp.rv(v_early), 'burned')), 'invalid_input/disposition', 'dispose: values');
  r := pg_temp.dispose('sapi-fchs-admin', 'FCHS', v_early, pg_temp.rv(v_early), 'donated');
  perform pg_temp.eq(r->>'custody', 'expired_donated', 'dispose: school_admin early disposal');
  perform pg_temp.eq(r->>'publicationStatus', 'withdrawn', 'dispose: publication withdrawn');
  perform pg_temp.ok(pg_temp.item(v_early)->>'disposed_at' is not null, 'dispose: disposed_at');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.media_deletion_ledger
                                         where item_id = %L and reason = 'expired_donated'$f$, v_early)) = 1,
                     'dispose: deletion ledger');
  r := pg_temp.dispose('sapi-fchs-office', 'FCHS', v_due, pg_temp.rv(v_due), 'disposed');
  perform pg_temp.eq(r->>'custody', 'expired_disposed', 'dispose: office once disposition is due');

  r := pg_temp.bulk_dispose('sapi-fchs-office', 'FCHS', array[b1, b2], 'donated');
  perform pg_temp.eq(r->>'disposed', '1', 'bulk dispose: only the due item for office');
  perform pg_temp.eq(r->>'skipped', jsonb_build_array(b2)::text, 'bulk dispose: skipped');
  r := pg_temp.bulk_dispose('sapi-fchs-admin', 'FCHS', array[b2], 'donated');
  perform pg_temp.eq(r->>'disposed', '1', 'bulk dispose: school_admin may dispose early');
end $$;

-- =====================================================================================================
-- 7. late arrival of a never-arrived item (G-01)
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'withdrawn', 'expired_never_arrived', '{public_ready}');
  v_old uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'withdrawn', 'expired_never_arrived', '{public_ready}');
  v_hidden uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'expired_never_arrived');
  v_ledger bigint;
  r jsonb;
  it jsonb;
begin
  -- expiry happened yesterday; its deletion is deferred by the grace window
  perform pg_temp.exec(format($f$update public.items set terminal_at = now() - interval '1 day',
                                   withdrawn_at = now() - interval '1 day' where id = %L$f$, v));
  perform pg_temp.exec(format($f$update public.items set terminal_at = now() - interval '10 days',
                                   withdrawn_at = now() - interval '10 days' where id = %L$f$, v_old));
  v_ledger := pg_temp.n(format($f$select private.create_deletion_ledger(%L, '0a0a0a0a-0000-4000-8000-000000000001',
                                   'never_arrived', null, now() + interval '6 days')$f$, v));
  perform pg_temp.ok(v_ledger is not null, 'late: fixture ledger');

  perform pg_temp.eq(pg_temp.err(format('select pg_temp.receive(%L, %L, %L, %s, %L)', 'sapi-fchs-office', 'FCHS', v_old,
                                        pg_temp.rv(v_old), pg_temp.loc('FCHS', 'W'))), 'state_changed/custody',
                     'late: outside late_arrival_grace_days');

  r := pg_temp.receive('sapi-fchs-office', 'FCHS', v, pg_temp.rv(v), pg_temp.loc('FCHS', 'W'));
  perform pg_temp.eq(r->>'custody', 'at_location', 'late: back at the location');
  perform pg_temp.eq(r->>'publicationStatus', 'published', 'late: republished (variants intact, deletion cancelled)');
  it := pg_temp.item(v);
  perform pg_temp.ok(it->>'terminal_at' is null and it->>'withdrawn_at' is null, 'late: terminal_at and withdrawn_at cleared');
  perform pg_temp.ok((it->>'expires_at')::timestamptz = now() + interval '30 days', 'late: expires_at reset');
  perform pg_temp.ok(pg_temp.n(format('select count(*) from public.media_deletion_ledger where item_id = %L', v)) = 0,
                     'late: pending ledger removed');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs where dedupe_key = 'delete_media:%s'
                                         and status = 'done' and last_error_code = 'cancelled'$f$, v_ledger)) = 1,
                     'late: queued delete_media cancelled');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.audit_log where action = 'item.receive_late'
                                         and target_id = %L and metadata->>'republished' = 'true'$f$, v)) = 1,
                     'late: audited as item.receive_late');

  r := pg_temp.receive('sapi-fchs-office', 'FCHS', v_hidden, pg_temp.rv(v_hidden), pg_temp.loc('FCHS', 'E'));
  perform pg_temp.ok(r->>'custody' = 'at_location' and r->>'publicationStatus' = 'hidden' and r->>'reviewStatus' = 'pending',
                     'late: an unreviewed item returns hidden and pending');
end $$;

-- =====================================================================================================
-- 8. pull, delete, edit (§10.2 step 5, §5.4, §5.3 step 6)
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'published', 'with_finder', '{public_ready}');
  v_del uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'published', 'at_location', '{public_ready}');
  v_edit uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'published', 'at_location', '{public_ready}');
  r jsonb;
  rv bigint;
begin
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.pull(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        pg_temp.rv(v), 'because')), 'invalid_input/reason', 'pull: reason codes only');
  r := pg_temp.pull('sapi-fchs-reviewer', 'FCHS', v, pg_temp.rv(v), 'privacy');
  perform pg_temp.eq(r->>'publicationStatus', 'withdrawn', 'pull: withdrawn');
  perform pg_temp.eq(r->>'custody', 'with_finder', 'pull: custody unchanged');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.media_deletion_ledger
                                         where item_id = %L and reason = 'pulled'$f$, v)) = 1, 'pull: ledger');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.audit_log where action = 'item.pull'
                                         and target_id = %L and metadata->>'reason' = 'privacy'$f$, v)) = 1, 'pull: audit');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.pull(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        pg_temp.rv(v), 'privacy')), 'state_changed/publication_status', 'pull: once');

  perform pg_temp.eq(pg_temp.err(format('select pg_temp.del(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v_del,
                                        pg_temp.rv(v_del), 'staff_mistake')), 'forbidden', 'delete: office+ only');
  r := pg_temp.del('sapi-fchs-office', 'FCHS', v_del, pg_temp.rv(v_del), 'staff_mistake');
  perform pg_temp.eq(r->>'publicationStatus', 'withdrawn', 'delete: live publication withdrawn');
  perform pg_temp.ok(pg_temp.item(v_del)->>'deleted_at' is not null, 'delete: deleted_at');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.media_deletion_ledger
                                         where item_id = %L and reason = 'deleted'$f$, v_del)) = 1, 'delete: ledger');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.get(%L, %L, %L)', 'sapi-fchs-office', 'FCHS', v_del)),
                     'not_found', 'delete: gone from staff reads');

  rv := pg_temp.rv(v_edit);
  r := pg_temp.edit('sapi-fchs-office', 'FCHS', v_edit, rv, '{"description": "green hydroflask with stickers"}');
  perform pg_temp.eq(r->>'rowVersion', (rv + 1)::text, 'edit: row version');
  perform pg_temp.eq(pg_temp.item(v_edit)->>'description', 'green hydroflask with stickers', 'edit: applied');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs where kind = 'match_item'
                                         and dedupe_key = 'match_item:%s:%s'$f$, v_edit, rv + 1)) = 1,
                     'edit: published item re-matched at the new row version');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.edit(%L, %L, %L, %s, %L)', 'sapi-fchs-reviewer', 'FCHS', v_edit,
                                        rv + 1, '{"description": "x y"}')), 'forbidden', 'edit: office+ only');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.edit(%L, %L, %L, %s, %L)', 'sapi-fchs-office', 'FCHS', v_edit,
                                        rv + 1, '{}')), 'invalid_input/edits', 'edit: something to change');
end $$;

-- =====================================================================================================
-- 9. photo drop (G-23): a failed photo no longer blocks approval; never the last photo
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder', '{canonical_ready,failed}');
  v_ph uuid[] := pg_temp.photos(v);
  r jsonb;
begin
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.approve(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        pg_temp.rv(v))), 'state_changed/photos_not_ready', 'drop: failed photo blocks approval');
  r := pg_temp.drop_photo('sapi-fchs-office', 'FCHS', v, v_ph[2], pg_temp.rv(v));
  perform pg_temp.eq(pg_temp.item(v)->>'photo_count', '1', 'drop: photo_count follows the current set');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.media_deletion_objects o
                                          join public.media_deletion_ledger l on l.id = o.ledger_id
                                         where l.item_id = %L and l.reason = 'photo_dropped' and o.item_photo_id = %L$f$,
                                      v, v_ph[2])) = 1, 'drop: ledger for exactly that generation');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.drop_photo(%L, %L, %L, %L, %s)', 'sapi-fchs-office', 'FCHS', v,
                                        v_ph[2], pg_temp.rv(v))), 'state_changed/photo_not_current', 'drop: not twice');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.drop_photo(%L, %L, %L, %L, %s)', 'sapi-fchs-office', 'FCHS', v,
                                        v_ph[1], pg_temp.rv(v))), 'state_changed/last_photo', 'drop: never the last photo');
  r := pg_temp.approve('sapi-fchs-reviewer', 'FCHS', v, pg_temp.rv(v));
  perform pg_temp.eq(r->>'publicationStatus', 'generating', 'drop: approval now possible');
end $$;

-- =====================================================================================================
-- 10. staff post (G-08): create -> complete -> canonicalize (simulated) -> publish-ready; hold release
-- =====================================================================================================
do $$
declare
  r jsonb;
  it jsonb;
  v uuid;
  v_ph uuid[];
  v_obj jsonb;
  v_east uuid := pg_temp.loc('FCHS', 'E');
  v_hold uuid;
begin
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.create_item(%L, %L, %L, %L, %L, null, null, null, null, %L, 1)',
                                        'sapi-fchs-reviewer', 'FCHS', 'staff', 'id_card', 'student id card', v_east)),
                     'invalid_input/category', 'create: id_card is handled offline');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.create_item(%L, %L, %L, %L, %L, null, %L, %L, %L, %L, 1)',
                                        'sapi-fchs-reviewer', 'FCHS', 'staff', 'bottle', 'blue bottle',
                                        pg_temp.map('FCHS'), '1.500000', '0.500000', v_east)),
                     'invalid_input/pin', 'create: pin bounds');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.create_item(%L, %L, %L, %L, %L, null, null, null, null, %L, 1)',
                                        'sapi-fchs-reviewer', 'FCHS', 'student', 'bottle', 'blue bottle', v_east)),
                     'invalid_input/mode', 'create: mode');

  r := pg_temp.create_item('sapi-fchs-reviewer', 'FCHS', 'staff', 'bottle', 'blue hydroflask with stickers', 'shelf B',
                           pg_temp.map('FCHS'), '0.450000', '0.700000', v_east, 2);
  v := (r->>'itemId')::uuid;
  perform pg_temp.ok(r->>'publicId' like 'FCHS-E-%', 'create: public id assigned at create');
  perform pg_temp.eq(jsonb_array_length(r->'photos')::text, '2', 'create: photo slots');
  it := pg_temp.item(v);
  perform pg_temp.ok(it->>'review_status' = 'approved' and it->>'publication_status' = 'hidden'
                     and it->>'custody' = 'at_location', 'create: approved / hidden / at_location');
  perform pg_temp.ok(it->>'posted_by_kind' = 'staff' and it->>'posted_by_staff_id' = '00000000-5b00-4000-8000-000000000004'
                     and it->>'reviewed_by' = '00000000-5b00-4000-8000-000000000004', 'create: staff attribution');
  perform pg_temp.ok(it->>'current_location_id' = v_east::text and it->>'dropoff_location_id' = v_east::text
                     and (it->>'received_at')::timestamptz = now()
                     and (it->>'expires_at')::timestamptz = now() + interval '30 days', 'create: received now at E');
  perform pg_temp.eq(it->>'zone_id', pg_temp.zone('FCHS', 'Library')::text, 'create: zone resolved from the pin');
  perform pg_temp.ok(it->>'arrival_deadline_at' is null, 'create: no arrival deadline for staff posts');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.item_photos
                                         where item_id = %L and status = 'uploaded' and is_current and generation = 1
                                           and incoming_path = school_id::text || '/' || item_id::text || '/' || id::text || '/raw'$f$,
                                      v)) = 2, 'create: incoming keys follow the contract');

  -- complete: every current photo must be reported present
  v_ph := pg_temp.photos(v);
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.complete(%L, %L, %L, %L)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        jsonb_build_array(jsonb_build_object('photoId', v_ph[1], 'exists', true,
                                                                             'rawBytes', 5000, 'magicOk', true)))),
                     'invalid_input/objects', 'complete: a missing object is refused');
  v_obj := jsonb_build_array(jsonb_build_object('photoId', v_ph[1], 'exists', true, 'rawBytes', 5000, 'magicOk', true),
                             jsonb_build_object('photoId', v_ph[2], 'exists', true, 'rawBytes', 7000, 'magicOk', true));
  r := pg_temp.complete('sapi-fchs-reviewer', 'FCHS', v, v_obj);
  perform pg_temp.eq(r->>'publicationStatus', 'hidden', 'complete: still hidden');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs j join public.item_photos p
                                          on j.dedupe_key = 'canonicalize_photo:' || p.id::text
                                         where p.item_id = %L and j.kind = 'canonicalize_photo'$f$, v)) = 2,
                     'complete: canonicalize_photo per photo');
  r := pg_temp.complete('sapi-fchs-reviewer', 'FCHS', v, v_obj);
  perform pg_temp.eq(r->>'itemId', v::text, 'complete: idempotent replay');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs j join public.item_photos p
                                          on j.dedupe_key = 'canonicalize_photo:' || p.id::text
                                         where p.item_id = %L$f$, v)) = 2, 'complete: replay enqueues nothing new');

  -- canonicalization (worker, simulated) then publish-ready
  perform pg_temp.exec(format($f$update public.item_photos
                                    set status = 'canonical_ready', incoming_path = null,
                                        original_path = school_id::text || '/' || item_id::text || '/' || id::text || '/canonical.jpg',
                                        review_path = school_id::text || '/' || item_id::text || '/' || id::text || '/review.jpg'
                                  where item_id = %L$f$, v));
  perform pg_temp.exec(format($f$update public.items set screening_status = 'clean' where id = %L$f$, v));
  perform pg_temp.ok(pg_temp.publish_ready(v), 'publish-ready: hidden -> generating');
  perform pg_temp.eq(pg_temp.item(v)->>'publication_status', 'generating', 'publish-ready: generating');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.jobs where dedupe_key = 'make_variants:%s'$f$, v)) = 1,
                     'publish-ready: make_variants enqueued');

  -- a screening hold waits for staff confirmation (G-08 step 6)
  r := pg_temp.create_item('sapi-fchs-office', 'FCHS', 'backfill', 'phone', 'black phone in a blue case', null,
                           null, null, null, v_east, 1);
  v_hold := (r->>'itemId')::uuid;
  perform pg_temp.eq(pg_temp.item(v_hold)->>'posted_by_kind', 'backfill', 'create: backfill mode');
  perform pg_temp.exec(format($f$update public.item_photos
                                    set status = 'canonical_ready', incoming_path = null,
                                        original_path = school_id::text || '/' || item_id::text || '/' || id::text || '/canonical.jpg',
                                        review_path = school_id::text || '/' || item_id::text || '/' || id::text || '/review.jpg'
                                  where item_id = %L$f$, v_hold));
  perform pg_temp.exec(format($f$update public.items set screening_status = 'flagged',
                                   screening_flags = '{"hold": true, "has_face": true}' where id = %L$f$, v_hold));
  perform pg_temp.ok(not pg_temp.publish_ready(v_hold), 'hold: publish-ready waits');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.confirm(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v_hold,
                                        pg_temp.rv(v_hold))), 'forbidden', 'confirm: office+ only');
  r := pg_temp.confirm('sapi-fchs-office', 'FCHS', v_hold, pg_temp.rv(v_hold));
  perform pg_temp.eq(r->>'publicationStatus', 'generating', 'confirm: hold released, generating');
  perform pg_temp.ok(not (pg_temp.item(v_hold)->'screening_flags' ? 'hold'), 'confirm: hold flag cleared');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.confirm(%L, %L, %L, %s)', 'sapi-fchs-office', 'FCHS', v_hold,
                                        pg_temp.rv(v_hold))), 'state_changed/publication_status', 'confirm: only while hidden');
end $$;

-- =====================================================================================================
-- 11. devices (§13.3, F-85): block and unblock through an item or a report of this school
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  v_staff uuid := pg_temp.mk_item('FCHS', 'W', 'approved', 'hidden', 'at_location', '{canonical_ready}', false, 'staff');
  v_rep uuid := pg_temp.mk_report('FCHS');
  r jsonb;
begin
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.block(%L, %L, %L, null, 7, %L)', 'sapi-fchs-reviewer', 'FCHS', v,
                                        'spam')), 'forbidden', 'block: office+ only');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.block(%L, %L, %L, null, 0, %L)', 'sapi-fchs-office', 'FCHS', v,
                                        'spam')), 'invalid_input/days', 'block: 1..90 days');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.block(%L, %L, null, null, 7, %L)', 'sapi-fchs-office', 'FCHS',
                                        'spam')), 'invalid_input/item_id', 'block: an item or a report');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.block(%L, %L, %L, null, 7, %L)', 'sapi-fchs-office', 'FCHS', v_staff,
                                        'spam')), 'not_found/device', 'block: staff posts have no device');
  r := pg_temp.block('sapi-fchs-office', 'FCHS', v, null, 7, 'spam');
  perform pg_temp.ok((r->>'blocked')::boolean and (r->>'blockedUntil')::timestamptz = now() + interval '7 days',
                     'block: blocked for 7 days');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.devices d join public.items i
                                          on i.device_token_hash = d.token_hash and i.school_id = d.school_id
                                         where i.id = %L and d.block_reason = 'staff'
                                           and d.blocked_by = '00000000-5b00-4000-8000-000000000003'$f$, v)) = 1,
                     'block: devices row');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.audit_log where action = 'device.block'
                                         and target_id = %L and not (state_after ? 'device_token_hash')$f$, v)) = 1,
                     'block: audited without the digest');
  r := pg_temp.unblock('sapi-fchs-office', 'FCHS', v, null);
  perform pg_temp.ok(not (r->>'blocked')::boolean, 'unblock: result');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.devices d join public.items i
                                          on i.device_token_hash = d.token_hash and i.school_id = d.school_id
                                         where i.id = %L and d.blocked_until is null$f$, v)) = 1, 'unblock: cleared');
  r := pg_temp.block('sapi-fchs-admin', 'FCHS', null, v_rep, 30, 'staff');
  perform pg_temp.ok((r->>'blocked')::boolean, 'block: through a lost report');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.block(%L, %L, %L, null, 7, %L)', 'sapi-fchs-office', 'FCHS', v,
                                        'because I said so')), 'invalid_input/reason', 'block: reason codes only');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.block(%L, %L, null, %L, 7, %L)', 'sapi-sfhs-admin', 'SFHS', v_rep,
                                        'spam')), 'not_found', 'block: report of another school');
end $$;

-- =====================================================================================================
-- 12. media tickets (G-04, G-07)
-- =====================================================================================================
do $$
declare
  v uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder');
  v_sf uuid := pg_temp.mk_item('SFHS', 'M', 'pending', 'hidden', 'with_finder');
  v_raw uuid := pg_temp.mk_item('FCHS', 'W', 'pending', 'hidden', 'with_finder', '{uploaded}');
  v_ph uuid := (pg_temp.photos(v))[1];
  v_sf_ph uuid := (pg_temp.photos(v_sf))[1];
  v_draft uuid := pg_temp.mk_map('FCHS', 'draft', true, true);
  v_pending uuid := pg_temp.mk_map('FCHS', 'pending_district', true, true);
  v_nozone uuid := pg_temp.mk_map('FCHS', 'pending_district', false, true);
  r jsonb;
begin
  r := pg_temp.ticket('sapi-fchs-reviewer', 'FCHS', 'media.read', v_ph, null);
  perform pg_temp.ok((r->>'expiresAt')::timestamptz = now() + interval '30 seconds', 'ticket: 30 s expiry');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.media_tickets where id = %L and operation = 'media.read'
                                         and item_photo_id = %L and item_id = %L and used_at is null
                                         and staff_member_id = '00000000-5b00-4000-8000-000000000004'$f$,
                                      r->>'ticketId', v_ph, v)) = 1, 'ticket: media.read row');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, %L, null)', 'sapi-fchs-reviewer', 'FCHS',
                                        'media.read', v_sf_ph)), 'not_found', 'ticket: another school''s photo is refused');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, %L, null)', 'sapi-fchs-reviewer', 'SFHS',
                                        'media.read', v_sf_ph)), 'forbidden', 'ticket: no membership at SFHS');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, %L, null)', 'sapi-fchs-reviewer', 'FCHS',
                                        'media.read', (pg_temp.photos(v_raw))[1])), 'not_found',
                     'ticket: raw uploads are never readable');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, null, %L)', 'sapi-fchs-reviewer', 'FCHS',
                                        'map.read', v_draft)), 'forbidden', 'ticket: map.read is school_admin');
  r := pg_temp.ticket('sapi-fchs-admin', 'FCHS', 'map.upload', null, v_draft);
  perform pg_temp.ok(r->>'ticketId' is not null, 'ticket: map.upload on a draft');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, null, %L)', 'sapi-fchs-admin', 'FCHS',
                                        'map.upload', pg_temp.map('FCHS'))), 'state_changed/approval_status',
                     'ticket: map.upload only on drafts');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, null, %L)', 'sapi-fchs-admin', 'SFHS',
                                        'map.read', v_draft)), 'forbidden', 'ticket: FCHS admin at SFHS');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, null, %L)', 'sapi-fchs-admin', 'FCHS',
                                        'map.activate', v_pending)), 'forbidden', 'ticket: map.activate is district_admin');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, null, %L)', 'sapi-district', 'FCHS',
                                        'map.activate', v_draft)), 'state_changed/approval_status',
                     'ticket: map.activate needs pending_district');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, null, %L)', 'sapi-district', 'FCHS',
                                        'map.activate', v_nozone)), 'state_changed/no_zones',
                     'ticket: map.activate needs a complete package');
  r := pg_temp.ticket('sapi-district', 'FCHS', 'map.activate', null, v_pending);
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.media_tickets where id = %L
                                         and operation = 'map.activate' and map_version_id = %L$f$,
                                      r->>'ticketId', v_pending)) = 1, 'ticket: map.activate row');
  r := pg_temp.ticket('sapi-district', null, 'map.activate', null, v_pending);
  perform pg_temp.ok(r->>'ticketId' is not null, 'ticket: map.activate without a school code');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.ticket(%L, %L, %L, %L, null)', 'sapi-fchs-reviewer', 'FCHS',
                                        'queue.read', v_ph)), 'invalid_input/operation', 'ticket: operation list');
end $$;

-- =====================================================================================================
-- 13. lost reports, staff view (G-43)
-- =====================================================================================================
do $$
declare
  v_rep uuid := pg_temp.mk_report('FCHS');
  r jsonb;
  x jsonb;
  rv bigint;
begin
  r := pg_temp.reports('sapi-fchs-reviewer', 'FCHS');
  select e into x from jsonb_array_elements(r->'reports') e where e->>'id' = v_rep::text;
  perform pg_temp.ok(x is not null, 'reports: open report listed');
  perform pg_temp.ok(x ?& array['id', 'category', 'description', 'pin', 'mapVersionId', 'createdAt', 'matchCount', 'status',
                                'rowVersion'] and (select count(*) from jsonb_object_keys(x)) = 9,
                     'reports: exactly the contract keys (no device data)');
  perform pg_temp.eq(pg_temp.err($q$select pg_temp.reports('sapi-sfhs-admin', 'FCHS')$q$), 'forbidden',
                     'reports: other-school staff');
  rv := (x->>'rowVersion')::bigint;
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.report_close(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v_rep,
                                        rv + 1)), 'state_changed/row_version', 'report close: row version');
  r := pg_temp.report_close('sapi-fchs-reviewer', 'FCHS', v_rep, rv);
  perform pg_temp.eq(r->>'status', 'closed_by_staff', 'report close: closed_by_staff');
  perform pg_temp.ok(pg_temp.n(format($f$select count(*) from public.lost_reports
                                         where id = %L and terminal_at is not null$f$, v_rep)) = 1, 'report close: terminal_at');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.report_close(%L, %L, %L, %s)', 'sapi-fchs-reviewer', 'FCHS', v_rep,
                                        (r->>'rowVersion')::bigint)), 'state_changed/status', 'report close: once');
end $$;

-- =====================================================================================================
-- 14. custody list: expected arrivals, at location, disposition due (§5.4 custody page)
-- =====================================================================================================
do $$
declare
  v_a uuid := pg_temp.loc('SFHS', 'A');
  e1 uuid := pg_temp.mk_item('SFHS', 'A', 'pending', 'hidden', 'with_finder');
  e2 uuid := pg_temp.mk_item('SFHS', 'A', 'approved', 'published', 'with_finder', '{public_ready}');
  e3 uuid := pg_temp.mk_item('SFHS', 'A', 'pending', 'hidden', 'with_finder');
  eq uuid := pg_temp.mk_item('SFHS', 'A', 'pending', 'hidden', 'with_finder');
  d0 uuid := pg_temp.mk_item('SFHS', 'A', 'draft', 'hidden', 'with_finder', '{uploaded}');
  a1 uuid := pg_temp.mk_item('SFHS', 'A', 'approved', 'hidden', 'at_location');
  a2 uuid := pg_temp.mk_item('SFHS', 'A', 'pending', 'hidden', 'at_location');
  adel uuid := pg_temp.mk_item('SFHS', 'A', 'approved', 'hidden', 'at_location');
  due1 uuid := pg_temp.mk_item('SFHS', 'A', 'approved', 'hidden', 'at_location');
  due2 uuid := pg_temp.mk_item('SFHS', 'A', 'approved', 'hidden', 'at_location');
  am uuid := pg_temp.mk_item('SFHS', 'M', 'approved', 'hidden', 'at_location');
  r jsonb;
begin
  perform pg_temp.exec(format($f$
    update public.items set arrival_deadline_at = now() + interval '2 days' where id = %L;
    update public.items set arrival_deadline_at = now() + interval '1 day' where id = %L;
    update public.items set arrival_deadline_at = null where id = %L;
    update public.items set arrival_deadline_at = now() + interval '3 days', screening_status = 'flagged',
                            screening_flags = '{"quarantine": true}' where id = %L;
    update public.items set received_at = now() - interval '1 hour' where id = %L;
    update public.items set received_at = now() - interval '3 days' where id = %L;
    update public.items set deleted_at = now() where id = %L;
    update public.items set received_at = now() - interval '40 days', disposition_due_at = now() - interval '2 days'
     where id = %L;
    update public.items set received_at = now() - interval '35 days', disposition_due_at = now() - interval '1 day'
     where id = %L;$f$, e1, e2, e3, eq, a1, a2, adel, due1, due2));

  -- office (sapi-multi at SFHS): no quarantined rows
  r := pg_temp.custody('sapi-multi', 'SFHS', v_a);
  perform pg_temp.eq((select string_agg(x->>'id', ',' order by n) from jsonb_array_elements(r->'expected')
                        with ordinality as t(x, n)), concat_ws(',', e2, e1, e3),
                     'custody: expected by arrival deadline, nulls last; no draft; no quarantine for office');
  perform pg_temp.eq((select string_agg(x->>'id', ',' order by n) from jsonb_array_elements(r->'atLocation')
                        with ordinality as t(x, n)), concat_ws(',', a1, a2, due2, due1),
                     'custody: at location newest received first; deleted excluded');
  perform pg_temp.eq((select string_agg(x->>'id', ',' order by n) from jsonb_array_elements(r->'dispositionDue')
                        with ordinality as t(x, n)), concat_ws(',', due1, due2), 'custody: disposition due oldest first');
  perform pg_temp.eq((select string_agg(k, ',' order by k) from jsonb_object_keys(r#>'{atLocation,0}') k),
                     (select string_agg(k, ',' order by k)
                        from jsonb_object_keys(pg_temp.get('sapi-multi', 'SFHS', a1)) k),
                     'custody: rows are StaffItemRow (same keys as item_get)');
  perform pg_temp.eq(r#>>'{atLocation,0,rowVersion}', (pg_temp.rv(a1))::text, 'custody: row version for the next action');

  -- school_admin sees the quarantined arrival; no location filter spans the school
  r := pg_temp.custody('sapi-sfhs-admin', 'SFHS', v_a);
  perform pg_temp.eq((select string_agg(x->>'id', ',' order by n) from jsonb_array_elements(r->'expected')
                        with ordinality as t(x, n)), concat_ws(',', e2, e1, eq, e3), 'custody: quarantine for school_admin');
  r := pg_temp.custody('sapi-sfhs-admin', 'SFHS', null);
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(r->'atLocation') x where x->>'id' = am::text)
                     and exists (select 1 from jsonb_array_elements(r->'atLocation') x where x->>'id' = a1::text),
                     'custody: no filter covers every location');
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(r->'expected') x where x->>'id' = d0::text),
                     'custody: drafts never listed');

  perform pg_temp.eq(pg_temp.err(format('select pg_temp.custody(%L, %L, %L)', 'sapi-sfhs-admin', 'SFHS',
                                        pg_temp.loc('FCHS', 'W'))), 'invalid_input/location_id',
                     'custody: location must belong to the school');
  perform pg_temp.eq(pg_temp.err(format('select pg_temp.custody(%L, %L, null)', 'sapi-fchs-reviewer', 'SFHS')),
                     'forbidden', 'custody: other-school staff');
  perform pg_temp.eq(pg_temp.err(format('select public.api_staff_custody_list(pg_temp.a(%L, %L, %L, %L, null, %L), %L, null)',
                                        'sapi-multi', 'SFHS', 'item.read', a1,
                                        jsonb_build_object('school_code', 'SFHS', 'location_id', null), 'SFHS')),
                     'assertion_invalid', 'custody: target must be null');
end $$;

-- =====================================================================================================
-- 15. surface: every audit row written above is free of forbidden keys; login role has no table access
-- =====================================================================================================
do $$
begin
  perform pg_temp.ok(pg_temp.n($q$select count(distinct a.action) from public.audit_log a
                                  where a.created_at = now() and a.action in (
                                    'identity.bind', 'staff.activate', 'item.approve', 'item.reject', 'item.receive',
                                    'item.receive_late', 'item.transfer', 'item.claim', 'item.dispose', 'item.pull',
                                    'item.delete', 'item.edit', 'item.confirm_publish', 'item.photo_drop', 'item.create',
                                    'item.complete', 'device.block', 'device.unblock', 'report.close')$q$) = 19,
                     'audit: every action of this family was exercised');
  perform pg_temp.ok(pg_temp.n($q$select count(*) from public.audit_log a
                                  cross join lateral (values (a.state_before), (a.state_after), (a.metadata)) as j(v)
                                  cross join lateral jsonb_object_keys(j.v) as k(key)
                                  where a.created_at = now()
                                    and (k.key in ('description', 'note', 'location_note_private', 'email', 'display_name',
                                                   'google_sub', 'pin', 'pin_x', 'pin_y', 'device_token_hash', 'digest',
                                                   'token', 'body')
                                         or k.key like '%path%')$q$) = 0,
                     'audit: allowlisted keys only (F-74)');
  perform pg_temp.ok(pg_temp.err('select count(*) from public.items') like 'sqlstate 42501%', 'recover_web cannot read items');
  perform pg_temp.ok(pg_temp.err($q$select private.sapi_result(null::public.items)$q$) like 'sqlstate 42501%',
                     'recover_web cannot call private helpers');
end $$;

reset role;
select 'api_staff.sql: all tests passed' as result;
rollback;
