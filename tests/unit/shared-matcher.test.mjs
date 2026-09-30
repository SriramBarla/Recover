// Matching scorer v1 (§12.2, 12 Implementation guide): feature math, weights, threshold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORER_VERSION, THRESHOLD, WEIGHTS, score } from '../../packages/shared/src/matcher.ts';

const base = {
  reportId: 'r1',
  itemId: 'i1',
  lex: 1,
  sameCategory: true,
  reportCategoryNull: false,
  foundAt: '2026-09-28T15:00:00Z',
  lostOn: '2026-09-28',
  sameMapVersion: true,
  dx: 0,
  dy: 0,
  mapWidth: 2000,
  mapHeight: 1000,
};
const f = (over) => score({ ...base, ...over }).features;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('constants are the v1 values', () => {
  assert.equal(SCORER_VERSION, 'v1');
  assert.deepEqual(WEIGHTS, { lex: 0.45, cat: 0.2, time: 0.15, loc: 0.2 });
  near(WEIGHTS.lex + WEIGHTS.cat + WEIGHTS.time + WEIGHTS.loc, 1);
  assert.equal(THRESHOLD, 0.55);
});

test('cat: 1 same category, 0.5 report category null, else 0', () => {
  assert.equal(f({ sameCategory: true }).cat, 1);
  assert.equal(f({ sameCategory: false, reportCategoryNull: true }).cat, 0.5);
  assert.equal(f({ sameCategory: false, reportCategoryNull: false }).cat, 0);
});

test('time: 1 within 3 days after lost_on, linear to 0 at 21 days', () => {
  assert.equal(f({ foundAt: '2026-09-28T00:00:00Z' }).time, 1);
  assert.equal(f({ foundAt: '2026-10-01T00:00:00Z' }).time, 1); // exactly 3 days
  assert.equal(f({ foundAt: '2026-10-10T00:00:00Z' }).time, 0.5); // 12 days: (21-12)/18
  near(f({ foundAt: '2026-10-04T00:00:00Z' }).time, 15 / 18); // 6 days
  assert.equal(f({ foundAt: '2026-10-19T00:00:00Z' }).time, 0); // 21 days
  assert.equal(f({ foundAt: '2026-11-30T00:00:00Z' }).time, 0);
});

test('time: 0.5 without lost_on; 0.25 when found more than 1 day before the loss', () => {
  assert.equal(f({ lostOn: null }).time, 0.5);
  assert.equal(f({ foundAt: '2026-09-27T12:00:00Z' }).time, 1); // half a day before: tolerance
  assert.equal(f({ foundAt: '2026-09-27T00:00:00Z' }).time, 1); // exactly 1 day before
  assert.equal(f({ foundAt: '2026-09-26T23:59:00Z' }).time, 0.25);
  assert.equal(f({ foundAt: '2026-09-01T00:00:00Z' }).time, 0.25);
  assert.equal(f({ lostOn: 'not a date' }).time, 0.5);
});

test('loc: scaled distance, 1 at <= 0.05, linear to 0 at 0.25', () => {
  assert.equal(f({ dx: 0, dy: 0 }).loc, 1);
  assert.equal(f({ dx: 0.05, dy: 0 }).loc, 1); // 100 px / 2000
  near(f({ dx: 0.15, dy: 0 }).loc, 0.5); // 300 px / 2000 = 0.15
  near(f({ dx: 0.1, dy: 0 }).loc, 0.75);
  assert.equal(f({ dx: 0.25, dy: 0 }).loc, 0);
  assert.equal(f({ dx: -0.9, dy: 0.9 }).loc, 0);
  // Aspect scaling: 0.1 of a 1000 px height is only 100 px, i.e. 0.05 of the long edge.
  assert.equal(f({ dx: 0, dy: 0.1 }).loc, 1);
  near(f({ dx: 0.06, dy: 0.08 }).loc, (0.25 - Math.hypot(120, 80) / 2000) / 0.2);
});

test('loc: 0.5 when either pin is missing, the map versions differ, or the size is unknown', () => {
  assert.equal(f({ dx: null, dy: null }).loc, 0.5);
  assert.equal(f({ dx: 0.3, dy: null }).loc, 0.5);
  assert.equal(f({ sameMapVersion: false, dx: 0, dy: 0 }).loc, 0.5);
  assert.equal(f({ mapWidth: null }).loc, 0.5);
  assert.equal(f({ mapHeight: 0 }).loc, 0.5);
});

test('lex is clamped to [0, 1]', () => {
  assert.equal(f({ lex: 0.37 }).lex, 0.37);
  assert.equal(f({ lex: 1.7 }).lex, 1);
  assert.equal(f({ lex: -0.2 }).lex, 0);
  assert.equal(f({ lex: Number.NaN }).lex, 0);
});

test('score is the weighted sum and reproduces from the stored features', () => {
  const perfect = score(base);
  assert.equal(perfect.score, 1);
  const mid = score({ ...base, lex: 0.5, sameCategory: false, reportCategoryNull: true, foundAt: '2026-10-10T00:00:00Z', dx: 0.15, dy: 0 });
  assert.deepEqual(mid.features, { lex: 0.5, cat: 0.5, time: 0.5, loc: 0.5 });
  assert.equal(mid.score, 0.5);
  for (const s of [perfect, mid, score({ ...base, lex: 0.123456789, foundAt: '2026-10-05T07:00:00Z', dx: 0.0833 })]) {
    const { lex, cat, time, loc } = s.features;
    near(s.score, Math.round((0.45 * lex + 0.2 * cat + 0.15 * time + 0.2 * loc) * 1e6) / 1e6);
  }
});

test('threshold separates a plausible match from a weak one', () => {
  // Same category, found the next day, pins far apart, moderate text overlap.
  const plausible = score({ ...base, lex: 0.5, foundAt: '2026-09-29T10:00:00Z', dx: 0.4 });
  near(plausible.score, 0.575);
  assert.ok(plausible.score >= THRESHOLD);
  // Unknown category, unknown date, no pins, weak text.
  const weak = score({ ...base, lex: 0.2, sameCategory: false, reportCategoryNull: true, lostOn: null, dx: null, dy: null });
  near(weak.score, 0.09 + 0.1 + 0.075 + 0.1);
  assert.ok(weak.score < THRESHOLD);
  // Different category caps the score below the threshold unless text and place agree strongly.
  const otherCat = score({ ...base, lex: 0.4, sameCategory: false, reportCategoryNull: false, dx: null, dy: null });
  assert.ok(otherCat.score < THRESHOLD);
});

test('scoring is deterministic', () => {
  const pair = { ...base, lex: 0.61, foundAt: '2026-10-03T08:30:00Z', dx: 0.07, dy: -0.02 };
  assert.deepEqual(score(pair), score({ ...pair }));
});
