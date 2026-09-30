// Magic-byte detection for the complete-check and the canonicalizer's first gate (§9.2, §9.3).
// Only the three accepted upload formats are recognized (G-25: no HEIC; the client converts to JPEG).

export type ImageKind = 'jpeg' | 'png' | 'webp';

// Bytes the complete-check reads with a ranged GET.
export const MAGIC_BYTES = 16;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

export function sniff(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  return null;
}

// JPEG marker codes before the first scan (SOI excluded). Used to prove a JPEG carries no APP1
// (EXIF/XMP) or APP13 (IPTC) segment. Returns null if the segment structure is malformed.
export function jpegMarkers(b: Uint8Array): number[] | null {
  if (sniff(b) !== 'jpeg') return null;
  const markers: number[] = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    const m = b[i];
    if (m === undefined) return null;
    i++;
    markers.push(m);
    if (m === 0xda || m === 0xd9) return markers; // start of scan or end of image
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers
    if (i + 1 >= b.length) return null;
    const len = (b[i]! << 8) | b[i + 1]!;
    if (len < 2) return null;
    i += len;
  }
  return null;
}

export function hasMetadataSegments(b: Uint8Array): boolean {
  const markers = jpegMarkers(b);
  return markers === null || markers.includes(0xe1) || markers.includes(0xed);
}
