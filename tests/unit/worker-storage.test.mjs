// Storage client (§9.2, §9.6; F-75, F-117) over an injected fake signer and fetch: status handling,
// key-shape refusals, presign rules, and the regex ListObjectsV2 parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, parseListPage } from '../../apps/worker/lib/storage.ts';
import { PermanentError, RetryableError } from '../../apps/worker/lib/jobs/errors.ts';

const CFG = { endpoint: 'http://s3.test/storage/v1/s3', region: 'local', accessKeyId: 'AK', secretAccessKey: 'SK' };
const KEY = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/raw';

function fakes(respond) {
  const signed = [];
  const sent = [];
  const signer = {
    presignPut: (i) => {
      signed.push({ presign: i });
      return { url: `${i.endpoint}/${i.bucket}/${i.key}?X-Amz-Signature=sig`, expiresAt: new Date() };
    },
    signRequest: (i) => {
      signed.push(i);
      const q = i.query ? `?${new URLSearchParams(i.query)}` : '';
      return { url: `${i.endpoint}/${i.bucket}${i.key ? `/${i.key}` : ''}${q}`, headers: { authorization: 'AWS4-HMAC-SHA256 fake', 'x-amz-date': '20260930T000000Z' } };
    },
  };
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: init.body });
    return respond(url, init);
  };
  return { storage: createStorage(CFG, signer, fetchImpl), signed, sent };
}

test('head, get, del, put: status handling', async () => {
  const f = fakes((url, init) => {
    if (init.method === 'HEAD') return new Response(null, { status: url.includes('missing') ? 404 : 200, headers: { 'content-length': '1234', 'content-type': 'image/jpeg' } });
    if (init.method === 'DELETE') return new Response(null, { status: 404 });
    if (init.method === 'PUT') return new Response(null, { status: 200 });
    return new Response('abc', { status: 200, headers: { 'content-length': '3' } });
  });
  assert.deepEqual(await f.storage.head('incoming', KEY), { exists: true, bytes: 1234, contentType: 'image/jpeg' });
  assert.deepEqual(await f.storage.head('incoming', KEY.replace('raw', 'missing')), { exists: false, bytes: null, contentType: null });
  await f.storage.del('incoming', KEY); // 404 is success
  await f.storage.put('originals', KEY.replace('raw', 'canonical.jpg'), Buffer.from('jpeg'), 'image/jpeg');
  const put = f.sent.find((s) => s.method === 'PUT');
  assert.equal(put.headers['content-type'], 'image/jpeg');
  assert.equal(put.headers.authorization, 'AWS4-HMAC-SHA256 fake');
  assert.equal(Buffer.from(put.body).toString(), 'jpeg');
  assert.equal((await f.storage.getBytes('incoming', KEY, 10)).toString(), 'abc');
  await assert.rejects(f.storage.getBytes('incoming', KEY, 2), (e) => e instanceof PermanentError && e.code === 'too_large');
  await f.storage.get('incoming', KEY, { start: 0, end: 15 });
  assert.equal(f.sent.at(-1).headers.range, 'bytes=0-15');
});

test('5xx, 429, and network errors are retryable; other statuses are permanent', async () => {
  for (const status of [500, 503, 429]) {
    const f = fakes(() => new Response(null, { status }));
    await assert.rejects(f.storage.head('incoming', KEY), (e) => e instanceof RetryableError && e.code === 'storage_unavailable');
  }
  const denied = fakes(() => new Response(null, { status: 403 }));
  await assert.rejects(denied.storage.del('incoming', KEY), (e) => e instanceof PermanentError && e.code === 'storage_rejected');
  const offline = fakes(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.storage.put('incoming', KEY, Buffer.from('x'), 'image/jpeg'), (e) => e instanceof RetryableError);
});

test('keys must start with a school uuid and never walk out of it; unknown buckets are refused', async () => {
  const f = fakes(() => new Response(null, { status: 200 }));
  const bad = ['../etc/passwd', `${KEY}/../x`, `/${KEY}`, 'not-a-uuid/x', `${KEY.slice(0, 36)}`, `${KEY.slice(0, 36)}//raw`, `${KEY.slice(0, 36)}/./raw`];
  for (const key of bad) await assert.rejects(f.storage.head('incoming', key), (e) => e instanceof PermanentError && e.code === 'path_refused', key);
  await assert.rejects(f.storage.head('secrets', KEY), (e) => e instanceof PermanentError && e.code === 'path_refused');
  assert.equal(f.sent.length, 0, 'nothing was sent');
});

test('presignPut: allowed content types and TTLs only; expiresAt is an ISO time', () => {
  const f = fakes(() => new Response(null));
  const p = f.storage.presignPut('incoming', KEY, 900, 'image/jpeg');
  assert.match(p.url, /X-Amz-Signature=/);
  assert.ok(Math.abs(Date.parse(p.expiresAt) - (Date.now() + 900_000)) < 5_000);
  assert.equal(f.signed[0].presign.expiresSeconds, 900);
  assert.throws(() => f.storage.presignPut('incoming', KEY, 900, 'text/html'), (e) => e instanceof PermanentError && e.code === 'content_type_refused');
  assert.throws(() => f.storage.presignPut('incoming', KEY, 0, 'image/jpeg'), PermanentError);
  assert.throws(() => f.storage.presignPut('incoming', '../x', 900, 'image/jpeg'), PermanentError);
});

test('ListObjectsV2: regex parser decodes entities and follows continuation tokens', async () => {
  const page1 = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>true</IsTruncated>
    <Contents><Key>${KEY}</Key><LastModified>2026-09-30T01:00:00.000Z</LastModified><Size>1000</Size></Contents>
    <Contents><Key>a&amp;b</Key><LastModified>2026-09-30T02:00:00Z</LastModified><Size>2</Size></Contents>
    <NextContinuationToken>tok&lt;1&gt;</NextContinuationToken></ListBucketResult>`;
  const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>z</Key><LastModified>2026-09-30T03:00:00Z</LastModified><Size>3</Size></Contents></ListBucketResult>`;
  const parsed = parseListPage(page1);
  assert.deepEqual(parsed.objects.map((o) => [o.key, o.bytes]), [[KEY, 1000], ['a&b', 2]]);
  assert.equal(parsed.nextToken, 'tok<1>');
  assert.equal(parsed.objects[0].lastModified.toISOString(), '2026-09-30T01:00:00.000Z');
  assert.equal(parseListPage(page2).nextToken, null);

  const f = fakes((url) => new Response(url.includes('continuation-token') ? page2 : page1, { status: 200 }));
  const all = await f.storage.list('incoming', '');
  assert.deepEqual(all.map((o) => o.key), [KEY, 'a&b', 'z']);
  const listCalls = f.signed.filter((s) => s.query);
  assert.deepEqual(listCalls.map((s) => [s.method, s.key, s.query['list-type'], s.query['continuation-token'] ?? null]), [
    ['GET', '', '2', null],
    ['GET', '', '2', 'tok<1>'],
  ]);
  await assert.rejects(f.storage.list('incoming', '../'), PermanentError);
});
