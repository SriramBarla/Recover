// Step 6 of the student skeleton (08; F-77): Idempotency-Key is required on create, complete and lost report.
// key_hash = sha256(key); request_hash = sha256(canonicalJson(body)). The body passed in must contain only
// strings, safe integers, booleans and nulls (pins go in as fixed-point strings), matching assertion.ts.
//
// Outcome storage:
// - success: the minimal DTO is stored and replayed verbatim;
// - a deterministic 4xx (validation, feature off, blocked, not found, state changed): stored and replayed;
// - 5xx and rate_limited: not stored, because they are not answers to the request. The row stays in
//   progress, so clients start a new key after a 5xx (see components/student/client-api.ts).
import { canonicalJson } from '@recover/shared/assertion.ts';
import { sha256 } from '@recover/shared/crypto.ts';
import { PublicError, isPublicErrorCode, toPublicError } from '@recover/shared/errors.ts';
import { api } from './db.ts';
import { errorSignature, recordError } from './http.ts';

export type Outcome<T> = { status: number; body: T };

type Begin = { state: 'new' | 'replay' | 'in_progress'; responseCode: number | null; responseBody: unknown };

const KEY_RE = /^[\x21-\x7e]{1,100}$/;

export function idempotencyKey(req: Request): string {
  const key = req.headers.get('idempotency-key');
  if (key === null || !KEY_RE.test(key)) throw new PublicError('invalid_input', 'idempotencyKey');
  return key;
}

function storedError(body: unknown): PublicError {
  const err = (body as { error?: { code?: unknown; field?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' && isPublicErrorCode(err.code) ? err.code : 'internal';
  return new PublicError(code, typeof err?.field === 'string' ? err.field : undefined);
}

export async function withIdempotency<T extends Record<string, unknown>>(
  schoolCode: string,
  operation: string,
  digest: Buffer,
  req: Request,
  bodyObj: Record<string, unknown>,
  fn: () => Promise<Outcome<T>>,
): Promise<Outcome<T> & { replayed: boolean }> {
  const principal = {
    p_school_code: schoolCode,
    p_principal_kind: 'device',
    p_operation: operation,
    p_principal_hmac: digest,
    p_key_hash: sha256(idempotencyKey(req)),
  };
  const begin = await api<Begin>('api_idempotency_begin', { ...principal, p_request_hash: sha256(canonicalJson(bodyObj)) });

  if (begin.state === 'replay') {
    const status = begin.responseCode ?? 200;
    if (status >= 400) throw storedError(begin.responseBody);
    return { status, body: begin.responseBody as T, replayed: true };
  }
  // The same key is still running (a double submit or an overlapping retry): ask for a short wait.
  if (begin.state !== 'new') throw new PublicError('rate_limited', '2');

  const finish = async (status: number, body: Record<string, unknown>): Promise<void> => {
    try {
      await api('api_idempotency_finish', { ...principal, p_response_code: status, p_response_body: body });
    } catch (e) {
      // The work itself committed; answering it matters more than recording the replay copy.
      recordError(errorSignature(`idempotency_finish:${operation}`, e));
    }
  };

  let out: Outcome<T>;
  try {
    out = await fn();
  } catch (e) {
    const pe = toPublicError(e);
    if (pe.status < 500 && pe.code !== 'rate_limited') {
      const error: Record<string, unknown> = { code: pe.code };
      if (pe.field) error.field = pe.field;
      await finish(pe.status, { error });
    }
    throw e;
  }
  await finish(out.status, out.body);
  return { ...out, replayed: false };
}
