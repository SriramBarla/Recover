// Screening signal derivation (11 Implementation guide table; F-53; G-24) and the provider modes
// (mock; Google over Workload Identity Federation with a fake fetch; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearTokenCache, createVision, deriveSignals } from '../../apps/worker/lib/media/vision.ts';
import { PermanentError, RetryableError } from '../../apps/worker/lib/jobs/errors.ts';
import { exifGpsJpeg, solidJpeg } from '../fuzz/media/corpus.mjs';

const safe = (adult, racy, violence) => ({ safeSearchAnnotation: { adult, racy, violence, spoof: 'LIKELY', medical: 'VERY_LIKELY' } });
const text = (t) => ({ fullTextAnnotation: { text: t } });

test('nsfw and nsfw_score: max ordinal of adult, racy, violence; LIKELY or above flags', () => {
  const cases = [
    [safe('VERY_UNLIKELY', 'VERY_UNLIKELY', 'VERY_UNLIKELY'), false, 0],
    [safe('UNKNOWN', 'UNLIKELY', 'VERY_UNLIKELY'), false, 1],
    [safe('POSSIBLE', 'UNLIKELY', 'VERY_UNLIKELY'), false, 2],
    [safe('VERY_UNLIKELY', 'LIKELY', 'VERY_UNLIKELY'), true, 3],
    [safe('VERY_UNLIKELY', 'VERY_UNLIKELY', 'LIKELY'), true, 3],
    [safe('VERY_LIKELY', 'VERY_UNLIKELY', 'VERY_UNLIKELY'), true, 4],
    [{}, false, 0],
  ];
  for (const [r, nsfw, score] of cases) {
    const s = deriveSignals(r);
    assert.equal(s.nsfw, nsfw, JSON.stringify(r));
    assert.equal(s.nsfw_score, score, JSON.stringify(r));
  }
  // spoof and medical are not part of the rule.
  assert.equal(deriveSignals(safe('VERY_UNLIKELY', 'VERY_UNLIKELY', 'VERY_UNLIKELY')).nsfw, false);
});

test('severe (G-24): adult or violence at VERY_LIKELY; racy never', () => {
  assert.equal(deriveSignals(safe('VERY_LIKELY', 'VERY_UNLIKELY', 'VERY_UNLIKELY')).severe, true);
  assert.equal(deriveSignals(safe('VERY_UNLIKELY', 'VERY_UNLIKELY', 'VERY_LIKELY')).severe, true);
  const racy = deriveSignals(safe('LIKELY', 'VERY_LIKELY', 'LIKELY'));
  assert.equal(racy.severe, false);
  assert.equal(racy.nsfw_score, 4, 'racy VERY_LIKELY still scores 4 and flags nsfw');
  assert.equal(racy.nsfw, true);
});

test('faces: count only detections with confidence >= 0.6', () => {
  const s = deriveSignals({ faceAnnotations: [{ detectionConfidence: 0.9 }, { detectionConfidence: 0.6 }, { detectionConfidence: 0.59 }, {}] });
  assert.equal(s.face_count, 2);
  assert.equal(s.has_face, true);
  const none = deriveSignals({ faceAnnotations: [{ detectionConfidence: 0.2 }] });
  assert.deepEqual([none.has_face, none.face_count], [false, 0]);
});

test('text: length after whitespace collapse, has_text at 8 or more', () => {
  const eight = deriveSignals(text('ab  cd\n\n ef'));
  assert.deepEqual([eight.text_char_count, eight.has_text], [8, true]);
  const seven = deriveSignals(text('  abc d e  '));
  assert.deepEqual([seven.text_char_count, seven.has_text], [7, false]);
  assert.deepEqual([deriveSignals({}).text_char_count, deriveSignals({}).has_text], [0, false]);
});

test('contact_info: phone, email, @handle, snap:, ig:, URL; plain labels do not match', () => {
  for (const t of ['call 555-123-4567', '(555) 123 4567', 'text 867-5309', 'me@example.com', 'follow @sk8r_kid', 'snap: jj', 'SNAPCHAT: jj', 'ig: jjj', 'insta:jj', 'www.example.org', 'https://x.io/a', 'find me at mysite.com']) {
    assert.equal(deriveSignals(text(t)).contact_info, true, t);
  }
  for (const t of ['Hydro Flask 32 oz', 'Property of the library', 'Size 10', 'grade 7 math']) {
    assert.equal(deriveSignals(text(t)).contact_info, false, t);
  }
});

test('name_like: two consecutive capitalized tokens outside the stopword list', () => {
  for (const t of ['Maria Lopez', 'this belongs to Jordan Smith!', 'Mr Garcia room 12', 'José Núñez']) assert.equal(deriveSignals(text(t)).name_like, true, t);
  for (const t of ['The North Face', 'Hydro Flask', 'Property Of Library', 'maria lopez', 'MARIA LOPEZ', 'Nike']) assert.equal(deriveSignals(text(t)).name_like, false, t);
});

test('OCR text never leaves deriveSignals: only booleans and counts', () => {
  const s = deriveSignals(text('Maria Lopez 555-123-4567 me@example.com'));
  const json = JSON.stringify(s);
  for (const fragment of ['Maria', 'Lopez', '555', 'example']) assert.equal(json.includes(fragment), false);
  assert.deepEqual(Object.keys(s).sort(), ['contact_info', 'face_count', 'has_face', 'has_text', 'name_like', 'nsfw', 'nsfw_score', 'severe', 'text_char_count']);
  for (const v of Object.values(s)) assert.ok(typeof v === 'boolean' || typeof v === 'number');
});

test('mock mode: deterministic clean signals, has_text only with VISION_MOCK_FLAG, canonical bytes only', async () => {
  const jpeg = await solidJpeg(64, 48);
  const clean = await createVision({ mode: 'mock' }).screen(jpeg);
  assert.equal(clean.status, 'ok');
  assert.equal(clean.provider, 'mock');
  assert.deepEqual(clean, await createVision({ mode: 'mock' }).screen(jpeg), 'deterministic');
  assert.equal(Object.entries(clean.signals).every(([, v]) => v === false || v === 0), true);
  const flagged = await createVision({ mode: 'mock', mockFlag: true }).screen(jpeg);
  assert.equal(flagged.signals.has_text, true);
  await assert.rejects(createVision({ mode: 'mock' }).screen(await exifGpsJpeg()), (e) => e instanceof PermanentError && e.code === 'not_canonical');
  assert.equal(await createVision({ mode: 'off' }).screen(jpeg), null);
});

function fakeGoogle(annotate) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization ?? null });
    if (url === 'https://sts.googleapis.com/v1/token') return Response.json({ access_token: 'federated', token_type: 'Bearer', expires_in: 3599 });
    if (url.startsWith('https://iamcredentials.googleapis.com/')) return Response.json({ accessToken: 'sa-token', expireTime: '2026-09-30T13:00:00Z' });
    if (url === 'https://vision.googleapis.com/v1/images:annotate') return annotate();
    return new Response('unexpected', { status: 500 });
  };
  return { calls, fetchImpl };
}

test('google mode: WIF exchange, cached token, one annotate call with the three features', async () => {
  clearTokenCache();
  const g = fakeGoogle(() => Response.json({ responses: [{ ...safe('VERY_UNLIKELY', 'VERY_UNLIKELY', 'VERY_UNLIKELY'), ...text('Maria Lopez') }] }));
  const now = () => Date.parse('2026-09-30T12:00:00Z');
  const v = createVision({ mode: 'google', oidcToken: 'vercel-oidc', gcp: { wifAudience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v', serviceAccountEmail: 'recover-worker@proj.iam.gserviceaccount.com' }, fetch: g.fetchImpl, now });
  const jpeg = await solidJpeg(64, 48);
  const out = await v.screen(jpeg);
  assert.equal(out.status, 'ok');
  assert.equal(out.signals.name_like, true);
  assert.equal(JSON.stringify(out).includes('Maria'), false);
  const [sts, iam, ann] = g.calls;
  assert.equal(sts.body.subjectToken, 'vercel-oidc');
  assert.equal(sts.body.grantType, 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.match(iam.url, /serviceAccounts\/recover-worker@proj\.iam\.gserviceaccount\.com:generateAccessToken$/);
  assert.equal(iam.auth, 'Bearer federated');
  assert.equal(ann.auth, 'Bearer sa-token');
  assert.deepEqual(ann.body.requests[0].features, [{ type: 'SAFE_SEARCH_DETECTION' }, { type: 'FACE_DETECTION', maxResults: 5 }, { type: 'TEXT_DETECTION' }]);
  assert.equal(Buffer.from(ann.body.requests[0].image.content, 'base64').equals(jpeg), true);
  await v.screen(jpeg);
  assert.equal(g.calls.filter((c) => c.url.includes('sts.googleapis.com')).length, 1, 'token reused until 5 min before expiry');
  clearTokenCache();
});

test('google mode: 429 and 5xx retry, 400 is permanent, partial results are kept', async () => {
  const gcp = { wifAudience: 'aud', serviceAccountEmail: 'sa@p.iam.gserviceaccount.com' };
  const jpeg = await solidJpeg(64, 48);
  const run = async (annotate) => {
    clearTokenCache();
    return createVision({ mode: 'google', oidcToken: 't', gcp, fetch: fakeGoogle(annotate).fetchImpl }).screen(jpeg);
  };
  await assert.rejects(run(() => new Response('', { status: 429, headers: { 'retry-after': '40' } })), (e) => e instanceof RetryableError && e.retryAfterS === 40);
  await assert.rejects(run(() => new Response('', { status: 503 })), (e) => e instanceof RetryableError && e.code === 'provider_unavailable');
  await assert.rejects(run(() => new Response('', { status: 400 })), (e) => e instanceof PermanentError && e.code === 'provider_rejected');
  await assert.rejects(run(() => Response.json({ responses: [{ error: { code: 14 } }] })), (e) => e instanceof RetryableError);
  await assert.rejects(run(() => Response.json({ responses: [{ error: { code: 3 } }] })), (e) => e instanceof PermanentError);
  const partial = await run(() => Response.json({ responses: [{ ...safe('VERY_UNLIKELY', 'LIKELY', 'VERY_UNLIKELY'), error: { code: 13 } }] }));
  assert.equal(partial.status, 'partial');
  assert.equal(partial.signals.nsfw, true);
  assert.deepEqual([partial.signals.missing_safe_search, partial.signals.missing_face, partial.signals.missing_text], [undefined, true, true]);
  assert.ok(Object.values(partial.signals).every((v) => typeof v === 'boolean' || typeof v === 'number'), 'scalar signals only');
  clearTokenCache();
  await assert.rejects(createVision({ mode: 'google', oidcToken: null, gcp, fetch: fakeGoogle(() => Response.json({})).fetchImpl }).screen(jpeg), (e) => e instanceof RetryableError && e.code === 'provider_auth');
  await assert.rejects(createVision({ mode: 'google', oidcToken: 't', gcp: null }).screen(jpeg), (e) => e instanceof RetryableError && e.code === 'provider_config');
});
