/* Throwaway visual-review harness. Not a test — it just walks the app and
 * captures full-page screenshots. Delete when the review is done. */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const OUT = path.join(here, '__screens__');
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = 'papa@example.com';
const PASSWORD = 'ReviewMe!23456';

test.use({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
test.setTimeout(180_000);

type Console = { url: string; messages: string[] };
const consoleLog: Console[] = [];

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name === 'mobile-safari' ? 'm' : 'd';
}

async function attachConsole(page: Page) {
  const messages: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      messages.push(`[${m.type()}] ${m.text()}`.slice(0, 300));
  });
  page.on('pageerror', (e) => messages.push(`[pageerror] ${String(e).slice(0, 300)}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/'))
      messages.push(
        `[http ${r.status()}] ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')} auth=${r.request().headers().authorization ? 'yes' : 'no'}`,
      );
    else if (r.status() >= 400) messages.push(`[http ${r.status()}] ${r.url()}`);
  });
  return messages;
}

async function settle(page: Page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

/** Report horizontal overflow + small tap targets + small input font. */
async function audit(page: Page, name: string) {
  return page.evaluate((label) => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    const offenders: string[] = [];
    if (overflow > 1) {
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > doc.clientWidth + 1 && offenders.length < 8) {
          offenders.push(
            `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 70)} right=${Math.round(r.right)}`,
          );
        }
      });
    }
    const small: string[] = [];
    document.querySelectorAll('button, a[href], [role="button"], input, select').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.height < 44 || r.width < 32) {
        if (small.length < 14)
          small.push(
            `${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLElement).getAttribute('aria-label') || '').trim().slice(0, 28)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      }
    });
    const smallInputs: string[] = [];
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16)
        smallInputs.push(`${el.tagName.toLowerCase()}[${(el as HTMLInputElement).type}] ${fs}px`);
    });
    const unlabelled: string[] = [];
    document.querySelectorAll('button, a[href]').forEach((el) => {
      const text = (el.textContent || '').trim();
      const label = el.getAttribute('aria-label') || el.getAttribute('title');
      if (!text && !label && unlabelled.length < 10)
        unlabelled.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 60)}`);
    });
    return { label, overflow, offenders, small, smallInputs, unlabelled };
  }, name);
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/почт|email|e-mail/i).first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await settle(page);
}

async function setDark(page: Page, dark: boolean) {
  await page.evaluate((d) => {
    window.localStorage.setItem('family.theme', d ? 'dark' : 'light');
  }, dark);
  await page.reload();
  await settle(page);
}

test('visual walk', async ({ page }, testInfo) => {
  const t = tag(testInfo);
  await page.setViewportSize(
    testInfo.project.name === 'mobile-safari' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  );
  const messages = await attachConsole(page);
  const audits: unknown[] = [];

  // ---------- logged out ----------
  await page.goto('/login');
  await shot(page, `${t}-01-login`);
  audits.push(await audit(page, 'login'));

  await page.goto('/register');
  await shot(page, `${t}-02-register`);
  audits.push(await audit(page, 'register'));

  // validation / error state on the login form
  await page.goto('/login');
  await page.getByLabel(/почт|email|e-mail/i).first().fill('papa@example.com');
  await page.locator('input[type="password"]').first().fill('definitely-wrong-pw');
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForTimeout(2500);
  await shot(page, `${t}-03-login-error`);

  await page.goto('/auth/pending');
  await shot(page, `${t}-04-auth-pending`);

  await page.goto('/this-route-does-not-exist');
  await shot(page, `${t}-05-notfound`);

  // ---------- logged in ----------
  await login(page);
  await shot(page, `${t}-10-today`);
  audits.push(await audit(page, 'today'));

  const screens: Array<[string, string]> = [
    ['11-tasks', '/tasks'],
    ['12-calendar', '/calendar'],
    ['14-goals', '/goals'],
    ['15-shopping', '/shopping'],
    ['16-wall', '/wall'],
    ['17-family', '/family'],
    ['18-settings', '/settings'],
    ['19-settings-notifications', '/settings/notifications'],
    ['20-settings-profile', '/settings/profile'],
    ['21-admin-members', '/admin/members'],
  ];

  for (const [name, url] of screens) {
    await page.goto(url);
    await shot(page, `${t}-${name}`);
    audits.push(await audit(page, url));
  }

  // calendar agenda view — try to find a view switch
  await page.goto('/calendar');
  await settle(page);
  for (const label of [/список/i, /повестк/i, /agenda/i, /лента/i, /дела/i]) {
    const btn = page.getByRole('button', { name: label }).or(page.getByRole('tab', { name: label }));
    if (await btn.first().isVisible().catch(() => false)) {
      await btn.first().click();
      await shot(page, `${t}-13-calendar-agenda`);
      audits.push(await audit(page, 'calendar-agenda'));
      break;
    }
  }
  // dump calendar control labels for the report
  const calControls = await page
    .locator('main button, main [role="tab"]')
    .evaluateAll((els) => els.map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 30));
  console.log('CALENDAR CONTROLS', JSON.stringify(calControls));

  // ---------- detail pages ----------
  await page.goto('/goals');
  await settle(page);
  const goalLink = page.locator('main a[href^="/goals/"]').first();
  if (await goalLink.count()) {
    await goalLink.click();
    await shot(page, `${t}-30-goal-detail`);
    audits.push(await audit(page, 'goal-detail'));
  } else {
    console.log('NO GOAL LINK FOUND');
  }

  await page.goto('/tasks');
  await settle(page);
  const taskLink = page.locator('main a[href^="/tasks/"]').first();
  if (await taskLink.count()) {
    await taskLink.click();
    await shot(page, `${t}-31-task-detail`);
    audits.push(await audit(page, 'task-detail'));
  } else {
    console.log('NO TASK LINK FOUND');
  }

  await page.goto('/shopping');
  await settle(page);
  const listLink = page.locator('main a[href^="/shopping/"]').first();
  if (await listLink.count()) {
    await listLink.click();
    await shot(page, `${t}-32-shopping-list`);
    audits.push(await audit(page, 'shopping-list'));
  }

  // ---------- error state: kill the API ----------
  await page.route('**/api/dashboard/**', (r) => r.abort('failed'));
  await page.route('**/api/today**', (r) => r.abort('failed'));
  await page.route('**/api/tasks**', (r) => r.abort('failed'));
  await page.goto('/tasks');
  await shot(page, `${t}-40-tasks-error`);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // ---------- loading state (throttled API) ----------
  await page.route('**/api/**', async (r) => {
    await new Promise((res) => setTimeout(res, 4000));
    await r.continue();
  });
  const nav = page.goto('/goals');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${t}-41-goals-loading.png`), fullPage: true });
  await nav.catch(() => {});
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // ---------- mobile "Ещё" sheet ----------
  if (testInfo.project.name === 'mobile-safari') {
    await page.goto('/');
    await settle(page);
    const more = page.getByRole('button', { name: /ещ/i }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUT, `${t}-42-more-sheet.png`) });
      await page.keyboard.press('Escape');
    }
  }

  // ---------- dark mode ----------
  await setDark(page, true);
  for (const [name, url] of [
    ['50-today-dark', '/'],
    ['51-tasks-dark', '/tasks'],
    ['52-calendar-dark', '/calendar'],
    ['53-goals-dark', '/goals'],
    ['54-shopping-dark', '/shopping'],
    ['55-settings-dark', '/settings'],
  ] as Array<[string, string]>) {
    await page.goto(url);
    await shot(page, `${t}-${name}`);
  }
  await page.goto('/login');
  await shot(page, `${t}-56-login-dark`);
  await setDark(page, false);

  // ---------- focus ring spot-check ----------
  await page.goto('/login');
  await settle(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.screenshot({ path: path.join(OUT, `${t}-60-focus.png`) });

  fs.writeFileSync(
    path.join(OUT, `${t}-audit.json`),
    JSON.stringify({ audits, messages }, null, 2),
  );
  consoleLog.push({ url: t, messages });
  expect(true).toBe(true);
});
