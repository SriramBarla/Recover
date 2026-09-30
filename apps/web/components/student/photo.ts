// Client-side resize and JPEG re-encode (§9.2: a bandwidth optimization only; the worker canonicalizes the
// bytes regardless). Long edge <= 1600 px, quality 0.82, stepping down only when the result would exceed
// the 1 MiB incoming bucket limit. The output is always JPEG, so HEIC never leaves the device (G-25).

export type Photo = { blob: Blob; url: string; width: number; height: number };

const MAX_BYTES = 1_000_000; // incoming bucket limit is 1 MiB; stay under it with margin
const MAX_INPUT_BYTES = 40_000_000;
const PLAN: [number, number][] = [
  [1600, 0.82],
  [1600, 0.72],
  [1280, 0.72],
  [1024, 0.68],
];

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decodeWithImage(file: Blob): Promise<Decoded> {
  // <img> applies EXIF orientation by default (CSS image-orientation: from-image).
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    for (const opts of [{ imageOrientation: 'from-image' } as ImageBitmapOptions, undefined]) {
      try {
        const bmp = opts ? await createImageBitmap(file, opts) : await createImageBitmap(file);
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      } catch {
        // older engines reject the option or the format; try the next decoder
      }
    }
  }
  return decodeWithImage(file);
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export class PhotoError extends Error {
  readonly reason: 'unreadable' | 'too_large';
  constructor(reason: 'unreadable' | 'too_large') {
    super(reason);
    this.name = 'PhotoError';
    this.reason = reason;
  }
}

export async function toJpeg(file: Blob): Promise<Photo> {
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('too_large');
  let img: Decoded;
  try {
    img = await decode(file);
  } catch {
    throw new PhotoError('unreadable');
  }
  const canvas = document.createElement('canvas');
  try {
    if (!(img.width > 0 && img.height > 0)) throw new PhotoError('unreadable');
    for (const [edge, quality] of PLAN) {
      const k = Math.min(1, edge / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * k));
      const height = Math.max(1, Math.round(img.height * k));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new PhotoError('unreadable');
      ctx.drawImage(img.source, 0, 0, width, height);
      const blob = await toBlob(canvas, quality);
      if (blob && blob.type === 'image/jpeg' && blob.size <= MAX_BYTES) {
        return { blob, url: URL.createObjectURL(blob), width, height };
      }
    }
    throw new PhotoError('too_large');
  } finally {
    img.close();
    canvas.width = 0; // release the backing store early (mobile canvas memory limits)
    canvas.height = 0;
  }
}
