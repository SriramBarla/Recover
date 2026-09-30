// Worker environment (BUILD-CONTRACT.md section 10.2). Getters read process.env on every call so tests
// can set variables. Missing required variables fail loudly by name; values are never logged.
import { fromB64url } from '@recover/shared/crypto.ts';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v ? v : undefined;
}

export const onVercel = (): boolean => Boolean(process.env.VERCEL);

// Dev web->worker authentication is refused on Vercel no matter what the flags say (§9.3).
export const devAuthEnabled = (): boolean => process.env.RECOVER_DEV_AUTH === '1' && !onVercel();

export type DbEnv = { url: string; ssl: 'require' | 'disable' };

export function dbEnv(): DbEnv {
  return { url: requireEnv('DATABASE_URL'), ssl: process.env.DATABASE_SSL === 'require' ? 'require' : 'disable' };
}

export type S3Env = { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };

export function s3Env(): S3Env {
  return {
    endpoint: requireEnv('SUPABASE_S3_ENDPOINT').replace(/\/+$/, ''),
    region: requireEnv('SUPABASE_S3_REGION'),
    accessKeyId: requireEnv('SUPABASE_S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('SUPABASE_S3_SECRET_ACCESS_KEY'),
  };
}

// Fingerprint HMAC key (§9.3 step 5): base64url, at least 32 bytes, like the web's other keys.
export function contentKey(): Buffer {
  const key = fromB64url(requireEnv('CONTENT_KEY'));
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
  return { webUrl: requireEnv('WEB_URL').replace(/\/+$/, ''), secret: requireEnv('REVALIDATE_SECRET') };
}
