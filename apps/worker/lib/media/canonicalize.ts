// Server-side canonicalization (§9.3; 10 Implementation guide; F-73, F-91; G-25, G-28).
// Hostile upload bytes in; a metadata-free, auto-oriented, size-bounded JPEG out, plus the private
// 800 px review rendition. Failures are PermanentError('decode_failed' | 'unsupported_format' | 'too_large').
import sharp, { INPUT, decodeError, rendition } from './sharp.ts';
import { sniff, type ImageKind } from './magic.ts';
import { PermanentError } from '../jobs/errors.ts';

export const CANONICAL_EDGE = 1600;
export const REVIEW_EDGE = 800; // G-28
export const MAP_EDGE = 2400;
// item_photos.bytes stays within 1 MiB (G-38): quality steps down only for pathological (noise-like) input.
export const MAX_CANONICAL_BYTES = 1_048_576;
export const MAX_MAP_BYTES = 4_000_000; // storage-wide 4 MB upload limit (§9.1)

export type Canonical = { jpeg: Buffer; width: number; height: number; review: Buffer };
export type CanonicalMap = { jpeg: Buffer; width: number; height: number };

// Gate before any full decode: known magic, header parses, and the decoder agrees on the format
// (the loader allowlist in sharp.ts refuses everything else anyway).
async function probe(raw: Buffer, allowed: readonly ImageKind[]): Promise<void> {
  if (raw.length === 0) throw new PermanentError('decode_failed');
  const kind = sniff(raw);
  if (kind === null || !allowed.includes(kind)) throw new PermanentError('unsupported_format');
  let meta: { format?: string; width?: number; height?: number };
  try {
    meta = await sharp(raw, INPUT).metadata();
  } catch (e) {
    throw decodeError(e);
  }
  if (meta.format !== kind) throw new PermanentError('unsupported_format');
  if (!meta.width || !meta.height) throw new PermanentError('decode_failed');
}

async function encode(raw: Buffer, edge: number, quality: number): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(raw, INPUT)
      .rotate() // auto-orient from EXIF, then the tag is gone with the rest of the metadata
      .flatten({ background: '#ffffff' })
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, progressive: true }) // never withMetadata/keepMetadata
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (e) {
    throw decodeError(e);
  }
}

async function encodeBounded(raw: Buffer, edge: number, qualities: readonly number[], maxBytes: number) {
  for (const q of qualities) {
    const out = await encode(raw, edge, q);
    if (out.data.length <= maxBytes) return out;
  }
  throw new PermanentError('too_large');
}

// Re-decode the output once (§9.3 step 7): it must be a JPEG with exactly the dimensions produced.
async function assertJpeg(jpeg: Buffer, width: number, height: number, edge: number): Promise<void> {
  if (sniff(jpeg) !== 'jpeg') throw new PermanentError('decode_failed');
  let decoded: { width: number; height: number };
  try {
    ({ info: decoded } = await sharp(jpeg, INPUT).raw().toBuffer({ resolveWithObject: true }));
  } catch {
    throw new PermanentError('decode_failed');
  }
  if (decoded.width !== width || decoded.height !== height || Math.max(width, height) > edge) {
    throw new PermanentError('decode_failed');
  }
}

export async function canonicalize(raw: Buffer): Promise<Canonical> {
  await probe(raw, ['jpeg', 'png', 'webp']);
  const out = await encodeBounded(raw, CANONICAL_EDGE, [82, 72, 62, 50], MAX_CANONICAL_BYTES);
  await assertJpeg(out.data, out.width, out.height, CANONICAL_EDGE);
  const review = await rendition(out.data, REVIEW_EDGE, 78);
  return { jpeg: out.data, width: out.width, height: out.height, review };
}

// School maps (10 Implementation guide "Maps"): PNG or JPEG in, JPEG out, long edge <= 2400.
export async function canonicalizeMap(raw: Buffer): Promise<CanonicalMap> {
  await probe(raw, ['jpeg', 'png']);
  const out = await encodeBounded(raw, MAP_EDGE, [85, 75, 65], MAX_MAP_BYTES);
  await assertJpeg(out.data, out.width, out.height, MAP_EDGE);
  return { jpeg: out.data, width: out.width, height: out.height };
}
