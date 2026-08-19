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
  await Promise.all([
    import('./notifications/notifications.jobs.js'),
    // Enabled as each module lands:
    // import('./tasks/tasks.jobs.js'),
    // import('./events/events.jobs.js'),
    import('./chores/chores.jobs.js'),
    // import('./dashboard/dashboard.jobs.js'),
  ]);
}
