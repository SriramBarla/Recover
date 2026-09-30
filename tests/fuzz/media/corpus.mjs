// Media fuzz corpus (10 Implementation guide "Fuzz corpus"; §9.3; F-73, F-91; G-25).
// Generated in memory with sharp and hand-built headers, so nothing binary is checked in.
// Expected outcome of every case: a PermanentError, or a canonical JPEG with no APP1/APP13 segment.
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

// ---------- byte-level builders ----------

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A structurally valid PNG whose IHDR declares width x height (8-bit RGB) around an arbitrary IDAT.
export function pngWithHeader(width, height, idat) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Marker codes before the first scan, walked independently of the worker's own parser.
export function jpegMarkers(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const markers = [];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`bad marker at ${i}`);
    while (buf[i] === 0xff) i++;
    const m = buf[i++];
    markers.push(m);
    if (m === 0xda || m === 0xd9) return markers;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    i += buf.readUInt16BE(i);
  }
  throw new Error('no scan');
}

export const APP1 = 0xe1;
export const APP13 = 0xed;

// ---------- sharp-built fixtures ----------

export async function solidJpeg(width, height, extra = (s) => s) {
  return extra(sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } })).jpeg({ quality: 90 }).toBuffer();
}

// ~40 KB of EXIF including GPS, embedded with withMetadata (fixtures only; the worker never calls it).
export async function exifGpsJpeg() {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 90, b: 160 } } })
    .jpeg({ quality: 90 })
    .withMetadata({
      exif: {
        IFD0: { ImageDescription: 'x'.repeat(40_000), Copyright: 'fixture' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 26/1 4600/100', GPSLongitudeRef: 'W', GPSLongitude: '79/1 58/1 3600/100' },
      },
    })
    .toBuffer();
}

// Landscape pixels stored with EXIF orientation 6 (rotate 90 CW on display): displayed portrait.
export async function orientedJpeg() {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 200, b: 0 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

async function animatedWebp() {
  const frame = 32 * 32 * 3;
  const pixels = Buffer.alloc(frame * 3);
  for (let f = 0; f < 3; f++) pixels.fill(60 * (f + 1), f * frame, (f + 1) * frame);
  return sharp(pixels, { raw: { width: 32, height: 96, channels: 3, pageHeight: 32 } }).webp({ loop: 0, delay: [100, 100, 100] }).toBuffer();
}

const MINIMAL_HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('mif1heic', 'latin1'),
  Buffer.alloc(64),
]);

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>');

// Every case: name, bytes, and the expected outcome ('ok' or a PermanentError code).
export async function buildCorpus() {
  const base = await solidJpeg(640, 480);
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(26), Buffer.from('payload.txt', 'latin1'), Buffer.from('hello')]);
  return [
    { name: 'truncated jpeg', bytes: base.subarray(0, Math.floor(base.length / 2)), expect: 'decode_failed' },
    { name: 'jpeg with 40 KB EXIF incl. GPS', bytes: await exifGpsJpeg(), expect: 'ok' },
    { name: 'png zlib bomb (10000x10000 of zeros)', bytes: pngWithHeader(10_000, 10_000, deflateSync(Buffer.alloc(1_000_000))), expect: 'too_large' },
    { name: 'animated webp', bytes: await animatedWebp(), expect: 'ok' },
    { name: 'heic', bytes: MINIMAL_HEIC, expect: 'unsupported_format' },
    { name: 'polyglot jpeg+zip', bytes: Buffer.concat([base, zip]), expect: 'ok' },
    { name: '20000x20000 header, tiny body', bytes: pngWithHeader(20_000, 20_000, deflateSync(Buffer.alloc(16))), expect: 'too_large' },
    { name: '5000x5000 header, tiny body', bytes: pngWithHeader(5_000, 5_000, deflateSync(Buffer.alloc(16))), expect: 'decode_failed' },
    { name: 'zero bytes', bytes: Buffer.alloc(0), expect: 'decode_failed' },
    { name: 'svg renamed .jpg', bytes: SVG, expect: 'unsupported_format' },
    { name: 'gif', bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).gif().toBuffer(), expect: 'unsupported_format' },
    { name: 'jpeg magic then garbage', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x41)]), expect: 'decode_failed' },
    { name: 'cmyk jpeg', bytes: await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).toColourspace('cmyk').jpeg().toBuffer(), expect: 'ok' },
    { name: 'png with alpha', bytes: await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), expect: 'ok' },
    { name: 'webp', bytes: await sharp({ create: { width: 64, height: 48, channels: 3, background: '#123456' } }).webp().toBuffer(), expect: 'ok' },
  ];
}
