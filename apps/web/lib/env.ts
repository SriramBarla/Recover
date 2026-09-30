// Server-only environment access for the web project (BUILD-CONTRACT.md section 10.1).
// Missing required variables fail loudly by name; values are never logged.

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

// Dev-only switches are refused on Vercel and in every production build (next build and next start
// run with NODE_ENV=production, which Next also inlines at build time), no matter what the flags say.
// `next dev` keeps them.
const DEV_FLAGS = ['RECOVER_DEV_LOGIN', 'RECOVER_DEV_AUTH'] as const;
type DevFlag = (typeof DEV_FLAGS)[number];

function devFlag(name: DevFlag): boolean {
  return process.env[name] === '1' && !onVercel() && process.env.NODE_ENV !== 'production';
}

export const devLoginEnabled = (): boolean => devFlag('RECOVER_DEV_LOGIN');
export const devWorkerAuthEnabled = (): boolean => devFlag('RECOVER_DEV_AUTH');

// Dev switches that are set in a production build and therefore ignored; instrumentation.ts logs
// them once at startup so the misconfiguration is visible.
export function ignoredDevFlags(): DevFlag[] {
  if (process.env.NODE_ENV !== 'production') return [];
  return DEV_FLAGS.filter((name) => Boolean(process.env[name]));
}

export function storagePublicUrl(bucket: 'variants' | 'maps', key: string): string {
  const base = requireEnv('STORAGE_PUBLIC_URL').replace(/\/+$/, '');
  return `${base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
