// A dev-only switch (RECOVER_DEV_LOGIN, RECOVER_DEV_AUTH) set in a production build is treated as off by
// env.ts; this says so once, naming the variables only, never their values. instrumentation.ts calls it
// on the Node.js runtime only.
import { log } from '@recover/shared/log.ts';
import { deviceKeyReport, ignoredDevFlags } from './env.ts';

export function reportIgnoredDevFlags(): void {
  const ignored = ignoredDevFlags();
  if (ignored.length > 0) log('warn', 'dev_flags_ignored', { flags: ignored });
}

// Device keys (RUNBOOK.md section 21): a configuration every device-bound request would fail on is named as
// an error, and a DEVICE_KEY_V<n> that no version uses as a warning, again by name only.
export function reportDeviceKeys(): void {
  const keys = deviceKeyReport();
  if (keys.problem) log('error', 'device_keys_invalid', { problem: keys.problem });
  if (keys.unused.length > 0) log('warn', 'device_keys_unused', { variables: keys.unused });
}
