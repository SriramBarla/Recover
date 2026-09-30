// Job kind -> module (BUILD-CONTRACT.md section 7). tests/unit/worker-registry.test.mjs pins this map
// to the contract catalog. The drain leases only kinds listed here.
import * as anonymize_rejected from './anonymize_rejected.ts';
import * as canonicalize_map from './canonicalize_map.ts';
import * as canonicalize_photo from './canonicalize_photo.ts';
import * as clear_terminal_item_text from './clear_terminal_item_text.ts';
import * as delete_map_draft from './delete_map_draft.ts';
import * as delete_media from './delete_media.ts';
import * as evaluate_alerts from './evaluate_alerts.ts';
import * as expire_never_arrived from './expire_never_arrived.ts';
import * as expire_reports from './expire_reports.ts';
import * as finalize_publish from './finalize_publish.ts';
import * as invalidate_cache from './invalidate_cache.ts';
import * as make_variants from './make_variants.ts';
import * as mark_disposition_due from './mark_disposition_due.ts';
import * as match_item from './match_item.ts';
import * as match_report from './match_report.ts';
import * as purge from './purge.ts';
import * as purge_drafts from './purge_drafts.ts';
import * as reconcile_generating from './reconcile_generating.ts';
import * as reconcile_orphan_uploads from './reconcile_orphan_uploads.ts';
import * as rollup_daily_stats from './rollup_daily_stats.ts';
import * as screen_item from './screen_item.ts';
import type { JobModule } from './types.ts';

export const REGISTRY: Readonly<Record<string, JobModule>> = {
  canonicalize_photo,
  screen_item,
  make_variants,
  finalize_publish,
  match_item,
  match_report,
  invalidate_cache,
  delete_media,
  canonicalize_map,
  delete_map_draft,
  expire_never_arrived,
  mark_disposition_due,
  expire_reports,
  anonymize_rejected,
  clear_terminal_item_text,
  reconcile_generating,
  evaluate_alerts,
  rollup_daily_stats,
  purge,
  purge_drafts,
  reconcile_orphan_uploads,
};

// Kinds doing image, provider, or bulk storage work lease for 120 s; everything else 60 s (09 "Lease SQL").
export const MEDIA_KINDS: readonly string[] = [
  'canonicalize_photo',
  'screen_item',
  'make_variants',
  'delete_media',
  'canonicalize_map',
  'delete_map_draft',
  'purge_drafts',
  'reconcile_orphan_uploads',
];

export const OTHER_KINDS: readonly string[] = Object.keys(REGISTRY).filter((k) => !MEDIA_KINDS.includes(k));

export const LEASE_SECONDS = { media: 120, other: 60 } as const;
