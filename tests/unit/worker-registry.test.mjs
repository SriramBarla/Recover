// Every job kind in BUILD-CONTRACT.md section 7 has a module at apps/worker/lib/jobs/<kind>.ts that
// exports `kind` and `run`, and the registry holds nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEASE_SECONDS, MEDIA_KINDS, OTHER_KINDS, REGISTRY } from '../../apps/worker/lib/jobs/registry.ts';

const CONTRACT_KINDS = [
  'canonicalize_photo',
  'screen_item',
  'make_variants',
  'finalize_publish',
  'match_item',
  'match_report',
  'invalidate_cache',
  'delete_media',
  'canonicalize_map',
  'delete_map_draft',
  'expire_never_arrived',
  'mark_disposition_due',
  'expire_reports',
  'anonymize_rejected',
  'clear_terminal_item_text',
  'reconcile_generating',
  'evaluate_alerts',
  'rollup_daily_stats',
  'purge',
  'purge_drafts',
  'reconcile_orphan_uploads',
];

test('every contract kind has a module file exporting kind and run', () => {
  for (const kind of CONTRACT_KINDS) {
    const file = fileURLToPath(new URL(`../../apps/worker/lib/jobs/${kind}.ts`, import.meta.url));
    assert.ok(existsSync(file), `missing lib/jobs/${kind}.ts`);
    const mod = REGISTRY[kind];
    assert.ok(mod, `registry has no ${kind}`);
    assert.equal(mod.kind, kind);
    assert.equal(typeof mod.run, 'function');
  }
});

test('the registry holds exactly the contract kinds', () => {
  assert.deepEqual(Object.keys(REGISTRY).sort(), [...CONTRACT_KINDS].sort());
});

test('lease classes partition the registry: media kinds 120 s, everything else 60 s (09 "Lease SQL")', () => {
  assert.deepEqual([...MEDIA_KINDS, ...OTHER_KINDS].sort(), [...CONTRACT_KINDS].sort());
  assert.equal(MEDIA_KINDS.filter((k) => OTHER_KINDS.includes(k)).length, 0);
  for (const k of ['canonicalize_photo', 'make_variants', 'screen_item', 'canonicalize_map']) assert.ok(MEDIA_KINDS.includes(k), k);
  for (const k of ['finalize_publish', 'invalidate_cache', 'match_item', 'purge']) assert.ok(OTHER_KINDS.includes(k), k);
  assert.deepEqual(LEASE_SECONDS, { media: 120, other: 60 });
});
