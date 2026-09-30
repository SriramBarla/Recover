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

// Dev-only switches are refused on Vercel no matter what the flags say.
export const onVercel = (): boolean => Boolean(process.env.VERCEL);
export const devLoginEnabled = (): boolean => process.env.RECOVER_DEV_LOGIN === '1' && !onVercel();
export const devWorkerAuthEnabled = (): boolean => process.env.RECOVER_DEV_AUTH === '1' && !onVercel();

export function storagePublicUrl(bucket: 'variants' | 'maps', key: string): string {
  const base = requireEnv('STORAGE_PUBLIC_URL').replace(/\/+$/, '');
  return `${base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
