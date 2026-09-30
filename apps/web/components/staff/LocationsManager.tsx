'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ActionError } from './ActionError.tsx';
import { staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { MapCanvas, type Point } from './MapCanvas.tsx';
import type { LocationRow, MapVersionRow } from './shapes.ts';

type Props = { code: string; locations: LocationRow[]; versions: MapVersionRow[] };

const PINNABLE = new Set(['draft', 'pending_district']);

function pinOn(l: LocationRow, v: MapVersionRow): Point | null {
  const p = l.pins.find((x) => x.mapVersionId === v.id);
  if (p) return { x: p.x, y: p.y };
  return v.active && l.pin ? l.pin : null;
}

// Pickup locations and their pins (§5.5; §24 step 3: every active location needs a pin on the map
// before the district can activate it). Deactivating needs a recent sign-in (G-31).
export function LocationsManager({ code, locations, versions }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<LocationRow | 'new' | null>(null);
  const pinnable = versions.filter((v) => v.active || PINNABLE.has(v.approvalStatus));
  const [versionId, setVersionId] = useState(pinnable.find((v) => v.active)?.id ?? pinnable[0]?.id ?? '');
  const [pinFor, setPinFor] = useState(locations.find((l) => l.active)?.id ?? '');
  const [picked, setPicked] = useState<Point | null>(null);
  const [pinError, setPinError] = useState<unknown>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const version = pinnable.find((v) => v.id === versionId) ?? null;

  const savePin = async () => {
    if (!version || !pinFor || !picked) return;
    setPinBusy(true);
    setPinError(null);
    try {
      await staffApi(`/api/staff/${code}/locations/${pinFor}/pin`, { body: { mapVersionId: version.id, x: picked.x, y: picked.y } });
      setNotice('Pin saved.');
      setPicked(null);
      router.refresh();
    } catch (e) {
      setPinError(e);
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <p className="visually-hidden" role="status" aria-live="polite">
        {notice}
      </p>
      {notice ? <div className="notice notice-ok">{notice}</div> : null}
      <section className="stack" aria-labelledby="loc-h">
        <div className="spread">
          <h2 id="loc-h">Pickup locations</h2>
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            Add location
          </button>
        </div>
        {editing === 'new' ? <LocationForm code={code} onDone={(msg) => { setEditing(null); setNotice(msg); router.refresh(); }} onCancel={() => setEditing(null)} /> : null}
        {locations.length === 0 ? (
          <p className="muted">No locations yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Status</th>
                  <th scope="col">Pin on selected map</th>
                  <th scope="col">Edit</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.id}>
                    <td className="mono">{l.code}</td>
                    <td>{l.name}</td>
                    <td className="small">{l.hours ?? <span className="muted">Not set</span>}</td>
                    <td>{l.active ? <span className="badge badge-ok">Active</span> : <span className="badge">Inactive</span>}</td>
                    <td>{version ? (pinOn(l, version) ? <span className="badge badge-ok">Pinned</span> : <span className={l.active ? 'badge badge-warn' : 'badge'}>No pin</span>) : '-'}</td>
                    <td>
                      <button type="button" className="btn btn-ghost" onClick={() => setEditing(l)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editing && editing !== 'new' ? (
          <LocationForm key={editing.id} code={code} location={editing} onDone={(msg) => { setEditing(null); setNotice(msg); router.refresh(); }} onCancel={() => setEditing(null)} />
        ) : null}
      </section>

      <section className="stack" aria-labelledby="pins-h">
        <h2 id="pins-h">Location pins</h2>
        {pinnable.length === 0 ? (
          <p className="muted">Create a draft map on the Map page first.</p>
        ) : (
          <>
            <div className="grid">
              <label className="field">
                <span className="label">Map version</span>
                <select className="select" value={versionId} onChange={(e) => { setVersionId(e.target.value); setPicked(null); }}>
                  {pinnable.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.active ? 'Active map' : v.approvalStatus === 'draft' ? 'Draft' : 'Waiting for district'} ({v.id.slice(0, 8)})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">Location to pin</span>
                <select className="select" value={pinFor} onChange={(e) => { setPinFor(e.target.value); setPicked(null); }}>
                  {locations
                    .filter((l) => l.active)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {version ? (
              <MapCanvas
                src={version.width !== null ? `/api/staff/${code}/maps/${version.id}/image` : null}
                alt="Campus map"
                width={version.width}
                height={version.height}
                markers={locations
                  .filter((l) => l.active && l.id !== pinFor)
                  .flatMap((l) => {
                    const p = pinOn(l, version);
                    return p ? [{ id: l.id, x: p.x, y: p.y, label: l.name }] : [];
                  })}
                picked={picked ?? (locations.find((l) => l.id === pinFor) ? pinOn(locations.find((l) => l.id === pinFor)!, version) : null)}
                onPick={setPicked}
                pickLabel="location pin"
                maxWidth="48rem"
              />
            ) : null}
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={!picked || !pinFor || pinBusy} onClick={() => void savePin()}>
                {pinBusy ? 'Saving...' : 'Save pin'}
              </button>
            </div>
            <ActionError error={pinError} />
          </>
        )}
      </section>
    </div>
  );
}

function LocationForm({ code, location, onDone, onCancel }: { code: string; location?: LocationRow; onDone: (message: string) => void; onCancel: () => void }) {
  const [codeValue, setCodeValue] = useState(location?.code ?? '');
  const [name, setName] = useState(location?.name ?? '');
  const [hours, setHours] = useState(location?.hours ?? '');
  const [active, setActive] = useState(location?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const deactivating = location !== undefined && location.active && !active;

  const save = async () => {
    await staffApi(`/api/staff/${code}/locations`, {
      body: { locationId: location?.id ?? null, code: codeValue.trim().toUpperCase(), name, hours: hours.trim() ? hours : null, active },
    });
    onDone(location ? 'Location saved.' : 'Location added.');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (deactivating) return;
    setBusy(true);
    setError(null);
    try {
      await save();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card stack" aria-label={location ? `Edit ${location.name}` : 'New location'}>
      <h3>{location ? `Edit ${location.name}` : 'New location'}</h3>
      <div className="grid">
        <label className="field">
          <span className="label">Code</span>
          <input className="input mono" required pattern="[A-Za-z0-9]{1,6}" maxLength={6} value={codeValue} onChange={(e) => setCodeValue(e.target.value.toUpperCase())} />
          <span className="hint">1 to 6 letters or digits, used in item IDs.</span>
        </label>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Front office" />
        </label>
        <label className="field">
          <span className="label">Pickup hours</span>
          <input className="input" maxLength={120} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Mon-Fri 7:30-3:30" />
        </label>
      </div>
      <label className="row">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active (students can choose it as a drop-off)
      </label>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {deactivating ? (
          <ConfirmButton
            label="Deactivate location"
            prompt="Deactivate this location? It is refused while items are checked in there. Needs a recent sign-in."
            confirmLabel="Deactivate"
            danger
            onConfirm={save}
          />
        ) : (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ActionError error={error} />
    </form>
  );
}
