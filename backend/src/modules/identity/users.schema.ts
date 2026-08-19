import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { emptyTextArray, primaryId, timestamps } from '../../db/base.js';

/**
 * The root table of the whole application.
 *
 * Per decision D1 this app is **single-tenant**: there is no `households` table
 * and no separate `members` table. Everything that would have been membership
 * state (role, status, rotation weight, permission overrides) lives here.
 *
 * This file is owned by the lead and referenced by every other module. Add
 * columns here only for attributes that are genuinely part of "who this person
 * is"; anything module-specific belongs in that module's own table.
 */

export const userRole = pgEnum('user_role', [
  'owner',
  'admin',
  'adult',
  'teen',
  'child',
  'guest',
]);

/**
 * Registration is admin-gated (D3). A `pending_approval` user is created but is
 * never issued a session of any kind.
 */
export const userStatus = pgEnum('user_status', [
  'pending_approval',
  'active',
  'rejected',
  'suspended',
]);

export const users = pgTable(
  'users',
  {
    id: primaryId(),

    /** Nullable — Telegram never gives us an email. */
    email: text(),
    emailVerified: boolean().notNull().default(false),

    displayName: text().notNull(),
    avatarUrl: text(),

    /** Argon2id. NULL => this user has no password login method. */
    passwordHash: text(),

    role: userRole().notNull().default('child'),
    status: userStatus().notNull().default('pending_approval'),

    /** Per-user RBAC overrides on top of the role matrix. Denies win (D4). */
    permissionGrants: text().array().notNull().default(emptyTextArray),
    permissionDenies: text().array().notNull().default(emptyTextArray),

    /** Drives birthday events and the default chore-rotation weight. */
    birthDate: date(),
    /** NULL => inherit `family_settings.timezone`. */
    timezone: text(),
    /** BCP-47 tag. The UI is Russian; this exists for date/number formatting. */
    locale: text().notNull().default('ru-RU'),

    /**
     * Chore-rotation capacity multiplier. 1.00 = a full-share adult, 0.40 = a
     * young child, 0.00 = temporarily excused. See D5.
     */
    choreWeight: numeric({ precision: 4, scale: 2 }).notNull().default('1.00'),

    /** Display ordering in member lists and rotation tie-breaks. */
    sortOrder: integer().notNull().default(0),

    /** Short accent colour (hex) used for avatars and calendar chips. */
    color: text(),

    approvedAt: timestamp({ withTimezone: true }),
    approvedById: uuid(),
    rejectedReason: text(),

    lastSeenAt: timestamp({ withTimezone: true }),
    lastLoginAt: timestamp({ withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    /**
     * Case-insensitive uniqueness, partial so that the many NULL emails of
     * Telegram-only users do not collide.
     */
    uniqueIndex('users_email_lower_uq')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    index('users_status_idx').on(t.status),
    index('users_role_idx').on(t.role),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
