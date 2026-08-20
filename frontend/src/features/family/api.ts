import { z } from 'zod';
import {
  publicUserSchema,
  taskOccurrenceListResponseSchema,
  type TaskOccurrenceResponse,
  type UpdateMemberRequest,
} from '@family/shared';
import { api } from '@/shared/api/client';

/**
 * Typed fetchers for the «Семья» section.
 *
 * ### One query-key root, two features
 *
 * `features/admin` moderates the same rows from the same endpoint. Both build
 * their keys on `['members']`, so an approval on the admin screen and a role
 * change here invalidate each other without either feature importing the
 * other's key factory.
 *
 * ### Why the roster row is declared here
 *
 * `GET /members` picks its serializer from the caller's permissions: an admin
 * gets `memberListItemSchema`, everybody else `publicUserSchema`. Parsing
 * against the admin schema would throw for a child. `rosterMemberSchema` is the
 * public projection with the admin fields **optional**, which accepts either
 * wire shape and hands the components one type.
 *
 * `birthDate` is optional for a different reason: the roster is supposed to
 * show birthdays and the contract does not carry the field on any member
 * projection yet (only `selfUserSchema` has it). It is rendered when present
 * and silently skipped when not — noted in the handover for the contract owner.
 *
 * ### An endpoint this screen wants that does not exist yet
 *
 * `GET /tasks/occurrences` is specified in `docs/architecture/scheduling.md` §7
 * but not implemented. It is treated as strictly optional enrichment: the
 * "ближайшие дела" list degrades to a quiet line of text, and the roster itself
 * never depends on it.
 */

/* -------------------------------------------------------------------------- */
/* query keys                                                                  */
/* -------------------------------------------------------------------------- */

/** Shared with `features/admin` — invalidating this refreshes every member view. */
export const MEMBER_KEY_ROOT = ['members'] as const;

export const familyKeys = {
  all: MEMBER_KEY_ROOT,
  roster: () => [...MEMBER_KEY_ROOT, 'roster'] as const,
  upcoming: (memberId: string) => [...MEMBER_KEY_ROOT, 'upcoming', memberId] as const,
};

/* -------------------------------------------------------------------------- */
/* wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

export const rosterMemberSchema = publicUserSchema.extend({
  /** Admin projection only. */
  email: z.string().nullable().optional(),
  choreWeight: z.number().optional(),
  sortOrder: z.number().int().optional(),
  lastSeenAt: z.string().nullable().optional(),
  /** Not in any member projection yet — see the file header. */
  birthDate: z.string().nullable().optional(),
});
export type RosterMember = z.infer<typeof rosterMemberSchema>;

export const rosterSchema = z.object({
  items: z.array(rosterMemberSchema),
  pendingCount: z.number().int().min(0).default(0),
});
export type Roster = z.infer<typeof rosterSchema>;

/* -------------------------------------------------------------------------- */
/* reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function fetchRoster(signal?: AbortSignal): Promise<Roster> {
  const raw = await api.get<unknown>('/members', signal ? { signal } : {});
  return rosterSchema.parse(raw);
}

/** The next few scheduled chores for one member — the detail sheet's body. */
export async function fetchUpcomingTasks(
  memberId: string,
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<TaskOccurrenceResponse[]> {
  const raw = await api.get<unknown>('/tasks/occurrences', {
    query: { assigneeId: memberId, from: range.from, to: range.to, limit: 5 },
    ...(signal ? { signal } : {}),
  });
  return taskOccurrenceListResponseSchema.parse(raw).items;
}

/* -------------------------------------------------------------------------- */
/* writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface UpdateMemberInput {
  id: string;
  patch: UpdateMemberRequest;
}

export async function updateMember(input: UpdateMemberInput): Promise<RosterMember> {
  const raw = await api.patch<unknown>(`/members/${input.id}`, input.patch);
  return rosterMemberSchema.parse(raw);
}

export async function suspendMember(id: string): Promise<RosterMember> {
  const raw = await api.post<unknown>(`/members/${id}/suspend`, {});
  return rosterMemberSchema.parse(raw);
}

export async function reactivateMember(id: string): Promise<RosterMember> {
  const raw = await api.post<unknown>(`/members/${id}/reactivate`, {});
  return rosterMemberSchema.parse(raw);
}

/* -------------------------------------------------------------------------- */
/* chore weight                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The contract is asymmetric and it is easy to get wrong: the roster returns
 * `choreWeight` as a **number**, `updateMemberRequestSchema` accepts it as a
 * **decimal string** (`choreWeightSchema` — `"1.00"`, two decimals, max 99.99).
 * One place converts, and this is it.
 */
export const CHORE_WEIGHT_STEP = 0.25;
export const CHORE_WEIGHT_MIN = 0;
export const CHORE_WEIGHT_MAX = 5;

export function formatChoreWeight(weight: number): string {
  return weight.toFixed(2);
}

export function clampChoreWeight(weight: number): number {
  const clamped = Math.min(CHORE_WEIGHT_MAX, Math.max(CHORE_WEIGHT_MIN, weight));
  // Keep it on the step grid so repeated taps cannot drift into 0.7499999.
  return Math.round(clamped / CHORE_WEIGHT_STEP) * CHORE_WEIGHT_STEP;
}
