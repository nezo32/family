import { z } from 'zod';

/**
 * The change feed — per-domain revision counters (D12,
 * `docs/architecture/sync.md`).
 *
 * `GET /api/changes` answers with one integer per domain. The client remembers
 * the map it last saw, compares, and invalidates the query keys belonging to
 * whichever domains moved. There is no cursor, no log and no event payload: a
 * counter *is* the catch-up, which is what makes resume after an hour in the
 * background exact and free.
 *
 * ## Why this list lives here
 *
 * The domain names are the contract between the route-prefix table on the
 * server (`backend/src/core/plugins/revisions.ts`) and the query-key map on the
 * client (`frontend/src/shared/sync/change-feed.ts`). Both sides index by these
 * strings, so a rename that only lands on one side would silently stop syncing
 * one section of the app — the kind of bug nobody notices for a month. Keeping
 * the tuple in `@family/shared` makes that a compile error instead.
 *
 * ## `settings` is deliberately absent
 *
 * Sign-in methods, push device rows, notification preferences and quiet hours
 * are changed by you, on the device in your hand, and the mutation's own
 * `onSettled` already invalidates them. A domain for syncing your own settings
 * between your phone and your laptop is machinery for a thing nobody asked for.
 *
 * `dashboard` is not a domain either: the «Сегодня» screen is a *view* over five
 * domains and is invalidated by all of them, on the client.
 */
export const CHANGE_DOMAINS = [
  /** Task series & occurrences, chores, rotations, swaps, fairness. */
  'tasks',
  /** Event series & occurrences, attendees, RSVP. */
  'events',
  /** Savings goals, milestones, transactions. */
  'goals',
  /** Lists, items, product catalog. */
  'shopping',
  /** Posts, comments, reactions, polls, kudos, activity log. */
  'wall',
  /** Users, roster, approvals, avatars, own profile. */
  'members',
  /** The in-app inbox and unread count. */
  'notifications',
] as const;

export const changeDomainSchema = z.enum(CHANGE_DOMAINS);
export type ChangeDomain = z.infer<typeof changeDomainSchema>;

/**
 * A counter. Monotonic in practice, but the client compares with `!==` rather
 * than `>`: if Redis is ever rebuilt the counters restart at 1, which is
 * *lower* than what the clients hold and still means "refetch".
 */
export const revisionSchema = z.number().int().nonnegative();

/**
 * The revision map, **partial by design**.
 *
 * A domain the caller may not read is omitted entirely — a child never learns
 * that the goals domain moved, and never invalidates a query it is not allowed
 * to run (D4: the server decides, the client does not re-derive). "Absent" must
 * therefore never be read as "reset to 0", and the type has to say so.
 *
 * Written as an object with optional keys rather than
 * `z.record(changeDomainSchema, …)`. Both infer the same partial type, but the
 * record renders into OpenAPI with all seven properties marked **required** —
 * so the generated documentation would state the opposite of the contract, and
 * a client generated from it would type `rev.goals` as a number that is in fact
 * sometimes absent. This form generates what it means.
 */
export const revisionMapSchema = z
  .object({
    tasks: revisionSchema,
    events: revisionSchema,
    goals: revisionSchema,
    shopping: revisionSchema,
    wall: revisionSchema,
    members: revisionSchema,
    notifications: revisionSchema,
  })
  .partial();
export type RevisionMap = z.infer<typeof revisionMapSchema>;

export const changesResponseSchema = z.object({ rev: revisionMapSchema });
export type ChangesResponse = z.infer<typeof changesResponseSchema>;
