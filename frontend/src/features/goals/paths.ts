import { ROUTES } from '@/shared/lib/routes';

/**
 * Paths owned by this feature.
 *
 * Derived from `ROUTES.goals` rather than hardcoded, so renaming the section
 * stays a one-line change in `shared/lib/routes.ts` (which this feature does
 * not own). The detail route itself has to be registered in `app/router.tsx`
 * as a child of `/goals` — see the note in the final report.
 */
export function goalDetailPath(goalId: string): string {
  return `${ROUTES.goals}/${goalId}`;
}
