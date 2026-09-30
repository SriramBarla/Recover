// Storage key layout (BUILD-CONTRACT.md section 8) and prefix assertions (F-75, §9.6).
// Every key the worker reads, writes, or deletes is built here from DB ids, or checked here against
// them, before it reaches storage. A mismatch is PermanentError('path_refused'): never retried.
import { PermanentError } from './jobs/errors.ts';

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_RE = new RegExp(`^${UUID_SRC}$`);
const HEX32_RE = /^[0-9a-f]{32}$/;

export type Bucket = 'incoming' | 'originals' | 'variants' | 'map_drafts' | 'maps';
export type PhotoIds = { schoolId: string; itemId: string; photoId: string };
export type ObjectKind = 'incoming' | 'original' | 'review' | 'thumb' | 'medium';

// Deletion-ledger object kinds and where each lives (§9.6; G-28 puts `review` in originals).
export const BUCKET_FOR_KIND: Readonly<Record<ObjectKind, Bucket>> = {
  incoming: 'incoming',
  original: 'originals',
  review: 'originals',
  thumb: 'variants',
  medium: 'variants',
};

export function isObjectKind(v: unknown): v is ObjectKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BUCKET_FOR_KIND, v);
}

export function refused(): never {
  throw new PermanentError('path_refused');
}

// Lowercased uuid, or refuse: ids that shape a key must be exactly uuids (no separators, no dots).
export function idOf(v: unknown): string {
  if (typeof v !== 'string') refused();
  const l = v.toLowerCase();
  if (!UUID_RE.test(l)) refused();
  return l;
}

export const isHex32 = (v: unknown): v is string => typeof v === 'string' && HEX32_RE.test(v);

export function photoBase(p: PhotoIds): string {
  return `${idOf(p.schoolId)}/${idOf(p.itemId)}/${idOf(p.photoId)}`;
}

export const incomingKey = (p: PhotoIds): string => `${photoBase(p)}/raw`;
export const canonicalKey = (p: PhotoIds): string => `${photoBase(p)}/canonical.jpg`;
export const reviewKey = (p: PhotoIds): string => `${photoBase(p)}/review.jpg`;

export function variantKey(p: PhotoIds, token: string, which: 'thumb' | 'medium'): string {
  if (!isHex32(token)) throw new PermanentError('invalid_token');
  return `${photoBase(p)}/${token}/${which}.jpg`;
}

export const mapDraftKey = (schoolId: string, mapVersionId: string): string => `${idOf(schoolId)}/${idOf(mapVersionId)}/draft`;
export const mapCanonicalKey = (schoolId: string, mapVersionId: string): string =>
  `${idOf(schoolId)}/${idOf(mapVersionId)}/canonical.jpg`;

export function mapPublicKey(schoolId: string, mapVersionId: string, token: string): string {
  if (!isHex32(token)) throw new PermanentError('invalid_token');
  return `${idOf(schoolId)}/${idOf(mapVersionId)}/${token}.jpg`;
}

// Refuse unless `actual` is exactly the key the DB ids imply.
export function assertKey(actual: unknown, expected: string): string {
  if (typeof actual !== 'string' || actual !== expected) refused();
  return actual;
}

// A ledger or DB path must sit under its own photo's school/item/generation prefix, with the leaf its
// object kind implies. Variant leaves carry the 128-bit public object token segment.
export function assertPhotoObjectKey(kind: ObjectKind, key: unknown, p: PhotoIds): string {
  if (typeof key !== 'string') refused();
  const base = photoBase(p);
  let ok: boolean;
  if (kind === 'incoming') ok = key === `${base}/raw`;
  else if (kind === 'original') ok = key === `${base}/canonical.jpg`;
  else if (kind === 'review') ok = key === `${base}/review.jpg`;
  else ok = new RegExp(`^${base}/[0-9a-f]{32}/${kind}\\.jpg$`).test(key); // base is [0-9a-f-/] only
  if (!ok) refused();
  return key;
}

const INCOMING_RE = new RegExp(`^(${UUID_SRC})/(${UUID_SRC})/(${UUID_SRC})/raw$`);
const CANONICAL_RE = new RegExp(`^(${UUID_SRC})/(${UUID_SRC})/(${UUID_SRC})/canonical\\.jpg$`);

function parse(re: RegExp, key: unknown): PhotoIds | null {
  if (typeof key !== 'string') return null;
  const m = re.exec(key);
  return m ? { schoolId: m[1]!, itemId: m[2]!, photoId: m[3]! } : null;
}

export const parseIncomingKey = (key: unknown): PhotoIds | null => parse(INCOMING_RE, key);

// Canonical original of a known item/photo whose school comes from the path itself (variant and
// screening targets carry no school id). The school must also match the leased job when it has one.
export function canonicalFor(originalPath: unknown, itemId: string, photoId: string, jobSchoolId: string | null): PhotoIds & { key: string } {
  const ids = parse(CANONICAL_RE, originalPath);
  if (!ids || ids.itemId !== idOf(itemId) || ids.photoId !== idOf(photoId)) refused();
  if (jobSchoolId !== null && ids.schoolId !== idOf(jobSchoolId)) refused();
  return { ...ids, key: originalPath as string };
}
