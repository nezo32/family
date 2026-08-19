import type { AssignedVia, RotationStrategy } from '@family/shared';

/**
 * The chore rotation algorithm (D5, `docs/architecture/scheduling.md` §5).
 *
 * **This file is pure.** No database, no clock, no randomness, no I/O of any
 * kind. Everything it needs arrives in a {@link RotationSnapshot} and every
 * answer is a deterministic function of that snapshot. That is not a stylistic
 * preference — it is the feature:
 *
 * > Re-running the materializer must reproduce the same schedule bit for bit.
 *
 * If assignment were random, or read the wall clock, or depended on row order
 * from Postgres, then every horizon extension would silently reshuffle next
 * week's chores. "But it said it was mine yesterday" is the end of the feature,
 * so the tie-break chain below is total: it ends at `userId`, which is unique,
 * so two runs over the same snapshot cannot disagree.
 *
 * ## The debt model
 *
 * ```
 * debt = (earned + committed) / weight
 * ```
 *
 * - `earned`    — points actually booked to the member over the balance window.
 * - `committed` — points of still-`scheduled` work already assigned to them.
 * - `weight`    — capacity multiplier. A 0.4-weight child carrying 4 points has
 *                 the same debt as a 1.0-weight adult carrying 10, so both are
 *                 equally "next" — which is how proportional load emerges.
 *
 * `committed` is what stops one pass handing a single person the whole month:
 * {@link RotationRun.assign} folds each pick straight back into that member's
 * committed total before the next occurrence is considered.
 *
 * A `weight <= 0` member is **excused**, expressed as infinite debt rather than
 * as a filter, so the debt column stays meaningful in the preview UI.
 */

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** Half-open interval `[startsAt, endsAt)` in which a member is unavailable. */
export interface BlackoutWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * One roster row, already resolved against the ledger by the repository.
 *
 * `weight` is a JS number here and a `numeric(4,2)` string at rest; the
 * repository does the one conversion so the maths never sees a string.
 */
export interface RotationCandidate {
  readonly userId: string;
  /** Effective weight for this rotation. `<= 0` means excused. */
  readonly weight: number;
  /** `round_robin` order and the penultimate deterministic tie-break. */
  readonly position: number;
  /** Soft removal — an inactive member keeps their history but takes no work. */
  readonly active: boolean;
  /** `SUM(delta)` of chore/bonus/cover reasons over the balance window. */
  readonly earned: number;
  /** Effective points of still-`scheduled` occurrences already assigned. */
  readonly committed: number;
  /** `MAX(starts_at)` over their assignments. NULL => never assigned. */
  readonly lastAssignedAt: Date | null;
  /** Every blackout that could overlap the planning window. */
  readonly blackouts: readonly BlackoutWindow[];
}

export interface RotationSnapshot {
  readonly strategy: RotationStrategy;
  /** `round_robin` index of the next pick, taken modulo the walk length. */
  readonly cursor: number;
  readonly members: readonly RotationCandidate[];
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

/** Why a member was passed over. Mirrors the strings in the preview contract. */
export type IneligibleReason = 'inactive' | 'zero_weight' | 'blackout';

/** Why the rotation produced no assignee. */
export type UnassignedReason = 'anyone_strategy' | 'no_eligible_member' | 'empty_rotation';

export interface RotationPick {
  /** NULL for `anyone`, and whenever nobody is eligible at that instant. */
  readonly userId: string | null;
  /** `'rotation'` when somebody was picked; NULL leaves the row claimable. */
  readonly assignedVia: Extract<AssignedVia, 'rotation'> | null;
  /** The winner's debt at the moment of the pick. NULL when unassigned. */
  readonly debt: number | null;
  /** Set only when `userId` is NULL — the audit trail for "why nobody?". */
  readonly unassignedReason: UnassignedReason | null;
}

/** One member's standing at a point in a dry run, for the preview endpoint. */
export interface RotationStanding {
  readonly userId: string;
  readonly weight: number;
  readonly earned: number;
  readonly committed: number;
  readonly debt: number;
  readonly eligible: boolean;
  readonly reason: IneligibleReason | null;
}

/* -------------------------------------------------------------------------- */
/* Pure primitives                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Float slack for debt equality.
 *
 * `(4 + 0) / 0.4` is `9.999999999999998`, not `10`. Without a tolerance the
 * 0.4-weight child and the 1.0-weight adult would never tie, and the ordering
 * would be decided by IEEE-754 noise instead of by the documented chain.
 * Comparisons stay deterministic either way — this only makes them *sensible*.
 */
export const DEBT_EPSILON = 1e-9;

/** An excused member. Expressed as a debt so the preview can still show them. */
export const EXCUSED_DEBT = Number.POSITIVE_INFINITY;

export function computeDebt(earned: number, committed: number, weight: number): number {
  if (!(weight > 0)) return EXCUSED_DEBT;
  return (earned + committed) / weight;
}

/** Blackouts are half-open: a window ending at 09:00 frees the 09:00 chore. */
export function isBlackedOut(blackouts: readonly BlackoutWindow[], at: Date): boolean {
  const t = at.getTime();
  return blackouts.some((b) => b.startsAt.getTime() <= t && t < b.endsAt.getTime());
}

/**
 * Eligibility (§5). A blackout **skips without forgiving**: the member keeps
 * their accrued debt, so they resurface at the top of the queue when they come
 * back rather than quietly getting a free week.
 */
export function ineligibleReason(
  candidate: Pick<RotationCandidate, 'active' | 'weight' | 'blackouts'>,
  at: Date,
): IneligibleReason | null {
  if (!candidate.active) return 'inactive';
  if (!(candidate.weight > 0)) return 'zero_weight';
  if (isBlackedOut(candidate.blackouts, at)) return 'blackout';
  return null;
}

/** Total order on ids. `localeCompare` is locale-dependent and is not used. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The tie-break chain of D5, in order:
 *
 * 1. lowest `debt` — the whole point of the strategy;
 * 2. longest time since their last assignment (NULL first: somebody who has
 *    never been assigned goes before somebody who was assigned in 2019);
 * 3. `position` ascending;
 * 4. `userId` ascending — the final, total tie-break.
 *
 * Step 4 is what makes the comparator a *total* order, and a total order is
 * what makes two runs over the same snapshot produce the same schedule.
 */
export function compareByDebt(
  a: Pick<RotationCandidate, 'userId' | 'position' | 'lastAssignedAt'> & { debt: number },
  b: Pick<RotationCandidate, 'userId' | 'position' | 'lastAssignedAt'> & { debt: number },
): number {
  if (Math.abs(a.debt - b.debt) > DEBT_EPSILON) return a.debt < b.debt ? -1 : 1;

  const aLast = a.lastAssignedAt?.getTime() ?? null;
  const bLast = b.lastAssignedAt?.getTime() ?? null;
  if (aLast !== bLast) {
    if (aLast === null) return -1;
    if (bLast === null) return 1;
    return aLast < bLast ? -1 : 1;
  }

  if (a.position !== b.position) return a.position - b.position;
  return compareIds(a.userId, b.userId);
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/** Mutable per-run copy of a candidate. The snapshot itself is never touched. */
interface RunState {
  readonly userId: string;
  readonly weight: number;
  readonly position: number;
  readonly active: boolean;
  readonly earned: number;
  readonly blackouts: readonly BlackoutWindow[];
  committed: number;
  lastAssignedAt: Date | null;
}

function toRunState(candidate: RotationCandidate): RunState {
  return {
    userId: candidate.userId,
    weight: candidate.weight,
    position: candidate.position,
    active: candidate.active,
    earned: candidate.earned,
    blackouts: candidate.blackouts,
    committed: candidate.committed,
    lastAssignedAt: candidate.lastAssignedAt,
  };
}

/**
 * One materialization pass over a rotation.
 *
 * Built to be driven from the materializer's `decorate` seam, which is called
 * once per planned occurrence **in ascending key order**. Each {@link assign}
 * folds its own result back into the running state, so the debt a member
 * carries into occurrence *n+1* already includes what they were given at *n*.
 * Without that, a single pass would hand one person the entire next month.
 *
 * The class is stateful but still pure: it performs no I/O, and the sequence of
 * picks is a function of the snapshot plus the `(at, points)` arguments alone.
 */
export class RotationRun {
  private readonly strategy: RotationStrategy;
  private readonly states: RunState[];
  /** Members eligible to appear in a `round_robin` / `fixed` walk, ordered. */
  private readonly walk: RunState[];
  private cursorIndex: number;
  private readonly initialCursor: number;

  constructor(snapshot: RotationSnapshot) {
    this.strategy = snapshot.strategy;
    this.states = snapshot.members.map(toRunState);

    // The walk is ordered by (position, userId) and contains only members who
    // could ever be picked. Blackouts are *not* filtered here: they are
    // time-dependent, so they are checked per occurrence instead.
    this.walk = this.states
      .filter((s) => s.active && s.weight > 0)
      .sort((a, b) => (a.position !== b.position ? a.position - b.position : compareIds(a.userId, b.userId)));

    this.initialCursor = snapshot.cursor;
    this.cursorIndex = this.walk.length === 0 ? 0 : normalizeCursor(snapshot.cursor, this.walk.length);
  }

  /** The value to persist back onto `rotations.cursor` after the run. */
  get cursor(): number {
    return this.walk.length === 0 ? this.initialCursor : this.cursorIndex;
  }

  /** True once a pick has moved the round-robin cursor — saves a needless UPDATE. */
  get cursorMoved(): boolean {
    return this.cursor !== this.initialCursor;
  }

  /**
   * Pick the assignee for one occurrence.
   *
   * @param at     the occurrence instant, used for blackout evaluation
   * @param points effective points of the occurrence, folded into `committed`
   */
  assign(at: Date, points: number): RotationPick {
    const pick = this.pickFor(at);
    if (pick.userId !== null) this.record(pick.userId, at, points);
    return pick;
  }

  /**
   * The roster as it stands right now, for the preview endpoint. Ordered by the
   * same comparator the picker uses, so the UI can show "you are third in line"
   * without re-deriving anything.
   */
  standings(at: Date): RotationStanding[] {
    return this.states
      .map((s) => {
        const reason = ineligibleReason(s, at);
        return {
          userId: s.userId,
          weight: s.weight,
          earned: s.earned,
          committed: s.committed,
          debt: computeDebt(s.earned, s.committed, s.weight),
          eligible: reason === null,
          reason,
        };
      })
      .sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        const sa = this.states.find((s) => s.userId === a.userId);
        const sb = this.states.find((s) => s.userId === b.userId);
        if (sa === undefined || sb === undefined) return compareIds(a.userId, b.userId);
        return compareByDebt({ ...sa, debt: a.debt }, { ...sb, debt: b.debt });
      });
  }

  private record(userId: string, at: Date, points: number): void {
    const state = this.states.find((s) => s.userId === userId);
    if (state === undefined) return;
    state.committed += points;
    // The tie-break also has to move, or a rotation of zero-point chores would
    // give every occurrence to the same person: with no points, debt never
    // changes and "longest since last assignment" is the only thing separating
    // two members.
    if (state.lastAssignedAt === null || state.lastAssignedAt.getTime() < at.getTime()) {
      state.lastAssignedAt = at;
    }
  }

  private pickFor(at: Date): RotationPick {
    switch (this.strategy) {
      case 'anyone':
        // Materialize unassigned and let the first claimer take it
        // (`assigned_via = 'claimed'`, written by the tasks module).
        return unassigned('anyone_strategy');
      case 'fixed':
        return this.pickFixed(at);
      case 'round_robin':
        return this.pickRoundRobin(at);
      case 'weighted_balance':
        return this.pickWeighted(at);
    }
  }

  private pickWeighted(at: Date): RotationPick {
    const eligible = this.states.filter((s) => ineligibleReason(s, at) === null);
    if (eligible.length === 0) return unassigned(this.emptyReason());

    let best = eligible[0] as RunState;
    let bestDebt = computeDebt(best.earned, best.committed, best.weight);
    for (const candidate of eligible.slice(1)) {
      const debt = computeDebt(candidate.earned, candidate.committed, candidate.weight);
      if (compareByDebt({ ...candidate, debt }, { ...best, debt: bestDebt }) < 0) {
        best = candidate;
        bestDebt = debt;
      }
    }

    return { userId: best.userId, assignedVia: 'rotation', debt: bestDebt, unassignedReason: null };
  }

  /**
   * Strict order by `position`, walking forward from the cursor and skipping
   * anyone blacked out. The cursor advances past the member actually picked, so
   * a skipped member is next in line rather than losing their turn.
   */
  private pickRoundRobin(at: Date): RotationPick {
    if (this.walk.length === 0) return unassigned(this.emptyReason());

    for (let step = 0; step < this.walk.length; step += 1) {
      const index = (this.cursorIndex + step) % this.walk.length;
      const candidate = this.walk[index] as RunState;
      if (isBlackedOut(candidate.blackouts, at)) continue;
      this.cursorIndex = (index + 1) % this.walk.length;
      return {
        userId: candidate.userId,
        assignedVia: 'rotation',
        debt: computeDebt(candidate.earned, candidate.committed, candidate.weight),
        unassignedReason: null,
      };
    }

    return unassigned('no_eligible_member');
  }

  /**
   * Always the same person. When several members are active the lowest
   * `(position, userId)` wins, so the choice is still deterministic rather than
   * dependent on row order. A blackout leaves the occurrence unassigned — there
   * is nobody else by definition, and silently assigning somebody on holiday
   * would be worse than an empty slot an adult can see and fix.
   */
  private pickFixed(at: Date): RotationPick {
    const first = this.walk[0];
    if (first === undefined) return unassigned(this.emptyReason());
    if (isBlackedOut(first.blackouts, at)) return unassigned('no_eligible_member');
    return {
      userId: first.userId,
      assignedVia: 'rotation',
      debt: computeDebt(first.earned, first.committed, first.weight),
      unassignedReason: null,
    };
  }

  private emptyReason(): UnassignedReason {
    return this.states.length === 0 ? 'empty_rotation' : 'no_eligible_member';
  }
}

function unassigned(reason: UnassignedReason): RotationPick {
  return { userId: null, assignedVia: null, debt: null, unassignedReason: reason };
}

function normalizeCursor(cursor: number, length: number): number {
  if (!Number.isFinite(cursor) || length <= 0) return 0;
  const index = Math.trunc(cursor) % length;
  return index < 0 ? index + length : index;
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One-shot pick, for callers that assign a single occurrence (a manual
 * "rotate this one" or a `reassignFuture` sweep of one row).
 */
export function pickAssignee(
  snapshot: RotationSnapshot,
  at: Date,
  points = 0,
): RotationPick {
  return new RotationRun(snapshot).assign(at, points);
}

export interface PreviewStep {
  readonly at: Date;
  readonly pick: RotationPick;
  readonly standings: readonly RotationStanding[];
}

/**
 * Dry run of the next `count` picks — the auditable answer to "why did I get
 * the bins again?". Same code path as materialization, so what it shows is what
 * would actually happen.
 */
export function previewAssignments(
  snapshot: RotationSnapshot,
  options: { at: Date; count: number; points?: number; stepMs?: number },
): PreviewStep[] {
  const run = new RotationRun(snapshot);
  const points = options.points ?? 0;
  // Successive picks are spread a day apart so a blackout in the middle of the
  // preview window shows up where the family expects to see it.
  const step = options.stepMs ?? 86_400_000;

  const steps: PreviewStep[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const at = new Date(options.at.getTime() + i * step);
    const standings = run.standings(at);
    steps.push({ at, pick: run.assign(at, points), standings });
  }
  return steps;
}
