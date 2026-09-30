'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HIGH_VALUE_CATEGORIES, type Category, type UploadSpec } from '@recover/shared/dto.ts';
import type { StaffMeta } from '../../lib/staff.ts';
import { ActionError } from './ActionError.tsx';
import { ApiError, newKey, staffApi } from './client-api.ts';
import { STAFF_POST_CATEGORIES } from './constants.ts';
import { categoryLabel } from './format.ts';
import { PhotoPrepError, putWithRetry, toJpeg } from './image-prep.ts';
import { MapCanvas, type Point } from './MapCanvas.tsx';

type Props = { code: string; mode: 'staff' | 'backfill'; meta: StaffMeta | null };
type Pending = { itemId: string; publicId: string; uploads: UploadSpec[]; blobs: Blob[] };
type Stage = 'idle' | 'preparing' | 'creating' | 'uploading' | 'completing';

const STAGE_TEXT: Record<Stage, string> = {
  idle: '',
  preparing: 'Preparing photos...',
  creating: 'Creating the item...',
  uploading: 'Uploading photos...',
  completing: 'Finishing...',
};

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the counter simply resets
  }
}

// Trusted staff post and backfill (G-08; §5.3.2; §24 step 5): create -> presigned PUTs -> complete.
// The item starts approved/hidden; canonicalization and advisory screening still run before
// anything is public. Backfill keeps the shelf location and an items-per-hour counter per session.
export function PostForm({ code, mode, meta }: Props) {
  const backfill = mode === 'backfill';
  const locKey = `recover:${code}:backfill-location`;
  const logKey = `recover:${code}:backfill-log`;
  const locations = meta?.locations ?? [];
  const [category, setCategory] = useState<Category | ''>('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [locationId, setLocationId] = useState('');
  const [pin, setPin] = useState<Point | null>(null);
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [last, setLast] = useState<{ itemId: string; publicId: string } | null>(null);
  const [log, setLog] = useState<number[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const idem = useRef<string | null>(null);
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    if (backfill) {
      const saved = readStore<string>(locKey, '');
      if (saved && locations.some((l) => l.id === saved)) setLocationId(saved);
      setLog(readStore<number[]>(logKey, []).filter((t) => typeof t === 'number'));
    }
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      window.clearInterval(t);
      for (const f of filesRef.current) URL.revokeObjectURL(f.url);
    };
    // Mount only: restores the backfill session from sessionStorage once.
  }, []);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = [...list].slice(0, Math.max(0, 3 - files.length)).map((file) => ({ file, url: URL.createObjectURL(file) }));
    setFiles((prev) => [...prev, ...incoming].slice(0, 3));
  };

  const removeFile = (i: number) =>
    setFiles((prev) => {
      const f = prev[i];
      if (f) URL.revokeObjectURL(f.url);
      return prev.filter((_, j) => j !== i);
    });

  const pickLocation = (id: string) => {
    setLocationId(id);
    if (backfill) writeStore(locKey, id);
  };

  const reset = () => {
    for (const f of files) URL.revokeObjectURL(f.url);
    setFiles([]);
    setDescription('');
    setNote('');
    setPin(null);
    setCategory('');
    setPending(null);
    idem.current = null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!pending && (!category || description.trim().length < 2 || !locationId || files.length === 0)) {
      setError(new ApiError('invalid_input', 'Choose a category and location, describe the item (at least 2 characters), and add at least one photo.', 400));
      return;
    }
    try {
      let p = pending;
      if (!p) {
        setStage('preparing');
        const blobs = await Promise.all(files.map((f) => toJpeg(f.file)));
        setStage('creating');
        idem.current ??= newKey();
        const created = await staffApi<{ itemId: string; publicId: string; uploads: UploadSpec[] }>(`/api/staff/${code}/items`, {
          idempotencyKey: idem.current,
          body: {
            mode,
            category,
            description,
            note: note.trim() ? note : null,
            locationId,
            photoCount: blobs.length,
            mapVersionId: pin && meta?.map ? meta.map.versionId : null,
            pinX: pin && meta?.map ? pin.x : null,
            pinY: pin && meta?.map ? pin.y : null,
          },
        });
        p = { itemId: created.itemId, publicId: created.publicId, uploads: Array.isArray(created.uploads) ? created.uploads : [], blobs };
        setPending(p);
      }
      setStage('uploading');
      for (const u of p.uploads) {
        const blob = p.blobs[u.position];
        if (blob) await putWithRetry(u.url, blob);
      }
      setStage('completing');
      await staffApi(`/api/staff/${code}/items/${p.itemId}/complete`, { body: {} });
      setLast({ itemId: p.itemId, publicId: p.publicId });
      if (backfill) {
        const next = [...readStore<number[]>(logKey, []), Date.now()].slice(-500);
        writeStore(logKey, next);
        setLog(next);
        setNowMs(Date.now());
      }
      reset();
    } catch (err) {
      if (err instanceof PhotoPrepError) setError(new ApiError('invalid_input', err.message, 400));
      else if (err instanceof Error && err.message === 'upload_rejected')
        setError(new ApiError('upstream_unavailable', 'The upload link was refused or has expired. Open the item, delete it, and post again.', 503));
      else if (err instanceof Error && err.message === 'upload_failed')
        setError(new ApiError('upstream_unavailable', 'Photo upload failed. Check the connection and press Retry upload.', 503));
      else setError(err);
    } finally {
      setStage('idle');
    }
  };

  const busy = stage !== 'idle';
  const hourAgo = nowMs - 3_600_000;
  const lastHour = log.filter((t) => t >= hourAgo).length;
  const first = log[0];
  const hours = first && nowMs ? Math.max(1 / 60, (nowMs - first) / 3_600_000) : 0;
  const rate = hours > 0 ? Math.round(log.length / hours) : 0;
  const highValue = category !== '' && HIGH_VALUE_CATEGORIES.includes(category);

  return (
    <div className="stack-lg">
      {backfill ? (
        <div className="kpis" aria-label="Backfill session">
          <div className="kpi">
            <div className="value">{log.length}</div>
            <div className="label">Items this session</div>
          </div>
          <div className="kpi">
            <div className="value">{lastHour}</div>
            <div className="label">In the last hour</div>
          </div>
          <div className="kpi">
            <div className="value">{rate}</div>
            <div className="label">Items per hour</div>
          </div>
          <div className="kpi">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                writeStore(logKey, []);
                setLog([]);
              }}
            >
              Reset counter
            </button>
          </div>
        </div>
      ) : null}

      <p className="visually-hidden" role="status" aria-live="polite">
        {busy ? STAGE_TEXT[stage] : last ? `Posted ${last.publicId}.` : ''}
      </p>
      {last ? (
        <div className="notice notice-ok">
          Posted <strong className="mono">{last.publicId}</strong>. It is published after photo processing and screening.{' '}
          <a href={`/staff/${code}/items/${last.itemId}`}>Open item</a>
        </div>
      ) : null}

      <form onSubmit={submit} className="card stack-lg" aria-label={backfill ? 'Backfill item' : 'Post a found item'}>
        <fieldset className="stack" disabled={busy || pending !== null} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field">
            <span className="label">Category</span>
            <select className="select" required value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              <option value="" disabled>
                Choose a category
              </option>
              {STAFF_POST_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
            {highValue ? (
              <span className="hint">High-value item: use a plain photo and generic text (for example "black phone"). Keep serial numbers, names, and other proof-of-ownership details out of view.</span>
            ) : (
              <span className="hint">ID cards and medication are handled at the office and are not posted.</span>
            )}
          </label>
          <label className="field">
            <span className="label">Description (public)</span>
            <input className="input" required minLength={2} maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="navy metal water bottle" />
            <span className="hint">{description.length}/120. Describe the item, not the owner. No names or contact details.</span>
          </label>
          <label className="field">
            <span className="label">{backfill ? 'Shelf location (kept for this session)' : 'Where is it now?'}</span>
            <select className="select" required value={locationId} onChange={(e) => pickLocation(e.target.value)}>
              <option value="" disabled>
                Choose a location
              </option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Staff-only note (optional)</span>
            <input className="input" maxLength={80} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Found in C214" />
          </label>

          <div className="stack">
            <span className="label">Photos (1 to 3)</span>
            <div className="photo-slots">
              {[0, 1, 2].map((i) => {
                const f = files[i];
                return (
                  <div key={i} className="photo-slot">
                    {f ? (
                      <>
                        <img src={f.url} alt={`Photo ${i + 1} preview`} />
                        <button type="button" className="btn" style={{ position: 'absolute', bottom: 4, right: 4 }} onClick={() => removeFile(i)} aria-label={`Remove photo ${i + 1}`}>
                          Remove
                        </button>
                      </>
                    ) : (
                      <span className="muted small">Empty</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="row">
              <label className="btn">
                Take photo
                <input
                  className="visually-hidden"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  capture="environment"
                  disabled={files.length >= 3}
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
              <label className="btn">
                Choose files
                <input
                  className="visually-hidden"
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  disabled={files.length >= 3}
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            <span className="hint">Photos are resized and converted to JPEG on this device, then checked again on the server.</span>
          </div>

          {!backfill ? (
            <div className="stack">
              <span className="label">Where it was found (optional, staff only)</span>
              {meta?.map?.url ? (
                <>
                  <MapCanvas src={meta.map.url} alt="Campus map" width={meta.map.width} height={meta.map.height} zones={meta.zones} picked={pin} onPick={setPin} pickLabel="found location" maxWidth="36rem" />
                  {pin ? (
                    <button type="button" className="btn btn-ghost" onClick={() => setPin(null)}>
                      Clear pin
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="muted small">This school has no active map yet, so items are posted without a pin.</p>
              )}
            </div>
          ) : null}
        </fieldset>

        <div className="row">
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? STAGE_TEXT[stage] : pending ? 'Retry upload' : backfill ? 'Post and next' : 'Post item'}
          </button>
          {pending && !busy ? (
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Start over
            </button>
          ) : null}
        </div>
        {pending && !busy ? (
          <p className="hint">
            Item <span className="mono">{pending.publicId}</span> was created but its photos did not finish uploading. Retry, or{' '}
            <a href={`/staff/${code}/items/${pending.itemId}`}>open it</a> to delete it.
          </p>
        ) : null}
        <ActionError error={error} />
      </form>
    </div>
  );
}
