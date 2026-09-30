// Step 1 of every student mutation (08 "Route handler skeleton"; §6.4): exact Origin match, Fetch
// Metadata, and a fixed non-simple header. The device cookie is never used as a CSRF secret.
import { PublicError } from '@recover/shared/errors.ts';

type Env = Record<string, string | undefined>;

// WEB_ORIGIN in every deployed environment. Outside production (next dev) the request's own origin
// stands in, so a local stack works without extra configuration. Production without WEB_ORIGIN fails closed.
export function expectedOrigin(req: Request, env: Env = process.env): string | null {
  const configured = env.WEB_ORIGIN;
  try {
    if (configured) return new URL(configured).origin;
    if (env.NODE_ENV !== 'production') return new URL(req.url).origin;
  } catch {
    return null;
  }
  return null;
}

export function assertSameOrigin(req: Request, env: Env = process.env): void {
  const expected = expectedOrigin(req, env);
  const origin = req.headers.get('origin');
  if (!expected || !origin || origin !== expected) throw new PublicError('forbidden');
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') throw new PublicError('forbidden');
  if (req.headers.get('x-recover-request') !== '1') throw new PublicError('forbidden');
}
