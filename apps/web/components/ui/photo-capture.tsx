'use client';
// PhotoCapture: the presentational slot UI for 1 to 3 photos (§5.1 step 3). The page owns
// resizing, blob: previews, and uploads; this component owns the file input, the slots, the
// retake and remove controls, focus after changes, and short announcements.
// Callbacks: onAdd(files) for new photos (fill the next empty slots), onReplace(index, file) for
// a retake, onRemove(index), and onRetry(index) for a failed upload.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx, describedBy } from './cx.ts';
import { FieldError } from './field.tsx';
import { IconAlertCircle, IconCamera, IconCheck, IconRefresh, IconTrash } from './icons.tsx';

export type PhotoStatus = 'ready' | 'processing' | 'uploading' | 'uploaded' | 'error';

export type CapturedPhoto = {
  key: string;
  previewUrl: string;
  status?: PhotoStatus;
  // 0..100 while uploading.
  progress?: number;
  error?: string;
};

export type PhotoCaptureProps = {
  photos: readonly CapturedPhoto[];
  onAdd: (files: File[]) => void;
  onReplace: (index: number, file: File) => void;
  onRemove: (index: number) => void;
  onRetry?: (index: number) => void;
  max?: number;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  // 'environment' opens the rear camera on phones; false lets people pick from their library.
  capture?: 'environment' | 'user' | false;
  accept?: string;
  id?: string;
  className?: string;
};

function StatusOverlay({ photo, n }: { photo: CapturedPhoto; n: number }) {
  const s = photo.status ?? 'ready';
  if (s === 'ready') return null;
  if (s === 'error') {
    return (
      <span className="photo-status" data-status="error">
        <IconAlertCircle size={14} />
        {photo.error ?? 'Upload failed'}
      </span>
    );
  }
  if (s === 'uploaded') {
    return (
      <span className="photo-status" data-status="uploaded">
        <IconCheck size={14} />
        Uploaded
      </span>
    );
  }
  const label = s === 'processing' ? 'Preparing' : 'Uploading';
  return (
    <span className="photo-status" data-status={s}>
      <span className="btn-spinner" aria-hidden="true" />
      {label}
      {s === 'uploading' && photo.progress !== undefined ? (
        <progress className="progress-bar" max={100} value={photo.progress} aria-label={`Photo ${n} upload progress`} />
      ) : null}
    </span>
  );
}

export function PhotoCapture({
  photos,
  onAdd,
  onReplace,
  onRemove,
  onRetry,
  max = 3,
  label = 'Photos',
  hint = 'Add 1 to 3 clear photos of the item. Keep faces, names, and screens out of the shot.',
  error,
  disabled = false,
  capture = 'environment',
  accept = 'image/*',
  id,
  className,
}: PhotoCaptureProps) {
  const autoId = useId();
  const base = id ?? autoId;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const target = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<number | null>(null);
  const [message, setMessage] = useState('');
  const count = Math.min(photos.length, max);
  const hasError = error !== undefined && error !== null && error !== false && error !== '';

  // After a remove or retake, put focus back on the slot the person was working on.
  useEffect(() => {
    const i = focusAfter.current;
    if (i === null || !listRef.current) return;
    focusAfter.current = null;
    const item = listRef.current.querySelectorAll<HTMLElement>('.photo-item')[Math.min(i, count)];
    item?.querySelector<HTMLElement>('button')?.focus();
  }, [photos, count]);

  function pick(index: number | null) {
    if (disabled) return;
    target.current = index;
    const input = inputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  }

  function onFiles(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    const i = target.current;
    if (i === null) {
      const room = Math.max(0, max - count);
      const taken = files.slice(0, room);
      if (taken.length === 0) return;
      onAdd(taken);
      setMessage(taken.length === 1 ? `Photo ${count + 1} added.` : `${taken.length} photos added.`);
    } else {
      const f = files[0];
      if (!f) return;
      onReplace(i, f);
      focusAfter.current = i;
      setMessage(`Photo ${i + 1} replaced.`);
    }
  }

  function remove(i: number) {
    onRemove(i);
    focusAfter.current = i;
    setMessage(`Photo ${i + 1} removed. ${Math.max(0, count - 1)} of ${max} photos.`);
  }

  const slots = Array.from({ length: max }, (_, i) => i);

  return (
    <fieldset
      className={cx('fieldset', 'photo-capture', className)}
      aria-describedby={describedBy(hasError && errorId, hint ? hintId : null)}
      disabled={disabled}
    >
      <legend>{label}</legend>
      <div className="stack-sm">
        {hint ? (
          <p className="hint" id={hintId}>
            {hint}
          </p>
        ) : null}
        {hasError ? <FieldError id={errorId}>{error}</FieldError> : null}
        <ul className="photo-slots" ref={listRef}>
          {slots.map((i) => {
            const photo = i < count ? photos[i] : undefined;
            const n = i + 1;
            if (photo) {
              const failed = photo.status === 'error';
              const busy = photo.status === 'processing' || photo.status === 'uploading';
              return (
                <li key={photo.key} className="photo-item">
                  <div className="photo-slot" data-filled="true" data-status={photo.status}>
                    <img src={photo.previewUrl} alt={`Photo ${n}`} width={300} height={300} />
                    <StatusOverlay photo={photo} n={n} />
                  </div>
                  <div className="photo-actions">
                    {failed && onRetry ? (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => onRetry(i)} aria-label={`Retry photo ${n}`}>
                        <IconRefresh size={16} />
                        <span className="btn-label">Retry</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => pick(i)}
                        aria-label={`Retake photo ${n}`}
                        disabled={busy}
                      >
                        <IconCamera size={16} />
                        <span className="btn-label">Retake</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => remove(i)}
                      aria-label={`Remove photo ${n}`}
                      disabled={busy}
                    >
                      <IconTrash size={16} />
                      <span className="btn-label">Remove</span>
                    </button>
                  </div>
                </li>
              );
            }
            if (i === count) {
              return (
                <li key={`add-${i}`} className="photo-item">
                  <button type="button" className="photo-slot photo-slot-add" onClick={() => pick(null)}>
                    <IconCamera />
                    <span>{count === 0 ? 'Take photo' : 'Add photo'}</span>
                    <span className="photo-slot-sub">
                      {n} of {max}
                      {n > 1 ? ' (optional)' : ''}
                    </span>
                  </button>
                </li>
              );
            }
            return (
              <li key={`empty-${i}`} className="photo-item" aria-hidden="true">
                <div className="photo-slot" data-empty="true">
                  {n}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="hint" aria-hidden="true">
          {count} of {max} photos
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture === false ? undefined : capture}
        multiple={capture === false}
        hidden
        tabIndex={-1}
        onChange={(e) => onFiles(e.target.files)}
      />
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {message}
      </div>
    </fieldset>
  );
}
