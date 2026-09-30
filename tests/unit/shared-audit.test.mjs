// Audit payload allowlists (F-74; 14 Implementation guide; contract section 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_ALLOWLIST, AUDIT_FORBIDDEN_WORDS, allowlistFor, assertAuditPayload } from '../../packages/shared/src/audit.ts';

const REQUIRED = [
  'item.complete', 'item.approve', 'item.reject', 'item.receive', 'item.transfer', 'item.claim', 'item.dispose',
  'item.pull', 'item.delete', 'item.edit', 'item.expire_never_arrived', 'item.receive_late', 'report.create',
  'report.close', 'report.expire', 'staff.invite', 'staff.update', 'school.config', 'school.create',
  'district.config', 'map.activate', 'map.reject', 'device.block', 'device.unblock', 'identity.rebind', 'alert.*',
];

test('every contract transition has an allowlist', () => {
  for (const action of REQUIRED) assert.ok(Array.isArray(AUDIT_ALLOWLIST[action]), action);
});

test('the 14 allowlists are reproduced', () => {
  assert.deepEqual([...AUDIT_ALLOWLIST['item.approve']].sort(), ['edited_fields', 'publication_status', 'review_status', 'row_version']);
  assert.deepEqual([...AUDIT_ALLOWLIST['item.reject']].sort(), ['reject_reason', 'review_status', 'row_version']);
  for (const k of ['custody', 'current_location_id', 'expires_at']) assert.ok(AUDIT_ALLOWLIST['item.receive'].includes(k), k);
  assert.deepEqual([...AUDIT_ALLOWLIST['staff.invite']].sort(), ['role', 'school_id']);
  assert.deepEqual([...AUDIT_ALLOWLIST['school.config']], ['changed_keys']);
});

test('no allowlist contains a forbidden key word, and keys are snake_case', () => {
  for (const [action, keys] of Object.entries(AUDIT_ALLOWLIST)) {
    assert.equal(new Set(keys).size, keys.length, `${action} has duplicates`);
    for (const key of keys) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `${action}.${key}`);
      for (const w of key.split('_')) assert.ok(!AUDIT_FORBIDDEN_WORDS.includes(w), `${action}.${key}`);
    }
  }
  for (const w of ['description', 'note', 'pin', 'digest', 'path', 'email']) assert.ok(AUDIT_FORBIDDEN_WORDS.includes(w), w);
});

test('assertAuditPayload accepts allowlisted flat payloads', () => {
  assertAuditPayload('item.approve', { review_status: 'approved', publication_status: 'generating', row_version: 4, edited_fields: ['description', 'category'] });
  assertAuditPayload('item.reject', { review_status: 'rejected', reject_reason: 'pii_visible', row_version: 2 });
  assertAuditPayload('item.receive', { custody: 'at_location', current_location_id: '11111111-1111-4111-8111-111111111111', expires_at: '2026-10-30T20:00:00+00:00' });
  assertAuditPayload('item.pull', { publication_status: 'withdrawn', reason: 'incident', row_version: 9 });
  assertAuditPayload('device.block', { blocked_until: null, days: 30, reason: 'repeat_rejections', source: 'auto' });
  assertAuditPayload('school.config', { changed_keys: ['retention_days', 'student_posting_enabled'] });
  assertAuditPayload('report.create', {});
});

test('alert.<name> actions use the alert.* list; other unknown actions are refused', () => {
  assert.equal(allowlistFor('alert.dead_jobs'), AUDIT_ALLOWLIST['alert.*']);
  assert.equal(allowlistFor('alert.severe_content'), AUDIT_ALLOWLIST['alert.*']);
  assertAuditPayload('alert.oldest_job', { metric: 'oldest_job_s', value: 912, threshold: 600, window_s: 300 });
  for (const bad of ['alert.*', 'alert.', 'alert.Bad-Name', 'item.unknown', 'item_approve', '', 'constructor', '__proto__']) {
    assert.equal(allowlistFor(bad), null, bad);
    assert.throws(() => assertAuditPayload(bad, {}), /unknown action/, bad);
  }
});

test('forbidden keys are refused even if smuggled into a payload', () => {
  const keys = [
    'description', 'location_note_private', 'note', 'pin_x', 'device_digest', 'deviceDigest', 'storage_path', 'email',
    'staff_email', 'device_token_hash', 'body', 'ip', 'ocr_text', 'display_name',
  ];
  for (const k of keys) {
    const value = `SENTINEL_${k}`;
    assert.throws(() => assertAuditPayload('item.approve', { [k]: value }), (e) => /forbidden key/.test(e.message) && !e.message.includes('SENTINEL'), k);
  }
});

test('keys outside the action allowlist are refused', () => {
  assert.throws(() => assertAuditPayload('item.reject', { review_status: 'rejected', custody: 'claimed' }), /not allowlisted: custody/);
  assert.throws(() => assertAuditPayload('item.claim', { reject_reason: 'spam' }), /not allowlisted/);
});

test('payloads must be flat objects of scalars', () => {
  assert.throws(() => assertAuditPayload('item.approve', null), /must be an object/);
  assert.throws(() => assertAuditPayload('item.approve', ['review_status']), /must be an object/);
  assert.throws(() => assertAuditPayload('item.approve', { edited_fields: { description: 'x' } }), /scalar/);
  assert.throws(() => assertAuditPayload('item.approve', { edited_fields: [{ description: 'x' }] }), /scalar/);
  assert.throws(() => assertAuditPayload('item.approve', { row_version: Number.NaN }), /scalar/);
});

test('reason fields must be codes, never staff free text', () => {
  assert.throws(() => assertAuditPayload('item.pull', { reason: 'student said it was hers, see note' }), (e) => /reason code/.test(e.message) && !e.message.includes('student'));
  assert.throws(() => assertAuditPayload('item.reject', { reject_reason: 'Other' }), /reason code/);
  assertAuditPayload('map.reject', { map_version_id: '22222222-2222-4222-8222-222222222222', approval_status: 'rejected', reason: null });
});
