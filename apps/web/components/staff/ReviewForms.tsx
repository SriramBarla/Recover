'use client';

import { useState, type FormEvent } from 'react';
import { STUDENT_CATEGORIES, type RejectReason, type StaffItemRow } from '@recover/shared/dto.ts';
import type { StaffMeta } from '../../lib/staff.ts';
import { ALL_CATEGORIES, REJECT_REASONS } from './constants.ts';
import { REJECT_REASON_LABELS, categoryLabel } from './format.ts';

// Edits for approve-with-edits and for editing an approved item (contract 6.2 p_edits: description,
// category, zoneId, dropoffLocationId). Only changed fields are sent; null means no edits.
export function EditForm({
  item,
  meta,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  item: StaffItemRow;
  meta: StaffMeta | null;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (edits: Record<string, unknown> | null) => void;
}) {
  const categories = item.postedByKind === 'student' ? STUDENT_CATEGORIES : ALL_CATEGORIES;
  const [description, setDescription] = useState(item.description ?? '');
  const [category, setCategory] = useState<string>(item.category);
  const [zoneId, setZoneId] = useState(item.zoneId ?? '');
  const [dropoff, setDropoff] = useState(item.dropoffLocationId);
  // A zone must belong to the item's own map version (composite FK), so only pins on the active map
  // can take a zone from the active map's list.
  const zonesEditable = Boolean(meta?.map && item.mapVersionId && item.mapVersionId === meta.map.versionId);
  const locations = meta?.locations ?? [];
  const hasCurrentDropoff = locations.some((l) => l.id === item.dropoffLocationId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const edits: Record<string, unknown> = {};
    const d = description.replace(/\s+/g, ' ').trim();
    if (d !== (item.description ?? '')) edits.description = d;
    if (category !== item.category) edits.category = category;
    if (zonesEditable && (zoneId || null) !== (item.zoneId ?? null)) edits.zoneId = zoneId || null;
    if (dropoff !== item.dropoffLocationId) edits.dropoffLocationId = dropoff;
    onSubmit(Object.keys(edits).length > 0 ? edits : null);
  };

  return (
    <form onSubmit={submit} className="stack" aria-label={submitLabel} style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
      <label className="field">
        <span className="label">Description</span>
        <textarea className="textarea" required minLength={2} maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} autoFocus />
        <span className="hint">{description.length}/120. This text is public: remove names, phone numbers, and other personal details.</span>
      </label>
      <div className="grid">
        <label className="field">
          <span className="label">Category</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Public zone</span>
          <select className="select" value={zoneId} onChange={(e) => setZoneId(e.target.value)} disabled={!zonesEditable}>
            <option value="">No zone label</option>
            {(meta?.zones ?? []).map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
          {!zonesEditable ? <span className="hint">Zones can only be changed for pins on the active map.</span> : null}
        </label>
        <label className="field">
          <span className="label">Drop-off location</span>
          <select className="select" value={dropoff} onChange={(e) => setDropoff(e.target.value)}>
            {!hasCurrentDropoff ? <option value={item.dropoffLocationId}>Current (inactive) location</option> : null}
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Reject with a required reason (§5.3 step 4). Choosing the reason and confirming is the confirm step.
export function RejectForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: RejectReason) => void }) {
  const [reason, setReason] = useState<RejectReason | ''>('');
  return (
    <form
      className="notice notice-warn stack"
      aria-label="Reject item"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason) onSubmit(reason);
      }}
    >
      <label className="field">
        <span className="label">Reason (required)</span>
        <select className="select" required autoFocus value={reason} onChange={(e) => setReason(e.target.value as RejectReason)}>
          <option value="" disabled>
            Choose a reason
          </option>
          {REJECT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REJECT_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <p className="small" style={{ margin: 0 }}>
        A rejected post stays hidden for good, and its photos are deleted after the review window.
      </p>
      <div className="row">
        <button type="submit" className="btn btn-danger" disabled={!reason || busy}>
          Confirm reject
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
