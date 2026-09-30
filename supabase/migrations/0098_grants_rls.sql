-- 0098 table privileges for the NOLOGIN function owners and owner-role RLS (§7.5, F-114, F-115).
-- Login roles (recover_web, recover_worker) get NO table privileges; they only EXECUTE functions,
-- which each function file grants explicitly. The system family never touches staff identity tables.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------- recover_api_owner (api_* family) ----------
grant select, update on public.schools, public.district_settings to recover_api_owner;
grant insert on public.schools to recover_api_owner;
grant select, insert, update on public.staff_users, public.staff_members to recover_api_owner;
grant select, insert, update on public.map_versions, public.locations to recover_api_owner;
grant select, insert, update, delete on public.location_map_pins, public.map_zones, public.school_calendar_days to recover_api_owner;
grant select, insert, update on public.devices to recover_api_owner;
grant select, insert on public.device_rejections to recover_api_owner;
grant select, insert, update on public.items, public.item_photos to recover_api_owner;
grant select on public.screening_runs to recover_api_owner;
grant select, insert, update on public.lost_reports to recover_api_owner;
grant select, update on public.lost_report_matches to recover_api_owner;
grant select, insert on public.audit_log to recover_api_owner;
grant select, insert, update on public.jobs to recover_api_owner;
grant select, insert, delete on public.media_deletion_ledger, public.media_deletion_objects to recover_api_owner;
grant select, insert, update on public.idempotency_keys, public.rate_counters to recover_api_owner;
grant select, insert, update on public.search_events to recover_api_owner;
grant select on public.health_checks, public.worker_heartbeats, public.synonyms to recover_api_owner;
grant select, insert, update on public.error_rollup, public.daily_school_stats to recover_api_owner;
grant select, insert on public.media_tickets to recover_api_owner;
grant select on public.visible_items, public.public_items, public.public_item_photos to recover_api_owner;

-- ---------- recover_system_owner (system_* family) ----------
grant select on public.schools, public.district_settings, public.locations, public.location_map_pins,
                public.map_zones, public.school_calendar_days to recover_system_owner;
grant select, update on public.map_versions to recover_system_owner;
grant select, update, delete on public.items to recover_system_owner;
grant select, update, delete on public.item_photos to recover_system_owner;
grant select, insert, update, delete on public.screening_runs to recover_system_owner;
grant select, update, delete on public.lost_reports to recover_system_owner;
grant select, insert, update, delete on public.lost_report_matches to recover_system_owner;
grant select, insert, update, delete on public.devices to recover_system_owner;
grant select, delete on public.device_rejections to recover_system_owner;
grant insert on public.audit_log to recover_system_owner;
grant select, insert, update, delete on public.jobs to recover_system_owner;
grant select, insert, update, delete on public.media_deletion_ledger, public.media_deletion_objects to recover_system_owner;
grant select, delete on public.idempotency_keys to recover_system_owner;
grant select, insert, update, delete on public.rate_counters to recover_system_owner;
grant select, update, delete on public.search_events to recover_system_owner;
grant select, insert, delete on public.health_checks to recover_system_owner;
grant select, insert, update on public.error_rollup, public.daily_school_stats, public.worker_heartbeats to recover_system_owner;
grant select, update, delete on public.media_tickets to recover_system_owner;
grant select, insert, update, delete on public.synonyms to recover_system_owner;
grant select on public.visible_items, public.public_items, public.public_item_photos to recover_system_owner;

-- identity sequences (belt and braces; identity columns do not normally need it)
grant usage on all sequences in schema public to recover_api_owner, recover_system_owner;

-- ---------- private helpers ----------
revoke all on all functions in schema private from public;
grant execute on all functions in schema private to recover_api_owner, recover_system_owner;
revoke execute on function private.verify_staff_mac(text, int, text) from recover_system_owner;
grant execute on function private.b64url_encode(bytea), private.b64url_decode(text) to recover_attestation_owner;

-- ---------- attestation owner: Vault read for the verifier only ----------
grant usage on schema vault to recover_attestation_owner;
grant select on vault.decrypted_secrets to recover_attestation_owner;
do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'vault' and p.proname like '%decrypt%'
  loop
    execute format('grant execute on function %s to recover_attestation_owner', f.sig);
  end loop;
end $$;

-- ---------- RLS: enabled everywhere; policies only for the owner roles that hold grants ----------
do $$
declare
  t text;
begin
  foreach t in array array[
    'schools', 'district_settings', 'staff_users', 'staff_members', 'map_versions', 'locations',
    'location_map_pins', 'map_zones', 'school_calendar_days', 'devices', 'device_rejections', 'items',
    'item_photos', 'screening_runs', 'lost_reports', 'lost_report_matches', 'audit_log', 'jobs',
    'media_deletion_ledger', 'media_deletion_objects', 'idempotency_keys', 'rate_counters', 'search_events',
    'health_checks', 'error_rollup', 'daily_school_stats', 'media_tickets', 'synonyms', 'worker_heartbeats'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to recover_api_owner using (true) with check (true)',
                   t || '_api_owner', t);
    if t not in ('staff_users', 'staff_members') then
      execute format('create policy %I on public.%I for all to recover_system_owner using (true) with check (true)',
                     t || '_system_owner', t);
    end if;
  end loop;
end $$;
