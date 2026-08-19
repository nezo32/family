import { z } from 'zod';

import { PERMISSIONS, ROLES } from '../domain/roles.js';
import type { Permission } from '../domain/roles.js';
import {
  choreWeightSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  timeZoneSchema,
} from './common.js';

/**
 * Users & members contracts.
 *
 * Per D1 there is no separate `members` table — a "member" *is* a user. The two
 * words are used interchangeably here: `member*` schemas are the admin-facing
 * view of the same row that `publicUser`/`me` expose to the member themselves.
 *
 * Every enum is built from the shared catalog constants, so adding a role or a
 * permission to `domain/roles.ts` propagates here at compile time rather than
 * silently drifting.
 */

/* -------------------------------------------------------------------------- */
/* enums                                                                       */
/* -------------------------------------------------------------------------- */

export const roleSchema = z.enum(ROLES);

/**
 * Registration is admin-gated (D3). Mirrors the `user_status` pgEnum in
 * `backend/src/modules/identity/users.schema.ts`; the two must stay in step.
 */
export const USER_STATUSES = ['pending_approval', 'active', 'rejected', 'suspended'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** A single permission from the catalog. `z.infer` of this *is* `Permission`. */
export const permissionSchema = z.enum(PERMISSIONS);

/** Short hex accent colour used for avatars and calendar chips. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Ожидается цвет в формате #RRGGBB');

/** BCP-47 tag. The UI is Russian; this only drives date/number formatting. */
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/, 'Ожидается языковой тег, например ru-RU');

/** Chore-rotation capacity multiplier (D5). 0 = temporarily excused. */

/* -------------------------------------------------------------------------- */
/* public projection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What any authenticated family member may see about any other member.
 *
 * Deliberately excludes email, birth date, timezone, chore weight and every
 * permission override: those are either private or admin-only. Widening this
 * object widens it for children too — think before adding a field.
 */
export const publicUserSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  color: z.string().nullable(),
  /** Display copy only. Never branch on this for access decisions (D4). */
  role: roleSchema,
  status: userStatusSchema,
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/** The caller's own profile — adds the fields only they (and admins) may read. */
export const selfUserSchema = publicUserSchema.extend({
  email: z.string().email().nullable(),
  birthDate: isoDateSchema.nullable(),
  /** NULL means "inherit `family.timezone`". */
  timezone: timeZoneSchema.nullable(),
  locale: z.string(),
});
export type SelfUser = z.infer<typeof selfUserSchema>;

/* -------------------------------------------------------------------------- */
/* GET /api/me                                                                 */
/* -------------------------------------------------------------------------- */

/** The family-wide settings the client needs to render anything at all. */
export const familyContextSchema = z.object({
  name: z.string(),
  timezone: timeZoneSchema,
  /** ISO-8601 weekday number: 1 = Monday. */
  weekStartsOn: z.number().int().min(1).max(7),
  currency: z.string().length(3),
});
export type FamilyContext = z.infer<typeof familyContextSchema>;

/**
 * The single source of client-side authorization state.
 *
 * `permissions` is the **effective** list (role matrix + grants − denies), so the
 * frontend never re-derives the matrix. `permissionsVersion` is an opaque hash of
 * `(role, grants, denies, status)`: when it differs from the value baked into the
 * access token the client must invalidate `['me']`, which is what makes a role
 * change visible without a logout.
 */
export const meResponseSchema = z.object({
  user: selfUserSchema,
  permissions: z.array(permissionSchema),
  family: familyContextSchema,
  permissionsVersion: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Compile-time proof that the contract and the catalog cannot drift apart. */
export type MePermissions = MeResponse['permissions'];
const _permissionsAreCatalogPermissions: MePermissions extends Permission[] ? true : never = true;
void _permissionsAreCatalogPermissions;

/* -------------------------------------------------------------------------- */
/* profile (self)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `PATCH /api/me` — what a member may change about themselves.
 *
 * Note what is absent: `role`, `status`, `permissionGrants`, `permissionDenies`
 * and `choreWeight`. Those are admin-only and live in `updateMemberRequest`.
 * `.strict()` turns an attempt to smuggle one of them in into a 400 rather than
 * a silently ignored field.
 */
export const updateProfileRequestSchema = z
  .object({
    displayName: nonEmptyString(80).optional(),
    avatarUrl: z.string().url().max(2048).nullish(),
    color: hexColorSchema.nullish(),
    birthDate: isoDateSchema.nullish(),
    timezone: timeZoneSchema.nullish(),
    locale: localeSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Нужно передать хотя бы одно поле' });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/* -------------------------------------------------------------------------- */
/* member administration                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `PATCH /api/members/:id` — the admin surface.
 *
 * `permissionGrants` / `permissionDenies` are **full replacements**, not deltas:
 * a partial-delta API for a two-list override system produces order-dependent
 * bugs the first time two admins edit at once. Denies always win (D4).
 */
export const updateMemberRequestSchema = z
  .object({
    role: roleSchema.optional(),
    choreWeight: choreWeightSchema.optional(),
    permissionGrants: z.array(permissionSchema).max(PERMISSIONS.length).optional(),
    permissionDenies: z.array(permissionSchema).max(PERMISSIONS.length).optional(),
    displayName: nonEmptyString(80).optional(),
    color: hexColorSchema.nullish(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Нужно передать хотя бы одно поле' });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

/**
 * `POST /api/members/:id/approve`.
 *
 * The role is chosen **at approval time**, not at signup: a self-declared role in
 * the registration form is an obvious privilege-escalation vector. The default is
 * the least-privileged useful role.
 */
export const approveMemberRequestSchema = z
  .object({
    role: roleSchema.default('child'),
    choreWeight: choreWeightSchema.optional(),
  })
  .strict();
export type ApproveMemberRequest = z.infer<typeof approveMemberRequestSchema>;

/** `POST /api/members/:id/reject`. The reason is shown on the rejected screen. */
export const rejectMemberRequestSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type RejectMemberRequest = z.infer<typeof rejectMemberRequestSchema>;

/** `POST /api/members/:id/suspend` — revokes every refresh family immediately. */
export const suspendMemberRequestSchema = rejectMemberRequestSchema;
export type SuspendMemberRequest = z.infer<typeof suspendMemberRequestSchema>;

/**
 * A row in the admin member list. Extends the public projection with the
 * moderation state an admin needs to act on a pending signup.
 *
 * Callers without `member:update:any` receive `publicUserSchema` rows instead —
 * the route picks the serializer, the client does not filter.
 */
export const memberListItemSchema = publicUserSchema.extend({
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  choreWeight: z.number(),
  sortOrder: z.number().int(),
  permissionGrants: z.array(permissionSchema),
  permissionDenies: z.array(permissionSchema),
  /** When the signup arrived — the sort key of the pending-approval queue. */
  createdAt: isoDateTimeSchema,
  approvedAt: isoDateTimeSchema.nullable(),
  approvedById: idSchema.nullable(),
  rejectedReason: z.string().nullable(),
  lastSeenAt: isoDateTimeSchema.nullable(),
});
export type MemberListItem = z.infer<typeof memberListItemSchema>;

export const memberListQuerySchema = z.object({
  status: userStatusSchema.optional(),
  role: roleSchema.optional(),
});
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

export const memberListResponseSchema = z.object({
  items: z.array(memberListItemSchema),
  /** Badge count for the admin nav. Cheap enough to compute on every list read. */
  pendingCount: z.number().int().min(0),
});
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;
