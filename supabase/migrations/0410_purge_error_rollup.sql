-- 0410 error_rollup retention (security review L1; G-29, 14 retention table). error_rollup counts rows written by
-- the unauthenticated /api/client-error beacon (0210 rate-limits it), so it is no longer kept indefinitely: rows are
-- purged 90 days after their UTC day by the nightly purge job. Re-creates private.sys_purge_kinds and
-- public.system_purge from 0400 with the new kind; 0450 enqueues one purge job per kind from the same list.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Kinds accepted by system_purge; 0450 enqueues one nightly purge job per kind from this same list.
create or replace function private.sys_purge_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['devices', 'device_links', 'closed_reports', 'report_matches', 'idempotency_keys', 'search_events',
               'health_checks', 'rate_counters', 'jobs', 'screening_runs', 'deletion_evidence', 'device_rejections',
               'media_tickets', 'map_drafts', 'error_rollup']::text[]
$$;

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
    when 'error_rollup' then       -- 90 d: day-level signature counts (G-29); the unauthenticated beacon writes here
      delete from public.error_rollup where day < (now() at time zone 'UTC')::date - 90;
      get diagnostics v_n = row_count;
  end case;
  return jsonb_build_object('count', v_n, 'kind', p_kind);
end $$;

-- The purge deletes error_rollup rows; the system family only had SELECT, INSERT, UPDATE (0098).
grant delete on public.error_rollup to recover_system_owner;

-- Same ownership and grants as 0400 (create or replace keeps them; restated so this file stands alone).
alter function private.sys_purge_kinds() owner to recover_system_owner;
revoke all on function private.sys_purge_kinds() from public, anon, authenticated, service_role;
alter function public.system_purge(text) owner to recover_system_owner;
revoke all on function public.system_purge(text) from public, anon, authenticated, service_role;
grant execute on function public.system_purge(text) to recover_worker;
