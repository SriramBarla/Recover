-- constraints.sql: every CHECK on items, item_photos, lost_reports and map_versions gets a positive insert that
-- passes and a negative insert that fails (05 "Constraints to test one by one"), with the v0.1 regressions pinned by
-- name: F-17, F-18, F-19, F-39, F-51, G-02, G-03.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/constraints.sql
-- Each negative row is also evaluated against every CHECK expression of its table (pg_constraint), so the test knows
-- exactly which constraints the row violates. The last block fails if any CHECK of the four tables was never
-- violated by some negative row: a new constraint without a test is a build failure.
-- Fixtures live in a throwaway school (ZZCON); everything is rolled back.
\set ON_ERROR_STOP 1
\set QUIET 1
begin;
set local lock_timeout = '20s';

create temp sequence t_checks;
create temp sequence t_gen start 10;
create temp table t_hits (tbl text, con text, label text);

-- CHECK constraints of p_table that p_row violates (a CHECK fails only when its expression is false). Column
-- defaults are applied first, exactly as the INSERT will apply them.
create function pg_temp.failing(p_table text, p_row jsonb) returns text[] language plpgsql as $$
declare
  c record;
  v boolean;
  v_default jsonb;
  v_row jsonb := '{}'::jsonb;
  r text[] := '{}';
begin
  for c in
    select a.attname, pg_get_expr(d.adbin, d.adrelid) as expr
      from pg_attribute a
      join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = ('public.' || p_table)::regclass and a.attgenerated = '' and not a.attisdropped
  loop
    execute format('select to_jsonb(%s)', c.expr) into v_default;
    v_row := v_row || jsonb_build_object(c.attname, v_default);
  end loop;
  p_row := v_row || p_row;
  for c in
    select conname, pg_get_expr(conbin, conrelid) as expr
      from pg_constraint where conrelid = ('public.' || p_table)::regclass and contype = 'c' order by conname
  loop
    execute format('select (%s) from jsonb_populate_record(null::public.%I, $1) as t', c.expr, p_table) into v using p_row;
    if v is false then
      r := r || c.conname::text;
    end if;
  end loop;
  return r;
end $$;

create function pg_temp.ins(p_table text, p_row jsonb) returns void language plpgsql as $$
declare
  v_cols text;
begin
  -- public_id is unique; CHECKs only look at whether it is null, so every insert gets a fresh value
  if p_table = 'items' and jsonb_typeof(p_row->'public_id') = 'string' then
    p_row := p_row || jsonb_build_object('public_id', 'ZZ-' || gen_random_uuid());
  end if;
  select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(p_row) as k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
                 p_table, v_cols, v_cols, p_table) using p_row;
end $$;

-- The insert must fail with 23514 on one of the constraints the row violates; p_n pins how many it violates
-- (1 for an isolated rule; more only for a CHECK that is implied by others).
create function pg_temp.neg(p_label text, p_table text, p_row jsonb, p_n int default 1) returns void language plpgsql as $$
declare
  v_fail text[] := pg_temp.failing(p_table, p_row);
  v_state text;
  v_con text;
begin
  if cardinality(v_fail) = 0 or cardinality(v_fail) <> p_n then
    raise exception 'constraints.sql FAILED: % violates % CHECK(s) %, expected %', p_label, cardinality(v_fail), v_fail, p_n;
  end if;
  begin
    perform pg_temp.ins(p_table, p_row);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_con = constraint_name;
    if v_state <> '23514' or not (v_con = any (v_fail)) then
      raise exception 'constraints.sql FAILED: % raised % on % (expected 23514 on one of %)', p_label, v_state, v_con, v_fail;
    end if;
    insert into t_hits select p_table, unnest(v_fail), p_label;
    perform nextval('pg_temp.t_checks');
    return;
  end;
  raise exception 'constraints.sql FAILED: % was accepted', p_label;
end $$;

create function pg_temp.pos(p_label text, p_table text, p_row jsonb) returns void language plpgsql as $$
declare
  v_fail text[] := pg_temp.failing(p_table, p_row);
begin
  if cardinality(v_fail) > 0 then
    raise exception 'constraints.sql FAILED: positive % violates %', p_label, v_fail;
  end if;
  begin
    perform pg_temp.ins(p_table, p_row);
  exception when others then
    raise exception 'constraints.sql FAILED: positive % raised % (%)', p_label, sqlstate, sqlerrm;
  end;
  perform nextval('pg_temp.t_checks');
end $$;

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'constraints.sql FAILED: %', p_label;
  end if;
  perform nextval('pg_temp.t_checks');
end $$;

-- throwaway tenant: a school, a location, a draft map with a zone
insert into public.schools (id, code, name) values ('0f0f0f0f-0000-4000-8000-00000000000f', 'ZZCON', 'Constraint Test School');
insert into public.locations (id, school_id, code, name, item_seq)
values ('0f0f0f0f-1000-4000-8000-00000000000f', '0f0f0f0f-0000-4000-8000-00000000000f', 'W', 'West Office', 41);
insert into public.map_versions (id, school_id, width_px, height_px)
values ('0f0f0f0f-2000-4000-8000-00000000000f', '0f0f0f0f-0000-4000-8000-00000000000f', 1000, 800);
insert into public.map_zones (id, school_id, map_version_id, name, cx, cy, radius)
values ('0f0f0f0f-3000-4000-8000-00000000000f', '0f0f0f0f-0000-4000-8000-00000000000f',
        '0f0f0f0f-2000-4000-8000-00000000000f', 'Main Hall', 0.5, 0.5, 0.2);
insert into public.items (id, school_id, category, description, dropoff_location_id, posted_by_kind, device_token_hash)
values ('0f0f0f0f-4000-4000-8000-00000000000f', '0f0f0f0f-0000-4000-8000-00000000000f', 'bag', 'photo holder',
        '0f0f0f0f-1000-4000-8000-00000000000f', 'student', extensions.gen_random_bytes(33));

-- =====================================================================================================
-- items
-- =====================================================================================================
do $$
declare
  s constant text := '0f0f0f0f-0000-4000-8000-00000000000f';
  map constant text := '0f0f0f0f-2000-4000-8000-00000000000f';
  zone constant text := '0f0f0f0f-3000-4000-8000-00000000000f';
  staff constant text := '00000000-5b00-4000-8000-000000000003';
  dev constant text := '\x' || repeat('ab', 33);
  -- a valid student draft; the other shapes are built from it
  draft jsonb := jsonb_build_object('school_id', s, 'category', 'bag', 'description', 'blue bag',
                                    'dropoff_location_id', '0f0f0f0f-1000-4000-8000-00000000000f',
                                    'posted_by_kind', 'student', 'device_token_hash', dev);
  pending jsonb;
  approved jsonb;
  rejected jsonb;
  staff_item jsonb;
  terminal jsonb;
  v_id uuid;
begin
  pending := draft || jsonb_build_object('review_status', 'pending', 'public_id', 'ZZ-' || gen_random_uuid());
  approved := draft || jsonb_build_object('review_status', 'approved', 'public_id', 'ZZ-' || gen_random_uuid(),
                                          'reviewed_at', now(), 'reviewed_by', staff);
  rejected := draft || jsonb_build_object('review_status', 'rejected', 'public_id', 'ZZ-' || gen_random_uuid(),
                                          'reviewed_at', now(), 'reviewed_by', staff, 'reject_reason', 'pii_visible');
  staff_item := (draft - 'device_token_hash') || jsonb_build_object('posted_by_kind', 'staff', 'posted_by_staff_id', staff);
  terminal := approved || jsonb_build_object('custody', 'claimed', 'claimed_at', now(), 'terminal_at', now(),
                                             'publication_status', 'withdrawn', 'withdrawn_at', now());

  -- column checks
  perform pg_temp.pos('items description 2 chars', 'items', draft || '{"description": "ok"}');
  perform pg_temp.pos('items description 120 chars', 'items', draft || jsonb_build_object('description', repeat('d', 120)));
  perform pg_temp.neg('items description 1 char', 'items', draft || '{"description": "x"}');
  perform pg_temp.neg('items description 121 chars', 'items', draft || jsonb_build_object('description', repeat('d', 121)));
  perform pg_temp.pos('items private note 80', 'items', draft || jsonb_build_object('location_note_private', repeat('n', 80)));
  perform pg_temp.neg('items private note 81', 'items', draft || jsonb_build_object('location_note_private', repeat('n', 81)));
  perform pg_temp.pos('items pin bounds', 'items', draft || jsonb_build_object('map_version_id', map, 'pin_x', 1.0, 'pin_y', 0.0));
  perform pg_temp.neg('items pin_x > 1', 'items', draft || jsonb_build_object('map_version_id', map, 'pin_x', 1.5, 'pin_y', 0.5));
  perform pg_temp.neg('items pin_y < 0', 'items', draft || jsonb_build_object('map_version_id', map, 'pin_x', 0.5, 'pin_y', -0.1));
  perform pg_temp.pos('items photo_count 3 (G-37)', 'items', draft || '{"photo_count": 3}');
  perform pg_temp.neg('items photo_count 0', 'items', draft || '{"photo_count": 0}');
  perform pg_temp.neg('items photo_count 4', 'items', draft || '{"photo_count": 4}');
  perform pg_temp.pos('items posted_by_kind backfill', 'items', staff_item || '{"posted_by_kind": "backfill"}');
  perform pg_temp.neg('items posted_by_kind unknown', 'items', staff_item || '{"posted_by_kind": "robot"}');
  perform pg_temp.neg('items device digest 32 bytes', 'items', draft || jsonb_build_object('device_token_hash', '\x' || repeat('ab', 32)));
  perform pg_temp.pos('items reject reason', 'items', rejected);
  perform pg_temp.neg('items reject reason unknown', 'items', rejected || '{"reject_reason": "rude"}');
  perform pg_temp.pos('items src', 'items', draft || '{"src": "poster-hall-a"}');
  perform pg_temp.neg('items src format', 'items', draft || '{"src": "Bad Src"}');

  -- pins, map, zone
  perform pg_temp.pos('items zone with its map', 'items', draft || jsonb_build_object('map_version_id', map, 'zone_id', zone));
  perform pg_temp.neg('items pin_x without pin_y', 'items', draft || jsonb_build_object('map_version_id', map, 'pin_x', 0.5));
  perform pg_temp.neg('items pin without map version', 'items', draft || '{"pin_x": 0.5, "pin_y": 0.5}');
  perform pg_temp.neg('items zone without map version', 'items', draft || jsonb_build_object('zone_id', zone));

  -- F-17: public_id is NULL only while draft
  perform pg_temp.pos('F-17 draft with null public_id', 'items', draft);
  perform pg_temp.pos('F-17 pending with public_id', 'items', pending);
  perform pg_temp.neg('F-17 pending without public_id', 'items', pending - 'public_id');

  -- F-51: a rejected row may drop its description; nothing else may
  perform pg_temp.pos('F-51 rejected row without description', 'items', rejected - 'description');
  perform pg_temp.neg('F-51 pending row without description', 'items', pending - 'description');
  insert into public.items (school_id, public_id, category, description, dropoff_location_id, posted_by_kind,
                            device_token_hash, review_status, reviewed_at, reviewed_by, reject_reason)
  values (s::uuid, 'ZZ-' || gen_random_uuid(), 'bag', 'to be minimized', '0f0f0f0f-1000-4000-8000-00000000000f', 'student',
          extensions.gen_random_bytes(33), 'rejected', now(), staff::uuid, 'spam')
  returning id into v_id;
  update public.items set description = null where id = v_id;
  perform pg_temp.expect((select description from public.items where id = v_id) is null, 'F-51 rejected row can null its description');

  -- published requires a description (implied by the text-clearing and deletion rules, so it never fails alone)
  perform pg_temp.pos('items published with description', 'items', approved || '{"publication_status": "published"}');
  perform pg_temp.neg('items published without description', 'items',
    (approved - 'description') || jsonb_build_object('publication_status', 'published', 'text_cleared_at', now(), 'deleted_at', now()), 2);

  -- G-03: the student device link can be cleared only with device_link_cleared_at
  perform pg_temp.pos('G-03 cleared device link', 'items', (draft - 'device_token_hash') || jsonb_build_object('device_link_cleared_at', now()));
  perform pg_temp.pos('G-03 staff item has no device link', 'items', staff_item);
  perform pg_temp.neg('G-03 student item without device link or cleared_at', 'items', draft - 'device_token_hash');
  perform pg_temp.neg('items cleared_at while a digest remains', 'items', draft || jsonb_build_object('device_link_cleared_at', now()));
  insert into public.items (school_id, category, description, dropoff_location_id, posted_by_kind, device_token_hash)
  values (s::uuid, 'bag', 'device link', '0f0f0f0f-1000-4000-8000-00000000000f', 'student', extensions.gen_random_bytes(33))
  returning id into v_id;
  begin
    update public.items set device_token_hash = null where id = v_id;
    raise exception 'constraints.sql FAILED: G-03 digest cleared without device_link_cleared_at';
  exception when check_violation then
    perform pg_temp.expect(true, 'G-03 clearing the digest alone is refused');
  end;
  update public.items set device_token_hash = null, device_link_cleared_at = now() where id = v_id;
  perform pg_temp.expect((select device_token_hash is null and device_link_cleared_at is not null from public.items where id = v_id),
                         'G-03 clearing with device_link_cleared_at is accepted');

  -- staff attribution and high-value categories
  perform pg_temp.neg('items staff post without staff id', 'items', staff_item - 'posted_by_staff_id');
  perform pg_temp.pos('items staff phone intake', 'items', staff_item || '{"category": "phone"}');
  perform pg_temp.neg('items student phone', 'items', draft || '{"category": "phone"}');

  -- review fields
  perform pg_temp.neg('items rejected without reason', 'items', rejected - 'reject_reason');
  perform pg_temp.neg('items approved without reviewed_at', 'items', approved - 'reviewed_at');
  perform pg_temp.neg('F-18 generating without approval', 'items', pending || '{"publication_status": "generating"}');
  perform pg_temp.pos('F-18 approved and generating', 'items', approved || '{"publication_status": "generating"}');

  -- custody
  perform pg_temp.pos('items at_location', 'items', pending || jsonb_build_object('custody', 'at_location', 'received_at', now(),
                                                                                    'current_location_id', '0f0f0f0f-1000-4000-8000-00000000000f'));
  perform pg_temp.neg('items at_location without receipt', 'items', pending || jsonb_build_object('custody', 'at_location',
                                                                                    'current_location_id', '0f0f0f0f-1000-4000-8000-00000000000f'));
  perform pg_temp.neg('items claimed without claimed_at', 'items', terminal - 'claimed_at');
  perform pg_temp.pos('items disposed', 'items', approved || jsonb_build_object('custody', 'expired_disposed', 'disposed_at', now(),
                                                                                'terminal_at', now(), 'expires_at', now(),
                                                                                'disposition_due_at', now()));
  perform pg_temp.neg('items disposed_at while with finder', 'items', pending || jsonb_build_object('disposed_at', now()));
  perform pg_temp.neg('items disposition due without expiry', 'items', pending || jsonb_build_object('disposition_due_at', now()));

  -- G-02: terminal custody only with a hidden or withdrawn publication; unreviewed items may be claimed
  perform pg_temp.pos('G-02 claimed and withdrawn', 'items', terminal);
  perform pg_temp.pos('G-02 pending item claimed, still hidden', 'items',
    pending || jsonb_build_object('custody', 'claimed', 'claimed_at', now(), 'terminal_at', now()));
  perform pg_temp.pos('G-02 rejected item disposed, still hidden', 'items',
    rejected || jsonb_build_object('custody', 'expired_donated', 'disposed_at', now(), 'terminal_at', now()));
  perform pg_temp.neg('G-02 claimed item cannot be published', 'items',
    terminal || jsonb_build_object('publication_status', 'published', 'withdrawn_at', null));
  perform pg_temp.neg('items terminal custody without terminal_at', 'items', terminal - 'terminal_at');
  perform pg_temp.neg('items terminal_at while with finder', 'items', pending || jsonb_build_object('terminal_at', now()));
  perform pg_temp.neg('items withdrawn without withdrawn_at', 'items', approved || '{"publication_status": "withdrawn"}');
  perform pg_temp.neg('items published after deletion', 'items', approved || jsonb_build_object('publication_status', 'published',
                                                                                                'deleted_at', now()));
  perform pg_temp.pos('items deleted and hidden', 'items', approved || jsonb_build_object('deleted_at', now()));

  -- anonymization and text clearing (one-way states)
  perform pg_temp.pos('items rejected content anonymized', 'items', (rejected - 'description') ||
    jsonb_build_object('content_anonymized_at', now(), 'device_token_hash', null, 'device_link_cleared_at', now()));
  perform pg_temp.neg('items anonymized with content left', 'items', rejected || jsonb_build_object('content_anonymized_at', now()));
  perform pg_temp.pos('items terminal text cleared', 'items', (terminal - 'description') || jsonb_build_object('text_cleared_at', now()));
  perform pg_temp.neg('items text cleared before terminal', 'items', (pending - 'description') || jsonb_build_object('text_cleared_at', now()));
end $$;

-- =====================================================================================================
-- item_photos
-- =====================================================================================================
do $$
declare
  s constant text := '0f0f0f0f-0000-4000-8000-00000000000f';
  item constant text := '0f0f0f0f-4000-4000-8000-00000000000f';
  pre constant text := '0f0f0f0f-0000-4000-8000-00000000000f/0f0f0f0f-4000-4000-8000-00000000000f/p/';
  tok constant text := '\x' || repeat('cd', 16);
  up jsonb;
  canon jsonb;
  pub jsonb;
begin
  up := jsonb_build_object('school_id', s, 'item_id', item, 'position', 0, 'status', 'uploaded', 'incoming_path', pre || 'raw');
  canon := (up - 'incoming_path') || jsonb_build_object('status', 'canonical_ready', 'original_path', pre || 'canonical.jpg',
                                                         'review_path', pre || 'review.jpg', 'bytes', 1000, 'width', 10, 'height', 10);
  pub := canon || jsonb_build_object('status', 'public_ready', 'thumb_path', pre || 't/thumb.jpg', 'medium_path', pre || 't/medium.jpg',
                                     'public_object_token', tok);

  perform pg_temp.pos('photos position 2', 'item_photos', up || jsonb_build_object('position', 2, 'generation', nextval('t_gen')));
  perform pg_temp.neg('photos position 3', 'item_photos', up || jsonb_build_object('position', 3, 'generation', nextval('t_gen')));
  perform pg_temp.neg('photos generation 0', 'item_photos', up || '{"generation": 0}');
  perform pg_temp.neg('photos token 15 bytes', 'item_photos', pub || jsonb_build_object('generation', nextval('t_gen'),
                                                                                           'public_object_token', '\x' || repeat('cd', 15)));
  perform pg_temp.pos('photos raw 1 MiB (G-38)', 'item_photos', up || jsonb_build_object('generation', nextval('t_gen'), 'raw_bytes', 1048576));
  perform pg_temp.neg('photos raw over 1 MiB', 'item_photos', up || jsonb_build_object('generation', nextval('t_gen'), 'raw_bytes', 1048577));
  perform pg_temp.neg('photos raw 0 bytes', 'item_photos', up || jsonb_build_object('generation', nextval('t_gen'), 'raw_bytes', 0));
  perform pg_temp.pos('photos canonical over 1 MiB (G-38)', 'item_photos', canon || jsonb_build_object('generation', nextval('t_gen'),
                                                                                                        'bytes', 2000000));
  perform pg_temp.neg('photos canonical 0 bytes', 'item_photos', canon || jsonb_build_object('generation', nextval('t_gen'), 'bytes', 0));
  perform pg_temp.neg('photos width 0', 'item_photos', canon || jsonb_build_object('generation', nextval('t_gen'), 'width', 0));
  perform pg_temp.neg('photos height 0', 'item_photos', canon || jsonb_build_object('generation', nextval('t_gen'), 'height', 0));
  perform pg_temp.neg('F-18 photos status approving', 'item_photos', up || jsonb_build_object('generation', nextval('t_gen'),
                                                                                               'status', 'approving'));
  perform pg_temp.pos('photos failed with code', 'item_photos', (up - 'incoming_path') || jsonb_build_object('generation', nextval('t_gen'),
                                                                                           'status', 'failed', 'failure_code', 'decode_failed'));
  perform pg_temp.neg('photos failure code format', 'item_photos', up || jsonb_build_object('generation', nextval('t_gen'),
                                                                                             'status', 'failed', 'failure_code', 'Bad-Code'));
  perform pg_temp.pos('photos canonical_ready', 'item_photos', canon || jsonb_build_object('generation', nextval('t_gen')));
  perform pg_temp.neg('photos canonical_ready without review rendition (G-28)', 'item_photos',
                      (canon - 'review_path') || jsonb_build_object('generation', nextval('t_gen')));
  perform pg_temp.pos('photos public_ready', 'item_photos', pub || jsonb_build_object('generation', nextval('t_gen')));
  perform pg_temp.neg('photos public_ready without token (F-98)', 'item_photos',
                      (pub - 'public_object_token') || jsonb_build_object('generation', nextval('t_gen')));
  -- F-19: deleted generations have no paths
  perform pg_temp.pos('F-19 deleted photo with null paths', 'item_photos', (up - 'incoming_path') ||
                      jsonb_build_object('generation', nextval('t_gen'), 'status', 'deleted'));
  perform pg_temp.neg('F-19 deleted photo keeping a path', 'item_photos', (up - 'incoming_path') ||
                      jsonb_build_object('generation', nextval('t_gen'), 'status', 'deleted', 'thumb_path', pre || 't/thumb.jpg'));
end $$;

-- =====================================================================================================
-- lost_reports
-- =====================================================================================================
do $$
declare
  s constant text := '0f0f0f0f-0000-4000-8000-00000000000f';
  map constant text := '0f0f0f0f-2000-4000-8000-00000000000f';
  open_r jsonb := jsonb_build_object('school_id', s, 'category', 'bottle', 'description', 'blue bottle',
                                     'device_token_hash', '\x' || repeat('ef', 33), 'expires_at', now() + interval '60 days');
  closed jsonb;
begin
  closed := open_r || jsonb_build_object('status', 'closed_by_user', 'terminal_at', now());
  perform pg_temp.pos('reports description 3 chars', 'lost_reports', open_r || '{"description": "cap"}');
  perform pg_temp.neg('reports description 2 chars', 'lost_reports', open_r || '{"description": "ab"}');
  perform pg_temp.neg('reports description 201 chars', 'lost_reports', open_r || jsonb_build_object('description', repeat('r', 201)));
  perform pg_temp.pos('reports pin', 'lost_reports', open_r || jsonb_build_object('map_version_id', map, 'pin_x', 0.0, 'pin_y', 1.0));
  perform pg_temp.neg('reports pin_x > 1', 'lost_reports', open_r || jsonb_build_object('map_version_id', map, 'pin_x', 1.1, 'pin_y', 0.5));
  perform pg_temp.neg('reports pin_y < 0', 'lost_reports', open_r || jsonb_build_object('map_version_id', map, 'pin_x', 0.5, 'pin_y', -1));
  perform pg_temp.neg('reports device digest 1 byte', 'lost_reports', open_r || '{"device_token_hash": "\\x01"}');
  perform pg_temp.pos('reports closed_by_staff (G-43)', 'lost_reports', open_r || jsonb_build_object('status', 'closed_by_staff', 'terminal_at', now()));
  perform pg_temp.neg('reports status unknown', 'lost_reports', open_r || jsonb_build_object('status', 'closed', 'terminal_at', now()));
  perform pg_temp.neg('reports negative match_count', 'lost_reports', open_r || '{"match_count": -1}');
  perform pg_temp.neg('reports pin_x without pin_y', 'lost_reports', open_r || jsonb_build_object('map_version_id', map, 'pin_x', 0.5));
  perform pg_temp.neg('reports pin without map version', 'lost_reports', open_r || '{"pin_x": 0.5, "pin_y": 0.5}');
  perform pg_temp.neg('reports open without device digest', 'lost_reports', open_r - 'device_token_hash');
  perform pg_temp.pos('reports closed without device digest', 'lost_reports', closed - 'device_token_hash');
  perform pg_temp.neg('reports open with terminal_at', 'lost_reports', open_r || jsonb_build_object('terminal_at', now()));
  perform pg_temp.neg('reports closed without terminal_at', 'lost_reports', closed - 'terminal_at');
  perform pg_temp.pos('reports content cleared', 'lost_reports', (closed - 'description' - 'device_token_hash') ||
                      jsonb_build_object('content_cleared_at', now()));
  perform pg_temp.neg('reports cleared with content left', 'lost_reports', closed || jsonb_build_object('content_cleared_at', now()));
end $$;

-- =====================================================================================================
-- map_versions (G-07)
-- =====================================================================================================
do $$
declare
  s constant text := '0f0f0f0f-0000-4000-8000-00000000000f';
  draft jsonb := jsonb_build_object('school_id', s);
  dims jsonb := jsonb_build_object('width_px', 1600, 'height_px', 1000);
  approved jsonb;
begin
  approved := draft || dims || jsonb_build_object('approval_status', 'approved', 'public_storage_path', s || '/v/' || repeat('a', 32) || '.jpg',
                                                  'approved_by', '00000000-5b00-4000-8000-000000000001', 'approved_at', now());
  perform pg_temp.pos('maps draft without dimensions (G-07)', 'map_versions', draft);
  perform pg_temp.pos('maps canonical draft', 'map_versions', draft || dims);
  perform pg_temp.neg('maps width 0', 'map_versions', draft || '{"width_px": 0}');
  perform pg_temp.neg('maps height 0', 'map_versions', draft || '{"height_px": 0}');
  perform pg_temp.neg('maps status unknown', 'map_versions', draft || '{"approval_status": "active"}');
  perform pg_temp.pos('maps rejected with reason', 'map_versions', draft || dims || jsonb_build_object('approval_status', 'rejected',
                                                                                                       'rejected_reason', repeat('r', 200)));
  perform pg_temp.neg('maps rejected reason 201', 'map_versions', draft || jsonb_build_object('rejected_reason', repeat('r', 201)));
  perform pg_temp.pos('maps pending with dimensions', 'map_versions', draft || dims || '{"approval_status": "pending_district"}');
  perform pg_temp.neg('maps pending without dimensions (G-07)', 'map_versions', draft || '{"approval_status": "pending_district"}');
  perform pg_temp.pos('maps approved and active', 'map_versions', approved || '{"active": true}');
  perform pg_temp.neg('maps approved without public path', 'map_versions', approved - 'public_storage_path');
  perform pg_temp.neg('maps draft with a public path', 'map_versions', draft || jsonb_build_object('public_storage_path', 'k.jpg'));
  perform pg_temp.neg('maps active draft', 'map_versions', draft || '{"active": true}');
  perform pg_temp.pos('maps retired keeps its public path (G-07)', 'map_versions', approved ||
                      jsonb_build_object('approval_status', 'retired', 'retired_at', now()));
  perform pg_temp.neg('maps retired without retired_at', 'map_versions', approved || '{"approval_status": "retired"}');
end $$;

-- =====================================================================================================
-- pinned regressions outside the CHECK matrix
-- =====================================================================================================
do $$
declare
  v_id text;
begin
  -- F-18: there is no ghost `approving` state in either status enum
  perform pg_temp.expect(not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                                      where t.typname in ('review_status', 'publication_status') and e.enumlabel = 'approving'),
                         'F-18 no approving enum value');
  begin
    perform 'approving'::public.review_status;
    raise exception 'constraints.sql FAILED: F-18 approving accepted';
  exception when invalid_text_representation then
    perform pg_temp.expect(true, 'F-18 approving is not a review_status');
  end;

  -- F-39: public ids are zero-padded with lpad (format('%06s') would pad with spaces)
  v_id := private.next_public_id('0f0f0f0f-0000-4000-8000-00000000000f', '0f0f0f0f-1000-4000-8000-00000000000f');
  perform pg_temp.expect(v_id = 'ZZCON-W-000042', 'F-39 lpad public id (' || v_id || ')');
  v_id := private.next_public_id('0f0f0f0f-0000-4000-8000-00000000000f', '0f0f0f0f-1000-4000-8000-00000000000f');
  perform pg_temp.expect(v_id = 'ZZCON-W-000043', 'F-39 sequence advances');
  begin
    perform private.next_public_id('0a0a0a0a-0000-4000-8000-000000000001', '0f0f0f0f-1000-4000-8000-00000000000f');
    raise exception 'constraints.sql FAILED: F-39 next_public_id accepted a foreign location';
  exception when sqlstate 'RV001' then
    perform pg_temp.expect(sqlerrm = 'tenant_mismatch', 'F-39 public id location must belong to the school');
  end;
end $$;

-- Coverage: every CHECK constraint of the four tables was violated by at least one negative row.
do $$
declare
  v_missing text;
begin
  select string_agg(c.conrelid::regclass::text || '.' || c.conname, ', ' order by 1)
    into v_missing
    from pg_constraint c
   where c.contype = 'c'
     and c.conrelid in ('public.items'::regclass, 'public.item_photos'::regclass, 'public.lost_reports'::regclass,
                        'public.map_versions'::regclass)
     and not exists (select 1 from t_hits h where h.tbl = c.conrelid::regclass::text and h.con = c.conname);
  -- conrelid::regclass prints without the schema when public is on the search_path
  if v_missing is not null then
    select string_agg(c.conrelid::regclass::text || '.' || c.conname, ', ')
      into v_missing
      from pg_constraint c
     where c.contype = 'c'
       and c.conrelid in ('public.items'::regclass, 'public.item_photos'::regclass, 'public.lost_reports'::regclass,
                          'public.map_versions'::regclass)
       and not exists (select 1 from t_hits h where h.con = c.conname
                          and h.tbl = (select relname from pg_class where oid = c.conrelid));
  end if;
  if v_missing is not null then
    raise exception 'constraints.sql FAILED: CHECK constraints without a negative test: %', v_missing;
  end if;
  raise notice 'constraints.sql: % checks passed; % CHECK constraints covered', currval('pg_temp.t_checks'),
    (select count(*) from pg_constraint c where c.contype = 'c'
        and c.conrelid in ('public.items'::regclass, 'public.item_photos'::regclass, 'public.lost_reports'::regclass,
                           'public.map_versions'::regclass));
end $$;

rollback;
