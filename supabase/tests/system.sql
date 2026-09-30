-- system.sql: behaviour of the system_* family (BUILD-CONTRACT section 6.4) and of the 0450 cron helpers.
-- Run as the migration role against a database with the migrations and the seed applied:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/system.sql
-- Everything runs inside one transaction that is rolled back. Fixtures are created as the migration role; the
-- calls under test run as recover_worker (SET ROLE), the only role allowed to execute them.
\set ON_ERROR_STOP 1
\set QUIET 1
begin;
set local lock_timeout = '20s';

-- Lets this session SET ROLE recover_worker (rolled back with the test).
grant recover_worker to postgres;

create temp sequence t_checks;

-- Run one statement as the worker and return its jsonb result.
create function pg_temp.w(p_sql text) returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  set local role recover_worker;
  execute p_sql into r;
  reset role;
  return r;
end $$;

-- Run one statement as the worker; return 'SQLSTATE:message' on error, null on success.
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  begin
    set local role recover_worker;
    execute p_sql;
    reset role;
  exception when others then
    return sqlstate || ':' || sqlerrm;
  end;
  return null;
end $$;

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'system.sql FAILED: %', p_label;
  end if;
  perform nextval('pg_temp.t_checks');
end $$;

-- An item in any legal state combination, with the columns its CHECKs require.
create function pg_temp.mk_item(p_school uuid, p_kind text, p_review text, p_pub text, p_custody text,
                                p_desc text default 'navy metal water bottle') returns uuid
language plpgsql as $$
declare
  v uuid := gen_random_uuid();
  v_loc uuid;
  v_terminal boolean := p_custody in ('claimed', 'expired_donated', 'expired_disposed', 'expired_never_arrived');
begin
  select l.id into v_loc from public.locations l where l.school_id = p_school order by l.code limit 1;
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, current_location_id,
                            review_status, publication_status, custody, posted_by_kind, posted_by_staff_id,
                            device_token_hash, reviewed_at, reviewed_by, reject_reason, received_at, claimed_at,
                            terminal_at, withdrawn_at)
  values (v, p_school, case when p_review = 'draft' then null else 'T' || replace(v::text, '-', '') end, 'bottle',
          p_desc, v_loc, case when p_custody = 'at_location' then v_loc end,
          p_review::public.review_status, p_pub::public.publication_status, p_custody::public.custody_status, p_kind,
          case when p_kind <> 'student' then '00000000-5b00-4000-8000-000000000003'::uuid end,
          case when p_kind = 'student' then extensions.gen_random_bytes(33) end,
          case when p_review in ('approved', 'rejected') then now() end,
          case when p_review in ('approved', 'rejected') then '00000000-5b00-4000-8000-000000000003'::uuid end,
          case when p_review = 'rejected' then 'spam' end,
          case when p_custody = 'at_location' then now() end,
          case when p_custody = 'claimed' then now() end,
          case when v_terminal then now() end,
          case when p_pub = 'withdrawn' then now() end);
  return v;
end $$;

-- A current generation-1 photo whose paths match its status (section 8 keys).
create function pg_temp.mk_photo(p_item uuid, p_pos int, p_status text) returns uuid
language plpgsql as $$
declare
  v uuid := gen_random_uuid();
  v_school uuid;
  v_pre text;
  v_tok bytea := extensions.gen_random_bytes(16);
  v_canon boolean := p_status in ('canonical_ready', 'public_ready');
begin
  select i.school_id into v_school from public.items i where i.id = p_item;
  v_pre := v_school::text || '/' || p_item::text || '/' || v::text || '/';
  insert into public.item_photos (id, school_id, item_id, position, generation, is_current, incoming_path,
                                  original_path, review_path, thumb_path, medium_path, public_object_token,
                                  raw_bytes, bytes, width, height, status)
  values (v, v_school, p_item, p_pos, 1, true,
          case when p_status in ('uploaded', 'canonicalizing') then v_pre || 'raw' end,
          case when v_canon then v_pre || 'canonical.jpg' end,
          case when v_canon then v_pre || 'review.jpg' end,
          case when p_status = 'public_ready' then v_pre || encode(v_tok, 'hex') || '/thumb.jpg' end,
          case when p_status = 'public_ready' then v_pre || encode(v_tok, 'hex') || '/medium.jpg' end,
          case when p_status = 'public_ready' then v_tok end,
          case when p_status in ('uploaded', 'canonicalizing') then 900000 end,
          case when v_canon then 180000 end,
          case when v_canon then 1600 end,
          case when v_canon then 1200 end,
          p_status);
  return v;
end $$;

create function pg_temp.stat(p_school uuid, p_column text) returns int language plpgsql as $$
declare
  v int;
begin
  execute format('select d.%I from public.daily_school_stats d join public.schools s on s.id = d.school_id
                   where d.school_id = $1 and d.day = (now() at time zone s.timezone)::date', p_column)
    into v using p_school;
  return coalesce(v, 0);
end $$;

-- =====================================================================================================
-- 1. Job queue: lease, done, fail, reap, dead (Appendix E)
-- =====================================================================================================
do $$
declare
  j1 bigint; j2 bigint; j3 bigint; j4 bigint; j5 bigint; j6 bigint; j7 bigint; j8 bigint;
  r jsonb;
  v public.jobs;
begin
  insert into public.jobs (kind, payload, priority) values ('zz_test_lease', '{"n": 1}', -100) returning id into j1;
  insert into public.jobs (kind, payload, priority) values ('zz_test_lease', '{"n": 2}', -101) returning id into j2;
  insert into public.jobs (kind, payload, priority, run_after)
  values ('zz_test_lease', '{"n": 3}', -102, now() + interval '1 hour') returning id into j3;
  insert into public.jobs (kind, payload, priority) values ('zz_test_other', '{}', -100) returning id into j4;

  r := pg_temp.w($q$select public.system_lease_jobs('test-worker', array['zz_test_lease'], 5, 60)$q$);
  perform pg_temp.expect(jsonb_array_length(r->'jobs') = 2, 'lease returns only due jobs of the requested kinds');
  perform pg_temp.expect((r->'jobs'->0->>'id')::bigint = j2 and (r->'jobs'->1->>'id')::bigint = j1,
                         'lease orders by priority, run_after, id');
  perform pg_temp.expect(r->'jobs'->0 ?& array['id', 'kind', 'payload', 'schoolId', 'attempts', 'maxAttempts']
                         and (r->'jobs'->0->>'attempts')::int = 1 and (r->'jobs'->0->>'maxAttempts')::int = 5
                         and r->'jobs'->0->'payload' = '{"n": 2}'::jsonb, 'lease DTO');
  select * into v from public.jobs where id = j1;
  perform pg_temp.expect(v.status = 'running' and v.attempts = 1 and v.locked_by = 'test-worker'
                         and v.locked_at = now() and v.locked_until = now() + interval '60 seconds',
                         'lease sets running, attempts and the lock fields');
  r := pg_temp.w($q$select public.system_lease_jobs('test-worker', array['zz_test_lease'], 5, 60)$q$);
  perform pg_temp.expect(jsonb_array_length(r->'jobs') = 0, 'a running job is never leased twice');

  insert into public.jobs (kind, priority) select 'zz_test_clamp', -100 from generate_series(1, 3);
  r := pg_temp.w($q$select public.system_lease_jobs('test-worker', array['zz_test_clamp'], 0, 60)$q$);
  perform pg_temp.expect(jsonb_array_length(r->'jobs') = 1, 'lease limit is clamped to at least 1');
  r := pg_temp.w($q$select public.system_lease_jobs('test-worker', array['zz_test_clamp'], 500, 60)$q$);
  perform pg_temp.expect(jsonb_array_length(r->'jobs') = 2, 'lease takes what is left under the clamp');
  perform pg_temp.expect(pg_temp.err($q$select public.system_lease_jobs('', null, 1, 60)$q$) = 'RV001:invalid_input',
                         'lease requires a worker id');

  -- transient failure: requeued with the requested delay and a sanitized code
  r := pg_temp.w(format('select public.system_job_fail(%s, %L, 120, false)', j1, 'Upstream Timeout'));
  select * into v from public.jobs where id = j1;
  perform pg_temp.expect(r->>'status' = 'queued' and v.status = 'queued' and v.run_after = now() + interval '120 seconds'
                         and v.last_error_code = 'upstream_timeout' and v.finished_at is null,
                         'job_fail requeues with run_after = now() + retry');
  -- permanent failure: dead, finished_at, alert.dead_job {jobId, kind, errorCode}
  r := pg_temp.w(format('select public.system_job_fail(%s, %L, null, true)', j2, 'decode_failed'));
  select * into v from public.jobs where id = j2;
  perform pg_temp.expect(r->>'status' = 'dead' and v.status = 'dead' and v.finished_at = now(),
                         'permanent failure is dead with finished_at');
  perform pg_temp.expect(exists (select 1 from public.audit_log a
                                  where a.action = 'alert.dead_job' and a.target_table = 'jobs'
                                    and a.target_id = j2::text and a.actor_kind = 'system'
                                    and a.metadata = jsonb_build_object('jobId', j2, 'kind', 'zz_test_lease',
                                                                        'errorCode', 'decode_failed')),
                         'dead job writes alert.dead_job with {jobId, kind, errorCode}');
  -- out of attempts: dead without the permanent flag
  insert into public.jobs (kind, priority, max_attempts) values ('zz_test_once', -100, 1) returning id into j5;
  perform pg_temp.w($q$select public.system_lease_jobs('test-worker', array['zz_test_once'], 1, 60)$q$);
  r := pg_temp.w(format('select public.system_job_fail(%s, %L, 5, false)', j5, 'timeout'));
  perform pg_temp.expect(r->>'status' = 'dead' and (select status from public.jobs where id = j5) = 'dead',
                         'job_fail with attempts exhausted is dead');
  -- failing a job that is not running changes nothing
  r := pg_temp.w(format('select public.system_job_fail(%s, %L, 5, false)', j5, 'again'));
  perform pg_temp.expect(r->>'status' = 'dead' and (select last_error_code from public.jobs where id = j5) = 'timeout',
                         'job_fail on a finished job is a no-op');

  -- done
  perform pg_temp.w($q$select public.system_lease_jobs('test-worker', array['zz_test_other'], 1, 60)$q$);
  r := pg_temp.w(format('select public.system_job_done(%s)', j4));
  select * into v from public.jobs where id = j4;
  perform pg_temp.expect((r->>'ok')::boolean and v.status = 'done' and v.finished_at = now(), 'job_done');
  r := pg_temp.w(format('select public.system_job_done(%s)', j4));
  perform pg_temp.expect((r->>'ok')::boolean, 'job_done is idempotent');
  perform pg_temp.expect(pg_temp.err('select public.system_job_done(-1)') = 'RV001:not_found', 'job_done unknown id');

  -- reap: expired leases go back to queued, or dead when out of attempts
  insert into public.jobs (kind, status, attempts, max_attempts, locked_by, locked_at, locked_until)
  values ('zz_test_reap', 'running', 1, 5, 'gone-worker', now() - interval '5 minutes', now() - interval '1 second')
  returning id into j6;
  insert into public.jobs (kind, status, attempts, max_attempts, locked_by, locked_at, locked_until)
  values ('zz_test_reap', 'running', 5, 5, 'gone-worker', now() - interval '5 minutes', now() - interval '1 second')
  returning id into j7;
  insert into public.jobs (kind, status, attempts, max_attempts, locked_by, locked_at, locked_until)
  values ('zz_test_reap', 'running', 1, 5, 'live-worker', now(), now() + interval '1 minute')
  returning id into j8;
  r := pg_temp.w('select public.system_reap_leases()');
  perform pg_temp.expect((r->>'requeued')::int >= 1 and (r->>'dead')::int >= 1, 'reap returns {requeued, dead}');
  select * into v from public.jobs where id = j6;
  perform pg_temp.expect(v.status = 'queued' and v.last_error_code = 'lease_expired' and v.run_after = now()
                         and v.attempts = 1, 'reap requeues an expired lease');
  select * into v from public.jobs where id = j7;
  perform pg_temp.expect(v.status = 'dead' and v.finished_at = now(), 'reap kills an expired lease out of attempts');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.dead_job'
                                   and a.target_id = j7::text and a.metadata->>'errorCode' = 'lease_expired'),
                         'reaped dead job writes alert.dead_job');
  perform pg_temp.expect((select status from public.jobs where id = j8) = 'running', 'reap leaves live leases alone');

  -- heartbeat
  r := pg_temp.w($q$select public.system_worker_heartbeat('test-worker')$q$);
  perform pg_temp.expect((r->>'ok')::boolean and exists (select 1 from public.worker_heartbeats h
                                                          where h.worker_id = 'test-worker' and h.seen_at = now()),
                         'worker heartbeat');
  perform pg_temp.expect(pg_temp.err($q$select public.system_worker_heartbeat('')$q$) = 'RV001:invalid_input',
                         'heartbeat requires a worker id');
  perform pg_temp.expect(current_user = 'postgres', 'role restored after worker calls');
end $$;

-- =====================================================================================================
-- 2. Quarantine mode leases only the reconcile kinds (G-06)
-- =====================================================================================================
do $$
declare
  jr bigint; jo bigint; jz bigint;
  r jsonb;
begin
  update public.district_settings set worker_mode = 'quarantine' where id = 1;
  insert into public.jobs (kind, priority) values ('reconcile_generating', -200) returning id into jr;
  insert into public.jobs (kind, priority) values ('reconcile_orphan_uploads', -200) returning id into jo;
  insert into public.jobs (kind, priority) values ('zz_test_quarantine', -300) returning id into jz;
  r := pg_temp.w($q$select public.system_lease_jobs('q-worker', null, 20, 60)$q$);
  perform pg_temp.expect(not exists (select 1 from jsonb_array_elements(r->'jobs') as e
                                      where e->>'kind' not in ('reconcile_generating', 'reconcile_orphan_uploads')),
                         'quarantine leases nothing but reconcile kinds');
  perform pg_temp.expect(exists (select 1 from jsonb_array_elements(r->'jobs') as e where (e->>'id')::bigint = jr)
                         and exists (select 1 from jsonb_array_elements(r->'jobs') as e where (e->>'id')::bigint = jo),
                         'quarantine still leases reconcile_generating and reconcile_orphan_uploads');
  perform pg_temp.expect((select status from public.jobs where id = jz) = 'queued', 'quarantine holds other kinds');
  r := pg_temp.w($q$select public.system_lease_jobs('q-worker', array['zz_test_quarantine'], 20, 60)$q$);
  perform pg_temp.expect(jsonb_array_length(r->'jobs') = 0, 'quarantine ignores requested non-reconcile kinds');
  update public.district_settings set worker_mode = 'normal' where id = 1;
  r := pg_temp.w($q$select public.system_lease_jobs('q-worker', array['zz_test_quarantine'], 20, 60)$q$);
  perform pg_temp.expect(jsonb_array_length(r->'jobs') = 1 and (r->'jobs'->0->>'id')::bigint = jz,
                         'normal mode leases every kind again');
end $$;

-- =====================================================================================================
-- 3. Student photo pipeline: canonical -> screening -> approval -> variants -> finalize -> published
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  it uuid; p0 uuid; p1 uuid; it2 uuid; q2 uuid; it3 uuid; q3 uuid;
  pre0 text; pre1 text; tok0 text; tok1 text;
  fp bytea := extensions.digest('recover system.sql fingerprint', 'sha256');
  r jsonb;
  v_before int;
  rv bigint;
  ph public.item_photos;
begin
  it := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder', 'blue hydroflask water bottle');
  p0 := pg_temp.mk_photo(it, 0, 'uploaded');
  p1 := pg_temp.mk_photo(it, 1, 'uploaded');
  pre0 := fchs::text || '/' || it::text || '/' || p0::text || '/';
  pre1 := fchs::text || '/' || it::text || '/' || p1::text || '/';

  perform pg_temp.expect(pg_temp.err(format('select public.system_get_upload_spec(%L, %L)', it, fchs))
                         = 'RV001:state_changed', 'upload spec only for drafts and hidden staff posts');
  perform pg_temp.expect(pg_temp.err(format('select public.system_photo_canonical_ready(%L, %L, %L, 1, 1, 1, null)',
                           p0, pre1 || 'canonical.jpg', pre0 || 'review.jpg')) = 'RV001:invalid_input',
                         'canonical key outside the photo prefix is refused (F-75)');
  perform pg_temp.expect(pg_temp.err(format('select public.system_photo_canonical_ready(%L, %L, %L, 0, 1, 1, null)',
                           p0, pre0 || 'canonical.jpg', pre0 || 'review.jpg')) = 'RV001:invalid_input',
                         'canonical bytes must be positive');

  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 180000, 1600, 1200, %L::bytea)',
                        p0, pre0 || 'canonical.jpg', pre0 || 'review.jpg', fp));
  select * into ph from public.item_photos where id = p0;
  perform pg_temp.expect(r->>'allCanonical' = 'false' and ph.status = 'canonical_ready'
                         and ph.original_path = pre0 || 'canonical.jpg' and ph.review_path = pre0 || 'review.jpg'
                         and ph.bytes = 180000 and ph.width = 1600 and ph.content_fingerprint = fp,
                         'canonical_ready stores keys, bytes, dimensions and fingerprint');
  perform pg_temp.expect(not exists (select 1 from public.jobs j where j.dedupe_key = 'screen_item:' || it::text || ':v1'),
                         'no screening before every photo is canonical');
  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 180000, 1600, 1200, %L::bytea)',
                        p0, pre0 || 'canonical.jpg', pre0 || 'review.jpg', fp));
  perform pg_temp.expect((r->>'replay')::boolean and r->>'allCanonical' = 'false', 'canonical_ready replay');

  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 170000, 1600, 1200, null)',
                        p1, pre1 || 'canonical.jpg', pre1 || 'review.jpg'));
  perform pg_temp.expect((r->>'allCanonical')::boolean, 'allCanonical once every current photo is canonical');
  perform pg_temp.expect(exists (select 1 from public.jobs j
                                  where j.kind = 'screen_item' and j.status = 'queued' and j.school_id = fchs
                                    and j.dedupe_key = 'screen_item:' || it::text || ':v1'
                                    and j.payload = jsonb_build_object('itemId', it, 'policyVersion', 'v1')),
                         'screen_item enqueued with {itemId, policyVersion} and its dedupe key');

  -- screen_item work list: canonical current photos without a run for the policy version
  r := pg_temp.w(format($q$select public.system_screening_targets(%L, 'v1')$q$, it));
  perform pg_temp.expect(r = jsonb_build_object('photos', jsonb_build_array(
                               jsonb_build_object('photoId', p0, 'originalPath', pre0 || 'canonical.jpg'),
                               jsonb_build_object('photoId', p1, 'originalPath', pre1 || 'canonical.jpg'))),
                         'screening targets list both canonical photos in position order');
  perform pg_temp.expect(pg_temp.err(format('select public.system_screening_targets(%L, null)', it)) = 'RV001:invalid_input',
                         'screening targets need a policy version');

  -- budget, then screening with derived signals only (F-53)
  r := pg_temp.w('select public.system_screening_budget_take(2)');
  perform pg_temp.expect(r = '{"allowed": true, "enabled": true}'::jsonb, 'budget take allowed');
  v_before := pg_temp.stat(fchs, 'screening_images');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok',
                   '{"has_text": true, "text_char_count": 12, "ocr": "CALL 555 0100", "nested": {"a": 1}}')$q$, it, p0));
  perform pg_temp.expect((r->>'recorded')::boolean and not (r->>'allScreened')::boolean
                         and r->>'screeningStatus' = 'unscreened', 'first photo screened, item not yet aggregated');
  perform pg_temp.expect((select signals from public.screening_runs where item_photo_id = p0 and policy_version = 'v1')
                         = '{"has_text": true, "text_char_count": 12}'::jsonb,
                         'screening_runs.signals keeps booleans and numbers only');
  perform pg_temp.expect((select screening_flags->'has_text' from public.items where id = it) = 'true'::jsonb,
                         'has_text merged into screening_flags');
  r := pg_temp.w(format($q$select public.system_screening_targets(%L, 'v1')$q$, it));
  perform pg_temp.expect(jsonb_array_length(r->'photos') = 1 and (r->'photos'->0->>'photoId')::uuid = p1,
                         'screening targets skip photos already screened for the policy (replay)');
  r := pg_temp.w(format($q$select public.system_screening_targets(%L, 'v2')$q$, it));
  perform pg_temp.expect(jsonb_array_length(r->'photos') = 2, 'screening targets are per policy version');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{"nsfw": true}')$q$, it, p0));
  perform pg_temp.expect(not (r->>'recorded')::boolean and (select count(*) from public.screening_runs where item_photo_id = p0) = 1
                         and (select screening_flags ? 'nsfw' from public.items where id = it) is false,
                         'record_screening is idempotent per (photo, policy) (G-26)');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{}')$q$, it, p1));
  perform pg_temp.expect((r->>'allScreened')::boolean and r->>'screeningStatus' = 'flagged'
                         and (select screening_status from public.items where id = it) = 'flagged',
                         'fully screened item with a flag is flagged');
  perform pg_temp.expect(pg_temp.stat(fchs, 'screening_images') = v_before + 2, 'screening_images counts each run');
  r := pg_temp.w(format($q$select public.system_screening_targets(%L, 'v1')$q$, it));
  perform pg_temp.expect(r = '{"photos": []}'::jsonb, 'no screening targets once every photo has a run');
  r := pg_temp.w(format($q$select public.system_screening_targets(%L, 'v1')$q$, gen_random_uuid()));
  perform pg_temp.expect(r = '{"photos": []}'::jsonb, 'unknown item has no screening targets');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_record_screening(%L, %L, 'mock', 'm', 'v1', 'maybe', '{}')$q$, it, p1))
                         = 'RV001:invalid_input', 'screening status is validated');

  -- a reviewer approves (API family transition): approved + generating
  update public.items set review_status = 'approved', reviewed_at = now(),
         reviewed_by = '00000000-5b00-4000-8000-000000000004', publication_status = 'generating'
   where id = it;
  r := pg_temp.w(format('select public.system_variant_targets(%L)', it));
  perform pg_temp.expect(jsonb_array_length(r->'photos') = 2 and (r->>'generating')::boolean
                         and (r->'photos'->0->>'token') ~ '^[0-9a-f]{32}$'
                         and r->'photos'->0->>'originalPath' = pre0 || 'canonical.jpg',
                         'variant targets return hex tokens and canonical keys');
  tok0 := r->'photos'->0->>'token';
  tok1 := r->'photos'->1->>'token';
  r := pg_temp.w(format('select public.system_variant_targets(%L)', it));
  perform pg_temp.expect(r->'photos'->0->>'token' = tok0 and r->'photos'->1->>'token' = tok1 and tok0 <> tok1,
                         'public_object_token is generated once and stored');
  perform pg_temp.expect((select public_object_token from public.item_photos where id = p0) = decode(tok0, 'hex'),
                         'token stored as 16 bytes');

  perform pg_temp.expect(pg_temp.err(format('select public.system_photo_variants_ready(%L, %L, %L)', p0,
                           pre0 || '00000000000000000000000000000000/thumb.jpg',
                           pre0 || '00000000000000000000000000000000/medium.jpg')) = 'RV001:invalid_input',
                         'variant keys must carry the stored token');
  r := pg_temp.w(format('select public.system_photo_variants_ready(%L, %L, %L)', p0,
                        pre0 || tok0 || '/thumb.jpg', pre0 || tok0 || '/medium.jpg'));
  perform pg_temp.expect((r->>'ready')::boolean and not (r->>'allReady')::boolean
                         and (select status from public.item_photos where id = p0) = 'public_ready',
                         'variants_ready sets public_ready');

  -- finalize refuses while a current generation is not public_ready (F-18)
  r := pg_temp.w(format('select public.system_finalize_publish(%L)', it));
  perform pg_temp.expect(not (r->>'published')::boolean and r->>'reason' = 'variants_not_ready'
                         and (select publication_status from public.items where id = it) = 'generating',
                         'finalize refuses when a photo is not ready');
  begin
    update public.items set publication_status = 'published' where id = it;
    raise exception 'system.sql FAILED: published without ready variants';
  exception when sqlstate 'RV001' then
    perform pg_temp.expect(sqlerrm = 'state_changed', 'trigger refuses published without ready variants');
  end;

  r := pg_temp.w(format('select public.system_photo_variants_ready(%L, %L, %L)', p1,
                        pre1 || tok1 || '/thumb.jpg', pre1 || tok1 || '/medium.jpg'));
  perform pg_temp.expect((r->>'allReady')::boolean and exists (select 1 from public.jobs j
                           where j.kind = 'finalize_publish' and j.dedupe_key = 'finalize_publish:' || it::text),
                         'all variants ready enqueues finalize_publish');
  r := pg_temp.w(format('select public.system_photo_variants_ready(%L, %L, %L)', p1,
                        pre1 || tok1 || '/thumb.jpg', pre1 || tok1 || '/medium.jpg'));
  perform pg_temp.expect((r->>'ready')::boolean, 'variants_ready replay');

  r := pg_temp.w(format('select public.system_finalize_publish(%L)', it));
  select row_version into rv from public.items where id = it;
  perform pg_temp.expect((r->>'published')::boolean and (select publication_status from public.items where id = it) = 'published',
                         'finalize publishes');
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'match_item'
                                   and j.dedupe_key = 'match_item:' || it::text || ':' || rv::text
                                   and j.payload = jsonb_build_object('itemId', it)),
                         'finalize enqueues match_item:<id>:<row_version>');
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'invalidate_cache'
                                   and j.payload->'tags' ? ('item:' || it::text)),
                         'finalize enqueues invalidate_cache');
  perform pg_temp.expect(exists (select 1 from public.public_items pi where pi.id = it)
                         and (select count(*) from public.public_item_photos pp where pp.item_id = it) = 2,
                         'published item is visible with both photos');
  r := pg_temp.w(format('select public.system_finalize_publish(%L)', it));
  perform pg_temp.expect(not (r->>'published')::boolean and r->>'publicationStatus' = 'published',
                         'finalize on a non-generating item returns published false');

  r := pg_temp.w(format('select public.system_photo_incoming_cleared(%L)', p0));
  perform pg_temp.expect((r->>'ok')::boolean and (select incoming_path from public.item_photos where id = p0) is null,
                         'incoming_cleared NULLs incoming_path');
  r := pg_temp.w(format('select public.system_get_photo(%L)', p0));
  perform pg_temp.expect(r->>'status' = 'public_ready' and r->>'publicObjectToken' = tok0 and r->'incomingPath' = 'null'::jsonb
                         and r->>'thumbPath' = pre0 || tok0 || '/thumb.jpg' and (r->>'isCurrent')::boolean
                         and r ?& array['photoId', 'itemId', 'schoolId', 'originalPath', 'reviewPath', 'mediumPath'],
                         'get_photo DTO');
  perform pg_temp.expect(pg_temp.err(format('select public.system_get_photo(%L)', gen_random_uuid())) = 'RV001:not_found',
                         'get_photo unknown id');

  -- G-11: the same fingerprint on another item of the same school within 30 days is a reviewer flag
  it2 := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder');
  q2 := pg_temp.mk_photo(it2, 0, 'uploaded');
  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 1000, 10, 10, %L::bytea)', q2,
                        fchs::text || '/' || it2::text || '/' || q2::text || '/canonical.jpg',
                        fchs::text || '/' || it2::text || '/' || q2::text || '/review.jpg', fp));
  perform pg_temp.expect((r->>'duplicate')::boolean and (select screening_flags->'duplicate' from public.items where id = it2) = 'true'::jsonb
                         and (select review_status from public.items where id = it2) = 'pending',
                         'duplicate fingerprint sets the duplicate flag and never rejects (G-11)');
  it3 := pg_temp.mk_item('0b0b0b0b-0000-4000-8000-000000000002', 'student', 'pending', 'hidden', 'with_finder');
  q3 := pg_temp.mk_photo(it3, 0, 'uploaded');
  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 1000, 10, 10, %L::bytea)', q3,
                        '0b0b0b0b-0000-4000-8000-000000000002/' || it3::text || '/' || q3::text || '/canonical.jpg',
                        '0b0b0b0b-0000-4000-8000-000000000002/' || it3::text || '/' || q3::text || '/review.jpg', fp));
  perform pg_temp.expect(not (r->>'duplicate')::boolean, 'duplicates are detected per school only');

  -- screening merges into screening_flags: flags set by the API and canonicalization survive (duplicate, photo_failed)
  update public.items set screening_flags = screening_flags || '{"photo_failed": true}'::jsonb where id = it2;
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{"has_face": true, "face_count": 1}')$q$, it2, q2));
  perform pg_temp.expect((select screening_flags = '{"duplicate": true, "photo_failed": true, "has_face": true}'::jsonb
                            from public.items where id = it2) and r->>'screeningStatus' = 'flagged',
                         'record_screening merges flags and keeps duplicate and photo_failed');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v9', 'error', '{"ceiling": true}')$q$, it2, q2));
  perform pg_temp.expect((select screening_flags @> '{"duplicate": true, "photo_failed": true, "has_face": true, "screening_error": true, "ceiling": true}'::jsonb
                                 and screening_status = 'error' from public.items where id = it2),
                         'error and ceiling flags are merged too');
end $$;

-- =====================================================================================================
-- 3b. Staff posts (G-08), upload specs, budget ceiling (G-35), photo failures
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  sfhs constant uuid := '0b0b0b0b-0000-4000-8000-000000000002';
  st uuid; sp uuid; st2 uuid; sp2 uuid; st3 uuid; sp3 uuid; dr uuid; dp0 uuid; dp1 uuid; fp_item uuid; fq uuid;
  r jsonb;
  pre text;
begin
  -- drafts: upload and complete specs list the incoming keys
  dr := pg_temp.mk_item(fchs, 'student', 'draft', 'hidden', 'with_finder');
  dp1 := pg_temp.mk_photo(dr, 1, 'uploaded');
  dp0 := pg_temp.mk_photo(dr, 0, 'uploaded');
  r := pg_temp.w(format('select public.system_get_upload_spec(%L, %L)', dr, fchs));
  perform pg_temp.expect((r->>'schoolId')::uuid = fchs and (r->>'itemId')::uuid = dr and jsonb_array_length(r->'photos') = 2
                         and (r->'photos'->0->>'photoId')::uuid = dp0 and (r->'photos'->0->>'position')::int = 0
                         and r->'photos'->0->>'key' = (select incoming_path from public.item_photos where id = dp0),
                         'upload spec for a student draft');
  r := pg_temp.w(format('select public.system_get_complete_spec(%L, %L)', dr, fchs));
  perform pg_temp.expect(jsonb_array_length(r->'photos') = 2 and r->'photos'->1 ?& array['photoId', 'key']
                         and (r->'photos'->1->>'photoId')::uuid = dp1, 'complete spec lists the expected keys');
  perform pg_temp.expect(pg_temp.err(format('select public.system_get_upload_spec(%L, %L)', dr, sfhs)) = 'RV001:not_found',
                         'upload spec requires the item school');

  -- staff post: approved/hidden -> canonical -> screened clean -> generating + make_variants
  st := pg_temp.mk_item(fchs, 'staff', 'approved', 'hidden', 'at_location', 'grey zip hoodie');
  sp := pg_temp.mk_photo(st, 0, 'uploaded');
  r := pg_temp.w(format('select public.system_get_upload_spec(%L, %L)', st, fchs));
  perform pg_temp.expect(jsonb_array_length(r->'photos') = 1, 'upload spec for a hidden staff post');
  pre := fchs::text || '/' || st::text || '/' || sp::text || '/';
  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 1000, 10, 10, null)',
                        sp, pre || 'canonical.jpg', pre || 'review.jpg'));
  perform pg_temp.expect((r->>'allCanonical')::boolean and exists (select 1 from public.jobs j
                           where j.dedupe_key = 'screen_item:' || st::text || ':v1'), 'staff post goes to screening');
  perform pg_temp.expect((select publication_status from public.items where id = st) = 'hidden',
                         'staff post stays hidden until screened');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{"face_count": 0}')$q$, st, sp));
  perform pg_temp.expect(r->>'screeningStatus' = 'clean' and (select publication_status from public.items where id = st) = 'generating'
                         and exists (select 1 from public.jobs j where j.dedupe_key = 'make_variants:' || st::text),
                         'screened staff post moves to generating with make_variants (G-08)');

  -- severe signal on a hidden staff post: quarantine + hold, stays hidden, alert
  st2 := pg_temp.mk_item(fchs, 'staff', 'approved', 'hidden', 'at_location', 'red umbrella');
  sp2 := pg_temp.mk_photo(st2, 0, 'canonical_ready');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{"nsfw": true, "severe": true}')$q$, st2, sp2));
  perform pg_temp.expect((r->>'severe')::boolean and not (r->>'withdrawn')::boolean
                         and (select screening_flags @> '{"quarantine": true, "hold": true, "nsfw": true}'::jsonb
                                from public.items where id = st2)
                         and (select publication_status from public.items where id = st2) = 'hidden'
                         and not exists (select 1 from public.jobs j where j.dedupe_key = 'make_variants:' || st2::text),
                         'severe staff post is quarantined and held (G-24)');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.severe_content'
                                   and a.target_id = st2::text and a.metadata->>'withdrawn' = 'false'),
                         'severe content writes alert.severe_content');

  -- screening switched off: canonical goes straight to staff publish-ready
  update public.district_settings set screening_enabled = false where id = 1;
  st3 := pg_temp.mk_item(fchs, 'backfill', 'approved', 'hidden', 'at_location', 'lunch box');
  sp3 := pg_temp.mk_photo(st3, 0, 'uploaded');
  pre := fchs::text || '/' || st3::text || '/' || sp3::text || '/';
  r := pg_temp.w(format('select public.system_photo_canonical_ready(%L, %L, %L, 1000, 10, 10, null)',
                        sp3, pre || 'canonical.jpg', pre || 'review.jpg'));
  perform pg_temp.expect((select publication_status from public.items where id = st3) = 'generating'
                         and not exists (select 1 from public.jobs j where j.dedupe_key = 'screen_item:' || st3::text || ':v1'),
                         'screening off: canonical calls staff_publish_ready directly');
  r := pg_temp.w('select public.system_screening_budget_take(1)');
  perform pg_temp.expect(r = '{"allowed": false, "enabled": false}'::jsonb, 'budget reports screening disabled');

  -- G-35 district budget: atomic counter under the ceiling
  update public.district_settings set screening_enabled = true, screening_daily_ceiling = 3 where id = 1;
  delete from public.rate_counters where tenant_scope = 'district' and action = 'screening';
  perform pg_temp.expect((pg_temp.w('select public.system_screening_budget_take(2)')->>'allowed')::boolean, 'budget 2 of 3');
  perform pg_temp.expect(not (pg_temp.w('select public.system_screening_budget_take(2)')->>'allowed')::boolean,
                         'budget refuses above the ceiling');
  perform pg_temp.expect((pg_temp.w('select public.system_screening_budget_take(1)')->>'allowed')::boolean, 'budget 3 of 3');
  perform pg_temp.expect((select c.count from public.rate_counters c
                           where c.tenant_scope = 'district' and c.action = 'screening' and c.subject_kind = 'district'
                             and c.subject_hmac = '\x00'::bytea and c.window_start = date_trunc('day', now(), 'UTC')) = 3,
                         'district counter row in rate_counters');
  update public.district_settings set screening_daily_ceiling = 500 where id = 1;

  -- photo failures
  fp_item := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder');
  fq := pg_temp.mk_photo(fp_item, 0, 'uploaded');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_photo_failed(%L, 'Decode Failed')$q$, fq)) = 'RV001:invalid_input',
                         'failure code format');
  r := pg_temp.w(format($q$select public.system_photo_failed(%L, 'decode_failed')$q$, fq));
  perform pg_temp.expect((r->>'ok')::boolean and (select status || ':' || failure_code from public.item_photos where id = fq) = 'failed:decode_failed'
                         and (select screening_flags->'photo_failed' from public.items where id = fp_item) = 'true'::jsonb,
                         'photo_failed sets failed and flags photo_failed');
  r := pg_temp.w(format($q$select public.system_photo_failed(%L, 'decode_failed')$q$, sp));
  perform pg_temp.expect(not (r->>'ok')::boolean and (select status from public.item_photos where id = sp) = 'canonical_ready',
                         'photo_failed never regresses a canonical generation');
  r := pg_temp.w(format('select public.system_photo_incoming_cleared(%L)', dp0));
  perform pg_temp.expect(not (r->>'ok')::boolean and (select incoming_path from public.item_photos where id = dp0) is not null,
                         'incoming_cleared refuses a photo that still needs its raw object');

  -- a dead screen_item job marks screening error; a dead canonicalize_photo job fails the photo (§10.4, §9.3)
  declare
    sx uuid := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder');
    sxp uuid := pg_temp.mk_photo(sx, 0, 'uploaded');
    jid bigint;
  begin
    insert into public.jobs (kind, payload, status, attempts, max_attempts, locked_by, locked_until)
    values ('screen_item', jsonb_build_object('itemId', sx, 'policyVersion', 'v1'), 'running', 5, 5, 'w', now())
    returning id into jid;
    perform pg_temp.w(format('select public.system_job_fail(%s, %L, null, false)', jid, 'provider_5xx'));
    perform pg_temp.expect((select screening_status::text || ':' || (screening_flags->>'screening_error') from public.items where id = sx)
                           = 'error:true', 'dead screen_item job sets screening error');
    insert into public.jobs (kind, payload, status, attempts, max_attempts, locked_by, locked_until)
    values ('canonicalize_photo', jsonb_build_object('photoId', sxp), 'running', 5, 5, 'w', now())
    returning id into jid;
    perform pg_temp.w(format('select public.system_job_fail(%s, %L, null, false)', jid, 'too_large'));
    perform pg_temp.expect((select status || ':' || failure_code from public.item_photos where id = sxp) = 'failed:too_large',
                           'dead canonicalize_photo job fails the photo');
  end;
end $$;

-- =====================================================================================================
-- 4. Severe content after approval withdraws the item (G-24)
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  pub uuid; pp uuid; gen uuid; gp uuid;
  r jsonb;
  v_ledger bigint;
  tok text;
  pre text;
begin
  pub := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'at_location', 'black backpack with patches');
  pp := pg_temp.mk_photo(pub, 0, 'public_ready');
  perform pg_temp.expect(exists (select 1 from public.public_items where id = pub), 'fixture is visible');
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v2', 'ok', '{"nsfw": true, "severe": true}')$q$, pub, pp));
  perform pg_temp.expect((r->>'withdrawn')::boolean, 'severe signal after approval withdraws');
  perform pg_temp.expect((select publication_status = 'withdrawn' and withdrawn_at = now()
                                 and screening_flags @> '{"quarantine": true}'::jsonb from public.items where id = pub),
                         'item withdrawn with withdrawn_at and quarantine flag');
  perform pg_temp.expect(not exists (select 1 from public.public_items where id = pub), 'withdrawn item is no longer public');
  select l.id into v_ledger from public.media_deletion_ledger l where l.item_id = pub and l.reason = 'severe_content';
  perform pg_temp.expect(v_ledger is not null
                         and (select array_agg(o.object_kind order by o.object_kind) from public.media_deletion_objects o
                               where o.ledger_id = v_ledger) = array['medium', 'thumb'],
                         'severe ledger removes the public variants');
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'delete_media'
                                   and j.dedupe_key = 'delete_media:' || v_ledger::text and j.run_after = now()),
                         'severe ledger enqueues delete_media now');
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'invalidate_cache'
                                   and j.payload->'tags' ? ('item:' || pub::text)), 'severe withdrawal invalidates');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.severe_content'
                                   and a.target_id = pub::text and a.metadata->>'withdrawn' = 'true'),
                         'alert.severe_content audit row');

  -- a generating item is withdrawn too; variants finished meanwhile are ledgered, never published
  gen := pg_temp.mk_item(fchs, 'student', 'approved', 'generating', 'with_finder', 'silver bracelet');
  gp := pg_temp.mk_photo(gen, 0, 'canonical_ready');
  r := pg_temp.w(format('select public.system_variant_targets(%L)', gen));
  tok := r->'photos'->0->>'token';
  r := pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{"severe": true}')$q$, gen, gp));
  perform pg_temp.expect((r->>'withdrawn')::boolean and (select publication_status from public.items where id = gen) = 'withdrawn',
                         'severe signal withdraws a generating item');
  pre := fchs::text || '/' || gen::text || '/' || gp::text || '/' || tok || '/';
  r := pg_temp.w(format('select public.system_photo_variants_ready(%L, %L, %L)', gp, pre || 'thumb.jpg', pre || 'medium.jpg'));
  perform pg_temp.expect(not (r->>'ready')::boolean and (r->>'ledgerId') is not null
                         and exists (select 1 from public.media_deletion_ledger l where l.id = (r->>'ledgerId')::bigint
                                       and l.reason = 'late_variants')
                         and (select count(*) from public.media_deletion_objects o where o.ledger_id = (r->>'ledgerId')::bigint) = 2,
                         'late variants are recorded and ledgered');
  r := pg_temp.w(format('select public.system_finalize_publish(%L)', gen));
  perform pg_temp.expect(not (r->>'published')::boolean, 'a withdrawn item is never finalized');
  r := pg_temp.w(format('select public.system_variant_targets(%L)', gen));
  perform pg_temp.expect(not (r->>'generating')::boolean and jsonb_array_length(r->'photos') = 0,
                         'variant targets only for approved + generating items');
end $$;

-- =====================================================================================================
-- 5. Never-arrived expiry with a delayed ledger (G-01, G-02), then the deletion ledger flow (§9.6)
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  a uuid; ap uuid; b uuid; bp uuid; c uuid; d uuid;
  r jsonb;
  v_before int;
  v_grace int;
  v_ledger bigint;
  v_ledger_b bigint;
  o jsonb;
  ph public.item_photos;
begin
  select late_arrival_grace_days into v_grace from public.schools where id = fchs;
  a := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder', 'purple water bottle');
  ap := pg_temp.mk_photo(a, 0, 'canonical_ready');
  update public.items set arrival_deadline_at = now() - interval '1 hour' where id = a;
  b := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'with_finder', 'green scarf');
  bp := pg_temp.mk_photo(b, 0, 'public_ready');
  update public.items set arrival_deadline_at = now() - interval '2 hours' where id = b;
  c := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder');
  update public.items set arrival_deadline_at = now() + interval '1 day' where id = c;
  d := pg_temp.mk_item(fchs, 'student', 'draft', 'hidden', 'with_finder');
  update public.items set arrival_deadline_at = now() - interval '1 day' where id = d;
  v_before := pg_temp.stat(fchs, 'expired');

  r := pg_temp.w('select public.system_expire_never_arrived()');
  perform pg_temp.expect((r->>'count')::int >= 2, 'expire_never_arrived returns {count}');
  perform pg_temp.expect((select custody = 'expired_never_arrived' and terminal_at = now() and publication_status = 'hidden'
                                 and withdrawn_at is null from public.items where id = a),
                         'pending never-arrived item expires and stays hidden (G-02)');
  perform pg_temp.expect((select custody = 'expired_never_arrived' and publication_status = 'withdrawn' and withdrawn_at = now()
                                 and withdrawn_at = terminal_at from public.items where id = b),
                         'published never-arrived item is withdrawn with withdrawn_at = terminal_at');
  perform pg_temp.expect((select array_agg(distinct l.reason) from public.media_deletion_ledger l where l.item_id in (a, b))
                         = array['never_arrived'], 'never-arrived ledgers use reason never_arrived exactly');
  perform pg_temp.expect((select custody from public.items where id = c) = 'with_finder'
                         and (select custody from public.items where id = d) = 'with_finder',
                         'future deadlines and drafts are untouched');
  select l.id into v_ledger from public.media_deletion_ledger l where l.item_id = a and l.reason = 'never_arrived';
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.dedupe_key = 'delete_media:' || v_ledger::text
                                   and j.run_after = now() + make_interval(days => v_grace)),
                         'never-arrived deletion is delayed by late_arrival_grace_days (G-01)');
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'invalidate_cache' and j.payload->'tags' ? ('item:' || b::text))
                         and not exists (select 1 from public.jobs j where j.kind = 'invalidate_cache' and j.payload->'tags' ? ('item:' || a::text)),
                         'only a public item invalidates caches');
  perform pg_temp.expect((select count(*) from public.audit_log l where l.action = 'item.expire_never_arrived'
                           and l.target_id in (a::text, b::text)) = 2, 'expiry is audited');
  perform pg_temp.expect(pg_temp.stat(fchs, 'expired') >= v_before + 2, 'expired counter');
  r := pg_temp.w('select public.system_expire_never_arrived()');
  perform pg_temp.expect((select count(*) from public.media_deletion_ledger l where l.item_id = a) = 1,
                         'expiry is idempotent');

  -- deletion ledger flow: objects, per-object evidence, verification nulls paths and marks deleted
  r := pg_temp.w(format('select public.system_deletion_objects(%s)', v_ledger));
  perform pg_temp.expect((r->>'found')::boolean and (r->>'itemId')::uuid = a and jsonb_array_length(r->'objects') = 2
                         and not exists (select 1 from jsonb_array_elements(r->'objects') as e
                                          where e->>'bucket' <> 'originals' or e->>'storagePath' <> e->>'currentPath'
                                             or (e->>'photoId')::uuid <> ap),
                         'deletion_objects lists the canonical and review objects with buckets');
  r := pg_temp.w(format('select public.system_media_ledger_verified(%s)', v_ledger));
  perform pg_temp.expect(not (r->>'verified')::boolean and (r->>'pending')::int = 2, 'ledger not verified with pending objects');
  for o in select e from jsonb_array_elements(pg_temp.w(format('select public.system_deletion_objects(%s)', v_ledger))->'objects') as e loop
    r := pg_temp.w(format('select public.system_deletion_object_done(%s, %L, %L, false)', v_ledger, o->>'photoId', o->>'objectKind'));
    r := pg_temp.w(format('select public.system_deletion_object_done(%s, %L, %L, true)', v_ledger, o->>'photoId', o->>'objectKind'));
  end loop;
  perform pg_temp.expect((r->>'remaining')::int = 0 and not exists (select 1 from public.media_deletion_objects x
                           where x.ledger_id = v_ledger and (x.deleted_at is null or x.verified_at is null or x.attempts <> 2)),
                         'object evidence recorded');
  r := pg_temp.w(format('select public.system_media_ledger_verified(%s)', v_ledger));
  select * into ph from public.item_photos where id = ap;
  perform pg_temp.expect((r->>'verified')::boolean and (r->>'photosDeleted')::int = 1 and ph.status = 'deleted'
                         and ph.original_path is null and ph.review_path is null and ph.incoming_path is null
                         and ph.thumb_path is null and ph.medium_path is null,
                         'verified ledger NULLs the paths and marks the generation deleted');
  perform pg_temp.expect((select verified_at from public.media_deletion_ledger where id = v_ledger) = now()
                         and exists (select 1 from public.audit_log l where l.action = 'media.deletion_verified'
                                       and l.target_id = v_ledger::text), 'ledger verified_at and audit');
  r := pg_temp.w(format('select public.system_media_ledger_verified(%s)', v_ledger));
  perform pg_temp.expect((r->>'verified')::boolean and (r->>'replay')::boolean, 'ledger verification is idempotent');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_deletion_object_done(%s, %L, 'thumb', true)$q$, v_ledger, ap))
                         = 'RV001:not_found', 'object_done for an object not in the ledger');
  r := pg_temp.w('select public.system_deletion_objects(-1)');
  perform pg_temp.expect(not (r->>'found')::boolean and r->'objects' = '[]'::jsonb, 'a cancelled ledger has no objects');

  -- the published item's ledger covers original, review, thumb, medium
  select l.id into v_ledger_b from public.media_deletion_ledger l where l.item_id = b and l.reason = 'never_arrived';
  perform pg_temp.expect((select count(*) from public.media_deletion_objects x where x.ledger_id = v_ledger_b) = 4,
                         'published item ledger covers every stored rendition');
  for o in select e from jsonb_array_elements(pg_temp.w(format('select public.system_deletion_objects(%s)', v_ledger_b))->'objects') as e loop
    perform pg_temp.w(format('select public.system_deletion_object_done(%s, %L, %L, true)', v_ledger_b, o->>'photoId', o->>'objectKind'));
  end loop;
  perform pg_temp.w(format('select public.system_media_ledger_verified(%s)', v_ledger_b));
  perform pg_temp.expect((select status from public.item_photos where id = bp) = 'deleted', 'variants and originals deleted');
end $$;

-- A variants-only ledger (severe content) leaves the private renditions: public_ready -> canonical_ready.
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  it uuid; p uuid;
  v_ledger bigint;
  o jsonb;
  ph public.item_photos;
begin
  it := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'at_location', 'orange lanyard');
  p := pg_temp.mk_photo(it, 0, 'public_ready');
  perform pg_temp.w(format($q$select public.system_record_screening(%L, %L, 'mock', 'mock-1', 'v1', 'ok', '{"severe": true}')$q$, it, p));
  select l.id into v_ledger from public.media_deletion_ledger l where l.item_id = it and l.reason = 'severe_content';
  for o in select e from jsonb_array_elements(pg_temp.w(format('select public.system_deletion_objects(%s)', v_ledger))->'objects') as e loop
    perform pg_temp.w(format('select public.system_deletion_object_done(%s, %L, %L, true)', v_ledger, o->>'photoId', o->>'objectKind'));
  end loop;
  perform pg_temp.w(format('select public.system_media_ledger_verified(%s)', v_ledger));
  select * into ph from public.item_photos where id = p;
  perform pg_temp.expect(ph.status = 'canonical_ready' and ph.thumb_path is null and ph.medium_path is null
                         and ph.original_path is not null and ph.review_path is not null,
                         'variants-only verification keeps the private renditions');
end $$;

-- =====================================================================================================
-- 6. Scheduled maintenance: disposition due, report expiry, rejected anonymization, terminal text,
--    reconcile generating, rollup, alerts, drafts
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  x uuid; y uuid; rj uuid; rjp uuid; rj2 uuid; ct uuid; ct2 uuid; dl uuid; g uuid; g2 uuid; od uuid; fr uuid;
  rep uuid; rep2 uuid;
  r jsonb;
  v_n int;
  v_ledger bigint;
  it public.items;
begin
  -- disposition due (custody never changes by time alone)
  x := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'at_location');
  update public.items set expires_at = now() - interval '1 hour' where id = x;
  y := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'at_location');
  update public.items set expires_at = now() + interval '1 day' where id = y;
  r := pg_temp.w('select public.system_mark_disposition_due()');
  perform pg_temp.expect((r->>'count')::int >= 1 and (select disposition_due_at = now() and custody = 'at_location'
                                                        from public.items where id = x)
                         and (select disposition_due_at from public.items where id = y) is null,
                         'mark_disposition_due sets disposition_due_at only');
  r := pg_temp.w('select public.system_mark_disposition_due()');
  perform pg_temp.expect((select count(*) from public.audit_log l where l.action = 'item.disposition_due' and l.target_id = x::text) = 1,
                         'mark_disposition_due is idempotent');

  -- report expiry (G-13)
  insert into public.lost_reports (school_id, category, description, device_token_hash, expires_at)
  values (fchs, 'bag', 'lost red backpack', extensions.gen_random_bytes(33), now() - interval '1 minute') returning id into rep;
  insert into public.lost_reports (school_id, category, description, device_token_hash, expires_at)
  values (fchs, 'bag', 'lost blue backpack', extensions.gen_random_bytes(33), now() + interval '1 day') returning id into rep2;
  r := pg_temp.w('select public.system_expire_reports()');
  perform pg_temp.expect((r->>'count')::int >= 1 and (select status = 'expired' and terminal_at = now() from public.lost_reports where id = rep)
                         and (select status from public.lost_reports where id = rep2) = 'open', 'expire_reports');

  -- rejected anonymization after rejected_media_retention_days (G-03)
  rj := pg_temp.mk_item(fchs, 'student', 'rejected', 'hidden', 'with_finder', 'rejected text');
  rjp := pg_temp.mk_photo(rj, 0, 'canonical_ready');
  update public.item_photos set content_fingerprint = '\x0102'::bytea where id = rjp;
  update public.items set reviewed_at = now() - interval '8 days', location_note_private = 'C214',
         map_version_id = '0a0a0a0a-2000-4000-8000-000000000001', pin_x = 0.5, pin_y = 0.5, src = 'poster-a'
   where id = rj;
  rj2 := pg_temp.mk_item(fchs, 'student', 'rejected', 'hidden', 'with_finder', 'recent reject');
  r := pg_temp.w('select public.system_anonymize_rejected()');
  select * into it from public.items where id = rj;
  perform pg_temp.expect((r->>'count')::int >= 1 and it.description is null and it.location_note_private is null
                         and it.pin_x is null and it.pin_y is null and it.zone_id is null and it.src is null
                         and it.device_token_hash is null and it.device_link_cleared_at = now()
                         and it.content_anonymized_at = now(), 'anonymize_rejected clears content and the device link');
  perform pg_temp.expect((select content_fingerprint from public.item_photos where id = rjp) is null, 'fingerprints cleared');
  select l.id into v_ledger from public.media_deletion_ledger l where l.item_id = rj and l.reason = 'rejected_retention';
  perform pg_temp.expect(v_ledger is not null and exists (select 1 from public.jobs j where j.dedupe_key = 'delete_media:' || v_ledger::text),
                         'rejected media deletion scheduled');
  perform pg_temp.expect((select description from public.items where id = rj2) is not null, 'recent rejects keep content');

  -- terminal text clearing: coalesce(terminal_at, deleted_at) + terminal_text_retention_days
  ct := pg_temp.mk_item(fchs, 'staff', 'approved', 'withdrawn', 'claimed', 'claimed item text');
  update public.items set terminal_at = now() - interval '31 days', claimed_at = now() - interval '31 days',
         location_note_private = 'shelf 3' where id = ct;
  ct2 := pg_temp.mk_item(fchs, 'staff', 'approved', 'withdrawn', 'claimed', 'recently claimed');
  update public.items set terminal_at = now() - interval '5 days' where id = ct2;
  dl := pg_temp.mk_item(fchs, 'staff', 'approved', 'hidden', 'at_location', 'deleted mistake');
  update public.items set deleted_at = now() - interval '40 days' where id = dl;
  r := pg_temp.w('select public.system_clear_terminal_item_text()');
  perform pg_temp.expect((select description is null and location_note_private is null and text_cleared_at = now()
                                 from public.items where id = ct)
                         and (select text_cleared_at is not null from public.items where id = dl)
                         and (select description from public.items where id = ct2) is not null,
                         'clear_terminal_item_text');

  -- reconcile generating: re-enqueue make_variants unless a job is active
  g := gen_random_uuid();
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            publication_status, custody, posted_by_kind, posted_by_staff_id, reviewed_at, reviewed_by,
                            updated_at)
  values (g, fchs, 'T' || replace(g::text, '-', ''), 'bag', 'stuck item', '0a0a0a0a-1000-4000-8000-000000000001',
          'approved', 'generating', 'with_finder', 'staff', '00000000-5b00-4000-8000-000000000003', now(),
          '00000000-5b00-4000-8000-000000000003', now() - interval '11 minutes');
  g2 := gen_random_uuid();
  insert into public.items (id, school_id, public_id, category, description, dropoff_location_id, review_status,
                            publication_status, custody, posted_by_kind, posted_by_staff_id, reviewed_at, reviewed_by,
                            updated_at)
  values (g2, fchs, 'T' || replace(g2::text, '-', ''), 'bag', 'busy item', '0a0a0a0a-1000-4000-8000-000000000001',
          'approved', 'generating', 'with_finder', 'staff', '00000000-5b00-4000-8000-000000000003', now(),
          '00000000-5b00-4000-8000-000000000003', now() - interval '11 minutes');
  insert into public.jobs (kind, payload, dedupe_key, status, attempts, locked_until)
  values ('make_variants', jsonb_build_object('itemId', g2), 'make_variants:' || g2::text, 'running', 1, now() + interval '1 minute');
  r := pg_temp.w('select public.system_reconcile_generating()');
  perform pg_temp.expect((r->>'count')::int >= 1
                         and exists (select 1 from public.jobs j where j.dedupe_key = 'make_variants:' || g::text and j.status = 'queued')
                         and (select count(*) from public.jobs j where j.dedupe_key = 'make_variants:' || g2::text) = 1,
                         'reconcile_generating re-enqueues only stuck items');

  -- rollup: recomputed from the sources for the school's local day; the five API-owned live counters are untouched
  insert into public.daily_school_stats (school_id, day, posted, lost_reports, matches_viewed, reports_closed_found,
                                         high_value_redirects, expired, rejected, claimed)
  values (fchs, (now() at time zone 'America/New_York')::date, 101, 102, 103, 104, 105, 9999, 9999, 9999)
  on conflict (school_id, day) do update
    set posted = 101, lost_reports = 102, matches_viewed = 103, reports_closed_found = 104, high_value_redirects = 105,
        expired = 9999, rejected = 9999, claimed = 9999;
  r := pg_temp.w(format('select public.system_rollup_daily_stats(%L)', (now() at time zone 'America/New_York')::date));
  perform pg_temp.expect((r->>'count')::int >= 3, 'rollup covers every school');
  perform pg_temp.expect((select d.posted = 101 and d.lost_reports = 102 and d.matches_viewed = 103
                                 and d.reports_closed_found = 104 and d.high_value_redirects = 105
                            from public.daily_school_stats d
                           where d.school_id = fchs and d.day = (now() at time zone 'America/New_York')::date),
                         'rollup never overwrites the API-owned counters');
  perform pg_temp.expect((select d.expired = (select count(*) from public.items i
                                               where i.school_id = fchs and i.terminal_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
                                                 and i.custody in ('expired_donated', 'expired_disposed', 'expired_never_arrived'))
                                 and d.expired >= 2 and d.rejected < 9999 and d.claimed < 9999
                            from public.daily_school_stats d
                           where d.school_id = fchs and d.day = (now() at time zone 'America/New_York')::date),
                         'rollup recomputes the other counters from the sources');
  perform pg_temp.expect(pg_temp.err(format('select public.system_rollup_daily_stats(%L)', current_date - 60)) = 'RV001:invalid_input',
                         'rollup refuses days whose sources may be purged');

  -- drafts older than 3 h
  od := pg_temp.mk_item(fchs, 'student', 'draft', 'hidden', 'with_finder');
  perform pg_temp.mk_photo(od, 0, 'uploaded');
  perform pg_temp.mk_photo(od, 1, 'uploaded');
  update public.items set created_at = now() - interval '4 hours' where id = od;
  fr := pg_temp.mk_item(fchs, 'student', 'draft', 'hidden', 'with_finder');
  r := pg_temp.w('select public.system_drafts_to_purge()');
  perform pg_temp.expect(exists (select 1 from jsonb_array_elements(r->'items') as e
                                  where (e->>'itemId')::uuid = od and jsonb_array_length(e->'incomingPaths') = 2
                                    and (e->>'schoolId')::uuid = fchs)
                         and not exists (select 1 from jsonb_array_elements(r->'items') as e where (e->>'itemId')::uuid = fr),
                         'drafts_to_purge lists old drafts with their incoming keys');
  r := pg_temp.w(format('select public.system_purge_draft(%L)', od));
  perform pg_temp.expect((r->>'deleted')::boolean and not exists (select 1 from public.items where id = od)
                         and not exists (select 1 from public.item_photos where item_id = od), 'purge_draft cascades photos');
  r := pg_temp.w(format('select public.system_purge_draft(%L)', fr));
  perform pg_temp.expect(not (r->>'deleted')::boolean and exists (select 1 from public.items where id = fr),
                         'purge_draft keeps fresh drafts');
  r := pg_temp.w(format('select public.system_purge_draft(%L)', x));
  perform pg_temp.expect(not (r->>'deleted')::boolean, 'purge_draft never deletes a non-draft');
end $$;

-- Alerts: §17 conditions become audit rows, deduplicated within 60 minutes.
do $$
declare
  r jsonb;
  v_first int;
begin
  -- a dead job exists from section 1, so dead_jobs must fire (unless it already fired within the hour)
  delete from public.rate_counters where action like 'alert.%';
  r := pg_temp.w('select public.system_evaluate_alerts()');
  perform pg_temp.expect((r->>'count')::int >= 1 and exists (select 1 from public.audit_log a
                           where a.action = 'alert.dead_jobs' and a.created_at = now() and (a.metadata->>'deadJobs')::int >= 1),
                         'evaluate_alerts writes alert.dead_jobs');
  select count(*) into v_first from public.audit_log a where a.action like 'alert.%' and a.created_at = now()
     and a.actor_id = 'evaluate_alerts';
  r := pg_temp.w('select public.system_evaluate_alerts()');
  perform pg_temp.expect((r->>'count')::int = 0 and (select count(*) from public.audit_log a where a.action like 'alert.%'
                           and a.created_at = now() and a.actor_id = 'evaluate_alerts') = v_first,
                         'alerts are deduplicated within 60 minutes');
  -- calendar horizon below 45 days is a school-scoped alert (runbook 23)
  delete from public.rate_counters where action like 'alert.%';
  delete from public.school_calendar_days where school_id = '0c0c0c0c-0000-4000-8000-000000000003' and day > current_date + 10;
  r := pg_temp.w('select public.system_evaluate_alerts()');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.calendar_horizon'
                                   and a.school_id = '0c0c0c0c-0000-4000-8000-000000000003' and a.created_at = now()),
                         'calendar horizon alert is school-scoped');
end $$;

-- The remaining §17 conditions, each driven past its threshold.
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  it uuid;
  r jsonb;
begin
  delete from public.rate_counters where action like 'alert.%';
  -- queue age p95 > 24 h (school-scoped)
  it := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder');
  update public.items set created_at = now() - interval '30 days' where id = it;
  -- deletion ledger unverified for more than 7 days: breach, not the lower levels
  insert into public.media_deletion_ledger (school_id, item_id, reason, requested_at) values (fchs, it, 'pulled', now() - interval '8 days');
  -- three failing readiness checks in a row (dated after anything cron may have written)
  insert into public.health_checks (checked_at, ok) values (now() + interval '1 second', false),
                                                        (now() + interval '2 seconds', false), (now() + interval '3 seconds', false);
  -- screening budget above 80% of the ceiling
  delete from public.rate_counters where tenant_scope = 'district' and action = 'screening';
  insert into public.rate_counters (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
  values ('district', 'screening', 'district', '\x00', date_trunc('day', now(), 'UTC'),
          (select screening_daily_ceiling * 9 / 10 from public.district_settings where id = 1));
  -- storage reported by the worker above 70% of plan
  perform pg_temp.w($q$select public.system_health_record('{"ok": false, "storagePct": 75, "egressPct": 10}')$q$);
  -- no worker heartbeat for more than 10 minutes
  delete from public.worker_heartbeats;
  insert into public.worker_heartbeats (worker_id, seen_at) values ('old-worker', now() - interval '11 minutes');

  r := pg_temp.w('select public.system_evaluate_alerts()');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.queue_age' and a.school_id = fchs
                                   and a.created_at = now() and (a.metadata->>'p95Hours')::numeric > 24), 'alert.queue_age');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.deletion_unverified_breach' and a.created_at = now())
                         and not exists (select 1 from public.audit_log a where a.created_at = now()
                                           and a.action in ('alert.deletion_unverified_high', 'alert.deletion_unverified_warning')),
                         'alert.deletion_unverified_breach replaces the lower levels');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.health_failing' and a.created_at = now()),
                         'alert.health_failing after 3 failing checks');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.screening_budget' and a.created_at = now()),
                         'alert.screening_budget over 80%');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.storage' and a.created_at = now())
                         and not exists (select 1 from public.audit_log a where a.action = 'alert.egress' and a.created_at = now()),
                         'alert.storage from the worker figures');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.worker_stale' and a.created_at = now()
                                   and (a.metadata->>'heartbeatAgeS')::int >= 660), 'alert.worker_stale');
  perform pg_temp.expect(not exists (select 1 from public.audit_log a where a.action like 'alert.%' and a.created_at = now()
                                       and a.metadata::text ~* '(description|path|token|digest)'),
                         'alert metadata carries figures only (F-74)');

  -- no health row for 20 minutes
  delete from public.rate_counters where action like 'alert.%';
  delete from public.health_checks;
  insert into public.health_checks (checked_at, ok) values (now() - interval '25 minutes', true);
  r := pg_temp.w('select public.system_evaluate_alerts()');
  perform pg_temp.expect(exists (select 1 from public.audit_log a where a.action = 'alert.health_gap' and a.created_at = now()
                                   and (a.metadata->>'gapS')::int >= 1500), 'alert.health_gap');
end $$;

-- Claim cohorts of earlier days keep filling in as claims arrive (§17 cohort recovery).
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  v_day date := (now() at time zone 'America/New_York')::date - 10;
  it uuid;
  v_before int;
begin
  insert into public.daily_school_stats (school_id, day) values (fchs, v_day) on conflict do nothing;
  select received_cohort_7d into v_before from public.daily_school_stats where school_id = fchs and day = v_day;
  it := pg_temp.mk_item(fchs, 'staff', 'approved', 'withdrawn', 'claimed');
  update public.items
     set received_at = (v_day::timestamp + interval '12 hours') at time zone 'America/New_York',
         current_location_id = dropoff_location_id,
         claimed_at = (v_day::timestamp + interval '36 hours') at time zone 'America/New_York',
         terminal_at = (v_day::timestamp + interval '36 hours') at time zone 'America/New_York'
   where id = it;
  perform pg_temp.w(format('select public.system_rollup_daily_stats(%L)', (now() at time zone 'America/New_York')::date));
  perform pg_temp.expect((select received_cohort_7d >= 1 and received_cohort_30d >= 1 and received_cohort_7d >= v_before
                            from public.daily_school_stats where school_id = fchs and day = v_day),
                         'rollup refreshes the claim cohorts of the previous 30 days');
end $$;

-- =====================================================================================================
-- 7. Purges (14 retention table + BUILD-CONTRACT additions)
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  h_old bytea := extensions.gen_random_bytes(33);
  h_new bytea := extensions.gen_random_bytes(33);
  h_blk bytea := extensions.gen_random_bytes(33);
  i_old uuid; i_new uuid; r_old uuid; r_new uuid; r_open uuid; r_m90 uuid; r_m10 uuid; vis uuid; vis2 uuid;
  ph uuid; ph2 uuid; e1 bigint; e2 bigint; e3 bigint; e4 bigint; j_done_old bigint; j_done_new bigint;
  j_dead_old bigint; j_dead_new bigint; l1 bigint; t_old uuid; t_new uuid; mv uuid;
  r jsonb;
  v_t timestamptz := now() - interval '31 days';
begin
  perform pg_temp.expect(pg_temp.err($q$select public.system_purge('everything')$q$) = 'RV001:invalid_input', 'unknown purge kind');

  -- devices: 90 d after last_seen_at, not while blocked
  insert into public.devices (school_id, token_hash, last_seen_at) values (fchs, h_old, now() - interval '91 days');
  insert into public.devices (school_id, token_hash, last_seen_at) values (fchs, h_new, now() - interval '1 day');
  insert into public.devices (school_id, token_hash, last_seen_at, blocked_until, block_reason)
  values (fchs, h_blk, now() - interval '91 days', now() + interval '1 day', 'staff');
  r := pg_temp.w($q$select public.system_purge('devices')$q$);
  perform pg_temp.expect((r->>'count')::int >= 1 and r->>'kind' = 'devices'
                         and not exists (select 1 from public.devices where token_hash = h_old)
                         and exists (select 1 from public.devices where token_hash = h_new)
                         and exists (select 1 from public.devices where token_hash = h_blk), 'purge devices');

  -- device_links: 30 d after terminal (G-03 CHECK: cleared_at recorded)
  i_old := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'claimed');
  update public.items set terminal_at = now() - interval '31 days', claimed_at = now() - interval '31 days' where id = i_old;
  i_new := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'claimed');
  r := pg_temp.w($q$select public.system_purge('device_links')$q$);
  perform pg_temp.expect((select device_token_hash is null and device_link_cleared_at = now() from public.items where id = i_old)
                         and (select device_token_hash is not null from public.items where id = i_new), 'purge device_links');

  -- closed_reports: content cleared 30 d after terminal
  insert into public.lost_reports (school_id, category, description, device_token_hash, status, terminal_at, expires_at,
                                   map_version_id, pin_x, pin_y)
  values (fchs, 'bag', 'old closed report', extensions.gen_random_bytes(33), 'closed_by_user', v_t, now(),
          '0a0a0a0a-2000-4000-8000-000000000001', 0.2, 0.2) returning id into r_old;
  insert into public.lost_reports (school_id, category, description, device_token_hash, status, terminal_at, expires_at)
  values (fchs, 'bag', 'new closed report', extensions.gen_random_bytes(33), 'closed_found', now() - interval '2 days', now())
  returning id into r_new;
  insert into public.lost_reports (school_id, category, description, device_token_hash, expires_at)
  values (fchs, 'bag', 'open report', extensions.gen_random_bytes(33), now() + interval '10 days') returning id into r_open;
  r := pg_temp.w($q$select public.system_purge('closed_reports')$q$);
  perform pg_temp.expect((select description is null and pin_x is null and device_token_hash is null and content_cleared_at = now()
                                 from public.lost_reports where id = r_old)
                         and (select description is not null from public.lost_reports where id = r_new)
                         and (select description is not null from public.lost_reports where id = r_open), 'purge closed_reports');

  -- report_matches: 90 d after the report's terminal_at
  vis := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'with_finder');
  insert into public.lost_reports (school_id, category, description, device_token_hash, status, terminal_at, expires_at)
  values (fchs, 'bag', 'very old report', extensions.gen_random_bytes(33), 'expired', now() - interval '91 days', now())
  returning id into r_m90;
  insert into public.lost_reports (school_id, category, description, device_token_hash, status, terminal_at, expires_at)
  values (fchs, 'bag', 'older report', extensions.gen_random_bytes(33), 'expired', now() - interval '10 days', now())
  returning id into r_m10;
  insert into public.lost_report_matches (school_id, lost_report_id, item_id, score, scorer_version)
  values (fchs, r_m90, vis, 0.8, 'v1'), (fchs, r_m10, vis, 0.8, 'v1');
  r := pg_temp.w($q$select public.system_purge('report_matches')$q$);
  perform pg_temp.expect(not exists (select 1 from public.lost_report_matches where lost_report_id = r_m90)
                         and exists (select 1 from public.lost_report_matches where lost_report_id = r_m10), 'purge report_matches');

  -- idempotency_keys: 24 h
  insert into public.idempotency_keys (tenant_scope, principal_kind, operation, principal_hmac, key_hash, request_hash, created_at, expires_at)
  values ('school:' || fchs::text, 'device', 'item.create', '\x01', '\xaa01', '\x01', now() - interval '25 hours', now() + interval '1 hour'),
         ('school:' || fchs::text, 'device', 'item.create', '\x01', '\xaa02', '\x01', now() - interval '1 hour', now() - interval '1 minute'),
         ('school:' || fchs::text, 'device', 'item.create', '\x01', '\xaa03', '\x01', now() - interval '1 hour', now() + interval '1 hour');
  r := pg_temp.w($q$select public.system_purge('idempotency_keys')$q$);
  perform pg_temp.expect((select array_agg(key_hash order by key_hash) from public.idempotency_keys
                           where principal_hmac = '\x01' and tenant_scope = 'school:' || fchs::text) = array['\xaa03'::bytea],
                         'purge idempotency_keys');

  -- search_events: redacted text 7 d, rows 90 d or purge_after
  insert into public.search_events (school_id, query_hmac, redacted_query, result_count, created_at, purge_after)
  values (fchs, '\x01', 'blue bottle', 1, now() - interval '8 days', now() + interval '80 days') returning id into e1;
  insert into public.search_events (school_id, query_hmac, redacted_query, result_count, created_at, purge_after)
  values (fchs, '\x02', null, 0, now() - interval '91 days', now() + interval '1 day') returning id into e2;
  insert into public.search_events (school_id, query_hmac, redacted_query, result_count, created_at, purge_after)
  values (fchs, '\x03', null, 0, now() - interval '2 days', now() - interval '1 minute') returning id into e3;
  insert into public.search_events (school_id, query_hmac, redacted_query, result_count, created_at, purge_after)
  values (fchs, '\x04', 'hoodie', 2, now() - interval '1 day', now() + interval '89 days') returning id into e4;
  r := pg_temp.w($q$select public.system_purge('search_events')$q$);
  perform pg_temp.expect((select redacted_query from public.search_events where id = e1) is null
                         and not exists (select 1 from public.search_events where id in (e2, e3))
                         and (select redacted_query from public.search_events where id = e4) = 'hoodie', 'purge search_events');

  -- health_checks: 30 d
  insert into public.health_checks (checked_at, ok) values (now() - interval '31 days', true), (now() - interval '29 days', true);
  r := pg_temp.w($q$select public.system_purge('health_checks')$q$);
  perform pg_temp.expect(not exists (select 1 from public.health_checks where checked_at = now() - interval '31 days')
                         and exists (select 1 from public.health_checks where checked_at = now() - interval '29 days'),
                         'purge health_checks');

  -- rate_counters: 48 h, but a counter with an N-day window (action suffix :Nd) survives N + 1 days, so the
  -- weekly post limit (post_item:7d) keeps its whole window
  insert into public.rate_counters (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
  values ('zz_test', 'search', 'ip', '\x01', now() - interval '49 hours', 3),
         ('zz_test', 'search', 'ip', '\x01', now() - interval '1 hour', 3),
         ('zz_test', 'post_item:1d', 'device', '\x01', now() - interval '49 hours', 1),
         ('zz_test', 'post_item:1d', 'device', '\x01', now() - interval '25 hours', 1),
         ('zz_test', 'post_item:7d', 'device', '\x01', now() - interval '6 days', 4),
         ('zz_test', 'post_item:7d', 'device', '\x01', now() - interval '7 days 23 hours', 4),
         ('zz_test', 'post_item:7d', 'device', '\x01', now() - interval '8 days 1 hour', 4);
  r := pg_temp.w($q$select public.system_purge('rate_counters')$q$);
  perform pg_temp.expect((select array_agg(action || '@' || extract(epoch from now() - window_start)::bigint::text
                                           order by action, window_start)
                            from public.rate_counters where tenant_scope = 'zz_test')
                         = array['post_item:1d@90000', 'post_item:7d@687600', 'post_item:7d@518400', 'search@3600'],
                         'purge rate_counters: 48 h, weekly windows kept 8 days');

  -- jobs: done 30 d; dead 90 d after disposition
  insert into public.jobs (kind, status, finished_at) values ('zz_test_purge', 'done', now() - interval '31 days') returning id into j_done_old;
  insert into public.jobs (kind, status, finished_at) values ('zz_test_purge', 'done', now() - interval '1 day') returning id into j_done_new;
  insert into public.jobs (kind, status, finished_at, disposed_at)
  values ('zz_test_purge', 'dead', now() - interval '100 days', now() - interval '91 days') returning id into j_dead_old;
  insert into public.jobs (kind, status, finished_at) values ('zz_test_purge', 'dead', now() - interval '100 days') returning id into j_dead_new;
  r := pg_temp.w($q$select public.system_purge('jobs')$q$);
  perform pg_temp.expect((select array_agg(id order by id) from public.jobs where kind = 'zz_test_purge')
                         = array[j_done_new, j_dead_new], 'purge jobs');

  -- screening_runs: signals older than 30 d become {"aggregated": true}
  ph := pg_temp.mk_photo(vis, 0, 'canonical_ready');
  insert into public.screening_runs (school_id, item_id, item_photo_id, provider, model, policy_version, status, signals, created_at)
  values (fchs, vis, ph, 'mock', 'm', 'old', 'ok', '{"has_face": true}', now() - interval '31 days'),
         (fchs, vis, ph, 'mock', 'm', 'new', 'ok', '{"has_face": true}', now() - interval '1 day');
  r := pg_temp.w($q$select public.system_purge('screening_runs')$q$);
  perform pg_temp.expect((select signals from public.screening_runs where item_photo_id = ph and policy_version = 'old') = '{"aggregated": true}'::jsonb
                         and (select signals from public.screening_runs where item_photo_id = ph and policy_version = 'new') = '{"has_face": true}'::jsonb,
                         'purge screening_runs aggregates old signals');

  -- deletion_evidence: storage_path NULLed 90 d after verification
  vis2 := pg_temp.mk_item(fchs, 'staff', 'approved', 'hidden', 'at_location');
  ph2 := pg_temp.mk_photo(vis2, 0, 'canonical_ready');
  insert into public.media_deletion_ledger (school_id, item_id, reason, verified_at) values (fchs, vis2, 'test', now() - interval '91 days')
  returning id into l1;
  insert into public.media_deletion_objects (ledger_id, school_id, item_id, item_photo_id, storage_path, object_kind, deleted_at, verified_at)
  values (l1, fchs, vis2, ph2, 'x/original', 'original', now() - interval '91 days', now() - interval '91 days'),
         (l1, fchs, vis2, ph2, 'x/review', 'review', now() - interval '10 days', now() - interval '10 days');
  r := pg_temp.w($q$select public.system_purge('deletion_evidence')$q$);
  perform pg_temp.expect((select storage_path from public.media_deletion_objects where ledger_id = l1 and object_kind = 'original') is null
                         and (select storage_path from public.media_deletion_objects where ledger_id = l1 and object_kind = 'review') = 'x/review',
                         'purge deletion_evidence');

  -- device_rejections: 30 d
  insert into public.device_rejections (school_id, device_token_hash, rejected_at)
  values (fchs, h_old, now() - interval '31 days'), (fchs, h_old, now() - interval '1 day');
  r := pg_temp.w($q$select public.system_purge('device_rejections')$q$);
  perform pg_temp.expect((select count(*) from public.device_rejections where device_token_hash = h_old) = 1, 'purge device_rejections');

  -- media_tickets: 1 d
  insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, created_at, expires_at)
  values (fchs, 'map.read', '0a0a0a0a-2000-4000-8000-000000000001', '00000000-5b00-4000-8000-000000000002',
          now() - interval '2 days', now() - interval '2 days' + interval '30 seconds') returning id into t_old;
  insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, expires_at)
  values (fchs, 'map.read', '0a0a0a0a-2000-4000-8000-000000000001', '00000000-5b00-4000-8000-000000000002',
          now() + interval '30 seconds') returning id into t_new;
  r := pg_temp.w($q$select public.system_purge('media_tickets')$q$);
  perform pg_temp.expect(not exists (select 1 from public.media_tickets where id = t_old)
                         and exists (select 1 from public.media_tickets where id = t_new), 'purge media_tickets');

  -- map_drafts: rejected drafts get delete_map_draft after 7 d; the worker then reports them deleted
  mv := gen_random_uuid();
  insert into public.map_versions (id, school_id, draft_storage_path, draft_canonical_path, width_px, height_px,
                                   approval_status, submitted_at, rejected_reason, created_at)
  values (mv, fchs, fchs::text || '/' || mv::text || '/draft', fchs::text || '/' || mv::text || '/canonical.jpg', 100, 100,
          'rejected', now() - interval '8 days', 'shows a classroom', now() - interval '9 days');
  r := pg_temp.w($q$select public.system_purge('map_drafts')$q$);
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'delete_map_draft'
                                   and j.dedupe_key = 'delete_map_draft:' || mv::text and j.payload = jsonb_build_object('mapVersionId', mv)),
                         'purge map_drafts enqueues delete_map_draft');
  r := pg_temp.w(format('select public.system_map_draft_deleted(%L)', mv));
  perform pg_temp.expect((select draft_storage_path is null and draft_canonical_path is null from public.map_versions where id = mv),
                         'map_draft_deleted clears the draft keys');
end $$;

-- =====================================================================================================
-- 8. Matching: candidates and record_match keeping the top 10 (§12.2)
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  rep uuid;
  its uuid[] := '{}';
  other_cat uuid; other_school uuid; late uuid;
  k int;
  r jsonb;
  v_before int;
begin
  insert into public.lost_reports (school_id, category, description, device_token_hash, expires_at, map_version_id, pin_x, pin_y)
  values (fchs, 'bottle', 'lost my blue hydroflask water bottle near the gym', extensions.gen_random_bytes(33),
          now() + interval '60 days', '0a0a0a0a-2000-4000-8000-000000000001', 0.40, 0.50)
  returning id into rep;
  for k in 1..12 loop
    its := its || pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'with_finder', 'blue hydroflask bottle number ' || k);
  end loop;
  update public.items set map_version_id = '0a0a0a0a-2000-4000-8000-000000000001', pin_x = 0.45, pin_y = 0.50 where id = its[1];
  other_cat := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'with_finder', 'blue hydroflask water bottle');
  update public.items set category = 'bag' where id = other_cat;

  r := pg_temp.w(format('select public.system_match_candidates_for_report(%L)', rep));
  perform pg_temp.expect(jsonb_array_length(r->'pairs') between 12 and 50
                         and exists (select 1 from jsonb_array_elements(r->'pairs') as e where (e->>'itemId')::uuid = its[5])
                         and not exists (select 1 from jsonb_array_elements(r->'pairs') as e where (e->>'itemId')::uuid = other_cat),
                         'report candidates: lexical match, compatible category only');
  perform pg_temp.expect((select e ?& array['reportId', 'itemId', 'lex', 'sameCategory', 'reportCategoryNull', 'foundAt', 'lostOn',
                                             'sameMapVersion', 'dx', 'dy', 'mapWidth', 'mapHeight']
                                 and (e->>'lex')::numeric > 0 and (e->>'lex')::numeric <= 1 and (e->>'sameCategory')::boolean
                                 and not (e->>'reportCategoryNull')::boolean
                            from jsonb_array_elements(r->'pairs') as e where (e->>'itemId')::uuid = its[2]),
                         'pair shape');
  perform pg_temp.expect((select (e->>'sameMapVersion')::boolean and round((e->>'dx')::numeric, 2) = 0.05
                                 and (e->>'dy')::numeric = 0 and (e->>'mapWidth')::int = 1600 and (e->>'mapHeight')::int = 1000
                            from jsonb_array_elements(r->'pairs') as e where (e->>'itemId')::uuid = its[1]),
                         'same-map pins give dx/dy and the map dimensions');
  r := pg_temp.w(format('select public.system_match_candidates_for_item(%L)', its[3]));
  perform pg_temp.expect(exists (select 1 from jsonb_array_elements(r->'pairs') as e where (e->>'reportId')::uuid = rep),
                         'item candidates include the open report');
  r := pg_temp.w(format('select public.system_match_candidates_for_item(%L)', other_cat));
  perform pg_temp.expect(not exists (select 1 from jsonb_array_elements(r->'pairs') as e where (e->>'reportId')::uuid = rep),
                         'item candidates respect category compatibility');

  v_before := pg_temp.stat(fchs, 'matches_surfaced');
  for k in 1..12 loop
    r := pg_temp.w(format($q$select public.system_record_match(%L, %L, %s, '{"lex": 0.5, "cat": 1, "note": "text", "weights": {"lex": 0.45, "s": "x"}}', 'v1')$q$,
                          rep, its[k], k / 20.0));
  end loop;
  perform pg_temp.expect((select count(*) from public.lost_report_matches where lost_report_id = rep) = 10
                         and not exists (select 1 from public.lost_report_matches where lost_report_id = rep and item_id in (its[1], its[2])),
                         'at most 10 matches per report, the lowest evicted');
  perform pg_temp.expect((select match_count = 10 and last_matched_at = now() from public.lost_reports where id = rep),
                         'match_count and last_matched_at updated');
  perform pg_temp.expect((select features from public.lost_report_matches where lost_report_id = rep and item_id = its[3])
                         = '{"lex": 0.5, "cat": 1, "weights": {"lex": 0.45}}'::jsonb, 'features keep numbers only');
  perform pg_temp.expect(pg_temp.stat(fchs, 'matches_surfaced') = v_before + 12, 'matches_surfaced counts new matches');
  r := pg_temp.w(format($q$select public.system_record_match(%L, %L, 0.1, '{}', 'v1')$q$, rep, its[12]));
  perform pg_temp.expect((select score from public.lost_report_matches where lost_report_id = rep and item_id = its[12]) = 0.6,
                         'upsert keeps the max score');
  r := pg_temp.w(format($q$select public.system_record_match(%L, %L, 0.99, '{"lex": 1}', 'v2')$q$, rep, its[3]));
  perform pg_temp.expect((select score = 0.99 and scorer_version = 'v2' from public.lost_report_matches
                           where lost_report_id = rep and item_id = its[3]), 'a better score replaces features and version');
  late := pg_temp.mk_item(fchs, 'staff', 'approved', 'published', 'with_finder', 'blue bottle late');
  r := pg_temp.w(format($q$select public.system_record_match(%L, %L, 0.01, '{}', 'v1')$q$, rep, late));
  perform pg_temp.expect(not (r->>'recorded')::boolean and (r->>'matchCount')::int = 10
                         and not exists (select 1 from public.lost_report_matches where item_id = late),
                         'a score below the top 10 is not kept');
  other_school := pg_temp.mk_item('0b0b0b0b-0000-4000-8000-000000000002', 'staff', 'approved', 'published', 'with_finder');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_record_match(%L, %L, 0.9, '{}', 'v1')$q$, rep, other_school))
                         = 'RV001:tenant_mismatch', 'record_match refuses cross-school pairs');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_record_match(%L, %L, 1.5, '{}', 'v1')$q$, rep, late))
                         = 'RV001:invalid_input', 'score must be in [0, 1]');
  update public.lost_reports set status = 'closed_by_user', terminal_at = now() where id = rep;
  r := pg_temp.w(format($q$select public.system_record_match(%L, %L, 0.9, '{}', 'v1')$q$, rep, late));
  perform pg_temp.expect(not (r->>'recorded')::boolean, 'closed reports get no new matches');
  r := pg_temp.w(format('select public.system_match_candidates_for_report(%L)', rep));
  perform pg_temp.expect(jsonb_array_length(r->'pairs') = 0, 'no candidates for a closed report');
end $$;

-- =====================================================================================================
-- 9. Media tickets and map activation (G-04, G-07)
-- =====================================================================================================
do $$
declare
  fchs constant uuid := '0a0a0a0a-0000-4000-8000-000000000001';
  old_map constant uuid := '0a0a0a0a-2000-4000-8000-000000000001';
  dadmin constant uuid := '00000000-5b00-4000-8000-000000000001';
  v2 uuid := gen_random_uuid();
  v3 uuid := gen_random_uuid();
  t uuid; t_old uuid; t_up uuid; t_exp uuid; t_read uuid;
  it uuid; p uuid;
  pub text;
  r jsonb;
  mv public.map_versions;
begin
  insert into public.map_versions (id, school_id, draft_storage_path, draft_canonical_path, width_px, height_px, created_by)
  values (v2, fchs, fchs::text || '/' || v2::text || '/draft', fchs::text || '/' || v2::text || '/canonical.jpg', 2000, 1250,
          '00000000-5b00-4000-8000-000000000002');
  insert into public.map_zones (school_id, map_version_id, name, cx, cy, radius) values (fchs, v2, 'Main Hall', 0.3, 0.4, 0.1);
  insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y)
  select fchs, l.id, v2, 0.5, 0.5 from public.locations l where l.school_id = fchs and l.code <> 'STUB';
  update public.map_versions set approval_status = 'pending_district', submitted_at = now() where id = v2;
  insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, expires_at)
  values (fchs, 'map.activate', v2, dadmin, now() + interval '30 seconds') returning id into t;
  pub := fchs::text || '/' || v2::text || '/' || encode(extensions.gen_random_bytes(16), 'hex') || '.jpg';

  perform pg_temp.expect(pg_temp.err(format('select public.system_map_activate(%L, %L)', t, pub)) = 'RV001:forbidden',
                         'activation needs a redeemed ticket');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_media_ticket_redeem(%L, 'map.read')$q$, t)) = 'RV001:forbidden',
                         'ticket operation must match');
  r := pg_temp.w(format($q$select public.system_media_ticket_redeem(%L, 'map.activate')$q$, t));
  perform pg_temp.expect((r->>'mapVersionId')::uuid = v2 and (r->>'schoolId')::uuid = fchs and r->>'operation' = 'map.activate'
                         and r->>'draftCanonicalPath' = fchs::text || '/' || v2::text || '/canonical.jpg'
                         and r ?& array['photoId', 'reviewPath', 'originalPath', 'draftPath'],
                         'redeem returns the map context');
  perform pg_temp.expect((select used_at from public.media_tickets where id = t) = now(), 'redeem sets used_at');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_media_ticket_redeem(%L, 'map.activate')$q$, t)) = 'RV001:forbidden',
                         'tickets are single use');
  perform pg_temp.expect(pg_temp.err(format('select public.system_map_activate(%L, %L)', t, pub)) = 'RV001:invalid_input',
                         'every active location must be pinned');
  insert into public.location_map_pins (school_id, location_id, map_version_id, pin_x, pin_y)
  select fchs, l.id, v2, 0.6, 0.6 from public.locations l where l.school_id = fchs and l.code = 'STUB';
  perform pg_temp.expect(pg_temp.err(format('select public.system_map_activate(%L, %L)', t, fchs::text || '/' || v2::text || '/map.jpg'))
                         = 'RV001:invalid_input', 'public key must be <school>/<version>/<tokenhex>.jpg');

  r := pg_temp.w(format('select public.system_map_activate(%L, %L)', t, pub));
  perform pg_temp.expect((r->>'active')::boolean and (r->>'retiredVersionId')::uuid = old_map, 'activation result');
  select * into mv from public.map_versions where id = v2;
  perform pg_temp.expect(mv.approval_status = 'approved' and mv.active and mv.approved_by = dadmin and mv.approved_at = now()
                         and mv.public_storage_path = pub, 'new version approved and active');
  select * into mv from public.map_versions where id = old_map;
  perform pg_temp.expect(mv.approval_status = 'retired' and not mv.active and mv.retired_at = now()
                         and mv.public_storage_path is not null, 'previous version retired, public path kept');
  perform pg_temp.expect(exists (select 1 from public.jobs j where j.kind = 'delete_map_draft' and j.dedupe_key = 'delete_map_draft:' || v2::text)
                         and exists (select 1 from public.audit_log a where a.action = 'map.activate' and a.target_id = v2::text
                                       and a.actor_kind = 'staff' and a.actor_id = dadmin::text)
                         and exists (select 1 from public.jobs j where j.kind = 'invalidate_cache' and j.payload->'tags' ? ('school:' || fchs::text)),
                         'activation enqueues delete_map_draft, invalidates, audits');
  r := pg_temp.w(format('select public.system_map_activate(%L, %L)', t, pub));
  perform pg_temp.expect((r->>'replay')::boolean, 'activation replay');
  r := pg_temp.w(format('select public.system_map_draft_deleted(%L)', v2));
  perform pg_temp.expect((select draft_storage_path is null and draft_canonical_path is null and public_storage_path = pub
                                 from public.map_versions where id = v2), 'draft keys cleared after activation');

  -- a ticket redeemed more than 2 minutes ago cannot activate
  insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, created_at, expires_at, used_at)
  values (fchs, 'map.activate', v2, dadmin, now() - interval '3 minutes', now() - interval '150 seconds', now() - interval '3 minutes')
  returning id into t_old;
  perform pg_temp.expect(pg_temp.err(format('select public.system_map_activate(%L, %L)', t_old, pub)) = 'RV001:forbidden',
                         'stale map.activate ticket refused');

  -- map.upload: redeem records the draft key and schedules canonicalization; canonical_ready is for drafts only
  insert into public.map_versions (id, school_id, created_by) values (v3, fchs, '00000000-5b00-4000-8000-000000000002');
  insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, expires_at)
  values (fchs, 'map.upload', v3, '00000000-5b00-4000-8000-000000000002', now() + interval '30 seconds') returning id into t_up;
  r := pg_temp.w(format($q$select public.system_media_ticket_redeem(%L, 'map.upload')$q$, t_up));
  perform pg_temp.expect(r->>'draftPath' = fchs::text || '/' || v3::text || '/draft'
                         and (select draft_storage_path from public.map_versions where id = v3) = r->>'draftPath'
                         and exists (select 1 from public.jobs j where j.dedupe_key = 'canonicalize_map:' || v3::text
                                       and j.run_after = now() + interval '60 seconds'),
                         'map.upload redeem records the draft key and schedules canonicalize_map');
  perform pg_temp.expect(pg_temp.err(format('select public.system_map_canonical_ready(%L, %L, 2400, 1500)', v3, 'elsewhere/canonical.jpg'))
                         = 'RV001:invalid_input', 'map canonical key prefix');
  r := pg_temp.w(format('select public.system_map_canonical_ready(%L, %L, 2400, 1500)', v3, fchs::text || '/' || v3::text || '/canonical.jpg'));
  r := pg_temp.w(format('select public.system_map_get(%L)', v3));
  perform pg_temp.expect(r->>'approvalStatus' = 'draft' and (r->>'width')::int = 2400 and (r->>'height')::int = 1500
                         and r->>'draftCanonicalPath' = fchs::text || '/' || v3::text || '/canonical.jpg'
                         and r ?& array['mapVersionId', 'schoolId', 'active', 'draftPath', 'publicPath'], 'map_get DTO');
  perform pg_temp.expect(pg_temp.err(format('select public.system_map_canonical_ready(%L, %L, 10, 10)', v2, fchs::text || '/' || v2::text || '/c.jpg'))
                         = 'RV001:state_changed', 'map canonical_ready only for drafts');
  perform pg_temp.expect(pg_temp.err(format('select public.system_map_draft_deleted(%L)', v3)) = 'RV001:state_changed',
                         'draft keys are kept while the version is a draft');

  -- expired tickets and media.read context
  insert into public.media_tickets (school_id, operation, map_version_id, staff_member_id, created_at, expires_at)
  values (fchs, 'map.read', v2, dadmin, now() - interval '1 minute', now() - interval '30 seconds') returning id into t_exp;
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_media_ticket_redeem(%L, 'map.read')$q$, t_exp)) = 'RV001:forbidden',
                         'expired ticket refused');
  perform pg_temp.expect(pg_temp.err(format($q$select public.system_media_ticket_redeem(%L, 'map.read')$q$, gen_random_uuid()))
                         = 'RV001:not_found', 'unknown ticket');
  it := pg_temp.mk_item(fchs, 'student', 'pending', 'hidden', 'with_finder');
  p := pg_temp.mk_photo(it, 0, 'canonical_ready');
  insert into public.media_tickets (school_id, operation, item_id, item_photo_id, staff_member_id, expires_at)
  values (fchs, 'media.read', it, p, '00000000-5b00-4000-8000-000000000004', now() + interval '30 seconds') returning id into t_read;
  r := pg_temp.w(format($q$select public.system_media_ticket_redeem(%L, 'media.read')$q$, t_read));
  perform pg_temp.expect((r->>'photoId')::uuid = p and r->>'reviewPath' = (select review_path from public.item_photos where id = p)
                         and r->>'originalPath' = (select original_path from public.item_photos where id = p)
                         and r->'mapVersionId' = 'null'::jsonb, 'media.read returns the review and canonical keys');
end $$;

-- =====================================================================================================
-- 10. Health functions and the 0450 cron helpers (F-62)
-- =====================================================================================================
do $$
declare
  r jsonb;
  v_key text;
  v_n int;
  v_first bigint;
  v_second bigint;
  h public.health_checks;
begin
  r := pg_temp.w($q$select public.system_record_error('GET /api/s/[code]/items TypeError')$q$);
  r := pg_temp.w($q$select public.system_record_error('GET /api/s/[code]/items TypeError')$q$);
  perform pg_temp.expect((select count >= 2 from public.error_rollup where day = (now() at time zone 'UTC')::date
                           and signature = 'GET /api/s/[code]/items TypeError'), 'record_error upserts error_rollup (G-29)');
  perform pg_temp.expect(pg_temp.err(format('select public.system_record_error(%L)', E'bad\nsignature')) = 'RV001:invalid_input',
                         'error signature must be printable');
  r := pg_temp.w($q$select public.system_health_record('{"ok": true, "storage": true, "latencyMs": 42, "path": "a/b", "storagePct": 12}')$q$);
  select * into h from public.health_checks c where c.detail->>'source' = 'worker' order by c.checked_at desc limit 1;
  perform pg_temp.expect(h.ok and h.latency_ms = 42 and h.detail @> '{"storage": true, "storagePct": 12}'::jsonb
                         and not h.detail ? 'path', 'health_record keeps scalar figures only');

  -- cron catalog: commands only call private helpers, never carry a secret or URL
  select count(*) into v_n from cron.job where jobname like 'recover\_%';
  perform pg_temp.expect(v_n = 12, 'twelve recover_ cron jobs');
  perform pg_temp.expect(not exists (select 1 from cron.job where jobname like 'recover\_%'
                                      and (command !~ '^select private\.[a-z_]+\(' or command ~* '(http|bearer|secret|vault|password)')),
                         'cron commands carry no secrets (F-62)');
  perform pg_temp.expect((select schedule from cron.job where jobname = 'recover_drain') = '* * * * *'
                         and (select schedule from cron.job where jobname = 'recover_health') = '*/5 * * * *'
                         and (select schedule from cron.job where jobname = 'recover_expire_reports') = '*/15 * * * *'
                         and (select schedule from cron.job where jobname = 'recover_purge_drafts') = '0 * * * *'
                         and (select schedule from cron.job where jobname = 'recover_purges') = '15 7 * * *',
                         'cron cadence');

  -- periodic dedupe keys (calls sequenced through variables: AND operands have no evaluation order)
  v_first := private.enqueue_periodic('zz_test_periodic');
  v_second := private.enqueue_periodic('zz_test_periodic');
  perform pg_temp.expect(v_first is not null and v_second is null, 'enqueue_periodic dedupes within the minute');
  v_key := 'zz_test_periodic:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  perform pg_temp.expect(exists (select 1 from public.jobs where id = v_first and dedupe_key = v_key and school_id is null
                                   and payload = '{}'::jsonb), 'periodic dedupe key <kind>:<yyyy-mm-ddThh:mi>');
  delete from public.jobs where kind = 'purge' and status in ('queued', 'running');
  v_n := private.enqueue_purges();
  perform pg_temp.expect(v_n = array_length(private.sys_purge_kinds(), 1), 'one purge job per kind');
  v_n := private.enqueue_purges();
  perform pg_temp.expect(v_n = 0, 'purge jobs are deduplicated per kind and day');
  perform pg_temp.expect(exists (select 1 from public.jobs where kind = 'purge'
                                   and dedupe_key = 'purge:devices:' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD')
                                   and payload = '{"kind": "devices"}'::jsonb and priority = 200), 'purge dedupe key');
  delete from public.jobs where dedupe_key = 'rollup_daily_stats:2026-01-01';
  v_first := private.enqueue_periodic('rollup_daily_stats', jsonb_build_object('day', '2026-01-01'));
  perform pg_temp.expect(exists (select 1 from public.jobs where id = v_first and dedupe_key = 'rollup_daily_stats:2026-01-01'
                                   and payload = '{"day": "2026-01-01"}'::jsonb), 'rollup dedupe key');

  -- the drain is a no-op without both Vault secrets
  if not exists (select 1 from vault.decrypted_secrets where name in ('worker_url', 'scheduler_bearer')) then
    perform pg_temp.expect(private.cron_drain() is null, 'drain does nothing without Vault secrets');
  end if;

  -- health: a SQL-computed row, then alerts
  perform private.cron_health();
  select * into h from public.health_checks c where c.detail->>'source' = 'cron' order by c.checked_at desc limit 1;
  perform pg_temp.expect(h.checked_at >= now() and h.detail ?& array['db', 'oldestJobS', 'deadJobs', 'calendarHorizonD',
                                                                      'deletionUnverifiedMaxAgeS', 'workerHeartbeatAgeS'],
                         'cron_health inserts the health figures');
end $$;

do $$
begin
  raise notice 'system.sql: % checks passed', currval('pg_temp.t_checks');
end $$;

rollback;
