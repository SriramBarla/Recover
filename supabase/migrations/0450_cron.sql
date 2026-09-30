-- 0450 pg_cron schedules (§8.3 cron catalog with the G-13 additions; F-62; BUILD-CONTRACT sections 6.4 and 7).
-- pg_cron runs each command as the role that scheduled it (the migration role). Commands only call the private
-- functions below: no URL, bearer, or other secret is ever part of a cron command (F-62). The scheduler bearer and
-- the worker URL are read from Vault at call time. Local development has neither secret, so the drain is a no-op
-- and scripts/dev.mjs drives the worker instead.
-- Restore quarantine (G-06): the runbook's first step disables every job named recover_% with cron.alter_job.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Periodic outbox rows. Dedupe keys follow the job catalog (section 7): purge:<kind>:<day>,
-- rollup_daily_stats:<day>, and <kind>:<yyyy-mm-ddThh:mi> (UTC) for everything else, so a re-fired or
-- overlapping schedule inside the same minute enqueues nothing new.
create or replace function private.enqueue_periodic(p_kind text, p_payload jsonb default '{}'::jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_utc timestamp := now() at time zone 'UTC';
  v_key text;
begin
  if p_kind is null or p_kind !~ '^[a-z_]{3,40}$' then
    raise exception 'enqueue_periodic: invalid kind';
  end if;
  v_key := case p_kind
             when 'purge' then 'purge:' || coalesce(v_payload->>'kind', '') || ':' || to_char(v_utc, 'YYYY-MM-DD')
             when 'rollup_daily_stats' then 'rollup_daily_stats:' || coalesce(v_payload->>'day', to_char(v_utc, 'YYYY-MM-DD'))
             else p_kind || ':' || to_char(v_utc, 'YYYY-MM-DD"T"HH24:MI')
           end;
  return private.enqueue(p_kind, v_payload, null, v_key, now(),
                         case when p_kind = 'purge' then 200 else 100 end::smallint);
end $$;

-- One purge job per retention kind (the list lives in private.sys_purge_kinds, 0400).
create or replace function private.enqueue_purges() returns int
language plpgsql set search_path = '' as $$
declare
  v_kind text;
  v_n int := 0;
begin
  foreach v_kind in array private.sys_purge_kinds() loop
    if private.enqueue_periodic('purge', jsonb_build_object('kind', v_kind)) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- Every minute: ask the worker to drain the queue (§8.3). Secrets are read from Vault at call time (F-62). The
-- call is synchronous (http extension), so the bearer is never written to a table; pg_net's request queue
-- was readable by the login roles (0001). The worker keeps draining after the 5 s client timeout, so that
-- timeout is the normal outcome. Any other failure fails the cron run, and cron.job_run_details shows the
-- HTTP status or the connection error (RUNBOOK 20).
create or replace function private.cron_drain() returns bigint
language plpgsql set search_path = '' as $$
declare
  v_url text;
  v_bearer text;
  v_status bigint;
begin
  select nullif(btrim(s.decrypted_secret), '') into v_url from vault.decrypted_secrets s where s.name = 'worker_url';
  select nullif(btrim(s.decrypted_secret), '') into v_bearer from vault.decrypted_secrets s where s.name = 'scheduler_bearer';
  if v_url is null or v_bearer is null then
    return null;  -- not configured (local development): scripts/dev.mjs drives the worker
  end if;
  perform set_config('http.timeout_msec', '5000', true);
  begin
    select r.status into v_status
      from extensions.http(row('POST', rtrim(v_url, '/') || '/api/jobs/run',
                               array[extensions.http_header('authorization', 'Bearer ' || v_bearer)],
                               'application/json', '{}')::extensions.http_request) as r;
  exception when others then
    if sqlerrm like 'Operation timed out after %' then
      return null;  -- connected, and the worker is still draining
    end if;
    raise exception 'cron_drain: worker unreachable: %', sqlerrm;
  end;
  if v_status not between 200 and 299 then
    raise exception 'cron_drain: worker returned HTTP %', v_status;
  end if;
  return v_status;
end $$;

-- Every 5 minutes: a health_checks row computed in SQL (§17 health model), then the §17 alert evaluation.
-- ok means the worker is alive (heartbeat under 10 min) and no eligible job has waited 10 min or more.
create or replace function private.cron_health() returns void
language plpgsql set search_path = '' as $$
declare
  v_started timestamptz := clock_timestamp();
  v_detail jsonb := private.sys_health_snapshot();
  v_ok boolean;
begin
  v_ok := (v_detail->>'workerHeartbeatAgeS') is not null
          and (v_detail->>'workerHeartbeatAgeS')::bigint < 600
          and coalesce((v_detail->>'oldestJobS')::bigint, 0) < 600;
  insert into public.health_checks (checked_at, ok, latency_ms, detail)
  values (clock_timestamp(), v_ok, (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
          v_detail || '{"source": "cron"}'::jsonb)
  on conflict (checked_at) do nothing;
  perform public.system_evaluate_alerts();
end $$;

revoke all on function private.enqueue_periodic(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.enqueue_purges() from public, anon, authenticated, service_role;
revoke all on function private.cron_drain() from public, anon, authenticated, service_role;
revoke all on function private.cron_health() from public, anon, authenticated, service_role;

-- Idempotent scheduling: every job named recover_% is unscheduled, then the catalog below is scheduled again.
do $$
declare
  v_job record;
  v_entry record;
begin
  for v_job in select j.jobid from cron.job j where j.jobname like 'recover\_%' loop
    perform cron.unschedule(v_job.jobid);
  end loop;
  for v_entry in
    select * from (values
      -- every minute: worker drain (reap_leases runs first inside the drain)
      ('recover_drain', '* * * * *', 'select private.cron_drain()'),
      -- every 5 minutes: health row + alerts (includes the calendar-coverage horizon, G-13)
      ('recover_health', '*/5 * * * *', 'select private.cron_health()'),
      -- every 15 minutes
      ('recover_expire_never_arrived', '*/15 * * * *', 'select private.enqueue_periodic(''expire_never_arrived'')'),
      ('recover_expire_reports', '*/15 * * * *', 'select private.enqueue_periodic(''expire_reports'')'),
      ('recover_reconcile_generating', '*/15 * * * *', 'select private.enqueue_periodic(''reconcile_generating'')'),
      -- hourly
      ('recover_mark_disposition_due', '0 * * * *', 'select private.enqueue_periodic(''mark_disposition_due'')'),
      ('recover_purge_drafts', '0 * * * *', 'select private.enqueue_periodic(''purge_drafts'')'),
      ('recover_reconcile_orphan_uploads', '0 * * * *', 'select private.enqueue_periodic(''reconcile_orphan_uploads'')'),
      -- nightly at 07:15 UTC (after midnight in every US time zone)
      ('recover_rollup_daily_stats', '15 7 * * *',
       'select private.enqueue_periodic(''rollup_daily_stats'', jsonb_build_object(''day'', ((now() at time zone ''UTC'')::date - 1)::text))'),
      ('recover_anonymize_rejected', '15 7 * * *', 'select private.enqueue_periodic(''anonymize_rejected'')'),
      ('recover_clear_terminal_item_text', '15 7 * * *', 'select private.enqueue_periodic(''clear_terminal_item_text'')'),
      ('recover_purges', '15 7 * * *', 'select private.enqueue_purges()')
    ) as t(name, schedule, command)
  loop
    perform cron.schedule(v_entry.name, v_entry.schedule, v_entry.command);
  end loop;
end $$;
