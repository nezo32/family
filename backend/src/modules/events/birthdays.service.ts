import type { Db, Executor } from '../../core/db.js';
import { recurrenceEngine } from '../../core/recurrence/engine.js';
import { emit } from '../notifications/notifications.service.js';
import * as repo from './events.repository.js';
import type { EventSeriesRow } from './events.schema.js';
import { localDateIn } from './events.service.js';

/**
 * Birthday event generation (`docs/architecture/scheduling.md` §6).
 *
 * **There is no `birthdays` table and there must not be one.** A birthday is an
 * ordinary yearly `event_series` generated from `users.birth_date`. A dedicated
 * table would buy nothing and cost a second calendar read path, a second
 * notification path, a second ICS exporter and a second permission check — for
 * a row that is already a perfectly ordinary yearly all-day event.
 *
 * ## Idempotency
 *
 * `event_series_source_uq (source_kind, source_ref) WHERE source_ref IS NOT NULL`
 * is the whole guarantee. The job keys every generated row on
 * `('user_birthday', users.id)`, so:
 *
 * - re-running the nightly job changes nothing;
 * - **changing a birth date updates the one row rather than adding a second**,
 *   and drops the future occurrences so the new date materializes;
 * - clearing `birth_date` (or suspending the member) archives the series;
 * - deleting the user cascades the series away.
 *
 * ## 29 February — the decision
 *
 * A person born on 29 February has a birthday every year, not every fourth
 * year. `FREQ=YEARLY` anchored at 29 February produces occurrences **only in
 * leap years**, which is technically defensible and socially wrong: it would
 * mean the family app forgets Даша's birthday three years out of four.
 *
 * So a leap-day birthday compiles to
 *
 * ```
 * FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1
 * ```
 *
 * — **the last day of February**: 28 February in a common year, 29 February in
 * a leap year. Compared with the alternatives:
 *
 * | Option | Why not |
 * |---|---|
 * | plain `FREQ=YEARLY` from 29 Feb | fires once every four years |
 * | pin to 28 Feb always | in a leap year it lands the day *before* the real birthday, next to a 29 Feb that is now empty |
 * | pin to 1 Mar always | in a leap year it lands the day *after*; also puts a February person in March |
 * | `BYMONTHDAY=28,29;BYSETPOS=-1` | identical result, but a rule shape the expander has no test coverage for |
 *
 * "Last day of February" is the only option that is right in leap years and
 * defensible in common years, and it is expressible in the plain RRULE grammar
 * the engine already exercises (`monthly_last_day` uses `BYMONTHDAY=-1`).
 *
 * The `dtstartLocal` still carries the true birth year and the true 29 February
 * date, so the age shown next to the event is computed from the profile and is
 * always correct.
 */

/** Minutes before the event at which to remind (§6). A week, then a day. */
export const BIRTHDAY_REMINDER_OFFSETS = [10_080, 1_440];

/** `sourceKind` for every generated birthday series. */
export const BIRTHDAY_SOURCE_KIND = 'user_birthday' as const;

/** Statuses whose members still get a birthday on the family calendar. */
const CELEBRATED_STATUSES = new Set(['active', 'pending_approval']);

const BIRTH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface BirthdayPlan {
  readonly rrule: string;
  readonly dtstartLocal: string;
  readonly title: string;
  /** True when the 29-February rule above is in play. Surfaced for tests. */
  readonly isLeapDay: boolean;
}

/** «День рождения: Маша» — the SUMMARY the phone's calendar will show. */
export function birthdayTitle(displayName: string): string {
  const name = displayName.trim();
  return name === '' ? 'День рождения' : `День рождения: ${name}`;
}

/**
 * Turn a `YYYY-MM-DD` birth date into the yearly rule and its floating anchor.
 *
 * Returns `null` for a malformed or absent date rather than throwing: one bad
 * profile row must not take the whole nightly sync down with it.
 */
export function planBirthday(birthDate: string | null, displayName: string): BirthdayPlan | null {
  if (birthDate === null) return null;
  const match = BIRTH_DATE.exec(birthDate.slice(0, 10));
  if (!match) return null;

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;

  const isLeapDay = month === '02' && day === '29';
  const rrule = isLeapDay
    ? // The last day of February: 29th in a leap year, 28th otherwise.
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1'
    : `FREQ=YEARLY;BYMONTH=${Number(month)};BYMONTHDAY=${Number(day)}`;

  return {
    rrule,
    // All-day ⇒ local midnight, in the family timezone. Never a UTC instant.
    dtstartLocal: `${year}-${month}-${day}T00:00:00`,
    title: birthdayTitle(displayName),
    isLeapDay,
  };
}

/** Does the stored series still match what the profile says it should be? */
export function birthdayNeedsUpdate(series: EventSeriesRow, plan: BirthdayPlan): boolean {
  return (
    series.rrule !== plan.rrule ||
    series.dtstartLocal !== plan.dtstartLocal ||
    series.title !== plan.title ||
    series.archivedAt !== null
  );
}

/** True when the schedule moved, i.e. existing future occurrences are stale. */
export function birthdayScheduleMoved(series: EventSeriesRow, plan: BirthdayPlan): boolean {
  return series.rrule !== plan.rrule || series.dtstartLocal !== plan.dtstartLocal;
}

export interface BirthdaySyncResult {
  created: number;
  updated: number;
  archived: number;
  unchanged: number;
}

/**
 * Sync one member's birthday series. Runs on the caller's executor so the
 * nightly job can give each user its own transaction.
 */
export async function syncBirthdayForUser(
  x: Executor,
  user: repo.BirthdayCandidate,
  timezone: string,
): Promise<keyof BirthdaySyncResult> {
  const existing = await repo.findSeriesBySource(x, BIRTHDAY_SOURCE_KIND, user.id);
  const plan = CELEBRATED_STATUSES.has(user.status)
    ? planBirthday(user.birthDate, user.displayName)
    : null;

  // No (usable) birth date, or the member is gone: archive rather than delete,
  // so the past occurrences stay in the family's history.
  if (plan === null) {
    if (existing && existing.archivedAt === null) {
      await repo.archiveSeries(x, existing.id, new Date());
      return 'archived';
    }
    return 'unchanged';
  }

  const rule = {
    rrule: plan.rrule,
    dtstartLocal: plan.dtstartLocal,
    timezone,
    rdatesLocal: [],
    exdatesLocal: [],
  };

  if (!existing) {
    const created = await repo.insertSeries(x, {
      title: plan.title,
      description: null,
      location: null,
      visibility: 'household',
      createdById: user.id,
      rrule: plan.rrule,
      dtstartLocal: plan.dtstartLocal,
      timezone,
      rdatesLocal: [],
      exdatesLocal: [],
      seriesEndsAt: recurrenceEngine.seriesEndsAt(rule),
      // All-day, one wall-clock day. `durationMinutes: 0` would make the
      // exporter emit DTEND == DTSTART and the phone would hide the event.
      durationMinutes: 1_440,
      isAllDay: true,
      reminderOffsets: BIRTHDAY_REMINDER_OFFSETS,
      color: null,
      category: 'birthday',
      sourceKind: BIRTHDAY_SOURCE_KIND,
      sourceRef: user.id,
    });
    await repo.materializeEventSeries(x, created.id);
    return 'created';
  }

  if (!birthdayNeedsUpdate(existing, plan)) return 'unchanged';

  const moved = birthdayScheduleMoved(existing, plan);
  await repo.updateSeriesRow(x, existing.id, {
    title: plan.title,
    rrule: plan.rrule,
    dtstartLocal: plan.dtstartLocal,
    timezone,
    seriesEndsAt: recurrenceEngine.seriesEndsAt(rule),
    archivedAt: null,
    // Rewind the watermark so the corrected date is actually materialized.
    ...(moved ? { materializedThrough: null } : {}),
  });

  if (moved) {
    // Drop the stale future slots. Past occurrences, and anything a person
    // deliberately edited, are left alone — this is the same "history is not
    // rewritten" rule the §3 mutations follow.
    await repo.deleteFutureScheduledOccurrences(
      x,
      existing.id,
      `${localDateIn(new Date(), timezone)}T00:00:00`,
    );
    await repo.materializeEventSeries(x, existing.id);
  }

  return 'updated';
}

/**
 * The `scheduler.birthdays` pass.
 *
 * Each member is synced in **its own transaction**, so one poisoned profile row
 * cannot roll back everybody else's calendar — the same reason
 * `materializeAllDue` isolates per series.
 */
export async function syncBirthdays(db: Db): Promise<BirthdaySyncResult> {
  const timezone = await repo.getFamilyTimezone(db);
  const users = await repo.listBirthdayCandidates(db);

  const result: BirthdaySyncResult = { created: 0, updated: 0, archived: 0, unchanged: 0 };
  for (const user of users) {
    const outcome = await db.transaction((tx) => syncBirthdayForUser(tx, user, timezone));
    result[outcome] += 1;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* «Сегодня день рождения» (D10 — `birthday_today`)                            */
/* -------------------------------------------------------------------------- */

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Does this birth date fall on `localDate` (`YYYY-MM-DD`) in the family's zone?
 *
 * The 29-February rule is the *same* one `planBirthday` compiles into the
 * calendar series (`BYMONTHDAY=-1`): in a common year the celebration is the
 * last day of February, so a leap-day person is greeted on 28 February rather
 * than three years out of four not at all. Keeping the two in one file is what
 * stops the calendar and the notification from disagreeing about the date.
 */
export function birthdayFallsOn(birthDate: string | null, localDate: string): boolean {
  if (birthDate === null) return false;
  const birth = BIRTH_DATE.exec(birthDate.slice(0, 10));
  const today = BIRTH_DATE.exec(localDate.slice(0, 10));
  if (!birth || !today) return false;

  const [, , birthMonth, birthDay] = birth;
  const [, todayYear, todayMonth, todayDay] = today;
  if (todayYear === undefined || todayMonth === undefined || todayDay === undefined) return false;

  if (birthMonth === todayMonth && birthDay === todayDay) return true;

  // 29 February in a common year: greet on the 28th, the last day of February.
  const isLeapDayBirth = birthMonth === '02' && birthDay === '29';
  return (
    isLeapDayBirth &&
    todayMonth === '02' &&
    todayDay === '28' &&
    !isLeapYear(Number(todayYear))
  );
}

/** Whole years completed today. `null` when the year is not usable. */
export function ageOn(birthDate: string, localDate: string): number | null {
  const birthYear = Number(birthDate.slice(0, 4));
  const todayYear = Number(localDate.slice(0, 4));
  if (!Number.isFinite(birthYear) || !Number.isFinite(todayYear)) return null;
  const age = todayYear - birthYear;
  return age > 0 && age < 130 ? age : null;
}

/**
 * Tell the family who is celebrating today.
 *
 * `birthday_today` shipped with a renderer, a preference row, a Russian label
 * and a UI toggle — and no producer, so the toggle promised something that
 * never arrived. The nightly `scheduler.birthdays` job is the natural home: it
 * already reads every profile and already knows the family timezone.
 *
 * **The celebrant is not told about their own birthday.** `actorId` is null for
 * a scheduler intent, so self-suppression would not fire; the audience is built
 * as "everyone else" instead. The fan-out still narrows it to active members
 * holding `event:read`.
 *
 * Idempotent on `birthday_today:<userId>:<YYYY-MM-DD>`, so re-running the job —
 * or running it twice around midnight — greets each person once per year.
 */
export async function announceBirthdaysToday(db: Db, now: Date = new Date()): Promise<number> {
  const timezone = await repo.getFamilyTimezone(db);
  const today = localDateIn(now, timezone);
  const users = await repo.listBirthdayCandidates(db);

  let emitted = 0;
  for (const user of users) {
    if (!CELEBRATED_STATUSES.has(user.status)) continue;
    if (!birthdayFallsOn(user.birthDate, today)) continue;

    const others = users.filter((u) => u.id !== user.id).map((u) => u.id);
    if (others.length === 0) continue;

    const age = user.birthDate === null ? null : ageOn(user.birthDate, today);
    const result = await emit(db, {
      type: 'birthday_today',
      audience: { users: others },
      actorId: null,
      entityType: 'user',
      entityId: user.id,
      dedupeKey: `birthday_today:${user.id}:${today}`,
      payload: {
        userId: user.id,
        personName: user.displayName,
        title: user.displayName,
        localDate: today,
        ...(age === null ? {} : { age }),
      },
    });
    if (!result.deduped) emitted += 1;
  }

  return emitted;
}
