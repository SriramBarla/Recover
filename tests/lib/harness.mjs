// Integration harness: talks to the running local stack exactly as browsers, the scheduler and
// staff do. Requires `supabase start`, `node scripts/dev-env.mjs`, and `npm run dev`.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '../..');

export function loadEnv(file) {
  const p = path.join(root, file);
  if (!existsSync(p)) return {};
  return Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
}

export const env = { ...loadEnv('apps/web/.env.local'), ...loadEnv('.env.local') };
export const WEB = env.WEB_URL ?? 'http://localhost:3000';
export const WORKER = env.WORKER_URL ?? 'http://localhost:3001';
export const SCHOOL = { code: 'FCHS', id: '0a0a0a0a-0000-4000-8000-000000000001', map: '0a0a0a0a-2000-4000-8000-000000000001', westOffice: '0a0a0a0a-1000-4000-8000-000000000001', eastOffice: '0a0a0a0a-1000-4000-8000-000000000002' };
export const OTHER_SCHOOL = { code: 'SFHS', id: '0b0b0b0b-0000-4000-8000-000000000002', mainOffice: '0b0b0b0b-1000-4000-8000-000000000001' };

let adminSql;
export function admin() {
  adminSql ??= postgres(env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55422/postgres', { prepare: false, onnotice: () => {}, max: 2 });
  return adminSql;
}
export async function closeAdmin() {
  if (adminSql) await adminSql.end({ timeout: 2 });
  adminSql = undefined;
}

export async function stackIsUp() {
  try {
    const [w, k] = await Promise.all([
      fetch(`${WEB}/offline`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${WORKER}/api/jobs/run`, { method: 'POST', signal: AbortSignal.timeout(5000) }),
    ]);
    return w.status < 500 && k.status === 401; // the worker must refuse an unauthenticated drain
  } catch {
    return false;
  }
}

// A realistic phone photo: colored scene plus EXIF with GPS, so tests can prove it is stripped (F-73).
export async function makePhoto({ hue = 210, label = 'item', width = 1200, height = 900 } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="hsl(${hue},35%,82%)"/>
    <rect x="${width * 0.3}" y="${height * 0.2}" width="${width * 0.4}" height="${height * 0.6}" rx="40" fill="hsl(${hue},55%,40%)"/>
    <text x="50%" y="92%" font-size="42" text-anchor="middle" font-family="Arial" fill="#222">${label}</text></svg>`;
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 80 })
    .withExif({ IFD0: { Make: 'TestPhone', Model: 'Harness' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '34/1 12/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 8/1 15/1' } })
    .toBuffer();
}

export function hasExif(jpeg) {
  // APP1 marker (0xFFE1) carries EXIF/XMP; canonical output must not contain it.
  for (let i = 2; i < Math.min(jpeg.length - 1, 65536); i++) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xe1) return true;
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xda) break; // start of scan
  }
  return false;
}

class CookieJar {
  #cookies = new Map();
  store(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0/i.test(c) || value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  has(name) {
    return this.#cookies.has(name);
  }
}

async function send(jar, method, url, { json, form, headers = {}, mutate = method !== 'GET', idempotencyKey } = {}) {
  const h = { ...headers };
  const cookie = jar.header();
  if (cookie) h.cookie = cookie;
  if (mutate) {
    h.origin = WEB;
    h['sec-fetch-site'] = 'same-origin';
    h['x-recover-request'] = '1';
  }
  if (idempotencyKey) h['idempotency-key'] = idempotencyKey;
  let body;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    h['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url.startsWith('http') ? url : `${WEB}${url}`, { method, headers: h, body, redirect: 'manual' });
  jar.store(res);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

export class Student {
  jar = new CookieJar();
  get(p) {
    return send(this.jar, 'GET', p, { mutate: false });
  }
  post(p, json, opts = {}) {
    return send(this.jar, 'POST', p, { json, idempotencyKey: opts.idempotencyKey ?? randomUUID(), ...opts });
  }
}

export class Staff {
  jar = new CookieJar();
  constructor(email) {
    this.email = email;
  }
  async signIn() {
    const providers = await send(this.jar, 'GET', '/api/auth/providers', { mutate: false });
    const cred = Object.values(providers.data ?? {}).find((p) => p.type === 'credentials');
    if (!cred) throw new Error('dev credentials provider not available (RECOVER_DEV_LOGIN=1 required)');
    const csrf = await send(this.jar, 'GET', '/api/auth/csrf', { mutate: false });
    const res = await send(this.jar, 'POST', `/api/auth/callback/${cred.id}`, {
      form: { csrfToken: csrf.data.csrfToken, email: this.email, callbackUrl: `${WEB}/staff` },
      mutate: false,
      headers: { origin: WEB },
    });
    if (![200, 302, 303].includes(res.status)) throw new Error(`sign-in failed: ${res.status}`);
    const session = await send(this.jar, 'GET', '/api/auth/session', { mutate: false });
    if (!session.data?.user && !session.data?.sub) throw new Error('sign-in produced no session');
    return session.data;
  }
  get(p) {
    return send(this.jar, 'GET', p, { mutate: false });
  }
  post(p, json, opts = {}) {
    return send(this.jar, 'POST', p, { json, ...opts });
  }
  patch(p, json) {
    return send(this.jar, 'PATCH', p, { json });
  }
  del(p, json) {
    return send(this.jar, 'DELETE', p, { json });
  }
}

export async function putUpload(url, bytes, contentType = 'image/jpeg') {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes });
  return res.status;
}

// Drain the worker until two consecutive rounds do no work (or maxRounds).
export async function drain(maxRounds = 30) {
  let idle = 0;
  const totals = { rounds: 0, done: 0, failed: 0 };
  for (let i = 0; i < maxRounds && idle < 2; i++) {
    const res = await fetch(`${WORKER}/api/jobs/run`, { method: 'POST', headers: { authorization: `Bearer ${env.SCHEDULER_BEARER}` } });
    if (res.status !== 200) throw new Error(`drain failed: ${res.status}`);
    const body = await res.json();
    const n = Number(body.done ?? 0) + Number(body.failed ?? 0);
    totals.rounds += 1;
    totals.done += Number(body.done ?? 0);
    totals.failed += Number(body.failed ?? 0);
    idle = n === 0 ? idle + 1 : 0;
  }
  return totals;
}

export async function jobsFor(itemId) {
  return admin()`select kind, status, attempts, last_error_code from public.jobs
                  where payload->>'itemId' = ${itemId} or payload->>'photoId' in
                        (select id::text from public.item_photos where item_id = ${itemId}::uuid)
                  order by id`;
}
