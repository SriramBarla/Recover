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
import { auditCode, jobId, replayDedupeKey } from '../../scripts/jobs.mjs';
import { mergeNormalized, validateSynonyms } from '../../scripts/load-synonyms.mjs';
import {
  BUCKETS, buildIndex, classify, deleteOrphans, displayKey, localSignRequest, missingObjects, modifiedSince, parseListObjects,
  s3Config, sameObject,
} from '../../scripts/reconcile-orphans.mjs';
import { jobsToReopen, parseDirectory, recordedSinceReopen, setCronActive } from '../../scripts/restore-quarantine.mjs';
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
      { key: 'a/b&c/raw', size: 123, lastModified: '2026-09-01T00:00:00.000Z', etag: '"e"' },
      { key: 'x/y', size: 0, lastModified: '2026-09-02T00:00:00.000Z', etag: null },
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
  assert.deepEqual(missingObjects('variants', listed, index), [
    { bucket: 'variants', table: 'item_photos', id: P, column: 'medium_path', status: 'public_ready', rowTime: null },
  ]);
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

// ---------- review fixes: storage (items 1-3) ----------

const RS = '0a0a0a0a-0000-4000-8000-000000000001';
const RI = '0a0a0a0a-3000-4000-8000-000000000001';
const RP = '0a0a0a0a-4000-4000-8000-000000000001';

test('reconcile covers map drafts and public maps: classes, missing objects, masked tokens', () => {
  const V = '0a0a0a0a-2000-4000-8000-000000000001';
  const W = '0a0a0a0a-2000-4000-8000-000000000009';
  assert.deepEqual(Object.keys(BUCKETS), ['incoming', 'originals', 'variants', 'map_drafts', 'maps']);
  const index = buildIndex([], [], [{
    id: V, school_id: RS, approval_status: 'approved', approved_at: '2026-09-01T00:00:00Z',
    draft_storage_path: `${RS}/${V}/draft`, draft_canonical_path: null, public_storage_path: `${RS}/${V}/abc123.jpg`,
  }]);
  const opts = { now: Date.parse('2026-09-30T12:00:00Z'), minAgeMs: 24 * 3600e3 };
  const c = (bucket, key) => classify(bucket, { key, lastModified: '2026-09-01T00:00:00Z' }, index, opts);
  assert.equal(c('maps', `${RS}/${V}/abc123.jpg`), 'referenced');
  assert.equal(c('map_drafts', `${RS}/${V}/draft`), 'referenced');
  assert.equal(c('map_drafts', `${RS}/${V}/canonical.jpg`), 'unreferenced');
  assert.equal(c('maps', `${RS}/${V}/old999.jpg`), 'unreferenced');
  assert.equal(c('maps', `${RS}/${W}/x.jpg`), 'no_row');
  assert.equal(c('maps', `0b0b0b0b-0000-4000-8000-000000000002/${V}/x.jpg`), 'no_row'); // the version belongs to another school
  assert.equal(c('maps', 'logo.png'), 'unrecognized');
  assert.deepEqual(missingObjects('maps', new Set(), index), [
    { bucket: 'maps', table: 'map_versions', id: V, column: 'public_storage_path', status: 'approved', rowTime: '2026-09-01T00:00:00.000Z' },
  ]);
  assert.equal(displayKey('maps', `${RS}/${V}/abc123.jpg`, false), `${RS}/${V}/<token>.jpg`);
  assert.equal(displayKey('maps', `${RS}/${V}/abc123.jpg`, true), `${RS}/${V}/abc123.jpg`);
  assert.equal(displayKey('map_drafts', `${RS}/${V}/draft`, false), `${RS}/${V}/draft`);
});

test('--since lists every object modified in the window and flags overwritten live objects', () => {
  const index = buildIndex([{
    id: RP, item_id: RI, school_id: RS, status: 'public_ready', updated_at: '2026-09-20T10:00:00Z',
    thumb_path: `${RS}/${RI}/${RP}/t/thumb.jpg`, medium_path: `${RS}/${RI}/${RP}/t/medium.jpg`,
  }], []);
  const objects = [
    { key: `${RS}/${RI}/${RP}/t/thumb.jpg`, lastModified: '2026-09-20T10:00:05Z' }, // written with its row
    { key: `${RS}/${RI}/${RP}/t/medium.jpg`, lastModified: '2026-09-25T03:00:00Z' }, // overwritten days later
    { key: `${RS}/${RI}/${RP}/x/thumb.jpg`, lastModified: '2026-09-26T00:00:00Z' }, // unreferenced, written in the window
    { key: 'stray.bin', lastModified: 'not a date' },
    { key: `${RS}/${RI}/${RP}/t/old.jpg`, lastModified: '2026-09-01T00:00:00Z' }, // before the window: not listed
  ];
  const got = modifiedSince('variants', objects, index, Date.parse('2026-09-15T00:00:00Z'), { now: Date.parse('2026-09-30T00:00:00Z'), minAgeMs: 3600e3 });
  assert.deepEqual(got.map((r) => [r.class, r.note]), [
    ['referenced', ''], ['referenced', 'written after its row'], ['unreferenced', ''], ['unrecognized', 'no timestamp'],
  ]);
  assert.equal(got[1].row_time, '2026-09-20T10:00:00.000Z');
});

test('an object is re-confirmed by ETag, or else by the Last-Modified second and the size', () => {
  assert.equal(sameObject({ etag: '"abc"' }, { etag: '"abc"' }), true);
  assert.equal(sameObject({ etag: '"abc"' }, { etag: 'W/"abc"' }), true);
  assert.equal(sameObject({ etag: '"abc"' }, { etag: '"abd"' }), false);
  const listed = { etag: null, lastModified: '2026-09-30T09:10:54.508Z', size: 10 };
  assert.equal(sameObject(listed, { 'last-modified': 'Wed, 30 Sep 2026 09:10:54 GMT', 'content-length': '10' }), true);
  assert.equal(sameObject(listed, { 'last-modified': 'Wed, 30 Sep 2026 09:10:55 GMT', 'content-length': '10' }), false);
  assert.equal(sameObject(listed, { 'last-modified': 'Wed, 30 Sep 2026 09:10:54 GMT', 'content-length': '11' }), false);
  assert.equal(sameObject({ etag: null, lastModified: null, size: 1 }, {}), false);
});

test('every DELETE follows a fresh lookup and a matching HEAD; counts survive partial runs', async () => {
  const opts = { now: Date.parse('2026-09-30T12:00:00Z'), minAgeMs: 24 * 3600e3 };
  const key = (n) => `${RS}/${RI}/0a0a0a0a-4000-4000-8000-00000000000${n}/raw`;
  const batch = [1, 2, 3, 4, 5, 6].map((n) => ({ bucket: 'incoming', key: key(n), lastModified: '2026-09-01T00:00:00Z', etag: `"e${n}"`, size: 1 }));
  batch.push({ bucket: 'incoming', key: key(7), lastModified: '2026-09-30T11:30:00Z', etag: '"e7"', size: 1 }); // its listed age is kept
  const empty = buildIndex([], [], []);
  const nowReferenced = buildIndex([{ id: '0a0a0a0a-4000-4000-8000-000000000002', item_id: RI, school_id: RS, status: 'uploaded', incoming_path: key(2) }], []);
  const heads = { 1: '"e1"', 2: '"e2"', 3: 404, 4: '"changed"', 5: 500, 6: '"e6"' };
  const calls = [];
  const send = async ({ method, key: k }) => {
    const n = Number(k.split('/')[2].slice(-1));
    calls.push(`${method} ${n}`);
    if (method === 'HEAD') {
      const h = heads[n];
      return typeof h === 'number' ? { status: h, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: { etag: h }, text: '' };
    }
    return n === 6 ? { status: 500, ok: false, headers: {}, text: '<Error><Code>InternalError</Code></Error>' } : { status: 204, ok: true, headers: {}, text: '' };
  };
  const zero = () => ({ deleted: 0, failed: 0, skipped_not_orphan: 0, skipped_changed: 0, skipped_gone: 0 });
  const lookups = [];
  const counts = zero();
  await deleteOrphans({ batch, lookup: async (b, k) => (lookups.push(k), k === key(2) ? nowReferenced : empty), send, opts, say: () => {}, counts });
  assert.deepEqual(counts, { deleted: 1, failed: 2, skipped_not_orphan: 2, skipped_changed: 1, skipped_gone: 1 });
  assert.equal(lookups.length, 7, 'every key is looked up again');
  assert.deepEqual(calls, ['HEAD 1', 'DELETE 1', 'HEAD 3', 'HEAD 4', 'HEAD 5', 'HEAD 6', 'DELETE 6']);

  let n = 0;
  const partial = zero();
  await assert.rejects(
    deleteOrphans({ batch, lookup: async () => { n += 1; if (n === 3) throw new Error('connection lost'); return empty; }, send, opts, say: () => {}, counts: partial }),
    /connection lost/,
  );
  assert.deepEqual(partial, { ...zero(), deleted: 2 }, 'the counts of a run that failed midway are kept for its audit row');

  const stopped = zero();
  await deleteOrphans({ batch, lookup: async () => empty, send, opts, say: () => {}, counts: stopped, shouldStop: () => stopped.deleted >= 1 });
  assert.deepEqual(stopped, { ...zero(), deleted: 1 });
});

// ---------- review fixes: restore quarantine (items 5, 11) and job errors (item 10) ----------

test('reopen restores every job disabled by any --begin since the last reopen', () => {
  const rows = [
    { id: 1, metadata: { phase: 'begin', cron_job_ids: [9], cron_job_names: ['old_job'] } },
    { id: 2, metadata: { phase: 'reopen' } },
    { id: 3, metadata: { phase: 'begin', cron_job_ids: [1, 2], cron_job_names: ['recover_drain', 'recover_health'] } },
    { id: 4, metadata: { phase: 'begin', cron_job_ids: [], cron_job_names: [] } }, // a second --begin finds nothing active
  ];
  const recorded = recordedSinceReopen(rows);
  assert.deepEqual(recorded, { ids: [1, 2], names: ['recover_drain', 'recover_health'], begins: 2 });
  const cron = [
    { jobid: 1, jobname: 'recover_drain', active: false },
    { jobid: 2, jobname: 'recover_health', active: false },
    { jobid: 9, jobname: 'old_job', active: false },
  ];
  assert.deepEqual(jobsToReopen(cron, recorded), [1, 2], 'the empty second --begin does not strand recover_drain');
  assert.deepEqual(jobsToReopen(cron, recordedSinceReopen([rows[3]])), [], 'reading only the latest record would re-enable nothing');
  assert.equal(recordedSinceReopen(rows.slice(0, 2)), null);
  assert.equal(recordedSinceReopen([]), null);
});

test('the cron fallback update must change exactly one row', async () => {
  const tx = (alterError, rows) => {
    const f = async () => rows;
    f.savepoint = async () => {
      if (alterError) throw new Error(alterError);
    };
    return f;
  };
  assert.equal(await setCronActive(tx(null, []), 1, false), 'alter_job');
  assert.equal(await setCronActive(tx('must be owner of job 1', [{ jobid: 1 }]), 1, false), 'update');
  await assert.rejects(setCronActive(tx('must be owner of job 1', []), 1, false), /changed 0 rows, not 1/);
  await assert.rejects(setCronActive(tx('must be owner of job 1', [{ jobid: 1 }, { jobid: 1 }]), 1, false), /changed 2 rows, not 1/);
  const broken = async () => {
    throw new Error('permission denied for table job');
  };
  broken.savepoint = async () => {
    throw new Error('must be owner of job 7');
  };
  await assert.rejects(setCronActive(broken, 7, true), /alter_job failed \(must be owner of job 7\) and the fallback update failed \(permission denied/);
});

test('audit metadata keeps plain error codes only', () => {
  assert.equal(auditCode('provider_timeout'), 'provider_timeout');
  assert.equal(auditCode(null), null);
  assert.equal(auditCode(undefined), null);
  for (const bad of ['Error: connect ECONNREFUSED 10.0.0.7:443', 'Timeout', 'x@y.org', 'a b', '5xx', `k${'x'.repeat(60)}`]) {
    assert.equal(auditCode(bad), 'other', bad);
  }
});
