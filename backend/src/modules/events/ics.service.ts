import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { getConfig } from '../../core/config.js';
import { AppError } from '../../core/errors.js';

/**
 * The read-only ICS feed (D9, `docs/architecture/scheduling.md` §8).
 *
 * This is the highest-leverage feature in the calendar backlog and the reason
 * it is worth being pedantic here: **adults will not maintain two calendars.**
 * If the family calendar does not appear inside the iPhone's own Calendar app
 * next to work and school, it is a website somebody has to remember to open,
 * and it dies. A subscribed ICS URL costs the user one paste and then never
 * needs attention again.
 *
 * Everything in this file is **pure** — string in, string out — so the parts
 * that are easy to get subtly wrong (octet folding, escaping, the all-day date
 * range) are unit-tested without a database or an HTTP server.
 *
 * ## The two failure modes this file is built around
 *
 * **1. Folding is measured in octets, not characters (RFC 5545 §3.1).**
 * A line may not exceed 75 *octets*. «День рождения Марии» is 19 characters and
 * 35 octets in UTF-8. An implementation that folds at 75 *characters* emits
 * 140-octet lines; worse, one that slices a JS string at a byte offset splits a
 * two-byte Cyrillic code point down the middle, and Apple Calendar renders the
 * result as replacement characters — or drops the event. {@link foldLine}
 * therefore works on a `Buffer` and always retreats to a UTF-8 code-point
 * boundary.
 *
 * **2. An all-day event is a date range, not a midnight-to-midnight instant
 * range.** It is emitted as `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` with an
 * **exclusive** end (RFC 5545 §3.8.2.2), so a one-day event on the 7th is
 * `20260907` → `20260908`. Emitting the local midnights as UTC instants shifts
 * the event a day for every viewer whose offset has the opposite sign, and
 * emitting an inclusive DTEND makes every all-day event two days long. Both
 * bugs are famous, and both are silent.
 */

/* -------------------------------------------------------------------------- */
/* Line handling                                                               */
/* -------------------------------------------------------------------------- */

/** RFC 5545 §3.1: a content line may not exceed 75 octets, excluding CRLF. */
export const ICS_LINE_OCTETS = 75;

/** RFC 5545 requires CRLF between content lines. Not `\n`. */
export const CRLF = '\r\n';

/**
 * Escape a TEXT value: RFC 5545 §3.3.11.
 *
 * Backslash first — escaping it after the others would double-escape the
 * backslashes they introduced. `:` is deliberately **not** escaped: it is only
 * special in the property-name/value separator, and escaping it breaks Outlook.
 */
export function escapeText(value: string): string {
  return (
    value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n')
      // Control characters are not valid in a TEXT value and are the usual
      // vehicle for line injection from a user-supplied title. TAB is legal and
      // is kept; everything else below U+0020, plus DEL, is dropped.
      // eslint-disable-next-line no-control-regex -- dropping them is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  );
}

/** True when the buffer ends in an odd run of `\`, i.e. mid-escape-sequence. */
function endsWithOddBackslashRun(bytes: Buffer, end: number): boolean {
  let run = 0;
  let i = end - 1;
  while (i >= 0 && bytes[i] === 0x5c) {
    run += 1;
    i -= 1;
  }
  return run % 2 === 1;
}

/**
 * Fold one content line into physical lines of at most {@link ICS_LINE_OCTETS}
 * octets each, continuation lines prefixed with a single space.
 *
 * Octet-aware in three ways, each of which is a real bug if you skip it:
 *
 * 1. the budget is measured on the UTF-8 **bytes**, not on `String.length`;
 * 2. a split never lands inside a multi-byte code point — the cut retreats
 *    while the byte at the boundary is a continuation byte (`10xxxxxx`);
 * 3. a split never lands between a `\` and the character it escapes. Unfolding
 *    would restore it, but several clients unescape before unfolding.
 */
export function foldLine(line: string): string[] {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= ICS_LINE_OCTETS) return [line];

  const out: string[] = [];
  let offset = 0;
  let first = true;

  while (offset < bytes.length) {
    // Continuation lines spend one octet of their budget on the leading space.
    const budget = first ? ICS_LINE_OCTETS : ICS_LINE_OCTETS - 1;
    let end = Math.min(offset + budget, bytes.length);

    if (end < bytes.length) {
      // Retreat off a UTF-8 continuation byte (0b10xxxxxx).
      while (end > offset + 1 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      // Retreat off a dangling escape backslash.
      if (endsWithOddBackslashRun(bytes, end) && end > offset + 1) end -= 1;
    }

    const chunk = bytes.subarray(offset, end).toString('utf8');
    out.push(first ? chunk : ` ${chunk}`);
    offset = end;
    first = false;
  }

  return out;
}

/** Join content lines into the CRLF-delimited, folded body of a component. */
export function serializeLines(lines: readonly string[]): string {
  return lines.flatMap((line) => foldLine(line)).join(CRLF);
}

/* -------------------------------------------------------------------------- */
/* Date formatting                                                             */
/* -------------------------------------------------------------------------- */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `20260907T060000Z` — the RFC 5545 UTC DATE-TIME form. */
export function formatUtcStamp(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new AppError('INTERNAL_ERROR', 'Invalid ICS instant');
  return (
    `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
    `T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
  );
}

/** `2026-09-07` → `20260907` — the RFC 5545 DATE form. */
export function formatIcsDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(localDate);
  if (!match) throw new AppError('INTERNAL_ERROR', `Invalid ICS local date: ${localDate}`);
  return `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}`;
}

/** Add whole days to a `YYYY-MM-DD` string, in the calendar, not in instants. */
export function addLocalDays(localDate: string, days: number): string {
  const parsed = Date.parse(`${localDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new AppError('INTERNAL_ERROR', `Invalid local date: ${localDate}`);
  }
  const moved = new Date(parsed + days * 86_400_000);
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** Minutes → an RFC 5545 negative duration, e.g. `-PT1H30M`, `-P7D`. */
export function formatAlarmTrigger(minutesBefore: number): string {
  const total = Math.max(0, Math.trunc(minutesBefore));
  if (total === 0) return '-PT0M';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  // A whole number of days reads better to a human as `-P7D` than `-PT168H`,
  // and Apple Calendar shows it as "за 1 неделю".
  if (days > 0 && hours === 0 && minutes === 0) return `-P${days}D`;
  const time = `${hours > 0 ? `${hours}H` : ''}${minutes > 0 ? `${minutes}M` : ''}`;
  return days > 0 ? `-P${days}DT${time || '0M'}` : `-PT${time}`;
}

/* -------------------------------------------------------------------------- */
/* The calendar model                                                          */
/* -------------------------------------------------------------------------- */

export type IcsEventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

export interface IcsEvent {
  /** Globally unique and **stable across regenerations** — see `uidFor`. */
  readonly uid: string;
  /** Bumped whenever the event is edited (RFC 5545 §3.8.7.4). */
  readonly sequence: number;
  readonly summary: string;
  readonly description?: string | null;
  readonly location?: string | null;

  readonly isAllDay: boolean;
  /** Inclusive local start date, `YYYY-MM-DD`. Used when `isAllDay`. */
  readonly startLocalDate: string;
  /** **Exclusive** local end date, `YYYY-MM-DD`. Used when `isAllDay`. */
  readonly endLocalDateExclusive: string;

  /** Resolved instants. Used when not `isAllDay`. */
  readonly startsAt: Date;
  readonly endsAt: Date;

  readonly status?: IcsEventStatus;
  readonly categories?: readonly string[];
  /** Minutes before the start; each becomes a `VALARM`. */
  readonly reminderOffsets?: readonly number[];

  readonly dtstamp: Date;
  readonly created?: Date;
  readonly lastModified?: Date;
  /** URL back into the PWA, so tapping the event in Calendar opens the app. */
  readonly url?: string;
}

export interface IcsCalendar {
  /** `X-WR-CALNAME`, in Russian — this is the name the phone shows. */
  readonly name: string;
  /** IANA id for `X-WR-TIMEZONE`. */
  readonly timezone: string;
  readonly description?: string;
  readonly events: readonly IcsEvent[];
  /** How often a subscribing client should poll. */
  readonly refreshIntervalMinutes?: number;
}

/** `-//Family//Календарь//RU` — identifies the product that wrote the file. */
export const ICS_PRODID = '-//Family App//Family Calendar 1.0//RU';

/**
 * A UID that survives re-materialization.
 *
 * Derived from `seriesId` + `occurrenceKey` rather than from the occurrence
 * **row id**, because the row is deleted and recreated by the "edit all future"
 * split and by a schedule change (§3.3/§3.4). A row-id UID would make every
 * such edit look to Apple Calendar like a *deletion plus a new event*: the user
 * loses their local alerts and any per-event notes. `occurrenceKey` is the
 * immutable identity of an instance, so this UID is too.
 */
export function uidFor(seriesId: string, occurrenceKey: string): string {
  return `${seriesId}-${occurrenceKey.replace(/[-:]/g, '')}@family.calendar`;
}

/**
 * `SEQUENCE` from the series' own timestamps.
 *
 * RFC 5545 only requires a non-negative integer that does not decrease between
 * revisions. Seconds-since-creation of the series satisfies that without a
 * revision column: every `UPDATE` moves `updated_at` forward, so the number
 * grows monotonically for a given UID.
 */
export function sequenceFor(createdAt: Date, updatedAt: Date): number {
  const seconds = Math.floor((updatedAt.getTime() - createdAt.getTime()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

function textProperty(name: string, value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const trimmed = value.trim();
  if (trimmed === '') return [];
  return [`${name}:${escapeText(trimmed)}`];
}

function alarmLines(event: IcsEvent): string[] {
  const offsets = [...new Set(event.reminderOffsets ?? [])].sort((a, b) => b - a);
  return offsets.flatMap((minutes) => [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `TRIGGER:${formatAlarmTrigger(minutes)}`,
    `DESCRIPTION:${escapeText(event.summary)}`,
    'END:VALARM',
  ]);
}

export function eventLines(event: IcsEvent): string[] {
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtcStamp(event.dtstamp)}`,
  ];

  if (event.isAllDay) {
    // The whole point: a date range in the family's own calendar, with an
    // EXCLUSIVE end. `20260907` → `20260908` is one day, not two, and it does
    // not move when the reader is in another timezone.
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(event.startLocalDate)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDate(event.endLocalDateExclusive)}`);
  } else {
    lines.push(`DTSTART:${formatUtcStamp(event.startsAt)}`);
    lines.push(`DTEND:${formatUtcStamp(event.endsAt)}`);
  }

  lines.push(`SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`);
  lines.push(...textProperty('SUMMARY', event.summary));
  lines.push(...textProperty('DESCRIPTION', event.description));
  lines.push(...textProperty('LOCATION', event.location));

  const categories = (event.categories ?? []).filter((c) => c.trim() !== '');
  if (categories.length > 0) {
    lines.push(`CATEGORIES:${categories.map((c) => escapeText(c)).join(',')}`);
  }

  lines.push(`STATUS:${event.status ?? 'CONFIRMED'}`);
  lines.push(`TRANSP:${event.isAllDay ? 'TRANSPARENT' : 'OPAQUE'}`);
  if (event.created) lines.push(`CREATED:${formatUtcStamp(event.created)}`);
  if (event.lastModified) lines.push(`LAST-MODIFIED:${formatUtcStamp(event.lastModified)}`);
  if (event.url) lines.push(`URL:${event.url}`);

  lines.push(...alarmLines(event));
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Build the whole `VCALENDAR`.
 *
 * No `VTIMEZONE` component is emitted, on purpose: every timed event carries a
 * UTC `DTSTART`/`DTEND`, which RFC 5545 §3.3.5 permits and which sidesteps
 * shipping a hand-rolled tzdb that would go stale the next time Russian time
 * law changes (three times in a decade — D2). All-day events carry no time at
 * all, so they need no zone either. `X-WR-TIMEZONE` tells the client which zone
 * the calendar *thinks* in, for display.
 */
export function buildIcsCalendar(calendar: IcsCalendar): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timezone}`,
  ];

  if (calendar.description !== undefined && calendar.description.trim() !== '') {
    lines.push(`X-WR-CALDESC:${escapeText(calendar.description)}`);
  }

  const refresh = calendar.refreshIntervalMinutes ?? 60;
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`);
  lines.push(`X-PUBLISHED-TTL:PT${refresh}M`);

  for (const event of calendar.events) lines.push(...eventLines(event));
  lines.push('END:VCALENDAR');

  // Trailing CRLF: RFC 5545 wants every content line, including the last one,
  // terminated. Several parsers drop an unterminated final line.
  return `${serializeLines(lines)}${CRLF}`;
}

/** Weak ETag over the rendered body, for `If-None-Match` (304) support. */
export function icsEtag(body: string): string {
  return `W/"${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)}"`;
}

/* -------------------------------------------------------------------------- */
/* The feed token                                                              */
/* -------------------------------------------------------------------------- */

/**
 * ## Why the URL carries a token at all
 *
 * A calendar client cannot send an `Authorization` header. iOS Calendar fetches
 * a subscribed URL from a background daemon with no session, no cookie jar and
 * no way to run our refresh flow. So the credential has to be **in the URL**,
 * which is why the route is `config: { public: true }` and authenticates from
 * the token alone (D4 allows this only because the token *is* the guard).
 *
 * ## The design
 *
 * ```
 * f1.<userId without dashes>.<revocation epoch, base36>.<HMAC-SHA256, base64url>
 * ```
 *
 * - **Unguessable.** The signature is a full 256-bit HMAC. Forging one without
 *   the key is not a thing that happens.
 * - **Not the session token.** The key is derived from `COOKIE_SECRET` through
 *   a distinct info string, so a feed token can never be replayed as a session
 *   credential and a leaked feed URL grants *read-only calendar* and nothing
 *   else. It is also the reason a feed token must never be minted from
 *   `JWT_ACCESS_SECRET`.
 * - **Revocable.** The signed payload contains the user's revocation epoch. The
 *   verifier recomputes the signature and then the caller checks the epoch
 *   still matches the stored one (`repo.getFeedRevocationEpoch`). Bumping the
 *   epoch — "заменить ссылку" in Settings — instantly invalidates every URL
 *   ever handed out, and the replacement URL is deterministic, so the same user
 *   asking twice gets the same link back instead of accumulating live tokens.
 *
 * ## The trade-off, stated plainly
 *
 * The epoch lives in `audit_log` because this agent may not add a table. A
 * dedicated `calendar_feed_tokens` row (hash, label, `last_used_at`,
 * `revoked_at`) would be better: it would give per-device links, a
 * "last synced" display, and a revocation read that does not scan an
 * append-only log. **Flagged for the lead** — swapping the two functions in
 * `events.repository.ts` is the entire migration; nothing else changes.
 */
export const FEED_TOKEN_VERSION = 'f1';

const FEED_TOKEN_INFO = 'family:calendar-feed:v1';

/** Domain-separated key. Never `JWT_ACCESS_SECRET`, never the raw secret. */
function feedKey(): Buffer {
  return createHmac('sha256', getConfig().COOKIE_SECRET).update(FEED_TOKEN_INFO).digest();
}

function signPayload(payload: string): string {
  return createHmac('sha256', feedKey()).update(payload, 'utf8').digest('base64url');
}

const COMPACT_UUID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function compactUuid(id: string): string {
  const compact = id.toLowerCase().replace(/-/g, '');
  if (!COMPACT_UUID.test(compact)) {
    throw new AppError('BAD_REQUEST', 'Feed token requires a uuid user id');
  }
  return compact;
}

function expandUuid(compact: string): string | null {
  if (!COMPACT_UUID.test(compact)) return null;
  const id = [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
  return UUID.test(id) ? id : null;
}

/**
 * Mint the (deterministic) feed token for a user at a given revocation epoch.
 * Same inputs ⇒ same token, so "показать мою ссылку" never rotates it by
 * accident.
 */
export function mintFeedToken(userId: string, revocationEpochMs: number): string {
  const epoch = Math.max(0, Math.trunc(revocationEpochMs));
  const payload = `${FEED_TOKEN_VERSION}.${compactUuid(userId)}.${epoch.toString(36)}`;
  return `${payload}.${signPayload(payload)}`;
}

export interface ParsedFeedToken {
  readonly userId: string;
  readonly revocationEpochMs: number;
}

/**
 * Verify the signature and return the claims, or `null`.
 *
 * A `null` here is "this string is not one of ours". The **epoch still has to be
 * checked against the database** by the caller — that check is what makes
 * revocation work, and it is deliberately not done here so this function stays
 * pure and testable.
 */
export function parseFeedToken(token: string): ParsedFeedToken | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, compact, epochRaw, signature] = parts;
  if (version !== FEED_TOKEN_VERSION) return null;
  if (compact === undefined || epochRaw === undefined || signature === undefined) return null;

  const userId = expandUuid(compact);
  if (userId === null) return null;

  if (!/^[0-9a-z]{1,12}$/.test(epochRaw)) return null;
  const revocationEpochMs = Number.parseInt(epochRaw, 36);
  if (!Number.isFinite(revocationEpochMs) || revocationEpochMs < 0) return null;

  const expected = signPayload(`${version}.${compact}.${epochRaw}`);
  if (!constantTimeEquals(expected, signature)) return null;

  return { userId, revocationEpochMs };
}

/** Length-guarded `timingSafeEqual`, so a wrong token leaks no prefix length. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The absolute URL a user pastes into iOS Calendar / Google Calendar. */
export function feedUrlFor(token: string): string {
  return `${getConfig().publicOrigin}/api/events/feed.ics?token=${encodeURIComponent(token)}`;
}

/**
 * The `webcal://` form. Tapping this on iOS opens Calendar's subscribe sheet
 * directly instead of downloading a file into Safari's Downloads, which is the
 * difference between a one-tap setup and a support conversation.
 */
export function webcalUrlFor(token: string): string {
  return feedUrlFor(token).replace(/^https?:/, 'webcal:');
}
