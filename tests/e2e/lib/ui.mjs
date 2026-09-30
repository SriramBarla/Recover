// Browser helpers shared by the E2E suites. Controls are found by role and accessible name
// (getByRole, getByLabel), never by CSS class, so markup and copy edits do not break the suites.
// Where a regex names a control it lists the plausible wordings for it; widen the regex if the UI
// settles on different words.
import assert from 'node:assert/strict';
import { TIMEOUTS } from '../../../playwright.config.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- waiting ----------

// Polls fn until it returns something truthy (returned) or the timeout passes (assertion error).
export async function eventually(fn, { timeout = TIMEOUTS.expect, interval = 250, message = 'condition never held' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) {
      const why = lastError ? `; last error: ${String(lastError.message ?? lastError).split('\n')[0]}` : '';
      assert.fail(`${message} (waited ${timeout} ms)${why}`);
    }
    await sleep(interval);
  }
}

// The app's own alerts explain most failures (rate limit, outage), so failed waits quote them.
async function pageAlerts(page) {
  try {
    const texts = await page.evaluate(() =>
      [...document.querySelectorAll('[role="alert"], .field-error')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
    );
    return texts.length ? `; page says: ${texts.join(' | ').slice(0, 400)}` : '';
  } catch {
    return '';
  }
}

// Waits until the first match of `locator` is visible and returns it.
export async function shown(locator, what, timeout = TIMEOUTS.expect) {
  const first = locator.first();
  try {
    await first.waitFor({ state: 'visible', timeout });
  } catch {
    assert.fail(`${what}: not visible within ${timeout} ms${await pageAlerts(locator.page())}`);
  }
  return first;
}

export async function isShown(locator) {
  return locator.first().isVisible().catch(() => false);
}

// Hydration completes shortly after the network goes quiet (the dev HMR socket does not count).
export async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

export async function open(page, path) {
  const res = await page.goto(path);
  await settle(page);
  return res;
}

export function assertCleanConsole(session, where) {
  assert.deepEqual(session.consoleErrors, [], `console errors on ${where}:\n  ${session.consoleErrors.join('\n  ')}`);
}

// ---------- controls ----------

// Main actions may be links or buttons.
export function action(page, name) {
  return page.getByRole('link', { name }).or(page.getByRole('button', { name }));
}

export const NEXT = /^(next|continue|use (this|these|the) photos?)\b/i;
export const SUBMIT = /^(submit|post|send|finish|report|upload|save|file)\b/i;

export async function clickNext(page, where) {
  const next = await shown(page.getByRole('button', { name: NEXT }).or(page.getByRole('link', { name: NEXT })), `${where}: a Next or Continue control`);
  await eventually(() => next.isEnabled(), { message: `${where}: the Next control stays disabled` });
  await next.click();
}

// Some steps advance on their own (a category tap), others wait for Next. Waits briefly for
// `target` (the next step's marker); clicks Next if it has not appeared, then waits for it.
export async function continueTo(page, target, where, state = 'visible') {
  const arrived = await target.first().waitFor({ state, timeout: 2_500 }).then(() => true, () => false);
  if (arrived) return;
  await clickNext(page, where);
  try {
    await target.first().waitFor({ state, timeout: TIMEOUTS.expect });
  } catch {
    assert.fail(`${where}: the next step never appeared${await pageAlerts(page)}`);
  }
}

// Accessible name of one element, as Playwright computes it (from its aria snapshot).
export async function accessibleName(locator) {
  const line = (await locator.ariaSnapshot()).trim().split('\n')[0] ?? '';
  const m = /^- [\w-]+ "(.*?)"(?=:|$|\s\[)/.exec(line);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}

// First visible textbox whose accessible name matches `include` and not `exclude`.
export async function textboxNamed(page, include, exclude) {
  for (const box of await page.getByRole('textbox').all()) {
    if (!(await box.isVisible().catch(() => false))) continue;
    const name = await accessibleName(box).catch(() => '');
    if (include.test(name) && !exclude?.test(name)) return box;
  }
  return null;
}

export async function waitForTextbox(page, include, exclude, what) {
  return eventually(() => textboxNamed(page, include, exclude), { message: `${what}: no visible text field named like ${include}` });
}

export async function fillTextbox(page, include, exclude, value) {
  const box = await textboxNamed(page, include, exclude);
  if (!box) return false;
  await box.fill(value);
  return true;
}

// ---------- keyboard ----------

// Presses Tab until focus lands on one of `target`'s matches; returns a handle to that element.
export async function tabTo(page, target, what, max = 40) {
  const focused = target.and(page.locator(':focus'));
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if ((await focused.count()) > 0) return page.evaluateHandle(() => document.activeElement);
  }
  assert.fail(`${what}: not reached after ${max} presses of Tab, so keyboard-only users cannot get there`);
}

// Tabs through the whole page and lists the visible interactive elements that never took focus.
// A radio group counts once (arrow keys move within it). Marks elements with data-e2e-tab, so run
// it after hydration and reload before other checks.
export async function unreachableByTab(page, max = 200) {
  const total = await page.evaluate(() => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
    const keys = new Set();
    for (const el of document.querySelectorAll(selector)) {
      if (el.disabled || el.getAttribute('tabindex') === '-1' || el.closest('[inert], [aria-hidden="true"]')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.getClientRects().length === 0) continue;
      const key = el.matches('input[type="radio"]') && el.name ? `radio:${el.name}` : `el:${keys.size}`;
      el.setAttribute('data-e2e-tab', key);
      keys.add(key);
    }
    return keys.size;
  });
  const seen = new Set();
  for (let i = 0; i < max && seen.size < total; i++) {
    await page.keyboard.press('Tab');
    const key = await page.evaluate(() => document.activeElement?.getAttribute('data-e2e-tab') ?? null);
    if (key) seen.add(key);
  }
  return page.evaluate(
    (visited) =>
      [...document.querySelectorAll('[data-e2e-tab]')]
        .filter((el) => !visited.includes(el.getAttribute('data-e2e-tab')))
        .map((el) => `<${el.tagName.toLowerCase()}> ${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`),
    [...seen],
  );
}

// ---------- student found wizard (§5.1; 04 screen inventory) ----------

export const CATEGORY = {
  bottle: { value: 'bottle', name: /water bottle|\bbottle\b/i },
  phone: { value: 'phone', name: /\bphone\b/i },
};

export const DESCRIPTION = /descri|what (is|was) it|what did you (find|lose)|tell us/i;
export const NOTE = /note|only staff|staff.only|where exactly|exact(ly)? (where|spot|place)|which room|room number/i;

export function publicIdRe(code) {
  return new RegExp(`\\b${code}-[A-Z0-9]{1,6}-\\d{6,}\\b`);
}

// §5.1 step 7: "Bring it to {location} by the end of the next school day."
export const DEADLINE = /\b(bring|take|drop)\b[^.]{0,120}\b(by|before)\b|\bby the end of\b|\bdeadline\b/i;

export function categoryChoice(page, cat) {
  return page
    .getByRole('radio', { name: cat.name })
    .or(page.getByRole('button', { name: cat.name }))
    .or(page.getByRole('link', { name: cat.name }));
}

export function categorySelect(page) {
  return page.getByRole('combobox', { name: /category|what (did you find|did you lose|is it|kind)/i });
}

export async function chooseCategory(page, cat) {
  const choice = categoryChoice(page, cat);
  await shown(choice.or(categorySelect(page)), `a category choice for ${cat.value}`);
  if (!(await isShown(choice))) {
    await categorySelect(page).first().selectOption(cat.value);
    return;
  }
  const el = choice.first();
  if (await el.evaluate((n) => n.matches('input[type="radio"], [role="radio"]'))) {
    // Keyboard selection works whatever the radio's styling (visually hidden inputs included).
    await el.focus();
    await page.keyboard.press('Space');
    if (!(await el.isChecked().catch(() => true))) await el.check({ force: true });
  } else {
    await el.click();
  }
}

export function fileInput(page) {
  return page.locator('input[type="file"]');
}

// Camera capture is an <input type=file>; setInputFiles stands in for the camera (§22: mocked).
export async function attachPhoto(page, buffer) {
  const input = fileInput(page).first();
  try {
    await input.waitFor({ state: 'attached', timeout: TIMEOUTS.expect });
  } catch {
    assert.fail(`photos step: no <input type="file"> for the camera${await pageAlerts(page)}`);
  }
  await input.setInputFiles({ name: 'found-item.jpg', mimeType: 'image/jpeg', buffer });
  await shown(
    page.locator('img[src^="blob:"], img[src^="data:"]').or(page.getByRole('img', { name: /photo|preview/i })),
    'photos step: a preview of the attached photo',
  );
}

// The focusable campus map: a named application/group/slider, a focusable image, or a focusable
// wrapper around the map image.
export function mapPicker(page) {
  const name = /map/i;
  const focusable = page.locator('[tabindex]:not([tabindex="-1"])');
  return page
    .getByRole('application', { name })
    .or(page.getByRole('slider', { name }))
    .or(page.getByRole('group', { name }).and(focusable))
    .or(page.getByRole('img', { name }).and(focusable))
    .or(focusable.filter({ has: page.getByRole('img', { name }) }));
}

const PIN_TEXT = /\b(pin(ned)?|placed|dropped|marked|selected|chosen|near)\b/i;

async function pinTexts(page, map) {
  const own = await map.evaluate((el) => {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('aria-valuetext'),
      el.getAttribute('aria-description'),
      ...ids.map((id) => document.getElementById(id)?.textContent ?? ''),
    ];
  });
  const body = await page.evaluate(() => document.body.innerText);
  return [...own, ...body.split('\n')].map((s) => (s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// §5.1 step 4 and Appendix H: arrow keys move a crosshair, Enter drops the pin. `map` is the focused
// map element (from tabTo). Placement must be reported by an aria attribute (aria-valuetext,
// aria-label, aria-describedby), a live region, or visible text, e.g. "Pin placed near Main Hall".
// Returns the new text that reported it.
export async function placePinByKeyboard(page, map) {
  for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowUp']) await page.keyboard.press(key);
  const before = await pinTexts(page, map);
  await page.keyboard.press('Enter');
  return eventually(
    async () => {
      const fresh = (await pinTexts(page, map)).filter((s) => !before.includes(s) && PIN_TEXT.test(s));
      return fresh.length ? [...new Set(fresh)] : null;
    },
    { message: 'map: after arrow keys and Enter, no aria attribute, live region or visible text reported the pin (expected something like "Pin placed near Main Hall")' },
  );
}

// If a drop-off location select is still empty, pick its first location (it defaults from the pin).
export async function ensureDropoff(page) {
  const select = page.getByRole('combobox', { name: /drop.?off|bring it|take it|pick.?up|office|location/i }).first();
  if (!(await isShown(select)) || (await select.inputValue())) return;
  const values = await select.locator('option').evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
  if (values[0]) await select.selectOption(values[0]);
}

// Clicks the final submit, stepping through a review step first if there is one.
export async function submitWizard(page, where) {
  for (let i = 0; i < 3; i++) {
    const submit = page.getByRole('button', { name: SUBMIT });
    if (await isShown(submit)) {
      await eventually(() => submit.first().isEnabled(), { message: `${where}: the submit button stays disabled` });
      await submit.first().click();
      return;
    }
    await clickNext(page, where);
  }
  assert.fail(`${where}: no submit button`);
}

// Runs the whole found wizard for a low-value item and waits for the done screen. Returns the
// public ID and the text that reported the keyboard-placed pin. The caller asserts the rest.
export async function postFoundItem(page, code, { description, note, photo }) {
  await open(page, `/s/${code}/found`);
  await chooseCategory(page, CATEGORY.bottle);
  await continueTo(page, fileInput(page), 'category step', 'attached');
  await attachPhoto(page, photo);
  await clickNext(page, 'photos step');

  await shown(mapPicker(page), 'where step: a keyboard-operable campus map (Appendix H: no pointer-only pin)');
  const map = await tabTo(page, mapPicker(page), 'where step: the campus map');
  const pinFeedback = await placePinByKeyboard(page, map);
  let noteFilled = await fillTextbox(page, NOTE, DESCRIPTION, note);
  await ensureDropoff(page);

  let describe = await textboxNamed(page, DESCRIPTION, NOTE);
  if (!describe) {
    await clickNext(page, 'where step');
    describe = await waitForTextbox(page, DESCRIPTION, NOTE, 'describe step: the description field');
  }
  await describe.fill(description);
  if (!noteFilled) noteFilled = await fillTextbox(page, NOTE, DESCRIPTION, note);
  assert.ok(noteFilled, 'the staff-only note field (at most 80 chars, §5.1 step 4) is on neither the where nor the describe step');

  await submitWizard(page, 'describe step');
  const idText = await shown(page.getByText(publicIdRe(code)), 'done screen: the public item ID', 90_000);
  const publicId = (await idText.innerText()).match(publicIdRe(code))?.[0];
  assert.ok(publicId, 'done screen: public item ID text');
  return { publicId, pinFeedback };
}
