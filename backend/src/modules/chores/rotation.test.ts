import { describe, expect, it } from 'vitest';

import {
  compareByDebt,
  DEBT_EPSILON,
  computeDebt,
  EXCUSED_DEBT,
  ineligibleReason,
  isBlackedOut,
  pickAssignee,
  previewAssignments,
  RotationRun,
  type BlackoutWindow,
  type RotationCandidate,
  type RotationSnapshot,
} from './rotation.js';

/**
 * The rotation suite.
 *
 * No database anywhere: `rotation.ts` is pure, and the property that matters
 * most about it — "re-running the materializer reproduces the same schedule bit
 * for bit" (D5) — is a property of the *function*, not of the storage. A test
 * that needed Postgres to prove determinism would be testing the wrong thing.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const T0 = new Date('2026-09-07T06:00:00.000Z');
const DAY = 86_400_000;

/** Ids are ordered so the final `userId` tie-break is easy to reason about. */
const ADULT = '00000000-0000-4000-8000-00000000000a';
const TEEN = '00000000-0000-4000-8000-00000000000b';
const CHILD = '00000000-0000-4000-8000-00000000000c';

function member(overrides: Partial<RotationCandidate> & { userId: string }): RotationCandidate {
  return {
    weight: 1,
    position: 0,
    active: true,
    earned: 0,
    committed: 0,
    lastAssignedAt: null,
    blackouts: [],
    ...overrides,
  };
}

function snapshot(
  members: RotationCandidate[],
  overrides: Partial<RotationSnapshot> = {},
): RotationSnapshot {
  return { strategy: 'weighted_balance', cursor: 0, members, ...overrides };
}

/** Run a whole horizon of daily occurrences and collect who got each one. */
function runSchedule(
  input: RotationSnapshot,
  options: { count: number; points: number; from?: Date },
): Array<string | null> {
  const run = new RotationRun(input);
  const from = options.from ?? T0;
  const picks: Array<string | null> = [];
  for (let i = 0; i < options.count; i += 1) {
    picks.push(run.assign(new Date(from.getTime() + i * DAY), options.points).userId);
  }
  return picks;
}

/* -------------------------------------------------------------------------- */
/* Debt                                                                        */
/* -------------------------------------------------------------------------- */

describe('computeDebt', () => {
  it('divides the combined load by the weight', () => {
    expect(computeDebt(6, 4, 2)).toBe(5);
  });

  it('treats a zero or negative weight as excused, not as a divide by zero', () => {
    expect(computeDebt(10, 0, 0)).toBe(EXCUSED_DEBT);
    expect(computeDebt(10, 0, -1)).toBe(EXCUSED_DEBT);
    // An excused member with no history is still excused — the rule is about
    // capacity, not about whether they happen to owe anything today.
    expect(computeDebt(0, 0, 0)).toBe(EXCUSED_DEBT);
  });

  it('counts committed work exactly like earned work', () => {
    expect(computeDebt(10, 0, 1)).toBe(computeDebt(0, 10, 1));
  });
});

describe('isBlackedOut', () => {
  const window: BlackoutWindow[] = [
    { startsAt: new Date('2026-09-10T00:00:00Z'), endsAt: new Date('2026-09-20T00:00:00Z') },
  ];

  it('is half-open: the closing instant is already free', () => {
    expect(isBlackedOut(window, new Date('2026-09-10T00:00:00Z'))).toBe(true);
    expect(isBlackedOut(window, new Date('2026-09-19T23:59:59Z'))).toBe(true);
    expect(isBlackedOut(window, new Date('2026-09-20T00:00:00Z'))).toBe(false);
    expect(isBlackedOut(window, new Date('2026-09-09T23:59:59Z'))).toBe(false);
  });
});

describe('ineligibleReason', () => {
  const at = T0;

  it('reports the reason rather than a bare boolean', () => {
    expect(ineligibleReason({ active: false, weight: 1, blackouts: [] }, at)).toBe('inactive');
    expect(ineligibleReason({ active: true, weight: 0, blackouts: [] }, at)).toBe('zero_weight');
    expect(
      ineligibleReason(
        {
          active: true,
          weight: 1,
          blackouts: [{ startsAt: new Date(at.getTime() - DAY), endsAt: new Date(at.getTime() + DAY) }],
        },
        at,
      ),
    ).toBe('blackout');
    expect(ineligibleReason({ active: true, weight: 1, blackouts: [] }, at)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The tie-break chain                                                         */
/* -------------------------------------------------------------------------- */

describe('compareByDebt — the deterministic tie-break chain (D5)', () => {
  const base = { userId: ADULT, position: 0, lastAssignedAt: null, debt: 1 };

  it('puts the lowest debt first', () => {
    expect(compareByDebt({ ...base, debt: 1 }, { ...base, debt: 2 })).toBeLessThan(0);
  });

  it('breaks a debt tie by longest since the last assignment, never-assigned first', () => {
    const never = { ...base, userId: TEEN, lastAssignedAt: null };
    const recent = { ...base, userId: ADULT, lastAssignedAt: T0 };
    expect(compareByDebt(never, recent)).toBeLessThan(0);

    const older = { ...base, userId: TEEN, lastAssignedAt: new Date(T0.getTime() - DAY) };
    expect(compareByDebt(older, recent)).toBeLessThan(0);
  });

  it('then by position, then by id — a total order, so two runs cannot disagree', () => {
    const a = { ...base, userId: CHILD, position: 1 };
    const b = { ...base, userId: ADULT, position: 2 };
    expect(compareByDebt(a, b)).toBeLessThan(0);

    const sameEverything = { ...base, userId: ADULT };
    const later = { ...base, userId: TEEN };
    expect(compareByDebt(sameEverything, later)).toBeLessThan(0);
    expect(compareByDebt(later, sameEverything)).toBeGreaterThan(0);
    expect(compareByDebt(sameEverything, { ...sameEverything })).toBe(0);
  });

  it('treats debts within DEBT_EPSILON as a tie, so IEEE-754 noise cannot pick a person', () => {
    // Fractional weights make exact equality a coin flip: `(0.1 + 0.2) / 0.3`
    // is 1.0000000000000002, not 1. Without the tolerance the documented
    // tie-break chain would be short-circuited by the last bit of a mantissa.
    const child = { ...base, userId: CHILD, position: 9, debt: 10 };
    const adult = { ...base, userId: ADULT, position: 1, debt: 10 + DEBT_EPSILON / 2 };
    // Nominally the child owes a hair less; within epsilon they tie, so
    // position decides and the adult wins on 1 vs 9.
    expect(compareByDebt(adult, child)).toBeLessThan(0);
    // A difference that actually means something still wins on debt.
    expect(compareByDebt({ ...adult, debt: 10.001 }, child)).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism — the reason this file exists                                   */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  const roster = [
    member({ userId: ADULT, position: 0, earned: 12, lastAssignedAt: new Date(T0.getTime() - 3 * DAY) }),
    member({ userId: TEEN, position: 1, earned: 7, lastAssignedAt: new Date(T0.getTime() - DAY) }),
    member({ userId: CHILD, position: 2, weight: 0.5, earned: 3, lastAssignedAt: null }),
  ];

  it('produces an identical schedule when the same snapshot is run twice', () => {
    const first = runSchedule(snapshot(roster), { count: 30, points: 5 });
    const second = runSchedule(snapshot(roster), { count: 30, points: 5 });
    expect(second).toEqual(first);
  });

  it('does not mutate the snapshot it was handed', () => {
    const before = JSON.stringify(roster);
    runSchedule(snapshot(roster), { count: 30, points: 5 });
    expect(JSON.stringify(roster)).toBe(before);
  });

  it('is stable under a reordered member array', () => {
    // Postgres makes no promise about row order without an ORDER BY. The
    // comparator ends at `userId`, so the answer must not depend on it.
    const shuffled = [roster[2], roster[0], roster[1]].filter(
      (m): m is RotationCandidate => m !== undefined,
    );
    expect(runSchedule(snapshot(shuffled), { count: 20, points: 5 })).toEqual(
      runSchedule(snapshot(roster), { count: 20, points: 5 }),
    );
  });

  it('never leaves a chore to chance — every pick is one of the eligible members', () => {
    const picks = runSchedule(snapshot(roster), { count: 50, points: 4 });
    expect(new Set(picks)).toEqual(new Set([ADULT, TEEN, CHILD]));
  });
});

/* -------------------------------------------------------------------------- */
/* weighted_balance                                                            */
/* -------------------------------------------------------------------------- */

describe('weighted_balance', () => {
  it('picks the lowest debt', () => {
    const pick = pickAssignee(
      snapshot([
        member({ userId: ADULT, earned: 20 }),
        member({ userId: TEEN, earned: 4 }),
        member({ userId: CHILD, earned: 9 }),
      ]),
      T0,
    );
    expect(pick.userId).toBe(TEEN);
    expect(pick.assignedVia).toBe('rotation');
    expect(pick.debt).toBe(4);
  });

  it('folds each pick back into committed, so one pass cannot dump a month on one person', () => {
    const picks = runSchedule(
      snapshot([member({ userId: ADULT, position: 0 }), member({ userId: TEEN, position: 1 })]),
      { count: 10, points: 5 },
    );
    const adultShare = picks.filter((p) => p === ADULT).length;
    expect(adultShare).toBe(5);
    // And they genuinely alternate rather than arriving in two blocks.
    expect(picks.slice(0, 4)).toEqual([ADULT, TEEN, ADULT, TEEN]);
  });

  it('alternates on zero-point chores, where only the tie-break can separate people', () => {
    // With `points: 0` nobody's debt ever changes, so "longest since their last
    // assignment" is the *only* thing keeping this from being one name repeated
    // ten times.
    const picks = runSchedule(
      snapshot([member({ userId: ADULT, position: 0 }), member({ userId: TEEN, position: 1 })]),
      { count: 6, points: 0 },
    );
    expect(picks).toEqual([ADULT, TEEN, ADULT, TEEN, ADULT, TEEN]);
  });

  it('converges a 0.4-weight child and a 1.0-weight adult to proportional load', () => {
    const POINTS = 10;
    const picks = runSchedule(
      snapshot([
        member({ userId: ADULT, weight: 1, position: 0 }),
        member({ userId: CHILD, weight: 0.4, position: 1 }),
      ]),
      { count: 70, points: POINTS },
    );

    const adult = picks.filter((p) => p === ADULT).length;
    const child = picks.filter((p) => p === CHILD).length;
    expect(adult + child).toBe(70);

    // Fair share is 1 / 1.4 = 71.4 % and 0.4 / 1.4 = 28.6 %.
    expect(child / 70).toBeCloseTo(0.4 / 1.4, 1);
    expect(adult / 70).toBeCloseTo(1 / 1.4, 1);

    // The load each of them ends up carrying, divided by their weight, is the
    // same number — which is the actual definition of "fair" here.
    expect((adult * POINTS) / 1).toBeCloseTo((child * POINTS) / 0.4, -1);
  });

  it('starts a member with existing debt behind one who has none', () => {
    const picks = runSchedule(
      snapshot([
        member({ userId: ADULT, position: 0, earned: 30 }),
        member({ userId: TEEN, position: 1, earned: 0 }),
      ]),
      { count: 4, points: 10 },
    );
    // The teen owes nothing, so they take the first three before it evens out.
    expect(picks).toEqual([TEEN, TEEN, TEEN, ADULT]);
  });

  it('skips a blacked-out member without forgiving their debt', () => {
    const holiday: BlackoutWindow[] = [
      { startsAt: new Date(T0.getTime() - DAY), endsAt: new Date(T0.getTime() + 3 * DAY) },
    ];
    const roster = snapshot([
      member({ userId: ADULT, position: 0, earned: 0, blackouts: holiday }),
      member({ userId: TEEN, position: 1, earned: 20 }),
    ]);

    const picks = runSchedule(roster, { count: 5, points: 5 });
    // Days 0-2 fall inside the blackout, so the teen takes them despite owing
    // far more...
    expect(picks.slice(0, 3)).toEqual([TEEN, TEEN, TEEN]);
    // ...and the adult is straight back at the front of the queue afterwards,
    // because the skip never touched their debt.
    expect(picks[3]).toBe(ADULT);
  });

  it('excuses a zero-weight member entirely', () => {
    const picks = runSchedule(
      snapshot([
        member({ userId: ADULT, position: 0, weight: 0 }),
        member({ userId: TEEN, position: 1, earned: 500 }),
      ]),
      { count: 3, points: 5 },
    );
    expect(picks).toEqual([TEEN, TEEN, TEEN]);
  });

  it('ignores inactive members', () => {
    const pick = pickAssignee(
      snapshot([
        member({ userId: ADULT, active: false }),
        member({ userId: TEEN, earned: 99 }),
      ]),
      T0,
    );
    expect(pick.userId).toBe(TEEN);
  });

  it('leaves the occurrence unassigned when nobody is eligible', () => {
    const pick = pickAssignee(
      snapshot([
        member({
          userId: ADULT,
          blackouts: [{ startsAt: new Date(T0.getTime() - DAY), endsAt: new Date(T0.getTime() + DAY) }],
        }),
      ]),
      T0,
    );
    expect(pick.userId).toBeNull();
    expect(pick.assignedVia).toBeNull();
    expect(pick.unassignedReason).toBe('no_eligible_member');
  });

  it('reports an empty rotation distinctly from an ineligible one', () => {
    expect(pickAssignee(snapshot([]), T0).unassignedReason).toBe('empty_rotation');
  });
});

/* -------------------------------------------------------------------------- */
/* round_robin / fixed / anyone                                                */
/* -------------------------------------------------------------------------- */

describe('round_robin', () => {
  const roster = [
    member({ userId: CHILD, position: 0 }),
    member({ userId: ADULT, position: 1 }),
    member({ userId: TEEN, position: 2 }),
  ];

  it('walks position order and wraps', () => {
    expect(runSchedule(snapshot(roster, { strategy: 'round_robin' }), { count: 4, points: 5 })).toEqual([
      CHILD,
      ADULT,
      TEEN,
      CHILD,
    ]);
  });

  it('starts from the stored cursor and reports where to resume', () => {
    const run = new RotationRun(snapshot(roster, { strategy: 'round_robin', cursor: 2 }));
    expect(run.assign(T0, 0).userId).toBe(TEEN);
    expect(run.cursor).toBe(0);
    expect(run.cursorMoved).toBe(true);
  });

  it('normalizes an out-of-range cursor rather than falling off the end', () => {
    const run = new RotationRun(snapshot(roster, { strategy: 'round_robin', cursor: 7 }));
    expect(run.assign(T0, 0).userId).toBe(ADULT); // 7 % 3 === 1
  });

  it('skips a blacked-out member without costing them their turn', () => {
    const away = [
      member({ userId: CHILD, position: 0 }),
      member({
        userId: ADULT,
        position: 1,
        blackouts: [{ startsAt: T0, endsAt: new Date(T0.getTime() + DAY + 1) }],
      }),
      member({ userId: TEEN, position: 2 }),
    ];
    const picks = runSchedule(snapshot(away, { strategy: 'round_robin' }), { count: 4, points: 0 });
    // Day 0: child. Day 1: adult is away, so the teen takes it. Day 2: the
    // cursor is past the teen, so it wraps to the child, then the adult — who
    // is back — is next.
    expect(picks).toEqual([CHILD, TEEN, CHILD, ADULT]);
  });

  it('ignores inactive and zero-weight members in the walk', () => {
    const mixed = [
      member({ userId: CHILD, position: 0, active: false }),
      member({ userId: ADULT, position: 1, weight: 0 }),
      member({ userId: TEEN, position: 2 }),
    ];
    expect(runSchedule(snapshot(mixed, { strategy: 'round_robin' }), { count: 2, points: 0 })).toEqual([
      TEEN,
      TEEN,
    ]);
  });
});

describe('fixed', () => {
  it('always picks the same member regardless of debt', () => {
    const roster = snapshot(
      [
        member({ userId: ADULT, position: 0, earned: 1_000 }),
        member({ userId: TEEN, position: 1, earned: 0 }),
      ],
      { strategy: 'fixed' },
    );
    expect(runSchedule(roster, { count: 3, points: 5 })).toEqual([ADULT, ADULT, ADULT]);
  });

  it('leaves the slot empty while that member is away, rather than picking a stand-in', () => {
    const roster = snapshot(
      [
        member({
          userId: ADULT,
          position: 0,
          blackouts: [{ startsAt: T0, endsAt: new Date(T0.getTime() + DAY) }],
        }),
        member({ userId: TEEN, position: 1 }),
      ],
      { strategy: 'fixed' },
    );
    const picks = runSchedule(roster, { count: 2, points: 0 });
    expect(picks).toEqual([null, ADULT]);
  });
});

describe('anyone', () => {
  it('materializes unassigned and claimable, whoever is eligible', () => {
    const pick = pickAssignee(
      snapshot([member({ userId: ADULT }), member({ userId: TEEN })], { strategy: 'anyone' }),
      T0,
    );
    expect(pick.userId).toBeNull();
    expect(pick.assignedVia).toBeNull();
    expect(pick.unassignedReason).toBe('anyone_strategy');
  });

  it('stays unassigned for a whole horizon', () => {
    const picks = runSchedule(
      snapshot([member({ userId: ADULT }), member({ userId: TEEN })], { strategy: 'anyone' }),
      { count: 10, points: 5 },
    );
    expect(picks.every((p) => p === null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

describe('previewAssignments', () => {
  const roster = snapshot([
    member({ userId: ADULT, position: 0, earned: 10 }),
    member({ userId: TEEN, position: 1, earned: 0 }),
    member({ userId: CHILD, position: 2, weight: 0, earned: 0 }),
  ]);

  it('reproduces exactly what materialization would do', () => {
    const steps = previewAssignments(roster, { at: T0, count: 5, points: 5 });
    expect(steps.map((s) => s.pick.userId)).toEqual(
      runSchedule(roster, { count: 5, points: 5 }),
    );
  });

  it('explains why a member was passed over', () => {
    const [first] = previewAssignments(roster, { at: T0, count: 1, points: 5 });
    const excused = first?.standings.find((s) => s.userId === CHILD);
    expect(excused?.eligible).toBe(false);
    expect(excused?.reason).toBe('zero_weight');
    expect(excused?.debt).toBe(EXCUSED_DEBT);
  });

  it('orders standings by the same comparator the picker uses', () => {
    const [first] = previewAssignments(roster, { at: T0, count: 1, points: 5 });
    expect(first?.standings.map((s) => s.userId)).toEqual([TEEN, ADULT, CHILD]);
  });
});
