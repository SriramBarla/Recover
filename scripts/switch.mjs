#!/usr/bin/env node
// Feature and worker switches for the runbooks (RUNBOOK.md 3, 4, 11, 12, 16, 22; §5.5; G-06).
// Effective availability is district global switch AND school switch; a global OFF always wins.
// A change to a student-visible flag also enqueues invalidate_cache for the affected schools in the
// same transaction, so the student UI reflects it without waiting for the cache TTL (§7.6).
import { UsageError, dryRunNote, isMain, printPlan, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/switch.mjs --district [posting=on|off] [lost_reports=on|off] [cross_school=on|off]
                                     [screening=on|off] [worker_mode=normal|quarantine] [--yes]
  node scripts/switch.mjs --school CODE [student_posting=on|off] [lost_reports=on|off] [cross_school=on|off] [--yes]
With no assignments the current state is printed. Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

const ON_OFF = ['on', 'off'];
export const DISTRICT_SWITCHES = {
  posting: { column: 'student_posting_global_enabled', values: ON_OFF, visible: true },
  lost_reports: { column: 'lost_reports_global_enabled', values: ON_OFF, visible: true },
  cross_school: { column: 'cross_school_search_global_enabled', values: ON_OFF, visible: true },
  screening: { column: 'screening_enabled', values: ON_OFF, visible: false },
  worker_mode: { column: 'worker_mode', values: ['normal', 'quarantine'], visible: false },
};
export const SCHOOL_SWITCHES = {
  student_posting: { column: 'student_posting_enabled', values: ON_OFF, visible: true },
  lost_reports: { column: 'lost_reports_enabled', values: ON_OFF, visible: true },
  cross_school: { column: 'cross_school_search_enabled', values: ON_OFF, visible: true },
};
// School flag -> the district global switch it is AND-ed with.
const GLOBAL_FOR = {
  student_posting_enabled: 'student_posting_global_enabled',
  lost_reports_enabled: 'lost_reports_global_enabled',
  cross_school_search_enabled: 'cross_school_search_global_enabled',
};

// "posting=off" -> {key, column, value}; booleans for on/off switches, the text for worker_mode.
export function parseAssignments(table, positionals) {
  const out = [];
  for (const raw of positionals) {
    const m = /^([a-z_]+)=([a-z]+)$/.exec(String(raw).toLowerCase());
    if (!m) throw new UsageError(`expected key=value, got "${raw}"`);
    const [, key, value] = m;
    const spec = Object.hasOwn(table, key) ? table[key] : null;
    if (!spec) throw new UsageError(`unknown switch "${key}" (valid: ${Object.keys(table).join(', ')})`);
    if (!spec.values.includes(value)) throw new UsageError(`${key} must be ${spec.values.join(' or ')}`);
    if (out.some((a) => a.key === key)) throw new UsageError(`${key} is given twice`);
    out.push({ key, column: spec.column, value: spec.values === ON_OFF ? value === 'on' : value, visible: spec.visible });
  }
  return out;
}

export const show = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));

async function readState(sql, code) {
  const [district] = await sql`
    select student_posting_global_enabled, lost_reports_global_enabled, cross_school_search_global_enabled,
           screening_enabled, worker_mode
      from public.district_settings where id = 1`;
  if (!district) throw new Error('district_settings has no row; load supabase/bootstrap.example.sql first');
  if (!code) return { district, school: null };
  const [school] = await sql`
    select id, code, name, active, student_posting_enabled, lost_reports_enabled, cross_school_search_enabled
      from public.schools where code = ${code}`;
  if (!school) throw new UsageError(`no school with code ${code}`);
  return { district, school };
}

function printState(say, { district, school }) {
  const d = Object.entries(DISTRICT_SWITCHES).map(([k, s]) => `${k}=${show(district[s.column])}`).join(' ');
  say(`district: ${d}`);
  if (school) {
    const s = Object.entries(SCHOOL_SWITCHES)
      .map(([k, spec]) => `${k}=${show(school[spec.column])} (effective ${show(school[spec.column] && district[GLOBAL_FOR[spec.column]])})`)
      .join(' ');
    say(`school ${school.code}${school.active ? '' : ' (inactive)'}: ${s}`);
  }
}

export async function run({ values, positionals, apply, sql, requestId, say }) {
  const isDistrict = values.district === true;
  const code = values.school === undefined ? null : String(values.school).toUpperCase();
  if (isDistrict === Boolean(code)) throw new UsageError('give exactly one of --district or --school CODE');
  if (code && !/^[A-Z]{2,6}$/.test(code)) throw new UsageError('--school takes a school code such as FCHS');
  const wanted = parseAssignments(isDistrict ? DISTRICT_SWITCHES : SCHOOL_SWITCHES, positionals);

  const state = await readState(sql, code);
  printState(say, state);
  if (!wanted.length) return 0;

  const current = isDistrict ? state.district : state.school;
  for (const w of wanted.filter((x) => current[x.column] === x.value)) say(`${w.key} is already ${show(w.value)}; unchanged`);
  const changes = wanted.filter((w) => current[w.column] !== w.value);
  if (!changes.length) {
    say('nothing to change');
    return 0;
  }
  const table = isDistrict ? 'district_settings' : `schools (${code})`;
  const visible = changes.some((c) => c.visible);
  const steps = changes.map((c) => `set ${table}.${c.column}: ${show(current[c.column])} -> ${show(c.value)}`);
  if (visible) {
    steps.push(isDistrict ? 'enqueue invalidate_cache for every active school (student-visible flag)' : `enqueue invalidate_cache for ${code}`);
  }
  steps.push(`write audit_log runbook.switch (actor runbook:switch, request_id ${requestId})`);
  printPlan(say, steps);
  for (const c of changes) {
    if (c.column === 'worker_mode' && c.value === 'quarantine') {
      say('note: in quarantine the worker leases only reconcile_generating and reconcile_orphan_uploads (G-06)');
    }
    if (!isDistrict && c.value === true && !state.district[GLOBAL_FOR[c.column]]) {
      say(`note: the district global switch for ${c.key} is off, so ${code} stays off until it is turned on (§5.5)`);
    }
  }
  if (!apply) {
    dryRunNote(say);
    return 0;
  }

  const invalidated = await sql.begin(async (tx) => {
    const set = Object.fromEntries(changes.map((c) => [c.column, c.value]));
    let schools = 0;
    if (isDistrict) {
      await tx`select 1 from public.district_settings where id = 1 for update`;
      await tx`update public.district_settings set ${tx(set)} where id = 1`;
      if (visible) schools = (await tx`select private.invalidate(s.id) from public.schools s where s.active`).length;
    } else {
      await tx`update public.schools set ${tx(set)} where id = ${state.school.id}`;
      if (visible) schools = (await tx`select private.invalidate(${state.school.id}::uuid)`).length;
    }
    await writeAudit(tx, {
      script: 'switch',
      action: 'runbook.switch',
      requestId,
      schoolId: isDistrict ? null : state.school.id,
      targetTable: isDistrict ? 'district_settings' : 'schools',
      targetId: isDistrict ? '1' : state.school.id,
      before: Object.fromEntries(changes.map((c) => [c.column, current[c.column]])),
      after: set,
      metadata: { scope: isDistrict ? 'district' : 'school', changed: changes.map((c) => c.key), invalidated_schools: schools },
    });
    return schools;
  });
  say(`applied (request_id ${requestId}; cache invalidation queued for ${invalidated} school(s))`);
  printState(say, await readState(sql, code));
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({ name: 'switch', usage: USAGE, options: { district: { type: 'boolean' }, school: { type: 'string' } }, run });
}
