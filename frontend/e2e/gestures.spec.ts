import { devices, type CDPSession, type Locator, type Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { forgetShoppingItems } from './helpers';

/**
 * The gestures of §C-gestures, driven with **real touch input**.
 *
 * Every assertion here is about something a component test structurally cannot
 * see: whether the browser's own scrolling still works while a swipeable list
 * is under the finger, whether a drag beginning at the screen edge is left to
 * the system, and whether a long press opens a sheet *without* the row's tap
 * also navigating out from under it.
 *
 * ## Why Chromium at iPhone 15 metrics
 *
 * Touch here is dispatched through CDP `Input.dispatchTouchEvent`, which enters
 * the browser where a finger does: it reaches the compositor, so a vertical
 * drag genuinely scrolls the page rather than merely firing a `touchmove`
 * listener. WebKit exposes no equivalent — `new Touch()` is an illegal
 * constructor there and there is no CDP — so a WebKit run could only dispatch
 * synthetic events, which would prove the handlers run and prove nothing at all
 * about scrolling. The viewport, DPR and `hasTouch` are iPhone 15's, so
 * `(pointer: coarse)` matches and the gestures are enabled exactly as they are
 * on the owner's phone.
 */
test.use({ ...devices['iPhone 15'], browserName: 'chromium' });

// The file forces its own browser, so it would otherwise run identically in
// both configured projects. Once is enough.
test.beforeEach(() => {
  // `test.info()` rather than the hook's second argument: Playwright insists
  // the first parameter of a hook be a destructuring pattern for the fixtures
  // it wants, and an empty one (`({}, testInfo) =>`) is both rejected by
  // Playwright at runtime and by `no-empty-pattern` at lint time.
  test.skip(
    test.info().project.name !== 'mobile-safari',
    'runs once, under its own forced Chromium/iPhone-15 configuration',
  );
});

/**
 * Stamps this file has written rows under, cleared after every test.
 *
 * The suite must leave zero rows behind. `helpers.ts` sweeps this file's debris
 * after thirty minutes as a net for a run that dies mid-test, but a healthy run
 * cleans up after itself — accumulated rows are not inert here: the shopping
 * screen renders every item on one page, and a hundred leftovers is a list that
 * takes a second to lay out and a `boundingBox()` three thousand pixels down.
 *
 * Module scope is safe because Playwright runs a worker's tests one at a time,
 * and each worker has its own copy of this module.
 */
const writtenStamps: string[] = [];

function newStamp(): string {
  const stamp = String(Date.now());
  writtenStamps.push(stamp);
  return stamp;
}

test.afterEach(() => {
  let stamp = writtenStamps.pop();
  while (stamp !== undefined) {
    forgetShoppingItems(stamp);
    stamp = writtenStamps.pop();
  }
});

/** §G3: the iOS back gesture starts within ~20–30px of the left edge. */
const DEAD_ZONE_PX = 32;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bring a row somewhere a finger can actually reach it, and hand back the exact
 * point to touch.
 *
 * Load-bearing, not tidiness, and the source of the only real flake this file
 * has had. Two things conspire:
 *
 *  - CDP touch coordinates are **viewport** coordinates, so dispatching at a
 *    `boundingBox()` taken from a row 2000px down the document lands on empty
 *    space — and every assertion of the form "the row did not move" then passes
 *    for entirely the wrong reason.
 *  - the shopping screen's quick-add composer is `sticky` at the bottom, and a
 *    row scrolled to the foot of the list can end up underneath it. Scrolling
 *    "into view" is not the same as being touchable.
 *
 * So the point is **verified** rather than computed: `elementFromPoint` has to
 * report something inside this row before the caller is allowed to touch it,
 * and the helper fails with a sentence rather than letting a test quietly
 * measure the wrong thing.
 */
async function touchPoint(
  page: Page,
  row: Locator,
  offsetFromRight: number,
): Promise<{ box: Box; x: number; y: number }> {
  await expect(row).toBeVisible({ timeout: 15_000 });
  // Nothing may hold focus: a focused composer grows, and the page scrolls
  // under it while we are trying to measure.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });

  for (const block of ['center', 'start', 'center'] as const) {
    await row.evaluate((node, position) => {
      node.scrollIntoView({ block: position });
    }, block);
    await page.waitForTimeout(250);

    const box = await row.boundingBox();
    if (box === null) continue;
    const x = box.x + box.width - offsetFromRight;
    const y = box.y + box.height / 2;
    const reachable = await row.evaluate(
      (node, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit !== null && node.contains(hit);
      },
      { x, y },
    );
    if (reachable) return { box, x, y };
  }

  throw new Error(
    'the row could not be brought clear of the page chrome — a touch dispatched ' +
      'at its box would land on something else, and the test would prove nothing',
  );
}

/**
 * A finger. Deliberately many small steps with a frame between them: the axis
 * lock in `SwipeRow` reads the *first* few pixels of travel, and a single jump
 * from start to end would skip the very decision under test.
 */
async function drag(
  cdp: CDPSession,
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 14,
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function longPress(cdp: CDPSession, page: Page, at: { x: number; y: number }): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y }],
  });
  // 450ms is the threshold; 700 leaves room for the timer without becoming a
  // different gesture.
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function openFirstList(page: Page): Promise<void> {
  await page.goto('/shopping');
  const link = page.locator('a[href^="/shopping/"]').first();
  await expect(link, 'the seed should have left at least one shopping list').toBeVisible({
    timeout: 15_000,
  });
  await link.click();
  await expect(page).toHaveURL(/\/shopping\/[^/]+$/);
}

/**
 * The `SwipeRow` for a named item.
 *
 * Assertions go through this rather than `getByText(name)`, because the item's
 * name is also sitting in the quick-add textarea for a moment after the add and
 * would be its own second match.
 */
function rowFor(page: Page, name: string): Locator {
  return page.locator('[data-slot="swipe-row"]').filter({ hasText: name }).first();
}

/** One товар per line — the quick-add composer's own contract. */
const NEWLINE = '\n';

async function addItems(page: Page, names: readonly string[]): Promise<void> {
  const field = page.getByPlaceholder(/Например, 2 кг картошки/i);
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill(names.join(NEWLINE));
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const last = names.at(-1);
  if (last !== undefined) await expect(rowFor(page, last)).toBeVisible({ timeout: 15_000 });
}

/**
 * Writes `name` **and three rows after it**, then returns the row for `name`.
 *
 * The padding is not decoration. A freshly added item is appended to the end of
 * the list, and the last row of the list is the one place the sticky quick-add
 * composer can end up sitting on top of: at maximum scroll the page cannot move
 * any further, so no amount of `scrollIntoView` will bring that row clear. Three
 * rows beneath the target is ~174px of list, which is enough for the page to
 * scroll the target into the open.
 */
async function addPaddedItem(page: Page, name: string, stamp: string): Promise<Locator> {
  await addItems(page, [
    name,
    ...Array.from({ length: 3 }, (_, index) => `Ниже${String(index)} ${stamp}`),
  ]);
  return rowFor(page, name);
}

/**
 * Start the drag inboard of the trailing `⋯`. Starting *on* it would still
 * swipe, but a gesture that never engages would then land as a tap on the
 * overflow control, and the test could not tell the two outcomes apart.
 */
const TRAILING_CONTROL_PX = 60;

test.describe('swipe left on a shopping item', () => {
  test('reveals, fires, and the undo toast puts it back', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const stamp = newStamp();
    const name = `Молоко ${stamp}`;

    await openFirstList(page);
    const row = await addPaddedItem(page, name, stamp);
    const { box, x: startX, y } = await touchPoint(page, row, TRAILING_CONTROL_PX);
    const panel = row.locator('[data-slot="swipe-row-panel"]');

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
    });
    for (let step = 1; step <= 14; step += 1) {
      const x = startX - ((startX - (box.x + 20)) * step) / 14;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
      if (step === 7) {
        // Mid-gesture: the row is tracking the finger, which is the half of
        // §G4 that a "did the mutation fire" assertion cannot see.
        const transform = await panel.evaluate((node) => (node as HTMLElement).style.transform);
        expect(transform, 'the row must follow the finger, 1:1').toMatch(/translate3d\(-\d/);
      }
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // The write went through the outbox and the item left the aisle for the
    // collapsed «Куплено» tail.
    await expect(rowFor(page, name)).toHaveCount(0, { timeout: 15_000 });

    // §G4: a six-second «Отменить», and it must actually reverse the action.
    const undo = page.getByRole('button', { name: 'Отменить' });
    await expect(undo).toBeVisible({ timeout: 5_000 });
    await undo.click();

    await expect(rowFor(page, name), 'undo has to put the item back').toBeVisible({
      timeout: 15_000,
    });
  });

  test('ignores a drag that starts inside the 32px left edge', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const stamp = newStamp();
    const name = `Хлеб ${stamp}`;

    await openFirstList(page);
    const row = await addPaddedItem(page, name, stamp);
    const { y } = await touchPoint(page, row, TRAILING_CONTROL_PX);
    const panel = row.locator('[data-slot="swipe-row-panel"]');

    /*
     * A finger mid-back-gesture: it starts two pixels inside the dead zone and
     * travels 29px left — comfortably past the 12px the axis lock engages at,
     * so the row *would* move if the dead zone were not there.
     *
     * The assertion has to be taken **during** the drag. A row that engages and
     * is then released short of the 88px rest stop snaps back to `transform:
     * ''`, which is indistinguishable from a row that never moved: an earlier
     * revision of this test asserted after `touchend` and passed happily with
     * the dead zone set to 0.
     */
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: DEAD_ZONE_PX - 2, y }],
    });
    for (let step = 1; step <= 14; step += 1) {
      const x = DEAD_ZONE_PX - 2 - ((DEAD_ZONE_PX - 3) * step) / 14;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
      expect(
        await panel.evaluate((node) => (node as HTMLElement).style.transform),
        'the row must not move at all — that drag belongs to the system',
      ).toBe('');
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(rowFor(page, name)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Отменить' })).toHaveCount(0);
  });

  test('does not stop the list from scrolling', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const stamp = newStamp();

    await openFirstList(page);
    /*
     * The list makes its own scrollable page rather than trusting the seed's.
     * An earlier revision took the list as it found it and went red on other
     * machines, because "is this screen taller than the phone" is a property of
     * whatever rows happen to be in the database — including rows left behind
     * by other runs, which are now swept. Twelve 56px rows plus the composer is
     * comfortably past 659px on an iPhone 15 whatever else is there.
     */
    /*
     * `Строка0 …`, not `Позиция 0 …`. The quick-add parser reads the first
     * standalone number on a line as a *quantity* and strips it from the name,
     * so twelve «Позиция N <stamp>» lines all arrive as one name, «Позиция
     * <stamp>», with twelve different quantities — and the row this test then
     * looks for does not exist. Keeping the index glued to a word leaves the
     * parser nothing to take.
     */
    const names = Array.from({ length: 12 }, (_, index) => `Строка${String(index)} ${stamp}`);
    await addItems(page, names);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(overflow, 'the page must be taller than the screen to prove anything').toBeGreaterThan(
      400,
    );

    /*
     * The **first** row on the screen, with the whole list below it — not one of
     * the rows just written. New items are appended, so a row near the end sits
     * at or near maximum scroll, and a drag that asks the page to scroll further
     * down is answered with a delta of zero by a browser doing exactly the right
     * thing. An earlier revision aimed at the middle of the new rows and failed
     * for that reason, which looked like `touch-action` eating the scroll and
     * was nothing of the kind.
     */
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    const row = page.locator('[data-slot="swipe-row"]').first();
    const { box, y } = await touchPoint(page, row, TRAILING_CONTROL_PX);

    const before = await page.evaluate(() => window.scrollY);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
      ),
      'there has to be page left to scroll, or the assertion measures nothing',
    ).toBeGreaterThan(300);

    /*
     * A vertical drag that starts on a swipeable row. `touch-action: pan-y` on
     * the moving layer is what lets the compositor scroll this instead of the
     * row swallowing the gesture. Mutation-verified: with `touch-none` on that
     * layer the delta below comes back as 0.
     */
    const x = box.x + box.width / 2;
    await drag(cdp, page, { x, y }, { x, y: y - 240 }, 18);
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => window.scrollY);
    expect(after - before, 'a swipeable list must still scroll under the finger').toBeGreaterThan(
      100,
    );
    await expect(page.getByRole('button', { name: 'Отменить' })).toHaveCount(0);
  });
});

test.describe('long press on a task row', () => {
  test('opens the action sheet without also opening the task', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);

    await page.goto('/tasks');
    const row = page.locator('[data-slot="swipe-row"]').first();
    await expect(row, 'the seed should have left at least one chore').toBeVisible({
      timeout: 15_000,
    });
    const { box } = await touchPoint(page, row, TRAILING_CONTROL_PX);

    await longPress(cdp, page, {
      // Away from the 44px tick on the left and the chevron on the right.
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    await expect(page, 'the row must not navigate out from under its own sheet').toHaveURL(
      /\/tasks$/,
    );
    // §G5/§D2: the sheet is the row's own menu. «Возьму на себя» only appears on
    // an unassigned chore, so the stable entry is the one every row carries.
    await expect(sheet.getByRole('button', { name: 'Открыть дело' })).toBeVisible();
  });
});


/* -------------------------------------------------------------------------- */
/* §G6 — pull to refresh                                                       */
/* -------------------------------------------------------------------------- */

/** §G6: travel before the release refetches. */
const PULL_THRESHOLD_PX = 64;

/**
 * Every `GET` the app makes for real data, as it makes it.
 *
 * `/api/changes` is excluded and that exclusion is the whole point: the change
 * feed polls on its own timer, so an assertion of the form "a request happened"
 * would come true a second or two after *any* gesture, and a pull-to-refresh
 * that did nothing at all would pass. What is counted is the queries the
 * refetch is supposed to move.
 */
function watchApiReads(page: Page): { urls: string[] } {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const url = request.url();
    if (!url.includes('/api/')) return;
    if (url.includes('/api/changes')) return;
    urls.push(url);
  });
  return { urls };
}

/**
 * A finger dragged straight down, reporting whether the indicator ever showed.
 *
 * The indicator has to be sampled **during** the drag: it is mounted only while
 * `distance > 0` or a refetch is in flight, so by the time `touchend` has
 * settled there is nothing left to assert against either way — which is exactly
 * the shape of assertion that passes whether the gesture works or not.
 */
async function pullDown(
  cdp: CDPSession,
  page: Page,
  from: { x: number; y: number },
  distance: number,
  steps = 16,
): Promise<boolean> {
  const indicator = page.locator('[data-slot="pull-to-refresh"]');
  let seen = false;

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x, y: from.y + (distance * step) / steps }],
    });
    await page.waitForTimeout(16);
    if (!seen) seen = (await indicator.count()) > 0;
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return seen;
}

/** A list long enough for the document to scroll, and the page parked at the top. */
async function tallList(page: Page, stamp: string): Promise<void> {
  await openFirstList(page);
  // `Строка0 …` rather than `Позиция 0 …`: the quick-add parser reads the first
  // standalone number on a line as a quantity and strips it from the name.
  await addItems(
    page,
    Array.from({ length: 12 }, (_, index) => `Строка${String(index)} ${stamp}`),
  );
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(overflow, 'the page must be taller than the screen to prove anything').toBeGreaterThan(400);
}

/**
 * §G6, driven with real touches.
 *
 * The component had unit tests and no host: it was mounted in `AppShell` as
 * part of this work, so the first thing worth proving is that the gesture is
 * reachable at all in the assembled app — that the document really is the
 * scroll container the component reads, that `(pointer: coarse)` matches, and
 * that nothing between the shell and the row swallows the drag.
 *
 * Refetch is observed as **requests**, not as a spy: `refetchQueries({ type:
 * 'active' })` is the behaviour under test and the only honest evidence of it
 * is traffic leaving the browser.
 */
test.describe('pull to refresh', () => {
  test('refetches the screen when pulled from the top', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);

    await page.goto('/');
    // Settle first, so the reads counted below are the gesture's and not the
    // page's own first load.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    /*
     * A marker a reload would wipe. §G6 is emphatic that this gesture must
     * never `location.reload()` — in an installed PWA that is a cold start
     * which throws away the Query cache, the shopping outbox and any half-typed
     * form (research §8) — and "the page is still the same page" is the only
     * assertion that actually distinguishes a refetch from a reload.
     */
    await page.evaluate(() => {
      (window as unknown as { __beforePull?: boolean }).__beforePull = true;
    });

    const reads = watchApiReads(page);
    const sawIndicator = await pullDown(cdp, page, { x: 200, y: 180 }, PULL_THRESHOLD_PX * 3);

    expect(sawIndicator, 'the band must grow out from under the app bar while pulling').toBe(true);
    await expect
      .poll(() => reads.urls.length, {
        message: 'releasing past the threshold has to refetch the active queries',
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    expect(
      await page.evaluate(() => (window as unknown as { __beforePull?: boolean }).__beforePull),
      'refetch, never location.reload() — a reload would have wiped this',
    ).toBe(true);
  });

  test('stays out of the way mid-page, where the drag is a scroll', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const stamp = newStamp();

    await tallList(page, stamp);
    await page.evaluate(() => {
      window.scrollTo(0, 300);
    });
    await page.waitForTimeout(250);
    const before = await page.evaluate(() => window.scrollY);
    expect(before, 'the page has to actually be scrolled for this to mean anything').toBeGreaterThan(
      200,
    );
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    const reads = watchApiReads(page);
    const sawIndicator = await pullDown(cdp, page, { x: 200, y: 200 }, 200);

    // §G6: `scrollY !== 0` means the finger is scrolling, and a refresh
    // triggered from the middle of a list is a refresh nobody asked for.
    expect(sawIndicator, 'nothing may appear when the gesture starts mid-page').toBe(false);
    await page.waitForTimeout(500);
    expect(reads.urls, 'no refetch may be provoked from mid-page').toEqual([]);
    // And the drag did what it was: it scrolled back up.
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(before);
  });

  test('leaves ordinary scrolling — and the rows it starts on — alone', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const stamp = newStamp();

    await tallList(page, stamp);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);

    /*
     * The drag starts **on a swipe row**, at the very top of the page, and goes
     * up. Three things have to hold at once and only a real touch can show it:
     * the page scrolls (the pull's `preventDefault` must not fire on an upward
     * drag), the indicator never appears, and the row underneath does not move
     * — the two gestures share the same first few pixels of travel and must not
     * both claim them.
     */
    const row = page.locator('[data-slot="swipe-row"]').first();
    const { box, y } = await touchPoint(page, row, TRAILING_CONTROL_PX);
    const panel = row.locator('[data-slot="swipe-row-panel"]');
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(250);

    const reads = watchApiReads(page);
    const indicator = page.locator('[data-slot="pull-to-refresh"]');
    const x = box.x + box.width / 2;
    const before = await page.evaluate(() => window.scrollY);

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 18; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - (240 * step) / 18 }],
      });
      await page.waitForTimeout(16);
      expect(await indicator.count(), 'an upward drag is not a pull').toBe(0);
      expect(
        await panel.evaluate((node) => (node as HTMLElement).style.transform),
        'a vertical drag belongs to the scroller, not to the row',
      ).toBe('');
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);

    expect(
      (await page.evaluate(() => window.scrollY)) - before,
      'mounting pull-to-refresh must not cost the page its scrolling',
    ).toBeGreaterThan(100);
    expect(reads.urls, 'scrolling is not a refresh').toEqual([]);
    await expect(page.getByRole('button', { name: 'Отменить' })).toHaveCount(0);
  });
});
