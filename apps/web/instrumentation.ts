// Startup checks. Next.js calls register() once per server instance, before it serves requests.
// A dev-only switch (RECOVER_DEV_LOGIN, RECOVER_DEV_AUTH) set in a production build is treated as
// off by lib/env.ts; this says so once, naming the variables only, never their values.
import { log } from '@recover/shared/log.ts';
import { ignoredDevFlags } from './lib/env.ts';

export function register(): void {
  if (process.env.NEXT_RUNTIME === 'edge') return; // the shared logger writes to process.stderr
  const ignored = ignoredDevFlags();
  if (ignored.length > 0) log('warn', 'dev_flags_ignored', { flags: ignored });
}
