'use client';
// Photo step (§5.1 step 3): up to three photos, each with retake and remove, shown with the design
// system's PhotoCapture. Capture uses a native file input (capture="environment" is UX friction only,
// §13.1); every image is re-encoded to JPEG before it enters state, and photos stay packed to the
// front so upload positions are always 0..n-1.
import { useState } from 'react';
import { PhotoCapture } from '@/components/ui/photo-capture.tsx';
import { PhotoError, toJpeg, type Photo } from './photo.ts';

const MAX = 3;

function packed(list: Photo[]): (Photo | null)[] {
  return Array.from({ length: MAX }, (_, i) => list[i] ?? null);
}

export function PhotoSlots({
  photos,
  onChange,
  itemLabel,
}: {
  photos: (Photo | null)[];
  onChange: (next: (Photo | null)[]) => void;
  itemLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = photos.filter((p): p is Photo => p !== null);

  async function convert(file: File): Promise<Photo | null> {
    try {
      return await toJpeg(file);
    } catch (err) {
      setError(
        err instanceof PhotoError && err.reason === 'too_large'
          ? 'That photo is too large. Please take it again with the camera.'
          : 'That photo could not be read. Please take a new photo with the camera.',
      );
      return null;
    }
  }

  async function add(files: File[]) {
    setError(null);
    setBusy(true);
    const next = [...list];
    for (const file of files) {
      if (next.length >= MAX) break;
      setStatus(`Preparing photo ${next.length + 1}.`);
      const photo = await convert(file);
      if (photo) next.push(photo);
    }
    setBusy(false);
    if (next.length > list.length) {
      onChange(packed(next));
      setStatus(`Photo ${next.length} added.`);
    } else {
      setStatus('');
    }
  }

  async function replace(slot: number, file: File) {
    setError(null);
    setBusy(true);
    setStatus(`Preparing photo ${slot + 1}.`);
    const photo = await convert(file);
    setBusy(false);
    if (!photo) {
      setStatus('');
      return;
    }
    const next = [...list];
    const old = next[slot];
    if (old) URL.revokeObjectURL(old.url);
    next[slot] = photo;
    onChange(packed(next));
    setStatus(`Photo ${slot + 1} added.`);
  }

  function remove(slot: number) {
    const old = list[slot];
    if (old) URL.revokeObjectURL(old.url);
    onChange(packed(list.filter((_, i) => i !== slot)));
    setStatus(`Photo ${slot + 1} removed.`);
  }

  return (
    <div className="stack-sm">
      <PhotoCapture
        photos={list.map((p) => ({ key: p.url, previewUrl: p.url }))}
        onAdd={(files) => void add(files)}
        onReplace={(slot, file) => void replace(slot, file)}
        onRemove={remove}
        max={MAX}
        disabled={busy}
        announce={false}
        label={`Photos of the ${itemLabel.toLowerCase()}`}
        hint="Take 1 to 3 clear photos. Keep faces, names and ID numbers out of the picture."
        error={error}
      />
      <p className="small muted" aria-live="polite">
        {status}
      </p>
      {error ? (
        <p className="visually-hidden" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
