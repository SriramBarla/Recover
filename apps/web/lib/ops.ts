// Staff operation ids, the minimum-role matrix, the function -> assertion table, and the pure
// argument/body builders used to mint staff assertions (BUILD-CONTRACT.md section 5; §14.2, §14.3).
// The matrix is mirrored here for UI gating only: private.assert_staff in SQL is the enforcement
// point. This module is pure (no Next.js, no env, no database) so node --test can import it.
import { mint } from '@recover/shared/assertion.ts';
import { sha256Hex } from '@recover/shared/crypto.ts';
import { PublicError } from '@recover/shared/errors.ts';
import { cleanText, hasContactInfo } from '@recover/shared/unicode.ts';
import type { AssertionBundle, StaffRole } from '@recover/shared/dto.ts';
import { ALL_CATEGORIES } from '../components/staff/constants.ts';

// Enumerations used by the staff forms live in a client-safe module (no Node imports); re-exported
// here so routes and tests have one import site.
export {
  ALL_CATEGORIES,
  ASSIGNABLE_ROLES,
  BLOCK_REASONS,
  DELETE_REASONS,
  DISPOSITIONS,
  MAP_REJECT_REASONS,
  MEMBER_STATUSES,
  POST_MODES,
  PULL_REASONS,
  REJECT_REASONS,
} from '../components/staff/constants.ts';

// ---------- roles and operations ----------

export const ROLES: readonly StaffRole[] = ['reviewer', 'office', 'school_admin', 'district_admin'];

export function roleRank(role: StaffRole): number {
  return ROLES.indexOf(role);
}

export function atLeast(role: StaffRole, min: StaffRole): boolean {
  return roleRank(role) >= roleRank(min);
}

// Minimum role per operation (contract section 5). district.* is district_admin only.
export const OP_MIN_ROLE = {
  'queue.read': 'reviewer',
  'item.read': 'reviewer',
  'item.approve': 'reviewer',
  'item.reject': 'reviewer',
  'item.bulk_reject': 'reviewer',
  'item.pull': 'reviewer',
  'item.create': 'reviewer',
  'item.complete': 'reviewer',
  'media.read': 'reviewer',
  'reports.read': 'reviewer',
  'report.close': 'reviewer',
  'stats.read': 'reviewer',
  'item.receive': 'office',
  'item.transfer': 'office',
  'item.claim': 'office',
  'item.dispose': 'office',
  'item.bulk_dispose': 'office',
  'item.edit': 'office',
  'item.delete': 'office',
  'item.photo_drop': 'office',
  'item.confirm_publish': 'office',
  'device.block': 'office',
  'device.unblock': 'office',
  'roster.read': 'school_admin',
  'roster.invite': 'school_admin',
  'roster.update': 'school_admin',
  'locations.read': 'school_admin',
  'locations.write': 'school_admin',
  'zones.write': 'school_admin',
  'map.read': 'school_admin',
  'map.create': 'school_admin',
  'map.upload': 'school_admin',
  'map.submit': 'school_admin',
  'config.read': 'school_admin',
  'config.write': 'school_admin',
  'calendar.write': 'school_admin',
  'audit.read': 'school_admin',
  'map.activate': 'district_admin',
} as const satisfies Record<string, StaffRole>;

export type SchoolOperation = keyof typeof OP_MIN_ROLE;

// District function operation ids. The contract fixes only the `district.*` prefix; these names are
// this app's proposal and are listed in the PR for A-sql-staff (see FNS below).
export const DISTRICT_OPS = [
  'district.schools.read',
  'district.school.create',
  'district.settings.read',
  'district.settings.write',
  'district.maps.read',
  'district.map.reject',
  'district.identity.rebind',
  'district.stats.read',
  'district.alerts.read',
  'district.onboarding.read',
] as const;

export type DistrictOperation = (typeof DISTRICT_OPS)[number];

// Pre-session identity operations (G-05): district scope, no role requirement.
export type IdentityOperation = 'identity.bind' | 'session.resolve';

export type Operation = SchoolOperation | DistrictOperation | IdentityOperation;

export function minRoleFor(op: string): StaffRole | null {
  if (op.startsWith('district.')) return 'district_admin';
  if (Object.prototype.hasOwnProperty.call(OP_MIN_ROLE, op)) return OP_MIN_ROLE[op as SchoolOperation];
  return null;
}

// UI gating mirror. Unknown operations are never allowed.
export function canPerform(role: StaffRole | null | undefined, op: string): boolean {
  if (!role) return false;
  const min = minRoleFor(op);
  return min !== null && atLeast(role, min);
}

// Destructive actions that need a session authenticated within the last 10 minutes (G-31, §14.3).
export const STEP_UP_OPS: ReadonlySet<string> = new Set([
  'item.delete',
  'item.bulk_dispose',
  'roster.update',
  'config.write',
  'map.activate',
  'district.settings.write',
  'district.identity.rebind',
]);

export const STEP_UP_MAX_AGE_S = 600;

// ---------- function -> assertion spec ----------

export type Scope = 'school' | 'district';

type FnSpec = {
  op: Operation | 'ticket'; // 'ticket': the operation is the ticket's p_operation
  scope: Scope;
  target: readonly string[]; // arg keys; the first non-null value is the assertion target_id
};

// Every api_staff_* / api_district_* function (contract 6.2, 6.3). Target rule: the id argument of
// the entity whose state or row_version the function checks; null for lists, creates, and bulk.
export const FNS = {
  api_staff_bind_identity: { op: 'identity.bind', scope: 'district', target: [] },
  api_staff_resolve_session: { op: 'session.resolve', scope: 'district', target: [] },
  api_staff_queue: { op: 'queue.read', scope: 'school', target: [] },
  api_staff_item_get: { op: 'item.read', scope: 'school', target: ['p_item_id'] },
  api_staff_item_approve: { op: 'item.approve', scope: 'school', target: ['p_item_id'] },
  api_staff_item_reject: { op: 'item.reject', scope: 'school', target: ['p_item_id'] },
  api_staff_bulk_reject: { op: 'item.bulk_reject', scope: 'school', target: [] },
  api_staff_item_receive: { op: 'item.receive', scope: 'school', target: ['p_item_id'] },
  api_staff_item_transfer: { op: 'item.transfer', scope: 'school', target: ['p_item_id'] },
  api_staff_item_claim: { op: 'item.claim', scope: 'school', target: ['p_item_id'] },
  api_staff_item_dispose: { op: 'item.dispose', scope: 'school', target: ['p_item_id'] },
  api_staff_bulk_dispose: { op: 'item.bulk_dispose', scope: 'school', target: [] },
  api_staff_item_pull: { op: 'item.pull', scope: 'school', target: ['p_item_id'] },
  api_staff_item_delete: { op: 'item.delete', scope: 'school', target: ['p_item_id'] },
  api_staff_item_edit: { op: 'item.edit', scope: 'school', target: ['p_item_id'] },
  api_staff_item_confirm_publish: { op: 'item.confirm_publish', scope: 'school', target: ['p_item_id'] },
  api_staff_photo_drop: { op: 'item.photo_drop', scope: 'school', target: ['p_item_id'] },
  api_staff_create_item: { op: 'item.create', scope: 'school', target: [] },
  api_staff_complete_item: { op: 'item.complete', scope: 'school', target: ['p_item_id'] },
  api_staff_block_device: { op: 'device.block', scope: 'school', target: ['p_item_id', 'p_report_id'] },
  api_staff_unblock_device: { op: 'device.unblock', scope: 'school', target: ['p_item_id', 'p_report_id'] },
  api_staff_media_ticket: { op: 'ticket', scope: 'school', target: ['p_photo_id', 'p_map_version_id'] },
  api_staff_lost_reports: { op: 'reports.read', scope: 'school', target: [] },
  api_staff_report_close: { op: 'report.close', scope: 'school', target: ['p_report_id'] },
  api_staff_roster_list: { op: 'roster.read', scope: 'school', target: [] },
  api_staff_roster_invite: { op: 'roster.invite', scope: 'school', target: [] },
  api_staff_roster_update: { op: 'roster.update', scope: 'school', target: ['p_member_id'] },
  api_staff_locations_list: { op: 'locations.read', scope: 'school', target: [] },
  api_staff_location_upsert: { op: 'locations.write', scope: 'school', target: ['p_location_id'] },
  api_staff_location_pin_set: { op: 'locations.write', scope: 'school', target: ['p_location_id'] },
  api_staff_map_versions: { op: 'map.read', scope: 'school', target: [] },
  api_staff_map_create_draft: { op: 'map.create', scope: 'school', target: [] },
  api_staff_zone_upsert: { op: 'zones.write', scope: 'school', target: ['p_zone_id'] },
  api_staff_map_submit: { op: 'map.submit', scope: 'school', target: ['p_map_version_id'] },
  api_staff_config_get: { op: 'config.read', scope: 'school', target: [] },
  api_staff_config_update: { op: 'config.write', scope: 'school', target: [] },
  api_staff_calendar_upsert: { op: 'calendar.write', scope: 'school', target: [] },
  api_staff_stats: { op: 'stats.read', scope: 'school', target: [] },
  api_staff_audit: { op: 'audit.read', scope: 'school', target: [] },
  // PROPOSED, not in contract 6.2: custody lists for /staff/[code]/custody (expected arrivals,
  // at location, disposition due). The page falls back to the public feed until it exists.
  api_staff_custody_list: { op: 'item.read', scope: 'school', target: [] },
  api_district_schools_list: { op: 'district.schools.read', scope: 'district', target: [] },
  api_district_school_create: { op: 'district.school.create', scope: 'district', target: [] },
  api_district_settings_get: { op: 'district.settings.read', scope: 'district', target: [] },
  api_district_settings_update: { op: 'district.settings.write', scope: 'district', target: [] },
  api_district_maps_pending: { op: 'district.maps.read', scope: 'district', target: [] },
  api_district_map_reject: { op: 'district.map.reject', scope: 'district', target: ['p_map_version_id'] },
  api_district_identity_rebind: { op: 'district.identity.rebind', scope: 'district', target: ['p_staff_user_id'] },
  api_district_stats: { op: 'district.stats.read', scope: 'district', target: [] },
  api_district_alerts: { op: 'district.alerts.read', scope: 'district', target: [] },
  api_district_onboarding: { op: 'district.onboarding.read', scope: 'district', target: [] },
} as const satisfies Record<string, FnSpec>;

export type StaffFn = keyof typeof FNS;

export const TICKET_OPS = ['media.read', 'map.upload', 'map.read', 'map.activate'] as const;
export type TicketOperation = (typeof TICKET_OPS)[number];

export type Args = Record<string, unknown>;

export type CallSpec = { operation: string; scope: Scope; targetId: string | null; rowVersion: number | null };

// Derive the assertion fields for a catalogued function from its (normalized) arguments.
export function specFor(fn: StaffFn, args: Args): CallSpec {
  const spec: FnSpec = FNS[fn];
  let operation: string;
  let scope: Scope = spec.scope;
  if (spec.op === 'ticket') {
    const op = args.p_operation;
    if (typeof op !== 'string' || !(TICKET_OPS as readonly string[]).includes(op)) {
      throw new PublicError('invalid_input', 'operation');
    }
    operation = op;
    if (op === 'map.activate') scope = 'district'; // G-07: activation is a district decision
  } else {
    operation = spec.op;
  }
  let targetId: string | null = null;
  for (const key of spec.target) {
    const v = args[key];
    if (typeof v === 'string' && v) {
      targetId = v;
      break;
    }
  }
  const rv = args.p_row_version;
  const rowVersion = typeof rv === 'number' ? rv : null;
  return { operation, scope, targetId, rowVersion };
}

// ---------- argument normalization and the canonical body ----------

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const SCHOOL_CODE_RE = /^[A-Z]{2,6}$/;
const ARG_KEY_RE = /^p_[a-z0-9_]+$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Inside jsonb values: NFC every string, lowercase uuid strings under `...Id` / `...Ids` keys, and
// refuse non-integer numbers (section 5: no floats anywhere in the body).
function normalizeJson(v: unknown, key: string): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const s = v.normalize('NFC');
    return /Ids?$/.test(key) && UUID_RE.test(s) ? s.toLowerCase() : s;
  }
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`args: non-integer number under ${key}; send it as a string`);
    return v;
  }
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => normalizeJson(x, key));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalizeJson(x, k);
    return out;
  }
  throw new Error(`args: unsupported value under ${key}`);
}

// Normalize SQL arguments (section 5): undefined -> null; strings NFC; `p_*_id` values must be uuids
// and are lowercased; `p_*_ids` arrays likewise; numbers must be safe integers (pins, zone numbers,
// and timestamps are passed as strings by the caller).
export function normalizeArgs(args: Args): Args {
  const out: Args = {};
  for (const [key, raw] of Object.entries(args)) {
    if (!ARG_KEY_RE.test(key) || key === 'p_assert') throw new Error(`args: refused key ${key}`);
    if (raw === undefined || raw === null) {
      out[key] = null;
    } else if (key.endsWith('_id')) {
      if (!isUuid(raw)) throw new PublicError('invalid_input', key.slice(2));
      out[key] = raw.toLowerCase();
    } else if (key.endsWith('_ids')) {
      if (!Array.isArray(raw) || !raw.every(isUuid)) throw new PublicError('invalid_input', key.slice(2));
      out[key] = raw.map((x) => (x as string).toLowerCase());
    } else {
      out[key] = normalizeJson(raw, key);
    }
  }
  return out;
}

// The assertion body: every business argument keyed without the p_ prefix (section 5).
export function bodyOf(args: Args): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(args)) {
    if (key === 'p_assert') continue;
    if (!ARG_KEY_RE.test(key)) throw new Error(`args: refused key ${key}`);
    body[key.slice(2)] = v === undefined ? null : v;
  }
  return body;
}

export function prepareArgs(args: Args): { args: Args; body: Record<string, unknown> } {
  const normalized = normalizeArgs(args);
  return { args: normalized, body: bodyOf(normalized) };
}

export type PrepareInput = {
  sub: string;
  operation: string;
  scope: Scope;
  schoolId?: string | null;
  targetId?: string | null;
  rowVersion?: number | null;
  args: Args;
  idempotencyKey?: string | null;
  keyB64url: string;
  keyVersion: number;
  requestId?: string;
  now?: number;
};

export function scopeString(scope: Scope, schoolId?: string | null): string {
  if (scope === 'district') return 'district';
  if (!isUuid(schoolId)) throw new Error('assertion: school scope needs a school uuid');
  return `school:${schoolId.toLowerCase()}`;
}

// Build the full parameter object for `select public.<fn>(p_assert => ..., ...)`: the normalized
// business args plus the minted bundle whose body hash covers exactly those args.
export function prepareCall(i: PrepareInput): { params: Args; bundle: AssertionBundle } {
  const { args, body } = prepareArgs(i.args);
  const targetId = i.targetId ?? null;
  if (targetId !== null && !isUuid(targetId)) throw new PublicError('invalid_input', 'targetId');
  const rowVersion = i.rowVersion ?? null;
  if (rowVersion !== null && !Number.isSafeInteger(rowVersion)) throw new PublicError('invalid_input', 'rowVersion');
  if ('p_row_version' in args && args.p_row_version !== rowVersion) {
    throw new Error('assertion: row_version must equal p_row_version');
  }
  if (!Number.isSafeInteger(i.keyVersion) || i.keyVersion < 1) throw new Error('assertion: bad key version');
  const bundle = mint({
    googleSub: i.sub,
    scope: scopeString(i.scope, i.schoolId),
    operation: i.operation,
    targetId: targetId ? targetId.toLowerCase() : null,
    rowVersion,
    body,
    idempotencyKeySha256: i.idempotencyKey ? sha256Hex(i.idempotencyKey) : null,
    keyB64url: i.keyB64url,
    keyVersion: i.keyVersion,
    ...(i.requestId ? { requestId: i.requestId } : {}),
    ...(i.now !== undefined ? { now: i.now } : {}),
  });
  return { params: { p_assert: bundle, ...args }, bundle };
}

// ---------- session windows (§14.1: 24 h absolute, 8 h idle; G-31 step-up) ----------

export const SESSION_ABSOLUTE_S = 24 * 60 * 60;
export const SESSION_IDLE_S = 8 * 60 * 60;

export type TokenTimes = { sub?: unknown; authTime?: unknown; lastSeen?: unknown };

// Returns the live session fields, or null when the token is malformed or past either window.
export function liveSession(t: TokenTimes, nowS: number): { sub: string; authTime: number } | null {
  if (typeof t.sub !== 'string' || !t.sub) return null;
  if (typeof t.authTime !== 'number' || !Number.isFinite(t.authTime)) return null;
  const lastSeen = typeof t.lastSeen === 'number' && Number.isFinite(t.lastSeen) ? t.lastSeen : t.authTime;
  if (t.authTime > nowS + 60) return null;
  if (nowS - t.authTime > SESSION_ABSOLUTE_S) return null;
  if (nowS - lastSeen > SESSION_IDLE_S) return null;
  return { sub: t.sub, authTime: t.authTime };
}

export function isFresh(authTime: number, nowS: number, maxAgeS = STEP_UP_MAX_AGE_S): boolean {
  return nowS - authTime <= maxAgeS && authTime <= nowS + 60;
}

// ---------- identity helpers (§14.1) ----------

// Exact parsed domain of a lowercase email; null unless the address has one '@' and no whitespace.
export function emailDomain(email: string): string | null {
  if (!email || email.length > 254 || /\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  return domain;
}

// Exact match only; never suffix or substring matching.
export function domainAllowed(email: string, domains: readonly string[]): boolean {
  const d = emailDomain(email);
  return d !== null && domains.some((x) => typeof x === 'string' && x.toLowerCase() === d);
}

// ---------- request validation (route handlers) ----------

// Rejects C0/C1 controls and bidi overrides (used for small non-text fields such as emails).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

// Free text through the shared Unicode policy (F-102): NFC, controls and bidi refused, whitespace
// collapsed, length in code points. Optional fields map empty input to null.
export function textOf(v: unknown, field: string, opts: { min?: number; max: number; optional?: boolean }): string | null {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (opts.optional) return null;
    throw new PublicError('invalid_input', field);
  }
  return cleanText(v, { field, min: opts.min ?? 1, max: opts.max });
}

// The one public free-text field (contract section 0): 2..120 code points and no contact details
// (§10.2 layer 1 applies to staff-written text too).
export function publicDescriptionOf(v: unknown): string {
  const s = cleanText(v, { field: 'description', min: 2, max: 120 });
  if (hasContactInfo(s)) throw new PublicError('invalid_input', 'description');
  return s;
}

export function uuidOf(v: unknown, field: string): string {
  if (!isUuid(v)) throw new PublicError('invalid_input', field);
  return v.toLowerCase();
}

export function uuidOrNull(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return uuidOf(v, field);
}

export function idsOf(v: unknown, field: string, max: number): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw new PublicError('invalid_input', field);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    const id = uuidOf(x, field);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function intOf(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new PublicError('invalid_input', field);
  }
  return v;
}

export function boolOf(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new PublicError('invalid_input', field);
  return v;
}

export function enumOf<T extends string>(v: unknown, field: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new PublicError('invalid_input', field);
  return v as T;
}

export function rowVersionOf(v: unknown): number {
  return intOf(v, 'rowVersion', 0, Number.MAX_SAFE_INTEGER);
}

// Normalized map coordinate in [0, 1], sent to SQL as a fixed 6-decimal string (section 5).
export function coordStr(v: unknown, field: string): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new PublicError('invalid_input', field);
  return v.toFixed(6);
}

// Zone radius in (0, 0.5] (map_zones CHECK), as a 6-decimal string.
export function radiusStr(v: unknown, field: string): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 0.5) throw new PublicError('invalid_input', field);
  return v.toFixed(6);
}

export function dateOf(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new PublicError('invalid_input', field);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new PublicError('invalid_input', field);
  return v;
}

// Stats window: defaults to the last 30 days (UTC dates); at most 366 days; from <= to.
export function rangeOf(from: unknown, to: unknown, nowMs = Date.now()): { from: string; to: string } {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const toDay = to === undefined || to === null || to === '' ? today : dateOf(to, 'to');
  const fromDay =
    from === undefined || from === null || from === ''
      ? new Date(Date.parse(`${toDay}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10)
      : dateOf(from, 'from');
  const span = (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000;
  if (span < 0 || span > 366) throw new PublicError('invalid_input', 'from');
  return { from: fromDay, to: toDay };
}

// Timestamps are forwarded exactly as the server issued them (section 5); only the shape is checked.
export function isoOf(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new PublicError('invalid_input', field);
  }
  return v;
}

export function emailOf(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new PublicError('invalid_input', field);
  const e = v.normalize('NFC').trim().toLowerCase();
  if (!emailDomain(e) || CONTROL_RE.test(e)) throw new PublicError('invalid_input', field);
  return e;
}

export function schoolCodeOf(v: unknown): string {
  if (typeof v !== 'string' || !SCHOOL_CODE_RE.test(v)) throw new PublicError('not_found');
  return v;
}

// ---------- structured bodies (jsonb arguments) ----------

const EDIT_KEYS = ['description', 'category', 'zoneId', 'dropoffLocationId'] as const;

// p_edits for approve-with-edits and edit (contract 6.2): only these four keys, or null for none.
export function editsOf(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) throw new PublicError('invalid_input', 'edits');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v)) {
    if (!(EDIT_KEYS as readonly string[]).includes(key)) throw new PublicError('invalid_input', key);
  }
  if ('description' in v) out.description = publicDescriptionOf(v.description);
  if ('category' in v) out.category = enumOf(v.category, 'category', ALL_CATEGORIES);
  if ('zoneId' in v) out.zoneId = uuidOrNull(v.zoneId, 'zoneId');
  if ('dropoffLocationId' in v) out.dropoffLocationId = uuidOf(v.dropoffLocationId, 'dropoffLocationId');
  return Object.keys(out).length > 0 ? out : null;
}

type ChangeRule = (v: unknown, field: string) => unknown;

const boolRule: ChangeRule = (v, f) => boolOf(v, f);
const intRule = (min: number, max: number): ChangeRule => (v, f) => intOf(v, f, min, max);

function changesOf(v: unknown, rules: Record<string, ChangeRule>): Record<string, unknown> {
  if (!isPlainObject(v)) throw new PublicError('invalid_input', 'changes');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    const rule = rules[key];
    if (!rule) throw new PublicError('invalid_input', key);
    out[key] = rule(value, key);
  }
  if (Object.keys(out).length === 0) throw new PublicError('invalid_input', 'changes');
  return out;
}

// p_changes for api_staff_config_update (§5.5). SQL re-checks the retention floor and ceiling.
export function configChangesOf(v: unknown): Record<string, unknown> {
  return changesOf(v, {
    studentPostingEnabled: boolRule,
    lostReportsEnabled: boolRule,
    crossSchoolSearchEnabled: boolRule,
    retentionDays: intRule(1, 365),
    neverArrivedSchoolDays: intRule(1, 10),
    enabledCategories: (x, f) => {
      if (!Array.isArray(x) || x.length > ALL_CATEGORIES.length) throw new PublicError('invalid_input', f);
      return [...new Set(x.map((c) => enumOf(c, f, ALL_CATEGORIES)))];
    },
  });
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// p_changes for api_district_settings_update (§5.6; G-06 worker mode).
export function districtChangesOf(v: unknown): Record<string, unknown> {
  return changesOf(v, {
    retentionDaysFloor: intRule(1, 365),
    retentionDaysCeiling: intRule(1, 365),
    staffEmailDomains: (x, f) => {
      if (!Array.isArray(x) || x.length === 0 || x.length > 10) throw new PublicError('invalid_input', f);
      const out = x.map((d) => {
        if (typeof d !== 'string') throw new PublicError('invalid_input', f);
        const s = d.trim().toLowerCase();
        if (!DOMAIN_RE.test(s) || s.length > 253) throw new PublicError('invalid_input', f);
        return s;
      });
      return [...new Set(out)];
    },
    studentPostingGlobalEnabled: boolRule,
    lostReportsGlobalEnabled: boolRule,
    crossSchoolSearchGlobalEnabled: boolRule,
    screeningEnabled: boolRule,
    screeningDailyCeiling: intRule(0, 100_000),
    workerMode: (x, f) => enumOf(x, f, ['normal', 'quarantine'] as const),
    lostReportTtlDays: intRule(1, 180),
    rejectedMediaRetentionDays: intRule(1, 90),
  });
}

export type CalendarDay = { day: string; isOpen: boolean; openAt: string | null; closeAt: string | null };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function timeOf(v: unknown, field: string): string {
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw new PublicError('invalid_input', field);
  return v.length === 5 ? `${v}:00` : v;
}

// p_days for api_staff_calendar_upsert: [{day, isOpen, openAt, closeAt}] mirroring the
// school_calendar_days CHECK (open days need open_at < close_at; closed days have neither).
export function calendarDaysOf(v: unknown, max = 400): CalendarDay[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) throw new PublicError('invalid_input', 'days');
  const seen = new Set<string>();
  return v.map((raw) => {
    if (!isPlainObject(raw)) throw new PublicError('invalid_input', 'days');
    const day = dateOf(raw.day, 'day');
    if (seen.has(day)) throw new PublicError('invalid_input', 'day');
    seen.add(day);
    const isOpen = boolOf(raw.isOpen, 'isOpen');
    if (!isOpen) {
      if ((raw.openAt ?? null) !== null || (raw.closeAt ?? null) !== null) throw new PublicError('invalid_input', 'openAt');
      return { day, isOpen, openAt: null, closeAt: null };
    }
    const openAt = timeOf(raw.openAt, 'openAt');
    const closeAt = timeOf(raw.closeAt, 'closeAt');
    if (openAt >= closeAt) throw new PublicError('invalid_input', 'closeAt');
    return { day, isOpen, openAt, closeAt };
  });
}

// ---------- navigation ----------

export type SchoolPage = { seg: string; label: string; op: SchoolOperation };

export const SCHOOL_PAGES: readonly SchoolPage[] = [
  { seg: 'queue', label: 'Queue', op: 'queue.read' },
  { seg: 'custody', label: 'Custody', op: 'item.receive' },
  { seg: 'post', label: 'Post', op: 'item.create' },
  { seg: 'reports', label: 'Lost reports', op: 'reports.read' },
  { seg: 'stats', label: 'Stats', op: 'stats.read' },
  { seg: 'roster', label: 'Roster', op: 'roster.read' },
  { seg: 'locations', label: 'Locations', op: 'locations.read' },
  { seg: 'map', label: 'Map', op: 'map.read' },
  { seg: 'config', label: 'Settings', op: 'config.read' },
];

export function pagesFor(role: StaffRole): SchoolPage[] {
  return SCHOOL_PAGES.filter((p) => canPerform(role, p.op));
}

// Same-site relative paths only (no scheme, no protocol-relative, no backslashes).
export function safeReturnPath(v: unknown, fallback = '/staff'): string {
  if (typeof v !== 'string' || v.length > 300) return fallback;
  if (!/^\/(staff|district)(\/|$|\?)/.test(v)) return fallback;
  if (v.includes('//') || v.includes('\\') || CONTROL_RE.test(v)) return fallback;
  return v;
}
