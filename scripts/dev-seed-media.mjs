#!/usr/bin/env node
// Local development only: draws a simple campus map per seeded school (buildings where the seeded
// zones are) and uploads it to the public `maps` bucket at each active version's public_storage_path.
// Uses `supabase storage cp --local`, so no storage credential is needed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const dbUrl = process.env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55422/postgres';

const rows = execFileSync('psql', [dbUrl, '-At', '-F', '\t', '-c', `
  select s.code, s.name, v.public_storage_path, v.width_px, v.height_px,
         coalesce((select string_agg(z.name || '|' || z.cx || '|' || z.cy || '|' || z.radius, ';')
                     from public.map_zones z where z.map_version_id = v.id), '')
    from public.map_versions v join public.schools s on s.id = v.school_id
   where v.active and v.public_storage_path is not null order by s.code`], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dir = mkdtempSync(path.join(tmpdir(), 'recover-maps-'));
try {
  for (const row of rows) {
    const [code, name, key, w, h, zonesRaw] = row.split('\t');
    const W = Number(w);
    const H = Number(h);
    const zones = zonesRaw.split(';').filter(Boolean).map((z) => {
      const [zn, cx, cy, r] = z.split('|');
      return { name: zn, cx: Number(cx) * W, cy: Number(cy) * H, r: Number(r) * Math.max(W, H) };
    });
    const buildings = zones.map((z, i) => {
      const bw = z.r * 1.3;
      const bh = z.r * 0.9;
      const fill = ['#d9e6f2', '#f2e3d5', '#e2f0d9', '#efe0f2', '#f5f0d0'][i % 5];
      return `<rect x="${z.cx - bw / 2}" y="${z.cy - bh / 2}" width="${bw}" height="${bh}" rx="18" fill="${fill}" stroke="#5a6b7b" stroke-width="4"/>
        <text x="${z.cx}" y="${z.cy + 12}" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#23313f">${esc(z.name)}</text>`;
    }).join('\n');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#f4f1e8"/>
      <path d="M 0 ${H * 0.55} C ${W * 0.3} ${H * 0.5}, ${W * 0.6} ${H * 0.6}, ${W} ${H * 0.5}" stroke="#cfc8b4" stroke-width="46" fill="none"/>
      <path d="M ${W * 0.5} 0 L ${W * 0.5} ${H}" stroke="#cfc8b4" stroke-width="36" fill="none"/>
      ${buildings}
      <text x="40" y="70" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="800" fill="#0f5c56">${esc(name)} (${esc(code)})</text>
      <text x="40" y="${H - 30}" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#5d5a53">Simplified public map - sample data for local development</text>
    </svg>`;
    const file = path.join(dir, `${code}.jpg`);
    writeFileSync(file, await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer());
    execFileSync('supabase', ['--experimental', 'storage', 'cp', '--local', '--content-type', 'image/jpeg', file, `ss:///maps/${key}`],
      { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`dev-seed-media: uploaded map for ${code}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
