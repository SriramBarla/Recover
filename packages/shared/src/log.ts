// Structured JSON logging (§17; 15 Implementation guide "Structured logging"). One line per call.
// Every field passes a recursive, case-insensitive denylist so free text, credentials, digests, IPs,
// queries, pins, signed URLs, and storage paths never reach Vercel or Supabase logs (BUILD-CONTRACT.md
// section 0). The rules are a strict superset of the §17 list; over-scrubbing is the safe failure.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SCRUBBED = '[scrubbed]';
const MAX_DEPTH = 8;

// A key is scrubbed when any of its words (camelCase, snake_case, kebab-case, dotted; a trailing
// plural `s` ignored) is listed here, or when it starts with x-amz- / x_amz_.
const DENY = new Set([
  'description', 'note', 'body', 'bodies', 'authorization', 'cookie', 'token', 'password', 'secret',
  'digest', 'email', 'ip', 'ipv4', 'ipv6', 'address', 'addr', 'forwarded', 'q', 'query', 'queries', 'pin',
]);
// Path-like keys keep only route paths (a string starting with `/`); storage keys, URLs, and anything
// else under them is scrubbed.
const PATHLIKE = new Set(['path', 'url', 'uri', 'href']);

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function deniedKey(key: string, value: unknown): boolean {
  if (/^x[-_]amz[-_]/i.test(key)) return true; // x-amz-* headers and presign parameters
  const ws = words(key);
  if (ws.some((w) => DENY.has(w) || DENY.has(w.replace(/s$/, '')))) return true;
  const pathlike = key.toLowerCase() === 'key' || ws.some((w) => PATHLIKE.has(w) || PATHLIKE.has(w.replace(/s$/, '')));
  return pathlike && !(typeof value === 'string' && value.startsWith('/'));
}

function errorClass(err: unknown): string {
  if (!(err instanceof Error)) return 'NonError';
  const name = err.name && err.name !== 'Error' ? err.name : err.constructor?.name;
  return (name || 'Error').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 60) || 'Error';
}

function scrub(v: unknown, depth: number, stack: WeakSet<object>): unknown {
  if (typeof v === 'string') {
    // Signed URLs and anything naming a private bucket path go, whatever the key.
    return /x-amz-(signature|credential)=|(incoming|originals)\//i.test(v) ? SCRUBBED : v;
  }
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return SCRUBBED; // digests, keys, image bytes
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Error) {
    // Class and a code-shaped `code` only: messages can carry row values or provider text.
    const code = (v as { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? { error: errorClass(v), code } : { error: errorClass(v) };
  }
  if (stack.has(v)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  stack.add(v);
  let out: unknown;
  if (Array.isArray(v)) {
    out = v.map((x) => scrub(x, depth + 1, stack));
  } else {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = deniedKey(k, x) ? SCRUBBED : scrub(x, depth + 1, stack);
    out = o;
  }
  stack.delete(v);
  return out;
}

// Writes `{ts, level, event, ...fields}` as one JSON line: debug/info to stdout, warn/error to
// stderr. Never throws; fields cannot override the envelope keys.
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  let line: string;
  try {
    const clean = scrub(fields, 0, new WeakSet()) as Record<string, unknown>;
    delete clean.ts;
    delete clean.level;
    delete clean.event;
    line = JSON.stringify({ ts, level, event, ...clean });
  } catch {
    line = JSON.stringify({ ts, level, event, logFailure: true });
  }
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

// error_rollup signature (G-29): `route:ErrorClass`, at most 120 characters (api_record_error).
// Pass the route template (for example `POST /api/s/[code]/items`), never the concrete URL.
export function errorSignature(route: string, err: unknown): string {
  const cls = errorClass(err);
  const r = route.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 119 - cls.length);
  return `${r}:${cls}`;
}
