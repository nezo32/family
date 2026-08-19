import { z } from 'zod';

import {
  cursorPaginationSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  paginatedSchema,
  timeZoneSchema,
} from './common.js';
import {
  calendarRangeBaseSchema,
  calendarRangeCheck,
  editScopeSchema,
  floatingDateTimeSchema,
  occurrenceStatusSchema,
  queryBooleanSchema,
  recurrenceSpecSchema,
  recurrenceViewSchema,
  visibilitySchema,
} from './tasks.js';

/**
 * Calendar events. The recurrence vocabulary (`recurrenceSpec`, `editScope`,
 * `calendarRange`) is shared with tasks and imported from `./tasks.js` — one
 * grammar, one compiler, one set of edge cases.
 *
 * **Birthdays are not a resource here.** They are an ordinary yearly event
 * series generated from `users.birthDate` by a job, so they appear in these
 * responses like anything else, with `sourceKind: 'user_birthday'`. Clients
 * must treat generated series as read-only (they are regenerated) and edit the
 * underlying profile instead.
 */

export const eventSourceKindSchema = z.enum(['manual', 'user_birthday', 'imported_ics']);
export type EventSourceKind = z.infer<typeof eventSourceKindSchema>;

export const rsvpSchema = z.enum(['pending', 'yes', 'no', 'maybe']);
export type Rsvp = z.infer<typeof rsvpSchema>;

/** Minutes before start. The set the UI offers; other values are accepted on import. */
export const reminderOffsetSchema = z.number().int().min(0).max(60 * 24 * 30);

/* -------------------------------------------------------------------------- */
/* Event series                                                                */
/* -------------------------------------------------------------------------- */

const eventSeriesFields = {
  title: nonEmptyString(200),
  description: z.string().max(4000).nullish(),
  location: z.string().max(200).nullish(),
  visibility: visibilitySchema.default('household'),
  /** Wall-clock minutes. Ignored when `isAllDay`. */
  durationMinutes: z.number().int().min(0).max(60 * 24 * 30).default(60),
  isAllDay: z.boolean().default(false),
  reminderOffsets: z.array(reminderOffsetSchema).max(5).default([]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Ожидается цвет в формате #RRGGBB')
    .nullish(),
  category: z.string().max(64).nullish(),
};

export const eventSeriesCreateSchema = z.object({
  ...eventSeriesFields,
  recurrence: recurrenceSpecSchema,
  /**
   * Who is invited. Fanned out across every materialized occurrence as
   * `pending`. Empty => a family-wide event nobody has to answer for.
   */
  attendeeIds: z.array(idSchema).max(50).default([]),
});
export type EventSeriesCreate = z.infer<typeof eventSeriesCreateSchema>;

export const eventSeriesUpdateSchema = z
  .object({
    scope: editScopeSchema,
    occurrenceId: idSchema.optional(),
    title: nonEmptyString(200).optional(),
    description: z.string().max(4000).nullish(),
    location: z.string().max(200).nullish(),
    visibility: visibilitySchema.optional(),
    durationMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
    isAllDay: z.boolean().optional(),
    reminderOffsets: z.array(reminderOffsetSchema).max(5).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Ожидается цвет в формате #RRGGBB')
      .nullish(),
    category: z.string().max(64).nullish(),
    attendeeIds: z.array(idSchema).max(50).optional(),
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
export type EventSeriesUpdate = z.infer<typeof eventSeriesUpdateSchema>;

export const eventSeriesDeleteSchema = z
  .object({ scope: editScopeSchema, occurrenceId: idSchema.optional() })
  .refine((v) => v.scope === 'all' || v.occurrenceId !== undefined, {
    message: 'occurrenceId обязателен для scope "this" и "this_and_future"',
    path: ['occurrenceId'],
  });
export type EventSeriesDelete = z.infer<typeof eventSeriesDeleteSchema>;

export const eventSeriesResponseSchema = z.object({
  id: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  visibility: visibilitySchema,
  createdById: idSchema,
  recurrence: recurrenceViewSchema,
  durationMinutes: z.number().int(),
  isAllDay: z.boolean(),
  reminderOffsets: z.array(z.number().int()),
  color: z.string().nullable(),
  category: z.string().nullable(),
  sourceKind: eventSourceKindSchema,
  /** TRUE for generated series (birthdays, imports): edit the source, not this. */
  isReadOnly: z.boolean(),
  supersedesSeriesId: idSchema.nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EventSeriesResponse = z.infer<typeof eventSeriesResponseSchema>;

export const eventSeriesListQuerySchema = cursorPaginationSchema.extend({
  includeArchived: queryBooleanSchema.default(false),
  category: z.string().max(64).optional(),
  sourceKind: eventSourceKindSchema.optional(),
});
export type EventSeriesListQuery = z.infer<typeof eventSeriesListQuerySchema>;

export const eventSeriesListResponseSchema = paginatedSchema(eventSeriesResponseSchema);

/* -------------------------------------------------------------------------- */
/* Event occurrences                                                           */
/* -------------------------------------------------------------------------- */

export const eventAttendeeResponseSchema = z.object({
  userId: idSchema,
  rsvp: rsvpSchema,
  respondedAt: isoDateTimeSchema.nullable(),
});
export type EventAttendeeResponse = z.infer<typeof eventAttendeeResponseSchema>;

export const eventOccurrenceResponseSchema = z.object({
  id: idSchema,
  seriesId: idSchema,
  /** Immutable identity of the instance (floating local datetime). */
  occurrenceKey: floatingDateTimeSchema,

  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  localDate: isoDateSchema,
  startsLocal: floatingDateTimeSchema,
  timezone: timeZoneSchema,

  status: occurrenceStatusSchema,
  isException: z.boolean(),

  /** Resolved: override if present, otherwise the series value. */
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  isAllDay: z.boolean(),
  color: z.string().nullable(),
  category: z.string().nullable(),
  visibility: visibilitySchema,
  sourceKind: eventSourceKindSchema,

  attendees: z.array(eventAttendeeResponseSchema),
  /** The caller's own answer, hoisted so the card does not have to scan. */
  myRsvp: rsvpSchema.nullable(),

  createdAt: isoDateTimeSchema,
});
export type EventOccurrenceResponse = z.infer<typeof eventOccurrenceResponseSchema>;

/** The month/week/agenda read. Bounded local-date window, no pagination. */
export const eventCalendarQuerySchema = calendarRangeBaseSchema
  .extend({
    category: z.string().max(64).optional(),
    /** Only events this user attends. */
    attendeeId: idSchema.optional(),
    includeCancelled: queryBooleanSchema.default(false),
    /** Fold task occurrences into the same feed for a unified calendar. */
    includeTasks: queryBooleanSchema.default(false),
  })
  .superRefine(calendarRangeCheck);
export type EventCalendarQuery = z.infer<typeof eventCalendarQuerySchema>;

export const eventOccurrenceListQuerySchema = cursorPaginationSchema.extend({
  seriesId: idSchema.optional(),
  attendeeId: idSchema.optional(),
  status: z.array(occurrenceStatusSchema).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type EventOccurrenceListQuery = z.infer<typeof eventOccurrenceListQuerySchema>;

export const eventOccurrenceListResponseSchema = paginatedSchema(eventOccurrenceResponseSchema);

/** Per-occurrence override. Always sets `isException = true`. */
export const eventOccurrenceUpdateSchema = z.object({
  titleOverride: z.string().max(200).nullish(),
  descriptionOverride: z.string().max(4000).nullish(),
  locationOverride: z.string().max(200).nullish(),
  isAllDayOverride: z.boolean().nullish(),
  /** Move this instance. `occurrenceKey` never changes. */
  startsLocal: floatingDateTimeSchema.optional(),
  /** Wall-clock length of this instance only. */
  durationMinutes: z.number().int().min(0).max(60 * 24 * 30).optional(),
});
export type EventOccurrenceUpdate = z.infer<typeof eventOccurrenceUpdateSchema>;

export const eventRsvpSchema = z.object({
  rsvp: rsvpSchema,
  /** Answer for somebody else (a parent answering for a child). Needs `event:update:any`. */
  userId: idSchema.optional(),
  /** Apply to every future occurrence of the series, not just this one. */
  applyToFuture: z.boolean().default(false),
});
export type EventRsvp = z.infer<typeof eventRsvpSchema>;

export const eventAttendeesUpdateSchema = z.object({
  scope: editScopeSchema,
  attendeeIds: z.array(idSchema).max(50),
});
export type EventAttendeesUpdate = z.infer<typeof eventAttendeesUpdateSchema>;

/** Agenda strip for the Today dashboard. */
export const eventTodayResponseSchema = z.object({
  date: isoDateSchema,
  timezone: timeZoneSchema,
  today: z.array(eventOccurrenceResponseSchema),
  tomorrow: z.array(eventOccurrenceResponseSchema),
  awaitingMyRsvp: z.array(eventOccurrenceResponseSchema),
});
export type EventTodayResponse = z.infer<typeof eventTodayResponseSchema>;
