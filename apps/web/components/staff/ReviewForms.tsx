'use client';

import { useId, useState, type FormEvent } from 'react';
import { STUDENT_CATEGORIES, type RejectReason, type StaffItemRow } from '@recover/shared/dto.ts';
import type { StaffMeta } from '../../lib/staff.ts';
import { Button } from '@/components/ui/button.tsx';
import { IconCheck, IconX } from '@/components/ui/icons.tsx';
import { Select } from '@/components/ui/select.tsx';
import { TextArea } from '@/components/ui/text-area.tsx';
import { REJECT_REASONS, STAFF_POST_CATEGORIES } from './constants.ts';
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
  const categories = item.postedByKind === 'student' ? STUDENT_CATEGORIES : STAFF_POST_CATEGORIES;
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

  const formId = `edit-${item.id}`;
  return (
    <form onSubmit={submit} className="stack review-panel" aria-label={submitLabel}>
      <TextArea
        id={`${formId}-desc`}
        label="Description"
        hint="This text is public: remove names, phone numbers, and other personal details."
        required
        minLength={2}
        maxLength={120}
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        autoFocus
      />
      <div className="grid">
        <Select
          id={`${formId}-cat`}
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          options={categories.map((c) => ({ value: c, label: categoryLabel(c) }))}
        />
        <Select
          id={`${formId}-zone`}
          label="Public zone"
          value={zoneId}
          onChange={(e) => setZoneId(e.target.value)}
          disabled={!zonesEditable}
          hint={!zonesEditable ? 'Zones can only be changed for pins on the active map.' : undefined}
          placeholder="No zone label"
          options={(meta?.zones ?? []).map((z) => ({ value: z.id, label: z.name }))}
        />
        <Select id={`${formId}-dropoff`} label="Drop-off location" value={dropoff} onChange={(e) => setDropoff(e.target.value)}>
          {!hasCurrentDropoff ? <option value={item.dropoffLocationId}>Current (inactive) location</option> : null}
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={busy} icon={<IconCheck />}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Reject with a required reason (§5.3 step 4). Choosing the reason and confirming is the confirm step.
export function RejectForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: RejectReason) => void }) {
  const [reason, setReason] = useState<RejectReason | ''>('');
  const id = useId();
  return (
    <form
      className="stack review-panel review-panel-danger"
      aria-label="Reject item"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason) onSubmit(reason);
      }}
    >
      <Select id={`${id}-reason`} label="Reason (required)" required autoFocus value={reason} onChange={(e) => setReason(e.target.value as RejectReason)}>
        <option value="" disabled>
          Choose a reason
        </option>
        {REJECT_REASONS.map((r) => (
          <option key={r} value={r}>
            {REJECT_REASON_LABELS[r]}
          </option>
        ))}
      </Select>
      <p className="small muted" style={{ margin: 0 }}>
        A rejected post stays hidden for good, and its photos are deleted after the review window.
      </p>
      <div className="button-row">
        <Button type="submit" variant="danger" disabled={!reason || busy} icon={<IconX />}>
          Confirm reject
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
