import { devices, type Page } from '@playwright/test';

import { expect, test } from './fixtures';

/**
 * The software keyboard and the bottom of the screen.
 *
 * ## What this file is for now
 *
 * It began as the pin for a report from the owner's installed app on iOS 26.6:
 * «после открытия клавиатуры мобильной — снизу появляется отступ», a band of
 * empty background left under a bottom sheet and under the tab bar. The fix
 * shipped for that — two custom properties published from `visualViewport` by
 * `app/layout/viewport-insets.ts`, and two `@utility` rules positioning the
 * fixed chrome from them — produced two worse defects on the same phone within
 * the hour, and has been removed in full.
 *
 * So this suite has changed sides. It no longer measures a correction; it
 * measures that **there is none**, and that the chrome is where plain CSS puts
 * it. Three properties are under test:
 *
 * 1. A keyboard-sized reduction of the viewport, held and then reverted,
 *    leaves nothing behind — no residual padding, no residual scroll offset,
 *    no gap. That is the original report, and it is still worth pinning.
 * 2. **Nothing ever writes a `--viewport-*` custom property onto `<html>`.**
 *    This is the regression guard. The old mechanism was invisible to every
 *    gate this project can run — it is absent on a healthy browser by
 *    construction — so the only thing that can catch its return is an
 *    assertion that the property is not there.
 * 3. **The tab bar's computed `bottom` is `0px`, always**, and its box never
 *    leaves the viewport. The second reported defect was a bar pushed 59px
 *    *below* the bottom edge with its icons cut off, by a `bottom:
 *    calc(-1 * var(--viewport-shortfall,0px))` firing on a false positive.
 *    Anything that can make this element's `bottom` negative is a bug.
 *
 * The viewport meta deliberately carries no `interactive-widget`; see
 * `index.html` for the WebKit dates behind that, and for why the keyboard is
 * `vaul`'s problem rather than this app's.
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

/** Longer than any debounce the app could plausibly grow, with room for a frame. */
const SETTLED_MS = 700;

interface Measurements {
  innerHeight: number;
  scrollY: number;
  docHeight: number;
  mainPaddingBottom: string;
  tabbarTop: number;
  tabbarBottom: number;
  tabbarComputedBottom: string;
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
 * It still matters after the removal, and for a sharper reason than before.
 * The mechanism that was removed was **standalone-only**: it stood down in a
 * browser tab on purpose, which is precisely why nobody saw it misbehave until
 * it reached a Home Screen. A regression guard that runs in tab mode would not
 * have caught the thing it is guarding against.
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
  expect(before.tabbarComputedBottom, 'and it is anchored by plain CSS').toBe('0px');
  expect(before.rootStyleAttribute, 'nothing is published onto <html>').not.toContain(
    '--viewport-',
  );

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
  expect(after.tabbarComputedBottom, 'no residual offset on the bar').toBe('0px');
  expect(after.mainPaddingBottom, 'no residual padding under the page').toBe(
    before.mainPaddingBottom,
  );
  expect(after.docHeight, 'the document is the height it was').toBe(before.docHeight);
  expect(after.rootStyleAttribute, 'and still nothing published onto <html>').not.toContain(
    '--viewport-',
  );
});

test('while the viewport is reduced the tab bar sits on the bottom of what is visible', async ({
  page,
}) => {
  await emulateInstalled(page);
  await openFirstList(page);
  await page.waitForTimeout(500);

  await page.locator('main textarea').first().click();
  await page.setViewportSize(REDUCED);
  await page.waitForTimeout(SETTLED_MS);

  const reduced = await measure(page);
  expect(reduced.tabbarComputedBottom, 'still plain CSS').toBe('0px');
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
  expect(after.rootStyleAttribute).not.toContain('--viewport-');
});

/**
 * The regression guard for the second reported defect, stated as the property
 * that was violated rather than as the mechanism that violated it.
 *
 * The old code answered a shrinking `innerHeight` in standalone by pushing the
 * tab bar *down* by the difference, on the theory that the layout viewport had
 * been left short of the display. When the theory was wrong — and on iOS 26 a
 * standalone `innerHeight` moves for reasons that are not that defect — the
 * bar went off the bottom of the screen with its icons cut off. Measured at
 * these metrics: a 59px reading moved its box from [602, 659] to [661, 718].
 *
 * The invariant below would have failed on that build, and does not care how
 * the next attempt is implemented.
 */
test('a layout viewport that comes back short never pushes the tab bar off the screen', async ({
  page,
}) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  const before = await measure(page);
  expect(before.tabbarComputedBottom).toBe('0px');

  // The defect's signature, staged: the layout viewport comes back short with
  // nothing focused and the visual viewport agreeing with it.
  const SHORT_BY = 59;
  await page.setViewportSize({ width: FULL.width, height: FULL.height - SHORT_BY });
  await page.waitForTimeout(SETTLED_MS);

  const short = await measure(page);
  expect(short.tabbarComputedBottom, 'no correction is applied at all').toBe('0px');
  expect(short.tabbarBottom, 'the bar is on the bottom of the short viewport, not below it').toBe(
    short.innerHeight,
  );
  expect(short.tabbarTop, 'the whole bar is on screen').toBeGreaterThanOrEqual(0);
  expect(short.rootStyleAttribute).not.toContain('--viewport-');

  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);

  const recovered = await measure(page);
  expect(recovered.tabbarComputedBottom).toBe('0px');
  expect(recovered.tabbarBottom).toBe(before.tabbarBottom);
});

/**
 * The other half of the guard, against the built stylesheet rather than the
 * live page: the two `@utility` rules are gone, so a class name surviving in
 * some component that was missed cannot silently start positioning anything.
 *
 * Against the real stylesheet on purpose. Twice in this codebase a Tailwind
 * class has compiled to nothing and the failure was invisible — a class built
 * from a template literal, and a keyboard term written as a separate utility
 * that sorted after `max-h-[60dvh]` and won. Reading `getComputedStyle` back is
 * the only form of this check that cannot be fooled.
 */
test('the reverted bottom-anchor utilities no longer exist in the stylesheet', async ({ page }) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  const resolved = await page.evaluate(() => {
    // Every rule the page actually loaded, read back from the CSSOM. Note that
    // `getComputedStyle(el).bottom` cannot answer this question: on a
    // positioned element `bottom: auto` resolves to a *used* value in pixels,
    // so a class that matches no rule at all still reads back as a number —
    // which is how the first draft of this test passed a `-40px` off as proof.
    const offenders: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // A cross-origin stylesheet, which this app has none of.
        continue;
      }
      for (const rule of [...rules]) {
        if (/bottom-viewport|bottom-above-keyboard|--viewport-/.test(rule.cssText)) {
          offenders.push(rule.cssText.slice(0, 160));
        }
      }
    }

    // And a positive control, so an empty result cannot mean "the stylesheet
    // did not load".
    const probe = document.createElement('div');
    probe.className = 'fixed inset-x-0 bottom-0';
    document.body.append(probe);
    const plain = getComputedStyle(probe).bottom;
    probe.remove();

    return { offenders, plain };
  });

  expect(
    resolved.offenders,
    'no rule may mention the reverted utilities or the properties behind them',
  ).toEqual([]);
  expect(resolved.plain, 'and plain `bottom-0` still resolves, so the sheet did load').toBe('0px');

  const after = await measure(page);
  expect(after.rootStyleAttribute, 'the probe cleaned up after itself').not.toContain(
    '--viewport-',
  );
});

/**
 * The first reported defect, stated as geometry.
 *
 * «Новое дело» autofocuses its title field, so on the owner's phone the sheet
 * opened, the keyboard came up, and the sheet's header — «Отмена · Новое дело
 * · Создать» — ended up above the top edge of the screen with the tail of the
 * form near it. The mechanism was iOS scrolling the visual viewport to centre
 * the focused input while nothing held the page still; the cure was restoring
 * `vaul`'s `preventScrollMobileSafari`, which no browser here has an equivalent
 * of.
 *
 * What Chromium *can* pin is the part that is pure CSS, and that is worth
 * pinning because it is what the removed height arithmetic changed: the sheet's
 * top edge sits at the top inset and its submit control is inside the viewport,
 * both when the viewport is whole and when a keyboard's worth of it is gone.
 */
test('the create sheet opens with its header and its submit on screen', async ({ page }) => {
  await emulateInstalled(page);
  await page.goto('/tasks');

  const trigger = page.getByRole('button', { name: /Новое дело|Новая задача|Добавить/i }).first();
  await expect(trigger, 'no create trigger on /tasks').toBeVisible({ timeout: 20_000 });
  await trigger.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // Wait for vaul's slide-in to finish rather than sleeping at it. Measuring
  // mid-transform reads a top edge one pixel off and makes this flaky, which
  // is exactly the kind of noise that gets an inconvenient assertion loosened
  // until it stops meaning anything.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const surface = document.querySelector('[role=dialog]');
          return surface === null ? 'missing' : getComputedStyle(surface).transform;
        }),
      { timeout: 5_000 },
    )
    .toBe('none');

  const read = async () =>
    page.evaluate(() => {
      const surface = document.querySelector('[role=dialog]');
      const box = surface?.getBoundingClientRect();
      const submit = [...(surface?.querySelectorAll('button') ?? [])].find((b) =>
        /Создать/i.test(b.textContent ?? ''),
      );
      const sb = submit?.getBoundingClientRect();
      const body = surface?.querySelector('[data-scroll-pane]') ?? null;
      return {
        innerHeight: window.innerHeight,
        top: Math.round(box?.top ?? Number.NaN),
        bottom: Math.round(box?.bottom ?? Number.NaN),
        submitTop: Math.round(sb?.top ?? Number.NaN),
        submitBottom: Math.round(sb?.bottom ?? Number.NaN),
        bodyScrollTop: Math.round(body?.scrollTop ?? Number.NaN),
        rootStyle: document.documentElement.getAttribute('style') ?? '',
      };
    });

  const whole = await read();
  // `max(env(safe-area-inset-top), 12px) + 12px`, and the inset is 0 here.
  expect(whole.top, 'the sheet starts below the status-bar inset, not above the screen').toBe(24);
  expect(whole.bottom, 'and reaches the bottom of the viewport').toBe(whole.innerHeight);
  expect(whole.bodyScrollTop, 'the form opens at the top of itself, never scrolled').toBe(0);
  expect(whole.submitTop, '«Создать» is on screen').toBeGreaterThanOrEqual(0);
  expect(whole.submitBottom).toBeLessThanOrEqual(whole.innerHeight);
  expect(whole.rootStyle).not.toContain('--viewport-');

  // A keyboard's worth of viewport removed. The header must not move up.
  await page.setViewportSize(REDUCED);
  await page.waitForTimeout(SETTLED_MS);

  const reduced = await read();
  expect(reduced.top, 'the header stays under the top inset').toBe(24);
  expect(reduced.submitTop, '«Создать» is still on screen').toBeGreaterThanOrEqual(0);
  expect(reduced.submitBottom).toBeLessThanOrEqual(reduced.innerHeight);
  expect(reduced.rootStyle).not.toContain('--viewport-');

  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);
});

/**
 * The three `drawerSize` strings from `responsive-dialog.tsx`, verbatim.
 *
 * Copied rather than imported on purpose: what is under test is what the
 * *built stylesheet* does with them. The hazard is real and has fired twice —
 * once as a class assembled from a template literal, which Tailwind's source
 * scanner never sees and which therefore generated no rule at all, and once as
 * a keyboard term written as its own `max-h-[…]` utility, which sorted after
 * `max-h-[60dvh]` and silently won, letting an action sheet grow to nearly the
 * whole screen. Neither failed anything. Both were found in `dist/assets/*.css`.
 */
test('each sheet size still resolves to the height it claims', async ({ page }) => {
  await emulateInstalled(page);
  await page.goto('/');
  await page.waitForTimeout(600);

  const SIZES = {
    full: 'h-[calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem)]! bottom-0!',
    tall: 'h-[85dvh]',
    auto: 'max-h-[60dvh]',
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

    const quiet = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, read(v)]));

    // And the same three, with both removed properties staged. A size that
    // still moved would mean a keyboard term survived somewhere.
    const root = document.documentElement;
    root.style.setProperty('--viewport-keyboard', '300px');
    root.style.setProperty('--viewport-shortfall', '59px');
    const hostile = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, read(v)]));
    root.style.removeProperty('--viewport-keyboard');
    root.style.removeProperty('--viewport-shortfall');

    probe.remove();
    return { quiet, hostile, viewport: window.innerHeight };
  }, SIZES);

  // `max(env(safe-area-inset-top), 12px) + 12px`, and the inset is 0 here.
  const available = measured.viewport - 24;

  expect(measured.quiet.auto, 'auto is capped at 60dvh, not at the whole screen').toBe(
    Math.round(measured.viewport * 0.6),
  );
  expect(measured.quiet.tall, 'tall is 85dvh').toBe(Math.round(measured.viewport * 0.85));
  expect(measured.quiet.full, 'full is the screen less the top inset').toBe(available);

  expect(measured.hostile, 'no size reads a viewport property any more').toEqual(measured.quiet);
});

/**
 * The third reported defect, and the one that made «Новое дело» unusable: the
 * sheet opening collapsed to a sliver on the bottom edge, its header intact
 * above a 200-odd pixel window onto a 400-odd pixel form.
 *
 * It is the *other* half of restoring `repositionInputs`. That flag gates
 * `preventScrollMobileSafari`, which this app needs; it also gates vaul's own
 * keyboard arithmetic, which — while an input inside the sheet has focus —
 * writes an inline `height` and `bottom` onto the surface on every
 * `visualViewport` resize, and only clears them when a later run of the same
 * handler decides the keyboard has closed. That decision reads
 * `innerHeight - visualViewport.height`, the one quantity iOS reports
 * unreliably in a Home Screen web app, so on the owner's phone it did not
 * clear. `responsive-dialog.tsx` answers with `!` on both properties for
 * `size="full"`.
 *
 * Stated as geometry rather than as mechanism: whatever a library writes onto
 * this element, a full sheet is the screen less its top inset, and «Создать»
 * is on screen — before a keyboard, during one, and after it goes away.
 */
test('a full sheet cannot be resized out from under itself by a keyboard', async ({ page }) => {
  await emulateInstalled(page);
  await page.goto('/tasks');

  const trigger = page.getByRole('button', { name: /Новое дело|Новая задача|Добавить/i }).first();
  await expect(trigger, 'no create trigger on /tasks').toBeVisible({ timeout: 20_000 });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = document.querySelector('[data-slot="responsive-dialog"]');
          return s === null ? 'missing' : getComputedStyle(s).transform;
        }),
      { timeout: 8_000 },
    )
    .toBe('none');

  const geometry = async () =>
    page.evaluate(() => {
      const surface = document.querySelector('[data-slot="responsive-dialog"]');
      const box = surface?.getBoundingClientRect();
      const submit = [...(surface?.querySelectorAll('button') ?? [])].find((b) =>
        /Создать/i.test(b.textContent ?? ''),
      );
      const sb = submit?.getBoundingClientRect();
      const body = surface?.querySelector('[data-scroll-pane]') ?? null;
      const bb = body?.getBoundingClientRect();
      return {
        innerHeight: window.innerHeight,
        top: Math.round(box?.top ?? Number.NaN),
        bottom: Math.round(box?.bottom ?? Number.NaN),
        height: Math.round(box?.height ?? Number.NaN),
        bodyHeight: Math.round(bb?.height ?? Number.NaN),
        submitTop: Math.round(sb?.top ?? Number.NaN),
        submitBottom: Math.round(sb?.bottom ?? Number.NaN),
      };
    });

  // `max(env(safe-area-inset-top), 12px) + 12px`, and the inset is 0 here.
  const INSET = 24;

  const before = await geometry();
  expect(before.top, 'the sheet starts at the top inset').toBe(INSET);
  expect(before.height, 'and is the screen less that inset').toBe(before.innerHeight - INSET);

  await page.setViewportSize(REDUCED);
  await page.waitForTimeout(SETTLED_MS);

  const during = await geometry();
  expect(during.top, 'still at the top inset with a keyboard up').toBe(INSET);
  expect(during.height, 'and still sized from the viewport it is on').toBe(
    during.innerHeight - INSET,
  );
  expect(during.submitTop, '«Создать» is on screen').toBeGreaterThanOrEqual(0);
  expect(during.submitBottom).toBeLessThanOrEqual(during.innerHeight);

  await page.setViewportSize(FULL);
  await page.waitForTimeout(SETTLED_MS);

  // The regression proper. Before the fix this read 299px on a 659px viewport,
  // with the sheet's top at y=360 — an inline `height` vaul had written while
  // the viewport was short and never took back.
  const after = await geometry();
  expect(after.top, 'the sheet came back to the top inset').toBe(INSET);
  expect(after.height, 'at its full height').toBe(after.innerHeight - INSET);
  expect(after.bodyHeight, 'and the form is not a sliver').toBe(before.bodyHeight);
  expect(after.submitTop, '«Создать» is where it was').toBe(before.submitTop);

  // Said once more against the property rather than the box, because an inline
  // style *is* still written — it simply no longer wins.
  const resolved = await page.evaluate(() => {
    const surface = document.querySelector('[data-slot="responsive-dialog"]');
    return {
      computedHeight: surface === null ? '' : getComputedStyle(surface).height,
      computedBottom: surface === null ? '' : getComputedStyle(surface).bottom,
      inline: (surface as HTMLElement | null)?.getAttribute('style') ?? '',
    };
  });
  expect(resolved.computedBottom, 'anchored by plain CSS, as the tab bar is').toBe('0px');
  expect(
    resolved.computedHeight,
    'the stylesheet outranks whatever vaul left in the style attribute',
  ).toBe(`${String(FULL.height - INSET)}px`);
});
