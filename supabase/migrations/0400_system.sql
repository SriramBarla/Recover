-- 0400 system_* function family (BUILD-CONTRACT section 6.4): job queue (§7.6, Appendix E), media pipeline
-- (§9.3-§9.6), screening (§10.3-§10.5), matching (§12), maps (G-07), retention (14 retention table), alerts (§17).
--
-- Every public.system_* function is SECURITY DEFINER with search_path = '', owned by recover_system_owner, and
-- executable by recover_worker only (grant block at the end of this file). The family never reads staff_users or
-- staff_members: the system owner has no grant and no RLS policy on them (F-114, 0098).
-- Helpers named private.sys_* are SECURITY INVOKER; they run with the privileges of the calling definer (the
-- system owner) or of the migration role when called from pg_cron (0450).
-- Returned DTOs are jsonb_build_object values with camelCase keys (section 6). Failures use private.fail (section 4).
set lock_timeout = '5s';
set statement_timeout = '60s';

-- =====================================================================================================
-- private helpers (system family only)
-- =====================================================================================================

-- Storage keys are bucket-relative (section 8). A key is accepted only when it starts with the exact expected
-- school/item/photo (or school/map-version) prefix and the remainder is a single plain file name (F-75).
create or replace function private.sys_key_ok(p_key text, p_prefix text) returns boolean
language sql immutable set search_path = '' as $$
  select p_key is not null and p_prefix is not null
     and char_length(p_key) between char_length(p_prefix) + 1 and 512
     and left(p_key, char_length(p_prefix)) = p_prefix
     and substr(p_key, char_length(p_prefix) + 1) ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$'
     and position('..' in p_key) = 0
$$;

-- Derived-signal stores keep booleans and numbers only (F-53): OCR text, names, or provider JSON never land in
-- screening_runs.signals, lost_report_matches.features, or health_checks.detail. With p_nested, one level of
-- nested objects (for example feature weights) is kept, filtered the same way.
create or replace function private.sys_scalar_json(p jsonb, p_nested boolean default false) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return v_out;
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p) as e loop
    continue when v_key !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$';
    if jsonb_typeof(v_val) in ('boolean', 'number') then
      v_out := v_out || jsonb_build_object(v_key, v_val);
    elsif p_nested and jsonb_typeof(v_val) = 'object' then
      v_out := v_out || jsonb_build_object(v_key, private.sys_scalar_json(v_val, false));
    end if;
  end loop;
  return v_out;
end $$;

-- One counter of daily_school_stats for the school's local day. The column name comes from a fixed allowlist.
create or replace function private.sys_bump_stat(p_school_id uuid, p_column text, p_n int default 1) returns void
language plpgsql set search_path = '' as $$
declare
  v_day date;
begin
  if p_column not in ('posted', 'approved', 'rejected', 'received', 'claimed', 'expired', 'searches',
                      'zero_result_searches', 'lost_reports', 'matches_surfaced', 'matches_viewed',
                      'reports_closed_found', 'screening_images', 'high_value_redirects') then
    raise exception 'sys_bump_stat: % is not a counter column', p_column;
  end if;
  if p_school_id is null or coalesce(p_n, 0) = 0 then
    return;
  end if;
  select (now() at time zone s.timezone)::date into v_day from public.schools s where s.id = p_school_id;
  if v_day is null then
    return;
  end if;
  execute format(
    'insert into public.daily_school_stats as d (school_id, day, %1$I) values ($1, $2, $3)
     on conflict (school_id, day) do update set %1$I = d.%1$I + excluded.%1$I', p_column)
  using p_school_id, v_day, p_n;
end $$;

-- A deletion ledger restricted to some object kinds (variants only, for example). Same F-75 prefix rule as
-- private.create_deletion_ledger; objects already scheduled by another unverified ledger are not repeated.
create or replace function private.sys_ledger(
  p_item_id uuid, p_school_id uuid, p_reason text, p_kinds text[],
  p_photo_ids uuid[] default null, p_run_after timestamptz default now()
) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_ledger bigint;
  v_n int;
  v_prefix text := p_school_id::text || '/' || p_item_id::text || '/';
begin
  if exists (
       select 1
         from public.item_photos p
         cross join lateral (values ('incoming', p.incoming_path), ('original', p.original_path), ('review', p.review_path),
                                    ('thumb', p.thumb_path), ('medium', p.medium_path)) as o(kind, path)
        where p.item_id = p_item_id and p.school_id = p_school_id and o.path is not null and o.kind = any (p_kinds)
          and (p_photo_ids is null or p.id = any (p_photo_ids))
          and left(o.path, length(v_prefix)) <> v_prefix) then
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
   where p.item_id = p_item_id and p.school_id = p_school_id and o.path is not null and o.kind = any (p_kinds)
     and p.status <> 'deleted'
     and (p_photo_ids is null or p.id = any (p_photo_ids))
     and not exists (
           select 1
             from public.media_deletion_objects x
             join public.media_deletion_ledger l on l.id = x.ledger_id
            where l.verified_at is null and x.item_photo_id = p.id and x.object_kind = o.kind
              and x.storage_path = o.path);
  get diagnostics v_n = row_count;
  if v_n = 0 then
    delete from public.media_deletion_ledger where id = v_ledger;
    return null;
  end if;
  perform private.enqueue('delete_media', jsonb_build_object('ledgerId', v_ledger), p_school_id,
    'delete_media:' || v_ledger::text, p_run_after, 100::smallint);
  return v_ledger;
end $$;

-- §17 alert: an audit_log row `alert.<name>` (school-scoped when p_school_id is set), at most one per name and
-- scope within 60 minutes. The system owner cannot read audit_log, so the 60-minute marker lives in rate_counters
-- (tenant_scope district or school:<id>, action alert.<name>, subject 0x00, window_start = fire time; purged at 48 h).
create or replace function private.sys_alert(p_name text, p_school_id uuid, p_metadata jsonb default '{}'::jsonb)
returns boolean
language plpgsql set search_path = '' as $$
declare
  v_scope text := case when p_school_id is null then 'district' else 'school:' || p_school_id::text end;
  v_kind text := case when p_school_id is null then 'district' else 'school' end;
  v_action text := 'alert.' || p_name;
begin
  if exists (select 1 from public.rate_counters c
              where c.tenant_scope = v_scope and c.action = v_action and c.subject_kind = v_kind
                and c.subject_hmac = '\x00'::bytea and c.window_start > now() - interval '60 minutes') then
    return false;
  end if;
  insert into public.rate_counters (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
  values (v_scope, v_action, v_kind, '\x00'::bytea, now(), 1)
  on conflict (tenant_scope, action, subject_kind, subject_hmac, window_start) do nothing;
  perform private.audit(p_school_id, 'system', 'evaluate_alerts', null, v_action, 'alerts', p_name,
                        '{}'::jsonb, '{}'::jsonb, coalesce(p_metadata, '{}'::jsonb));
  return true;
end $$;

-- Side effects of a job reaching `dead` (Appendix E.1 step 7, §10.4): an alert row, and state that must not wait
-- forever on a job that will never run again.
create or replace function private.sys_on_dead_job(p_job public.jobs) returns void
language plpgsql set search_path = '' as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item_id uuid;
  v_photo_id uuid;
begin
  perform private.audit(p_job.school_id, 'system', 'worker', null, 'alert.dead_job', 'jobs', p_job.id::text,
    '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object('jobId', p_job.id, 'kind', p_job.kind, 'errorCode', p_job.last_error_code));

  if p_job.kind = 'screen_item' and coalesce(p_job.payload->>'itemId', '') ~ v_uuid then
    -- §10.4 provider exhausted: screening_status error + flag; a staff post is no longer blocked on it (G-08).
    v_item_id := (p_job.payload->>'itemId')::uuid;
    update public.items
       set screening_status = 'error',
           screening_flags = screening_flags || '{"screening_error": true}'::jsonb
     where id = v_item_id and screening_status = 'unscreened';
    if found then
      perform private.staff_publish_ready(v_item_id);
    end if;
  elsif p_job.kind = 'canonicalize_photo' and coalesce(p_job.payload->>'photoId', '') ~ v_uuid then
    -- §9.3: a canonicalization failure leaves the item non-public with a stable failure code.
    v_photo_id := (p_job.payload->>'photoId')::uuid;
    update public.item_photos
       set status = 'failed',
           failure_code = case when coalesce(p_job.last_error_code, '') ~ '^[a-z_]{2,40}$'
                               then p_job.last_error_code else 'dead_job' end
     where id = v_photo_id and status in ('uploaded', 'canonicalizing')
    returning item_id into v_item_id;
    if v_item_id is not null then
      update public.items set screening_flags = screening_flags || '{"photo_failed": true}'::jsonb
       where id = v_item_id;
    end if;
  elsif p_job.kind = 'delete_media' and coalesce(p_job.payload->>'ledgerId', '') ~ '^[0-9]{1,18}$' then
    update public.media_deletion_ledger set last_error_code = p_job.last_error_code
     where id = (p_job.payload->>'ledgerId')::bigint and verified_at is null;
  end if;
end $$;

-- OR-query over the English lexemes of a description (G-22: OR groups; stop words removed by the english config).
-- Lexemes are quoted directly into tsquery syntax so they are not re-stemmed.
create or replace function private.sys_or_query(p text) returns tsquery
language plpgsql stable set search_path = '' as $$
declare
  v text;
begin
  select string_agg('''' || t.lexeme || '''', ' | ' order by t.lexeme)
    into v
    from unnest(to_tsvector('english'::regconfig, private.f_unaccent(coalesce(p, '')))) as t
   where t.lexeme ~ '^[[:alnum:]]{2,40}$';
  if v is null then
    return null;
  end if;
  return v::tsquery;
end $$;

-- Kinds accepted by system_purge; 0450 enqueues one nightly purge job per kind from this same list.
create or replace function private.sys_purge_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['devices', 'device_links', 'closed_reports', 'report_matches', 'idempotency_keys', 'search_events',
               'health_checks', 'rate_counters', 'jobs', 'screening_runs', 'deletion_evidence', 'device_rejections',
               'media_tickets', 'map_drafts']::text[]
$$;

-- Health figures computed in SQL (§17 health model; api_health DTO names): shared by private.cron_health (0450)
-- and system_evaluate_alerts. Deletion age counts from when the deletion became due: never-arrived ledgers are
-- deliberately delayed by the school's late-arrival grace (G-01).
create or replace function private.sys_health_snapshot() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_oldest double precision;
  v_dead bigint;
  v_horizon int;
  v_deletion double precision;
  v_heartbeat double precision;
begin
  select extract(epoch from now() - min(j.run_after))::double precision into v_oldest
    from public.jobs j where j.status = 'queued' and j.run_after <= now();
  select count(*) into v_dead from public.jobs j where j.status = 'dead' and j.disposed_at is null;
  select min(h.days) into v_horizon
    from (select coalesce((select max(c.day) from public.school_calendar_days c where c.school_id = s.id and c.is_open)
                          - (now() at time zone s.timezone)::date, 0) as days
            from public.schools s where s.active) as h;
  select max(extract(epoch from now() - (l.requested_at
                     + case when l.reason = 'never_arrived' then make_interval(days => s.late_arrival_grace_days)
                            else interval '0' end)))::double precision
    into v_deletion
    from public.media_deletion_ledger l
    join public.schools s on s.id = l.school_id
   where l.verified_at is null;
  select extract(epoch from now() - max(w.seen_at))::double precision into v_heartbeat from public.worker_heartbeats w;
  return jsonb_build_object(
    'db', true,
    'oldestJobS', case when v_oldest is null then null else floor(greatest(v_oldest, 0))::bigint end,
    'deadJobs', v_dead,
    'calendarHorizonD', v_horizon,
    'deletionUnverifiedMaxAgeS', floor(greatest(coalesce(v_deletion, 0), 0))::bigint,
    'workerHeartbeatAgeS', case when v_heartbeat is null then null else floor(greatest(v_heartbeat, 0))::bigint end);
end $$;

-- =====================================================================================================
-- job queue (§7.6, Appendix E; G-06, G-33)
-- =====================================================================================================

create or replace function public.system_lease_jobs(p_worker_id text, p_kinds text[], p_limit int, p_lease_seconds int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_mode text := coalesce((private.district()).worker_mode, 'normal');
  v_kinds text[] := p_kinds;
  v_limit int := greatest(1, least(20, coalesce(p_limit, 1)));
  v_lease int := greatest(10, least(900, coalesce(p_lease_seconds, 60)));
  v_jobs jsonb;
begin
  set local lock_timeout = '3s';
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 80 then
    perform private.fail('invalid_input', 'worker_id');
  end if;
  -- G-06: restore quarantine leases only the read-only reconciliation kinds.
  if v_mode = 'quarantine' then
    v_kinds := array(select k from unnest(array['reconcile_generating', 'reconcile_orphan_uploads']) as k
                      where p_kinds is null or k = any (p_kinds));
  end if;

  with cte as (
    select j.id
      from public.jobs j
     where j.status = 'queued' and j.run_after <= now()
       and (v_kinds is null or j.kind = any (v_kinds))
     order by j.priority, j.run_after, j.id
     limit v_limit
       for update skip locked
  ), upd as (
    update public.jobs j
       set status = 'running', attempts = j.attempts + 1, locked_by = p_worker_id,
           locked_at = now(), locked_until = now() + make_interval(secs => v_lease)
      from cte
     where j.id = cte.id
    returning j.id, j.kind, j.payload, j.school_id, j.attempts, j.max_attempts, j.priority, j.run_after
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'kind', u.kind, 'payload', u.payload,
                                               'schoolId', u.school_id, 'attempts', u.attempts,
                                               'maxAttempts', u.max_attempts)
                            order by u.priority, u.run_after, u.id), '[]'::jsonb)
    into v_jobs
    from upd u;
  return jsonb_build_object('jobs', v_jobs);
end $$;

create or replace function public.system_job_done(p_job_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  set local lock_timeout = '3s';
  update public.jobs set status = 'done', finished_at = now(), locked_until = null
   where id = p_job_id and status = 'running'
  returning status into v_status;
  if v_status is null then
    select j.status into v_status from public.jobs j where j.id = p_job_id;
    if v_status is null then
      perform private.fail('not_found');
    end if;
    return jsonb_build_object('ok', v_status = 'done', 'status', v_status);
  end if;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

-- Appendix E.2: transient -> requeue with bounded backoff; permanent or out of attempts -> dead + alert.
create or replace function public.system_job_fail(p_job_id bigint, p_error_code text, p_retry_after_s int, p_permanent boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_code text := left(regexp_replace(lower(coalesce(nullif(btrim(p_error_code), ''), 'unknown')), '[^a-z0-9_]+', '_', 'g'), 60);
  v_retry int;
begin
  set local lock_timeout = '3s';
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_job.status <> 'running' then
    return jsonb_build_object('status', v_job.status, 'attempts', v_job.attempts, 'runAfter', v_job.run_after);
  end if;

  if coalesce(p_permanent, false) or v_job.attempts >= v_job.max_attempts then
    update public.jobs set status = 'dead', finished_at = now(), last_error_code = v_code, locked_until = null
     where id = v_job.id
    returning * into v_job;
    perform private.sys_on_dead_job(v_job);
    return jsonb_build_object('status', 'dead', 'attempts', v_job.attempts, 'runAfter', v_job.run_after);
  end if;

  v_retry := case when p_retry_after_s is not null then greatest(0, least(86400, p_retry_after_s))
                  else least(300, 5 * (2 ^ least(v_job.attempts, 10))::int) + floor(random() * 5)::int end;
  update public.jobs
     set status = 'queued', run_after = now() + make_interval(secs => v_retry), last_error_code = v_code,
         locked_until = null
   where id = v_job.id
  returning * into v_job;
  return jsonb_build_object('status', 'queued', 'attempts', v_job.attempts, 'runAfter', v_job.run_after);
end $$;

create or replace function public.system_reap_leases() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_requeued int := 0;
  v_dead int := 0;
begin
  set local lock_timeout = '3s';
  for v_job in
    with cte as (
      select j.id
        from public.jobs j
       where j.status = 'running' and j.locked_until < now()
       order by j.locked_until, j.id
       limit 500
         for update skip locked
    )
    update public.jobs j
       set status = case when j.attempts >= j.max_attempts then 'dead' else 'queued' end,
           finished_at = case when j.attempts >= j.max_attempts then now() else j.finished_at end,
           run_after = case when j.attempts >= j.max_attempts then j.run_after else now() end,
           last_error_code = 'lease_expired',
           locked_until = null
      from cte
     where j.id = cte.id
    returning j.*
  loop
    if v_job.status = 'dead' then
      v_dead := v_dead + 1;
      perform private.sys_on_dead_job(v_job);
    else
      v_requeued := v_requeued + 1;
    end if;
  end loop;
  return jsonb_build_object('requeued', v_requeued, 'dead', v_dead);
end $$;

create or replace function public.system_worker_heartbeat(p_worker_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  set local lock_timeout = '3s';
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 80 then
    perform private.fail('invalid_input', 'worker_id');
  end if;
  insert into public.worker_heartbeats (worker_id, seen_at) values (p_worker_id, now())
  on conflict (worker_id) do update set seen_at = excluded.seen_at;
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================================================
-- uploads and canonicalization (§9.2, §9.3; G-08, G-11, G-37, G-38)
-- =====================================================================================================

-- Current photo generations still waiting for their raw upload: a student draft, or a staff/backfill item that
-- is approved and hidden (G-08). Keys are the incoming_path values written by the API family (section 8).
create or replace function public.system_get_upload_spec(p_item_id uuid, p_school_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_bad int;
  v_photos jsonb;
begin
  set local lock_timeout = '3s';
  select * into v_item from public.items where id = p_item_id and school_id = p_school_id;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_item.deleted_at is not null
     or not ((v_item.posted_by_kind = 'student' and v_item.review_status = 'draft')
             or (v_item.posted_by_kind <> 'student' and v_item.review_status = 'approved'
                 and v_item.publication_status = 'hidden')) then
    perform private.fail('state_changed', 'item_state');
  end if;
  select count(*) filter (where not private.sys_key_ok(p.incoming_path,
                                  p.school_id::text || '/' || p.item_id::text || '/' || p.id::text || '/')),
         coalesce(jsonb_agg(jsonb_build_object('photoId', p.id, 'position', p.position, 'key', p.incoming_path)
                            order by p.position), '[]'::jsonb)
    into v_bad, v_photos
    from public.item_photos p
   where p.item_id = v_item.id and p.school_id = v_item.school_id and p.is_current and p.status = 'uploaded';
  if v_bad > 0 then
    perform private.fail('invalid_input', 'incoming_path');
  end if;
  if v_photos = '[]'::jsonb then
    perform private.fail('state_changed', 'no_pending_uploads');
  end if;
  return jsonb_build_object('schoolId', v_item.school_id, 'itemId', v_item.id, 'photos', v_photos);
end $$;

-- The expected raw objects for the worker's HEAD check before api_complete_item / api_staff_complete_item.
create or replace function public.system_get_complete_spec(p_item_id uuid, p_school_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_spec jsonb;
begin
  v_spec := public.system_get_upload_spec(p_item_id, p_school_id);
  return jsonb_build_object(
    'schoolId', v_spec->'schoolId',
    'itemId', v_spec->'itemId',
    'photos', (select coalesce(jsonb_agg(jsonb_build_object('photoId', e->'photoId', 'position', e->'position',
                                                            'key', e->'key') order by (e->>'position')::int), '[]'::jsonb)
                 from jsonb_array_elements(v_spec->'photos') as e));
end $$;

create or replace function public.system_get_photo(p_photo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_out jsonb;
begin
  select jsonb_build_object(
           'photoId', p.id, 'itemId', p.item_id, 'schoolId', p.school_id, 'status', p.status,
           'position', p.position, 'generation', p.generation,
           'incomingPath', p.incoming_path, 'originalPath', p.original_path, 'reviewPath', p.review_path,
           'thumbPath', p.thumb_path, 'mediumPath', p.medium_path,
           'publicObjectToken', case when p.public_object_token is null then null
                                     else encode(p.public_object_token, 'hex') end,
           'isCurrent', p.is_current)
    into v_out
    from public.item_photos p
   where p.id = p_photo_id;
  if v_out is null then
    perform private.fail('not_found');
  end if;
  return v_out;
end $$;

-- §9.3 step 8. Accepted from uploaded or canonicalizing only; a replay after a committed success reports the
-- current state without repeating side effects (the screen_item dedupe only covers active jobs).
create or replace function public.system_photo_canonical_ready(
  p_photo_id uuid, p_original_path text, p_review_path text, p_bytes int, p_width int, p_height int, p_fingerprint bytea
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_policy constant text := 'v1';
  v_item_id uuid;
  v_item public.items;
  v_photo public.item_photos;
  v_prefix text;
  v_all boolean;
  v_dup boolean := false;
begin
  set local lock_timeout = '3s';
  select p.item_id into v_item_id from public.item_photos p where p.id = p_photo_id;
  if v_item_id is null then
    perform private.fail('not_found');
  end if;
  select * into v_item from public.items where id = v_item_id for update;
  select * into v_photo from public.item_photos where id = p_photo_id for update;

  if v_photo.status in ('canonical_ready', 'public_ready') then
    select coalesce(bool_and(x.status in ('canonical_ready', 'public_ready')), false) into v_all
      from public.item_photos x where x.item_id = v_item.id and x.is_current;
    return jsonb_build_object('allCanonical', v_all, 'replay', true);
  end if;
  if v_photo.status not in ('uploaded', 'canonicalizing') then
    perform private.fail('state_changed', 'photo_status');
  end if;

  v_prefix := v_photo.school_id::text || '/' || v_photo.item_id::text || '/' || v_photo.id::text || '/';
  if not private.sys_key_ok(p_original_path, v_prefix) or not private.sys_key_ok(p_review_path, v_prefix)
     or p_original_path = p_review_path then
    perform private.fail('invalid_input', 'path');
  end if;
  if p_bytes is null or p_bytes <= 0 or p_width is null or p_width <= 0 or p_height is null or p_height <= 0 then
    perform private.fail('invalid_input', 'dimensions');
  end if;

  update public.item_photos
     set original_path = p_original_path, review_path = p_review_path, bytes = p_bytes, width = p_width,
         height = p_height, content_fingerprint = p_fingerprint, status = 'canonical_ready', failure_code = null
   where id = v_photo.id;

  -- G-11: a duplicate is always a reviewer flag, never an auto-reject.
  if p_fingerprint is not null and exists (
       select 1 from public.item_photos o
        where o.school_id = v_photo.school_id and o.content_fingerprint = p_fingerprint
          and o.item_id <> v_photo.item_id and o.created_at > now() - interval '30 days') then
    v_dup := true;
    update public.items set screening_flags = screening_flags || '{"duplicate": true}'::jsonb where id = v_item.id;
  end if;

  select coalesce(bool_and(x.status in ('canonical_ready', 'public_ready')), false) into v_all
    from public.item_photos x where x.item_id = v_item.id and x.is_current;
  if v_all and v_item.deleted_at is null and v_item.review_status in ('pending', 'approved') then
    if coalesce((private.district()).screening_enabled, false) then
      perform private.enqueue('screen_item', jsonb_build_object('itemId', v_item.id, 'policyVersion', v_policy),
        v_item.school_id, 'screen_item:' || v_item.id::text || ':' || v_policy, now(), 100::smallint);
    else
      perform private.staff_publish_ready(v_item.id);  -- G-08; returns false for student items
    end if;
  end if;
  return jsonb_build_object('allCanonical', v_all, 'duplicate', v_dup);
end $$;

-- §9.3 step 9: after the raw object is deleted (or confirmed 404), NULL incoming_path.
create or replace function public.system_photo_incoming_cleared(p_photo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  set local lock_timeout = '3s';
  select p.status into v_status from public.item_photos p where p.id = p_photo_id;
  if v_status is null then
    perform private.fail('not_found');
  end if;
  if v_status not in ('canonical_ready', 'public_ready', 'failed', 'deleted') then
    return jsonb_build_object('ok', false, 'status', v_status);
  end if;
  update public.item_photos set incoming_path = null where id = p_photo_id and incoming_path is not null;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

create or replace function public.system_photo_failed(p_photo_id uuid, p_failure_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item_id uuid;
  v_status text;
begin
  set local lock_timeout = '3s';
  if p_failure_code is null or p_failure_code !~ '^[a-z_]{2,40}$' then
    perform private.fail('invalid_input', 'failure_code');
  end if;
  select p.item_id, p.status into v_item_id, v_status from public.item_photos p where p.id = p_photo_id;
  if v_item_id is null then
    perform private.fail('not_found');
  end if;
  perform 1 from public.items where id = v_item_id for update;
  update public.item_photos set status = 'failed', failure_code = p_failure_code
   where id = p_photo_id and status in ('uploaded', 'canonicalizing', 'failed');
  if not found then
    return jsonb_build_object('ok', false, 'status', v_status);  -- never regress a canonical generation
  end if;
  update public.items set screening_flags = screening_flags || '{"photo_failed": true}'::jsonb where id = v_item_id;
  return jsonb_build_object('ok', true, 'status', 'failed');
end $$;

-- =====================================================================================================
-- screening (§10.3-§10.5; G-24, G-26, G-35)
-- =====================================================================================================

-- G-35: one district-scoped fixed daily window (UTC) in rate_counters, incremented atomically under the ceiling.
create or replace function public.system_screening_budget_take(p_images int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_district public.district_settings := private.district();
  v_window timestamptz := date_trunc('day', now(), 'UTC');
  v_count int;
begin
  set local lock_timeout = '3s';
  if p_images is null or p_images < 1 or p_images > 100 then
    perform private.fail('invalid_input', 'images');
  end if;
  if not coalesce(v_district.screening_enabled, false) then
    return jsonb_build_object('allowed', false, 'enabled', false);
  end if;
  insert into public.rate_counters (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
  values ('district', 'screening', 'district', '\x00'::bytea, v_window, 0)
  on conflict (tenant_scope, action, subject_kind, subject_hmac, window_start) do nothing;
  update public.rate_counters c
     set count = c.count + p_images
   where c.tenant_scope = 'district' and c.action = 'screening' and c.subject_kind = 'district'
     and c.subject_hmac = '\x00'::bytea and c.window_start = v_window
     and c.count + p_images <= v_district.screening_daily_ceiling
  returning c.count into v_count;
  return jsonb_build_object('allowed', v_count is not null, 'enabled', true);
end $$;

create or replace function public.system_record_screening(
  p_item_id uuid, p_photo_id uuid, p_provider text, p_model text, p_policy_version text, p_status text, p_signals jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_photo public.item_photos;
  v_signals jsonb := private.sys_scalar_json(p_signals, false);
  v_flags jsonb := '{}'::jsonb;
  v_key text;
  v_n int;
  v_severe boolean;
  v_ceiling boolean;
  v_missing int;
  v_errors int;
  v_new_status public.screening_status;
  v_withdrawn boolean := false;
  v_ledger bigint;
begin
  set local lock_timeout = '3s';
  if p_status is null or p_status not in ('ok', 'partial', 'error') then
    perform private.fail('invalid_input', 'status');
  end if;
  if p_policy_version is null or p_policy_version !~ '^[A-Za-z0-9._-]{1,20}$' then
    perform private.fail('invalid_input', 'policy_version');
  end if;
  if p_provider is null or char_length(p_provider) not between 1 and 40 then
    perform private.fail('invalid_input', 'provider');
  end if;
  if p_model is null or char_length(p_model) not between 1 and 60 then
    perform private.fail('invalid_input', 'model');
  end if;
  select * into v_item from public.items where id = p_item_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  select * into v_photo from public.item_photos
   where id = p_photo_id and item_id = v_item.id and school_id = v_item.school_id;
  if not found then
    perform private.fail('not_found');
  end if;
  v_severe := coalesce(v_signals->'severe' = 'true'::jsonb, false);   -- G-24: adult/violence VERY_LIKELY
  v_ceiling := coalesce(v_signals->'ceiling' = 'true'::jsonb, false); -- §10.5: skipped over the daily ceiling

  -- G-26: idempotent per (photo, policy); a replay changes nothing.
  insert into public.screening_runs (school_id, item_id, item_photo_id, provider, model, policy_version, status,
                                     signals, error_code)
  values (v_item.school_id, v_item.id, v_photo.id, p_provider, p_model, p_policy_version, p_status, v_signals,
          case when p_status = 'error' then case when v_ceiling then 'ceiling' else 'provider_error' end end)
  on conflict (item_photo_id, policy_version) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('recorded', false, 'screeningStatus', v_item.screening_status);
  end if;

  if not v_ceiling then
    perform private.sys_bump_stat(v_item.school_id, 'screening_images', 1);
  end if;

  foreach v_key in array array['nsfw', 'has_face', 'has_text', 'contact_info', 'name_like'] loop
    if v_signals->v_key = 'true'::jsonb then
      v_flags := v_flags || jsonb_build_object(v_key, true);
    end if;
  end loop;
  if p_status = 'error' then
    v_flags := v_flags || '{"screening_error": true}'::jsonb;
  end if;
  if v_ceiling then
    v_flags := v_flags || '{"ceiling": true}'::jsonb;
  end if;
  if v_severe then
    v_flags := v_flags || '{"quarantine": true}'::jsonb;
  end if;
  if v_flags <> '{}'::jsonb then
    update public.items set screening_flags = screening_flags || v_flags where id = v_item.id
    returning * into v_item;
  end if;

  -- Aggregate once every current photo has a run for this policy version.
  select count(*) filter (where r.id is null), count(*) filter (where r.status = 'error')
    into v_missing, v_errors
    from public.item_photos x
    left join public.screening_runs r on r.item_photo_id = x.id and r.policy_version = p_policy_version
   where x.item_id = v_item.id and x.is_current;
  if v_missing = 0 then
    v_new_status := case
      when v_errors > 0 then 'error'
      when exists (select 1 from jsonb_each(v_item.screening_flags) as f
                    where f.key <> 'hold' and f.value = 'true'::jsonb) then 'flagged'
      else 'clean' end;
    update public.items set screening_status = v_new_status where id = v_item.id
    returning * into v_item;
  end if;

  if v_severe then
    -- G-24: a late severe signal withdraws a live or in-flight publication and removes the public variants.
    -- The private canonical/review renditions stay for the designated responders under quarantine.
    if v_item.review_status = 'approved' and v_item.publication_status in ('generating', 'published') then
      update public.items set publication_status = 'withdrawn', withdrawn_at = now() where id = v_item.id
      returning * into v_item;
      v_ledger := private.sys_ledger(v_item.id, v_item.school_id, 'severe_content', array['thumb', 'medium']);
      perform private.invalidate(v_item.school_id, v_item.id);
      v_withdrawn := true;
    end if;
    perform private.audit(v_item.school_id, 'system', 'screening', null, 'alert.severe_content', 'items',
      v_item.id::text, '{}'::jsonb,
      jsonb_build_object('publicationStatus', v_item.publication_status, 'rowVersion', v_item.row_version),
      jsonb_build_object('itemId', v_item.id, 'photoId', v_photo.id, 'withdrawn', v_withdrawn, 'ledgerId', v_ledger));
  end if;

  -- G-08: staff posts continue once fully screened, unless a severe signal placed them on hold.
  if v_item.posted_by_kind <> 'student' and v_missing = 0 then
    if coalesce(v_item.screening_flags->'quarantine' = 'true'::jsonb, false) then
      if not coalesce(v_item.screening_flags->'hold' = 'true'::jsonb, false) then
        update public.items set screening_flags = screening_flags || '{"hold": true}'::jsonb where id = v_item.id
        returning * into v_item;
      end if;
    else
      perform private.staff_publish_ready(v_item.id);
    end if;
  end if;

  return jsonb_build_object('recorded', true, 'screeningStatus', v_item.screening_status, 'allScreened', v_missing = 0,
                            'severe', v_severe, 'withdrawn', v_withdrawn);
end $$;

-- =====================================================================================================
-- variants and publishing (§9.4, §16.3; F-18, F-98)
-- =====================================================================================================

-- The 128-bit public object token is generated once per photo generation and stored before any upload (F-98).
create or replace function public.system_variant_targets(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_photos jsonb;
begin
  set local lock_timeout = '3s';
  select * into v_item from public.items where id = p_item_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_item.review_status <> 'approved' or v_item.publication_status <> 'generating' or v_item.deleted_at is not null then
    return jsonb_build_object('generating', false, 'photos', '[]'::jsonb);
  end if;
  update public.item_photos set public_object_token = extensions.gen_random_bytes(16)
   where item_id = v_item.id and is_current and public_object_token is null
     and status in ('canonical_ready', 'public_ready');
  select coalesce(jsonb_agg(jsonb_build_object('photoId', p.id, 'position', p.position, 'status', p.status,
                                               'originalPath', p.original_path,
                                               'token', encode(p.public_object_token, 'hex'))
                            order by p.position), '[]'::jsonb)
    into v_photos
    from public.item_photos p
   where p.item_id = v_item.id and p.is_current and p.status in ('canonical_ready', 'public_ready');
  return jsonb_build_object('generating', true, 'schoolId', v_item.school_id, 'itemId', v_item.id, 'photos', v_photos);
end $$;

-- Keys must be <school>/<item>/<photo>/<tokenhex>/<file> (section 8). If the item left `generating` while the
-- variants were being built (pull, claim, expiry, severe content), the objects are recorded and immediately put on
-- a deletion ledger so they never outlive the decision.
create or replace function public.system_photo_variants_ready(p_photo_id uuid, p_thumb_path text, p_medium_path text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item_id uuid;
  v_item public.items;
  v_photo public.item_photos;
  v_prefix text;
  v_all boolean;
  v_ledger bigint;
begin
  set local lock_timeout = '3s';
  select p.item_id into v_item_id from public.item_photos p where p.id = p_photo_id;
  if v_item_id is null then
    perform private.fail('not_found');
  end if;
  select * into v_item from public.items where id = v_item_id for update;
  select * into v_photo from public.item_photos where id = p_photo_id for update;
  if v_photo.public_object_token is null then
    perform private.fail('state_changed', 'token');
  end if;
  v_prefix := v_photo.school_id::text || '/' || v_photo.item_id::text || '/' || v_photo.id::text || '/'
              || encode(v_photo.public_object_token, 'hex') || '/';
  if not private.sys_key_ok(p_thumb_path, v_prefix) or not private.sys_key_ok(p_medium_path, v_prefix)
     or p_thumb_path = p_medium_path then
    perform private.fail('invalid_input', 'path');
  end if;

  if v_photo.status = 'public_ready' then
    if v_photo.thumb_path is distinct from p_thumb_path or v_photo.medium_path is distinct from p_medium_path then
      perform private.fail('state_changed', 'variants');
    end if;
  elsif v_item.review_status = 'approved' and v_item.publication_status = 'generating'
        and v_item.deleted_at is null and v_photo.is_current and v_photo.status = 'canonical_ready' then
    update public.item_photos set thumb_path = p_thumb_path, medium_path = p_medium_path, status = 'public_ready'
     where id = v_photo.id;
  else
    update public.item_photos
       set thumb_path = p_thumb_path, medium_path = p_medium_path,
           status = case status when 'canonical_ready' then 'public_ready' when 'deleted' then 'failed' else status end,
           failure_code = case when status = 'deleted' then 'late_variants' else failure_code end
     where id = v_photo.id;
    v_ledger := private.sys_ledger(v_item.id, v_item.school_id, 'late_variants', array['thumb', 'medium'],
                                   array[v_photo.id]);
    return jsonb_build_object('ok', true, 'ready', false, 'allReady', false, 'ledgerId', v_ledger);
  end if;

  select coalesce(bool_and(x.status = 'public_ready'), false) into v_all
    from public.item_photos x where x.item_id = v_item.id and x.is_current;
  if v_all and v_item.review_status = 'approved' and v_item.publication_status = 'generating' then
    perform private.enqueue('finalize_publish', jsonb_build_object('itemId', v_item.id), v_item.school_id,
      'finalize_publish:' || v_item.id::text, now(), 50::smallint);
  end if;
  return jsonb_build_object('ok', true, 'ready', true, 'allReady', v_all);
end $$;

-- Appendix C item_finalize_publish: approved + generating, every current generation public_ready (the trigger
-- private.items_state_assertions re-checks it, F-18).
create or replace function public.system_finalize_publish(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_current int;
  v_not_ready int;
begin
  set local lock_timeout = '3s';
  select * into v_item from public.items where id = p_item_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_item.review_status <> 'approved' or v_item.publication_status <> 'generating' or v_item.deleted_at is not null then
    return jsonb_build_object('published', false, 'publicationStatus', v_item.publication_status);
  end if;
  select count(*), count(*) filter (where p.status <> 'public_ready')
    into v_current, v_not_ready
    from public.item_photos p where p.item_id = v_item.id and p.is_current;
  if v_current = 0 or v_not_ready > 0 then
    return jsonb_build_object('published', false, 'publicationStatus', v_item.publication_status,
                              'reason', 'variants_not_ready');
  end if;
  update public.items set publication_status = 'published' where id = v_item.id
  returning * into v_item;
  perform private.invalidate(v_item.school_id, v_item.id);
  perform private.enqueue('match_item', jsonb_build_object('itemId', v_item.id), v_item.school_id,
    'match_item:' || v_item.id::text || ':' || v_item.row_version::text, now(), 100::smallint);
  perform private.audit(v_item.school_id, 'system', 'finalize_publish', null, 'item.finalize_publish', 'items',
    v_item.id::text, jsonb_build_object('publicationStatus', 'generating'),
    jsonb_build_object('publicationStatus', v_item.publication_status, 'rowVersion', v_item.row_version));
  return jsonb_build_object('published', true, 'publicationStatus', v_item.publication_status,
                            'rowVersion', v_item.row_version);
end $$;

-- =====================================================================================================
-- media tickets (G-04, G-07) and deletion proof (§9.6, Appendix F)
-- =====================================================================================================

create or replace function public.system_media_ticket_redeem(p_ticket_id uuid, p_operation text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ticket public.media_tickets;
  v_photo public.item_photos;
  v_map public.map_versions;
  v_draft text;
begin
  set local lock_timeout = '3s';
  select * into v_ticket from public.media_tickets where id = p_ticket_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_ticket.operation is distinct from p_operation or v_ticket.used_at is not null or v_ticket.expires_at <= now() then
    perform private.fail('forbidden', 'ticket');
  end if;
  update public.media_tickets set used_at = now() where id = v_ticket.id;

  if v_ticket.operation = 'media.read' then
    select * into v_photo from public.item_photos
     where id = v_ticket.item_photo_id and item_id = v_ticket.item_id and school_id = v_ticket.school_id;
    return jsonb_build_object('schoolId', v_ticket.school_id, 'operation', v_ticket.operation,
      'itemId', v_ticket.item_id, 'photoId', v_ticket.item_photo_id,
      'reviewPath', v_photo.review_path, 'originalPath', v_photo.original_path,
      'mapVersionId', null, 'draftPath', null, 'draftCanonicalPath', null, 'publicPath', null);
  end if;

  select * into v_map from public.map_versions
   where id = v_ticket.map_version_id and school_id = v_ticket.school_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_ticket.operation = 'map.upload' then
    if v_map.approval_status <> 'draft' then
      perform private.fail('state_changed', 'map_not_draft');
    end if;
    v_draft := v_map.school_id::text || '/' || v_map.id::text || '/draft';
    if v_map.draft_storage_path is distinct from v_draft then
      update public.map_versions set draft_storage_path = v_draft where id = v_map.id;
      v_map.draft_storage_path := v_draft;
    end if;
    -- Nothing else can observe the browser's PUT, so the canonicalization job is scheduled here with a short delay;
    -- the worker retries while the draft object is still missing.
    perform private.enqueue('canonicalize_map', jsonb_build_object('mapVersionId', v_map.id), v_map.school_id,
      'canonicalize_map:' || v_map.id::text, now() + interval '60 seconds', 100::smallint);
  elsif v_ticket.operation = 'map.activate' then
    if v_map.approval_status <> 'pending_district' or v_map.draft_canonical_path is null then
      perform private.fail('state_changed', 'map_not_pending');
    end if;
  end if;
  return jsonb_build_object('schoolId', v_ticket.school_id, 'operation', v_ticket.operation,
    'itemId', null, 'photoId', null, 'reviewPath', null, 'originalPath', null,
    'mapVersionId', v_map.id, 'draftPath', v_map.draft_storage_path,
    'draftCanonicalPath', v_map.draft_canonical_path, 'publicPath', v_map.public_storage_path,
    'width', v_map.width_px, 'height', v_map.height_px);
end $$;

create or replace function public.system_deletion_objects(p_ledger_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger public.media_deletion_ledger;
  v_objects jsonb;
begin
  select * into v_ledger from public.media_deletion_ledger where id = p_ledger_id;
  if not found then
    -- cancelled by a late arrival (G-01): nothing to delete
    return jsonb_build_object('found', false, 'objects', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'photoId', o.item_photo_id,
           'objectKind', o.object_kind,
           'bucket', case o.object_kind when 'incoming' then 'incoming'
                                        when 'thumb' then 'variants' when 'medium' then 'variants'
                                        else 'originals' end,
           'storagePath', o.storage_path,
           'currentPath', case o.object_kind when 'incoming' then p.incoming_path when 'original' then p.original_path
                                             when 'review' then p.review_path when 'thumb' then p.thumb_path
                                             else p.medium_path end,
           'deletedAt', o.deleted_at,
           'verifiedAt', o.verified_at)
         order by o.item_photo_id, o.object_kind), '[]'::jsonb)
    into v_objects
    from public.media_deletion_objects o
    join public.item_photos p on p.id = o.item_photo_id and p.item_id = o.item_id and p.school_id = o.school_id
   where o.ledger_id = v_ledger.id;
  return jsonb_build_object('found', true, 'ledgerId', v_ledger.id, 'schoolId', v_ledger.school_id,
                            'itemId', v_ledger.item_id, 'reason', v_ledger.reason,
                            'verifiedAt', v_ledger.verified_at, 'objects', v_objects);
end $$;

-- Called after the signed DELETE (204 or 404, p_verified false) and again after the verifying HEAD 404
-- (p_verified true). Idempotent.
create or replace function public.system_deletion_object_done(
  p_ledger_id bigint, p_photo_id uuid, p_object_kind text, p_verified boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_remaining int;
begin
  set local lock_timeout = '3s';
  update public.media_deletion_objects
     set deleted_at = coalesce(deleted_at, now()),
         verified_at = case when coalesce(p_verified, false) then coalesce(verified_at, now()) else verified_at end,
         attempts = attempts + 1,
         last_error_code = null
   where ledger_id = p_ledger_id and item_photo_id = p_photo_id and object_kind = p_object_kind;
  if not found then
    perform private.fail('not_found');
  end if;
  select count(*) into v_remaining
    from public.media_deletion_objects where ledger_id = p_ledger_id and verified_at is null;
  return jsonb_build_object('ok', true, 'remaining', v_remaining);
end $$;

-- Appendix F items 9 and 10: once every object is verified absent, NULL exactly the verified paths and mark a
-- generation with no path left `deleted`, in one transaction with the ledger's verified_at.
create or replace function public.system_media_ledger_verified(p_ledger_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger public.media_deletion_ledger;
  v_pending int;
  v_objects int;
  v_deleted int;
begin
  set local lock_timeout = '3s';
  select * into v_ledger from public.media_deletion_ledger where id = p_ledger_id for update;
  if not found then
    return jsonb_build_object('verified', false, 'found', false);
  end if;
  if v_ledger.verified_at is not null then
    return jsonb_build_object('verified', true, 'replay', true);
  end if;
  select count(*) filter (where o.verified_at is null), count(*) into v_pending, v_objects
    from public.media_deletion_objects o where o.ledger_id = v_ledger.id;
  if v_pending > 0 then
    return jsonb_build_object('verified', false, 'pending', v_pending);
  end if;

  -- lock the generations first so the next statement computes from their latest committed state
  perform 1 from public.item_photos p
   where p.id in (select o.item_photo_id from public.media_deletion_objects o where o.ledger_id = v_ledger.id)
     for update;
  with gone as (
    select o.item_photo_id, array_agg(o.storage_path) as paths
      from public.media_deletion_objects o
     where o.ledger_id = v_ledger.id and o.storage_path is not null
     group by o.item_photo_id
  ), n as (
    select p.id, p.status as old_status,
           case when p.incoming_path = any (g.paths) then null else p.incoming_path end as incoming_path,
           case when p.original_path = any (g.paths) then null else p.original_path end as original_path,
           case when p.review_path = any (g.paths) then null else p.review_path end as review_path,
           case when p.thumb_path = any (g.paths) then null else p.thumb_path end as thumb_path,
           case when p.medium_path = any (g.paths) then null else p.medium_path end as medium_path
      from public.item_photos p
      join gone g on g.item_photo_id = p.id
     where p.item_id = v_ledger.item_id and p.school_id = v_ledger.school_id
  ), s as (
    select n.*,
           case when n.incoming_path is null and n.original_path is null and n.review_path is null
                     and n.thumb_path is null and n.medium_path is null then 'deleted'
                when n.old_status = 'public_ready' and (n.thumb_path is null or n.medium_path is null)
                     and n.original_path is not null and n.review_path is not null then 'canonical_ready'
                when n.old_status in ('canonical_ready', 'public_ready')
                     and (n.original_path is null or n.review_path is null) then 'failed'
                else n.old_status end as new_status
      from n
  )
  update public.item_photos p
     set incoming_path = s.incoming_path, original_path = s.original_path, review_path = s.review_path,
         thumb_path = s.thumb_path, medium_path = s.medium_path, status = s.new_status,
         failure_code = case when s.new_status = 'failed' and s.old_status <> 'failed' then 'deleted_partial'
                             else p.failure_code end
    from s
   where p.id = s.id;

  select count(*) into v_deleted
    from public.item_photos p
   where p.status = 'deleted'
     and p.id in (select o.item_photo_id from public.media_deletion_objects o where o.ledger_id = v_ledger.id);
  update public.media_deletion_ledger set verified_at = now(), last_error_code = null where id = v_ledger.id;
  perform private.audit(v_ledger.school_id, 'system', 'delete_media', null, 'media.deletion_verified',
    'media_deletion_ledger', v_ledger.id::text, '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object('ledgerId', v_ledger.id, 'itemId', v_ledger.item_id, 'reason', v_ledger.reason,
                       'objects', v_objects, 'photosDeleted', v_deleted));
  return jsonb_build_object('verified', true, 'objects', v_objects, 'photosDeleted', v_deleted);
end $$;

-- =====================================================================================================
-- scheduled maintenance (§8.3 cron catalog, Appendix C, 14 retention table; G-01, G-02, G-03, G-13, G-14)
-- =====================================================================================================

-- Appendix C item_expire_never_arrived with the G-01/G-02 resolutions: every review state except draft,
-- publication generating/published -> withdrawn (hidden stays hidden), media deletion delayed by the school's
-- late-arrival grace so a late check-in can still cancel it. withdrawn_at equals terminal_at exactly (one v_now):
-- the late-arrival republish rule compares them. The ledger reason is exactly 'never_arrived', the only reason
-- private.cancel_pending_deletion may cancel.
create or replace function public.system_expire_never_arrived() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_row record;
  v_item public.items;
  v_count int := 0;
begin
  set local lock_timeout = '3s';
  for v_row in
    select i.id, i.publication_status, s.late_arrival_grace_days
      from public.items i
      join public.schools s on s.id = i.school_id
     where i.custody = 'with_finder' and i.review_status <> 'draft' and i.deleted_at is null
       and i.arrival_deadline_at is not null and i.arrival_deadline_at < now()
     order by i.arrival_deadline_at, i.id
     limit 500
       for update of i skip locked
  loop
    update public.items
       set custody = 'expired_never_arrived', terminal_at = v_now,
           publication_status = case when publication_status in ('generating', 'published')
                                     then 'withdrawn'::public.publication_status else publication_status end,
           withdrawn_at = case when publication_status in ('generating', 'published') then v_now else withdrawn_at end
     where id = v_row.id
    returning * into v_item;
    perform private.create_deletion_ledger(v_item.id, v_item.school_id, 'never_arrived', null,
      v_now + make_interval(days => v_row.late_arrival_grace_days));
    if v_row.publication_status in ('generating', 'published') then
      perform private.invalidate(v_item.school_id, v_item.id);
    end if;
    perform private.audit(v_item.school_id, 'system', 'expire_never_arrived', null, 'item.expire_never_arrived',
      'items', v_item.id::text,
      jsonb_build_object('custody', 'with_finder', 'publicationStatus', v_row.publication_status),
      jsonb_build_object('custody', v_item.custody, 'publicationStatus', v_item.publication_status,
                         'rowVersion', v_item.row_version));
    perform private.sys_bump_stat(v_item.school_id, 'expired', 1);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- Appendix C item_mark_disposition_due: custody unchanged, disposition_due_at set idempotently.
create or replace function public.system_mark_disposition_due() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_count int := 0;
begin
  set local lock_timeout = '3s';
  for v_row in
    with c as (
      select i.id
        from public.items i
       where i.custody = 'at_location' and i.expires_at is not null and i.expires_at <= now()
         and i.disposition_due_at is null
       order by i.expires_at, i.id
       limit 500
         for update skip locked
    )
    update public.items i set disposition_due_at = now()
      from c where i.id = c.id
    returning i.id, i.school_id, i.row_version
  loop
    perform private.audit(v_row.school_id, 'system', 'mark_disposition_due', null, 'item.disposition_due', 'items',
      v_row.id::text, '{}'::jsonb, jsonb_build_object('custody', 'at_location', 'rowVersion', v_row.row_version));
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- Appendix C report_expire (G-13).
create or replace function public.system_expire_reports() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_count int := 0;
begin
  set local lock_timeout = '3s';
  for v_row in
    with c as (
      select r.id
        from public.lost_reports r
       where r.status = 'open' and r.expires_at <= now()
       order by r.expires_at, r.id
       limit 500
         for update skip locked
    )
    update public.lost_reports r set status = 'expired', terminal_at = now()
      from c where r.id = c.id
    returning r.id, r.school_id, r.row_version
  loop
    perform private.audit(v_row.school_id, 'system', 'expire_reports', null, 'report.expire', 'lost_reports',
      v_row.id::text, jsonb_build_object('status', 'open'),
      jsonb_build_object('status', 'expired', 'rowVersion', v_row.row_version));
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- §6.1 rejected: after rejected_media_retention_days, delete media and minimize content, the device link (G-03),
-- and photo fingerprints. device_rejections keeps the 30-day reputation window (G-12).
create or replace function public.system_anonymize_rejected() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_days int := coalesce((private.district()).rejected_media_retention_days, 7);
  v_row record;
  v_item public.items;
  v_count int := 0;
begin
  set local lock_timeout = '3s';
  for v_row in
    select i.id, i.school_id
      from public.items i
     where i.review_status = 'rejected' and i.content_anonymized_at is null
       and i.reviewed_at < now() - make_interval(days => v_days)
     order by i.reviewed_at, i.id
     limit 500
       for update skip locked
  loop
    perform private.create_deletion_ledger(v_row.id, v_row.school_id, 'rejected_retention');
    update public.items
       set description = null, location_note_private = null, pin_x = null, pin_y = null, zone_id = null, src = null,
           device_link_cleared_at = case when device_token_hash is not null or posted_by_kind = 'student'
                                         then coalesce(device_link_cleared_at, now()) else device_link_cleared_at end,
           device_token_hash = null,
           content_anonymized_at = now()
     where id = v_row.id
    returning * into v_item;
    update public.item_photos set content_fingerprint = null
     where item_id = v_row.id and content_fingerprint is not null;
    perform private.audit(v_item.school_id, 'system', 'anonymize_rejected', null, 'item.anonymize_rejected', 'items',
      v_item.id::text, '{}'::jsonb,
      jsonb_build_object('reviewStatus', v_item.review_status, 'rowVersion', v_item.row_version));
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- F-87, F-111, G-14: free text and private location of terminal or deleted items are cleared after
-- school.terminal_text_retention_days, counted from coalesce(terminal_at, deleted_at).
create or replace function public.system_clear_terminal_item_text() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_item public.items;
  v_count int := 0;
begin
  set local lock_timeout = '3s';
  for v_row in
    select i.id
      from public.items i
      join public.schools s on s.id = i.school_id
     where i.text_cleared_at is null and i.description is not null
       and (i.terminal_at is not null or i.deleted_at is not null)
       and coalesce(i.terminal_at, i.deleted_at) + make_interval(days => s.terminal_text_retention_days) < now()
     order by coalesce(i.terminal_at, i.deleted_at), i.id
     limit 500
       for update of i skip locked
  loop
    update public.items
       set description = null, location_note_private = null, pin_x = null, pin_y = null, zone_id = null, src = null,
           text_cleared_at = now()
     where id = v_row.id
    returning * into v_item;
    perform private.audit(v_item.school_id, 'system', 'clear_terminal_item_text', null, 'item.clear_terminal_text',
      'items', v_item.id::text, '{}'::jsonb, jsonb_build_object('rowVersion', v_item.row_version));
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- §16.3: a generating item older than 10 minutes with no active make_variants/finalize_publish job is re-driven.
create or replace function public.system_reconcile_generating() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_count int := 0;
begin
  set local lock_timeout = '3s';
  for v_row in
    select i.id, i.school_id
      from public.items i
     where i.review_status = 'approved' and i.publication_status = 'generating' and i.deleted_at is null
       and i.updated_at < now() - interval '10 minutes'
       and not exists (select 1 from public.jobs j
                        where j.status in ('queued', 'running')
                          and j.dedupe_key in ('make_variants:' || i.id::text, 'finalize_publish:' || i.id::text))
     order by i.updated_at, i.id
     limit 500
  loop
    if private.enqueue('make_variants', jsonb_build_object('itemId', v_row.id), v_row.school_id,
                       'make_variants:' || v_row.id::text, now(), 50::smallint) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return jsonb_build_object('count', v_count);
end $$;

-- §17 metrics, recomputed from the source tables for one day, using each school's local day
-- ((ts at time zone school.timezone)::date, the same key the API writers use). The five counters the API writes
-- live (posted, lost_reports, matches_viewed, reports_closed_found, high_value_redirects) are never written here.
-- Claim cohorts of the previous 31 days are refreshed too, because claims keep arriving for 30 days after
-- receipt. Days older than 30 are refused: their sources (search events, match edges) may already be purged.
create or replace function public.system_rollup_daily_stats(p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_count int;
begin
  set local lock_timeout = '3s';
  if p_day is null or p_day > v_today + 1 or p_day < v_today - 30 then
    perform private.fail('invalid_input', 'day');
  end if;

  with s as (
    select sc.id, (p_day::timestamp at time zone sc.timezone) as t0, ((p_day + 1)::timestamp at time zone sc.timezone) as t1
      from public.schools sc
  ), v as (
    select s.id as school_id,
      (select count(*) from public.items i
        where i.school_id = s.id and i.posted_by_kind = 'student' and i.review_status = 'approved'
          and i.reviewed_at >= s.t0 and i.reviewed_at < s.t1) as approved,
      (select count(*) from public.items i
        where i.school_id = s.id and i.review_status = 'rejected' and i.reviewed_at >= s.t0 and i.reviewed_at < s.t1) as rejected,
      (select count(*) from public.items i
        where i.school_id = s.id and i.received_at >= s.t0 and i.received_at < s.t1) as received,
      (select count(*) from public.items i
        where i.school_id = s.id and i.claimed_at >= s.t0 and i.claimed_at < s.t1) as claimed,
      (select count(*) from public.items i
        where i.school_id = s.id and i.custody in ('expired_donated', 'expired_disposed', 'expired_never_arrived')
          and i.terminal_at >= s.t0 and i.terminal_at < s.t1) as expired,
      (select count(*) from public.search_events e
        where e.school_id = s.id and e.created_at >= s.t0 and e.created_at < s.t1) as searches,
      (select count(*) from public.search_events e
        where e.school_id = s.id and e.created_at >= s.t0 and e.created_at < s.t1 and e.result_count = 0) as zero_results,
      (select count(*) from public.lost_report_matches m
        where m.school_id = s.id and m.matched_at >= s.t0 and m.matched_at < s.t1) as matches_surfaced,
      (select count(*) from public.items i
        where i.school_id = s.id and i.received_at >= s.t0 and i.received_at < s.t1
          and i.claimed_at <= i.received_at + interval '7 days') as cohort_7d,
      (select count(*) from public.items i
        where i.school_id = s.id and i.received_at >= s.t0 and i.received_at < s.t1
          and i.claimed_at <= i.received_at + interval '30 days') as cohort_30d,
      -- queue age: student items in the queue at some point of the day, aged until review or the day's end
      (select percentile_cont(0.95) within group (order by
                (extract(epoch from least(coalesce(i.reviewed_at, 'infinity'::timestamptz), s.t1, now()) - i.created_at)
                 / 3600.0)::double precision)
         from public.items i
        where i.school_id = s.id and i.posted_by_kind = 'student' and i.review_status <> 'draft'
          and i.created_at < s.t1 and coalesce(i.reviewed_at, 'infinity'::timestamptz) >= s.t0) as queue_p95,
      (select count(*) from public.screening_runs sr
        where sr.school_id = s.id and sr.created_at >= s.t0 and sr.created_at < s.t1
          and not coalesce(sr.signals->'ceiling' = 'true'::jsonb, false)) as screening_images
      from s
  )
  -- posted, lost_reports, matches_viewed, reports_closed_found, high_value_redirects: API-owned, left out on purpose
  insert into public.daily_school_stats as d
    (school_id, day, approved, rejected, received, claimed, expired, searches, zero_result_searches,
     matches_surfaced, received_cohort_7d, received_cohort_30d, queue_age_p95_hours, screening_images)
  select v.school_id, p_day, v.approved, v.rejected, v.received, v.claimed, v.expired, v.searches,
         v.zero_results, v.matches_surfaced, v.cohort_7d, v.cohort_30d, v.queue_p95, v.screening_images
    from v
  on conflict (school_id, day) do update
    set approved = excluded.approved, rejected = excluded.rejected,
        received = excluded.received, claimed = excluded.claimed, expired = excluded.expired,
        searches = excluded.searches, zero_result_searches = excluded.zero_result_searches,
        matches_surfaced = excluded.matches_surfaced,
        received_cohort_7d = excluded.received_cohort_7d, received_cohort_30d = excluded.received_cohort_30d,
        queue_age_p95_hours = excluded.queue_age_p95_hours, screening_images = excluded.screening_images;
  get diagnostics v_count = row_count;

  update public.daily_school_stats d
     set received_cohort_7d = c.c7, received_cohort_30d = c.c30
    from (select i.school_id, (i.received_at at time zone sc.timezone)::date as day,
                 count(*) filter (where i.claimed_at <= i.received_at + interval '7 days') as c7,
                 count(*) filter (where i.claimed_at <= i.received_at + interval '30 days') as c30
            from public.items i
            join public.schools sc on sc.id = i.school_id
           where i.received_at >= (p_day - 33)::timestamp at time zone 'UTC'
             and i.received_at < (p_day + 1)::timestamp at time zone 'UTC'
           group by 1, 2) as c
   where d.school_id = c.school_id and d.day = c.day and d.day between p_day - 31 and p_day - 1
     and (d.received_cohort_7d, d.received_cohort_30d) is distinct from (c.c7::int, c.c30::int);
  return jsonb_build_object('count', v_count);
end $$;

-- §17 alert list. Each alert is an audit_log row `alert.<name>`, deduplicated per name and scope within 60 min.
-- Storage and egress use figures the worker reports through system_health_record (storagePct, egressPct).
create or replace function public.system_evaluate_alerts() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_health jsonb := private.sys_health_snapshot();
  v_district public.district_settings := private.district();
  v_count int := 0;
  v_runs bigint;
  v_errors bigint;
  v_used bigint;
  v_age double precision;
  v_failing int;
  v_recent int;
  v_last timestamptz;
  v_prev timestamptz;
  v_detail jsonb;
  v_row record;
begin
  set local lock_timeout = '3s';
  perform pg_advisory_xact_lock(hashtext('recover.system_evaluate_alerts'));

  -- oldest queued job > 10 min
  if coalesce((v_health->>'oldestJobS')::bigint, 0) > 600 then
    if private.sys_alert('oldest_job', null, jsonb_build_object('oldestJobS', (v_health->>'oldestJobS')::bigint)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- any dead job not yet disposed by an operator
  if coalesce((v_health->>'deadJobs')::bigint, 0) > 0 then
    if private.sys_alert('dead_jobs', null, jsonb_build_object('deadJobs', (v_health->>'deadJobs')::bigint)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- screening error rate > 5% over 1 h (ceiling skips are budget, not errors)
  select count(*), count(*) filter (where r.status = 'error' and not coalesce(r.signals->'ceiling' = 'true'::jsonb, false))
    into v_runs, v_errors
    from public.screening_runs r where r.created_at > now() - interval '1 hour';
  if v_runs > 0 and v_errors::double precision / v_runs > 0.05 then
    if private.sys_alert('screening_error_rate', null, jsonb_build_object('runs', v_runs, 'errors', v_errors)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- queue age p95 > 24 h at a school (school-scoped: shown to school_admin)
  for v_row in
    select i.school_id,
           percentile_cont(0.95) within group (order by (extract(epoch from now() - i.created_at) / 3600.0)::double precision) as p95
      from public.items i
     where i.review_status = 'pending' and i.deleted_at is null
     group by i.school_id
  loop
    if v_row.p95 > 24 then
      if private.sys_alert('queue_age', v_row.school_id, jsonb_build_object('p95Hours', round(v_row.p95::numeric, 1))) then
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  -- media_deletion_ledger unverified: > 1 h warning, > 24 h high, > 7 d policy breach (§9.6)
  v_age := coalesce((v_health->>'deletionUnverifiedMaxAgeS')::double precision, 0);
  if v_age > 604800 then
    if private.sys_alert('deletion_unverified_breach', null, jsonb_build_object('maxAgeS', v_age::bigint)) then
      v_count := v_count + 1;
    end if;
  elsif v_age > 86400 then
    if private.sys_alert('deletion_unverified_high', null, jsonb_build_object('maxAgeS', v_age::bigint)) then
      v_count := v_count + 1;
    end if;
  elsif v_age > 3600 then
    if private.sys_alert('deletion_unverified_warning', null, jsonb_build_object('maxAgeS', v_age::bigint)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- readiness failing 3 consecutive checks
  select count(*) filter (where not h.ok), count(*) into v_failing, v_recent
    from (select c.ok from public.health_checks c order by c.checked_at desc limit 3) as h;
  if v_recent = 3 and v_failing = 3 then
    if private.sys_alert('health_failing', null, jsonb_build_object('consecutiveFailures', v_failing)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- no health_checks row for 20 minutes (now, or a gap that just ended)
  select max(c.checked_at) into v_last from public.health_checks c;
  select max(c.checked_at) into v_prev from public.health_checks c where c.checked_at < v_last;
  if v_last is null or v_last < now() - interval '20 minutes'
     or (v_prev is not null and v_last - v_prev > interval '20 minutes') then
    if private.sys_alert('health_gap', null, jsonb_build_object(
         'gapS', case when v_last is null then null
                      when v_last < now() - interval '20 minutes' then extract(epoch from now() - v_last)::bigint
                      else extract(epoch from v_last - v_prev)::bigint end)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- screening images > 80% of the daily ceiling (G-35 counter)
  select c.count into v_used
    from public.rate_counters c
   where c.tenant_scope = 'district' and c.action = 'screening' and c.subject_kind = 'district'
     and c.subject_hmac = '\x00'::bytea and c.window_start = date_trunc('day', now(), 'UTC');
  if coalesce(v_district.screening_enabled, false) and v_district.screening_daily_ceiling > 0
     and coalesce(v_used, 0) > 0.8 * v_district.screening_daily_ceiling then
    if private.sys_alert('screening_budget', null,
         jsonb_build_object('used', v_used, 'ceiling', v_district.screening_daily_ceiling)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- storage and egress > 70% of plan, when the worker has reported them
  select c.detail into v_detail
    from public.health_checks c
   where c.detail ? 'storagePct' or c.detail ? 'egressPct'
   order by c.checked_at desc limit 1;
  if jsonb_typeof(v_detail->'storagePct') = 'number' and (v_detail->>'storagePct')::numeric > 70 then
    if private.sys_alert('storage', null, jsonb_build_object('storagePct', v_detail->'storagePct')) then
      v_count := v_count + 1;
    end if;
  end if;
  if jsonb_typeof(v_detail->'egressPct') = 'number' and (v_detail->>'egressPct')::numeric > 70 then
    if private.sys_alert('egress', null, jsonb_build_object('egressPct', v_detail->'egressPct')) then
      v_count := v_count + 1;
    end if;
  end if;

  -- worker heartbeat older than 10 min (§16.2 "worker not running")
  if (v_health->>'workerHeartbeatAgeS') is null or (v_health->>'workerHeartbeatAgeS')::bigint > 600 then
    if private.sys_alert('worker_stale', null,
         jsonb_build_object('heartbeatAgeS', (v_health->>'workerHeartbeatAgeS')::bigint)) then
      v_count := v_count + 1;
    end if;
  end if;

  -- operating-calendar coverage below 45 days (F-88, runbook 23; school-scoped)
  for v_row in
    select s.id,
           coalesce((select max(c.day) from public.school_calendar_days c where c.school_id = s.id and c.is_open)
                    - (now() at time zone s.timezone)::date, 0) as horizon
      from public.schools s
     where s.active
  loop
    if v_row.horizon < 45 then
      if private.sys_alert('calendar_horizon', v_row.id, jsonb_build_object('horizonDays', v_row.horizon)) then
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('count', v_count);
end $$;

-- 14 retention table plus the BUILD-CONTRACT additions. Each kind is idempotent and threshold-based.
create or replace function public.system_purge(p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_n bigint := 0;
  v_m bigint := 0;
  v_row record;
begin
  set local lock_timeout = '3s';
  if p_kind is null or not (p_kind = any (private.sys_purge_kinds())) then
    perform private.fail('invalid_input', 'kind');
  end if;
  case p_kind
    when 'devices' then            -- 90 d after last_seen_at, never while a block is still running
      delete from public.devices
       where last_seen_at < now() - interval '90 days' and (blocked_until is null or blocked_until < now());
      get diagnostics v_n = row_count;
    when 'device_links' then       -- 30 d after terminal custody, deletion, or anonymization (G-03)
      update public.items
         set device_token_hash = null, device_link_cleared_at = coalesce(device_link_cleared_at, now())
       where device_token_hash is not null
         and coalesce(terminal_at, deleted_at, content_anonymized_at) < now() - interval '30 days';
      get diagnostics v_n = row_count;
    when 'closed_reports' then     -- lost-report content 30 d after terminal (§12.4)
      update public.lost_reports
         set description = null, pin_x = null, pin_y = null, device_token_hash = null, content_cleared_at = now()
       where status <> 'open' and content_cleared_at is null and terminal_at < now() - interval '30 days';
      get diagnostics v_n = row_count;
    when 'report_matches' then     -- match edges 90 d after the report's terminal_at (F-108)
      delete from public.lost_report_matches m
       using public.lost_reports r
       where r.id = m.lost_report_id and r.status <> 'open' and r.terminal_at < now() - interval '90 days';
      get diagnostics v_n = row_count;
    when 'idempotency_keys' then   -- 24 h
      delete from public.idempotency_keys where expires_at < now() or created_at < now() - interval '24 hours';
      get diagnostics v_n = row_count;
    when 'search_events' then      -- redacted text 7 d, hashes 90 d (or purge_after)
      update public.search_events set redacted_query = null
       where redacted_query is not null and created_at < now() - interval '7 days';
      get diagnostics v_m = row_count;
      delete from public.search_events where purge_after < now() or created_at < now() - interval '90 days';
      get diagnostics v_n = row_count;
      v_n := v_n + v_m;
    when 'health_checks' then      -- 30 d
      delete from public.health_checks where checked_at < now() - interval '30 days';
      get diagnostics v_n = row_count;
    when 'rate_counters' then      -- 48 h, but never before the counter's own window has ended:
      -- API actions carry their window as a suffix (post_item:1d, post_item:7d); a row with an N-day window is
      -- kept N + 1 days so the weekly post limit keeps its full history.
      delete from public.rate_counters c
       where c.window_start < now() - greatest(
               interval '48 hours',
               case when c.action ~ ':[0-9]{1,3}d$'
                    then make_interval(days => substring(c.action from ':([0-9]{1,3})d$')::int + 1)
                    else interval '0' end);
      get diagnostics v_n = row_count;
    when 'jobs' then               -- done 30 d; dead 90 d after operator disposition
      delete from public.jobs
       where (status = 'done' and finished_at < now() - interval '30 days')
          or (status = 'dead' and disposed_at < now() - interval '90 days');
      get diagnostics v_n = row_count;
    when 'screening_runs' then     -- detailed signals 30 d, then aggregate-only
      update public.screening_runs set signals = '{"aggregated": true}'::jsonb
       where created_at < now() - interval '30 days' and signals is distinct from '{"aggregated": true}'::jsonb;
      get diagnostics v_n = row_count;
    when 'deletion_evidence' then  -- object paths 90 d after verification
      update public.media_deletion_objects set storage_path = null
       where storage_path is not null and verified_at < now() - interval '90 days';
      get diagnostics v_n = row_count;
    when 'device_rejections' then  -- 30 d (G-12)
      delete from public.device_rejections where rejected_at < now() - interval '30 days';
      get diagnostics v_n = row_count;
    when 'media_tickets' then      -- 1 d (G-04)
      delete from public.media_tickets where created_at < now() - interval '1 day';
      get diagnostics v_n = row_count;
    when 'map_drafts' then         -- rejected map drafts: objects deleted by delete_map_draft after 7 d (§9.4.1)
      for v_row in
        select v.id, v.school_id
          from public.map_versions v
         where v.approval_status = 'rejected'
           and (v.draft_storage_path is not null or v.draft_canonical_path is not null)
           and coalesce(v.submitted_at, v.created_at) < now() - interval '7 days'
      loop
        if private.enqueue('delete_map_draft', jsonb_build_object('mapVersionId', v_row.id), v_row.school_id,
                           'delete_map_draft:' || v_row.id::text, now(), 200::smallint) is not null then
          v_n := v_n + 1;
        end if;
      end loop;
  end case;
  return jsonb_build_object('count', v_n, 'kind', p_kind);
end $$;

-- §6.1 draft: purged after the upload-capability window (3 h). The worker deletes the incoming objects first.
create or replace function public.system_drafts_to_purge() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('itemId', d.id, 'schoolId', d.school_id, 'incomingPaths', d.paths)
                            order by d.created_at, d.id), '[]'::jsonb)
    into v_items
    from (select i.id, i.school_id, i.created_at,
                 coalesce((select jsonb_agg(p.incoming_path order by p.position, p.generation)
                             from public.item_photos p
                            where p.item_id = i.id and p.school_id = i.school_id
                              and private.sys_key_ok(p.incoming_path,
                                    p.school_id::text || '/' || p.item_id::text || '/' || p.id::text || '/')),
                          '[]'::jsonb) as paths
            from public.items i
           where i.review_status = 'draft' and i.created_at < now() - interval '3 hours'
           order by i.created_at, i.id
           limit 200) as d;
  return jsonb_build_object('items', v_items);
end $$;

create or replace function public.system_purge_draft(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  set local lock_timeout = '3s';
  delete from public.items
   where id = p_item_id and review_status = 'draft' and created_at < now() - interval '3 hours';
  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted', v_n > 0);
end $$;

-- =====================================================================================================
-- matching (§12.2; G-22)
-- =====================================================================================================

-- Candidate pairs for the scorer in packages/shared/src/matcher.ts: open reports at the item's school created
-- within lost_report_ttl_days, category compatible (same, or null on the report), lexically prefiltered by an
-- English OR tsquery or word_similarity > 0.3 on search_norm. lex = max(ts_rank_cd normalized to [0,1), trigram).
create or replace function public.system_match_candidates_for_item(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.items;
  v_ttl int := coalesce((private.district()).lost_report_ttl_days, 60);
  v_q tsquery;
  v_norm text;
  v_pairs jsonb;
begin
  select i.* into v_item from public.items i
   where i.id = p_item_id and exists (select 1 from public.visible_items vi where vi.id = i.id);
  if not found then
    return jsonb_build_object('pairs', '[]'::jsonb);
  end if;
  v_q := private.sys_or_query(v_item.description);
  v_norm := private.search_norm(v_item.description);

  select coalesce(jsonb_agg(c.pair order by c.lex desc, c.report_id), '[]'::jsonb)
    into v_pairs
    from (
      select r.id as report_id, x.lex,
             jsonb_build_object(
               'reportId', r.id, 'itemId', v_item.id, 'lex', round(x.lex::numeric, 4),
               'sameCategory', r.category is not distinct from v_item.category,
               'reportCategoryNull', r.category is null,
               'foundAt', v_item.found_at, 'lostOn', r.lost_on,
               'sameMapVersion', x.same_map,
               'dx', case when x.same_map then r.pin_x - v_item.pin_x end,
               'dy', case when x.same_map then r.pin_y - v_item.pin_y end,
               'mapWidth', case when x.same_map then mv.width_px end,
               'mapHeight', case when x.same_map then mv.height_px end) as pair
        from public.lost_reports r
        cross join lateral (
          select greatest(case when v_q is null then 0 else ts_rank_cd(r.search_tsv, v_q, 32) end,
                          extensions.word_similarity(v_norm, private.search_norm(r.description)),
                          extensions.word_similarity(private.search_norm(r.description), v_norm))::double precision as lex,
                 (r.map_version_id is not null and r.map_version_id = v_item.map_version_id
                  and r.pin_x is not null and v_item.pin_x is not null) as same_map,
                 (v_q is not null and r.search_tsv @@ v_q) as ts_hit,
                 greatest(extensions.word_similarity(v_norm, private.search_norm(r.description)),
                          extensions.word_similarity(private.search_norm(r.description), v_norm)) as wsim
        ) as x
        left join public.map_versions mv on mv.id = v_item.map_version_id
       where r.school_id = v_item.school_id and r.status = 'open'
         and r.created_at > now() - make_interval(days => v_ttl)
         and (r.category is null or r.category = v_item.category)
         and (x.ts_hit or x.wsim > 0.3)
       order by x.lex desc, r.id
       limit 50
    ) as c;
  return jsonb_build_object('pairs', v_pairs);
end $$;

create or replace function public.system_match_candidates_for_report(p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_report public.lost_reports;
  v_ttl int := coalesce((private.district()).lost_report_ttl_days, 60);
  v_q tsquery;
  v_norm text;
  v_pairs jsonb;
begin
  select * into v_report from public.lost_reports where id = p_report_id and status = 'open';
  if not found then
    return jsonb_build_object('pairs', '[]'::jsonb);
  end if;
  v_q := private.sys_or_query(v_report.description);
  v_norm := private.search_norm(v_report.description);

  select coalesce(jsonb_agg(c.pair order by c.lex desc, c.item_id), '[]'::jsonb)
    into v_pairs
    from (
      select i.id as item_id, x.lex,
             jsonb_build_object(
               'reportId', v_report.id, 'itemId', i.id, 'lex', round(x.lex::numeric, 4),
               'sameCategory', v_report.category is not distinct from i.category,
               'reportCategoryNull', v_report.category is null,
               'foundAt', i.found_at, 'lostOn', v_report.lost_on,
               'sameMapVersion', x.same_map,
               'dx', case when x.same_map then v_report.pin_x - i.pin_x end,
               'dy', case when x.same_map then v_report.pin_y - i.pin_y end,
               'mapWidth', case when x.same_map then mv.width_px end,
               'mapHeight', case when x.same_map then mv.height_px end) as pair
        from public.visible_items i
        cross join lateral (
          select greatest(case when v_q is null then 0 else ts_rank_cd(i.search_tsv, v_q, 32) end,
                          extensions.word_similarity(v_norm, private.search_norm(i.description)),
                          extensions.word_similarity(private.search_norm(i.description), v_norm))::double precision as lex,
                 (i.map_version_id is not null and i.map_version_id = v_report.map_version_id
                  and i.pin_x is not null and v_report.pin_x is not null) as same_map,
                 (v_q is not null and i.search_tsv @@ v_q) as ts_hit,
                 greatest(extensions.word_similarity(v_norm, private.search_norm(i.description)),
                          extensions.word_similarity(private.search_norm(i.description), v_norm)) as wsim
        ) as x
        left join public.map_versions mv on mv.id = v_report.map_version_id
       where i.school_id = v_report.school_id
         and i.created_at > v_report.created_at - make_interval(days => v_ttl)
         and (v_report.category is null or i.category = v_report.category)
         and (x.ts_hit or x.wsim > 0.3)
       order by x.lex desc, i.id
       limit 50
    ) as c;
  return jsonb_build_object('pairs', v_pairs);
end $$;

-- §12.2 step 5: upsert keeping the best score, at most 10 per report (lowest evicted), match_count and
-- last_matched_at in the same transaction, funnel counter matches_surfaced (F-63).
create or replace function public.system_record_match(
  p_report_id uuid, p_item_id uuid, p_score double precision, p_features jsonb, p_scorer_version text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_report public.lost_reports;
  v_item_school uuid;
  v_features jsonb := private.sys_scalar_json(p_features, true);
  v_inserted boolean;
  v_match_id uuid;
  v_kept boolean;
  v_count int;
begin
  set local lock_timeout = '3s';
  if p_score is null or not (p_score between 0 and 1) or p_score = 'NaN'::double precision then
    perform private.fail('invalid_input', 'score');
  end if;
  if p_scorer_version is null or p_scorer_version !~ '^[A-Za-z0-9._-]{1,20}$' then
    perform private.fail('invalid_input', 'scorer_version');
  end if;
  select * into v_report from public.lost_reports where id = p_report_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  select i.school_id into v_item_school from public.items i where i.id = p_item_id;
  if v_item_school is null then
    perform private.fail('not_found');
  end if;
  if v_item_school <> v_report.school_id then
    perform private.fail('tenant_mismatch');
  end if;
  if v_report.status <> 'open' or not exists (select 1 from public.visible_items vi where vi.id = p_item_id) then
    return jsonb_build_object('recorded', false, 'matchCount', v_report.match_count);
  end if;

  insert into public.lost_report_matches as m (school_id, lost_report_id, item_id, score, features, scorer_version)
  values (v_report.school_id, v_report.id, p_item_id, p_score, v_features, p_scorer_version)
  on conflict (lost_report_id, item_id) do update
    set score = greatest(m.score, excluded.score),
        features = case when excluded.score > m.score then excluded.features else m.features end,
        scorer_version = case when excluded.score > m.score then excluded.scorer_version else m.scorer_version end
  returning m.id, (m.xmax = 0) into v_match_id, v_inserted;

  delete from public.lost_report_matches
   where id in (select m.id from public.lost_report_matches m
                 where m.lost_report_id = v_report.id
                 order by m.score desc, m.matched_at, m.id
                offset 10);
  v_kept := exists (select 1 from public.lost_report_matches m where m.id = v_match_id);
  select count(*) into v_count from public.lost_report_matches m where m.lost_report_id = v_report.id;

  update public.lost_reports
     set match_count = v_count,
         last_matched_at = case when v_inserted and v_kept then now() else last_matched_at end
   where id = v_report.id and (match_count <> v_count or (v_inserted and v_kept));
  if v_inserted and v_kept then
    perform private.sys_bump_stat(v_report.school_id, 'matches_surfaced', 1);
  end if;
  return jsonb_build_object('recorded', v_kept, 'inserted', v_inserted and v_kept, 'matchCount', v_count);
end $$;

-- =====================================================================================================
-- maps (§9.4.1; G-07)
-- =====================================================================================================

create or replace function public.system_map_get(p_map_version_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_map public.map_versions;
begin
  select * into v_map from public.map_versions where id = p_map_version_id;
  if not found then
    perform private.fail('not_found');
  end if;
  return jsonb_build_object('mapVersionId', v_map.id, 'schoolId', v_map.school_id,
    'approvalStatus', v_map.approval_status, 'active', v_map.active,
    'draftPath', v_map.draft_storage_path, 'draftCanonicalPath', v_map.draft_canonical_path,
    'publicPath', v_map.public_storage_path, 'width', v_map.width_px, 'height', v_map.height_px);
end $$;

-- canonicalize_map result: drafts only (dimensions become known here, G-07).
create or replace function public.system_map_canonical_ready(
  p_map_version_id uuid, p_canonical_path text, p_width int, p_height int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_map public.map_versions;
begin
  set local lock_timeout = '3s';
  select * into v_map from public.map_versions where id = p_map_version_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if not private.sys_key_ok(p_canonical_path, v_map.school_id::text || '/' || v_map.id::text || '/') then
    perform private.fail('invalid_input', 'path');
  end if;
  if p_width is null or p_height is null or p_width not between 1 and 10000 or p_height not between 1 and 10000 then
    perform private.fail('invalid_input', 'dimensions');
  end if;
  if v_map.approval_status <> 'draft' then
    if v_map.draft_canonical_path = p_canonical_path and v_map.width_px = p_width and v_map.height_px = p_height then
      return jsonb_build_object('ok', true, 'replay', true);
    end if;
    perform private.fail('state_changed', 'map_not_draft');
  end if;
  update public.map_versions
     set draft_canonical_path = p_canonical_path, width_px = p_width, height_px = p_height
   where id = v_map.id;
  return jsonb_build_object('ok', true);
end $$;

-- G-07 worker-brokered activation. The ticket is a map.activate ticket redeemed (system_media_ticket_redeem)
-- within the last 2 minutes; every active location of the school must be pinned on the version, which needs at
-- least one zone. The previous active version is retired and keeps its public path.
create or replace function public.system_map_activate(p_ticket_id uuid, p_public_path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ticket public.media_tickets;
  v_map public.map_versions;
  v_prefix text;
  v_prev uuid;
begin
  set local lock_timeout = '3s';
  select * into v_ticket from public.media_tickets where id = p_ticket_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_ticket.operation <> 'map.activate' or v_ticket.used_at is null or v_ticket.used_at < now() - interval '2 minutes' then
    perform private.fail('forbidden', 'ticket');
  end if;
  select * into v_map from public.map_versions
   where id = v_ticket.map_version_id and school_id = v_ticket.school_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_map.approval_status = 'approved' and v_map.active and v_map.public_storage_path = p_public_path then
    return jsonb_build_object('mapVersionId', v_map.id, 'active', true, 'replay', true);
  end if;
  if v_map.approval_status <> 'pending_district' then
    perform private.fail('state_changed', 'map_not_pending');
  end if;
  v_prefix := v_map.school_id::text || '/' || v_map.id::text || '/';
  if not private.sys_key_ok(p_public_path, v_prefix)
     or substr(p_public_path, char_length(v_prefix) + 1) !~ '^[0-9a-f]{32}\.jpg$' then
    perform private.fail('invalid_input', 'path');
  end if;
  if exists (select 1 from public.locations l
              where l.school_id = v_map.school_id and l.active
                and not exists (select 1 from public.location_map_pins mp
                                 where mp.location_id = l.id and mp.map_version_id = v_map.id)) then
    perform private.fail('invalid_input', 'location_pins');
  end if;
  if not exists (select 1 from public.map_zones z where z.map_version_id = v_map.id and z.active) then
    perform private.fail('invalid_input', 'zones');
  end if;

  select v.id into v_prev from public.map_versions v
   where v.school_id = v_map.school_id and v.active and v.id <> v_map.id
     for update;
  if v_prev is not null then
    update public.map_versions set active = false, approval_status = 'retired', retired_at = now() where id = v_prev;
  end if;
  update public.map_versions
     set approval_status = 'approved', approved_by = v_ticket.staff_member_id, approved_at = now(),
         public_storage_path = p_public_path, active = true
   where id = v_map.id;
  perform private.enqueue('delete_map_draft', jsonb_build_object('mapVersionId', v_map.id), v_map.school_id,
    'delete_map_draft:' || v_map.id::text, now(), 100::smallint);
  perform private.invalidate(v_map.school_id);
  perform private.audit(v_map.school_id, 'staff', v_ticket.staff_member_id::text, null, 'map.activate', 'map_versions',
    v_map.id::text, jsonb_build_object('approvalStatus', 'pending_district'),
    jsonb_build_object('approvalStatus', 'approved', 'active', true),
    jsonb_build_object('mapVersionId', v_map.id, 'retiredVersionId', v_prev));
  return jsonb_build_object('mapVersionId', v_map.id, 'active', true, 'retiredVersionId', v_prev);
end $$;

-- delete_map_draft result: the private draft objects are gone, so their keys are cleared (§9.4.1).
create or replace function public.system_map_draft_deleted(p_map_version_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_map public.map_versions;
begin
  set local lock_timeout = '3s';
  select * into v_map from public.map_versions where id = p_map_version_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_map.approval_status in ('draft', 'pending_district') then
    perform private.fail('state_changed', 'map_in_review');
  end if;
  update public.map_versions set draft_storage_path = null, draft_canonical_path = null
   where id = v_map.id and (draft_storage_path is not null or draft_canonical_path is not null);
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================================================
-- health (G-29, §17)
-- =====================================================================================================

create or replace function public.system_record_error(p_signature text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  set local lock_timeout = '3s';
  if p_signature is null or char_length(p_signature) not between 1 and 120 or p_signature !~ '^[[:print:]]+$' then
    perform private.fail('invalid_input', 'signature');
  end if;
  insert into public.error_rollup as e (day, signature, count)
  values ((now() at time zone 'UTC')::date, p_signature, 1)
  on conflict (day, signature) do update set count = e.count + 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.system_health_record(p_detail jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_detail jsonb := private.sys_scalar_json(p_detail, false);
  v_ok boolean;
  v_latency int;
begin
  set local lock_timeout = '3s';
  v_ok := case when jsonb_typeof(p_detail->'ok') = 'boolean' then (p_detail->>'ok')::boolean
               else not exists (select 1 from jsonb_each(v_detail) as e where e.value = 'false'::jsonb) end;
  if jsonb_typeof(p_detail->'latencyMs') = 'number' then
    v_latency := greatest(0, least((p_detail->>'latencyMs')::numeric, 2147483647))::int;
  end if;
  insert into public.health_checks (checked_at, ok, latency_ms, detail)
  values (clock_timestamp(), v_ok, v_latency, v_detail || '{"source": "worker"}'::jsonb)
  on conflict (checked_at) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================================================
-- ownership and grants: owner recover_system_owner; EXECUTE to recover_worker only (§7.5, F-114, F-115)
-- =====================================================================================================
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'system\_%'
  loop
    execute format('alter function %s owner to recover_system_owner', f.sig);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    execute format('grant execute on function %s to recover_worker', f.sig);
  end loop;
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'private'::regnamespace and p.proname like 'sys\_%'
  loop
    execute format('alter function %s owner to recover_system_owner', f.sig);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
