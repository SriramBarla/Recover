// POST /api/client-error {signature}: browser error beacon (§17 D-6; G-29). 1 KB max, no device identity,
// signature only: an error class and a route template built by the client, re-checked against a strict
// character set here. Anything else is counted under one generic bucket, never echoed or stored.
import { assertSameOrigin } from '@/lib/guard.ts';
import { handle, json, readJsonObject, recordError } from '@/lib/http.ts';

const CLIENT_SIGNATURE_RE = /^[A-Za-z0-9_.:/*-]{1,100}$/;

export const POST = handle<Record<string, never>>('POST /api/client-error', async (req, _params, reply) => {
  assertSameOrigin(req);
  const { signature } = await readJsonObject(req, 1024);
  const clean = typeof signature === 'string' && CLIENT_SIGNATURE_RE.test(signature) ? signature : 'unrecognized';
  recordError(`client:${clean}`, reply.requestId);
  return json({ ok: true }, { requestId: reply.requestId, status: 202 });
});
