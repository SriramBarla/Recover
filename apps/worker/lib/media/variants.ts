// Public variants from the canonical JPEG (§9.4; 10 Implementation guide): thumb 400 px q75 and
// medium 1200 px q80, both without metadata. Paths carry the per-generation public object token.
import { rendition } from './sharp.ts';

export const THUMB = { edge: 400, quality: 75 } as const;
export const MEDIUM = { edge: 1200, quality: 80 } as const;

export async function variants(canonical: Buffer): Promise<{ thumb: Buffer; medium: Buffer }> {
  const thumb = await rendition(canonical, THUMB.edge, THUMB.quality);
  const medium = await rendition(canonical, MEDIUM.edge, MEDIUM.quality);
  return { thumb, medium };
}
