'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { BLOCK_REASONS } from './constants.ts';
import { BLOCK_REASON_LABELS, categoryLabel, fmtDateTime } from './format.ts';
import { ItemPin, type PinMapInfo } from './ItemPin.tsx';
import type { LostReportRow } from './shapes.ts';

type Props = {
  code: string;
  reports: LostReportRow[];
  can: { close: boolean; block: boolean; readMaps: boolean };
  activeMap: PinMapInfo;
  tz: string | null;
};

// Open lost reports at this school (G-43). There is no device data here: blocking resolves the
// report's device server-side (F-85).
export function ReportsTable({ code, reports, can, activeMap, tz }: Props) {
  const router = useRouter();
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [live, setLive] = useState('');
  const rows = reports.filter((r) => r.status === 'open' && !closed.has(r.id));

  const close = async (r: LostReportRow) => {
    await staffApi(`/api/staff/${code}/reports/${r.id}/close`, { body: { rowVersion: r.rowVersion ?? 0 } });
    setClosed((p) => new Set(p).add(r.id));
    setLive('Report closed.');
    router.refresh();
  };

  if (rows.length === 0) return <p className="muted">There are no open lost reports.</p>;

  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite">
        {live}
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Filed</th>
              <th scope="col">Category</th>
              <th scope="col">Description</th>
              <th scope="col">Where they think</th>
              <th scope="col">Matches</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.createdAt, tz)}</td>
                <td>{r.category ? categoryLabel(r.category) : <span className="muted">Any</span>}</td>
                <td>{r.description ?? <span className="muted">Cleared</span>}</td>
                <td>
                  <ItemPin code={code} pin={r.pin} mapVersionId={r.mapVersionId} activeMap={activeMap} canReadMaps={can.readMaps} label="Reported loss location" />
                </td>
                <td>{r.matchCount > 0 ? <span className="badge badge-brand">{r.matchCount}</span> : '0'}</td>
                <td className="stack">
                  {can.close ? (
                    <ConfirmButton label="Close" prompt="Close this report? The student's device will see it as closed by staff." confirmLabel="Close report" onConfirm={() => close(r)} />
                  ) : null}
                  {can.block ? <BlockReportDevice code={code} reportId={r.id} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BlockReportDevice({ code, reportId }: { code: string; reportId: string }) {
  const [reason, setReason] = useState<(typeof BLOCK_REASONS)[number] | ''>('');
  const [days, setDays] = useState(7);
  const [done, setDone] = useState(false);
  if (done) return <span className="badge badge-warn">Device blocked</span>;
  return (
    <ConfirmButton
      label="Block device"
      prompt="Block the device that filed this report from filing more?"
      confirmLabel="Block"
      danger
      confirmDisabled={!reason}
      onConfirm={async () => {
        await staffApi(`/api/staff/${code}/reports/${reportId}/block-device`, { body: { days, reason } });
        setDone(true);
      }}
    >
      <div className="row">
        <label className="field">
          <span className="label">Days</span>
          <input className="input" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))} style={{ width: '6rem' }} />
        </label>
        <label className="field">
          <span className="label">Reason</span>
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value as (typeof BLOCK_REASONS)[number])}>
            <option value="" disabled>
              Choose a reason
            </option>
            {BLOCK_REASONS.map((b) => (
              <option key={b} value={b}>
                {BLOCK_REASON_LABELS[b]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </ConfirmButton>
  );
}
