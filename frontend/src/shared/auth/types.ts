import { z } from 'zod';
import { ROLES, PERMISSIONS } from '@family/shared';

/**
 * Shape of `GET /api/me`.
 *
 * TEMPORARY HOME. The canonical contract belongs in
 * `packages/shared/src/contracts/me.ts` and is owned by the auth backend agent.
 * When it lands, delete this file and re-export from `@family/shared` — the
 * names below are chosen to match one-for-one so the swap is mechanical.
 *
 * The `permissions` array is the **effective** list (role matrix + per-user
 * grants − denies), computed server-side per D4. The client never re-derives
 * it and never branches on `role` for an access decision.
 */

export const accountStatusSchema = z.enum(['pending_approval', 'active', 'rejected', 'suspended']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const authProviderSchema = z.enum(['google', 'apple', 'telegram']);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export const meSchema = z.object({
  id: z.string().uuid(),
  /** Nullable: Telegram never gives us an email (D3). */
  email: z.string().email().nullable(),
  displayName: z.string(),
  avatarUrl: z.string().url().nullable(),
  /** Display copy only. Never use for an access decision — use `useCan()`. */
  role: z.enum(ROLES),
  status: accountStatusSchema,
  /** IANA timezone; falls back to the family default. */
  timezone: z.string(),
  /** Effective permission list from the server. */
  permissions: z.array(z.enum(PERMISSIONS)),
  /** Linked sign-in methods, for Settings → Аккаунты. */
  providers: z.array(authProviderSchema).default([]),
  /** Family-wide settings the shell needs on every screen. */
  family: z
    .object({
      name: z.string(),
      timezone: z.string(),
      currency: z.string().default('RUB'),
      weekStartsOn: z.number().int().min(0).max(6).default(1),
    })
    .optional(),
});

export type Me = z.infer<typeof meSchema>;
