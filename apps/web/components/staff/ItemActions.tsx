'use client';

import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import type { RejectReason, StaffItemRow } from '@recover/shared/dto.ts';
import type { StaffMeta } from '../../lib/staff.ts';
import { ActionError } from './ActionError.tsx';
import { ApiError, staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { BLOCK_REASONS, DELETE_REASONS, DISPOSITIONS, PULL_REASONS } from './constants.ts';
import { BLOCK_REASON_LABELS, DELETE_REASON_LABELS, PULL_REASON_LABELS } from './format.ts';
import { EditForm, RejectForm } from './ReviewForms.tsx';

export type ItemCan = {
  approve: boolean;
  receive: boolean;
  transfer: boolean;
  claim: boolean;
  dispose: boolean;
  pull: boolean;
  edit: boolean;
  del: boolean;
  confirmPublish: boolean;
  dropPhoto: boolean;
  block: boolean;
};

type Props = { code: string; item: StaffItemRow; can: ItemCan; meta: StaffMeta | null };

const TERMINAL = new Set(['claimed', 'expired_donated', 'expired_disposed']);

// Actions allowed for this role and state (§5.4, Appendix C). This is UI gating only; every
// transition is re-checked in SQL against the attested operation and the row_version.
export function ItemActions({ code, item, can, meta }: Props) {
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'approve-edit' | 'reject' | 'edit' | null>(null);
  const [notice, setNotice] = useState('');
  const locations = meta?.locations ?? [];
  const [receiveAt, setReceiveAt] = useState(locations.some((l) => l.id === item.dropoffLocationId) ? item.dropoffLocationId : (locations[0]?.id ?? ''));
  const [transferTo, setTransferTo] = useState(locations.find((l) => l.id !== item.currentLocationId)?.id ?? '');
  const [disposition, setDisposition] = useState<(typeof DISPOSITIONS)[number]>('donated');
  const [pullReason, setPullReason] = useState<(typeof PULL_REASONS)[number] | ''>('');
  const [deleteReason, setDeleteReason] = useState<(typeof DELETE_REASONS)[number] | ''>('');
  const [blockReason, setBlockReason] = useState<(typeof BLOCK_REASONS)[number] | ''>('');
  const [blockDays, setBlockDays] = useState(7);

  const base = `/api/staff/${code}/items/${item.id}`;

  // For plain buttons: run, then reload server data. ConfirmButton actions throw to show errors.
  const act = async (path: string, body: Record<string, unknown>, done: string, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') => {
    await staffApi(path, { method, body });
    setNotice(done);
    router.refresh();
  };

  const safely = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.code === 'state_changed') router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const rv = item.rowVersion;
  const pending = item.reviewStatus === 'pending';
  const canReceive = can.receive && (item.custody === 'with_finder' || item.custody === 'expired_never_arrived');
  const atLocation = item.custody === 'at_location';
  const held = item.flags.includes('hold');
  const photos = item.photos.filter((p) => p.isCurrent && p.status !== 'deleted').sort((a, b) => a.position - b.position);

  const sections: ReactElement[] = [];

  if (can.approve && pending) {
    sections.push(
      <section key="review" className="stack" aria-labelledby="act-review">
        <h3 id="act-review">Review</h3>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void safely(() => act(`${base}/approve`, { rowVersion: rv, edits: null }, 'Approved.'))}>
            Approve
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setPanel('approve-edit')}>
            Approve with edits
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setPanel('reject')}>
            Reject
          </button>
        </div>
        {panel === 'approve-edit' ? (
          <EditForm
            item={item}
            meta={meta}
            busy={busy}
            submitLabel="Approve with these edits"
            onCancel={() => setPanel(null)}
            onSubmit={(edits) => void safely(() => act(`${base}/approve`, { rowVersion: rv, edits }, 'Approved.'))}
          />
        ) : null}
        {panel === 'reject' ? (
          <RejectForm busy={busy} onCancel={() => setPanel(null)} onSubmit={(reason: RejectReason) => void safely(() => act(`${base}/reject`, { rowVersion: rv, reason }, 'Rejected.'))} />
        ) : null}
      </section>,
    );
  }

  if (canReceive || (can.transfer && atLocation) || (can.claim && atLocation) || (can.dispose && atLocation)) {
    sections.push(
      <section key="custody" className="stack" aria-labelledby="act-custody">
        <h3 id="act-custody">Custody</h3>
        {canReceive ? (
          <div className="row">
            <label className="field" style={{ minWidth: '14rem' }}>
              <span className="label">{item.custody === 'expired_never_arrived' ? 'Late check-in at' : 'Check in at'}</span>
              <select className="select" value={receiveAt} onChange={(e) => setReceiveAt(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              style={{ alignSelf: 'flex-end' }}
              disabled={busy || !receiveAt}
              onClick={() => void safely(() => act(`${base}/receive`, { rowVersion: rv, locationId: receiveAt }, 'Checked in.'))}
            >
              Check in
            </button>
            {item.custody === 'expired_never_arrived' ? <p className="hint">Late check-in is allowed within the school's grace window after the deadline passed.</p> : null}
          </div>
        ) : null}
        {can.transfer && atLocation ? (
          <div className="row">
            <label className="field" style={{ minWidth: '14rem' }}>
              <span className="label">Move to</span>
              <select className="select" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                {locations
                  .filter((l) => l.id !== item.currentLocationId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              style={{ alignSelf: 'flex-end' }}
              disabled={busy || !transferTo}
              onClick={() => void safely(() => act(`${base}/transfer`, { rowVersion: rv, locationId: transferTo }, 'Transferred.'))}
            >
              Transfer
            </button>
          </div>
        ) : null}
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {can.claim && atLocation ? (
            <ConfirmButton
              label="Mark claimed"
              prompt="Did you verify ownership in person with a detail that is not in the public listing (contents, unlock, hidden mark, exact place)?"
              confirmLabel="Yes, mark claimed"
              onConfirm={() => act(`${base}/claim`, { rowVersion: rv }, 'Marked claimed. The listing has been withdrawn.')}
            />
          ) : null}
          {can.dispose && atLocation ? (
            <ConfirmButton
              label="Record donation or disposal"
              prompt="Record that this item physically left the lost and found? This ends custody and withdraws the listing."
              confirmLabel="Record it"
              danger
              onConfirm={() => act(`${base}/dispose`, { rowVersion: rv, disposition }, 'Recorded.')}
            >
              <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label">What happened</legend>
                {DISPOSITIONS.map((d) => (
                  <label key={d} className="row small">
                    <input type="radio" name={`disp-${item.id}`} value={d} checked={disposition === d} onChange={() => setDisposition(d)} />
                    {d === 'donated' ? 'Donated' : 'Disposed of'}
                  </label>
                ))}
              </fieldset>
              {item.dispositionDueAt === null ? <p className="small">Retention has not ended yet; record this only under an authorized early policy.</p> : null}
            </ConfirmButton>
          ) : null}
        </div>
      </section>,
    );
  }

  if ((can.pull && item.publicationStatus === 'published') || (can.confirmPublish && held) || (can.edit && item.reviewStatus === 'approved' && !TERMINAL.has(item.custody))) {
    sections.push(
      <section key="publication" className="stack" aria-labelledby="act-pub">
        <h3 id="act-pub">Listing</h3>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {can.confirmPublish && held ? (
            <ConfirmButton
              label="Confirm and publish"
              prompt="Screening held this staff post. Publish it after checking the photos?"
              confirmLabel="Publish"
              onConfirm={() => act(`${base}/confirm-publish`, { rowVersion: rv }, 'Publishing.')}
            />
          ) : null}
          {can.edit && item.reviewStatus === 'approved' && !TERMINAL.has(item.custody) ? (
            <button type="button" className="btn" onClick={() => setPanel(panel === 'edit' ? null : 'edit')} aria-expanded={panel === 'edit'}>
              Edit details
            </button>
          ) : null}
          {can.pull && item.publicationStatus === 'published' ? (
            <ConfirmButton
              label="Pull listing"
              prompt="Withdraw this listing now? Public photos are deleted and caches are purged."
              confirmLabel="Pull it"
              danger
              confirmDisabled={!pullReason}
              onConfirm={() => act(`${base}/pull`, { rowVersion: rv, reason: pullReason }, 'Pulled.')}
            >
              <label className="field">
                <span className="label">Reason</span>
                <select className="select" value={pullReason} onChange={(e) => setPullReason(e.target.value as (typeof PULL_REASONS)[number])}>
                  <option value="" disabled>
                    Choose a reason
                  </option>
                  {PULL_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {PULL_REASON_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
            </ConfirmButton>
          ) : null}
        </div>
        {panel === 'edit' ? (
          <EditForm
            item={item}
            meta={meta}
            busy={busy}
            submitLabel="Save changes"
            onCancel={() => setPanel(null)}
            onSubmit={(edits) => {
              if (!edits) {
                setPanel(null);
                return;
              }
              void safely(() => act(base, { rowVersion: rv, edits }, 'Saved.', 'PATCH'));
            }}
          />
        ) : null}
      </section>,
    );
  }

  if (can.dropPhoto && photos.length > 0 && !TERMINAL.has(item.custody)) {
    sections.push(
      <section key="photos" className="stack" aria-labelledby="act-photos">
        <h3 id="act-photos">Photos</h3>
        <p className="hint">Drop a photo that failed processing or should not be published. Dropping cannot be undone.</p>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {photos.map((p) => (
            <ConfirmButton
              key={p.photoId}
              label={`Drop photo ${p.position + 1}${p.status === 'failed' ? ' (failed)' : ''}`}
              prompt={`Drop photo ${p.position + 1}? It is deleted from storage.`}
              confirmLabel="Drop photo"
              danger
              onConfirm={() => act(`${base}/photos/${p.photoId}/drop`, { rowVersion: rv }, 'Photo dropped.')}
            />
          ))}
        </div>
      </section>,
    );
  }

  if (can.block && item.postedByKind === 'student') {
    sections.push(
      <section key="device" className="stack" aria-labelledby="act-device">
        <h3 id="act-device">Posting device</h3>
        <p className="hint">Blocks posting from the browser that submitted this item. Recover never shows who that is.</p>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <ConfirmButton
            label="Block device"
            prompt="Block this device from posting?"
            confirmLabel="Block"
            danger
            confirmDisabled={!blockReason}
            onConfirm={() => act(`${base}/block-device`, { days: blockDays, reason: blockReason }, 'Device blocked.')}
          >
            <div className="row">
              <label className="field">
                <span className="label">Days</span>
                <input className="input" type="number" min={1} max={90} value={blockDays} onChange={(e) => setBlockDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} style={{ width: '6rem' }} />
              </label>
              <label className="field">
                <span className="label">Reason</span>
                <select className="select" value={blockReason} onChange={(e) => setBlockReason(e.target.value as (typeof BLOCK_REASONS)[number])}>
                  <option value="" disabled>
                    Choose a reason
                  </option>
                  {BLOCK_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {BLOCK_REASON_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </ConfirmButton>
          <ConfirmButton label="Unblock device" prompt="Allow this device to post again?" confirmLabel="Unblock" onConfirm={() => act(`${base}/unblock-device`, {}, 'Device unblocked.')} />
        </div>
      </section>,
    );
  }

  if (can.del && item.postedByKind !== 'student') {
    sections.push(
      <section key="delete" className="stack" aria-labelledby="act-delete">
        <h3 id="act-delete">Delete</h3>
        <p className="hint">For staff posts made by mistake. The item is soft-deleted, audited, and its media deleted. Needs a recent sign-in.</p>
        <ConfirmButton
          label="Delete item"
          prompt="Delete this staff post? This cannot be undone."
          confirmLabel="Delete"
          danger
          confirmDisabled={!deleteReason}
          onConfirm={() => act(base, { rowVersion: rv, reason: deleteReason }, 'Deleted.', 'DELETE')}
        >
          <label className="field">
            <span className="label">Reason</span>
            <select className="select" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value as (typeof DELETE_REASONS)[number])}>
              <option value="" disabled>
                Choose a reason
              </option>
              {DELETE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {DELETE_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </ConfirmButton>
      </section>,
    );
  }

  return (
    <div className="card stack-lg">
      <h2>Actions</h2>
      <p className="visually-hidden" aria-live="polite" role="status">
        {notice}
      </p>
      {notice ? <div className="notice notice-ok">{notice}</div> : null}
      {sections.length > 0 ? sections : <p className="muted">No actions are available for your role in this state.</p>}
      <ActionError error={error} />
    </div>
  );
}
