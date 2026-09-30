-- Device-key rotation window (0220_device_rekey.sql; 13-Abuse-and-Rate-Limiting.md implementation guide "Device cookie
-- issuance"; RUNBOOK.md section 21). api_device_rekey moves one browser's rows at one school from its previous-key
-- digest to its current-key digest: items, lost reports, devices (merged), device_rejections, rate_counters and
-- idempotency_keys. Checks: every row moves and the device API keeps working with the new digest, a second call is a
-- no-op, other browsers and other schools are untouched, bad digests are refused, and only recover_web can call it.
-- One transaction, rolled back at the end. Every failed check raises; every passing check prints NOTICE PASS.
\set ON_ERROR_STOP 1
begin;
set local lock_timeout = '10s';

-- ---------- helpers ----------

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

-- A digest as the web builds it: version byte, then 32 bytes (here one repeated byte stands in for the HMAC).
create function pg_temp.digest(p_version int, p_fill text) returns bytea language sql immutable as $$
  select decode(lpad(to_hex(p_version), 2, '0') || repeat(p_fill, 32), 'hex')
$$;

create function pg_temp.school(p_code text) returns uuid language sql as $$
  select id from public.schools where code = p_code
$$;

-- Runs p_sql as p_role, then returns to the caller's role. Returns 'ok', the RV001 code and detail
-- ('invalid_input/device_digest'), or the SQLSTATE. A failed call rolls back with its block, role included.
create function pg_temp.try(p_sql text, p_role text default 'recover_web') returns text language plpgsql as $$
declare
  v_caller text := current_user;
  v_msg text;
  v_detail text;
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  execute format('set local role %I', v_caller);
  return 'ok';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return case when sqlstate = 'RV001' then v_msg || coalesce('/' || nullif(v_detail, ''), '') else 'sqlstate ' || sqlstate end;
end $$;

create function pg_temp.rekey(p_code text, p_old bytea, p_new bytea) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  set local role recover_web;
  r := public.api_device_rekey(p_school_code => p_code, p_old_digest => p_old, p_new_digest => p_new);
  reset role;
  return r;
end $$;

-- Every row at p_school that still carries p_digest, by table (0 when none).
create function pg_temp.carrying(p_school uuid, p_digest bytea) returns int language sql as $$
  select (select count(*) from public.items where school_id = p_school and device_token_hash = p_digest)::int
       + (select count(*) from public.lost_reports where school_id = p_school and device_token_hash = p_digest)::int
       + (select count(*) from public.devices where school_id = p_school and token_hash = p_digest)::int
       + (select count(*) from public.device_rejections where school_id = p_school and device_token_hash = p_digest)::int
       + (select count(*) from public.rate_counters
           where tenant_scope = 'school:' || p_school and subject_kind = 'device' and subject_hmac = p_digest)::int
       + (select count(*) from public.idempotency_keys
           where tenant_scope = 'school:' || p_school and principal_kind = 'device' and principal_hmac = p_digest)::int
$$;

-- ---------- structure and privileges ----------
do $$
declare
  f regprocedure := 'public.api_device_rekey(text, bytea, bytea)';
  v_role text;
begin
  perform pg_temp.ok((select pg_get_userbyid(p.proowner) = 'recover_api_owner' and p.prosecdef
                             and p.proconfig @> array['search_path=""']
                        from pg_proc p where p.oid = f),
                     'structure: owner recover_api_owner, SECURITY DEFINER, empty search_path');
  perform pg_temp.ok(has_function_privilege('recover_web', f, 'EXECUTE'), 'grants: recover_web can execute');
  foreach v_role in array array['recover_worker', 'anon', 'authenticated', 'service_role'] loop
    perform pg_temp.ok(not has_function_privilege(v_role, f, 'EXECUTE'), 'grants: ' || v_role || ' cannot execute');
  end loop;
  perform pg_temp.ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                                  where p.oid = f and a.grantee = 0),
                     'grants: nothing for PUBLIC');
  perform pg_temp.eq(pg_temp.try($q$select public.api_device_rekey('FCHS', '\x01', '\x02')$q$, 'recover_worker'),
                     'sqlstate 42501', 'grants: recover_worker is refused at call time');

  perform pg_temp.ok(has_table_privilege('recover_api_owner', 'public.devices', 'DELETE')
                     and has_table_privilege('recover_api_owner', 'public.rate_counters', 'DELETE')
                     and has_table_privilege('recover_api_owner', 'public.idempotency_keys', 'DELETE'),
                     'grants: the api family can delete devices, rate_counters and idempotency_keys rows');
  perform pg_temp.ok(has_column_privilege('recover_api_owner', 'public.device_rejections', 'device_token_hash', 'UPDATE')
                     and not has_column_privilege('recover_api_owner', 'public.device_rejections', 'rejected_at', 'UPDATE')
                     and not has_table_privilege('recover_api_owner', 'public.device_rejections', 'DELETE'),
                     'grants: device_rejections gains UPDATE of device_token_hash only');
  perform pg_temp.ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'reports_device_link'),
                     'index: reports_device_link finds reports by digest in any status');
end $$;

-- ---------- fixtures: browser A (old key v1, new key v2) and browser B at FCHS; browser A's bytes at SFHS ----------
-- Rows come from the device API as recover_web where it can write them, else from the migration role.
do $$
declare
  v_fchs uuid := pg_temp.school('FCHS');
  v_old bytea := pg_temp.digest(1, 'e1');
  v_new bytea := pg_temp.digest(2, 'e2');
  v_b bytea := pg_temp.digest(1, 'e3');
  v_ip bytea := decode(repeat('a1', 32), 'hex');
  v_loc uuid := '0a0a0a0a-1000-4000-8000-000000000001';
  v jsonb;
  v_r2 uuid;
  v_i2 uuid;
begin
  set local role recover_web;
  -- browser A under the old key: a draft item, an open report, a closed report, counters, two idempotency keys
  v := public.api_create_item_draft(p_school_code => 'FCHS', p_device_digest => v_old, p_category => 'bottle',
         p_description => 'Rekey draft bottle', p_dropoff_location_id => v_loc, p_photo_count => 1);
  perform set_config('rv.i1', v->>'itemId', true);
  v := public.api_create_lost_report(p_school_code => 'FCHS', p_device_digest => v_old, p_description => 'Rekey green scarf');
  perform set_config('rv.r1', v->>'reportId', true);
  v := public.api_create_lost_report(p_school_code => 'FCHS', p_device_digest => v_old, p_description => 'Rekey red umbrella');
  v_r2 := (v->>'reportId')::uuid;
  perform set_config('rv.r2', v_r2::text, true);
  perform public.api_close_lost_report('FCHS', v_old, v_r2, 0, 'found');
  perform public.api_rate_take('FCHS', 'post_item', v_old, v_ip, true);
  perform public.api_rate_take('FCHS', 'lost_report', v_old, v_ip, true);
  perform public.api_idempotency_begin('FCHS', 'device', 'item.create', v_old, sha256('\x6b31'), sha256('\x7231'));
  perform public.api_idempotency_finish('FCHS', 'device', 'item.create', v_old, sha256('\x6b31'), 201,
                                        jsonb_build_object('itemId', current_setting('rv.i1')));
  perform public.api_idempotency_begin('FCHS', 'device', 'report.create', v_old, sha256('\x6b32'), sha256('\x7232'));
  -- browser A already reached the new key once (a request on the new deployment before the old rows moved):
  -- a devices row, the same post_item windows, and the same report.create key with its own request
  perform public.api_device_touch('FCHS', v_new);
  perform public.api_rate_take('FCHS', 'post_item', v_new, v_ip, true);
  perform public.api_idempotency_begin('FCHS', 'device', 'report.create', v_new, sha256('\x6b32'), sha256('\x7233'));
  -- browser B at FCHS, and browser A's old bytes at SFHS (the same token has an unrelated digest there, F-28)
  v := public.api_create_lost_report(p_school_code => 'FCHS', p_device_digest => v_b, p_description => 'Rekey blue cap');
  perform set_config('rv.r3', v->>'reportId', true);
  perform public.api_rate_take('FCHS', 'post_item', v_b, v_ip, true);
  v := public.api_create_lost_report(p_school_code => 'SFHS', p_device_digest => v_old, p_description => 'Rekey gray gloves');
  perform set_config('rv.r4', v->>'reportId', true);
  perform public.api_create_item_draft(p_school_code => 'SFHS', p_device_digest => v_old, p_category => 'bottle',
            p_description => 'Rekey SFHS bottle', p_dropoff_location_id => '0b0b0b0b-1000-4000-8000-000000000001',
            p_photo_count => 1);
  perform public.api_rate_take('SFHS', 'post_item', v_old, v_ip, true);
  perform public.api_idempotency_begin('SFHS', 'device', 'item.create', v_old, sha256('\x6b31'), sha256('\x7231'));
  reset role;

  -- a pending and a rejected item (the device link stays until anonymization; staff can block through either)
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            posted_by_kind, device_token_hash, arrival_basis_at, arrival_deadline_at)
  values (gen_random_uuid(), v_fchs, 'FCHS-W-990201', 'bottle', 'Rekey pending bottle', v_loc, 'pending',
          'student', v_old, now(), private.calendar_next_close(v_fchs, now(), 1))
  returning id into v_i2;
  perform set_config('rv.i2', v_i2::text, true);
  insert into public.items (school_id, public_id, category, description, dropoff_location_id, review_status,
                            reject_reason, reviewed_at, reviewed_by, posted_by_kind, device_token_hash)
  values (v_fchs, 'FCHS-W-990202', 'other', 'Rekey rejected post', v_loc, 'rejected', 'spam', now(),
          '00000000-5b00-4000-8000-000000000004', 'student', v_old);
  insert into public.device_rejections (school_id, device_token_hash)
  values (v_fchs, v_old), (v_fchs, v_old), (v_fchs, v_b), (pg_temp.school('SFHS'), v_old);

  -- devices: the old row is older and carries a longer staff block than the new row's auto block
  update public.devices set first_seen_at = now() - interval '30 days', last_seen_at = now() - interval '2 days',
         blocked_until = now() + interval '10 days', block_reason = 'staff',
         blocked_by = '00000000-5b00-4000-8000-000000000003'
   where school_id = v_fchs and token_hash = v_old;
  update public.devices set first_seen_at = now() - interval '1 day', last_seen_at = now(),
         blocked_until = now() + interval '2 days', block_reason = 'auto_rejections', blocked_by = null
   where school_id = v_fchs and token_hash = v_new;

  perform pg_temp.eq(pg_temp.carrying(v_fchs, v_old)::text, '13', 'fixtures: browser A has 13 rows under the old key at FCHS');
end $$;

-- ---------- the move ----------
do $$
declare
  v_fchs uuid := pg_temp.school('FCHS');
  v_old bytea := pg_temp.digest(1, 'e1');
  v_new bytea := pg_temp.digest(2, 'e2');
  v_audit bigint := (select count(*) from public.audit_log);
  v_jobs bigint := (select count(*) from public.jobs);
  v_versions jsonb := (select jsonb_object_agg(id, row_version) from public.items
                        where school_id = v_fchs and device_token_hash = v_old);
  r jsonb;
  d public.devices;
begin
  r := pg_temp.rekey('FCHS', v_old, v_new);
  perform pg_temp.eq(r::text, jsonb_build_object('items', 3, 'lostReports', 2, 'deviceRejections', 2, 'devices', 1,
                                                 'rateCounters', 3, 'idempotencyKeys', 2)::text,
                     'move: counts per table (3 items, 2 reports, 2 rejections, 1 device, 3 counters, 2 keys)');
  perform pg_temp.eq(pg_temp.carrying(v_fchs, v_old)::text, '0', 'move: no row at FCHS still carries the old digest');
  perform pg_temp.ok((select count(*) = 3 and bool_and(row_version = (v_versions->>id::text)::bigint + 1)
                        from public.items where school_id = v_fchs and device_token_hash = v_new),
                     'move: the three items carry the new digest, each with a new row_version');
  perform pg_temp.ok((select count(*) = 2 from public.lost_reports
                       where school_id = v_fchs and device_token_hash = v_new
                         and id::text in (current_setting('rv.r1'), current_setting('rv.r2'))),
                     'move: the open and the closed report carry the new digest');
  perform pg_temp.eq((select count(*) from public.audit_log)::text, v_audit::text, 'move: writes no audit row');
  perform pg_temp.eq((select count(*) from public.jobs)::text, v_jobs::text, 'move: enqueues no job');

  select * into d from public.devices where school_id = v_fchs and token_hash = v_new;
  perform pg_temp.ok(d.first_seen_at = now() - interval '30 days' and d.last_seen_at = now(),
                     'devices: merged row keeps the older first_seen_at and the later last_seen_at');
  perform pg_temp.ok(d.blocked_until = now() + interval '10 days' and d.block_reason = 'staff'
                     and d.blocked_by = '00000000-5b00-4000-8000-000000000003',
                     'devices: merged row keeps the stricter (later) block with its reason and staff member');
  perform pg_temp.eq(private.device_rejections_30d(v_fchs, v_new)::text, '2',
                     'device_rejections: reputation follows the browser to the new digest (G-12)');
  perform pg_temp.ok((select count(*) = 2 and bool_and(count = 2) from public.rate_counters
                       where tenant_scope = 'school:' || v_fchs and subject_kind = 'device' and subject_hmac = v_new
                         and action in ('post_item:1d', 'post_item:7d')),
                     'rate_counters: the same window under both digests adds up (1 + 1)');
end $$;

-- ---------- the device API with the new digest ----------
do $$
declare
  v_old bytea := pg_temp.digest(1, 'e1');
  v_new bytea := pg_temp.digest(2, 'e2');
  v_ip bytea := decode(repeat('a2', 32), 'hex');
  v jsonb;
  v_rv bigint;
begin
  set local role recover_web;
  v := public.api_my_items('FCHS', v_new);
  perform pg_temp.ok(jsonb_array_length(v->'items') = 3, 'api: api_my_items lists the moved items under the new digest');
  v := public.api_item_status('FCHS', v_new, current_setting('rv.i2')::uuid);
  perform pg_temp.eq(v->>'reviewStatus', 'pending', 'api: api_item_status answers the new digest');
  v := public.api_device_touch('FCHS', v_new);
  perform pg_temp.ok((v->>'blocked')::boolean, 'api: the carried-over block still applies');
  v := public.api_idempotency_begin('FCHS', 'device', 'item.create', v_new, sha256('\x6b31'), sha256('\x7231'));
  perform pg_temp.ok(v->>'state' = 'replay' and (v->>'responseCode')::int = 201
                     and v->'responseBody'->>'itemId' = current_setting('rv.i1'),
                     'api: a retried create after the move replays its stored response (F-77)');
  v := public.api_idempotency_begin('FCHS', 'device', 'report.create', v_new, sha256('\x6b32'), sha256('\x7233'));
  perform pg_temp.eq(v->>'state', 'in_progress', 'api: a key already used under the new digest keeps that row');
  perform pg_temp.eq(pg_temp.try(format('select public.api_idempotency_begin(%L, %L, %L, %L::bytea, %L::bytea, %L::bytea)',
                                        'FCHS', 'device', 'report.create', v_new, sha256('\x6b32'), sha256('\x7232'))),
                     'idempotency_conflict', 'api: the old row for that key was dropped, not merged');
  perform public.api_rate_take('FCHS', 'post_item', v_new, v_ip, true);
  perform pg_temp.ok(pg_temp.try(format('select public.api_rate_take(%L, %L, %L::bytea, %L::bytea, true)',
                                        'FCHS', 'post_item', v_new, v_ip)) like 'rate_limited/%',
                     'api: the daily post budget spans the rotation (3 per day, 2 were used before the move)');
  perform pg_temp.ok(pg_temp.try(format('select public.api_rate_take(%L, %L, %L::bytea, %L::bytea, true)',
                                        'FCHS', 'lost_report', v_new, v_ip)) like 'rate_limited/%',
                     'api: the daily lost-report budget spans the rotation');

  v := public.api_my_lost_reports('FCHS', v_new);
  perform pg_temp.ok(jsonb_array_length(v->'reports') = 1 and v->'reports'->0->>'id' = current_setting('rv.r1'),
                     'api: api_my_lost_reports lists the open report under the new digest');
  v_rv := (v->'reports'->0->>'rowVersion')::bigint;
  perform pg_temp.eq(pg_temp.try(format('select public.api_close_lost_report(%L, %L::bytea, %L::uuid, 0, %L)',
                                        'FCHS', v_new, current_setting('rv.r1'), 'dismiss')),
                     'state_changed', 'api: a row_version listed before the move is stale once');
  v := public.api_close_lost_report('FCHS', v_new, current_setting('rv.r1')::uuid, v_rv, 'dismiss');
  perform pg_temp.eq(v->>'status', 'closed_by_user', 'api: the browser closes its moved report with the new digest');
  perform pg_temp.eq(pg_temp.try(format('select public.api_item_status(%L, %L::bytea, %L::uuid)',
                                        'FCHS', v_old, current_setting('rv.i2'))),
                     'not_found', 'api: the old digest no longer reaches the item');
  reset role;
end $$;

-- ---------- idempotent, scoped, and refused ----------
do $$
declare
  v_fchs uuid := pg_temp.school('FCHS');
  v_sfhs uuid := pg_temp.school('SFHS');
  v_old bytea := pg_temp.digest(1, 'e1');
  v_new bytea := pg_temp.digest(2, 'e2');
  v_b bytea := pg_temp.digest(1, 'e3');
  v_before jsonb := (select jsonb_agg(to_jsonb(d) order by d.token_hash) from public.devices d where d.school_id = v_fchs);
  v_versions jsonb := (select jsonb_agg(row_version order by id) from public.items where school_id = v_fchs);
  r jsonb;
  v_ip bytea := decode(repeat('a3', 32), 'hex');
begin
  r := pg_temp.rekey('FCHS', v_old, v_new);
  perform pg_temp.eq(r::text, jsonb_build_object('items', 0, 'lostReports', 0, 'deviceRejections', 0, 'devices', 0,
                                                 'rateCounters', 0, 'idempotencyKeys', 0)::text,
                     'idempotent: a second call moves nothing');
  perform pg_temp.ok((select jsonb_agg(to_jsonb(d) order by d.token_hash) from public.devices d where d.school_id = v_fchs)
                       = v_before
                     and (select jsonb_agg(row_version order by id) from public.items where school_id = v_fchs) = v_versions,
                     'idempotent: devices rows and item row_versions are unchanged by the second call');

  -- browser B at FCHS and browser A's bytes at SFHS
  perform pg_temp.ok((select device_token_hash = v_b from public.lost_reports where id::text = current_setting('rv.r3'))
                     and exists (select 1 from public.devices where school_id = v_fchs and token_hash = v_b)
                     and exists (select 1 from public.device_rejections where school_id = v_fchs and device_token_hash = v_b)
                     and exists (select 1 from public.rate_counters where tenant_scope = 'school:' || v_fchs
                                    and subject_kind = 'device' and subject_hmac = v_b),
                     'scope: another browser at the same school is untouched');
  perform pg_temp.eq(pg_temp.carrying(v_sfhs, v_old)::text, '7',
                     'scope: the same bytes at another school stay put (item, report, device, rejection, 2 counters, key)');
  perform pg_temp.ok((select device_token_hash = v_old from public.lost_reports where id::text = current_setting('rv.r4')),
                     'scope: the SFHS report still carries its own digest');

  -- a request the previous deployment served after the move writes under the old key again; the next call merges it
  set local role recover_web;
  perform public.api_device_touch('FCHS', v_old);
  perform public.api_rate_take('FCHS', 'search', v_old, v_ip, true);
  perform public.api_rate_take('FCHS', 'search', v_new, v_ip, true);
  reset role;
  r := pg_temp.rekey('FCHS', v_old, v_new);
  perform pg_temp.ok((r->>'devices')::int = 1 and (r->>'rateCounters')::int = 1 and (r->>'items')::int = 0,
                     'late write: rows written under the old key after a move merge on the next call');
  perform pg_temp.ok((select blocked_until = now() + interval '10 days' from public.devices
                       where school_id = v_fchs and token_hash = v_new)
                     and (select count = 2 from public.rate_counters where tenant_scope = 'school:' || v_fchs
                            and action = 'search:10m' and subject_kind = 'device' and subject_hmac = v_new),
                     'late write: an unblocked late row does not lift the block, and its search count adds up');
  perform pg_temp.eq(pg_temp.carrying(v_fchs, v_old)::text, '0', 'late write: nothing is left under the old key');

  -- refused input changes nothing
  perform pg_temp.eq(pg_temp.try(format('select public.api_device_rekey(%L, %L::bytea, %L::bytea)', 'FCHS', '\x01', v_new)),
                     'invalid_input/device_digest', 'refused: a short old digest');
  perform pg_temp.eq(pg_temp.try(format('select public.api_device_rekey(%L, %L::bytea, null)', 'FCHS', v_old)),
                     'invalid_input/device_digest', 'refused: a missing new digest');
  perform pg_temp.eq(pg_temp.try(format('select public.api_device_rekey(%L, %L::bytea, %L::bytea)', 'FCHS', v_b,
                                        pg_temp.digest(1, 'e4'))),
                     'invalid_input/device_digest', 'refused: two digests with the same key version');
  perform pg_temp.eq(pg_temp.try(format('select public.api_device_rekey(%L, %L::bytea, %L::bytea)', 'ZZZZ', v_b,
                                        pg_temp.digest(2, 'e4'))),
                     'not_found', 'refused: an unknown school');
  perform pg_temp.ok((select device_token_hash = v_b from public.lost_reports where id::text = current_setting('rv.r3')),
                     'refused: browser B still carries its digest after the refused calls');
end $$;

rollback;
