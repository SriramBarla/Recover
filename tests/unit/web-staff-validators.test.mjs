// Route-handler validators for staff and district bodies: free text (F-102), the public description
// (§10.2 contact-info rule), p_edits, config and district p_changes, calendar days, and ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDaysOf,
  configChangesOf,
  dateOf,
  districtChangesOf,
  editsOf,
  emailOf,
  idsOf,
  isoOf,
  publicDescriptionOf,
  rangeOf,
  textOf,
} from '../../apps/web/lib/ops.ts';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

test('textOf cleans text and maps empty optional input to null', () => {
  assert.equal(textOf('  two   words ', 'name', { max: 20 }), 'two words');
  assert.equal(textOf('', 'note', { max: 80, optional: true }), null);
  assert.equal(textOf('   ', 'note', { max: 80, optional: true }), null);
  assert.equal(textOf(null, 'note', { max: 80, optional: true }), null);
  assert.throws(() => textOf('', 'name', { max: 20 }), { code: 'invalid_input', field: 'name' });
  assert.throws(() => textOf('x'.repeat(21), 'name', { max: 20 }), { code: 'invalid_input' });
  assert.throws(() => textOf('bad‮ltr', 'name', { max: 20 }), { code: 'invalid_input' });
  assert.throws(() => textOf(42, 'name', { max: 20 }), { code: 'invalid_input' });
});

test('the public description refuses contact details and enforces 2..120', () => {
  assert.equal(publicDescriptionOf('navy metal water bottle'), 'navy metal water bottle');
  assert.throws(() => publicDescriptionOf('call 404-555-1234'), { code: 'invalid_input', field: 'description' });
  assert.throws(() => publicDescriptionOf('ig: someone'), { code: 'invalid_input' });
  assert.throws(() => publicDescriptionOf('x'), { code: 'invalid_input' });
  assert.throws(() => publicDescriptionOf('x'.repeat(121)), { code: 'invalid_input' });
});

test('editsOf keeps only the four contract keys', () => {
  assert.equal(editsOf(null), null);
  assert.equal(editsOf(undefined), null);
  assert.equal(editsOf({}), null);
  assert.deepEqual(editsOf({ description: ' red  hoodie ', category: 'clothing', zoneId: null, dropoffLocationId: ID.toUpperCase() }), {
    description: 'red hoodie',
    category: 'clothing',
    zoneId: null,
    dropoffLocationId: ID,
  });
  assert.throws(() => editsOf({ note: 'x' }), { code: 'invalid_input', field: 'note' });
  assert.throws(() => editsOf({ category: 'car' }), { code: 'invalid_input', field: 'category' });
  assert.throws(() => editsOf({ zoneId: 'z1' }), { code: 'invalid_input', field: 'zoneId' });
  assert.throws(() => editsOf([]), { code: 'invalid_input', field: 'edits' });
});

test('config changes: known keys with their types and ranges only', () => {
  assert.deepEqual(configChangesOf({ retentionDays: 30, studentPostingEnabled: false, enabledCategories: ['bag', 'bag', 'book'] }), {
    retentionDays: 30,
    studentPostingEnabled: false,
    enabledCategories: ['bag', 'book'],
  });
  assert.throws(() => configChangesOf({}), { code: 'invalid_input', field: 'changes' });
  assert.throws(() => configChangesOf({ retentionDays: 0 }), { code: 'invalid_input', field: 'retentionDays' });
  assert.throws(() => configChangesOf({ neverArrivedSchoolDays: 11 }), { code: 'invalid_input' });
  assert.throws(() => configChangesOf({ timezone: 'UTC' }), { code: 'invalid_input', field: 'timezone' });
  assert.throws(() => configChangesOf({ studentPostingEnabled: 'yes' }), { code: 'invalid_input' });
});

test('district changes: domains are exact lowercase names; worker mode is normal or quarantine', () => {
  assert.deepEqual(districtChangesOf({ staffEmailDomains: [' District.ORG ', 'district.org'], workerMode: 'quarantine' }), {
    staffEmailDomains: ['district.org'],
    workerMode: 'quarantine',
  });
  assert.throws(() => districtChangesOf({ staffEmailDomains: [] }), { code: 'invalid_input' });
  assert.throws(() => districtChangesOf({ staffEmailDomains: ['*.district.org'] }), { code: 'invalid_input' });
  assert.throws(() => districtChangesOf({ workerMode: 'paused' }), { code: 'invalid_input' });
  assert.throws(() => districtChangesOf({ screeningDailyCeiling: -1 }), { code: 'invalid_input' });
});

test('calendar days mirror the school_calendar_days CHECK', () => {
  assert.deepEqual(
    calendarDaysOf([
      { day: '2026-10-01', isOpen: true, openAt: '07:45', closeAt: '15:30' },
      { day: '2026-10-03', isOpen: false, openAt: null, closeAt: null },
    ]),
    [
      { day: '2026-10-01', isOpen: true, openAt: '07:45:00', closeAt: '15:30:00' },
      { day: '2026-10-03', isOpen: false, openAt: null, closeAt: null },
    ],
  );
  assert.throws(() => calendarDaysOf([{ day: '2026-10-01', isOpen: true, openAt: '15:00', closeAt: '07:00' }]), { field: 'closeAt' });
  assert.throws(() => calendarDaysOf([{ day: '2026-10-01', isOpen: false, openAt: '07:00', closeAt: null }]), { field: 'openAt' });
  assert.throws(() => calendarDaysOf([{ day: '2026-02-30', isOpen: false }]), { field: 'day' });
  assert.throws(
    () =>
      calendarDaysOf([
        { day: '2026-10-01', isOpen: false },
        { day: '2026-10-01', isOpen: false },
      ]),
    { field: 'day' },
  );
  assert.throws(() => calendarDaysOf([]), { field: 'days' });
});

test('ranges default to the last 30 days and are bounded', () => {
  const now = Date.parse('2026-09-30T15:00:00Z');
  assert.deepEqual(rangeOf(undefined, undefined, now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(rangeOf('2026-09-10', '2026-09-20', now), { from: '2026-09-10', to: '2026-09-20' });
  assert.throws(() => rangeOf('2026-09-20', '2026-09-10', now), { code: 'invalid_input' });
  assert.throws(() => rangeOf('2024-01-01', '2026-09-10', now), { code: 'invalid_input' });
});

test('small field validators', () => {
  assert.equal(dateOf('2026-10-01', 'd'), '2026-10-01');
  assert.throws(() => dateOf('2026-13-01', 'd'), { code: 'invalid_input' });
  assert.equal(isoOf('2026-09-30T12:00:00.123456+00:00', 'c'), '2026-09-30T12:00:00.123456+00:00');
  assert.throws(() => isoOf('yesterday', 'c'), { code: 'invalid_input' });
  assert.equal(emailOf(' Pat@District.ORG ', 'email'), 'pat@district.org');
  assert.throws(() => emailOf('pat', 'email'), { code: 'invalid_input' });
  assert.deepEqual(idsOf([ID, ID.toUpperCase()], 'itemIds', 50), [ID]);
  assert.throws(() => idsOf([], 'itemIds', 50), { code: 'invalid_input' });
  assert.throws(() => idsOf(Array.from({ length: 51 }, () => ID), 'itemIds', 50), { code: 'invalid_input' });
});
