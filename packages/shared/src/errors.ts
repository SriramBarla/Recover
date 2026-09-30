// Public error codes (08-API-Surface.md "Public error codes"; BUILD-CONTRACT.md section 4).
// Messages are authored strings safe to show verbatim; database and provider text is never forwarded.

export type PublicErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'rate_limited'
  | 'device_blocked'
  | 'feature_disabled'
  | 'idempotency_conflict'
  | 'state_changed'
  | 'assertion_invalid'
  | 'forbidden'
  | 'tenant_mismatch'
  | 'upstream_unavailable'
  | 'unauthorized'
  | 'internal';

export const PUBLIC_ERRORS: Record<PublicErrorCode, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Not found.' },
  invalid_input: { status: 400, message: 'Please check the highlighted field and try again.' },
  rate_limited: { status: 429, message: 'Too many requests. Please wait a bit and try again.' },
  device_blocked: { status: 403, message: 'Posting is paused for this device. Please visit the front office.' },
  feature_disabled: { status: 403, message: 'This feature is turned off right now.' },
  idempotency_conflict: { status: 409, message: 'This request conflicts with an earlier one. Please start again.' },
  state_changed: { status: 409, message: 'This item changed while you were looking at it. Refresh and try again.' },
  assertion_invalid: { status: 401, message: 'Your session could not be verified. Please sign in again.' },
  forbidden: { status: 403, message: 'You do not have permission to do that.' },
  tenant_mismatch: { status: 400, message: 'That does not belong to this school.' },
  upstream_unavailable: { status: 503, message: 'Photo uploads are temporarily unavailable. Please try again soon.' },
  unauthorized: { status: 401, message: 'Please sign in.' },
  internal: { status: 500, message: 'Something went wrong. Please try again.' },
};

export function isPublicErrorCode(code: string): code is PublicErrorCode {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ERRORS, code);
}

export class PublicError extends Error {
  readonly code: PublicErrorCode;
  readonly status: number;
  readonly field: string | undefined;
  readonly retryAfterS: number | undefined;

  constructor(code: PublicErrorCode, detail?: string) {
    super(PUBLIC_ERRORS[code].message);
    this.name = 'PublicError';
    this.code = code;
    this.status = PUBLIC_ERRORS[code].status;
    this.field = code === 'invalid_input' && detail ? detail : undefined;
    const n = code === 'rate_limited' && detail ? Number.parseInt(detail, 10) : Number.NaN;
    this.retryAfterS = Number.isFinite(n) && n > 0 ? n : undefined;
  }
}

// Postgres errors raised by private.fail() carry SQLSTATE RV001 with message = public code.
type PgLikeError = { code?: unknown; message?: unknown; detail?: unknown };

export function toPublicError(e: unknown): PublicError {
  if (e instanceof PublicError) return e;
  const pg = e as PgLikeError;
  if (pg && pg.code === 'RV001' && typeof pg.message === 'string' && isPublicErrorCode(pg.message)) {
    return new PublicError(pg.message, typeof pg.detail === 'string' ? pg.detail : undefined);
  }
  return new PublicError('internal');
}

export type ErrorBody = {
  error: { code: PublicErrorCode; message: string; field?: string; retryAfterS?: number };
  requestId: string;
};

export function errorBody(e: PublicError, requestId: string): ErrorBody {
  const body: ErrorBody = { error: { code: e.code, message: e.message }, requestId };
  if (e.field) body.error.field = e.field;
  if (e.retryAfterS) body.error.retryAfterS = e.retryAfterS;
  return body;
}

export function errorResponse(e: unknown, requestId: string): Response {
  const pe = toPublicError(e);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-request-id': requestId,
  };
  if (pe.retryAfterS) headers['retry-after'] = String(pe.retryAfterS);
  return new Response(JSON.stringify(errorBody(pe, requestId)), { status: pe.status, headers });
}
