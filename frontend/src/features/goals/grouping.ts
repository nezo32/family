import type { GoalResponse } from '@family/shared';

/**
 * How the goal list is cut into groups, as a pure function — the same split
 * `shopping/grouping.ts` gets for aisles, and for the same reason: it is the
 * part that is worth a test.
 *
 * §D4 gives the screen two groups, «Копим» and «Собрано». Revealing the archive
 * adds a third, and it has to be a group of its own: before this, an archived
 * goal was rendered under the «КОПИМ» heading, counted in its badge and added
 * into «Накоплено» — a goal wearing the words «В архиве» while the heading over
 * it said the family is still saving for it. Measured on the goals screen with
 * one archived goal: «КОПИМ 3» and «3 цели в работе», for two live goals.
 *
 * So the archive is history and history is counted nowhere: `summarised` is the
 * set the display figure and the counts come from, and it never changes when
 * the archive is toggled.
 */

/** Reached: the server says so, or the balance says so. */
export function isGoalReached(goal: GoalResponse): boolean {
  return goal.status === 'reached' || goal.currentAmount >= goal.targetAmount;
}

/**
 * Archived *or* cancelled. Both are opt-in on the server (`includeArchived`
 * widens the status filter from `['active','reached']` to everything), so both
 * are what «Показать архив» reveals and neither may sit in a live group.
 */
export function isGoalArchived(goal: GoalResponse): boolean {
  return goal.status === 'archived' || goal.status === 'cancelled';
}

export interface GoalGroups {
  /** «Копим» */
  open: GoalResponse[];
  /** «Собрано» */
  reached: GoalResponse[];
  /** «В архиве» — only ever non-empty while the archive is shown. */
  archived: GoalResponse[];
  /** Goals the «Накоплено» block speaks for: everything but the archive. */
  summarised: GoalResponse[];
  /** Sum of `currentAmount` over {@link GoalGroups.summarised}. */
  totalSaved: number;
}

export function groupGoals(goals: readonly GoalResponse[]): GoalGroups {
  const open: GoalResponse[] = [];
  const reached: GoalResponse[] = [];
  const archived: GoalResponse[] = [];

  for (const goal of goals) {
    // Archived first: a goal can be both full and put away, and "put away"
    // wins — otherwise revealing the archive silently grows «Собрано».
    if (isGoalArchived(goal)) archived.push(goal);
    else if (isGoalReached(goal)) reached.push(goal);
    else open.push(goal);
  }

  const summarised = [...open, ...reached];
  return {
    open,
    reached,
    archived,
    summarised,
    totalSaved: summarised.reduce((sum, goal) => sum + goal.currentAmount, 0),
  };
}
