#!/usr/bin/env node
// Runbooks 10 and 23: operating-calendar horizon report and extension (F-88, G-01, §24 step 1).
// Horizon = consecutive days, starting tomorrow in the school's timezone, that have a calendar row.
// private.calendar_next_close looks only at days strictly after the local date, and a missing row
// reads as "not open", so a gap silently stretches arrival deadlines: the first gap ends the horizon.
// Coverage must stay above 45 days (runbook 23); onboarding requires 90 (§24).
import { readFileSync } from 'node:fs';
import { UsageError, dryRunNote, formatTable, isMain, positiveInt, printPlan, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/calendar-horizon.mjs [--school CODE] [--min-days N]     report (exit 1 if any school is under N, default 45)
  node scripts/calendar-horizon.mjs --school CODE --extend <file.csv> [--allow-changes] [--yes]
The CSV has the header day,is_open,open_at,close_at, e.g. 2026-10-05,true,07:30,16:30 or 2026-10-12,false,,
Rows before today are skipped. Changing a day that already exists needs --allow-changes.
Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

const WARN_DAYS = 45;
const ONBOARDING_DAYS = 90;
const MAX_AHEAD_DAYS = 800;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const TRUE = new Set(['true', 't', 'yes', 'y', '1', 'open']);
const FALSE = new Set(['false', 'f', 'no', 'n', '0', 'closed']);

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && addDays(s, 0) === s;
}

export function horizon(today, days) {
  let n = 0;
  while (n < 5000 && days.has(addDays(today, n + 1))) n += 1;
  return { days: n, coveredThrough: n ? addDays(today, n) : null };
}

const hms = (m) => `${m[1]}:${m[2]}:${m[3] ?? '00'}`;

// Returns {rows: [{day, is_open, open_at, close_at, line}], errors: [text]}; times as HH:MM:SS.
export function parseCalendarCsv(text) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  let header = null;
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || header === false) return;
    const cells = trimmed.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
    if (header === null) {
      const names = cells.map((c) => c.toLowerCase());
      const want = ['day', 'is_open', 'open_at', 'close_at'];
      if (names.length !== 4 || want.some((w) => !names.includes(w))) {
        errors.push(`line ${line}: the header must be day,is_open,open_at,close_at`);
        header = false;
      } else {
        header = Object.fromEntries(names.map((n, j) => [n, j]));
      }
      return;
    }
    if (cells.length !== 4) return void errors.push(`line ${line}: expected 4 columns, found ${cells.length}`);
    const day = cells[header.day];
    const open = cells[header.is_open].toLowerCase();
    const at = TIME_RE.exec(cells[header.open_at]);
    const close = TIME_RE.exec(cells[header.close_at]);
    if (!validDate(day)) return void errors.push(`line ${line}: day must be a real date as YYYY-MM-DD`);
    if (seen.has(day)) return void errors.push(`line ${line}: ${day} appears twice`);
    seen.add(day);
    if (TRUE.has(open)) {
      if (!at || !close) return void errors.push(`line ${line}: an open day needs open_at and close_at as HH:MM`);
      if (hms(at) >= hms(close)) return void errors.push(`line ${line}: open_at must be before close_at`);
      rows.push({ day, is_open: true, open_at: hms(at), close_at: hms(close), line });
    } else if (FALSE.has(open)) {
      if (cells[header.open_at] || cells[header.close_at]) return void errors.push(`line ${line}: a closed day has no hours`);
      rows.push({ day, is_open: false, open_at: null, close_at: null, line });
    } else {
      errors.push(`line ${line}: is_open must be true or false`);
    }
  });
  if (header === null) errors.push('the file has no header row');
  if (rows.length > 1000) errors.push(`too many rows (${rows.length}); split the file (1000 at most)`);
  return { rows, errors };
}

async function schools(sql, code) {
  return sql`
    select id, code, name, timezone, active, to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as today
      from public.schools
     where (${code}::text is null and active) or code = ${code}::text
     order by code`;
}

async function futureDays(sql, school) {
  return sql`
    select to_char(day, 'YYYY-MM-DD') as day, is_open, to_char(open_at, 'HH24:MI:SS') as open_at,
           to_char(close_at, 'HH24:MI:SS') as close_at
      from public.school_calendar_days
     where school_id = ${school.id} and day > ${school.today}::date and day <= ${school.today}::date + ${MAX_AHEAD_DAYS}::int
     order by day`;
}

async function report(sql, say, code, minDays) {
  const list = await schools(sql, code);
  if (!list.length) throw new UsageError(code ? `no school with code ${code}` : 'no active schools');
  const rows = [];
  for (const s of list) {
    const days = await futureDays(sql, s);
    const h = horizon(s.today, new Set(days.map((d) => d.day)));
    const covered = days.filter((d) => d.day <= (h.coveredThrough ?? ''));
    rows.push({
      school: s.code,
      today: s.today,
      horizon_days: h.days,
      covered_through: h.coveredThrough ?? '-',
      open_days: covered.filter((d) => d.is_open).length,
      last_row: days.at(-1)?.day ?? '-',
      status: h.days < minDays ? 'LOW' : h.days < ONBOARDING_DAYS ? `ok (under ${ONBOARDING_DAYS} for onboarding)` : 'ok',
    });
  }
  console.log(formatTable(rows, ['school', 'today', 'horizon_days', 'covered_through', 'open_days', 'last_row', 'status']));
  const low = rows.filter((r) => r.horizon_days < minDays);
  if (low.length) say(`${low.length} school(s) under ${minDays} days: extend with --school CODE --extend <file.csv>`);
  if (rows.some((r) => r.last_row !== '-' && r.last_row !== r.covered_through)) say('a gap ends coverage early for at least one school (last_row is beyond covered_through)');
  return low.length ? 1 : 0;
}

export async function run({ values, apply, sql, requestId, say }) {
  const code = values.school === undefined ? null : String(values.school).toUpperCase();
  if (code !== null && !/^[A-Z]{2,6}$/.test(code)) throw new UsageError('--school takes a school code such as FCHS');
  const minDays = positiveInt(values['min-days'], 'min-days', { min: 1, max: 730, fallback: WARN_DAYS });
  if (!values.extend) {
    if (values['allow-changes']) throw new UsageError('--allow-changes goes with --extend');
    return report(sql, say, code, minDays);
  }
  if (!code) throw new UsageError('--extend needs --school CODE');

  const { rows, errors } = parseCalendarCsv(readFileSync(values.extend, 'utf8'));
  if (errors.length) {
    errors.slice(0, 20).forEach((e) => say(`invalid: ${e}`));
    throw new Error(`${errors.length} problem(s) in ${values.extend}; nothing was changed`);
  }
  const [school] = await schools(sql, code);
  if (!school) throw new UsageError(`no school with code ${code}`);
  const limit = addDays(school.today, MAX_AHEAD_DAYS);
  const tooFar = rows.filter((r) => r.day > limit);
  if (tooFar.length) throw new Error(`${tooFar.length} row(s) are more than ${MAX_AHEAD_DAYS} days ahead (first: line ${tooFar[0].line})`);
  const past = rows.filter((r) => r.day < school.today);
  const wanted = rows.filter((r) => r.day >= school.today);

  const existing = new Map((await sql`
    select to_char(day, 'YYYY-MM-DD') as day, is_open, to_char(open_at, 'HH24:MI:SS') as open_at, to_char(close_at, 'HH24:MI:SS') as close_at
      from public.school_calendar_days where school_id = ${school.id} and day = any(${wanted.map((r) => r.day)}::date[])`).map((r) => [r.day, r]));
  const added = wanted.filter((r) => !existing.has(r.day));
  const changed = wanted.filter((r) => {
    const e = existing.get(r.day);
    return e && (e.is_open !== r.is_open || e.open_at !== r.open_at || e.close_at !== r.close_at);
  });
  if (changed.length && !values['allow-changes']) {
    throw new UsageError(`${changed.length} existing day(s) would change (${changed.slice(0, 5).map((r) => r.day).join(', ')}${changed.length > 5 ? ', ...' : ''}); re-run with --allow-changes if that is intended`);
  }
  const known = new Set((await futureDays(sql, school)).map((d) => d.day));
  const before = horizon(school.today, known);
  for (const r of wanted) if (r.day > school.today) known.add(r.day);
  const after = horizon(school.today, known);
  const upserts = [...added, ...changed];
  if (!upserts.length) {
    say(`${school.code}: every row is already in the calendar; horizon ${before.days} days`);
    return 0;
  }
  const span = (list) => (list.length ? ` (${list[0].day} .. ${list.at(-1).day})` : '');
  printPlan(say, [
    `insert ${added.length} new day(s) for ${school.code}${span(added)}`,
    `update ${changed.length} existing day(s)${changed.length ? `: ${changed.slice(0, 5).map((r) => r.day).join(', ')}${changed.length > 5 ? ', ...' : ''}` : ''}`,
    `skip ${past.length} day(s) before today (${school.today}) and ${wanted.length - upserts.length} unchanged day(s)`,
    `horizon ${before.days} -> ${after.days} days (covered through ${after.coveredThrough ?? '-'})`,
    `write audit_log runbook.calendar_extend (request_id ${requestId})`,
  ]);
  if (after.days < ONBOARDING_DAYS) say(`note: still under the ${ONBOARDING_DAYS}-day onboarding requirement`);
  if (changed.length) {
    const [{ n }] = await sql`
      select count(*)::int as n from public.items
       where school_id = ${school.id} and custody = 'with_finder' and review_status <> 'draft' and arrival_deadline_at is not null`;
    if (n) say(`note: ${n} open arrival deadline(s) were computed from the old calendar and are not recomputed here (late check-in covers them, G-01)`);
  }
  if (!apply) {
    dryRunNote(say);
    return 0;
  }
  const payload = upserts.map(({ day, is_open, open_at, close_at }) => ({ day, is_open, open_at, close_at }));
  await sql.begin(async (tx) => {
    await tx`
      insert into public.school_calendar_days (school_id, day, is_open, open_at, close_at, source)
      select ${school.id}::uuid, r.day, r.is_open, r.open_at, r.close_at, 'runbook'
        from jsonb_to_recordset(${tx.json(payload)}) as r(day date, is_open boolean, open_at time, close_at time)
      on conflict (school_id, day) do update
         set is_open = excluded.is_open, open_at = excluded.open_at, close_at = excluded.close_at, source = excluded.source`;
    await writeAudit(tx, {
      script: 'calendar-horizon',
      action: 'runbook.calendar_extend',
      requestId,
      schoolId: school.id,
      targetTable: 'school_calendar_days',
      targetId: school.id,
      metadata: {
        days_added: added.length,
        days_changed: changed.length,
        first_day: upserts.map((r) => r.day).sort()[0],
        last_day: upserts.map((r) => r.day).sort().at(-1),
        horizon_days_before: before.days,
        horizon_days_after: after.days,
      },
    });
  });
  say(`${school.code}: calendar extended; horizon ${after.days} days (request_id ${requestId})`);
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'calendar-horizon',
    usage: USAGE,
    options: { school: { type: 'string' }, extend: { type: 'string' }, 'allow-changes': { type: 'boolean' }, 'min-days': { type: 'string' } },
    run,
  });
}
