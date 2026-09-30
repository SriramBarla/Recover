-- tenant_property.sql: composite tenant foreign keys (F-16, Appendix D.1 and D.2).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/tenant_property.sql
-- For every ordered pair (A, B) of seeded schools, every cross-school reference a row of school A can carry is
-- attempted, on insert and on update, and must fail AT THE DATABASE with SQLSTATE 23503. Same-school mismatches
-- (a screening run or a ledger object whose photo belongs to another item) fail the same way. Each school also runs
-- positive controls (same-school references succeed) so a 23503 can only come from the tenant key.
-- Everything runs in one transaction that is rolled back.
\set ON_ERROR_STOP 1
\set QUIET 1
begin;
set local lock_timeout = '20s';

create temp sequence t_checks;
create temp sequence t_rejected;

-- The statement must fail with 23503 (foreign_key_violation).
create function pg_temp.expect_fk(p_label text, p_sql text) returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = '23503' then
      perform nextval('pg_temp.t_checks');
      perform nextval('pg_temp.t_rejected');
      return;
    end if;
    raise exception 'tenant_property.sql FAILED: % raised % (%) instead of 23503', p_label, v_state, v_msg;
  end;
  raise exception 'tenant_property.sql FAILED: % was accepted; expected 23503', p_label;
end $$;

-- Positive control: the statement succeeds; its effects are discarded (sub-transaction rolled back).
create function pg_temp.expect_ok(p_label text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception using errcode = 'RVOK1', message = 'positive control rollback';
  exception
    when sqlstate 'RVOK1' then
      perform nextval('pg_temp.t_checks');
      return;
    when others then
      raise exception 'tenant_property.sql FAILED: positive control % raised % (%)', p_label, sqlstate, sqlerrm;
  end;
end $$;

-- One fixture set per seeded school (fixed UUID prefixes from seed.sql).
create temp table fx (
  school_id uuid primary key, code text, loc uuid, map uuid, zone uuid, draft_map uuid,
  item uuid, item2 uuid, photo uuid, photo2 uuid, report uuid, ledger bigint
);

do $$
declare
  s record;
  v fx;
begin
  for s in select id, code from public.schools where code in ('FCHS', 'SFHS', 'NFMS') order by code loop
    v.school_id := s.id;
    v.code := s.code;
    select l.id into v.loc from public.locations l where l.school_id = s.id order by l.code limit 1;
    select m.id into v.map from public.map_versions m where m.school_id = s.id and m.active;
    select z.id into v.zone from public.map_zones z where z.map_version_id = v.map order by z.name limit 1;
    -- a draft version: zones can only be inserted on drafts (G-07), so zone attempts reach the foreign key
    insert into public.map_versions (school_id) values (s.id) returning id into v.draft_map;
    insert into public.items (school_id, category, description, dropoff_location_id, posted_by_kind, device_token_hash)
    values (s.id, 'bag', 'tenant fixture one', v.loc, 'student', extensions.gen_random_bytes(33)) returning id into v.item;
    insert into public.items (school_id, category, description, dropoff_location_id, posted_by_kind, device_token_hash)
    values (s.id, 'bag', 'tenant fixture two', v.loc, 'student', extensions.gen_random_bytes(33)) returning id into v.item2;
    insert into public.item_photos (school_id, item_id, position, generation, is_current, incoming_path)
    values (s.id, v.item, 0, 1, true, s.id::text || '/' || v.item::text || '/p/raw') returning id into v.photo;
    insert into public.item_photos (school_id, item_id, position, generation, is_current, incoming_path)
    values (s.id, v.item2, 0, 1, true, s.id::text || '/' || v.item2::text || '/p/raw') returning id into v.photo2;
    insert into public.lost_reports (school_id, category, description, device_token_hash, expires_at)
    values (s.id, 'bag', 'tenant fixture report', extensions.gen_random_bytes(33), now() + interval '30 days')
    returning id into v.report;
    insert into public.media_deletion_ledger (school_id, item_id, reason) values (s.id, v.item, 'tenant_test')
    returning id into v.ledger;
    insert into fx select v.*;
  end loop;
  if (select count(*) from fx) <> 3 or exists (select 1 from fx where loc is null or map is null or zone is null) then
    raise exception 'tenant_property.sql FAILED: seeded schools, locations, maps and zones are required';
  end if;
end $$;

-- Positive controls: every reference shape is accepted within one school.
do $$
declare
  a fx;
begin
  for a in select * from fx order by code loop
    perform pg_temp.expect_ok(a.code || ' item refs', format(
      $s$insert into public.items (school_id, category, description, dropoff_location_id, current_location_id, custody,
                                   received_at, map_version_id, zone_id, pin_x, pin_y, posted_by_kind, device_token_hash)
         values (%L, 'bag', 'same school', %L, %L, 'at_location', now(), %L, %L, 0.5, 0.5, 'student',
                 extensions.gen_random_bytes(33))$s$, a.school_id, a.loc, a.loc, a.map, a.zone));
    perform pg_temp.expect_ok(a.code || ' photo', format(
      $s$insert into public.item_photos (school_id, item_id, position, generation) values (%L, %L, 2, 9)$s$, a.school_id, a.item));
    perform pg_temp.expect_ok(a.code || ' screening run', format(
      $s$insert into public.screening_runs (school_id, item_id, item_photo_id, provider, model, policy_version, status)
         values (%L, %L, %L, 'mock', 'm', 'tp-ok', 'ok')$s$, a.school_id, a.item, a.photo));
    perform pg_temp.expect_ok(a.code || ' report map', format(
      $s$insert into public.lost_reports (school_id, description, device_token_hash, expires_at, map_version_id, pin_x, pin_y)
         values (%L, 'same school', extensions.gen_random_bytes(33), now() + interval '1 day', %L, 0.1, 0.1)$s$, a.school_id, a.map));
    perform pg_temp.expect_ok(a.code || ' match', format(
      $s$insert into public.lost_report_matches (school_id, lost_report_id, item_id, score, scorer_version)
         values (%L, %L, %L, 0.5, 'v1')$s$, a.school_id, a.report, a.item));
    perform pg_temp.expect_ok(a.code || ' ledger', format(
      $s$insert into public.media_deletion_ledger (school_id, item_id, reason) values (%L, %L, 'tenant_test')$s$, a.school_id, a.item));
    perform pg_temp.expect_ok(a.code || ' ledger object', format(
      $s$insert into public.media_deletion_objects (ledger_id, school_id, item_id, item_photo_id, storage_path, object_kind)
         values (%s, %L, %L, %L, 'k', 'incoming')$s$, a.ledger, a.school_id, a.item, a.photo));
    perform pg_temp.expect_ok(a.code || ' pin', format(
      $s$insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y) values (%L, %L, %L, 0.5, 0.5)$s$,
      a.school_id, a.loc, a.draft_map));
    perform pg_temp.expect_ok(a.code || ' zone', format(
      $s$insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius) values (%L, %L, 'Same School', 0.5, 0.5, 0.1)$s$,
      a.school_id, a.draft_map));
    perform pg_temp.expect_ok(a.code || ' media ticket', format(
      $s$insert into public.media_tickets (school_id, operation, item_id, item_photo_id, staff_member_id, expires_at)
         values (%L, 'media.read', %L, %L, '00000000-5b00-4000-8000-000000000001', now() + interval '30 seconds')$s$,
      a.school_id, a.item, a.photo));
    perform pg_temp.expect_ok(a.code || ' map ticket', format(
      $s$insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, expires_at)
         values (%L, 'map.read', %L, '00000000-5b00-4000-8000-000000000001', now() + interval '30 seconds')$s$,
      a.school_id, a.map));
  end loop;
end $$;

-- Generated pairs: every ordered pair of distinct schools, every cross-school reference, insert and update.
do $$
declare
  a fx;
  b fx;
  p text;
  n_pairs int := 0;
begin
  for a in select * from fx order by code loop
  for b in select * from fx where school_id <> a.school_id order by code loop
    n_pairs := n_pairs + 1;
    p := a.code || '->' || b.code || ': ';

    -- items -> location, map, zone of another school
    perform pg_temp.expect_fk(p || 'item dropoff location', format(
      $s$insert into public.items (school_id, category, description, dropoff_location_id, posted_by_kind, device_token_hash)
         values (%L, 'bag', 'cross school', %L, 'student', extensions.gen_random_bytes(33))$s$, a.school_id, b.loc));
    perform pg_temp.expect_fk(p || 'item current location', format(
      $s$insert into public.items (school_id, category, description, dropoff_location_id, current_location_id, custody,
                                   received_at, posted_by_kind, device_token_hash)
         values (%L, 'bag', 'cross school', %L, %L, 'at_location', now(), 'student', extensions.gen_random_bytes(33))$s$,
      a.school_id, a.loc, b.loc));
    perform pg_temp.expect_fk(p || 'item map version', format(
      $s$insert into public.items (school_id, category, description, dropoff_location_id, map_version_id, pin_x, pin_y,
                                   posted_by_kind, device_token_hash)
         values (%L, 'bag', 'cross school', %L, %L, 0.5, 0.5, 'student', extensions.gen_random_bytes(33))$s$,
      a.school_id, a.loc, b.map));
    perform pg_temp.expect_fk(p || 'item zone on own map', format(
      $s$insert into public.items (school_id, category, description, dropoff_location_id, map_version_id, zone_id,
                                   posted_by_kind, device_token_hash)
         values (%L, 'bag', 'cross school', %L, %L, %L, 'student', extensions.gen_random_bytes(33))$s$,
      a.school_id, a.loc, a.map, b.zone));
    perform pg_temp.expect_fk(p || 'item zone with its map', format(
      $s$insert into public.items (school_id, category, description, dropoff_location_id, map_version_id, zone_id,
                                   posted_by_kind, device_token_hash)
         values (%L, 'bag', 'cross school', %L, %L, %L, 'student', extensions.gen_random_bytes(33))$s$,
      a.school_id, a.loc, b.map, b.zone));
    perform pg_temp.expect_fk(p || 'item update to foreign location', format(
      $s$update public.items set dropoff_location_id = %L where id = %L$s$, b.loc, a.item));
    perform pg_temp.expect_fk(p || 'item update to foreign map', format(
      $s$update public.items set map_version_id = %L where id = %L$s$, b.map, a.item));

    -- photo -> another school's item
    perform pg_temp.expect_fk(p || 'photo of foreign item', format(
      $s$insert into public.item_photos (school_id, item_id, position, generation) values (%L, %L, 2, 9)$s$, a.school_id, b.item));
    perform pg_temp.expect_fk(p || 'photo moved to foreign item', format(
      $s$update public.item_photos set item_id = %L, position = 2, generation = 9 where id = %L$s$, b.item, a.photo));

    -- screening run: photo/item/school must agree
    perform pg_temp.expect_fk(p || 'screening run with foreign photo', format(
      $s$insert into public.screening_runs (school_id, item_id, item_photo_id, provider, model, policy_version, status)
         values (%L, %L, %L, 'mock', 'm', 'tp-x', 'ok')$s$, a.school_id, a.item, b.photo));
    perform pg_temp.expect_fk(p || 'screening run for foreign item', format(
      $s$insert into public.screening_runs (school_id, item_id, item_photo_id, provider, model, policy_version, status)
         values (%L, %L, %L, 'mock', 'm', 'tp-y', 'ok')$s$, a.school_id, b.item, b.photo));
    perform pg_temp.expect_fk(p || 'screening run photo of another item (same school)', format(
      $s$insert into public.screening_runs (school_id, item_id, item_photo_id, provider, model, policy_version, status)
         values (%L, %L, %L, 'mock', 'm', 'tp-z', 'ok')$s$, a.school_id, a.item, a.photo2));

    -- lost report -> another school's map
    perform pg_temp.expect_fk(p || 'report on foreign map', format(
      $s$insert into public.lost_reports (school_id, description, device_token_hash, expires_at, map_version_id, pin_x, pin_y)
         values (%L, 'cross school', extensions.gen_random_bytes(33), now() + interval '1 day', %L, 0.1, 0.1)$s$,
      a.school_id, b.map));
    perform pg_temp.expect_fk(p || 'report update to foreign map', format(
      $s$update public.lost_reports set map_version_id = %L, pin_x = 0.1, pin_y = 0.1 where id = %L$s$, b.map, a.report));

    -- matches across schools
    perform pg_temp.expect_fk(p || 'match with foreign item', format(
      $s$insert into public.lost_report_matches (school_id, lost_report_id, item_id, score, scorer_version)
         values (%L, %L, %L, 0.5, 'v1')$s$, a.school_id, a.report, b.item));
    perform pg_temp.expect_fk(p || 'match with foreign report', format(
      $s$insert into public.lost_report_matches (school_id, lost_report_id, item_id, score, scorer_version)
         values (%L, %L, %L, 0.5, 'v1')$s$, a.school_id, b.report, a.item));

    -- deletion ledger and its objects (F-75)
    perform pg_temp.expect_fk(p || 'ledger for foreign item', format(
      $s$insert into public.media_deletion_ledger (school_id, item_id, reason) values (%L, %L, 'tenant_test')$s$, a.school_id, b.item));
    perform pg_temp.expect_fk(p || 'ledger object with foreign photo', format(
      $s$insert into public.media_deletion_objects (ledger_id, school_id, item_id, item_photo_id, storage_path, object_kind)
         values (%s, %L, %L, %L, 'k', 'original')$s$, a.ledger, a.school_id, a.item, b.photo));
    perform pg_temp.expect_fk(p || 'ledger object with photo of another item (same school)', format(
      $s$insert into public.media_deletion_objects (ledger_id, school_id, item_id, item_photo_id, storage_path, object_kind)
         values (%s, %L, %L, %L, 'k', 'review')$s$, a.ledger, a.school_id, a.item, a.photo2));
    perform pg_temp.expect_fk(p || 'ledger object claiming a foreign ledger', format(
      $s$insert into public.media_deletion_objects (ledger_id, school_id, item_id, item_photo_id, storage_path, object_kind)
         values (%s, %L, %L, %L, 'k', 'thumb')$s$, b.ledger, a.school_id, a.item, a.photo));

    -- map pins and zones across schools
    perform pg_temp.expect_fk(p || 'pin on foreign map', format(
      $s$insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y) values (%L, %L, %L, 0.5, 0.5)$s$,
      a.school_id, a.loc, b.draft_map));
    perform pg_temp.expect_fk(p || 'pin for foreign location', format(
      $s$insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y) values (%L, %L, %L, 0.5, 0.5)$s$,
      a.school_id, b.loc, a.draft_map));
    perform pg_temp.expect_fk(p || 'zone on foreign map', format(
      $s$insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius) values (%L, %L, %L, 0.5, 0.5, 0.1)$s$,
      a.school_id, b.draft_map, 'Cross ' || b.code));

    -- media tickets across schools (G-04)
    perform pg_temp.expect_fk(p || 'media.read ticket for foreign photo', format(
      $s$insert into public.media_tickets (school_id, operation, item_id, item_photo_id, staff_member_id, expires_at)
         values (%L, 'media.read', %L, %L, '00000000-5b00-4000-8000-000000000001', now() + interval '30 seconds')$s$,
      a.school_id, b.item, b.photo));
    perform pg_temp.expect_fk(p || 'media.read ticket mixing items', format(
      $s$insert into public.media_tickets (school_id, operation, item_id, item_photo_id, staff_member_id, expires_at)
         values (%L, 'media.read', %L, %L, '00000000-5b00-4000-8000-000000000001', now() + interval '30 seconds')$s$,
      a.school_id, a.item, b.photo));
    perform pg_temp.expect_fk(p || 'map ticket for foreign map', format(
      $s$insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, expires_at)
         values (%L, 'map.activate', %L, '00000000-5b00-4000-8000-000000000001', now() + interval '30 seconds')$s$,
      a.school_id, b.map));
  end loop;
  end loop;
  if n_pairs <> 6 then
    raise exception 'tenant_property.sql FAILED: expected 6 ordered school pairs, got %', n_pairs;
  end if;
end $$;

do $$
begin
  if currval('pg_temp.t_rejected') <> 6 * 26 then
    raise exception 'tenant_property.sql FAILED: expected % rejected cross-tenant references, got %', 6 * 26, currval('pg_temp.t_rejected');
  end if;
  raise notice 'tenant_property.sql: % checks passed (% cross-tenant references rejected with 23503)',
    currval('pg_temp.t_checks'), currval('pg_temp.t_rejected');
end $$;

rollback;
