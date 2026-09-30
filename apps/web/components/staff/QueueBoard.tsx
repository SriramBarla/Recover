'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RejectReason, StaffItemRow } from '@recover/shared/dto.ts';
import type { StaffMeta } from '../../lib/staff.ts';
import { ActionError } from './ActionError.tsx';
import { ApiError, staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { REJECT_REASONS } from './constants.ts';
import { REJECT_REASON_LABELS, badgeClass, categoryLabel, chipsFor, fmtAge, fmtDateTime } from './format.ts';
import { ItemPhotos } from './ItemPhotos.tsx';
import { ItemPin } from './ItemPin.tsx';
import { EditForm, RejectForm } from './ReviewForms.tsx';
import { itemOf, queueOf, type QueuePage } from './shapes.ts';

type Props = {
  code: string;
  initial: QueuePage;
  meta: StaffMeta | null;
  canSeeQuarantine: boolean;
  canReadMaps: boolean;
  nowMs: number;
};

type Panel = { id: string; kind: 'edit' | 'reject' } | null;

// The review queue (§5.3; §10.2 chips; G-40 ordering comes from SQL). Keyboard shortcuts mirror
// visible buttons: J/K move, A approve, E approve with edits, R reject, X select for bulk reject.
export function QueueBoard({ code, initial, meta, canSeeQuarantine, canReadMaps, nowMs }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<StaffItemRow[]>(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [live, setLive] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [bulkReason, setBulkReason] = useState<RejectReason>('spam');
  const cards = useRef(new Map<string, HTMLElement>());
  const wantFocus = useRef(false);
  const tz = meta?.timezone ?? null;

  useEffect(() => {
    setFocus((f) => Math.min(f, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const id = items[focus]?.id;
    const el = id ? cards.current.get(id) : undefined;
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }, [focus, items]);

  const locationName = (id: string | null) => {
    if (!id) return 'None';
    return meta?.locations.find((l) => l.id === id)?.name ?? 'Inactive or unknown location';
  };

  const markBusy = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const removeItems = (ids: string[], message: string) => {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((i) => !gone.has(i.id)));
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    setPanel((p) => (p && gone.has(p.id) ? null : p));
    setLive(message);
  };

  const refresh = async (id: string) => {
    try {
      const fresh = itemOf(await staffApi<unknown>(`/api/staff/${code}/items/${id}`));
      if (!fresh || fresh.reviewStatus !== 'pending') {
        removeItems([id], 'That item was already handled by someone else.');
        return;
      }
      setItems((prev) => prev.map((i) => (i.id === id ? fresh : i)));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_found') removeItems([id], 'That item is no longer in the queue.');
    }
  };

  const run = async (item: StaffItemRow, done: string, fn: () => Promise<unknown>) => {
    if (busy.has(item.id)) return;
    markBusy(item.id, true);
    setErrors((prev) => ({ ...prev, [item.id]: null }));
    try {
      await fn();
      removeItems([item.id], `${done} ${item.publicId ?? 'item'}.`);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [item.id]: e }));
      if (e instanceof ApiError && (e.code === 'state_changed' || e.code === 'not_found')) await refresh(item.id);
    } finally {
      markBusy(item.id, false);
    }
  };

  const approve = (item: StaffItemRow, edits: Record<string, unknown> | null = null) =>
    run(item, edits ? 'Approved with edits' : 'Approved', () =>
      staffApi(`/api/staff/${code}/items/${item.id}/approve`, { body: { rowVersion: item.rowVersion, edits } }),
    );

  const reject = (item: StaffItemRow, reason: RejectReason) =>
    run(item, 'Rejected', () => staffApi(`/api/staff/${code}/items/${item.id}/reject`, { body: { rowVersion: item.rowVersion, reason } }));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const move = (d: number) => {
    if (items.length === 0) return;
    wantFocus.current = true;
    setFocus((f) => Math.max(0, Math.min(items.length - 1, f + d)));
  };

  const bulkReject = async () => {
    const ids = items.filter((i) => selected.has(i.id)).map((i) => i.id).slice(0, 50);
    if (ids.length === 0) return;
    const res = await staffApi<{ rejected?: unknown; skipped?: unknown[] }>(`/api/staff/${code}/items/bulk-reject`, {
      body: { itemIds: ids, reason: bulkReason },
    });
    const skipped = new Set(
      (Array.isArray(res?.skipped) ? res.skipped : [])
        .map((s) => (typeof s === 'string' ? s : ((s as { itemId?: unknown; id?: unknown })?.itemId ?? (s as { id?: unknown })?.id)))
        .filter((s): s is string => typeof s === 'string'),
    );
    const done = ids.filter((id) => !skipped.has(id));
    removeItems(done, `Rejected ${done.length} item${done.length === 1 ? '' : 's'}${skipped.size ? `; ${skipped.size} skipped because they changed` : ''}.`);
    for (const id of skipped) void refresh(id);
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const q = new URLSearchParams({ cursorCreated: cursor.createdAt, cursorId: cursor.id });
      const page = queueOf(await staffApi<unknown>(`/api/staff/${code}/queue?${q.toString()}`));
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        if (panel) {
          e.preventDefault();
          setPanel(null);
        }
        return;
      }
      if (panel) return;
      const item = items[focus];
      switch (e.key.toLowerCase()) {
        case 'j':
          e.preventDefault();
          move(1);
          break;
        case 'k':
          e.preventDefault();
          move(-1);
          break;
        case 'a':
          if (item) {
            e.preventDefault();
            void approve(item);
          }
          break;
        case 'e':
          if (item) {
            e.preventDefault();
            setPanel({ id: item.id, kind: 'edit' });
          }
          break;
        case 'r':
          if (item) {
            e.preventDefault();
            setPanel({ id: item.id, kind: 'reject' });
          }
          break;
        case 'x':
          if (item) {
            e.preventDefault();
            toggle(item.id);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selectedCount = items.filter((i) => selected.has(i.id)).length;

  return (
    <div className="stack-lg">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          {items.length === 0 ? 'Nothing is waiting for review.' : `${items.length} pending item${items.length === 1 ? '' : 's'} loaded. Flagged items come first.`}
        </p>
        <button type="button" className="btn" onClick={() => router.refresh()}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Keyboard: <kbd>J</kbd> next, <kbd>K</kbd> previous, <kbd>A</kbd> approve, <kbd>E</kbd> approve with edits, <kbd>R</kbd> reject, <kbd>X</kbd> select,{' '}
        <kbd>Esc</kbd> close. Every shortcut has a button on the card.
      </p>
      <p className="visually-hidden" aria-live="polite" role="status">
        {live}
      </p>
      {live ? (
        <div className="notice notice-ok" aria-hidden="true">
          {live}
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <div className="card stack" style={{ position: 'sticky', top: '0.5rem', zIndex: 2 }}>
          <div className="spread">
            <strong>{selectedCount} selected for bulk reject</strong>
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            </div>
          </div>
          <ConfirmButton
            label={`Reject ${selectedCount} selected`}
            prompt={`Reject ${Math.min(selectedCount, 50)} item${selectedCount === 1 ? '' : 's'} with one reason? This cannot be undone.`}
            confirmLabel="Reject selected"
            danger
            onConfirm={bulkReject}
          >
            <label className="field" style={{ maxWidth: '20rem' }}>
              <span className="label">Reason for all selected</span>
              <select className="select" value={bulkReason} onChange={(e) => setBulkReason(e.target.value as RejectReason)}>
                {REJECT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REJECT_REASON_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {selectedCount > 50 ? <p className="small">Only the first 50 are rejected at a time.</p> : null}
          </ConfirmButton>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSelected(selectedCount === items.length ? new Set() : new Set(items.slice(0, 50).map((i) => i.id)))}
          >
            {selectedCount === items.length ? 'Unselect all' : 'Select all shown (max 50)'}
          </button>
        </div>
      ) : null}

      <ol className="stack-lg" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((item, index) => {
          const isFocused = index === focus;
          const isBusy = busy.has(item.id);
          const title = `${categoryLabel(item.category)} ${item.publicId ?? ''}`.trim();
          const chips = chipsFor(item.flags, item.screeningStatus);
          const rejections = item.deviceRejections30d;
          return (
            <li key={item.id}>
              <article
                ref={(el) => {
                  if (el) cards.current.set(item.id, el);
                  else cards.current.delete(item.id);
                }}
                tabIndex={-1}
                className="card stack"
                aria-labelledby={`q-${item.id}`}
                aria-busy={isBusy}
                onFocusCapture={() => setFocus(index)}
                style={{ borderColor: isFocused ? 'var(--focus)' : undefined, borderWidth: isFocused ? 2 : undefined }}
              >
                {item.quarantine ? (
                  <div className="notice notice-danger" role="alert">
                    <strong>Quarantined by automated screening.</strong> {canSeeQuarantine ? 'Do not download or share it. Follow the district incident contact tree before acting.' : 'Ask a school admin.'}
                  </div>
                ) : null}
                <div className="spread">
                  <h2 id={`q-${item.id}`} style={{ fontSize: '1.1rem', margin: 0 }}>
                    {categoryLabel(item.category)} <span className="mono small muted">{item.publicId}</span>
                  </h2>
                  <label className="row small">
                    <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${title} for bulk reject`} />
                    Select
                  </label>
                </div>
                <p className="small muted" style={{ margin: 0 }}>
                  Posted {fmtDateTime(item.createdAt, tz)} ({fmtAge(item.createdAt, nowMs)} ago) by {item.postedByKind === 'student' ? 'a student' : 'staff'}
                </p>
                {chips.length > 0 ? (
                  <ul className="chips" aria-label="Screening flags" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {chips.map((c) => (
                      <li key={c.key} className={badgeClass(c.tone)}>
                        {c.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="grid-wide">
                  <ItemPhotos code={code} item={item} blurred={item.quarantine} />
                  <dl className="stack small" style={{ margin: 0 }}>
                    <div>
                      <dt className="label">Description (public after approval)</dt>
                      <dd style={{ margin: 0 }}>{item.description ?? <span className="muted">None</span>}</dd>
                    </div>
                    <div>
                      <dt className="label">Finder's location note (staff only)</dt>
                      <dd style={{ margin: 0 }}>{item.note ?? <span className="muted">None</span>}</dd>
                    </div>
                    <div>
                      <dt className="label">Exact pin (staff only)</dt>
                      <dd style={{ margin: 0 }}>
                        <ItemPin code={code} pin={item.pin} mapVersionId={item.mapVersionId} activeMap={meta?.map ?? null} canReadMaps={canReadMaps} label={title} />
                      </dd>
                    </div>
                    <div>
                      <dt className="label">Public zone</dt>
                      <dd style={{ margin: 0 }}>{item.zoneName ?? <span className="muted">None</span>}</dd>
                    </div>
                    <div>
                      <dt className="label">Drop-off</dt>
                      <dd style={{ margin: 0 }}>{locationName(item.dropoffLocationId)}</dd>
                    </div>
                    <div>
                      <dt className="label">Device rejections, last 30 days</dt>
                      <dd style={{ margin: 0 }}>
                        {rejections === null ? (
                          <span className="muted">Not applicable</span>
                        ) : (
                          <span className={rejections >= 3 ? 'badge badge-danger' : rejections > 0 ? 'badge badge-warn' : 'badge'}>{rejections}</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="row">
                  <button type="button" className="btn btn-primary" disabled={isBusy} onClick={() => void approve(item)}>
                    Approve <kbd aria-hidden="true">A</kbd>
                  </button>
                  <button type="button" className="btn" disabled={isBusy} aria-expanded={panel?.id === item.id && panel.kind === 'edit'} onClick={() => setPanel({ id: item.id, kind: 'edit' })}>
                    Approve with edits <kbd aria-hidden="true">E</kbd>
                  </button>
                  <button type="button" className="btn btn-danger" disabled={isBusy} aria-expanded={panel?.id === item.id && panel.kind === 'reject'} onClick={() => setPanel({ id: item.id, kind: 'reject' })}>
                    Reject <kbd aria-hidden="true">R</kbd>
                  </button>
                  <a className="btn btn-ghost" href={`/staff/${code}/items/${item.id}`}>
                    Open item
                  </a>
                </div>
                {panel?.id === item.id && panel.kind === 'edit' ? (
                  <EditForm
                    item={item}
                    meta={meta}
                    busy={isBusy}
                    submitLabel="Approve with these edits"
                    onCancel={() => setPanel(null)}
                    onSubmit={(edits) => {
                      setPanel(null);
                      void approve(item, edits);
                    }}
                  />
                ) : null}
                {panel?.id === item.id && panel.kind === 'reject' ? (
                  <RejectForm
                    busy={isBusy}
                    onCancel={() => setPanel(null)}
                    onSubmit={(reason) => {
                      setPanel(null);
                      void reject(item, reason);
                    }}
                  />
                ) : null}
                <ActionError error={errors[item.id]} />
              </article>
            </li>
          );
        })}
      </ol>

      {cursor ? (
        <div className="stack">
          <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
          <ActionError error={moreError} />
        </div>
      ) : null}
    </div>
  );
}
