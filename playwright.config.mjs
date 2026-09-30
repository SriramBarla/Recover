// Browser E2E settings for tests/e2e (§22 "Browser E2E" row; Appendix H). This is a plain module, not
// a @playwright/test config: the suites run under `node --test` with the `playwright` library and
// import BASE_URL, TIMEOUTS, stackStatus, warm and withBrowser from here.
//
// Environment (all optional):
//   E2E_BASE_URL    web origin, default http://localhost:3000
//   E2E_WORKER_URL  worker origin, default http://localhost:3001
//   E2E_HEADED=1    show the browser; E2E_SLOWMO=<ms> slows every action
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const trimSlash = (s) => s.replace(/\/+$/, '');

export const ROOT = import.meta.dirname;
export const OUTPUT_DIR = path.join(ROOT, 'test-results'); // git-ignored
export const BASE_URL = trimSlash(process.env.E2E_BASE_URL ?? 'http://localhost:3000');
export const WORKER_URL = trimSlash(process.env.E2E_WORKER_URL ?? 'http://localhost:3001');
export const SCHOOL = 'FCHS';
export const OTHER_SCHOOL = 'SFHS';

// `next dev` compiles a route on its first request, so navigations get a generous budget.
export const TIMEOUTS = {
  test: 240_000, // one it()
  navigation: 60_000,
  action: 15_000, // click, fill, press
  expect: 20_000, // waiting for something to appear
  probe: 20_000, // stack probe
};

export const VIEWPORT = { width: 1280, height: 900 };
const HEADLESS = process.env.E2E_HEADED !== '1';
const SLOW_MO = Number(process.env.E2E_SLOWMO ?? 0) || 0;

async function probe(url, init = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUTS.probe), ...init });
    await res.body?.cancel().catch(() => {});
    return { answered: true, status: res.status };
  } catch (e) {
    return { answered: false, status: 0, error: e?.cause?.code ?? e?.name ?? 'error' };
  }
}

let statusPromise;

// { up, workerUp, skip }: skip is false or the reason every suite prints when the stack is down.
export function stackStatus() {
  statusPromise ??= (async () => {
    const web = await probe(`${BASE_URL}/offline`);
    if (!web.answered) {
      return {
        up: false,
        workerUp: false,
        skip: `local stack not running: ${BASE_URL}/offline did not answer (${web.error}). Start it with supabase start, node scripts/dev-env.mjs, npm run dev`,
      };
    }
    // The worker refuses an unauthenticated drain with 401; any answer means it is running.
    const worker = await probe(`${WORKER_URL}/api/jobs/run`, { method: 'POST' });
    return { up: true, workerUp: worker.answered, skip: false };
  })();
  return statusPromise;
}

export const WORKER_DOWN = `worker not answering at ${WORKER_URL}; photo uploads need it (npm run dev starts it)`;

// First requests to a dev server compile routes; do that once before a suite instead of inside
// the first test's timeouts. Failures are ignored here and surface in the tests.
export async function warm(paths) {
  for (const p of paths) {
    await probe(`${BASE_URL}${p}`).catch(() => {});
  }
}

// In `next dev` the proxy's nonce-only style-src blocks the inline styles that the Next.js dev-tools
// overlay injects, which logs a CSP error per style on every page. That overlay never ships, so its
// messages are counted but not treated as application console errors.
const DEV_TOOLING = /next-devtools/;

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'e2e';
}

async function capture(session, err, t) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = path.join(OUTPUT_DIR, slug(session.name));
  const files = [];
  for (const [i, page] of session.context.pages().entries()) {
    const suffix = i === 0 ? '' : `-p${i + 1}`;
    try {
      await page.screenshot({ path: `${base}${suffix}.png`, fullPage: true, timeout: 10_000 });
      files.push(`${base}${suffix}.png`);
      writeFileSync(`${base}${suffix}.html`, await page.content());
    } catch {
      // a crashed or closed page cannot be captured; the log below still helps
    }
  }
  const log = [
    `test: ${session.name}`,
    `url: ${session.context.pages().map((p) => p.url()).join(' | ')}`,
    `error: ${err?.stack ?? err}`,
    '',
    'console errors:',
    ...session.consoleErrors,
    `(${session.devToolingErrors} more from the Next.js dev-tools overlay, ignored)`,
    '',
    'HTTP responses >= 400:',
    ...session.httpErrors,
  ].join('\n');
  writeFileSync(`${base}.log.txt`, log);
  const note = `screenshot: ${files[0] ?? '(none)'}; log: ${base}.log.txt`;
  if (typeof t?.diagnostic === 'function') t.diagnostic(note);
}

// Runs fn({ page, context, browser, consoleErrors, httpErrors, requests }) in a fresh Chromium, then
// closes it. On failure it writes a full-page screenshot, the HTML and a console/HTTP log into
// test-results/ before rethrowing. `t` is the node:test context (or a name).
// Options: storageState (reuse a signed-in session), viewport.
export async function withBrowser(t, fn, opts = {}) {
  const name = typeof t === 'string' ? t : (t?.fullName ?? t?.name ?? 'e2e');
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOW_MO });
  const session = { browser, name, consoleErrors: [], devToolingErrors: 0, httpErrors: [], requests: [] };
  try {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: opts.viewport ?? VIEWPORT,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      reducedMotion: 'reduce',
      storageState: opts.storageState,
    });
    session.context = context;
    context.setDefaultTimeout(TIMEOUTS.action);
    context.setDefaultNavigationTimeout(TIMEOUTS.navigation);
    context.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const at = msg.location()?.url ?? '';
      if (DEV_TOOLING.test(at)) session.devToolingErrors += 1;
      else session.consoleErrors.push(at ? `${msg.text()} (at ${at})` : msg.text());
    });
    context.on('weberror', (e) => session.consoleErrors.push(`uncaught: ${e.error()?.message ?? e.error()}`));
    context.on('request', (r) => session.requests.push({ method: r.method(), url: r.url() }));
    context.on('response', (r) => {
      if (r.status() >= 400) session.httpErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    session.page = await context.newPage();
    return await fn(session);
  } catch (err) {
    if (session.context) await capture(session, err, t).catch(() => {});
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}
