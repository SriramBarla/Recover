// One postgres.js pool per server instance, as recover_web (function-only grants; §7.5).
import { callApi, createDb, type Args, type Sql } from '@recover/shared/db.ts';
import { requireEnv } from './env.ts';

const g = globalThis as unknown as { __recoverWebDb?: Sql };

export function db(): Sql {
  if (!g.__recoverWebDb) {
    g.__recoverWebDb = createDb(requireEnv('DATABASE_URL'), {
      ssl: process.env.DATABASE_SSL === 'require' ? 'require' : 'disable',
      max: 4,
    });
  }
  return g.__recoverWebDb;
}

export function api<T = unknown>(name: `api_${string}`, args: Args = {}): Promise<T> {
  return callApi<T>(db(), name, args);
}
