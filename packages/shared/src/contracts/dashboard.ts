import { z } from 'zod';

import {
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  minorUnitsSchema,
  timeZoneSchema,
} from './common.js';
import { digestSectionSchema } from './notifications.js';

/**
 * Dashboard & digest contracts — the «Сегодня» screen and the weekly summary.
 *
 * ## Why this module exists at all
 *
 * Family apps do not die from missing features; they die when an adult stops
 * opening the app because they never know whether anything changed. Two things
 * fix that: a screen that answers "what do I need to know right now" in three
 * seconds, and one recurring notification a week that a family will not switch
 * off. Everything in this file serves one of those two jobs.
 *
 * ## Permission-gated sections are `null`, never omitted and never empty
 *
 * A child has **zero** `goal:*` permissions (D4), so a child's payload carries
 * `goals: null` — not `goals: { … }` with zeroed amounts, which would still leak
 * "the family is saving for something" and would tempt a client into rendering
 * an empty finance widget. `null` means "not for you"; an empty array or a
 * zeroed section means "for you, and there is nothing in it". The distinction is
 * load-bearing for the frontend, which shows a widget for the second case and
 * nothing at all for the first.
 *
 * The same rule applies to `fairness` (needs `task:read:any`) and
 * `pendingApprovals` (needs `member:approve`).
 *
 * ## Time
 *
 * Every instant on the wire is a UTC ISO-8601 string (D2). Every *date* is a
 * local calendar date **in the timezone echoed back as `timezone`** — which is
 * the caller's `users.timezone`, falling back to `family_settings.timezone`,
 * and never the server's. `today` is therefore whatever "today" means to the
 * person holding the phone, including when they are travelling.
 */

/* -------------------------------------------------------------------------- */
/* Building blocks                                                             */
/* -------------------------------------------------------------------------- */

/** A task occurrence as the dashboard renders it. */
export const dashboardTaskSchema = z.object({
  id: idSchema,
  seriesId: idSchema,
  title: z.string(),
  /** UTC instant of the deadline. */
  dueAt: isoDateTimeSchema,
  /** Local calendar date of the deadline, in `timezone`. */
  dueDate: isoDateSchema,
  /** `HH:mm` local. `null` for an all-day / end-of-day task. */
  dueTime: z.string().nullable(),
  category: z.string().nullable(),
  assigneeId: idSchema.nullable(),
  /** Derived from the clock, never stored (see `docs/architecture/scheduling.md` §4). */
  isOverdue: z.boolean(),
  /** How late it is, in whole minutes. `0` when not overdue. */
  overdueByMinutes: z.number().int().min(0),
});
export type DashboardTask = z.infer<typeof dashboardTaskSchema>;

/** An event occurrence as the dashboard renders it. */
export const dashboardEventSchema = z.object({
  id: idSchema,
  seriesId: idSchema,
  title: z.string(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  /** Local calendar date of the start, in `timezone`. */
  date: isoDateSchema,
  /** `HH:mm` local. `null` when `isAllDay`. */
  time: z.string().nullable(),
  isAllDay: z.boolean(),
  location: z.string().nullable(),
  color: z.string().nullable(),
});
export type DashboardEvent = z.infer<typeof dashboardEventSchema>;

/** One line of the "надо купить срочно" tile. */
export const dashboardShoppingItemSchema = z.object({
  id: idSchema,
  listId: idSchema,
  listName: z.string(),
  name: z.string(),
  /** `numeric` round-trips as a string; never widen it to a float. */
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  requestedById: idSchema,
});
export type DashboardShoppingItem = z.infer<typeof dashboardShoppingItemSchema>;

export const dashboardShoppingSchema = z.object({
  urgent: z.array(dashboardShoppingItemSchema),
  /** Everything still to buy across all live lists, urgent or not. */
  neededCount: z.number().int().min(0),
  urgentCount: z.number().int().min(0),
});
export type DashboardShopping = z.infer<typeof dashboardShoppingSchema>;

/**
 * The next thing the moneybox is reaching for.
 *
 * `milestoneId` is `null` when the goal has no unreached checkpoint left — the
 * goal's own target is then the milestone, which is what a family means by
 * "сколько осталось".
 */
export const dashboardMilestoneSchema = z.object({
  goalId: idSchema,
  goalTitle: z.string(),
  milestoneId: idSchema.nullable(),
  /** The milestone's title, or the goal's when there is no milestone left. */
  title: z.string(),
  targetAmount: minorUnitsSchema,
  savedAmount: minorUnitsSchema,
  remainingAmount: minorUnitsSchema,
  /**
   * `percentOf(savedAmount, targetAmount)` — the same uncapped value
   * `contracts/goals.ts` documents, floored at 0 and **not** capped at 100.
   *
   * It used to be `.max(100)` here and uncapped there, so an over-funded goal
   * read «112 %» on the goals screen and «100 %» on the home screen. Clamping
   * is now a rendering decision (`ringPercent`), not a wire contract.
   */
  progressPercent: z.number().int().min(0),
  currency: z.string(),
  deadline: isoDateSchema.nullable(),
});
export type DashboardMilestone = z.infer<typeof dashboardMilestoneSchema>;

/**
 * This week's split of the housework — deliberately **not** a leaderboard (D5).
 *
 * There are no points here and there never will be again: a number that follows
 * a person around and goes up when they do chores turns siblings into rivals.
 * `members` is ordered by display name, never by effort, and there is no rank,
 * no medal and no "лучший" field. `sharePercent` is a share of the family's
 * total for the week, so a member who did nothing reads as `0` rather than as
 * "last place". The frontend renders a neutral bar.
 */
export const dashboardLoadMemberSchema = z.object({
  userId: idSchema,
  displayName: z.string(),
  doneCount: z.number().int().min(0),
  /** `numeric(4,2)` as a decimal string — see `choreWeightSchema`. */
  weight: z.string(),
  /**
   * A share of the family's own weekly total, so it is bounded at 100 by
   * construction (`doneCount <= total`). The cap stays here because it is a
   * genuine invariant of a share, not a clamp hiding an over-funded value.
   */
  sharePercent: z.number().int().min(0).max(100),
});
export type DashboardLoadMember = z.infer<typeof dashboardLoadMemberSchema>;

export const dashboardFairnessSchema = z.object({
  /** Local dates of the window, inclusive start / exclusive end. */
  weekStart: isoDateSchema,
  weekEnd: isoDateSchema,
  me: dashboardLoadMemberSchema,
  /** Every active member, sorted by name. Never by effort. */
  members: z.array(dashboardLoadMemberSchema),
  /** A neutral Russian sentence. Never comparative, never a ranking. */
  note: z.string(),
});
export type DashboardFairness = z.infer<typeof dashboardFairnessSchema>;

export const dashboardPendingMemberSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  email: z.string().nullable(),
  requestedAt: isoDateTimeSchema,
});
export type DashboardPendingMember = z.infer<typeof dashboardPendingMemberSchema>;

/* -------------------------------------------------------------------------- */
/* GET /dashboard/today                                                        */
/* -------------------------------------------------------------------------- */

export const dashboardTasksSchema = z.object({
  /** Mine, due before the end of my local today. */
  dueToday: z.array(dashboardTaskSchema),
  /** Mine, still `scheduled` with the deadline (plus grace) already behind us. */
  overdue: z.array(dashboardTaskSchema),
  /** Mine, already completed today — the "you have done something" counter. */
  doneTodayCount: z.number().int().min(0),
});
export type DashboardTasks = z.infer<typeof dashboardTasksSchema>;

export const dashboardEventsSchema = z.object({
  today: z.array(dashboardEventSchema),
  tomorrow: z.array(dashboardEventSchema),
});
export type DashboardEvents = z.infer<typeof dashboardEventsSchema>;

export const todayResponseSchema = z.object({
  /** When the aggregate was computed, for a "обновлено N минут назад" label. */
  generatedAt: isoDateTimeSchema,
  /** The timezone every date below is expressed in. */
  timezone: timeZoneSchema,
  today: isoDateSchema,
  tomorrow: isoDateSchema,

  tasks: dashboardTasksSchema,
  events: dashboardEventsSchema,

  /** `null` when the caller lacks `shopping:read`. */
  shopping: dashboardShoppingSchema.nullable(),
  /** `null` when the caller lacks `goal:read` — every child, by design (D4). */
  goals: z.object({ nearestMilestone: dashboardMilestoneSchema.nullable() }).nullable(),

  unreadNotifications: z.number().int().min(0),

  /** `null` when the caller cannot read the family's tasks. */
  fairness: dashboardFairnessSchema.nullable(),
  /** `null` unless the caller holds `member:approve`. Empty array = nobody waiting. */
  pendingApprovals: z.array(dashboardPendingMemberSchema).nullable(),
});
export type TodayResponse = z.infer<typeof todayResponseSchema>;

/* -------------------------------------------------------------------------- */
/* GET /dashboard/week                                                         */
/* -------------------------------------------------------------------------- */

export const dashboardWeekDaySchema = z.object({
  date: isoDateSchema,
  /** 0 = Sunday … 6 = Saturday, matching `digest_subscriptions.weekday`. */
  weekday: z.number().int().min(0).max(6),
  isToday: z.boolean(),
  tasks: z.array(dashboardTaskSchema),
  events: z.array(dashboardEventSchema),
});
export type DashboardWeekDay = z.infer<typeof dashboardWeekDaySchema>;

export const weekResponseSchema = z.object({
  generatedAt: isoDateTimeSchema,
  timezone: timeZoneSchema,
  weekStart: isoDateSchema,
  /** Exclusive: the day after the last day in `days`. */
  weekEnd: isoDateSchema,
  days: z.array(dashboardWeekDaySchema),
  totals: z.object({
    tasks: z.number().int().min(0),
    events: z.number().int().min(0),
    overdue: z.number().int().min(0),
  }),
});
export type WeekResponse = z.infer<typeof weekResponseSchema>;

export const weekQuerySchema = z.object({
  /** Local date to anchor the window on. Defaults to the caller's today. */
  from: isoDateSchema.optional(),
  days: z.coerce.number().int().min(1).max(31).default(7),
});
export type WeekQuery = z.infer<typeof weekQuerySchema>;

/* -------------------------------------------------------------------------- */
/* POST /dashboard/digest/preview                                              */
/* -------------------------------------------------------------------------- */

/**
 * One rendered block of the digest.
 *
 * An empty section is **not** dropped and **not** rendered as a bare heading
 * with nothing under it. It carries `isEmpty: true` and exactly one friendly
 * Russian line ("Задач на неделю не запланировано — можно выдохнуть."), which
 * the text renderer prints without the heading. A digest that is mostly
 * headings over whitespace reads as broken, and a broken digest gets switched
 * off — which is the one outcome this whole module exists to prevent.
 */
export const digestBlockSchema = z.object({
  section: digestSectionSchema,
  heading: z.string(),
  lines: z.array(z.string()),
  isEmpty: z.boolean(),
});
export type DigestBlock = z.infer<typeof digestBlockSchema>;

export const digestPreviewResponseSchema = z.object({
  /** ISO week identity, e.g. `2026-W34`. Also the dedupe key's week component. */
  weekKey: z.string(),
  title: z.string(),
  /** The one-liner: «На неделе: 3 дня рождения, техосмотр, дежурство — Паша». */
  summary: z.string(),
  blocks: z.array(digestBlockSchema),
  /** The whole digest as plain text — what the Telegram channel sends. */
  text: z.string(),
  generatedAt: isoDateTimeSchema,
  timezone: timeZoneSchema,
  /** Local dates of the covered window, inclusive start / exclusive end. */
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
});
export type DigestPreviewResponse = z.infer<typeof digestPreviewResponseSchema>;

export const digestPreviewRequestSchema = z.object({
  /** Override the subscription's sections, for the settings-screen preview. */
  sections: z.array(digestSectionSchema).min(1).optional(),
});
export type DigestPreviewRequest = z.infer<typeof digestPreviewRequestSchema>;
