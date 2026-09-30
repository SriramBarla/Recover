// End-to-end: student post -> canonicalize -> staff approve -> publish -> lost-report match ->
// receive -> claim -> verified media deletion (doctrine rules 2, 3, 6; Appendix F; §22 integration row).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { OTHER_SCHOOL, SCHOOL, Staff, Student, admin, closeAdmin, drain, hasExif, makePhoto, putUpload, stackIsUp } from '../lib/harness.mjs';

const PUBLIC_ITEM_KEYS = ['category', 'custody', 'description', 'foundAt', 'id', 'location', 'locationId', 'photos', 'publicId', 'receivedAt', 'rowVersion', 'zoneName'];
const FORBIDDEN_KEYS = /pin|note|device|digest|screening|reviewer|reviewed|staff|path|token/i;

function assertNoForbiddenKeys(obj, where) {
  const walk = (o, trail) => {
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (k !== 'thumbUrl' && k !== 'mediumUrl') assert.doesNotMatch(k, FORBIDDEN_KEYS, `${where}: forbidden key ${trail}.${k}`);
        walk(v, `${trail}.${k}`);
      }
    }
  };
  walk(obj, where);
}

const up = await stackIsUp();

describe('student post to verified deletion', { skip: up ? false : 'local stack not running (supabase start, dev-env, npm run dev)' }, () => {
  const finder = new Student();
  const loser = new Student();
  const reviewer = new Staff('reviewer.fchs@recover.test');
  const office = new Staff('office.fchs@recover.test');
  const state = {};

  before(async () => {
    await reviewer.signIn();
    await office.signIn();
  });
  after(closeAdmin);

  it('meta exposes the approved map, locations and zones, but no private fields', async () => {
    const r = await finder.get(`/api/s/${SCHOOL.code}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    state.meta = r.data;
    assert.equal(r.data.school.code, SCHOOL.code);
    assert.ok(r.data.map?.versionId, 'active map present');
    assert.ok(r.data.locations.length >= 2);
    assert.ok(r.data.zones.length >= 1);
  });

  it('creates a draft and returns presigned uploads', async () => {
    const r = await finder.post(`/api/s/${SCHOOL.code}/items`, {
      category: 'bottle',
      description: 'navy metal water bottle with stickers',
      note: 'C214 near the window',
      mapVersionId: state.meta.map.versionId,
      pin: { x: 0.31, y: 0.41 },
      dropoffLocationId: SCHOOL.westOffice,
      photoCount: 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.uploads.length, 2);
    state.itemId = r.data.itemId;
    state.uploads = r.data.uploads;
  });

  it('uploads two photos (with GPS EXIF) straight to storage', async () => {
    for (const [i, u] of state.uploads.entries()) {
      const status = await putUpload(u.url, await makePhoto({ hue: 210 + i * 30, label: `bottle ${i}` }));
      assert.equal(status, 200, `upload ${i}`);
    }
  });

  it('completes: public id, next-school-day deadline, canonicalization queued', async () => {
    const r = await finder.post(`/api/s/${SCHOOL.code}/items/${state.itemId}/complete`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.publicId, /^FCHS-W-\d{6}$/);
    assert.ok(r.data.arrivalDeadlineAt, 'deadline computed from the calendar');
    state.publicId = r.data.publicId;
    const again = await finder.post(`/api/s/${SCHOOL.code}/items/${state.itemId}/complete`, {});
    assert.equal(again.data.publicId, state.publicId, 'complete is idempotent');
  });

  it('another device cannot read the item status', async () => {
    const r = await loser.get(`/api/s/${SCHOOL.code}/items/${state.itemId}/status`);
    assert.equal(r.status, 404);
  });

  it('the worker canonicalizes (metadata stripped) and screens', async () => {
    await drain();
    const photos = await admin()`select status, original_path, incoming_path from public.item_photos where item_id = ${state.itemId}::uuid`;
    assert.equal(photos.length, 2);
    for (const p of photos) {
      assert.equal(p.status, 'canonical_ready');
      assert.equal(p.incoming_path, null, 'raw upload deleted and pointer cleared (F-110)');
    }
    const [item] = await admin()`select review_status, screening_status from public.items where id = ${state.itemId}::uuid`;
    assert.equal(item.review_status, 'pending');
    assert.notEqual(item.screening_status, 'unscreened');
  });

  it('pending items are invisible to students', async () => {
    const r = await finder.get(`/api/s/${SCHOOL.code}/items/${state.publicId}`);
    assert.equal(r.status, 404);
  });

  it('reviewer sees it in the queue and the review image is canonical', async () => {
    const q = await reviewer.get(`/api/staff/${SCHOOL.code}/queue`);
    assert.equal(q.status, 200, JSON.stringify(q.data));
    const card = q.data.items.find((i) => i.id === state.itemId);
    assert.ok(card, 'item in queue');
    state.rowVersion = card.rowVersion;
    const photo = card.photos[0];
    const res = await fetch(`http://localhost:3000/api/staff/${SCHOOL.code}/items/${state.itemId}/photos/${photo.photoId}`, {
      headers: { cookie: reviewer.jar.header() },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(hasExif(bytes), false, 'no EXIF/GPS in what reviewers see');
    const meta = await sharp(bytes).metadata();
    assert.ok(Math.max(meta.width, meta.height) <= 1600);
  });

  it('staff at another school cannot read this queue', async () => {
    const other = new Staff('admin.sfhs@recover.test');
    await other.signIn();
    const r = await other.get(`/api/staff/${SCHOOL.code}/queue`);
    assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  });

  it('approve -> generating -> variants -> published', async () => {
    const r = await reviewer.post(`/api/staff/${SCHOOL.code}/items/${state.itemId}/approve`, { rowVersion: state.rowVersion });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.publicationStatus, 'generating');
    await drain();
    const [item] = await admin()`select publication_status from public.items where id = ${state.itemId}::uuid`;
    assert.equal(item.publication_status, 'published');
  });

  it('the public listing is allowlisted and its images are served', async () => {
    const r = await finder.get(`/api/s/${SCHOOL.code}/items/${state.publicId}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const item = r.data.item ?? r.data;
    assertNoForbiddenKeys(item, 'listing');
    for (const k of Object.keys(item)) assert.ok(PUBLIC_ITEM_KEYS.includes(k) || k === 'requestId', `unexpected public key ${k}`);
    assert.equal(item.photos.length, 2);
    const img = await fetch(item.photos[0].thumbUrl);
    assert.equal(img.status, 200);
    state.thumbUrl = item.photos[0].thumbUrl;
    state.mediumUrl = item.photos[0].mediumUrl;
    const feed = await finder.get(`/api/s/${SCHOOL.code}/items`);
    assert.ok((feed.data.items ?? []).some((i) => i.publicId === state.publicId), 'item in feed');
  });

  it('a lost report from another device is matched in-app', async () => {
    const r = await loser.post(`/api/s/${SCHOOL.code}/lost-reports`, { category: 'bottle', description: 'lost my navy blue metal water bottle' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await drain();
    const mine = await loser.get(`/api/s/${SCHOOL.code}/lost-reports`);
    assert.equal(mine.status, 200);
    const report = mine.data.reports[0];
    assert.ok(report.matches.some((m) => m.publicId === state.publicId), 'published item matched the report');
    assertNoForbiddenKeys(report.matches, 'matches');
  });

  it('reviewer cannot claim; office receives and claims', async () => {
    const denied = await reviewer.post(`/api/staff/${SCHOOL.code}/items/${state.itemId}/claim`, { rowVersion: 0 });
    assert.ok([403, 409].includes(denied.status), `reviewer claim got ${denied.status}`);
    let [row] = await admin()`select row_version from public.items where id = ${state.itemId}::uuid`;
    const received = await office.post(`/api/staff/${SCHOOL.code}/items/${state.itemId}/receive`, { rowVersion: Number(row.row_version), locationId: SCHOOL.westOffice });
    assert.equal(received.status, 200, JSON.stringify(received.data));
    assert.equal(received.data.custody, 'at_location');
    [row] = await admin()`select row_version from public.items where id = ${state.itemId}::uuid`;
    const claimed = await office.post(`/api/staff/${SCHOOL.code}/items/${state.itemId}/claim`, { rowVersion: Number(row.row_version) });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
    assert.equal(claimed.data.custody, 'claimed');
    assert.equal(claimed.data.publicationStatus, 'withdrawn');
  });

  it('claimed media is deleted, verified, and no longer served', async () => {
    const gone = await finder.get(`/api/s/${SCHOOL.code}/items/${state.publicId}`);
    assert.equal(gone.status, 404, 'listing withdrawn immediately at origin');
    await drain();
    const ledgers = await admin()`select verified_at from public.media_deletion_ledger where item_id = ${state.itemId}::uuid`;
    assert.ok(ledgers.length >= 1 && ledgers.every((l) => l.verified_at), 'ledger verified');
    const photos = await admin()`select status, original_path, thumb_path, medium_path from public.item_photos where item_id = ${state.itemId}::uuid`;
    for (const p of photos) {
      assert.equal(p.status, 'deleted');
      assert.equal(p.original_path ?? p.thumb_path ?? p.medium_path, null);
    }
    for (const url of [state.thumbUrl, state.mediumUrl]) {
      const res = await fetch(`${url}?v=${Date.now()}`);
      assert.ok([400, 404].includes(res.status), `public variant still served: ${res.status}`);
    }
  });

  it('the item was never visible at another school', async () => {
    const r = await finder.get(`/api/s/${OTHER_SCHOOL.code}/items/${state.publicId}`);
    assert.equal(r.status, 404);
  });
});
