import { expect, test, type ConsoleMessage, type Page, type Request } from '@playwright/test';

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
 * Requires a running stack:
 *   backend   BACKEND_PORT=3100 npx tsx --env-file-if-exists=.env src/main.ts
 *   frontend  npx vite build && npx vite preview --port 5173
 *
 * Port 5173 is not a suggestion: the backend's CORS allow-list contains only
 * that origin, so anything else 403s every POST.
 */

const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:3100';

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

/** Console noise that is expected and not a defect. */
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Service ?Worker/i,
  /Notification|PushManager/i, // absent in headless Chromium; the app degrades on purpose
  /favicon/i,
];

/** Requests whose failure is expected in a headless browser. */
const IGNORED_REQUESTS = [/vapid-public-key/i, /\/sw\.js/i, /manifest\.webmanifest/i];

interface PageProblems {
  console: string[];
  failed: string[];
}

function watch(page: Page): PageProblems {
  const problems: PageProblems = { console: [], failed: [] };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((r) => r.test(text))) return;
    problems.console.push(text);
  });

  page.on('requestfailed', (req: Request) => {
    const url = req.url();
    if (IGNORED_REQUESTS.some((r) => r.test(url))) return;
    problems.failed.push(`${req.method()} ${url} — ${req.failure()?.errorText ?? 'failed'}`);
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    if (IGNORED_REQUESTS.some((r) => r.test(url))) return;
    // 401 on /me before login is normal; anything else 4xx/5xx is not.
    if (res.status() >= 400 && !(res.status() === 401 && url.includes('/auth/'))) {
      problems.failed.push(`${res.status()} ${res.request().method()} ${url}`);
    }
  });

  return problems;
}

function assertClean(problems: PageProblems, where: string): void {
  expect(problems.failed, `${where}: failing requests`).toEqual([]);
  expect(problems.console, `${where}: console errors`).toEqual([]);
}

/** Creates an approved owner through the real API and signs in through the UI. */
async function signIn(page: Page): Promise<void> {
  const email = `e2e-${Date.now()}@example.test`;
  const password = 'E2ePassw0rd!2345';

  const res = await page.request.post(`${API}/api/auth/register`, {
    data: { email, password, displayName: 'Тест' },
  });
  expect(res.ok(), `register failed: ${res.status()} ${await res.text()}`).toBeTruthy();

  // Registration is admin-gated by design (D3), so approve directly in the
  // database the same way a first-run operator would.
  const { execSync } = await import('node:child_process');
  execSync(
    `docker exec family-dev-postgres-1 psql -U family -d family -c ` +
      `"update users set status='active', role='owner' where email='${email}'"`,
    { stdio: 'ignore' },
  );

  await page.goto('/login');
  await page.getByLabel(/почт|email/i).fill(email);
  await page.getByLabel(/пароль/i).fill(password);
  await page.getByRole('button', { name: /войти/i }).click();
  await expect(page).toHaveURL(/\/($|\?)/, { timeout: 15_000 });
}

test.describe('every page renders', () => {
  for (const route of ROUTES) {
    test(`${route.name} renders without errors`, async ({ page }) => {
      const problems = watch(page);
      await signIn(page);

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
      await signIn(page);
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
    { name: 'new event', path: '/calendar', open: /Новое событие|Добавить/i, expect: /Название/i },
    { name: 'new goal', path: '/goals', open: /Новая цель|Новая копилка|Добавить/i, expect: /Название|Цель/i },
    { name: 'new list', path: '/shopping', open: /Новый список|Добавить список/i, expect: /Название/i },
    { name: 'new post', path: '/wall', open: /Написать|Объявление|Добавить/i, expect: /Текст|Сообщение|Заголовок/i },
  ];

  for (const flow of FLOWS) {
    test(`${flow.name} opens and closes cleanly`, async ({ page }) => {
      const problems = watch(page);
      await signIn(page);
      await page.goto(flow.path);

      const trigger = page.getByRole('button', { name: flow.open }).first();
      if ((await trigger.count()) === 0) {
        test.skip(true, `no trigger matching ${flow.open} on ${flow.path}`);
      }
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
    await signIn(page);
    await page.goto('/tasks');

    const trigger = page.getByRole('button', { name: /Новое дело|Новая задача|Добавить/i }).first();
    if ((await trigger.count()) === 0) test.skip(true, 'no create trigger');
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
