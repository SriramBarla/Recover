// Server-keyed content fingerprint over canonical bytes (§9.3 step 5; 10 Implementation guide):
// HMAC(CONTENT_KEY, sha256(jpeg)). Keyed so a leaked photo cannot be matched against stored values
// without the key. Feeds the exact-duplicate flags in system_photo_canonical_ready (§10.2).
import { hmacSha256, sha256 } from '@recover/shared/crypto.ts';

export function fingerprint(jpeg: Uint8Array, contentKey: Uint8Array): Buffer {
  return hmacSha256(contentKey, sha256(jpeg));
}
