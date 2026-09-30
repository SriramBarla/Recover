// POST /api/client-error {signature}: browser error beacon (§17 D-6; G-29). 1 KB max, no device identity.
// Unauthenticated, so it spends the school-less per-address client_error budget before the body is read
// (security review L1), and the signature counts only when its error class and route template are both
// allowlisted (lib/client-error.ts), stored as a server-built value. Anything else is refused, never
// echoed or stored.
import { PublicError } from '@recover/shared/errors.ts';
import { clientErrorSignature } from '@/lib/client-error.ts';
import { assertSameOrigin } from '@/lib/guard.ts';
import { handle, json, readJsonObject, recordError } from '@/lib/http.ts';
import { take } from '@/lib/ratelimit.ts';

export const POST = handle<Record<string, never>>('POST /api/client-error', async (req, _params, reply) => {
  assertSameOrigin(req);
  await take(null, 'client_error', null, req);
  const signature = clientErrorSignature((await readJsonObject(req, 1024)).signature);
  if (!signature) throw new PublicError('invalid_input', 'signature');
  recordError(signature, reply.requestId);
  return json({ ok: true }, { requestId: reply.requestId, status: 202 });
});
