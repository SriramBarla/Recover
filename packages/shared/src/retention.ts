// Retention rules: the single source of truth (14 Implementation guide "Retention job table", the §15.1
// inventory, and BUILD-CONTRACT.md section 3 additions G-04, G-12, G-29). One row per (table,
// threshold). `job` names a job kind from contract section 7; `purge:<kind>` is the `purge` job with
// that `system_purge` kind. `seconds` is the default threshold (null = kept indefinitely).
export type RetentionRule = {
  readonly table: string;
  readonly threshold: string;
  readonly seconds: number | null;
  readonly job: string;
  readonly action: string;
};

const HOUR = 3600;
const DAY = 86_400;

export const RETENTION: readonly RetentionRule[] = [
  { table: 'items', threshold: '3 h after draft creation', seconds: 3 * HOUR, job: 'purge_drafts', action: 'incoming objects, then the draft item and photo rows' },
  { table: 'item_photos', threshold: '3 h after upload', seconds: 3 * HOUR, job: 'reconcile_orphan_uploads', action: 'incoming objects with no live photo generation' },
  { table: 'item_photos', threshold: 'rejected_media_retention_days (default 7 d) after rejection', seconds: 7 * DAY, job: 'anonymize_rejected', action: 'original and variant objects via a delete_media ledger, then the path columns' },
  { table: 'items', threshold: 'rejected_media_retention_days (default 7 d) after rejection', seconds: 7 * DAY, job: 'anonymize_rejected', action: 'description, private note, pin, zone, src, device digest, content fingerprint' },
  { table: 'items', threshold: 'terminal_text_retention_days (default 30 d, max 30) after withdrawn_at', seconds: 30 * DAY, job: 'clear_terminal_item_text', action: 'description, private note, pin, zone, src (F-87, F-111)' },
  { table: 'items', threshold: '30 d after terminal custody', seconds: 30 * DAY, job: 'purge:device_links', action: 'device_token_hash cleared, device_link_cleared_at set (G-03)' },
  { table: 'lost_reports', threshold: '30 d after terminal_at', seconds: 30 * DAY, job: 'purge:closed_reports', action: 'description, pin, device digest' },
  { table: 'lost_report_matches', threshold: '90 d after the report terminal_at', seconds: 90 * DAY, job: 'purge:report_matches', action: 'rows (F-108)' },
  { table: 'devices', threshold: '90 d after last_seen_at', seconds: 90 * DAY, job: 'purge:devices', action: 'rows' },
  { table: 'device_rejections', threshold: '30 d after rejected_at', seconds: 30 * DAY, job: 'purge:device_rejections', action: 'rows (G-12)' },
  { table: 'map_versions', threshold: 'immediately after the approved public copy is verified', seconds: 0, job: 'delete_map_draft', action: 'draft objects, then draft_storage_path' },
  { table: 'map_versions', threshold: '7 d after rejection or abandonment', seconds: 7 * DAY, job: 'delete_map_draft', action: 'draft objects, then draft_storage_path' },
  { table: 'media_tickets', threshold: '1 d after issue', seconds: DAY, job: 'purge:media_tickets', action: 'rows (G-04)' },
  { table: 'idempotency_keys', threshold: '24 h', seconds: 24 * HOUR, job: 'purge:idempotency_keys', action: 'rows' },
  { table: 'rate_counters', threshold: '48 h after window_start', seconds: 48 * HOUR, job: 'purge:rate_counters', action: 'rows' },
  { table: 'search_events', threshold: '7 d', seconds: 7 * DAY, job: 'purge:search_events', action: 'redacted_query text' },
  { table: 'search_events', threshold: '90 d', seconds: 90 * DAY, job: 'purge:search_events', action: 'rows (query HMACs)' },
  { table: 'health_checks', threshold: '30 d', seconds: 30 * DAY, job: 'purge:health_checks', action: 'rows' },
  { table: 'jobs', threshold: '30 d after completion', seconds: 30 * DAY, job: 'purge:jobs', action: 'done rows' },
  { table: 'jobs', threshold: '90 d after operator disposition', seconds: 90 * DAY, job: 'purge:jobs', action: 'dead rows' },
  { table: 'screening_runs', threshold: '30 d', seconds: 30 * DAY, job: 'purge:screening_runs', action: 'signals reduced to aggregate counts' },
  { table: 'media_deletion_objects', threshold: '90 d after verification', seconds: 90 * DAY, job: 'purge:deletion_evidence', action: 'storage_path on object rows' },
  { table: 'audit_log', threshold: '2 y', seconds: 730 * DAY, job: 'manual retention migration', action: 'rows' },
  { table: 'error_rollup', threshold: 'indefinite (aggregate signatures and counts only)', seconds: null, job: 'none', action: 'kept' },
  { table: 'daily_school_stats', threshold: 'indefinite (aggregate, no individual-level data; §15.1)', seconds: null, job: 'none', action: 'kept' },
];

// Every table that has a retention rule, sorted (input to scripts/lint-retention.mjs, G-41).
export const RETENTION_TABLES: readonly string[] = [...new Set(RETENTION.map((r) => r.table))].sort();
