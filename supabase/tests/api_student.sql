-- Student and public API family (BUILD-CONTRACT 6.1; migration 0200_api_student.sql).
-- Run: psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/api_student.sql
-- Everything runs in one transaction that is rolled back; no seed row changes survive. Every API call is
-- made after `set local role recover_web`, so the EXECUTE grants (and the absence of table grants) are what
-- is exercised. The Supabase `postgres` role is not a superuser, so the transaction first grants itself
-- membership in recover_web (rolled back with everything else). Fixture rows are inserted as postgres.
\set ON_ERROR_STOP 1
begin;
set local lock_timeout = '10s';
grant recover_web to postgres;

-- Run p_sql as the current role and require an RV001 error with code p_code (and detail p_detail when given).
-- Returns the detail so callers can inspect retry seconds.
create function pg_temp.expect_error(p_sql text, p_code text, p_detail text default null) returns text
language plpgsql as $$
declare
  v_msg text;
  v_detail text;
begin
  begin
    execute p_sql;
  exception when sqlstate 'RV001' then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    if v_msg is distinct from p_code or (p_detail is not null and v_detail is distinct from p_detail) then
      raise exception 'FAIL expected %/% but got %/% from: %', p_code, coalesce(p_detail, '*'), v_msg, v_detail, p_sql;
    end if;
    return v_detail;
  end;
  raise exception 'FAIL expected % but the call succeeded: %', p_code, p_sql;
end $$;

-- Sorted key set of a JSON object, for DTO allowlist assertions (§7.2: adding a key is a privacy review).
create function pg_temp.keys(p jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k collate "C"), '') from jsonb_object_keys(p) as k
$$;

-- ---------------------------------------------------------------------------------------------------
-- Fixtures (as postgres). Seed ids: FCHS 0a0a..01, SFHS 0b0b..02, NFMS 0c0c..03 (NFMS: no lost reports,
-- no cross-school search). Device digests are 33 bytes: 0x01 || 32 bytes.
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_sfhs constant uuid := '0b0b0b0b-0000-4000-8000-000000000002';
  v_nfms constant uuid := '0c0c0c0c-0000-4000-8000-000000000003';
  v_map constant uuid := '0a0a0a0a-2000-4000-8000-000000000001';
  v_office constant uuid := '00000000-5b00-4000-8000-000000000003';
  v_zone uuid;
begin
  select z.id into strict v_zone from public.map_zones z where z.map_version_id = v_map and z.name = 'Cafeteria';

  -- F1: published, with the finder, zone Cafeteria; its staff-only pin and note must never surface.
  insert into public.items (id, school_id, public_id, category, description, location_note_private, zone_id,
                            map_version_id, pin_x, pin_y, dropoff_location_id, review_status, publication_status,
                            custody, posted_by_kind, posted_by_staff_id, reviewed_at, found_at, created_at)
  values ('f1000000-0000-4000-8000-000000000001', v_fchs, 'FCHS-E-990001', 'bottle', 'Blue water bottle with stickers',
          'C214', v_zone, v_map, 0.62, 0.35, '0a0a0a0a-1000-4000-8000-000000000002', 'approved', 'published',
          'with_finder', 'staff', v_office, now(), now() - interval '2 hours', now() - interval '2 hours');
  -- F2: published, received at W, accented description.
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, current_location_id,
                            received_at, review_status, publication_status, custody, posted_by_kind,
                            posted_by_staff_id, reviewed_at, found_at, created_at)
  values ('f1000000-0000-4000-8000-000000000002', v_fchs, 'FCHS-W-990002', 'other', 'Estuche con lápiz amarillo',
          '0a0a0a0a-1000-4000-8000-000000000001', '0a0a0a0a-1000-4000-8000-000000000001', now(), 'approved',
          'published', 'at_location', 'staff', v_office, now(), now() - interval '3 hours', now() - interval '3 hours');
  -- F3: pending student post; never visible anywhere.
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            publication_status, custody, posted_by_kind, device_token_hash, created_at)
  values ('f1000000-0000-4000-8000-000000000003', v_fchs, 'FCHS-E-990003', 'bottle', 'Green water bottle pending review',
          '0a0a0a0a-1000-4000-8000-000000000002', 'pending', 'hidden', 'with_finder', 'student',
          decode('01' || repeat('d2', 32), 'hex'), now() - interval '1 hour');
  -- F4 at SFHS (opted in to cross-school search) and F5 at NFMS (not opted in).
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            publication_status, custody, posted_by_kind, posted_by_staff_id, reviewed_at, created_at)
  values ('f1000000-0000-4000-8000-000000000004', v_sfhs, 'SFHS-M-990004', 'bottle', 'Red water bottle near the gym',
          '0b0b0b0b-1000-4000-8000-000000000001', 'approved', 'published', 'with_finder', 'staff',
          '00000000-5b00-4000-8000-000000000007', now(), now() - interval '4 hours'),
         ('f1000000-0000-4000-8000-000000000005', v_nfms, 'NFMS-F-990005', 'bottle', 'Purple water bottle',
          '0c0c0c0c-1000-4000-8000-000000000001', 'approved', 'published', 'with_finder', 'staff',
          '00000000-5b00-4000-8000-000000000008', now(), now() - interval '4 hours');
  -- P01..P35: published sports items dated in 2031, isolated from any other data by the `since` filter.
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            publication_status, custody, posted_by_kind, posted_by_staff_id, reviewed_at, created_at)
  select ('f2000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, v_fchs,
         'FCHS-STUB-9901' || lpad(n::text, 2, '0'), 'sports', 'Soccer ball number ' || n,
         '0a0a0a0a-1000-4000-8000-000000000003', 'approved', 'published', 'with_finder', 'staff', v_office, now(),
         timestamptz '2031-01-01 00:00:00+00' + make_interval(mins => n)
    from generate_series(1, 35) as n;

  -- Current public_ready photo generations (F1 has two slots; positions inserted in reverse order).
  insert into public.item_photos (school_id, item_id, position, generation, is_current, original_path, review_path,
                                  thumb_path, medium_path, public_object_token, width, height, status)
  select i.school_id, i.id, g.pos, 1, true,
         i.school_id::text || '/' || i.id::text || '/p' || g.pos || '/canonical.jpg',
         i.school_id::text || '/' || i.id::text || '/p' || g.pos || '/review.jpg',
         i.school_id::text || '/' || i.id::text || '/p' || g.pos || '/thumb.jpg',
         i.school_id::text || '/' || i.id::text || '/p' || g.pos || '/medium.jpg',
         decode(repeat('ab', 16), 'hex'), 1200, 900, 'public_ready'
    from public.items i
    cross join lateral generate_series(case when i.public_id = 'FCHS-E-990001' then 1 else 0 end, 0, -1) as g(pos)
   where i.id in ('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002',
                  'f1000000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000005')
      or i.public_id like 'FCHS-STUB-9901%';

  -- D3 is blocked at FCHS by staff.
  insert into public.devices (school_id, token_hash, blocked_until, block_reason)
  values (v_fchs, decode('01' || repeat('d3', 32), 'hex'), now() + interval '1 day', 'staff');

  -- ZTST: a school with every student feature switched off, created only inside this transaction.
  insert into public.schools (id, code, name, student_posting_enabled, lost_reports_enabled, cross_school_search_enabled)
  values ('fa000000-0000-4000-8000-0000000000aa', 'ZTST', 'Test School With Features Off', false, false, false);
  insert into public.locations (id, school_id, code, name)
  values ('fa000000-1000-4000-8000-0000000000aa', 'fa000000-0000-4000-8000-0000000000aa', 'O', 'Office');

  raise notice 'PASS fixtures inserted';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Structure: owner, SECURITY DEFINER, empty search_path, EXECUTE only for recover_web.
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_expected constant text[] := array[
    'api_close_lost_report', 'api_complete_item', 'api_create_item_draft', 'api_create_lost_report',
    'api_device_touch', 'api_get_feed', 'api_get_item', 'api_get_meta', 'api_get_staff_domains', 'api_health',
    'api_idempotency_begin', 'api_idempotency_finish', 'api_item_status', 'api_mark_report_seen', 'api_my_items',
    'api_my_lost_reports', 'api_rate_take', 'api_record_error', 'api_record_high_value_redirect', 'api_search',
    'api_search_all'];
  r record;
  n int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = any (v_expected)
  loop
    n := n + 1;
    if r.owner <> 'recover_api_owner' or not r.prosecdef or not (r.proconfig @> array['search_path=""']) then
      raise exception 'FAIL % owner/secdef/search_path: % % %', r.proname, r.owner, r.prosecdef, r.proconfig;
    end if;
    if not has_function_privilege('recover_web', r.oid, 'execute')
       or has_function_privilege('recover_worker', r.oid, 'execute')
       or has_function_privilege('anon', r.oid, 'execute')
       or has_function_privilege('authenticated', r.oid, 'execute')
       or has_function_privilege('service_role', r.oid, 'execute') then
      raise exception 'FAIL % execute grants are not exactly recover_web', r.proname;
    end if;
  end loop;
  if n <> cardinality(v_expected) then
    raise exception 'FAIL expected % api functions (one signature each), found %', cardinality(v_expected), n;
  end if;
  raise notice 'PASS structure: % functions, owner recover_api_owner, definer, search_path, EXECUTE only recover_web', n;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- recover_web holds no table, view, or private-schema privileges.
-- ---------------------------------------------------------------------------------------------------
do $$
begin
  set local role recover_web;
  begin
    perform 1 from public.items limit 1;
    raise exception 'FAIL recover_web can select public.items';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.visible_items limit 1;
    raise exception 'FAIL recover_web can select public.visible_items';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.public_items limit 1;
    raise exception 'FAIL recover_web can select public.public_items';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.lost_reports limit 1;
    raise exception 'FAIL recover_web can select public.lost_reports';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.devices limit 1;
    raise exception 'FAIL recover_web can select public.devices';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.search_events (school_id, query_hmac, result_count, purge_after)
    values ('0a0a0a0a-0000-4000-8000-000000000001', '\x00', 0, now());
    raise exception 'FAIL recover_web can insert public.search_events';
  exception when insufficient_privilege then null;
  end;
  begin
    perform private.fail('internal');
    raise exception 'FAIL recover_web can call private.fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform private.student_query_norm('x');
    raise exception 'FAIL recover_web can call private.student_query_norm';
  exception when insufficient_privilege then null;
  end;
  reset role;
  raise notice 'PASS recover_web cannot read or write tables and views, nor reach schema private';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_get_meta
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v jsonb;
  v_nfms jsonb;
  v_w jsonb;
begin
  set local role recover_web;
  v := public.api_get_meta(p_school_code => 'fchs');  -- the code is normalized (trim, upper)
  v_nfms := public.api_get_meta(p_school_code => 'NFMS');
  perform pg_temp.expect_error($q$select public.api_get_meta('ZZZZ')$q$, 'not_found');
  reset role;

  if pg_temp.keys(v) <> 'locations,map,school,zones'
     or pg_temp.keys(v->'school') <> 'code,enabledCategories,flags,id,name,timezone'
     or pg_temp.keys(v->'school'->'flags') <> 'crossSchoolSearch,lostReports,studentPosting'
     or pg_temp.keys(v->'map') <> 'height,path,versionId,width' then
    raise exception 'FAIL meta key sets: %', v;
  end if;
  if v->'school'->>'id' <> '0a0a0a0a-0000-4000-8000-000000000001' or v->'school'->>'code' <> 'FCHS'
     or v->'school'->>'timezone' <> 'America/New_York'
     or v->'school'->'flags' <> '{"studentPosting": true, "lostReports": true, "crossSchoolSearch": true}'::jsonb
     or not (v->'school'->'enabledCategories' ? 'bottle') or (v->'school'->'enabledCategories' ? 'phone') then
    raise exception 'FAIL meta school block: %', v->'school';
  end if;
  if v->'map'->>'versionId' <> '0a0a0a0a-2000-4000-8000-000000000001' or (v->'map'->>'width')::int <> 1600
     or (v->'map'->>'height')::int <> 1000 or v->'map'->>'path' not like '0a0a0a0a-0000-4000-8000-000000000001/%' then
    raise exception 'FAIL meta map: %', v->'map';
  end if;
  select e into v_w from jsonb_array_elements(v->'locations') e where e->>'code' = 'W';
  if jsonb_array_length(v->'locations') < 3 or pg_temp.keys(v_w) <> 'code,hours,id,name,pin'
     or v_w->'pin' <> '{"x": 0.12, "y": 0.30}'::jsonb then
    raise exception 'FAIL meta locations: %', v->'locations';
  end if;
  if jsonb_array_length(v->'zones') <> 5 or pg_temp.keys(v->'zones'->0) <> 'cx,cy,id,name,radius' then
    raise exception 'FAIL meta zones: %', v->'zones';
  end if;
  if v_nfms->'school'->'flags' <> '{"studentPosting": true, "lostReports": false, "crossSchoolSearch": false}'::jsonb then
    raise exception 'FAIL meta flags are not the school switches ANDed with the district switches: %', v_nfms->'school'->'flags';
  end if;
  raise notice 'PASS api_get_meta shape, flags, active map, location pins, zones; unknown school is not_found';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_get_feed: keyset pagination, filters, visibility
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v1 jsonb;
  v2 jsonb;
  v_loc jsonb;
  v_cat jsonb;
  v_sfhs jsonb;
  v_ids1 text[];
  v_ids2 text[];
  v_since constant timestamptz := '2031-01-01 00:00:00+00';
begin
  set local role recover_web;
  v1 := public.api_get_feed(p_school_code => 'FCHS', p_category => 'sports', p_since => v_since);
  v2 := public.api_get_feed(p_school_code => 'FCHS', p_cursor_created => (v1->'nextCursor'->>'createdAt')::timestamptz,
                            p_cursor_id => (v1->'nextCursor'->>'id')::uuid, p_category => 'sports', p_since => v_since);
  v_loc := public.api_get_feed(p_school_code => 'FCHS', p_location_id => '0a0a0a0a-1000-4000-8000-000000000001');
  v_cat := public.api_get_feed(p_school_code => 'FCHS', p_category => 'other');
  v_sfhs := public.api_get_feed(p_school_code => 'SFHS');
  perform pg_temp.expect_error($q$select public.api_get_feed(p_school_code => 'FCHS', p_cursor_id => 'f2000000-0000-4000-8000-000000000001')$q$,
                               'invalid_input', 'cursor');
  perform pg_temp.expect_error($q$select public.api_get_feed(p_school_code => 'FCHS', p_category => 'spaceship')$q$,
                               'invalid_input', 'category');
  reset role;

  v_ids1 := array(select e->>'publicId' from jsonb_array_elements(v1->'items') with ordinality as x(e, o) order by o);
  v_ids2 := array(select e->>'publicId' from jsonb_array_elements(v2->'items') with ordinality as x(e, o) order by o);
  if cardinality(v_ids1) <> 30 or v_ids1[1] <> 'FCHS-STUB-990135' or v_ids1[30] <> 'FCHS-STUB-990106' then
    raise exception 'FAIL feed page 1: %', v_ids1;
  end if;
  if v1->'nextCursor'->>'id' <> 'f2000000-0000-4000-8000-000000000006'
     or (v1->'nextCursor'->>'createdAt')::timestamptz <> v_since + interval '6 minutes' then
    raise exception 'FAIL feed nextCursor: %', v1->'nextCursor';
  end if;
  if v_ids2 <> array['FCHS-STUB-990105', 'FCHS-STUB-990104', 'FCHS-STUB-990103', 'FCHS-STUB-990102', 'FCHS-STUB-990101']
     or jsonb_typeof(v2->'nextCursor') <> 'null' or v_ids1 && v_ids2 then
    raise exception 'FAIL feed page 2: % next %', v_ids2, v2->'nextCursor';
  end if;
  if pg_temp.keys(v1->'items'->0)
       <> 'category,custody,description,foundAt,id,locationId,photos,publicId,receivedAt,rowVersion,zoneName'
     or pg_temp.keys(v1->'items'->0->'photos'->0) <> 'height,mediumPath,position,thumbPath,width' then
    raise exception 'FAIL feed PublicItemRow key set: %', v1->'items'->0;
  end if;
  -- location filter uses coalesce(current, dropoff): F2 was received at W; F1 is being brought to E.
  if not exists (select 1 from jsonb_array_elements(v_loc->'items') e where e->>'publicId' = 'FCHS-W-990002')
     or exists (select 1 from jsonb_array_elements(v_loc->'items') e where e->>'publicId' in ('FCHS-E-990001', 'FCHS-E-990003')) then
    raise exception 'FAIL feed location filter: %', v_loc;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_cat->'items') e where e->>'publicId' = 'FCHS-W-990002')
     or exists (select 1 from jsonb_array_elements(v_cat->'items') e where e->>'category' <> 'other') then
    raise exception 'FAIL feed category filter: %', v_cat;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_sfhs->'items') e where e->>'publicId' = 'SFHS-M-990004')
     or exists (select 1 from jsonb_array_elements(v_sfhs->'items') e where e->>'publicId' like 'FCHS-%') then
    raise exception 'FAIL feed crosses schools: %', v_sfhs;
  end if;
  raise notice 'PASS api_get_feed: 30 per page, nextCursor keyset, filters, school isolation, DTO key set';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_get_item
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  set local role recover_web;
  v := public.api_get_item(p_school_code => 'FCHS', p_public_id => ' fchs-e-990001 ');
  perform pg_temp.expect_error($q$select public.api_get_item('FCHS', 'FCHS-E-990003')$q$, 'not_found');  -- pending
  perform pg_temp.expect_error($q$select public.api_get_item('SFHS', 'FCHS-E-990001')$q$, 'not_found');  -- other school
  perform pg_temp.expect_error($q$select public.api_get_item('FCHS', 'bogus')$q$, 'invalid_input', 'public_id');
  reset role;

  if pg_temp.keys(v)
       <> 'category,custody,description,foundAt,id,location,locationId,photos,publicId,receivedAt,rowVersion,zoneName'
     or pg_temp.keys(v->'location') <> 'hours,id,name' then
    raise exception 'FAIL listing key set (no pin, note, device or screening field allowed): %', v;
  end if;
  if v->>'id' <> 'f1000000-0000-4000-8000-000000000001' or v->>'zoneName' <> 'Cafeteria'
     or v->>'custody' <> 'with_finder' or v->>'locationId' <> '0a0a0a0a-1000-4000-8000-000000000002'
     or v->'location'->>'name' <> 'East Front Office' or jsonb_typeof(v->'receivedAt') <> 'null' then
    raise exception 'FAIL listing values: %', v;
  end if;
  if jsonb_array_length(v->'photos') <> 2 or (v->'photos'->0->>'position')::int <> 0
     or (v->'photos'->1->>'position')::int <> 1
     or v->'photos'->0->>'thumbPath' <> '0a0a0a0a-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000001/p0/thumb.jpg' then
    raise exception 'FAIL listing photos are not current public_ready slots ordered by position: %', v->'photos';
  end if;
  raise notice 'PASS api_get_item: listing DTO, zone name, ordered photos; pending/other-school not_found';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_search (G-22): synonyms, accents, trigram typos, filters, telemetry
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_qh constant bytea := decode(repeat('5e', 32), 'hex');
  v_syn jsonb;
  v_acc jsonb;
  v_acc2 jsonb;
  v_typo jsonb;
  v_cat jsonb;
  v_loc_e jsonb;
  v_loc_w jsonb;
  v_stop jsonb;
  v_n int;
begin
  set local role recover_web;
  v_syn := public.api_search(p_school_code => 'FCHS', p_q => 'hydroflask', p_query_hmac => v_qh);
  v_acc := public.api_search(p_school_code => 'FCHS', p_q => 'lapiz', p_query_hmac => v_qh);
  v_acc2 := public.api_search(p_school_code => 'FCHS', p_q => '  LÁPIZ ', p_query_hmac => v_qh);
  v_typo := public.api_search(p_school_code => 'FCHS', p_q => 'bottel', p_query_hmac => v_qh);
  v_cat := public.api_search(p_school_code => 'FCHS', p_q => 'water bottle', p_category => 'other', p_query_hmac => v_qh);
  v_loc_e := public.api_search(p_school_code => 'FCHS', p_q => 'water bottle',
                               p_location_id => '0a0a0a0a-1000-4000-8000-000000000002', p_query_hmac => v_qh);
  v_loc_w := public.api_search(p_school_code => 'FCHS', p_q => 'water bottle',
                               p_location_id => '0a0a0a0a-1000-4000-8000-000000000001', p_query_hmac => v_qh);
  v_stop := public.api_search(p_school_code => 'FCHS', p_q => 'the', p_query_hmac => v_qh);
  perform pg_temp.expect_error($q$select public.api_search(p_school_code => 'FCHS', p_q => '   ', p_query_hmac => '\x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e')$q$,
                               'invalid_input', 'q');
  perform pg_temp.expect_error($q$select public.api_search(p_school_code => 'FCHS', p_q => 'bottle')$q$,
                               'invalid_input', 'query_hmac');
  reset role;

  if not exists (select 1 from jsonb_array_elements(v_syn->'items') e where e->>'publicId' = 'FCHS-E-990001') then
    raise exception 'FAIL synonym hydroflask did not find the published water bottle: %', v_syn;
  end if;
  if exists (select 1 from jsonb_array_elements(v_syn->'items') e
              where e->>'publicId' in ('FCHS-E-990003', 'SFHS-M-990004', 'NFMS-F-990005')) then
    raise exception 'FAIL search returned a pending or other-school item: %', v_syn;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_acc->'items') e where e->>'publicId' = 'FCHS-W-990002')
     or not exists (select 1 from jsonb_array_elements(v_acc2->'items') e where e->>'publicId' = 'FCHS-W-990002') then
    raise exception 'FAIL accent-insensitive search (lapiz / LÁPIZ -> lápiz): % / %', v_acc, v_acc2;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_typo->'items') e where e->>'publicId' = 'FCHS-E-990001') then
    raise exception 'FAIL trigram typo search (bottel): %', v_typo;
  end if;
  if exists (select 1 from jsonb_array_elements(v_cat->'items') e where e->>'category' <> 'other') then
    raise exception 'FAIL search category filter: %', v_cat;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_loc_e->'items') e where e->>'publicId' = 'FCHS-E-990001')
     or exists (select 1 from jsonb_array_elements(v_loc_w->'items') e where e->>'publicId' = 'FCHS-E-990001') then
    raise exception 'FAIL search location filter: % / %', v_loc_e, v_loc_w;
  end if;
  if jsonb_array_length(v_stop->'items') <> 0 then
    raise exception 'FAIL a stop-word-only query should return no items: %', v_stop;
  end if;
  if pg_temp.keys(v_syn->'items'->0)
       <> 'category,custody,description,foundAt,id,locationId,photos,publicId,receivedAt,rowVersion,zoneName' then
    raise exception 'FAIL search PublicItemRow key set: %', v_syn->'items'->0;
  end if;

  select count(*) into v_n
    from public.search_events s
   where s.school_id = '0a0a0a0a-0000-4000-8000-000000000001' and s.query_hmac = v_qh
     and s.redacted_query is null and s.purge_after = now() + interval '90 days';
  if v_n <> 8 then
    raise exception 'FAIL expected 8 search_events rows (hmac, no redacted text, 90 d purge), got %', v_n;
  end if;
  if not exists (select 1 from public.search_events s
                  where s.school_id = '0a0a0a0a-0000-4000-8000-000000000001' and s.query_hmac = v_qh
                    and s.result_count = 0)
     or not exists (select 1 from public.search_events s
                     where s.school_id = '0a0a0a0a-0000-4000-8000-000000000001' and s.query_hmac = v_qh
                       and s.result_count >= 1) then
    raise exception 'FAIL search_events result_count not recorded';
  end if;
  raise notice 'PASS api_search: synonym, accent, typo, filters, visibility, telemetry';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_search_all (F-79)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v jsonb;
begin
  set local role recover_web;
  v := public.api_search_all(p_from_code => 'FCHS', p_q => 'water bottle', p_query_hmac => decode(repeat('5f', 32), 'hex'));
  perform pg_temp.expect_error($q$select public.api_search_all('NFMS', 'water bottle', '\x5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f')$q$,
                               'feature_disabled');
  perform pg_temp.expect_error($q$select public.api_search_all('ZTST', 'water bottle', '\x5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f')$q$,
                               'feature_disabled');
  reset role;

  if not exists (select 1 from jsonb_array_elements(v->'items') e where e->>'publicId' = 'FCHS-E-990001' and e->>'schoolCode' = 'FCHS')
     or not exists (select 1 from jsonb_array_elements(v->'items') e where e->>'publicId' = 'SFHS-M-990004' and e->>'schoolCode' = 'SFHS') then
    raise exception 'FAIL search_all misses opted-in schools: %', v;
  end if;
  if exists (select 1 from jsonb_array_elements(v->'items') e where e->>'publicId' in ('NFMS-F-990005', 'FCHS-E-990003')) then
    raise exception 'FAIL search_all returned an opted-out school or a pending item: %', v;
  end if;
  if pg_temp.keys(v->'items'->0)
       <> 'category,custody,description,foundAt,id,locationId,photos,publicId,receivedAt,rowVersion,schoolCode,zoneName' then
    raise exception 'FAIL search_all key set: %', v->'items'->0;
  end if;
  raise notice 'PASS api_search_all: source and each target opt-in required, schoolCode added';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_device_touch
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_blocked jsonb;
  v_new jsonb;
begin
  set local role recover_web;
  v_blocked := public.api_device_touch('FCHS', decode('01' || repeat('d3', 32), 'hex'));
  v_new := public.api_device_touch('FCHS', decode('01' || repeat('d5', 32), 'hex'));
  perform pg_temp.expect_error($q$select public.api_device_touch('FCHS', '\x01')$q$, 'invalid_input', 'device_digest');
  reset role;
  if (v_blocked->>'blocked')::boolean is not true or jsonb_typeof(v_blocked->'blockedUntil') <> 'string'
     or (v_new->>'blocked')::boolean is not false or jsonb_typeof(v_new->'blockedUntil') <> 'null' then
    raise exception 'FAIL device_touch: % / %', v_blocked, v_new;
  end if;
  if not exists (select 1 from public.devices d where d.school_id = '0a0a0a0a-0000-4000-8000-000000000001'
                    and d.token_hash = decode('01' || repeat('d5', 32), 'hex')) then
    raise exception 'FAIL device_touch did not upsert the device row';
  end if;
  raise notice 'PASS api_device_touch: blocked state and upsert';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_rate_take (§13.2 fixed windows; G-39 tenant scope; NULL device = IP-only)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_scope constant text := 'school:0a0a0a0a-0000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_d2 constant bytea := decode('01' || repeat('d2', 32), 'hex');
  v_ip1 constant bytea := decode(repeat('11', 32), 'hex');
  v_ip2 constant bytea := decode(repeat('12', 32), 'hex');
  v_ip3 constant bytea := decode(repeat('13', 32), 'hex');
  v_detail text;
  v jsonb;
  i int;
begin
  set local role recover_web;
  -- device post_item: 3 per day
  for i in 1..3 loop
    v := public.api_rate_take('FCHS', 'post_item', v_d1, v_ip1, false);
  end loop;
  if v <> '{"ok": true}'::jsonb then
    raise exception 'FAIL rate_take result shape: %', v;
  end if;
  v_detail := pg_temp.expect_error(format('select public.api_rate_take(%L, %L, %L::bytea, %L::bytea, false)',
                                          'FCHS', 'post_item', v_d1, v_ip1), 'rate_limited');
  if v_detail::int not between 1 and 86400 then
    raise exception 'FAIL rate_limited detail must be retry seconds within the day window: %', v_detail;
  end if;
  -- lost_report: 1 per day per device
  perform public.api_rate_take('FCHS', 'lost_report', v_d1, v_ip1, false);
  perform pg_temp.expect_error(format('select public.api_rate_take(%L, %L, %L::bytea, %L::bytea, null)',
                                      'FCHS', 'lost_report', v_d1, v_ip1), 'rate_limited');
  -- status_poll: 30 per 10 minutes per device
  for i in 1..30 loop
    perform public.api_rate_take('FCHS', 'status_poll', v_d1, null, null);
  end loop;
  v_detail := pg_temp.expect_error(format('select public.api_rate_take(%L, %L, %L::bytea, null, null)',
                                          'FCHS', 'status_poll', v_d1), 'rate_limited');
  if v_detail::int not between 1 and 600 then
    raise exception 'FAIL status_poll retry seconds: %', v_detail;
  end if;
  -- NULL device (first visit): only the IP window applies. Off-campus search: 200 per 10 minutes.
  for i in 1..200 loop
    perform public.api_rate_take(p_school_code => 'FCHS', p_action => 'search', p_device_hmac => null,
                                 p_ip_hmac => v_ip2, p_on_campus => false);
  end loop;
  perform pg_temp.expect_error(format('select public.api_rate_take(%L, %L, null, %L::bytea, false)',
                                      'FCHS', 'search', v_ip2), 'rate_limited');
  -- the same address classified on-campus gets the 3,000 ceiling
  perform public.api_rate_take('FCHS', 'search', null, v_ip2, true);
  -- input validation
  perform pg_temp.expect_error($q$select public.api_rate_take('FCHS', 'post_item', null, null, false)$q$,
                               'invalid_input', 'ip_hmac');
  perform pg_temp.expect_error($q$select public.api_rate_take('FCHS', 'delete_everything', null, '\x1111111111111111111111111111111111', false)$q$,
                               'invalid_input', 'action');
  perform pg_temp.expect_error($q$select public.api_rate_take('FCHS', 'search', '\x01', null, false)$q$,
                               'invalid_input', 'device_hmac');
  perform pg_temp.expect_error($q$select public.api_rate_take('ZZZZ', 'search', null, '\x1111111111111111111111111111111111', false)$q$,
                               'not_found');
  reset role;

  -- counters: tenant scope derived in SQL, window label in the key, refused calls not counted
  if (select c.count from public.rate_counters c where c.tenant_scope = v_scope and c.action = 'post_item:1d'
        and c.subject_kind = 'device' and c.subject_hmac = v_d1) <> 3
     or (select c.count from public.rate_counters c where c.tenant_scope = v_scope and c.action = 'post_item:7d'
           and c.subject_kind = 'device' and c.subject_hmac = v_d1) <> 3
     or (select c.count from public.rate_counters c where c.tenant_scope = v_scope and c.action = 'post_item:1h'
           and c.subject_kind = 'ip' and c.subject_hmac = v_ip1) <> 3 then
    raise exception 'FAIL post_item counters are not 3/3/3 after one refused call';
  end if;
  if (select c.count from public.rate_counters c where c.tenant_scope = v_scope and c.action = 'search:10m'
        and c.subject_kind = 'ip' and c.subject_hmac = v_ip2) <> 201 then
    raise exception 'FAIL search IP counter should be 201 (200 off-campus + 1 on-campus)';
  end if;
  if exists (select 1 from public.rate_counters c where c.tenant_scope = v_scope and c.action = 'search:10m'
                and c.subject_kind = 'device') then
    raise exception 'FAIL a NULL device must not create a device counter';
  end if;

  -- the weekly window: a device with 6 posts this week is refused even on a fresh day window
  insert into public.rate_counters (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
  values (v_scope, 'post_item:7d', 'device', v_d2,
          date_bin(interval '7 days', now(), timestamptz '2001-01-01 00:00:00+00'), 6);
  set local role recover_web;
  perform pg_temp.expect_error(format('select public.api_rate_take(%L, %L, %L::bytea, %L::bytea, false)',
                                      'FCHS', 'post_item', v_d2, v_ip3), 'rate_limited');
  reset role;
  raise notice 'PASS api_rate_take: device day/week windows, lost_report, status_poll, IP-only for NULL device, campus split, validation';
end $$;

-- api_rate_take, the unauthenticated counters (0210, security review L1): high_value is school-scoped and
-- client_error school-less (district scope); both are per address only.
do $$
declare
  v_scope constant text := 'school:0a0a0a0a-0000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_ip4 constant bytea := decode(repeat('14', 32), 'hex');
  v_ip5 constant bytea := decode(repeat('15', 32), 'hex');
  v_detail text;
  i int;
begin
  set local role recover_web;
  -- high_value: 20 per 10 minutes per address, on or off campus
  for i in 1..20 loop
    perform public.api_rate_take('FCHS', 'high_value', null, v_ip4, (i % 2 = 0));
  end loop;
  v_detail := pg_temp.expect_error(format('select public.api_rate_take(%L, %L, null, %L::bytea, true)',
                                          'FCHS', 'high_value', v_ip4), 'rate_limited');
  if v_detail::int not between 1 and 600 then
    raise exception 'FAIL high_value retry seconds: %', v_detail;
  end if;
  -- client_error: no school, 60 per 10 minutes per address
  for i in 1..60 loop
    perform public.api_rate_take(null, 'client_error', null, v_ip4, null);
  end loop;
  perform pg_temp.expect_error(format('select public.api_rate_take(null, %L, null, %L::bytea, null)', 'client_error', v_ip4),
                               'rate_limited');
  perform public.api_rate_take(null, 'client_error', null, v_ip5, null);  -- another address has its own budget
  -- pairing and input rules
  perform pg_temp.expect_error(format('select public.api_rate_take(%L, %L, null, %L::bytea, null)', 'FCHS', 'client_error', v_ip5),
                               'invalid_input', 'school_code');
  perform pg_temp.expect_error(format('select public.api_rate_take(null, %L, null, %L::bytea, null)', 'high_value', v_ip5),
                               'not_found');
  perform pg_temp.expect_error(format('select public.api_rate_take(null, %L, null, %L::bytea, null)', 'search', v_ip5),
                               'not_found');
  perform pg_temp.expect_error(format('select public.api_rate_take(%L, %L, %L::bytea, null, null)', 'FCHS', 'high_value', v_d1),
                               'invalid_input', 'ip_hmac');
  perform pg_temp.expect_error(format('select public.api_rate_take(null, %L, %L::bytea, null, null)', 'client_error', v_d1),
                               'invalid_input', 'ip_hmac');
  perform pg_temp.expect_error($q$select public.api_rate_take(null, 'delete_everything', null, '\x1414141414141414141414141414141414', null)$q$,
                               'invalid_input', 'action');
  reset role;

  if (select c.count from public.rate_counters c where c.tenant_scope = v_scope and c.action = 'high_value:10m'
        and c.subject_kind = 'ip' and c.subject_hmac = v_ip4) <> 20 then
    raise exception 'FAIL high_value counter should be 20 (the refused call is not counted)';
  end if;
  if (select c.count from public.rate_counters c where c.tenant_scope = 'district' and c.action = 'client_error:10m'
        and c.subject_kind = 'ip' and c.subject_hmac = v_ip4) <> 60 then
    raise exception 'FAIL client_error counter should be 60 under the district scope';
  end if;
  if exists (select 1 from public.rate_counters c
              where (c.action like 'client\_error:%' and c.tenant_scope <> 'district')
                 or (c.action like 'high\_value:%' and c.subject_kind <> 'ip')) then
    raise exception 'FAIL client_error must be district-scoped and high_value per address only';
  end if;
  raise notice 'PASS api_rate_take: high_value per school and address, school-less client_error, pairing rules';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_idempotency_begin / _finish (F-77, G-39)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_p constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_k1 constant bytea := decode(repeat('a1', 32), 'hex');
  v_k2 constant bytea := decode(repeat('a2', 32), 'hex');
  v_r1 constant bytea := decode(repeat('b1', 32), 'hex');
  v_r2 constant bytea := decode(repeat('b2', 32), 'hex');
  v1 jsonb;
  v2 jsonb;
  v3 jsonb;
  v4 jsonb;
  v5 jsonb;
  v6 jsonb;
begin
  set local role recover_web;
  v1 := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_p, v_k1, v_r1);
  v2 := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_p, v_k1, v_r1);
  perform public.api_idempotency_finish('FCHS', 'device', 'item.create', v_p, v_k1, 201,
                                        '{"itemId": "f1000000-0000-4000-8000-00000000abcd"}'::jsonb);
  perform public.api_idempotency_finish('FCHS', 'device', 'item.create', v_p, v_k1, 500, '{}'::jsonb);  -- no overwrite
  v3 := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_p, v_k1, v_r1);
  perform pg_temp.expect_error(format('select public.api_idempotency_begin(%L, %L, %L, %L::bytea, %L::bytea, %L::bytea)',
                                      'FCHS', 'device', 'item.create', v_p, v_k1, v_r2), 'idempotency_conflict');
  -- no cross-school replay: the same principal and key at another school is a different scope
  v4 := public.api_idempotency_begin('SFHS', 'device', 'item.create', v_p, v_k1, v_r1);
  -- nor across operations
  v5 := public.api_idempotency_begin('FCHS', 'device', 'report.create', v_p, v_k1, v_r1);
  v6 := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_p, v_k2, v_r1);
  perform pg_temp.expect_error(format('select public.api_idempotency_finish(%L, %L, %L, %L::bytea, %L::bytea, 200, null)',
                                      'FCHS', 'device', 'item.complete', v_p, v_k1), 'not_found');
  perform pg_temp.expect_error(format('select public.api_idempotency_begin(%L, %L, %L, %L::bytea, %L::bytea, %L::bytea)',
                                      'FCHS', 'robot', 'item.create', v_p, v_k1, v_r1), 'invalid_input', 'principal_kind');
  perform pg_temp.expect_error(format('select public.api_idempotency_begin(%L, %L, %L, %L::bytea, %L::bytea, %L::bytea)',
                                      'FCHS', 'device', 'Item Create!', v_p, v_k1, v_r1), 'invalid_input', 'operation');
  perform pg_temp.expect_error(format('select public.api_idempotency_finish(%L, %L, %L, %L::bytea, %L::bytea, 42, null)',
                                      'FCHS', 'device', 'item.create', v_p, v_k2), 'invalid_input', 'response_code');
  reset role;

  if v1 <> '{"state": "new", "responseCode": null, "responseBody": null}'::jsonb
     or v2 <> '{"state": "in_progress", "responseCode": null, "responseBody": null}'::jsonb
     or v3 <> '{"state": "replay", "responseCode": 201, "responseBody": {"itemId": "f1000000-0000-4000-8000-00000000abcd"}}'::jsonb
     or v4->>'state' <> 'new' or v5->>'state' <> 'new' or v6->>'state' <> 'new' then
    raise exception 'FAIL idempotency states: % % % % % %', v1, v2, v3, v4, v5, v6;
  end if;
  if not exists (select 1 from public.idempotency_keys k
                  where k.tenant_scope = 'school:0a0a0a0a-0000-4000-8000-000000000001' and k.key_hash = v_k1
                    and k.operation = 'item.create' and k.expires_at = now() + interval '24 hours') then
    raise exception 'FAIL idempotency row: tenant scope must be derived from the school, TTL 24 h';
  end if;

  -- a response-less row older than 60 s is a crashed attempt: the next begin takes it over
  update public.idempotency_keys k set created_at = now() - interval '2 minutes'
   where k.tenant_scope = 'school:0a0a0a0a-0000-4000-8000-000000000001' and k.key_hash = v_k2;
  -- an expired row that was not purged yet starts over, even with a different request hash
  update public.idempotency_keys k set expires_at = now() - interval '1 second', created_at = now() - interval '25 hours'
   where k.tenant_scope = 'school:0b0b0b0b-0000-4000-8000-000000000002' and k.key_hash = v_k1;
  set local role recover_web;
  v1 := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_p, v_k2, v_r1);
  v2 := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_p, v_k2, v_r1);
  v3 := public.api_idempotency_begin('SFHS', 'device', 'item.create', v_p, v_k1, v_r2);
  reset role;
  if v1->>'state' <> 'new' or v2->>'state' <> 'in_progress' or v3->>'state' <> 'new' then
    raise exception 'FAIL stale lock takeover / expired reuse: % % %', v1, v2, v3;
  end if;
  raise notice 'PASS api_idempotency: new, in_progress, replay, conflict, per-school and per-operation scope, stale takeover, expiry';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- api_create_item_draft -> api_complete_item (§5.1, Appendix C item_complete)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_map constant uuid := '0a0a0a0a-2000-4000-8000-000000000001';
  v_w constant uuid := '0a0a0a0a-1000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v jsonb;
  v_item uuid;
  v_zone uuid;
  r record;
begin
  set local role recover_web;
  v := public.api_create_item_draft(
         p_school_code => 'FCHS', p_device_digest => v_d1, p_category => 'bottle',
         p_description => '  Green   lunchbox ', p_note => 'C214', p_map_version_id => v_map,
         p_pin_x => 0.30, p_pin_y => 0.40, p_dropoff_location_id => v_w, p_photo_count => 2, p_src => 'poster-a');
  reset role;

  v_item := (v->>'itemId')::uuid;
  perform set_config('rv.item1', v_item::text, true);
  select z.id into strict v_zone from public.map_zones z where z.map_version_id = v_map and z.name = 'Main Hall';
  if pg_temp.keys(v) <> 'itemId,photos' or jsonb_array_length(v->'photos') <> 2
     or pg_temp.keys(v->'photos'->0) <> 'generation,photoId,position'
     or (v->'photos'->0->>'position')::int <> 0 or (v->'photos'->1->>'position')::int <> 1
     or (v->'photos'->0->>'generation')::int <> 1 then
    raise exception 'FAIL draft result shape: %', v;
  end if;
  select i.* into r from public.items i where i.id = v_item;
  if r.school_id <> v_fchs or r.review_status <> 'draft' or r.publication_status <> 'hidden'
     or r.custody <> 'with_finder' or r.posted_by_kind <> 'student' or r.device_token_hash <> v_d1
     or r.public_id is not null or r.description <> 'Green lunchbox' or r.location_note_private <> 'C214'
     or r.zone_id is distinct from v_zone or r.map_version_id <> v_map or r.pin_x <> 0.30 or r.pin_y <> 0.40
     or r.dropoff_location_id <> v_w or r.photo_count <> 2 or r.src <> 'poster-a' or r.screening_flags <> '{}'::jsonb then
    raise exception 'FAIL draft row: %', row_to_json(r);
  end if;
  if (select count(*) from public.item_photos p
       where p.item_id = v_item and p.school_id = v_fchs and p.generation = 1 and p.is_current and p.status = 'uploaded'
         and p.incoming_path = v_fchs::text || '/' || v_item::text || '/' || p.id::text || '/raw'
         and p.id::text in (v->'photos'->0->>'photoId', v->'photos'->1->>'photoId')) <> 2 then
    raise exception 'FAIL draft photo rows (generation 1, current, incoming key <school>/<item>/<photo>/raw)';
  end if;
  if not exists (select 1 from public.devices d where d.school_id = v_fchs and d.token_hash = v_d1) then
    raise exception 'FAIL draft did not upsert the device';
  end if;
  raise notice 'PASS api_create_item_draft: draft/hidden/with_finder/student row, zone resolved, photo slots, device upsert';
end $$;

-- draft refusals, and F-102 text canonicalization
do $$
declare
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_d3 constant bytea := decode('01' || repeat('d3', 32), 'hex');
  v_d6 constant bytea := decode('01' || repeat('d6', 32), 'hex');
  v_w constant uuid := '0a0a0a0a-1000-4000-8000-000000000001';
  v jsonb;
  v_fmt constant text := 'select public.api_create_item_draft(p_school_code => %L, p_device_digest => %L::bytea, '
    || 'p_category => %L, p_description => %L, p_note => %L, p_map_version_id => %L::uuid, p_pin_x => %s, '
    || 'p_pin_y => %s, p_dropoff_location_id => %L::uuid, p_photo_count => %s, p_src => %L)';
begin
  set local role recover_web;
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d3, 'bottle', 'Green lunchbox', null, null, 'null', 'null', v_w, 1, null),
                               'device_blocked');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'phone', 'Black phone', null, null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'category');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'spaceship', 'Green lunchbox', null, null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'category');
  perform pg_temp.expect_error(format(v_fmt, 'ZTST', v_d1, 'bottle', 'Green lunchbox', null, null, 'null', 'null',
                                      'fa000000-1000-4000-8000-0000000000aa', 1, null), 'feature_disabled');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'a', null, null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'description');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', repeat('x', 121), null, null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'description');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green ' || chr(8238) || 'lunchbox', null, null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'description');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', repeat('n', 81), null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'note');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, null, '0.5', '0.5', v_w, 1, null),
                               'invalid_input', 'map_version_id');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, '0b0b0b0b-2000-4000-8000-000000000001',
                                      '0.5', '0.5', v_w, 1, null), 'invalid_input', 'map_version_id');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, '0a0a0a0a-2000-4000-8000-000000000001',
                                      '1.5', '0.5', v_w, 1, null), 'invalid_input', 'pin');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, '0a0a0a0a-2000-4000-8000-000000000001',
                                      '0.5', 'null', v_w, 1, null), 'invalid_input', 'pin');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, null, 'null', 'null',
                                      '0b0b0b0b-1000-4000-8000-000000000001', 1, null), 'invalid_input', 'dropoff_location_id');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, null, 'null', 'null', v_w, 4, null),
                               'invalid_input', 'photo_count');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, null, 'null', 'null', v_w, 0, null),
                               'invalid_input', 'photo_count');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', null, null, 'null', 'null', v_w, 1, 'Bad Src'),
                               'invalid_input', 'src');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', '\x01d1', 'bottle', 'Green lunchbox', null, null, 'null', 'null', v_w, 1, null),
                               'invalid_input', 'device_digest');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green ' || chr(8294) || 'lunchbox', null, null, 'null', 'null',
                                      v_w, 1, null), 'invalid_input', 'description');  -- bidi isolate
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Green lunchbox', 'Room ' || chr(7) || '214', null, 'null', 'null',
                                      v_w, 1, null), 'invalid_input', 'note');  -- C0 control
  -- decomposed a + combining acute, a tab and a double space: stored NFC-composed and whitespace-collapsed
  v := public.api_create_item_draft(p_school_code => 'FCHS', p_device_digest => v_d6, p_category => 'book',
                                    p_description => 'L' || chr(97) || chr(769) || 'piz ' || chr(9) || ' rojo',
                                    p_dropoff_location_id => v_w, p_photo_count => 1);
  reset role;
  if (select i.description from public.items i where i.id = (v->>'itemId')::uuid) <> 'L' || chr(225) || 'piz rojo' then
    raise exception 'FAIL description must be stored NFC-normalized with collapsed whitespace: %',
      (select i.description from public.items i where i.id = (v->>'itemId')::uuid);
  end if;
  raise notice 'PASS api_create_item_draft refusals: blocked device, high-value/unknown category, disabled flag, text, controls, pin, map, dropoff, photo count, src, digest; NFC storage';
end $$;

-- complete (and idempotent re-complete)
do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_w constant uuid := '0a0a0a0a-1000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_d2 constant bytea := decode('01' || repeat('d2', 32), 'hex');
  v_item constant uuid := current_setting('rv.item1')::uuid;
  v_seq bigint;
  v_expected_id text;
  v_expected_deadline timestamptz;
  v_posted_before int;
  v_objects jsonb;
  v1 jsonb;
  v2 jsonb;
begin
  select l.item_seq into v_seq from public.locations l where l.id = v_w;
  v_expected_id := 'FCHS-W-' || lpad((v_seq + 1)::text, 6, '0');
  select (d.day + d.close_at) at time zone 'America/New_York' into v_expected_deadline
    from public.school_calendar_days d
   where d.school_id = v_fchs and d.is_open and d.day > (now() at time zone 'America/New_York')::date
   order by d.day limit 1;
  select coalesce(sum(s.posted), 0) into v_posted_before
    from public.daily_school_stats s where s.school_id = v_fchs;
  select jsonb_agg(jsonb_build_object('photoId', p.id, 'exists', true, 'rawBytes', 200000 + p.position, 'magicOk', true))
    into v_objects
    from public.item_photos p where p.item_id = v_item;

  set local role recover_web;
  perform pg_temp.expect_error(format('select public.api_complete_item(%L, %L::bytea, %L::uuid, %L::jsonb)',
                                      'FCHS', v_d2, v_item, v_objects), 'not_found');  -- another device
  perform pg_temp.expect_error(format('select public.api_complete_item(%L, %L::bytea, %L::uuid, %L::jsonb)',
                                      'SFHS', v_d1, v_item, v_objects), 'not_found');  -- another school
  v1 := public.api_complete_item('FCHS', v_d1, v_item, v_objects);
  v2 := public.api_complete_item('FCHS', v_d1, v_item, v_objects);
  reset role;

  if pg_temp.keys(v1) <> 'arrivalDeadlineAt,itemId,publicId,reviewStatus' or v1->>'itemId' <> v_item::text
     or v1->>'reviewStatus' <> 'pending' or v1->>'publicId' <> v_expected_id
     or v1->>'publicId' !~ '^FCHS-W-[0-9]{6}$' then
    raise exception 'FAIL complete result: % (expected public id %)', v1, v_expected_id;
  end if;
  if v_seq = 0 and v1->>'publicId' <> 'FCHS-W-000001' then
    raise exception 'FAIL first public id at W must be FCHS-W-000001, got %', v1->>'publicId';
  end if;
  if (v1->>'arrivalDeadlineAt')::timestamptz <> v_expected_deadline or v_expected_deadline <= now()
     or extract(isodow from (v_expected_deadline at time zone 'America/New_York')) > 5
     or ((v_expected_deadline at time zone 'America/New_York')::date) <= (now() at time zone 'America/New_York')::date then
    raise exception 'FAIL arrival deadline % is not the close of the next school day (%)', v1->>'arrivalDeadlineAt', v_expected_deadline;
  end if;
  if v2 <> v1 then
    raise exception 'FAIL re-complete is not idempotent: % vs %', v2, v1;
  end if;
  if not exists (select 1 from public.items i where i.id = v_item and i.review_status = 'pending'
                    and i.publication_status = 'hidden' and i.public_id = v_expected_id
                    and i.arrival_deadline_at = v_expected_deadline) then
    raise exception 'FAIL item row after complete';
  end if;
  if (select count(*) from public.item_photos p where p.item_id = v_item and p.raw_bytes = 200000 + p.position) <> 2 then
    raise exception 'FAIL raw_bytes not recorded from the worker complete-check (G-38)';
  end if;
  if (select count(*) from public.jobs j
       join public.item_photos p on p.item_id = v_item and j.payload = jsonb_build_object('photoId', p.id)
      where j.kind = 'canonicalize_photo' and j.status = 'queued' and j.school_id = v_fchs
        and j.dedupe_key = 'canonicalize_photo:' || p.id::text) <> 2
     or (select count(*) from public.jobs j where j.kind = 'canonicalize_photo'
           and j.payload->>'photoId' in (select p.id::text from public.item_photos p where p.item_id = v_item)) <> 2 then
    raise exception 'FAIL expected exactly one canonicalize_photo job per photo (none added by the re-complete)';
  end if;
  if (select count(*) from public.audit_log a
       where a.action = 'item.complete' and a.target_table = 'items' and a.target_id = v_item::text
         and a.actor_kind = 'device' and a.actor_id is null and a.school_id = v_fchs) <> 1 then
    raise exception 'FAIL expected exactly one item.complete audit row (device actor, no actor id)';
  end if;
  if (select coalesce(sum(s.posted), 0) from public.daily_school_stats s where s.school_id = v_fchs) <> v_posted_before + 1 then
    raise exception 'FAIL daily_school_stats.posted must increase by exactly 1';
  end if;
  raise notice 'PASS api_complete_item: % pending, deadline %, 2 canonicalize jobs, audit, posted counter, idempotent re-complete',
    v1->>'publicId', v1->>'arrivalDeadlineAt';
end $$;

-- complete refusals, duplicate-text flag (G-11), status (F-78), my items (G-32)
do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_w constant uuid := '0a0a0a0a-1000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_d2 constant bytea := decode('01' || repeat('d2', 32), 'hex');
  v_item1 constant uuid := current_setting('rv.item1')::uuid;
  v_dup jsonb;
  v_other jsonb;
  v_p0 text;
  v_p1 text;
  v_ok0 jsonb;
  v_ok1 jsonb;
  v_status jsonb;
  v_mine jsonb;
  v_theirs jsonb;
  v_sql constant text := 'select public.api_complete_item(%L, %L::bytea, %L::uuid, %L::jsonb)';
begin
  set local role recover_web;
  v_dup := public.api_create_item_draft(p_school_code => 'FCHS', p_device_digest => v_d1, p_category => 'bag',
                                        p_description => 'GREEN lunchbox', p_dropoff_location_id => v_w, p_photo_count => 2);
  v_other := public.api_create_item_draft(p_school_code => 'FCHS', p_device_digest => v_d2, p_category => 'bag',
                                          p_description => 'Green lunchbox', p_dropoff_location_id => v_w, p_photo_count => 1);
  v_p0 := v_dup->'photos'->0->>'photoId';
  v_p1 := v_dup->'photos'->1->>'photoId';
  v_ok0 := jsonb_build_object('photoId', v_p0, 'exists', true, 'rawBytes', 1000, 'magicOk', true);
  v_ok1 := jsonb_build_object('photoId', v_p1, 'exists', true, 'rawBytes', 1000, 'magicOk', true);
  perform pg_temp.expect_error(format(v_sql, 'FCHS', v_d1, v_dup->>'itemId', jsonb_build_array(v_ok0)),
                               'invalid_input', 'objects');  -- a photo is missing
  perform pg_temp.expect_error(format(v_sql, 'FCHS', v_d1, v_dup->>'itemId',
                                      jsonb_build_array(v_ok0, v_ok1 || '{"magicOk": false}')), 'invalid_input', 'objects');
  perform pg_temp.expect_error(format(v_sql, 'FCHS', v_d1, v_dup->>'itemId',
                                      jsonb_build_array(v_ok0, v_ok1 || '{"exists": false}')), 'invalid_input', 'objects');
  perform pg_temp.expect_error(format(v_sql, 'FCHS', v_d1, v_dup->>'itemId',
                                      jsonb_build_array(v_ok0, v_ok1 || '{"rawBytes": 1048577}')), 'invalid_input', 'objects');
  perform pg_temp.expect_error(format(v_sql, 'FCHS', v_d1, v_dup->>'itemId',
                                      jsonb_build_array(v_ok0, v_ok1, v_ok1)), 'invalid_input', 'objects');  -- extra entry
  perform pg_temp.expect_error(format(v_sql, 'FCHS', v_d1, v_dup->>'itemId', '{"photoId": 1}'), 'invalid_input', 'objects');
  v_status := public.api_item_status('FCHS', v_d1, v_item1);
  perform pg_temp.expect_error(format('select public.api_item_status(%L, %L::bytea, %L::uuid)', 'FCHS', v_d2, v_item1),
                               'not_found');
  perform pg_temp.expect_error(format('select public.api_item_status(%L, %L::bytea, %L::uuid)', 'SFHS', v_d1, v_item1),
                               'not_found');
  v_mine := public.api_my_items('FCHS', v_d1);
  v_theirs := public.api_my_items('SFHS', v_d1);
  reset role;

  if (select i.screening_flags from public.items i where i.id = (v_dup->>'itemId')::uuid) <> '{"duplicate": true}'::jsonb
     or (select i.screening_flags from public.items i where i.id = (v_other->>'itemId')::uuid) <> '{}'::jsonb then
    raise exception 'FAIL duplicate text from the same device must be a reviewer flag only (G-11)';
  end if;
  if (select i.review_status from public.items i where i.id = (v_dup->>'itemId')::uuid) <> 'draft' then
    raise exception 'FAIL a refused complete must leave the draft untouched';
  end if;
  if pg_temp.keys(v_status) <> 'arrivalDeadlineAt,custody,itemId,publicId,publicationStatus,reviewStatus'
     or v_status->>'reviewStatus' <> 'pending' or v_status->>'publicationStatus' <> 'hidden'
     or v_status->>'custody' <> 'with_finder' or v_status->>'itemId' <> v_item1::text then
    raise exception 'FAIL item status: %', v_status;
  end if;
  if jsonb_array_length(v_mine->'items') <> 2
     or pg_temp.keys(v_mine->'items'->0) <> 'category,createdAt,custody,itemId,publicId,publicationStatus,reviewStatus'
     or not exists (select 1 from jsonb_array_elements(v_mine->'items') e
                     where e->>'itemId' = v_item1::text and e->>'reviewStatus' = 'pending')
     or not exists (select 1 from jsonb_array_elements(v_mine->'items') e
                     where e->>'itemId' = v_dup->>'itemId' and jsonb_typeof(e->'publicId') = 'null')
     or jsonb_array_length(v_theirs->'items') <> 0 then
    raise exception 'FAIL my items: % / %', v_mine, v_theirs;
  end if;
  raise notice 'PASS complete refusals (missing/bad/extra objects), duplicate-text flag, item status and my items bound to school + digest';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Lost reports: create, list (matches through public_items), seen, close (§12, Appendix C)
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_today constant date := (now() at time zone 'America/New_York')::date;
  v_ttl int;
  v_before int;
  v jsonb;
  v_fmt constant text := 'select public.api_create_lost_report(p_school_code => %L, p_device_digest => %L::bytea, '
    || 'p_category => %L, p_description => %L, p_map_version_id => %L::uuid, p_pin_x => %s, p_pin_y => %s, p_lost_on => %L::date)';
begin
  select d.lost_report_ttl_days into v_ttl from public.district_settings d where d.id = 1;
  select coalesce(sum(s.lost_reports), 0) into v_before from public.daily_school_stats s where s.school_id = v_fchs;

  set local role recover_web;
  v := public.api_create_lost_report(p_school_code => 'FCHS', p_device_digest => v_d1, p_category => 'bottle',
                                     p_description => 'Lost my blue water bottle', p_map_version_id => '0a0a0a0a-2000-4000-8000-000000000001',
                                     p_pin_x => 0.45, p_pin_y => 0.70, p_lost_on => v_today - 1);
  perform pg_temp.expect_error(format(v_fmt, 'NFMS', v_d1, 'bottle', 'Lost my bottle', null, 'null', 'null', null), 'feature_disabled');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'ab', null, 'null', 'null', null), 'invalid_input', 'description');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', repeat('x', 201), null, 'null', 'null', null),
                               'invalid_input', 'description');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'toaster', 'Lost my bottle', null, 'null', 'null', null),
                               'invalid_input', 'category');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Lost my bottle', null, 'null', 'null', v_today + 1),
                               'invalid_input', 'lost_on');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Lost my bottle', null, 'null', 'null', v_today - 61),
                               'invalid_input', 'lost_on');
  perform pg_temp.expect_error(format(v_fmt, 'FCHS', v_d1, 'bottle', 'Lost my bottle', '0b0b0b0b-2000-4000-8000-000000000001',
                                      '0.5', '0.5', null), 'invalid_input', 'map_version_id');
  reset role;

  perform set_config('rv.report1', v->>'reportId', true);
  if pg_temp.keys(v) <> 'expiresAt,reportId,status' or v->>'status' <> 'open'
     or (v->>'expiresAt')::timestamptz <> now() + make_interval(days => v_ttl) then
    raise exception 'FAIL lost report result: %', v;
  end if;
  if not exists (select 1 from public.lost_reports r
                  where r.id = (v->>'reportId')::uuid and r.school_id = v_fchs and r.device_token_hash = v_d1
                    and r.status = 'open' and r.category = 'bottle' and r.lost_on = v_today - 1 and r.pin_x = 0.45) then
    raise exception 'FAIL lost report row';
  end if;
  if (select count(*) from public.jobs j where j.kind = 'match_report' and j.school_id = v_fchs
        and j.dedupe_key = 'match_report:' || (v->>'reportId') and j.payload = jsonb_build_object('reportId', (v->>'reportId')::uuid)) <> 1 then
    raise exception 'FAIL match_report job not enqueued with its dedupe key';
  end if;
  if (select count(*) from public.audit_log a where a.action = 'report.create' and a.target_id = v->>'reportId'
        and a.actor_kind = 'device' and a.actor_id is null) <> 1 then
    raise exception 'FAIL report.create audit row';
  end if;
  if (select coalesce(sum(s.lost_reports), 0) from public.daily_school_stats s where s.school_id = v_fchs) <> v_before + 1 then
    raise exception 'FAIL lost_reports counter';
  end if;
  raise notice 'PASS api_create_lost_report: row, match_report outbox, audit, counter, validation, feature flag';
end $$;

-- Matches as the matcher would write them: one to a visible item (F1) and a higher-scored one to a pending item (F3).
do $$
declare
  v_report constant uuid := current_setting('rv.report1')::uuid;
begin
  insert into public.lost_report_matches (school_id, lost_report_id, item_id, score, scorer_version, matched_at)
  values ('0a0a0a0a-0000-4000-8000-000000000001', v_report, 'f1000000-0000-4000-8000-000000000001', 0.81, 'v1', now()),
         ('0a0a0a0a-0000-4000-8000-000000000001', v_report, 'f1000000-0000-4000-8000-000000000003', 0.95, 'v1', now());
  update public.lost_reports set match_count = 2, last_matched_at = now() where id = v_report;
end $$;

do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_d2 constant bytea := decode('01' || repeat('d2', 32), 'hex');
  v_report constant uuid := current_setting('rv.report1')::uuid;
  v_mine jsonb;
  v_other jsonb;
  v_after jsonb;
  v_rep jsonb;
  v_viewed_before int;
  v_found_before int;
  v_rv bigint;
  v_seen jsonb;
  v_close jsonb;
begin
  select coalesce(sum(s.matches_viewed), 0), coalesce(sum(s.reports_closed_found), 0) into v_viewed_before, v_found_before
    from public.daily_school_stats s where s.school_id = v_fchs;

  set local role recover_web;
  v_mine := public.api_my_lost_reports('FCHS', v_d1);
  v_other := public.api_my_lost_reports('FCHS', v_d2);
  v_seen := public.api_mark_report_seen('FCHS', v_d1, v_report);
  perform public.api_mark_report_seen('FCHS', v_d1, v_report);  -- nothing new: no counter, no row_version bump
  perform pg_temp.expect_error(format('select public.api_mark_report_seen(%L, %L::bytea, %L::uuid)', 'FCHS', v_d2, v_report),
                               'not_found');
  reset role;

  v_rep := v_mine->'reports'->0;
  if jsonb_array_length(v_mine->'reports') <> 1
     or pg_temp.keys(v_rep) <> 'category,description,expiresAt,id,lastMatchedAt,lastViewedAt,matchCount,matches,rowVersion,status'
     or v_rep->>'id' <> v_report::text or v_rep->>'status' <> 'open' or (v_rep->>'matchCount')::int <> 1
     or (v_rep->>'rowVersion')::bigint <> 1 or jsonb_array_length(v_rep->'matches') <> 1 then
    raise exception 'FAIL my lost reports: %', v_mine;
  end if;
  if pg_temp.keys(v_rep->'matches'->0) <> 'category,custody,description,itemId,locationId,publicId,score,thumbPath'
     or v_rep->'matches'->0->>'itemId' <> 'f1000000-0000-4000-8000-000000000001'
     or v_rep->'matches'->0->>'publicId' <> 'FCHS-E-990001'
     or (v_rep->'matches'->0->>'score')::float8 <> 0.81
     or v_rep->'matches'->0->>'thumbPath' <> '0a0a0a0a-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000001/p0/thumb.jpg' then
    raise exception 'FAIL report matches must join through public_items with the lowest-position thumb: %', v_rep->'matches';
  end if;
  if jsonb_array_length(v_other->'reports') <> 0 then
    raise exception 'FAIL another device sees reports: %', v_other;
  end if;
  if v_seen <> '{"ok": true}'::jsonb
     or (select m.seen_at from public.lost_report_matches m
          where m.lost_report_id = v_report and m.item_id = 'f1000000-0000-4000-8000-000000000001') is null
     or (select m.seen_at from public.lost_report_matches m
          where m.lost_report_id = v_report and m.item_id = 'f1000000-0000-4000-8000-000000000003') is not null
     or (select r.last_viewed_at from public.lost_reports r where r.id = v_report) is null then
    raise exception 'FAIL seen must mark only visible matches and set last_viewed_at';
  end if;
  if (select coalesce(sum(s.matches_viewed), 0) from public.daily_school_stats s where s.school_id = v_fchs) <> v_viewed_before + 1 then
    raise exception 'FAIL matches_viewed must increase by exactly 1';
  end if;
  select r.row_version into v_rv from public.lost_reports r where r.id = v_report;
  if v_rv <> 2 then
    raise exception 'FAIL row_version after seen should be 2 (one bump), got %', v_rv;
  end if;

  set local role recover_web;
  perform pg_temp.expect_error(format('select public.api_close_lost_report(%L, %L::bytea, %L::uuid, %s, %L)',
                                      'FCHS', v_d1, v_report, 1, 'found'), 'state_changed');  -- stale row_version
  perform pg_temp.expect_error(format('select public.api_close_lost_report(%L, %L::bytea, %L::uuid, %s, %L)',
                                      'FCHS', v_d2, v_report, v_rv, 'found'), 'not_found');  -- another device
  perform pg_temp.expect_error(format('select public.api_close_lost_report(%L, %L::bytea, %L::uuid, %s, %L)',
                                      'FCHS', v_d1, v_report, v_rv, 'lost'), 'invalid_input', 'outcome');
  v_close := public.api_close_lost_report('FCHS', v_d1, v_report, v_rv, 'found');
  perform pg_temp.expect_error(format('select public.api_close_lost_report(%L, %L::bytea, %L::uuid, %s, %L)',
                                      'FCHS', v_d1, v_report, v_rv + 1, 'dismiss'), 'state_changed');  -- already closed
  perform pg_temp.expect_error(format('select public.api_mark_report_seen(%L, %L::bytea, %L::uuid)', 'FCHS', v_d1, v_report),
                               'state_changed');
  v_after := public.api_my_lost_reports('FCHS', v_d1);
  reset role;

  if v_close <> jsonb_build_object('reportId', v_report, 'status', 'closed_found') then
    raise exception 'FAIL close result: %', v_close;
  end if;
  if not exists (select 1 from public.lost_reports r where r.id = v_report and r.status = 'closed_found' and r.terminal_at = now()) then
    raise exception 'FAIL closed report row';
  end if;
  if (select coalesce(sum(s.reports_closed_found), 0) from public.daily_school_stats s where s.school_id = v_fchs) <> v_found_before + 1 then
    raise exception 'FAIL reports_closed_found counter';
  end if;
  if (select count(*) from public.audit_log a where a.action = 'report.close' and a.target_id = v_report::text
        and a.actor_kind = 'device' and a.state_after = '{"status": "closed_found"}'::jsonb) <> 1 then
    raise exception 'FAIL report.close audit row';
  end if;
  if jsonb_array_length(v_after->'reports') <> 0 then
    raise exception 'FAIL closed reports must leave the device list: %', v_after;
  end if;
  raise notice 'PASS lost report list/seen/close: visible matches only, thumb, funnel counters, row_version guard, audit';
end $$;

-- dismiss path and the 5-open cap
do $$
declare
  v_d1 constant bytea := decode('01' || repeat('d1', 32), 'hex');
  v_d4 constant bytea := decode('01' || repeat('d4', 32), 'hex');
  v jsonb;
  v_close jsonb;
  v_detail text;
  v_ttl int;
  i int;
begin
  select d.lost_report_ttl_days into v_ttl from public.district_settings d where d.id = 1;
  set local role recover_web;
  v := public.api_create_lost_report(p_school_code => 'FCHS', p_device_digest => v_d1, p_description => 'Gray hoodie');
  v_close := public.api_close_lost_report('FCHS', v_d1, (v->>'reportId')::uuid, 0, 'dismiss');
  for i in 1..5 loop
    perform public.api_create_lost_report(p_school_code => 'FCHS', p_device_digest => v_d4,
                                          p_description => 'Lost item number ' || i);
  end loop;
  v_detail := pg_temp.expect_error(format('select public.api_create_lost_report(p_school_code => %L, p_device_digest => %L::bytea, p_description => %L)',
                                          'FCHS', v_d4, 'Sixth report'), 'rate_limited');
  reset role;
  if v_close->>'status' <> 'closed_by_user' then
    raise exception 'FAIL dismiss must close as closed_by_user: %', v_close;
  end if;
  if v_detail::int <> v_ttl * 86400 then
    raise exception 'FAIL open-report cap retry must be the seconds until the oldest open report expires: %', v_detail;
  end if;
  raise notice 'PASS dismiss -> closed_by_user; sixth open report refused with rate_limited';
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Counters, telemetry, domains, health
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_hv_before int;
  v_hv jsonb;
  v_err jsonb;
  v_domains jsonb;
  v_health jsonb;
  v_sig constant text := 'test:api_student/s/[code]/items.TypeError';
begin
  select coalesce(sum(s.high_value_redirects), 0) into v_hv_before from public.daily_school_stats s where s.school_id = v_fchs;
  set local role recover_web;
  v_hv := public.api_record_high_value_redirect('FCHS', 'phone');
  perform pg_temp.expect_error($q$select public.api_record_high_value_redirect('FCHS', 'bottle')$q$, 'invalid_input', 'category');
  v_err := public.api_record_error(v_sig);
  perform public.api_record_error(v_sig);
  -- 0210: the web's server-side signatures carry one space (`<METHOD> <route>:<Class>`); other punctuation,
  -- the client's `*` wildcard, and anything over 120 characters are still refused
  perform public.api_record_error('POST /api/s/[code]/items:TypeError');
  perform pg_temp.expect_error($q$select public.api_record_error('has;semicolon')$q$, 'invalid_input', 'signature');
  perform pg_temp.expect_error($q$select public.api_record_error('client:TypeError:/s/*/found')$q$, 'invalid_input', 'signature');
  perform pg_temp.expect_error($q$select public.api_record_error(E'tab\there')$q$, 'invalid_input', 'signature');
  perform pg_temp.expect_error(format('select public.api_record_error(%L)', repeat('a', 121)), 'invalid_input', 'signature');
  v_domains := public.api_get_staff_domains();
  v_health := public.api_health();
  reset role;

  if v_hv <> '{"ok": true}'::jsonb
     or (select coalesce(sum(s.high_value_redirects), 0) from public.daily_school_stats s where s.school_id = v_fchs) <> v_hv_before + 1 then
    raise exception 'FAIL high-value redirect counter';
  end if;
  if v_err <> '{"ok": true}'::jsonb
     or (select e.count from public.error_rollup e where e.signature = v_sig and e.day = (now() at time zone 'UTC')::date) <> 2
     or not exists (select 1 from public.error_rollup e where e.signature = 'POST /api/s/[code]/items:TypeError') then
    raise exception 'FAIL error_rollup upsert';
  end if;
  if v_domains <> jsonb_build_object('domains', (select to_jsonb(d.staff_email_domains) from public.district_settings d where d.id = 1)) then
    raise exception 'FAIL staff domains: %', v_domains;
  end if;
  -- calendarHorizonD is the minimum over active schools; the fixture school ZTST has no calendar rows at all.
  if pg_temp.keys(v_health) <> 'calendarHorizonD,db,deadJobs,deletionUnverifiedMaxAgeS,oldestJobS,workerHeartbeatAgeS'
     or (v_health->>'db')::boolean is not true or (v_health->>'oldestJobS')::int < 0 or (v_health->>'deadJobs')::int < 0
     or (v_health->>'calendarHorizonD')::int <> 0 or (v_health->>'deletionUnverifiedMaxAgeS')::int < 0 then
    raise exception 'FAIL health: %', v_health;
  end if;
  raise notice 'PASS high-value redirect count, error rollup, staff domains, health %', v_health;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- Redacted search text only when the district opts in (§11.5). Runs last: it writes the district row.
-- ---------------------------------------------------------------------------------------------------
do $$
declare
  v_qh constant bytea := decode(repeat('5d', 32), 'hex');
begin
  update public.district_settings set redacted_search_enabled = true where id = 1;
  set local role recover_web;
  perform public.api_search(p_school_code => 'FCHS', p_q => 'Locker 214 bottle ME@x.org', p_query_hmac => v_qh);
  reset role;
  if (select s.redacted_query from public.search_events s where s.query_hmac = v_qh) is distinct from 'locker ### bottle [redacted]' then
    raise exception 'FAIL redacted query: %', (select s.redacted_query from public.search_events s where s.query_hmac = v_qh);
  end if;
  raise notice 'PASS redacted search text stored only with the district opt-in, digits and addresses masked';
end $$;

rollback;
