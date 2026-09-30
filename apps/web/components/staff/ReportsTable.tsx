'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconSearch } from '@/components/ui/icons.tsx';
import { LiveRegion } from '@/components/ui/live-region.tsx';
import { Select } from '@/components/ui/select.tsx';
import { Table } from '@/components/ui/table.tsx';
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

  if (rows.length === 0)
    return (
      <>
        <LiveRegion message={live} />
        <EmptyState icon={<IconSearch />} title="No open lost reports">
          There are no open lost reports.
        </EmptyState>
      </>
    );

  return (
    <>
      <LiveRegion message={live} />
      <Table caption="Open lost reports" hideCaption>
        <thead>
          <tr>
            <th scope="col">Filed</th>
            <th scope="col">Category</th>
            <th scope="col">Description</th>
            <th scope="col">Where they think</th>
            <th scope="col">Matches</th>
            <th scope="col" className="actions">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="nowrap small">{fmtDateTime(r.createdAt, tz)}</td>
              <td>
                {r.category ? (
                  <span className="with-icon">
                    <CategoryIcon category={r.category} size={18} />
                    {categoryLabel(r.category)}
                  </span>
                ) : (
                  <span className="muted">Any</span>
                )}
              </td>
              <td>{r.description ?? <span className="muted">Cleared</span>}</td>
              <td>
                <ItemPin code={code} pin={r.pin} mapVersionId={r.mapVersionId} activeMap={activeMap} canReadMaps={can.readMaps} label="Reported loss location" />
              </td>
              <td>{r.matchCount > 0 ? <Badge tone="brand">{r.matchCount}</Badge> : <span className="muted">0</span>}</td>
              <td className="actions">
                <div className="button-row">
                  {can.close ? (
                    <ConfirmButton label="Close" prompt="Close this report? The student's device will see it as closed by staff." confirmLabel="Close report" onConfirm={() => close(r)} />
                  ) : null}
                  {can.block ? <BlockReportDevice code={code} reportId={r.id} /> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function BlockReportDevice({ code, reportId }: { code: string; reportId: string }) {
  const [reason, setReason] = useState<(typeof BLOCK_REASONS)[number] | ''>('');
  const [days, setDays] = useState(7);
  const [done, setDone] = useState(false);
  if (done) return <Badge tone="warn">Device blocked</Badge>;
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
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <TextInput
          id={`block-days-${reportId}`}
          label="Days"
          type="number"
          inputMode="numeric"
          min={1}
          max={90}
          value={days}
          onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
          style={{ width: '6rem' }}
        />
        <Select
          id={`block-reason-${reportId}`}
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as (typeof BLOCK_REASONS)[number])}
          options={[{ value: '', label: 'Choose a reason', disabled: true }, ...BLOCK_REASONS.map((b) => ({ value: b, label: BLOCK_REASON_LABELS[b] ?? b }))]}
        />
      </div>
    </ConfirmButton>
  );
}
