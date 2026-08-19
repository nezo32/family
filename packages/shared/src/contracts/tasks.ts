import { z } from 'zod';

import {
  cursorPaginationSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  paginatedSchema,
  queryBooleanSchema,
  timeZoneSchema,
} from './common.js';

/**
 * Tasks & chores contracts.
 *
 * This file also owns the **shared recurrence vocabulary** (`recurrenceSpec*`,
 * `editScope`, `calendarRange`) because tasks and events speak it identically;
 * `events.ts` imports it from here rather than duplicating it. If a third
 * recurring domain ever appears, lift these into their own `recurrence.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Time primitives                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A **floating** local wall-clock datetime: `2026-09-07T09:00:00`. No offset,
 * no `Z`, seconds mandatory. This is what a series is anchored to (D2), and it
 * is deliberately *not* `isoDateTimeSchema` — attaching an offset here is the
 * exact bug the time model exists to prevent.
 */
export const floatingDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/,
    'Ожидается локальное время в формате ГГГГ-ММ-ДДTЧЧ:ММ:СС без смещения',
  );

/** RFC 5545 two-letter weekday codes, as used in `BYDAY`. */
export const weekdaySchema = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export type Weekday = z.infer<typeof weekdaySchema>;

/* -------------------------------------------------------------------------- */
/* Recurrence — the restricted rule builder                                    */
/* -------------------------------------------------------------------------- */

/** "Every N ...". Bounded so a typo cannot produce a rule nobody can read. */
export const recurrenceIntervalSchema = z.number().int().min(1).max(99).default(1);

/**
 * **The only recurrence shapes the UI may offer.** Product research settled on
 * six patterns; anything richer is a support burden nobody in a family app will
 * use. The backend compiles a preset to an RRULE line — the client never
 * authors RRULE text.
 *
 * | preset             | compiles to                             |
 * |--------------------|-----------------------------------------|
 * | `daily`            | `FREQ=DAILY;INTERVAL=n`                 |
 * | `weekly`           | `FREQ=WEEKLY;INTERVAL=n;BYDAY=MO,WE`    |
 * | `monthly_day`      | `FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=d`  |
 * | `monthly_last_day` | `FREQ=MONTHLY;INTERVAL=n;BYMONTHDAY=-1` |
 *
 * `weekly` covers both "specific weekdays" (`interval: 1`) and "every N weeks";
 * `monthly_day` covers both "day N of the month" (`interval: 1`) and "every N
 * months". `BYMONTHDAY=31` in a 30-day month simply produces no occurrence that
 * month — which is why the UI must steer users to `monthly_last_day` for
 * end-of-month chores.
 */
export const recurrencePresetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daily'),
    interval: recurrenceIntervalSchema,
  }),
  z.object({
    kind: z.literal('weekly'),
    interval: recurrenceIntervalSchema,
    weekdays: z.array(weekdaySchema).min(1).max(7),
  }),
  z.object({
    kind: z.literal('monthly_day'),
    interval: recurrenceIntervalSchema,
    dayOfMonth: z.number().int().min(1).max(31),
  }),
  z.object({
    kind: z.literal('monthly_last_day'),
    interval: recurrenceIntervalSchema,
  }),
]);
export type RecurrencePreset = z.infer<typeof recurrencePresetSchema>;

/** How the repetition stops. Compiles to `COUNT=` / `UNTIL=` (or neither). */
export const recurrenceEndSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('never') }),
  z.object({ type: z.literal('after'), count: z.number().int().min(1).max(1000) }),
  /** Inclusive last local datetime. Converted to a UTC `UNTIL` by the engine. */
  z.object({ type: z.literal('until'), untilLocal: floatingDateTimeSchema }),
]);
export type RecurrenceEnd = z.infer<typeof recurrenceEndSchema>;

/**
 * Escape hatch for ICS import and admin tooling only. Never surfaced in the UI.
 * Rejects a DTSTART inside the rule: the anchor is `dtstartLocal` + `timezone`,
 * and a second, offset-bearing anchor smuggled in here would silently win.
 */
export const rawRruleSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((v) => /(^|;)FREQ=/i.test(v), 'Правило должно содержать FREQ=')
  .refine(
    (v) => !/DTSTART/i.test(v),
    'DTSTART не входит в RRULE — используйте dtstartLocal и timezone',
  );

const recurrenceAnchor = {
  /** Floating local start — the anchor of the whole series (D2). */
  dtstartLocal: floatingDateTimeSchema,
  /** IANA id. Resolves the wall clock to instants at materialization time. */
  timezone: timeZoneSchema,
  /** Extra one-off local datetimes bolted onto the expansion (RDATE). */
  rdatesLocal: z.array(floatingDateTimeSchema).max(100).default([]),
  /** Local datetimes removed from the expansion (EXDATE). */
  exdatesLocal: z.array(floatingDateTimeSchema).max(500).default([]),
};

/**
 * What a client sends to describe when something happens.
 *
 * - `once`   — no repetition; one occurrence at `dtstartLocal`. Stores `rrule = NULL`.
 * - `preset` — the restricted builder above. What the UI always sends.
 * - `raw`    — an imported RRULE line. Import paths only.
 */
export const recurrenceSpecSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('once'), ...recurrenceAnchor }),
  z.object({
    mode: z.literal('preset'),
    preset: recurrencePresetSchema,
    ends: recurrenceEndSchema.default({ type: 'never' }),
    ...recurrenceAnchor,
  }),
  z.object({ mode: z.literal('raw'), rrule: rawRruleSchema, ...recurrenceAnchor }),
]);
export type RecurrenceSpec = z.infer<typeof recurrenceSpecSchema>;

/**
 * How a series describes itself back to the client. `preset` is the decompiled
 * form for pre-filling the edit form; it is NULL when the stored rule is
 * outside the restricted grammar (an import), in which case the UI shows
 * `summary` read-only and offers "replace the schedule" rather than "edit" it.
 */
export const recurrenceViewSchema = z.object({
  rrule: z.string().nullable(),
  dtstartLocal: floatingDateTimeSchema,
  timezone: timeZoneSchema,
  rdatesLocal: z.array(floatingDateTimeSchema),
  exdatesLocal: z.array(floatingDateTimeSchema),
  seriesEndsAt: isoDateTimeSchema.nullable(),
  materializedThrough: isoDateTimeSchema.nullable(),
  /** NULL => the rule is not expressible as a UI preset. */
  preset: recurrencePresetSchema.nullable(),
  ends: recurrenceEndSchema.nullable(),
  /** Human summary, already in Russian: "Каждый вторник и четверг, 09:00". */
  summary: z.string(),
});
export type RecurrenceView = z.infer<typeof recurrenceViewSchema>;

/* -------------------------------------------------------------------------- */
/* Shared mutation vocabulary                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which instances a mutation touches — the discriminator every recurring-item
 * edit and delete must carry (there is no safe default, so it is required).
 *
 * - `this`            — write an override on the one occurrence, flag it as an
 *                       exception; the rule is untouched.
 * - `this_and_future` — split: close the old series with an UNTIL just before
 *                       this occurrence, create a successor.
 * - `all`             — edit the series in place; non-exception occurrences are
 *                       re-materialized, exceptions are preserved.
 */
export const editScopeSchema = z.enum(['this', 'this_and_future', 'all']);
export type EditScope = z.infer<typeof editScopeSchema>;

export const visibilitySchema = z.enum(['household', 'private', 'restricted']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const occurrenceStatusSchema = z.enum(['scheduled', 'done', 'skipped', 'cancelled']);
export type OccurrenceStatus = z.infer<typeof occurrenceStatusSchema>;

export const assignedViaSchema = z.enum(['rotation', 'manual', 'swap', 'claimed']);
export type AssignedVia = z.infer<typeof assignedViaSchema>;

/**
 * A calendar window, expressed in **local dates** because that is what a grid
 * shows. The server resolves it to instants in the viewer timezone.
 */
export const calendarRangeBaseSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  /** Viewer timezone; defaults to the family timezone server-side. */
  timezone: timeZoneSchema.optional(),
});

/**
 * Ordering + span guard, shared by the task and event calendar queries. Capped
 * at 400 days so nobody asks for the whole of history in one grid request.
 */
export const calendarRangeCheck = (v: { from: string; to: string }, ctx: z.RefinementCtx): void => {
  if (v.from > v.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'from должно быть не позже to' });
    return;
  }
  const days = (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000;
  if (days > 400) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'Диапазон не может превышать 400 дней',
    });
  }
};

export const calendarRangeSchema = calendarRangeBaseSchema.superRefine(calendarRangeCheck);
export type CalendarRange = z.infer<typeof calendarRangeSchema>;

/* -------------------------------------------------------------------------- */
/* Task series                                                                 */
/* -------------------------------------------------------------------------- */

const taskSeriesFields = {
  title: nonEmptyString(200),
  notes: z.string().max(4000).nullish(),
  visibility: visibilitySchema.default('household'),
  /** Minutes from start to deadline; added in wall-clock terms. */
  dueOffsetMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  /** Lateness tolerated before a completion loses its on-time bonus. */
  graceMinutes: z.number().int().min(0).max(60 * 24 * 7).default(0),
  rotationId: idSchema.nullish(),
  defaultAssigneeId: idSchema.nullish(),
  points: z.number().int().min(0).max(1000).default(0),
  category: z.string().max(64).nullish(),
  autoCancelAfterDays: z.number().int().min(1).max(365).nullish(),
};

export const taskSeriesCreateSchema = z.object({
  ...taskSeriesFields,
  recurrence: recurrenceSpecSchema,
});
export type TaskSeriesCreate = z.infer<typeof taskSeriesCreateSchema>;

/**
 * `scope` is required: changing "every Monday" without saying whether you mean
 * this Monday, every Monday from now on, or all of history is the classic
 * calendar data-loss bug. `occurrenceId` anchors the `this` / `this_and_future`
 * split and is therefore required for those scopes.
 */
export const taskSeriesUpdateSchema = z
  .object({
    scope: editScopeSchema,
    occurrenceId: idSchema.optional(),
    title: nonEmptyString(200).optional(),
    notes: z.string().max(4000).nullish(),
    visibility: visibilitySchema.optional(),
    dueOffsetMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
    graceMinutes: z.number().int().min(0).max(60 * 24 * 7).optional(),
    rotationId: idSchema.nullish(),
    defaultAssigneeId: idSchema.nullish(),
    points: z.number().int().min(0).max(1000).optional(),
    category: z.string().max(64).nullish(),
    autoCancelAfterDays: z.number().int().min(1).max(365).nullish(),
    /** Omit to keep the schedule. Present => the schedule itself is changing. */
    recurrence: recurrenceSpecSchema.optional(),
  })
  .refine((v) => v.scope === 'all' || v.occurrenceId !== undefined, {
    message: 'occurrenceId обязателен для scope "this" и "this_and_future"',
    path: ['occurrenceId'],
  })
  .refine((v) => v.scope !== 'this' || v.recurrence === undefined, {
    message: 'Расписание нельзя изменить в рамках одного экземпляра',
    path: ['recurrence'],
  });
export type TaskSeriesUpdate = z.infer<typeof taskSeriesUpdateSchema>;

export const taskSeriesDeleteSchema = z
  .object({ scope: editScopeSchema, occurrenceId: idSchema.optional() })
  .refine((v) => v.scope === 'all' || v.occurrenceId !== undefined, {
    message: 'occurrenceId обязателен для scope "this" и "this_and_future"',
    path: ['occurrenceId'],
  });
export type TaskSeriesDelete = z.infer<typeof taskSeriesDeleteSchema>;

export const taskSeriesResponseSchema = z.object({
  id: idSchema,
  title: z.string(),
  notes: z.string().nullable(),
  visibility: visibilitySchema,
  createdById: idSchema,
  recurrence: recurrenceViewSchema,
  dueOffsetMinutes: z.number().int(),
  graceMinutes: z.number().int(),
  rotationId: idSchema.nullable(),
  defaultAssigneeId: idSchema.nullable(),
  points: z.number().int(),
  category: z.string().nullable(),
  autoCancelAfterDays: z.number().int().nullable(),
  supersedesSeriesId: idSchema.nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TaskSeriesResponse = z.infer<typeof taskSeriesResponseSchema>;

export const taskSeriesListQuerySchema = cursorPaginationSchema.extend({
  includeArchived: queryBooleanSchema.default(false),
  rotationId: idSchema.optional(),
  category: z.string().max(64).optional(),
  /** `true` => recurring only, `false` => one-offs only, omitted => both. */
  recurring: queryBooleanSchema.optional(),
});
export type TaskSeriesListQuery = z.infer<typeof taskSeriesListQuerySchema>;

export const taskSeriesListResponseSchema = paginatedSchema(taskSeriesResponseSchema);

/* -------------------------------------------------------------------------- */
/* Task occurrences                                                            */
/* -------------------------------------------------------------------------- */

export const taskOccurrenceResponseSchema = z.object({
  id: idSchema,
  seriesId: idSchema,
  /** The immutable identity of this instance (floating local datetime). */
  occurrenceKey: floatingDateTimeSchema,

  startsAt: isoDateTimeSchema,
  dueAt: isoDateTimeSchema,
  localDate: isoDateSchema,
  startsLocal: floatingDateTimeSchema,
  timezone: timeZoneSchema,

  status: occurrenceStatusSchema,
  isException: z.boolean(),

  /**
   * **Derived, never stored**: `status === 'scheduled' && dueAt + grace < now`.
   * Computed at read time so a row cannot rot into a stale state while nobody
   * is looking at it. See `docs/architecture/scheduling.md`.
   */
  isOverdue: z.boolean(),

  /** Already resolved: the override if present, otherwise the series value. */
  title: z.string(),
  notes: z.string().nullable(),
  points: z.number().int(),
  category: z.string().nullable(),
  visibility: visibilitySchema,

  assigneeId: idSchema.nullable(),
  assignedVia: assignedViaSchema.nullable(),
  completedById: idSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  skippedById: idSchema.nullable(),
  skipReason: z.string().nullable(),

  /** Set when a swap is live on this occurrence, so the card can show a badge. */
  pendingSwapId: idSchema.nullable(),

  createdAt: isoDateTimeSchema,
});
export type TaskOccurrenceResponse = z.infer<typeof taskOccurrenceResponseSchema>;

export const taskOccurrenceListQuerySchema = cursorPaginationSchema.extend({
  seriesId: idSchema.optional(),
  assigneeId: idSchema.optional(),
  /** `me` is resolved server-side from the session — the client never guesses. */
  assignee: z.literal('me').optional(),
  status: z.array(occurrenceStatusSchema).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** Filter to the derived overdue predicate. */
  overdueOnly: queryBooleanSchema.default(false),
  unassignedOnly: queryBooleanSchema.default(false),
  category: z.string().max(64).optional(),
});
export type TaskOccurrenceListQuery = z.infer<typeof taskOccurrenceListQuerySchema>;

export const taskOccurrenceListResponseSchema = paginatedSchema(taskOccurrenceResponseSchema);

/** The calendar/agenda read: a bounded local-date window, no pagination. */
export const taskCalendarQuerySchema = calendarRangeSchema;

/** Per-occurrence override. Always writes `isException = true`. */
export const taskOccurrenceUpdateSchema = z.object({
  titleOverride: z.string().max(200).nullish(),
  notesOverride: z.string().max(4000).nullish(),
  pointsOverride: z.number().int().min(0).max(1000).nullish(),
  /** Move this instance. Its `occurrenceKey` does **not** change. */
  startsLocal: floatingDateTimeSchema.optional(),
});
export type TaskOccurrenceUpdate = z.infer<typeof taskOccurrenceUpdateSchema>;

/**
 * Completion. `completedById` defaults to the caller; an adult may complete on
 * behalf of a child (`task:complete:any`), and the points then follow the
 * person named here, not the assignee (D5).
 */
export const taskCompleteSchema = z.object({
  completedById: idSchema.optional(),
  /** Backdating for "I did it last night, forgot to tick it". Never in the future. */
  completedAt: isoDateTimeSchema.optional(),
  note: z.string().max(500).optional(),
});
export type TaskComplete = z.infer<typeof taskCompleteSchema>;

/** Undo. Reverses the automatic ledger rows with compensating entries. */
export const taskUncompleteSchema = z.object({ reason: z.string().max(500).optional() });

export const taskSkipSchema = z.object({
  reason: z.string().max(500).optional(),
  /** `true` also writes an EXDATE so the slot never comes back on re-materialization. */
  suppressFuture: z.boolean().default(false),
});
export type TaskSkip = z.infer<typeof taskSkipSchema>;

export const taskAssignSchema = z.object({
  /** NULL => unassign and let anyone claim it. */
  assigneeId: idSchema.nullable(),
});
export type TaskAssign = z.infer<typeof taskAssignSchema>;

/** "Today" dashboard payload — one round trip for the home screen. */
export const taskTodayResponseSchema = z.object({
  date: isoDateSchema,
  timezone: timeZoneSchema,
  mine: z.array(taskOccurrenceResponseSchema),
  overdue: z.array(taskOccurrenceResponseSchema),
  unassigned: z.array(taskOccurrenceResponseSchema),
  familyDoneToday: z.number().int(),
});
export type TaskTodayResponse = z.infer<typeof taskTodayResponseSchema>;
