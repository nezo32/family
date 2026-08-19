import type { Db } from '../../core/db.js';
import { getDb } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { registerJobHandler } from '../../core/queue/workers.js';
import {
  emit,
  type NotificationAudience,
} from '../notifications/notifications.service.js';
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
 * | `scheduler.reminders` | `dedupe_key = task_due_soon:<occurrenceId>:<lead>m` |
 *
 * Note what the overdue sweep does **not** do: it never writes a status, a flag
 * or a column. Overdue is derived on read (§4); this job only decides whom to
 * tell, and the intent's dedupe key is what makes "tell them once" true even
 * though the job runs every fifteen minutes and a task stays overdue for days.
 */

/**
 * How far ahead "скоро срок" looks.
 *
 * `task_series` carries no per-series reminder offsets (unlike `event_series`,
 * which has `reminder_offsets`), so tasks get one family-wide lead time. The
 * window is the full lead rather than one sweep interval on purpose: after a
 * worker outage the next pass still catches everything it missed, and the
 * dedupe key stops the overlap from re-notifying.
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
        points: occurrence.points,
        assigneeId: occurrence.assigneeId,
        seriesId: occurrence.seriesId,
        occurrenceId: occurrence.id,
      },
    });
    if (!result.deduped) emitted += 1;
  }

  return emitted;
}

/** "Скоро срок" — one notification per occurrence per lead time. */
export async function runTaskReminders(db: Db, now = new Date()): Promise<number> {
  const to = new Date(now.getTime() + TASK_REMINDER_LEAD_MINUTES * 60_000);
  const due = await repo.findDueBetween(db, { from: now, to, limit: SWEEP_LIMIT });

  let emitted = 0;
  for (const occurrence of due) {
    // An unassigned task has nobody to remind — reminding the whole family
    // about work nobody has taken is noise, and the overdue sweep will still
    // surface it if it goes undone.
    if (occurrence.assigneeId === null) continue;

    const result = await emit(db, {
      type: 'task_due_soon',
      audience: { users: [occurrence.assigneeId] },
      actorId: null,
      entityType: 'task_occurrence',
      entityId: occurrence.id,
      dedupeKey: `task_due_soon:${occurrence.id}:${TASK_REMINDER_LEAD_MINUTES}m`,
      payload: {
        title: occurrence.title,
        dueAt: occurrence.dueAt.toISOString(),
        localDate: occurrence.localDate,
        leadMinutes: TASK_REMINDER_LEAD_MINUTES,
        seriesId: occurrence.seriesId,
        occurrenceId: occurrence.id,
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
    }
  });

  /** Every fifteen minutes. Emits at most one intent per overdue occurrence. */
  registerJobHandler('scheduler.overdue-sweep', async () => {
    const emitted = await runOverdueSweep(getDb());
    if (emitted > 0) logger.info({ emitted }, 'task overdue intents emitted');
  });

  /**
   * Every five minutes.
   *
   * **Note for the lead:** `scheduler.reminders` is one queue name shared with
   * the events module, and `registerJobHandler` refuses a duplicate — whichever
   * module loads second would crash the worker at boot. So this registration is
   * guarded exactly as `events.jobs.ts` guards its own, and both modules export
   * their sweep (`runTaskReminders` here, `runEventReminders` there). The fix is
   * one handler, in one place, calling both; until then whichever module loses
   * the race is silently not reminding anyone, which is why this logs loudly.
   */
  try {
    registerJobHandler('scheduler.reminders', async () => {
      const emitted = await runTaskReminders(getDb());
      if (emitted > 0) logger.info({ emitted }, 'task reminders emitted');
    });
  } catch (err) {
    logger.warn(
      { err },
      'scheduler.reminders already has a handler — call runTaskReminders() from it',
    );
  }
}

registerTaskJobs();
