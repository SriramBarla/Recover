'use client';
// Campus map pin (§5.1 step 4; Appendix H; §18 "the map is an <img> with a click handler").
// Pointer: click or tap to drop the pin. Keyboard: the map is focusable; arrow keys move a crosshair
// (Shift for bigger steps) and Enter or Space drops the pin there. Non-map fallback: an area picker that
// places the pin at the chosen zone's center. Coordinates are normalized 0..1 of the approved public map.
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

export type MapPin = { x: number; y: number };
export type MapZone = { id: string; name: string; cx: number; cy: number; radius: number };
export type MapImage = { versionId: string; url: string; width: number; height: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number(n.toFixed(6))));

function scaledDistance(a: MapPin, b: MapPin, w: number, h: number): number {
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h) / Math.max(w, h, 1);
}

// Same rule as private.resolve_zone: nearest active zone whose aspect-scaled distance is within its radius.
export function zoneAt(p: MapPin, zones: MapZone[], w: number, h: number): MapZone | null {
  let best: MapZone | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const z of zones) {
    const d = scaledDistance(p, { x: z.cx, y: z.cy }, w, h);
    if (d <= z.radius && d < bestD) {
      best = z;
      bestD = d;
    }
  }
  return best;
}

export function nearestById<T extends { id: string; pin: MapPin | null }>(p: MapPin, list: T[], w: number, h: number): T | null {
  let best: T | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const l of list) {
    if (!l.pin) continue;
    const d = scaledDistance(p, l.pin, w, h);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

export function MapPicker({
  map,
  zones,
  value,
  onChange,
  label,
}: {
  map: MapImage;
  zones: MapZone[];
  value: MapPin | null;
  onChange: (p: MapPin | null) => void;
  label: string;
}) {
  const id = useId();
  const imgRef = useRef<HTMLImageElement>(null);
  const [cursor, setCursor] = useState<MapPin>(value ?? { x: 0.5, y: 0.5 });
  const [focused, setFocused] = useState(false);
  const [announce, setAnnounce] = useState('');
  const sortedZones = [...zones].sort((a, b) => a.name.localeCompare(b.name));
  const describe = (p: MapPin) => {
    const z = zoneAt(p, zones, map.width, map.height);
    return z ? `near ${z.name}` : `${Math.round(p.x * 100)}% across and ${Math.round(p.y * 100)}% down the map`;
  };
  const currentZone = value ? zoneAt(value, zones, map.width, map.height) : null;

  function place(p: MapPin) {
    const pin = { x: clamp01(p.x), y: clamp01(p.y) };
    setCursor(pin);
    onChange(pin);
    setAnnounce(`Pin dropped ${describe(pin)}.`);
  }

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return;
    place({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      const next = { x: clamp01(cursor.x + m[0]), y: clamp01(cursor.y + m[1]) };
      const before = zoneAt(cursor, zones, map.width, map.height);
      const after = zoneAt(next, zones, map.width, map.height);
      setCursor(next);
      // Announce only when the crosshair enters or leaves a named area, not on every step.
      if (before?.id !== after?.id) setAnnounce(after ? `Crosshair near ${after.name}.` : 'Crosshair outside the named areas.');
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      place(cursor);
    }
  }

  function onZone(zoneId: string) {
    const z = zones.find((x) => x.id === zoneId);
    if (z) place({ x: z.cx, y: z.cy });
  }

  return (
    <div className="stack">
      <p id={`${id}-help`} className="hint">
        Tap the map where you found it. With a keyboard, select the map, move the crosshair with the arrow keys (hold Shift
        for bigger steps), and press Enter to drop the pin.
      </p>
      <div
        className="map-frame"
        role="application"
        aria-roledescription="map"
        aria-label={`${label}. ${value ? `Pin ${describe(value)}.` : 'No pin yet.'}`}
        aria-describedby={`${id}-help`}
        tabIndex={0}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ cursor: 'crosshair' }}
      >
        <img ref={imgRef} src={map.url} alt="" width={map.width} height={map.height} draggable={false} />
        {value && <span className="map-pin" style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }} />}
        {focused && <span className="map-crosshair" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} />}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
      {sortedZones.length > 0 && (
        <div className="field">
          <label className="label" htmlFor={`${id}-zone`}>
            Or choose an area
          </label>
          <select id={`${id}-zone`} className="select" value={currentZone?.id ?? ''} onChange={(e) => onZone(e.target.value)}>
            <option value="">{value && !currentZone ? 'Pin placed on the map' : 'Choose an area'}</option>
            {sortedZones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {value && (
        <p className="row">
          <span className="small">Pin {describe(value)}.</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onChange(null);
              setAnnounce('Pin removed.');
            }}
          >
            Remove pin
          </button>
        </p>
      )}
    </div>
  );
}
