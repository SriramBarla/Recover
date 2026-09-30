// scripts/lib-ops.mjs: argument parsing with the dry-run default, DB URL resolution, the F-74 payload
// check every runbook audit row passes, mode-600 secret files; and switch.mjs assignment parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LOCAL_DB_URL, UsageError, describeDb, isMain, parseEnv, parseOpsArgs, pickAction, positiveInt, privacyViolations,
  resolveDbUrl, writeAudit, writeSecretFile,
} from '../../scripts/lib-ops.mjs';
import { DISTRICT_SWITCHES, SCHOOL_SWITCHES, parseAssignments } from '../../scripts/switch.mjs';

const OPTIONS = { district: { type: 'boolean' }, school: { type: 'string' }, out: { type: 'string' } };

test('a dry run is the default; only --yes applies, and --dry-run wins over --yes', () => {
  assert.equal(parseOpsArgs([], OPTIONS).apply, false);
  assert.equal(parseOpsArgs(['--district', 'posting=off'], OPTIONS).apply, false);
  assert.equal(parseOpsArgs(['--district', 'posting=off', '--yes'], OPTIONS).apply, true);
  assert.equal(parseOpsArgs(['--yes', '--dry-run'], OPTIONS).apply, false);
  assert.equal(parseOpsArgs(['--dry-run'], OPTIONS).apply, false);
});

test('options, values and positionals are parsed strictly', () => {
  const a = parseOpsArgs(['--school', 'FCHS', 'student_posting=off', 'lost_reports=on', '--db', 'postgresql://u:p@h/db'], OPTIONS);
  assert.equal(a.values.school, 'FCHS');
  assert.equal(a.values.db, 'postgresql://u:p@h/db');
  assert.deepEqual(a.positionals, ['student_posting=off', 'lost_reports=on']);
  assert.equal(parseOpsArgs(['--school=SFHS'], OPTIONS).values.school, 'SFHS');
  assert.equal(parseOpsArgs(['-h'], OPTIONS).values.help, true);
  assert.throws(() => parseOpsArgs(['--force'], OPTIONS), UsageError);
  assert.throws(() => parseOpsArgs(['--school'], OPTIONS), UsageError);
  assert.throws(() => parseOpsArgs(['--yes=please'], OPTIONS), UsageError);
});

test('pickAction takes at most one action; positiveInt validates numbers', () => {
  assert.equal(pickAction({}, ['next', 'finish']), null);
  assert.equal(pickAction({ finish: true }, ['next', 'finish']), 'finish');
  assert.equal(pickAction({ replay: '12' }, ['dead', 'replay']), 'replay');
  assert.throws(() => pickAction({ next: true, finish: true }, ['next', 'finish']), UsageError);
  assert.throws(() => pickAction({}, ['begin', 'reopen'], { allowNone: false }), UsageError);
  assert.equal(positiveInt(undefined, 'limit', { fallback: 50 }), 50);
  assert.equal(positiveInt('20', 'limit', { max: 1000 }), 20);
  assert.throws(() => positiveInt('0', 'limit'), UsageError);
  assert.throws(() => positiveInt('5000', 'limit', { max: 1000 }), UsageError);
  assert.throws(() => positiveInt('1e3', 'limit'), UsageError);
});

test('the admin DB URL comes from --db, then DB_URL, then .env.local, then the local stack', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ops-args-'));
  assert.deepEqual(resolveDbUrl({}, {}, root), { url: LOCAL_DB_URL, source: 'default local stack' });
  writeFileSync(path.join(root, '.env.local'), '# local\nDB_URL="postgresql://postgres:filepw@127.0.0.1:1/postgres"\n');
  assert.equal(resolveDbUrl({}, {}, root).source, '.env.local');
  assert.equal(resolveDbUrl({}, {}, root).url, 'postgresql://postgres:filepw@127.0.0.1:1/postgres');
  assert.equal(resolveDbUrl({}, { DB_URL: 'postgresql://e@h/d' }, root).source, 'env DB_URL');
  assert.equal(resolveDbUrl({ db: 'postgresql://f@h/d' }, { DB_URL: 'postgresql://e@h/d' }, root).url, 'postgresql://f@h/d');
});

test('describeDb never shows the password', () => {
  const shown = describeDb('postgresql://postgres.abcd:s3cr3t-pw@db.example.supabase.co:5432/postgres');
  assert.equal(shown, 'postgres.abcd@db.example.supabase.co:5432/postgres');
  assert.ok(!shown.includes('s3cr3t'));
  assert.equal(describeDb('not a url'), '(unparseable database URL)');
});

test('parseEnv reads KEY=value lines and ignores the rest', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two"\nC=\'3\'\n bad line\nD=a=b\n'), { A: '1', B: 'two', C: '3', D: 'a=b' });
});

test('privacyViolations flags forbidden keys and values and never returns the value', () => {
  assert.deepEqual(privacyViolations({ phase: 'begin', cron_job_ids: [1, 2], restored_at: '2026-09-30T06:15:00.000Z', changed: ['posting'] }), []);
  const found = privacyViolations({
    description: 'x',
    pinX: 0.5,
    location_note_private: 'x',
    google_sub: '1',
    nested: { contact_email: 'a', list: ['room 214 by the stairs'] },
    who: 'someone@example.org',
    key: '0a0a0a0a-0000-4000-8000-000000000001/0b0b0b0b-0000-4000-8000-000000000002/x/raw',
    sha: 'ab'.repeat(32),
    device: `\\x01${'cd'.repeat(32)}`,
  });
  const rules = found.map((f) => `${f.at} ${f.rule}`);
  for (const expected of [
    '$.description forbidden_key', '$.pinX forbidden_key', '$.location_note_private forbidden_key', '$.google_sub forbidden_key',
    '$.nested.contact_email forbidden_key', '$.nested.list[0] free_text', '$.who at_sign', '$.key storage_path',
    '$.sha hex_digest', '$.device hex_digest',
  ]) assert.ok(rules.includes(expected), expected);
  assert.ok(!JSON.stringify(found).includes('someone@example.org'));
  assert.ok(!JSON.stringify(found).includes('stairs'));
});

test('writeAudit refuses a forbidden payload or a non-runbook action before any SQL', async () => {
  const calls = [];
  const sql = (...args) => {
    calls.push(args);
    return Promise.resolve([]);
  };
  sql.json = (v) => v;
  const base = { script: 'switch', requestId: '00000000-0000-4000-8000-000000000000', targetTable: 'schools', targetId: 'x' };
  await assert.rejects(writeAudit(sql, { ...base, action: 'runbook.switch', metadata: { note: 'x' } }), /F-74/);
  await assert.rejects(writeAudit(sql, { ...base, action: 'runbook.switch', after: { email: 'a@b.c' } }), /F-74/);
  await assert.rejects(writeAudit(sql, { ...base, action: 'item.approve' }), /runbook/);
  assert.equal(calls.length, 0);
  await writeAudit(sql, { ...base, action: 'runbook.switch', metadata: { scope: 'school' } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].join('?').includes('private.audit('));
  assert.ok(calls[0].includes('runbook:switch'));
});

test('writeSecretFile creates a mode-600 file and never overwrites one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-secret-'));
  const file = path.join(dir, 'key.env');
  assert.equal(writeSecretFile(file, 'A=1\n'), file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8'), 'A=1\n');
  assert.throws(() => writeSecretFile(file, 'B=2\n'), /EEXIST/);
  assert.equal(readFileSync(file, 'utf8'), 'A=1\n');
});

test('a script only runs as the entry point, never on import', () => {
  assert.equal(isMain(new URL('../../scripts/switch.mjs', import.meta.url).href), false);
  assert.equal(isMain(import.meta.url), true); // under node --test this file is the entry point
});

test('switch assignments map to the district and school columns', () => {
  assert.deepEqual(parseAssignments(DISTRICT_SWITCHES, ['posting=off', 'WORKER_MODE=quarantine']), [
    { key: 'posting', column: 'student_posting_global_enabled', value: false, visible: true },
    { key: 'worker_mode', column: 'worker_mode', value: 'quarantine', visible: false },
  ]);
  assert.deepEqual(parseAssignments(SCHOOL_SWITCHES, ['cross_school=on']), [
    { key: 'cross_school', column: 'cross_school_search_enabled', value: true, visible: true },
  ]);
  assert.equal(parseAssignments(DISTRICT_SWITCHES, ['screening=off'])[0].column, 'screening_enabled');
  assert.deepEqual(parseAssignments(DISTRICT_SWITCHES, []), []);
  assert.throws(() => parseAssignments(SCHOOL_SWITCHES, ['posting=off']), /unknown switch "posting"/);
  assert.throws(() => parseAssignments(DISTRICT_SWITCHES, ['posting=maybe']), /on or off/);
  assert.throws(() => parseAssignments(DISTRICT_SWITCHES, ['worker_mode=on']), /normal or quarantine/);
  assert.throws(() => parseAssignments(DISTRICT_SWITCHES, ['posting=off', 'posting=on']), /twice/);
  assert.throws(() => parseAssignments(DISTRICT_SWITCHES, ['posting']), /key=value/);
  assert.throws(() => parseAssignments(DISTRICT_SWITCHES, ['toString=on']), /unknown switch/);
});
