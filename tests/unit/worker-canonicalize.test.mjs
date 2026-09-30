// Canonicalization (§9.3; 10 Implementation guide; F-73, F-91; G-25, G-28). Fixtures are generated
// with sharp here and in tests/fuzz/media; the worker itself never calls withMetadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { canonicalize, canonicalizeMap, MAX_CANONICAL_BYTES } from '../../apps/worker/lib/media/canonicalize.ts';
import { variants } from '../../apps/worker/lib/media/variants.ts';
import { hasMetadataSegments, sniff } from '../../apps/worker/lib/media/magic.ts';
import { PermanentError } from '../../apps/worker/lib/jobs/errors.ts';
import { APP1, APP13, buildCorpus, exifGpsJpeg, jpegMarkers, orientedJpeg, pngWithHeader, solidJpeg } from '../fuzz/media/corpus.mjs';

const permanent = (code) => (e) => e instanceof PermanentError && e.code === code;

async function dims(buf) {
  const m = await sharp(buf).metadata();
  return [m.format, m.width, m.height];
}

test('JPEG with EXIF GPS comes out with no APP1 (or APP13) segment', async () => {
  const raw = await exifGpsJpeg();
  assert.ok(jpegMarkers(raw).includes(APP1), 'fixture must carry EXIF');
  assert.ok(raw.length > 40_000, 'fixture EXIF is about 40 KB');
  const c = await canonicalize(raw);
  for (const out of [c.jpeg, c.review]) {
    const markers = jpegMarkers(out);
    assert.ok(!markers.includes(APP1), 'no APP1');
    assert.ok(!markers.includes(APP13), 'no APP13');
    assert.equal(hasMetadataSegments(out), false);
  }
  assert.equal(c.jpeg.includes(Buffer.from('fixture')), false, 'EXIF text is gone');
});

test('PNG with a huge declared size but a tiny body is rejected', async () => {
  await assert.rejects(canonicalize(pngWithHeader(20_000, 20_000, deflateSync(Buffer.alloc(16)))), permanent('too_large'));
  await assert.rejects(canonicalize(pngWithHeader(5_000, 5_000, deflateSync(Buffer.alloc(16)))), permanent('decode_failed'));
});

test('truncated JPEG, zero bytes, and SVG renamed to jpg are rejected', async () => {
  const jpeg = await solidJpeg(640, 480);
  await assert.rejects(canonicalize(jpeg.subarray(0, Math.floor(jpeg.length / 2))), permanent('decode_failed'));
  await assert.rejects(canonicalize(Buffer.alloc(0)), permanent('decode_failed'));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  await assert.rejects(canonicalize(svg), permanent('unsupported_format'));
});

test('a 4032x3024 camera frame is accepted and bounded to 1600 px (G-25)', async () => {
  const c = await canonicalize(await solidJpeg(4032, 3024));
  assert.deepEqual([c.width, c.height], [1600, 1200]);
  assert.deepEqual(await dims(c.jpeg), ['jpeg', 1600, 1200]);
  assert.deepEqual(await dims(c.review), ['jpeg', 800, 600]);
  assert.ok(c.jpeg.length <= MAX_CANONICAL_BYTES);
});

test('small images are not enlarged; EXIF orientation is applied to pixels', async () => {
  const small = await canonicalize(await solidJpeg(300, 200));
  assert.deepEqual([small.width, small.height], [300, 200]);
  assert.deepEqual(await dims(small.review), ['jpeg', 300, 200]);
  const oriented = await canonicalize(await orientedJpeg());
  assert.deepEqual([oriented.width, oriented.height], [300, 400], 'orientation 6 displays portrait');
  const meta = await sharp(oriented.jpeg).metadata();
  assert.equal(meta.orientation, undefined, 'no orientation tag survives');
});

test('noise-like input is stepped down in quality to stay within 1 MiB', async () => {
  const noise = randomBytes(1600 * 1600 * 3);
  const raw = await sharp(noise, { raw: { width: 1600, height: 1600, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
  const c = await canonicalize(raw);
  assert.ok(c.jpeg.length <= MAX_CANONICAL_BYTES, `canonical is ${c.jpeg.length} bytes`);
  assert.deepEqual([c.width, c.height], [1600, 1600]);
});

test('fuzz corpus: every case is a PermanentError or a metadata-free canonical JPEG', async () => {
  for (const { name, bytes, expect } of await buildCorpus()) {
    if (expect === 'ok') {
      const c = await canonicalize(bytes);
      assert.equal(sniff(c.jpeg), 'jpeg', name);
      const markers = jpegMarkers(c.jpeg);
      assert.ok(!markers.includes(APP1) && !markers.includes(APP13), `${name}: metadata segment in output`);
      assert.ok(Math.max(c.width, c.height) <= 1600, name);
    } else {
      await assert.rejects(canonicalize(bytes), permanent(expect), name);
    }
  }
});

test('maps: PNG in, JPEG out, long edge 2400; WebP and SVG refused', async () => {
  const png = await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } }).png().toBuffer();
  const m = await canonicalizeMap(png);
  assert.deepEqual([m.width, m.height], [2400, 1600]);
  assert.deepEqual(await dims(m.jpeg), ['jpeg', 2400, 1600]);
  assert.equal(hasMetadataSegments(m.jpeg), false);
  const webp = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).webp().toBuffer();
  await assert.rejects(canonicalizeMap(webp), permanent('unsupported_format'));
  await assert.rejects(canonicalizeMap(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), permanent('unsupported_format'));
});

test('variants: thumb 400 px and medium 1200 px from the canonical, without metadata', async () => {
  const c = await canonicalize(await exifGpsJpeg());
  const v = await variants(c.jpeg);
  assert.deepEqual(await dims(v.thumb), ['jpeg', 400, 300]);
  assert.deepEqual(await dims(v.medium), ['jpeg', 640, 480], 'never enlarged beyond the canonical');
  for (const out of [v.thumb, v.medium]) assert.equal(hasMetadataSegments(out), false);
  const big = await canonicalize(await solidJpeg(4032, 3024));
  assert.deepEqual(await dims((await variants(big.jpeg)).medium), ['jpeg', 1200, 900]);
});
