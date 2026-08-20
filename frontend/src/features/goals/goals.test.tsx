import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { GoalResponse, Permission, PublicUser } from '@family/shared';
import { meKeys } from '@/shared/auth/use-me';
import { makeMe } from '@/test/me';
import { formatMoney } from '@/shared/lib/format';
import { GOALS_RU } from './locale';
import {
  formatMinorUnitsForInput,
  goalProgressPercent,
  parseAmount,
  parseMinorUnits,
  parsePositiveAmount,
} from './money';
import { useGoalAbilities } from './hooks';
import { GoalCard } from './components/GoalCard';
import { ContributeDialog } from './components/ContributeDialog';
import { GoalFormDialog } from './components/GoalFormDialog';

/**
 * What is worth testing here, and why.
 *
 * 1. The money parser. A rounding bug in it is a bug in the family's savings,
 *    so it gets round-trip, rubbish-rejection and never-a-float coverage.
 * 2. The permission affordances. D4 says teens are read-only and the UI must
 *    derive that from `useCan()` — the test drives it through the real
 *    `/api/me` cache entry, exactly as the app does.
 * 3. The progress percentage at its three interesting points.
 * 4. The contribute preview, because that number is what the user commits to.
 */

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ADULT_PERMISSIONS: Permission[] = [
  'goal:read',
  'goal:create',
  'goal:update',
  'goal:delete',
  'goal:contribute',
  'member:read',
];

/** A teen holds `goal:read` and nothing else (see the matrix in `roles.ts`). */
const TEEN_PERMISSIONS: Permission[] = ['goal:read', 'member:read'];

function makeGoal(overrides: Partial<GoalResponse> = {}): GoalResponse {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Отпуск на море',
    description: null,
    targetAmount: 50_000_00,
    currentAmount: 39_000_00,
    progressPercent: 78,
    remainingAmount: 11_000_00,
    currency: 'RUB',
    deadline: null,
    imageUrl: null,
    color: '#C2703D',
    icon: null,
    status: 'active',
    visibility: 'household',
    ownerId: null,
    createdById: '11111111-1111-4111-8111-111111111111',
    reachedAt: null,
    sortOrder: 0,
    milestones: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY_ROSTER = new Map<string, PublicUser>();

function renderAs(permissions: Permission[], ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The real permission source: the `['me']` cache entry `useCan()` reads.
  queryClient.setQueryData(
    meKeys.detail(),
    makeMe({ id: '11111111-1111-4111-8111-111111111111', permissions }),
  );

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/* -------------------------------------------------------------------------- */
/* money                                                                       */
/* -------------------------------------------------------------------------- */

describe('money parsing (D6)', () => {
  it('round-trips 1 234,56 ↔ 123456', () => {
    expect(parseMinorUnits('1 234,56')).toBe(123456);
    expect(formatMinorUnitsForInput(123456)).toBe('1234,56');
    expect(parseMinorUnits(formatMinorUnitsForInput(123456))).toBe(123456);
    // …including through the display formatter, NBSP separators and all.
    expect(parseMinorUnits(formatMoney(123456))).toBe(123456);
  });

  it('accepts both decimal separators and ignores thousands separators', () => {
    expect(parseMinorUnits('1234,56')).toBe(123456);
    expect(parseMinorUnits('1234.56')).toBe(123456);
    // Plain space, NBSP (U+00A0) and narrow NBSP (U+202F).
    expect(parseMinorUnits('1 234,56')).toBe(123456);
    expect(parseMinorUnits('1 234,56')).toBe(123456);
    expect(parseMinorUnits('1 234,56')).toBe(123456);
    expect(parseMinorUnits('1 000 000')).toBe(100_000_000);
    expect(parseMinorUnits('1234,5')).toBe(123450);
    expect(parseMinorUnits(',50')).toBe(50);
    expect(parseMinorUnits('0')).toBe(0);
  });

  it('rejects rubbish instead of guessing', () => {
    for (const rubbish of ['', '   ', 'abc', 'сто рублей', '1,2,3', '1.2.3', '-', ',', '12 у.е.']) {
      expect(parseMinorUnits(rubbish)).toBeNull();
    }
    // Three decimals would mean silently rounding somebody's money.
    expect(parseAmount('12,345')).toEqual({ ok: false, error: 'precision' });
    expect(parseAmount('999999999999999999').ok).toBe(false);
  });

  it('never produces a float, at any input', () => {
    const inputs = ['19.99', '0,01', '0,1', '1 234,56', '999 999,99', '8,05', '70,7', '1000000,03'];
    for (const input of inputs) {
      const value = parseMinorUnits(input);
      expect(value).not.toBeNull();
      expect(Number.isInteger(value)).toBe(true);
    }
    // The classic float trap: 19.99 * 100 === 1998.9999999999998.
    expect(parseMinorUnits('19.99')).toBe(1999);
    expect(parseMinorUnits('8,05')).toBe(805);
    expect(parseMinorUnits('70,7')).toBe(7070);
  });

  it('treats zero and negative amounts as invalid where a positive one is required', () => {
    expect(parsePositiveAmount('0')).toEqual({ ok: false, error: 'notPositive' });
    expect(parsePositiveAmount('-100')).toEqual({ ok: false, error: 'notPositive' });
    expect(parsePositiveAmount('100')).toEqual({ ok: true, minorUnits: 10000 });
  });
});

/* -------------------------------------------------------------------------- */
/* progress                                                                    */
/* -------------------------------------------------------------------------- */

describe('goal progress', () => {
  it('is 0 for an empty goal', () => {
    expect(goalProgressPercent(0, 50_000_00)).toBe(0);
    expect(goalProgressPercent(-500, 50_000_00)).toBe(0);
    // A target of zero cannot produce a percentage at all.
    expect(goalProgressPercent(1000, 0)).toBe(0);
  });

  it('rounds a partial goal to whole percent', () => {
    expect(goalProgressPercent(39_000_00, 50_000_00)).toBe(78);
    expect(goalProgressPercent(12_345, 100_000)).toBe(12);
    expect(goalProgressPercent(1, 100_000)).toBe(0);
  });

  it('is not capped at 100 for an over-funded goal', () => {
    expect(goalProgressPercent(56_000_00, 50_000_00)).toBe(112);
    expect(goalProgressPercent(50_000_00, 50_000_00)).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* permissions (D4)                                                            */
/* -------------------------------------------------------------------------- */

/** Exactly what the page renders: the ability comes from `useCan()` via
 *  `useGoalAbilities()`, never from a `role ===` comparison (D4). */
function GoalCardUnderPermissions() {
  const abilities = useGoalAbilities();
  return (
    <GoalCard goal={makeGoal()} roster={EMPTY_ROSTER} canContribute={abilities.canContribute} />
  );
}

/**
 * The same condition `GoalDetailPage` guards «Пополнить» with — that button
 * moved off the list row in the §D4 rebuild (one filled primary per view), so
 * the D4 rule is asserted where the affordance now lives.
 */
function ContributeAffordance() {
  const abilities = useGoalAbilities();
  return abilities.canContribute ? <button type="button">{GOALS_RU.contribute}</button> : null;
}

describe('permission affordances', () => {
  it('resolves the contribute ability from useCan(), never from a role (D4)', () => {
    renderAs(ADULT_PERMISSIONS, <ContributeAffordance />);
    expect(screen.getByRole('button', { name: GOALS_RU.contribute })).toBeInTheDocument();
  });

  it('hides every write affordance from a read-only teen', () => {
    renderAs(TEEN_PERMISSIONS, <ContributeAffordance />);
    expect(screen.queryByRole('button', { name: GOALS_RU.contribute })).not.toBeInTheDocument();
  });

  it('never puts a write affordance on a goal row — for anybody', () => {
    // §D4: the row is one indicator and one tap into the goal. «Пополнить» on
    // every row is a second filled primary per goal, floating at a different
    // height in each card because the titles wrap differently.
    renderAs(ADULT_PERMISSIONS, <GoalCardUnderPermissions />);
    expect(screen.getByText('Отпуск на море')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('still shows the goal itself to a read-only teen', () => {
    renderAs(TEEN_PERMISSIONS, <GoalCardUnderPermissions />);
    expect(screen.getByText('Отпуск на море')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* contribute preview                                                          */
/* -------------------------------------------------------------------------- */

describe('contribute dialog preview', () => {
  it('previews the resulting balance and progress in integer minor units', () => {
    const goal = makeGoal({ currentAmount: 1_000_00, targetAmount: 5_000_00 });
    renderAs(
      ADULT_PERMISSIONS,
      <ContributeDialog goal={goal} mode="contribute" open onOpenChange={() => undefined} />,
    );

    const amount = screen.getByLabelText(GOALS_RU.amount);
    fireEvent.change(amount, { target: { value: '1 234,56' } });

    // 100000 + 123456 = 223456 копеек.
    expect(screen.getByTestId('contribute-preview-balance').textContent).toBe(formatMoney(223456));
    // 223456 / 500000 = 44.69 % → 45 %.
    expect(screen.getByTestId('contribute-preview-percent').textContent).toContain('45');
  });

  it('subtracts on a withdrawal and warns when the balance would go negative', () => {
    const goal = makeGoal({ currentAmount: 1_000_00, targetAmount: 5_000_00 });
    renderAs(
      ADULT_PERMISSIONS,
      <ContributeDialog goal={goal} mode="withdraw" open onOpenChange={() => undefined} />,
    );

    const amount = screen.getByLabelText(GOALS_RU.amount);
    fireEvent.change(amount, { target: { value: '250' } });
    expect(screen.getByTestId('contribute-preview-balance').textContent).toBe(formatMoney(75_000));

    fireEvent.change(amount, { target: { value: '1 500' } });
    expect(screen.getByTestId('contribute-preview-balance').textContent).toBe(formatMoney(-50_000));
    expect(screen.getByText(GOALS_RU.previewOverdraft)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* the edit form survives a concurrent change                                  */
/* -------------------------------------------------------------------------- */

describe('goal form vs. a refetch mid-edit', () => {
  /**
   * The bug this pins down: the re-seed effect depended on the whole `goal`
   * object. TanStack's structural sharing keeps that object identical while the
   * data is unchanged, so an idle refetch is harmless and the dependency looks
   * safe — until another family member actually changes the goal. Then the
   * query hands back a **new object**, the effect fires, `form.reset` runs, and
   * everything typed since the dialog opened is gone without a word.
   *
   * A family app hits concurrent edits by construction: someone contributing to
   * the copilka you are renaming is the normal case, not the exotic one. The
   * same defect was fixed once already in the shopping dialogs, which is why
   * this test exists rather than just the fix.
   */
  it('keeps what the user typed when the goal is changed by someone else', () => {
    const goal = makeGoal();
    const { rerender } = renderAs(
      ADULT_PERMISSIONS,
      <GoalFormDialog open onOpenChange={() => undefined} goal={goal} />,
    );

    const title = screen.getByLabelText(GOALS_RU.formName);
    fireEvent.change(title, { target: { value: 'Отпуск в горах' } });
    expect(title).toHaveValue('Отпуск в горах');

    // A refetch after somebody else contributed: same id, new object.
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <GoalFormDialog
            open
            onOpenChange={() => undefined}
            goal={makeGoal({ currentAmount: 41_000_00, progressPercent: 82 })}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText(GOALS_RU.formName)).toHaveValue('Отпуск в горах');
  });

  it('does re-seed when the dialog is pointed at a different goal', () => {
    const { rerender } = renderAs(
      ADULT_PERMISSIONS,
      <GoalFormDialog open onOpenChange={() => undefined} goal={makeGoal()} />,
    );
    expect(screen.getByLabelText(GOALS_RU.formName)).toHaveValue('Отпуск на море');

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <GoalFormDialog
            open
            onOpenChange={() => undefined}
            goal={makeGoal({ id: '33333333-3333-4333-8333-333333333333', title: 'Велосипед' })}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText(GOALS_RU.formName)).toHaveValue('Велосипед');
  });
});
