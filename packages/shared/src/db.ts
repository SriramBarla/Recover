// The only database wrapper (§7.5 F-116). Route handlers and jobs never import the driver directly.
// Calls use named-argument notation so argument order can never drift between SQL and TS:
//   select public.api_x(p_a => $1, p_b => $2) as r
// The function name and argument names are allowlisted identifiers; every value is a bound parameter.

import postgres from 'postgres';
import { PublicError, toPublicError } from './errors.ts';

export type Sql = postgres.Sql;

export type DbOptions = { ssl?: 'require' | 'disable'; max?: number };

export function createDb(url: string, opts: DbOptions = {}): Sql {
  return postgres(url, {
    prepare: false, // required by the Supabase transaction pooler
    max: opts.max ?? 4,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: opts.ssl === 'require' ? 'require' : false,
    onnotice: () => {},
  });
}

const FN_NAME = /^(api|system)_[a-z0-9_]+$/;
const ARG_NAME = /^p_[a-z0-9_]+$/;

export type Args = Record<string, unknown>;

// Value mapping: undefined -> null; Date -> ISO string; everything else is passed through.
// postgres.js describes the statement, learns each parameter's type from the function signature,
// and serializes accordingly: jsonb params get JSON.stringify exactly once (so pass plain objects
// and arrays, never pre-serialized JSON strings), uuid[]/text[] get array literals, Buffer -> bytea.
function toParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

async function call<T>(sql: Sql, name: string, args: Args): Promise<T> {
  if (!FN_NAME.test(name)) throw new Error(`db: refused function name ${name}`);
  const keys = Object.keys(args);
  for (const k of keys) {
    if (!ARG_NAME.test(k)) throw new Error(`db: refused argument name ${k}`);
  }
  const list = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = keys.map((k) => toParam(args[k]));
  try {
    const rows = await sql.unsafe(`select public.${name}(${list}) as r`, values as never[]);
    return (rows[0] as { r: T } | undefined)?.r as T;
  } catch (e) {
    const pe = toPublicError(e);
    if (pe.code !== 'internal') throw pe;
    throw e; // unexpected: caller logs a scrubbed signature and returns `internal`
  }
}

export function callApi<T = unknown>(sql: Sql, name: `api_${string}`, args: Args = {}): Promise<T> {
  return call<T>(sql, name, args);
}

export function callSystem<T = unknown>(sql: Sql, name: `system_${string}`, args: Args = {}): Promise<T> {
  return call<T>(sql, name, args);
}

export { PublicError };
