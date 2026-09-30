// Structured logging and the denylist scrubber (§17, 15 Implementation guide, contract section 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorSignature, log } from '../../packages/shared/src/log.ts';

function capture(fn) {
  const out = [];
  const err = [];
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out: out.join(''), err: err.join('') };
}

function logLine(level, event, fields) {
  const { out, err } = capture(() => log(level, event, fields));
  const text = out || err;
  assert.equal(text.split('\n').length, 2, 'exactly one line, newline-terminated');
  assert.ok(text.endsWith('\n'));
  return { text, obj: JSON.parse(text) };
}

test('writes one JSON line with ts, level, event, then fields', () => {
  const { obj, text } = logLine('info', 'request.done', {
    request_id: '6f1c2b1e-0000-4000-8000-000000000001',
    school_code: 'FCHS',
    route: 'POST /api/s/[code]/items',
    status: 201,
    duration_ms: 42,
    corr: 'k3Jd9',
    job_kind: 'canonicalize_photo',
    job_id: 17,
  });
  assert.deepEqual(Object.keys(obj).slice(0, 3), ['ts', 'level', 'event']);
  assert.match(obj.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(obj.level, 'info');
  assert.equal(obj.event, 'request.done');
  assert.equal(obj.request_id, '6f1c2b1e-0000-4000-8000-000000000001');
  assert.equal(obj.school_code, 'FCHS');
  assert.equal(obj.route, 'POST /api/s/[code]/items');
  assert.equal(obj.status, 201);
  assert.equal(obj.duration_ms, 42);
  assert.equal(obj.corr, 'k3Jd9');
  assert.equal(obj.job_kind, 'canonicalize_photo');
  assert.equal(obj.job_id, 17);
  assert.ok(!text.includes('[scrubbed]'));
});

test('debug and info go to stdout; warn and error go to stderr', () => {
  for (const level of ['debug', 'info']) {
    const { out, err } = capture(() => log(level, 'e', {}));
    assert.ok(out.length > 0 && err === '', level);
  }
  for (const level of ['warn', 'error']) {
    const { out, err } = capture(() => log(level, 'e', {}));
    assert.ok(err.length > 0 && out === '', level);
  }
});

test('a synthetic request carrying every forbidden field logs none of them', () => {
  const S = (name) => `SENTINEL_${name}_7c1e`;
  const fields = {
    request_id: 'req-1',
    description: S('description'),
    DESCRIPTION: S('DESCRIPTION'),
    note: S('note'),
    location_note_private: S('location_note_private'),
    body: S('body'),
    requestBody: { any: S('requestBody') },
    authorization: `Bearer ${S('authorization')}`,
    Authorization: S('Authorization'),
    cookie: S('cookie'),
    'Set-Cookie': S('set_cookie'),
    token: S('token'),
    accessToken: S('accessToken'),
    public_object_token: S('public_object_token'),
    password: S('password'),
    secret: S('secret'),
    secretAccessKey: S('secretAccessKey'),
    digest: S('digest'),
    deviceDigest: S('deviceDigest'),
    email: S('email'),
    staffEmail: S('staffEmail'),
    emails: [S('emails')],
    ip: S('ip'),
    IP: S('IP'),
    clientIp: S('clientIp'),
    'x-real-ip': S('x_real_ip'),
    'x-forwarded-for': S('x_forwarded_for'),
    remoteAddress: S('remoteAddress'),
    ipv6: S('ipv6'),
    IPv6: S('IPv6'),
    clientIPv6: S('clientIPv6'),
    ipAddresses: [S('ipAddresses')],
    emailAddresses: [S('emailAddresses')],
    q: S('q'),
    query: S('query'),
    searchQuery: S('searchQuery'),
    pin: { x: S('pin_x'), y: S('pin_y') },
    pin_x: S('pin_x2'),
    path: `incoming/${S('path_incoming')}`,
    storagePath: `originals/${S('path_originals')}`,
    originalPath: `0a0a/1111/2222/${S('originalPath')}`,
    incomingPaths: [`0a0a/1111/2222/${S('incomingPaths')}`],
    key: `0a0a/1111/2222/${S('key')}`,
    url: `https://proj.supabase.co/storage/v1/s3/variants/${S('url')}`,
    uploadUrl: `http://127.0.0.1:55421/storage/v1/s3/incoming/a?X-Amz-Signature=${S('signed')}`,
    'X-Amz-Date': S('x_amz_date'),
    'x-amz-security-token': S('x_amz_security_token'),
    x_amz_content_sha256: S('x_amz_content_sha256'),
    headers: { Authorization: S('nested_authorization'), cookie: S('nested_cookie'), 'content-type': 'image/jpeg' },
    items: [{ email: S('array_email'), id: 'i1' }, { description: S('array_description') }],
    deep: { a: { b: { c: { note: S('deep_note') } } } },
    raw: Buffer.from(S('buffer')),
    anywhere: `see originals/${S('value_originals')}`,
  };
  const { text, obj } = logLine('error', 'request.failed', fields);
  const leaked = [...text.matchAll(/SENTINEL_([A-Za-z_0-9]+)_7c1e/g)].map((m) => m[1]);
  assert.deepEqual(leaked, [], `leaked: ${leaked.join(', ')}`);
  assert.equal(obj.request_id, 'req-1');
  assert.equal(obj.headers['content-type'], 'image/jpeg');
  assert.equal(obj.items[0].id, 'i1');
  for (const k of ['description', 'DESCRIPTION', 'note', 'body', 'authorization', 'cookie', 'token', 'password', 'secret', 'digest', 'email', 'ip', 'q', 'query', 'path', 'X-Amz-Date', 'pin']) {
    assert.equal(obj[k], '[scrubbed]', k);
  }
});

test('short denylist words match whole words only, so near-miss keys survive', () => {
  const fields = { pinned: true, spinner: 'spin', notebookCount: 2, antibody: 'a', equipment: 'e', quality: 'good', requestId: 'r' };
  const { obj } = logLine('info', 'e', fields);
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(obj[k], v, k);
});

test('a __proto__ key is logged as a plain, scrubbed key', () => {
  const fields = JSON.parse('{"__proto__": {"description": "SENTINEL_proto_7c1e", "n": 1}, "a": 1}');
  const { text, obj } = logLine('info', 'e', fields);
  assert.ok(!text.includes('SENTINEL_proto_7c1e'));
  assert.equal(obj.a, 1);
  assert.equal(Object.getPrototypeOf({}).description, undefined, 'no prototype pollution');
});

test('route paths survive under path-like keys; private storage paths do not', () => {
  const { obj } = logLine('info', 'e', {
    path: '/api/s/FCHS/items',
    pathname: '/s/FCHS/lost',
    storagePath: '/storage/v1/s3/originals/x/y',
    thumbPath: 'a/b/c/tok/thumb.jpg',
    keyVersion: 1,
  });
  assert.equal(obj.path, '/api/s/FCHS/items');
  assert.equal(obj.pathname, '/s/FCHS/lost');
  assert.equal(obj.storagePath, '[scrubbed]');
  assert.equal(obj.thumbPath, '[scrubbed]');
  assert.equal(obj.keyVersion, 1);
});

test('fields cannot override the envelope', () => {
  const { obj } = logLine('info', 'real.event', { ts: 'fake', level: 'fake', event: 'fake', status: 200 });
  assert.equal(obj.event, 'real.event');
  assert.equal(obj.level, 'info');
  assert.notEqual(obj.ts, 'fake');
  assert.equal(obj.status, 200);
});

test('errors log their class and a code-shaped code, never the message', () => {
  const pg = Object.assign(new Error('duplicate key value (email)=(a@b.example)'), { name: 'PostgresError', code: '23505' });
  const { text, obj } = logLine('error', 'db.failed', { err: pg, other: new TypeError('secret text') });
  assert.deepEqual(obj.err, { error: 'PostgresError', code: '23505' });
  assert.deepEqual(obj.other, { error: 'TypeError' });
  assert.ok(!text.includes('a@b.example') && !text.includes('secret text'));
});

test('dates, bigints, cycles, and depth are handled without throwing', () => {
  const cyc = { name: 'loop' };
  cyc.self = cyc;
  const shared = { v: 1 };
  let deep = { leaf: true };
  for (let i = 0; i < 12; i++) deep = { deep };
  const { obj } = logLine('info', 'e', { at: new Date('2026-09-30T00:00:00Z'), big: 10n, cyc, pair: [shared, shared], deep, bad: new Date('x') });
  assert.equal(obj.at, '2026-09-30T00:00:00.000Z');
  assert.equal(obj.big, '10');
  assert.equal(obj.cyc.self, '[circular]');
  assert.deepEqual(obj.pair, [{ v: 1 }, { v: 1 }]);
  assert.equal(obj.bad, null);
  assert.ok(JSON.stringify(obj.deep).includes('[depth]'));
});

test('errorSignature is route:ErrorClass capped at 120 characters', () => {
  assert.equal(errorSignature('POST /api/s/[code]/items', new TypeError('x')), 'POST /api/s/[code]/items:TypeError');
  const pg = Object.assign(new Error('boom'), { name: 'PostgresError' });
  assert.equal(errorSignature('job:canonicalize_photo', pg), 'job:canonicalize_photo:PostgresError');
  class UploadTimeout extends Error {}
  assert.equal(errorSignature('r', new UploadTimeout('t')), 'r:UploadTimeout');
  assert.equal(errorSignature('r', new Error('plain')), 'r:Error');
  assert.equal(errorSignature('r', 'thrown string'), 'r:NonError');
  assert.equal(errorSignature('r', null), 'r:NonError');
  const long = errorSignature(`GET /${'x'.repeat(300)}`, new RangeError('r'));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(':RangeError'));
  assert.equal(errorSignature('GET /a\nb‮', new Error()), 'GET /ab:Error');
});
