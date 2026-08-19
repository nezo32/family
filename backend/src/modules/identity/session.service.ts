import { createHmac, randomUUID } from 'node:crypto';

import type { PublicUser, SessionResponse, UserStatus } from '@family/shared';

import { getConfig } from '../../core/config.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  safeEqual,
  signAccessToken,
} from '../../core/auth/tokens.js';
import type { Db, Executor } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import * as repo from './identity.repository.js';
import type { RefreshRevokeReason } from './identity.schema.js';
import type { UserRow } from './users.schema.js';

/**
 * Session issuance and refresh-token rotation — the implementation of the D3
 * state machine drawn in `docs/architecture/identity.md` §2.
 *
 * A *family* is one login session on one device. Every generation of that
 * family's chain is a row in `refresh_tokens`; only `sha256(raw)` is stored, so
 * a database dump yields no usable sessions.
 *
 * OAuth providers call `issueSession` / `toSessionResponse` / `createStatusTicket`
 * from here — this module is the single place a credential is minted.
 */

export interface SessionContext {
  userAgent: string | null;
  ip: string | null;
}

export interface IssuedSession {
  accessToken: string;
  /** The raw opaque token. Goes into the `__Host-rt` cookie and nowhere else. */
  refreshToken: string;
  /** Access-token lifetime in seconds, for the client's refresh timer. */
  expiresIn: number;
  familyId: string;
}

export interface RotatedSession {
  accessToken: string;
  /**
   * `null` on the grace path.
   *
   * The successor's raw token is unrecoverable by design — only its hash is
   * stored — so a concurrent refresh cannot be handed "the successor's cookie".
   * It does not need one: concurrent refreshes come from the *same* browser and
   * therefore the same cookie jar, and the request that won the race already set
   * (or is about to set) the new cookie. Answering with no `Set-Cookie` leaves
   * the winner's value in place, which is exactly the desired end state, and
   * mints no third generation — a refresh storm cannot grow the chain.
   */
  refreshToken: string | null;
  expiresIn: number;
  familyId: string;
  user: UserRow;
  /** `false` when this was a grace-window replay rather than a real rotation. */
  rotated: boolean;
}

/* ========================================================================== */
/* account status gate                                                        */
/* ========================================================================== */

const STATUS_ERROR: Record<Exclude<UserStatus, 'active'>, AppError['code']> = {
  pending_approval: 'ACCOUNT_PENDING_APPROVAL',
  rejected: 'ACCOUNT_REJECTED',
  suspended: 'ACCOUNT_SUSPENDED',
};

const STATUS_MESSAGE: Record<Exclude<UserStatus, 'active'>, string> = {
  pending_approval: 'Account is awaiting admin approval',
  rejected: 'Access request was declined',
  suspended: 'Account has been suspended',
};

/**
 * The gate that makes "a `pending_approval` user gets no session at all" true
 * (D3 §3.1) — not a limited session, not a scoped one, none.
 *
 * Pure and total, so it is unit-testable without a database and impossible to
 * forget: `issueSession` and `rotateRefreshToken` both funnel through it.
 */
export function assertActive(user: Pick<UserRow, 'status'>): void {
  if (user.status === 'active') return;
  const status = user.status;
  throw new AppError(STATUS_ERROR[status], STATUS_MESSAGE[status]);
}

/* ========================================================================== */
/* issuing                                                                    */
/* ========================================================================== */

/**
 * Starts a brand new refresh-token family and mints the first access token.
 *
 * Called by password login and by every OAuth callback. Refuses outright for any
 * user whose status is not `active`.
 */
export async function issueSession(
  x: Executor,
  user: UserRow,
  ctx: SessionContext,
): Promise<IssuedSession> {
  assertActive(user);

  const config = getConfig();
  const familyId = randomUUID();
  const raw = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await repo.insertRefreshToken(x, {
    userId: user.id,
    familyId,
    tokenHash: hashRefreshToken(raw),
    generation: 0,
    expiresAt,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    role: user.role,
    status: user.status,
    sid: familyId,
  });

  return {
    accessToken,
    refreshToken: raw,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    familyId,
  };
}

/** The wire shape of a successful login / callback. The refresh token is never in the body. */
export function toSessionResponse(user: UserRow, issued: IssuedSession): SessionResponse {
  return {
    accessToken: issued.accessToken,
    expiresIn: issued.expiresIn,
    user: toPublicUser(user),
  };
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    color: user.color,
    role: user.role,
    status: user.status,
  };
}

/* ========================================================================== */
/* the rotation decision — pure                                               */
/* ========================================================================== */

/** Just the fields the decision depends on, so tests need no database row. */
export interface RefreshTokenSnapshot {
  id: string;
  familyId: string;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: RefreshRevokeReason | null;
  expiresAt: Date;
}

export interface SuccessorSnapshot {
  id: string;
  revokedAt: Date | null;
}

export type RefreshDecision =
  | { kind: 'invalid'; reason: string }
  | { kind: 'expired' }
  | { kind: 'reuse' }
  | { kind: 'grace'; successorId: string }
  | { kind: 'rotate' };

export interface RefreshDecisionInput {
  /** `null` when no row matched the presented hash. */
  token: RefreshTokenSnapshot | null;
  /**
   * The live continuation of `token`'s chain: its direct successor if that is
   * still unrevoked, otherwise the family's live head. Passing the head as a
   * fallback is what keeps a *three*-way concurrent burst benign — by the time
   * the third tab arrives, the direct successor may itself have been rotated,
   * and treating "successor already rotated" as a breach would log the family
   * out exactly in the situation the grace window exists to survive.
   */
  successor: SuccessorSnapshot | null;
  now: Date;
  graceSeconds: number;
}

/**
 * The whole state machine, as one pure function.
 *
 * Order matters and follows D3: unknown → replay → expiry → grace → rotate.
 * Extracted from the transaction so every branch is unit-testable without
 * Postgres, and so the ordering can be reviewed in one screen.
 */
export function decideRefresh(input: RefreshDecisionInput): RefreshDecision {
  const { token, successor, now, graceSeconds } = input;

  if (!token) return { kind: 'invalid', reason: 'unknown token' };

  if (token.usedAt) {
    const ageMs = now.getTime() - token.usedAt.getTime();
    const withinGrace = ageMs >= 0 && ageMs <= graceSeconds * 1000;
    if (withinGrace && successor && !successor.revokedAt) {
      return { kind: 'grace', successorId: successor.id };
    }
    // Presented after the window with the chain already moved on: the cookie
    // leaked and two parties hold live credentials. Only killing the family
    // evicts both.
    return { kind: 'reuse' };
  }

  if (token.revokedAt) {
    // A token revoked without ever being used was killed deliberately. `logout`
    // is the one benign case — a background tab can genuinely POST /auth/refresh
    // a moment after another tab signed out — and raising a breach alert for it
    // would be pure noise. Everything else (`reuse`, `admin`, `status_change`)
    // is treated as a replay.
    if (token.revokedReason === 'logout') {
      return { kind: 'invalid', reason: 'session was signed out' };
    }
    return { kind: 'reuse' };
  }

  if (token.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

  return { kind: 'rotate' };
}

/* ========================================================================== */
/* rotation                                                                   */
/* ========================================================================== */

/**
 * Outcome of the transactional part of a rotation.
 *
 * The reuse branch has to *commit* the family revocation before the request
 * fails, so the transaction returns a value and the caller throws — throwing
 * inside the transaction would roll the revocation back and leave the attacker's
 * token live.
 */
type RotationOutcome =
  | { kind: 'rotated'; user: UserRow; familyId: string; raw: string }
  | { kind: 'grace'; user: UserRow; familyId: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'expired' }
  | { kind: 'reuse'; userId: string; familyId: string }
  | { kind: 'status'; user: UserRow };

/**
 * Rotate a refresh token (D3).
 *
 * One transaction, opened by this function, holding a `FOR UPDATE` lock on the
 * presented row from the first statement — that lock is what serialises
 * simultaneous refreshes so exactly one of them mints a successor.
 */
export async function rotateRefreshToken(
  db: Db,
  raw: string,
  ctx: SessionContext,
): Promise<RotatedSession> {
  const config = getConfig();
  const tokenHash = hashRefreshToken(raw);

  const outcome = await db.transaction(async (tx): Promise<RotationOutcome> => {
    const token = await repo.lockRefreshTokenByHash(tx, tokenHash);

    const successorRow = token
      ? ((await repo.findLiveSuccessor(tx, token.id)) ??
        (await repo.findLiveFamilyHead(tx, token.familyId, token.id)))
      : undefined;

    const decision = decideRefresh({
      token: token ?? null,
      successor: successorRow ? { id: successorRow.id, revokedAt: successorRow.revokedAt } : null,
      now: new Date(),
      graceSeconds: config.REFRESH_GRACE_SECONDS,
    });

    if (decision.kind === 'invalid') return { kind: 'invalid', reason: decision.reason };
    if (decision.kind === 'expired') return { kind: 'expired' };

    // `token` is non-null for every remaining branch: `decideRefresh` only
    // returns `invalid` when it is null.
    if (!token) return { kind: 'invalid', reason: 'unknown token' };

    if (decision.kind === 'reuse') {
      await repo.revokeFamilyRows(tx, token.familyId, 'reuse');
      await repo.writeAudit(tx, {
        actorId: token.userId,
        action: 'session:reuse_detected',
        targetType: 'refresh_family',
        targetId: token.familyId,
        metadata: {
          generation: token.generation,
          usedAt: token.usedAt?.toISOString() ?? null,
          revokedReason: token.revokedReason,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { kind: 'reuse', userId: token.userId, familyId: token.familyId };
    }

    // Status is re-read from the row on every rotation (D3 §3.2), so a
    // suspension cannot be renewed past the current access token's lifetime.
    const user = await repo.findUserById(tx, token.userId);
    if (!user) return { kind: 'invalid', reason: 'user no longer exists' };

    if (user.status !== 'active') {
      await repo.revokeUserRows(tx, user.id, 'status_change');
      return { kind: 'status', user };
    }

    if (decision.kind === 'grace') {
      return { kind: 'grace', user, familyId: token.familyId };
    }

    /* --- rotate --- */
    const consumed = await repo.consumeRefreshToken(tx, token.id);
    if (!consumed) {
      // Lost the race despite the lock (possible only if another path consumed
      // the row without locking). Do not mint a second successor; fall back to
      // the grace answer, which is always safe.
      return { kind: 'grace', user, familyId: token.familyId };
    }

    const nextRaw = generateRefreshToken();
    await repo.insertRefreshToken(tx, {
      userId: user.id,
      familyId: token.familyId,
      tokenHash: hashRefreshToken(nextRaw),
      prevTokenId: token.id,
      generation: token.generation + 1,
      // The family does not slide: every generation inherits the original
      // expiry, so a compromised session cannot be renewed forever (D3).
      expiresAt: token.expiresAt,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });

    return { kind: 'rotated', user, familyId: token.familyId, raw: nextRaw };
  });

  switch (outcome.kind) {
    case 'invalid':
      throw new AppError('TOKEN_INVALID', `Refresh token rejected: ${outcome.reason}`);

    case 'expired':
      throw new AppError('TOKEN_EXPIRED', 'Refresh token has expired');

    case 'reuse':
      logger.error(
        { userId: outcome.userId, familyId: outcome.familyId, ip: ctx.ip },
        'refresh token reuse detected — entire token family revoked',
      );
      throw new AppError('REFRESH_TOKEN_REUSED', 'Refresh token was replayed', {
        context: { familyId: outcome.familyId },
      });

    case 'status':
      assertActive(outcome.user);
      // Unreachable: `assertActive` throws for every non-active status, and the
      // transaction only returns `status` for a non-active user.
      throw new AppError('UNAUTHENTICATED', 'Account is not usable');

    case 'grace':
    case 'rotated': {
      const accessToken = await signAccessToken({
        sub: outcome.user.id,
        role: outcome.user.role,
        status: outcome.user.status,
        sid: outcome.familyId,
      });

      return {
        accessToken,
        refreshToken: outcome.kind === 'rotated' ? outcome.raw : null,
        expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
        familyId: outcome.familyId,
        user: outcome.user,
        rotated: outcome.kind === 'rotated',
      };
    }
  }
}

/* ========================================================================== */
/* revocation                                                                 */
/* ========================================================================== */

/** Revokes one login session. Idempotent — revoking a dead family is a no-op. */
export async function revokeFamily(
  x: Executor,
  familyId: string,
  reason: RefreshRevokeReason,
): Promise<number> {
  return repo.revokeFamilyRows(x, familyId, reason);
}

/**
 * Revokes every session of a user.
 *
 * Called on every status change away from `active` (D3 §3.3), in the same
 * transaction as the status update.
 */
export async function revokeAllForUser(
  x: Executor,
  userId: string,
  reason: RefreshRevokeReason,
  exceptFamilyId?: string,
): Promise<number> {
  return repo.revokeUserRows(x, userId, reason, exceptFamilyId);
}

/* ========================================================================== */
/* account-status tickets                                                     */
/* ========================================================================== */

/**
 * The opaque handle behind the unauthenticated pending / rejected screens.
 *
 * A `pending_approval` user has no session, so the waiting screen cannot
 * identify itself with a token — but `GET /auth/status` still has to answer
 * "has anything changed?" without becoming an enumeration oracle for user ids.
 *
 * The ticket is a self-contained HMAC over `(userId, expiry)`: no table, no
 * cleanup job, and it carries no authority beyond reading one status field.
 */
const TICKET_VERSION = 'v1';
const TICKET_TTL_SECONDS = 7 * 24 * 60 * 60;

function ticketSignature(payload: string): string {
  return createHmac('sha256', getConfig().JWT_REFRESH_SECRET).update(payload).digest('base64url');
}

export function createStatusTicket(userId: string, now: Date = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS;
  const payload = `${TICKET_VERSION}.${userId}.${expiresAt}`;
  return `${payload}.${ticketSignature(payload)}`;
}

/** Returns the user id, or `null` for a malformed, forged or expired ticket. */
export function readStatusTicket(ticket: string, now: Date = new Date()): string | null {
  const parts = ticket.split('.');
  if (parts.length !== 4) return null;

  const [version, userId, expiresAt, signature] = parts;
  if (version !== TICKET_VERSION || !userId || !expiresAt || !signature) return null;

  const payload = `${version}.${userId}.${expiresAt}`;
  if (!safeEqual(signature, ticketSignature(payload))) return null;

  const expirySeconds = Number(expiresAt);
  if (!Number.isFinite(expirySeconds)) return null;
  if (expirySeconds * 1000 <= now.getTime()) return null;

  return userId;
}
