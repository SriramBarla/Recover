// Staff-app helpers: dev sign-in, finding the row that belongs to one item, and confirmation steps.
import assert from 'node:assert/strict';
import { BASE_URL, TIMEOUTS } from '../../../playwright.config.mjs';
import { eventually, isShown, open, settle, shown } from './ui.mjs';

// Whether the staff app offers the dev Credentials login (RECOVER_DEV_LOGIN=1; refused on Vercel).
export async function devLoginAvailable() {
  try {
    const res = await fetch(`${BASE_URL}/api/auth/providers`, { signal: AbortSignal.timeout(TIMEOUTS.probe) });
    if (!res.ok) return { ok: false, why: `staff app unavailable: GET /api/auth/providers returned ${res.status}` };
    const providers = await res.json();
    if (Object.values(providers ?? {}).some((p) => p?.type === 'credentials')) return { ok: true };
    return { ok: false, why: 'staff dev login is off: set RECOVER_DEV_LOGIN=1 in apps/web/.env.local (node scripts/dev-env.mjs writes it)' };
  } catch (e) {
    return { ok: false, why: `staff app unavailable: GET /api/auth/providers failed (${e.message})` };
  }
}

// Signs in through the dev form on /staff/signin (rendered only when RECOVER_DEV_LOGIN=1).
export async function devSignIn(page, email) {
  await open(page, '/staff/signin?callbackUrl=%2Fstaff');
  const field = await shown(page.getByLabel(/staff email|^email/i), 'the dev sign-in email field on /staff/signin');
  await field.fill(email);
  await page.getByRole('button', { name: /\(dev\)|dev(elopment)? sign.?in|sign.?in.*\bdev\b/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/staff/signin') || u.searchParams.has('error'), {
    timeout: TIMEOUTS.navigation,
  });
  await settle(page);
  const url = new URL(page.url());
  if (url.pathname.startsWith('/staff/signin')) {
    const alert = await page.getByRole('alert').allInnerTexts().catch(() => []);
    assert.fail(`dev sign-in as ${email} failed (${url.searchParams.get('error')}): ${alert.join(' ')}`);
  }
  return url;
}

// The smallest element around `text` that holds exactly one control named like `actionRe`: the
// row or card for that item. Null when there is none (e.g. the action lives on the item page).
export async function scopeFor(page, text, actionRe) {
  const anchor = page.getByText(text).first();
  if (!(await isShown(anchor))) return null;
  const handle = await anchor.elementHandle();
  const found = await handle.evaluate(
    (el, re) => {
      for (const old of document.querySelectorAll('[data-e2e-scope]')) old.removeAttribute('data-e2e-scope');
      const pattern = new RegExp(re.source, re.flags);
      const matches = (n) =>
        [...n.querySelectorAll('button, [role="button"], a[href]')].filter((b) =>
          pattern.test((b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim()),
        ).length;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const count = matches(n);
        if (count === 1) {
          n.setAttribute('data-e2e-scope', '1');
          return true;
        }
        if (count > 1) return false; // a list of several items: not this item's own row
      }
      return false;
    },
    { source: actionRe.source, flags: actionRe.flags },
  );
  return found ? page.locator('[data-e2e-scope="1"]') : null;
}

const CONFIRM = /^(confirm|yes|ok|receive|claim|mark|save|continue|done|submit)\b/i;
const CANCEL = /^(cancel|close|back|no|not now)\b/i;

// A confirmation step: a dialog, or an inline group that offers Cancel. Ticks any acknowledgement
// checkbox (e.g. "I checked who owns it") and presses the confirming button. With required: false,
// returns false when no confirmation shows up.
export async function confirmStep(page, what, { required = true } = {}) {
  const box = page
    .getByRole('dialog')
    .or(page.getByRole('alertdialog'))
    .or(page.getByRole('group').filter({ has: page.getByRole('button', { name: CANCEL }) }));
  const appeared = await box
    .first()
    .waitFor({ state: 'visible', timeout: required ? TIMEOUTS.expect : 3_000 })
    .then(() => true, () => false);
  if (!appeared) {
    if (required) assert.fail(`${what}: no confirmation step (a dialog, or an inline confirm with Cancel)`);
    return false;
  }
  const scope = box.last();
  for (const cb of await scope.getByRole('checkbox').all()) {
    if (!(await cb.isChecked())) await cb.check();
  }
  let button = scope.getByRole('button', { name: CONFIRM }).first();
  if (!(await isShown(button))) button = scope.getByRole('button').filter({ hasNotText: CANCEL }).first();
  await eventually(() => button.isEnabled(), { message: `${what}: the confirm button stays disabled` });
  await button.click();
  return true;
}

// The key a control advertises: aria-keyshortcuts first, then "(A)" or <kbd>A</kbd> in its label,
// else the conventional "a" for Approve.
export async function shortcutFor(control, fallback) {
  const aria = (await control.getAttribute('aria-keyshortcuts'))?.trim().split(/\s+/)[0];
  if (aria) return /^[A-Za-z]$/.test(aria) ? aria.toLowerCase() : aria;
  const kbd = (await control.locator('kbd').first().innerText({ timeout: 500 }).catch(() => '')).trim();
  if (/^[A-Za-z]$/.test(kbd)) return kbd.toLowerCase();
  const label = await control.innerText().catch(() => '');
  const m = /[([]([A-Za-z])[)\]]/.exec(label);
  return m ? m[1].toLowerCase() : fallback;
}
