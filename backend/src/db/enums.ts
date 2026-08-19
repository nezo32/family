import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Cross-domain Postgres enums.
 *
 * A `pgEnum` name is global to the database, so a type used by more than one
 * module MUST be declared exactly once — declaring it twice produces two
 * conflicting `CREATE TYPE` statements and a duplicate export in the schema
 * barrel. Anything shared between modules belongs here; anything owned by a
 * single module stays in that module's own schema file.
 */

/**
 * Who can see a record.
 *
 * - `household` — every active family member.
 * - `private`   — the creator (and, for goals, the owner) only.
 * - `restricted`— an explicit participant list, e.g. `event_attendees`.
 */
export const visibility = pgEnum('visibility', ['household', 'private', 'restricted']);

export type Visibility = (typeof visibility.enumValues)[number];
