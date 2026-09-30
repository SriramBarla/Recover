#!/usr/bin/env node
// Runbook 8: rotate the password of one application login, recover_web or recover_worker (§7.5, O-20).
// The new password is 32 random bytes as base64url (URL-safe, so it drops into the pooler URL as is).
// ALTER ROLE receives a client-computed SCRAM-SHA-256 verifier, the way psql's \password works, so the
// plaintext never reaches the server or its statement log. The plaintext goes to a new mode-600 file
// (--out), or with --show to this terminal once.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { UsageError, assertOutsideRepo, auditLanded, dryRunNote, isLocalDb, isMain, printPlan, runScript, settleOutFile, writeAudit, writeSecretFile } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/rotate-db-password.mjs --role recover_web|recover_worker --out <new file> [--yes]
  node scripts/rotate-db-password.mjs --role recover_web|recover_worker --show [--yes]
--out writes the new password to a new file outside the repository, mode 600 (never overwritten).
--show prints it once instead. Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

export const ROLES = ['recover_web', 'recover_worker'];
const PROJECT = { recover_web: 'recover-web', recover_worker: 'recover-worker' };

export function newPassword() {
  return randomBytes(32).toString('base64url');
}

// RFC 5802 / RFC 7677 verifier in PostgreSQL's stored form:
// SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>. SASLprep is the identity for the
// printable-ASCII passwords this script generates, so it is not implemented.
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('scramVerifier: password must be printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function nextSteps(role, file) {
  const project = PROJECT[role];
  const check = role === 'recover_web'
    ? 'open /s/<CODE> and /staff; Vercel logs must show no "password authentication failed"'
    : 'node scripts/jobs.mjs --summary shows a fresh worker heartbeat and a draining queue';
  return [
    `build the pooler URL (the password is URL-safe): postgresql://${role}.<project-ref>:<new password>@<pooler-host>:6543/postgres`,
    `in the ${project} Vercel project: vercel env rm DATABASE_URL production, then vercel env add DATABASE_URL production (paste the URL)`,
    `redeploy ${project} production (Deployments > Redeploy, or vercel redeploy <production deployment URL>)`,
    `verify: ${check}`,
    `store the password in the district password manager${file ? `, then delete ${file} (rm -P on macOS, shred -u on Linux)` : ''}`,
  ];
}

export async function run({ values, apply, sql, requestId, say, dbUrl }) {
  const role = values.role;
  if (!ROLES.includes(role)) throw new UsageError(`--role must be one of ${ROLES.join(', ')}`);
  const show = values.show === true;
  if (show === Boolean(values.out)) throw new UsageError('give exactly one of --out <file> or --show');
  const out = values.out ? assertOutsideRepo(values.out) : null;
  if (out && existsSync(out)) throw new UsageError(`${out} already exists; choose a new file (it is never overwritten)`);

  const [r] = await sql`select rolcanlogin from pg_roles where rolname = ${role}`;
  if (!r) throw new Error(`role ${role} does not exist in this database`);
  if (!r.rolcanlogin) throw new Error(`role ${role} is not a LOGIN role`);

  printPlan(say, [
    `generate a new password for ${role} (32 random bytes, base64url)`,
    out ? `write it to ${out} (mode 600, new file)` : 'print it once to this terminal (--show)',
    `ALTER ROLE ${role} PASSWORD '<SCRAM-SHA-256 verifier>' (the plaintext is never sent to the server)`,
    `write audit_log runbook.rotate_db_password (request_id ${requestId})`,
  ]);
  say(`warning: from step 3 the old password fails for NEW connections; update ${PROJECT[role]} and redeploy right away`);
  if (isLocalDb(dbUrl)) say(`local stack: apps/*/.env.local keep the seed password (${role}_dev); update DATABASE_URL there too`);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }

  const password = newPassword();
  const file = out ? writeSecretFile(out, `${password}\n`) : null;
  try {
    await sql.begin(async (tx) => {
      const verifier = scramVerifier(password);
      if (!/^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error('bad verifier');
      await tx.unsafe(`alter role "${role}" password '${verifier}'`); // ALTER ROLE takes no bind parameters
      await writeAudit(tx, {
        script: 'rotate-db-password',
        action: 'runbook.rotate_db_password',
        requestId,
        targetTable: 'pg_roles',
        targetId: role,
        metadata: { role, delivery: show ? 'terminal' : 'file' },
      });
    });
  } catch (e) {
    // The commit can land even when the client sees an error; never lose the only copy of a live password.
    if (file) {
      await settleOutFile(sql, requestId, file, say);
    } else {
      const landed = await auditLanded(sql, requestId);
      if (landed !== false) {
        say(landed
          ? 'WARNING: the change WAS committed although the client saw an error. The new password follows once.'
          : 'WARNING: could not confirm whether the change committed. The password it would have set follows once; test it before relying on it.');
        console.log(`\n  ${password}\n`);
      }
    }
    throw e;
  }
  say(`${role} password rotated (request_id ${requestId})`);
  if (file) say(`new password written to ${file} (mode 600)`);
  if (show) {
    say('WARNING: the new password follows once. It is not stored anywhere; copy it into the password manager now.');
    console.log(`\n  ${password}\n`);
  }
  say('next steps:');
  nextSteps(role, file).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({
    name: 'rotate-db-password',
    usage: USAGE,
    options: { role: { type: 'string' }, out: { type: 'string' }, show: { type: 'boolean' } },
    run,
  });
}
