import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '__screens__');
test.use({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
test.setTimeout(240_000);
async function settle(p: Page, ms = 1200) { await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{}); await p.waitForTimeout(ms); }
test('pass 3', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile-safari';
  const t = mobile ? 'm' : 'd';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  for (let i = 0; i < 3; i++) {
    await page.goto('/login'); await settle(page, 400);
    await page.locator('input[type="email"]').first().fill('papa@example.com');
    await page.locator('input[type="password"]').first().fill('ReviewMe!23456');
    await page.locator('form button[type="submit"]').first().click();
    try { await page.waitForURL((u)=>!u.pathname.startsWith('/login'), { timeout: 15000 }); break; } catch {}
  }
  await settle(page);

  // viewport (not fullPage) shots scrolled to the bottom — checks safe-area padding + tab bar blur
  for (const [name, url] of [['80-profile-bottom','/settings/profile'],['81-family-bottom','/family'],['82-notif-bottom','/settings/notifications']] as Array<[string,string]>) {
    await page.goto(url); await settle(page);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${t}-${name}.png`) });
  }
  // notifications page horizontal scroll proof
  await page.goto('/settings/notifications'); await settle(page);
  const metrics = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth }));
  console.log('NOTIF METRICS', JSON.stringify(metrics));
  await page.evaluate(() => { window.scrollTo(document.documentElement.scrollWidth, 1500); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${t}-83-notif-hscroll.png`) });

  // tab bar / top bar computed styles
  const bars = await page.evaluate(() => {
    const out: Record<string, string> = {};
    document.querySelectorAll('nav, header, [class*="fixed"]').forEach((el, i) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky')
        out[`${el.tagName.toLowerCase()}#${i}`] = `${cs.position} bg=${cs.backgroundColor} blur=${cs.backdropFilter} pb=${cs.paddingBottom}`;
    });
    return out;
  });
  console.log('BARS', JSON.stringify(bars));

  // wall composer
  await page.goto('/wall'); await settle(page);
  const w = page.getByRole('button', { name: /Написать/i }).first();
  if (await w.isVisible().catch(()=>false)) { await w.click(); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(OUT, `${t}-84-wall-composer.png`) }); await page.keyboard.press('Escape'); }

  // new task dialog
  await page.goto('/tasks'); await settle(page, 3000);
  const nt = page.getByRole('button', { name: /Новое дело/i }).first();
  if (await nt.isVisible().catch(()=>false)) { await nt.click(); await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, `${t}-85-task-dialog.png`), fullPage: true }); await page.keyboard.press('Escape'); }

  expect(true).toBe(true);
});
