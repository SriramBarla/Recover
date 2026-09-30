'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { MAP_REJECT_REASONS } from './constants.ts';
import { MAP_REJECT_REASON_LABELS, fmtDateTime } from './format.ts';
import { MapCanvas } from './MapCanvas.tsx';
import type { PendingMap } from './shapes.ts';

// District safety review of submitted maps (§5.6, G-07). The preview streams through a map.read
// ticket; activation is a district-scope map.activate ticket redeemed by the worker, which copies
// only the approved image to the public bucket. Activation needs a recent sign-in (G-31).
export function MapApprovals({ maps }: { maps: PendingMap[] }) {
  const router = useRouter();
  const [done, setDone] = useState<Record<string, string>>({});

  if (maps.length === 0) return <p className="muted">No maps are waiting for approval.</p>;

  return (
    <ul className="stack-lg" style={{ listStyle: 'none', padding: 0 }}>
      {maps.map((m) => (
        <li key={m.id}>
          <MapReview
            m={m}
            outcome={done[m.id] ?? null}
            onDone={(message) => {
              setDone((p) => ({ ...p, [m.id]: message }));
              router.refresh();
            }}
          />
        </li>
      ))}
    </ul>
  );
}

function MapReview({ m, outcome, onDone }: { m: PendingMap; outcome: string | null; onDone: (message: string) => void }) {
  const [reason, setReason] = useState<(typeof MAP_REJECT_REASONS)[number] | ''>('');
  const code = m.schoolCode;
  return (
    <article className="card stack" aria-labelledby={`map-${m.id}`}>
      <div className="spread">
        <h2 id={`map-${m.id}`} style={{ fontSize: '1.15rem' }}>
          {m.schoolName ?? code ?? 'School'} <span className="mono muted small">{code}</span>
        </h2>
        <span className="small muted">Submitted {fmtDateTime(m.submittedAt)}</span>
      </div>
      {code ? (
        <MapCanvas src={`/api/staff/${code}/maps/${m.id}/image`} alt={`Submitted map for ${m.schoolName ?? code}`} width={m.width} height={m.height} zones={m.zones} maxWidth="56rem" />
      ) : (
        <p className="muted">Preview unavailable: the school code is missing.</p>
      )}
      <div className="stack">
        <h3>Public zone labels ({m.zones.length})</h3>
        {m.zones.length === 0 ? (
          <p className="muted">No zones.</p>
        ) : (
          <ul className="chips" style={{ listStyle: 'none', padding: 0 }}>
            {m.zones.map((z) => (
              <li key={z.id} className="badge">
                {z.name}
              </li>
            ))}
          </ul>
        )}
        <p className="hint">Check that no label names a restroom, the clinic, counseling, a special program room, or a security area.</p>
      </div>
      {outcome ? (
        <div className="notice notice-ok" role="status">
          {outcome}
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <ConfirmButton
            label="Activate"
            prompt="Activate this map for students? It replaces the current public map, and the previous version is retired. Needs a recent sign-in."
            confirmLabel="Activate map"
            disabled={!code}
            onConfirm={async () => {
              await staffApi(`/api/district/maps/${m.id}/activate`, { body: { schoolCode: code } });
              onDone('Activated.');
            }}
          />
          <ConfirmButton
            label="Send back"
            prompt="Send this map back to the school?"
            confirmLabel="Send back"
            danger
            confirmDisabled={!reason}
            onConfirm={async () => {
              await staffApi(`/api/district/maps/${m.id}/reject`, { body: { reason } });
              onDone('Sent back to the school.');
            }}
          >
            <label className="field">
              <span className="label">Reason</span>
              <select className="select" value={reason} onChange={(e) => setReason(e.target.value as (typeof MAP_REJECT_REASONS)[number])}>
                <option value="" disabled>
                  Choose a reason
                </option>
                {MAP_REJECT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {MAP_REJECT_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </ConfirmButton>
        </div>
      )}
    </article>
  );
}
