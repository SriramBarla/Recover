// Pure parts of the runbook scripts: SCRAM verifier (RFC 7677), assertion-key pointer plan (G-17),
// job replay keys, calendar CSV and horizon (F-88), audit privacy findings (F-74), the S3 fallback
// signer (AWS SigV4 example) and orphan classification, roster directory parsing, cron reopen, and
// synonym validation. Nothing here needs a database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rowViolations } from '../../scripts/audit-privacy-sample.mjs';
import { addDays, horizon, parseCalendarCsv, validDate } from '../../scripts/calendar-horizon.mjs';
import { jobId, replayDedupeKey } from '../../scripts/jobs.mjs';
import { mergeNormalized, validateSynonyms } from '../../scripts/load-synonyms.mjs';
import { buildIndex, classify, displayKey, localSignRequest, missingObjects, parseListObjects, s3Config } from '../../scripts/reconcile-orphans.mjs';
import { jobsToReopen, parseDirectory } from '../../scripts/restore-quarantine.mjs';
import { planNext } from '../../scripts/rotate-assertion-key.mjs';
import { ROLES, newPassword, scramVerifier } from '../../scripts/rotate-db-password.mjs';

test('the SCRAM-SHA-256 verifier reproduces the RFC 7677 example exchange', () => {
  const verifier = scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096);
  const m = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  assert.ok(m, verifier.slice(0, 20));
  assert.equal(m[1], 'W22ZaJ0SNY7soEsUEjb6gQ==');
  const storedKey = Buffer.from(m[2], 'base64');
  const serverKey = Buffer.from(m[3], 'base64');
  const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
  assert.equal(createHmac('sha256', serverKey).update(authMessage).digest('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  // The server-side proof check: SHA-256(ClientProof XOR HMAC(StoredKey, AuthMessage)) = StoredKey.
  const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const signature = createHmac('sha256', storedKey).update(authMessage).digest();
  assert.deepEqual(createHash('sha256').update(Buffer.from(proof.map((b, i) => b ^ signature[i]))).digest(), storedKey);
});

test('new passwords are 32 random bytes as base64url; only the two app logins rotate', () => {
  const a = newPassword();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newPassword());
  assert.deepEqual(ROLES, ['recover_web', 'recover_worker']);
  assert.throws(() => scramVerifier('with space'), /printable ASCII/);
});

test('assertion key --next keeps the old version verifying, except after an emergency', () => {
  assert.deepEqual(planNext({ current: '1', previous: '', versions: [1] }), { next: 2, name: 'staff_assertion_key_v2', current: '2', previous: '1' });
  assert.deepEqual(planNext({ current: '', previous: '', versions: [1, 2] }), { next: 3, name: 'staff_assertion_key_v3', current: '3', previous: '' });
  assert.deepEqual(planNext({ current: null, previous: null, versions: [] }), { next: 1, name: 'staff_assertion_key_v1', current: '1', previous: '' });
  assert.equal(planNext({ current: '2', previous: '', versions: [1, 2, 7] }).next, 8);
  assert.throws(() => planNext({ current: '2', previous: '1', versions: [1, 2] }), /--finish first/);
});

test('replayed jobs get a fresh dedupe key within the 200-character column', () => {
  const now = new Date('2026-09-30T08:15:00.123Z');
  assert.equal(replayDedupeKey({ id: '12', kind: 'screen_item', dedupe_key: 'screen_item:abc:v1' }, now), 'screen_item:abc:v1:replay:20260930T081500Z');
  assert.equal(replayDedupeKey({ id: '12', kind: 'purge_drafts', dedupe_key: null }, now), 'purge_drafts:job-12:replay:20260930T081500Z');
  assert.equal(
    replayDedupeKey({ id: '3', kind: 'x', dedupe_key: 'make_variants:i:replay:20260929T000000Z:replay:20260929T010000Z' }, now),
    'make_variants:i:replay:20260930T081500Z',
  );
  const long = replayDedupeKey({ id: '1', kind: 'k', dedupe_key: 'k'.repeat(200) }, now);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(':replay:20260930T081500Z'));
  assert.equal(jobId('42', 'replay'), '42');
  for (const bad of ['4a', '-1', '', '1.5']) assert.throws(() => jobId(bad, 'replay'), /numeric job id/);
});

test('calendar CSV: header in any order, BOM, CRLF, comments, one-digit hours', () => {
  const csv = '﻿is_open,day,close_at,open_at\r\n# term 1\r\ntrue,2026-10-05,16:30,7:30\r\nfalse,2026-10-10,,\r\nyes,2026-10-06,15:00:00,08:00\r\n';
  const { rows, errors } = parseCalendarCsv(csv);
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map(({ line, ...r }) => r), [
    { day: '2026-10-05', is_open: true, open_at: '07:30:00', close_at: '16:30:00' },
    { day: '2026-10-10', is_open: false, open_at: null, close_at: null },
    { day: '2026-10-06', is_open: true, open_at: '08:00:00', close_at: '15:00:00' },
  ]);
});

test('calendar CSV: every invalid row is reported with its line', () => {
  const { rows, errors } = parseCalendarCsv([
    'day,is_open,open_at,close_at',
    '2027-02-30,true,07:30,16:30',
    '2027-03-01,maybe,07:30,16:30',
    '2027-03-02,true,16:30,07:30',
    '2027-03-03,false,07:30,16:30',
    '2027-03-04,true,,',
    '2027-03-05,true,07:30',
    '2027-03-06,false,,',
    '2027-03-06,false,,',
    '2027-03-07,true,24:00,25:00',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.deepEqual(errors.map((e) => e.split(':')[0]), ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 9', 'line 10']);
  assert.deepEqual(parseCalendarCsv('date,open\n2026-10-05,true\n').errors, ['line 1: the header must be day,is_open,open_at,close_at']);
  assert.deepEqual(parseCalendarCsv('\n# nothing\n').errors, ['the file has no header row']);
});

test('the horizon counts consecutive covered days from tomorrow; a gap ends it', () => {
  const days = new Set(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-07']);
  assert.deepEqual(horizon('2026-09-30', days), { days: 5, coveredThrough: '2026-10-05' });
  assert.deepEqual(horizon('2026-09-29', days), { days: 0, coveredThrough: null });
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // DST change in US time zones: pure date math
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2027-02-29'), false);
  assert.equal(validDate('2027-1-05'), false);
});

test('audit privacy findings name the row, place and rule, never the value', () => {
  const clean = { id: '7', action: 'item.approve', actor_id: '00000000-5b00-4000-8000-000000000004', target_id: '0a0a0a0a-1000-4000-8000-000000000001', state_before: { review_status: 'pending' }, state_after: { review_status: 'approved', edited_fields: ['description'] }, metadata: {} };
  assert.deepEqual(rowViolations(clean), []);
  const bad = {
    id: '8',
    action: 'item.reject',
    actor_id: 'runbook:x',
    target_id: '0a0a0a0a-0000-4000-8000-000000000001/0b0b0b0b-0000-4000-8000-000000000002/raw',
    state_before: { description: 'red hoodie' },
    state_after: {},
    metadata: { device: 'ab'.repeat(33), by: 'x@y.org' },
  };
  assert.deepEqual(rowViolations(bad).map((f) => `${f.at} ${f.rule}`).sort(), [
    'metadata.by at_sign', 'metadata.device hex_digest', 'state_before.description forbidden_key', 'target_id storage_path',
  ]);
  assert.ok(!JSON.stringify(rowViolations(bad)).includes('hoodie'));
});

test('the fallback SigV4 signer reproduces the AWS "GET Bucket (List Objects)" example', () => {
  const { url, headers } = localSignRequest({
    method: 'GET',
    endpoint: 'https://examplebucket.s3.amazonaws.com',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    query: { 'max-keys': '2', prefix: 'J' },
    now: '2013-05-24T00:00:00Z',
  });
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J');
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
  );
  const del = localSignRequest({ method: 'DELETE', endpoint: 'http://127.0.0.1:55421/storage/v1/s3', region: 'local', accessKeyId: 'k', secretAccessKey: 's', bucket: 'incoming', key: 'a b/c(1).jpg', now: '2026-09-30T00:00:00Z' });
  assert.equal(del.url, 'http://127.0.0.1:55421/storage/v1/s3/incoming/a%20b/c%281%29.jpg');
});

test('ListObjectsV2 responses are parsed with entities and continuation tokens', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>incoming</Name><IsTruncated>true</IsTruncated>'
    + '<Contents><Key>a/b&amp;c/raw</Key><LastModified>2026-09-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag><Size>123</Size></Contents>'
    + '<Contents><Key>x&#47;y</Key><LastModified>2026-09-02T00:00:00.000Z</LastModified><Size>0</Size></Contents>'
    + '<NextContinuationToken>t&amp;k==</NextContinuationToken></ListBucketResult>';
  assert.deepEqual(parseListObjects(xml), {
    objects: [
      { key: 'a/b&c/raw', size: 123, lastModified: '2026-09-01T00:00:00.000Z' },
      { key: 'x/y', size: 0, lastModified: '2026-09-02T00:00:00.000Z' },
    ],
    truncated: true,
    next: 't&k==',
  });
  assert.deepEqual(parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'), { objects: [], truncated: false, next: null });
});

test('orphan classification covers every class, and missing objects are found', () => {
  const S = '0a0a0a0a-0000-4000-8000-000000000001';
  const I = '0a0a0a0a-3000-4000-8000-000000000001';
  const P = '0a0a0a0a-4000-4000-8000-000000000001';
  const Q = '0a0a0a0a-4000-4000-8000-000000000002';
  const other = '0b0b0b0b-0000-4000-8000-000000000002';
  const index = buildIndex(
    [{ id: P, item_id: I, school_id: S, status: 'public_ready', incoming_path: null, original_path: `${S}/${I}/${P}/canonical.jpg`, review_path: `${S}/${I}/${P}/review.jpg`, thumb_path: `${S}/${I}/${P}/t0k3n/thumb.jpg`, medium_path: `${S}/${I}/${P}/t0k3n/medium.jpg` }],
    [{ object_kind: 'thumb', storage_path: `${S}/${I}/${Q}/old/thumb.jpg` }, { object_kind: 'review', storage_path: null }],
  );
  const now = Date.parse('2026-09-30T12:00:00Z');
  const old = '2026-09-01T00:00:00Z';
  const c = (bucket, key, lastModified = old) => classify(bucket, { key, lastModified }, index, { now, minAgeMs: 24 * 3600e3 });
  assert.equal(c('originals', `${S}/${I}/${P}/canonical.jpg`), 'referenced');
  assert.equal(c('variants', `${S}/${I}/${Q}/old/thumb.jpg`), 'pending_deletion');
  assert.equal(c('variants', `${S}/${I}/${P}/older/thumb.jpg`), 'unreferenced');
  assert.equal(c('incoming', `${S}/${I}/${Q}/raw`), 'no_row');
  assert.equal(c('incoming', `${other}/${I}/${P}/raw`), 'no_row'); // photo exists, but under another school
  assert.equal(c('incoming', 'healthcheck/canary'), 'unrecognized');
  assert.equal(c('incoming', `${S}/${I}/${Q}/raw`, '2026-09-30T11:00:00Z'), 'too_new');
  assert.equal(c('incoming', `${S}/${I}/${Q}/raw`, 'garbage'), 'too_new');
  const listed = new Set([`${S}/${I}/${P}/t0k3n/thumb.jpg`]);
  assert.deepEqual(missingObjects('variants', listed, index), [{ bucket: 'variants', photoId: P, column: 'medium_path', status: 'public_ready' }]);
  const deleting = buildIndex(
    [{ id: P, item_id: I, school_id: S, status: 'public_ready', original_path: `${S}/${I}/${P}/canonical.jpg` }],
    [{ object_kind: 'original', storage_path: `${S}/${I}/${P}/canonical.jpg` }],
  );
  assert.deepEqual(missingObjects('originals', new Set(), deleting), [], 'an object already in the deletion ledger is not missing');
  assert.equal(displayKey('variants', `${S}/${I}/${P}/t0k3n/thumb.jpg`, false), `${S}/${I}/${P}/<token>/thumb.jpg`);
  assert.equal(displayKey('variants', `${S}/${I}/${P}/t0k3n/thumb.jpg`, true), `${S}/${I}/${P}/t0k3n/thumb.jpg`);
  assert.equal(displayKey('originals', `${S}/${I}/${P}/canonical.jpg`, false), `${S}/${I}/${P}/canonical.jpg`);
});

test('S3 settings come from --worker-env, else the environment, else apps/worker/.env.local', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ops-s3-'));
  const vars = 'SUPABASE_S3_ENDPOINT=http://127.0.0.1:55421/storage/v1/s3\nSUPABASE_S3_REGION=local\nSUPABASE_S3_ACCESS_KEY_ID=id\nSUPABASE_S3_SECRET_ACCESS_KEY=secret\n';
  assert.deepEqual(s3Config({}, {}, root).missing, ['SUPABASE_S3_ENDPOINT', 'SUPABASE_S3_REGION', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY']);
  const file = path.join(root, 'worker.env');
  writeFileSync(file, vars);
  const fromFile = s3Config({ 'worker-env': file }, { SUPABASE_S3_REGION: 'ignored' }, root);
  assert.deepEqual([fromFile.s3.region, fromFile.missing, fromFile.source], ['local', [], file]);
  const env = { SUPABASE_S3_ENDPOINT: 'https://x.supabase.co/storage/v1/s3', SUPABASE_S3_REGION: 'us-east-1', SUPABASE_S3_ACCESS_KEY_ID: 'a', SUPABASE_S3_SECRET_ACCESS_KEY: 'b' };
  assert.equal(s3Config({}, env, root).source, 'environment');
});

test('restore: directory exports yield lowercase emails; reopen matches jobs by name or id', () => {
  assert.deepEqual([...parseDirectory('name,email\nA,Alice@District.org\n"B", bob@district.org;carol@x.org\nno email here')], ['alice@district.org', 'bob@district.org', 'carol@x.org']);
  const cron = [
    { jobid: 109, jobname: 'recover_drain', active: false },
    { jobid: 110, jobname: 'recover_health', active: false },
    { jobid: 5, jobname: null, active: false },
    { jobid: 111, jobname: 'recover_purges', active: true },
    { jobid: 7, jobname: 'someone_else', active: false },
  ];
  assert.deepEqual(jobsToReopen(cron, { ids: [13, 14, 5], names: ['recover_drain', 'recover_health', 'recover_purges'] }), [109, 110, 5]);
  assert.deepEqual(jobsToReopen(cron, null), [109, 110, 5, 7]);
  assert.deepEqual(jobsToReopen(cron, { ids: [], names: [] }), []);
  assert.deepEqual(jobsToReopen(null, null), []);
});

test('synonyms: the file shape is validated and normalized terms are merged', () => {
  assert.deepEqual(validateSynonyms([]).errors, ['the file must hold one JSON object']);
  const { entries, errors } = validateSynonyms({ Hydroflask: ['Water Bottle'], hydroflask: ['bottle', 'water bottle'], ok: 'x', 'bad\u0007': ['y'], empty: [] });
  assert.equal(entries.length, 2);
  assert.equal(errors.length, 3);
  const norm = new Map([['Hydroflask', 'hydroflask'], ['hydroflask', 'hydroflask'], ['Water Bottle', 'water bottle'], ['water bottle', 'water bottle'], ['bottle', 'bottle']]);
  const { merged, notes } = mergeNormalized(entries, norm);
  assert.deepEqual([...merged], [['hydroflask', ['water bottle', 'bottle']]]);
  assert.ok(notes.some((n) => n.includes('merges into "hydroflask"')));
  const self = mergeNormalized([{ term: 'Crocs', expansions: ['crocs'] }], new Map([['Crocs', 'crocs'], ['crocs', 'crocs']]));
  assert.equal(self.merged.size, 0);
  assert.ok(self.notes[0].includes('no expansion left'));
});
