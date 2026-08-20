import type { Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { assertClean, watch } from './helpers';

/**
 * The composers behind «Что повесим на доску?» must show **one** box per group,
 * not a field drawn inside a card.
 *
 * ## Why this is an e2e and not a unit test
 *
 * The bug it guards was reported as "a field inside a field" in «Новое
 * объявление»: in dark mode the note kept a white-at-4.8% rounded ground of its
 * own, inset 12/16px inside the `Section` card, and the same was true of the
 * poll's question and options and of the kudos message.
 *
 * Nothing in the source said so. Every composer *did* pass the overrides —
 * `border-0 bg-transparent px-0 shadow-none focus-visible:ring-0` — and they
 * read as complete. Two things defeated them, and both are invisible above the
 * stylesheet:
 *
 * - `bg-transparent` and the primitive's `dark:bg-input/30` are not a conflict
 *   to `tailwind-merge` (different modifiers), so both survived, and in the
 *   built CSS the `dark:` rule is later **and** more specific;
 * - nothing named a radius, so `rounded-md` was never overridden at all.
 *
 * So a test asserting class names would have passed against the broken build —
 * the class names were right. Only reading the resolved style back can tell.
 * That is the same reasoning as the stylesheet guard in
 * `keyboard-viewport.spec.ts`, and this is the third time in this codebase that
 * a Tailwind utility has silently failed to apply.
 *
 * ## The positive control
 *
 * "No borders anywhere" is also what a sheet that never opened looks like, and
 * what an unstyled page looks like. So each case additionally asserts that the
 * `Section` around the field **does** carry a 1px border, a radius and an opaque
 * ground: the surface moved to the row, it did not evaporate.
 */

interface Box {
  bg: string;
  borderWidth: string;
  radius: string;
  padding: string;
  fontSize: string;
}

interface Probe {
  field: Box;
  /** Every element between the field and its section body, innermost first. */
  between: Box[];
  section: Box | null;
  dark: boolean;
}

const TRANSPARENT = ['rgba(0, 0, 0, 0)', 'transparent'];

/**
 * Reads the field, its wrappers and its `Section` back out of the live page.
 *
 * `data-slot` rather than a test id: `Section` and the two primitives already
 * carry them, so this reads the shipped markup rather than markup added for a
 * test to hold on to.
 */
async function probe(
  page: Page,
  slot: 'textarea' | 'input',
  accessibleName: string | RegExp,
): Promise<Probe> {
  return page.evaluate(
    ({ slot, name }) => {
      const box = (el: Element) => {
        const s = getComputedStyle(el);
        return {
          bg: s.backgroundColor,
          borderWidth: s.borderTopWidth,
          radius: s.borderTopLeftRadius,
          padding: `${s.paddingTop} ${s.paddingLeft}`,
          fontSize: s.fontSize,
        };
      };

      // Every open dialog, not the first: the menu this composer was chosen
      // from is still on the layer stack while it animates out, and it is
      // earlier in the document.
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      if (dialogs.length === 0) throw new Error('no dialog is open');

      const fields = dialogs.flatMap((d) => [...d.querySelectorAll(`[data-slot="${slot}"]`)]);
      const field = fields.find((el) => {
        // Both, because these fields carry an `aria-label` that names the row
        // («Текст», «За что») *and* a placeholder that demonstrates it.
        const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`;
        return new RegExp(name).test(label);
      });
      if (!field) throw new Error(`no ${slot} matching ${name} in the open dialog`);

      const between = [];
      let node = field.parentElement;
      while (node && node.getAttribute('data-slot') !== 'section-body') {
        between.push(box(node));
        node = node.parentElement;
      }

      return {
        field: box(field),
        between,
        section: node ? box(node) : null,
        dark: document.documentElement.classList.contains('dark'),
      };
    },
    { slot, name: typeof accessibleName === 'string' ? accessibleName : accessibleName.source },
  );
}

function expectDrawsNothing(what: string, box: Box): void {
  expect(TRANSPARENT, `${what}: no ground of its own`).toContain(box.bg);
  expect(box.borderWidth, `${what}: no border of its own`).toBe('0px');
  expect(box.radius, `${what}: no radius of its own`).toBe('0px');
}

function expectIsTheSurface(what: string, box: Box | null): void {
  expect(box, `${what}: the field is inside a Section`).not.toBeNull();
  if (!box) return;
  expect(TRANSPARENT, `${what}: the section has an opaque ground`).not.toContain(box.bg);
  expect(box.borderWidth, `${what}: the section keeps its 1px edge`).toBe('1px');
  expect(parseFloat(box.radius), `${what}: the section keeps its radius`).toBeGreaterThan(0);
}

/** Opens the board's one door and picks one kind of note. */
async function compose(page: Page, kind: RegExp, title: string): Promise<void> {
  const door = page.getByRole('button').filter({ hasText: 'Что повесить на доску?' }).first();
  await door.waitFor();
  await door.click();

  // The menu is skipped when the reader may put up exactly one kind of note.
  const choice = page.getByRole('button', { name: kind }).first();
  if (await choice.isVisible().catch(() => false)) await choice.click();

  // By accessible *name*, not by text: `BoardCompose` deliberately lets the menu
  // finish leaving after the composer has been asked for, so two dialogs are on
  // the page for a few hundred milliseconds — and the menu's own body contains
  // «Спросить семью и решить вместе», which a `hasText` filter happily matches.
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
}

async function dismiss(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Отмена' }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.use({ colorScheme: 'dark' });

test('a composer field draws no box of its own inside its Section', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/wall');

  await compose(page, /Объявление/, 'Новое объявление');
  const note = await probe(page, 'textarea', 'в субботу едем к бабушке');
  expect(note.dark, 'the dark theme is the one under test').toBeTruthy();
  expectDrawsNothing('the announcement note', note.field);
  for (const [i, wrapper] of note.between.entries()) {
    expectDrawsNothing(`the announcement note's wrapper ${String(i)}`, wrapper);
  }
  expectIsTheSurface('the announcement note', note.section);
  // Below 16px iOS zooms the viewport on focus and never zooms back (§F2).
  expect(parseFloat(note.field.fontSize)).toBeGreaterThanOrEqual(16);
  await dismiss(page);

  await compose(page, /Опрос/, 'Спросить семью');
  const question = await probe(page, 'textarea', 'куда едем на выходных');
  expectDrawsNothing('the poll question', question.field);
  expectIsTheSurface('the poll question', question.section);
  // The option rows are fields inside a Section too, and shared the same defect.
  const option = await probe(page, 'input', 'Вариант 1');
  expectDrawsNothing('a poll option', option.field);
  expectIsTheSurface('a poll option', option.section);
  await dismiss(page);

  await compose(page, /Спасибо/, 'Кому спасибо?');
  const message = await probe(page, 'textarea', 'спасибо, что забрал');
  expectDrawsNothing('the kudos message', message.field);
  expectIsTheSurface('the kudos message', message.section);
  await dismiss(page);

  assertClean(problems, 'the wall composers');
});
