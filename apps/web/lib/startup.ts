// A dev-only switch (RECOVER_DEV_LOGIN, RECOVER_DEV_AUTH) set in a production build is treated as off by
// env.ts; this says so once, naming the variables only, never their values. instrumentation.ts calls it
// on the Node.js runtime only.
import { log } from '@recover/shared/log.ts';
import { ignoredDevFlags } from './env.ts';

export function reportIgnoredDevFlags(): void {
  const ignored = ignoredDevFlags();
  if (ignored.length > 0) log('warn', 'dev_flags_ignored', { flags: ignored });
}
