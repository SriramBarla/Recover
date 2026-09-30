// Scrubbed JSON-line logger (§15 "Logs"; BUILD-CONTRACT.md section 0 security invariants).
// Local stand-in until @recover/shared/log.ts lands; same log(level, event, fields) signature, so the
// swap is an import change. Denylisted field names are dropped, and string values that could carry a
// path, free text, or a token are redacted: logs hold codes, ids, kinds, and counts only.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogFn = (level: LogLevel, event: string, fields?: LogFields) => void;

const DENY = new Set([
  'path', 'paths', 'key', 'keys', 'url', 'urls', 'body', 'text', 'description', 'note', 'token', 'tokens',
  'secret', 'authorization', 'auth', 'bearer', 'cookie', 'digest', 'hash', 'hmac', 'fingerprint', 'email',
  'ip', 'pin', 'sub', 'ocr', 'payload', 'message', 'stack', 'detail',
]);

function denied(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => DENY.has(w));
}

const SAFE_VALUE = /^[A-Za-z0-9_.:@-]{0,120}$/;
const RESERVED = new Set(['t', 'level', 'event']);

export function scrub(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || RESERVED.has(k) || denied(k)) continue;
    if (typeof v === 'string') out[k] = SAFE_VALUE.test(v) ? v : '[redacted]';
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else out[k] = v;
  }
  return out;
}

export const log: LogFn = (level, event, fields = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event: SAFE_VALUE.test(event) ? event : 'event', ...scrub(fields) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

// Stable error class for signatures (G-29): the constructor name only, never the message.
export function errorClass(e: unknown): string {
  if (e instanceof Error) return /^[A-Za-z0-9_]{1,40}$/.test(e.name) ? e.name : 'Error';
  return typeof e;
}
