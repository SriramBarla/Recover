'use client';

import { useId, useState, type KeyboardEvent, type MouseEvent } from 'react';

export type MapMarker = { id: string; x: number; y: number; label: string };
export type MapZone = { id: string; name: string; cx: number; cy: number; radius: number; active?: boolean };
export type Point = { x: number; y: number };

type Props = {
  src: string | null;
  alt: string;
  width?: number | null;
  height?: number | null;
  markers?: MapMarker[];
  zones?: MapZone[];
  picked?: Point | null;
  onPick?: (p: Point) => void;
  pickLabel?: string;
  maxWidth?: string;
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

// The campus map is an <img> with overlays (§18: no map library). Picking works by pointer, by
// arrow keys moving a crosshair (Enter places it), or by typing percentages: the keyboard and
// numeric paths are the non-pointer fallback §18 requires.
export function MapCanvas({ src, alt, width, height, markers = [], zones = [], picked = null, onPick, pickLabel = 'pin', maxWidth }: Props) {
  const hintId = useId();
  const [cross, setCross] = useState<Point>(picked ?? { x: 0.5, y: 0.5 });
  const [focused, setFocused] = useState(false);
  const [px, setPx] = useState('');
  const [py, setPy] = useState('');

  const pick = (p: Point) => {
    const q = { x: round6(clamp(p.x)), y: round6(clamp(p.y)) };
    setCross(q);
    onPick?.(q);
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onPick) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    pick({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onPick) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      setCross((c) => ({ x: clamp(c.x + m.x), y: clamp(c.y + m.y) }));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(cross);
    }
  };

  const aspect = width && height ? `${width} / ${height}` : undefined;

  return (
    <div className="stack" style={maxWidth ? { maxWidth } : undefined}>
      <div
        className="map-frame"
        style={{ aspectRatio: aspect, cursor: onPick ? 'crosshair' : undefined, minHeight: src ? undefined : '8rem' }}
        onClick={onClick}
        onKeyDown={onKey}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        tabIndex={onPick ? 0 : undefined}
        role={onPick ? 'group' : undefined}
        aria-label={onPick ? `${alt}. Choose a ${pickLabel} location.` : undefined}
        aria-describedby={onPick ? hintId : undefined}
      >
        {src ? (
          <img src={src} alt={onPick ? '' : alt} draggable={false} loading="lazy" decoding="async" style={aspect ? { width: '100%', height: '100%', objectFit: 'fill' } : undefined} />
        ) : (
          <p className="muted small" style={{ padding: '1rem' }}>
            No map image available.
          </p>
        )}
        {zones
          .filter((z) => z.active !== false)
          .map((z) => (
            <span
              key={z.id}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: `${z.cx * 100}%`,
                top: `${z.cy * 100}%`,
                width: `${z.radius * 200}%`,
                aspectRatio: '1 / 1',
                transform: 'translate(-50%, -50%)',
                border: '2px dashed var(--brand)',
                borderRadius: '50%',
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.75rem',
                fontWeight: 700,
                color: 'var(--brand)',
                textShadow: '0 0 3px var(--surface)',
              }}
            >
              {z.name}
            </span>
          ))}
        {markers.map((m) => (
          <span key={m.id} className="map-pin" title={m.label} aria-hidden="true" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, opacity: 0.85 }} />
        ))}
        {picked ? (
          <span className="map-pin" aria-hidden="true" style={{ left: `${picked.x * 100}%`, top: `${picked.y * 100}%`, background: 'var(--focus)', boxShadow: '0 0 0 2px var(--focus)' }} />
        ) : null}
        {onPick && focused ? <span className="map-crosshair" aria-hidden="true" style={{ left: `${cross.x * 100}%`, top: `${cross.y * 100}%` }} /> : null}
      </div>
      {markers.length > 0 ? (
        <ul className="visually-hidden">
          {markers.map((m) => (
            <li key={m.id}>
              {m.label}: {Math.round(m.x * 100)}% across, {Math.round(m.y * 100)}% down
            </li>
          ))}
        </ul>
      ) : null}
      {onPick ? (
        <>
          <p id={hintId} className="hint">
            Click the map, or focus it and use the arrow keys (Shift for bigger steps) then Enter. You can also type the position below.
          </p>
          <div className="row">
            <label className="field" style={{ width: '8rem' }}>
              <span className="label small">Across (%)</span>
              <input className="input" inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} placeholder={picked ? String(Math.round(picked.x * 1000) / 10) : '50'} />
            </label>
            <label className="field" style={{ width: '8rem' }}>
              <span className="label small">Down (%)</span>
              <input className="input" inputMode="decimal" value={py} onChange={(e) => setPy(e.target.value)} placeholder={picked ? String(Math.round(picked.y * 1000) / 10) : '50'} />
            </label>
            <button
              type="button"
              className="btn"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => {
                const x = Number(px);
                const y = Number(py);
                if (Number.isFinite(x) && Number.isFinite(y) && px !== '' && py !== '') pick({ x: x / 100, y: y / 100 });
              }}
            >
              Set {pickLabel}
            </button>
          </div>
          <p className="small muted" aria-live="polite">
            {picked ? `Selected: ${(picked.x * 100).toFixed(1)}% across, ${(picked.y * 100).toFixed(1)}% down.` : 'Nothing selected yet.'}
          </p>
        </>
      ) : null}
    </div>
  );
}
