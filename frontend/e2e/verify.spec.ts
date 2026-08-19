/* Temporary verification harness for the polish pass. Deleted afterwards. */
import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '__verify__');
fs.mkdirSync(OUT, { recursive: true });

const EMAIL = 'papa@example.com';
const PASSWORD = 'ReviewMe!23456';

test.use({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
test.setTimeout(240_000);

function tag(ti: { project: { name: string } }) {
  return ti.project.name === 'mobile-safari' ? 'm' : 'd';
}
async function settle(page: Page, ms = 700) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}
async function shot(page: Page, name: string, full = true) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
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
    } catch {
      /* retry */
    }
  }
  throw new Error('login failed');
}

/** WCAG contrast of the primary button, measured from real rendered pixels. */
async function contrastReport(page: Page) {
  return page.evaluate(() => {
    /* Chrome reports oklch() colours verbatim, so round-trip through a canvas
       to get the real sRGB bytes the screen shows. */
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 1;
    const ctx = cv.getContext('2d')!;
    const parse = (c: string): [number, number, number] | null => {
      if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000000';
      ctx.fillStyle = c;
      if (ctx.fillStyle === '#000000' && !/^#0{6}$|black|rgb\(0, 0, 0\)/.test(c)) return null;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] / 255, d[1] / 255, d[2] / 255];
    };
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const lum = (c: [number, number, number]) =>
      0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
      return (hi + 0.05) / (lo + 0.05);
    };
    const out: string[] = [];
    document.querySelectorAll('button, a').forEach((el) => {
      const cs = getComputedStyle(el);
      const bg = parse(cs.backgroundColor);
      const fg = parse(cs.color);
      const text = (el.textContent || '').trim().slice(0, 24);
      if (!fg) return;
      if (bg && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && out.length < 24) {
        out.push(`BTN "${text}" ${cs.backgroundColor} / ${cs.color} = ${ratio(bg, fg).toFixed(2)}`);
      }
    });
    const probe = document.createElement('span');
    probe.className = 'text-primary';
    document.body.appendChild(probe);
    const pf = parse(getComputedStyle(probe).color);
    probe.remove();
    const pageBg = parse(getComputedStyle(document.body).backgroundColor);
    if (pf && pageBg) {
      out.push(`text-primary on body bg = ${ratio(pf, pageBg).toFixed(2)}`);
      out.push(`text-primary on white card = ${ratio(pf, [1, 1, 1]).toFixed(2)}`);
    }
    return out;
  });
}

async function audit(page: Page, label: string) {
  return page.evaluate((name) => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    const offenders: string[] = [];
    if (overflow > 1) {
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > doc.clientWidth + 1 && offenders.length < 8)
          offenders.push(
            `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`,
          );
      });
    }
    const small: string[] = [];
    document.querySelectorAll('button, a[href], [role="button"], input, select').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.height < 44 || r.width < 32) {
        if (small.length < 14)
          small.push(
            `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 26)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      }
    });
    const unlabelled: string[] = [];
    document.querySelectorAll('button, a[href]').forEach((el) => {
      const text = (el.textContent || '').trim();
      const lbl = el.getAttribute('aria-label') || el.getAttribute('title');
      if (!text && !lbl && unlabelled.length < 10)
        unlabelled.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
    });
    /* Real hit area of the first switch, probed with elementFromPoint. */
    let switchHit = 'none';
    const sw = document.querySelector('[data-slot="switch"]');
    if (sw) {
      sw.scrollIntoView({ block: 'center' });
      const r = sw.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hits = (x: number, y: number) => {
        const el = document.elementFromPoint(x, y);
        return el !== null && el.closest('[data-slot="switch"]') === sw;
      };
      let w = 0;
      let h = 0;
      for (let d = 0; d < 40; d++) {
        if (hits(cx - d, cy) && hits(cx + d, cy)) w = d * 2 + 1;
        else break;
      }
      for (let d = 0; d < 40; d++) {
        if (hits(cx, cy - d) && hits(cx, cy + d)) h = d * 2 + 1;
        else break;
      }
      switchHit = `box ${Math.round(r.width)}x${Math.round(r.height)} hit ~${w}x${h}`;
    }
    return {
      label: name,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflow,
      offenders,
      small,
      unlabelled,
      switchHit,
      docHeight: doc.scrollHeight,
    };
  }, label);
}

test('verify', async ({ page }, testInfo) => {
  const t = tag(testInfo);
  const mobile = testInfo.project.name === 'mobile-safari';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const audits: unknown[] = [];

  await page.goto('/login');
  await shot(page, `${t}-01-login`);
  console.log('CONTRAST', t, JSON.stringify(await contrastReport(page), null, 1));

  await login(page);
  await shot(page, `${t}-10-today`);
  audits.push(await audit(page, 'today'));

  const screens: [string, string][] = [
    ['11-tasks', '/tasks'],
    ['12-calendar', '/calendar'],
    ['14-goals', '/goals'],
    ['15-shopping', '/shopping'],
    ['16-wall', '/wall'],
    ['17-family', '/family'],
    ['18-settings', '/settings'],
    ['19-notif', '/settings/notifications'],
    ['20-profile', '/settings/profile'],
    ['21-members', '/admin/members'],
  ];
  for (const [name, url] of screens) {
    await page.goto(url);
    await shot(page, `${t}-${name}`);
    audits.push(await audit(page, url));
  }

  if (mobile) {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const url of [
      '/',
      '/tasks',
      '/calendar',
      '/goals',
      '/shopping',
      '/wall',
      '/family',
      '/settings',
      '/settings/notifications',
      '/settings/profile',
      '/admin/members',
    ]) {
      await page.goto(url);
      await settle(page, 500);
      audits.push(await audit(page, `320 ${url}`));
    }
    await page.goto('/settings/notifications');
    await settle(page);
    await page.screenshot({ path: path.join(OUT, `${t}-83-notif-320.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
  }

  /* Detail routes — these 500'd/400'd during the original review (backend bugs,
     since fixed), so they were never actually looked at. */
  await page.goto('/goals');
  await settle(page);
  const goalHref = await page.locator('a[href^="/goals/"]').first().getAttribute('href');
  if (goalHref) {
    await page.goto(goalHref);
    await shot(page, `${t}-30-goal-detail`);
    audits.push(await audit(page, 'goal-detail'));
  }
  await page.goto('/shopping');
  await settle(page);
  const listHref = await page.locator('a[href^="/shopping/"]').first().getAttribute('href');
  if (listHref) {
    await page.goto(listHref);
    await shot(page, `${t}-31-shopping-list`);
    audits.push(await audit(page, 'shopping-list'));
  }

  await page.evaluate(() => {
    window.localStorage.setItem('family.theme', 'dark');
  });
  await page.goto('/');
  await shot(page, `${t}-50-today-dark`);
  console.log('CONTRAST-DARK', t, JSON.stringify((await contrastReport(page)).slice(-6), null, 1));
  await page.goto('/goals');
  await shot(page, `${t}-53-goals-dark`);
  await page.goto('/calendar');
  await shot(page, `${t}-52-calendar-dark`);
  await page.evaluate(() => {
    window.localStorage.setItem('family.theme', 'light');
  });

  await page.goto('/goals');
  await settle(page);
  const newGoal = page.getByRole('button', { name: /Новая копилка|Копилка/ }).first();
  if (await newGoal.isVisible().catch(() => false)) {
    await newGoal.click();
    await shot(page, `${t}-78-goal-dialog`, false);
  }

  fs.writeFileSync(path.join(OUT, `${t}-audit.json`), JSON.stringify({ audits }, null, 2));
});
