import { z } from 'zod';
import { ERROR_CODES } from '../domain/errors.js';

/**
 * Shared validation primitives.
 *
 * ## Every message here is Russian, on purpose
 *
 * The client maps `error.code` to a Russian sentence and appends the first
 * `details` string so the user learns *which* field is wrong. That string is
 * whatever zod put in the issue, so a schema without a custom message leaks
 * zod's English default («Проверьте поля — String must contain at least 1
 * character(s)») into a Russian UI. `AppError` messages stay English (D7 —
 * they are developer-facing); validation messages are user-facing and are not.
 */

/** UUID v4/v7 identifier used by every entity. */
export const idSchema = z.string().uuid('Ожидается идентификатор в формате UUID');
export type Id = z.infer<typeof idSchema>;

/** ISO-8601 instant in UTC, e.g. `2026-08-19T09:00:00.000Z`. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: 'Ожидается дата и время в формате ISO-8601' });

/** Calendar date without a time component, e.g. `2026-08-19`. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается формат ГГГГ-ММ-ДД');

/** Local wall-clock time, e.g. `09:30`. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Ожидается ЧЧ:ММ');

/** IANA timezone name. Defaults come from the family settings. */
export const timeZoneSchema = z
  .string()
  .min(1, 'Укажите часовой пояс')
  .max(64, 'Не длиннее 64 символов');

export const nonEmptyString = (max: number) =>
  z.string().trim().min(1, 'Поле не может быть пустым').max(max, `Не длиннее ${max} символов`);

/** Money is stored as integer minor units (копейки) to avoid float drift. */
export const minorUnitsSchema = z.number().int('Ожидается целое число копеек');
export const positiveMinorUnitsSchema = z
  .number()
  .int('Ожидается целое число копеек')
  .positive('Сумма должна быть больше нуля');
export const currencySchema = z
  .string()
  .length(3, 'Код валюты состоит из трёх букв')
  .default('RUB');

/** Page size a list endpoint serves when the client asks for nothing specific. */
export const DEFAULT_PAGE_SIZE = 50;
/** The cap that protects an ordinary list endpoint from a whole-table request. */
export const MAX_PAGE_SIZE = 100;

/**
 * `limit` for a cursor-paginated list.
 *
 * `z.coerce.number()` because this is a querystring: `?limit=50` arrives as the
 * string `"50"`.
 *
 * The cap is a parameter rather than a constant because it is a per-endpoint
 * judgement, not a global truth: a shopping list is a single screen the user
 * scrolls to the bottom of while standing in the aisle, and paginating it would
 * be a worse product for no safety gained. Endpoints that page over history
 * (ledgers, activity, notifications) keep `MAX_PAGE_SIZE`.
 */
export const paginationLimitSchema = (max = MAX_PAGE_SIZE, fallback = DEFAULT_PAGE_SIZE) =>
  z.coerce
    .number()
    .int('Ожидается целое число')
    .min(1, 'Минимум одна запись')
    .max(max, `Не больше ${max} записей за раз`)
    .default(fallback);

export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: paginationLimitSchema(),
});
export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

/**
 * The same cursor pagination with a different ceiling. Use it — rather than
 * raising `MAX_PAGE_SIZE` — when one endpoint genuinely needs a bigger page,
 * so the wider limit stays visible at the endpoint that asked for it.
 */
export const cursorPaginationWithLimit = (max: number, fallback = DEFAULT_PAGE_SIZE) =>
  z.object({
    cursor: z.string().optional(),
    limit: paginationLimitSchema(max, fallback),
  });

/**
 * Query-string booleans.
 *
 * `z.coerce.boolean()` is a trap here: it is `Boolean(value)`, and every
 * non-empty string is truthy, so `?includeArchived=false` parses as **true**
 * and the toggle silently does nothing. Lives in `common` because six modules
 * need it and the module that happened to discover the bug is not the one that
 * owns the primitive.
 */
export const queryBooleanSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v === 'true' || v === '1' : v),
  z.boolean(),
);

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
