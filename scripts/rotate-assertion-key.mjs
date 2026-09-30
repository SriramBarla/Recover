#!/usr/bin/env node
// Runbook 17: staff-assertion key rotation and emergency revocation (§14.2, D-23, O-23, G-17).
// The SQL verifier accepts only the versions named by the Vault pointers staff_assertion_key_current
// and staff_assertion_key_previous; each key lives in Vault as staff_assertion_key_v<n> (base64url of
// 32 bytes). The pointers hold version numbers, which this script prints. Key material is never printed.
//   --next       create v(N+1), current = N+1, previous = N (both verify); key file for recover-web
//   --finish     previous = '' once recover-web mints with N+1 and has been live for 60 s
//   --emergency  current = previous = '' (every staff request fails closed until --next is deployed)
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { UsageError, assertOutsideRepo, dryRunNote, isMain, pickAction, printPlan, runScript, settleOutFile, writeAudit, writeSecretFile } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/rotate-assertion-key.mjs                              show the pointers and stored versions
  node scripts/rotate-assertion-key.mjs --next --out <new file> [--yes]
  node scripts/rotate-assertion-key.mjs --finish [--yes]
  node scripts/rotate-assertion-key.mjs --emergency [--yes]
--out is a new file outside the repository (mode 600, never overwritten). Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

export const CURRENT = 'staff_assertion_key_current';
export const PREVIOUS = 'staff_assertion_key_previous';
const VERSION_RE = /^staff_assertion_key_v([0-9]{1,6})$/;
const FINISH_MIN_AGE_S = 60; // one 30 s assertion lifetime plus clock skew (runbook 17)

// Pure: the version --next creates and the pointer values it writes. After an emergency (current
// empty) the new version is above every stored one and previous stays empty, so the revoked key
// never verifies again.
export function planNext({ current, previous, versions }) {
  if (previous) throw new Error(`a rotation is in progress (previous = ${previous}); run --finish first`);
  const cur = current ? Number(current) : 0;
  const next = Math.max(cur, 0, ...versions) + 1;
  return { next, name: `staff_assertion_key_v${next}`, current: String(next), previous: current ? String(cur) : '' };
}

async function readState(sql) {
  const pointers = await sql`
    select name, btrim(decrypted_secret) as value from vault.decrypted_secrets
     where name = any(${[CURRENT, PREVIOUS]}::text[])`;
  const byName = Object.fromEntries(pointers.map((p) => [p.name, p.value ?? '']));
  const versions = (await sql`select name from vault.secrets where name ~ '^staff_assertion_key_v[0-9]+$'`)
    .map((r) => Number(VERSION_RE.exec(r.name)[1]))
    .sort((a, b) => a - b);
  const state = {
    current: byName[CURRENT] ?? null,
    previous: byName[PREVIOUS] ?? null,
    versions,
    missing: [CURRENT, PREVIOUS].filter((n) => byName[n] === undefined),
  };
  for (const [name, v] of [[CURRENT, state.current], [PREVIOUS, state.previous]]) {
    if (v && !/^[0-9]{1,6}$/.test(v)) throw new Error(`${name} holds something other than a version number; fix it by hand`);
  }
  return state;
}

async function upsertSecret(sql, name, value) {
  const [row] = await sql`select id from vault.secrets where name = ${name}`;
  if (row) await sql`select vault.update_secret(${row.id}::uuid, ${value})`;
  else await sql`select vault.create_secret(${value}, ${name})`;
}

const label = (v) => (v === null ? '(missing)' : v === '' ? '(empty)' : v);

export async function run({ values, apply, sql, requestId, say }) {
  const action = pickAction(values, ['next', 'finish', 'emergency']);
  const state = await readState(sql);
  say(`current = ${label(state.current)}, previous = ${label(state.previous)}, stored versions: ${state.versions.map((v) => `v${v}`).join(' ') || '(none)'}`);
  if (!action) return 0;
  const out = values.out ? assertOutsideRepo(values.out) : null;
  if (action === 'next' && !out) throw new UsageError('--next needs --out <new file> for the recover-web key');
  if (action !== 'next' && out) throw new UsageError('--out is only used with --next');
  if (out && existsSync(out)) throw new UsageError(`${out} already exists; choose a new file (it is never overwritten)`);
  const audit = { script: 'rotate-assertion-key', action: 'runbook.rotate_assertion_key', requestId, targetTable: 'vault.secrets', targetId: 'staff_assertion_key' };

  if (action === 'next') {
    const p = planNext(state);
    printPlan(say, [
      `create Vault secret ${p.name} (32 random bytes, base64url)`,
      `set ${CURRENT} = ${p.current} and ${PREVIOUS} = ${label(p.previous)}${p.previous ? ' (both versions verify)' : ' (no older version verifies)'}`,
      `write STAFF_ASSERTION_KEY_CURRENT and STAFF_ASSERTION_KEY_VERSION=${p.next} to ${out} (mode 600, new file)`,
      `write audit_log runbook.rotate_assertion_key (request_id ${requestId})`,
    ]);
    if (!apply) {
      dryRunNote(say);
      return 0;
    }
    const key = randomBytes(32).toString('base64url');
    const file = writeSecretFile(out, `STAFF_ASSERTION_KEY_CURRENT=${key}\nSTAFF_ASSERTION_KEY_VERSION=${p.next}\n`);
    try {
      await sql.begin(async (tx) => {
        const [exists] = await tx`select 1 from vault.secrets where name = ${p.name}`;
        if (exists) throw new Error(`${p.name} already exists; refusing to replace key material`);
        await tx`select vault.create_secret(${key}, ${p.name}, 'Recover staff assertion HMAC key')`;
        await upsertSecret(tx, CURRENT, p.current);
        await upsertSecret(tx, PREVIOUS, p.previous);
        await writeAudit(tx, { ...audit, metadata: { phase: 'next', current_version: p.next, previous_version: p.previous ? Number(p.previous) : null } });
      });
    } catch (e) {
      await settleOutFile(sql, requestId, file, say); // keeps the file if the commit landed anyway
      throw e;
    }
    say(`v${p.next} is current${p.previous ? `; v${p.previous} still verifies until --finish` : ''} (request_id ${requestId})`);
    say('next steps:');
    [
      `set STAFF_ASSERTION_KEY_CURRENT and STAFF_ASSERTION_KEY_VERSION from ${file} in the recover-web project (vercel env rm/add ... production)`,
      'redeploy recover-web production and wait until the new deployment serves traffic',
      p.previous ? 'wait 60 s more, then run: node scripts/rotate-assertion-key.mjs --finish --yes' : 'no --finish is needed (previous is empty)',
      `delete ${file} (rm -P on macOS, shred -u on Linux)`,
    ].forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    return 0;
  }

  if (action === 'finish') {
    if (!state.previous) throw new Error(`${PREVIOUS} is already empty; nothing to finish`);
    const [last] = await sql`
      select extract(epoch from now() - created_at)::int as age_s from public.audit_log
       where action = 'runbook.rotate_assertion_key' and metadata->>'phase' = 'next' order by id desc limit 1`;
    if (last && last.age_s < FINISH_MIN_AGE_S) {
      throw new Error(`--next ran ${last.age_s} s ago; wait at least ${FINISH_MIN_AGE_S - last.age_s} s more (and until recover-web is redeployed)`);
    }
    printPlan(say, [
      `set ${PREVIOUS} = (empty): only v${state.current} verifies from now on`,
      `write audit_log runbook.rotate_assertion_key (request_id ${requestId})`,
    ]);
    say(`precondition: recover-web production already mints with STAFF_ASSERTION_KEY_VERSION=${state.current} and has served for 60 s`);
    if (!apply) {
      dryRunNote(say);
      return 0;
    }
    await sql.begin(async (tx) => {
      await upsertSecret(tx, PREVIOUS, '');
      await writeAudit(tx, { ...audit, metadata: { phase: 'finish', current_version: Number(state.current), cleared_version: Number(state.previous) } });
    });
    say(`v${state.previous} no longer verifies (request_id ${requestId})`);
    return 0;
  }

  printPlan(say, [
    `set ${CURRENT} = (empty) and ${PREVIOUS} = (empty): no key version verifies`,
    `write audit_log runbook.rotate_assertion_key (request_id ${requestId})`,
  ]);
  say('effect: every staff and district request fails with assertion_invalid until a new key is deployed');
  if (!apply) {
    dryRunNote(say);
    return 0;
  }
  await sql.begin(async (tx) => {
    await upsertSecret(tx, CURRENT, '');
    await upsertSecret(tx, PREVIOUS, '');
    const num = (v) => (v ? Number(v) : null);
    await writeAudit(tx, { ...audit, metadata: { phase: 'emergency', revoked_current: num(state.current), revoked_previous: num(state.previous) } });
  });
  say(`all staff assertion keys revoked (request_id ${requestId})`);
  say('next: node scripts/rotate-assertion-key.mjs --next --out <new file> --yes, set the recover-web env, redeploy');
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'rotate-assertion-key',
    usage: USAGE,
    options: { next: { type: 'boolean' }, finish: { type: 'boolean' }, emergency: { type: 'boolean' }, out: { type: 'string' } },
    run,
  });
}
