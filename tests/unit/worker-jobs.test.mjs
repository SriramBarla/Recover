// Job modules against fakes: deletion-ledger binding (F-75, §9.6), screening flows (§10.4, §10.5),
// orphan reconciliation (§9.7), and variant paths (§9.4, F-98).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PublicError } from '@recover/shared/errors.ts';
import { PermanentError, RetryableError } from '../../apps/worker/lib/jobs/errors.ts';
import * as deleteMedia from '../../apps/worker/lib/jobs/delete_media.ts';
import * as screenItem from '../../apps/worker/lib/jobs/screen_item.ts';
import * as reconcileOrphans from '../../apps/worker/lib/jobs/reconcile_orphan_uploads.ts';
import * as makeVariants from '../../apps/worker/lib/jobs/make_variants.ts';
import * as canonicalizeMapJob from '../../apps/worker/lib/jobs/canonicalize_map.ts';
import * as deleteMapDraft from '../../apps/worker/lib/jobs/delete_map_draft.ts';
import * as purge from '../../apps/worker/lib/jobs/purge.ts';
import { createVision } from '../../apps/worker/lib/media/vision.ts';
import { canonicalize } from '../../apps/worker/lib/media/canonicalize.ts';
import { solidJpeg } from '../fuzz/media/corpus.mjs';

const SCHOOL = '11111111-1111-4111-8111-111111111111';
const OTHER_SCHOOL = '99999999-9999-4999-8999-999999999999';
const ITEM = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const BASE = `${SCHOOL}/${ITEM}/${PHOTO}`;
const TOKEN = 'ab'.repeat(16);

function memStorage(initial = {}, { pageSize = 1000 } = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, { bytes: Buffer.from(v.bytes ?? 'x'), lastModified: v.lastModified ?? new Date() }]));
  const ops = [];
  const k = (b, key) => `${b}/${key}`;
  const listing = (b) =>
    [...objects.entries()]
      .filter(([key]) => key.startsWith(`${b}/`))
      .map(([key, o]) => ({ key: key.slice(b.length + 1), lastModified: o.lastModified, bytes: o.bytes.length }))
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return {
    objects,
    ops,
    // ListObjectsV2 in key order; the continuation token is the last key returned (like start-after), so
    // deleting listed keys never shifts the next page.
    async listPage(b, _prefix, { token = null, maxKeys = pageSize } = {}) {
      ops.push(['listPage', b, token]);
      const rest = listing(b).filter((o) => token === null || o.key > token);
      const page = rest.slice(0, Math.min(maxKeys, pageSize));
      return { objects: page, nextToken: rest.length > page.length ? page.at(-1).key : null };
    },
    async getBytes(b, key) {
      ops.push(['get', k(b, key)]);
      const o = objects.get(k(b, key));
      return o ? Buffer.from(o.bytes) : null;
    },
    async head(b, key) {
      ops.push(['head', k(b, key)]);
      const o = objects.get(k(b, key));
      return o ? { exists: true, bytes: o.bytes.length, contentType: 'image/jpeg' } : { exists: false, bytes: null, contentType: null };
    },
    async put(b, key, bytes) {
      ops.push(['put', k(b, key)]);
      objects.set(k(b, key), { bytes: Buffer.from(bytes), lastModified: new Date() });
    },
    async del(b, key) {
      ops.push(['del', k(b, key)]);
      objects.delete(k(b, key));
    },
    async list(b) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(`${b}/`))
        .map(([key, o]) => ({ key: key.slice(b.length + 1), lastModified: o.lastModified, bytes: o.bytes.length }));
    },
  };
}

function ctxWith(handlers, storage, over = {}) {
  const calls = [];
  const sys = async (name, args = {}) => {
    calls.push({ name, args });
    const h = handlers[name];
    if (!h) throw new Error(`unexpected system call ${name}`);
    return h(args);
  };
  const ctx = {
    sys,
    storage,
    vision: createVision({ mode: 'mock' }),
    matcher: null,
    log: () => {},
    deadline: Date.now() + 50_000,
    workerId: 'w',
    job: { id: 1, kind: 'x', payload: {}, schoolId: SCHOOL, attempts: 1, maxAttempts: 5 },
    ...over,
  };
  return { ctx, calls };
}

// ---------- delete_media ----------

const photoRow = (over = {}) => ({
  photoId: PHOTO,
  itemId: ITEM,
  schoolId: SCHOOL,
  status: 'public_ready',
  incomingPath: null,
  originalPath: `${BASE}/canonical.jpg`,
  reviewPath: `${BASE}/review.jpg`,
  thumbPath: `${BASE}/${TOKEN}/thumb.jpg`,
  mediumPath: `${BASE}/${TOKEN}/medium.jpg`,
  publicObjectToken: TOKEN,
  isCurrent: true,
  ...over,
});

const ledgerRows = () => [
  { photoId: PHOTO, objectKind: 'original', bucket: 'originals', storagePath: `${BASE}/canonical.jpg`, deletedAt: null, verifiedAt: null },
  { photoId: PHOTO, objectKind: 'review', bucket: 'originals', storagePath: `${BASE}/review.jpg`, deletedAt: null, verifiedAt: null },
  { photoId: PHOTO, objectKind: 'thumb', bucket: 'variants', storagePath: `${BASE}/${TOKEN}/thumb.jpg`, deletedAt: null, verifiedAt: null },
  { photoId: PHOTO, objectKind: 'medium', bucket: 'variants', storagePath: `${BASE}/${TOKEN}/medium.jpg`, deletedAt: null, verifiedAt: null },
];

function deletionWorld(rows, photo = photoRow()) {
  const storage = memStorage({
    [`originals/${BASE}/canonical.jpg`]: {},
    [`originals/${BASE}/review.jpg`]: {},
    [`variants/${BASE}/${TOKEN}/thumb.jpg`]: {},
    [`variants/${BASE}/${TOKEN}/medium.jpg`]: {},
    [`originals/${OTHER_SCHOOL}/${ITEM}/${PHOTO}/canonical.jpg`]: {},
  });
  const done = [];
  let verified = 0;
  const { ctx, calls } = ctxWith(
    {
      system_deletion_objects: () => ({ objects: rows }),
      system_get_photo: () => photo,
      system_deletion_object_done: (a) => {
        done.push(a);
        const row = rows.find((r) => r.objectKind === a.p_object_kind);
        if (a.p_verified) row.verifiedAt = 'now';
        return { ok: true };
      },
      system_media_ledger_verified: () => {
        verified++;
        return { ok: true };
      },
    },
    storage,
  );
  return { ctx, calls, storage, done, verifiedCount: () => verified };
}

test('delete_media: deletes, verifies absent with HEAD, then closes the ledger; a replay is a no-op', async () => {
  const w = deletionWorld(ledgerRows());
  await deleteMedia.run({ ledgerId: 42 }, w.ctx);
  assert.equal(w.done.length, 4);
  assert.ok(w.done.every((a) => a.p_verified === true && a.p_ledger_id === 42));
  assert.equal(w.verifiedCount(), 1);
  assert.deepEqual([...w.storage.objects.keys()], [`originals/${OTHER_SCHOOL}/${ITEM}/${PHOTO}/canonical.jpg`]);
  const opsBefore = w.storage.ops.length;
  await deleteMedia.run({ ledgerId: 42 }, w.ctx);
  assert.equal(w.storage.ops.length, opsBefore, 'verified rows are not touched again');
  assert.equal(w.verifiedCount(), 2, 'closing the ledger is idempotent in SQL');
});

test('delete_media: a forged ledger path is refused before any storage call (F-75)', async () => {
  const forged = ledgerRows();
  forged[2] = { ...forged[2], objectKind: 'original', bucket: 'originals', storagePath: `${OTHER_SCHOOL}/${ITEM}/${PHOTO}/canonical.jpg` };
  const w = deletionWorld(forged);
  await assert.rejects(deleteMedia.run({ ledgerId: 7 }, w.ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
  assert.deepEqual(w.storage.ops.filter(([op]) => op === 'del'), [], 'nothing deleted');
  assert.equal(w.storage.objects.size, 5);
});

test('delete_media: wrong bucket, stale path, foreign school, and unknown kind are all refused', async () => {
  const cases = [
    (rows) => { rows[2].bucket = 'originals'; },
    (rows) => { rows[2].storagePath = `${BASE}/${'cd'.repeat(16)}/thumb.jpg`; }, // not the recorded token path
    (rows) => { rows[0].storagePath = `${BASE}/../canonical.jpg`; },
    (rows) => { rows[0].objectKind = 'everything'; },
  ];
  for (const mutate of cases) {
    const rows = ledgerRows();
    mutate(rows);
    const w = deletionWorld(rows);
    await assert.rejects(deleteMedia.run({ ledgerId: 1 }, w.ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
    assert.deepEqual(w.storage.ops.filter(([op]) => op === 'del'), []);
  }
  const w = deletionWorld(ledgerRows(), photoRow({ schoolId: OTHER_SCHOOL }));
  await assert.rejects(deleteMedia.run({ ledgerId: 1 }, w.ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
  await assert.rejects(deleteMedia.run({ ledgerId: 'x' }, w.ctx), (e) => e instanceof PermanentError && e.code === 'invalid_payload');
});

test('delete_media: an object still present after delete is recorded unverified and retried', async () => {
  const w = deletionWorld(ledgerRows());
  const del = w.storage.del;
  w.storage.del = async (b, key) => (key.endsWith('medium.jpg') ? undefined : del(b, key));
  await assert.rejects(deleteMedia.run({ ledgerId: 3 }, w.ctx), (e) => e instanceof RetryableError && e.code === 'deletion_unverified');
  assert.deepEqual(w.done.find((a) => a.p_object_kind === 'medium').p_verified, false);
  assert.equal(w.verifiedCount(), 0);
});

// ---------- screen_item ----------

async function screeningWorld({ budget = { allowed: true, enabled: true }, vision, job } = {}) {
  const c = await canonicalize(await solidJpeg(320, 240));
  const storage = memStorage({ [`originals/${BASE}/canonical.jpg`]: { bytes: c.jpeg } });
  const records = [];
  const { ctx, calls } = ctxWith(
    {
      system_screening_targets: () => ({ photos: [{ photoId: PHOTO, originalPath: `${BASE}/canonical.jpg` }] }),
      system_screening_budget_take: () => budget,
      system_record_screening: (a) => {
        records.push(a);
        return { ok: true };
      },
    },
    storage,
    { ...(vision ? { vision } : {}), ...(job ? { job: { id: 1, kind: 'screen_item', payload: {}, schoolId: SCHOOL, attempts: 1, maxAttempts: 5, ...job } } : {}) },
  );
  return { ctx, calls, records, storage };
}

const payload = { itemId: ITEM, policyVersion: 'p1' };

test('screen_item: mock vision records one ok run per photo from canonical bytes', async () => {
  const w = await screeningWorld();
  await screenItem.run(payload, w.ctx);
  assert.equal(w.records.length, 1);
  assert.deepEqual([w.records[0].p_status, w.records[0].p_provider, w.records[0].p_policy_version, w.records[0].p_photo_id], ['ok', 'mock', 'p1', PHOTO]);
  assert.equal(w.records[0].p_signals.nsfw, false);
});

test('screen_item: VISION_MODE=off and a disabled district switch leave the item unscreened', async () => {
  const off = await screeningWorld({ vision: createVision({ mode: 'off' }) });
  await screenItem.run(payload, off.ctx);
  assert.deepEqual(off.calls, [], 'no provider, no budget, no run');
  const disabled = await screeningWorld({ budget: { allowed: true, enabled: false } });
  await screenItem.run(payload, disabled.ctx);
  assert.deepEqual(disabled.records, []);
});

test('screen_item: over the ceiling records error runs with the ceiling flag and calls no provider (F-67)', async () => {
  let screened = 0;
  const vision = { mode: 'mock', provider: 'mock', model: 'mock-1', screen: async () => { screened++; return null; } };
  const w = await screeningWorld({ budget: { allowed: false, enabled: true }, vision });
  await screenItem.run(payload, w.ctx);
  assert.equal(screened, 0);
  assert.deepEqual(w.storage.ops, []);
  assert.deepEqual([w.records[0].p_status, w.records[0].p_signals], ['error', { ceiling: true }]);
});

test('screen_item: provider failures retry, and the last attempt records an error run (§10.4)', async () => {
  const failing = { mode: 'google', provider: 'google_vision', model: 'v1', screen: async () => { throw new RetryableError('provider_unavailable', 30); } };
  const early = await screeningWorld({ vision: failing });
  await assert.rejects(screenItem.run(payload, early.ctx), (e) => e instanceof RetryableError);
  assert.deepEqual(early.records, []);
  const last = await screeningWorld({ vision: failing, job: { attempts: 5 } });
  await screenItem.run(payload, last.ctx);
  assert.deepEqual([last.records[0].p_status, last.records[0].p_signals], ['error', { provider_unavailable: true }]);
  const rejected = { ...failing, screen: async () => { throw new PermanentError('provider_rejected'); } };
  const perm = await screeningWorld({ vision: rejected });
  await screenItem.run(payload, perm.ctx);
  assert.deepEqual(perm.records[0].p_signals, { provider_rejected: true });
});

test('screen_item: a canonical path from another school is refused', async () => {
  const w = await screeningWorld({ job: { schoolId: OTHER_SCHOOL } });
  await assert.rejects(screenItem.run(payload, w.ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
  assert.deepEqual(w.storage.ops, []);
});

// ---------- reconcile_orphan_uploads ----------

test('reconcile_orphan_uploads: deletes only objects older than 3 h that no waiting generation expects', async () => {
  const old = new Date(Date.now() - 4 * 3_600_000);
  const young = new Date(Date.now() - 30 * 60_000);
  const P = (n) => `4444444${n}-4444-4444-8444-444444444444`;
  const keys = {
    orphan: `${SCHOOL}/${ITEM}/${P(1)}/raw`,
    waiting: `${SCHOOL}/${ITEM}/${P(2)}/raw`,
    debt: `${SCHOOL}/${ITEM}/${P(3)}/raw`,
    fresh: `${SCHOOL}/${ITEM}/${P(4)}/raw`,
    moved: `${SCHOOL}/${ITEM}/${P(5)}/raw`,
    junk: `${SCHOOL}/not-our-layout`,
  };
  const storage = memStorage(
    Object.fromEntries(Object.entries(keys).map(([name, key]) => [`incoming/${key}`, { lastModified: name === 'fresh' ? young : old }])),
  );
  const rows = {
    [P(2)]: { photoId: P(2), itemId: ITEM, schoolId: SCHOOL, status: 'uploaded', incomingPath: keys.waiting },
    [P(3)]: { photoId: P(3), itemId: ITEM, schoolId: SCHOOL, status: 'canonical_ready', incomingPath: keys.debt },
    [P(4)]: { photoId: P(4), itemId: ITEM, schoolId: SCHOOL, status: 'uploaded', incomingPath: keys.fresh },
    [P(5)]: { photoId: P(5), itemId: '55555555-5555-4555-8555-555555555555', schoolId: SCHOOL, status: 'uploaded', incomingPath: 'elsewhere' },
  };
  const cleared = [];
  const { ctx } = ctxWith(
    {
      system_get_photo: (a) => {
        if (!rows[a.p_photo_id]) throw new PublicError('not_found');
        return rows[a.p_photo_id];
      },
      system_photo_incoming_cleared: (a) => {
        cleared.push(a.p_photo_id);
        return { ok: true };
      },
    },
    storage,
  );
  await reconcileOrphans.run({}, ctx);
  const left = [...storage.objects.keys()].map((k) => k.slice('incoming/'.length)).sort();
  assert.deepEqual(left, [keys.fresh, keys.waiting].sort());
  assert.deepEqual(cleared, [P(3)], 'only cleanup debt clears the DB pointer');
});

// security review L4: the sweep follows the continuation token past the first page instead of stopping there.
const orphanWorld = (n, opts) => {
  const old = new Date(Date.now() - 4 * 3_600_000);
  const key = (i) => `${SCHOOL}/${ITEM}/${String(i).padStart(8, '0')}-4444-4444-8444-444444444444/raw`;
  const storage = memStorage(Object.fromEntries(Array.from({ length: n }, (_, i) => [`incoming/${key(i)}`, { lastModified: old }])), opts);
  const logs = [];
  const { ctx } = ctxWith({ system_get_photo: () => { throw new PublicError('not_found'); } }, storage, {
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { storage, ctx, logs };
};

test('reconcile_orphan_uploads: pages through the whole bucket with the continuation token', async () => {
  const w = orphanWorld(7, { pageSize: 3 });
  await reconcileOrphans.run({}, w.ctx);
  assert.equal(w.storage.objects.size, 0, 'orphans beyond the first page are reached');
  const pages = w.storage.ops.filter((o) => o[0] === 'listPage');
  assert.equal(pages.length, 3);
  assert.equal(pages[0][2], null, 'the first page has no token');
  assert.ok(pages.slice(1).every((p) => typeof p[2] === 'string'), 'later pages pass the token');
  const done = w.logs.find((l) => l.event === 'orphans_reconciled').fields;
  assert.deepEqual([done.listed, done.pages, done.complete, done.deleted], [7, 3, true, 7]);
});

test('reconcile_orphan_uploads: stops at the time budget without starting another page', async () => {
  const w = orphanWorld(7, { pageSize: 3 });
  let now = Date.now();
  w.ctx.deadline = now + 5_000 + 2; // two units of work left before the 5 s reserve
  const realNow = Date.now;
  Date.now = () => now++;
  try {
    await reconcileOrphans.run({}, w.ctx);
  } finally {
    Date.now = realNow;
  }
  assert.ok(w.storage.objects.size > 0, 'work is left for the next hourly run');
  assert.equal(w.storage.ops.filter((o) => o[0] === 'listPage').length, 1);
  assert.equal(w.logs.find((l) => l.event === 'orphans_reconciled').fields.complete, false);
});

// ---------- make_variants ----------

test('make_variants: variants land under the token path, then publication is attempted', async () => {
  const c = await canonicalize(await solidJpeg(1600, 1200));
  const storage = memStorage({ [`originals/${BASE}/canonical.jpg`]: { bytes: c.jpeg } });
  const ready = [];
  let finalized = 0;
  const target = { photoId: PHOTO, originalPath: `${BASE}/canonical.jpg`, token: TOKEN };
  const { ctx } = ctxWith(
    {
      system_variant_targets: () => ({ photos: [target] }),
      system_photo_variants_ready: (a) => {
        ready.push(a);
        return { ok: true };
      },
      system_finalize_publish: () => {
        finalized++;
        return { published: true };
      },
    },
    storage,
  );
  await makeVariants.run({ itemId: ITEM }, ctx);
  assert.deepEqual(ready, [{ p_photo_id: PHOTO, p_thumb_path: `${BASE}/${TOKEN}/thumb.jpg`, p_medium_path: `${BASE}/${TOKEN}/medium.jpg` }]);
  assert.equal(finalized, 1);
  assert.ok(storage.objects.has(`variants/${BASE}/${TOKEN}/thumb.jpg`));

  target.token = 'not-hex';
  await assert.rejects(makeVariants.run({ itemId: ITEM }, ctx), (e) => e instanceof PermanentError && e.code === 'invalid_token');
  target.token = TOKEN;
  target.originalPath = `${SCHOOL}/55555555-5555-4555-8555-555555555555/${PHOTO}/canonical.jpg`;
  await assert.rejects(makeVariants.run({ itemId: ITEM }, ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
});

test('make_variants: published generations are never rewritten; a non-generating item is left alone', async () => {
  const c = await canonicalize(await solidJpeg(800, 600));
  const other = '66666666-6666-4666-8666-666666666666';
  const storage = memStorage({
    [`originals/${BASE}/canonical.jpg`]: { bytes: c.jpeg },
    [`originals/${SCHOOL}/${ITEM}/${other}/canonical.jpg`]: { bytes: c.jpeg },
  });
  let targets = {
    generating: true,
    schoolId: SCHOOL,
    photos: [
      { photoId: PHOTO, originalPath: `${BASE}/canonical.jpg`, token: TOKEN, status: 'public_ready' },
      { photoId: other, originalPath: `${SCHOOL}/${ITEM}/${other}/canonical.jpg`, token: 'cd'.repeat(16), status: 'canonical_ready' },
    ],
  };
  const ready = [];
  let finalized = 0;
  const { ctx } = ctxWith(
    {
      system_variant_targets: () => targets,
      system_photo_variants_ready: (a) => ready.push(a.p_photo_id),
      system_finalize_publish: () => ({ published: ++finalized > 0 }),
    },
    storage,
  );
  await makeVariants.run({ itemId: ITEM }, ctx);
  assert.deepEqual(ready, [other]);
  assert.deepEqual(storage.ops.filter(([op]) => op === 'put').map(([, k]) => k.split('/').at(-1)), ['thumb.jpg', 'medium.jpg']);
  assert.ok(storage.ops.every(([, k]) => !k.includes(TOKEN)), 'the published token path was not touched');

  targets = { ...targets, schoolId: OTHER_SCHOOL };
  await assert.rejects(makeVariants.run({ itemId: ITEM }, ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
  targets = { generating: false, photos: [] };
  const before = finalized;
  await makeVariants.run({ itemId: ITEM }, ctx);
  assert.equal(finalized, before, 'nothing to publish');
});

test('delete_media: a cancelled ledger is a no-op; a ledger naming another item is refused', async () => {
  const cancelled = deletionWorld(ledgerRows());
  cancelled.ctx.sys = async (name) => (name === 'system_deletion_objects' ? { found: false, objects: [] } : assert.fail(name));
  await deleteMedia.run({ ledgerId: 5 }, cancelled.ctx);
  assert.deepEqual(cancelled.storage.ops, []);

  const w = deletionWorld(ledgerRows());
  const inner = w.ctx.sys;
  w.ctx.sys = async (name, args) => {
    const r = await inner(name, args);
    return name === 'system_deletion_objects' ? { found: true, schoolId: SCHOOL, itemId: '77777777-7777-4777-8777-777777777777', objects: r.objects } : r;
  };
  await assert.rejects(deleteMedia.run({ ledgerId: 5 }, w.ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
  assert.deepEqual(w.storage.ops.filter(([op]) => op === 'del'), []);
});

const MAP = '88888888-8888-4888-8888-888888888888';
const mapRow = (over = {}) => ({ mapVersionId: MAP, schoolId: SCHOOL, approvalStatus: 'draft', draftPath: `${SCHOOL}/${MAP}/draft`, draftCanonicalPath: null, publicPath: null, ...over });

test('canonicalize_map: draft PNG becomes a canonical JPEG with dimensions; missing drafts retry; frozen versions are skipped', async () => {
  const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const storage = memStorage({ [`map_drafts/${SCHOOL}/${MAP}/draft`]: { bytes: png } });
  let row = mapRow();
  const ready = [];
  const { ctx } = ctxWith({ system_map_get: () => row, system_map_canonical_ready: (a) => ready.push(a) }, storage);
  await canonicalizeMapJob.run({ mapVersionId: MAP }, ctx);
  assert.deepEqual(ready, [{ p_map_version_id: MAP, p_canonical_path: `${SCHOOL}/${MAP}/canonical.jpg`, p_width: 2400, p_height: 1200 }]);
  assert.ok(storage.objects.has(`map_drafts/${SCHOOL}/${MAP}/canonical.jpg`));

  storage.objects.delete(`map_drafts/${SCHOOL}/${MAP}/draft`);
  await assert.rejects(canonicalizeMapJob.run({ mapVersionId: MAP }, ctx), (e) => e instanceof RetryableError && e.code === 'draft_missing');
  row = mapRow({ approvalStatus: 'pending_district', draftCanonicalPath: `${SCHOOL}/${MAP}/canonical.jpg` });
  await canonicalizeMapJob.run({ mapVersionId: MAP }, ctx);
  assert.equal(ready.length, 1, 'no work once the version left draft');
  row = mapRow({ draftPath: `${OTHER_SCHOOL}/${MAP}/draft` });
  await assert.rejects(canonicalizeMapJob.run({ mapVersionId: MAP }, ctx), (e) => e instanceof PermanentError && e.code === 'path_refused');
});

test('delete_map_draft: removes both private objects after activation or rejection, never during review', async () => {
  const objects = () => ({ [`map_drafts/${SCHOOL}/${MAP}/draft`]: {}, [`map_drafts/${SCHOOL}/${MAP}/canonical.jpg`]: {}, [`maps/${SCHOOL}/${MAP}/${TOKEN}.jpg`]: {} });
  for (const status of ['draft', 'pending_district']) {
    const storage = memStorage(objects());
    const { ctx, calls } = ctxWith({ system_map_get: () => mapRow({ approvalStatus: status }) }, storage);
    await deleteMapDraft.run({ mapVersionId: MAP }, ctx);
    assert.equal(storage.objects.size, 3, status);
    assert.deepEqual(calls.map((c) => c.name), ['system_map_get']);
  }
  for (const status of ['approved', 'rejected']) {
    const storage = memStorage(objects());
    let cleared = 0;
    const row = mapRow({ approvalStatus: status, draftCanonicalPath: `${SCHOOL}/${MAP}/canonical.jpg` });
    const { ctx } = ctxWith({ system_map_get: () => row, system_map_draft_deleted: () => ++cleared }, storage);
    await deleteMapDraft.run({ mapVersionId: MAP }, ctx);
    assert.deepEqual([...storage.objects.keys()], [`maps/${SCHOOL}/${MAP}/${TOKEN}.jpg`], `${status}: only the public copy remains`);
    assert.equal(cleared, 1);
  }
});

test('purge: any kind-shaped value goes to SQL, which owns the list; anything else is refused', async () => {
  const kinds = [];
  const { ctx } = ctxWith({ system_purge: (a) => { kinds.push(a.p_kind); return { count: 0 }; } }, memStorage());
  await purge.run({ kind: 'map_drafts' }, ctx);
  await purge.run({ kind: 'media_tickets' }, ctx);
  assert.deepEqual(kinds, ['map_drafts', 'media_tickets']);
  for (const bad of [undefined, '', 'Jobs; drop', 'x'.repeat(41), 7]) {
    await assert.rejects(purge.run({ kind: bad }, ctx), (e) => e instanceof PermanentError && e.code === 'invalid_payload');
  }
});
