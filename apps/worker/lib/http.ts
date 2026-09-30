// Route helpers: bounded JSON bodies, uuid parsing, and public error responses (BUILD-CONTRACT.md
// section 4). Raw error text never leaves the worker: PublicError codes map to their statuses, storage
// and provider failures become upstream_unavailable, and anything else is `internal`.
import { randomUUID } from 'node:crypto';
import { PublicError, errorResponse } from '@recover/shared/errors.ts';
import { errorSignature, log } from '@recover/shared/log.ts';
import { recordError } from './db.ts';
import { PermanentError, RetryableError } from './jobs/errors.ts';
import { UUID_RE } from './keys.ts';

export function requireUuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v.toLowerCase())) throw new PublicError('invalid_input', field);
  return v.toLowerCase();
}

export function requestIdFor(req: Request): string {
  const h = req.headers.get('x-request-id');
  return h && UUID_RE.test(h.toLowerCase()) ? h.toLowerCase() : randomUUID();
}

export async function readJson(req: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > maxBytes || !req.body) throw new PublicError('invalid_input', 'body');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PublicError('invalid_input', 'body');
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PublicError('invalid_input', 'body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PublicError('invalid_input', 'body');
  return parsed as Record<string, unknown>;
}

export function json(data: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId },
  });
}

// `route` is the route template, for example `POST /api/media/upload-spec` (G-29 signature input).
export async function failure(e: unknown, route: string, requestId: string): Promise<Response> {
  let pe: PublicError;
  if (e instanceof PublicError) pe = e;
  else if (e instanceof RetryableError || (e instanceof PermanentError && e.code.startsWith('storage_'))) pe = new PublicError('upstream_unavailable');
  else pe = new PublicError('internal');
  const code = e instanceof RetryableError || e instanceof PermanentError ? e.code : pe.code;
  log(pe.status >= 500 ? 'error' : 'warn', 'route_failed', { route, requestId, status: pe.status, code, err: e });
  if (pe.code === 'internal') await recordError(errorSignature(`worker ${route}`, e));
  return errorResponse(pe, requestId);
}
