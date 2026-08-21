import type { Db } from '../../core/db.js';
import { getDb } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import { bumpRevisions } from '../../core/revisions.js';
import { emit, type NotificationAudience } from '../notifications/notifications.service.js';
import * as repo from './tasks.repository.js';
import { TasksService } from './tasks.service.js';

/**
 * Background work for tasks (`scheduling.md` §2 and §4).
 *
 * Four sweeps, and the thing they all have in common is that **running one
 * twice must be indistinguishable from running it once**. A BullMQ job is
 * retried on failure, the worker can be restarted mid-pass, and two workers can
 * overlap; none of that may double-notify a family or double-award a point.
 * Each sweep below states which mechanism gives it that property:
 *
 * | job | idempotency comes from |
 * |---|---|
 * | `scheduler.materialize-all` | `UNIQUE (series_id, occurrence_key)` + `DO NOTHING` |
 * | auto-cancel (same job) | `WHERE status = 'scheduled'` — a cancelled row is not re-cancelled |
 * | `scheduler.overdue-sweep` | `notification_intents.dedupe_key = task_overdue:<occurrenceId>` |
 * | `scheduler.reminders` (ahead)    | `dedupe_key = task_due_soon:<occurrenceId>:<offset>m` |
 * | `scheduler.reminders` (at start) | `dedupe_key = task_started:<occurrenceId>` |
 *
 * Note what the overdue sweep does **not** do: it never writes a status, a flag
 * or a column. Overdue is derived on read (§4); this job only decides whom to
 * tell, and the intent's dedupe key is what makes "tell them once" true even
 * though the job runs every fifteen minutes and a task stays overdue for days.
 */

/**
 * How far back a reminder sweep will look for lead times it missed.
 *
 * The sweep runs every five minutes and looks back thirty, so its window
 * overlaps itself six times over. That is deliberate — a worker restart, a
 * retry, or a few minutes of Redis being unreachable must not lose a reminder
 * — and the dedupe key is the only thing that makes the overlap safe. Same
 * number, same reasoning, as `events.jobs.REMINDER_LOOKBACK_MINUTES`.
 *
 * It is also the bound on lateness: a reminder whose moment passed more than
 * half an hour ago is not sent at all. A push about a chore that started
 * yesterday is noise, and D10's real failure mode is fatigue.
 */
export const REMINDER_LOOKBACK_MINUTES = 30;

/**
 * Retained so the shape of the key does not change for anything already
 * notified. Before per-series offsets existed, every assigned task got exactly
 * one reminder an hour before its `dueAt`, keyed
 * `task_due_soon:<occurrenceId>:60m`. A series that now carries `{60}` produces
 * the identical key, so nothing that has already been told is told twice.
 */
export const TASK_REMINDER_LEAD_MINUTES = 60;

/** Series scanned by one materialization pass. */
const MATERIALIZE_LIMIT = 500;

/** Occurrences notified about in one sweep. */
const SWEEP_LIMIT = 200;

function audienceFor(assigneeId: string | null): NotificationAudience {
  // An unassigned overdue chore is nobody's and therefore everybody's; the
  // fan-out drops anyone who cannot read it, so a broad audience is safe.
  return assigneeId === null ? { everyone: true } : { users: [assigneeId] };
}

/* -------------------------------------------------------------------------- */
/* The sweeps                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Extend the rolling 90-day horizon, then trim.
 *
 * Materialization and trimming are one job because they are two halves of the
 * same maintenance pass (§2): the first adds the far edge of the window, the
 * second retires the stale near edge. Each series is materialized in its own
 * transaction, so one malformed rule cannot roll back the family's calendar.
 */
export async function runMaterializeAll(
  db: Db,
  now = new Date(),
): Promise<{ series: number; inserted: number; cancelled: number }> {
  const service = new TasksService(db, { now: () => now });

  const results = await service.materializeAll({ now, limit: MATERIALIZE_LIMIT });
  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);

  // Opt-in per series: a NULL `auto_cancel_after_days` means the task nags
  // forever, which is the right default for "заплатить за садик".
  const cancelled = await service.autoCancelStale(now);

  return { series: results.length, inserted, cancelled };
}

/**
 * The auto-cancel sweeper on its own, for an admin repair route or a test.
 *
 * A swept row becomes `cancelled`, never deleted — the history of a fortnight
 * of un-done dishes belongs to whoever did not do them.
 */
export async function runAutoCancel(db: Db, now = new Date()): Promise<number> {
  return new TasksService(db, { now: () => now }).autoCancelStale(now);
}

/**
 * Tell people about tasks that are past their deadline.
 *
 * The query is the derived predicate `status = 'scheduled' AND due_at + grace <
 * now`, shaped so the partial index `task_occurrences_overdue_idx` drives it.
 * Nothing is written back to the occurrence: the *only* side effect is at most
 * one `task_overdue` intent per occurrence, forever, courtesy of the dedupe key.
 */
export async function runOverdueSweep(db: Db, now = new Date()): Promise<number> {
  const overdue = await repo.findOverdue(db, { now, limit: SWEEP_LIMIT });

  let emitted = 0;
  for (const occurrence of overdue) {
    const result = await emit(db, {
      type: 'task_overdue',
      audience: audienceFor(occurrence.assigneeId),
      actorId: null,
      entityType: 'task_occurrence',
      entityId: occurrence.id,
      // Once per occurrence, ever. Not per sweep, not per day: a task that is
      // three days late has been late since the first notification, and
      // repeating it every fifteen minutes is how a family mutes the app.
      dedupeKey: `task_overdue:${occurrence.id}`,
      payload: {
        title: occurrence.title,
        dueAt: occurrence.dueAt.toISOString(),
        localDate: occurrence.localDate,
        assigneeId: occurrence.assigneeId,
        seriesId: occurrence.seriesId,
        occurrenceId: occurrence.id,
      },
    });
    if (!result.deduped) emitted += 1;
  }

  return emitted;
}

/**
 * Who a reminder about one occurrence is for.
 *
 * The assignee, and when there is none — «Любой», which is what a chore is
 * created with by default — **whoever created the series**. That second clause
 * is load-bearing: the create sheet defaults «Кто» to «Любой», so the ordinary
 * «вынести мусор, сегодня в 21:00» has no assignee at all, and the rule this
 * replaces (`if (assigneeId === null) continue`) would have made the
 * notification the owner asked to be unremovable apply to almost nothing.
 *
 * Not `{ everyone: true }`, which is what the overdue sweep does. Overdue is a
 * problem the household shares; a chore starting on time is one person's
 * business, and telling five people about it every evening is the fatigue D10
 * exists to prevent.
 */
function reminderAudience(reminder: repo.DueTaskReminder): NotificationAudience {
  return { users: [reminder.assigneeId ?? reminder.seriesCreatedById] };
}

/**
 * Both halves of "напоминания о деле", in one pass.
 *
 * 1. **Ahead of time**, once per `(occurrence, offset)` in the series'
 *    `reminder_offsets` — «за час», «за день», whatever the family chose.
 *    Optional, and empty by default.
 * 2. **At the start**, once per occurrence, always. It is not an offset and it
 *    is not in that array, so no edit can remove it; see the note on
 *    `taskSeries.reminderOffsets` and on `task_started` in the shared contract.
 *
 * "Mandatory" stops there, and stops there deliberately. `task_started` is
 * `normal` priority, so quiet hours still apply to it — and D10 says quiet
 * hours **defer**, they do not drop, so the notification arrives when the
 * window ends rather than at 03:00. The only priority that overrides a quiet
 * window is `critical`, which would also skip the hourly push cap and open a
 * ten-minute escalation chain to another adult. A family woken once by a chore
 * turns notifications off wholesale, and «дать лекарство в 20:00» goes with it.
 *
 * Both halves dedupe on a key naming the occurrence and the lead, so the
 * five-minute cron overlapping its own thirty-minute window six times over
 * tells someone once.
 */
export async function runTaskReminders(db: Db, now = new Date()): Promise<number> {
  const [ahead, starting] = await Promise.all([
    repo.listDueReminders(db, {
      now,
      lookbackMinutes: REMINDER_LOOKBACK_MINUTES,
      limit: SWEEP_LIMIT,
    }),
    repo.listStartedSince(db, {
      now,
      lookbackMinutes: REMINDER_LOOKBACK_MINUTES,
      limit: SWEEP_LIMIT,
    }),
  ]);

  let emitted = 0;

  for (const reminder of ahead) {
    const result = await emit(db, {
      type: 'task_due_soon',
      audience: reminderAudience(reminder),
      actorId: null,
      entityType: 'task_occurrence',
      entityId: reminder.occurrenceId,
      // Per occurrence *and* per offset: a series with `{1440, 60}` owes two
      // notifications, and a key without the offset would collapse them.
      dedupeKey: `task_due_soon:${reminder.occurrenceId}:${String(reminder.offsetMinutes)}m`,
      payload: {
        title: reminder.title,
        startsAt: reminder.startsAt.toISOString(),
        startsLocal: reminder.startsLocal,
        localDate: reminder.localDate,
        offsetMinutes: reminder.offsetMinutes,
        // Kept alongside the newer name: an intent written by the previous
        // build is still sitting in someone's inbox waiting to be rendered.
        leadMinutes: reminder.offsetMinutes,
        seriesId: reminder.seriesId,
        occurrenceId: reminder.occurrenceId,
      },
    });
    if (!result.deduped) emitted += 1;
  }

  for (const reminder of starting) {
    const result = await emit(db, {
      type: 'task_started',
      audience: reminderAudience(reminder),
      actorId: null,
      entityType: 'task_occurrence',
      entityId: reminder.occurrenceId,
      // No offset in the key: there is exactly one of these per occurrence,
      // ever.
      dedupeKey: `task_started:${reminder.occurrenceId}`,
      payload: {
        title: reminder.title,
        startsAt: reminder.startsAt.toISOString(),
        startsLocal: reminder.startsLocal,
        localDate: reminder.localDate,
        seriesId: reminder.seriesId,
        occurrenceId: reminder.occurrenceId,
      },
    });
    if (!result.deduped) emitted += 1;
  }

  return emitted;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

let registered = false;

/**
 * Idempotent: `registerJobHandler` throws on a duplicate name, and this module
 * is imported both by the job barrel and by anything that wants the sweeps.
 */
export function registerTaskJobs(): void {
  if (registered) return;
  registered = true;

  /** Nightly. Extends the horizon and retires stale rows. */
  registerJobHandler('scheduler.materialize-all', async () => {
    const result = await runMaterializeAll(getDb());
    if (result.inserted > 0 || result.cancelled > 0) {
      logger.info(result, 'task materialization pass complete');
      /**
       * A job's writes never pass through the HTTP `onResponse` hook, so the
       * change feed has to be told explicitly (D12, `sync.md` §4.3). Awaited,
       * not fired and forgotten: a worker may be torn down the moment its
       * handler resolves. Without this the new occurrences still appear on
       * focus and on mount, so a missing bump is a latency bug, never a
       * correctness one.
       */
      await bumpRevisions(['tasks']);
    }
  });

  /** Every fifteen minutes. Emits at most one intent per overdue occurrence. */
  registerJobHandler('scheduler.overdue-sweep', async () => {
    const emitted = await runOverdueSweep(getDb());
    if (emitted > 0) logger.info({ emitted }, 'task overdue intents emitted');
  });

  /**
   * `scheduler.reminders` is deliberately NOT registered here. Tasks and events
   * share the one sweep, and `registerJobHandler` refuses a duplicate — the
   * module that loaded second used to lose the race and silently stop
   * reminding anyone. `modules/jobs.ts` now registers it once and calls both
   * sweeps, which is also the only way to guarantee neither is skipped.
   */
}

registerTaskJobs();
