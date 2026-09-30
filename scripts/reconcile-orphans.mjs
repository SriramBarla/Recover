#!/usr/bin/env node
// Runbooks 12, 18 and 22: orphan storage reconciliation (§16.5 step 6; 14 retention table).
// Lists incoming, originals and variants with S3 ListObjectsV2 and compares every key with the paths
// the database still references:
//   referenced        an item_photos path column holds the key
//   pending_deletion  an unverified media_deletion_objects row holds it (delete_media owns it)
//   no_row            orphan: the <school>/<item>/<photo>/ prefix matches no item_photos row
//   unreferenced      orphan: the photo row exists but none of its columns points at this key
//   too_new           younger than --min-age-hours (uploads in flight); never touched
//   unrecognized      not a <uuid>/<uuid>/<uuid>/... key; reported, never deleted
// and the other way round, missing: a key the database references with no object behind it. Missing
// objects are never recreated from an old row (§16.5); the runbook pulls the affected items instead.
// The S3 endpoint and keys come from --worker-env, else the SUPABASE_S3_* environment variables, else
// apps/worker/.env.local (the Storage root credential: run this only where the worker key may live).
// Only --yes deletes, only orphans, at most --max-delete, each re-checked against the database first.
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { ROOT, UsageError, dryRunNote, formatTable, isMain, positiveInt, printPlan, readEnvFile, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/reconcile-orphans.mjs [--dry-run] [--bucket incoming,originals,variants] [--min-age-hours H]
                                     [--worker-env <file>] [--show-keys]
  node scripts/reconcile-orphans.mjs ... --yes [--max-delete N]      delete the orphans found
A dry run is the default. Object keys of public variants are shown with the token masked unless --show-keys.
Common options: --db <url> (else env DB_URL, .env.local, local stack), --help.`;

export const BUCKET_COLUMNS = {
  incoming: ['incoming_path'],
  originals: ['original_path', 'review_path'],
  variants: ['thumb_path', 'medium_path'],
};
export const KIND_BUCKET = { incoming: 'incoming', original: 'originals', review: 'originals', thumb: 'variants', medium: 'variants' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S3_VARS = ['SUPABASE_S3_ENDPOINT', 'SUPABASE_S3_REGION', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY'];

// ---------- S3 adapter ----------

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Minimal header-signed SigV4 (path-style, service s3, empty payload), used only when
// packages/shared/src/sigv4.ts is not available. Same call shape as its signRequest.
export function localSignRequest({ method, endpoint, region, accessKeyId, secretAccessKey, bucket, key, query = {}, now }) {
  const base = new URL(endpoint);
  let p = base.pathname.replace(/\/+$/, '');
  if (bucket) p += `/${uriEncode(bucket)}`;
  if (key) p += `/${key.split('/').map(uriEncode).join('/')}`;
  if (!p) p = '/';
  const date = new Date(now ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const payload = sha256Hex('');
  const headers = { host: base.host, 'x-amz-content-sha256': payload, 'x-amz-date': date };
  const names = Object.keys(headers).sort();
  const qs = Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [method, p, qs, ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payload].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date.slice(0, 8)), region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${hmac(kSigning, toSign).toString('hex')}`;
  return { url: `${base.protocol}//${base.host}${p}${qs ? `?${qs}` : ''}`, headers };
}

export async function loadSigner() {
  const candidates = [new URL('../packages/shared/src/sigv4.ts', import.meta.url).href, '@recover/shared/sigv4.ts'];
  for (const spec of candidates) {
    try {
      const m = await import(spec);
      if (typeof m.signRequest === 'function') return { name: 'packages/shared/src/sigv4.ts', signRequest: m.signRequest };
    } catch {
      // not merged yet (feat/shared-modules); fall through to the local signer
    }
  }
  return { name: 'local fallback in scripts/reconcile-orphans.mjs (packages/shared/src/sigv4.ts not found)', signRequest: localSignRequest };
}

export function s3Config(values = {}, env = process.env, root = ROOT) {
  let vars;
  let source;
  if (values['worker-env']) {
    vars = readEnvFile(path.resolve(values['worker-env']));
    source = values['worker-env'];
  } else if (S3_VARS.every((k) => env[k])) {
    vars = env;
    source = 'environment';
  } else {
    vars = readEnvFile(path.join(root, 'apps/worker/.env.local'));
    source = 'apps/worker/.env.local';
  }
  const missing = S3_VARS.filter((k) => !vars[k]);
  return {
    s3: { endpoint: vars.SUPABASE_S3_ENDPOINT, region: vars.SUPABASE_S3_REGION, accessKeyId: vars.SUPABASE_S3_ACCESS_KEY_ID, secretAccessKey: vars.SUPABASE_S3_SECRET_ACCESS_KEY },
    missing,
    source,
  };
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlDecode = (s) =>
  s.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g, (_, n, d, h) => (n ? XML_ENTITIES[n] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));
const tag = (s, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1] ?? null;

export function parseListObjects(xml) {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, body]) => ({
    key: xmlDecode(tag(body, 'Key') ?? ''),
    size: Number(tag(body, 'Size') ?? 0),
    lastModified: tag(body, 'LastModified'),
  }));
  const next = tag(xml, 'NextContinuationToken');
  return { objects, truncated: tag(xml, 'IsTruncated') === 'true', next: next === null ? null : xmlDecode(next) };
}

async function s3Fetch(signer, s3, request) {
  const { url, headers } = signer.signRequest({ ...s3, ...request });
  const sendable = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'host'));
  const res = await fetch(url, { method: request.method, headers: sendable });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

export async function listBucket(signer, s3, bucket) {
  const out = [];
  let token = null;
  for (let page = 0; page < 100000; page += 1) {
    const query = { 'list-type': '2', 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) };
    const r = await s3Fetch(signer, s3, { method: 'GET', bucket, query });
    if (!r.ok) throw new Error(`ListObjectsV2 on ${bucket} failed: HTTP ${r.status} ${tag(r.text, 'Code') ?? ''}`.trim());
    const parsed = parseListObjects(r.text);
    out.push(...parsed.objects);
    if (!parsed.truncated || !parsed.next) break;
    token = parsed.next;
  }
  return out;
}

// ---------- classification (pure) ----------

export function buildIndex(photos, pending) {
  const refs = { incoming: new Map(), originals: new Map(), variants: new Map() };
  const photoById = new Map();
  for (const p of photos) {
    photoById.set(String(p.id).toLowerCase(), p);
    for (const [bucket, columns] of Object.entries(BUCKET_COLUMNS)) {
      for (const c of columns) if (p[c]) refs[bucket].set(p[c], { photoId: p.id, column: c, status: p.status });
    }
  }
  const pendingKeys = { incoming: new Set(), originals: new Set(), variants: new Set() };
  for (const o of pending) if (KIND_BUCKET[o.object_kind] && o.storage_path) pendingKeys[KIND_BUCKET[o.object_kind]].add(o.storage_path);
  return { refs, photoById, pendingKeys };
}

export function classify(bucket, object, index, { now = Date.now(), minAgeMs = 24 * 3600 * 1000 } = {}) {
  if (index.refs[bucket].has(object.key)) return 'referenced';
  if (index.pendingKeys[bucket].has(object.key)) return 'pending_deletion';
  const parts = object.key.split('/');
  if (parts.length < 4 || !parts.slice(0, 3).every((s) => UUID_RE.test(s))) return 'unrecognized';
  const modified = Date.parse(object.lastModified ?? '');
  if (Number.isNaN(modified) || now - modified < minAgeMs) return 'too_new';
  const photo = index.photoById.get(parts[2]);
  if (!photo || String(photo.school_id).toLowerCase() !== parts[0] || String(photo.item_id).toLowerCase() !== parts[1]) return 'no_row';
  return 'unreferenced';
}

export function missingObjects(bucket, listedKeys, index) {
  const out = [];
  for (const [key, ref] of index.refs[bucket]) if (!listedKeys.has(key)) out.push({ bucket, ...ref });
  return out;
}

// Public variant keys carry the unguessable token in the fourth segment; mask it by default.
export function displayKey(bucket, key, showKeys) {
  if (showKeys || bucket !== 'variants') return key;
  const parts = key.split('/');
  if (parts.length >= 5) parts[3] = '<token>';
  return parts.join('/');
}

async function loadIndex(sql) {
  const photos = await sql`
    select id, item_id, school_id, status, incoming_path, original_path, review_path, thumb_path, medium_path
      from public.item_photos`;
  const pending = await sql`
    select object_kind, storage_path from public.media_deletion_objects
     where verified_at is null and storage_path is not null`;
  return buildIndex(photos, pending);
}

export async function run({ values, apply, sql, requestId, say }) {
  const buckets = values.bucket ? values.bucket.split(',').map((b) => b.trim()) : Object.keys(BUCKET_COLUMNS);
  for (const b of buckets) if (!BUCKET_COLUMNS[b]) throw new UsageError(`--bucket takes ${Object.keys(BUCKET_COLUMNS).join(', ')}`);
  const minAgeHours = positiveInt(values['min-age-hours'], 'min-age-hours', { min: 1, max: 24 * 365, fallback: 24 });
  const maxDelete = positiveInt(values['max-delete'], 'max-delete', { min: 1, max: 100000, fallback: 500 });
  const showKeys = values['show-keys'] === true;
  const { s3, missing, source } = s3Config(values);
  if (missing.length) throw new UsageError(`missing ${missing.join(', ')} (from ${source}); pass --worker-env <file> or export them`);
  const signer = await loadSigner();
  say(`storage ${new URL(s3.endpoint).origin}${new URL(s3.endpoint).pathname} (region ${s3.region}; credentials from ${source})`);
  say(`signer: ${signer.name}`);

  const opts = { now: Date.now(), minAgeMs: minAgeHours * 3600 * 1000 };
  let index = await loadIndex(sql);
  const summary = [];
  const orphans = [];
  const dangling = [];
  const unknown = [];
  for (const bucket of buckets) {
    const objects = await listBucket(signer, s3, bucket);
    const counts = { bucket, listed: objects.length, referenced: 0, pending_deletion: 0, no_row: 0, unreferenced: 0, too_new: 0, unrecognized: 0, missing: 0 };
    for (const o of objects) {
      const c = classify(bucket, o, index, opts);
      counts[c] += 1;
      if (c === 'no_row' || c === 'unreferenced') orphans.push({ bucket, key: o.key, class: c, size: o.size });
      if (c === 'unrecognized') unknown.push({ bucket, key: displayKey(bucket, o.key, showKeys) });
    }
    const gone = missingObjects(bucket, new Set(objects.map((o) => o.key)), index);
    counts.missing = gone.length;
    dangling.push(...gone);
    summary.push(counts);
  }
  console.log(formatTable(summary, ['bucket', 'listed', 'referenced', 'pending_deletion', 'no_row', 'unreferenced', 'too_new', 'unrecognized', 'missing']));
  if (unknown.length) {
    say(`${unknown.length} unrecognized key(s), never deleted by this script${unknown.length > 20 ? ' (first 20)' : ''}:`);
    console.log(formatTable(unknown.slice(0, 20), ['bucket', 'key']));
  }
  if (orphans.length) {
    say(`${orphans.length} orphan object(s) older than ${minAgeHours} h${orphans.length > 20 ? ' (first 20)' : ''}:`);
    console.log(formatTable(orphans.slice(0, 20).map((o) => ({ ...o, key: displayKey(o.bucket, o.key, showKeys) })), ['bucket', 'class', 'size', 'key']));
  }
  if (dangling.length) {
    say(`${dangling.length} referenced object(s) are missing from storage${dangling.length > 20 ? ' (first 20)' : ''}; never recreate them:`);
    console.log(formatTable(dangling.slice(0, 20).map((d) => ({ bucket: d.bucket, photo_id: d.photoId, column: d.column, photo_status: d.status })), ['bucket', 'photo_id', 'column', 'photo_status']));
    say('public_ready photos with missing variants belong to items that must be pulled (RUNBOOK.md 3, step 1)');
  }
  if (!orphans.length) {
    say('no orphans to delete');
    return 0;
  }
  const batch = orphans.slice(0, maxDelete);
  printPlan(say, [
    `re-check ${batch.length} orphan key(s) against the database, then DELETE each one that is still orphaned${orphans.length > maxDelete ? ` (${orphans.length - maxDelete} left for a later run)` : ''}`,
    `write audit_log runbook.reconcile_orphans with the counts (request_id ${requestId})`,
  ]);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }

  index = await loadIndex(sql);
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const o of batch) {
    const c = classify(o.bucket, { key: o.key, lastModified: new Date(0).toISOString() }, index, opts);
    if (c !== 'no_row' && c !== 'unreferenced') {
      skipped += 1;
      continue;
    }
    const r = await s3Fetch(signer, s3, { method: 'DELETE', bucket: o.bucket, key: o.key });
    if (r.ok || r.status === 404) deleted += 1;
    else {
      failed += 1;
      say(`delete failed in ${o.bucket}: HTTP ${r.status} ${tag(r.text, 'Code') ?? ''}`);
    }
  }
  const byBucket = (field) => Object.fromEntries(summary.map((s) => [s.bucket, s[field]]));
  await writeAudit(sql, {
    script: 'reconcile-orphans',
    action: 'runbook.reconcile_orphans',
    requestId,
    targetTable: 'storage',
    targetId: buckets.join(','),
    metadata: {
      listed: byBucket('listed'),
      orphans: Object.fromEntries(summary.map((s) => [s.bucket, s.no_row + s.unreferenced])),
      missing: byBucket('missing'),
      deleted,
      failed,
      skipped,
      min_age_hours: minAgeHours,
    },
  });
  say(`deleted ${deleted}, failed ${failed}, skipped ${skipped} (request_id ${requestId})`);
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'reconcile-orphans',
    usage: USAGE,
    options: {
      bucket: { type: 'string' }, 'min-age-hours': { type: 'string' }, 'max-delete': { type: 'string' },
      'worker-env': { type: 'string' }, 'show-keys': { type: 'boolean' },
    },
    run,
  });
}
