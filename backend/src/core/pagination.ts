/**
 * Keyset pagination — one cursor codec for every list endpoint.
 *
 * ## What this replaces
 *
 * Seven modules had written their own: `chores`, `wall`, `events`, `goals`,
 * `tasks`, `notifications` and `shopping`. Between them they used **four
 * encodings** (`base64url("iso|id")`, `base64url(JSON {v,id})`,
 * `base64url("offset")`, and a raw-ish variant) and **three error policies**, so
 * the same expired-tab reload behaved three different ways depending on which
 * tab it was:
 *
 * | a stale or corrupt `?cursor=` | before | now |
 * |---|---|---|
 * | chores, wall, tasks, shopping | `400 Malformed cursor` | first page |
 * | events, goals, notifications  | silently first page    | first page |
 *
 * | an empty `?cursor=` | before | now |
 * |---|---|---|
 * | goals, shopping | first page | first page |
 * | chores, wall, tasks | `400` (chores/wall) or first page (tasks) | first page |
 *
 * ## The two decisions
 *
 * **The `{ v, id }` JSON form wins.** `"iso|id"` only ever encoded a timestamp
 * key; `{ v, id }` carries any sort key as text (a timestamp, a `sort_order`, a
 * composite) and is what `tasks` and `goals` — the two modules with non-trivial
 * ordering — already used. `encodeTimestampCursor` keeps the common
 * `(created_at, id)` case a one-liner.
 *
 * **A malformed cursor is `null`, never a 400.** A cursor is an opaque token
 * the client got from us; the only realistic ways it goes bad are a redeploy
 * that changed the encoding, a truncated URL, or a bookmarked page-2 link. None
 * of those is the user doing something wrong, and answering a scroll-to-load
 * with a red error is worse than answering it with the first page. Callers that
 * genuinely need to distinguish "no cursor" from "bad cursor" can compare the
 * raw string themselves — nothing in this repo does.
 *
 * Cursors are **not** signed or encrypted. They encode a sort key that is
 * already in the response body; base64url exists only so nothing client-side
 * starts parsing the shape and depending on it.
 */

/**
 * An opaque page marker: the sort key of the last row of the previous page,
 * plus its id.
 *
 * `id` is always part of the key. Two rows can share a millisecond — two ledger
 * entries from one completion, two items added by one bulk paste — and without
 * the id as a tiebreaker the page boundary skips or repeats one of them.
 */
export interface Cursor {
  /** The sort key of the last row of the previous page, as text. */
  readonly v: string;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or `null` for absent, empty, or unreadable input.
 *
 * Never throws and never rejects the request — see the policy note above.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, id } = parsed as Partial<Cursor>;
  if (typeof v !== 'string' || typeof id !== 'string' || id === '') return null;
  return { v, id };
}

/* -------------------------------------------------------------------------- */
/* The `(created_at, id)` keyset — what most lists are ordered by              */
/* -------------------------------------------------------------------------- */

/** A row that can be paged by creation time. */
export interface Timestamped {
  readonly createdAt: Date;
  readonly id: string;
}

export interface TimestampCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeTimestampCursor(row: Timestamped): string {
  return encodeCursor({ v: row.createdAt.toISOString(), id: row.id });
}

/** `decodeCursor` plus the ISO-timestamp parse. `null` on anything unreadable. */
export function decodeTimestampCursor(raw: string | null | undefined): TimestampCursor | null {
  const cursor = decodeCursor(raw);
  if (!cursor) return null;
  const createdAt = new Date(cursor.v);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: cursor.id };
}

/* -------------------------------------------------------------------------- */
/* Assembling a page                                                           */
/* -------------------------------------------------------------------------- */

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/**
 * Split an over-fetched `limit + 1` result into a page plus the cursor for the
 * next one.
 *
 * Over-fetching by exactly one row is the cheapest possible "is there more?":
 * it needs no `COUNT(*)`, and — unlike a count — it cannot disagree with the
 * rows actually returned.
 */
export function toPage<T>(rows: readonly T[], limit: number, key: (row: T) => Cursor): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(key(last)) : null,
  };
}

/** {@link toPage} for the `(created_at, id)` keyset. */
export function toTimestampPage<T extends Timestamped>(rows: readonly T[], limit: number): Page<T> {
  return toPage(rows, limit, (row) => ({ v: row.createdAt.toISOString(), id: row.id }));
}
