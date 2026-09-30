// Browser E2E for the staff app (§5.3, §5.4; 04 staff screen inventory): dev sign-in, the review
// queue, the review card approved by its keyboard shortcut with a visible button equivalent
// (Appendix H), office custody (receive, then claim, with confirmation), and cross-school denial.
// Needs the local stack with RECOVER_DEV_LOGIN=1 (scripts/dev-env.mjs sets it). Skips otherwise.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OTHER_SCHOOL, SCHOOL, TIMEOUTS, WORKER_DOWN, stackStatus, warm, withBrowser } from '../../playwright.config.mjs';
import { NO_HARNESS, createPendingItem, itemIdFor, itemState, jpegPhoto, loadHarness, shared, uniqueText } from './lib/data.mjs';
import { confirmStep, devLoginAvailable, devSignIn, scopeFor, shortcutFor } from './lib/staff.mjs';
import { esc, eventually, isShown, open, postFoundItem, settle, shown, textboxNamed } from './lib/ui.mjs';

const REVIEWER = 'reviewer.fchs@recover.test';
const OFFICE = 'office.fchs@recover.test';
const OTHER_STAFF = 'admin.sfhs@recover.test'; // school_admin at SFHS only
const QUEUE = `/staff/${SCHOOL}/queue`;
const CUSTODY = `/staff/${SCHOOL}/custody`;
const APPROVE = /^approve(?! with)\b/i;
const OPEN_CARD = /^(review|open|details|view)\b/i;
const RECEIVE = /^(receive|check in|mark (as )?received|arrived)\b/i;
const CLAIM = /^(claim|mark (as )?claimed|returned|give (it )?back|hand (it )?over)\b/i;

const status = await stackStatus();
const login = status.up ? await devLoginAvailable() : { ok: false };
const skip = status.skip || (login.ok ? false : login.why);
const h = skip ? null : await loadHarness();
const T = { timeout: TIMEOUTS.test };

// What identifies the item in staff lists: its public ID or its description.
function itemText(item) {
  return new RegExp(item.publicId ? `${esc(item.publicId)}|${esc(item.description)}` : esc(item.description), 'i');
}

async function dbState(item) {
  return h && item.itemId ? itemState(h, item.itemId) : null;
}

// Clicks the item's own `actionRe` button: in its row on the current page, or else on the item's
// page (reached by its link, or by looking up its public ID).
async function actOnItem(page, item, actionRe, what) {
  const text = itemText(item);
  let scope = await eventually(() => scopeFor(page, text, actionRe), { timeout: 10_000 }).catch(() => null);
  if (!scope) {
    const link = page.getByRole('link').filter({ hasText: text });
    const lookup = item.publicId ? await textboxNamed(page, /item id|scan|look ?up|find|search/i) : null;
    if (await isShown(link)) {
      await link.first().click();
    } else if (lookup) {
      await lookup.fill(item.publicId);
      await lookup.press('Enter');
    }
    await settle(page);
    scope = page.locator('main');
  }
  const button = await shown(scope.getByRole('button', { name: actionRe }), `${what}: the button for ${item.publicId ?? item.description}`);
  await button.click();
}

describe('staff app in a browser', { skip }, () => {
  const state = {};
  before(() => warm(['/staff/signin', QUEUE, CUSTODY, '/staff/forbidden']), { timeout: 300_000 });
  after(async () => {
    await h?.closeAdmin?.();
  });

  it('dev sign-in at /staff/signin brings the reviewer to the FCHS queue', T, (t) =>
    withBrowser(t, async ({ page, context }) => {
      await devSignIn(page, REVIEWER);
      if (new URL(page.url()).pathname !== QUEUE) await open(page, QUEUE); // a picker or other landing page
      assert.equal(new URL(page.url()).pathname, QUEUE, 'the reviewer can open the FCHS queue');
      await shown(page.getByRole('heading', { level: 1 }), 'the queue heading');
      state.reviewer = await context.storageState();
    }));

  it('the queue lists a pending student item', T, async (t) => {
    if (!state.reviewer) return t.skip('the reviewer did not sign in');
    const description = uniqueText('e2e staff queue bottle');
    if (shared.studentItem) {
      // Run in one process with the student suite: review the item its wizard posted.
      state.item = { ...shared.studentItem };
      if (h) state.item.itemId = await itemIdFor(h, state.item.publicId);
      t.diagnostic(`reviewing ${state.item.publicId} from the student suite`);
    } else if (!status.workerUp) {
      return t.skip(WORKER_DOWN);
    } else if (h) {
      state.item = await createPendingItem(h, { description });
    } else {
      t.diagnostic(`${NO_HARNESS}; posting through the student wizard instead`);
      const { publicId } = await withBrowser(`${t.name} (student post)`, async ({ page }) =>
        postFoundItem(page, SCHOOL, { description, note: 'e2e staff-only note', photo: await jpegPhoto() }),
      );
      state.item = { description, publicId };
    }
    await withBrowser(
      t,
      async ({ page }) => {
        await eventually(
          async () => {
            await open(page, QUEUE);
            return isShown(page.getByText(itemText(state.item)));
          },
          { timeout: 60_000, interval: 3_000, message: `the pending item "${state.item.description}" never showed in ${QUEUE}` },
        );
      },
      { storageState: state.reviewer },
    );
  });

  it(`${OTHER_SCHOOL} staff are denied ${QUEUE} (403 page or redirect)`, T, (t) =>
    withBrowser(t, async ({ page }) => {
      await devSignIn(page, OTHER_STAFF);
      const res = await page.goto(QUEUE);
      await settle(page);
      const url = new URL(page.url());
      assert.ok(!url.pathname.startsWith('/staff/signin'), `${OTHER_STAFF} was sent to sign in instead of being denied: ${url.pathname}${url.search}`);
      const status403 = res.status() === 403;
      assert.ok(status403 || !url.pathname.startsWith(`/staff/${SCHOOL}/`), `expected a 403 page or a redirect away from ${QUEUE}; got ${res.status()} at ${url.pathname}`);
      if (status403 || url.pathname.startsWith('/staff/forbidden')) {
        await shown(page.getByText(/do not have access|don't have access|not a member|no access|not allowed|forbidden/i), 'the access-denied message');
      }
      if (state.item) assert.equal(await page.getByText(itemText(state.item)).count(), 0, `${SCHOOL} queue content is visible to ${OTHER_SCHOOL} staff`);
    }));

  it('the review card approves with its keyboard shortcut and also has a visible Approve button', T, async (t) => {
    if (!state.item) return t.skip('no pending item to review');
    await withBrowser(
      t,
      async ({ page }) => {
        await open(page, QUEUE);
        const text = itemText(state.item);
        await shown(page.getByText(text), `the item "${state.item.description}" in the queue`);

        // Open the card: a link on the card itself, or a Review link or button in its row. A queue
        // that reviews inline has neither; then the card is the item's row.
        let card = page.locator('main');
        let inline = false;
        const cardLink = page.getByRole('link').filter({ hasText: text });
        const row = await scopeFor(page, text, OPEN_CARD);
        if (await isShown(cardLink)) {
          await cardLink.first().click();
        } else if (row) {
          await row.getByRole('link', { name: OPEN_CARD }).or(row.getByRole('button', { name: OPEN_CARD })).first().click();
        } else {
          card = await scopeFor(page, text, APPROVE);
          assert.ok(card, `no way to open the review card for "${state.item.description}" from the queue`);
          inline = true;
        }
        if (!inline) await page.waitForURL(new RegExp(`/staff/${SCHOOL}/items/`), { timeout: TIMEOUTS.navigation }).catch(() => {});
        await settle(page);

        const approve = await shown(card.getByRole('button', { name: APPROVE }), 'the visible Approve button on the review card');
        const key = await shortcutFor(approve, 'a');
        const startUrl = page.url();
        // The database decides when the harness is here; otherwise the page must say so, move on, or
        // (inline queue) drop the item from the pending list.
        const approved = async () => {
          const db = await dbState(state.item);
          if (db) return db.review_status === 'approved';
          return (
            page.url() !== startUrl ||
            (await isShown(page.getByText(/\bapproved\b|publishing|getting (the )?photos ready|generating/i))) ||
            (inline && !(await isShown(page.getByText(text))))
          );
        };

        // Letter keys do not activate a focused button, so pressing the key with focus on this card's
        // Approve button still tests the shortcut, and keeps an inline queue on the right card.
        if (inline) await approve.focus();
        else await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press(key);
        if (!(await eventually(approved, { timeout: 6_000 }).catch(() => false))) {
          // A shortcut may be live only while the card has focus (WCAG 2.1.4): try again from there.
          await approve.focus();
          await page.keyboard.press(key);
          await eventually(approved, { message: `pressing "${key}" on the review card did not approve the item` });
        }
        t.diagnostic(`approved with the "${key}" shortcut`);
      },
      { storageState: state.reviewer },
    );
  });

  it('the office user receives, then claims, the item on the custody page with confirmation steps', T, async (t) => {
    if (!state.item) return t.skip('no item to take through custody');
    await withBrowser(t, async ({ page }) => {
      await devSignIn(page, OFFICE);
      const res = await open(page, CUSTODY);
      assert.equal(res.status(), 200, `GET ${CUSTODY}`);
      assert.equal(new URL(page.url()).pathname, CUSTODY, 'the office user can open the custody page');
      await shown(page.getByRole('heading', { level: 1 }), 'the custody page heading');

      await actOnItem(page, state.item, RECEIVE, 'receive');
      const receiveConfirmed = await confirmStep(page, 'receive', { required: false });
      t.diagnostic(`receive ${receiveConfirmed ? 'had' : 'had no'} confirmation step`);
      if (h && state.item.itemId) {
        await eventually(async () => (await dbState(state.item))?.custody === 'at_location', { message: 'custody never became at_location' });
      }

      await open(page, CUSTODY);
      await actOnItem(page, state.item, CLAIM, 'claim');
      await confirmStep(page, 'claim (§5.4: staff verify ownership in person)', { required: true });
      if (h && state.item.itemId) {
        await eventually(async () => (await dbState(state.item))?.custody === 'claimed', { message: 'custody never became claimed' });
      } else {
        await shown(page.getByText(/\bclaimed\b|returned to (its|the) owner/i), 'the item shows as claimed');
      }
    });
  });
});
