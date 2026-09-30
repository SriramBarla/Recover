#!/usr/bin/env node
// Runbooks 13 and 20: inspect, replay and dispose outbox jobs (§7.6, Appendix E.3).
// Replays insert a NEW queued copy with a fresh dedupe key (<old key>:replay:<utc stamp>), so the
// active-dedupe index never blocks them; every job is idempotent, so a replay is safe. The old dead
// row gets disposed_at, which starts its 90-day retention clock.
import { PERIODIC_KINDS, QUARANTINE_KINDS, UsageError, dryRunNote, enqueuePeriodic, formatTable, isMain, pickAction, positiveInt, printPlan, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/jobs.mjs [--summary]                      counts per kind, oldest queued age, worker mode, heartbeat
  node scripts/jobs.mjs --dead [--kind K] [--all] [--limit N]   dead jobs (undisposed unless --all)
  node scripts/jobs.mjs --running [--limit N]            leases held right now
  node scripts/jobs.mjs --replay <id> [--yes]            queue a fresh copy of a dead job, dispose the old one
  node scripts/jobs.mjs --dispose <id> [--yes]           mark a dead job handled
  node scripts/jobs.mjs --enqueue <kind> [--yes]         enqueue one maintenance job (${PERIODIC_KINDS.join(', ')})
Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

const REPLAY_SUFFIX_RE = /(:replay:\d{8}T\d{6}Z)+$/;

// <old dedupe key or kind:job-<id>> + ':replay:<yyyymmddThhmmssZ>', within the 200-character column.
export function replayDedupeKey(job, now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  const suffix = `:replay:${stamp}`;
  const base = (job.dedupe_key ?? `${job.kind}:job-${job.id}`).replace(REPLAY_SUFFIX_RE, '');
  return base.slice(0, 200 - suffix.length) + suffix;
}

export function jobId(value, flag) {
  if (!/^[0-9]{1,18}$/.test(String(value))) throw new UsageError(`--${flag} takes a numeric job id`);
  return String(value);
}

async function context(sql) {
  const [row] = await sql`
    select (select worker_mode from public.district_settings where id = 1) as worker_mode,
           (select floor(extract(epoch from now() - max(seen_at)))::int from public.worker_heartbeats) as heartbeat_age_s`;
  return row;
}

async function summary(sql, say) {
  const ctx = await context(sql);
  say(`worker_mode=${ctx.worker_mode ?? '(no district_settings row)'}; last worker heartbeat ${ctx.heartbeat_age_s === null ? 'never' : `${ctx.heartbeat_age_s} s ago`}`);
  const rows = await sql`
    select kind,
           count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status = 'running')::int as running,
           count(*) filter (where status = 'dead' and disposed_at is null)::int as dead,
           floor(extract(epoch from now() - min(run_after) filter (where status = 'queued' and run_after <= now())))::int as oldest_due_s
      from public.jobs
     where status in ('queued', 'running') or (status = 'dead' and disposed_at is null)
     group by kind order by kind`;
  console.log(rows.length ? formatTable(rows, ['kind', 'queued', 'running', 'dead', 'oldest_due_s']) : '  (no queued, running or undisposed dead jobs)');
  if (ctx.worker_mode === 'quarantine') say(`quarantine: only ${QUARANTINE_KINDS.join(' and ')} are leased; the rest waits for normal mode`);
  return 0;
}

async function dead(sql, say, values) {
  const kind = values.kind ?? null;
  if (kind !== null && !/^[a-z_]{3,40}$/.test(kind)) throw new UsageError('--kind takes a job kind such as screen_item');
  const all = values.all === true;
  const limit = positiveInt(values.limit, 'limit', { max: 1000, fallback: 50 });
  const rows = await sql`
    select j.id, j.kind, j.attempts || '/' || j.max_attempts as attempts, j.last_error_code as error,
           coalesce(j.finished_at, j.created_at) as at, s.code as school,
           case when j.disposed_at is null then '' else 'yes' end as disposed
      from public.jobs j left join public.schools s on s.id = j.school_id
     where j.status = 'dead' and (${kind}::text is null or j.kind = ${kind}::text) and (${all}::boolean or j.disposed_at is null)
     order by coalesce(j.finished_at, j.created_at) desc, j.id desc
     limit ${limit}`;
  say(`${rows.length} dead job(s)${kind ? ` of kind ${kind}` : ''}${all ? '' : ' not yet disposed'} (newest first, limit ${limit})`);
  if (!rows.length) return 0;
  console.log(formatTable(rows, ['id', 'kind', 'attempts', 'error', 'at', 'school', ...(all ? ['disposed'] : [])]));
  const groups = await sql`
    select kind, coalesce(last_error_code, '-') as error, count(*)::int as jobs,
           count(distinct payload)::int as payloads, max(coalesce(finished_at, created_at)) as latest
      from public.jobs
     where status = 'dead' and (${kind}::text is null or kind = ${kind}::text) and (${all}::boolean or disposed_at is null)
     group by 1, 2 order by 3 desc`;
  say('by kind and error code:');
  console.log(formatTable(groups, ['kind', 'error', 'jobs', 'payloads', 'latest']));
  say('many jobs of one kind with one transient code across many payloads: provider or network outage; replay after recovery');
  say('one payload failing with a permanent code: poison input; dispose it and fix the item, do not replay');
  return 0;
}

async function running(sql, say, values) {
  const limit = positiveInt(values.limit, 'limit', { max: 1000, fallback: 50 });
  const rows = await sql`
    select id, kind, attempts, locked_by, locked_at, locked_until,
           case when locked_until < now() then 'yes' else '' end as expired
      from public.jobs where status = 'running' order by locked_at limit ${limit}`;
  say(`${rows.length} running job(s); expired leases are requeued (or dead-lettered) by system_reap_leases on the next drain`);
  if (rows.length) console.log(formatTable(rows, ['id', 'kind', 'attempts', 'locked_by', 'locked_at', 'locked_until', 'expired']));
  return 0;
}

async function loadDead(sql, id) {
  const [job] = await sql`
    select id, kind, status, school_id, payload, payload_version, dedupe_key, priority, max_attempts, attempts,
           last_error_code, disposed_at
      from public.jobs where id = ${id}::bigint`;
  if (!job) throw new Error(`no job ${id}`);
  if (job.status !== 'dead') throw new Error(`job ${id} is ${job.status}; only dead jobs can be replayed or disposed`);
  return job;
}

export async function run({ values, apply, sql, requestId, say }) {
  const action = pickAction(values, ['summary', 'dead', 'running', 'replay', 'dispose', 'enqueue']) ?? 'summary';
  if (action !== 'dead' && (values.kind !== undefined || values.all !== undefined)) throw new UsageError('--kind and --all go with --dead');
  if (action === 'summary') return summary(sql, say);
  if (action === 'dead') return dead(sql, say, values);
  if (action === 'running') return running(sql, say, values);
  const audit = { script: 'jobs', requestId, targetTable: 'jobs' };
  const { worker_mode: mode } = await context(sql);

  if (action === 'enqueue') {
    const kind = values.enqueue;
    if (!PERIODIC_KINDS.includes(kind)) throw new UsageError(`--enqueue takes one of ${PERIODIC_KINDS.join(', ')}`);
    printPlan(say, [
      `enqueue ${kind} with payload {} and dedupe key ${kind}:<current UTC minute> (skipped if already queued this minute)`,
      `write audit_log runbook.jobs_enqueue (request_id ${requestId})`,
    ]);
    if (mode === 'quarantine' && !QUARANTINE_KINDS.includes(kind)) say(`note: worker_mode is quarantine; ${kind} waits until --reopen`);
    if (!apply) {
      dryRunNote(say);
      return 0;
    }
    const id = await sql.begin(async (tx) => {
      const newId = await enqueuePeriodic(tx, kind);
      if (newId !== null) await writeAudit(tx, { ...audit, action: 'runbook.jobs_enqueue', targetId: String(newId), metadata: { kind, job_id: newId } });
      return newId;
    });
    say(id === null ? `${kind} is already queued or running for this minute; nothing added` : `queued ${kind} as job ${id} (request_id ${requestId})`);
    return 0;
  }

  const id = jobId(values[action], action);
  const job = await loadDead(sql, id);
  if (action === 'dispose') {
    if (job.disposed_at) throw new Error(`job ${id} was already disposed at ${job.disposed_at.toISOString()}`);
    printPlan(say, [
      `set jobs.disposed_at = now() on dead job ${id} (${job.kind}, ${job.attempts} attempts, error ${job.last_error_code ?? '-'})`,
      `write audit_log runbook.jobs_dispose (request_id ${requestId})`,
    ]);
    if (!apply) {
      dryRunNote(say);
      return 0;
    }
    await sql.begin(async (tx) => {
      const r = await tx`update public.jobs set disposed_at = now() where id = ${id}::bigint and status = 'dead' and disposed_at is null returning id`;
      if (!r.length) throw new Error(`job ${id} changed meanwhile; nothing disposed`);
      await writeAudit(tx, { ...audit, action: 'runbook.jobs_dispose', schoolId: job.school_id, targetId: id, metadata: { job_id: Number(id), kind: job.kind, error_code: job.last_error_code } });
    });
    say(`job ${id} disposed (request_id ${requestId})`);
    return 0;
  }

  // --replay
  if (job.dedupe_key) {
    const [active] = await sql`select id, status from public.jobs where dedupe_key = ${job.dedupe_key} and status in ('queued', 'running')`;
    if (active) throw new Error(`job ${active.id} with the same dedupe key is already ${active.status}; no replay needed (dispose ${id} instead)`);
  }
  const key = replayDedupeKey(job);
  printPlan(say, [
    `insert a queued copy of dead job ${id}: kind ${job.kind}, same school and payload, attempts 0 of ${job.max_attempts}, dedupe key ${key}`,
    `set jobs.disposed_at on job ${id}${job.disposed_at ? ' (already set; kept)' : ''}`,
    `write audit_log runbook.jobs_replay (request_id ${requestId})`,
  ]);
  if (job.disposed_at) say(`note: job ${id} was already disposed at ${job.disposed_at.toISOString()}`);
  if (mode === 'quarantine' && !QUARANTINE_KINDS.includes(job.kind)) say(`note: worker_mode is quarantine; the copy waits until --reopen`);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }
  const newId = await sql.begin(async (tx) => {
    const [locked] = await tx`select status from public.jobs where id = ${id}::bigint for update`;
    if (locked?.status !== 'dead') throw new Error(`job ${id} changed meanwhile; nothing replayed`);
    const [row] = await tx`
      insert into public.jobs (school_id, kind, payload, payload_version, dedupe_key, priority, max_attempts, request_id)
      values (${job.school_id}, ${job.kind}, ${tx.json(job.payload)}, ${job.payload_version}, ${key}, ${job.priority},
              ${job.max_attempts}, ${requestId}::uuid)
      returning id`;
    await tx`update public.jobs set disposed_at = coalesce(disposed_at, now()) where id = ${id}::bigint`;
    await writeAudit(tx, {
      ...audit,
      action: 'runbook.jobs_replay',
      schoolId: job.school_id,
      targetId: id,
      metadata: { job_id: Number(id), new_job_id: Number(row.id), kind: job.kind, attempts: job.attempts, error_code: job.last_error_code },
    });
    return row.id;
  });
  say(`replayed job ${id} as job ${newId} (request_id ${requestId})`);
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'jobs',
    usage: USAGE,
    options: {
      summary: { type: 'boolean' }, dead: { type: 'boolean' }, running: { type: 'boolean' }, replay: { type: 'string' },
      dispose: { type: 'string' }, enqueue: { type: 'string' }, kind: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' },
    },
    run,
  });
}
