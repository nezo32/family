import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  fairnessQuerySchema,
  listGoalsQuerySchema,
  listPostsQuerySchema,
  listShoppingItemsQuerySchema,
  listShoppingListsQuerySchema,
  rotationPreviewQuerySchema,
  SHOPPING_ITEMS_MAX_LIMIT,
  taskSeriesListQuerySchema,
} from '@family/shared';

/**
 * Querystrings are strings.
 *
 * Every failure in this file was live: a schema that types a query parameter as
 * something other than a string, without saying how the string becomes it.
 * They are collected here rather than split across six module suites because
 * they are one bug wearing different hats, and because the next `z.number()` on
 * a querystring will be added by somebody who never opens the module that got
 * it wrong last time.
 *
 * Two shapes:
 *
 * - `z.number()` on a query parameter rejects `"7"` and 400s **every** call.
 *   Loud, immediate, and it still shipped, because the only tests that exercised
 *   the schema passed it a number.
 * - `z.coerce.boolean()` is worse, because it never fails: it is `Boolean(v)`,
 *   and every non-empty string is truthy, so `?includeArchived=false` parses as
 *   `true` and a toggle in the UI silently does nothing in one of its two
 *   positions. The half that works is the half a test with `true` covers.
 */

describe('query booleans: "false" must mean false', () => {
  /** Parses one field the way Fastify hands it over: as a string. */
  const parsed = (schema: z.ZodTypeAny, field: string, raw: string): unknown =>
    (schema.parse({ [field]: raw }) as Record<string, unknown>)[field];

  const cases: [string, z.ZodTypeAny, string][] = [
    ['goals', listGoalsQuerySchema, 'includeArchived'],
    ['shopping lists', listShoppingListsQuerySchema, 'includeArchived'],
    ['shopping items', listShoppingItemsQuerySchema, 'groupByCategory'],
    ['tasks', taskSeriesListQuerySchema, 'includeArchived'],
  ];

  for (const [name, schema, field] of cases) {
    it(`${name}: ?${field}=false excludes, ?${field}=true includes`, () => {
      expect(parsed(schema, field, 'false')).toBe(false);
      expect(parsed(schema, field, '0')).toBe(false);
      expect(parsed(schema, field, 'true')).toBe(true);
      expect(parsed(schema, field, '1')).toBe(true);
    });
  }

  it('keeps each default when the client sends nothing', () => {
    expect(listGoalsQuerySchema.parse({}).includeArchived).toBe(false);
    expect(listShoppingListsQuerySchema.parse({}).includeArchived).toBe(false);
    // `pinnedFirst` defaults the other way — the wall is useless without pins
    // on top — which makes it the case a `Boolean("false")` bug hides in.
    expect(listPostsQuerySchema.parse({}).pinnedFirst).toBe(true);
    expect(listPostsQuerySchema.parse({ pinnedFirst: 'false' }).pinnedFirst).toBe(false);
  });
});

describe('query numbers arrive as strings', () => {
  it('parses `windowDays` off the wire', () => {
    // Both callers of `GET /chores/fairness` always send this parameter, so a
    // bare `z.number()` here 400s every fairness request there is.
    expect(fairnessQuerySchema.parse({ windowDays: '7' }).windowDays).toBe(7);
    expect(fairnessQuerySchema.parse({}).windowDays).toBe(28);
    expect(() => fairnessQuerySchema.parse({ windowDays: '0' })).toThrow();
    expect(() => fairnessQuerySchema.parse({ windowDays: '400' })).toThrow();
  });

  it('parses the rotation preview `count` off the wire', () => {
    expect(rotationPreviewQuerySchema.parse({ count: '3' }).count).toBe(3);
    expect(rotationPreviewQuerySchema.parse({}).count).toBe(5);
  });
});

describe('page size', () => {
  it('serves a whole shopping list in one page', () => {
    // The client asks for 200 and scrolls; a shopping list is one screen in the
    // aisle, not a paginated history.
    expect(listShoppingItemsQuerySchema.parse({ limit: '200' }).limit).toBe(
      SHOPPING_ITEMS_MAX_LIMIT,
    );
    expect(listShoppingItemsQuerySchema.parse({}).limit).toBe(50);
    expect(() => listShoppingItemsQuerySchema.parse({ limit: '201' })).toThrow();
  });

  it('keeps the ordinary ceiling everywhere else', () => {
    expect(taskSeriesListQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(() => taskSeriesListQuerySchema.parse({ limit: '200' })).toThrow();
  });

  it('rejects a limit with a Russian message, like every other field', () => {
    const result = listGoalsQuerySchema.safeParse({ limit: '999' });
    expect(result.success).toBe(false);
    if (result.success) return;
    // The client appends the first raw `details` string to its own sentence, so
    // an English zod default would surface verbatim to a Russian user (D7 keeps
    // English for `AppError`, which is developer-facing — not for these).
    for (const issue of result.error.issues) {
      expect(issue.message, issue.path.join('.')).toMatch(/[А-Яа-яЁё]/);
    }
  });
});
