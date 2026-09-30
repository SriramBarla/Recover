#!/usr/bin/env node
// Student JS budget (15 section 18; docs/DESIGN.md "Student JS budget"): the gzipped first-load JS of every
// student route stays under 150 KB. Measures what a production server actually sends for each page: every
// <script src> in its HTML except the nomodule polyfills, which modern browsers never download, gzipped at
// level 9. Exits 1 if any route is over budget.
//
// Measure the build Vercel runs (`next build`, Turbopack in Next 16):
//   cd apps/web && npx next build && npx next start -p 3200     # with the local stack up
//   node scripts/js-budget.mjs [--base http://127.0.0.1:3200] [--school FCHS] [--budget-kb 150]
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:3200' },
    school: { type: 'string', default: 'FCHS' },
    'budget-kb': { type: 'string', default: '150' },
  },
});
const base = values.base.replace(/\/+$/, '');
const code = values.school.toUpperCase();
const budget = Number(values['budget-kb']) * 1024;

async function get(path) {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res;
}

async function firstLoadBytes(path) {
  const html = await (await get(path)).text();
  const tags = [...html.matchAll(/<script\b([^>]*)\bsrc="([^"]+)"([^>]*)>/g)];
  let bytes = 0;
  let scripts = 0;
  for (const [, before, src, after] of tags) {
    if (/\bnomodule\b/i.test(before + after)) continue;
    const body = Buffer.from(await (await get(new URL(src, base).pathname)).arrayBuffer());
    bytes += gzipSync(body, { level: 9 }).length;
    scripts += 1;
  }
  return { bytes, scripts };
}

const routes = [`/s/${code}`, `/s/${code}/found`, `/s/${code}/search`, `/s/${code}/lost`, `/s/${code}/lost/mine`, `/s/${code}/mine`];
const feed = await (await get(`/api/s/${code}/items`)).json();
const listing = feed.items?.[0]?.publicId;
if (listing) routes.push(`/s/${code}/items/${listing}`);
else console.log(`js-budget: no published item at ${code}, so the listing page is not measured`);

let over = 0;
for (const route of routes) {
  const { bytes, scripts } = await firstLoadBytes(route);
  const ok = bytes <= budget;
  if (!ok) over += 1;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${route.padEnd(34)} ${(bytes / 1024).toFixed(1).padStart(6)} KB gzipped (${scripts} scripts; ${((budget - bytes) / 1024).toFixed(1)} KB left)`);
}
if (over > 0) {
  console.log(`js-budget: ${over} route(s) over ${values['budget-kb']} KB`);
  process.exit(1);
}
console.log(`js-budget: every student route is within ${values['budget-kb']} KB`);
