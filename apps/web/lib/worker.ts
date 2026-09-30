// Web -> worker calls (§8.3). Production: Vercel OIDC token as bearer (worker verifies iss/aud/sub/env).
// Development only: shared dev secret, refused on Vercel (G-18/G-19; BUILD-CONTRACT.md section 9.3).
import { headers } from 'next/headers';
import { PublicError } from '@recover/shared/errors.ts';
import { devWorkerAuthEnabled, onVercel, requireEnv } from './env.ts';

async function authHeader(): Promise<Record<string, string>> {
  if (onVercel()) {
    // [VERIFY] V-3: runtime token source. Vercel injects x-vercel-oidc-token on incoming requests.
    let token: string | undefined;
    try {
      token = (await headers()).get('x-vercel-oidc-token') ?? undefined;
    } catch {
      token = undefined;
    }
    token = token ?? process.env.VERCEL_OIDC_TOKEN;
    if (!token) throw new PublicError('upstream_unavailable');
    return { authorization: `Bearer ${token}` };
  }
  if (devWorkerAuthEnabled() && process.env.WORKER_DEV_SECRET) {
    return { 'x-recover-dev-secret': process.env.WORKER_DEV_SECRET };
  }
  throw new PublicError('upstream_unavailable');
}

export async function workerFetch(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<Response> {
  const url = new URL(path, requireEnv('WORKER_URL'));
  const h: Record<string, string> = { ...(await authHeader()) };
  if (init.body !== undefined) h['content-type'] = 'application/json';
  try {
    return await fetch(url, {
      method: init.method ?? 'POST',
      headers: h,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PublicError('upstream_unavailable');
  }
}

export async function workerJson<T>(path: string, body: unknown): Promise<T> {
  const res = await workerFetch(path, { method: 'POST', body });
  if (res.status === 404) throw new PublicError('not_found');
  if (res.status === 409) throw new PublicError('state_changed');
  if (!res.ok) throw new PublicError('upstream_unavailable');
  return (await res.json()) as T;
}
