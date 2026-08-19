import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import type {
  DashboardEvent,
  DashboardFairness,
  DashboardLoadMember,
  DashboardMilestone,
  DashboardPendingMember,
  DashboardShoppingItem,
  DashboardTask,
  DashboardWeekDay,
  TodayResponse,
  WeekQuery,
  WeekResponse,
} from '@family/shared/contracts/dashboard';
import type { Permission, Role } from '@family/shared';

import type { Executor } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { eventOccurrences, eventSeries } from '../events/events.schema.js';
import { pointsLedger } from '../chores/chores.schema.js';
import { goalMilestones, goalTransactions, savingsGoals } from '../goals/goals.schema.js';
import { familySettings } from '../identity/identity.schema.js';
import { users } from '../identity/users.schema.js';
import { notificationDeliveries } from '../notifications/notifications.schema.js';
import { shoppingItems, shoppingLists } from '../shopping/shopping.schema.js';
import { taskOccurrences, taskSeries } from '../tasks/tasks.schema.js';

/**
 * The «Сегодня» aggregate.
 *
 * ## Why this endpoint is shaped the way it is
 *
 * `GET /dashboard/today` is hit on **every app open**, including every iOS cold
 * start, and it is the first thing a family member sees. If it is slow or if it
 * lies about what day it is, the app feels broken and they stop opening it.
 * Two consequences run through this whole file:
 *
 * 1. **One bounded set of queries, not a fan-out per widget.** The number of
 *    round trips is a small constant — at most eight — and it does not grow
 *    with the family, the number of lists, or the number of goals. Every query
 *    is issued concurrently through {@link DashboardPort} and a section the
 *    caller may not see issues **no query at all**, so a child's payload costs
 *    strictly less than an adult's rather than being filtered after the fact.
 * 2. **"Today" is the caller's today.** Every boundary is computed from
 *    `users.timezone` (falling back to `family_settings.timezone`) with
 *    `Temporal`, never from the server's clock and never from a stored
 *    `local_date` column — that column is denormalized in the *series*
 *    timezone, which is not necessarily the reader's. A parent in Berlin must
 *    see Berlin's today.
 *
 * ## Cross-module reads (D8)
 *
 * This module aggregates domains it does not own. It therefore **never imports
 * another module's repository**. Reads go through {@link DashboardPort}, a
 * narrow interface owned by this module; {@link createDashboardPort} is the
 * Postgres implementation, written against the other modules' *schema* tables
 * (which are shared through `src/db/schema.ts`) because no cross-module service
 * exposes these shapes yet. When the owning services land, swap the port
 * implementation — nothing above it changes. The service methods this module
 * would rather call are listed in the handover notes.
 *
 * ## Permissions
 *
 * A section the caller may not read is `null`, not an empty object (D4). A
 * child has zero `goal:*` permissions, so a child's payload carries no goal
 * title, no target and no amount — there is nothing to filter out downstream
 * because nothing was ever fetched.
 */

/* -------------------------------------------------------------------------- */
/* Actor                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the aggregate needs to know about the caller.
 *
 * Structurally satisfied by `AuthContext`, but declared narrowly so the
 * assembly functions below can be unit-tested with a plain object and no
 * Fastify, no JWT and no database.
 */
export interface DashboardActor {
  readonly userId: string;
  readonly displayName: string;
  /** `users.timezone`. `null` => inherit the family default. */
  readonly timezone: string | null;
  can(permission: Permission): boolean;
}

/* -------------------------------------------------------------------------- */
/* Temporal helpers — the timezone rules live here and nowhere else            */
/* -------------------------------------------------------------------------- */

type TemporalApi = NonNullable<typeof globalThis.Temporal>;

function temporal(): TemporalApi {
  const api = globalThis.Temporal;
  if (!api) {
    throw new Error('Temporal is not available — call installTemporal() from core/temporal.js');
  }
  return api;
}

/**
 * The caller's timezone, or the family's, or Moscow.
 *
 * The last fallback exists only so a malformed row cannot 500 the home screen;
 * `family_settings.timezone` is `NOT NULL DEFAULT 'Europe/Moscow'`, so it is
 * unreachable in practice.
 */
export function resolveTimezone(
  userTimezone: string | null | undefined,
  familyTimezone: string | null | undefined,
): string {
  const candidate = userTimezone?.trim() ?? '';
  if (candidate) return candidate;
  const family = familyTimezone?.trim() ?? '';
  return family || 'Europe/Moscow';
}

function zoned(at: Date, timezone: string) {
  return temporal().Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timezone);
}

/** `2026-08-19` — the local calendar date of an instant, in `timezone`. */
export function localDateOf(at: Date, timezone: string): string {
  return zoned(at, timezone).toPlainDate().toString();
}

/** `09:30` — the local wall time of an instant, in `timezone`. */
export function localTimeOf(at: Date, timezone: string): string {
  const zdt = zoned(at, timezone);
  return `${String(zdt.hour).padStart(2, '0')}:${String(zdt.minute).padStart(2, '0')}`;
}

/** UTC instant of local midnight starting `date` (`YYYY-MM-DD`) in `timezone`. */
export function startOfLocalDay(date: string, timezone: string): Date {
  const plain = temporal().PlainDate.from(date);
  // `startOfDay` is DST-correct: on a spring-forward day in a zone that skips
  // midnight, local "00:00" does not exist and this returns 01:00 instead of
  // throwing or silently landing on the previous day.
  return new Date(plain.toZonedDateTime(timezone).startOfDay().epochMilliseconds);
}

/** `2026-08-19` + 1 day, staying on the calendar rather than adding 86 400 s. */
export function addLocalDays(date: string, days: number): string {
  return temporal().PlainDate.from(date).add({ days }).toString();
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a local date. */
export function isoWeekdayOf(date: string): number {
  return temporal().PlainDate.from(date).dayOfWeek;
}

/** 0 = Sunday … 6 = Saturday — the convention used by `digest_subscriptions`. */
export function dbWeekdayOf(date: string): number {
  return isoWeekdayOf(date) % 7;
}

/**
 * The local date the caller's week starts on.
 *
 * `weekStartsOn` is `family_settings.weekStartsOn`, an **ISO** weekday number
 * (1 = Monday), which is why this is not a `% 7` of a JS `getDay()`.
 */
export function startOfLocalWeek(date: string, weekStartsOn: number): string {
  const start = ((weekStartsOn - 1) % 7) + 1;
  const offset = (isoWeekdayOf(date) - start + 7) % 7;
  return addLocalDays(date, -offset);
}

/** The three local-day boundaries the «Сегодня» screen is built from. */
export interface DayWindow {
  timezone: string;
  today: string;
  tomorrow: string;
  /** UTC instant of local today 00:00. */
  startOfToday: Date;
  /** UTC instant of local tomorrow 00:00 — exclusive end of today. */
  startOfTomorrow: Date;
  /** UTC instant of local day-after-tomorrow 00:00 — exclusive end of tomorrow. */
  endOfTomorrow: Date;
}

export function dayWindowFor(timezone: string, now: Date): DayWindow {
  const today = localDateOf(now, timezone);
  const tomorrow = addLocalDays(today, 1);
  return {
    timezone,
    today,
    tomorrow,
    startOfToday: startOfLocalDay(today, timezone),
    startOfTomorrow: startOfLocalDay(tomorrow, timezone),
    endOfTomorrow: startOfLocalDay(addLocalDays(today, 2), timezone),
  };
}

/** An arbitrary run of local days — the `/dashboard/week` and digest window. */
export interface RangeWindow {
  timezone: string;
  /** Inclusive first local date. */
  from: string;
  /** **Exclusive** last local date. */
  to: string;
  fromUtc: Date;
  toUtc: Date;
  days: string[];
}

export function rangeWindowFor(timezone: string, from: string, days: number): RangeWindow {
  const to = addLocalDays(from, days);
  return {
    timezone,
    from,
    to,
    fromUtc: startOfLocalDay(from, timezone),
    toUtc: startOfLocalDay(to, timezone),
    days: Array.from({ length: days }, (_, i) => addLocalDays(from, i)),
  };
}

/* -------------------------------------------------------------------------- */
/* Port — the only way this module reads another module's data                 */
/* -------------------------------------------------------------------------- */

export interface ViewerContext {
  userId: string;
  displayName: string;
  role: Role;
  userTimezone: string | null;
  familyTimezone: string;
  familyName: string;
  /** ISO weekday, 1 = Monday. */
  weekStartsOn: number;
  currency: string;
}

export interface MemberRow {
  id: string;
  displayName: string;
  email: string | null;
  role: Role;
  status: 'pending_approval' | 'active' | 'rejected' | 'suspended';
  /** `numeric(4,2)` as a decimal string — never a float (see `choreWeightSchema`). */
  choreWeight: string;
  /** `YYYY-MM-DD`, or `null`. */
  birthDate: string | null;
  createdAt: Date;
}

export interface TaskRow {
  id: string;
  seriesId: string;
  title: string;
  dueAt: Date;
  points: number;
  category: string | null;
  assigneeId: string | null;
  graceMinutes: number;
  status: 'scheduled' | 'done' | 'skipped' | 'cancelled';
  completedAt: Date | null;
}

export interface EventRow {
  id: string;
  seriesId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  isAllDay: boolean;
  location: string | null;
  color: string | null;
}

export interface ShoppingRow {
  id: string;
  listId: string;
  listName: string;
  name: string;
  quantity: string | null;
  unit: string | null;
  requestedById: string;
  isUrgent: boolean;
}

export interface ShoppingSnapshot {
  items: ShoppingRow[];
  neededCount: number;
  urgentCount: number;
}

/** One `(goal × unreached milestone)` pair. A goal with none yields one row. */
export interface GoalRow {
  goalId: string;
  goalTitle: string;
  currency: string;
  goalTarget: number;
  deadline: string | null;
  /** `SUM(delta)` — derived, never a stored column (D6). */
  saved: number;
  milestoneId: string | null;
  milestoneTitle: string | null;
  milestoneTarget: number | null;
  milestoneSortOrder: number;
}

export interface LoadRow {
  userId: string;
  doneCount: number;
  points: number;
}

/**
 * Everything the dashboard reads from domains it does not own.
 *
 * Deliberately narrow and row-shaped: no entity objects, no cursors, no
 * write methods. Implementations are trivially fakeable, which is what lets the
 * permission rules and the timezone maths be tested without Postgres.
 */
export interface DashboardPort {
  loadViewer(userId: string): Promise<ViewerContext | null>;
  loadMembers(): Promise<MemberRow[]>;
  /**
   * Tasks assigned to `userId` with a deadline in `[sinceUtc, untilUtc)` that
   * are still open, plus the ones completed since `doneSinceUtc`.
   */
  loadMyTasks(
    userId: string,
    range: { sinceUtc: Date; untilUtc: Date; doneSinceUtc: Date },
  ): Promise<TaskRow[]>;
  /** Every family task in the window, whoever it belongs to — the digest's duty roster. */
  loadFamilyTasks(range: { fromUtc: Date; toUtc: Date }): Promise<TaskRow[]>;
  /** Events overlapping the window that `userId` is allowed to see. */
  loadEvents(userId: string, range: { fromUtc: Date; toUtc: Date }): Promise<EventRow[]>;
  loadShopping(limit: number): Promise<ShoppingSnapshot>;
  loadGoals(userId: string, canSeeEveryGoal: boolean): Promise<GoalRow[]>;
  loadUnreadCount(userId: string): Promise<number>;
  loadLoad(range: { fromUtc: Date; toUtc: Date }): Promise<LoadRow[]>;
}

/* -------------------------------------------------------------------------- */
/* Postgres implementation                                                     */
/* -------------------------------------------------------------------------- */

/** `count(*)`/`sum()` come back from postgres.js as `int8` strings. */
function toInt(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

/**
 * How many overdue days back the aggregate looks.
 *
 * Unbounded "everything still open" would make the query grow forever with a
 * dead daily chore nobody archived. Thirty days is well past the point where a
 * task is actionable, and `autoCancelAfterDays` sweeps the rest.
 */
export const OVERDUE_LOOKBACK_DAYS = 30;

/** Hard caps so a pathological family cannot turn the home screen into a page. */
export const DASHBOARD_LIMITS = {
  tasks: 200,
  events: 200,
  shoppingItems: 12,
  goalRows: 200,
} as const;

export function createDashboardPort(exec: Executor): DashboardPort {
  return {
    async loadViewer(userId) {
      const [row] = await exec
        .select({
          userId: users.id,
          displayName: users.displayName,
          role: users.role,
          userTimezone: users.timezone,
          familyTimezone: familySettings.timezone,
          familyName: familySettings.familyName,
          weekStartsOn: familySettings.weekStartsOn,
          currency: familySettings.currency,
        })
        .from(users)
        // `family_settings` is a singleton (D1) — a cross join is the whole
        // "which row is the real one" logic this app needs.
        .leftJoin(familySettings, sql`true`)
        .where(eq(users.id, userId))
        .limit(1);

      if (!row) return null;
      return {
        userId: row.userId,
        displayName: row.displayName,
        role: row.role,
        userTimezone: row.userTimezone,
        familyTimezone: row.familyTimezone ?? 'Europe/Moscow',
        familyName: row.familyName ?? 'Семья',
        weekStartsOn: row.weekStartsOn ?? 1,
        currency: row.currency ?? 'RUB',
      };
    },

    async loadMembers() {
      const rows = await exec
        .select({
          id: users.id,
          displayName: users.displayName,
          email: users.email,
          role: users.role,
          status: users.status,
          choreWeight: users.choreWeight,
          birthDate: users.birthDate,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(inArray(users.status, ['active', 'pending_approval']))
        .orderBy(asc(users.sortOrder), asc(users.displayName));
      return rows;
    },

    async loadMyTasks(userId, range) {
      return exec
        .select({
          id: taskOccurrences.id,
          seriesId: taskOccurrences.seriesId,
          title: sql<string>`coalesce(${taskOccurrences.titleOverride}, ${taskSeries.title})`,
          dueAt: taskOccurrences.dueAt,
          points: sql<number>`coalesce(${taskOccurrences.pointsOverride}, ${taskSeries.points})`,
          category: taskSeries.category,
          assigneeId: taskOccurrences.assigneeId,
          graceMinutes: taskSeries.graceMinutes,
          status: taskOccurrences.status,
          completedAt: taskOccurrences.completedAt,
        })
        .from(taskOccurrences)
        .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId))
        .where(
          and(
            eq(taskOccurrences.assigneeId, userId),
            gte(taskOccurrences.dueAt, range.sinceUtc),
            lt(taskOccurrences.dueAt, range.untilUtc),
            or(
              eq(taskOccurrences.status, 'scheduled'),
              and(
                eq(taskOccurrences.status, 'done'),
                gte(taskOccurrences.completedAt, range.doneSinceUtc),
              ),
            ),
          ),
        )
        .orderBy(asc(taskOccurrences.dueAt))
        .limit(DASHBOARD_LIMITS.tasks);
    },

    async loadFamilyTasks(range) {
      return exec
        .select({
          id: taskOccurrences.id,
          seriesId: taskOccurrences.seriesId,
          title: sql<string>`coalesce(${taskOccurrences.titleOverride}, ${taskSeries.title})`,
          dueAt: taskOccurrences.dueAt,
          points: sql<number>`coalesce(${taskOccurrences.pointsOverride}, ${taskSeries.points})`,
          category: taskSeries.category,
          assigneeId: taskOccurrences.assigneeId,
          graceMinutes: taskSeries.graceMinutes,
          status: taskOccurrences.status,
          completedAt: taskOccurrences.completedAt,
        })
        .from(taskOccurrences)
        .innerJoin(taskSeries, eq(taskSeries.id, taskOccurrences.seriesId))
        .where(
          and(
            eq(taskOccurrences.status, 'scheduled'),
            gte(taskOccurrences.dueAt, range.fromUtc),
            lt(taskOccurrences.dueAt, range.toUtc),
            eq(taskSeries.visibility, 'household'),
          ),
        )
        .orderBy(asc(taskOccurrences.dueAt))
        .limit(DASHBOARD_LIMITS.tasks);
    },

    async loadEvents(userId, range) {
      return exec
        .select({
          id: eventOccurrences.id,
          seriesId: eventOccurrences.seriesId,
          title: sql<string>`coalesce(${eventOccurrences.titleOverride}, ${eventSeries.title})`,
          startsAt: eventOccurrences.startsAt,
          endsAt: eventOccurrences.endsAt,
          isAllDay: sql<boolean>`coalesce(${eventOccurrences.isAllDayOverride}, ${eventSeries.isAllDay})`,
          location: sql<
            string | null
          >`coalesce(${eventOccurrences.locationOverride}, ${eventSeries.location})`,
          color: eventSeries.color,
        })
        .from(eventOccurrences)
        .innerJoin(eventSeries, eq(eventSeries.id, eventOccurrences.seriesId))
        .where(
          and(
            ne(eventOccurrences.status, 'cancelled'),
            lt(eventOccurrences.startsAt, range.toUtc),
            gte(eventOccurrences.endsAt, range.fromUtc),
            // Visibility narrows *after* the permission check (D4): `household`
            // is the family calendar, `private` is the creator's, `restricted`
            // is the explicit attendee list.
            or(
              eq(eventSeries.visibility, 'household'),
              eq(eventSeries.createdById, userId),
              sql`exists (
                select 1 from event_attendees ea
                 where ea.occurrence_id = ${eventOccurrences.id}
                   and ea.user_id = ${userId}
              )`,
            ),
          ),
        )
        .orderBy(asc(eventOccurrences.startsAt))
        .limit(DASHBOARD_LIMITS.events);
    },

    async loadShopping(limit) {
      // The two window functions are evaluated over the whole matching set
      // *before* LIMIT, so one round trip yields both the tile and the totals.
      const rows = await exec
        .select({
          id: shoppingItems.id,
          listId: shoppingItems.listId,
          listName: shoppingLists.name,
          name: shoppingItems.name,
          quantity: shoppingItems.quantity,
          unit: shoppingItems.unit,
          requestedById: shoppingItems.requestedById,
          isUrgent: shoppingItems.isUrgent,
          neededCount: sql<string>`count(*) over ()`,
          urgentCount: sql<string>`count(*) filter (where ${shoppingItems.isUrgent}) over ()`,
        })
        .from(shoppingItems)
        .innerJoin(shoppingLists, eq(shoppingLists.id, shoppingItems.listId))
        .where(and(eq(shoppingItems.state, 'needed'), eq(shoppingLists.isArchived, false)))
        .orderBy(sql`${shoppingItems.isUrgent} desc, ${shoppingItems.createdAt} desc`)
        .limit(limit);

      const first = rows[0];
      return {
        items: rows.map((r) => ({
          id: r.id,
          listId: r.listId,
          listName: r.listName,
          name: r.name,
          quantity: r.quantity,
          unit: r.unit,
          requestedById: r.requestedById,
          isUrgent: r.isUrgent,
        })),
        neededCount: first ? toInt(first.neededCount) : 0,
        urgentCount: first ? toInt(first.urgentCount) : 0,
      };
    },

    async loadGoals(userId, canSeeEveryGoal) {
      const balance = exec
        .select({
          goalId: goalTransactions.goalId,
          amount: sql<string>`coalesce(sum(${goalTransactions.delta}), 0)`.as('amount'),
        })
        .from(goalTransactions)
        .groupBy(goalTransactions.goalId)
        .as('goal_balance');

      const visible = canSeeEveryGoal
        ? or(eq(savingsGoals.visibility, 'household'), eq(savingsGoals.visibility, 'private'))
        : or(eq(savingsGoals.visibility, 'household'), eq(savingsGoals.ownerId, userId));

      const rows = await exec
        .select({
          goalId: savingsGoals.id,
          goalTitle: savingsGoals.title,
          currency: savingsGoals.currency,
          goalTarget: savingsGoals.targetAmount,
          deadline: savingsGoals.deadline,
          saved: sql<string>`coalesce(${balance.amount}, '0')`,
          milestoneId: goalMilestones.id,
          milestoneTitle: goalMilestones.title,
          milestoneTarget: goalMilestones.targetAmount,
          milestoneSortOrder: goalMilestones.sortOrder,
        })
        .from(savingsGoals)
        .leftJoin(balance, eq(balance.goalId, savingsGoals.id))
        .leftJoin(
          goalMilestones,
          and(eq(goalMilestones.goalId, savingsGoals.id), isNull(goalMilestones.reachedAt)),
        )
        .where(and(isNull(savingsGoals.deletedAt), eq(savingsGoals.status, 'active'), visible))
        .limit(DASHBOARD_LIMITS.goalRows);

      return rows.map((r) => ({
        goalId: r.goalId,
        goalTitle: r.goalTitle,
        currency: r.currency,
        goalTarget: toInt(r.goalTarget),
        deadline: r.deadline,
        saved: toInt(r.saved),
        milestoneId: r.milestoneId,
        milestoneTitle: r.milestoneTitle,
        milestoneTarget: r.milestoneTarget === null ? null : toInt(r.milestoneTarget),
        milestoneSortOrder: r.milestoneSortOrder ?? 0,
      }));
    },

    async loadUnreadCount(userId) {
      const [row] = await exec
        .select({ n: sql<string>`count(*)` })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.userId, userId),
            eq(notificationDeliveries.channel, 'in_app'),
            isNull(notificationDeliveries.readAt),
          ),
        );
      return row ? toInt(row.n) : 0;
    },

    async loadLoad(range) {
      // `points_ledger` rather than `task_occurrences`: points accrue to
      // whoever actually did the chore, not whoever was assigned (D5), and the
      // ledger is the only place that distinction survives.
      const rows = await exec
        .select({
          userId: pointsLedger.userId,
          doneCount: sql<string>`count(*) filter (where ${pointsLedger.reason} = 'chore_completed')`,
          points: sql<string>`coalesce(sum(${pointsLedger.delta}), 0)`,
        })
        .from(pointsLedger)
        .where(
          and(gte(pointsLedger.createdAt, range.fromUtc), lt(pointsLedger.createdAt, range.toUtc)),
        )
        .groupBy(pointsLedger.userId);

      return rows.map((r) => ({
        userId: r.userId,
        doneCount: toInt(r.doneCount),
        points: toInt(r.points),
      }));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Pure mapping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Overdue is a function of the clock, never a stored flag
 * (`docs/architecture/scheduling.md` §4). `graceMinutes` is the series' slack
 * after the deadline before "late" means anything.
 */
export function overdueMinutes(row: TaskRow, now: Date): number {
  if (row.status !== 'scheduled') return 0;
  const deadline = row.dueAt.getTime() + row.graceMinutes * 60_000;
  const late = now.getTime() - deadline;
  return late > 0 ? Math.floor(late / 60_000) : 0;
}

export function toDashboardTask(row: TaskRow, timezone: string, now: Date): DashboardTask {
  const late = overdueMinutes(row, now);
  const time = localTimeOf(row.dueAt, timezone);
  return {
    id: row.id,
    seriesId: row.seriesId,
    title: row.title,
    dueAt: row.dueAt.toISOString(),
    dueDate: localDateOf(row.dueAt, timezone),
    // Midnight is how "к концу дня" materializes; showing "00:00" reads as a
    // real appointment time and is worse than showing nothing.
    dueTime: time === '00:00' ? null : time,
    points: row.points,
    category: row.category,
    assigneeId: row.assigneeId,
    isOverdue: late > 0,
    overdueByMinutes: late,
  };
}

export function toDashboardEvent(row: EventRow, timezone: string): DashboardEvent {
  return {
    id: row.id,
    seriesId: row.seriesId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    date: localDateOf(row.startsAt, timezone),
    time: row.isAllDay ? null : localTimeOf(row.startsAt, timezone),
    isAllDay: row.isAllDay,
    location: row.location,
    color: row.color,
  };
}

export function toShoppingItem(row: ShoppingRow): DashboardShoppingItem {
  return {
    id: row.id,
    listId: row.listId,
    listName: row.listName,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    requestedById: row.requestedById,
  };
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * The single next thing the moneybox is reaching for.
 *
 * Chooses by **smallest remaining amount**, so the milestone that is genuinely
 * within reach wins over a distant one; a goal with no unreached checkpoint
 * competes with its own target, which is what "сколько осталось" means to a
 * family. Ties break on goal id so the home screen does not flicker between two
 * equally close goals on consecutive loads.
 */
export function pickNearestMilestone(rows: readonly GoalRow[]): DashboardMilestone | null {
  let best: { row: GoalRow; target: number; remaining: number } | null = null;

  for (const row of rows) {
    const usesMilestone = row.milestoneId !== null && row.milestoneTarget !== null;
    const target = usesMilestone ? (row.milestoneTarget as number) : row.goalTarget;
    const remaining = target - row.saved;
    // An unreached milestone already covered by the balance is stale data the
    // goals service will close; it is not "the next thing" either way.
    if (remaining <= 0) continue;
    if (
      !best ||
      remaining < best.remaining ||
      (remaining === best.remaining && row.goalId < best.row.goalId)
    ) {
      best = { row, target, remaining };
    }
  }

  if (!best) return null;
  const { row, target, remaining } = best;
  return {
    goalId: row.goalId,
    goalTitle: row.goalTitle,
    milestoneId: row.milestoneId,
    title: row.milestoneTitle ?? row.goalTitle,
    targetAmount: target,
    savedAmount: row.saved,
    remainingAmount: remaining,
    progressPercent: percent(row.saved, target),
    currency: row.currency,
    deadline: row.deadline,
  };
}

/**
 * This week's load, as a neutral bar and never as a leaderboard (D5).
 *
 * Members are ordered **by display name**. There is no rank field, no "best",
 * no arrow. A sibling leaderboard is the fastest way to make a child hate a
 * family app, and the ordering is the part a well-meaning frontend would
 * otherwise get wrong.
 */
export function buildFairness(
  actor: { userId: string; displayName: string },
  members: readonly MemberRow[],
  load: readonly LoadRow[],
  window: { weekStart: string; weekEnd: string },
): DashboardFairness {
  const byUser = new Map(load.map((l) => [l.userId, l]));
  const active = members.filter((m) => m.status === 'active');
  const total = active.reduce((sum, m) => sum + (byUser.get(m.id)?.doneCount ?? 0), 0);

  const toMember = (m: MemberRow): DashboardLoadMember => {
    const row = byUser.get(m.id);
    return {
      userId: m.id,
      displayName: m.displayName,
      doneCount: row?.doneCount ?? 0,
      points: row?.points ?? 0,
      weight: m.choreWeight,
      sharePercent: percent(row?.doneCount ?? 0, total),
    };
  };

  const list = active
    .map(toMember)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));

  const mine = list.find((m) => m.userId === actor.userId) ?? {
    userId: actor.userId,
    displayName: actor.displayName,
    doneCount: 0,
    points: 0,
    weight: '1.00',
    sharePercent: 0,
  };

  return {
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    me: mine,
    members: list,
    // Deliberately free of comparatives and of any number that invites one.
    note:
      total === 0
        ? 'На этой неделе дел пока никто не закрывал — неделя только начинается.'
        : 'Общая нагрузка семьи за неделю. Это не соревнование и не рейтинг.',
  };
}

function toPendingMember(row: MemberRow): DashboardPendingMember {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    requestedAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

/** Everything the port fetched, before permissions and bucketing are applied. */
export interface TodayInputs {
  members: MemberRow[];
  tasks: TaskRow[];
  events: EventRow[];
  shopping: ShoppingSnapshot | null;
  goals: GoalRow[] | null;
  unreadNotifications: number;
  load: LoadRow[] | null;
}

/**
 * Which sections the caller is entitled to. Resolved once, then used both to
 * decide **which queries to issue** and how to shape the payload — so a denied
 * section is never fetched, not merely stripped afterwards.
 */
export interface TodayAccess {
  tasks: boolean;
  events: boolean;
  shopping: boolean;
  goals: boolean;
  /** Reading the *family's* load, not one's own. */
  fairness: boolean;
  approvals: boolean;
  /** Owner/admin see `private` goals as well as `household` ones. */
  everyGoal: boolean;
}

export function resolveAccess(actor: DashboardActor): TodayAccess {
  return {
    tasks: actor.can('task:read:own') || actor.can('task:read:any'),
    events: actor.can('event:read'),
    shopping: actor.can('shopping:read'),
    // Children hold zero `goal:*` permissions by design (D4) — no target, no
    // balance, no goal title ever reaches them through this aggregate.
    goals: actor.can('goal:read'),
    // Seeing what everyone else did requires reading everyone else's tasks.
    // A child sees only their own load, so they get no family bar at all.
    fairness: actor.can('task:read:any'),
    approvals: actor.can('member:approve'),
    everyGoal: actor.can('goal:delete'),
  };
}

/**
 * Pure assembly: rows in, response out. No clock of its own, no database, no
 * Fastify — which is what makes the permission and timezone rules testable.
 */
export function assembleToday(
  actor: DashboardActor,
  access: TodayAccess,
  window: DayWindow,
  weekStartDate: string,
  inputs: TodayInputs,
  now: Date,
): TodayResponse {
  const tz = window.timezone;
  const startOfToday = window.startOfToday.getTime();
  const startOfTomorrow = window.startOfTomorrow.getTime();

  const dueToday: DashboardTask[] = [];
  const overdue: DashboardTask[] = [];
  let doneTodayCount = 0;

  for (const row of inputs.tasks) {
    if (row.status === 'done') {
      if (row.completedAt && row.completedAt.getTime() >= startOfToday) doneTodayCount += 1;
      continue;
    }
    if (row.status !== 'scheduled') continue;
    const task = toDashboardTask(row, tz, now);
    // "Overdue" wins over "due today": a task that was due at 09:00 and is now
    // late belongs in the red list, not in both.
    if (task.isOverdue) overdue.push(task);
    else if (row.dueAt.getTime() < startOfTomorrow) dueToday.push(task);
  }

  const eventsToday: DashboardEvent[] = [];
  const eventsTomorrow: DashboardEvent[] = [];
  for (const row of inputs.events) {
    const event = toDashboardEvent(row, tz);
    if (event.date === window.today) eventsToday.push(event);
    else if (event.date === window.tomorrow) eventsTomorrow.push(event);
    // An event that started yesterday and runs past midnight is shown on the
    // day it starts, which is where the family looks for it.
    else if (row.startsAt.getTime() < startOfToday && row.endsAt.getTime() >= startOfToday) {
      eventsToday.push(event);
    }
  }

  const pending = access.approvals
    ? inputs.members.filter((m) => m.status === 'pending_approval').map(toPendingMember)
    : null;

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    today: window.today,
    tomorrow: window.tomorrow,
    tasks: { dueToday, overdue, doneTodayCount },
    events: { today: eventsToday, tomorrow: eventsTomorrow },
    shopping: inputs.shopping
      ? {
          urgent: inputs.shopping.items.filter((i) => i.isUrgent).map(toShoppingItem),
          neededCount: inputs.shopping.neededCount,
          urgentCount: inputs.shopping.urgentCount,
        }
      : null,
    goals: inputs.goals ? { nearestMilestone: pickNearestMilestone(inputs.goals) } : null,
    unreadNotifications: inputs.unreadNotifications,
    fairness: inputs.load
      ? buildFairness(actor, inputs.members, inputs.load, {
          weekStart: weekStartDate,
          weekEnd: addLocalDays(weekStartDate, 7),
        })
      : null,
    pendingApprovals: pending,
  };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The «Сегодня» aggregate for one caller.
 *
 * Every query is issued concurrently and only for a section the caller may
 * read, so the round-trip count is a small constant that *shrinks* with reduced
 * permissions rather than growing with the family.
 */
export async function getToday(
  port: DashboardPort,
  actor: DashboardActor,
  now: Date = new Date(),
): Promise<TodayResponse> {
  const viewer = await port.loadViewer(actor.userId);
  if (!viewer) throw notFound('User');

  const timezone = resolveTimezone(actor.timezone ?? viewer.userTimezone, viewer.familyTimezone);
  const window = dayWindowFor(timezone, now);
  const access = resolveAccess(actor);

  const weekStart = startOfLocalWeek(window.today, viewer.weekStartsOn);
  const weekRange = {
    fromUtc: startOfLocalDay(weekStart, timezone),
    toUtc: startOfLocalDay(addLocalDays(weekStart, 7), timezone),
  };

  const [members, tasks, events, shopping, goals, unreadNotifications, load] = await Promise.all([
    port.loadMembers(),
    access.tasks
      ? port.loadMyTasks(actor.userId, {
          sinceUtc: startOfLocalDay(addLocalDays(window.today, -OVERDUE_LOOKBACK_DAYS), timezone),
          untilUtc: window.startOfTomorrow,
          doneSinceUtc: window.startOfToday,
        })
      : Promise.resolve<TaskRow[]>([]),
    access.events
      ? port.loadEvents(actor.userId, {
          fromUtc: window.startOfToday,
          toUtc: window.endOfTomorrow,
        })
      : Promise.resolve<EventRow[]>([]),
    access.shopping
      ? port.loadShopping(DASHBOARD_LIMITS.shoppingItems)
      : Promise.resolve<ShoppingSnapshot | null>(null),
    access.goals
      ? port.loadGoals(actor.userId, access.everyGoal)
      : Promise.resolve<GoalRow[] | null>(null),
    port.loadUnreadCount(actor.userId),
    access.fairness ? port.loadLoad(weekRange) : Promise.resolve<LoadRow[] | null>(null),
  ]);

  return assembleToday(
    actor,
    access,
    window,
    weekStart,
    { members, tasks, events, shopping, goals, unreadNotifications, load },
    now,
  );
}

/** Buckets a flat list of tasks/events into local days. Pure. */
export function assembleWeek(
  window: RangeWindow,
  today: string,
  tasks: readonly TaskRow[],
  events: readonly EventRow[],
  now: Date,
): WeekResponse {
  const byDate = new Map<string, DashboardWeekDay>();
  for (const date of window.days) {
    byDate.set(date, {
      date,
      weekday: dbWeekdayOf(date),
      isToday: date === today,
      tasks: [],
      events: [],
    });
  }

  let overdue = 0;
  for (const row of tasks) {
    const task = toDashboardTask(row, window.timezone, now);
    if (task.isOverdue) overdue += 1;
    byDate.get(task.dueDate)?.tasks.push(task);
  }
  for (const row of events) {
    const event = toDashboardEvent(row, window.timezone);
    byDate.get(event.date)?.events.push(event);
  }

  const days = window.days.map((d) => byDate.get(d)).filter((d): d is DashboardWeekDay => !!d);
  return {
    generatedAt: now.toISOString(),
    timezone: window.timezone,
    weekStart: window.from,
    weekEnd: window.to,
    days,
    totals: {
      tasks: days.reduce((n, d) => n + d.tasks.length, 0),
      events: days.reduce((n, d) => n + d.events.length, 0),
      overdue,
    },
  };
}

/** The «Неделя» view — the same data, bucketed by local day. */
export async function getWeek(
  port: DashboardPort,
  actor: DashboardActor,
  query: WeekQuery,
  now: Date = new Date(),
): Promise<WeekResponse> {
  const viewer = await port.loadViewer(actor.userId);
  if (!viewer) throw notFound('User');

  const timezone = resolveTimezone(actor.timezone ?? viewer.userTimezone, viewer.familyTimezone);
  const today = localDateOf(now, timezone);
  const window = rangeWindowFor(timezone, query.from ?? today, query.days);
  const access = resolveAccess(actor);

  const [tasks, events] = await Promise.all([
    access.tasks
      ? port.loadMyTasks(actor.userId, {
          sinceUtc: window.fromUtc,
          untilUtc: window.toUtc,
          doneSinceUtc: window.toUtc,
        })
      : Promise.resolve<TaskRow[]>([]),
    access.events
      ? port.loadEvents(actor.userId, { fromUtc: window.fromUtc, toUtc: window.toUtc })
      : Promise.resolve<EventRow[]>([]),
  ]);

  return assembleWeek(window, today, tasks, events, now);
}
