'use client';
// Photo step (§5.1 step 3): three slots, each with retake and remove. Capture uses a native file input
// (capture="environment" is UX friction only, §13.1); every image is re-encoded to JPEG before upload.
import { useRef, useState, type ChangeEvent } from 'react';
import { PhotoError, toJpeg, type Photo } from './photo.ts';

export function PhotoSlots({
  photos,
  onChange,
  itemLabel,
}: {
  photos: (Photo | null)[];
  onChange: (next: (Photo | null)[]) => void;
  itemLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const target = useRef(0);
  const [busy, setBusy] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstEmpty = photos.findIndex((p) => p === null);

  function pick(slot: number) {
    target.current = slot;
    setError(null);
    inputRef.current?.click();
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again must still fire change
    if (!file) return;
    const slot = target.current;
    setBusy(slot);
    setStatus(`Preparing photo ${slot + 1}.`);
    try {
      const photo = await toJpeg(file);
      const next = [...photos];
      const old = next[slot];
      if (old) URL.revokeObjectURL(old.url);
      next[slot] = photo;
      onChange(next);
      setStatus(`Photo ${slot + 1} added.`);
    } catch (err) {
      setStatus('');
      setError(
        err instanceof PhotoError && err.reason === 'too_large'
          ? 'That photo is too large. Please take it again with the camera.'
          : 'That photo could not be read. Please take a new photo with the camera.',
      );
    } finally {
      setBusy(null);
    }
  }

  function remove(slot: number) {
    const old = photos[slot];
    if (old) URL.revokeObjectURL(old.url);
    // Keep photos packed to the front so upload positions are always 0..n-1.
    const packed = photos.filter((p, i): p is Photo => p !== null && i !== slot);
    onChange([packed[0] ?? null, packed[1] ?? null, packed[2] ?? null]);
    setStatus(`Photo ${slot + 1} removed.`);
  }

  return (
    <div className="stack">
      <ul className="photo-slots" aria-label="Photos" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {photos.map((p, i) => (
          <li key={i} className="stack">
            <div className="photo-slot">
              {p ? (
                <img src={p.url} alt={`Photo ${i + 1} of the ${itemLabel.toLowerCase()}`} />
              ) : (
                <span className="small muted" style={{ padding: '0.25rem', textAlign: 'center' }}>
                  {busy === i ? 'Preparing...' : `Photo ${i + 1}${i === 0 ? '' : ' (optional)'}`}
                </span>
              )}
            </div>
            {p ? (
              <>
                <button type="button" className="btn btn-block" onClick={() => pick(i)} disabled={busy !== null} aria-label={`Retake photo ${i + 1}`}>
                  Retake
                </button>
                <button type="button" className="btn btn-ghost btn-block" onClick={() => remove(i)} disabled={busy !== null} aria-label={`Remove photo ${i + 1}`}>
                  Remove
                </button>
              </>
            ) : i === firstEmpty ? (
              <button type="button" className="btn btn-primary btn-block" onClick={() => pick(i)} disabled={busy !== null}>
                {i === 0 ? 'Take photo' : 'Add photo'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <p className="small" aria-live="polite">
        {status}
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
