/* Throwaway visual-review pass 2 — fills the gaps left by visual-review.spec.ts. */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '__screens__');
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = 'papa@example.com';
const PASSWORD = 'ReviewMe!23456';

test.use({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
test.setTimeout(240_000);

async function settle(page: Page, ms = 1500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}
async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}
async function login(page: Page) {
  for (let i = 0; i < 3; i++) {
    await page.goto('/login');
    await settle(page, 400);
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.locator('form button[type="submit"]').first().click();
    try {
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
      await settle(page);
      return;
    } catch { /* retry */ }
  }
  throw new Error('login failed');
}

test('pass 2', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-safari';
  const t = mobile ? 'm' : 'd';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });

  // logged-out dark mode (before any session exists)
  await page.goto('/login');
  await page.evaluate(() => { window.localStorage.setItem('family.theme', 'dark'); });
  await page.reload();
  await shot(page, `${t}-70-login-dark`);
  await page.evaluate(() => { window.localStorage.setItem('family.theme', 'light'); });
  await page.reload();

  await login(page);

  // calendar: the view the current viewport does NOT default to
  await page.goto('/calendar');
  await settle(page);
  const other = mobile ? 'Месяц' : 'Список';
  await page.getByRole('button', { name: other, exact: true }).first().click().catch(() => {});
  await shot(page, `${t}-71-calendar-${mobile ? 'month' : 'agenda'}`);

  // goal detail (longer settle so it is not a skeleton)
  await page.goto('/goals');
  await settle(page);
  const goal = page.locator('a[href^="/goals/"]').first();
  if (await goal.count()) {
    await goal.click();
    await settle(page, 2500);
    await shot(page, `${t}-72-goal-detail`);
  }

  // shopping list detail
  await page.goto('/shopping');
  await settle(page);
  const list = page.locator('a[href^="/shopping/"]').first();
  if (await list.count()) {
    await list.click();
    await settle(page, 2500);
    await shot(page, `${t}-73-shopping-list`);
  }

  // tasks after retries are exhausted (server 500s on /api/tasks/occurrences)
  await page.goto('/tasks');
  await settle(page, 12_000);
  await shot(page, `${t}-74-tasks-after-12s`);

  // real error state: dashboard fails
  await page.route('**/api/dashboard/**', (r) => r.abort('failed'));
  await page.goto('/');
  await settle(page, 3000);
  await shot(page, `${t}-75-today-error`);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // empty state: shopping list with no items (Хозтовары)
  await page.goto('/shopping');
  await settle(page);
  const empty = page.getByText('Хозтовары').first();
  if (await empty.isVisible().catch(() => false)) {
    await empty.click();
    await settle(page, 2000);
    await shot(page, `${t}-76-shopping-empty`);
  }

  // wall detail / composer dialog
  await page.goto('/wall');
  await settle(page);
  const write = page.getByRole('button', { name: /Написать/i }).first();
  if (await write.isVisible().catch(() => false)) {
    await write.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `${t}-77-wall-composer.png`) });
    await page.keyboard.press('Escape');
  }

  // new-goal dialog (form density check)
  await page.goto('/goals');
  await settle(page);
  const newGoal = page.getByRole('button', { name: /Новая копилка/i }).first();
  if (await newGoal.isVisible().catch(() => false)) {
    await newGoal.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `${t}-78-goal-dialog.png`) });
    await page.keyboard.press('Escape');
  }

  // focus ring on a real app screen
  await page.goto('/settings');
  await settle(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.screenshot({ path: path.join(OUT, `${t}-79-focus-settings.png`) });

  expect(true).toBe(true);
});
