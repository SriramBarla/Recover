#!/usr/bin/env node
// Synthetic dismissal-peak load for the read path (§18 budgets; 18-Testing.md load row).
// Usage: node scripts/load.mjs [--base http://localhost:3000] [--school FCHS] [--readers 500] [--seconds 60]
// Reports p50/p95/max per route and exits non-zero when a p95 budget is exceeded. Run it against
// staging (production builds), not `next dev`, before the numbers mean anything.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const base = args.base ?? 'http://localhost:3000';
const school = args.school ?? 'FCHS';
const readers = Number(args.readers ?? 500);
const seconds = Number(args.seconds ?? 60);
const budgets = { feed: 600, search: 300, listing: 600, meta: 600 }; // ms, origin p95 (§18)
const terms = ['bottle', 'hoodie', 'airpods', 'backpack', 'calculator', 'botella', 'jacket', 'charger'];

const samples = { feed: [], search: [], listing: [], meta: [] };
const errors = { feed: 0, search: 0, listing: 0, meta: 0 };
let publicIds = [];

async function timed(kind, url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'recover-load' } });
    const body = await res.text();
    samples[kind].push(performance.now() - t0);
    if (res.status >= 500) errors[kind] += 1;
    return { status: res.status, body };
  } catch {
    errors[kind] += 1;
    return { status: 0, body: '' };
  }
}

async function reader(deadline) {
  while (Date.now() < deadline) {
    const r = Math.random();
    if (r < 0.55) {
      const res = await timed('feed', `${base}/api/s/${school}/items`);
      if (res.status === 200 && publicIds.length < 50) {
        try {
          publicIds = [...new Set([...publicIds, ...JSON.parse(res.body).items.map((i) => i.publicId)])];
        } catch { /* ignore */ }
      }
    } else if (r < 0.8) {
      await timed('search', `${base}/api/s/${school}/search?q=${encodeURIComponent(terms[Math.floor(Math.random() * terms.length)])}`);
    } else if (r < 0.95 && publicIds.length) {
      await timed('listing', `${base}/api/s/${school}/items/${publicIds[Math.floor(Math.random() * publicIds.length)]}`);
    } else {
      await timed('meta', `${base}/api/s/${school}/meta`);
    }
    await new Promise((res) => setTimeout(res, 200 + Math.random() * 800)); // think time
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

console.log(`load: ${readers} readers for ${seconds}s against ${base}/s/${school}`);
const deadline = Date.now() + seconds * 1000;
await Promise.all(Array.from({ length: readers }, () => reader(deadline)));

let over = false;
console.log('\nroute     count   p50ms   p95ms   maxms  errors  budget');
for (const k of Object.keys(samples)) {
  const a = samples[k];
  const p95 = pct(a, 95);
  const bad = a.length > 0 && p95 > budgets[k];
  over ||= bad;
  console.log(`${k.padEnd(8)} ${String(a.length).padStart(6)} ${pct(a, 50).toFixed(0).padStart(7)} ${p95.toFixed(0).padStart(7)} ${pct(a, 100).toFixed(0).padStart(7)} ${String(errors[k]).padStart(7)}  ${bad ? 'OVER' : 'ok'} (${budgets[k]})`);
}
process.exit(over ? 1 : 0);
