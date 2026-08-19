import { z } from 'zod';
import { ERROR_CODES } from '../domain/errors.js';

/** UUID v4/v7 identifier used by every entity. */
export const idSchema = z.string().uuid();
export type Id = z.infer<typeof idSchema>;

/** ISO-8601 instant in UTC, e.g. `2026-08-19T09:00:00.000Z`. */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Calendar date without a time component, e.g. `2026-08-19`. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается формат ГГГГ-ММ-ДД');

/** Local wall-clock time, e.g. `09:30`. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Ожидается ЧЧ:ММ');

/** IANA timezone name. Defaults come from the family settings. */
export const timeZoneSchema = z.string().min(1).max(64);

export const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);

/** Money is stored as integer minor units (копейки) to avoid float drift. */
export const minorUnitsSchema = z.number().int();
export const positiveMinorUnitsSchema = z.number().int().positive();
export const currencySchema = z.string().length(3).default('RUB');

export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export const paginatedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export type Paginated<T> = { items: T[]; nextCursor: string | null };

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.array(z.string())).optional(),
    requestId: z.string().optional(),
  }),
});

export const okSchema = z.object({ ok: z.literal(true) });

/** Standard `204`-like response body for mutations that return nothing useful. */
export const emptySchema = z.object({}).strict();

/** Sort direction shared by list endpoints. */
export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');

/**
 * Chore-rotation capacity multiplier, stored as `numeric(4,2)`.
 *
 * Carried on the wire as a decimal STRING, not a number: postgres `numeric`
 * round-trips through Drizzle as a string, and going via a float would let
 * 0.35 become 0.34999999999999998 on its way back into the fairness maths.
 */
export const choreWeightSchema = z
  .string()
  .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Ожидается вес вида 1.00')
  .refine((v) => Number(v) <= 99.99, 'Максимальный вес — 99.99');
