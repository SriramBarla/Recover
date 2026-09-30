// GET /api/internal/ready (G-19; §17 health model): pg_cron probes this every 5 minutes with
// `Authorization: Bearer <secret>`, checked by sha256 against READY_SECRET_SHA256 before any I/O.
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { secretMatchesSha256 } from '@recover/shared/crypto.ts';
import { api } from '../../../../lib/db.ts';

function reply(status: number, body: unknown, rid: string): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': rid },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const rid = randomUUID();
  const m = /^Bearer ([^\s]+)$/.exec(req.headers.get('authorization') ?? '');
  if (!secretMatchesSha256(m?.[1] ?? '', process.env.READY_SECRET_SHA256 ?? '')) return reply(401, null, rid);
  const started = Date.now();
  try {
    const health = await api<Record<string, unknown>>('api_health');
    return reply(200, { ...health, latencyMs: Date.now() - started }, rid);
  } catch {
    return reply(503, { db: false, latencyMs: Date.now() - started }, rid);
  }
}
