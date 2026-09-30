'use client';

import { useState } from 'react';
import type { StaffItemRow } from '@recover/shared/dto.ts';

const VIEWABLE = new Set(['canonical_ready', 'public_ready']);

// Canonical private review renditions streamed through the authenticated no-store gateway (§5.3
// step 3). Quarantined items start blurred (G-24). Raw uploads are never shown: until a photo is
// canonical there is nothing to look at.
export function ItemPhotos({ code, item, blurred = false }: { code: string; item: StaffItemRow; blurred?: boolean }) {
  const [reveal, setReveal] = useState(!blurred);
  const photos = item.photos.filter((p) => p.isCurrent && p.status !== 'deleted').sort((a, b) => a.position - b.position);
  if (photos.length === 0) return <p className="muted small">No photos.</p>;
  const label = item.publicId ?? 'this item';
  return (
    <div className="stack">
      <div className="photo-slots" style={{ gridTemplateColumns: `repeat(${Math.min(3, photos.length)}, 1fr)` }}>
        {photos.map((p) => {
          const src = `/api/staff/${code}/items/${item.id}/photos/${p.photoId}`;
          if (!VIEWABLE.has(p.status)) {
            return (
              <div key={p.photoId} className="photo-slot" style={{ borderStyle: 'solid', aspectRatio: '4 / 3' }}>
                <span className={p.status === 'failed' ? 'badge badge-danger' : 'badge'}>{p.status === 'failed' ? 'Photo failed' : 'Processing photo'}</span>
              </div>
            );
          }
          return (
            <a key={p.photoId} href={reveal ? `${src}?full=1` : undefined} target="_blank" rel="noopener" className="photo-slot" style={{ borderStyle: 'solid', aspectRatio: '4 / 3', background: 'var(--surface-2)' }}>
              <img
                src={src}
                alt={`Photo ${p.position + 1} of ${label}`}
                loading="lazy"
                decoding="async"
                style={{ objectFit: 'contain', filter: reveal ? undefined : 'blur(28px)' }}
              />
            </a>
          );
        })}
      </div>
      {!reveal ? (
        <button type="button" className="btn" onClick={() => setReveal(true)}>
          Show photos
        </button>
      ) : (
        <span className="hint">Select a photo to open it full size in a new tab.</span>
      )}
    </div>
  );
}
