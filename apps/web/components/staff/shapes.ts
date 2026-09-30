// Tolerant readers for staff/district SQL results. The contract pins StaffItemRow, the session,
// and the lost-report list; the roster, locations, map versions, config, district lists, alerts,
// onboarding, and audit shapes are not pinned, so each reader accepts the camelCase keys this app
// expects (listed in the PR) plus obvious aliases, drops everything else, and never throws.
import type { Membership, StaffItemRow, StaffRole } from '@recover/shared/dto.ts';

export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export function list(v: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const o = obj(v);
  if (o) {
    for (const k of keys) {
      const x = o[k];
      if (Array.isArray(x)) return x;
    }
  }
  return [];
}

function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function point(v: unknown): { x: number; y: number } | null {
  const o = obj(v);
  if (!o) return null;
  const x = num(o.x);
  const y = num(o.y);
  return x === null || y === null ? null : { x, y };
}

const ROLE_SET: readonly string[] = ['reviewer', 'office', 'school_admin', 'district_admin'];

function role(v: unknown): StaffRole | null {
  return typeof v === 'string' && ROLE_SET.includes(v) ? (v as StaffRole) : null;
}

// ---------- session and schools ----------

export function membershipsOf(v: unknown): Membership[] {
  const out: Membership[] = [];
  for (const raw of list(v, 'memberships')) {
    const o = obj(raw);
    const r = o ? role(o.role) : null;
    if (!o || !r) continue;
    const status = o.status === 'invited' || o.status === 'active' || o.status === 'deactivated' ? o.status : 'active';
    out.push({
      memberId: str(o.memberId) ?? '',
      schoolId: str(o.schoolId),
      schoolCode: str(o.schoolCode),
      schoolName: str(o.schoolName),
      role: r,
      status,
    });
  }
  return out;
}

export type SchoolRef = { id: string; code: string; name: string; timezone: string | null; active: boolean };

export function schoolsOf(v: unknown): SchoolRef[] {
  const out: SchoolRef[] = [];
  for (const raw of list(v, 'schools')) {
    const o = obj(raw);
    if (!o) continue;
    const id = str(pick(o, 'id', 'schoolId'));
    const code = str(pick(o, 'code', 'schoolCode'));
    if (!id || !code) continue;
    out.push({
      id: id.toLowerCase(),
      code,
      name: str(pick(o, 'name', 'schoolName')) ?? code,
      timezone: str(o.timezone),
      active: bool(o.active) ?? true,
    });
  }
  return out;
}

// ---------- queue and items ----------

export type QueuePage = { items: StaffItemRow[]; nextCursor: { createdAt: string; id: string } | null };

export function itemOf(v: unknown): StaffItemRow | null {
  const o = obj(v);
  if (!o || typeof o.id !== 'string') return null;
  const row = o as unknown as StaffItemRow;
  return {
    ...row,
    flags: Array.isArray(o.flags) ? o.flags.filter((f): f is string => typeof f === 'string') : [],
    photos: Array.isArray(o.photos) ? (o.photos as StaffItemRow['photos']) : [],
    quarantine: o.quarantine === true,
  };
}

export function queueOf(v: unknown): QueuePage {
  const items: StaffItemRow[] = [];
  for (const raw of list(v, 'items')) {
    const item = itemOf(raw);
    if (item) items.push(item);
  }
  const c = obj(obj(v)?.nextCursor);
  const createdAt = c ? str(c.createdAt) : null;
  const id = c ? str(c.id) : null;
  return { items, nextCursor: createdAt && id ? { createdAt, id } : null };
}

// ---------- roster ----------

export type RosterMember = {
  memberId: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: StaffRole | null;
  status: string | null;
  lastLoginAt: string | null;
};

export function rosterOf(v: unknown): RosterMember[] {
  const out: RosterMember[] = [];
  for (const raw of list(v, 'members', 'roster', 'staff')) {
    const o = obj(raw);
    const memberId = o ? str(pick(o, 'memberId', 'id')) : null;
    if (!o || !memberId) continue;
    out.push({
      memberId,
      userId: str(pick(o, 'userId', 'staffUserId')),
      email: str(o.email),
      displayName: str(o.displayName),
      role: role(o.role),
      status: str(o.status),
      lastLoginAt: str(o.lastLoginAt),
    });
  }
  return out;
}

// ---------- locations, maps, zones ----------

export type LocationRow = {
  id: string;
  code: string;
  name: string;
  hours: string | null;
  active: boolean;
  pin: { x: number; y: number } | null; // on the active map
  pins: { mapVersionId: string; x: number; y: number }[];
};

export function locationsOf(v: unknown): LocationRow[] {
  const out: LocationRow[] = [];
  for (const raw of list(v, 'locations')) {
    const o = obj(raw);
    const id = o ? str(pick(o, 'id', 'locationId')) : null;
    if (!o || !id) continue;
    const pins: LocationRow['pins'] = [];
    for (const p of list(o.pins)) {
      const po = obj(p);
      const mapVersionId = po ? str(po.mapVersionId) : null;
      const pt = point(po);
      if (mapVersionId && pt) pins.push({ mapVersionId, ...pt });
    }
    out.push({
      id,
      code: str(o.code) ?? '',
      name: str(o.name) ?? '',
      hours: str(o.hours),
      active: bool(o.active) ?? true,
      pin: point(o.pin),
      pins,
    });
  }
  return out;
}

export type ZoneRow = { id: string; name: string; cx: number; cy: number; radius: number; active: boolean };

export function zonesOf(v: unknown): ZoneRow[] {
  const out: ZoneRow[] = [];
  for (const raw of list(v, 'zones')) {
    const o = obj(raw);
    const id = o ? str(pick(o, 'id', 'zoneId')) : null;
    const cx = o ? num(o.cx) : null;
    const cy = o ? num(o.cy) : null;
    const radius = o ? num(o.radius) : null;
    if (!o || !id || cx === null || cy === null || radius === null) continue;
    out.push({ id, name: str(o.name) ?? '', cx, cy, radius, active: bool(o.active) ?? true });
  }
  return out;
}

export type MapVersionRow = {
  id: string;
  approvalStatus: string;
  active: boolean;
  width: number | null;
  height: number | null;
  createdAt: string | null;
  approvedAt: string | null;
  hasImage: boolean | null;
  zones: ZoneRow[];
};

export function mapVersionsOf(v: unknown): MapVersionRow[] {
  const out: MapVersionRow[] = [];
  for (const raw of list(v, 'versions', 'maps', 'mapVersions')) {
    const o = obj(raw);
    const id = o ? str(pick(o, 'id', 'mapVersionId', 'versionId')) : null;
    if (!o || !id) continue;
    const width = num(pick(o, 'width', 'widthPx'));
    out.push({
      id,
      approvalStatus: str(pick(o, 'approvalStatus', 'status')) ?? 'draft',
      active: bool(o.active) ?? false,
      width,
      height: num(pick(o, 'height', 'heightPx')),
      createdAt: str(o.createdAt),
      approvedAt: str(o.approvedAt),
      hasImage: bool(pick(o, 'hasImage', 'hasDraft', 'draftUploaded')) ?? (width !== null ? true : null),
      zones: zonesOf(o.zones),
    });
  }
  return out;
}

export type PendingMap = {
  id: string;
  schoolId: string | null;
  schoolCode: string | null;
  schoolName: string | null;
  width: number | null;
  height: number | null;
  submittedAt: string | null;
  zones: ZoneRow[];
};

export function pendingMapsOf(v: unknown): PendingMap[] {
  const out: PendingMap[] = [];
  for (const raw of list(v, 'maps', 'versions', 'pending')) {
    const o = obj(raw);
    const id = o ? str(pick(o, 'id', 'mapVersionId', 'versionId')) : null;
    if (!o || !id) continue;
    out.push({
      id,
      schoolId: str(o.schoolId),
      schoolCode: str(o.schoolCode),
      schoolName: str(o.schoolName),
      width: num(pick(o, 'width', 'widthPx')),
      height: num(pick(o, 'height', 'heightPx')),
      submittedAt: str(pick(o, 'submittedAt', 'updatedAt', 'createdAt')),
      zones: zonesOf(o.zones),
    });
  }
  return out;
}

// ---------- config ----------

export type SchoolConfig = {
  name: string | null;
  timezone: string | null;
  studentPosting: boolean;
  lostReports: boolean;
  crossSchoolSearch: boolean;
  retentionDays: number | null;
  neverArrivedSchoolDays: number | null;
  lateArrivalGraceDays: number | null;
  enabledCategories: string[];
  retentionFloor: number | null;
  retentionCeiling: number | null;
  calendarHorizonDays: number | null;
  calendarLastDay: string | null;
  globalStudentPosting: boolean | null;
  globalLostReports: boolean | null;
  globalCrossSchoolSearch: boolean | null;
};

export function configOf(v: unknown): SchoolConfig {
  const root = obj(v) ?? {};
  const o = obj(root.config) ?? obj(root.school) ?? root;
  const flags = obj(o.flags) ?? obj(root.flags) ?? {};
  const district = obj(root.district) ?? obj(o.district) ?? {};
  const cal = obj(root.calendar) ?? obj(o.calendar) ?? {};
  const cats = pick(o, 'enabledCategories') ?? root.enabledCategories;
  return {
    name: str(o.name),
    timezone: str(o.timezone),
    studentPosting: bool(pick(flags, 'studentPosting', 'studentPostingEnabled')) ?? bool(o.studentPostingEnabled) ?? false,
    lostReports: bool(pick(flags, 'lostReports', 'lostReportsEnabled')) ?? bool(o.lostReportsEnabled) ?? false,
    crossSchoolSearch: bool(pick(flags, 'crossSchoolSearch', 'crossSchoolSearchEnabled')) ?? bool(o.crossSchoolSearchEnabled) ?? false,
    retentionDays: num(o.retentionDays),
    neverArrivedSchoolDays: num(o.neverArrivedSchoolDays),
    lateArrivalGraceDays: num(o.lateArrivalGraceDays),
    enabledCategories: Array.isArray(cats) ? cats.filter((c): c is string => typeof c === 'string') : [],
    retentionFloor: num(pick(district, 'retentionDaysFloor', 'floor')) ?? num(root.retentionDaysFloor),
    retentionCeiling: num(pick(district, 'retentionDaysCeiling', 'ceiling')) ?? num(root.retentionDaysCeiling),
    calendarHorizonDays: num(pick(cal, 'horizonDays', 'coverageDays')) ?? num(root.calendarHorizonDays),
    calendarLastDay: str(pick(cal, 'lastDay', 'coveredThrough')) ?? str(root.calendarLastDay),
    globalStudentPosting: bool(pick(district, 'studentPostingGlobalEnabled', 'studentPosting')),
    globalLostReports: bool(pick(district, 'lostReportsGlobalEnabled', 'lostReports')),
    globalCrossSchoolSearch: bool(pick(district, 'crossSchoolSearchGlobalEnabled', 'crossSchoolSearch')),
  };
}

// ---------- lost reports (contract 6.2) ----------

export type LostReportRow = {
  id: string;
  category: string | null;
  description: string | null;
  pin: { x: number; y: number } | null;
  mapVersionId: string | null;
  createdAt: string | null;
  matchCount: number;
  status: string;
  rowVersion: number | null;
};

export function lostReportsOf(v: unknown): LostReportRow[] {
  const out: LostReportRow[] = [];
  for (const raw of list(v, 'reports')) {
    const o = obj(raw);
    const id = o ? str(o.id) : null;
    if (!o || !id) continue;
    out.push({
      id,
      category: str(o.category),
      description: str(o.description),
      pin: point(o.pin),
      mapVersionId: str(o.mapVersionId),
      createdAt: str(o.createdAt),
      matchCount: num(o.matchCount) ?? 0,
      status: str(o.status) ?? 'open',
      rowVersion: num(o.rowVersion),
    });
  }
  return out;
}

// ---------- district ----------

export type DistrictSettings = {
  retentionDaysFloor: number | null;
  retentionDaysCeiling: number | null;
  staffEmailDomains: string[];
  studentPostingGlobalEnabled: boolean | null;
  lostReportsGlobalEnabled: boolean | null;
  crossSchoolSearchGlobalEnabled: boolean | null;
  screeningEnabled: boolean | null;
  screeningDailyCeiling: number | null;
  workerMode: 'normal' | 'quarantine' | null;
  lostReportTtlDays: number | null;
  rejectedMediaRetentionDays: number | null;
};

export function districtSettingsOf(v: unknown): DistrictSettings {
  const root = obj(v) ?? {};
  const o = obj(root.settings) ?? root;
  const domains = pick(o, 'staffEmailDomains', 'domains');
  const mode = o.workerMode;
  return {
    retentionDaysFloor: num(o.retentionDaysFloor),
    retentionDaysCeiling: num(o.retentionDaysCeiling),
    staffEmailDomains: Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : [],
    studentPostingGlobalEnabled: bool(o.studentPostingGlobalEnabled),
    lostReportsGlobalEnabled: bool(o.lostReportsGlobalEnabled),
    crossSchoolSearchGlobalEnabled: bool(o.crossSchoolSearchGlobalEnabled),
    screeningEnabled: bool(o.screeningEnabled),
    screeningDailyCeiling: num(o.screeningDailyCeiling),
    workerMode: mode === 'normal' || mode === 'quarantine' ? mode : null,
    lostReportTtlDays: num(o.lostReportTtlDays),
    rejectedMediaRetentionDays: num(o.rejectedMediaRetentionDays),
  };
}

export type AlertRow = { id: string; name: string; severity: string | null; schoolCode: string | null; createdAt: string | null; detail: string | null };

export function alertsOf(v: unknown): AlertRow[] {
  const out: AlertRow[] = [];
  let i = 0;
  for (const raw of list(v, 'alerts', 'items')) {
    const o = obj(raw);
    i += 1;
    if (!o) continue;
    const name = (str(pick(o, 'name', 'alert', 'action', 'kind')) ?? 'alert').replace(/^alert\./, '');
    const meta = obj(pick(o, 'metadata', 'detail'));
    const detail = meta
      ? Object.entries(meta)
          .filter(([, x]) => typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && x.length <= 40))
          .map(([k, x]) => `${k}: ${String(x)}`)
          .join(', ')
      : str(o.detail);
    out.push({
      id: str(o.id) ?? String(num(o.id) ?? i),
      name,
      severity: str(pick(o, 'severity', 'level')),
      schoolCode: str(o.schoolCode),
      createdAt: str(pick(o, 'createdAt', 'at')),
      detail: detail || null,
    });
  }
  return out;
}

export type OnboardingStep = { step: string; label: string | null; done: boolean; doneAt: string | null; detail: string | null };

export function onboardingOf(v: unknown): OnboardingStep[] {
  const out: OnboardingStep[] = [];
  for (const raw of list(v, 'steps', 'checklist')) {
    const o = obj(raw);
    const step = o ? str(pick(o, 'step', 'key', 'name')) : null;
    if (!o || !step) continue;
    const status = str(o.status);
    out.push({
      step,
      label: str(o.label),
      done: bool(pick(o, 'done', 'complete', 'ok')) ?? (status === 'done' || status === 'complete'),
      doneAt: str(o.doneAt),
      detail: str(pick(o, 'detail', 'note')),
    });
  }
  return out;
}

export type AuditRow = { id: string; action: string; createdAt: string | null; actorKind: string | null; targetTable: string | null; targetId: string | null };

export function auditOf(v: unknown): AuditRow[] {
  const out: AuditRow[] = [];
  let i = 0;
  for (const raw of list(v, 'entries', 'audit', 'items', 'rows')) {
    const o = obj(raw);
    i += 1;
    if (!o) continue;
    out.push({
      id: str(o.id) ?? String(num(o.id) ?? i),
      action: str(o.action) ?? '',
      createdAt: str(o.createdAt),
      actorKind: str(o.actorKind),
      targetTable: str(o.targetTable),
      targetId: str(o.targetId),
    });
  }
  return out;
}
