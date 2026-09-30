// Startup checks. Next.js calls register() once per server instance, before it serves requests.
// A dev-only switch (RECOVER_DEV_LOGIN, RECOVER_DEV_AUTH) set in a production build is treated as
// off by lib/env.ts; this says so once, naming the variables only, never their values.
// Device keys (RUNBOOK.md section 21): a configuration that every device-bound request would fail on is
// named here as an error, and a DEVICE_KEY_V<n> that no version uses as a warning, again by name only.
import { log } from '@recover/shared/log.ts';
import { deviceKeyReport, ignoredDevFlags } from './lib/env.ts';

export function register(): void {
  if (process.env.NEXT_RUNTIME === 'edge') return; // the shared logger writes to process.stderr
  const ignored = ignoredDevFlags();
  if (ignored.length > 0) log('warn', 'dev_flags_ignored', { flags: ignored });
  const keys = deviceKeyReport();
  if (keys.problem) log('error', 'device_keys_invalid', { problem: keys.problem });
  if (keys.unused.length > 0) log('warn', 'device_keys_unused', { variables: keys.unused });
}
