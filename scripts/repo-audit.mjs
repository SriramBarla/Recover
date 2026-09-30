#!/usr/bin/env node
// Static repository audit (CI): secret-shaped strings, committed env files, and the deployment
// boundaries the spec depends on (§0.5, §7.5, F-68, F-69, 16 "CI security jobs").
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const problems = [];
const text = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

// 1. No env files other than the documented example.
for (const f of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) problems.push(`${f}: environment file is tracked`);
}

// 2. Secret-shaped values (documented AWS example credentials used by SigV4 vectors are allowed).
const secretPatterns = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S+/, 'service role key assignment'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/"private_key"\s*:\s*"-----BEGIN/, 'service account JSON key'],
];
for (const f of tracked) {
  if (/\.(png|jpe?g|webp|heic|ico|zip)$/i.test(f)) continue;
  const t = text(f);
  for (const [re, label] of secretPatterns) if (re.test(t)) problems.push(`${f}: looks like a ${label}`);
}

// 3. Deployment boundaries.
const inDir = (d) => tracked.filter((f) => f.startsWith(d) && /\.(ts|tsx|mjs|js)$/.test(f));
for (const f of inDir('apps/web/')) {
  const t = text(f);
  if (/SUPABASE_S3_|S3_ACCESS_KEY|S3_SECRET/.test(t)) problems.push(`${f}: web must never reference the Storage S3 key (D-16)`);
  if (/from ['"]sharp['"]|from ['"]jose['"]/.test(t)) problems.push(`${f}: web must not import sharp or jose (approved for the worker only)`);
  if (/from ['"](?:\.\.\/)+worker\//.test(t) || /apps\/worker/.test(t)) problems.push(`${f}: web must not import from apps/worker`);
}
for (const f of inDir('apps/worker/')) {
  const t = text(f);
  if (/from ['"]next-auth/.test(t)) problems.push(`${f}: worker must never import Auth.js (§8.3)`);
  if (/STAFF_ASSERTION_KEY/.test(t)) problems.push(`${f}: worker must never hold the staff assertion key`);
}
for (const f of inDir('packages/shared/')) {
  if (/process\.env/.test(text(f)) && !f.endsWith('/env.ts')) problems.push(`${f}: packages/shared must not read environment variables`);
}

if (problems.length) {
  console.log(`repo-audit: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`repo-audit: OK (${tracked.length} tracked files checked)`);
