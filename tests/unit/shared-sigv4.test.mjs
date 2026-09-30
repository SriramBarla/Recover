// SigV4 signer (F-117, D-26): AWS S3 API Reference vectors plus a presign round trip checked by an
// independent, server-style verifier written here without importing any sigv4.ts internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { encodeKey, presignPut, signRequest, sigv4, uriEncode } from '../../packages/shared/src/sigv4.ts';

const VECTOR_DIR = new URL('../vectors/sigv4/', import.meta.url);
const vectors = readdirSync(VECTOR_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, VECTOR_DIR), 'utf8')));

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

// ---------- independent verifier (what an S3 server re-derives from the wire request) ----------

function awsEncode(s) {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    out += b < 0x80 && /[A-Za-z0-9\-._~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function serverCheck({ method, url, headers, secret, region }) {
  const u = new URL(url);
  const pairs = u.search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return [decodeURIComponent(i < 0 ? p : p.slice(0, i)), decodeURIComponent(i < 0 ? '' : p.slice(i + 1))];
    });
  const q = Object.fromEntries(pairs);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  lower.host = u.host;
  const presigned = 'X-Amz-Signature' in q;
  let names, payload, provided, amzDate;
  if (presigned) {
    names = q['X-Amz-SignedHeaders'].split(';');
    payload = q['X-Amz-Content-Sha256'] ?? 'UNSIGNED-PAYLOAD';
    provided = q['X-Amz-Signature'];
    amzDate = q['X-Amz-Date'];
  } else {
    const m = /SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(lower.authorization);
    assert.ok(m, 'authorization header shape');
    names = m[1].split(';');
    provided = m[2];
    payload = lower['x-amz-content-sha256'];
    amzDate = lower['x-amz-date'];
  }
  const canonQuery = pairs
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const creq = [method, u.pathname, canonQuery, canonHeaders, names.join(';'), payload].join('\n');
  const day = amzDate.slice(0, 8);
  const sts = ['AWS4-HMAC-SHA256', amzDate, `${day}/${region}/s3/aws4_request`, sha256Hex(creq)].join('\n');
  let k = createHmac('sha256', `AWS4${secret}`).update(day).digest();
  for (const part of [region, 's3', 'aws4_request']) k = createHmac('sha256', k).update(part).digest();
  return { expected: createHmac('sha256', k).update(sts).digest('hex'), provided, query: q };
}

// ---------- AWS documentation vectors ----------

test('all five AWS S3 SigV4 documentation vectors are checked in', () => {
  assert.deepEqual(
    vectors.map((v) => v.name),
    ['get-bucket-lifecycle', 'get-bucket-list-objects', 'get-object-presigned', 'get-object-range', 'put-object'],
  );
});

for (const v of vectors) {
  const r = v.request;
  const common = {
    endpoint: r.endpoint,
    region: r.region,
    accessKeyId: r.accessKeyId,
    secretAccessKey: r.secretAccessKey,
    key: r.key,
    query: r.query,
    headers: r.headers,
    now: new Date(r.now),
  };

  test(`AWS vector ${v.name}: canonical request, string to sign, signature`, () => {
    const payloadHash = v.mode === 'presign' ? 'UNSIGNED-PAYLOAD' : sha256Hex(r.body);
    if (v.expected.payloadHash) assert.equal(payloadHash, v.expected.payloadHash);
    const out = sigv4({
      ...common,
      method: r.method,
      payloadHash,
      presign: v.mode === 'presign' ? { expiresSeconds: r.expiresSeconds, contentSha256Param: false } : undefined,
    });
    assert.equal(out.canonicalRequest, v.expected.canonicalRequest);
    assert.equal(out.stringToSign, v.expected.stringToSign);
    assert.equal(out.signature, v.expected.signature);
    if (v.mode === 'presign') assert.equal(out.url, v.expected.url);
  });

  if (v.mode === 'header') {
    test(`AWS vector ${v.name}: signRequest produces the documented Authorization header`, () => {
      const out = signRequest({ ...common, method: r.method, body: r.body });
      assert.equal(out.url, v.expected.url);
      assert.equal(out.headers.authorization, v.expected.authorization);
      assert.equal(out.headers['x-amz-date'], '20130524T000000Z');
      assert.equal(out.headers['x-amz-content-sha256'], v.expected.payloadHash);
      assert.equal(out.headers.host, 'examplebucket.s3.amazonaws.com');
    });
  }

  test(`AWS vector ${v.name}: the independent verifier agrees with the documented signature`, () => {
    const sent =
      v.mode === 'presign'
        ? { url: v.expected.url, headers: {} }
        : signRequest({ ...common, method: r.method, body: r.body });
    const chk = serverCheck({ method: r.method, url: sent.url, headers: sent.headers, secret: r.secretAccessKey, region: r.region });
    assert.equal(chk.provided, v.expected.signature);
    assert.equal(chk.expected, v.expected.signature);
  });
}

// ---------- presigned PUT round trip (shape and expiry) ----------

const LOCAL = {
  endpoint: 'http://127.0.0.1:55421/storage/v1/s3',
  region: 'local',
  accessKeyId: 'test-access-key-id',
  secretAccessKey: 'test-secret-access-key',
};
const KEY = '0a0a0a0a-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/raw';
const NOW = new Date('2026-09-30T14:05:06.789Z');

test('presignPut: path-style URL under the endpoint prefix with the SDK v3 query shape', () => {
  const { url, expiresAt } = presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: 600, now: NOW });
  const u = new URL(url);
  assert.equal(u.origin, 'http://127.0.0.1:55421');
  assert.equal(u.pathname, `/storage/v1/s3/incoming/${KEY}`);
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual(Object.keys(q), [
    'X-Amz-Algorithm',
    'X-Amz-Content-Sha256',
    'X-Amz-Credential',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-SignedHeaders',
    'X-Amz-Signature',
  ]);
  assert.equal(q['X-Amz-Algorithm'], 'AWS4-HMAC-SHA256');
  assert.equal(q['X-Amz-Content-Sha256'], 'UNSIGNED-PAYLOAD');
  assert.equal(q['X-Amz-Credential'], 'test-access-key-id/20260930/local/s3/aws4_request');
  assert.equal(q['X-Amz-Date'], '20260930T140506Z');
  assert.equal(q['X-Amz-Expires'], '600');
  assert.equal(q['X-Amz-SignedHeaders'], 'host');
  assert.match(q['X-Amz-Signature'], /^[0-9a-f]{64}$/);
  // Expiry is X-Amz-Date (whole seconds) plus X-Amz-Expires.
  assert.equal(expiresAt, '2026-09-30T14:15:06.000Z');
});

test('presignPut: an independent server-side verification accepts the URL', () => {
  const { url } = presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: 600, now: NOW });
  const chk = serverCheck({ method: 'PUT', url, headers: {}, secret: LOCAL.secretAccessKey, region: 'local' });
  assert.equal(chk.provided, chk.expected);
});

test('presignPut: tampering with the key, expiry, or method fails verification', () => {
  const { url } = presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: 600, now: NOW });
  const check = (method, u) => serverCheck({ method, url: u, headers: {}, secret: LOCAL.secretAccessKey, region: 'local' });
  const otherKey = url.replace('/raw?', '/raw2?');
  const longer = url.replace('X-Amz-Expires=600', 'X-Amz-Expires=6000');
  for (const [method, u] of [['PUT', otherKey], ['PUT', longer], ['GET', url]]) {
    const chk = check(method, u);
    assert.notEqual(chk.expected, chk.provided);
  }
  const wrongSecret = serverCheck({ method: 'PUT', url, headers: {}, secret: 'other', region: 'local' });
  assert.notEqual(wrongSecret.expected, wrongSecret.provided);
});

test('presignPut: contentType becomes a signed header the upload must send', () => {
  const { url } = presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: 60, contentType: 'image/jpeg', now: NOW });
  const q = Object.fromEntries(new URL(url).searchParams);
  assert.equal(q['X-Amz-SignedHeaders'], 'content-type;host');
  const good = serverCheck({ method: 'PUT', url, headers: { 'Content-Type': 'image/jpeg' }, secret: LOCAL.secretAccessKey, region: 'local' });
  assert.equal(good.expected, good.provided);
  const bad = serverCheck({ method: 'PUT', url, headers: { 'Content-Type': 'text/html' }, secret: LOCAL.secretAccessKey, region: 'local' });
  assert.notEqual(bad.expected, bad.provided);
});

test('presignPut: expiresSeconds must be a whole number of seconds in 1..604800', () => {
  for (const bad of [0, -1, 1.5, 604_801, Number.NaN]) {
    assert.throws(() => presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: bad, now: NOW }), /expiresSeconds/);
  }
  const max = presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: 604_800, now: NOW });
  assert.equal(max.expiresAt, '2026-10-07T14:05:06.000Z');
});

test('presignPut: defaults to the current time', () => {
  const before = Math.floor(Date.now() / 1000) * 1000;
  const { expiresAt } = presignPut({ ...LOCAL, bucket: 'incoming', key: KEY, expiresSeconds: 300 });
  const t = Date.parse(expiresAt);
  assert.ok(t >= before + 300_000 && t <= Date.now() + 300_000, 'expiry is now + 300 s');
});

// ---------- header signing against the local endpoint shape ----------

test('signRequest: GET, HEAD, DELETE sign the empty-body hash and pass server verification', () => {
  for (const method of ['GET', 'HEAD', 'DELETE']) {
    const out = signRequest({ ...LOCAL, method, bucket: 'originals', key: KEY.replace(/raw$/, 'canonical.jpg'), now: NOW });
    assert.equal(out.url, `http://127.0.0.1:55421/storage/v1/s3/originals/${KEY.replace(/raw$/, 'canonical.jpg')}`);
    assert.equal(out.headers.host, '127.0.0.1:55421');
    assert.equal(out.headers['x-amz-date'], '20260930T140506Z');
    assert.equal(out.headers['x-amz-content-sha256'], sha256Hex(''));
    assert.match(out.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key-id\/20260930\/local\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=[0-9a-f]{64}$/);
    const chk = serverCheck({ method, url: out.url, headers: out.headers, secret: LOCAL.secretAccessKey, region: 'local' });
    assert.equal(chk.expected, chk.provided);
  }
});

test('signRequest: PUT hashes the body and signs caller headers', () => {
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const out = signRequest({ ...LOCAL, method: 'PUT', bucket: 'variants', key: 'a/b/c/thumb.jpg', headers: { 'Content-Type': 'image/jpeg' }, body, now: NOW });
  assert.equal(out.headers['x-amz-content-sha256'], createHash('sha256').update(body).digest('hex'));
  assert.equal(out.headers['content-type'], 'image/jpeg');
  assert.match(out.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
  const chk = serverCheck({ method: 'PUT', url: out.url, headers: out.headers, secret: LOCAL.secretAccessKey, region: 'local' });
  assert.equal(chk.expected, chk.provided);
});

test('signRequest: a caller-supplied x-amz-content-sha256 is the signed payload hash', () => {
  const out = signRequest({ ...LOCAL, method: 'PUT', bucket: 'b', key: 'k', headers: { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' }, now: NOW });
  assert.equal(out.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.match(sigv4({ ...LOCAL, method: 'PUT', bucket: 'b', key: 'k', payloadHash: 'UNSIGNED-PAYLOAD', now: NOW }).canonicalRequest, /\nUNSIGNED-PAYLOAD$/);
});

test('signRequest: ListObjectsV2 is a GET on the bucket with an encoded, sorted query', () => {
  const out = signRequest({ ...LOCAL, method: 'GET', bucket: 'incoming', query: { prefix: 'a b/', 'list-type': '2' }, now: NOW });
  assert.equal(out.url, 'http://127.0.0.1:55421/storage/v1/s3/incoming?list-type=2&prefix=a%20b%2F');
  const empty = signRequest({ ...LOCAL, method: 'GET', bucket: 'incoming', query: { 'list-type': '2', prefix: '' }, now: NOW });
  assert.equal(empty.url, 'http://127.0.0.1:55421/storage/v1/s3/incoming?list-type=2&prefix=');
  for (const o of [out, empty]) {
    const chk = serverCheck({ method: 'GET', url: o.url, headers: o.headers, secret: LOCAL.secretAccessKey, region: 'local' });
    assert.equal(chk.expected, chk.provided);
  }
  const creq = sigv4({ ...LOCAL, method: 'GET', bucket: 'incoming', query: { 'list-type': '2', prefix: '' }, payloadHash: sha256Hex(''), now: NOW }).canonicalRequest;
  assert.equal(creq.split('\n').slice(0, 3).join('\n'), 'GET\n/storage/v1/s3/incoming\nlist-type=2&prefix=');
});

test('signRequest: endpoint trailing slashes and default ports do not change the signed host or path', () => {
  const a = signRequest({ ...LOCAL, endpoint: 'https://proj.supabase.co/storage/v1/s3/', method: 'HEAD', bucket: 'b', key: 'k', now: NOW });
  const b = signRequest({ ...LOCAL, endpoint: 'https://proj.supabase.co:443/storage/v1/s3', method: 'HEAD', bucket: 'b', key: 'k', now: NOW });
  assert.equal(a.url, 'https://proj.supabase.co/storage/v1/s3/b/k');
  assert.equal(a.url, b.url);
  assert.equal(a.headers.host, 'proj.supabase.co');
  assert.equal(a.headers.authorization, b.headers.authorization);
});

test('key encoding follows the SigV4 UriEncode rules', () => {
  assert.equal(uriEncode("AZaz09-._~ !'()*/+=&é"), 'AZaz09-._~%20%21%27%28%29%2A%2F%2B%3D%26%C3%A9');
  assert.equal(encodeKey('dir one/test$file.text/😀'), 'dir%20one/test%24file.text/%F0%9F%98%80');
  assert.equal(encodeKey('a//b/'), 'a//b/');
});

test('missing region or credentials fail without echoing any value', () => {
  for (const missing of ['region', 'accessKeyId', 'secretAccessKey']) {
    const input = { ...LOCAL, [missing]: '', method: 'GET', bucket: 'b', key: 'k' };
    assert.throws(() => signRequest(input), (e) => e instanceof Error && !e.message.includes('test-secret-access-key') && /credentials/.test(e.message));
  }
  assert.throws(() => signRequest({ ...LOCAL, method: 'GET', bucket: 'b', key: 'k', now: new Date('nope') }), /invalid time/);
});
