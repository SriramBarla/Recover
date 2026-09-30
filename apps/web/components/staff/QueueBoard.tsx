'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RejectReason, StaffItemRow } from '@recover/shared/dto.ts';
import type { StaffMeta } from '../../lib/staff.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button, buttonClass } from '@/components/ui/button.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { PrivateNote } from '@/components/ui/field.tsx';
import { IconAlert, IconArrowRight, IconCheck, IconCheckCircle, IconChevronDown, IconChevronLeft, IconChevronRight, IconClock, IconPencil, IconRefresh, IconX } from '@/components/ui/icons.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { Select } from '@/components/ui/select.tsx';
import { FlagChip } from '@/components/ui/status-badge.tsx';
import { ActionError } from './ActionError.tsx';
import { ApiError, staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { REJECT_REASONS } from './constants.ts';
import { REJECT_REASON_LABELS, categoryLabel, chipsFor, fmtAge, fmtDateTime } from './format.ts';
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
      if (t?.closest('dialog')) return; // a confirm dialog is open: the queue behind it is inert
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
        <Button onClick={() => router.refresh()} icon={<IconRefresh />}>
          Refresh
        </Button>
      </div>
      <div className="spread">
        <p className="hint" style={{ margin: 0 }}>
          Keyboard: <Kbd>J</Kbd> next, <Kbd>K</Kbd> previous, <Kbd>A</Kbd> approve, <Kbd>E</Kbd> approve with edits, <Kbd>R</Kbd> reject, <Kbd>X</Kbd> select,{' '}
          <Kbd>Esc</Kbd> close. Every shortcut has a button.
        </p>
        {items.length > 1 ? (
          <div className="row" role="group" aria-label="Move between items">
            <Button disabled={focus <= 0} onClick={() => move(-1)} icon={<IconChevronLeft />}>
              Previous item <Kbd aria-hidden="true">K</Kbd>
            </Button>
            <Button disabled={focus >= items.length - 1} onClick={() => move(1)} iconEnd={<IconChevronRight />}>
              Next item <Kbd aria-hidden="true">J</Kbd>
            </Button>
            <span className="small muted">
              {Math.min(focus + 1, items.length)} of {items.length}
            </span>
          </div>
        ) : null}
      </div>
      <p className="visually-hidden" aria-live="polite" role="status">
        {live}
      </p>
      {live ? (
        <Notice tone="success" aria-hidden="true">
          {live}
        </Notice>
      ) : null}

      {selectedCount > 0 ? (
        <div className="card stack bulk-bar">
          <div className="spread">
            <strong className="with-icon">
              <IconCheck />
              {selectedCount} selected for bulk reject
            </strong>
            <div className="row">
              <Button variant="ghost" onClick={() => setSelected(new Set())} icon={<IconX />}>
                Clear selection
              </Button>
            </div>
          </div>
          <ConfirmButton
            label={`Reject ${selectedCount} selected`}
            prompt={`Reject ${Math.min(selectedCount, 50)} item${selectedCount === 1 ? '' : 's'} with one reason? This cannot be undone.`}
            confirmLabel="Reject selected"
            danger
            onConfirm={bulkReject}
          >
            <Select
              id="bulk-reason"
              label="Reason for all selected"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value as RejectReason)}
              options={REJECT_REASONS.map((r) => ({ value: r, label: REJECT_REASON_LABELS[r] ?? r }))}
            />
            {selectedCount > 50 ? <p className="small">Only the first 50 are rejected at a time.</p> : null}
          </ConfirmButton>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="row">
          <Button
            variant="ghost"
            onClick={() => setSelected(selectedCount === items.length ? new Set() : new Set(items.slice(0, 50).map((i) => i.id)))}
          >
            {selectedCount === items.length ? 'Unselect all' : 'Select all shown (max 50)'}
          </Button>
        </div>
      ) : (
        <EmptyState title="Queue is clear" icon={<IconCheckCircle />}>
          No student posts are waiting for review. New posts show up here as soon as their photos finish uploading.
        </EmptyState>
      )}

      <ol className="stack-lg" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((item, index) => {
          const isFocused = index === focus;
          const isBusy = busy.has(item.id);
          const title = `${categoryLabel(item.category)} ${item.publicId ?? ''}`.trim();
          const flags = chipsFor(item.flags, item.screeningStatus).map((c) => c.key);
          const rejections = item.deviceRejections30d;
          return (
            <li key={item.id}>
              <article
                ref={(el) => {
                  if (el) cards.current.set(item.id, el);
                  else cards.current.delete(item.id);
                }}
                tabIndex={-1}
                className="card stack review-card"
                data-focused={isFocused ? 'true' : undefined}
                aria-labelledby={`q-${item.id}`}
                aria-busy={isBusy}
                onFocusCapture={() => setFocus(index)}
              >
                {item.quarantine ? (
                  <Notice tone="danger" live="assertive" title="Quarantined by automated screening.">
                    {canSeeQuarantine ? 'Do not download or share it. Follow the district incident contact tree before acting.' : 'Ask a school admin.'}
                  </Notice>
                ) : null}
                <div className="spread">
                  <h2 id={`q-${item.id}`} className="review-card-title">
                    <CategoryIcon category={item.category} size={22} />
                    {categoryLabel(item.category)} <span className="mono small muted">{item.publicId}</span>
                  </h2>
                  <label className="choice small" style={{ minHeight: 0, padding: 0 }}>
                    <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${title} for bulk reject`} />
                    <span>Select</span>
                  </label>
                </div>
                <p className="small muted with-icon" style={{ margin: 0, whiteSpace: 'normal' }}>
                  <IconClock size={16} />
                  <span>
                    Posted {fmtDateTime(item.createdAt, tz)} ({fmtAge(item.createdAt, nowMs)} ago) by {item.postedByKind === 'student' ? 'a student' : 'staff'}
                  </span>
                </p>
                {flags.length > 0 ? (
                  <ul className="chips" aria-label="Screening flags" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {flags.map((f) => (
                      <li key={f}>
                        <FlagChip flag={f} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="grid-wide">
                  <ItemPhotos code={code} item={item} blurred={item.quarantine} />
                  <dl className="kv kv-stacked small">
                    <dt>Description (public after approval)</dt>
                    <dd>{item.description ?? <span className="muted">None</span>}</dd>
                    <dt>
                      Finder's location note <PrivateNote>Staff only</PrivateNote>
                    </dt>
                    <dd>{item.note ?? <span className="muted">None</span>}</dd>
                    <dt>
                      Exact pin <PrivateNote>Staff only</PrivateNote>
                    </dt>
                    <dd>
                      <ItemPin code={code} pin={item.pin} mapVersionId={item.mapVersionId} activeMap={meta?.map ?? null} canReadMaps={canReadMaps} label={title} />
                    </dd>
                    <dt>Public zone</dt>
                    <dd>{item.zoneName ?? <span className="muted">None</span>}</dd>
                    <dt>Drop-off</dt>
                    <dd>{locationName(item.dropoffLocationId)}</dd>
                    <dt>Device rejections, last 30 days</dt>
                    <dd>
                      {rejections === null ? (
                        <span className="muted">Not applicable</span>
                      ) : (
                        <Badge tone={rejections >= 3 ? 'danger' : rejections > 0 ? 'warn' : 'neutral'} icon={rejections > 0 ? <IconAlert /> : undefined}>
                          {rejections}
                        </Badge>
                      )}
                    </dd>
                  </dl>
                </div>
                <div className="button-row review-actions">
                  <Button variant="primary" disabled={isBusy} onClick={() => void approve(item)} icon={<IconCheck />}>
                    Approve <Kbd aria-hidden="true">A</Kbd>
                  </Button>
                  <Button
                    disabled={isBusy}
                    aria-expanded={panel?.id === item.id && panel.kind === 'edit'}
                    onClick={() => setPanel({ id: item.id, kind: 'edit' })}
                    icon={<IconPencil />}
                  >
                    Approve with edits <Kbd aria-hidden="true">E</Kbd>
                  </Button>
                  <Button
                    variant="danger-outline"
                    disabled={isBusy}
                    aria-expanded={panel?.id === item.id && panel.kind === 'reject'}
                    onClick={() => setPanel({ id: item.id, kind: 'reject' })}
                    icon={<IconX />}
                  >
                    Reject <Kbd aria-hidden="true">R</Kbd>
                  </Button>
                  <a className={buttonClass({ variant: 'ghost' })} href={`/staff/${code}/items/${item.id}`}>
                    Open item
                    <IconArrowRight />
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
          <Button disabled={loadingMore} onClick={() => void loadMore()} icon={<IconChevronDown />}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </Button>
          <ActionError error={moreError} />
        </div>
      ) : null}
    </div>
  );
}
