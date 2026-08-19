import { getDb } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import type { Db } from '../../core/db.js';
import { emit, type NotificationAudience } from '../notifications/notifications.service.js';
import { syncBirthdays } from './birthdays.service.js';
import * as repo from './events.repository.js';
import { canViewEvent } from './events.service.js';

/**
 * Background work for the calendar.
 *
 * Two jobs, both **idempotent**, because BullMQ is at-least-once and because
 * the reminder sweep deliberately overlaps its own window:
 *
 * | Job | Idempotency mechanism |
 * |---|---|
 * | `scheduler.birthdays` | the partial unique index `(source_kind, source_ref)` — the sync upserts |
 * | `scheduler.reminders` | `notification_intents.dedupe_key = event_reminder:<occurrenceId>:<offset>m` |
 *
 * The reminder key is per **occurrence and offset**, not per series and not per
 * day. That is the grain that matters: a series with `reminderOffsets =
 * {10080, 1440}` must produce two notifications for the same birthday — one a
 * week out, one the day before — and re-running the sweep must produce neither
 * a third nor a duplicate of either.
 */

/** How far back a sweep will look for reminders it missed. */
export const REMINDER_LOOKBACK_MINUTES = 30;

/** Pairs handled by one sweep. Family scale; the bound is a safety valve. */
const REMINDER_BATCH = 200;

/**
 * Fire the reminders whose lead time has just elapsed.
 *
 * Exported so it can be unit-tested and, more importantly, so the lead can
 * compose it with the tasks module's own `scheduler.reminders` handler — see
 * the registration note at the bottom of this file.
 */
export async function runEventReminders(db: Db, now: Date = new Date()): Promise<number> {
  const due = await repo.listDueReminders(db, {
    now,
    lookbackMinutes: REMINDER_LOOKBACK_MINUTES,
    limit: REMINDER_BATCH,
  });

  let emitted = 0;
  for (const reminder of due) {
    // Visibility narrows the audience *after* the RBAC matrix has run (D4):
    // a `restricted` doctor's appointment must not push the whole family.
    let audience: NotificationAudience;
    if (reminder.visibility === 'household') {
      audience = { everyone: true };
    } else {
      const recipients = [
        ...new Set(
          [reminder.createdById, ...reminder.attendeeIds].filter((userId) =>
            canViewEvent(
              userId,
              { visibility: reminder.visibility, createdById: reminder.createdById },
              reminder.attendeeIds,
            ),
          ),
        ),
      ];
      if (recipients.length === 0) continue;
      audience = { users: recipients };
    }

    const result = await emit(db, {
      type: 'event_reminder',
      audience,
      actorId: null,
      entityType: 'event_occurrence',
      entityId: reminder.occurrenceId,
      // The whole idempotency guarantee, in one string.
      dedupeKey: `event_reminder:${reminder.occurrenceId}:${reminder.offsetMinutes}m`,
      payload: {
        title: reminder.title,
        startsAt: reminder.startsAt.toISOString(),
        localDate: reminder.localDate,
        isAllDay: reminder.isAllDay,
        offsetMinutes: reminder.offsetMinutes,
        occurrenceId: reminder.occurrenceId,
        seriesId: reminder.seriesId,
      },
    });

    if (!result.deduped) emitted += 1;
  }

  return emitted;
}

let registered = false;

export function registerEventJobs(): void {
  // Guarded: both `worker.ts` and any module importing this file for its side
  // effect would otherwise trip `registerJobHandler`'s duplicate check.
  if (registered) return;
  registered = true;

  /**
   * Nightly. Generates / refreshes / archives the yearly birthday series from
   * `users.birth_date`. Safe to run at any time and any number of times.
   */
  registerJobHandler('scheduler.birthdays', async () => {
    const result = await syncBirthdays(getDb());
    if (result.created + result.updated + result.archived > 0) {
      logger.info(result, 'birthday sync complete');
    }
  });

  /**
   * `scheduler.reminders` is deliberately NOT registered here. Tasks and events
   * share the one sweep, and `registerJobHandler` refuses a duplicate — the
   * module that loaded second used to lose the race and silently stop
   * reminding anyone. `modules/jobs.ts` now registers it once and calls both
   * sweeps, which is also the only way to guarantee neither is skipped.
   */
}

registerEventJobs();
