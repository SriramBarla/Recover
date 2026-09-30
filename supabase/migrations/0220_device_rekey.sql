-- 0220 device-key rotation window (13-Abuse-and-Rate-Limiting.md implementation guide "Device cookie issuance";
-- §6.4; F-28; RUNBOOK.md section 21). A digest is version_byte || HMAC(DEVICE_KEY_V<version>, school id || token).
-- While the web has DEVICE_KEY_PREVIOUS set, it derives each browser's digest with both keys and, before the first
-- device-bound call of a request, asks api_device_rekey to move that browser's rows at the school from the
-- previous-key digest to the current-key digest. Every other function keeps matching one digest by equality, rows
-- are written with the current key, and outside a window nothing here is called.
-- The move covers every place a device digest is stored:
--   items.device_token_hash (the G-03 device link), lost_reports.device_token_hash (any status: a closed report
--   keeps its link for 30 days and staff can block through it), devices (merged into an existing current-key row),
--   device_rejections (G-12 reputation), rate_counters with subject_kind 'device' (counts of one window add up), and
--   idempotency_keys with principal_kind 'device' (a current-key row with the same key wins).
-- Items and lost reports are updated in place, so their triggers run: a moved row gets a new row_version and
-- updated_at. devices, rate_counters and idempotency_keys rows are moved as delete + upsert, which cannot race a
-- concurrent insert of the current-key row; the api family therefore gains DELETE on those three tables. UPDATE,
-- which it already holds there, can already clear a block, zero a counter or rewrite a key, so DELETE adds no new
-- effect. It also gains UPDATE of device_rejections.device_token_hash only.
-- Neither digest is logged, audited, or returned; the result is counts only.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- The move finds a browser's lost reports in any status; reports_device (0009) covers open reports only.
create index if not exists reports_device_link on public.lost_reports (school_id, device_token_hash)
  where device_token_hash is not null;

grant delete on public.devices, public.rate_counters, public.idempotency_keys to recover_api_owner;
grant update (device_token_hash) on public.device_rejections to recover_api_owner;

-- Idempotent: a second call finds nothing under the old digest and returns zero counts. The version bytes must
-- differ, so this only ever moves rows between two key versions; that the new digest uses the current version
-- is the web's check (it holds the keys). Lock order is items, lost_reports, device_rejections, devices, the
-- order of the staff reject path (items, device_rejections, then devices through private.maybe_auto_block).
create or replace function public.api_device_rekey(p_school_code text, p_old_digest bytea, p_new_digest bytea)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.schools;
  v_scope text;
  v_items int;
  v_reports int;
  v_rejections int;
  v_devices int;
  v_counters int;
  v_keys int;
begin
  set local lock_timeout = '3s';
  s := private.school_by_code(p_school_code);
  perform private.student_check_digest(p_old_digest);
  perform private.student_check_digest(p_new_digest);
  if get_byte(p_old_digest, 0) = get_byte(p_new_digest, 0) then
    perform private.fail('invalid_input', 'device_digest');
  end if;
  v_scope := 'school:' || s.id::text;

  update public.items i set device_token_hash = p_new_digest
   where i.school_id = s.id and i.device_token_hash = p_old_digest;
  get diagnostics v_items = row_count;

  update public.lost_reports r set device_token_hash = p_new_digest
   where r.school_id = s.id and r.device_token_hash = p_old_digest;
  get diagnostics v_reports = row_count;

  update public.device_rejections d set device_token_hash = p_new_digest
   where d.school_id = s.id and d.device_token_hash = p_old_digest;
  get diagnostics v_rejections = row_count;

  -- One devices row per browser and school: the older first_seen_at, the later last_seen_at, and the stricter
  -- block, which is the one that runs later, with its reason and staff member.
  with moved as (
    delete from public.devices d
     where d.school_id = s.id and d.token_hash = p_old_digest
    returning d.first_seen_at, d.last_seen_at, d.blocked_until, d.block_reason, d.blocked_by
  ), merged as (
    insert into public.devices as d (school_id, token_hash, first_seen_at, last_seen_at, blocked_until, block_reason,
                                     blocked_by)
    select s.id, p_new_digest, m.first_seen_at, m.last_seen_at, m.blocked_until, m.block_reason, m.blocked_by
      from moved m
    on conflict (school_id, token_hash) do update
       set first_seen_at = least(d.first_seen_at, excluded.first_seen_at),
           last_seen_at  = greatest(d.last_seen_at, excluded.last_seen_at),
           blocked_until = case when excluded.blocked_until > coalesce(d.blocked_until, '-infinity')
                                then excluded.blocked_until else d.blocked_until end,
           block_reason  = case when excluded.blocked_until > coalesce(d.blocked_until, '-infinity')
                                then excluded.block_reason else d.block_reason end,
           blocked_by    = case when excluded.blocked_until > coalesce(d.blocked_until, '-infinity')
                                then excluded.blocked_by else d.blocked_by end
    returning 1
  )
  select count(*) into v_devices from moved;

  -- §13.2 budgets carry over: a window the browser already used under both digests counts both.
  with moved as (
    delete from public.rate_counters c
     where c.tenant_scope = v_scope and c.subject_kind = 'device' and c.subject_hmac = p_old_digest
    returning c.action, c.window_start, c.count
  ), merged as (
    insert into public.rate_counters as c (tenant_scope, action, subject_kind, subject_hmac, window_start, count)
    select v_scope, m.action, 'device', p_new_digest, m.window_start, m.count
      from moved m
    on conflict (tenant_scope, action, subject_kind, subject_hmac, window_start)
    do update set count = c.count + excluded.count
    returning 1
  )
  select count(*) into v_counters from moved;

  -- F-77: a retry that crosses the move still replays. A key the browser already used under the current digest
  -- keeps that row.
  with moved as (
    delete from public.idempotency_keys k
     where k.tenant_scope = v_scope and k.principal_kind = 'device' and k.principal_hmac = p_old_digest
    returning k.operation, k.key_hash, k.request_hash, k.response_code, k.response_body, k.created_at, k.expires_at
  ), merged as (
    insert into public.idempotency_keys (tenant_scope, principal_kind, operation, principal_hmac, key_hash,
                                         request_hash, response_code, response_body, created_at, expires_at)
    select v_scope, 'device', m.operation, p_new_digest, m.key_hash, m.request_hash, m.response_code,
           m.response_body, m.created_at, m.expires_at
      from moved m
    on conflict (tenant_scope, principal_kind, operation, principal_hmac, key_hash) do nothing
    returning 1
  )
  select count(*) into v_keys from moved;

  return jsonb_build_object('items', v_items, 'lostReports', v_reports, 'deviceRejections', v_rejections,
                            'devices', v_devices, 'rateCounters', v_counters, 'idempotencyKeys', v_keys);
end $$;
alter function public.api_device_rekey(text, bytea, bytea) owner to recover_api_owner;
revoke all on function public.api_device_rekey(text, bytea, bytea) from public;
grant execute on function public.api_device_rekey(text, bytea, bytea) to recover_web;
