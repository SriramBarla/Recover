// Student route-handler plumbing (08 "Route handler skeleton" steps 5 and 8; BUILD-CONTRACT section 4; G-29).
// Every JSON response echoes a request id. Errors map through errorResponse (authored messages only) and
// 5xx outcomes are logged and counted as a scrubbed signature: route template plus error class, never a
// message, body, path value, cookie or digest.
import { randomUUID } from 'node:crypto';
import { after, type NextRequest } from 'next/server';
import { HIGH_VALUE_CATEGORIES, STUDENT_CATEGORIES, type Category } from '@recover/shared/dto.ts';
import { PublicError, errorResponse, toPublicError } from '@recover/shared/errors.ts';
import { api } from './db.ts';

export function requestId(): string {
  return randomUUID();
}

// Per-request reply state shared between a handler and handle(): the device cookie must reach the
// browser on error responses too, or a retry would arrive as a different device (and a different
// idempotency principal).
export type Reply = { requestId: string; setCookie?: string };

export function json(
  data: Record<string, unknown>,
  opts: { requestId: string; status?: number; cache?: string },
): Response {
  return new Response(JSON.stringify({ ...data, requestId: opts.requestId }), {
    status: opts.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': opts.cache ?? 'no-store',
      'x-request-id': opts.requestId,
    },
  });
}

const SIGNATURE_MAX = 120; // error_rollup.signature check (G-29)

// Route template plus error class: a PublicError code, or the constructor name and a constant error code
// (SQLSTATE or errno name). Messages are never included because they can echo input.
export function errorSignature(route: string, e: unknown): string {
  let cls = 'NonError';
  if (e instanceof PublicError) cls = e.code;
  else if (e instanceof Error) cls = e.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'Error';
  const code = e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  if (!(e instanceof PublicError) && typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code)) cls += `:${code}`;
  return `${route}:${cls}`.slice(0, SIGNATURE_MAX);
}

export function recordError(signature: string, reqId?: string): void {
  console.error(JSON.stringify({ level: 'error', event: 'request_error', requestId: reqId ?? null, signature }));
  try {
    after(async () => {
      try {
        await api('api_record_error', { p_signature: signature.slice(0, SIGNATURE_MAX) });
      } catch {
        // best effort: the database may be the thing that is down
      }
    });
  } catch {
    // after() is only available inside a request scope
  }
}

export type Handler<P> = (req: NextRequest, params: P, reply: Reply) => Promise<Response>;

export function handle<P extends Record<string, string>>(route: string, fn: Handler<P>) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    const reply: Reply = { requestId: requestId() };
    let res: Response;
    try {
      res = await fn(req, await context.params, reply);
    } catch (e) {
      const pe = toPublicError(e);
      if (pe.status >= 500) recordError(errorSignature(route, e), reply.requestId);
      res = errorResponse(pe, reply.requestId);
    }
    if (reply.setCookie) res.headers.append('set-cookie', reply.setCookie);
    return res;
  };
}

// ---------- request parsing (hand validation, no dependency; 08 step 5) ----------

export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new PublicError('invalid_input', 'body');
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PublicError('invalid_input', 'body');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJsonObject(req: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  const text = await readBodyText(req, maxBytes);
  let value: unknown = {};
  if (text.trim() !== '') {
    try {
      value = JSON.parse(text);
    } catch {
      throw new PublicError('invalid_input', 'body');
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('invalid_input', 'body');
  return value as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function uuidField(v: unknown, field: string): string {
  if (!isUuid(v)) throw new PublicError('invalid_input', field);
  return v.toLowerCase();
}

export function optionalUuidField(v: unknown, field: string): string | null {
  return v === undefined || v === null || v === '' ? null : uuidField(v, field);
}

// Path ids that fail the format check are simply not found (nothing to validate for the caller).
export function uuidParam(v: string): string {
  if (!isUuid(v)) throw new PublicError('not_found');
  return v.toLowerCase();
}

const ALL_CATEGORIES: readonly Category[] = [...STUDENT_CATEGORIES, ...HIGH_VALUE_CATEGORIES];

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (ALL_CATEGORIES as readonly string[]).includes(v);
}

export function isHighValue(c: Category): boolean {
  return HIGH_VALUE_CATEGORIES.includes(c);
}

export function categoryField(v: unknown, field = 'category'): Category {
  if (!isCategory(v)) throw new PublicError('invalid_input', field);
  return v;
}

export function intField(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new PublicError('invalid_input', field);
  return v;
}

export type Pin = { x: number; y: number };

// Normalized 0..1 map coordinates, rounded to 6 decimals so JSON, SQL and hashing agree.
export function pinField(v: unknown, field = 'pin'): Pin | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new PublicError('invalid_input', field);
  const { x, y } = v as { x?: unknown; y?: unknown };
  for (const n of [x, y]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw new PublicError('invalid_input', field);
  }
  return { x: Number((x as number).toFixed(6)), y: Number((y as number).toFixed(6)) };
}

// F-99: campaign attribution is a short known-shape code; anything else is discarded, never stored.
const SRC_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export function srcValue(v: unknown): string | null {
  return typeof v === 'string' && SRC_RE.test(v) ? v : null;
}

// Feed cursor: opaque base64url of "createdAt|id". The timestamp string is passed to SQL untouched so
// microsecond precision survives the round trip.
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export function encodeCursor(c: { createdAt: string; id: string } | null): string | null {
  return c ? Buffer.from(`${c.createdAt}|${c.id}`, 'utf8').toString('base64url') : null;
}

export function decodeCursor(raw: string | null | undefined): { createdAt: string; id: string } | null {
  if (!raw) return null;
  if (raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new PublicError('invalid_input', 'cursor');
  const [createdAt, id, extra] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !createdAt || !CURSOR_TS_RE.test(createdAt) || !isUuid(id)) {
    throw new PublicError('invalid_input', 'cursor');
  }
  return { createdAt, id: id.toLowerCase() };
}

// `since` filter: a calendar date or an ISO timestamp (08 feed query).
export function sinceValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) || CURSOR_TS_RE.test(raw)) {
    if (!Number.isNaN(Date.parse(raw))) return raw;
  }
  throw new PublicError('invalid_input', 'since');
}
