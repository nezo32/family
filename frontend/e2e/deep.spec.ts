import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

import { ANONYMOUS, assertClean, firstId, watch } from './helpers';

/**
 * Deep end-to-end coverage — the routes and interactions `smoke.spec.ts` does
 * not reach.
 *
 * `smoke.spec.ts` walks the twelve top-level screens. That leaves the four
 * detail pages, `/notifications`, the five anonymous auth screens and the
 * catch-all unreachable — and a detail page is exactly where a route that
 * renders a list fine still throws, because it is the only place that reads a
 * single record by id.
 *
 * Detail pages are reached by **clicking through the UI** rather than by
 * POSTing a hand-built payload. A payload written here drifts from the contract
 * the moment the contract changes, and passes while the real navigation is
 * broken; a click exercises the link, the route and the loader together.
 *
 * Requires the same running stack as `smoke.spec.ts` — see its header. Port
 * 5173 is mandatory: the backend's CORS allow-list contains only that origin.
 */

/** Drills from a list screen into the first detail row it links to. */
async function openFirstDetail(page: Page, listPath: string, detailPattern: RegExp) {
  await page.goto(listPath);
  await page.waitForLoadState('networkidle');

  const link = page.locator(`a[href^="${listPath}/"]`).first();
  const count = await link.count();
  expect(
    count,
    `${listPath}: nothing to drill into — the seed should have left at least one record`,
  ).toBeGreaterThan(0);

  await link.click();
  await expect(page).toHaveURL(detailPattern, { timeout: 15_000 });
}

test.describe('detail pages render', () => {
  const DETAILS: Array<{ name: string; list: string; url: RegExp; expect: RegExp }> = [
    { name: 'task detail', list: '/tasks', url: /\/tasks\/[^/]+$/, expect: /./ },
    { name: 'goal detail', list: '/goals', url: /\/goals\/[^/]+$/, expect: /./ },
    { name: 'shopping list', list: '/shopping', url: /\/shopping\/[^/]+$/, expect: /./ },
  ];

  for (const d of DETAILS) {
    test(`${d.name} opens from its list without errors`, async ({ page }) => {
      const problems = watch(page);

      await openFirstDetail(page, d.list, d.url);

      // A detail page that renders an error state is still a broken page.
      await expect(
        page.getByText(/Что-то пошло не так|Не удалось загрузить|Ошибка сервера|не найден/i),
      ).toHaveCount(0);
      await expect(page.locator('body')).toContainText(d.expect);

      assertClean(problems, d.name);
    });
  }
});

test.describe('remaining authenticated routes', () => {
  test('the notification centre opens from the app bar', async ({ page }) => {
    // Deliberately not a route: `/notifications` is an API path, and listing it
    // as an app route made `isKnownAppPath()` vouch for a URL that renders the
    // 404 screen. The centre is a panel, so this is where it gets exercised.
    const problems = watch(page);

    await page.goto('/');
    const bell = page.getByRole('button', { name: /Уведомления|Открыть уведомления/i }).first();
    await expect(bell).toBeVisible({ timeout: 15_000 });
    await bell.click();

    await expect(page.getByText('Уведомления').first()).toBeVisible({ timeout: 10_000 });

    assertClean(problems, 'notification centre');
  });

  test('an unknown path shows the not-found screen rather than crashing', async ({ page }) => {
    const problems = watch(page);

    await page.goto('/definitely-not-a-route');
    // Whatever it says, it must be a rendered screen with a way back — not a
    // blank document and not an unhandled error boundary.
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.getByRole('link').or(page.getByRole('button')).first()).toBeVisible();

    assertClean(problems, 'not-found');
  });
});

test.describe('anonymous screens render', () => {
  // These screens only exist for someone who is *not* signed in, and the run
  // shares one authenticated session, so this block opts back out of it.
  test.use({ storageState: ANONYMOUS });

  const ANON: Array<{ path: string; expect: RegExp; name: string }> = [
    { path: '/login', expect: /Войти|Вход|почт/i, name: 'login' },
    { path: '/register', expect: /Регистрац|Заявк|почт/i, name: 'register' },
    { path: '/auth/pending', expect: /ожида|Заявк|подтвержд/i, name: 'auth/pending' },
    { path: '/auth/rejected', expect: /отклон/i, name: 'auth/rejected' },
    { path: '/auth/suspended', expect: /приостанов|заблокир/i, name: 'auth/suspended' },
  ];

  for (const a of ANON) {
    test(`${a.name} renders for a signed-out visitor`, async ({ page }) => {
      const problems = watch(page);

      await page.goto(a.path);
      await expect(page.locator('body')).toContainText(a.expect, { timeout: 15_000 });

      assertClean(problems, a.name);
    });
  }

  test('pending and rejected do not look like crashes', async ({ page }) => {
    // The designer's note: these are ordinary states of an admin-gated signup,
    // and a family member who sees a red error screen will think they broke it.
    for (const path of ['/auth/pending', '/auth/rejected']) {
      await page.goto(path);
      await expect(page.getByText(/Что-то пошло не так|Ошибка сервера/i)).toHaveCount(0);
    }
  });
});

test.describe('a form actually writes', () => {
  test('creating a task through the UI puts it on the list', async ({ page }) => {
    const problems = watch(page);

    const title = `E2E дело ${Date.now()}`;

    await page.goto('/tasks');
    const trigger = page
      .getByRole('button', { name: /Новое дело|Новая задача|Добавить/i })
      .first();
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/Название|Что нужно сделать/i).first().fill(title);

    const submit = dialog.getByRole('button', { name: /Создать|Сохранить/i }).first();
    await expect(submit, 'the submit control must be reachable without hunting').toBeVisible();
    await submit.click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // The round trip is the point: it must come back from the server, not just
    // vanish from the form.
    await expect(page.locator('body')).toContainText(title, { timeout: 15_000 });

    assertClean(problems, 'create task');
  });
});

test.describe('dialogs dismiss both ways', () => {
  test('Escape and the close control both shut the create dialog', async ({ page }) => {
    await page.goto('/tasks');

    const trigger = page
      .getByRole('button', { name: /Новое дело|Новая задача|Добавить/i })
      .first();
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    await trigger.click();
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole('button', { name: /Закрыть|Отмена|Close/i }).first();
    await expect(close, 'a dialog needs a visible way out, not just Escape').toBeVisible();
    await close.click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

test.describe('routes only a notification links to', () => {
  test('an event series page renders when opened directly', async ({ page }) => {
    // The calendar opens a sheet rather than navigating, so `/calendar/:id` has
    // no link anywhere in the UI — a push notification is the only way in, which
    // makes it the single most likely detail route to rot unnoticed.
    const problems = watch(page);
    const seriesId = firstId('event_series');
    expect(seriesId, 'the seed should have left an event series').toMatch(/^[0-9a-f-]{36}$/);

    await page.goto(`/calendar/${seriesId}`);

    await expect(
      page.getByText(/Что-то пошло не так|Не удалось загрузить|Ошибка сервера|не найден/i),
    ).toHaveCount(0);
    await expect(page.locator('body')).not.toBeEmpty();

    assertClean(problems, 'event series deep link');
  });
});
