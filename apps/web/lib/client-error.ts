// Browser error beacon signatures (§17 D-6; G-29; security review L1). The browser sends
// `<error class>:<route template>` (components/student/client-api.ts reportClientError, where every
// path segment outside a fixed set becomes `*`). The endpoint is unauthenticated, so the value is
// never stored as sent: both halves must be on the allowlists below, and the stored signature is built
// here from the allowlisted parts. Anything else is refused. Every result satisfies the
// api_record_error pattern (letters, digits, `_:/.[]-` and space; at most 120 characters).

// Route templates the student pages produce, mapped to their App Router paths.
export const CLIENT_ERROR_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/s/*', '/s/[code]'],
  ['/s/*/found', '/s/[code]/found'],
  ['/s/*/items/*', '/s/[code]/items/[publicId]'],
  ['/s/*/search', '/s/[code]/search'],
  ['/s/*/lost', '/s/[code]/lost'],
  ['/s/*/lost/mine', '/s/[code]/lost/mine'],
  ['/s/*/mine', '/s/[code]/mine'],
  ['/offline', '/offline'],
]);

// The app's own kinds, the ECMAScript error classes, the DOMException names the student pages can
// raise (fetch, camera and photo capture, storage, service worker), chunk loading, and non-Error throws.
export const CLIENT_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'render_error',
  'upload_failed',
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'InternalError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'NotSupportedError',
  'InvalidStateError',
  'QuotaExceededError',
  'SecurityError',
  'DataCloneError',
  'EncodingError',
  'OperationError',
  'OverconstrainedError',
  'UnknownError',
  'ChunkLoadError',
  'Object',
  'NonError',
]);

const MAX_INPUT = 100;

// The stored signature for an allowlisted beacon value, or null when either half is unknown.
export function clientErrorSignature(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT) return null;
  const sep = raw.indexOf(':');
  if (sep < 1) return null;
  const cls = raw.slice(0, sep);
  const route = CLIENT_ERROR_ROUTES.get(raw.slice(sep + 1));
  if (!route || !CLIENT_ERROR_CLASSES.has(cls)) return null;
  return `client:${route}:${cls}`;
}
