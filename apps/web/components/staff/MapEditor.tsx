'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconCheck, IconMap, IconPencil, IconPlus, IconUpload } from '@/components/ui/icons.tsx';
import type { MapPoint as Point } from '@/components/ui/map-geometry.ts';
import { MapPicker } from '@/components/ui/map-picker.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { StatusBadge } from '@/components/ui/status-badge.tsx';
import { Table } from '@/components/ui/table.tsx';
import { ActionError } from './ActionError.tsx';
import { ApiError, staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { MAP_REJECT_REASON_LABELS, fmtDateTime, label } from './format.ts';
import type { MapVersionRow, ZoneRow } from './shapes.ts';

type Props = { code: string; versions: MapVersionRow[]; tz: string | null };

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending_district: 'Waiting for district',
  approved: 'Approved',
  rejected: 'Sent back',
  retired: 'Retired',
};

const MAX_BYTES = 4 * 1024 * 1024;
const MIN_WIDTH = 1200;

// Map versions (§5.5, §24 steps 2-3, G-07): school admins upload a private draft, draw public zones,
// and submit; only the district activates. Zones freeze once a version leaves draft.
export function MapEditor({ code, versions, tz }: Props) {
  const router = useRouter();
  const initial = versions.find((v) => v.approvalStatus === 'draft') ?? versions.find((v) => v.active) ?? versions[0] ?? null;
  const [selectedId, setSelectedId] = useState(initial?.id ?? '');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const selected = versions.find((v) => v.id === selectedId) ?? null;

  const createDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await staffApi<{ mapVersionId?: string }>(`/api/staff/${code}/maps`, { body: {} });
      if (r?.mapVersionId) setSelectedId(r.mapVersionId);
      setNotice('Draft created. Upload the map image next.');
      router.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <p className="visually-hidden" role="status" aria-live="polite">
        {notice}
      </p>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <section className="stack" aria-labelledby="versions-h">
        <div className="spread">
          <h2 id="versions-h" className="with-icon">
            <IconMap />
            Map versions
          </h2>
          <Button disabled={busy} onClick={() => void createDraft()} icon={<IconPlus />}>
            New draft
          </Button>
        </div>
        <ActionError error={error} />
        {versions.length === 0 ? (
          <p className="muted">No map yet. Create a draft to start.</p>
        ) : (
          <Table caption="Map versions" hideCaption>
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Status</th>
                <th scope="col">Size</th>
                <th scope="col">Zones</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} aria-current={v.id === selectedId ? 'true' : undefined}>
                  <td>{fmtDateTime(v.createdAt, tz)}</td>
                  <td>
                    <span className="chips">
                      <StatusBadge kind="map" status={v.approvalStatus} label={label(STATUS_LABELS, v.approvalStatus)} />
                      {v.active ? <StatusBadge kind="publication" status="published" label="Active" /> : null}
                    </span>
                  </td>
                  <td>{v.width && v.height ? `${v.width} x ${v.height}` : <span className="muted">Not processed</span>}</td>
                  <td>{v.zones.length}</td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedId(v.id)} aria-pressed={v.id === selectedId}>
                      {v.id === selectedId ? 'Open' : 'View'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      {selected ? <VersionPanel key={selected.id} code={code} v={selected} tz={tz} onChanged={(m) => { setNotice(m); router.refresh(); }} /> : null}
    </div>
  );
}

function VersionPanel({ code, v, tz, onChanged }: { code: string; v: MapVersionRow; tz: string | null; onChanged: (message: string) => void }) {
  const draft = v.approvalStatus === 'draft';
  const [zone, setZone] = useState<ZoneRow | null>(null);
  const [center, setCenter] = useState<Point | null>(null);
  const processed = v.width !== null && v.height !== null;
  // The worker streams a map only once it is canonical (it never serves the raw upload).
  const src = processed ? `/api/staff/${code}/maps/${v.id}/image` : null;

  return (
    <section className="card stack-lg" aria-labelledby="version-h">
      <div className="stack">
        <h2 id="version-h" className="review-card-title">
          {label(STATUS_LABELS, v.approvalStatus)} version
          <StatusBadge kind="map" status={v.approvalStatus} label={label(STATUS_LABELS, v.approvalStatus)} />
          {v.active ? <StatusBadge kind="publication" status="published" label="Active" /> : null}
        </h2>
        <p className="small muted" style={{ margin: 0 }}>
          Created {fmtDateTime(v.createdAt, tz)}
          {v.submittedAt ? `; submitted ${fmtDateTime(v.submittedAt, tz)}` : ''}
          {v.approvedAt ? `; approved ${fmtDateTime(v.approvedAt, tz)}` : ''}
        </p>
        {v.approvalStatus === 'rejected' ? (
          <Notice tone="warning">
            The district sent this version back{v.rejectedReason ? `: ${label(MAP_REJECT_REASON_LABELS, v.rejectedReason)}` : '.'} Create a new draft with the changes.
          </Notice>
        ) : null}
        {!draft ? <p className="hint">Only drafts can change. Zones on this version are frozen.</p> : null}
      </div>

      {draft ? <UploadImage code={code} versionId={v.id} onDone={() => onChanged('Uploaded. The image is processed in the background; refresh in a minute.')} /> : null}

      {src ? (
        <div style={{ maxWidth: '56rem' }}>
          <MapPicker
            src={src}
            width={v.width}
            height={v.height}
            zones={v.zones.filter((z) => z.active)}
            showZones
            value={draft ? center : null}
            onChange={draft && processed ? (p) => setCenter(p) : undefined}
            readOnly={!(draft && processed)}
            label={draft && processed ? 'Campus map draft. Choose a zone center location.' : 'Campus map draft'}
            help="Click the map, or focus it and use the arrow keys (Shift for bigger steps) then Enter. You can also type the position below."
            coordinateInputs
            showCoordinates
            pointLabel="zone center"
          />
        </div>
      ) : (
        <p className="muted small">No map image available.</p>
      )}
      {draft && !processed ? <p className="hint">Zones can be drawn once the uploaded image has been processed.</p> : null}

      <div className="stack">
        <h3 className="with-icon">
          <IconMap />
          Zones ({v.zones.length})
        </h3>
        <p className="hint">Zone names are public labels, so leave restrooms, the clinic, counseling, and other sensitive rooms out.</p>
        {v.zones.length > 0 ? (
          <Table caption="Zones" hideCaption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Center</th>
                <th scope="col">Radius</th>
                <th scope="col">Status</th>
                {draft ? <th scope="col">Edit</th> : null}
              </tr>
            </thead>
            <tbody>
              {v.zones.map((z) => (
                <tr key={z.id}>
                  <td>{z.name}</td>
                  <td className="small">
                    {(z.cx * 100).toFixed(1)}%, {(z.cy * 100).toFixed(1)}%
                  </td>
                  <td className="small">{(z.radius * 100).toFixed(1)}%</td>
                  <td>{z.active ? <StatusBadge kind="member" status="active" /> : <StatusBadge kind="member" status="deactivated" label="Off" />}</td>
                  {draft ? (
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconPencil />}
                        onClick={() => {
                          setZone(z);
                          setCenter({ x: z.cx, y: z.cy });
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="muted">No zones yet.</p>
        )}
        {draft && processed ? (
          <ZoneForm
            key={zone?.id ?? 'new'}
            code={code}
            versionId={v.id}
            zone={zone}
            center={center}
            onDone={(m) => {
              setZone(null);
              setCenter(null);
              onChanged(m);
            }}
            onCancel={() => {
              setZone(null);
              setCenter(null);
            }}
          />
        ) : null}
      </div>

      {draft ? (
        <div className="stack">
          <h3>Submit for district approval</h3>
          <p className="hint">The district reviews the map and zone package, then activates it. Every active pickup location needs a pin on this version first (Locations page).</p>
          <ConfirmButton
            label="Submit for approval"
            prompt="Submit this map and its zones to the district? You cannot edit it after submitting."
            confirmLabel="Submit"
            disabled={!processed || v.zones.length === 0}
            onConfirm={async () => {
              await staffApi(`/api/staff/${code}/maps/${v.id}/submit`, { body: {} });
              onChanged('Submitted. The district will review it.');
            }}
          />
          {!processed || v.zones.length === 0 ? <p className="hint">Upload a processed image and add at least one zone before submitting.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function UploadImage({ code, versionId, onDone }: { code: string; versionId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (!/^image\/(png|jpeg)$/.test(file.type)) throw new ApiError('invalid_input', 'Use a PNG or JPEG image.', 400);
      if (file.size > MAX_BYTES) throw new ApiError('invalid_input', 'The image must be 4 MB or smaller.', 400);
      let width = 0;
      try {
        const bmp = await createImageBitmap(file);
        width = bmp.width;
        bmp.close();
      } catch {
        throw new ApiError('invalid_input', 'That image could not be read.', 400);
      }
      if (width < MIN_WIDTH) throw new ApiError('invalid_input', `The image must be at least ${MIN_WIDTH} pixels wide.`, 400);
      const put = await staffApi<{ url: string | null; contentType: string }>(`/api/staff/${code}/maps/${versionId}/upload`, {
        body: { contentType: file.type },
      });
      if (!put.url) throw new ApiError('upstream_unavailable', 'The upload link could not be created. Please try again.', 503);
      // The presigned PUT signs the content type: send exactly the value the broker returned.
      const res = await fetch(put.url, { method: 'PUT', body: file, headers: { 'content-type': put.contentType }, credentials: 'omit' });
      if (!res.ok) throw new ApiError('upstream_unavailable', 'The upload was refused or the link expired. Please try again.', 503);
      setFile(null);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={upload} className="stack" aria-label="Upload map image">
      <h3>Map image</h3>
      <TextInput
        id={`map-file-${versionId}`}
        label={`PNG or JPEG, at most 4 MB, at least ${MIN_WIDTH} px wide`}
        type="file"
        accept="image/png,image/jpeg"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <Button type="submit" variant="primary" disabled={!file || busy} icon={<IconUpload />}>
        {busy ? 'Uploading...' : 'Upload image'}
      </Button>
      <ActionError error={error} />
    </form>
  );
}

function ZoneForm({
  code,
  versionId,
  zone,
  center,
  onDone,
  onCancel,
}: {
  code: string;
  versionId: string;
  zone: ZoneRow | null;
  center: Point | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(zone?.name ?? '');
  const [radiusPct, setRadiusPct] = useState(zone ? Math.round(zone.radius * 1000) / 10 : 6);
  const [active, setActive] = useState(zone?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!center) {
      setError(new ApiError('invalid_input', 'Choose the zone center on the map first.', 400));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await staffApi(`/api/staff/${code}/maps/${versionId}/zones`, {
        body: { zoneId: zone?.id ?? null, name, cx: center.x, cy: center.y, radius: Math.min(0.5, Math.max(0.005, radiusPct / 100)), active },
      });
      onDone(zone ? 'Zone saved.' : 'Zone added.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="stack review-panel" aria-label={zone ? `Edit zone ${zone.name}` : 'Add zone'}>
      <h4 style={{ margin: 0 }}>{zone ? `Edit ${zone.name}` : 'Add a zone'}</h4>
      <p className="hint">Pick the center on the map above (click, or arrow keys and Enter, or type the position).</p>
      <div className="grid">
        <TextInput id={`zone-name-${zone?.id ?? 'new'}`} label="Public name" required minLength={2} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Gym lobby" />
        <TextInput
          id={`zone-radius-${zone?.id ?? 'new'}`}
          label="Radius (% of map width)"
          type="number"
          min={0.5}
          max={50}
          step={0.5}
          value={radiusPct}
          onChange={(e) => setRadiusPct(Number(e.target.value))}
        />
      </div>
      <label className="choice">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>Active</span>
      </label>
      <p className="small muted" style={{ margin: 0 }}>
        Center: {center ? `${(center.x * 100).toFixed(1)}% across, ${(center.y * 100).toFixed(1)}% down` : 'not chosen'}
      </p>
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy} icon={<IconCheck />}>
          {busy ? 'Saving...' : zone ? 'Save zone' : 'Add zone'}
        </Button>
        {zone ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <ActionError error={error} />
    </form>
  );
}
