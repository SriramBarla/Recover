// Writes tests/vectors/staff_assertion_v1.json from packages/shared/src/assertion.ts (§14.2, F-120;
// contract section 5). Everything is fixed (key, fields, time), so reruns produce identical bytes.
// The SQL verifier test and tests/unit/shared-assertion.test.mjs both assert this file.
// Usage: node scripts/gen-vectors.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bodySha256, canonicalJson, canonicalLines, mint } from '../packages/shared/src/assertion.ts';

export const STAFF_ASSERTION_VECTOR_URL = new URL('../tests/vectors/staff_assertion_v1.json', import.meta.url);

export function buildStaffAssertionVector() {
  const keyB64url = Buffer.alloc(32, 0x42).toString('base64url');
  const targetId = '11111111-1111-4111-8111-111111111111';
  const input = {
    googleSub: '113459876543210987654',
    scope: 'school:0a0a0a0a-0000-4000-8000-000000000001',
    operation: 'item.approve',
    targetId,
    rowVersion: 3,
    body: { school_code: 'FCHS', item_id: targetId, row_version: 3, edits: { description: 'navy metal water bottle' } },
    idempotencyKeySha256: null,
    keyVersion: 1,
    requestId: '00000000-0000-4000-8000-000000000001',
    now: 1_790_000_000_000, // ms; iat = 1790000000
  };
  const bundle = mint({ ...input, keyB64url });
  const { mac, ...fields } = bundle;
  return {
    keyB64url,
    input,
    bodyCanonical: canonicalJson(input.body),
    bodySha256: bodySha256(input.body),
    canonicalLines: canonicalLines(fields),
    mac,
    bundle,
  };
}

export function serialize(vector) {
  return `${JSON.stringify(vector, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(new URL('.', STAFF_ASSERTION_VECTOR_URL), { recursive: true });
  writeFileSync(STAFF_ASSERTION_VECTOR_URL, serialize(buildStaffAssertionVector()));
  console.log(`wrote ${fileURLToPath(STAFF_ASSERTION_VECTOR_URL)}`);
}
