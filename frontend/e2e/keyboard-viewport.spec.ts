import { devices, type Page } from '@playwright/test';

import { expect, test } from './fixtures';

/**
 * The software keyboard and the bottom of the screen.
 *
 * ## What is being reproduced
 *
 * Reported from the owner's installed app on iOS 26.6: «после открытия
 * клавиатуры мобильной — снизу появляется отступ». A band of empty background
 * is left between the bottom edge of a bottom sheet — and of the tab bar — and
 * the bottom of the display, and it stays.
 *
 * No browser this suite can drive has WebKit's viewport defects, and none can
 * open a real iOS keyboard. What is driven here is the mechanism, in two ways.
 *
 * **The engine's.** A keyboard-sized reduction of the viewport, held past the
 * compensator's settle window and then reverted. The assertion that matters is
 * the one *after* the revert: no residual padding, no residual scroll offset,
 * no residual custom property, no gap. That is the reported bug, and it is what
 * this file exists to pin.
 *
 * **The app's.** `--viewport-keyboard` and `--viewport-shortfall`
 * (`src/app/layout/viewport-insets.ts`) are the two numbers the fixed chrome is
 * positioned from, and they are absent on a healthy browser. The last two tests
 * therefore stage them and measure that the chrome moves by exactly that much
 * and no further — the part of the fix a Chromium run can genuinely verify,
 * and the part that would silently rot otherwise.
 *
 * The viewport meta deliberately carries no `interactive-widget`; see
 * `index.html` for the WebKit dates behind that.
 */

test.use({ ...devices['iPhone 15'], browserName: 'chromium' });

test.beforeEach(() => {
  test.skip(
    test.info().project.name !== 'mobile-safari',
    'runs once, under its own forced Chromium/iPhone-15 configuration',
  );
});

/** iPhone 15 in portrait, as `devices` reports it to the page. */
const FULL = { width: 393, height: 659 };

/** A plausible iOS keyboard, in CSS pixels. */
const KEYBOARD_PX = 336;
const REDUCED = { width: FULL.width, height: FULL.height - KEYBOARD_PX };

/** Longer than `SETTLE_MS` in `viewport-insets.ts`, with room for a frame. */
const SETTLED_MS = 700;

interface Measurements {
  innerHeight: number;
  scrollY: number;
  docHeight: number;
  mainPaddingBottom: string;
  tabbarTop: number;
  tabbarBottom: number;
  tabbarComputedBottom: string;
  keyboard: string;
  shortfall: string;
  rootStyleAttribute: string;
}

async function measure(page: Page): Promise<Measurements> {
  return page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Основная навигация"]');
    const box = bar?.getBoundingClientRect();
    const main = document.querySelector('#main');
    const root = document.documentElement;
    return {
      innerHeight: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      docHeight: root.scrollHeight,
      mainPaddingBottom: main === null ? '' : getComputedStyle(main).paddingBottom,
      tabbarTop: Math.round(box?.top ?? Number.NaN),
      tabbarBottom: Math.round(box?.bottom ?? Number.NaN),
      tabbarComputedBottom: bar === null ? '' : getComputedStyle(bar).bottom,
      keyboard: root.style.getPropertyValue('--viewport-keyboard').trim(),
      shortfall: root.style.getPropertyValue('--viewport-shortfall').trim(),
      rootStyleAttribute: root.getAttribute('style') ?? '',
    };
  });
}

/**
 * Makes `(display-mode: standalone)` match, as it does on the Home Screen.
 *
 * Patched in `addInitScript` rather than emulated: `display-mode` is not one of
 * the media features CDP's `Emulation.setEmulatedMedia` can override — it was
 * tried, and `matchMedia('(display-mode: standalone)')` still reported
 * `browser`. Everything other than that one query is delegated to the engine,
 * so `(pointer: coarse)`, `prefers-color-scheme` and `prefers-reduced-motion`
 * are still the real answers.
 *
 * The gate itself is not test-only scaffolding — `viewport-insets.ts` refuses
 * to correct a shortfall in a browser tab on purpose, because a URL bar
 * shrinking `innerHeight` is exactly the false positive that would push the tab
 * bar off the screen.
 */
async function emulateInstalled(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList =>
      query.replace(/\s+/g, '') === '(display-mode:standalone)'
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            dispatchEvent: () => false,
          } as unknown as MediaQueryList)
        : real(query);
  });
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

test('the keyboard-sized reduction leaves nothing behind when it is reverted', async ({ page }) => {
  await emulateInstalled(page);
  await openFirstList(page);
  await page.waitForTimeout(500);

  const before = await measure(page);
  expect(before.tabbarBottom, 'the tab bar starts on the bottom of the viewport').toBe(FULL.height);
  expect(before.shortfall, 'nothing is corrected on a healthy viewport').toBe('');
  expect(before.keyboard, 'and no keyboard inset either').toBe('');

  // Focus the composer, then take the keyboard's height off the viewport —
  // the reported repro, in the order it was reported.
  await page.locator('main textarea').first().click();
  await page.setViewportSize(REDUCED);
  await page.waitForTimeout(SETTLED_MS);

  // …and give it back.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(200);

  const after = await measure(page);

  expect(after.innerHeight, 'the viewport is back').toBe(before.innerHeight);
  expect(after.tabbarBottom, 'the tab bar is back on the bottom of the screen').toBe(
    before.tabbarBottom,
  );
  expect(after.tabbarTop, 'and it is the same height it was').toBe(before.tabbarTop);
  expect(after.tabbarComputedBottom, 'no residual offset on the bar').toBe(
    before.tabbarComputedBottom,
  );
  expect(after.mainPaddingBottom, 'no residual padding under the page').toBe(
    before.mainPaddingBottom,
  );
  expect(after.docHeight, 'the document is the height it was').toBe(before.docHeight);
  expect(after.shortfall, 'the shortfall correction cleared itself').toBe('');
  expect(after.keyboard, 'the keyboard inset cleared itself').toBe('');
  expect(
    after.rootStyleAttribute,
    'the compensator removed its properties rather than zeroing them',
  ).not.toContain('--viewport-');
});

test('while the viewport is reduced the tab bar sits on the bottom of what is visible', async ({
  page,
}) => {
  await emulateInstalled(page);
  await openFirstList(page);
  await page.waitForTimeout(500);

  // With a text control focused the shortfall correction stands down by design
  // — a keyboard that is genuinely up is not that defect.
  await page.locator('main textarea').first().click();
  await page.setViewportSize(REDUCED);
  await page.waitForTimeout(SETTLED_MS);

  const reduced = await measure(page);
  expect(reduced.shortfall, 'no correction while a keyboard is genuinely up').toBe('');
  expect(reduced.tabbarBottom, 'the bar is on the bottom of the visible area').toBe(REDUCED.height);
  expect(reduced.tabbarTop).toBeGreaterThan(0);

  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);
});

test('a drawer opened and closed while the viewport is reduced does not shift the page', async ({
  page,
}) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    window.scrollTo({ top: 120, behavior: 'instant' });
  });
  await page.waitForTimeout(200);
  const before = await measure(page);

  await page.setViewportSize(REDUCED);
  await page.waitForTimeout(300);

  const more = page.getByRole('button', { name: 'Ещё' }).first();
  if ((await more.count()) > 0) {
    await more.click();
    await expect(page.locator('[data-slot="drawer-content"]')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="drawer-content"]')).toBeHidden({ timeout: 5_000 });
  }

  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);

  const after = await measure(page);
  expect(after.scrollY, 'the drawer put the page back exactly where it was').toBe(before.scrollY);
  expect(after.tabbarBottom).toBe(before.tabbarBottom);
  expect(after.shortfall).toBe('');
  expect(after.rootStyleAttribute).not.toContain('--viewport-');
});

test('a layout viewport left short with no keyboard up puts the chrome back on the screen', async ({
  page,
}) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  const before = await measure(page);
  expect(before.tabbarComputedBottom).toBe('0px');

  // The defect's signature: the layout viewport comes back short with nothing
  // focused and the visual viewport agreeing with it. WebKit does this by
  // itself; here it has to be staged.
  const SHORT_BY = 59;
  await page.setViewportSize({ width: FULL.width, height: FULL.height - SHORT_BY });
  await page.waitForTimeout(SETTLED_MS);

  const short = await measure(page);
  expect(short.shortfall, 'the band was measured').toBe(`${String(SHORT_BY)}px`);
  expect(short.tabbarComputedBottom, 'and the bar was pushed down by exactly that much').toBe(
    `-${String(SHORT_BY)}px`,
  );

  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);

  const recovered = await measure(page);
  expect(recovered.shortfall).toBe('');
  expect(recovered.tabbarComputedBottom).toBe('0px');
  expect(recovered.tabbarBottom).toBe(before.tabbarBottom);
});

test('the two bottom-anchor utilities resolve to the numbers the chrome is placed by', async ({
  page,
}) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  // Against the real stylesheet, not a re-implementation of the calc: the
  // failure mode this guards against is the utility being renamed, dropped, or
  // — twice before in this codebase — compiled to nothing.
  const resolved = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'fixed inset-x-0';
    document.body.append(probe);
    const read = (className: string) => {
      probe.className = `fixed inset-x-0 ${className}`;
      return getComputedStyle(probe).bottom;
    };
    const root = document.documentElement;

    const quiet = { bar: read('bottom-viewport'), sheet: read('bottom-above-keyboard') };

    root.style.setProperty('--viewport-keyboard', '300px');
    const typing = { bar: read('bottom-viewport'), sheet: read('bottom-above-keyboard') };

    root.style.removeProperty('--viewport-keyboard');
    root.style.setProperty('--viewport-shortfall', '59px');
    const short = { bar: read('bottom-viewport'), sheet: read('bottom-above-keyboard') };

    root.style.removeProperty('--viewport-shortfall');
    probe.remove();
    return { quiet, typing, short };
  });

  expect(
    resolved.quiet,
    'absent properties mean the chrome sits exactly where it always did',
  ).toEqual({ bar: '0px', sheet: '0px' });
  expect(
    resolved.typing,
    'a keyboard lifts the sheet onto it and leaves the tab bar behind it',
  ).toEqual({ bar: '0px', sheet: '300px' });
  expect(resolved.short, 'a short layout viewport pushes both back down onto the screen').toEqual({
    bar: '-59px',
    sheet: '-59px',
  });

  const after = await measure(page);
  expect(after.rootStyleAttribute, 'the probe cleaned up after itself').not.toContain(
    '--viewport-',
  );
});

test('a sheet keeps its own size, and gives the keyboard only what the keyboard needs', async ({
  page,
}) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  // The three `drawerSize` strings from `responsive-dialog.tsx`, verbatim.
  // Copied rather than imported on purpose: what is under test is what the
  // *built stylesheet* does with them, and the hazard is real — the keyboard
  // term first went in as a separate `max-h-[…]` utility, which Tailwind sorted
  // after `max-h-[60dvh]`, so it won outright and an action sheet quietly
  // gained the freedom to grow to nearly the whole screen. Nothing in the app
  // would have failed; this measures it.
  const SIZES = {
    full: 'h-[calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem_-_var(--viewport-keyboard,0px))]',
    tall: 'h-[min(85dvh,calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem_-_var(--viewport-keyboard,0px)))]',
    auto: 'max-h-[min(60dvh,calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem_-_var(--viewport-keyboard,0px)))]',
  } as const;

  const measured = await page.evaluate((sizes: Record<string, string>) => {
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.insetInline = '0';
    // Taller than any viewport, so an `auto` sheet's `max-height` is what
    // binds. Without content the box measures 0 and every cap looks the same.
    const filler = document.createElement('div');
    filler.style.height = '10000px';
    probe.append(filler);
    document.body.append(probe);
    const read = (className: string): number => {
      probe.className = className;
      return Math.round(parseFloat(getComputedStyle(probe).height));
    };
    const root = document.documentElement;

    const quiet = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, read(v)]));
    root.style.setProperty('--viewport-keyboard', '300px');
    const typing = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, read(v)]));
    root.style.removeProperty('--viewport-keyboard');

    probe.remove();
    return { quiet, typing, viewport: window.innerHeight };
  }, SIZES);

  // `max(env(safe-area-inset-top), 12px) + 12px`, and the inset is 0 here.
  const available = measured.viewport - 24;

  expect(measured.quiet.auto, 'auto is still capped at 60dvh, not at the whole screen').toBe(
    Math.round(measured.viewport * 0.6),
  );
  expect(measured.quiet.tall, 'tall is still 85dvh').toBe(Math.round(measured.viewport * 0.85));
  expect(measured.quiet.full, 'full is still the screen less the top inset').toBe(available);

  // With a keyboard up every size loses exactly the keyboard's height, so the
  // sheet's *top* stays where it was instead of being pushed off the screen.
  expect(measured.typing.full).toBe(available - 300);
  expect(measured.typing.tall).toBe(
    Math.min(Math.round(measured.viewport * 0.85), available - 300),
  );
  expect(measured.typing.auto).toBe(Math.min(Math.round(measured.viewport * 0.6), available - 300));
});
