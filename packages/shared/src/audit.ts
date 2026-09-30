// Per-action audit payload allowlists (F-74; 14 Implementation guide "Audit payload allowlists").
// TS mirror of the lists SQL enforces when it writes audit_log. Payloads are flat: scalar values or
// arrays of scalars. Forbidden everywhere (05 audit_log comment, contract section 0): free text,
// notes, pins, device digests or tokens, storage paths or URLs, emails, request bodies, OCR text.
// Device-origin rows carry request_id and actor_id = NULL; that is a column rule, not a payload key.
export const AUDIT_ALLOWLIST = {
  'item.create': ['review_status', 'publication_status', 'custody', 'posted_by_kind', 'category', 'public_id', 'photo_count', 'row_version'],
  'item.complete': ['review_status', 'publication_status', 'public_id', 'arrival_deadline_at', 'photo_count', 'row_version'],
  'item.approve': ['review_status', 'publication_status', 'edited_fields', 'row_version'],
  'item.reject': ['review_status', 'reject_reason', 'row_version'],
  'item.receive': ['custody', 'current_location_id', 'expires_at', 'row_version'],
  'item.receive_late': ['custody', 'publication_status', 'current_location_id', 'expires_at', 'row_version'],
  'item.transfer': ['current_location_id', 'row_version'],
  'item.claim': ['custody', 'publication_status', 'row_version'],
  'item.dispose': ['custody', 'publication_status', 'row_version'],
  'item.pull': ['publication_status', 'reason', 'row_version'],
  'item.delete': ['publication_status', 'reason', 'row_version'],
  'item.edit': ['edited_fields', 'row_version'],
  'item.confirm_publish': ['publication_status', 'row_version'],
  'item.photo_drop': ['photo_id', 'position', 'row_version'],
  'item.expire_never_arrived': ['custody', 'publication_status', 'arrival_deadline_at', 'row_version'],
  'report.create': ['status', 'category', 'expires_at', 'row_version'],
  'report.close': ['status', 'row_version'],
  'report.expire': ['status', 'row_version'],
  'staff.invite': ['role', 'school_id'],
  'staff.update': ['role', 'status', 'school_id'],
  'school.config': ['changed_keys'],
  'school.create': ['code', 'timezone'],
  'district.config': ['changed_keys'],
  'map.submit': ['map_version_id', 'approval_status'],
  'map.activate': ['map_version_id', 'previous_map_version_id', 'approval_status'],
  'map.reject': ['map_version_id', 'approval_status', 'reason'],
  'device.block': ['blocked_until', 'days', 'reason', 'source'],
  'device.unblock': ['blocked_until'],
  'identity.rebind': ['staff_user_id'],
  'job.dead': ['job_id', 'kind', 'attempts', 'error_code'],
  'alert.*': ['metric', 'value', 'threshold', 'window_s', 'count', 'severity'], // any alert.<name> (§17)
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_ALLOWLIST;

// Key words that may never appear in an audit payload key, whatever an allowlist says.
export const AUDIT_FORBIDDEN_WORDS: readonly string[] = [
  'description', 'note', 'pin', 'digest', 'path', 'email', 'token', 'hash', 'url', 'body', 'ip', 'query',
  'ocr', 'text', 'name', 'secret', 'password', 'cookie', 'authorization', 'bearer',
];

const ALERT = /^alert\.[a-z][a-z0-9_]*$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;

export function allowlistFor(action: string): readonly string[] | null {
  if (Object.prototype.hasOwnProperty.call(AUDIT_ALLOWLIST, action) && action !== 'alert.*') {
    return AUDIT_ALLOWLIST[action as AuditAction];
  }
  return ALERT.test(action) ? AUDIT_ALLOWLIST['alert.*'] : null;
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

// Throws unless `obj` is a flat payload whose keys are all allowlisted for `action`. Error messages
// name the action and key only, never a value.
export function assertAuditPayload(action: string, obj: unknown): void {
  const allowed = allowlistFor(action);
  if (!allowed) throw new Error(`audit: unknown action ${action}`);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`audit: ${action} payload must be an object`);
  for (const [key, value] of Object.entries(obj)) {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
    if (words.some((w) => AUDIT_FORBIDDEN_WORDS.includes(w))) throw new Error(`audit: ${action} forbidden key ${key}`);
    if (!allowed.includes(key)) throw new Error(`audit: ${action} key not allowlisted: ${key}`);
    if (!(isScalar(value) || (Array.isArray(value) && value.every(isScalar)))) {
      throw new Error(`audit: ${action} ${key} must be a scalar or an array of scalars`);
    }
    if (/(^|_)reason$/.test(key) && value !== null && !(typeof value === 'string' && REASON_CODE.test(value))) {
      throw new Error(`audit: ${action} ${key} must be a reason code, not free text`);
    }
  }
}
