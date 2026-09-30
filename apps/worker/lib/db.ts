// One postgres.js pool per worker instance, as recover_worker (EXECUTE on system_* only; §7.5, F-116).
// Opened lazily, so an unauthenticated request never reaches it (F-123, G-18).
import { callSystem, createDb, type Args, type Sql } from '@recover/shared/db.ts';
import { dbEnv } from './env.ts';

const g = globalThis as unknown as { __recoverWorkerDb?: Sql };

export function db(): Sql {
  if (!g.__recoverWorkerDb) {
    const e = dbEnv();
    g.__recoverWorkerDb = createDb(e.url, { ssl: e.ssl, max: 4 });
  }
  return g.__recoverWorkerDb;
}

export function sys<T = unknown>(name: `system_${string}`, args: Args = {}): Promise<T> {
  return callSystem<T>(db(), name, args);
}

// G-29: error signature upsert, best effort; a failure here must never mask the original error.
export async function recordError(signature: string): Promise<void> {
  try {
    await sys('system_record_error', { p_signature: signature.slice(0, 120) });
  } catch {
    // the database may be the thing that failed
  }
}
