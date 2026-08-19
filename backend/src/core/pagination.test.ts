import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import * as choresRepo from '../modules/chores/chores.repository.js';
import * as eventsRepo from '../modules/events/events.repository.js';
import * as goalsRepo from '../modules/goals/goals.repository.js';
import * as shoppingRepo from '../modules/shopping/shopping.repository.js';
import type { ShoppingItemRow } from '../modules/shopping/shopping.schema.js';
import * as tasksRepo from '../modules/tasks/tasks.repository.js';
import * as wallRepo from '../modules/wall/wall.repository.js';
import {
  decodeCursor,
  decodeTimestampCursor,
  encodeCursor,
  encodeTimestampCursor,
  toPage,
  toTimestampPage,
} from './pagination.js';

/**
 * Seven modules had their own cursor codec, between them using four encodings
 * and three error policies. These tests pin down the single behaviour that
 * replaced them — and, module by module, that every list endpoint now speaks
 * it.
 */

describe('the cursor codec', () => {
  it('round-trips a `{ v, id }` cursor', () => {
    const cursor = { v: '2026-08-19T10:00:00.000Z', id: randomUUID() };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a `(createdAt, id)` cursor', () => {
    const row = { createdAt: new Date('2026-08-19T10:00:00.000Z'), id: randomUUID() };
    const decoded = decodeTimestampCursor(encodeTimestampCursor(row));
    expect(decoded?.id).toBe(row.id);
    expect(decoded?.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  it('is opaque — nothing client-side can read the sort key off it', () => {
    const encoded = encodeCursor({ v: '2026-08-19T10:00:00.000Z', id: 'abc' });
    expect(encoded).not.toContain('2026');
    expect(encoded).not.toContain('abc');
  });

  /**
   * The old policies: chores, wall, tasks and shopping answered `400 Malformed
   * cursor`; events, goals and notifications silently restarted. A cursor is a
   * token we issued — the realistic ways it goes bad are a redeploy that
   * changed the encoding, a truncated URL, or a bookmarked page-2 link, none of
   * which is the user doing something wrong.
   */
  it.each([
    ['junk', 'not-a-cursor'],
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['valid base64url that is not JSON', Buffer.from('hello').toString('base64url')],
    ['JSON that is not a cursor', Buffer.from('{"page":2}').toString('base64url')],
    ['JSON with a non-string `v`', Buffer.from('{"v":2,"id":"a"}').toString('base64url')],
    ['a cursor with an empty id', Buffer.from('{"v":"x","id":""}').toString('base64url')],
    ['a JSON array', Buffer.from('[1,2]').toString('base64url')],
    ['the old `iso|id` encoding', Buffer.from('2026-08-19T10:00:00.000Z|abc').toString('base64url')],
    ['the old offset encoding', Buffer.from('50').toString('base64url')],
  ])('returns null rather than throwing on %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
    expect(decodeTimestampCursor(raw)).toBeNull();
  });

  it('rejects a timestamp cursor whose key is not a date', () => {
    expect(decodeTimestampCursor(encodeCursor({ v: 'not-a-date', id: 'a' }))).toBeNull();
  });
});

describe('toPage', () => {
  const rows = [1, 2, 3].map((n) => ({
    id: `0000000${n}`,
    createdAt: new Date(`2026-08-1${n}T00:00:00.000Z`),
  }));

  it('emits no cursor when the page is not full', () => {
    expect(toTimestampPage(rows, 10)).toEqual({ items: rows, nextCursor: null });
  });

  it('trims the over-fetched row and points the cursor at the last kept one', () => {
    const page = toTimestampPage(rows, 2);
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodeTimestampCursor(page.nextCursor)?.id).toBe(rows[1]?.id);
  });

  it('emits no cursor when the result is exactly one page', () => {
    expect(toTimestampPage(rows, 3).nextCursor).toBeNull();
  });

  it('takes an arbitrary sort key, which is why `{ v, id }` won', () => {
    const page = toPage(rows, 2, (row) => ({ v: String(row.createdAt.getTime()), id: row.id }));
    expect(decodeCursor(page.nextCursor)?.v).toBe(String(rows[1]?.createdAt.getTime()));
  });
});

/**
 * The whole point of the consolidation: a cursor is now portable between
 * modules because there is only one codec left.
 */
describe('every module speaks the same cursor', () => {
  const row = { id: randomUUID(), createdAt: new Date('2026-08-19T10:00:00.000Z') };

  it('chores, wall and events encode `(createdAt, id)` identically', () => {
    const shared = encodeTimestampCursor(row);
    expect(choresRepo.encodeCursor(row)).toBe(shared);
    expect(wallRepo.encodeCursor(row)).toBe(shared);
    expect(eventsRepo.encodeCursor(row.createdAt, row.id)).toBe(shared);
  });

  it('goals and tasks encode `{ v, id }` identically', () => {
    const cursor = { v: '42', id: row.id };
    expect(goalsRepo.encodeCursor(cursor)).toBe(encodeCursor(cursor));
    expect(tasksRepo.encodeCursor(cursor)).toBe(encodeCursor(cursor));
  });

  it.each([
    ['chores', (raw: string) => choresRepo.decodeCursor(raw) ?? null],
    ['wall', (raw: string) => wallRepo.decodeCursor(raw) ?? null],
    ['events', (raw: string) => eventsRepo.decodeCursor(raw)],
    ['goals', (raw: string) => goalsRepo.decodeCursor(raw)],
    ['tasks', (raw: string) => tasksRepo.decodeCursor(raw)],
  ])('%s restarts pagination on a stale cursor instead of 400-ing', (_module, decode) => {
    // tasks, chores and wall used to throw `badRequest` here.
    expect(decode('not-a-cursor')).toBeNull();
    expect(decode('')).toBeNull();
  });
});

/**
 * Shopping was the odd one out twice over: an **offset** rather than a keyset,
 * and a `400` on a malformed cursor.
 */
describe('shopping item cursors', () => {
  const base: ShoppingItemRow = {
    id: '00000000-0000-4000-8000-000000000001',
    listId: '00000000-0000-4000-8000-0000000000aa',
    name: 'Молоко',
    quantity: '2.000',
    unit: 'л',
    category: 'молочное',
    note: null,
    requestedById: '00000000-0000-4000-8000-0000000000bb',
    state: 'needed',
    boughtById: null,
    boughtAt: null,
    isUrgent: false,
    sortOrder: 7,
    clientId: null,
    createdAt: new Date('2026-08-19T12:00:00.000Z'),
    updatedAt: new Date('2026-08-19T12:00:00.000Z'),
  };

  it('round-trips the full aisle ordering key, not a row offset', () => {
    const decoded = shoppingRepo.decodeItemCursor(shoppingRepo.encodeItemCursor(base));
    expect(decoded).toEqual({
      categoryIsNull: false,
      category: 'молочное',
      isDone: false,
      notUrgent: true,
      sortOrder: 7,
      createdAt: base.createdAt,
      id: base.id,
    });
  });

  it('normalises the two terms `ORDER BY` sorts backwards or nullably', () => {
    const urgentDone = shoppingRepo.decodeItemCursor(
      shoppingRepo.encodeItemCursor({
        ...base,
        category: null,
        state: 'bought',
        isUrgent: true,
      }),
    );
    // `is_urgent DESC` becomes ascending `notUrgent`; a null category sorts last
    // via the flag, and ties at `''` inside its own group.
    expect(urgentDone).toMatchObject({
      categoryIsNull: true,
      category: '',
      isDone: true,
      notUrgent: false,
    });
  });

  it.each([
    ['junk', 'not-a-cursor'],
    ['an old offset cursor', Buffer.from('50').toString('base64url')],
    ['a `{ v, id }` cursor whose `v` is not the item key', encodeCursor({ v: 'x', id: 'a' })],
    ['a key tuple of the wrong length', encodeCursor({ v: '[true,"a"]', id: 'a' })],
    ['a key tuple with a bad timestamp', encodeCursor({ v: '[false,"",false,true,0,"nope"]', id: 'a' })],
  ])('starts from the top on %s rather than 400-ing', (_label, raw) => {
    expect(shoppingRepo.decodeItemCursor(raw)).toBeNull();
  });

  it('is absent-safe, so `?cursor=` and no cursor at all behave the same', () => {
    expect(shoppingRepo.decodeItemCursor(undefined)).toBeNull();
    expect(shoppingRepo.decodeItemCursor('')).toBeNull();
  });
});
