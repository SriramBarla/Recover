#!/usr/bin/env node
// Runs every supabase/tests/*.sql file against the local database with psql (ON_ERROR_STOP).
// Each test file wraps itself in begin/rollback and raises on failure (18-Testing.md, SQL assertions).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dbUrl = process.env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55422/postgres';
const dir = path.join(root, 'supabase/tests');
const only = process.argv.slice(2);
if (!existsSync(dir)) {
  console.log('sql-tests: no supabase/tests directory yet; nothing to run');
  process.exit(0);
}
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).filter((f) => !only.length || only.some((o) => f.includes(o))).sort();

let failed = 0;
for (const f of files) {
  const started = Date.now();
  const r = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(dir, f)], { encoding: 'utf8' });
  const ms = Date.now() - started;
  const passes = (r.stderr.match(/NOTICE: {2}PASS|NOTICE:\s+PASS/g) ?? []).length;
  if (r.status === 0) {
    console.log(`PASS ${f} (${passes} checks, ${ms} ms)`);
  } else {
    failed += 1;
    console.log(`FAIL ${f} (${ms} ms)`);
    const lines = r.stderr.split('\n').filter((l) => /ERROR|FAIL|DETAIL|CONTEXT/.test(l)).slice(0, 12);
    for (const l of lines) console.log(`    ${l}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} SQL test files passed`);
process.exit(failed ? 1 : 0);
