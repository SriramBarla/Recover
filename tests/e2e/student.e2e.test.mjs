// Browser E2E for the student PWA (§5.1, §5.2; 04 screen inventory; §19 headers): home, keyboard
// reachability, the found wizard with a keyboard-placed pin, the high-value office redirect, lost
// reports, search, /offline, security headers, and a clean console.
// Needs the local stack: supabase start, node scripts/dev-env.mjs, npm run dev. Skips otherwise.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { SCHOOL, TIMEOUTS, WORKER_DOWN, stackStatus, warm, withBrowser } from '../../playwright.config.mjs';
import { jpegPhoto, shared, uniqueText } from './lib/data.mjs';
import {
  CATEGORY,
  DEADLINE,
  SUBMIT,
  action,
  assertCleanConsole,
  categoryChoice,
  categorySelect,
  chooseCategory,
  clickNext,
  esc,
  eventually,
  fileInput,
  isShown,
  open,
  postFoundItem,
  settle,
  shown,
  sleep,
  tabTo,
  textboxNamed,
  unreachableByTab,
} from './lib/ui.mjs';

const status = await stackStatus();
const T = { timeout: TIMEOUTS.test };
const HOME = `/s/${SCHOOL}`;
const STUDENT_PAGES = [HOME, `${HOME}/found`, `${HOME}/lost`, `${HOME}/lost/mine`, `${HOME}/mine`, `${HOME}/search?q=bottle`, '/offline'];
const LOST_DESCRIPTION = /descri|what (did you lose|is it|was it)|tell us/i;

describe('student PWA in a browser', { skip: status.skip }, () => {
  before(() => warm([...STUDENT_PAGES, `/api/s/${SCHOOL}/meta`]), { timeout: 300_000 });

  it('home renders the feed, the search box and the two main actions', T, (t) =>
    withBrowser(t, async (s) => {
      const res = await open(s.page, HOME);
      assert.equal(res.status(), 200, `GET ${HOME}`);
      await shown(s.page.getByRole('heading', { level: 1 }), 'the page heading');
      await shown(s.page.getByRole('searchbox', { name: /search/i }), 'the search box');
      await shown(action(s.page, /found something/i), 'the "Found something" action');
      await shown(action(s.page, /i lost something/i), 'the "I lost something" action');
      await shown(s.page.getByRole('heading', { name: /found items/i }), 'the feed heading');
      await shown(
        s.page.getByRole('list', { name: /found items/i }).or(s.page.getByText(/no found items|nothing (is|has been) (found|posted)|check back/i)),
        'the feed: item cards or the empty-feed message',
      );
      assertCleanConsole(s, HOME);
    }));

  it('everything on home is reachable by keyboard: Tab to "Found something", then Enter', T, (t) =>
    withBrowser(t, async ({ page }) => {
      await open(page, HOME);
      const missed = await unreachableByTab(page);
      assert.deepEqual(missed, [], `never focused by Tab:\n  ${missed.join('\n  ')}`);
      await open(page, HOME); // fresh focus position and markup
      await tabTo(page, action(page, /found something/i), 'the "Found something" action');
      await page.keyboard.press('Enter');
      await page.waitForURL(new RegExp(`/s/${SCHOOL}/found`), { timeout: TIMEOUTS.navigation });
    }));

  it('found wizard: bottle, photo, keyboard pin, note and description; done shows the ID and deadline', T, async (t) => {
    if (!status.workerUp) return t.skip(WORKER_DOWN);
    await withBrowser(t, async (s) => {
      const { page } = s;
      const description = uniqueText('e2e navy metal water bottle');
      const { publicId, pinFeedback } = await postFoundItem(page, SCHOOL, {
        description,
        note: 'C214 by the window',
        photo: await jpegPhoto(),
      });
      shared.studentItem = { description, publicId };
      t.diagnostic(`posted ${publicId}; pin reported as: ${pinFeedback.join(' | ')}`);
      await shown(page.getByText(DEADLINE), 'done screen: the drop-off deadline ("bring it to ... by ...")');
      const uploads = s.requests.filter((r) => r.method === 'PUT');
      assert.ok(uploads.length >= 1, 'the photo went straight to storage with a presigned PUT');
      assertCleanConsole(s, 'the found wizard');
    });
  });

  it('a high-value category (phone) shows "take it to the office" and creates no upload', T, (t) =>
    withBrowser(t, async (s) => {
      const { page } = s;
      await open(page, `${HOME}/found`);
      // The directions must come from choosing Phone: new "take it to" text (a screen or an inline
      // panel), not a hint the category step already showed.
      const office = page.getByText(/take it to/i);
      await shown(categoryChoice(page, CATEGORY.phone).or(categorySelect(page)), 'the category step');
      const hintsBefore = await office.count();
      await chooseCategory(page, CATEGORY.phone);
      const directed = async () =>
        (await office.count()) > hintsBefore || ((await isShown(office)) && !(await isShown(categoryChoice(page, CATEGORY.bottle))));
      if (!(await eventually(directed, { timeout: 2_500 }).catch(() => false))) {
        await clickNext(page, 'category step');
        await eventually(directed, { message: 'choosing Phone never showed "take it to the office" directions' });
      }
      await shown(page.getByText(/office|booth/i), 'where to take it');
      await shown(page.getByText(/\d{1,2}(:\d{2})?\s*[ap]\.?m\b|school days|lunch/i), 'the office hours');
      await settle(page);
      await sleep(500);
      assert.equal(await fileInput(page).count(), 0, 'the office screen offers no photo capture');
      const writes = s.requests.filter(
        (r) => r.method === 'PUT' || (r.method === 'POST' && /\/api\/s\/[^/]+\/items(\/|$)/.test(new URL(r.url).pathname)),
      );
      assert.deepEqual(writes, [], 'a high-value category creates no draft and uploads nothing (§5.1 step 2)');
      assertCleanConsole(s, 'the high-value redirect');
    }));

  it('the lost report form files a report and "Your lost reports" lists it', T, (t) =>
    withBrowser(t, async (s) => {
      const { page } = s;
      const description = uniqueText('e2e lost green hydroflask with stickers');
      await open(page, `${HOME}/lost`);
      await shown(
        page.getByText(/(clear|delet|eras)\w*\b[^.]{0,80}\b(browser|data|cookies|history)/i),
        'the note that clearing browser data loses the report (§5.2 step 5)',
      );
      // One page or a short wizard: category (optional), description, optional pin and date, submit.
      let chosen = false;
      let described = false;
      let submitted = false;
      for (let step = 0; step < 5 && !submitted; step++) {
        if (!chosen && ((await isShown(categoryChoice(page, CATEGORY.bottle))) || (await isShown(categorySelect(page))))) {
          await chooseCategory(page, CATEGORY.bottle);
          chosen = true;
        }
        const box = described ? null : await textboxNamed(page, LOST_DESCRIPTION);
        if (box) {
          await box.fill(description);
          described = true;
        }
        const submit = page.getByRole('button', { name: SUBMIT });
        if (described && (await isShown(submit))) {
          // The report is saved by POST /api/s/[code]/lost-reports (or a server action on /lost).
          const [saved] = await Promise.all([
            page.waitForResponse((r) => r.request().method() === 'POST' && /\/lost/.test(new URL(r.url()).pathname), {
              timeout: TIMEOUTS.navigation,
            }),
            submit.first().click(),
          ]);
          assert.ok(saved.status() < 400, `saving the report returned ${saved.status()}: ${(await saved.text().catch(() => '')).slice(0, 300)}`);
          submitted = true;
        } else {
          await clickNext(page, 'lost report form');
        }
      }
      assert.ok(described, 'lost report form: no description field');
      assert.ok(submitted, 'lost report form: no submit button');
      await settle(page);
      if (!new URL(page.url()).pathname.endsWith('/lost/mine')) await open(page, `${HOME}/lost/mine`);
      await shown(page.getByText(description), '"Your lost reports" lists the new report');
      await open(page, HOME);
      await shown(action(page, /your lost reports/i), 'the "Your lost reports" card on home');
      assertCleanConsole(s, 'the lost report flow');
    }));

  it('searching for "bottle" navigates to the results', T, (t) =>
    withBrowser(t, async ({ page }) => {
      await open(page, HOME);
      const box = await shown(page.getByRole('searchbox', { name: /search/i }), 'the search box');
      await box.fill('bottle');
      await box.press('Enter');
      await page.waitForURL(new RegExp(`/s/${SCHOOL}/search\\?(.+&)?q=bottle(&|$)`), { timeout: TIMEOUTS.navigation });
      await settle(page);
      await shown(page.getByRole('heading', { name: /\bmatch(es)?\b|results/i }), 'the results heading ("3 matches" or "No matches")');
    }));

  it('/offline renders', T, (t) =>
    withBrowser(t, async (s) => {
      const res = await open(s.page, '/offline');
      assert.equal(res.status(), 200, 'GET /offline');
      await shown(s.page.getByRole('heading', { level: 1 }), 'the offline page heading');
      await shown(s.page.getByText(/offline|connection|internet|unavailable|not available/i), 'the offline explanation');
      assertCleanConsole(s, '/offline');
    }));

  it('security headers on the school home: CSP with nonce and frame-ancestors, noindex, no-referrer (§19)', T, (t) =>
    withBrowser(t, async ({ page }) => {
      const res = await page.goto(HOME);
      const h = res.headers();
      const csp = h['content-security-policy'] ?? '';
      assert.match(csp, /frame-ancestors 'none'/, `content-security-policy: ${csp}`);
      const nonce = /'nonce-([A-Za-z0-9+/_=-]{16,})'/.exec(csp)?.[1];
      assert.ok(nonce, `content-security-policy has no nonce: ${csp}`);
      assert.match(h['x-robots-tag'] ?? '', /noindex/, `x-robots-tag: ${h['x-robots-tag']}`);
      assert.equal(h['referrer-policy'], 'no-referrer');
      const scriptNonces = await page.evaluate(() => [...document.scripts].map((el) => el.nonce).filter(Boolean));
      assert.ok(scriptNonces.includes(nonce), 'the page scripts carry this response\'s CSP nonce');
      const again = await page.request.get(HOME);
      const second = new RegExp(`'nonce-(?!${esc(nonce)}')`).test(again.headers()['content-security-policy'] ?? '');
      assert.ok(second, 'the nonce changes on every request');
    }));

  it('student pages log no console errors', T, (t) =>
    withBrowser(t, async (s) => {
      for (const path of STUDENT_PAGES) {
        const res = await open(s.page, path);
        assert.ok(res.status() < 400, `GET ${path} returned ${res.status()}`);
        await sleep(500); // late hydration and effect errors
      }
      assertCleanConsole(s, STUDENT_PAGES.join(', '));
    }));
});
