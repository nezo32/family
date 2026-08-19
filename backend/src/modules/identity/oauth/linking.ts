import { and, eq, sql } from 'drizzle-orm';

import type { OAuthProvider } from '@family/shared';

import { getConfig } from '../../../core/config.js';
import type { Db, Executor } from '../../../core/db.js';
import { AppError } from '../../../core/errors.js';
import {
  dispatchAfterCommit,
  emitIntent,
  rolesWithPermission,
} from '../../notifications/notifications.service.js';
import { familySettings, userIdentities, type OAuthIntent } from '../identity.schema.js';
import { users, type UserRow } from '../users.schema.js';

/**
 * Identity linking — the decision table from D3 / `docs/architecture/identity.md`.
 *
 * The whole module exists to make one rule impossible to get wrong: **the join
 * key is always `(provider, provider_user_id)` and email is never a key**, in
 * either direction. Google recycles addresses inside Workspace domains, Apple
 * hands out per-app relay addresses, and Telegram has no email at all — an
 * email-keyed merge is an account-takeover primitive, not a convenience.
 *
 * `decideLinkOutcome` is pure and holds every rule. `resolveOAuthIdentity` is
 * the thin database wrapper around it. Splitting them that way is what makes the
 * table testable without a Postgres instance.
 */

/* -------------------------------------------------------------------------- */
/* profile                                                                     */
/* -------------------------------------------------------------------------- */

/** Normalized provider profile. Every provider module produces exactly this. */
export interface OAuthProfile {
  provider: OAuthProvider;
  /** The provider's stable subject. Never the email. */
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  /** Apple private relay. Never link-eligible, never a contact address. */
  isPrivateEmail: boolean;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  /** Leftover claims for debugging — credentials already stripped. */
  rawProfile: Record<string, unknown>;
}

/**
 * Keys that must never reach `user_identities.raw_profile` (identity.md §4).
 * A debugging column that quietly accumulates bearer tokens is a breach waiting
 * for its first database dump.
 */
const CREDENTIAL_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'code_verifier',
  'client_secret',
  'authorization_code',
  'hash',
  'signature',
]);

export function sanitizeRawProfile(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* decision table                                                              */
/* -------------------------------------------------------------------------- */

export type LinkConflictReason =
  /** The subject is already attached to a different user. */
  | 'identity_owned_by_another_user'
  /** This user already linked a (different) account of the same provider. */
  | 'provider_already_linked'
  /**
   * An existing user has this email. We refuse to merge: "sign in with your
   * existing method, then link from Settings".
   */
  | 'email_belongs_to_existing_user'
  /** `intent=link` arrived without an authenticated session. */
  | 'link_requires_session';

export type LinkDecision =
  | { kind: 'login'; userId: string; identityId: string }
  | { kind: 'attach'; userId: string }
  | { kind: 'create'; asOwner: boolean }
  | { kind: 'reject'; reason: 'registration_closed' }
  | { kind: 'conflict'; reason: LinkConflictReason };

export interface LinkDecisionInput {
  intent: OAuthIntent;
  /** `oauth_transactions.link_user_id` — the session that started a link flow. */
  sessionUserId: string | null;
  profile: Pick<
    OAuthProfile,
    'provider' | 'providerUserId' | 'email' | 'emailVerified' | 'isPrivateEmail'
  >;
  /** The row for `(provider, provider_user_id)`, if any. */
  existingIdentity: { id: string; userId: string } | null;
  /** The session user's existing identity for this same provider, if any. */
  sessionUserProviderIdentity: { id: string } | null;
  /** A user owning this email. Callers must pass `null` for Telegram and for relay addresses. */
  emailOwnerUserId: string | null;
  /** `family_settings.allow_registration`. */
  registrationAllowed: boolean;
  /** `BOOTSTRAP_OWNER_EMAIL` — the first sign-in with it is auto-approved as owner. */
  bootstrapOwnerEmail: string | null;
}

function sameEmail(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The whole of D3's identity resolution, as one pure function.
 *
 * Order matters and is deliberate:
 *  1. A known subject is a login. Full stop — email is never consulted, so a
 *     provider that changes or loses the email cannot orphan an account.
 *  2. An unknown subject with an authenticated `intent=link` attaches.
 *  3. An unknown subject with no session registers a **new** user in
 *     `pending_approval` — and an email collision is a refusal, never a merge.
 */
export function decideLinkOutcome(input: LinkDecisionInput): LinkDecision {
  const { intent, sessionUserId, profile, existingIdentity } = input;

  /* 1. Known subject. */
  if (existingIdentity) {
    if (intent === 'link') {
      if (!sessionUserId) return { kind: 'conflict', reason: 'link_requires_session' };
      if (existingIdentity.userId !== sessionUserId) {
        return { kind: 'conflict', reason: 'identity_owned_by_another_user' };
      }
      // Re-linking the account you already linked is a no-op, not an error.
    }
    return { kind: 'login', userId: existingIdentity.userId, identityId: existingIdentity.id };
  }

  /* 2. New subject, explicit link. */
  if (intent === 'link') {
    if (!sessionUserId) return { kind: 'conflict', reason: 'link_requires_session' };
    // UNIQUE (user_id, provider): linking a provider is idempotent, not additive.
    if (input.sessionUserProviderIdentity) {
      return { kind: 'conflict', reason: 'provider_already_linked' };
    }
    return { kind: 'attach', userId: sessionUserId };
  }

  /* 3. New subject, registration.
   *
   * NEVER auto-link on email match, even when both sides are verified. A
   * provider asserting an address is not the same as the human proving they
   * control the existing account — and Google/Apple/Telegram disagree about
   * what "verified" even means. The user signs in with their existing method
   * and links from Settings, which is an authenticated, deliberate act.
   */
  const linkEligibleEmail = profile.isPrivateEmail ? null : profile.email;
  if (linkEligibleEmail && input.emailOwnerUserId) {
    return { kind: 'conflict', reason: 'email_belongs_to_existing_user' };
  }

  if (!input.registrationAllowed) {
    // Reject before writing anything, so closed registration does not silently
    // accumulate orphan `pending_approval` rows.
    return { kind: 'reject', reason: 'registration_closed' };
  }

  return { kind: 'create', asOwner: sameEmail(linkEligibleEmail, input.bootstrapOwnerEmail) };
}

/** Maps a decision failure onto the wire error the frontend already knows how to render. */
export function linkDecisionError(
  decision: Extract<LinkDecision, { kind: 'conflict' | 'reject' }>,
): AppError {
  if (decision.kind === 'reject') {
    return new AppError('FORBIDDEN', 'Registration is currently closed');
  }
  switch (decision.reason) {
    case 'link_requires_session':
      return new AppError('UNAUTHENTICATED', 'Linking requires an authenticated session');
    case 'identity_owned_by_another_user':
      return new AppError(
        'IDENTITY_ALREADY_LINKED',
        'This provider account is already linked to another family member',
      );
    case 'provider_already_linked':
      return new AppError(
        'IDENTITY_ALREADY_LINKED',
        'This account already has an identity for that provider',
      );
    case 'email_belongs_to_existing_user':
      return new AppError(
        'IDENTITY_ALREADY_LINKED',
        'An account with this email already exists — sign in with your existing method, then link this provider from Settings',
      );
  }
}

/* -------------------------------------------------------------------------- */
/* database-backed resolution                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedIdentity {
  outcome: 'login' | 'linked' | 'created';
  userId: string;
  identityId: string;
  /**
   * The authoritative user row. The caller hands it straight to
   * `issueSession()`, which refuses anything whose `status` is not `active` —
   * so "no session below active" is enforced in one place, not two.
   */
  user: UserRow;
  /**
   * Enqueues the fan-out for anything this resolution emitted — today, the
   * `member_pending_approval` intent a brand-new OAuth signup raises.
   *
   * **Call it after the transaction commits**, never inside: `dispatchIntent`
   * treats a not-yet-visible intent as "nothing to do", and nothing ever
   * re-dispatches an intent that failed to fan out. `resolveOAuthIdentityAndNotify`
   * does both halves in the right order — prefer it to calling this by hand.
   *
   * A no-op for a plain login or a link.
   */
  dispatchNotifications: () => Promise<void>;
}

function fallbackDisplayName(profile: OAuthProfile): string {
  const fromEmail = profile.email?.split('@')[0];
  return profile.displayName ?? profile.username ?? fromEmail ?? 'Новый участник';
}

/**
 * Snapshot columns refreshed on every successful login. These are display data
 * only — nothing here is ever used to find or merge an account.
 */
function profileSnapshot(profile: OAuthProfile, existingDisplayName?: string | null) {
  return {
    providerEmail: profile.email,
    providerEmailVerified: profile.emailVerified,
    providerUsername: profile.username,
    // Apple sends the name exactly once. Never overwrite a stored name with null.
    providerDisplayName: profile.displayName ?? existingDisplayName ?? null,
    providerAvatarUrl: profile.avatarUrl,
    isPrivateEmail: profile.isPrivateEmail,
    rawProfile: sanitizeRawProfile(profile.rawProfile),
  };
}

/**
 * Runs the decision table against the database and applies it.
 *
 * Pass a transaction handle: the user insert, the identity insert and the
 * caller's audit write have to succeed or fail together.
 */
export async function resolveOAuthIdentity(
  db: Executor,
  params: { profile: OAuthProfile; intent: OAuthIntent; sessionUserId: string | null },
): Promise<ResolvedIdentity> {
  const { profile, intent, sessionUserId } = params;
  const config = getConfig();

  const [existingIdentity] = await db
    .select({
      id: userIdentities.id,
      userId: userIdentities.userId,
      providerDisplayName: userIdentities.providerDisplayName,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, profile.provider),
        eq(userIdentities.providerUserId, profile.providerUserId),
      ),
    )
    .limit(1);

  let sessionUserProviderIdentity: { id: string } | null = null;
  if (intent === 'link' && sessionUserId) {
    const [row] = await db
      .select({ id: userIdentities.id })
      .from(userIdentities)
      .where(
        and(eq(userIdentities.userId, sessionUserId), eq(userIdentities.provider, profile.provider)),
      )
      .limit(1);
    sessionUserProviderIdentity = row ?? null;
  }

  /**
   * Telegram never yields an email, and an Apple relay address is not a real
   * mailbox — neither may ever participate in an email lookup, so the query is
   * not even issued for them.
   */
  let emailOwnerUserId: string | null = null;
  if (!existingIdentity && intent === 'login' && profile.email && !profile.isPrivateEmail) {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${profile.email.trim().toLowerCase()}`)
      .limit(1);
    emailOwnerUserId = owner?.id ?? null;
  }

  const [settings] = await db
    .select({ allowRegistration: familySettings.allowRegistration })
    .from(familySettings)
    .limit(1);

  const decision = decideLinkOutcome({
    intent,
    sessionUserId,
    profile,
    existingIdentity: existingIdentity
      ? { id: existingIdentity.id, userId: existingIdentity.userId }
      : null,
    sessionUserProviderIdentity,
    emailOwnerUserId,
    // No settings row yet (fresh install) means the family has not closed the
    // door, so registration is open — the bootstrap owner has to get in somehow.
    registrationAllowed: settings?.allowRegistration ?? true,
    bootstrapOwnerEmail: config.BOOTSTRAP_OWNER_EMAIL || null,
  });

  if (decision.kind === 'conflict' || decision.kind === 'reject') {
    throw linkDecisionError(decision);
  }

  if (decision.kind === 'login') {
    const now = new Date();
    await db
      .update(userIdentities)
      .set({
        ...profileSnapshot(profile, existingIdentity?.providerDisplayName),
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(userIdentities.id, decision.identityId));

    const [user] = await db.select().from(users).where(eq(users.id, decision.userId)).limit(1);
    if (!user) throw new AppError('NOT_FOUND', 'Linked user no longer exists');

    return {
      outcome: 'login',
      userId: decision.userId,
      identityId: decision.identityId,
      user,
      dispatchNotifications: noDispatch,
    };
  }

  if (decision.kind === 'attach') {
    const [identity] = await db
      .insert(userIdentities)
      .values({
        userId: decision.userId,
        provider: profile.provider,
        providerUserId: profile.providerUserId,
        ...profileSnapshot(profile),
        lastLoginAt: new Date(),
      })
      .returning({ id: userIdentities.id });
    if (!identity) throw new AppError('CONFLICT', 'Could not link this identity');

    const [user] = await db.select().from(users).where(eq(users.id, decision.userId)).limit(1);
    if (!user) throw new AppError('NOT_FOUND', 'User no longer exists');

    return {
      outcome: 'linked',
      userId: decision.userId,
      identityId: identity.id,
      user,
      dispatchNotifications: noDispatch,
    };
  }

  /* create — a brand new, admin-gated account. */
  const now = new Date();
  const [created] = await db
    .insert(users)
    .values({
      // A relay address is not a contact address, so it never lands on `users`.
      email: profile.isPrivateEmail ? null : (profile.email?.trim().toLowerCase() ?? null),
      emailVerified: profile.isPrivateEmail ? false : profile.emailVerified,
      displayName: fallbackDisplayName(profile),
      avatarUrl: profile.avatarUrl,
      role: decision.asOwner ? 'owner' : 'child',
      status: decision.asOwner ? 'active' : 'pending_approval',
      approvedAt: decision.asOwner ? now : null,
      lastLoginAt: now,
    })
    .returning();
  if (!created) throw new AppError('INTERNAL_ERROR', 'Could not create the account');

  const [identity] = await db
    .insert(userIdentities)
    .values({
      userId: created.id,
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      // Apple's name arrives once, unsigned, in this very callback. It is
      // persisted here, in the same transaction, or it is gone forever.
      ...profileSnapshot(profile),
      lastLoginAt: now,
    })
    .returning({ id: userIdentities.id });
  if (!identity) throw new AppError('INTERNAL_ERROR', 'Could not create the identity');

  /**
   * A signup through Google/Apple/Telegram lands in `pending_approval` exactly
   * like a password signup, and until now nobody was told about either. The
   * person is locked out of the family app until an admin happens to open the
   * members screen — so the admins get the same `high`-priority
   * `member_pending_approval` the password path raises.
   *
   * The bootstrap owner (`decision.asOwner`) is already `active` and needs no
   * approval, so it emits nothing.
   */
  const dispatchNotifications = created.status === 'active'
    ? noDispatch
    : await emitOAuthPendingApproval(db, created, profile.provider);

  return {
    outcome: 'created',
    userId: created.id,
    identityId: identity.id,
    user: created,
    dispatchNotifications,
  };
}

/** Nothing to enqueue — a login and a link raise no intents. */
const noDispatch = (): Promise<void> => Promise.resolve();

async function emitOAuthPendingApproval(
  x: Executor,
  user: UserRow,
  provider: OAuthProvider,
): Promise<() => Promise<void>> {
  const intent = await emitIntent(x, {
    type: 'member_pending_approval',
    // By permission, not by role name: the catalog decides who may approve.
    audience: { roles: rolesWithPermission('member:approve') },
    actorId: user.id,
    entityType: 'user',
    entityId: user.id,
    // A replayed callback creates no second applicant, so it tells nobody twice.
    dedupeKey: `member_pending_approval:${user.id}`,
    payload: {
      userId: user.id,
      displayName: user.displayName,
      actorName: user.displayName,
      provider,
      status: user.status,
    },
  });
  return intent.dispatch;
}

/**
 * `resolveOAuthIdentity` in its own transaction, with the fan-out enqueued
 * **after** that transaction commits.
 *
 * The user insert, the identity insert and the notification intent have to land
 * together — half a signup is an account nobody can sign into again, and an
 * intent that outlives a rolled-back signup would page an admin about a person
 * who does not exist. The queue is touched only once all three are durable.
 */
export async function resolveOAuthIdentityAndNotify(
  db: Db,
  params: { profile: OAuthProfile; intent: OAuthIntent; sessionUserId: string | null },
): Promise<ResolvedIdentity> {
  const resolved = await db.transaction((tx) => resolveOAuthIdentity(tx, params));
  await dispatchAfterCommit([resolved.dispatchNotifications]);
  return resolved;
}
