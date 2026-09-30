// The staff call builder (BUILD-CONTRACT.md section 5; G-16): the assertion body is exactly the SQL
// arguments without the p_ prefix, uuids are lowercased in both, and the minted bundle matches the
// shared vector that the SQL verifier test also uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodySha256, canonicalJson, macFor } from '../../packages/shared/src/assertion.ts';
import { sha256Hex } from '../../packages/shared/src/crypto.ts';
import { bodyOf, coordStr, normalizeArgs, prepareArgs, prepareCall, radiusStr, specFor } from '../../apps/web/lib/ops.ts';

const vector = JSON.parse(readFileSync(new URL('../vectors/staff_assertion_v1.json', import.meta.url), 'utf8'));
const KEY = vector.keyB64url;
const UPPER_ITEM = '0F0E0D0C-AAAA-4BBB-8CCC-00000000ABCD';
const LOWER_ITEM = UPPER_ITEM.toLowerCase();

test('the body is exactly the args without the p_ prefix', () => {
  const args = { p_school_code: 'FCHS', p_item_id: LOWER_ITEM, p_row_version: 7, p_reason: 'spam' };
  const { body } = prepareArgs(args);
  assert.deepEqual(Object.keys(body), ['school_code', 'item_id', 'row_version', 'reason']);
  assert.deepEqual(body, { school_code: 'FCHS', item_id: LOWER_ITEM, row_version: 7, reason: 'spam' });
});

test('p_assert never enters the body, and undefined arguments become null (kept)', () => {
  assert.deepEqual(bodyOf({ p_assert: { v: 'v1' }, p_a: 1 }), { a: 1 });
  const { args, body } = prepareArgs({ p_school_code: 'FCHS', p_note: undefined });
  assert.equal(args.p_note, null);
  assert.ok(Object.hasOwn(body, 'note'));
  assert.equal(body.note, null);
});

test('uuids are lowercased in both the SQL arguments and the body', () => {
  const ids = ['AAAAAAAA-0000-4000-8000-00000000000A', 'BBBBBBBB-0000-4000-8000-00000000000B'];
  const { args, body } = prepareArgs({
    p_school_code: 'FCHS',
    p_item_id: UPPER_ITEM,
    p_item_ids: ids,
    p_edits: { zoneId: 'CCCCCCCC-0000-4000-8000-00000000000C', dropoffLocationId: 'DDDDDDDD-0000-4000-8000-00000000000D', description: 'Navy Bottle' },
  });
  assert.equal(args.p_item_id, LOWER_ITEM);
  assert.equal(body.item_id, LOWER_ITEM);
  assert.deepEqual(args.p_item_ids, ids.map((s) => s.toLowerCase()));
  assert.deepEqual(body.item_ids, ids.map((s) => s.toLowerCase()));
  assert.equal(body.edits.zoneId, 'cccccccc-0000-4000-8000-00000000000c');
  assert.equal(body.edits.dropoffLocationId, 'dddddddd-0000-4000-8000-00000000000d');
  assert.equal(body.edits.description, 'Navy Bottle'); // free text is never case-folded
  assert.equal(body.school_code, 'FCHS');
  assert.deepEqual(body, bodyOf(args));
});

test('strings are NFC in both the arguments and the body', () => {
  const decomposed = 'Café mug';
  const { args, body } = prepareArgs({ p_description: decomposed });
  assert.equal(args.p_description, 'Café mug');
  assert.equal(body.description, 'Café mug');
});

test('floats are refused: pins, zone numbers, and timestamps travel as strings', () => {
  assert.throws(() => normalizeArgs({ p_pin_x: 0.5 }), /non-integer/);
  assert.throws(() => normalizeArgs({ p_edits: { weight: 1.5 } }), /non-integer/);
  assert.equal(coordStr(0.123456789, 'x'), '0.123457');
  assert.equal(coordStr(0, 'x'), '0.000000');
  assert.equal(coordStr(1, 'x'), '1.000000');
  assert.throws(() => coordStr(1.01, 'x'), { code: 'invalid_input' });
  assert.equal(radiusStr(0.05, 'radius'), '0.050000');
  assert.throws(() => radiusStr(0.6, 'radius'), { code: 'invalid_input' });
  const { body } = prepareArgs({ p_pin_x: coordStr(0.25, 'x'), p_cursor_created: '2026-09-30T12:00:00.123456+00:00' });
  assert.equal(body.pin_x, '0.250000');
  assert.equal(body.cursor_created, '2026-09-30T12:00:00.123456+00:00');
});

test('id arguments must be uuids, and argument names are allowlisted', () => {
  assert.throws(() => normalizeArgs({ p_item_id: 'not-a-uuid' }), { code: 'invalid_input' });
  assert.throws(() => normalizeArgs({ p_item_ids: ['x'] }), { code: 'invalid_input' });
  assert.throws(() => normalizeArgs({ item_id: LOWER_ITEM }), /refused key/);
  assert.throws(() => normalizeArgs({ p_assert: {} }), /refused key/);
});

test('prepareCall reproduces the shared vector bundle from uppercase inputs', () => {
  const args = {
    p_school_code: 'FCHS',
    p_item_id: vector.input.targetId.toUpperCase(),
    p_row_version: 3,
    p_edits: { description: 'navy metal water bottle' },
  };
  const spec = specFor('api_staff_item_approve', args);
  const { params, bundle } = prepareCall({
    sub: vector.input.googleSub,
    operation: spec.operation,
    scope: spec.scope,
    schoolId: vector.input.scope.slice('school:'.length).toUpperCase(),
    targetId: spec.targetId,
    rowVersion: spec.rowVersion,
    args,
    keyB64url: KEY,
    keyVersion: 1,
    requestId: vector.input.requestId,
    now: vector.input.now,
  });
  assert.deepEqual(bundle, vector.bundle);
  assert.equal(canonicalJson(bodyOf({ ...params, p_assert: undefined })), vector.bodyCanonical);
  assert.deepEqual(params.p_assert, vector.bundle);
  assert.equal(params.p_item_id, vector.input.targetId);
});

test('prepareCall: district scope, idempotency hash, and a verifiable MAC', () => {
  const { params, bundle } = prepareCall({
    sub: 'dev:admin@district.example',
    operation: 'district.settings.write',
    scope: 'district',
    args: { p_changes: { workerMode: 'normal' } },
    idempotencyKey: 'key-12345678',
    keyB64url: KEY,
    keyVersion: 2,
  });
  assert.equal(bundle.scope, 'district');
  assert.equal(bundle.target_id, null);
  assert.equal(bundle.row_version, null);
  assert.equal(bundle.key_version, 2);
  assert.equal(bundle.idempotency_key_sha256, sha256Hex('key-12345678'));
  assert.equal(bundle.body_sha256, bodySha256({ changes: { workerMode: 'normal' } }));
  assert.equal(bundle.exp - bundle.iat, 30);
  const { mac, ...fields } = bundle;
  assert.equal(mac, macFor(fields, KEY));
  assert.deepEqual(Object.keys(params), ['p_assert', 'p_changes']);
});

test('prepareCall refuses a school scope without a school id and a row_version that differs from p_row_version', () => {
  assert.throws(
    () => prepareCall({ sub: 's', operation: 'queue.read', scope: 'school', args: { p_school_code: 'FCHS' }, keyB64url: KEY, keyVersion: 1 }),
    /school uuid/,
  );
  assert.throws(
    () =>
      prepareCall({
        sub: 's',
        operation: 'item.claim',
        scope: 'school',
        schoolId: LOWER_ITEM,
        targetId: LOWER_ITEM,
        rowVersion: 4,
        args: { p_school_code: 'FCHS', p_item_id: LOWER_ITEM, p_row_version: 5 },
        keyB64url: KEY,
        keyVersion: 1,
      }),
    /row_version/,
  );
});
