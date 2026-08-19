import { getDb } from '../core/db.js';
import { logger } from '../core/logger.js';
import { registerJobHandler } from '../core/queue/workers.js';

/**
 * Background-job registration barrel.
 *
 * Modules register their handlers with `registerJobHandler` as a side effect of
 * being imported. `startWorkers()` only spins up the BullMQ workers — it does
 * not know which handlers exist — so this barrel must be imported **before**
 * it, or jobs would be enqueued and then fail with "no handler registered".
 *
 * Owned by the lead. Add a line here when a module grows a `*.jobs.ts`.
 */
export async function registerAllJobHandlers(): Promise<void> {
  const [tasks, events] = await Promise.all([
    import('./tasks/tasks.jobs.js'),
    import('./events/events.jobs.js'),
    import('./chores/chores.jobs.js'),
    import('./notifications/notifications.jobs.js'),
    import('./dashboard/dashboard.jobs.js'),
  ]);

  registerSharedReminderSweep(tasks.runTaskReminders, events.runEventReminders);
}

/**
 * Tasks and events both need "remind me shortly before this happens", and they
 * share one queue name. `registerJobHandler` refuses a duplicate, so if each
 * module registered its own the loser of the import race would silently stop
 * reminding anyone — the worst possible failure mode for a reminder feature,
 * because nothing errors and nobody notices until an appointment is missed.
 *
 * So neither module registers it. Both export their sweep and this is the one
 * place that composes them.
 */
function registerSharedReminderSweep(
  runTaskReminders: (db: ReturnType<typeof getDb>) => Promise<number>,
  runEventReminders: (db: ReturnType<typeof getDb>) => Promise<number>,
): void {
  registerJobHandler('scheduler.reminders', async () => {
    const db = getDb();

    // `allSettled`, not `all`: a failure in one domain must not cost the other
    // its reminders. Both sweeps are idempotent, so the retry is harmless.
    const [tasks, events] = await Promise.allSettled([
      runTaskReminders(db),
      runEventReminders(db),
    ]);

    if (tasks.status === 'rejected') logger.error({ err: tasks.reason }, 'task reminder sweep failed');
    if (events.status === 'rejected')
      logger.error({ err: events.reason }, 'event reminder sweep failed');

    const emitted =
      (tasks.status === 'fulfilled' ? tasks.value : 0) +
      (events.status === 'fulfilled' ? events.value : 0);
    if (emitted > 0) logger.info({ emitted }, 'reminders emitted');

    // Surface a partial failure to BullMQ so it retries rather than recording
    // a clean run that quietly skipped half the family's reminders.
    if (tasks.status === 'rejected' || events.status === 'rejected') {
      throw new Error('reminder sweep partially failed');
    }
  });
}
