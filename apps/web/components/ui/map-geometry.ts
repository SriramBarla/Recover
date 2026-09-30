// Map geometry shared by MapPicker (client) and any server code that needs the same answers.
// Coordinates are normalized to the map image: x and y in 0..1 from the top-left corner.

export type MapPoint = { x: number; y: number };
export type MapZone = { id: string; name: string; cx: number; cy: number; radius: number };
export type MapMarker = { id: string; x: number; y: number; label: string };

// Mirrors private.resolve_zone: the nearest active zone whose aspect-scaled distance
// (pixels / max(width, height)) is within its radius.
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

// Zone circle as percentages of the image box (the radius scales with the longer side).
export function zoneBox(z: MapZone, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(width, height);
  const rw = (z.radius * scale) / width;
  const rh = (z.radius * scale) / height;
  return { left: (z.cx - rw) * 100, top: (z.cy - rh) * 100, width: rw * 200, height: rh * 200 };
}
