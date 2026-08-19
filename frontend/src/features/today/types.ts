import type {
  EventOccurrenceResponse,
  ShoppingItemResponse,
  TaskOccurrenceResponse,
} from '@family/shared';

/**
 * TODO(contract): the canonical schemas belong in
 * `packages/shared/src/contracts/dashboard.ts`, owned by the dashboard backend
 * agent. That file does not exist yet, so the shapes this screen consumes are
 * declared here and must be deleted the moment the contract lands — the names
 * below are chosen to match one-for-one so the swap is a mechanical
 * `import type { ... } from '@family/shared'`.
 *
 * Design notes for whoever writes the real contract:
 *
 *  - The per-entity payloads are **not** redeclared. `tasks.*`, `events.*` and
 *    `shopping.urgent` reuse the existing `taskOccurrenceResponseSchema`,
 *    `eventOccurrenceResponseSchema` and `shoppingItemResponseSchema`, so the
 *    dashboard is an aggregation, not a parallel universe with its own drift.
 *  - The `tasks` and `events` sub-objects are structurally the existing
 *    `taskTodayResponseSchema` / `eventTodayResponseSchema` minus their
 *    duplicated `date` / `timezone`, which the envelope already carries.
 *  - Every permission-gated section is **nullable**: the server omits (nulls)
 *    what the caller may not read, and the client independently hides it with
 *    `useCan()`. Two locks on one door is deliberate — a child must never see a
 *    finance widget even if the backend regresses (D4).
 *  - Money is integer minor units everywhere (D6).
 */

/* -------------------------------------------------------------------------- */
/* GET /api/dashboard/today                                                    */
/* -------------------------------------------------------------------------- */

export interface TodayTasksSection {
  /** Scheduled, assigned to me, due today. Sorted by `dueAt`. */
  mine: TaskOccurrenceResponse[];
  /** `isOverdue === true`, within my read scope. Oldest first. */
  overdue: TaskOccurrenceResponse[];
  /** Today's unclaimed chores — anyone may take them. */
  unassigned: TaskOccurrenceResponse[];
  /** Chores the family finished today. The "мы молодцы" number. */
  familyDoneToday: number;
}

export interface TodayEventsSection {
  today: EventOccurrenceResponse[];
  tomorrow: EventOccurrenceResponse[];
}

export interface TodayShoppingSection {
  /** `isUrgent && state === 'pending'`. */
  urgent: ShoppingItemResponse[];
  /** Every still-pending item, urgent or not. */
  pendingCount: number;
  /** Where the urgent items live, so the card can deep-link. */
  listId: string | null;
}

/**
 * The next checkpoint on the family's savings — a milestone when the goal has
 * them, otherwise the goal's own target. One goal, not a list: the home screen
 * answers "how close are we", the Копилки screen answers "to what".
 */
export interface TodayGoalSection {
  goalId: string;
  goalTitle: string;
  /** ISO-4217, from the goal (not from the family default). */
  currency: string;
  /** `null` when the goal has no milestones and the target itself is the mark. */
  milestoneId: string | null;
  milestoneTitle: string | null;
  /** Absolute threshold, integer minor units. */
  targetAmount: number;
  /** `SUM(delta)`, integer minor units. */
  currentAmount: number;
  /** `max(0, target - current)`, integer minor units. */
  remainingAmount: number;
  /** Server-computed so every surface agrees. Not capped at 100. */
  progressPercent: number;
  deadline: string | null;
}

export interface TodayPendingMember {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** When the signup arrived — the sort key of the queue. */
  createdAt: string;
}

export interface TodayApprovalsSection {
  pendingCount: number;
  /** Capped server-side (the card shows at most three faces). */
  members: TodayPendingMember[];
}

export interface DashboardTodayResponse {
  /** Local calendar date in the family timezone, `YYYY-MM-DD`. */
  date: string;
  /** IANA id the dates above were resolved in. */
  timezone: string;

  tasks: TodayTasksSection | null;
  events: TodayEventsSection | null;
  shopping: TodayShoppingSection | null;
  goal: TodayGoalSection | null;
  approvals: TodayApprovalsSection | null;
}

/* -------------------------------------------------------------------------- */
/* GET /api/dashboard/week                                                     */
/* -------------------------------------------------------------------------- */

/**
 * My own slice of the week, a subset of `fairnessMemberSchema`.
 *
 * D5: this is rendered as a neutral bar against my *own* fair share. There is
 * deliberately no rank, no other member's numbers and no leaderboard.
 */
export interface WeeklyLoad {
  userId: string;
  /** Chores I completed in the window. */
  completed: number;
  /** Chores still scheduled to me in the window. */
  committed: number;
  /** Points earned in the window. */
  earned: number;
  /** My share of the family's week, 0..1. */
  actualShare: number;
  /** My weight-derived expected share, 0..1. */
  fairShare: number;
}

export interface DashboardWeekResponse {
  /** Local dates, inclusive. The week starts on Monday (D7 / `WEEK_STARTS_ON`). */
  from: string;
  to: string;
  timezone: string;
  /** `null` when the caller is not in any rotation. */
  load: WeeklyLoad | null;
  /** Chores assigned across the whole family in the window — the denominator. */
  familyTotal: number;
}
