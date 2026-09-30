-- 0009 internal projections (§7.2) and indexes (§7.3) with G-22 and G-36 fixes.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Visibility is defined exactly once (§6.1). No browser role has grants on these views (F-86).
create view public.visible_items with (security_invoker = true) as
  select i.*
    from public.items i
   where i.review_status = 'approved'
     and i.publication_status = 'published'
     and i.custody in ('with_finder', 'at_location')
     and i.deleted_at is null;

create view public.public_items with (security_invoker = true) as
  select i.id, i.school_id, i.public_id, i.category, i.description,
         z.name as zone_name,
         i.custody, i.found_at, i.received_at,
         coalesce(i.current_location_id, i.dropoff_location_id) as location_id,
         i.created_at, i.row_version
    from public.visible_items i
    left join public.map_zones z
      on z.id = i.zone_id and z.map_version_id = i.map_version_id and z.school_id = i.school_id;
-- Exact finder pin, map version, private note, device, screening and staff fields are deliberately absent.

create view public.public_item_photos with (security_invoker = true) as
  select p.id, p.item_id, p.school_id, p.position, p.generation,
         p.thumb_path, p.medium_path, p.width, p.height
    from public.item_photos p
    join public.visible_items i on i.id = p.item_id and i.school_id = p.school_id
   where p.is_current
     and p.status = 'public_ready'
     and p.thumb_path is not null
     and p.medium_path is not null;

-- items
create index items_feed on public.items (school_id, created_at desc, id desc)
  where review_status = 'approved' and publication_status = 'published'
    and deleted_at is null and custody in ('with_finder', 'at_location');
create index items_queue on public.items (school_id, created_at, id)
  where review_status = 'pending' and deleted_at is null and custody in ('with_finder', 'at_location');
create index items_generating on public.items (updated_at)
  where review_status = 'approved' and publication_status = 'generating';
create index items_expiry on public.items (expires_at, id) where custody = 'at_location';
create index items_never_arrived on public.items (arrival_deadline_at, id)            -- G-36
  where custody = 'with_finder' and review_status <> 'draft' and arrival_deadline_at is not null;
create index items_tsv on public.items using gin (search_tsv);
create index items_trgm on public.items using gin (private.search_norm(description) extensions.gin_trgm_ops);
create index items_device on public.items (school_id, device_token_hash, created_at desc)
  where device_token_hash is not null;
create index items_text_clear on public.items ((coalesce(terminal_at, deleted_at)))
  where text_cleared_at is null and description is not null and (terminal_at is not null or deleted_at is not null);
create index items_rejected_anon on public.items (reviewed_at)
  where review_status = 'rejected' and content_anonymized_at is null;
create index items_drafts on public.items (created_at) where review_status = 'draft';
create index items_school_custody on public.items (school_id, custody, updated_at desc) where deleted_at is null;

-- photos
create index photos_fingerprint on public.item_photos (school_id, content_fingerprint) where content_fingerprint is not null;
create index photos_slot_generation on public.item_photos (item_id, position, generation desc);
create index photos_status on public.item_photos (status, updated_at) where status in ('uploaded', 'canonicalizing', 'failed');

-- reports
create index reports_open on public.lost_reports (school_id, created_at desc) where status = 'open';
create index reports_device on public.lost_reports (school_id, device_token_hash, created_at desc) where status = 'open';
create index reports_terminal_purge on public.lost_reports (terminal_at) where status <> 'open' and description is not null;
create index reports_expiry on public.lost_reports (expires_at) where status = 'open';
create index reports_tsv on public.lost_reports using gin (search_tsv) where status = 'open';
create index reports_trgm on public.lost_reports using gin (private.search_norm(description) extensions.gin_trgm_ops) where status = 'open';
create index matches_report on public.lost_report_matches (lost_report_id, score desc);
create index matches_item on public.lost_report_matches (item_id);

-- jobs
create index jobs_ready on public.jobs (priority, run_after, id) where status = 'queued';
create index jobs_expired_leases on public.jobs (locked_until, id) where status = 'running';
create index jobs_finished on public.jobs (finished_at) where status in ('done', 'dead');
create index jobs_kind_status on public.jobs (kind, status);

-- misc
create index audit_school_time on public.audit_log (school_id, created_at desc);
create index audit_target on public.audit_log (target_table, target_id, created_at desc);
create index audit_action_time on public.audit_log (action, created_at desc);
create index search_events_purge on public.search_events (purge_after);
create index search_events_school_time on public.search_events (school_id, created_at);
create index device_rejections_window on public.device_rejections (school_id, device_token_hash, rejected_at desc);
create index device_rejections_purge on public.device_rejections (rejected_at);
create index media_tickets_expiry on public.media_tickets (expires_at);
create index rate_counters_window on public.rate_counters (window_start);
create index idempotency_expiry on public.idempotency_keys (expires_at);
create index ledger_unverified on public.media_deletion_ledger (requested_at) where verified_at is null;
create index ledger_item on public.media_deletion_ledger (item_id);
create index deletion_objects_verified on public.media_deletion_objects (verified_at) where storage_path is not null;
create index devices_last_seen on public.devices (last_seen_at);
create index staff_members_school on public.staff_members (school_id, status);
create index map_versions_school on public.map_versions (school_id, approval_status);
