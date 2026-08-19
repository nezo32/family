import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, emptyJsonObject, primaryId, timestamps } from '../../db/base.js';
import { users } from './users.schema.js';

/**
 * Identity & access tables.
 *
 * `users` itself lives in `users.schema.ts` (owned by the lead). This file adds
 * everything that hangs off it: the OAuth identity links, the server-side OAuth
 * transaction store, the refresh-token family ledger, the singleton family
 * configuration row and the append-only audit log.
 */

/**
 * `password` is a first-class provider: it is one of the login methods the
 * unlink guard counts, so it has to be enumerable alongside the OAuth ones even
 * though the credential itself lives in `users.password_hash`.
 */
export const authProvider = pgEnum('auth_provider', ['google', 'telegram', 'password']);

/* -------------------------------------------------------------------------- */
/* user_identities                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One row per (user, provider) link.
 *
 * Per D3 the join key is **always `(provider, provider_user_id)`** — the
 * provider's stable subject id. Email is never a key: Google addresses get
 * recycled inside Workspace domains and Telegram has no email at all. There is
 * deliberately no unique index on `provider_email`.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: primaryId(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    provider: authProvider().notNull(),

    /** The provider's stable subject (`sub` for OIDC, numeric id for Telegram). */
    providerUserId: text().notNull(),

    /** Snapshot only — never used to find or merge accounts. */
    providerEmail: text(),
    providerEmailVerified: boolean().notNull().default(false),

    /** Telegram handle. Mutable on the provider side, so display-only. */
    providerUsername: text(),

    /** The provider's snapshot of the human's name. Display-only. */
    providerDisplayName: text(),

    providerAvatarUrl: text(),

    /**
     * The remaining claims, for debugging and future profile enrichment.
     * **Strip every credential before writing**: no `access_token`,
     * `refresh_token`, `id_token`, `code` or `client_secret` may land here.
     */
    rawProfile: jsonb().$type<Record<string, unknown>>().notNull().default(emptyJsonObject),

    linkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp({ withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    /** The identity join key. Two users can never claim the same provider subject. */
    uniqueIndex('user_identities_provider_subject_uq').on(t.provider, t.providerUserId),
    /** One link per provider per user — linking Google is idempotent, not additive. */
    uniqueIndex('user_identities_user_provider_uq').on(t.userId, t.provider),
    // No standalone user_id index: the unique btree above leads with user_id and
    // already serves "all identities of this user" lookups.
  ],
);

export type UserIdentityRow = typeof userIdentities.$inferSelect;
export type NewUserIdentityRow = typeof userIdentities.$inferInsert;

/* -------------------------------------------------------------------------- */
/* oauth_transactions                                                          */
/* -------------------------------------------------------------------------- */

export type OAuthIntent = 'login' | 'link';

/**
 * The server-side OAuth state store (D3, non-negotiable).
 *
 * `state` is the primary key: it is already a high-entropy random string, it is
 * the value the provider echoes back, and making it the PK means the callback is
 * a single point lookup with no secondary index. This table is the one
 * deliberate exception to the "every table has a uuid `id`" convention.
 *
 * Rows have a 10-minute TTL and are **deleted on use** (`DELETE ... RETURNING`),
 * which makes the delete itself the single-use guard against replay.
 *
 * Why a table and not a cookie: the provider fallbacks that arrive as cross-site
 * POSTs would never see a `SameSite=Lax` cookie, so a cookie store fails in
 * production only — exactly where it must not.
 */
export const oauthTransactions = pgTable(
  'oauth_transactions',
  {
    /** The `state` parameter. High-entropy random, single use. */
    state: text().primaryKey(),

    provider: authProvider().notNull(),

    /** Replayed into the OIDC request and compared against the id_token claim. */
    nonce: text().notNull(),

    /** PKCE verifier. Nullable — not every provider supports PKCE. */
    codeVerifier: text(),

    /**
     * `login` starts a new session; `link` attaches this provider to the already
     * authenticated `link_user_id`. Kept as text + `$type` rather than a pgEnum
     * so adding a future intent is a code change, not a migration.
     */
    intent: text().$type<OAuthIntent>().notNull().default('login'),

    /** Set only when `intent = 'link'`. The session that started the flow. */
    linkUserId: uuid().references(() => users.id, { onDelete: 'cascade' }),

    /** Same-origin relative path to send the browser to after success. */
    redirectAfter: text(),

    ...createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    /** Sweep job: `DELETE FROM oauth_transactions WHERE expires_at < now()`. */
    index('oauth_transactions_expires_at_idx').on(t.expiresAt),
    index('oauth_transactions_link_user_idx').on(t.linkUserId),
  ],
);

export type OAuthTransactionRow = typeof oauthTransactions.$inferSelect;
export type NewOAuthTransactionRow = typeof oauthTransactions.$inferInsert;

/* -------------------------------------------------------------------------- */
/* refresh_tokens                                                              */
/* -------------------------------------------------------------------------- */

export type RefreshRevokeReason = 'rotated' | 'reuse' | 'logout' | 'admin' | 'status_change';

/**
 * Rotating refresh tokens with family-wide reuse detection (D3).
 *
 * A *family* is one login session on one device. Every rotation writes a new row
 * carrying the same `family_id` and `generation + 1`, and marks the presented
 * row `used_at` / `revoked_at` with reason `rotated`. Presenting an already-used
 * row after the 20-second grace window means the cookie leaked: revoke the whole
 * family.
 *
 * The raw token never touches this table — only `sha256(raw)`. A database dump
 * therefore does not hand the reader a set of usable sessions.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: primaryId(),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** One login session. Shared by every generation in the rotation chain. */
    familyId: uuid().notNull().defaultRandom(),

    /** Hex SHA-256 of the 32 random bytes handed to the client. Never the raw token. */
    tokenHash: text().notNull(),

    /**
     * The row this one rotated from. Intentionally **not** a foreign key: the
     * cleanup job prunes old generations, and a real FK would either block that
     * or cascade-delete the live token at the head of the chain.
     */
    prevTokenId: uuid(),

    /** Position in the rotation chain. Useful for spotting runaway refresh loops. */
    generation: integer().notNull().default(0),

    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),

    /**
     * First presentation. Within 20 s of this instant a re-presentation is a
     * benign concurrent refresh (React StrictMode, multiple PWA tabs, iOS
     * resume) and replays the successor instead of nuking the family.
     */
    usedAt: timestamp({ withTimezone: true }),

    revokedAt: timestamp({ withTimezone: true }),
    revokedReason: text().$type<RefreshRevokeReason>(),

    /** Diagnostics for the active-sessions screen. Never used for auth decisions. */
    userAgent: text(),
    ip: text(),
  },
  (t) => [
    /** The lookup on every refresh, and the guarantee that a hash is one row. */
    uniqueIndex('refresh_tokens_token_hash_uq').on(t.tokenHash),
    /** Reuse detection: revoke every row of the compromised family at once. */
    index('refresh_tokens_family_idx').on(t.familyId),
    /** Log out everywhere, and the status-change revoke-all. */
    index('refresh_tokens_user_idx').on(t.userId),
    /** Cleanup job: `DELETE FROM refresh_tokens WHERE expires_at < now()`. */
    index('refresh_tokens_expires_at_idx').on(t.expiresAt),
    /**
     * Partial index over the small live subset — the active-session list and the
     * bulk revoke both filter on it, and it stays tiny while the table grows one
     * row per rotation.
     */
    index('refresh_tokens_live_idx')
      .on(t.userId, t.familyId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type NewRefreshTokenRow = typeof refreshTokens.$inferInsert;

/* -------------------------------------------------------------------------- */
/* family_settings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The singleton family configuration row (D1).
 *
 * `singleton` is a boolean that is always `true`, carrying a unique index and a
 * CHECK constraint. Together they make a second row impossible at the database
 * level, so reads can be an unconditional `SELECT ... LIMIT 1` and writes an
 * upsert on the unique index — no "which row is the real one" logic anywhere.
 */
export const familySettings = pgTable(
  'family_settings',
  {
    id: primaryId(),

    /** Always `true`. See the unique index + check constraint below. */
    singleton: boolean().notNull().default(true),

    familyName: text().notNull().default('Семья'),

    /** IANA id. The default timezone every user and every series inherits. */
    timezone: text().notNull().default('Europe/Moscow'),

    /** ISO-8601 weekday number: 1 = Monday. Drives the calendar grid. */
    weekStartsOn: integer().notNull().default(1),

    /** ISO-4217. Display only — amounts are integer minor units (D6). */
    currency: text().notNull().default('RUB'),

    /**
     * Quiet hours as local wall-clock `HH:mm` in `timezone`. The window wraps
     * midnight when start > end. Notifications inside it are **deferred to the
     * end of the window, never dropped** (D10).
     */
    quietHoursStart: text().notNull().default('22:00'),
    quietHoursEnd: text().notNull().default('07:30'),

    /**
     * When false, `/auth/register` and OAuth `intent=login` for an unknown
     * subject are rejected outright — no `pending_approval` row is created.
     */
    allowRegistration: boolean().notNull().default(true),

    ...timestamps(),
  },
  (t) => [
    uniqueIndex('family_settings_singleton_uq').on(t.singleton),
    check('family_settings_singleton_ck', sql`${t.singleton}`),
  ],
);

export type FamilySettingsRow = typeof familySettings.$inferSelect;
export type NewFamilySettingsRow = typeof familySettings.$inferInsert;

/* -------------------------------------------------------------------------- */
/* audit_log                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Append-only administrative trail. Never updated, never deleted by application
 * code — a retention sweep is the only writer that removes rows.
 *
 * `actor_id` is `ON DELETE SET NULL` rather than cascade: deleting a user must
 * not erase the record of what that user did. `target_type` / `target_id` are a
 * loose polymorphic pointer on purpose — a real FK per target type would couple
 * this table to every module in the app.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),

    /** NULL for system-originated actions (jobs, migrations, the seed). */
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),

    /** `<resource>:<action>`, e.g. `member:approve`, `identity:unlink`. */
    action: text().notNull(),

    targetType: text(),
    targetId: uuid(),

    /**
     * Action-specific detail: the before/after of a role change, the rejection
     * reason, the provider that was unlinked. **No secrets, no tokens.**
     */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default(emptyJsonObject),

    ip: text(),
    userAgent: text(),

    ...createdAt(),
  },
  (t) => [
    /** The default view: the whole log, newest first. */
    index('audit_log_created_at_idx').on(t.createdAt.desc()),
    /** What did this member do, newest first. */
    index('audit_log_actor_created_at_idx').on(t.actorId, t.createdAt.desc()),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
