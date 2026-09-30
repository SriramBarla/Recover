// Staff operation matrix mirror (BUILD-CONTRACT.md section 5; §14.3) and the function -> assertion
// table (sections 6.2, 6.3). The SQL twin is private.op_min_role in 0010_private_helpers.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FNS,
  OP_MIN_ROLE,
  ROLES,
  STEP_UP_OPS,
  atLeast,
  canPerform,
  minRoleFor,
  pagesFor,
  specFor,
} from '../../apps/web/lib/ops.ts';

const CONTRACT = {
  reviewer: ['queue.read', 'item.read', 'item.approve', 'item.reject', 'item.bulk_reject', 'item.pull', 'item.create', 'item.complete', 'media.read', 'reports.read', 'report.close', 'stats.read'],
  office: ['item.receive', 'item.transfer', 'item.claim', 'item.dispose', 'item.bulk_dispose', 'item.edit', 'item.delete', 'item.photo_drop', 'item.confirm_publish', 'device.block', 'device.unblock'],
  school_admin: ['roster.read', 'roster.invite', 'roster.update', 'locations.read', 'locations.write', 'zones.write', 'map.read', 'map.create', 'map.upload', 'map.submit', 'config.read', 'config.write', 'calendar.write', 'audit.read'],
  district_admin: ['map.activate'],
};

test('the minimum-role table is exactly the contract table', () => {
  const expected = {};
  for (const [role, ops] of Object.entries(CONTRACT)) for (const op of ops) expected[op] = role;
  assert.deepEqual({ ...OP_MIN_ROLE }, expected);
});

test('roles are ordered reviewer < office < school_admin < district_admin', () => {
  assert.deepEqual([...ROLES], ['reviewer', 'office', 'school_admin', 'district_admin']);
  assert.ok(atLeast('office', 'reviewer'));
  assert.ok(!atLeast('reviewer', 'office'));
  assert.ok(atLeast('district_admin', 'school_admin'));
});

test('each role can do its own operations and every lower role, never higher ones', () => {
  for (const [role, ops] of Object.entries(CONTRACT)) {
    for (const op of ops) {
      for (const r of ROLES) {
        assert.equal(canPerform(r, op), atLeast(r, role), `${r} ${op}`);
      }
    }
  }
});

test('district.* is district_admin only; unknown operations and missing roles are refused', () => {
  assert.equal(minRoleFor('district.settings.write'), 'district_admin');
  assert.ok(canPerform('district_admin', 'district.schools.read'));
  assert.ok(!canPerform('school_admin', 'district.schools.read'));
  assert.ok(!canPerform('district_admin', 'item.teleport'));
  assert.ok(!canPerform(null, 'queue.read'));
  assert.ok(!canPerform(undefined, 'queue.read'));
});

const CATALOG_62 = [
  'api_staff_bind_identity', 'api_staff_resolve_session', 'api_staff_queue', 'api_staff_item_get', 'api_staff_item_approve',
  'api_staff_item_reject', 'api_staff_bulk_reject', 'api_staff_item_receive', 'api_staff_item_transfer', 'api_staff_item_claim',
  'api_staff_item_dispose', 'api_staff_bulk_dispose', 'api_staff_item_pull', 'api_staff_item_delete', 'api_staff_item_edit',
  'api_staff_item_confirm_publish', 'api_staff_photo_drop', 'api_staff_create_item', 'api_staff_complete_item',
  'api_staff_block_device', 'api_staff_unblock_device', 'api_staff_media_ticket', 'api_staff_lost_reports', 'api_staff_report_close',
  'api_staff_roster_list', 'api_staff_roster_invite', 'api_staff_roster_update', 'api_staff_locations_list',
  'api_staff_location_upsert', 'api_staff_location_pin_set', 'api_staff_map_versions', 'api_staff_map_create_draft',
  'api_staff_zone_upsert', 'api_staff_map_submit', 'api_staff_config_get', 'api_staff_config_update', 'api_staff_calendar_upsert',
  'api_staff_stats', 'api_staff_audit',
];
const CATALOG_63 = [
  'api_district_schools_list', 'api_district_school_create', 'api_district_settings_get', 'api_district_settings_update',
  'api_district_maps_pending', 'api_district_map_reject', 'api_district_identity_rebind', 'api_district_stats',
  'api_district_alerts', 'api_district_onboarding',
];

test('every catalogued staff and district function has an assertion spec', () => {
  for (const fn of [...CATALOG_62, ...CATALOG_63]) assert.ok(Object.hasOwn(FNS, fn), fn);
  const extra = Object.keys(FNS).filter((fn) => !CATALOG_62.includes(fn) && !CATALOG_63.includes(fn));
  assert.deepEqual(extra, ['api_staff_custody_list']); // the one proposed addition, flagged in ops.ts
});

test('district functions and identity functions use district scope; school functions use school scope', () => {
  for (const fn of CATALOG_63) {
    assert.equal(FNS[fn].scope, 'district', fn);
    assert.match(FNS[fn].op, /^district\./, fn);
  }
  assert.equal(FNS.api_staff_bind_identity.op, 'identity.bind');
  assert.equal(FNS.api_staff_resolve_session.op, 'session.resolve');
  assert.equal(FNS.api_staff_bind_identity.scope, 'district');
  assert.equal(FNS.api_staff_resolve_session.scope, 'district');
  for (const fn of CATALOG_62.filter((f) => !['api_staff_bind_identity', 'api_staff_resolve_session'].includes(f))) {
    assert.equal(FNS[fn].scope, 'school', fn);
  }
});

test('every school-scope operation in the table is a contract operation', () => {
  const known = new Set(Object.values(CONTRACT).flat());
  for (const [fn, spec] of Object.entries(FNS)) {
    if (spec.scope === 'school' && spec.op !== 'ticket') assert.ok(known.has(spec.op), `${fn} -> ${spec.op}`);
  }
});

test('specFor: target, row_version, and ticket operations', () => {
  const item = '0f0e0d0c-0000-4000-8000-00000000abcd';
  assert.deepEqual(specFor('api_staff_item_approve', { p_school_code: 'FCHS', p_item_id: item, p_row_version: 4, p_edits: null }), {
    operation: 'item.approve',
    scope: 'school',
    targetId: item,
    rowVersion: 4,
  });
  assert.deepEqual(specFor('api_staff_queue', { p_school_code: 'FCHS', p_cursor_created: null, p_cursor_id: null }), {
    operation: 'queue.read',
    scope: 'school',
    targetId: null,
    rowVersion: null,
  });
  const report = '1f0e0d0c-0000-4000-8000-00000000abcd';
  assert.equal(specFor('api_staff_block_device', { p_item_id: null, p_report_id: report }).targetId, report);
  const photo = '2f0e0d0c-0000-4000-8000-00000000abcd';
  const read = specFor('api_staff_media_ticket', { p_school_code: 'FCHS', p_operation: 'media.read', p_photo_id: photo, p_map_version_id: null });
  assert.deepEqual(read, { operation: 'media.read', scope: 'school', targetId: photo, rowVersion: null });
  const version = '3f0e0d0c-0000-4000-8000-00000000abcd';
  const activate = specFor('api_staff_media_ticket', { p_school_code: 'FCHS', p_operation: 'map.activate', p_photo_id: null, p_map_version_id: version });
  assert.deepEqual(activate, { operation: 'map.activate', scope: 'district', targetId: version, rowVersion: null });
  assert.throws(() => specFor('api_staff_media_ticket', { p_operation: 'media.write' }), { code: 'invalid_input' });
});

test('destructive operations require step-up (G-31)', () => {
  for (const op of ['item.delete', 'item.bulk_dispose', 'roster.update', 'config.write', 'map.activate', 'district.settings.write', 'district.identity.rebind']) {
    assert.ok(STEP_UP_OPS.has(op), op);
  }
  assert.ok(!STEP_UP_OPS.has('item.approve'));
});

test('navigation shows only the sections a role can open', () => {
  assert.deepEqual(pagesFor('reviewer').map((p) => p.seg), ['queue', 'post', 'reports', 'stats']);
  assert.deepEqual(pagesFor('office').map((p) => p.seg), ['queue', 'custody', 'post', 'reports', 'stats']);
  assert.deepEqual(pagesFor('school_admin').map((p) => p.seg), ['queue', 'custody', 'post', 'reports', 'stats', 'roster', 'locations', 'map', 'config']);
  assert.deepEqual(pagesFor('district_admin').map((p) => p.seg), pagesFor('school_admin').map((p) => p.seg));
});
