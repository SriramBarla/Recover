// Test data for the browser suites: generated photos, unique text, and API shortcuts through the
// integration harness (tests/lib/harness.mjs) when it is present. The harness arrives with the
// integration suite; until then the suites fall back to the UI or skip the step with a reason.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { eventually } from './ui.mjs';

// A plain JPEG "photo" of a bottle, built with sharp. setInputFiles attaches it in place of the camera.
export async function jpegPhoto({ width = 960, height = 720, hue = 205, label = 'water bottle' } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="hsl(${hue},30%,86%)"/>
    <rect x="${width * 0.38}" y="${height * 0.12}" width="${width * 0.24}" height="${height * 0.74}" rx="36" fill="hsl(${hue},60%,32%)"/>
    <text x="50%" y="95%" font-size="36" text-anchor="middle" font-family="Arial" fill="#222">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

const WORDS = [
  'amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'indigo', 'jasper', 'kelp',
  'lumen', 'maple', 'nectar', 'opal', 'prairie', 'quartz', 'russet', 'sierra', 'tundra', 'umber',
  'violet', 'willow', 'yarrow', 'zephyr',
];

// Letters only after the prefix: runs of digits look like phone numbers to the contact-info checks.
export function uniqueText(prefix) {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${prefix} ${pick()} ${pick()} ${pick()} ${pick()}`;
}

let harness;

// The integration harness module, or null when it is not in this checkout yet.
export function loadHarness() {
  harness ??= import('../../lib/harness.mjs').catch((e) => {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  });
  return harness;
}

export const NO_HARNESS = 'tests/lib/harness.mjs is not in this checkout yet (it comes with the integration suite)';

// A pending student item made through the student API, exactly as the wizard makes it: draft,
// presigned PUT, complete (§5.1 step 6). Then one worker drain so the photo is canonical for review.
export async function createPendingItem(h, { description, note = 'e2e staff-only note' }) {
  const code = h.SCHOOL.code;
  const student = new h.Student();
  const meta = await student.get(`/api/s/${code}/meta`);
  assert.equal(meta.status, 200, `GET meta: ${JSON.stringify(meta.data)}`);
  const map = meta.data.map;
  const draft = await student.post(`/api/s/${code}/items`, {
    category: 'bottle',
    description,
    note,
    mapVersionId: map?.versionId ?? null,
    pin: map ? { x: 0.31, y: 0.41 } : null,
    dropoffLocationId: h.SCHOOL.westOffice,
    photoCount: 1,
  });
  assert.ok([200, 201].includes(draft.status), `create draft: ${draft.status} ${JSON.stringify(draft.data)}`);
  const upload = draft.data.uploads?.[0];
  assert.ok(upload?.url, `create draft returned no upload URL: ${JSON.stringify(draft.data)}`);
  assert.equal(await h.putUpload(upload.url, await jpegPhoto({ label: 'e2e' })), 200, 'photo PUT to storage');
  const done = await student.post(`/api/s/${code}/items/${draft.data.itemId}/complete`, {});
  assert.equal(done.status, 200, `complete: ${JSON.stringify(done.data)}`);
  await h.drain(10).catch(() => {}); // without the scheduler bearer, the dev scheduler drains every 10 s
  return { itemId: draft.data.itemId, publicId: done.data.publicId, description };
}

export async function itemState(h, itemId) {
  const [row] = await h.admin()`select review_status, publication_status, custody from public.items where id = ${itemId}::uuid`;
  return row ?? null;
}

// Approves an item through the staff API and drains the worker until it is published.
export async function publishItem(h, item) {
  const code = h.SCHOOL.code;
  const reviewer = new h.Staff('reviewer.fchs@recover.test');
  await reviewer.signIn();
  const card = await eventually(
    async () => {
      const q = await reviewer.get(`/api/staff/${code}/queue`);
      return q.data?.items?.find((i) => i.id === item.itemId);
    },
    { timeout: 30_000, interval: 2_000, message: `item ${item.publicId} never reached the staff queue API` },
  );
  const r = await reviewer.post(`/api/staff/${code}/items/${item.itemId}/approve`, { rowVersion: card.rowVersion });
  assert.equal(r.status, 200, `approve: ${JSON.stringify(r.data)}`);
  await eventually(
    async () => {
      await h.drain(5).catch(() => {});
      return (await itemState(h, item.itemId))?.publication_status === 'published';
    },
    { timeout: 120_000, interval: 2_000, message: `item ${item.publicId} was approved but never published` },
  );
}
