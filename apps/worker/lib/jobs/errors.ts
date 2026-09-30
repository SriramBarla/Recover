// Job retry classes (Appendix E.2; 09 Implementation guide "Retry classes as code").
// Codes are stable snake_case identifiers: they land in jobs.last_error and logs, never free text.
import { PublicError } from '@recover/shared/errors.ts';

export class RetryableError extends Error {
  readonly code: string;
  readonly retryAfterS: number | null;
  constructor(code: string, retryAfterS: number | null = null) {
    super(code);
    this.name = 'RetryableError';
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

export class PermanentError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PermanentError';
    this.code = code;
  }
}

export type Failure = { code: string; permanent: boolean; retryAfterS: number | null };

const CODE = /^[a-z0-9_]{1,64}$/;
const safeCode = (c: string): string => (CODE.test(c) ? c : 'unexpected');

// PublicError codes from private.fail() that can clear on their own; every other one means the job's
// premise no longer holds, so retrying cannot help.
const TRANSIENT_PUBLIC = new Set(['upstream_unavailable', 'rate_limited']);
// Postgres SQLSTATE classes 08 (connection), 40 (rollback: serialization, deadlock), 53 (resources),
// 57 (operator intervention, statement timeout), and 55P03 (lock_timeout); plus socket-level codes.
const PG_TRANSIENT = /^(08|40|53|57)[0-9A-Z]{3}$|^55P03$/;
const NET_TRANSIENT = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED',
]);

// `attempts` is the job's attempt count after the lease incremented it (1 on the first run).
export function classify(e: unknown, attempts: number): Failure {
  if (e instanceof PermanentError) return { code: safeCode(e.code), permanent: true, retryAfterS: null };
  if (e instanceof RetryableError) return { code: safeCode(e.code), permanent: false, retryAfterS: e.retryAfterS };
  if (e instanceof PublicError) {
    return TRANSIENT_PUBLIC.has(e.code)
      ? { code: e.code, permanent: false, retryAfterS: e.retryAfterS ?? null }
      : { code: e.code, permanent: true, retryAfterS: null };
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (PG_TRANSIENT.test(code) || NET_TRANSIENT.has(code))) {
    return { code: 'transient_io', permanent: false, retryAfterS: null };
  }
  // Anything else is retried once, then dead as `unexpected` (09 Implementation guide).
  return { code: 'unexpected', permanent: attempts >= 2, retryAfterS: null };
}

// min(300, 5 * 2^attempts) seconds plus up to 20% jitter; a provider Retry-After can only lengthen it.
export function backoffSeconds(attempts: number, retryAfterS: number | null, random: () => number = Math.random): number {
  const base = Math.min(300, 5 * 2 ** Math.max(0, attempts));
  const floor = Math.max(base, retryAfterS ?? 0);
  const jitter = Math.floor(random() * (base / 5 + 1));
  return Math.min(3600, floor + jitter);
}
