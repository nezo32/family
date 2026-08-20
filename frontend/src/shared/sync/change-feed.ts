import type { QueryKey } from '@tanstack/react-query';
import type { ChangeDomain, ChangesResponse, RevisionMap } from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * The change feed, minus React (D12, `docs/architecture/sync.md` §5.1).
 *
 * Everything here is a pure function or a constant, so the rules that matter —
 * when to poll, what counts as a change, which query keys a domain owns — are
 * testable without mounting anything. The hook in `use-change-feed.ts` is then
 * only wiring.
 */

export const changeKeys = {
  feed: () => ['changes'] as const,
};

export function fetchChanges(signal?: AbortSignal): Promise<ChangesResponse> {
  // Through the ordinary authenticated client, deliberately: a 401 mid-poll
  // goes into the single-flight refresh that already exists, and there is
  // structurally no second auth surface to race D3's token rotation.
  return api.get<ChangesResponse>('/changes', signal ? { signal } : {});
}

/** While a shopping list is on screen — the one place a tick is worth 5 seconds. */
export const LIVE_POLL_MS = 5_000;

/** Everywhere else. Every screen's target is «within 20 seconds». */
export const IDLE_POLL_MS = 15_000;

/**
 * The rate a feed that is failing falls back to.
 *
 * A missing or broken `/api/changes` — a bad deploy, a rolled-back route, Redis
 * down — must not cost the family four failing requests a minute forever. The
 * feed is an enhancement: when it cannot answer, the app keeps working on focus
 * refetching alone and the poll steps back out of the way. It steps forward
 * again on the first success, so recovery needs no reload.
 */
export const DEGRADED_POLL_MS = 60_000;

export interface PollConditions {
  /** `document.visibilityState === 'visible'`. A locked phone polls zero times. */
  visible: boolean;
  /** At least one mounted screen asked for the fast rate. */
  live: boolean;
  /** The feed has failed repeatedly; back off rather than hammer a dead route. */
  degraded?: boolean;
}

/**
 * The polling rule, as a function.
 *
 * `false` means "do not poll at all" — not "poll slowly". Locking an iPhone
 * fires `visibilitychange → hidden`, so a phone in a pocket costs the family
 * nothing; the data it missed arrives in one diff on the focus refetch.
 *
 * Backing off beats the live rate: a screen asking for 5 seconds is asking of a
 * feed that works, and there is nothing to be gained by asking a broken one
 * twelve times as often.
 */
export function pollIntervalMs(conditions: PollConditions): number | false {
  if (!conditions.visible) return false;
  if (conditions.degraded) return DEGRADED_POLL_MS;
  return conditions.live ? LIVE_POLL_MS : IDLE_POLL_MS;
}

/**
 * Which domains moved between two maps.
 *
 * Three rules, each of which has a failure mode behind it:
 *
 * - A domain **absent from `seen`** is a baseline, not a change. The first
 *   response after a cold start must invalidate nothing, or every client
 *   refetches everything the moment it opens.
 * - A domain **absent from `next`** is not a change either. It disappears when
 *   the caller's permissions narrow, and "the number went away" is not "the
 *   data moved".
 * - The comparison is `!==`, never `>`. If Redis is rebuilt the counters
 *   restart at 1 — *lower* than what this client holds — and every client must
 *   still invalidate exactly once and then be correct.
 */
export function diffRevisions(seen: RevisionMap, next: RevisionMap): ChangeDomain[] {
  const changed: ChangeDomain[] = [];
  for (const [domain, revision] of Object.entries(next) as [ChangeDomain, number][]) {
    const previous = seen[domain];
    if (previous !== undefined && previous !== revision) changed.push(domain);
  }
  return changed;
}

/**
 * Domain → the query keys it owns, using the roots each feature's `api.ts`
 * already declares.
 *
 * Notes on the three non-obvious rows:
 *
 * - `['dashboard']` is `todayKeys.all`; «Сегодня» is a view fanned in from five
 *   domains. It only costs a request when the user is actually on that screen,
 *   because everything is invalidated with `refetchType: 'active'`.
 * - `['members']` is shared by `adminKeys` and `familyKeys` (both re-declare
 *   `MEMBER_KEY_ROOT`) and `goalKeys.roster` reaches into it too. One entry
 *   covers all of them; that shared root is deliberate and this relies on it.
 * - `['me']` under `members` heals a stale *affordance* list within seconds of
 *   a role change. It does not affect enforcement, which is already immediate
 *   server-side — `resolveAuth` re-reads the row on every request.
 *
 * `['calendar']` rather than `['events']` is not a typo: the calendar feature
 * owns the events UI and names its key root `calendar`.
 *
 * The keys are written out rather than imported from the features so that this
 * module stays a leaf — a `shared/` module importing eleven feature barrels
 * would drag half the app into the poll's dependency graph.
 */
export const CHANGE_DOMAIN_KEYS: Record<ChangeDomain, readonly QueryKey[]> = {
  tasks: [['tasks'], ['dashboard']],
  events: [['calendar'], ['dashboard']],
  goals: [['goals'], ['dashboard']],
  shopping: [['shopping'], ['dashboard']],
  wall: [['wall'], ['dashboard']],
  members: [['members'], ['me'], ['dashboard']],
  notifications: [['notifications']],
};
