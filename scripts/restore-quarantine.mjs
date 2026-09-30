#!/usr/bin/env node
// Runbooks 9 and 12: restore quarantine (§16.5 steps 2-8, G-06). Run --begin as the first action
// against a restored database, and --reopen only after the operator checkpoint.
//   --begin   1. disable every pg_cron job (cron.alter_job), so the restored schedule stops driving the
//                worker (G-06);
//             2. worker_mode = 'quarantine' (only reconcile_generating and reconcile_orphan_uploads lease)
//                and the three district global switches off;
//             3. recompute expiries by enqueueing expire_never_arrived, mark_disposition_due and
//                expire_reports (they run once --reopen returns the worker to normal);
//             4. exactly one audit row (runbook.restore_quarantine, phase begin) that also records the
//                audit gap: the last audit id in the restored database plus the restore timestamp;
//             5. roster-review checklist (with --directory <export>: members missing from the export).
//   --reopen  re-enable every cron job disabled by a --begin since the last reopen (matched by name or
//             id) and set worker_mode = 'normal'. Posting stays off until an operator turns it on
//             deliberately with switch.mjs.
import { readFileSync } from 'node:fs';
import { UsageError, dryRunNote, enqueuePeriodic, formatTable, isMain, pickAction, printPlan, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/restore-quarantine.mjs [--directory <export>]            show quarantine state and roster summary
  node scripts/restore-quarantine.mjs --begin [--restored-at <ISO time>] [--directory <export>] [--yes]
  node scripts/restore-quarantine.mjs --reopen [--yes]
--directory takes the district directory export (any text; every email address in it counts).
Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

export const GLOBAL_SWITCHES = ['student_posting_global_enabled', 'lost_reports_global_enabled', 'cross_school_search_global_enabled'];
export const EXPIRY_KINDS = ['expire_never_arrived', 'mark_disposition_due', 'expire_reports'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

// Every email address in a directory export (CSV, one per line, or anything else), lowercased.
export function parseDirectory(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/[^\s,;"'<>()]+@[^\s,;"'<>()]+/g)) out.add(m[0].toLowerCase());
  return out;
}

async function readState(sql) {
  const [district] = await sql`
    select worker_mode, student_posting_global_enabled, lost_reports_global_enabled,
           cross_school_search_global_enabled, screening_enabled
      from public.district_settings where id = 1`;
  if (!district) throw new Error('district_settings has no row');
  const [{ present }] = await sql`select to_regclass('cron.job') is not null as present`;
  const cron = present
    ? (await sql`select jobid, jobname, schedule, active from cron.job order by jobid`).map((j) => ({ ...j, jobid: Number(j.jobid) }))
    : null;
  const [last] = await sql`select id, created_at from public.audit_log order by id desc limit 1`;
  return { district, cron, lastAudit: last ? { id: Number(last.id), at: last.created_at } : null };
}

function printState(say, { district, cron }) {
  const sw = GLOBAL_SWITCHES.map((c) => `${c}=${district[c] ? 'on' : 'off'}`).join(' ');
  say(`worker_mode=${district.worker_mode} ${sw} screening_enabled=${district.screening_enabled ? 'on' : 'off'}`);
  if (!cron) say('pg_cron: not installed in this database');
  else if (!cron.length) say('pg_cron: no jobs visible to this role');
  else console.log(formatTable(cron.map((j) => ({ ...j, active: j.active ? 'yes' : 'no' })), ['jobid', 'jobname', 'schedule', 'active']));
}

async function rosterReview(sql, say, directoryFile) {
  const rows = await sql`
    select coalesce(s.code, 'DISTRICT') as school, m.role::text as role,
           count(*) filter (where m.status = 'active')::int as active,
           count(*) filter (where m.status = 'invited')::int as invited
      from public.staff_members m left join public.schools s on s.id = m.school_id
     where m.status <> 'deactivated'
     group by 1, 2 order by 1, 2`;
  say('roster review (§16.5 step 3): every membership below is live in the restored database');
  console.log(rows.length ? formatTable(rows, ['school', 'role', 'active', 'invited']) : '  (no live memberships)');
  if (directoryFile) {
    const directory = parseDirectory(readFileSync(directoryFile, 'utf8'));
    const live = await sql`
      select u.email, m.role::text as role, coalesce(s.code, 'DISTRICT') as school, m.status
        from public.staff_members m join public.staff_users u on u.id = m.user_id
        left join public.schools s on s.id = m.school_id
       where m.status <> 'deactivated' order by 3, 1`;
    const missing = live.filter((r) => !directory.has(r.email.toLowerCase()));
    say(`directory export: ${directory.size} addresses; ${missing.length} live membership(s) are not in it`);
    if (missing.length) console.log(formatTable(missing, ['school', 'role', 'status', 'email']));
  }
  say('checklist before --reopen:');
  [
    'every live member is still employed and in the role shown (directory export from district IT: --directory)',
    'deactivate everyone who left since the backup: /staff/<CODE>/roster, or /district for district admins (runbook 5)',
    'identity rebinds made after the backup are gone: repeat them from /district if a member cannot sign in',
    'device blocks added after the backup are gone: re-block repeat devices as they reappear (runbook 4)',
    'media: node scripts/reconcile-orphans.mjs (dry run); pull published items whose objects are missing (§16.5 step 6)',
    'RLS and privileges: DB_URL=<restored db> npm run test:sql (§16.5 step 7)',
    'pg_cron jobs are all still inactive (run this script without flags; a migration can reschedule them)',
    'two owners sign the checkpoint note, then: node scripts/restore-quarantine.mjs --reopen --yes (§16.5 step 8)',
  ].forEach((s) => console.log(`  [ ] ${s}`));
}

// The inactive jobs --begin disabled, matched by name (stable when a migration reschedules a job
// under a new id) or by id; every inactive job when no --begin record exists.
export function jobsToReopen(cron, recorded) {
  const inactive = (cron ?? []).filter((j) => !j.active);
  if (!recorded) return inactive.map((j) => j.jobid);
  const names = new Set(Array.isArray(recorded.names) ? recorded.names : []);
  const ids = new Set((Array.isArray(recorded.ids) ? recorded.ids : []).map(Number));
  return inactive.filter((j) => (j.jobname && names.has(j.jobname)) || ids.has(j.jobid)).map((j) => j.jobid);
}

const describeJobs = (cron, ids) =>
  ids.map((id) => (cron ?? []).find((j) => j.jobid === id)?.jobname ?? `job ${id}`).join(', ');

// Every --begin since the last --reopen, unioned (rows in id order). A second --begin finds nothing
// active and records nothing, so reading only the latest record would strand recover_drain.
export function recordedSinceReopen(rows) {
  let acc = null;
  for (const r of rows) {
    const m = r.metadata ?? {};
    if (m.phase === 'reopen') {
      acc = null;
    } else if (m.phase === 'begin') {
      acc ??= { ids: [], names: [], begins: 0 };
      acc.begins += 1;
      for (const id of Array.isArray(m.cron_job_ids) ? m.cron_job_ids : []) if (!acc.ids.includes(Number(id))) acc.ids.push(Number(id));
      for (const n of Array.isArray(m.cron_job_names) ? m.cron_job_names : []) if (!acc.names.includes(n)) acc.names.push(n);
    }
  }
  return acc;
}

// cron.alter_job is the supported API (job owner or superuser). The direct update is the fallback where
// only the table grant works; it must change exactly one row, otherwise the job was not switched (for
// example hidden by pg_cron's row security) and the error aborts the whole transaction.
export async function setCronActive(tx, jobid, active) {
  try {
    await tx.savepoint((sp) => sp`select cron.alter_job(${jobid}::bigint, active => ${active}::boolean)`);
    return 'alter_job';
  } catch (first) {
    let rows;
    try {
      rows = await tx`update cron.job set active = ${active}::boolean where jobid = ${jobid}::bigint returning jobid`;
    } catch (second) {
      throw new Error(`pg_cron job ${jobid}: cron.alter_job failed (${first.message}) and the fallback update failed (${second.message})`);
    }
    if (rows.length !== 1) {
      throw new Error(`pg_cron job ${jobid}: cron.alter_job failed (${first.message}) and the fallback update changed ${rows.length} rows, not 1`);
    }
    return 'update';
  }
}

export async function run({ values, apply, sql, requestId, say }) {
  const action = pickAction(values, ['begin', 'reopen']);
  if (values['restored-at'] !== undefined && (action !== 'begin' || !ISO_RE.test(values['restored-at']) || Number.isNaN(Date.parse(values['restored-at'])))) {
    throw new UsageError('--restored-at takes an ISO timestamp such as 2026-09-30T06:15:00Z, with --begin');
  }
  const state = await readState(sql);
  printState(say, state);
  const audit = { script: 'restore-quarantine', requestId, targetTable: 'district_settings', targetId: '1' };

  if (!action) {
    await rosterReview(sql, say, values.directory);
    return 0;
  }

  if (action === 'begin') {
    const activeJobs = (state.cron ?? []).filter((j) => j.active).map((j) => j.jobid);
    const switchesOn = GLOBAL_SWITCHES.filter((c) => state.district[c]);
    const last = state.lastAudit;
    const restoredAt = values['restored-at'] ?? null;
    if (state.district.worker_mode === 'quarantine') {
      say('note: already in quarantine; this writes another begin row, and --reopen restores every job disabled since the last reopen');
    }
    printPlan(say, [
      activeJobs.length ? `disable pg_cron jobs ${describeJobs(state.cron, activeJobs)} (cron.alter_job ... active => false)` : 'pg_cron: no active job to disable',
      `set district_settings.worker_mode = quarantine (now ${state.district.worker_mode})`,
      `set district global switches off: ${GLOBAL_SWITCHES.join(', ')}${switchesOn.length ? '' : ' (already off)'}`,
      `enqueue ${EXPIRY_KINDS.join(', ')} (they run after --reopen; quarantine leases only reconcile kinds)`,
      `write ONE audit_log row runbook.restore_quarantine (phase begin, request_id ${requestId}) recording the audit gap `
        + `(last audit id ${last ? `${last.id} at ${last.at.toISOString()}` : 'none'}, restored at ${restoredAt ?? 'now()'}), `
        + 'the cron jobs disabled and the switches turned off',
    ]);
    if (!apply) {
      dryRunNote(say);
      await rosterReview(sql, say, values.directory);
      return 0;
    }
    const enqueued = await sql.begin(async (tx) => {
      for (const id of activeJobs) await setCronActive(tx, id, false);
      await tx`
        update public.district_settings
           set worker_mode = 'quarantine', student_posting_global_enabled = false,
               lost_reports_global_enabled = false, cross_school_search_global_enabled = false
         where id = 1`;
      const [{ now }] = await tx`select coalesce(${restoredAt}::timestamptz, now()) as now`;
      const ids = [];
      for (const kind of EXPIRY_KINDS) ids.push(await enqueuePeriodic(tx, kind));
      await writeAudit(tx, {
        ...audit,
        action: 'runbook.restore_quarantine',
        before: { worker_mode: state.district.worker_mode },
        after: { worker_mode: 'quarantine' },
        metadata: {
          phase: 'begin',
          // the audit gap (§16.5 step 4): rows between this id and the restore are lost
          last_audit_id: last?.id ?? null,
          last_audit_at: last?.at.toISOString() ?? null,
          restored_at: now.toISOString(),
          cron_job_ids: activeJobs,
          cron_job_names: (state.cron ?? []).filter((j) => activeJobs.includes(j.jobid) && j.jobname).map((j) => j.jobname),
          switches_off: switchesOn,
          jobs_enqueued: ids.filter((x) => x !== null).length,
        },
      });
      return ids;
    });
    say(`quarantine started (request_id ${requestId}); expiry jobs queued: ${enqueued.map((id) => id ?? 'already queued').join(', ')}`);
    printState(say, await readState(sql));
    await rosterReview(sql, say, values.directory);
    return 0;
  }

  // --reopen
  if (state.district.worker_mode !== 'quarantine') throw new Error('worker_mode is not quarantine; nothing to reopen');
  const history = await sql`
    select id, metadata from public.audit_log
     where action = 'runbook.restore_quarantine'
       and id > coalesce((select max(a.id) from public.audit_log a
                           where a.action = 'runbook.restore_quarantine' and a.metadata->>'phase' = 'reopen'), 0)
     order by id`;
  const recorded = recordedSinceReopen(history);
  const toEnable = jobsToReopen(state.cron, recorded);
  if (recorded) say(`${recorded.begins} --begin record(s) since the last reopen; their disabled jobs are restored together`);
  else say('note: no --begin record since the last reopen; every inactive pg_cron job will be re-enabled');
  printPlan(say, [
    toEnable.length ? `re-enable pg_cron jobs ${describeJobs(state.cron, toEnable)} (cron.alter_job ... active => true)` : 'pg_cron: no job to re-enable',
    'set district_settings.worker_mode = normal (queued expiry and deletion work runs on the next drain)',
    'leave the district global switches as they are (posting stays off)',
    `write audit_log runbook.restore_quarantine phase reopen (request_id ${requestId})`,
  ]);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }
  await sql.begin(async (tx) => {
    for (const id of toEnable) await setCronActive(tx, id, true);
    await tx`update public.district_settings set worker_mode = 'normal' where id = 1`;
    await writeAudit(tx, {
      ...audit,
      action: 'runbook.restore_quarantine',
      before: { worker_mode: 'quarantine' },
      after: { worker_mode: 'normal' },
      metadata: {
        phase: 'reopen',
        cron_job_ids: toEnable,
        cron_job_names: (state.cron ?? []).filter((j) => toEnable.includes(j.jobid) && j.jobname).map((j) => j.jobname),
        begin_rows: recorded?.begins ?? 0,
      },
    });
  });
  say(`workers reopened (request_id ${requestId})`);
  printState(say, await readState(sql));
  say('posting, lost reports and cross-school search are still OFF. Once the expiry jobs have run');
  say('(node scripts/jobs.mjs --summary), turn them on deliberately:');
  console.log('  node scripts/switch.mjs --district posting=on lost_reports=on cross_school=on --yes');
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'restore-quarantine',
    usage: USAGE,
    options: { begin: { type: 'boolean' }, reopen: { type: 'boolean' }, 'restored-at': { type: 'string' }, directory: { type: 'string' } },
    run,
  });
}
