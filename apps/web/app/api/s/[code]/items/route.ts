// GET  /api/s/[code]/items: the feed, newest first, cursor-paginated (§5.2; 08 cache table).
// POST /api/s/[code]/items: create a draft, then ask the worker broker for presigned PUTs to the
//      server-generated incoming/ keys (§5.1 step 6, §9.2; F-17, F-99, F-102). Guard order: section 9.1.
import type { Category, DraftCreated, Meta, UploadSpec } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { cleanText, hasContactInfo } from '@recover/shared/unicode.ts';
import { CACHE, getFeed, getMeta, isFirstUnfilteredPage, type FeedFilters } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import {
  categoryField,
  decodeCursor,
  encodeCursor,
  handle,
  intField,
  isHighValue,
  isUuid,
  json,
  optionalUuidField,
  pinField,
  readJsonObject,
  sinceValue,
  srcValue,
  uuidField,
  type Pin,
} from '@/lib/http.ts';
import { withIdempotency } from '@/lib/idempotency.ts';
import { take } from '@/lib/ratelimit.ts';
import { toPublicItem } from '@/lib/storage-url.ts';
import { workerJson } from '@/lib/worker.ts';

export const GET = handle<{ code: string }>('GET /api/s/[code]/items', async (req, { code }, reply) => {
  const meta = await getMeta(code);
  const q = req.nextUrl.searchParams;
  const category = q.get('category');
  const filters: FeedFilters = {
    cursor: decodeCursor(q.get('cursor')),
    locationId: optionalUuidField(q.get('location'), 'location'),
    category: category ? categoryField(category) : null,
    since: sinceValue(q.get('since')),
  };
  const page = await getFeed(meta, filters);
  // Edge caching only for the bare first page, so query strings cannot mint unbounded cache variants (08).
  const cacheable = isFirstUnfilteredPage(filters) && [...q.keys()].length === 0;
  return json(
    { items: page.items.map(toPublicItem), nextCursor: encodeCursor(page.nextCursor) },
    { requestId: reply.requestId, cache: cacheable ? CACHE.feed : CACHE.none },
  );
});

type DraftInput = {
  category: Category;
  description: string;
  note: string | null;
  pin: Pin | null;
  mapVersionId: string | null;
  dropoffLocationId: string;
  photoCount: number;
  src: string | null;
};

function parseDraft(b: Record<string, unknown>, meta: Meta): DraftInput {
  const category = categoryField(b.category);
  // §5.1 step 2: phones, wallets, keys, IDs and medication go straight to the office; no student row.
  if (isHighValue(category)) throw new PublicError('feature_disabled');
  if (!meta.school.enabledCategories.includes(category)) throw new PublicError('invalid_input', 'category');
  const description = cleanText(b.description, { field: 'description', min: 2, max: 120 });
  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') throw new PublicError('invalid_input', 'note');
  const note = typeof b.note === 'string' && b.note.trim() !== '' ? cleanText(b.note, { field: 'note', min: 1, max: 80 }) : null;
  // §10.2 layer 1: contact info (phone, email, URL, @handle, snap:/ig:) is rejected at submit. Recover
  // holds no way to reach a student, so this applies to the staff-only note as well as the description.
  if (hasContactInfo(description)) throw new PublicError('invalid_input', 'description');
  if (note && hasContactInfo(note)) throw new PublicError('invalid_input', 'note');
  const pin = pinField(b.pin);
  const mapVersionId = pin ? uuidField(b.mapVersionId, 'mapVersionId') : null;
  const dropoffLocationId = uuidField(b.dropoffLocationId, 'dropoffLocationId');
  if (!meta.locations.some((l) => l.id.toLowerCase() === dropoffLocationId)) {
    throw new PublicError('invalid_input', 'dropoffLocationId');
  }
  return {
    category,
    description,
    note,
    pin,
    mapVersionId,
    dropoffLocationId,
    photoCount: intField(b.photoCount, 'photoCount', 1, 3),
    src: srcValue(b.src),
  };
}

// request_hash input: integers and strings only (pins as fixed-point strings; BUILD-CONTRACT section 5).
function hashBody(d: DraftInput): Record<string, unknown> {
  return {
    category: d.category,
    description: d.description,
    note: d.note,
    pinX: d.pin ? d.pin.x.toFixed(6) : null,
    pinY: d.pin ? d.pin.y.toFixed(6) : null,
    mapVersionId: d.mapVersionId,
    dropoffLocationId: d.dropoffLocationId,
    photoCount: d.photoCount,
    src: d.src,
  };
}

function uploadsFrom(spec: unknown): UploadSpec[] {
  const list = (spec as { uploads?: unknown } | null)?.uploads;
  if (!Array.isArray(list)) throw new PublicError('upstream_unavailable');
  return list.map((u) => {
    const x = (u ?? {}) as Record<string, unknown>;
    if (
      !isUuid(x.photoId) ||
      typeof x.position !== 'number' ||
      typeof x.url !== 'string' ||
      !/^https?:\/\//.test(x.url) ||
      typeof x.expiresAt !== 'string'
    ) {
      throw new PublicError('upstream_unavailable');
    }
    return { photoId: x.photoId, position: x.position, url: x.url, expiresAt: x.expiresAt };
  });
}

export const POST = handle<{ code: string }>('POST /api/s/[code]/items', async (req, { code }, reply) => {
  assertSameOrigin(req); // 1
  const meta = await getMeta(code); // 2
  const school = meta.school;
  if (!school.flags.studentPosting) throw new PublicError('feature_disabled');

  const device = await getDevice(req, school, { create: true }); // 3
  reply.setCookie = device.setCookie;
  const touch = await api<{ blocked: boolean }>('api_device_touch', {
    p_school_code: school.code,
    p_device_digest: device.digest,
  });
  if (touch.blocked) throw new PublicError('device_blocked');

  await take(school.code, 'post_item', device.digest, req); // 4
  const input = parseDraft(await readJsonObject(req), meta); // 5

  // 6-7. Only the draft is the idempotent unit. The upload capabilities are minted fresh on every call,
  // including replays, so a resumed upload after a failure gets unexpired URLs for the same draft.
  const { body } = await withIdempotency(school.code, 'item.create', device.digest, req, hashBody(input), async () => {
    const draft = await api<DraftCreated>('api_create_item_draft', {
      p_school_code: school.code,
      p_device_digest: device.digest,
      p_category: input.category,
      p_description: input.description,
      p_note: input.note,
      p_map_version_id: input.mapVersionId,
      p_pin_x: input.pin?.x ?? null,
      p_pin_y: input.pin?.y ?? null,
      p_dropoff_location_id: input.dropoffLocationId,
      p_photo_count: input.photoCount,
      p_src: input.src,
    });
    return { status: 201, body: { itemId: draft.itemId } };
  });

  const itemId = uuidField(body.itemId, 'itemId');
  const uploads = uploadsFrom(await workerJson<unknown>('/api/media/upload-spec', { itemId, schoolId: school.id }));
  return json({ itemId, uploads }, { requestId: reply.requestId, status: 201 }); // 8
});
