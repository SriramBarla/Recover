// Required environment variables for the apps (contract section 11). Shared modules never call this
// or read the environment themselves. The error lists missing names only, never any value.
export function requireEnv<const N extends string>(
  names: readonly N[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<N, string> {
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  const out = {} as Record<N, string>;
  for (const n of names) out[n] = env[n] as string;
  return out;
}
