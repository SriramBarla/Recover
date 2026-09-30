'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { IconBuilding, IconCalendar, IconCheck, IconClock, IconTransfer } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { Select } from '@/components/ui/select.tsx';
import { StatusBadge } from '@/components/ui/status-badge.tsx';
import { Table } from '@/components/ui/table.tsx';
import { ActionError } from './ActionError.tsx';
import { ApiError, staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { DISPOSITIONS } from './constants.ts';
import { CUSTODY_LABELS, categoryLabel, fmtDate, fmtDateTime, label } from './format.ts';
import type { CustodyLists, CustodyRow } from './shapes.ts';

type Loc = { id: string; name: string };
type Can = { receive: boolean; transfer: boolean; claim: boolean; dispose: boolean; bulkDispose: boolean };
type Props = { code: string; lists: CustodyLists; locations: Loc[]; can: Can; tz: string | null };

// Custody desk (§5.4): expected arrivals, items at a location, and disposition-due items, with
// receive, transfer, claim, and donate/dispose (single and bulk). SQL checks every transition.
export function CustodyBoard({ code, lists, locations, can, tz }: Props) {
  const router = useRouter();
  const [filter, setFilter] = useState('');
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkDisposition, setBulkDisposition] = useState<(typeof DISPOSITIONS)[number]>('donated');
  const [live, setLive] = useState('');

  const locName = (id: string | null) => (id ? (locations.find((l) => l.id === id)?.name ?? 'Inactive location') : 'None');
  const visible = (rows: CustodyRow[]) => rows.filter((r) => !done.has(r.id) && (!filter || r.locationId === filter));
  const expected = useMemo(() => visible(lists.expected), [lists.expected, done, filter]);
  const atLocation = useMemo(() => visible(lists.atLocation), [lists.atLocation, done, filter]);
  const due = useMemo(() => (lists.dispositionDue ? visible(lists.dispositionDue) : null), [lists.dispositionDue, done, filter]);

  const finish = (ids: string[], message: string) => {
    setDone((prev) => new Set([...prev, ...ids]));
    setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    setLive(message);
    router.refresh();
  };

  const run = async (row: CustodyRow, path: string, body: Record<string, unknown>, message: string) => {
    setBusy((p) => new Set(p).add(row.id));
    setErrors((p) => ({ ...p, [row.id]: null }));
    try {
      await staffApi(`/api/staff/${code}/items/${row.id}/${path}`, { body: { rowVersion: row.rowVersion, ...body } });
      finish([row.id], `${message} ${row.publicId ?? ''}`.trim());
    } catch (e) {
      setErrors((p) => ({ ...p, [row.id]: e }));
      if (e instanceof ApiError && e.code === 'state_changed') router.refresh();
    } finally {
      setBusy((p) => {
        const n = new Set(p);
        n.delete(row.id);
        return n;
      });
    }
  };

  // Throws so ConfirmButton shows the error inline.
  const confirmRun = async (row: CustodyRow, path: string, body: Record<string, unknown>, message: string) => {
    await staffApi(`/api/staff/${code}/items/${row.id}/${path}`, { body: { rowVersion: row.rowVersion, ...body } });
    finish([row.id], `${message} ${row.publicId ?? ''}`.trim());
  };

  const bulkDispose = async () => {
    const ids = [...selected].slice(0, 50);
    const res = await staffApi<{ skipped?: unknown[] }>(`/api/staff/${code}/items/bulk-dispose`, { body: { itemIds: ids, disposition: bulkDisposition } });
    const skipped = new Set(
      (Array.isArray(res?.skipped) ? res.skipped : [])
        .map((s) => (typeof s === 'string' ? s : (s as { itemId?: unknown })?.itemId))
        .filter((s): s is string => typeof s === 'string'),
    );
    const recorded = ids.filter((id) => !skipped.has(id));
    finish(recorded, `Recorded ${recorded.length} item${recorded.length === 1 ? '' : 's'}${skipped.size ? `; ${skipped.size} skipped because they changed` : ''}.`);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const idCell = (r: CustodyRow) => (
    <td className="cell-id">
      <a href={`/staff/${code}/items/${r.id}`} className="mono">
        {r.publicId ?? 'Item'}
      </a>
      <div className="small with-icon">
        <CategoryIcon category={r.category} size={16} />
        {categoryLabel(r.category)}
      </div>
    </td>
  );

  const thumbCell = (r: CustodyRow) => (
    <td style={{ width: '4.5rem' }}>
      {r.thumb ? (
        <img className="thumb-sm" src={r.thumb} alt="" width={64} height={64} loading="lazy" />
      ) : (
        <span className="thumb-sm thumb-sm-empty" aria-hidden="true">
          <CategoryIcon category={r.category} size={24} />
        </span>
      )}
    </td>
  );

  return (
    <div className="stack-lg">
      <p className="visually-hidden" role="status" aria-live="polite">
        {live}
      </p>
      {live ? <Notice tone="success">{live}</Notice> : null}
      <Select
        id="custody-filter"
        label="Show location"
        fieldClassName="inline-field"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="All locations"
        options={locations.map((l) => ({ value: l.id, label: l.name }))}
      />

      <section className="stack" aria-labelledby="c-expected">
        <h2 id="c-expected" className="with-icon">
          <IconClock />
          Expected arrivals ({expected.length})
        </h2>
        {expected.length === 0 ? (
          <p className="muted">No items are on their way.</p>
        ) : (
          <Table caption="Expected arrivals" hideCaption>
            <thead>
              <tr>
                <th scope="col">Photo</th>
                <th scope="col">Item</th>
                <th scope="col">Description</th>
                <th scope="col">Posted</th>
                <th scope="col">Deadline</th>
                <th scope="col">Check in</th>
              </tr>
            </thead>
            <tbody>
              {expected.map((r) => (
                <ExpectedRow key={r.id} row={r} locations={locations} can={can.receive} busy={busy.has(r.id)} error={errors[r.id]} tz={tz} thumbCell={thumbCell(r)} idCell={idCell(r)} locName={locName} onReceive={(locationId) => void run(r, 'receive', { locationId }, 'Checked in')} />
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="stack" aria-labelledby="c-at">
        <h2 id="c-at" className="with-icon">
          <IconBuilding />
          At a location ({atLocation.length})
        </h2>
        {atLocation.length === 0 ? (
          <p className="muted">Nothing is checked in.</p>
        ) : (
          <Table caption="At a location" hideCaption>
            <thead>
              <tr>
                <th scope="col">Photo</th>
                <th scope="col">Item</th>
                <th scope="col">Description</th>
                <th scope="col">Location</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {atLocation.map((r) => (
                <tr key={r.id} aria-busy={busy.has(r.id)}>
                  {thumbCell(r)}
                  {idCell(r)}
                  <td className="cell-text">{r.description ?? <span className="muted">None</span>}</td>
                  <td>
                    <StatusBadge kind="custody" status="at_location" label={locName(r.locationId)} />
                    {r.receivedAt ? <div className="small muted">since {fmtDate(r.receivedAt, tz)}</div> : null}
                    {r.expiresAt ? <div className="small muted">retention ends {fmtDate(r.expiresAt, tz)}</div> : null}
                  </td>
                  <td className="stack-sm">
                    {can.transfer ? <TransferControl row={r} locations={locations} busy={busy.has(r.id)} onTransfer={(locationId) => void run(r, 'transfer', { locationId }, 'Transferred')} /> : null}
                    <div className="row" style={{ alignItems: 'flex-start' }}>
                      {can.claim ? (
                        <ConfirmButton
                          label="Claimed"
                          prompt="Did you verify ownership in person with a detail that is not in the public listing?"
                          confirmLabel="Yes, mark claimed"
                          onConfirm={() => confirmRun(r, 'claim', {}, 'Marked claimed')}
                        />
                      ) : null}
                      {can.dispose ? <DisposeControl onConfirm={(disposition) => confirmRun(r, 'dispose', { disposition }, 'Recorded')} /> : null}
                    </div>
                    <ActionError error={errors[r.id]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section className="stack" aria-labelledby="c-due">
        <h2 id="c-due" className="with-icon">
          <IconCalendar />
          Disposition due{due ? ` (${due.length})` : ''}
        </h2>
        <p className="hint">Retention has ended for these items. Time alone never disposes of anything: record what physically happened.</p>
        {due === null ? (
          <Notice tone="warning">This list needs the staff custody list from the database, which is not available yet. Open an item to record its disposition.</Notice>
        ) : due.length === 0 ? (
          <p className="muted">Nothing is due.</p>
        ) : (
          <>
            {can.bulkDispose ? (
              <div className="card stack">
                <div className="spread">
                  <strong className="with-icon">
                    <IconCheck />
                    {selected.size} selected
                  </strong>
                  <Button variant="ghost" onClick={() => setSelected(selected.size === due.length ? new Set() : new Set(due.slice(0, 50).map((r) => r.id)))}>
                    {selected.size === due.length ? 'Unselect all' : 'Select all (max 50)'}
                  </Button>
                </div>
                <ConfirmButton
                  label={`Record ${selected.size} selected`}
                  prompt={`Record ${Math.min(selected.size, 50)} item${selected.size === 1 ? '' : 's'} as ${bulkDisposition}? This ends custody and cannot be undone. It needs a recent sign-in.`}
                  confirmLabel="Record all"
                  danger
                  disabled={selected.size === 0}
                  onConfirm={bulkDispose}
                >
                  <fieldset className="fieldset">
                    <legend>What happened to all of them</legend>
                    {DISPOSITIONS.map((d) => (
                      <label key={d} className="choice">
                        <input type="radio" name="bulk-disposition" value={d} checked={bulkDisposition === d} onChange={() => setBulkDisposition(d)} />
                        <span>{d === 'donated' ? 'Donated' : 'Disposed of'}</span>
                      </label>
                    ))}
                  </fieldset>
                </ConfirmButton>
              </div>
            ) : null}
            <Table caption="Disposition due" hideCaption>
              <thead>
                <tr>
                  {can.bulkDispose ? <th scope="col">Select</th> : null}
                  <th scope="col">Photo</th>
                  <th scope="col">Item</th>
                  <th scope="col">Location</th>
                  <th scope="col">Due since</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {due.map((r) => (
                  <tr key={r.id}>
                    {can.bulkDispose ? (
                      <td>
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.publicId ?? 'item'}`} />
                      </td>
                    ) : null}
                    {thumbCell(r)}
                    {idCell(r)}
                    <td>{locName(r.locationId)}</td>
                    <td>{fmtDateTime(r.dispositionDueAt, tz)}</td>
                    <td>
                      <StatusBadge kind="custody" status={r.custody} label={label(CUSTODY_LABELS, r.custody)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </section>
    </div>
  );
}

function ExpectedRow({
  row,
  locations,
  can,
  busy,
  error,
  tz,
  thumbCell,
  idCell,
  locName,
  onReceive,
}: {
  row: CustodyRow;
  locations: Loc[];
  can: boolean;
  busy: boolean;
  error: unknown;
  tz: string | null;
  thumbCell: ReactNode;
  idCell: ReactNode;
  locName: (id: string | null) => string;
  onReceive: (locationId: string) => void;
}) {
  const [at, setAt] = useState(row.locationId && locations.some((l) => l.id === row.locationId) ? row.locationId : (locations[0]?.id ?? ''));
  const late = row.custody === 'expired_never_arrived';
  return (
    <tr aria-busy={busy}>
      {thumbCell}
      {idCell}
      <td className="cell-text">
        {row.description ?? <span className="muted">None</span>}
        <div className="small muted">Bringing it to {locName(row.locationId)}</div>
      </td>
      <td className="nowrap">{fmtDate(row.postedAt, tz)}</td>
      <td>
        {row.deadlineAt ? fmtDateTime(row.deadlineAt, tz) : <span className="muted">Not set</span>}
        {late ? (
          <div>
            <Badge tone="warn" icon={<IconClock />}>
              Late: missed the deadline
            </Badge>
          </div>
        ) : null}
      </td>
      <td>
        {can ? (
          <div className="stack-sm">
            <Select
              id={`checkin-${row.id}`}
              label="Check in at"
              hideLabel
              value={at}
              onChange={(e) => setAt(e.target.value)}
              options={locations.map((l) => ({ value: l.id, label: l.name }))}
            />
            <Button variant="primary" disabled={busy || !at} onClick={() => onReceive(at)} icon={<IconCheck />}>
              {late ? 'Late check-in' : 'Check in'}
            </Button>
            <ActionError error={error} />
          </div>
        ) : (
          <span className="muted small">Office staff check items in.</span>
        )}
      </td>
    </tr>
  );
}

function TransferControl({ row, locations, busy, onTransfer }: { row: CustodyRow; locations: Loc[]; busy: boolean; onTransfer: (locationId: string) => void }) {
  const others = locations.filter((l) => l.id !== row.locationId);
  const [to, setTo] = useState(others[0]?.id ?? '');
  if (others.length === 0) return null;
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <Select
        id={`move-${row.id}`}
        label="Move to"
        hideLabel
        value={to}
        onChange={(e) => setTo(e.target.value)}
        options={others.map((l) => ({ value: l.id, label: l.name }))}
      />
      <Button disabled={busy || !to} onClick={() => onTransfer(to)} icon={<IconTransfer />}>
        Move
      </Button>
    </div>
  );
}

function DisposeControl({ onConfirm }: { onConfirm: (disposition: (typeof DISPOSITIONS)[number]) => Promise<void> }) {
  const name = useId();
  const [d, setD] = useState<(typeof DISPOSITIONS)[number]>('donated');
  return (
    <ConfirmButton label="Donate or dispose" prompt="Record that this item physically left the lost and found?" confirmLabel="Record it" danger onConfirm={() => onConfirm(d)}>
      <fieldset className="fieldset">
        <legend>What happened</legend>
        {DISPOSITIONS.map((x) => (
          <label key={x} className="choice">
            <input type="radio" name={name} value={x} checked={d === x} onChange={() => setD(x)} />
            <span>{x === 'donated' ? 'Donated' : 'Disposed of'}</span>
          </label>
        ))}
      </fieldset>
    </ConfirmButton>
  );
}
