// Shared helpers for the operational scripts (19-Operations-Runbooks.md, "Commands referenced by
// runbooks"; RUNBOOK.md). Every script built on runScript():
// - reads the admin DB URL from --db, then env DB_URL, then DB_URL= in the repo-root .env.local, and
//   falls back to the local stack;
// - prints exactly what it will do and acts only with --yes. A dry run is the default, and --dry-run
//   wins over --yes;
// - records each action as one audit_log row through private.audit as the postgres admin, with
//   actor_kind 'system', actor_id 'runbook:<script>' and action 'runbook.<name>'. The payload carries
//   codes and counts only and is checked here before it is sent (F-74);
// - never prints a secret value (passwords, keys, the password part of the DB URL).
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:55422/postgres';

const COMMON_OPTIONS = {
  yes: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  db: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export class UsageError extends Error {}

// ---------- arguments ----------

// Strict parse (unknown options are errors). `apply` is true only for --yes without --dry-run.
export function parseOpsArgs(argv, options = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { ...COMMON_OPTIONS, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const values = { ...parsed.values };
  return { values, positionals: parsed.positionals, apply: values.yes === true && values['dry-run'] !== true };
}

// At most one of the named action options (boolean or valued); none is the read-only default mode
// unless allowNone is false.
export function pickAction(values, names, { allowNone = true } = {}) {
  const given = names.filter((n) => values[n] !== undefined && values[n] !== false);
  if (given.length > 1) throw new UsageError(`choose one of ${names.map((n) => `--${n}`).join(', ')}`);
  if (!given.length && !allowNone) throw new UsageError(`one of ${names.map((n) => `--${n}`).join(', ')} is required`);
  return given[0] ?? null;
}

export function positiveInt(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,15}$/.test(String(value))) throw new UsageError(`--${name} must be a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}

// ---------- environment and database ----------

export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}

export function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

export function resolveDbUrl(values = {}, env = process.env, root = ROOT) {
  if (values.db) return { url: values.db, source: '--db' };
  if (env.DB_URL) return { url: env.DB_URL, source: 'env DB_URL' };
  const file = readEnvFile(path.join(root, '.env.local'));
  if (file.DB_URL) return { url: file.DB_URL, source: '.env.local' };
  return { url: LOCAL_DB_URL, source: 'default local stack' };
}

// user@host:port/db, never the password.
export function describeDb(url) {
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.username) || '(no user)'}@${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable database URL)';
  }
}

export function isLocalDb(url) {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

// TLS for the admin connection. Remote databases get verify-full (chain and host name) against the
// CA file named by PGSSLROOTCERT, the libpq variable psql also reads; download the Supabase CA from
// Dashboard > Database > SSL Configuration. PGSSLROOTCERT=system verifies against the system CAs.
// Without it the connection is encrypted but unverified ('require'), and runScript warns loudly.
// The explicit option overrides any sslmode in the URL. The local stack uses no TLS.
export const CA_ENV = 'PGSSLROOTCERT';

export function tlsFor(url, env = process.env, read = readFileSync) {
  if (isLocalDb(url)) return { ssl: false, mode: 'off (local stack)' };
  const ca = env[CA_ENV];
  if (ca === 'system') return { ssl: { rejectUnauthorized: true }, mode: 'verify-full (system CAs)' };
  if (ca) return { ssl: { ca: read(ca), rejectUnauthorized: true }, mode: `verify-full (CA ${ca})` };
  return {
    ssl: 'require',
    mode: 'require, certificate NOT verified',
    warning: `the server certificate is NOT verified (sslmode=require). Set ${CA_ENV} to the Supabase CA file `
      + '(Dashboard > Database > SSL Configuration) to connect with verify-full.',
  };
}

export function connect(url, name, tls = tlsFor(url)) {
  return postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: `recover-runbook:${name}` },
    ssl: tls.ssl,
  });
}

// ---------- audit (F-74) ----------

const FORBIDDEN_KEY_WORDS = new Set([
  'description', 'note', 'pin', 'email', 'digest', 'path', 'token', 'query', 'body', 'ocr', 'password', 'secret',
  'cookie', 'authorization', 'bearer', 'mac', 'ip', 'url',
]);
const FORBIDDEN_KEYS = new Set(['google_sub', 'display_name', 'device_token_hash', 'redacted_query']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORAGE_PATH_RE = new RegExp(`${UUID}/${UUID}/`, 'i');
const HEX_DIGEST_RE = /[0-9a-f]{64}/i;

export function keyWords(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// The data rules, applied to string values and to object keys alike: an `@`, a storage-path-like
// `<uuid>/<uuid>/` prefix, a 64-hex run (a SHA-256 or HMAC digest), three or more words (free text).
function dataRules(s) {
  const rules = [];
  if (s.includes('@')) rules.push('at_sign');
  if (STORAGE_PATH_RE.test(s)) rules.push('storage_path');
  if (HEX_DIGEST_RE.test(s)) rules.push('hex_digest');
  if (s.trim().split(/\s+/).length >= 3) rules.push('free_text');
  return rules;
}

// Every place in a JSON value that could retain personal data or a secret: forbidden key names
// (description, note, pin, email, ...), and keys or string values that break a data rule (a key
// breaking one is reported as key_<rule>). Returns [{at, rule}] and never a value; a key is shown in
// `at` only when it is a plain identifier that breaks no data rule, otherwise as <key n redacted>.
export function privacyViolations(value, at = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => privacyViolations(v, `${at}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([k, v], i) => {
      const keyRules = dataRules(k);
      const where = `${at}.${keyRules.length || !SAFE_KEY_RE.test(k) ? `<key ${i + 1} redacted>` : k}`;
      for (const rule of keyRules) out.push({ at: where, rule: `key_${rule}` });
      if (FORBIDDEN_KEYS.has(k.toLowerCase()) || keyWords(k).some((w) => FORBIDDEN_KEY_WORDS.has(w))) {
        out.push({ at: where, rule: 'forbidden_key' });
      }
      privacyViolations(v, where, out);
    });
  } else if (typeof value === 'string') {
    for (const rule of dataRules(value)) out.push({ at, rule });
  }
  return out;
}

export async function writeAudit(sql, { script, action, requestId, schoolId = null, targetTable, targetId, before = {}, after = {}, metadata = {} }) {
  if (!/^runbook\.[a-z_]+$/.test(action)) throw new Error(`audit action ${action} is not runbook.<name>`);
  for (const [label, payload] of [['state_before', before], ['state_after', after], ['metadata', metadata]]) {
    const bad = privacyViolations(payload);
    if (bad.length) throw new Error(`audit ${label} would retain ${bad[0].rule} at ${bad[0].at}; refusing (F-74)`);
  }
  // sql.json marks the parameter as jsonb; a pre-stringified value would be stored as a JSON string.
  await sql`
    select private.audit(${schoolId}::uuid, 'system', ${`runbook:${script}`}, ${requestId}::uuid, ${action},
                         ${targetTable}, ${String(targetId)}, ${sql.json(before)}, ${sql.json(after)}, ${sql.json(metadata)})`;
}

// ---------- jobs ----------

// Maintenance kinds an operator may enqueue by hand (contract section 7: payload {}, dedupe key
// <kind>:<yyyy-mm-ddThh:mi> in UTC, the same key private.enqueue_periodic uses, so a cron enqueue in
// the same minute is deduplicated).
export const PERIODIC_KINDS = [
  'expire_never_arrived', 'mark_disposition_due', 'expire_reports', 'anonymize_rejected',
  'clear_terminal_item_text', 'reconcile_generating', 'evaluate_alerts', 'purge_drafts', 'reconcile_orphan_uploads',
];

// Kinds system_lease_jobs still leases while district_settings.worker_mode = 'quarantine' (G-06).
export const QUARANTINE_KINDS = ['reconcile_generating', 'reconcile_orphan_uploads'];

// Returns the new job id, or null when the same work is already queued or running this minute.
export async function enqueuePeriodic(sql, kind) {
  if (!PERIODIC_KINDS.includes(kind)) throw new UsageError(`${kind} is not a maintenance job kind (${PERIODIC_KINDS.join(', ')})`);
  const [row] = await sql`
    select private.enqueue(${kind}::text, '{}'::jsonb, null::uuid,
                           ${kind}::text || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI')) as id`;
  return row.id === null ? null : Number(row.id);
}

// ---------- files, output, entry point ----------

// A secret must never land in the working tree, where a `git add` could publish it. Resolves
// symlinks on both sides; the parent directory must exist.
export function assertOutsideRepo(file, root = ROOT) {
  const abs = path.resolve(file);
  let dir;
  try {
    dir = realpathSync(path.dirname(abs));
  } catch {
    throw new UsageError(`directory ${path.dirname(abs)} does not exist`);
  }
  const rel = path.relative(realpathSync(root), path.join(dir, path.basename(abs)));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new UsageError(`${abs} is inside the repository; write secret files outside the working tree (for example ~/)`);
  }
  return abs;
}

// Every runbook change writes its audit row in the same transaction, so after a client-side error
// the row tells whether the commit landed anyway: true, false, or null when the lookup fails.
export async function auditLanded(sql, requestId) {
  try {
    return (await sql`select 1 from public.audit_log where request_id = ${requestId}::uuid limit 1`).length > 0;
  } catch {
    return null;
  }
}

// After a failed apply that had already written a secret file: only a confirmed "not committed"
// deletes the file. If the commit landed, or the lookup fails, the file is kept, because deleting the
// only copy of a live secret would lock the service out.
export async function settleOutFile(sql, requestId, file, say) {
  const landed = await auditLanded(sql, requestId);
  if (landed === false) {
    unlinkSync(file);
    say(`nothing was committed; removed ${file}`);
    return 'deleted';
  }
  say(landed
    ? `WARNING: the change WAS committed (audit row for request_id ${requestId} exists) although the client saw an error; ${file} holds the new secret and is kept`
    : `WARNING: could not confirm whether the change committed; ${file} is kept. Look for request_id ${requestId} in audit_log before deleting it`);
  return 'kept';
}

// Mode 600 from creation; refuses to overwrite an existing file.
export function writeSecretFile(file, text) {
  const abs = path.resolve(file);
  const fd = openSync(abs, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return abs;
}

export function printPlan(say, steps) {
  say('plan:');
  steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
}

export function dryRunNote(say) {
  say('DRY RUN: nothing was changed. Re-run with --yes to apply.');
}

export function formatTable(rows, columns) {
  const cell = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))]
    .map((l) => `  ${l}`)
    .join('\n');
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

function errorText(e) {
  if (e && typeof e === 'object' && typeof e.code === 'string' && e.severity) return `${e.message} (sqlstate ${e.code})`;
  return e instanceof Error ? e.message : String(e);
}

// run({values, positionals, apply, sql, requestId, say, name}) returns an optional exit code.
export async function runScript({ name, usage, options = {}, needsDb = true, run }) {
  const say = (line) => console.log(`${name}: ${line}`);
  let args;
  try {
    args = parseOpsArgs(process.argv.slice(2), options);
  } catch (e) {
    console.error(`${name}: ${e.message}\n\n${usage}`);
    process.exitCode = 2;
    return;
  }
  if (args.values.help) {
    console.log(usage);
    return;
  }
  const target = resolveDbUrl(args.values);
  let sql = null;
  try {
    if (needsDb) {
      const tls = tlsFor(target.url);
      if (tls.warning) {
        const bar = '*'.repeat(78);
        console.error(`${bar}\n${name}: WARNING: ${tls.warning}\n${bar}`);
      }
      sql = connect(target.url, name, tls);
      say(`database ${describeDb(target.url)} (${target.source}; TLS ${tls.mode})`);
    }
    const code = await run({ ...args, sql, requestId: randomUUID(), say, name, dbUrl: target.url });
    if (typeof code === 'number') process.exitCode = code;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${name}: ${e.message}\n\n${usage}`);
      process.exitCode = 2;
    } else {
      console.error(`${name}: error: ${errorText(e)}`);
      process.exitCode = 1;
    }
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
}
