// Calendar CSV parsing for the staff config page (`day,is_open,open_at,close_at`, §24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendarCsv, summarize } from '../../apps/web/components/staff/calendar-csv.ts';

test('parses a header, open and closed days, and sorts by day', () => {
  const { rows, errors } = parseCalendarCsv('﻿day,is_open,open_at,close_at\r\n2026-10-02,true,7:45,15:30\n2026-10-01,TRUE,07:45:00,15:30\n2026-10-03,false,,\n\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(rows, [
    { day: '2026-10-01', isOpen: true, openAt: '07:45:00', closeAt: '15:30:00' },
    { day: '2026-10-02', isOpen: true, openAt: '07:45:00', closeAt: '15:30:00' },
    { day: '2026-10-03', isOpen: false, openAt: null, closeAt: null },
  ]);
  assert.deepEqual(summarize(rows), { first: '2026-10-01', last: '2026-10-03', open: 2, closed: 1 });
});

test('accepts yes/no/1/0/open/closed and quoted cells', () => {
  const { rows, errors } = parseCalendarCsv('"2026-10-01","yes","08:00","15:00"\n2026-10-02,0,,\n2026-10-03,closed,,');
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => r.isOpen), [true, false, false]);
});

test('reports line-numbered errors', () => {
  const { rows, errors } = parseCalendarCsv(
    ['day,is_open,open_at,close_at', '2026-02-30,true,08:00,15:00', '2026-10-01,maybe,,', '2026-10-02,true,15:00,08:00', '2026-10-03,false,08:00,', '2026-10-04,true,,', '2026-10-05,false,,', '2026-10-05,false,,', '2026-10-06,false,,,x'].join('\n'),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    errors.map((e) => e.split(':')[0]),
    ['Line 2', 'Line 3', 'Line 4', 'Line 5', 'Line 6', 'Line 8', 'Line 9'],
  );
});

test('stops collecting after the error limit', () => {
  const text = Array.from({ length: 30 }, (_, i) => `bad-${i},true,,`).join('\n');
  assert.equal(parseCalendarCsv(text, 5).errors.length, 5);
});
