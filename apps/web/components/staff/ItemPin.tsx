'use client';

import { MapCanvas } from './MapCanvas.tsx';

export type PinMapInfo = { versionId: string; url: string | null; width: number; height: number } | null;

// The exact finder pin is staff-only (§5.1 step 4). It is drawn on the active public map when the
// item used that version; school admins can also load older private versions through a map.read
// ticket; otherwise the position is given as text.
export function ItemPin({
  code,
  pin,
  mapVersionId,
  activeMap,
  canReadMaps,
  label,
}: {
  code: string;
  pin: { x: number; y: number } | null;
  mapVersionId: string | null;
  activeMap: PinMapInfo;
  canReadMaps: boolean;
  label: string;
}) {
  if (!pin) return <span className="muted">No pin</span>;
  const text = `${(pin.x * 100).toFixed(0)}% across, ${(pin.y * 100).toFixed(0)}% down`;
  let src: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  if (activeMap && mapVersionId === activeMap.versionId && activeMap.url) {
    src = activeMap.url;
    width = activeMap.width;
    height = activeMap.height;
  } else if (canReadMaps && mapVersionId) {
    src = `/api/staff/${code}/maps/${mapVersionId}/image`;
  }
  if (!src) return <span>{text} (on an earlier map version)</span>;
  return (
    <details>
      <summary>Show pin on map ({text})</summary>
      <div style={{ marginTop: '0.5rem' }}>
        <MapCanvas src={src} alt={`Campus map with the pin for ${label}`} width={width} height={height} markers={[{ id: 'pin', x: pin.x, y: pin.y, label }]} maxWidth="32rem" />
      </div>
    </details>
  );
}
