// sharp configured once per process for hostile input (§9.3; G-25). Only the JPEG, PNG, and WebP
// buffer loaders stay enabled, so SVG, PDF, HEIF, TIFF, GIF and the rest never reach a libvips
// parser, whatever the bytes claim to be. The operation cache is off: images are unrelated.
import sharp from 'sharp';
import { PermanentError } from '../jobs/errors.ts';

sharp.cache(false);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });

// Fail on any decode error; 50 MP input cap (G-25 raised it from 12 MP so a 4032x3024 frame passes;
// the 1 MiB incoming limit already bounds compressed size).
export const INPUT = { failOn: 'error', limitInputPixels: 50_000_000 } as const;

export function decodeError(e: unknown): PermanentError {
  const msg = e instanceof Error ? e.message : '';
  if (/pixel limit/i.test(msg)) return new PermanentError('too_large');
  if (/unsupported image format/i.test(msg)) return new PermanentError('unsupported_format');
  return new PermanentError('decode_failed');
}

// Downscaled JPEG rendition of an already canonical JPEG (review, thumb, medium). Never withMetadata.
export async function rendition(canonical: Buffer, longEdge: number, quality: number): Promise<Buffer> {
  try {
    return await sharp(canonical, INPUT)
      .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, progressive: true })
      .toBuffer();
  } catch (e) {
    throw decodeError(e);
  }
}

export default sharp;
