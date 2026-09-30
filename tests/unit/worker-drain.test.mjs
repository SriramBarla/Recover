// Drain loop (Appendix E; 09 Implementation guide; G-33) against a fake `sys` queue and fake jobs:
// retry vs permanent classes, the 50 s budget, lease order and durations, and at-least-once replay of
// the real canonicalize_photo module (F-110 fault point after_storage_delete).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicError } from '@recover/shared/errors.ts';
import { drain } from '../../apps/worker/lib/drain.ts';
import { PermanentError, RetryableError, backoffSeconds, classify } from '../../apps/worker/lib/jobs/errors.ts';
import { MEDIA_KINDS, OTHER_KINDS, REGISTRY } from '../../apps/worker/lib/jobs/registry.ts';
import { solidJpeg } from '../fuzz/media/corpus.mjs';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), start };
}

// A tiny in-memory jobs table honoring kinds, run_after, and the done/fail contract.
function queue(jobs, clk, extra = {}) {
  const rows = jobs.map((j, i) => ({ id: i + 1, schoolId: null, maxAttempts: 5, payload: {}, attempts: 0, ...j, status: 'queued', runAfter: 0 }));
  const calls = [];
  const byId = (id) => rows.find((r) => r.id === id);
  const sys = async (name, args = {}) => {
    calls.push({ name, args });
    if (extra[name]) return extra[name](args);
    switch (name) {
      case 'system_reap_leases':
        return { requeued: 2, dead: 1 };
      case 'system_worker_heartbeat':
        return { ok: true };
      case 'system_lease_jobs': {
        const r = rows.find((j) => j.status === 'queued' && j.runAfter <= clk.now() && args.p_kinds.includes(j.kind));
        if (!r) return { jobs: [] };
        r.status = 'running';
        r.attempts += 1;
        r.leaseSeconds = args.p_lease_seconds;
        return { jobs: [{ id: r.id, kind: r.kind, payload: r.payload, schoolId: r.schoolId, attempts: r.attempts, maxAttempts: r.maxAttempts }] };
      }
      case 'system_job_done':
        byId(args.p_job_id).status = 'done';
        return { ok: true };
      case 'system_job_fail': {
        const r = byId(args.p_job_id);
        r.status = args.p_permanent ? 'dead' : 'queued';
        r.code = args.p_error_code;
        r.retryAfterS = args.p_retry_after_s;
        r.runAfter = clk.now() + args.p_retry_after_s * 1000;
        return { ok: true };
      }
      default:
        throw new Error(`unexpected system call ${name}`);
    }
  };
  return { rows, calls, sys };
}

function deps(q, clk, registry, over = {}) {
  const logs = [];
  return {
    logs,
    sys: q.sys,
    registry,
    log: (level, event, fields) => logs.push({ level, event, ...fields }),
    workerId: 'worker-test',
    now: clk.now,
    random: () => 0.5,
    ctxFor: (job, deadline) => ({ job, deadline, sys: q.sys, log: () => {}, workerId: 'worker-test' }),
    mediaKinds: [],
    otherKinds: Object.keys(registry),
    ...over,
  };
}

const job = (fn) => ({ kind: 'x', run: fn });

test('retry vs permanent: error classes map to system_job_fail with backoff or dead', async () => {
  const clk = clock();
  const registry = {
    retry: job(async () => { throw new RetryableError('provider_unavailable'); }),
    perm: job(async () => { throw new PermanentError('decode_failed'); }),
    boom: job(async () => { throw new Error('raw text with a path 1/2/3/raw'); }),
    gone: job(async () => { throw new PublicError('state_changed'); }),
    busy: job(async () => { throw new PublicError('upstream_unavailable'); }),
    ok: job(async () => {}),
  };
  const kinds = ['retry', 'perm', 'boom', 'gone', 'busy', 'ok', 'mystery'];
  const q = queue(kinds.map((kind) => ({ kind })), clk);
  const d = deps(q, clk, registry, { otherKinds: kinds });

  const first = await drain(d);
  assert.deepEqual({ ...first, durationMs: 0 }, { requeued: 2, reapedDead: 1, leased: 7, done: 1, retried: 3, dead: 3, stoppedBy: 'empty', durationMs: 0 });
  const by = Object.fromEntries(q.rows.map((r) => [r.kind, r]));
  assert.deepEqual([by.retry.status, by.retry.code], ['queued', 'provider_unavailable']);
  assert.ok(by.retry.retryAfterS >= 10 && by.retry.retryAfterS <= 12, `backoff ${by.retry.retryAfterS}`);
  assert.deepEqual([by.perm.status, by.perm.code, by.perm.retryAfterS], ['dead', 'decode_failed', 0]);
  assert.deepEqual([by.boom.status, by.boom.code], ['queued', 'unexpected'], 'unexpected errors retry once');
  assert.deepEqual([by.gone.status, by.gone.code], ['dead', 'state_changed']);
  assert.deepEqual([by.busy.status, by.busy.code], ['queued', 'upstream_unavailable']);
  assert.equal(by.ok.status, 'done');
  assert.deepEqual([by.mystery.status, by.mystery.code], ['dead', 'unknown_kind']);

  clk.advance(600_000);
  const second = await drain(d);
  assert.equal(second.leased, 3);
  assert.deepEqual([by.boom.status, by.boom.code], ['dead', 'unexpected'], 'second unexpected failure is dead');
  assert.ok(by.retry.retryAfterS >= 20 && by.retry.retryAfterS <= 24, 'backoff doubles');

  const everything = JSON.stringify([q.calls, d.logs]);
  assert.equal(everything.includes('raw text'), false, 'error messages never reach the queue or logs');
  assert.equal(everything.includes('1/2/3/raw'), false);
});

test('a retryable failure on the last attempt is dead', async () => {
  const clk = clock();
  const q = queue([{ kind: 'retry', attempts: 4, maxAttempts: 5 }], clk);
  const r = await drain(deps(q, clk, { retry: job(async () => { throw new RetryableError('provider_unavailable', 30); }) }));
  assert.equal(r.dead, 1);
  assert.equal(q.rows[0].status, 'dead');
});

test('budget: no new lease after 50 s; jobs see the 57 s deadline', async () => {
  const clk = clock();
  const deadlines = [];
  const registry = { slow: job(async (_p, ctx) => { deadlines.push(ctx.deadline); clk.advance(20_000); }) };
  const q = queue(Array.from({ length: 5 }, () => ({ kind: 'slow' })), clk);
  const r = await drain(deps(q, clk, registry));
  assert.equal(r.leased, 3, 'leases at 0 s, 20 s, 40 s; none at 60 s');
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(q.rows.filter((x) => x.status === 'queued').length, 2);
  assert.deepEqual(new Set(deadlines), new Set([clk.start + 57_000]));
});

test('one job per lease: media kinds first with 120 s, then the rest with 60 s; reap and heartbeat first', async () => {
  const clk = clock();
  const ran = [];
  const registry = { media: job(async () => ran.push('media')), other: job(async () => ran.push('other')) };
  const q = queue([{ kind: 'other' }, { kind: 'media' }], clk);
  const r = await drain(deps(q, clk, registry, { mediaKinds: ['media'], otherKinds: ['other'] }));
  assert.equal(r.done, 2);
  assert.deepEqual(ran, ['media', 'other']);
  const names = q.calls.map((c) => c.name);
  assert.deepEqual(names.slice(0, 3), ['system_reap_leases', 'system_worker_heartbeat', 'system_lease_jobs']);
  const leases = q.calls.filter((c) => c.name === 'system_lease_jobs').map((c) => c.args);
  assert.ok(leases.every((a) => a.p_limit === 1 && a.p_worker_id === 'worker-test'));
  assert.deepEqual(leases.map((a) => [a.p_kinds.join(','), a.p_lease_seconds]), [
    ['media', 120],
    ['media', 120],
    ['other', 60],
    ['media', 120],
    ['other', 60],
  ]);
  assert.deepEqual(q.rows.map((x) => x.leaseSeconds), [60, 120]);
});

test('a database failure while leasing stops the loop and keeps the counts', async () => {
  const clk = clock();
  let leases = 0;
  const q = queue([{ kind: 'ok' }, { kind: 'ok' }], clk);
  const inner = q.sys;
  q.sys = async (name, args) => {
    if (name === 'system_lease_jobs' && ++leases > 1) throw Object.assign(new Error('gone'), { code: 'ECONNRESET' });
    return inner(name, args);
  };
  const r = await drain(deps(q, clk, { ok: job(async () => {}) }));
  assert.deepEqual([r.done, r.stoppedBy], [1, 'error']);
});

test('backoff and classification tables', () => {
  assert.equal(backoffSeconds(1, null, () => 0), 10);
  assert.equal(backoffSeconds(3, null, () => 0), 40);
  assert.equal(backoffSeconds(7, null, () => 0), 300);
  assert.ok(backoffSeconds(7, null, () => 0.999) <= 360);
  assert.equal(backoffSeconds(1, 900, () => 0), 900, 'a provider Retry-After only lengthens');
  assert.deepEqual(classify(Object.assign(new Error('x'), { code: '40001' }), 3), { code: 'transient_io', permanent: false, retryAfterS: null });
  assert.deepEqual(classify(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 3), { code: 'transient_io', permanent: false, retryAfterS: null });
  assert.deepEqual(classify(Object.assign(new Error('x'), { code: '23505' }), 1), { code: 'unexpected', permanent: false, retryAfterS: null });
  assert.deepEqual(classify(new PublicError('rate_limited', '30'), 1), { code: 'rate_limited', permanent: false, retryAfterS: 30 });
  assert.deepEqual(classify(new RetryableError('Bad Code!'), 1).code, 'unexpected', 'codes are sanitized');
});

// ---------- at-least-once replay with the real canonicalize_photo module ----------

const IDS = {
  schoolId: '11111111-1111-4111-8111-111111111111',
  itemId: '22222222-2222-4222-8222-222222222222',
  photoId: '33333333-3333-4333-8333-333333333333',
};
const BASE = `${IDS.schoolId}/${IDS.itemId}/${IDS.photoId}`;

function memStorage() {
  const objects = new Map();
  const writes = [];
  const k = (b, key) => `${b}/${key}`;
  return {
    objects,
    writes,
    async getBytes(b, key, max) {
      const o = objects.get(k(b, key));
      if (!o) return null;
      if (o.bytes.length > max) throw new PermanentError('too_large');
      return Buffer.from(o.bytes);
    },
    async head(b, key) {
      const o = objects.get(k(b, key));
      return o ? { exists: true, bytes: o.bytes.length, contentType: o.contentType } : { exists: false, bytes: null, contentType: null };
    },
    async put(b, key, bytes, contentType) {
      writes.push(k(b, key));
      objects.set(k(b, key), { bytes: Buffer.from(bytes), contentType });
    },
    async del(b, key) {
      objects.delete(k(b, key));
    },
  };
}

async function world(raw, { crashAfterStorageDelete }) {
  const clk = clock();
  const storage = memStorage();
  storage.objects.set(`incoming/${BASE}/raw`, { bytes: raw, contentType: 'image/jpeg' });
  const photo = { ...IDS, status: 'uploaded', incomingPath: `${BASE}/raw`, originalPath: null, reviewPath: null, thumbPath: null, mediumPath: null, publicObjectToken: null, isCurrent: true };
  const counts = { canonicalReady: 0, cleared: 0 };
  let crash = crashAfterStorageDelete;
  const q = queue([{ kind: 'canonicalize_photo', payload: { photoId: IDS.photoId } }], clk, {
    system_get_photo: () => ({ ...photo }),
    system_photo_canonical_ready: (a) => {
      counts.canonicalReady++;
      Object.assign(photo, { status: 'canonical_ready', originalPath: a.p_original_path, reviewPath: a.p_review_path });
      return { allCanonical: true };
    },
    system_photo_incoming_cleared: () => {
      if (crash) {
        crash = false; // the process dies between the storage delete and the DB cleanup
        throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      }
      counts.cleared++;
      photo.incomingPath = null;
      return { ok: true };
    },
    system_photo_failed: () => {
      throw new Error('a replay must never fail the photo');
    },
  });
  const d = deps(q, clk, REGISTRY, {
    mediaKinds: MEDIA_KINDS,
    otherKinds: OTHER_KINDS,
    ctxFor: (job, deadline) => ({ sys: q.sys, storage, vision: null, matcher: null, log: () => {}, deadline, workerId: 'worker-test', job }),
  });
  const endState = () => ({
    photo: { ...photo },
    objects: [...storage.objects.entries()].map(([key, o]) => [key, createHash('sha256').update(o.bytes).digest('hex')]).sort(),
  });
  return { clk, q, d, photo, counts, storage, endState };
}

test('at-least-once: a crash after the storage delete, a replay, and a duplicate delivery end where one clean run ends', async () => {
  process.env.CONTENT_KEY = Buffer.alloc(32, 7).toString('base64url');
  const raw = await solidJpeg(2000, 1500);

  const clean = await world(raw, { crashAfterStorageDelete: false });
  assert.equal((await drain(clean.d)).done, 1);
  assert.equal(clean.photo.status, 'canonical_ready');
  assert.equal(clean.photo.incomingPath, null);
  assert.deepEqual([...clean.storage.objects.keys()].sort(), [`originals/${BASE}/canonical.jpg`, `originals/${BASE}/review.jpg`]);

  const faulty = await world(raw, { crashAfterStorageDelete: true });
  const crashed = await drain(faulty.d);
  assert.deepEqual([crashed.retried, faulty.q.rows[0].code], [1, 'transient_io']);
  assert.equal(faulty.photo.status, 'canonical_ready');
  assert.notEqual(faulty.photo.incomingPath, null, 'the DB pointer survived the crash');
  assert.equal(faulty.storage.objects.has(`incoming/${BASE}/raw`), false, 'the raw object was already deleted');

  faulty.clk.advance(600_000);
  assert.equal((await drain(faulty.d)).done, 1, 'replay finishes the cleanup');
  const writesAfterReplay = faulty.storage.writes.length;

  faulty.q.rows.push({ id: 99, kind: 'canonicalize_photo', payload: { photoId: IDS.photoId }, schoolId: null, attempts: 0, maxAttempts: 5, status: 'queued', runAfter: 0 });
  assert.equal((await drain(faulty.d)).done, 1, 'duplicate delivery is a no-op');

  assert.equal(faulty.counts.canonicalReady, 1, 'canonical_ready committed exactly once');
  assert.equal(faulty.storage.writes.length, writesAfterReplay, 'no storage writes on the duplicate');
  assert.deepEqual(faulty.endState(), clean.endState());
});
