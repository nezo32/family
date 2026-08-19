import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import {
  DEFAULT_DIGEST_SECTIONS,
  DIGEST_SECTION_LABELS_RU,
  DIGEST_SECTIONS,
  effectivePermissions,
  PERMISSIONS,
  type DigestSection,
  type Permission,
  type Role,
} from '@family/shared';
import type { DigestBlock, DigestPreviewResponse } from '@family/shared/contracts/dashboard';

import type { Executor } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { kudos } from '../chores/chores.schema.js';
import { goalTransactions } from '../goals/goals.schema.js';
import { users } from '../identity/users.schema.js';
import { digestSubscriptions } from '../notifications/notifications.schema.js';
import * as notifications from '../notifications/notifications.service.js';
import { posts } from '../wall/wall.schema.js';
import {
  addLocalDays,
  createDashboardPort,
  isoWeekdayOf,
  localDateOf,
  localTimeOf,
  pickNearestMilestone,
  resolveAccess,
  resolveTimezone,
  startOfLocalDay,
  startOfLocalWeek,
  type DashboardActor,
  type DashboardPort,
  type EventRow,
  type GoalRow,
  type LoadRow,
  type MemberRow,
  type ShoppingSnapshot,
  type TaskRow,
  type TodayAccess,
  type ViewerContext,
} from './dashboard.service.js';

/**
 * The weekly digest.
 *
 * ## Why this is the most important notification in the product
 *
 * It is the **one recurring message a family will not switch off**, because it
 * is the only one that answers "what is coming" instead of "react to this now".
 * Every rule below protects that: it is composed in correct Russian (a digest
 * that says «3 задача» reads as broken software and gets muted), it degrades to
 * a friendly sentence instead of an empty heading, and it can physically not be
 * sent twice for the same week.
 *
 * ## Idempotency — three independent guards
 *
 * 1. `digest_subscriptions.last_sent_at`, advanced by a **conditional** update,
 *    is the cheap pre-filter that keeps the hourly job from doing any work.
 * 2. The intent's `dedupe_key` is `weekly_digest:<userId>:<isoWeekKey>` and the
 *    partial unique index on it is the real guarantee: two workers racing, a
 *    replayed BullMQ job or a redeploy mid-sweep all collapse to one row.
 * 3. The BullMQ `jobId` on the dispatch enqueue collapses duplicate jobs.
 *
 * The emit happens **before** the `last_sent_at` stamp on purpose. A crash
 * between the two costs nothing — the next hourly tick re-emits, loses the
 * dedupe race, and stamps. The reverse order would silently lose a week's
 * digest whenever Redis hiccuped.
 *
 * ## Time
 *
 * `weekday` + `timeOfDay` are floating local wall clock in the *subscriber's*
 * timezone (D2). The job runs hourly in UTC and each subscriber is bucketed
 * into their own zone, so a family spread across Moscow and Berlin each get
 * their Sunday 19:00, not somebody else's.
 */

/* ========================================================================== */
/* Russian language primitives                                                */
/* ========================================================================== */

/** U+00A0. Russian typography groups digits with it, and never with a comma. */
export const NBSP = String.fromCharCode(0x00a0);

/**
 * Russian numeric agreement — one implementation, in `@family/shared`.
 *
 * The rule and the word table both used to live here, and were the *best* of
 * the six copies in the repo: the only one modelling grammatical case
 * («21 задача на неделе» vs «вы закрыли 21 задачу»). So this form won and moved
 * to `@family/shared/domain/plural.ts`; the whole app reads it now.
 *
 * One behaviour changed here as a result: `countRu` formats the count with
 * `Intl.NumberFormat('ru-RU')` like the UI always did, so a four-figure count
 * reads «1 011 задач» in the digest instead of «1011 задач». The digest and the
 * screen it summarises no longer print the same number two ways.
 *
 * The key formerly called `RU_PLURALS.goal` here — «копилка» — is now
 * `RU_PLURALS.moneybox`, because `goal` in the shared table is the abstract
 * «цель» the goals screen uses for its headings. Same words, unambiguous names.
 */
import { countRu, formatCountRu, pluralRu, RU_PLURALS } from '@family/shared';
import type { PluralForms } from '@family/shared';

export { countRu, formatCountRu, pluralRu, RU_PLURALS };
export type { PluralForms };

/** Nominative weekday names, indexed by ISO weekday (1 = Monday). */
export const WEEKDAY_RU: Readonly<Record<number, string>> = {
  1: 'понедельник',
  2: 'вторник',
  3: 'среда',
  4: 'четверг',
  5: 'пятница',
  6: 'суббота',
  7: 'воскресенье',
};

/**
 * «в понедельник» / «во вторник» / «в среду» — the accusative with its
 * preposition, because "во" before вт- and the -у endings are exactly what a
 * naive `в ${weekday}` gets wrong.
 */
export const WEEKDAY_ON_RU: Readonly<Record<number, string>> = {
  1: 'в понедельник',
  2: 'во вторник',
  3: 'в среду',
  4: 'в четверг',
  5: 'в пятницу',
  6: 'в субботу',
  7: 'в воскресенье',
};

/** Genitive month names — the form a date takes in «24 августа». */
export const MONTHS_GENITIVE_RU: readonly string[] = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** `'2026-08-24'` → `'24 августа'`. */
export function formatLocalDateRu(date: string): string {
  const [, month, day] = date.split('-');
  const monthName = MONTHS_GENITIVE_RU[Number(month) - 1] ?? '';
  return `${Number(day)} ${monthName}`.trim();
}

/** `'2026-08-24'..'2026-08-30'` → `'24–30 августа'`, or `'29 августа – 4 сентября'`. */
export function formatLocalRangeRu(from: string, toInclusive: string): string {
  const fromMonth = from.slice(5, 7);
  const toMonth = toInclusive.slice(5, 7);
  const fromDay = Number(from.slice(8, 10));
  if (fromMonth === toMonth) return `${fromDay}–${formatLocalDateRu(toInclusive)}`;
  return `${formatLocalDateRu(from)} – ${formatLocalDateRu(toInclusive)}`;
}

/**
 * How a date is referred to inside the digest: «сегодня» for the day it is
 * composed, a weekday phrase for the rest of the week, a calendar date beyond
 * it.
 *
 * There is deliberately **no «завтра»**. A digest is written once and read
 * whenever the person gets to it — Sunday evening, Monday morning on the
 * commute, Tuesday when they finally open Telegram. «Завтра» is wrong by then;
 * «во вторник» never goes stale. The same reasoning caps the relative form at
 * one week: past that, two different Tuesdays are in play and only a date is
 * honest.
 */
export function relativeDayRu(date: string, anchor: string): string {
  if (date === anchor) return 'сегодня';
  const withinWeek = date < addLocalDays(anchor, 7);
  if (withinWeek) return WEEKDAY_ON_RU[isoWeekdayOf(date)] ?? formatLocalDateRu(date);
  return formatLocalDateRu(date);
}

/** «Дежурство по кухне» → «дежурство по кухне», for mid-sentence use. */
export function lowerFirstRu(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLocaleLowerCase('ru-RU') + value.slice(1);
}

/**
 * Integer minor units → «12 400 ₽» (D6).
 *
 * Hand-rolled rather than `Intl.NumberFormat` so the output is byte-identical
 * regardless of the container's ICU build, and so the arithmetic never leaves
 * integer space. The separator is a non-breaking space, as Russian typography
 * wants.
 */
export function formatMoneyRu(minorUnits: number, currency: string): string {
  const negative = minorUnits < 0;
  const abs = Math.abs(Math.trunc(minorUnits));
  const major = Math.trunc(abs / 100);
  const minor = abs % 100;
  // U+00A0 goes through a named constant on purpose: a literal non-breaking
  // space in source is invisible in review and in every diff, and a test
  // asserting on it then fails with two strings that look identical.
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const symbol = currency === 'RUB' ? '₽' : currency;
  const body = minor === 0 ? grouped : `${grouped},${String(minor).padStart(2, '0')}`;
  return `${negative ? '−' : ''}${body}${NBSP}${symbol}`;
}

/* ========================================================================== */
/* ISO week identity                                                          */
/* ========================================================================== */

/**
 * `2026-W34` — the ISO-8601 week-numbering key.
 *
 * This is the **week component of the dedupe key**, so it has to agree with
 * itself across a year boundary: 2026-12-31 and 2027-01-01 are the same ISO
 * week, and a naive `${year}-W${week}` would emit two different keys for them
 * and send the family two digests. The Thursday of the week decides the
 * numbering year, which is exactly what ISO-8601 says.
 */
export function isoWeekKey(localDate: string): string {
  const temporalApi = globalThis.Temporal;
  if (!temporalApi) {
    throw new Error('Temporal is not available — call installTemporal() from core/temporal.js');
  }
  const date = temporalApi.PlainDate.from(localDate);
  const thursday = date.add({ days: 4 - date.dayOfWeek });
  const week = Math.floor((thursday.dayOfYear - 1) / 7) + 1;
  return `${thursday.year}-W${String(week).padStart(2, '0')}`;
}

/* ========================================================================== */
/* Scheduling                                                                 */
/* ========================================================================== */

export interface DigestSchedule {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday, matching `digest_subscriptions.weekday`. */
  weekday: number;
  /** `HH:mm` local wall clock. */
  timeOfDay: string;
  lastSentAt: Date | null;
}

export type DigestDueReason = 'due' | 'disabled' | 'already_sent' | 'not_yet';

export interface DigestDueDecision {
  due: boolean;
  reason: DigestDueReason;
  /** ISO week the decision is about — the dedupe key's week component. */
  weekKey: string;
  /** UTC instant of this week's configured slot, in the subscriber's zone. */
  slotUtc: Date;
  /** The subscriber's local date at `now`. */
  localDate: string;
}

/**
 * Is this subscriber's slot in the past, in *their* timezone, and have they not
 * already been sent this week's digest?
 *
 * Deliberately "the slot has arrived", not "the slot is in this hour". The
 * hourly job may miss a tick — a redeploy, a wedged worker, a Redis restart —
 * and a digest that arrives three hours late is worth vastly more than no
 * digest at all. The ISO-week guard is what keeps that from turning into a
 * second send.
 */
export function digestDueDecision(input: {
  schedule: DigestSchedule;
  timezone: string;
  now: Date;
}): DigestDueDecision {
  const { schedule, timezone, now } = input;
  const localDate = localDateOf(now, timezone);
  const weekKey = isoWeekKey(localDate);

  // `weekday` is 0=Sunday; ISO is 1=Monday…7=Sunday. Mapping Sunday to 7 puts
  // a Sunday digest at the *end* of its ISO week, which is what "воскресный
  // дайджест" means to a family.
  const isoWeekday = schedule.weekday === 0 ? 7 : schedule.weekday;
  const mondayOfWeek = startOfLocalWeek(localDate, 1);
  const slotDate = addLocalDays(mondayOfWeek, isoWeekday - 1);
  const slotUtc = localSlotInstant(slotDate, schedule.timeOfDay, timezone);

  const base = { weekKey, slotUtc, localDate };

  if (!schedule.enabled) return { due: false, reason: 'disabled', ...base };
  if (schedule.lastSentAt && isoWeekKey(localDateOf(schedule.lastSentAt, timezone)) === weekKey) {
    return { due: false, reason: 'already_sent', ...base };
  }
  if (now.getTime() < slotUtc.getTime()) return { due: false, reason: 'not_yet', ...base };
  return { due: true, reason: 'due', ...base };
}

/** UTC instant of `HH:mm` local on `date`, DST-safe (D2). */
export function localSlotInstant(date: string, timeOfDay: string, timezone: string): Date {
  const temporalApi = globalThis.Temporal;
  if (!temporalApi) {
    throw new Error('Temporal is not available — call installTemporal() from core/temporal.js');
  }
  const [hourRaw, minuteRaw] = timeOfDay.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    // A malformed row must not wedge the sweep for everybody else.
    return startOfLocalDay(date, timezone);
  }
  const zdt = temporalApi.PlainDate.from(date)
    .toPlainDateTime({ hour, minute })
    // `compatible` matches Google Calendar: a spring-forward gap pushes
    // forward, a fall-back overlap picks the earlier instance (D2).
    .toZonedDateTime(timezone, { disambiguation: 'compatible' });
  return new Date(zdt.epochMilliseconds);
}

/* ========================================================================== */
/* Port                                                                       */
/* ========================================================================== */

export interface WallCounts {
  announcements: number;
  kudos: number;
}

/** One row of the hourly sweep — everything needed to decide and to compose. */
export interface DigestSubscriber {
  userId: string;
  displayName: string;
  role: Role;
  permissionGrants: string[];
  permissionDenies: string[];
  /** `users.timezone`; `null` => family default. */
  userTimezone: string | null;
  schedule: DigestSchedule;
  sections: DigestSection[];
}

/**
 * Everything the digest reads beyond what the dashboard already reads.
 *
 * Extends {@link DashboardPort} rather than duplicating it: the digest is the
 * same aggregate over a different window, and having two ways to read "my tasks
 * this week" is how the screen and the digest end up disagreeing.
 */
export interface DigestPort extends DashboardPort {
  loadWallCounts(range: { fromUtc: Date; toUtc: Date }): Promise<WallCounts>;
  /** Sum of positive `goal_transactions.delta` in the window, in minor units. */
  loadGoalContributions(range: { fromUtc: Date; toUtc: Date }): Promise<number>;
  loadSubscriber(userId: string): Promise<DigestSubscriber | null>;
  /** Every enabled subscription for an active user. Family scale — no cursor. */
  listSubscribers(limit: number): Promise<DigestSubscriber[]>;
  /**
   * Conditional stamp. Returns `false` when another worker already claimed this
   * week, which is what makes the sweep safe to run concurrently.
   */
  markSent(userId: string, sentAt: Date, notSentSince: Date): Promise<boolean>;
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

const VALID_SECTIONS: ReadonlySet<string> = new Set<string>(DIGEST_SECTIONS);

/** A `text[]` column can hold a section name a later release removed. Drop it. */
export function sanitizeSections(values: readonly string[]): DigestSection[] {
  const kept = values.filter((v): v is DigestSection => VALID_SECTIONS.has(v));
  return kept.length > 0 ? kept : [...DEFAULT_DIGEST_SECTIONS];
}

export function createDigestPort(exec: Executor): DigestPort {
  const base = createDashboardPort(exec);

  const subscriberSelect = {
    userId: digestSubscriptions.userId,
    displayName: users.displayName,
    role: users.role,
    permissionGrants: users.permissionGrants,
    permissionDenies: users.permissionDenies,
    userTimezone: users.timezone,
    enabled: digestSubscriptions.enabled,
    weekday: digestSubscriptions.weekday,
    timeOfDay: digestSubscriptions.timeOfDay,
    sections: digestSubscriptions.sections,
    lastSentAt: digestSubscriptions.lastSentAt,
  };

  type SubscriberSelectRow = {
    userId: string;
    displayName: string;
    role: Role;
    permissionGrants: string[];
    permissionDenies: string[];
    userTimezone: string | null;
    enabled: boolean;
    weekday: number;
    timeOfDay: string;
    sections: string[];
    lastSentAt: Date | null;
  };

  const toSubscriber = (row: SubscriberSelectRow): DigestSubscriber => ({
    userId: row.userId,
    displayName: row.displayName,
    role: row.role,
    permissionGrants: row.permissionGrants,
    permissionDenies: row.permissionDenies,
    userTimezone: row.userTimezone,
    schedule: {
      enabled: row.enabled,
      weekday: row.weekday,
      timeOfDay: row.timeOfDay,
      lastSentAt: row.lastSentAt,
    },
    sections: sanitizeSections(row.sections),
  });

  return {
    ...base,

    async loadWallCounts(range) {
      // Two counts, one round trip. `UNION ALL` over two aggregates beats two
      // queries for a job that runs once per subscriber per week.
      const rows = await exec.execute(sql`
        select 'announcements' as kind, count(*)::text as n
          from ${posts}
         where ${posts.createdAt} >= ${range.fromUtc}
           and ${posts.createdAt} < ${range.toUtc}
           and ${posts.deletedAt} is null
           and ${posts.type} = 'announcement'
        union all
        select 'kudos' as kind, count(*)::text as n
          from ${kudos}
         where ${kudos.createdAt} >= ${range.fromUtc}
           and ${kudos.createdAt} < ${range.toUtc}
      `);

      const counts: WallCounts = { announcements: 0, kudos: 0 };
      for (const raw of rows as unknown as Array<{ kind: string; n: string }>) {
        if (raw.kind === 'announcements') counts.announcements = toInt(raw.n);
        if (raw.kind === 'kudos') counts.kudos = toInt(raw.n);
      }
      return counts;
    },

    async loadGoalContributions(range) {
      const [row] = await exec
        .select({ total: sql<string>`coalesce(sum(${goalTransactions.delta}), 0)` })
        .from(goalTransactions)
        .where(
          and(
            gt(goalTransactions.delta, 0),
            sql`${goalTransactions.occurredAt} >= ${range.fromUtc}`,
            sql`${goalTransactions.occurredAt} < ${range.toUtc}`,
          ),
        );
      return row ? toInt(row.total) : 0;
    },

    async loadSubscriber(userId) {
      const [row] = await exec
        .select(subscriberSelect)
        .from(digestSubscriptions)
        .innerJoin(users, eq(users.id, digestSubscriptions.userId))
        .where(eq(digestSubscriptions.userId, userId))
        .limit(1);
      return row ? toSubscriber(row) : null;
    },

    async listSubscribers(limit) {
      const rows = await exec
        .select(subscriberSelect)
        .from(digestSubscriptions)
        .innerJoin(users, eq(users.id, digestSubscriptions.userId))
        .where(and(eq(digestSubscriptions.enabled, true), eq(users.status, 'active')))
        .limit(limit);
      return rows.map(toSubscriber);
    },

    async markSent(userId, sentAt, notSentSince) {
      // Conditional by design: two workers reaching this line for the same user
      // produce one winner and one `false`, exactly like the D3 approval race.
      const updated = await exec
        .update(digestSubscriptions)
        .set({ lastSentAt: sentAt })
        .where(
          and(
            eq(digestSubscriptions.userId, userId),
            or(
              isNull(digestSubscriptions.lastSentAt),
              lt(digestSubscriptions.lastSentAt, notSentSince),
            ),
          ),
        )
        .returning({ userId: digestSubscriptions.userId });
      return updated.length > 0;
    },
  };
}

/* ========================================================================== */
/* Notification intent port (D10)                                             */
/* ========================================================================== */

export interface DigestIntent {
  userId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * The narrow slice of the notifications module this one needs.
 *
 * Declared as an interface rather than calling `notifications.emitIntent`
 * directly from {@link sendDigest} for one reason: it lets the send-once tests
 * drive the whole sweep with an in-memory dedupe set, no Postgres and no Redis.
 * The real implementation below is a thin adapter over the notifications
 * **service** — never its repository (D8).
 */
export interface NotificationIntentPort {
  emit(intent: DigestIntent): Promise<{ intentId: string; created: boolean }>;
}

export function createNotificationIntentPort(exec: Executor): NotificationIntentPort {
  return {
    async emit(intent) {
      // `emitIntent` writes the row on the caller's executor and hands back a
      // `dispatch()` to enqueue the fan-out. Both halves are idempotent: the
      // partial unique index on `dedupe_key` collapses a duplicate row, and the
      // BullMQ `jobId` collapses a duplicate job.
      const result = await notifications.emitIntent(exec, {
        type: 'weekly_digest',
        audience: { users: [intent.userId] },
        // No actor: the scheduler caused this, not a person.
        actorId: null,
        entityType: 'digest',
        payload: intent.payload,
        dedupeKey: intent.dedupeKey,
        // `low` — a digest must never escalate and must never punch through
        // quiet hours (D11: "never escalate a low/normal notification").
        priority: 'low',
      });

      if (result.deduped) return { intentId: result.intentId, created: false };

      try {
        // Outside a transaction, so dispatching here is the "after commit" step.
        await result.dispatch();
      } catch (error) {
        // Fail-soft: the intent row is committed and the notifications sweep
        // re-dispatches undelivered intents. Redis being down must not cost the
        // family their digest.
        logger.error(
          { intentId: result.intentId, err: error },
          'failed to enqueue notification fan-out for the weekly digest',
        );
      }
      return { intentId: result.intentId, created: true };
    },
  };
}

/* ========================================================================== */
/* Composition                                                                */
/* ========================================================================== */

/** Everything the composer needs. Gathered once, then rendered purely. */
export interface DigestData {
  viewer: Pick<ViewerContext, 'displayName' | 'currency' | 'familyName'>;
  timezone: string;
  /** Inclusive local date the forward-looking window starts on. */
  periodStart: string;
  /** Exclusive local date it ends on. */
  periodEnd: string;
  members: MemberRow[];
  myTasks: TaskRow[];
  familyTasks: TaskRow[];
  events: EventRow[];
  /** `null` when the subscriber may not read goals (every child — D4). */
  goals: GoalRow[] | null;
  goalContributed: number | null;
  shopping: ShoppingSnapshot | null;
  wall: WallCounts | null;
  load: LoadRow[] | null;
  /** The subscriber, for "you did N" lines. */
  actorId: string;
}

interface SectionResult {
  block: DigestBlock;
  /** Fragments the one-line summary is built from, best first. */
  highlights: string[];
}

/** A birthday falling inside the window. Pure — derived from `users.birth_date`. */
export interface UpcomingBirthday {
  userId: string;
  displayName: string;
  date: string;
  /** Age being turned, or `null` when the birth year is unknown. */
  turning: number | null;
}

/**
 * Birthdays inside `[from, to)`, matched on month + day.
 *
 * 29 February is matched literally: in a non-leap year there is simply no
 * matching day in the window, and quietly moving it to 1 March would be this
 * module inventing a policy that belongs to the birthday-sync job
 * (`docs/architecture/scheduling.md`), not to the digest.
 */
export function birthdaysIn(
  members: readonly MemberRow[],
  from: string,
  to: string,
): UpcomingBirthday[] {
  const found: UpcomingBirthday[] = [];
  for (let date = from; date < to; date = addLocalDays(date, 1)) {
    const monthDay = date.slice(5);
    for (const member of members) {
      if (member.status !== 'active' || !member.birthDate) continue;
      if (member.birthDate.slice(5) !== monthDay) continue;
      const birthYear = Number(member.birthDate.slice(0, 4));
      const year = Number(date.slice(0, 4));
      found.push({
        userId: member.id,
        displayName: member.displayName,
        date,
        turning: Number.isFinite(birthYear) && birthYear > 1900 ? year - birthYear : null,
      });
    }
  }
  return found;
}

const EMPTY_LINES: Readonly<Record<DigestSection, string>> = {
  tasks: 'Задач и дежурств на неделю не запланировано — можно выдохнуть.',
  events: 'В календаре на неделе пусто. Хороший повод придумать что-нибудь вместе.',
  goals: 'Копилки пока стоят на месте — ничего страшного, неделя впереди.',
  shopping: 'Список покупок пуст — всё уже куплено.',
  wall: 'На стене за неделю тихо.',
  points: 'Баллов на этой неделе никто ещё не набрал.',
  birthdays: 'Дней рождения на неделе нет.',
};

function block(section: DigestSection, lines: string[]): DigestBlock {
  const isEmpty = lines.length === 0;
  return {
    section,
    heading: DIGEST_SECTION_LABELS_RU[section],
    // An empty section gets a friendly sentence, never a bare heading over
    // whitespace — see the note on `digestBlockSchema`.
    lines: isEmpty ? [EMPTY_LINES[section]] : lines,
    isEmpty,
  };
}

function nameOf(members: readonly MemberRow[], userId: string | null): string | null {
  if (!userId) return null;
  return members.find((m) => m.id === userId)?.displayName ?? null;
}

function buildTasks(data: DigestData): SectionResult {
  const lines: string[] = [];
  const highlights: string[] = [];

  const open = data.myTasks.filter((t) => t.status === 'scheduled');
  if (open.length > 0) {
    lines.push(`У вас на неделе ${countRu(open.length, RU_PLURALS.task)}.`);
  }

  // One line per series, not per occurrence: "Вынести мусор — Паша" seven times
  // is noise, and the family cares who is on duty, not how many times.
  const seen = new Set<string>();
  for (const task of data.familyTasks) {
    if (task.status !== 'scheduled' || !task.assigneeId) continue;
    const key = `${task.seriesId}:${task.assigneeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = nameOf(data.members, task.assigneeId);
    if (!who) continue;
    lines.push(`${task.title} — ${who}`);
    if (highlights.length < 1) highlights.push(`${lowerFirstRu(task.title)} — ${who}`);
    if (seen.size >= 6) break;
  }

  return { block: block('tasks', lines), highlights };
}

function buildEvents(data: DigestData): SectionResult {
  const lines: string[] = [];
  const highlights: string[] = [];

  for (const event of data.events.slice(0, 10)) {
    const date = localDateOf(event.startsAt, data.timezone);
    const when = relativeDayRu(date, data.periodStart);
    const time = event.isAllDay ? '' : `, ${localTimeOf(event.startsAt, data.timezone)}`;
    lines.push(`${event.title} — ${when}${time}`);
    if (highlights.length < 2) highlights.push(`${lowerFirstRu(event.title)} ${when}`);
  }

  return { block: block('events', lines), highlights };
}

function buildBirthdays(data: DigestData): SectionResult {
  const upcoming = birthdaysIn(data.members, data.periodStart, data.periodEnd);
  const lines = upcoming.map((b) => {
    const when = relativeDayRu(b.date, data.periodStart);
    const age = b.turning === null ? '' : `, исполняется ${countRu(b.turning, RU_PLURALS.year)}`;
    return `${b.displayName} — ${when}${age}`;
  });
  const highlights = upcoming.length > 0 ? [countRu(upcoming.length, RU_PLURALS.birthday)] : [];
  return { block: block('birthdays', lines), highlights };
}

function buildGoals(data: DigestData): SectionResult {
  if (!data.goals) return { block: block('goals', []), highlights: [] };

  const lines: string[] = [];
  const nearest = pickNearestMilestone(data.goals);
  if (nearest) {
    lines.push(
      `«${nearest.goalTitle}» — ${formatMoneyRu(nearest.savedAmount, nearest.currency)} ` +
        `из ${formatMoneyRu(nearest.targetAmount, nearest.currency)} (${nearest.progressPercent}%).`,
    );
    lines.push(
      `До цели «${nearest.title}» осталось ${formatMoneyRu(nearest.remainingAmount, nearest.currency)}.`,
    );
  }
  if (data.goalContributed !== null && data.goalContributed > 0) {
    lines.push(`За неделю отложили ${formatMoneyRu(data.goalContributed, data.viewer.currency)}.`);
  }
  return { block: block('goals', lines), highlights: [] };
}

function buildShopping(data: DigestData): SectionResult {
  if (!data.shopping) return { block: block('shopping', []), highlights: [] };

  const lines: string[] = [];
  const { neededCount, urgentCount, items } = data.shopping;
  if (neededCount > 0) {
    const urgentPart =
      urgentCount > 0
        ? `, из них ${formatCountRu(urgentCount)} ${pluralRu(urgentCount, RU_PLURALS.urgent)}`
        : '';
    lines.push(`В списках ${countRu(neededCount, RU_PLURALS.purchase)}${urgentPart}.`);
  }
  for (const item of items.filter((i) => i.isUrgent).slice(0, 5)) {
    lines.push(`Срочно: ${item.name} (${item.listName})`);
  }
  const highlights =
    urgentCount > 0
      ? [`${formatCountRu(urgentCount)} ${pluralRu(urgentCount, RU_PLURALS.urgent)} покупка`]
      : [];
  return { block: block('shopping', lines), highlights: urgentCount > 0 ? highlights : [] };
}

function buildWall(data: DigestData): SectionResult {
  if (!data.wall) return { block: block('wall', []), highlights: [] };
  const lines: string[] = [];
  if (data.wall.announcements > 0) {
    lines.push(`${countRu(data.wall.announcements, RU_PLURALS.announcement)} на стене.`);
  }
  if (data.wall.kudos > 0) {
    lines.push(`${countRu(data.wall.kudos, RU_PLURALS.thanks)} друг другу за неделю.`);
  }
  return { block: block('wall', lines), highlights: [] };
}

function buildPoints(data: DigestData): SectionResult {
  if (!data.load) return { block: block('points', []), highlights: [] };

  const lines: string[] = [];
  const mine = data.load.find((l) => l.userId === data.actorId);
  const totalDone = data.load.reduce((n, l) => n + l.doneCount, 0);

  if (mine && (mine.doneCount > 0 || mine.points !== 0)) {
    lines.push(
      `Вы закрыли ${countRu(mine.doneCount, RU_PLURALS.taskAccusative)} ` +
        `и набрали ${countRu(mine.points, RU_PLURALS.point)}.`,
    );
  }
  if (totalDone > 0) {
    // Neutral, aggregate, never a ranking (D5).
    lines.push(`Вся семья за неделю — ${countRu(totalDone, RU_PLURALS.task)}.`);
  }
  return { block: block('points', lines), highlights: [] };
}

const BUILDERS: Readonly<Record<DigestSection, (data: DigestData) => SectionResult>> = {
  tasks: buildTasks,
  events: buildEvents,
  goals: buildGoals,
  shopping: buildShopping,
  wall: buildWall,
  points: buildPoints,
  birthdays: buildBirthdays,
};

/** Summary order: what a person scans for first. Birthdays, then plans, then duty. */
const SUMMARY_ORDER: readonly DigestSection[] = [
  'birthdays',
  'events',
  'tasks',
  'shopping',
  'goals',
  'points',
  'wall',
];

const MAX_SUMMARY_HIGHLIGHTS = 4;

/**
 * Composes the digest. **Pure** — no clock of its own beyond `now`, no database,
 * no notifications. This is the function the Russian-grammar tests exercise.
 */
export function composeDigest(
  data: DigestData,
  sections: readonly DigestSection[],
  now: Date,
): DigestPreviewResponse {
  const results = new Map<DigestSection, SectionResult>();
  // Ordered as the subscriber configured them; an unknown value was already
  // dropped by `sanitizeSections`.
  const ordered = sections.filter((s, i) => sections.indexOf(s) === i);
  for (const section of ordered) {
    const builder = BUILDERS[section];
    results.set(section, builder(data));
  }

  const highlights: string[] = [];
  for (const section of SUMMARY_ORDER) {
    const result = results.get(section);
    if (!result) continue;
    for (const highlight of result.highlights) {
      if (highlights.length < MAX_SUMMARY_HIGHLIGHTS) highlights.push(highlight);
    }
  }

  const lastDay = addLocalDays(data.periodEnd, -1);
  const title = `Неделя ${formatLocalRangeRu(data.periodStart, lastDay)}`;
  const summary =
    highlights.length > 0
      ? `На неделе: ${highlights.join(', ')}.`
      : 'Неделя спокойная — ничего срочного не запланировано.';

  const blocks = ordered.map((s) => results.get(s)).filter((r): r is SectionResult => !!r);
  const preview: DigestPreviewResponse = {
    weekKey: isoWeekKey(data.periodStart),
    title,
    summary,
    blocks: blocks.map((r) => r.block),
    text: '',
    generatedAt: now.toISOString(),
    timezone: data.timezone,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
  };
  return { ...preview, text: renderDigestText(preview) };
}

/**
 * The plain-text render — what the Telegram channel sends and what the push
 * body is truncated from.
 *
 * An **empty block prints its friendly line without the heading**. A digest
 * that is four headings over four blank spaces looks broken, and a digest that
 * looks broken gets muted; one honest sentence ("Дней рождения на неделе нет.")
 * costs one line and reads like a person wrote it.
 */
export function renderDigestText(digest: Omit<DigestPreviewResponse, 'text'>): string {
  const parts: string[] = [digest.title, '', digest.summary];
  for (const b of digest.blocks) {
    parts.push('');
    if (b.isEmpty) {
      parts.push(b.lines[0] ?? '');
      continue;
    }
    parts.push(b.heading);
    for (const line of b.lines) parts.push(`• ${line}`);
  }
  return parts.join('\n').trim();
}

/* ========================================================================== */
/* Gathering                                                                  */
/* ========================================================================== */

const VALID_PERMISSIONS: ReadonlySet<string> = new Set<string>(PERMISSIONS);

function sanitizePermissions(values: readonly string[]): Permission[] {
  return values.filter((v): v is Permission => VALID_PERMISSIONS.has(v));
}

/** Builds a {@link DashboardActor} for a subscriber the job picked up. */
export function actorForSubscriber(subscriber: DigestSubscriber): DashboardActor {
  const permissions = new Set<Permission>(
    effectivePermissions(
      subscriber.role,
      sanitizePermissions(subscriber.permissionGrants),
      sanitizePermissions(subscriber.permissionDenies),
    ),
  );
  return {
    userId: subscriber.userId,
    displayName: subscriber.displayName,
    timezone: subscriber.userTimezone,
    can: (permission) => permissions.has(permission),
  };
}

/**
 * Reads everything the requested sections need, and **only** what they need.
 *
 * The forward window (`[today, today+7)`) drives tasks, events and birthdays;
 * the trailing window (`[today-7, today)`) drives points, the wall and the
 * week's contributions. Mixing the two is how a digest ends up congratulating
 * you for chores you have not done yet.
 */
export async function gatherDigestData(
  port: DigestPort,
  actor: DashboardActor,
  sections: readonly DigestSection[],
  now: Date,
): Promise<{ data: DigestData; sections: DigestSection[]; access: TodayAccess }> {
  const viewer = await port.loadViewer(actor.userId);
  if (!viewer) throw notFound('User');

  const timezone = resolveTimezone(actor.timezone ?? viewer.userTimezone, viewer.familyTimezone);
  const access = resolveAccess(actor);
  const today = localDateOf(now, timezone);
  const periodEnd = addLocalDays(today, 7);
  const ahead = {
    fromUtc: startOfLocalDay(today, timezone),
    toUtc: startOfLocalDay(periodEnd, timezone),
  };
  const behind = {
    fromUtc: startOfLocalDay(addLocalDays(today, -7), timezone),
    toUtc: ahead.fromUtc,
  };

  // A section the subscriber may not read is dropped from the digest entirely —
  // not rendered empty. A child who somehow has `goals` in their row must not
  // receive a "Копилки" heading at all.
  const permitted = sections.filter((section) => {
    if (section === 'goals') return access.goals;
    if (section === 'shopping') return access.shopping;
    if (section === 'points') return access.fairness;
    if (section === 'tasks') return access.tasks;
    if (section === 'events') return access.events;
    return true;
  });

  const wants = (section: DigestSection) => permitted.includes(section);

  const [members, myTasks, familyTasks, events, goals, goalContributed, shopping, wall, load] =
    await Promise.all([
      port.loadMembers(),
      wants('tasks')
        ? port.loadMyTasks(actor.userId, {
            sinceUtc: ahead.fromUtc,
            untilUtc: ahead.toUtc,
            doneSinceUtc: ahead.toUtc,
          })
        : Promise.resolve<TaskRow[]>([]),
      wants('tasks') ? port.loadFamilyTasks(ahead) : Promise.resolve<TaskRow[]>([]),
      wants('events') ? port.loadEvents(actor.userId, ahead) : Promise.resolve<EventRow[]>([]),
      wants('goals')
        ? port.loadGoals(actor.userId, access.everyGoal)
        : Promise.resolve<GoalRow[] | null>(null),
      wants('goals') ? port.loadGoalContributions(behind) : Promise.resolve<number | null>(null),
      wants('shopping') ? port.loadShopping(12) : Promise.resolve<ShoppingSnapshot | null>(null),
      wants('wall') ? port.loadWallCounts(behind) : Promise.resolve<WallCounts | null>(null),
      wants('points') ? port.loadLoad(behind) : Promise.resolve<LoadRow[] | null>(null),
    ]);

  return {
    access,
    sections: permitted,
    data: {
      viewer: {
        displayName: viewer.displayName,
        currency: viewer.currency,
        familyName: viewer.familyName,
      },
      timezone,
      periodStart: today,
      periodEnd,
      members,
      myTasks,
      familyTasks,
      events,
      goals,
      goalContributed,
      shopping,
      wall,
      load,
      actorId: actor.userId,
    },
  };
}

/** `POST /dashboard/digest/preview` — render my digest as of right now. */
export async function previewDigest(
  port: DigestPort,
  actor: DashboardActor,
  override: readonly DigestSection[] | undefined,
  now: Date = new Date(),
): Promise<DigestPreviewResponse> {
  const subscriber = await port.loadSubscriber(actor.userId);
  const requested = override ?? subscriber?.sections ?? [...DEFAULT_DIGEST_SECTIONS];
  const { data, sections } = await gatherDigestData(port, actor, sanitizeSections(requested), now);
  return composeDigest(data, sections, now);
}

/* ========================================================================== */
/* Sending                                                                    */
/* ========================================================================== */

/** The subscriber's own timezone, falling back to `family_settings.timezone` (D2). */
export function resolveTimezoneForSubscriber(
  subscriber: Pick<DigestSubscriber, 'userTimezone'>,
  familyTimezone: string,
): string {
  return resolveTimezone(subscriber.userTimezone, familyTimezone);
}

export interface DigestSendResult {
  userId: string;
  sent: boolean;
  reason: DigestDueReason | 'raced';
  weekKey: string;
}

/**
 * Sends one subscriber's digest, if their slot has arrived in their timezone
 * and they have not already had it this week.
 *
 * The order — emit, then stamp — is the safe one; see the file header.
 */
export async function sendDigest(
  port: DigestPort,
  intents: NotificationIntentPort,
  subscriber: DigestSubscriber,
  familyTimezone: string,
  now: Date = new Date(),
): Promise<DigestSendResult> {
  const timezone = resolveTimezone(subscriber.userTimezone, familyTimezone);
  const decision = digestDueDecision({ schedule: subscriber.schedule, timezone, now });
  if (!decision.due) {
    return {
      userId: subscriber.userId,
      sent: false,
      reason: decision.reason,
      weekKey: decision.weekKey,
    };
  }

  const actor = actorForSubscriber(subscriber);
  const { data, sections } = await gatherDigestData(
    port,
    actor,
    sanitizeSections(subscriber.sections),
    now,
  );
  const digest = composeDigest(data, sections, now);

  const emitted = await intents.emit({
    userId: subscriber.userId,
    // The whole point of D11's "a retried job can never send twice", expressed
    // as one string: identity is (user, ISO week), nothing else.
    dedupeKey: `weekly_digest:${subscriber.userId}:${decision.weekKey}`,
    payload: {
      weekKey: digest.weekKey,
      title: digest.title,
      summary: digest.summary,
      text: digest.text,
      blocks: digest.blocks,
      periodStart: digest.periodStart,
      periodEnd: digest.periodEnd,
      timezone: digest.timezone,
    },
  });

  // Stamp regardless of who won the dedupe race: either we just emitted, or
  // somebody else did and this row is simply behind.
  await port.markSent(subscriber.userId, now, decision.slotUtc);

  return {
    userId: subscriber.userId,
    sent: emitted.created,
    reason: emitted.created ? 'due' : 'raced',
    weekKey: decision.weekKey,
  };
}
