import { sql } from 'drizzle-orm';
import { bigint, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column builders. `drizzle.config.ts` sets `casing: 'snake_case'`, so
 * unnamed builders map to snake_case DB columns automatically.
 */

/** Primary key used by every table. */
export const primaryId = () => uuid().primaryKey().defaultRandom();

/** `created_at` / `updated_at`. Spread into a table definition. */
export const timestamps = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** `created_at` only, for append-only tables (ledgers, logs, deliveries). */
export const createdAt = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Soft-delete marker. Prefer this over hard deletes for user-visible content. */
export const softDelete = () => ({
  deletedAt: timestamp({ withTimezone: true }),
});

/**
 * Money. Always integer **minor units** (копейки) — never a float, never a
 * decimal we do arithmetic on in JS. `mode: 'number'` is safe here: JS integers
 * are exact to 2^53, i.e. ~90 trillion roubles.
 */
export const money = () => bigint({ mode: 'number' });

/** A `text[]` column defaulting to the empty array rather than NULL. */
export const emptyTextArray = sql`'{}'::text[]`;

/** A `jsonb` column defaulting to `{}`. */
export const emptyJsonObject = sql`'{}'::jsonb`;
