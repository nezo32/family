import { z } from 'zod';
import {
  authProviderSchema,
  memberListItemSchema,
  publicUserSchema,
  type MemberListQuery,
  type Role,
} from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers for member administration.
 *
 * ### One query-key root for two features
 *
 * `features/family` renders the same rows from the same endpoint, and an
 * approval or a suspension has to be visible on both screens immediately. Both
 * features therefore build their keys on the shared `['members']` root, so
 * either one can invalidate everything member-shaped with a single call and
 * neither has to import the other's key factory.
 *
 * ### Why the row schemas are re-declared here rather than imported verbatim
 *
 * `GET /members` is served through **one of two serializers** chosen by the
 * caller's permissions (`memberListItemSchema` for an admin, `publicUserSchema`
 * for everyone else). Parsing against the admin schema would therefore throw
 * for a non-admin caller. `memberRowSchema` below is the public projection plus
 * the admin fields as **optional**, which accepts either wire shape and gives
 * the components a single type to render.
 *
 * Two fields are optional for a different reason: the contract does not carry
 * them yet.
 *  - `providers` — which method the signup came in through. The queue needs it
 *    («вход через Telegram» is how an admin recognises the person), the
 *    contract does not expose it. Rendered when present, skipped when not.
 *  - `birthDate` — same story for the family roster.
 * Both are noted in the handover; nothing breaks while they are missing.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

/** Shared with `features/family` — invalidate this to refresh every member view. */
export const MEMBER_KEY_ROOT = ['members'] as const;

export const adminKeys = {
  all: MEMBER_KEY_ROOT,
  pending: () => [...MEMBER_KEY_ROOT, 'pending'] as const,
  lists: () => [...MEMBER_KEY_ROOT, 'admin-list'] as const,
  list: (query: MemberListQuery) => [...MEMBER_KEY_ROOT, 'admin-list', query] as const,
};

/* -------------------------------------------------------------------------- */
/* wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

export const memberRowSchema = publicUserSchema.extend({
  email: z.string().nullable().optional(),
  emailVerified: z.boolean().optional(),
  choreWeight: z.number().optional(),
  createdAt: z.string().optional(),
  approvedAt: z.string().nullable().optional(),
  rejectedReason: z.string().nullable().optional(),
  lastSeenAt: z.string().nullable().optional(),
  /** Not in the contract yet — see the file header. */
  providers: z.array(authProviderSchema).optional(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

/** The queue is admin-only, so its rows are always the full projection. */
export const pendingMemberSchema = memberListItemSchema.extend({
  providers: z.array(authProviderSchema).optional(),
});
export type PendingMember = z.infer<typeof pendingMemberSchema>;

export const memberListSchema = z.object({
  items: z.array(memberRowSchema),
  pendingCount: z.number().int().min(0).default(0),
});
export type MemberList = z.infer<typeof memberListSchema>;

export const pendingListSchema = z.object({
  items: z.array(pendingMemberSchema),
  pendingCount: z.number().int().min(0).default(0),
});
export type PendingList = z.infer<typeof pendingListSchema>;

/* -------------------------------------------------------------------------- */
/* reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function fetchMembers(
  query: MemberListQuery = {},
  signal?: AbortSignal,
): Promise<MemberList> {
  const raw = await api.get<unknown>('/members', {
    query: { ...query },
    ...(signal ? { signal } : {}),
  });
  return memberListSchema.parse(raw);
}

export async function fetchPendingMembers(signal?: AbortSignal): Promise<PendingList> {
  const raw = await api.get<unknown>('/members/pending', signal ? { signal } : {});
  return pendingListSchema.parse(raw);
}

/* -------------------------------------------------------------------------- */
/* writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface ApproveInput {
  id: string;
  /** Chosen at approval time, never self-declared at signup (D3). */
  role: Role;
}

export interface RejectInput {
  id: string;
  /** Shown to the applicant on the rejection screen. */
  reason?: string;
}

export interface SuspendInput {
  id: string;
  reason?: string;
}

/**
 * `POST /members/:id/approve`.
 *
 * The server update is conditional on `status = 'pending_approval'`, so a
 * second admin racing the first gets `409 CONFLICT` here. That is handled in
 * `hooks.ts`, not swallowed — the loser must see the queue refresh, not an
 * error dialog.
 */
export async function approveMember(input: ApproveInput): Promise<MemberRow> {
  const raw = await api.post<unknown>(`/members/${input.id}/approve`, { role: input.role });
  return memberRowSchema.parse(raw);
}

export async function rejectMember(input: RejectInput): Promise<MemberRow> {
  const reason = input.reason?.trim();
  const raw = await api.post<unknown>(`/members/${input.id}/reject`, reason ? { reason } : {});
  return memberRowSchema.parse(raw);
}

export async function suspendMember(input: SuspendInput): Promise<MemberRow> {
  const reason = input.reason?.trim();
  const raw = await api.post<unknown>(`/members/${input.id}/suspend`, reason ? { reason } : {});
  return memberRowSchema.parse(raw);
}

export async function reactivateMember(id: string): Promise<MemberRow> {
  const raw = await api.post<unknown>(`/members/${id}/reactivate`, {});
  return memberRowSchema.parse(raw);
}
