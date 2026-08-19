import { PUSH_SW_RU } from '../locale';

/**
 * Push payload parsing.
 *
 * Imported by **`src/sw.ts`** (through a relative path, so the `injectManifest`
 * child build does not have to resolve the `@/` alias) and by the tests. It is
 * deliberately free of DOM, React and network code: everything here is a pure
 * function over an untrusted string.
 *
 * ## Why this file exists at all
 *
 * `showNotification()` must be called on **every** push. After roughly three
 * pushes where the service worker ran without showing anything, iOS silently
 * revokes the subscription and the user never finds out
 * (`docs/research/ios-pwa-push.md` §1). So the one thing this parser may never
 * do is throw: a truncated payload, a `null` body, an HTML error page from a
 * misconfigured proxy — all of them have to end in a generic-but-real
 * notification rather than in a rejected `waitUntil`.
 *
 * ## The hybrid Declarative Web Push envelope
 *
 * The backend sends one payload that satisfies both worlds (research doc §4):
 *
 * ```jsonc
 * { "web_push": 8030,
 *   "notification": { "title": …, "body": …, "navigate": …, "app_badge": 3,
 *                     "mutable": true, "data": { "deliveryId": … } } }
 * ```
 *
 * Safari 18.5+/iOS 18.4+ renders it natively; every other browser ignores
 * `web_push` and falls through to our `push` handler, which unwraps
 * `notification` and shows the same thing. `mutable: true` means that even if
 * this handler dies, the platform still shows the fallback — but we must not
 * rely on that, because it is Safari-only.
 */

/** The magic version number that marks a Declarative Web Push envelope. */
export const DECLARATIVE_WEB_PUSH_VERSION = 8030;

export interface ParsedPush {
  title: string;
  body: string;
  /**
   * Same-origin **path** to open when the notification is tapped. Absolute URLs
   * pointing elsewhere are rejected and collapsed to `/` — a push payload is
   * attacker-influenced input the moment the push service is, and
   * `clients.openWindow()` will happily leave our origin.
   */
  navigate: string;
  /** `notification_deliveries.id`, the D11 ack target. `null` = nothing to ack. */
  deliveryId: string | null;
  /** `navigator.setAppBadge` argument. `0` means "clear". `null` means "leave alone". */
  appBadge: number | null;
  /** Honoured on desktop; iOS ignores it entirely. */
  silent: boolean;
  /**
   * iOS ignores `tag` (no grouping, no replacement) — coalescing is a
   * server-side concern. Kept because Chrome and Firefox do honour it.
   */
  tag: string | null;
  /** Passed through to `showNotification({ data })` and read back on click. */
  data: Record<string, unknown>;
  /** True when the sender used the declarative envelope. Diagnostics only. */
  declarative: boolean;
  /** True when the payload was missing or unreadable and we fell back. */
  fallback: boolean;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Json, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readNumber(source: Json, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // Some senders stringify numbers; a badge is too cheap to lose over that.
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * Reduce anything to a safe same-origin path.
 *
 * Accepts `/tasks/42`, `https://our-origin/tasks/42` and `tasks/42`; rejects
 * other origins, `javascript:` and protocol-relative `//evil.example`.
 */
export function safeNavigatePath(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return '/';
  const candidate = raw.trim();
  if (candidate.startsWith('//')) return '/';
  try {
    const url = new URL(candidate, origin);
    if (url.origin !== new URL(origin).origin) return '/';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return '/';
  }
}

/** The notification we show when we understood nothing at all. */
function fallbackPush(origin: string): ParsedPush {
  return {
    title: PUSH_SW_RU.fallbackTitle,
    body: PUSH_SW_RU.fallbackBody,
    navigate: safeNavigatePath('/', origin),
    deliveryId: null,
    appBadge: null,
    silent: false,
    tag: null,
    data: {},
    declarative: false,
    fallback: true,
  };
}

/**
 * Parse a raw push payload. **Never throws.**
 *
 * @param raw   `event.data?.text()`, or anything at all.
 * @param origin the service worker's origin, used to sanitise `navigate`.
 */
export function parsePushPayload(raw: string | null | undefined, origin: string): ParsedPush {
  const empty = fallbackPush(origin);
  if (typeof raw !== 'string' || raw.trim().length === 0) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Not JSON. A bare string is still better copy than the generic fallback.
    const text = raw.trim();
    if (text.length <= 200 && !text.startsWith('<')) {
      return { ...empty, body: text, fallback: true };
    }
    return empty;
  }

  if (!isObject(parsed)) return empty;

  // ---- unwrap the declarative envelope ------------------------------------
  const declarative = readNumber(parsed, 'web_push') === DECLARATIVE_WEB_PUSH_VERSION;
  const inner = declarative && isObject(parsed.notification) ? parsed.notification : parsed;

  const data = isObject(inner.data) ? inner.data : {};

  const title = readString(inner, 'title');
  const body = readString(inner, 'body') ?? readString(inner, 'message');

  // A declarative payload without a title is invalid per spec; rather than show
  // nothing we show the fallback title and keep whatever body we got.
  if (!title && !body) {
    return { ...empty, declarative };
  }

  const deliveryId =
    readString(data, 'deliveryId', 'delivery_id') ??
    readString(inner, 'deliveryId', 'delivery_id') ??
    (isObject(parsed) ? readString(parsed, 'deliveryId', 'delivery_id') : null);

  return {
    title: title ?? PUSH_SW_RU.fallbackTitle,
    body: body ?? PUSH_SW_RU.fallbackBody,
    navigate: safeNavigatePath(
      readString(inner, 'navigate', 'link', 'url') ?? readString(data, 'link', 'navigate'),
      origin,
    ),
    deliveryId,
    appBadge: readNumber(inner, 'app_badge', 'appBadge'),
    silent: inner.silent === true,
    tag: readString(inner, 'tag') ?? readString(data, 'intentId', 'intent_id'),
    data: { ...data, ...(deliveryId ? { deliveryId } : {}) },
    declarative,
    fallback: false,
  };
}

/**
 * `showNotification()` options built from a parsed payload.
 *
 * `icon`, `badge`, `actions`, `renotify` and `requireInteraction` are all
 * ignored on iOS (research doc §3) — we set only `tag`, `data` and `silent`,
 * which are the ones that either work everywhere or cost nothing.
 */
export function notificationOptions(push: ParsedPush): NotificationOptions {
  return {
    body: push.body,
    data: { ...push.data, navigate: push.navigate, deliveryId: push.deliveryId },
    ...(push.tag ? { tag: push.tag } : {}),
    ...(push.silent ? { silent: true } : {}),
  };
}

/** Read the deep link back out of a `Notification` on click. */
export function navigateFromNotificationData(data: unknown, origin: string): string {
  if (!isObject(data)) return '/';
  return safeNavigatePath(readString(data, 'navigate', 'link', 'url'), origin);
}

/** Read the D11 delivery id back out of a `Notification` on click. */
export function deliveryIdFromNotificationData(data: unknown): string | null {
  if (!isObject(data)) return null;
  return readString(data, 'deliveryId', 'delivery_id');
}
