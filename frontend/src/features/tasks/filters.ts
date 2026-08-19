/**
 * List filter state.
 *
 * `assignee: 'me'` is deliberately a literal rather than the caller's own id:
 * `taskOccurrenceListQuerySchema` resolves it server-side, and the contract is
 * explicit that the client never guesses who it is.
 */
export type AssigneeFilter = { kind: 'all' } | { kind: 'me' } | { kind: 'user'; userId: string };

export interface TaskFilterState {
  assignee: AssigneeFilter;
  category: string | null;
  /** Completed and skipped groups are hidden by default — they are history. */
  showDone: boolean;
}

export const DEFAULT_FILTERS: TaskFilterState = {
  assignee: { kind: 'all' },
  category: null,
  showDone: false,
};
