import type { Permission } from '@family/shared';

/**
 * The authenticated caller, as the chores services need it.
 *
 * Lives in its own file so `swaps.service.ts` and `chores.service.ts` can both
 * depend on it without importing each other. It used to hang off
 * `points.service.ts`, which no longer exists: the points ledger was removed
 * outright (D5) and nothing replaced it.
 */
export interface ChoreActor {
  readonly id: string;
  readonly displayName: string;
  can(permission: Permission): boolean;
}
