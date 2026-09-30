// Appendix H accessibility basics in a real browser, without axe (not an approved package): alt
// attributes, accessible names, html[lang], visible focus, no positive tabindex, pointer-free pin
// placement with a text fallback, and reflow at 320 CSS px. Pages: student home, the found wizard
// steps, a listing, the lost form, and the staff queue. Automated checks are a floor, not the
// manual WCAG 2.2 AA evidence Appendix J asks for.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SCHOOL, TIMEOUTS, stackStatus, warm, withBrowser } from '../../playwright.config.mjs';
import { assertAccessible, documentProblems, focusProblems, reflowProblems, unnamedControls } from './lib/a11y.mjs';
import { NO_HARNESS, createPendingItem, jpegPhoto, loadHarness, publishItem, uniqueText } from './lib/data.mjs';
import { devLoginAvailable, devSignIn } from './lib/staff.mjs';
import {
  CATEGORY,
  DESCRIPTION,
  NOTE,
  attachPhoto,
  categoryChoice,
  categorySelect,
  chooseCategory,
  clickNext,
  continueTo,
  fileInput,
  mapPicker,
  open,
  placePinByKeyboard,
  shown,
  tabTo,
  textboxNamed,
  waitForTextbox,
} from './lib/ui.mjs';

const status = await stackStatus();
const login = status.up ? await devLoginAvailable() : { ok: false };
const h = status.up ? await loadHarness() : null;
const T = { timeout: TIMEOUTS.test };
const HOME = `/s/${SCHOOL}`;
const QUEUE = `/staff/${SCHOOL}/queue`;
const REVIEWER = 'reviewer.fchs@recover.test';
const FOCUS_RING = (el) => {
  const cs = getComputedStyle(el);
  return (cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0) || (Boolean(cs.boxShadow) && cs.boxShadow !== 'none');
};

// Walks the found wizard to its where step (category, then a photo), calling onStep at each step.
async function toWhereStep(page, onStep = async () => {}) {
  await open(page, `${HOME}/found`);
  await shown(categoryChoice(page, CATEGORY.bottle).or(categorySelect(page)), 'found wizard: the category step');
  await onStep('found wizard, category step');
  await chooseCategory(page, CATEGORY.bottle);
  await continueTo(page, fileInput(page), 'category step', 'attached');
  await onStep('found wizard, photos step');
  await attachPhoto(page, await jpegPhoto());
  await onStep('found wizard, photos step with a photo');
  await clickNext(page, 'photos step');
  await shown(mapPicker(page), 'found wizard: the where step map');
  await onStep('found wizard, where step');
}

// A published listing to audit: the newest one in the feed, or one published through the harness.
let listing;
function listingPath() {
  listing ??= (async () => {
    const href = await withBrowser('a11y find a listing', async ({ page }) => {
      await open(page, HOME);
      return page.locator(`a[href*="/s/${SCHOOL}/items/"]`).first().getAttribute('href', { timeout: 3_000 }).catch(() => null);
    });
    if (href) return { path: new URL(href, 'http://localhost').pathname };
    if (!h) return { skip: `the feed is empty and ${NO_HARNESS}, so no listing can be published` };
    if (!status.workerUp) return { skip: 'the feed is empty and the worker is not running to publish a listing' };
    try {
      const item = await createPendingItem(h, { description: uniqueText('e2e a11y listing bottle') });
      await publishItem(h, item);
      return { path: `${HOME}/items/${item.publicId}` };
    } catch (e) {
      return { skip: `could not publish a listing to audit: ${e.message.split('\n')[0]}` };
    }
  })();
  return listing;
}

// The checks must not pass vacuously: on a fixture page with planted problems each one reports.
// Needs no stack, so it also runs when the suites below skip.
describe('the accessibility checks find planted problems (fixture page)', () => {
  it('flags missing alt and lang, unnamed controls, positive tabindex, missing focus ring and sideways scroll', T, (t) =>
    withBrowser(
      t,
      async ({ page }) => {
        await page.setContent(`<!doctype html><html><head><style>
          :focus-visible { outline: 3px solid blue; } .bare:focus-visible { outline: none; } .wide { width: 600px; height: 4px; }
          </style></head><body>
          <label>Named <input name="ok"></label> <input name="unnamed"> <select name="pick"><option>x</option></select>
          <button></button> <button class="bare">No ring</button> <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
          <div tabindex="2">positive</div> <div style="display:none"><input name="hidden"></div> <div class="wide"></div>
          </body></html>`);
        const doc = (await documentProblems(page)).join('\n');
        assert.match(doc, /img without an alt/);
        assert.match(doc, /no lang attribute/);
        assert.match(doc, /positive tabindex=2/);
        const names = (await unnamedControls(page)).join('\n');
        assert.match(names, /name="unnamed"/);
        assert.match(names, /name="pick"/);
        assert.match(names, /button has no accessible name/);
        assert.doesNotMatch(names, /name="ok"|name="hidden"/);
        assert.match((await focusProblems(page)).join('\n'), /No ring/);
        assert.match((await reflowProblems(page)).join('\n'), /scrolls sideways at 320px/);
      },
      { viewport: { width: 320, height: 600 } },
    ));
});

describe('accessibility basics (Appendix H, without axe)', { skip: status.skip }, () => {
  before(() => warm([HOME, `${HOME}/found`, `${HOME}/lost`, '/staff/signin', QUEUE]), { timeout: 300_000 });
  after(async () => {
    await h?.closeAdmin?.();
  });

  it('student home', T, (t) =>
    withBrowser(t, async ({ page }) => {
      const res = await open(page, HOME);
      assert.equal(res.status(), 200, `GET ${HOME}`);
      await assertAccessible(page, HOME);
    }));

  it('found wizard steps: category, photos, where, describe', T, (t) =>
    withBrowser(t, async ({ page }) => {
      await toWhereStep(page, (where) => assertAccessible(page, where));
      const map = await tabTo(page, mapPicker(page), 'the where step map');
      await placePinByKeyboard(page, map);
      if (!(await textboxNamed(page, DESCRIPTION, NOTE))) await clickNext(page, 'where step');
      await waitForTextbox(page, DESCRIPTION, NOTE, 'the describe step');
      await assertAccessible(page, 'found wizard, describe step');
    }));

  it('the map pin can be placed without a pointer, with a visible focus ring and a text fallback', T, (t) =>
    withBrowser(t, async ({ page }) => {
      await toWhereStep(page);
      const map = await tabTo(page, mapPicker(page), 'the where step map');
      assert.ok(await map.evaluate(FOCUS_RING), 'the focused map shows a focus indicator (outline or box-shadow)');
      const feedback = await placePinByKeyboard(page, map);
      t.diagnostic(`pin reported as: ${feedback.join(' | ')}`);
      const fallback = /zone|area|building|near|part of (the )?(campus|school)/i;
      await shown(
        page
          .getByRole('combobox', { name: fallback })
          .or(page.getByRole('radiogroup', { name: fallback }))
          .or(page.getByRole('textbox', { name: /across|down|%/i })),
        'a text alternative to the map: a zone picker or a typed position (§5.1 step 4, Appendix H)',
      );
    }));

  it('listing page', T, async (t) => {
    const l = await listingPath();
    if (l.skip) return t.skip(l.skip);
    await withBrowser(t, async ({ page }) => {
      const res = await open(page, l.path);
      assert.equal(res.status(), 200, `GET ${l.path}`);
      await assertAccessible(page, l.path);
    });
  });

  it('lost report form', T, (t) =>
    withBrowser(t, async ({ page }) => {
      const res = await open(page, `${HOME}/lost`);
      assert.equal(res.status(), 200, `GET ${HOME}/lost`);
      await assertAccessible(page, `${HOME}/lost`);
    }));

  it('staff queue', T, async (t) => {
    if (!login.ok) return t.skip(login.why);
    await withBrowser(t, async ({ page }) => {
      await devSignIn(page, REVIEWER);
      await open(page, QUEUE);
      assert.equal(new URL(page.url()).pathname, QUEUE, 'the reviewer reaches the queue');
      await assertAccessible(page, QUEUE);
    });
  });

  it('reflow: no horizontal scroll at 320 CSS px (WCAG 1.4.10)', T, async (t) => {
    const l = await listingPath();
    const pages = [HOME, `${HOME}/lost`, ...(l.path ? [l.path] : [])];
    await withBrowser(
      t,
      async ({ page }) => {
        const problems = [];
        const check = async (label) => problems.push(...(await reflowProblems(page)).map((m) => `${label}: ${m}`));
        for (const p of pages) {
          await open(page, p);
          await check(p);
        }
        await toWhereStep(page, (where) => check(where));
        if (login.ok) {
          await devSignIn(page, REVIEWER);
          await open(page, QUEUE);
          await check(QUEUE);
        }
        assert.deepEqual(problems, [], `horizontal scrolling at 320px:\n  ${problems.join('\n  ')}`);
      },
      { viewport: { width: 320, height: 720 } },
    );
  });
});
