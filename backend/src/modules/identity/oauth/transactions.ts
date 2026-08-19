import { randomBytes } from 'node:crypto';

import { eq, lt } from 'drizzle-orm';

import type { OAuthProvider } from '@family/shared';

import type { Executor } from '../../../core/db.js';
import { AppError } from '../../../core/errors.js';
import { oauthTransactions, type OAuthIntent } from '../identity.schema.js';

/**
 * The server-side OAuth transaction store (D3 — non-negotiable).
 *
 * `state -> { nonce, code_verifier, intent, link_user_id, redirect_after }` is
 * kept in Postgres with a 10-minute TTL and is **deleted on read**, which makes
 * the delete itself the replay guard: a `state` can be redeemed exactly once,
 * even under concurrent callbacks, because `DELETE ... RETURNING` is atomic.
 *
 * Why not a cookie: Apple's `response_mode=form_post` callback is a **cross-site
 * POST**, and a `SameSite=Lax` cookie is not sent on cross-site POSTs. A
 * cookie-backed state store therefore fails for Apple only, and only in
 * production — the worst possible failure mode. The same class of bug bites the
 * installed iOS PWA, where the return navigation is likewise not same-site.
 * Keeping the state on the server takes the browser out of the trust path.
 */

/** D3: ten minutes. Long enough for a slow consent screen, short enough to sweep cheaply. */
export const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

/** 32 bytes of entropy. `state` is both the lookup key and the CSRF token. */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export interface CreateOAuthTransactionInput {
  provider: OAuthProvider;
  /** Replayed into the authorization request and compared against the id_token claim. */
  nonce: string;
  /** PKCE verifier. NULL for Apple, which does not support PKCE. */
  codeVerifier?: string | null;
  intent?: OAuthIntent;
  /** Required when `intent === 'link'` — the already authenticated user. */
  linkUserId?: string | null;
  /** Same-origin relative path to send the browser to after success. */
  redirectAfter?: string | null;
}

export interface OAuthTransaction {
  state: string;
  provider: OAuthProvider;
  nonce: string;
  codeVerifier: string | null;
  intent: OAuthIntent;
  linkUserId: string | null;
  redirectAfter: string | null;
  expiresAt: Date;
}

export interface OAuthTransactionStore {
  /** Inserts a row and returns the generated `state`. */
  create(input: CreateOAuthTransactionInput): Promise<string>;
  /** Delete-on-read. Throws `BAD_REQUEST` for unknown, expired or mismatched rows. */
  consume(state: string, provider: OAuthProvider): Promise<OAuthTransaction>;
  /** Housekeeping for the nightly sweep; the happy path already deletes each row. */
  sweep(now?: Date): Promise<number>;
}

/**
 * The single-use / freshness policy, kept pure so that both the Postgres store
 * and the in-memory store enforce exactly the same rules, and so the rules can
 * be unit tested without a database.
 *
 * `row === undefined` covers three cases that must stay indistinguishable to the
 * caller: never existed, already consumed, already swept.
 */
export function assertTransactionUsable(
  row: OAuthTransaction | undefined,
  expectedProvider: OAuthProvider,
  now: Date = new Date(),
): OAuthTransaction {
  if (!row) {
    throw new AppError('BAD_REQUEST', 'OAuth state is unknown or has already been used');
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError('BAD_REQUEST', 'OAuth state has expired');
  }
  if (row.provider !== expectedProvider) {
    // A state minted for Google must never be redeemable at Apple's callback.
    throw new AppError('BAD_REQUEST', 'OAuth state does not belong to this provider');
  }
  return row;
}

function normalize(input: CreateOAuthTransactionInput, state: string, now: Date): OAuthTransaction {
  return {
    state,
    provider: input.provider,
    nonce: input.nonce,
    codeVerifier: input.codeVerifier ?? null,
    intent: input.intent ?? 'login',
    linkUserId: input.linkUserId ?? null,
    redirectAfter: input.redirectAfter ?? null,
    expiresAt: new Date(now.getTime() + OAUTH_TRANSACTION_TTL_MS),
  };
}

/* -------------------------------------------------------------------------- */
/* Postgres-backed store                                                       */
/* -------------------------------------------------------------------------- */

export function createOAuthTransactionStore(
  db: Executor,
  clock: () => Date = () => new Date(),
): OAuthTransactionStore {
  return {
    async create(input) {
      const row = normalize(input, generateState(), clock());
      await db.insert(oauthTransactions).values({
        state: row.state,
        provider: row.provider,
        nonce: row.nonce,
        codeVerifier: row.codeVerifier,
        intent: row.intent,
        linkUserId: row.linkUserId,
        redirectAfter: row.redirectAfter,
        expiresAt: row.expiresAt,
      });
      return row.state;
    },

    async consume(state, provider) {
      // Delete-on-read: the DELETE is the single-use guard. Two concurrent
      // callbacks racing on one `state` produce exactly one winner, and the
      // loser cannot tell its failure apart from a forged state — the point.
      const [deleted] = await db
        .delete(oauthTransactions)
        .where(eq(oauthTransactions.state, state))
        .returning();

      const row: OAuthTransaction | undefined = deleted
        ? {
            state: deleted.state,
            // `assertTransactionUsable` rejects anything but `expectedProvider`,
            // so the widening here can never reach a caller unchecked.
            provider: deleted.provider as OAuthProvider,
            nonce: deleted.nonce,
            codeVerifier: deleted.codeVerifier,
            intent: deleted.intent,
            linkUserId: deleted.linkUserId,
            redirectAfter: deleted.redirectAfter,
            expiresAt: deleted.expiresAt,
          }
        : undefined;

      return assertTransactionUsable(row, provider, clock());
    },

    async sweep(now = clock()) {
      const removed = await db
        .delete(oauthTransactions)
        .where(lt(oauthTransactions.expiresAt, now))
        .returning({ state: oauthTransactions.state });
      return removed.length;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* In-memory store                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Same semantics, no database. The unit tests drive this one so the
 * consume-once and TTL rules are exercised for real rather than mocked away.
 */
export function createMemoryOAuthTransactionStore(
  clock: () => Date = () => new Date(),
): OAuthTransactionStore {
  const rows = new Map<string, OAuthTransaction>();

  return {
    async create(input) {
      const row = normalize(input, generateState(), clock());
      rows.set(row.state, row);
      return row.state;
    },

    async consume(state, provider) {
      const row = rows.get(state);
      // Delete first, unconditionally: an expired or mismatched row is spent too.
      rows.delete(state);
      return assertTransactionUsable(row, provider, clock());
    },

    async sweep(now = clock()) {
      let removed = 0;
      for (const [state, row] of rows) {
        if (row.expiresAt.getTime() < now.getTime()) {
          rows.delete(state);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
