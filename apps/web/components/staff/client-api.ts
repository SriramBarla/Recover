// Browser-side calls to the staff and district API. Mutations carry X-Recover-Request: 1 (§8) and
// errors come back as {error:{code,message}}; staff see a friendly message chosen by code.

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field: string | undefined;
  readonly reauth: boolean;

  constructor(code: string, message: string, status: number, field?: string, reauth = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.field = field;
    this.reauth = reauth;
  }
}

const STAFF_MESSAGES: Record<string, string> = {
  not_found: 'That item or record no longer exists, or it belongs to another school.',
  invalid_input: 'Please check the form and try again.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  feature_disabled: 'This feature is turned off for this school.',
  idempotency_conflict: 'This request conflicts with an earlier one. Refresh and try again.',
  state_changed: 'Someone else changed this in the meantime. It has been refreshed; check it and try again.',
  assertion_invalid: 'Your session could not be verified. Please sign in again.',
  forbidden: 'Your role does not allow this action.',
  tenant_mismatch: 'That does not belong to this school.',
  upstream_unavailable: 'The photo and map service is unavailable right now. Please try again soon.',
  unauthorized: 'Your session has ended. Please sign in again.',
  internal: 'Something went wrong. Please try again.',
  network: 'Network error. Check your connection and try again.',
};

export function staffMessage(code: string, fallback?: string, field?: string): string {
  if (code === 'invalid_input' && field) return `Please check the "${field}" field and try again.`;
  return STAFF_MESSAGES[code] ?? fallback ?? STAFF_MESSAGES.internal!;
}

export function needsSignIn(e: unknown): boolean {
  return e instanceof ApiError && (e.reauth || e.code === 'unauthorized' || e.code === 'assertion_invalid');
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export async function staffApi<T>(path: string, init: { method?: Method; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method: Method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['x-recover-request'] = '1';
    headers['content-type'] = 'application/json';
  }
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('network', staffMessage('network'), 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const body = (data ?? {}) as { error?: { code?: unknown; message?: unknown; field?: unknown }; reauth?: unknown };
    const code = typeof body.error?.code === 'string' ? body.error.code : res.status === 401 ? 'unauthorized' : 'internal';
    const field = typeof body.error?.field === 'string' ? body.error.field : undefined;
    const reauth = body.reauth === true;
    const serverMessage = typeof body.error?.message === 'string' ? body.error.message : undefined;
    const message = reauth ? serverMessage ?? staffMessage(code) : staffMessage(code, serverMessage, field);
    throw new ApiError(code, message, res.status, field, reauth);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return staffMessage('internal');
}

export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Where to send the user for a fresh sign-in, returning to the current page afterwards (G-31).
export function signInAgainHref(): string {
  const back = typeof window === 'undefined' ? '/staff' : `${window.location.pathname}${window.location.search}`;
  return `/staff/signin?reauth=1&callbackUrl=${encodeURIComponent(back)}`;
}
