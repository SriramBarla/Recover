// Retention table (14 Implementation guide, §15.1, contract section 3 additions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETENTION, RETENTION_TABLES } from '../../packages/shared/src/retention.ts';

const HOUR = 3600;
const DAY = 86_400;

// Contract section 6.4: the kinds `system_purge(p_kind)` accepts.
const PURGE_KINDS = [
  'devices', 'device_links', 'closed_reports', 'report_matches', 'idempotency_keys', 'search_events',
  'health_checks', 'rate_counters', 'jobs', 'screening_runs', 'deletion_evidence', 'device_rejections', 'media_tickets',
];
// Contract section 7 job kinds a retention rule may name (plus the two non-job markers).
const JOB_KINDS = new Set([
  'purge_drafts', 'reconcile_orphan_uploads', 'anonymize_rejected', 'clear_terminal_item_text', 'delete_map_draft',
  ...PURGE_KINDS.map((k) => `purge:${k}`), 'manual retention migration', 'none',
]);

const find = (table, pred = () => true) => RETENTION.filter((r) => r.table === table && pred(r));

test('every row is complete and names a contract job', () => {
  assert.ok(RETENTION.length >= 20);
  for (const r of RETENTION) {
    for (const k of ['table', 'threshold', 'job', 'action']) assert.ok(typeof r[k] === 'string' && r[k].length > 0, `${r.table}.${k}`);
    assert.match(r.table, /^[a-z_]+$/);
    assert.ok(r.seconds === null || (Number.isInteger(r.seconds) && r.seconds >= 0), r.table);
    assert.ok(JOB_KINDS.has(r.job), `unknown job ${r.job}`);
    assert.equal(r.seconds === null, r.job === 'none', `${r.table}: only indefinite rows have no job`);
  }
});

test('every system_purge kind is covered by a rule', () => {
  const jobs = new Set(RETENTION.map((r) => r.job));
  for (const kind of PURGE_KINDS) assert.ok(jobs.has(`purge:${kind}`), kind);
});

test('thresholds match the 14 table', () => {
  const secondsFor = (table, job) => find(table, (r) => r.job === job).map((r) => r.seconds);
  assert.deepEqual(secondsFor('items', 'purge_drafts'), [3 * HOUR]);
  assert.deepEqual(secondsFor('item_photos', 'reconcile_orphan_uploads'), [3 * HOUR]);
  assert.deepEqual(secondsFor('items', 'anonymize_rejected'), [7 * DAY]);
  assert.deepEqual(secondsFor('item_photos', 'anonymize_rejected'), [7 * DAY]);
  assert.deepEqual(secondsFor('items', 'clear_terminal_item_text'), [30 * DAY]);
  assert.deepEqual(secondsFor('lost_reports', 'purge:closed_reports'), [30 * DAY]);
  assert.deepEqual(secondsFor('lost_report_matches', 'purge:report_matches'), [90 * DAY]);
  assert.deepEqual(secondsFor('devices', 'purge:devices'), [90 * DAY]);
  assert.deepEqual(secondsFor('items', 'purge:device_links'), [30 * DAY]);
  assert.deepEqual(secondsFor('map_versions', 'delete_map_draft').sort((a, b) => a - b), [0, 7 * DAY]);
  assert.deepEqual(secondsFor('idempotency_keys', 'purge:idempotency_keys'), [24 * HOUR]);
  assert.deepEqual(secondsFor('rate_counters', 'purge:rate_counters'), [48 * HOUR]);
  assert.deepEqual(secondsFor('search_events', 'purge:search_events').sort((a, b) => a - b), [7 * DAY, 90 * DAY]);
  assert.deepEqual(secondsFor('health_checks', 'purge:health_checks'), [30 * DAY]);
  assert.deepEqual(secondsFor('jobs', 'purge:jobs').sort((a, b) => a - b), [30 * DAY, 90 * DAY]);
  assert.deepEqual(secondsFor('screening_runs', 'purge:screening_runs'), [30 * DAY]);
  assert.deepEqual(secondsFor('media_deletion_objects', 'purge:deletion_evidence'), [90 * DAY]);
  assert.deepEqual(secondsFor('audit_log', 'manual retention migration'), [730 * DAY]);
});

test('contract section 3 additions are present', () => {
  assert.deepEqual(find('device_rejections').map((r) => [r.seconds, r.job]), [[30 * DAY, 'purge:device_rejections']]);
  assert.deepEqual(find('media_tickets').map((r) => [r.seconds, r.job]), [[DAY, 'purge:media_tickets']]);
  const rollup = find('error_rollup');
  assert.equal(rollup.length, 1);
  assert.equal(rollup[0].seconds, null);
  assert.match(rollup[0].threshold, /indefinite/);
  assert.match(rollup[0].threshold, /aggregate/);
});

test('rows that minimize content name the fields they clear', () => {
  const rejected = find('items', (r) => r.job === 'anonymize_rejected')[0];
  for (const f of ['description', 'private note', 'pin', 'zone', 'src', 'device digest', 'fingerprint']) assert.ok(rejected.action.includes(f), f);
  const terminal = find('items', (r) => r.job === 'clear_terminal_item_text')[0];
  for (const f of ['description', 'private note', 'pin', 'zone', 'src']) assert.ok(terminal.action.includes(f), f);
  const report = find('lost_reports')[0];
  for (const f of ['description', 'pin', 'device digest']) assert.ok(report.action.includes(f), f);
});

test('RETENTION_TABLES lists every table with a rule exactly once, sorted', () => {
  const expected = [...new Set(RETENTION.map((r) => r.table))].sort();
  assert.deepEqual(RETENTION_TABLES, expected);
  for (const t of [
    'audit_log', 'daily_school_stats', 'device_rejections', 'devices', 'error_rollup', 'health_checks', 'idempotency_keys',
    'item_photos', 'items', 'jobs', 'lost_report_matches', 'lost_reports', 'map_versions', 'media_deletion_objects',
    'media_tickets', 'rate_counters', 'screening_runs', 'search_events',
  ]) {
    assert.ok(RETENTION_TABLES.includes(t), t);
  }
});
