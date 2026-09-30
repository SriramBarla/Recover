'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconAlert, IconBuilding, IconCheck, IconMapPin, IconPencil, IconPlus, IconX } from '@/components/ui/icons.tsx';
import type { MapPoint as Point } from '@/components/ui/map-geometry.ts';
import { MapPicker } from '@/components/ui/map-picker.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { Select } from '@/components/ui/select.tsx';
import { Table } from '@/components/ui/table.tsx';
import { ActionError } from './ActionError.tsx';
import { staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
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

  const current = locations.find((l) => l.id === pinFor) ?? null;

  return (
    <div className="stack-lg">
      <p className="visually-hidden" role="status" aria-live="polite">
        {notice}
      </p>
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <section className="stack" aria-labelledby="loc-h">
        <div className="spread">
          <h2 id="loc-h" className="with-icon">
            <IconBuilding />
            Pickup locations
          </h2>
          <Button onClick={() => setEditing('new')} icon={<IconPlus />}>
            Add location
          </Button>
        </div>
        {editing === 'new' ? <LocationForm code={code} onDone={(msg) => { setEditing(null); setNotice(msg); router.refresh(); }} onCancel={() => setEditing(null)} /> : null}
        {locations.length === 0 ? (
          <p className="muted">No locations yet.</p>
        ) : (
          <Table caption="Pickup locations" hideCaption>
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
              {locations.map((l) => {
                const pinned = version ? pinOn(l, version) !== null : false;
                return (
                  <tr key={l.id}>
                    <td className="mono">{l.code}</td>
                    <td>{l.name}</td>
                    <td className="small">{l.hours ?? <span className="muted">Not set</span>}</td>
                    <td>
                      {l.active ? (
                        <Badge tone="ok" icon={<IconCheck />}>
                          Active
                        </Badge>
                      ) : (
                        <Badge icon={<IconX />}>Inactive</Badge>
                      )}
                    </td>
                    <td>
                      {version ? (
                        pinned ? (
                          <Badge tone="ok" icon={<IconMapPin />}>
                            Pinned
                          </Badge>
                        ) : (
                          <Badge tone={l.active ? 'warn' : 'neutral'} icon={<IconAlert />}>
                            No pin
                          </Badge>
                        )
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(l)} icon={<IconPencil />}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {editing && editing !== 'new' ? (
          <LocationForm key={editing.id} code={code} location={editing} onDone={(msg) => { setEditing(null); setNotice(msg); router.refresh(); }} onCancel={() => setEditing(null)} />
        ) : null}
      </section>

      <section className="stack" aria-labelledby="pins-h">
        <h2 id="pins-h" className="with-icon">
          <IconMapPin />
          Location pins
        </h2>
        {pinnable.length === 0 ? (
          <p className="muted">Create a draft map on the Map page first.</p>
        ) : (
          <>
            <div className="grid-wide">
              <Select
                id="pin-version"
                label="Map version"
                value={versionId}
                onChange={(e) => {
                  setVersionId(e.target.value);
                  setPicked(null);
                }}
                options={pinnable.map((v) => ({
                  value: v.id,
                  label: `${v.active ? 'Active map' : v.approvalStatus === 'draft' ? 'Draft' : 'Waiting for district'} (${v.id.slice(0, 8)})`,
                }))}
              />
              <Select
                id="pin-location"
                label="Location to pin"
                value={pinFor}
                onChange={(e) => {
                  setPinFor(e.target.value);
                  setPicked(null);
                }}
                options={locations.filter((l) => l.active).map((l) => ({ value: l.id, label: l.name }))}
              />
            </div>
            {version ? (
              version.width !== null ? (
                <div style={{ maxWidth: '48rem' }}>
                  <MapPicker
                    src={`/api/staff/${code}/maps/${version.id}/image`}
                    width={version.width}
                    height={version.height}
                    label="Campus map. Choose a location pin location."
                    help="Click the map, or focus it and use the arrow keys (Shift for bigger steps) then Enter. You can also type the position below."
                    markers={locations
                      .filter((l) => l.active && l.id !== pinFor)
                      .flatMap((l) => {
                        const p = pinOn(l, version);
                        return p ? [{ id: l.id, x: p.x, y: p.y, label: l.name }] : [];
                      })}
                    value={picked ?? (current ? pinOn(current, version) : null)}
                    onChange={(p) => setPicked(p)}
                    coordinateInputs
                    showCoordinates
                    pointLabel="location pin"
                  />
                </div>
              ) : (
                <p className="muted small">No map image available.</p>
              )
            ) : null}
            <div className="row">
              <Button variant="primary" disabled={!picked || !pinFor || pinBusy} onClick={() => void savePin()} icon={<IconCheck />}>
                {pinBusy ? 'Saving...' : 'Save pin'}
              </Button>
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
  const formId = location ? `loc-${location.id}` : 'loc-new';

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
        <TextInput
          id={`${formId}-code`}
          label="Code"
          hint="1 to 6 letters or digits, used in item IDs."
          className="mono"
          required
          pattern="[A-Za-z0-9]{1,6}"
          maxLength={6}
          value={codeValue}
          onChange={(e) => setCodeValue(e.target.value.toUpperCase())}
        />
        <TextInput
          id={`${formId}-name`}
          label="Name"
          required
          minLength={2}
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Front office"
        />
        <TextInput
          id={`${formId}-hours`}
          label="Pickup hours"
          maxLength={120}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          placeholder="Mon-Fri 7:30-3:30"
        />
      </div>
      <label className="choice">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>Active (students can choose it as a drop-off)</span>
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
          <Button type="submit" variant="primary" disabled={busy} icon={<IconCheck />}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ActionError error={error} />
    </form>
  );
}
