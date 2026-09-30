// GET  /api/s/[code]/lost-reports: this browser's open reports and their matches (§12.3; private, no-store).
// POST /api/s/[code]/lost-reports: file a report bound to the device digest (§5.2 step 5, §12.4; 1/day,
//      5 open; Idempotency-Key required). Guard order: section 9.1.
import type { Category, MyLostReport } from '@recover/shared/dto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { cleanText } from '@recover/shared/unicode.ts';
import { CACHE, getMeta } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { getDevice } from '@/lib/device.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import { categoryField, handle, json, pinField, readJsonObject, uuidField, type Pin } from '@/lib/http.ts';
import { withIdempotency } from '@/lib/idempotency.ts';
import { take } from '@/lib/ratelimit.ts';
import { toPublicLostReport } from '@/lib/storage-url.ts';

export const GET = handle<{ code: string }>('GET /api/s/[code]/lost-reports', async (req, { code }, reply) => {
  const meta = await getMeta(code);
  const device = getDevice(req, meta.school.id, { create: false });
  if (!device) return json({ reports: [] }, { requestId: reply.requestId, cache: CACHE.private });
  await take(meta.school.code, 'status_poll', device.digest, req);
  const res = await api<{ reports: MyLostReport[] }>('api_my_lost_reports', {
    p_school_code: meta.school.code,
    p_device_digest: device.digest,
  });
  return json({ reports: res.reports.map(toPublicLostReport) }, { requestId: reply.requestId, cache: CACHE.private });
});

type ReportInput = {
  category: Category;
  description: string;
  pin: Pin | null;
  mapVersionId: string | null;
  lostOn: string | null;
};

const DAY_MS = 86_400_000;

// Optional calendar date, not in the future (a day of slack for time zones) and within the last year.
function lostOnField(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new PublicError('invalid_input', 'lostOn');
  const t = Date.parse(`${v}T00:00:00Z`);
  const now = Date.now();
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v || t > now + DAY_MS || t < now - 366 * DAY_MS) {
    throw new PublicError('invalid_input', 'lostOn');
  }
  return v;
}

function parseReport(b: Record<string, unknown>): ReportInput {
  const category = categoryField(b.category);
  if (typeof b.description !== 'string') throw new PublicError('invalid_input', 'description');
  const pin = pinField(b.pin);
  return {
    category,
    description: cleanText(b.description, { field: 'description', min: 3, max: 200 }),
    pin,
    mapVersionId: pin ? uuidField(b.mapVersionId, 'mapVersionId') : null,
    lostOn: lostOnField(b.lostOn),
  };
}

export const POST = handle<{ code: string }>('POST /api/s/[code]/lost-reports', async (req, { code }, reply) => {
  assertSameOrigin(req); // 1
  const meta = await getMeta(code); // 2
  const school = meta.school;
  if (!school.flags.lostReports) throw new PublicError('feature_disabled');

  const device = getDevice(req, school.id, { create: true }); // 3
  reply.setCookie = device.setCookie;
  // Records the device for ownership and staff tooling. A posting block does not stop a lost report (§13.3).
  await api('api_device_touch', { p_school_code: school.code, p_device_digest: device.digest });

  await take(school.code, 'lost_report', device.digest, req); // 4
  const input = parseReport(await readJsonObject(req)); // 5
  const hashBody = {
    category: input.category,
    description: input.description,
    pinX: input.pin ? input.pin.x.toFixed(6) : null,
    pinY: input.pin ? input.pin.y.toFixed(6) : null,
    mapVersionId: input.mapVersionId,
    lostOn: input.lostOn,
  };
  const { status, body } = await withIdempotency(school.code, 'report.create', device.digest, req, hashBody, async () => {
    const r = await api<{ reportId: string; status: string; expiresAt: string }>('api_create_lost_report', {
      p_school_code: school.code,
      p_device_digest: device.digest,
      p_category: input.category,
      p_description: input.description,
      p_map_version_id: input.mapVersionId,
      p_pin_x: input.pin?.x ?? null,
      p_pin_y: input.pin?.y ?? null,
      p_lost_on: input.lostOn,
    });
    return { status: 201, body: { reportId: r.reportId, status: r.status, expiresAt: r.expiresAt } };
  });
  return json(body, { requestId: reply.requestId, status });
});
