-- Regression checks for the database security review: no reachable pg_net (H1), assertion replay on the
-- creates without a row_version (M1), arrival deadlines that only move later and only for the edited school
-- (M2), and a verifier that can read the assertion keys and nothing else in Vault (L1).
-- One transaction, rolled back at the end. Every failed check raises; every passing check prints NOTICE PASS.
\set ON_ERROR_STOP 1
begin;

-- ---------- setup (migration role; everything below is rolled back) ----------

-- The test key is 32 bytes of 0x42 (tests/vectors); version 1 is current and there is no previous version.
-- A scheduler bearer is present so the L1 checks can show the verifier cannot see it.
do $$
declare
  v_id uuid;
  s record;
begin
  for s in select * from (values ('staff_assertion_key_v1', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI'),
                                 ('staff_assertion_key_current', '1'),
                                 ('staff_assertion_key_previous', ''),
                                 ('scheduler_bearer', 'tsec-scheduler-bearer')) as t(name, secret) loop
    select id into v_id from vault.secrets where name = s.name;
    if v_id is null then
      perform vault.create_secret(s.secret, s.name);
    else
      perform vault.update_secret(v_id, s.secret);
    end if;
  end loop;
end $$;

update public.staff_users u set google_sub = 'tsec-' || v.sub
  from (values ('00000000-5a00-4000-8000-000000000002'::uuid, 'fchs-admin'),
               ('00000000-5a00-4000-8000-000000000006'::uuid, 'sfhs-admin')) as v(id, sub)
 where u.id = v.id;
update public.staff_members set status = 'active' where id::text like '00000000-5b00-4000-8000-00000000000_';

-- Assertion v1 exactly as assertion.ts mints it, with an optional idempotency key hash.
create function pg_temp.mint(p_sub text, p_scope text, p_op text, p_body jsonb, p_idem text default null)
returns jsonb language plpgsql as $$
declare
  v_iat bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_req text := lower(gen_random_uuid()::text);
  v_sha text := encode(extensions.digest(convert_to(private.canonical_json(p_body), 'UTF8'), 'sha256'), 'hex');
  v_lines text;
begin
  v_lines := array_to_string(array[
    'v1', v_req, p_sub, lower(p_scope), p_op, '-', '-', v_sha, coalesce(p_idem, '-'), '1', v_iat::text,
    (v_iat + 30)::text], E'\n');
  return jsonb_build_object(
    'v', 'v1', 'request_id', v_req, 'google_sub', p_sub, 'scope', lower(p_scope), 'operation', p_op,
    'target_id', null, 'row_version', null, 'body_sha256', v_sha, 'idempotency_key_sha256', p_idem,
    'key_version', 1, 'iat', v_iat, 'exp', v_iat + 30,
    'mac', rtrim(translate(encode(extensions.hmac(convert_to(v_lines, 'UTF8'), decode(repeat('42', 32), 'hex'), 'sha256'),
                                  'base64'), '+/', '-_'), '='));
end $$;

create function pg_temp.item_body(p_desc text) returns jsonb language sql as $$
  select jsonb_build_object('school_code', 'FCHS', 'mode', 'staff', 'category', 'bottle', 'description', p_desc,
                            'note', null, 'map_version_id', null, 'pin_x', null, 'pin_y', null,
                            'location_id', '0a0a0a0a-1000-4000-8000-000000000001', 'photo_count', 1)
$$;

-- api_staff_create_item as recover_web with the arguments of pg_temp.item_body(p_desc).
create function pg_temp.create_item(p_assert jsonb, p_desc text) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  set local role recover_web;
  r := public.api_staff_create_item(p_assert => p_assert, p_school_code => 'FCHS', p_mode => 'staff',
         p_category => 'bottle', p_description => p_desc, p_note => null, p_map_version_id => null,
         p_pin_x => null, p_pin_y => null, p_location_id => '0a0a0a0a-1000-4000-8000-000000000001',
         p_photo_count => 1);
  reset role;
  return r;
end $$;

create function pg_temp.create_item_err(p_assert jsonb, p_desc text) returns text language plpgsql as $$
begin
  perform pg_temp.create_item(p_assert, p_desc);
  return 'ok';
exception when others then
  return case when sqlstate = 'RV001' then sqlerrm else 'sqlstate ' || sqlstate || ': ' || sqlerrm end;
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

create function pg_temp.school(p_code text) returns uuid language sql as $$
  select id from public.schools where code = p_code
$$;

-- A student item still with the finder, completed at p_basis, with the deadline /complete would have set.
create function pg_temp.open_item(p_school uuid, p_location uuid, p_basis timestamptz) returns uuid
language plpgsql as $$
declare
  v uuid := gen_random_uuid();
begin
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            posted_by_kind, device_token_hash, arrival_basis_at, arrival_deadline_at)
  values (v, p_school, 'T' || replace(v::text, '-', ''), 'bottle', 'deadline check', p_location, 'pending',
          'student', extensions.gen_random_bytes(33), p_basis,
          private.calendar_next_close(p_school, p_basis, 1));
  return v;
end $$;

-- ---------- H1: no pg_net, and the login roles reach nothing outside their function surface ----------
do $$
declare
  v_role text;
  v_extra text;
begin
  perform pg_temp.ok(not exists (select 1 from pg_extension where extname = 'pg_net'), 'H1: pg_net is not installed');
  perform pg_temp.ok(exists (select 1 from pg_extension where extname = 'http'), 'H1: the drain uses the http extension');
  foreach v_role in array array['recover_web', 'recover_worker'] loop
    select string_agg(n.nspname, ',' order by n.nspname) into v_extra
      from pg_namespace n
     where (has_schema_privilege(v_role, n.oid, 'USAGE') or has_schema_privilege(v_role, n.oid, 'CREATE'))
       and n.nspname not in ('public', 'pg_catalog', 'information_schema')
       and n.nspname !~ '^pg_(toast|temp_|toast_temp_)';
    perform pg_temp.eq(coalesce(v_extra, ''), '', 'H1: ' || v_role || ' has USAGE only on public (and the catalogs)');
    perform pg_temp.ok(not has_schema_privilege(v_role, 'public', 'CREATE'), 'H1: ' || v_role || ' cannot create in public');
    perform pg_temp.ok(not has_function_privilege(v_role, 'private.cron_drain()', 'EXECUTE'),
                       'H1: ' || v_role || ' cannot run the cron drain');
  end loop;
  perform pg_temp.ok((select command from cron.job where jobname = 'recover_drain') = 'select private.cron_drain()',
                     'H1: the drain is still scheduled every minute through private.cron_drain()');
end $$;

-- ---------- L1: the verifier reads the assertion keys and nothing else in Vault ----------
do $$
declare
  v_names text;
begin
  begin
    set local role recover_attestation_owner;
    perform 1 from vault.decrypted_secrets limit 1;
    raise exception 'FAIL: L1: recover_attestation_owner read vault.decrypted_secrets';
  exception when insufficient_privilege then
    raise notice 'PASS L1: recover_attestation_owner cannot read vault.decrypted_secrets';
  end;
  set local role recover_attestation_owner;
  select string_agg(name, ',' order by name) into v_names from private.staff_assertion_keys;
  reset role;
  perform pg_temp.eq(v_names, 'staff_assertion_key_current,staff_assertion_key_previous,staff_assertion_key_v1',
                     'L1: private.staff_assertion_keys shows only staff_assertion_key_* (no scheduler_bearer)');
  perform pg_temp.ok(not has_table_privilege('recover_api_owner', 'private.staff_assertion_keys', 'SELECT')
                     and not has_table_privilege('recover_system_owner', 'private.staff_assertion_keys', 'SELECT')
                     and not has_table_privilege('recover_web', 'private.staff_assertion_keys', 'SELECT'),
                     'L1: only the attestation owner can read the key view');
end $$;

-- ---------- M1: replaying a create assertion returns the first result ----------
do $$
declare
  v_fchs uuid := pg_temp.school('FCHS');
  a jsonb;
  a2 jsonb;
  r1 jsonb;
  r2 jsonb;
  v_idem text := encode(sha256(convert_to('tsec-idempotency-key-1', 'UTF8')), 'hex');
begin
  a := pg_temp.mint('tsec-fchs-admin', 'school:' || v_fchs, 'item.create', pg_temp.item_body('replayed bottle'));
  r1 := pg_temp.create_item(a, 'replayed bottle');
  r2 := pg_temp.create_item(a, 'replayed bottle');
  perform pg_temp.ok(r1 ? 'itemId' and r2 = r1, 'M1: item.create replay returns the first result');
  perform pg_temp.eq((select count(*)::text from public.items where description = 'replayed bottle'), '1',
                     'M1: item.create replay creates one item');
  perform pg_temp.eq((select count(*)::text from public.audit_log
                       where request_id = (a->>'request_id')::uuid and action = 'item.create'), '1',
                     'M1: item.create replay writes one audit row');

  a := pg_temp.mint('tsec-fchs-admin', 'school:' || v_fchs, 'item.create', pg_temp.item_body('fresh bottle'));
  r2 := pg_temp.create_item(a, 'fresh bottle');
  perform pg_temp.ok(r2->>'itemId' is distinct from r1->>'itemId', 'M1: a new assertion creates a new item');

  -- The same idempotency key in two separately minted assertions (a client retry) is one item.
  a := pg_temp.mint('tsec-fchs-admin', 'school:' || v_fchs, 'item.create', pg_temp.item_body('keyed bottle'), v_idem);
  a2 := pg_temp.mint('tsec-fchs-admin', 'school:' || v_fchs, 'item.create', pg_temp.item_body('keyed bottle'), v_idem);
  perform pg_temp.ok(a->>'request_id' <> a2->>'request_id', 'M1: two mints, two request ids');
  r1 := pg_temp.create_item(a, 'keyed bottle');
  r2 := pg_temp.create_item(a2, 'keyed bottle');
  perform pg_temp.ok(r2 = r1, 'M1: a retry with the same idempotency key returns the first result');
  perform pg_temp.eq((select count(*)::text from public.items where description = 'keyed bottle'), '1',
                     'M1: a retry with the same idempotency key creates one item');
  a2 := pg_temp.mint('tsec-fchs-admin', 'school:' || v_fchs, 'item.create', pg_temp.item_body('other bottle'), v_idem);
  perform pg_temp.eq(pg_temp.create_item_err(a2, 'other bottle'), 'idempotency_conflict',
                     'M1: the same idempotency key with a different body is idempotency_conflict');

  a := pg_temp.mint('tsec-fchs-admin', 'school:' || v_fchs, 'map.create', jsonb_build_object('school_code', 'FCHS'));
  set local role recover_web;
  r1 := public.api_staff_map_create_draft(p_assert => a, p_school_code => 'FCHS');
  r2 := public.api_staff_map_create_draft(p_assert => a, p_school_code => 'FCHS');
  reset role;
  perform pg_temp.ok(r1 ? 'mapVersionId' and r2 = r1, 'M1: map.create replay returns the first draft');
  perform pg_temp.eq((select count(*)::text from public.audit_log
                       where request_id = (a->>'request_id')::uuid and action = 'map.create_draft'), '1',
                     'M1: map.create replay creates one draft');
end $$;

-- ---------- M2: deadlines move only later, and only for the school whose calendar changed ----------
do $$
declare
  v_fchs uuid := pg_temp.school('FCHS');
  v_sfhs uuid := pg_temp.school('SFHS');
  v_loc uuid := '0a0a0a0a-1000-4000-8000-000000000001';
  v_today date := (now() at time zone 'America/New_York')::date;
  v_wed date;
  v_item uuid;
  v_edge uuid;
  v_held uuid;
  v_deadline timestamptz;
  v_version bigint;
  v_last date;
  v_days jsonb;
  a jsonb;
  r jsonb;
begin
  -- A Wednesday two to three weeks out, inside the seeded calendar (weekdays open 07:30-16:30).
  v_wed := v_today + 14 + ((3 - extract(isodow from v_today + 14)::int + 7) % 7);
  v_item := pg_temp.open_item(v_fchs, v_loc, (v_wed + time '12:00') at time zone 'America/New_York');
  select arrival_deadline_at, row_version into v_deadline, v_version from public.items where id = v_item;
  perform pg_temp.eq(v_deadline::text, (((v_wed + 1) + time '16:30') at time zone 'America/New_York')::text,
                     'M2: setup deadline is the close of the next school day (Thursday)');

  -- Another school's closure, through the staff API, touches nothing at FCHS.
  v_days := jsonb_build_array(jsonb_build_object('day', (v_wed + 1)::text, 'isOpen', false));
  a := pg_temp.mint('tsec-sfhs-admin', 'school:' || v_sfhs, 'calendar.write',
                    jsonb_build_object('school_code', 'SFHS', 'days', v_days));
  set local role recover_web;
  r := public.api_staff_calendar_upsert(p_assert => a, p_school_code => 'SFHS', p_days => v_days);
  reset role;
  perform pg_temp.eq(r->>'upserted', '1', 'M2: the SFHS closure was written through the staff API');
  perform pg_temp.ok((select arrival_deadline_at = v_deadline and row_version = v_version from public.items where id = v_item),
                     'M2: an SFHS calendar edit leaves the FCHS deadline and row_version alone');

  -- FCHS closes that Thursday: the deadline moves to Friday's close, once.
  update public.school_calendar_days set is_open = false, open_at = null, close_at = null
   where school_id = v_fchs and day = v_wed + 1;
  perform pg_temp.ok((select arrival_deadline_at = (((v_wed + 2) + time '16:30') at time zone 'America/New_York')
                             and row_version = v_version + 1 from public.items where id = v_item),
                     'M2: an FCHS closure on the deadline day extends the deadline to the next school day');

  -- Reopening Thursday never pulls the deadline back.
  update public.school_calendar_days set is_open = true, open_at = '07:30', close_at = '16:30'
   where school_id = v_fchs and day = v_wed + 1;
  perform pg_temp.ok((select arrival_deadline_at = (((v_wed + 2) + time '16:30') at time zone 'America/New_York')
                        from public.items where id = v_item),
                     'M2: reopening the day does not move the deadline earlier');

  -- A longer never-arrived window extends; a shorter one does not shorten.
  update public.schools set never_arrived_school_days = 3 where id = v_fchs;
  perform pg_temp.ok((select arrival_deadline_at = (((v_wed + 5) + time '16:30') at time zone 'America/New_York')
                        from public.items where id = v_item),
                     'M2: never_arrived_school_days 1 -> 3 extends to the third school day (Monday)');
  update public.schools set never_arrived_school_days = 1 where id = v_fchs;
  perform pg_temp.ok((select arrival_deadline_at = (((v_wed + 5) + time '16:30') at time zone 'America/New_York')
                        from public.items where id = v_item),
                     'M2: never_arrived_school_days 3 -> 1 does not shorten the deadline');

  -- Completed past the end of coverage: no deadline (fail safe) until coverage arrives.
  select max(day) into v_last from public.school_calendar_days where school_id = v_fchs;
  v_edge := pg_temp.open_item(v_fchs, v_loc, (v_last + time '12:00') at time zone 'America/New_York');
  perform pg_temp.ok((select arrival_deadline_at is null from public.items where id = v_edge),
                     'M2: no calendar coverage after completion leaves the deadline NULL');
  insert into public.school_calendar_days (school_id, day, is_open, open_at, close_at, source)
  select v_fchs, d::date, extract(isodow from d) < 6,
         case when extract(isodow from d) < 6 then time '07:30' end,
         case when extract(isodow from d) < 6 then time '16:30' end, 'test'
    from generate_series(v_last + 1, v_last + 10, interval '1 day') as d;
  perform pg_temp.ok((select arrival_deadline_at = private.calendar_next_close(v_fchs, arrival_basis_at, 1)
                             and arrival_deadline_at is not null
                        from public.items where id = v_edge),
                     'M2: new coverage fills the missing deadline');

  -- Items no longer with the finder are never recomputed.
  v_held := pg_temp.open_item(v_fchs, v_loc, (v_wed + time '12:00') at time zone 'America/New_York');
  update public.items set custody = 'at_location', current_location_id = v_loc, received_at = now() where id = v_held;
  select arrival_deadline_at, row_version into v_deadline, v_version from public.items where id = v_held;
  update public.school_calendar_days set is_open = false, open_at = null, close_at = null
   where school_id = v_fchs and day = v_wed + 1;
  perform pg_temp.ok((select arrival_deadline_at = v_deadline and row_version = v_version from public.items where id = v_held),
                     'M2: a received item keeps its deadline and row_version');
end $$;

rollback;
