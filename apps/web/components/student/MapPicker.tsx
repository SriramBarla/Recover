// Map helpers for the student flows. The pin picker itself is the design system's MapPicker
// (@/components/ui/map-picker.tsx); coordinates are normalized 0..1 of the approved public map.

export type MapPin = { x: number; y: number };

function scaledDistance(a: MapPin, b: MapPin, w: number, h: number): number {
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h) / Math.max(w, h, 1);
}

// The location whose pin is closest to p (used to default the drop-off location from the found pin).
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
