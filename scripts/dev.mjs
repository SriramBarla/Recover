#!/usr/bin/env node
// `npm run dev`: web on :3000, worker on :3001, and a dev scheduler that drains the worker every 10 s.
// The dev scheduler stands in for pg_cron -> pg_net, which is the production path (§8.3); it uses the
// same scheduler bearer the worker verifies by SHA-256 (G-18).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env.local');
if (!existsSync(envFile)) {
  console.error('dev: missing .env.local. Run `node scripts/dev-env.mjs` first (with `supabase start` running).');
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);

const children = [];
function run(name, args, cwd) {
  const child = spawn('npx', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const tag = `[${name}]`;
  const pipe = (stream, out) => stream.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) out.write(`${tag} ${line}\n`);
  });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag} exited with ${code}`));
  children.push(child);
}

run('web', ['next', 'dev', '-p', '3000'], path.join(root, 'apps/web'));
run('worker', ['next', 'dev', '-p', '3001'], path.join(root, 'apps/worker'));

const intervalMs = Number(process.env.DEV_SCHEDULER_MS ?? 10_000);
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch(`${env.WORKER_URL ?? 'http://localhost:3001'}/api/jobs/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.SCHEDULER_BEARER}` },
      signal: AbortSignal.timeout(65_000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const done = Number(body.done ?? 0) + Number(body.failed ?? 0);
      if (done > 0) console.log(`[scheduler] ${JSON.stringify(body)}`);
    } else if (res.status !== 404) {
      console.log(`[scheduler] drain returned ${res.status}`);
    }
  } catch {
    // worker still compiling or restarting; try again next tick
  } finally {
    busy = false;
  }
}, intervalMs);

function shutdown() {
  clearInterval(timer);
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`[scheduler] draining the worker every ${intervalMs / 1000}s`);
