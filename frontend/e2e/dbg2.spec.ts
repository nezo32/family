import { test } from '@playwright/test';
test.use({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
test.setTimeout(120000);
test('dbg', async ({ page }) => {
  page.on('response', (r) => {
    if (r.url().includes('/api/'))
      console.log(r.status(), r.request().method(), r.url().replace('http://localhost:5173',''), (r.request().headers().authorization||'none').slice(0,16));
  });
  await page.goto('/login'); await page.waitForTimeout(1000);
  await page.goto('/register'); await page.waitForTimeout(1000);
  console.log('=== after /register, url=', page.url());
  await page.goto('/login');
  await page.locator('input[type=email]').fill('papa@example.com');
  await page.locator('input[type=password]').fill('definitely-wrong-pw');
  await page.locator('form button[type=submit]').click();
  await page.waitForTimeout(2500);
  await page.goto('/auth/pending'); await page.waitForTimeout(800);
  await page.goto('/this-route-does-not-exist'); await page.waitForTimeout(800);
  console.log('=== real login ===');
  await page.goto('/login');
  await page.locator('input[type=email]').fill('papa@example.com');
  await page.locator('input[type=password]').fill('ReviewMe!23456');
  await page.locator('form button[type=submit]').click();
  await page.waitForTimeout(8000);
  console.log('URL', page.url());
});
