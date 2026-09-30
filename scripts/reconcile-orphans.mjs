#!/usr/bin/env node
// Runbooks 12, 18 and 22: storage reconciliation (§16.5 step 6; 14 retention table; D-16).
// Lists incoming, originals, variants, map_drafts and maps with S3 ListObjectsV2 and compares every
// key with the paths the database still references:
//   referenced        an item_photos or map_versions path column holds the key
//   pending_deletion  an unverified media_deletion_objects row holds it (delete_media owns it)
//   no_row            orphan: the <school>/<item>/<photo>/ or <school>/<map version>/ prefix matches no row
//   unreferenced      orphan: the row exists but none of its columns points at this key
//   too_new           younger than --min-age-hours (uploads in flight); never touched
//   unrecognized      not a key this system writes; reported, never deleted
// and the other way round, missing: a key the database references with no object behind it. Missing
// objects are never recreated from an old row (§16.5); the runbook pulls the affected items instead.
// --since <ISO> also lists EVERY object modified since then, referenced or not, beside the time its
// row last changed, so an overwritten live variant or map shows up after a credential incident.
// The S3 endpoint and keys come from --worker-env, else the SUPABASE_S3_* environment variables, else
// apps/worker/.env.local (the Storage root credential: run this only where the worker key may live).
// Only --yes deletes, only orphans, at most --max-delete. Right before each DELETE the key is looked
// up in the database again and a HEAD must show the listed object (same ETag); otherwise it is
// skipped. The audit row is written in a finally block, so partial and interrupted runs are recorded.
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { ROOT, UsageError, dryRunNote, formatTable, isMain, positiveInt, printPlan, readEnvFile, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/reconcile-orphans.mjs [--bucket incoming,originals,variants,map_drafts,maps] [--min-age-hours H]
                                     [--since <ISO time>] [--worker-env <file>] [--show-keys]
  node scripts/reconcile-orphans.mjs ... --yes [--max-delete N]      delete the orphans found
A dry run is the default. --since lists every object modified since that time, referenced or not.
Public object tokens (variants, maps) are masked unless --show-keys.
Common options: --db <url> (else env DB_URL, .env.local, local stack), --help.`;

export const BUCKETS = {
  incoming: { source: 'photos', columns: ['incoming_path'] },
  originals: { source: 'photos', columns: ['original_path', 'review_path'] },
  variants: { source: 'photos', columns: ['thumb_path', 'medium_path'] },
  map_drafts: { source: 'maps', columns: ['draft_storage_path', 'draft_canonical_path'] },
  maps: { source: 'maps', columns: ['public_storage_path'] },
};
export const KIND_BUCKET = { incoming: 'incoming', original: 'originals', review: 'originals', thumb: 'variants', medium: 'variants' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const S3_VARS = ['SUPABASE_S3_ENDPOINT', 'SUPABASE_S3_REGION', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY'];
const SUSPECT_SKEW_MS = 15 * 60 * 1000; // an object written this long after its row last changed is suspect
const isMapBucket = (bucket) => BUCKETS[bucket].source === 'maps';

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
      // not available in this checkout; fall through to the local signer
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
    etag: tag(body, 'ETag') === null ? null : xmlDecode(tag(body, 'ETag')),
  }));
  const next = tag(xml, 'NextContinuationToken');
  return { objects, truncated: tag(xml, 'IsTruncated') === 'true', next: next === null ? null : xmlDecode(next) };
}

async function s3Fetch(signer, s3, request) {
  const { url, headers } = signer.signRequest({ ...s3, ...request });
  const sendable = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'host'));
  const res = await fetch(url, { method: request.method, headers: sendable });
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text: await res.text() };
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

// The object a HEAD describes is still the one the listing saw: same ETag when both carry one,
// otherwise the same Last-Modified second and size. Anything unprovable counts as changed.
export function sameObject(listed, headers) {
  const bare = (s) => (s ? String(s).replace(/^W\//, '').replace(/"/g, '').trim() : '');
  const a = bare(listed.etag);
  const b = bare(headers.etag);
  if (a && b) return a === b;
  const lm = Date.parse(listed.lastModified ?? '');
  const hm = Date.parse(headers['last-modified'] ?? '');
  if (Number.isNaN(lm) || Number.isNaN(hm) || Math.floor(lm / 1000) !== Math.floor(hm / 1000)) return false;
  return headers['content-length'] === undefined || Number(headers['content-length']) === Number(listed.size);
}

// ---------- classification (pure) ----------

export function buildIndex(photos, pending, maps = []) {
  const refs = Object.fromEntries(Object.keys(BUCKETS).map((b) => [b, new Map()]));
  const pendingKeys = Object.fromEntries(Object.keys(BUCKETS).map((b) => [b, new Set()]));
  const photoById = new Map();
  const mapById = new Map();
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  const add = (source, row, table, status, rowTime) => {
    for (const [bucket, spec] of Object.entries(BUCKETS)) {
      if (spec.source !== source) continue;
      for (const c of spec.columns) if (row[c]) refs[bucket].set(row[c], { table, id: row.id, column: c, status, rowTime: rowTime(c) });
    }
  };
  for (const p of photos) {
    photoById.set(String(p.id).toLowerCase(), p);
    add('photos', p, 'item_photos', p.status, () => iso(p.updated_at));
  }
  for (const v of maps) {
    mapById.set(String(v.id).toLowerCase(), v);
    add('maps', v, 'map_versions', v.approval_status, (c) => (c === 'public_storage_path' ? iso(v.approved_at) : null));
  }
  for (const o of pending) if (KIND_BUCKET[o.object_kind] && o.storage_path) pendingKeys[KIND_BUCKET[o.object_kind]].add(o.storage_path);
  return { refs, photoById, mapById, pendingKeys };
}

export function classify(bucket, object, index, { now = Date.now(), minAgeMs = 24 * 3600 * 1000 } = {}) {
  if (index.refs[bucket].has(object.key)) return 'referenced';
  if (index.pendingKeys[bucket].has(object.key)) return 'pending_deletion';
  const parts = object.key.split('/');
  const idSegments = isMapBucket(bucket) ? 2 : 3;
  if (parts.length < idSegments + 1 || !parts.slice(0, idSegments).every((s) => UUID_RE.test(s))) return 'unrecognized';
  const modified = Date.parse(object.lastModified ?? '');
  if (Number.isNaN(modified) || now - modified < minAgeMs) return 'too_new';
  if (isMapBucket(bucket)) {
    const v = index.mapById.get(parts[1]);
    return v && String(v.school_id).toLowerCase() === parts[0] ? 'unreferenced' : 'no_row';
  }
  const photo = index.photoById.get(parts[2]);
  if (!photo || String(photo.school_id).toLowerCase() !== parts[0] || String(photo.item_id).toLowerCase() !== parts[1]) return 'no_row';
  return 'unreferenced';
}

// Referenced keys with no object; keys already in the unverified deletion ledger are expected to go.
export function missingObjects(bucket, listedKeys, index) {
  const out = [];
  for (const [key, ref] of index.refs[bucket]) {
    if (!listedKeys.has(key) && !index.pendingKeys[bucket].has(key)) out.push({ bucket, ...ref });
  }
  return out;
}

// Every listed object written at or after `since` (ms), whatever its class, beside the time its row
// last changed. A referenced object written well after that time may have been overwritten.
export function modifiedSince(bucket, objects, index, since, opts) {
  const out = [];
  for (const o of objects) {
    const t = Date.parse(o.lastModified ?? '');
    if (!Number.isNaN(t) && t < since) continue;
    const rowTime = index.refs[bucket].get(o.key)?.rowTime ?? null;
    const note = Number.isNaN(t)
      ? 'no timestamp'
      : rowTime !== null && t > Date.parse(rowTime) + SUSPECT_SKEW_MS ? 'written after its row' : '';
    out.push({ bucket, key: o.key, class: classify(bucket, o, index, opts), last_modified: o.lastModified, row_time: rowTime, note });
  }
  return out;
}

// Public object keys carry an unguessable token; mask it by default.
export function displayKey(bucket, key, showKeys) {
  if (showKeys) return key;
  const parts = key.split('/');
  if (bucket === 'variants' && parts.length >= 5) parts[3] = '<token>';
  else if (bucket === 'maps' && parts.length >= 3) parts[parts.length - 1] = parts[parts.length - 1].replace(/^[^.]+/, '<token>');
  return parts.join('/');
}

async function loadIndex(sql) {
  const photos = await sql`
    select id, item_id, school_id, status, updated_at, incoming_path, original_path, review_path, thumb_path, medium_path
      from public.item_photos`;
  const pending = await sql`
    select object_kind, storage_path from public.media_deletion_objects
     where verified_at is null and storage_path is not null`;
  const maps = await sql`
    select id, school_id, approval_status, approved_at, draft_storage_path, draft_canonical_path, public_storage_path
      from public.map_versions`;
  return buildIndex(photos, pending, maps);
}

// The rows that could hold this one key right now: its own photo or map version row, any row that
// points at the key, and unverified ledger entries for it. Orphan keys always carry uuid segments.
async function freshIndexFor(sql, bucket, key) {
  const parts = key.split('/');
  if (isMapBucket(bucket)) {
    const maps = await sql`
      select id, school_id, approval_status, approved_at, draft_storage_path, draft_canonical_path, public_storage_path
        from public.map_versions
       where id = ${parts[1]}::uuid or draft_storage_path = ${key} or draft_canonical_path = ${key} or public_storage_path = ${key}`;
    return buildIndex([], [], maps);
  }
  const photos = await sql`
    select id, item_id, school_id, status, updated_at, incoming_path, original_path, review_path, thumb_path, medium_path
      from public.item_photos
     where id = ${parts[2]}::uuid or incoming_path = ${key} or original_path = ${key} or review_path = ${key}
        or thumb_path = ${key} or medium_path = ${key}`;
  const pending = await sql`
    select object_kind, storage_path from public.media_deletion_objects where storage_path = ${key} and verified_at is null`;
  return buildIndex(photos, pending, []);
}

// Deletes orphans one at a time, updating `counts` in place so the caller can audit a partial run.
// Before each DELETE: a fresh database lookup must still classify the key as an orphan (with its
// listed age), and a HEAD must show the listed object; otherwise the key is skipped.
export async function deleteOrphans({ batch, lookup, send, opts, say, counts, shouldStop = () => false }) {
  for (const o of batch) {
    if (shouldStop()) break;
    const now = classify(o.bucket, o, await lookup(o.bucket, o.key), opts);
    if (now !== 'no_row' && now !== 'unreferenced') {
      counts.skipped_not_orphan += 1;
      continue;
    }
    const head = await send({ method: 'HEAD', bucket: o.bucket, key: o.key });
    if (head.status === 404) {
      counts.skipped_gone += 1;
      continue;
    }
    if (!head.ok) {
      counts.failed += 1;
      say(`HEAD failed in ${o.bucket}: HTTP ${head.status}; not deleted`);
      continue;
    }
    if (!sameObject(o, head.headers)) {
      counts.skipped_changed += 1;
      continue;
    }
    const r = await send({ method: 'DELETE', bucket: o.bucket, key: o.key });
    if (r.ok || r.status === 404) {
      counts.deleted += 1;
    } else {
      counts.failed += 1;
      say(`delete failed in ${o.bucket}: HTTP ${r.status} ${tag(r.text, 'Code') ?? ''}`.trim());
    }
  }
  return counts;
}

export async function run({ values, apply, sql, requestId, say }) {
  const buckets = values.bucket ? values.bucket.split(',').map((b) => b.trim()) : Object.keys(BUCKETS);
  for (const b of buckets) if (!Object.hasOwn(BUCKETS, b)) throw new UsageError(`--bucket takes ${Object.keys(BUCKETS).join(', ')}`);
  const minAgeHours = positiveInt(values['min-age-hours'], 'min-age-hours', { min: 1, max: 24 * 365, fallback: 24 });
  const maxDelete = positiveInt(values['max-delete'], 'max-delete', { min: 1, max: 100000, fallback: 500 });
  const showKeys = values['show-keys'] === true;
  let since = null;
  if (values.since !== undefined) {
    since = Date.parse(values.since);
    if (!ISO_RE.test(values.since) || Number.isNaN(since)) throw new UsageError('--since takes an ISO time such as 2026-09-29T18:00:00Z');
  }
  const { s3, missing, source } = s3Config(values);
  if (missing.length) throw new UsageError(`missing ${missing.join(', ')} (from ${source}); pass --worker-env <file> or export them`);
  const signer = await loadSigner();
  const send = (request) => s3Fetch(signer, s3, request);
  say(`storage ${new URL(s3.endpoint).origin}${new URL(s3.endpoint).pathname} (region ${s3.region}; credentials from ${source})`);
  say(`signer: ${signer.name}`);

  const opts = { now: Date.now(), minAgeMs: minAgeHours * 3600 * 1000 };
  const index = await loadIndex(sql);
  const summary = [];
  const orphans = [];
  const dangling = [];
  const unknown = [];
  const recent = [];
  for (const bucket of buckets) {
    const objects = await listBucket(signer, s3, bucket);
    const counts = { bucket, listed: objects.length, referenced: 0, pending_deletion: 0, no_row: 0, unreferenced: 0, too_new: 0, unrecognized: 0, missing: 0 };
    for (const o of objects) {
      const c = classify(bucket, o, index, opts);
      counts[c] += 1;
      if (c === 'no_row' || c === 'unreferenced') orphans.push({ bucket, ...o, class: c });
      if (c === 'unrecognized') unknown.push({ bucket, key: displayKey(bucket, o.key, showKeys) });
    }
    if (since !== null) recent.push(...modifiedSince(bucket, objects, index, since, opts));
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
  if (since !== null) {
    const suspects = recent.filter((r) => r.note);
    say(`${recent.length} object(s) modified since ${values.since}, every one listed (${suspects.length} flagged):`);
    if (recent.length) console.log(formatTable(recent.map((r) => ({ ...r, key: displayKey(r.bucket, r.key, showKeys) })), ['bucket', 'class', 'last_modified', 'row_time', 'note', 'key']));
    if (suspects.length) say('"written after its row": the object changed long after the database last touched it; treat it as possibly overwritten (RUNBOOK.md 22)');
  }
  if (orphans.length) {
    say(`${orphans.length} orphan object(s) older than ${minAgeHours} h${orphans.length > 20 ? ' (first 20)' : ''}:`);
    console.log(formatTable(orphans.slice(0, 20).map((o) => ({ ...o, key: displayKey(o.bucket, o.key, showKeys) })), ['bucket', 'class', 'size', 'key']));
  }
  if (dangling.length) {
    say(`${dangling.length} referenced object(s) are missing from storage${dangling.length > 20 ? ' (first 20)' : ''}; never recreate them:`);
    console.log(formatTable(dangling.slice(0, 20).map((d) => ({ bucket: d.bucket, row: `${d.table} ${d.id}`, column: d.column, status: d.status })), ['bucket', 'row', 'column', 'status']));
    if (dangling.some((d) => d.bucket === 'variants' && d.status === 'public_ready')) {
      say('public_ready photos with missing variants belong to items that must be pulled (RUNBOOK.md 3, step 1)');
    }
    if (dangling.some((d) => d.bucket === 'maps')) say('an approved map with a missing public object needs a new version (RUNBOOK.md 6 and 19)');
  }
  if (!orphans.length) {
    say('no orphans to delete');
    return 0;
  }
  const batch = orphans.slice(0, maxDelete);
  printPlan(say, [
    `for each of ${batch.length} orphan key(s): look it up in the database again and HEAD it; DELETE it only if it is still an orphan and still the listed object${orphans.length > maxDelete ? ` (${orphans.length - maxDelete} left for a later run)` : ''}`,
    `write audit_log runbook.reconcile_orphans with the counts, also for a partial run (request_id ${requestId})`,
  ]);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }

  const counts = { deleted: 0, failed: 0, skipped_not_orphan: 0, skipped_changed: 0, skipped_gone: 0 };
  let interrupted = false;
  let aborted = false;
  let audited = false;
  const onSigint = () => {
    interrupted = true;
    say('interrupted: stopping after the current object; the audit row is still written');
  };
  process.once('SIGINT', onSigint);
  try {
    await deleteOrphans({ batch, lookup: (bucket, key) => freshIndexFor(sql, bucket, key), send, opts, say, counts, shouldStop: () => interrupted });
  } catch (e) {
    aborted = true;
    throw e;
  } finally {
    process.removeListener('SIGINT', onSigint);
    const byBucket = (field) => Object.fromEntries(summary.map((s) => [s.bucket, s[field]]));
    try {
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
          ...counts,
          attempted: batch.length,
          interrupted,
          aborted,
          min_age_hours: minAgeHours,
          ...(since !== null ? { since: new Date(since).toISOString(), modified_since: recent.length } : {}),
        },
      });
      audited = true;
    } catch (e) {
      say(`ERROR: the audit row could not be written (${e.message}); record these counts by hand`);
    }
    say(`deleted ${counts.deleted}, failed ${counts.failed}, skipped ${counts.skipped_not_orphan} no longer orphans, ${counts.skipped_changed} changed, ${counts.skipped_gone} gone${interrupted ? ' (interrupted)' : ''} (request_id ${requestId})`);
  }
  return counts.failed || interrupted || !audited ? 1 : 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'reconcile-orphans',
    usage: USAGE,
    options: {
      bucket: { type: 'string' }, 'min-age-hours': { type: 'string' }, 'max-delete': { type: 'string' },
      since: { type: 'string' }, 'worker-env': { type: 'string' }, 'show-keys': { type: 'boolean' },
    },
    run,
  });
}
