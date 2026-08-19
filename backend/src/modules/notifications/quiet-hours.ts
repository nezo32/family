import type { Temporal } from 'temporal-polyfill';

import type { NotificationPriority, QuietMode } from '@family/shared';

/**
 * Quiet hours — pure wall-clock arithmetic.
 *
 * The whole point of this file (D10): **quiet hours DEFER, they never drop.**
 * A notification that lands inside a window is held and released at the end of
 * the window; only `critical` priority is allowed through, and only
 * `system_alert` is critical by default. One push at 03:00 is how a family
 * turns notifications off forever.
 *
 * Everything here is a pure function of `(windows, timezone, instant)` so it is
 * fully testable without Postgres, Redis or a clock.
 *
 * ## Time model (D2)
 *
 * A window is a **floating local wall clock** pair `HH:mm` plus an optional
 * weekday, evaluated in the *recipient's* timezone. It is never an offset and
 * never a UTC instant: a family member who flies to Berlin must get their own
 * 22:00, not Moscow's. All conversion goes through `Temporal` (installed
 * globally by `core/temporal.ts`), with `disambiguation: 'compatible'` so a DST
 * spring-forward gap pushes the boundary forward instead of throwing.
 *
 * ## Wrapping past midnight
 *
 * `endsAt <= startsAt` means the window wraps: `22:00 → 07:30` is
 * *tonight 22:00 until tomorrow 07:30*. This is the common case, not the edge
 * case, which is why the anchor search below always looks at yesterday as well
 * as today.
 *
 * The interval is half-open — `[start, end)` — so a window ending at 07:30 and
 * another starting at 07:30 chain seamlessly rather than overlapping by a
 * minute.
 */

/** One stored `quiet_hours` row, reduced to the fields the maths needs. */
export interface QuietWindow {
  /** 0 = Sunday … 6 = Saturday, matching the DB column. `null` = every day. */
  dayOfWeek: number | null;
  /** Local `HH:mm`, inclusive. */
  startsAt: string;
  /** Local `HH:mm`, exclusive. `<= startsAt` wraps past midnight. */
  endsAt: string;
  mode: QuietMode;
}

/** The set of windows a user has configured. Order is irrelevant; they compose. */
export type QuietHoursConfig = readonly QuietWindow[];

/** A concrete, resolved occurrence of a window around some instant. */
export interface ActiveQuietWindow {
  window: QuietWindow;
  /** UTC instant the occurrence opened. */
  start: Date;
  /** UTC instant the occurrence closes (exclusive). */
  end: Date;
}

export type QuietAction = 'send' | 'defer' | 'silence';

export interface QuietDecision {
  action: QuietAction;
  /**
   * The UTC instant a deferred delivery should fire. `null` for `send` and
   * `silence`.
   */
  scheduledFor: Date | null;
  /** Which windows the instant fell inside. Empty for `send`. */
  windows: ActiveQuietWindow[];
}

/**
 * How many times `nextQuietEnd` will hop from the end of one window into the
 * next before giving up. Overlapping windows compose (§4 of the design note):
 * `22:00–07:00` immediately followed by `07:00–09:00` must release at 09:00, not
 * into a second quiet window. Fourteen windows is the contract's maximum, so a
 * handful of hops is plenty; the bound exists only to make a pathological
 * configuration terminate.
 */
const MAX_WINDOW_CHAIN = 16;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface WallTime {
  hour: number;
  minute: number;
}

type TemporalApi = NonNullable<typeof globalThis.Temporal>;

function temporal(): TemporalApi {
  const api = globalThis.Temporal;
  if (!api) {
    throw new Error('Temporal is not available — call installTemporal() from core/temporal.js');
  }
  return api;
}

/** `'22:00'` → `{ hour: 22, minute: 0 }`. Returns `null` for malformed input. */
export function parseWallTime(value: string): WallTime | null {
  const match = HHMM.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { hour, minute };
}

const minutesOf = (t: WallTime): number => t.hour * 60 + t.minute;

/** `Temporal.dayOfWeek` is 1=Monday…7=Sunday; the DB column is 0=Sunday…6=Saturday. */
function isoToDbWeekday(isoDayOfWeek: number): number {
  return isoDayOfWeek % 7;
}

function zonedAt(at: Date, timeZone: string): Temporal.ZonedDateTime {
  return temporal().Instant.fromEpochMilliseconds(at.getTime()).toZonedDateTimeISO(timeZone);
}

function wallToInstant(date: Temporal.PlainDate, time: WallTime, timeZone: string): Date {
  const zdt = date
    .toPlainDateTime({ hour: time.hour, minute: time.minute })
    // 'compatible' matches Google Calendar and D2: a spring-forward gap pushes
    // the instant forward rather than throwing, a fall-back overlap picks the
    // earlier of the two candidates.
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' });
  return new Date(zdt.epochMilliseconds);
}

/**
 * Materialises the occurrence of `window` anchored on the local date `anchor`.
 *
 * The anchor is the day the window **starts**, which is what makes a weekday
 * filter unambiguous for a wrapping window: `dayOfWeek = 5` (Friday) with
 * `22:00 → 07:00` means Friday night into Saturday morning.
 */
function resolveOccurrence(
  window: QuietWindow,
  anchor: Temporal.PlainDate,
  timeZone: string,
): ActiveQuietWindow | null {
  const start = parseWallTime(window.startsAt);
  const end = parseWallTime(window.endsAt);
  // A malformed row must never make the whole user "permanently quiet" — treat
  // it as no window at all rather than throwing inside the dispatcher.
  if (!start || !end) return null;

  if (window.dayOfWeek !== null && isoToDbWeekday(anchor.dayOfWeek) !== window.dayOfWeek) {
    return null;
  }

  const wraps = minutesOf(end) <= minutesOf(start);
  const endAnchor = wraps ? anchor.add({ days: 1 }) : anchor;

  const startInstant = wallToInstant(anchor, start, timeZone);
  const endInstant = wallToInstant(endAnchor, end, timeZone);

  // Possible when a DST gap swallows the whole window (e.g. 02:00 → 02:30 on a
  // spring-forward night). Nothing is quiet then, which is the honest answer.
  if (endInstant.getTime() <= startInstant.getTime()) return null;

  return { window, start: startInstant, end: endInstant };
}

/**
 * Every window occurrence that contains `at`.
 *
 * Both today's and yesterday's anchors are considered because a window that
 * wraps past midnight is *still yesterday's occurrence* at 03:00.
 */
export function activeQuietWindows(
  config: QuietHoursConfig,
  timeZone: string,
  at: Date,
): ActiveQuietWindow[] {
  if (config.length === 0) return [];

  const zdt = zonedAt(at, timeZone);
  const today = zdt.toPlainDate();
  const anchors = [today, today.subtract({ days: 1 })];
  const ms = at.getTime();

  const active: ActiveQuietWindow[] = [];
  for (const window of config) {
    for (const anchor of anchors) {
      const occurrence = resolveOccurrence(window, anchor, timeZone);
      if (!occurrence) continue;
      if (occurrence.start.getTime() <= ms && ms < occurrence.end.getTime()) {
        active.push(occurrence);
      }
    }
  }
  return active;
}

/**
 * Is `at` inside any quiet window?
 *
 * `timeZone` is the recipient's IANA zone (`users.timezone`, falling back to
 * `family_settings.timezone`) — never the server's.
 */
export function isQuietNow(config: QuietHoursConfig, timeZone: string, at: Date): boolean {
  return activeQuietWindows(config, timeZone, at).length > 0;
}

/**
 * The UTC instant a delivery deferred at `at` should actually fire.
 *
 * Returns `null` when `at` is not quiet. When several windows overlap, the
 * latest end wins, and the result is re-tested so a chain of adjacent windows
 * cannot release a notification into the next silence.
 */
export function nextQuietEnd(config: QuietHoursConfig, timeZone: string, at: Date): Date | null {
  let cursor = at;
  let release: Date | null = null;

  for (let hop = 0; hop < MAX_WINDOW_CHAIN; hop += 1) {
    const active = activeQuietWindows(config, timeZone, cursor);
    if (active.length === 0) break;

    let latest = cursor;
    for (const occurrence of active) {
      if (occurrence.end.getTime() > latest.getTime()) latest = occurrence.end;
    }
    if (release && latest.getTime() <= release.getTime()) break; // no forward progress

    release = latest;
    cursor = latest;
  }

  return release;
}

/**
 * The full quiet-hours decision for one delivery.
 *
 * - `critical` always sends. It is the only bypass, and only `system_alert` is
 *   critical by default.
 * - Any active window in `defer` mode defers — `defer` wins over `silence`
 *   because deferring loses nothing.
 * - All-`silence` suppresses the *ping* only; callers must still write the
 *   in-app row, which is the durable record.
 */
export function resolveQuietDecision(
  config: QuietHoursConfig,
  timeZone: string,
  at: Date,
  priority: NotificationPriority,
): QuietDecision {
  if (priority === 'critical') return { action: 'send', scheduledFor: null, windows: [] };

  const windows = activeQuietWindows(config, timeZone, at);
  if (windows.length === 0) return { action: 'send', scheduledFor: null, windows };

  if (windows.some((w) => w.window.mode === 'defer')) {
    return { action: 'defer', scheduledFor: nextQuietEnd(config, timeZone, at), windows };
  }

  return { action: 'silence', scheduledFor: null, windows };
}

/**
 * The family-wide fallback window, used for a user who has never opened the
 * quiet-hours editor. `family_settings` stores it as two `HH:mm` strings.
 */
export function familyDefaultWindow(startsAt: string, endsAt: string): QuietWindow[] {
  if (!parseWallTime(startsAt) || !parseWallTime(endsAt) || startsAt === endsAt) return [];
  return [{ dayOfWeek: null, startsAt, endsAt, mode: 'defer' }];
}
