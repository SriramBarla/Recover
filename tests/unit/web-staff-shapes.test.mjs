// Tolerant readers for staff SQL results (components/staff/shapes.ts) and reviewer chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configOf, custodyListsOf, membershipsOf, queueOf, rosterOf, schoolsOf } from '../../apps/web/components/staff/shapes.ts';
import { chipsFor } from '../../apps/web/components/staff/format.ts';

const ITEM = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  publicId: 'FCHS-W-000001',
  category: 'bag',
  description: 'blue backpack',
  note: null,
  pin: null,
  mapVersionId: null,
  zoneId: null,
  zoneName: null,
  dropoffLocationId: 'bbbbbbbb-0000-4000-8000-000000000001',
  currentLocationId: null,
  reviewStatus: 'pending',
  publicationStatus: 'hidden',
  custody: 'with_finder',
  postedByKind: 'student',
  createdAt: '2026-09-30T12:00:00Z',
  arrivalDeadlineAt: null,
  expiresAt: null,
  dispositionDueAt: null,
  rowVersion: 2,
  screeningStatus: 'flagged',
  flags: ['has_face', 7],
  quarantine: false,
  photos: [{ photoId: 'cccccccc-0000-4000-8000-000000000001', position: 0, generation: 1, status: 'canonical_ready', isCurrent: true }],
  deviceRejections30d: 1,
};

test('queueOf keeps well-formed items and the cursor', () => {
  const page = queueOf({ items: [ITEM, { nope: true }], nextCursor: { createdAt: '2026-09-30T12:00:00Z', id: ITEM.id } });
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].flags, ['has_face']);
  assert.deepEqual(page.nextCursor, { createdAt: '2026-09-30T12:00:00Z', id: ITEM.id });
  assert.deepEqual(queueOf(null), { items: [], nextCursor: null });
});

test('membershipsOf drops unknown roles and defaults the status', () => {
  const ms = membershipsOf({
    memberships: [
      { memberId: 'm1', schoolId: 's1', schoolCode: 'FCHS', schoolName: 'Forsyth', role: 'office', status: 'invited' },
      { memberId: 'm2', schoolId: null, schoolCode: null, schoolName: null, role: 'district_admin' },
      { memberId: 'm3', role: 'superuser' },
    ],
  });
  assert.deepEqual(ms.map((m) => [m.role, m.status]), [['office', 'invited'], ['district_admin', 'active']]);
});

test('schoolsOf and rosterOf accept the documented keys and aliases', () => {
  assert.deepEqual(schoolsOf({ schools: [{ schoolId: 'AB', code: 'FCHS', name: 'Forsyth' }, { code: 'NOID' }] }), [
    { id: 'ab', code: 'FCHS', name: 'Forsyth', timezone: null, active: true },
  ]);
  const roster = rosterOf([{ id: 'm1', email: 'a@d.org', role: 'reviewer', status: 'active' }]);
  assert.equal(roster[0].memberId, 'm1');
  assert.equal(roster[0].role, 'reviewer');
});

test('configOf reads nested and flat flag shapes', () => {
  const nested = configOf({ flags: { studentPosting: true, lostReports: false, crossSchoolSearch: true }, retentionDays: 21, enabledCategories: ['bag'] });
  assert.equal(nested.studentPosting, true);
  assert.equal(nested.crossSchoolSearch, true);
  assert.equal(nested.retentionDays, 21);
  const flat = configOf({ config: { studentPostingEnabled: true, retentionDays: 14 }, district: { retentionDaysFloor: 14, retentionDaysCeiling: 60 } });
  assert.equal(flat.studentPosting, true);
  assert.equal(flat.retentionFloor, 14);
  assert.equal(flat.retentionCeiling, 60);
});

test('custody lists map StaffItemRows to rows with a private thumbnail', () => {
  const lists = custodyListsOf({ expected: [ITEM], atLocation: [], dispositionDue: [] }, 'FCHS');
  assert.equal(lists.expected.length, 1);
  assert.equal(lists.expected[0].locationId, ITEM.dropoffLocationId);
  assert.equal(lists.expected[0].thumb, `/api/staff/FCHS/items/${ITEM.id}/photos/${ITEM.photos[0].photoId}`);
  assert.deepEqual(lists.dispositionDue, []);
});

test('reviewer chips cover the section 10.2 flags plus unscreened and screening errors', () => {
  assert.deepEqual(chipsFor(['nsfw', 'quarantine'], 'flagged').map((c) => c.key), ['nsfw']);
  assert.deepEqual(chipsFor([], 'unscreened').map((c) => c.key), ['unscreened']);
  assert.deepEqual(chipsFor([], 'error').map((c) => c.key), ['screening_error']);
  assert.deepEqual(chipsFor(['ceiling'], 'error').map((c) => c.key), ['ceiling']);
  assert.equal(chipsFor(['brand_new_flag'], 'clean')[0].tone, 'neutral');
});
