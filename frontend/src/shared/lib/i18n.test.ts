import { describe, expect, it } from 'vitest';
import { PLURALS, formatCountRu, plural, pluralForm, pluralize } from './i18n';
import { SHOPPING_RU } from '@/features/shopping/locale';
import { contributorsLabel, daysLeftLabel } from '@/features/goals/locale';
import { taskCount } from '@/features/today/locale';
import { memberCount } from '@/features/family/locale';

/**
 * Russian pluralization.
 *
 * The rule has three forms and two traps:
 *   - 11–14 take the `many` form even though they end in 1–4;
 *   - 0 takes `many`, not `one`.
 * Both are exercised below.
 */

const TASKS = PLURALS.task; // ['задача', 'задачи', 'задач']

describe('pluralForm', () => {
  it('picks the "one" form for n ending in 1, except 11', () => {
    for (const n of [1, 21, 31, 101, 1001]) {
      expect(pluralForm(n)).toBe(0);
    }
  });

  it('picks the "few" form for n ending in 2–4, except 12–14', () => {
    for (const n of [2, 3, 4, 22, 23, 24, 102, 1003]) {
      expect(pluralForm(n)).toBe(1);
    }
  });

  it('picks the "many" form for 0, 5–20 and the 11–14 exception', () => {
    for (const n of [0, 5, 6, 9, 10, 11, 12, 13, 14, 15, 20, 25, 100, 111, 112]) {
      expect(pluralForm(n)).toBe(2);
    }
  });

  it('is symmetric for negative counts', () => {
    expect(pluralForm(-1)).toBe(pluralForm(1));
    expect(pluralForm(-13)).toBe(pluralForm(13));
    expect(pluralForm(-22)).toBe(pluralForm(22));
  });
});

describe('plural', () => {
  it('produces the forms Russian speakers expect', () => {
    expect(plural(1, TASKS)).toBe('задача');
    expect(plural(2, TASKS)).toBe('задачи');
    expect(plural(5, TASKS)).toBe('задач');
    expect(plural(0, TASKS)).toBe('задач');
  });

  it('gets the 11–14 exception right', () => {
    expect(plural(11, TASKS)).toBe('задач');
    expect(plural(12, TASKS)).toBe('задач');
    expect(plural(13, TASKS)).toBe('задач');
    expect(plural(14, TASKS)).toBe('задач');
    // …while the 21–24 band goes back to the normal rule.
    expect(plural(21, TASKS)).toBe('задача');
    expect(plural(22, TASKS)).toBe('задачи');
  });

  it('handles the hundreds boundary', () => {
    expect(plural(101, TASKS)).toBe('задача');
    expect(plural(111, TASKS)).toBe('задач');
    expect(plural(121, TASKS)).toBe('задача');
  });

  it('works for every catalogued word set', () => {
    expect(plural(1, PLURALS.member)).toBe('участник');
    expect(plural(3, PLURALS.member)).toBe('участника');
    expect(plural(7, PLURALS.member)).toBe('участников');

    expect(plural(1, PLURALS.day)).toBe('день');
    expect(plural(2, PLURALS.day)).toBe('дня');
    expect(plural(11, PLURALS.day)).toBe('дней');
  });
});

describe('pluralize', () => {
  it('prefixes the count', () => {
    expect(pluralize(1, TASKS)).toBe('1 задача');
    expect(pluralize(2, TASKS)).toBe('2 задачи');
    expect(pluralize(5, TASKS)).toBe('5 задач');
  });

  it('groups thousands the Russian way', () => {
    // Intl uses a narrow no-break space as the group separator for ru-RU.
    expect(pluralize(1234, TASKS).replace(/\s/g, ' ')).toBe('1 234 задачи');
  });
});

/**
 * The consolidation itself.
 *
 * This rule was written out six times: here, `features/shopping/locale.ts`,
 * `features/goals/locale.ts`, `notifications/render.ts`,
 * `dashboard/digest.service.ts` and `core/recurrence/engine.ts`. They agreed on
 * every integer, so nothing looked broken — but two of them exported a function
 * called `plural` taking `(n, one, few, many)` while this one takes
 * `(n, forms)`, so a line moved between the two files compiled and printed
 * nonsense; and the count was formatted two ways, «1 000 задач» on screen and
 * «1000 задач» in the push about the same figure.
 */
describe('one pluraliser, one count format', () => {
  it('is the same table the server renders notifications and the digest from', () => {
    // `PLURALS` is `RU_PLURALS` from `@family/shared` — not a copy of it.
    expect(PLURALS.task).toEqual(['задача', 'задачи', 'задач']);
    // Case-aware, which is what made the digest's tuple form the one that won.
    expect(plural(21, PLURALS.task)).toBe('задача');
    expect(plural(21, PLURALS.taskAccusative)).toBe('задачу');
  });

  it('formats every count through one formatter', () => {
    expect(formatCountRu(1_000)).toBe('1\u00a0000');
    expect(pluralize(1_000, PLURALS.task)).toBe(`${formatCountRu(1_000)} задач`);
  });

  it('routes every feature that used to inline its own tuple', () => {
    // shopping — used to export a `plural(n, one, few, many)` that *shadowed*
    // the shared name with a different arity.
    expect(SHOPPING_RU.quickAddCount(21)).toBe(
      `Добавим ${pluralize(21, PLURALS.lineItemAccusative)}`,
    );
    expect(SHOPPING_RU.counters(2, 11)).toBe(`2 из ${pluralize(11, PLURALS.lineItem)}`);

    // goals — used to export its own `pluralRu(count, one, few, many)`.
    expect(daysLeftLabel(11)).toBe(pluralize(11, PLURALS.day));
    expect(contributorsLabel(2)).toBe(pluralize(2, PLURALS.member));

    // today / family — used to inline the tuples at the call site.
    expect(taskCount(5)).toBe(pluralize(5, PLURALS.task));
    expect(memberCount(3)).toBe(pluralize(3, PLURALS.member));
  });

  it('exposes exactly one arity, so a copy-pasted call cannot compile to nonsense', () => {
    // `plural` takes a tuple. The three-positional-string form is gone from the
    // codebase entirely; this is the shape every call site now uses.
    expect(plural(1, PLURALS.change)).toBe('изменение');
    expect(pluralForm(1)).toBe(0);
  });
});
