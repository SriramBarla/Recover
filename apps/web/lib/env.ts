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

// Device digest keys (§6.4; 13 Implementation guide "Device cookie issuance"; RUNBOOK.md section 21).
// DEVICE_KEY_V<n> is the base64url of the 32-byte HMAC key whose digests start with version byte n.
// DEVICE_KEY_CURRENT (default 1) is the version every digest is written and looked up with. DEVICE_KEY_PREVIOUS
// is set only during a rotation window, while lib/device.ts moves each browser's rows to its current-key digest.
// Errors name the variable, never its value.
export type DeviceKey = { version: number; key: string };
export type DeviceKeys = { current: DeviceKey; previous: DeviceKey | null };

type Env = Readonly<Record<string, string | undefined>>;

const KEY_VERSION_RE = /^[1-9][0-9]{0,2}$/;
// 43 characters are exactly 32 bytes. The padded standard-base64 spelling of the same bytes decodes the same way.
const DEVICE_KEY_RE = /^[A-Za-z0-9_+/-]{43}=?$/;
const DEVICE_KEY_NAME_RE = /^DEVICE_KEY_V([1-9][0-9]{0,2})$/;

function keyVersion(env: Env, name: 'DEVICE_KEY_CURRENT' | 'DEVICE_KEY_PREVIOUS'): number | null {
  const v = env[name];
  if (!v) return null;
  if (!KEY_VERSION_RE.test(v) || Number(v) > 255) throw new Error(`${name} must be a key version from 1 to 255`);
  return Number(v);
}

function deviceKey(env: Env, version: number): DeviceKey {
  const name = `DEVICE_KEY_V${version}`;
  const key = env[name];
  if (!key) throw new Error(`Missing required environment variable ${name}`);
  if (!DEVICE_KEY_RE.test(key)) throw new Error(`${name} must be a base64url 32-byte key`);
  return { version, key };
}

export function deviceKeys(env: Env = process.env): DeviceKeys {
  const current = keyVersion(env, 'DEVICE_KEY_CURRENT') ?? 1;
  const previous = keyVersion(env, 'DEVICE_KEY_PREVIOUS');
  if (previous === current) throw new Error('DEVICE_KEY_PREVIOUS must differ from DEVICE_KEY_CURRENT');
  return { current: deviceKey(env, current), previous: previous === null ? null : deviceKey(env, previous) };
}

// What instrumentation.ts reports at startup: the configuration problem, which fails every device-bound request,
// and the DEVICE_KEY_V<n> variables no version uses (a key left behind after a window, or a window opened
// without DEVICE_KEY_PREVIOUS). Names only.
export function deviceKeyReport(env: Env = process.env): { problem: string | null; unused: string[] } {
  let keys: DeviceKeys;
  try {
    keys = deviceKeys(env);
  } catch (e) {
    return { problem: e instanceof Error ? e.message : 'invalid device keys', unused: [] };
  }
  const used = new Set([keys.current.version, keys.previous?.version]);
  const unused = Object.keys(env)
    .filter((name) => {
      const m = DEVICE_KEY_NAME_RE.exec(name);
      return m !== null && Boolean(env[name]) && !used.has(Number(m[1]));
    })
    .sort();
  return { problem: null, unused };
}

export function storagePublicUrl(bucket: 'variants' | 'maps', key: string): string {
  const base = requireEnv('STORAGE_PUBLIC_URL').replace(/\/+$/, '');
  return `${base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
