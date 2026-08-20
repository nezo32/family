/**
 * The «Сегодня» contract.
 *
 * TODO(contract): these types are the real schemas from
 * `packages/shared/src/contracts/dashboard.ts` — nothing here is redeclared.
 * They are imported through the package's `./contracts/*` subpath because
 * `packages/shared/src/index.ts` does not re-export the dashboard module yet
 * and the barrel is owned by the lead. **When that one line lands, change the
 * import below to `@family/shared` and delete this note**; every consumer in
 * the feature imports from this file precisely so that stays a one-line edit.
 */
export type {
  DashboardEvent,
  DashboardEvents,
  DashboardFairness,
  DashboardLoadMember,
  DashboardMilestone,
  DashboardPendingMember,
  DashboardShopping,
  DashboardShoppingItem,
  DashboardTask,
  DashboardTasks,
  DashboardWeekDay,
  TodayResponse,
  WeekQuery,
  WeekResponse,
} from '@family/shared/contracts/dashboard';
