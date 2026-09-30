// Browser-side calls to the student API. Every mutation carries X-Recover-Request: 1 (08 step 1) and the
// server's authored error message is shown as-is (errors.ts messages are written for students).
//
// Idempotency keys (08 step 6): one key per logical submission, reused for automatic retries after a
// network failure or a short 429 (the server may already have done the work). After a 5xx the server
// has not stored an answer for that key, so the caller starts a fresh key for the next attempt.

export type ApiError = { code: string; message: string; field?: string; retryAfterS?: number; status: number };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const OFFLINE: ApiError = {
  code: 'network',
  message: 'You seem to be offline. Check your connection and try again.',
  status: 0,
};

export async function apiFetch<T>(
  url: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.method === 'POST') {
    headers['x-recover-request'] = '1';
    headers['content-type'] = 'application/json';
  }
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: OFFLINE };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok) return { ok: true, data: data as T };
  const e = (data as { error?: { code?: unknown; message?: unknown; field?: unknown; retryAfterS?: unknown } } | null)?.error;
  return {
    ok: false,
    error: {
      code: typeof e?.code === 'string' ? e.code : 'internal',
      message: typeof e?.message === 'string' ? e.message : 'Something went wrong. Please try again.',
      field: typeof e?.field === 'string' ? e.field : undefined,
      retryAfterS: typeof e?.retryAfterS === 'number' ? e.retryAfterS : undefined,
      status: res.status,
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Automatic retries for transient failures only: no response at all, or a short Retry-After.
export async function withRetry<T>(call: () => Promise<ApiResult<T>>, attempts = 3): Promise<ApiResult<T>> {
  let result = await call();
  for (let i = 1; i < attempts && !result.ok; i++) {
    const e = result.error;
    const shortWait = e.code === 'rate_limited' && (e.retryAfterS ?? 99) <= 5;
    if (e.code !== 'network' && !shortWait) break;
    await sleep(shortWait ? (e.retryAfterS ?? 2) * 1000 : 1000 * 2 ** (i - 1));
    result = await call();
  }
  return result;
}

// Whether the next attempt of the same submission must use a new Idempotency-Key. POST /items stores the
// draft under its key before calling the worker, so an upstream_unavailable there keeps the key: the retry
// replays the same draft and gets fresh upload URLs.
export function needsNewKey(e: ApiError, opts: { draftStoredBeforeUpstream?: boolean } = {}): boolean {
  if (e.code === 'upstream_unavailable' && opts.draftStoredBeforeUpstream) return false;
  return e.status >= 500 || e.code === 'idempotency_conflict';
}

export function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function retryHint(e: ApiError): string {
  if (e.code !== 'rate_limited' || !e.retryAfterS) return '';
  const minutes = Math.ceil(e.retryAfterS / 60);
  return minutes <= 1 ? ' Try again in a minute.' : minutes < 120 ? ` Try again in about ${minutes} minutes.` : ' Try again tomorrow.';
}

// §17 D-6 client error beacon: an error class and a route template, never messages, ids or text.
const KNOWN_SEGMENTS = new Set(['s', 'found', 'lost', 'mine', 'items', 'search', 'offline']);

export function routeTemplate(pathname: string): string {
  const t = pathname
    .split('/')
    .map((seg) => (seg === '' || KNOWN_SEGMENTS.has(seg) ? seg : '*'))
    .join('/');
  return (t || '/').slice(0, 60);
}

export function reportClientError(kind: string): void {
  const cls = kind.replace(/[^A-Za-z0-9_]/g, '').slice(0, 30) || 'Error';
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-recover-request': '1' },
      body: JSON.stringify({ signature: `${cls}:${routeTemplate(window.location.pathname)}` }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch {
    // reporting must never throw
  }
}
