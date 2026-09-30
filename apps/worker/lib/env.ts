// Worker environment (BUILD-CONTRACT.md section 10.2). Getters read process.env on every call so tests
// can set variables. Required groups go through the shared requireEnv, which names what is missing and
// never prints a value.
import { fromB64url } from '@recover/shared/crypto.ts';
import { requireEnv } from '@recover/shared/env.ts';

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v ? v : undefined;
}

export const onVercel = (): boolean => Boolean(process.env.VERCEL);

// Dev web->worker authentication is refused on Vercel and in every production build (next build and
// next start run with NODE_ENV=production, which Next also inlines at build time), no matter what the
// flags say (§9.3). `next dev` keeps it.
export const devAuthEnabled = (): boolean =>
  process.env.RECOVER_DEV_AUTH === '1' && !onVercel() && process.env.NODE_ENV !== 'production';

const DEV_FLAGS = ['RECOVER_DEV_LOGIN', 'RECOVER_DEV_AUTH'] as const;

// Dev switches that are set in a production build and therefore ignored; instrumentation.ts logs
// them once at startup so the misconfiguration is visible.
export function ignoredDevFlags(): string[] {
  if (process.env.NODE_ENV !== 'production') return [];
  return DEV_FLAGS.filter((name) => Boolean(process.env[name]));
}

export type DbEnv = { url: string; ssl: 'require' | 'disable' };

export function dbEnv(): DbEnv {
  const { DATABASE_URL } = requireEnv(['DATABASE_URL']);
  return { url: DATABASE_URL, ssl: process.env.DATABASE_SSL === 'require' ? 'require' : 'disable' };
}

export type S3Env = { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };

export function s3Env(): S3Env {
  const e = requireEnv(['SUPABASE_S3_ENDPOINT', 'SUPABASE_S3_REGION', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY']);
  return {
    endpoint: e.SUPABASE_S3_ENDPOINT.replace(/\/+$/, ''),
    region: e.SUPABASE_S3_REGION,
    accessKeyId: e.SUPABASE_S3_ACCESS_KEY_ID,
    secretAccessKey: e.SUPABASE_S3_SECRET_ACCESS_KEY,
  };
}

// Fingerprint HMAC key (§9.3 step 5): base64url, at least 32 bytes (scripts/dev-env.mjs writes 32).
export function contentKey(): Buffer {
  const key = fromB64url(requireEnv(['CONTENT_KEY']).CONTENT_KEY);
  if (key.length < 32) throw new Error('CONTENT_KEY must decode to at least 32 bytes');
  return key;
}

// Empty when unset, which makes every scheduler request fail closed (G-18).
export const schedulerBearerSha256 = (): string => optionalEnv('SCHEDULER_BEARER_SHA256') ?? '';

export const workerDevSecret = (): string => optionalEnv('WORKER_DEV_SECRET') ?? '';

export type OidcPins = { issuer: string; audience: string; projectId: string; ownerId: string };

// All four pins or nothing: a partially configured worker refuses every web request.
export function oidcPins(): OidcPins | null {
  const issuer = optionalEnv('WEB_OIDC_ISSUER');
  const audience = optionalEnv('WEB_OIDC_AUDIENCE');
  const projectId = optionalEnv('WEB_PROJECT_ID');
  const ownerId = optionalEnv('WEB_OWNER_ID');
  if (!issuer || !audience || !projectId || !ownerId) return null;
  return { issuer: issuer.replace(/\/+$/, ''), audience, projectId, ownerId };
}

export type VisionMode = 'off' | 'mock' | 'google';

export function visionMode(): VisionMode {
  const v = optionalEnv('VISION_MODE') ?? 'off';
  if (v === 'off' || v === 'mock' || v === 'google') return v;
  throw new Error('VISION_MODE must be off, mock, or google');
}

export const visionMockFlag = (): boolean => process.env.VISION_MOCK_FLAG === '1';

export type GcpEnv = { wifAudience: string; serviceAccountEmail: string };

// Null when unset: screening then fails per job (and is retried) instead of stopping the whole drain.
export function gcpEnv(): GcpEnv | null {
  const wifAudience = optionalEnv('GCP_WIF_AUDIENCE');
  const serviceAccountEmail = optionalEnv('GCP_SERVICE_ACCOUNT_EMAIL');
  return wifAudience && serviceAccountEmail ? { wifAudience, serviceAccountEmail } : null;
}

export type RevalidateEnv = { webUrl: string; secret: string };

export function revalidateEnv(): RevalidateEnv {
  const e = requireEnv(['WEB_URL', 'REVALIDATE_SECRET']);
  return { webUrl: e.WEB_URL.replace(/\/+$/, ''), secret: e.REVALIDATE_SECRET };
}
