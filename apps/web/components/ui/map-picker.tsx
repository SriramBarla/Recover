'use client';
// MapPicker: the campus map as a plain <img> with a normalized (0..1) pin (§5.1 step 4, §18).
// Shared by the student found and lost flows and the staff pin and zone editors.
// - Pointer: click or tap places the pin.
// - Keyboard: focus the map, arrow keys move a crosshair (Shift moves 5x), Enter or Space
//   places the pin, Delete clears it (when clearable).
// - Non-map fallback: a visible zone <select> places the pin at the zone's center.
// - Announcements: placement is announced at once; crosshair moves are announced after a pause.
// - readOnly: no interaction. Staff review may pass the exact pin as `value`; public listings
//   must not (the public DTO has no pin) and pass `highlightZoneId` instead.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { cx } from './cx.ts';
import { IconBuilding, IconChevronDown, IconMapPin, IconX } from './icons.tsx';

export type MapPoint = { x: number; y: number };
export type MapZone = { id: string; name: string; cx: number; cy: number; radius: number };
export type MapMarker = { id: string; x: number; y: number; label: string };

export type MapPickerProps = {
  src: string;
  width: number;
  height: number;
  value: MapPoint | null;
  onChange?: (value: MapPoint | null, zone: MapZone | null) => void;
  zones?: readonly MapZone[];
  readOnly?: boolean;
  label?: string;
  // Draw every zone as a labelled circle (staff zone editor, review).
  showZones?: boolean;
  // Read-only listings: outline this zone instead of showing a pin.
  highlightZoneId?: string | null;
  // Fixed points such as drop-off locations.
  markers?: readonly MapMarker[];
  clearable?: boolean;
  zoneSelectLabel?: string;
  help?: string;
  priority?: boolean;
  id?: string;
  className?: string;
};

const STEP = 0.02;
const BIG_STEP = STEP * 5;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Mirrors private.resolve_zone: nearest active zone whose aspect-scaled distance is within its radius.
export function nearestZone(zones: readonly MapZone[], p: MapPoint | null, width: number, height: number): MapZone | null {
  if (!p || zones.length === 0 || width <= 0 || height <= 0) return null;
  const scale = Math.max(width, height);
  let best: MapZone | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const z of zones) {
    const d = Math.hypot((p.x - z.cx) * width, (p.y - z.cy) * height) / scale;
    if (d <= z.radius && d < bestD) {
      best = z;
      bestD = d;
    }
  }
  return best;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function describe(p: MapPoint, zone: MapZone | null): string {
  const where = `${pct(p.x)} across, ${pct(p.y)} down`;
  return zone ? `near ${zone.name}, ${where}` : `${where}, not near a named area`;
}

function ZoneShape({ zone, width, height, highlight }: { zone: MapZone; width: number; height: number; highlight: boolean }) {
  const scale = Math.max(width, height);
  const rw = (zone.radius * scale) / width;
  const rh = (zone.radius * scale) / height;
  return (
    <>
      <span
        className="map-zone"
        data-highlight={highlight ? 'true' : undefined}
        style={{ left: `${(zone.cx - rw) * 100}%`, top: `${(zone.cy - rh) * 100}%`, width: `${rw * 200}%`, height: `${rh * 200}%` }}
      />
      <span className="map-zone-label" style={{ left: `${zone.cx * 100}%`, top: `${zone.cy * 100}%` }}>
        {zone.name}
      </span>
    </>
  );
}

function Marker({ p, animate }: { p: MapPoint; animate: boolean }) {
  return (
    <span className="map-marker" data-animate={animate ? 'true' : undefined} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
      <svg viewBox="0 0 34 42" aria-hidden="true">
        <path className="mm-body" d="M17 40.5S3.5 27.6 3.5 16.2a13.5 13.5 0 0 1 27 0C30.5 27.6 17 40.5 17 40.5Z" />
        <circle className="mm-dot" cx="17" cy="16" r="5" />
      </svg>
    </span>
  );
}

export function MapPicker({
  src,
  width,
  height,
  value,
  onChange,
  zones = [],
  readOnly = false,
  label = 'Campus map',
  showZones = false,
  highlightZoneId = null,
  markers = [],
  clearable = false,
  zoneSelectLabel = 'Or choose an area from the list',
  help,
  priority = false,
  id,
  className,
}: MapPickerProps) {
  const autoId = useId();
  const base = id ?? autoId;
  const helpId = `${base}-help`;
  const readoutId = `${base}-readout`;
  const selectId = `${base}-zone`;
  const [cross, setCross] = useState<MapPoint>(value ?? { x: 0.5, y: 0.5 });
  const [message, setMessage] = useState('');
  const [dropKey, setDropKey] = useState(0);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow external value changes (zone select, reset by the page).
  useEffect(() => {
    if (value) setCross(value);
  }, [value]);

  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
    },
    [],
  );

  const zone = nearestZone(zones, value, width, height);
  const highlighted = highlightZoneId ? zones.find((z) => z.id === highlightZoneId) ?? null : null;
  const interactive = !readOnly;

  function place(p: MapPoint, spoken?: string) {
    const next = { x: round4(clamp01(p.x)), y: round4(clamp01(p.y)) };
    const z = nearestZone(zones, next, width, height);
    setCross(next);
    setDropKey((k) => k + 1);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    setMessage(spoken ?? `Pin placed ${describe(next, z)}.`);
    onChange?.(next, z);
  }

  function clear() {
    setMessage('Pin removed.');
    onChange?.(null, null);
  }

  function onClick(e: MouseEvent<HTMLDivElement>) {
    if (!interactive) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    place({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    const step = e.shiftKey ? BIG_STEP : STEP;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      place(cross);
      return;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && clearable && value) {
      e.preventDefault();
      clear();
      return;
    } else return;
    e.preventDefault();
    const next = { x: round4(clamp01(cross.x + dx)), y: round4(clamp01(cross.y + dy)) };
    setCross(next);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => {
      setMessage(`Crosshair ${describe(next, nearestZone(zones, next, width, height))}. Press Enter to place the pin.`);
    }, 450);
  }

  function onZoneSelect(zoneId: string) {
    const z = zones.find((x) => x.id === zoneId);
    if (!z) return;
    place({ x: z.cx, y: z.cy }, `Pin placed at ${z.name}.`);
  }

  const readoutText = value ? (zone ? `Pin placed near ${zone.name}` : 'Pin placed (not near a named area)') : 'No pin yet';
  const roLabel = readOnly
    ? value
      ? `${label}, pin ${zone ? `near ${zone.name}` : 'placed'}`
      : highlighted
        ? `${label}, ${highlighted.name} area highlighted`
        : label
    : undefined;
  const sortedZones = [...zones].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={cx('map-picker', className)}>
      {interactive ? (
        <p className="map-help" id={helpId}>
          {help ?? 'Tap the map where it was. With a keyboard: focus the map, move with the arrow keys (hold Shift for bigger steps), then press Enter.'}
        </p>
      ) : null}
      <div
        className="map-frame"
        data-interactive={interactive ? 'true' : undefined}
        role={interactive ? 'application' : 'img'}
        aria-roledescription={interactive ? 'map' : undefined}
        aria-label={interactive ? label : roLabel}
        aria-describedby={interactive ? `${helpId} ${readoutId}` : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={interactive ? onClick : undefined}
        onKeyDown={interactive ? onKeyDown : undefined}
      >
        <img src={src} width={width} height={height} alt="" draggable={false} loading={priority ? 'eager' : 'lazy'} decoding="async" />
        {showZones ? zones.map((z) => <ZoneShape key={z.id} zone={z} width={width} height={height} highlight={z.id === highlightZoneId} />) : null}
        {!showZones && highlighted ? <ZoneShape zone={highlighted} width={width} height={height} highlight /> : null}
        {markers.map((m) => (
          <span key={m.id} className="map-poi" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}>
            <IconBuilding size={14} />
            {m.label}
          </span>
        ))}
        {value ? <Marker key={dropKey} p={value} animate={interactive && dropKey > 0} /> : null}
        {interactive ? <span className="map-crosshair" style={{ left: `${cross.x * 100}%`, top: `${cross.y * 100}%` }} /> : null}
      </div>
      {interactive ? (
        <>
          <div className="map-readout" id={readoutId}>
            <span className="map-readout-text">
              <IconMapPin size={18} />
              <span>{readoutText}</span>
            </span>
            {clearable && value ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
                <IconX size={16} />
                <span className="btn-label">Clear pin</span>
              </button>
            ) : null}
          </div>
          {zones.length > 0 ? (
            <div className="field">
              <label className="label" htmlFor={selectId}>
                {zoneSelectLabel}
              </label>
              <span className="select-wrap">
                <select id={selectId} className="select" value={zone?.id ?? ''} onChange={(e) => onZoneSelect(e.target.value)}>
                  <option value="">Choose an area</option>
                  {sortedZones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
                <IconChevronDown className="select-chevron" size={18} />
              </span>
            </div>
          ) : null}
          <div className="visually-hidden" aria-live="polite" aria-atomic="true">
            {message}
          </div>
        </>
      ) : null}
    </div>
  );
}
