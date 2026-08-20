import { expect, test } from './fixtures';

import { assertClean, watch } from './helpers';

/**
 * Whole-app smoke suite.
 *
 * Walks every route, opens every modal and exercises every form, asserting on
 * things unit tests structurally cannot see: that a screen actually renders,
 * that nothing 4xx/5xx'd behind it, that the console is clean, and that the
 * layout does not overflow on a phone.
 *
 * This exists because the unit suites were green while three sections of the
 * app were returning 500 in production. A test that renders a component with a
 * mocked fetch cannot tell you the page works.
 *
 * Requires a running stack. The preview origin must match the backend's
 * APP_PUBLIC_URL, because CORS is built from it — and `localhost` and
 * `127.0.0.1` are different origins, so mixing them 403s every POST:
 *
 *   backend   BACKEND_PORT=3102 APP_PUBLIC_URL=http://localhost:5175 \
 *               RATE_LIMIT_FACTOR=100 npx tsx --env-file-if-exists=.env src/main.ts
 *   frontend  npx vite build && VITE_API_PROXY_TARGET=http://localhost:3102 \
 *               npx vite preview --port 5175
 *
 * `RATE_LIMIT_FACTOR` is what keeps the suite from tripping the refresh limit;
 * see `core/config.ts` for why that is a harness problem and not a product one.
 */


/** Every navigable route, with what proves it rendered. */
const ROUTES: Array<{ path: string; expect: RegExp; name: string }> = [
  { path: '/', expect: /Сегодня|Доброе|Добрый/i, name: 'today' },
  { path: '/tasks', expect: /Задачи|дела/i, name: 'tasks' },
  { path: '/calendar', expect: /Календарь|Событие/i, name: 'calendar' },
  { path: '/goals', expect: /Копилк|Цел/i, name: 'goals' },
  { path: '/shopping', expect: /Покупк|Список/i, name: 'shopping' },
  { path: '/wall', expect: /Лент|Объявлен/i, name: 'wall' },
  { path: '/family', expect: /Семья|Участник/i, name: 'family' },
  { path: '/settings', expect: /Настройк/i, name: 'settings' },
  { path: '/settings/profile', expect: /Профиль|Имя/i, name: 'settings/profile' },
  { path: '/settings/notifications', expect: /Уведомлен/i, name: 'settings/notifications' },
  { path: '/settings/accounts', expect: /вход|Google|Telegram/i, name: 'settings/accounts' },
  { path: '/admin/members', expect: /Участник|Заявк/i, name: 'admin/members' },
];
test.describe('every page renders', () => {
  for (const route of ROUTES) {
    test(`${route.name} renders without errors`, async ({ page }) => {
      const problems = watch(page);

      await page.goto(route.path);
      await expect(page.locator('body')).toContainText(route.expect, { timeout: 15_000 });

      // An error state that renders "successfully" is still a broken page.
      await expect(
        page.getByText(/Что-то пошло не так|Не удалось загрузить|Ошибка сервера/i),
      ).toHaveCount(0);

      assertClean(problems, route.name);
    });
  }
});

test.describe('layout holds at phone width', () => {
  test.use({ viewport: { width: 320, height: 844 } });

  for (const route of ROUTES) {
    test(`${route.name} does not scroll sideways at 320px`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForTimeout(600);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route.name} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('forms and modals open', () => {
  const FLOWS: Array<{ name: string; path: string; open: RegExp; expect: RegExp }> = [
    { name: 'new task', path: '/tasks', open: /Новое дело|Новая задача|Добавить/i, expect: /Название|Что нужно сделать/i },
    // The calendar's action uses the short label «Событие», not «Новое событие».
    { name: 'new event', path: '/calendar', open: /^Событие$|Новое событие/i, expect: /Название/i },
    { name: 'new goal', path: '/goals', open: /Новая цель|Новая копилка|Добавить/i, expect: /Название|Цель/i },
    { name: 'new list', path: '/shopping', open: /Новый список|Добавить список/i, expect: /Название/i },
    { name: 'new post', path: '/wall', open: /Написать|Объявление|Добавить/i, expect: /Текст|Сообщение|Заголовок/i },
  ];

  for (const flow of FLOWS) {
    test(`${flow.name} opens and closes cleanly`, async ({ page }) => {
      const problems = watch(page);
      await page.goto(flow.path);

      // `count()` does not auto-wait, and the route chunk loads lazily, so the
      // old `if (count === 0) test.skip()` read 0 every time and quietly
      // skipped all five create flows. A missing trigger is a failure, not a
      // reason to stop looking.
      const trigger = page.getByRole('button', { name: flow.open }).first();
      await expect(trigger, `no create trigger on ${flow.path}`).toBeVisible({
        timeout: 15_000,
      });
      await trigger.click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText(flow.expect);

      // The submit control must be reachable without hunting: it is the single
      // most common complaint about long forms on a phone.
      const submit = dialog.getByRole('button', { name: /Создать|Сохранить|Опубликовать/i }).first();
      await expect(submit).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      assertClean(problems, flow.name);
    });
  }
});

test.describe('modals respect the safe area', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a dialog never starts above the status bar inset', async ({ page }) => {
    await page.goto('/tasks');

    const trigger = page.getByRole('button', { name: /Новое дело|Новая задача|Добавить/i }).first();
    await expect(trigger, 'no create trigger on /tasks').toBeVisible({ timeout: 15_000 });
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // In standalone iOS the web view extends under the status bar, so content
    // anchored at y=0 renders behind the clock. Nothing may start above 0.
    const box = await dialog.boundingBox();
    expect(box, 'dialog has no box').not.toBeNull();
    expect(box!.y, 'dialog starts above the viewport top').toBeGreaterThanOrEqual(0);
  });
});
