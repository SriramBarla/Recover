// Browser-side photo preparation for staff posts: decode, resize, and re-encode as JPEG under the
// 1 MiB incoming limit (contract section 8; G-25: no HEIC upload, the client converts to JPEG).
// This is a bandwidth optimization only; the worker canonicalizes every upload (§5.1 step 3).

export const MAX_UPLOAD_BYTES = 1024 * 1024;

export class PhotoPrepError extends Error {
  readonly reason: 'not_image' | 'decode' | 'too_big';
  constructor(reason: 'not_image' | 'decode' | 'too_big') {
    super(
      reason === 'not_image'
        ? 'That file is not a photo.'
        : reason === 'decode'
          ? 'This browser cannot read that photo format. Take the photo again or use a JPEG or PNG.'
          : 'That photo is too large even after shrinking it.',
    );
    this.name = 'PhotoPrepError';
    this.reason = reason;
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function toJpeg(file: File, maxEdge = 1600, maxBytes = MAX_UPLOAD_BYTES - 4096): Promise<Blob> {
  if (file.type && !file.type.startsWith('image/')) throw new PhotoPrepError('not_image');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoPrepError('decode');
  }
  try {
    let edge = maxEdge;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new PhotoPrepError('decode');
      ctx.drawImage(bitmap, 0, 0, w, h);
      for (const q of [0.85, 0.75, 0.65]) {
        const blob = await toBlob(canvas, q);
        if (blob && blob.size <= maxBytes) return blob;
      }
      edge = Math.round(edge * 0.75);
    }
    throw new PhotoPrepError('too_big');
  } finally {
    bitmap.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PUT to a presigned URL with up to three attempts; 4xx responses (for example an expired
// signature) are not retried.
export async function putWithRetry(url: string, body: Blob, headers: Record<string, string> = {}): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'PUT', body, headers: { 'content-type': 'image/jpeg', ...headers }, credentials: 'omit' });
      if (res.ok) return;
      lastStatus = res.status;
      if (res.status >= 400 && res.status < 500) break;
    } catch {
      lastStatus = 0;
    }
    await sleep(600 * 2 ** attempt);
  }
  throw new Error(lastStatus >= 400 && lastStatus < 500 ? 'upload_rejected' : 'upload_failed');
}
