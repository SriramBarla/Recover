#!/usr/bin/env node
// Runbook 24: audit privacy review (F-74). Samples audit_log rows and proves that no payload retains
// free text, exact pins, device digests, emails or storage paths. Checked: every key in state_before,
// state_after and metadata (description, note, pin, email, digest, path, token, ...), and every string
// value there and in actor_id/target_id (an `@`, a <uuid>/<uuid>/ storage-path prefix, a 64-hex
// digest, three or more words of free text). Findings name the row, action, place and rule, never the
// value. Exit 1 on FAIL. With --yes the result itself is recorded as an audit row.
import { dryRunNote, formatTable, isMain, positiveInt, privacyViolations, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/audit-privacy-sample.mjs [--sample N] [--random] [--yes]
--sample N rows (default 500, newest first); --random samples across the whole table instead.
--yes records the result as audit_log runbook.audit_privacy_sample. Exit 1 when a violation is found.
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

// Pure: violations for one audit row, as [{id, action, at, rule}].
export function rowViolations(row) {
  const found = [];
  for (const column of ['state_before', 'state_after', 'metadata']) {
    for (const v of privacyViolations(row[column] ?? {}, column)) found.push(v);
  }
  for (const column of ['actor_id', 'target_id']) {
    if (typeof row[column] !== 'string') continue;
    for (const v of privacyViolations(row[column], column)) if (v.rule !== 'free_text') found.push(v);
  }
  return found.map((v) => ({ id: String(row.id), action: row.action, at: v.at, rule: v.rule }));
}

export async function run({ values, apply, sql, requestId, say }) {
  const n = positiveInt(values.sample, 'sample', { max: 100000, fallback: 500 });
  const random = values.random === true;
  const rows = random
    ? await sql`
        select id, action, actor_id, target_id, state_before, state_after, metadata, created_at
          from public.audit_log order by random() limit ${n}`
    : await sql`
        select id, action, actor_id, target_id, state_before, state_after, metadata, created_at
          from public.audit_log order by id desc limit ${n}`;
  if (!rows.length) {
    say('audit_log is empty; nothing to sample');
    return 0;
  }
  const ids = rows.map((r) => Number(r.id));
  const times = rows.map((r) => r.created_at.getTime());
  say(`sampled ${rows.length} row(s) ${random ? 'at random' : 'newest first'}: ids ${Math.min(...ids)}..${Math.max(...ids)}, ${new Date(Math.min(...times)).toISOString()} .. ${new Date(Math.max(...times)).toISOString()}`);
  const actions = new Map();
  for (const r of rows) actions.set(r.action, (actions.get(r.action) ?? 0) + 1);
  say(`${actions.size} action type(s) in the sample`);

  const findings = rows.flatMap(rowViolations);
  const result = findings.length ? 'fail' : 'pass';
  if (findings.length) {
    say(`FAIL: ${findings.length} violation(s) in ${new Set(findings.map((f) => f.id)).size} row(s)`);
    console.log(formatTable(findings.slice(0, 50), ['id', 'action', 'at', 'rule']));
    if (findings.length > 50) say(`(first 50 of ${findings.length} shown)`);
    const byAction = new Map();
    for (const f of findings) byAction.set(`${f.action} ${f.rule}`, (byAction.get(`${f.action} ${f.rule}`) ?? 0) + 1);
    say('by action and rule:');
    for (const [k, c] of [...byAction].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${c}`);
    say('fix the writer (private.audit_guard, packages/shared/src/audit.ts); audit rows are append-only, so the retained rows need an approved retention migration');
  } else {
    say('PASS: no forbidden keys or values in the sample');
  }

  if (!apply) {
    say(`plan: write audit_log runbook.audit_privacy_sample with the result (${result}) (request_id ${requestId})`);
    dryRunNote(say);
  } else {
    await writeAudit(sql, {
      script: 'audit-privacy-sample',
      action: 'runbook.audit_privacy_sample',
      requestId,
      targetTable: 'audit_log',
      targetId: String(Math.max(...ids)),
      metadata: { result, sampled: rows.length, violations: findings.length, first_id: Math.min(...ids), last_id: Math.max(...ids), random },
    });
    say(`result recorded (request_id ${requestId})`);
  }
  return findings.length ? 1 : 0;
}

if (isMain(import.meta.url)) {
  await runScript({ name: 'audit-privacy-sample', usage: USAGE, options: { sample: { type: 'string' }, random: { type: 'boolean' } }, run });
}
