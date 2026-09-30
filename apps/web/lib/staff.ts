// Staff and district server plumbing (§14.2; BUILD-CONTRACT.md sections 5, 6.2, 6.3, 9.2):
// assertion-minting calls, per-request session resolution, page guards, the route-handler wrapper,
// the mutation guard, and the worker media stream. Authorization is enforced in SQL; everything
// here only shapes requests and UX. Nothing here logs sessions, subjects, emails, or bodies.
import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import { notFound, redirect, unstable_rethrow } from 'next/navigation';
import type { NextRequest } from 'next/server';
import type { Category, Meta, StaffRole } from '@recover/shared/dto.ts';
import { PublicError, errorBody, errorResponse, toPublicError, type PublicErrorCode } from '@recover/shared/errors.ts';
import { errorSignature, log } from '@recover/shared/log.ts';
import { membershipsOf, schoolsOf, type SchoolRef } from '../components/staff/shapes.ts';
import { api } from './db.ts';
import { optionalEnv, requireEnv, storagePublicUrl } from './env.ts';
import {
  SCHOOL_CODE_RE,
  STEP_UP_MAX_AGE_S,
  atLeast,
  isFresh,
  prepareCall,
  specFor,
  type Args,
  type Scope,
  type StaffFn,
} from './ops.ts';
import { currentSession, nowS, type StaffAuth } from './session.ts';
import { workerFetch } from './worker.ts';

// ---------- assertion-minting calls ----------

export type StaffCallInput = {
  operation: string;
  scope: Scope;
  schoolId?: string | null;
  targetId?: string | null;
  rowVersion?: number | null;
  fn: StaffFn;
  args: Args; // business args with the p_ prefix; the assertion body is these args without it
  idempotencyKey?: string | null;
};

function assertionKeyVersion(): number {
  const v = Number.parseInt(requireEnv('STAFF_ASSERTION_KEY_VERSION'), 10);
  if (!Number.isSafeInteger(v) || v < 1) throw new Error('STAFF_ASSERTION_KEY_VERSION must be a positive integer');
  return v;
}

async function callAs<T>(sub: string, i: StaffCallInput): Promise<T> {
  const { params } = prepareCall({
    sub,
    operation: i.operation,
    scope: i.scope,
    schoolId: i.schoolId ?? null,
    targetId: i.targetId ?? null,
    rowVersion: i.rowVersion ?? null,
    args: i.args,
    idempotencyKey: i.idempotencyKey ?? null,
    keyB64url: requireEnv('STAFF_ASSERTION_KEY_CURRENT'),
    keyVersion: assertionKeyVersion(),
  });
  return api<T>(i.fn, params);
}

// Loads the session (or throws unauthorized), mints the assertion over exactly `args`, and calls fn.
export async function staffCall<T>(i: StaffCallInput): Promise<T> {
  const s = await currentSession();
  if (!s) throw new PublicError('unauthorized');
  return callAs<T>(s.sub, i);
}

export type SchoolScope = { sub: string; schoolId: string; code: string };

// Catalog-driven call for a school-scoped function: operation, target, and row_version come from
// the FNS table in ops.ts so a route cannot drift from the assertion the SQL side recomputes.
export function schoolCall<T>(ctx: SchoolScope, fn: StaffFn, args: Args, opts: { idempotencyKey?: string | null } = {}): Promise<T> {
  const spec = specFor(fn, args);
  return callAs<T>(ctx.sub, {
    fn,
    args,
    operation: spec.operation,
    scope: spec.scope,
    schoolId: spec.scope === 'school' ? ctx.schoolId : null,
    targetId: spec.targetId,
    rowVersion: spec.rowVersion,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
}

export function districtCall<T>(ctx: { sub: string }, fn: StaffFn, args: Args = {}): Promise<T> {
  const spec = specFor(fn, args);
  if (spec.scope !== 'district') throw new Error(`${fn} is not a district-scope function`);
  return callAs<T>(ctx.sub, { fn, args, operation: spec.operation, scope: 'district', targetId: spec.targetId, rowVersion: spec.rowVersion });
}

// ---------- per-request session resolution (§14.1: memberships are loaded per request) ----------

export type ResolvedStaff = StaffAuth & {
  user: { id: string; email: string; displayName: string | null };
  memberships: ReturnType<typeof membershipsOf>;
};

const SIGNED_OUT_CODES: readonly PublicErrorCode[] = ['unauthorized', 'assertion_invalid', 'forbidden', 'not_found'];

export const resolveStaff = cache(async (): Promise<ResolvedStaff | null> => {
  const s = await currentSession();
  if (!s) return null;
  let r: unknown;
  try {
    r = await callAs<unknown>(s.sub, {
      fn: 'api_staff_resolve_session',
      operation: 'session.resolve',
      scope: 'district',
      args: { p_google_sub: s.sub },
    });
  } catch (e) {
    if (SIGNED_OUT_CODES.includes(toPublicError(e).code)) return null;
    throw e;
  }
  const o = r && typeof r === 'object' ? (r as { user?: unknown; memberships?: unknown }) : null;
  const u = o?.user && typeof o.user === 'object' ? (o.user as Record<string, unknown>) : null;
  if (!u || typeof u.id !== 'string') return null;
  return {
    ...s,
    user: {
      id: u.id,
      email: typeof u.email === 'string' ? u.email : '',
      displayName: typeof u.displayName === 'string' ? u.displayName : null,
    },
    memberships: membershipsOf(o),
  };
});

function activeMemberships(r: ResolvedStaff) {
  return r.memberships.filter((m) => m.status !== 'deactivated');
}

export function isDistrictAdmin(r: ResolvedStaff): boolean {
  return activeMemberships(r).some((m) => m.role === 'district_admin');
}

export function schoolMemberships(r: ResolvedStaff) {
  return activeMemberships(r).filter((m) => m.schoolId && m.schoolCode);
}

export const districtSchools = cache(async (sub: string): Promise<SchoolRef[]> => {
  return schoolsOf(await districtCall<unknown>({ sub }, 'api_district_schools_list'));
});

// School codes never change owner, so the code -> id mapping (used only to build the assertion
// scope; SQL re-derives and checks it, G-39) is safe to remember per instance.
const schoolIds = new Map<string, string>();

function rememberSchool(code: string, id: string): void {
  if (schoolIds.size > 1000) schoolIds.clear();
  schoolIds.set(code, id.toLowerCase());
}

export type StaffContext = ResolvedStaff & {
  school: { id: string; code: string; name: string };
  role: StaffRole; // effective role at this school (district_admin covers every school)
  isDistrict: boolean;
};

async function contextFor(r: ResolvedStaff, code: string): Promise<StaffContext | null> {
  const ms = activeMemberships(r);
  const isDistrict = ms.some((m) => m.role === 'district_admin');
  const m = ms.find((x) => x.schoolCode === code && x.schoolId);
  if (m?.schoolId) {
    rememberSchool(code, m.schoolId);
    return {
      ...r,
      school: { id: m.schoolId.toLowerCase(), code, name: m.schoolName ?? code },
      role: isDistrict ? 'district_admin' : m.role,
      isDistrict,
    };
  }
  if (!isDistrict) return null;
  const s = (await districtSchools(r.sub)).find((x) => x.code === code);
  if (!s) return null;
  rememberSchool(code, s.id);
  return { ...r, school: { id: s.id, code, name: s.name }, role: 'district_admin', isDistrict };
}

export function scopeOf(ctx: StaffContext): SchoolScope {
  return { sub: ctx.sub, schoolId: ctx.school.id, code: ctx.school.code };
}

// Non-redirecting lookup for layouts; pages use requireStaff.
export const getStaffContext = cache(async (code: string): Promise<StaffContext | null> => {
  if (!SCHOOL_CODE_RE.test(code)) return null;
  const r = await resolveStaff();
  return r ? contextFor(r, code) : null;
});

export function signinPath(returnTo: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ callbackUrl: returnTo, ...extra });
  return `/staff/signin?${q.toString()}`;
}

// Page guard: redirects to sign-in without a live session, and to the 403 page without a
// membership at this school (or below the page's minimum role).
export async function requireStaff(code: string, opts: { min?: StaffRole; path?: string } = {}): Promise<StaffContext> {
  if (!SCHOOL_CODE_RE.test(code)) notFound();
  const r = await resolveStaff();
  if (!r) redirect(signinPath(opts.path ?? `/staff/${code}/queue`));
  const ctx = await getStaffContext(code);
  if (!ctx) redirect(`/staff/forbidden?school=${encodeURIComponent(code)}`);
  if (opts.min && !atLeast(ctx.role, opts.min)) {
    redirect(`/staff/forbidden?school=${encodeURIComponent(code)}&need=${encodeURIComponent(opts.min)}`);
  }
  return ctx;
}

export async function requireDistrict(path = '/district'): Promise<ResolvedStaff> {
  const r = await resolveStaff();
  if (!r) redirect(signinPath(path));
  if (!isDistrictAdmin(r)) redirect('/staff/forbidden?district=1');
  return r;
}

// ---------- step-up (G-31) ----------

export class StepUpRequired extends PublicError {
  constructor() {
    super('unauthorized');
    this.name = 'StepUpRequired';
    this.message = 'For your security, please sign in again to continue.';
  }
}

// Destructive actions need a session authenticated within maxAgeS; otherwise the UI sends the user
// through a fresh sign-in (the response carries reauth: true).
export async function requireFresh(maxAgeS = STEP_UP_MAX_AGE_S): Promise<StaffAuth> {
  const s = await currentSession();
  if (!s) throw new PublicError('unauthorized');
  if (!isFresh(s.authTime, nowS(), maxAgeS)) throw new StepUpRequired();
  return s;
}

// ---------- route handlers ----------

export type ApiSchool = StaffAuth & SchoolScope;

// School context for an API route. Membership is enforced by SQL on the call itself; this only
// finds the school id for the assertion scope (resolving the session once per school code).
export async function apiSchool(code: string): Promise<ApiSchool> {
  if (!SCHOOL_CODE_RE.test(code)) throw new PublicError('not_found');
  const s = await currentSession();
  if (!s) throw new PublicError('unauthorized');
  const known = schoolIds.get(code);
  if (known) return { ...s, schoolId: known, code };
  const r = await resolveStaff();
  if (!r) throw new PublicError('unauthorized');
  const ctx = await contextFor(r, code);
  if (!ctx) throw new PublicError('forbidden');
  return { ...s, schoolId: ctx.school.id, code };
}

export async function apiDistrict(): Promise<StaffAuth> {
  const s = await currentSession();
  if (!s) throw new PublicError('unauthorized');
  return s;
}

// Scrubbed error class and SQLSTATE only (shared log.ts denylist); never the message, which may
// quote arguments. The signature also feeds error_rollup (G-29).
export function logUnexpected(where: string, e: unknown): void {
  log('error', 'staff_error', { route: where, err: e });
  api('api_record_error', { p_signature: errorSignature(where, e) }).catch(() => {});
}

function jsonResponse(data: unknown, status: number, rid: string): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': rid },
  });
}

export function ok(data: unknown, rid: string, status = 200): Response {
  return jsonResponse(data, status, rid);
}

export function failure(e: unknown, rid: string, where: string): Response {
  if (e instanceof StepUpRequired) return jsonResponse({ ...errorBody(e, rid), reauth: true }, 401, rid);
  const pe = toPublicError(e);
  if (pe.code === 'internal') logUnexpected(where, e);
  return errorResponse(pe, rid);
}

type Params = Record<string, string | string[] | undefined>;

// Wraps a route handler: request id, awaited params (Next 16), and public-error mapping.
export function handler<P extends Params>(where: string, fn: (req: NextRequest, params: P, rid: string) => Promise<Response>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    const rid = randomUUID();
    try {
      return await fn(req, await ctx.params, rid);
    } catch (e) {
      return failure(e, rid, where);
    }
  };
}

function expectedOrigin(req: NextRequest): string {
  const configured = optionalEnv('WEB_ORIGIN');
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request origin
    }
  }
  return req.nextUrl.origin;
}

// Mutations: same origin, same-origin fetch metadata, and the non-simple X-Recover-Request header.
export function assertMutation(req: NextRequest): void {
  if (req.headers.get('x-recover-request') !== '1') throw new PublicError('forbidden');
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') throw new PublicError('forbidden');
  const origin = req.headers.get('origin');
  if (!origin || origin !== expectedOrigin(req)) throw new PublicError('forbidden');
}

export async function readJson(req: NextRequest, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new PublicError('invalid_input', 'body');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new PublicError('invalid_input', 'body');
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new PublicError('invalid_input', 'body');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new PublicError('invalid_input', 'body');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PublicError('invalid_input', 'body');
  return v as Record<string, unknown>;
}

// Guard plus body for a mutation route.
export async function mutation(req: NextRequest, maxBytes?: number): Promise<Record<string, unknown>> {
  assertMutation(req);
  return readJson(req, maxBytes);
}

export function idempotencyKeyOf(req: NextRequest): string | null {
  const k = req.headers.get('idempotency-key');
  if (k === null) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(k)) throw new PublicError('invalid_input', 'idempotencyKey');
  return k;
}

// Streams a worker media response (private image) to the browser with no caching (§8.2).
export async function streamWorkerImage(path: string, rid: string): Promise<Response> {
  const res = await workerFetch(path, { method: 'GET' });
  if (res.status === 404) throw new PublicError('not_found');
  if (!res.ok || !res.body) throw new PublicError('upstream_unavailable');
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const headers: Record<string, string> = {
    'content-type': /^image\/(jpeg|png|webp)$/.test(type) ? type : 'image/jpeg',
    'cache-control': 'private, no-store',
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    'x-request-id': rid,
  };
  const len = res.headers.get('content-length');
  if (len && /^\d+$/.test(len)) headers['content-length'] = len;
  return new Response(res.body, { status: 200, headers });
}

// ---------- page data ----------

export type Loaded<T> = { ok: true; data: T } | { ok: false; code: PublicErrorCode; message: string };

// Page loader: public errors become a friendly notice instead of a crashed page.
export async function load<T>(where: string, fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    const pe = toPublicError(e);
    if (pe.code === 'internal') logUnexpected(where, e);
    return { ok: false, code: pe.code, message: pe.message };
  }
}

export type StaffMeta = {
  timezone: string | null;
  map: { versionId: string; url: string | null; width: number; height: number } | null;
  zones: { id: string; name: string; cx: number; cy: number; radius: number }[];
  locations: { id: string; code: string; name: string; hours: string | null; pin: { x: number; y: number } | null }[];
  enabledCategories: Category[];
};

// Public school meta (the active approved map, zones, active locations). Staff pages use it for
// pins and pickers; it is the same data students see, so it carries no private fields.
export const schoolMeta = cache(async (code: string): Promise<StaffMeta | null> => {
  let m: Meta;
  try {
    m = await api<Meta>('api_get_meta', { p_school_code: code });
  } catch {
    return null;
  }
  if (!m || !m.school) return null;
  let map: StaffMeta['map'] = null;
  if (m.map) {
    let url: string | null = null;
    try {
      url = storagePublicUrl('maps', m.map.path);
    } catch {
      url = null;
    }
    map = { versionId: m.map.versionId, url, width: m.map.width, height: m.map.height };
  }
  return {
    timezone: m.school.timezone ?? null,
    map,
    zones: Array.isArray(m.zones) ? m.zones : [],
    locations: Array.isArray(m.locations) ? m.locations : [],
    enabledCategories: Array.isArray(m.school.enabledCategories) ? m.school.enabledCategories : [],
  };
});

// Postgres undefined_function: lets a page fall back while a proposed function is not deployed.
export function isUndefinedFunction(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === '42883';
}

export function newRequestId(): string {
  return randomUUID();
}
