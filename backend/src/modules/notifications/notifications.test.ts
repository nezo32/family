import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Notifications tests.
 *
 * No Postgres and no Redis are available in this environment, and — more
 * importantly — **no live network calls are made**: `web-push` is injected as a
 * stub and `fetch` is replaced. Everything that can be pure is pure, and the
 * repository is mocked module-wide so the pipeline logic can be driven without a
 * database.
 *
 * The tests that matter most, in order of how much damage the bug they prevent
 * would do:
 *
 * 1. **The HTTP status → prune/retry table.** A `403` treated as "gone" deletes
 *    every push subscription in the family on a bad deploy, and the only
 *    recovery is asking every member to re-enable notifications by hand.
 * 2. **Quiet hours across midnight and across a DST boundary.** One push at
 *    03:00 and a parent turns notifications off forever.
 * 3. **Escalation fires exactly once, never inside quiet hours, never for
 *    `normal`/`low`.** The cure must not become the disease.
 * 4. **Acks are idempotent and status never regresses.** Offline replays are
 *    normal, not exceptional.
 */

/* -------------------------------------------------------------------------- */
/* Environment — must be set before any module reads the config                 */
/* -------------------------------------------------------------------------- */

/**
 * Hoisted above every import: the config is parsed the first time any module
 * touches `core/logger.ts`, so the environment has to be right before then.
 * `enqueueMock` lives here too — a `vi.mock` factory is hoisted above ordinary
 * `const` declarations and would otherwise hit the temporal dead zone.
 */
const { enqueueMock } = vi.hoisted(() => {
  // `src/test/setup.ts` sets LOG_LEVEL=silent, which is not a member of the
  // config enum; pin something valid before `core/logger.ts` is evaluated.
  process.env.LOG_LEVEL = 'fatal';
  process.env.VAPID_PUBLIC_KEY ??= 'test-vapid-public-key';
  process.env.VAPID_PRIVATE_KEY ??= 'test-vapid-private-key';
  process.env.VAPID_SUBJECT ??= 'mailto:admin@family.example.com';
  process.env.TELEGRAM_BOT_TOKEN ??= '123456:test-bot-token';
  return { enqueueMock: vi.fn(() => Promise.resolve()) };
});

/** BullMQ is never reachable here; capture what the pipeline tried to enqueue. */
vi.mock('../../core/queue/queues.js', () => ({
  enqueue: enqueueMock,
  getQueue: vi.fn(),
  closeQueues: vi.fn(),
  QUEUE_NAMES: {
    notifications: 'notifications',
    scheduler: 'scheduler',
    maintenance: 'maintenance',
  },
}));

/**
 * Mock every repository function while keeping the real module's shape, so a
 * function added to the repository later does not silently become `undefined`
 * in these tests.
 */
vi.mock('./notifications.repository.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' ? vi.fn() : value;
  }
  return mocked;
});

import {
  APP_ROUTES,
  APP_ROUTES_WITH_DETAIL,
  DELIVERY_STATUS_RANK,
  ESCALATION_DEADLINE_MINUTES,
  NOTIFICATION_LIMITS,
  isKnownAppPath,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_DEFAULT_PRIORITY,
  isForwardDeliveryStatus,
  nextEscalationState,
  requiredAckSignal,
} from '@family/shared';

import { installTemporal } from '../../core/temporal.js';
import type { Db, Executor } from '../../core/db.js';
import * as repo from './notifications.repository.js';
import type { NotificationDeliveryRow, NotificationIntentRow } from './notifications.schema.js';
import {
  classifyPushFailure,
  sendPush,
  serializePushPayload,
  trimToBytes,
  type PushDeps,
  type PushMessage,
} from './push.adapter.js';
import {
  activeQuietWindows,
  isQuietNow,
  nextQuietEnd,
  resolveQuietDecision,
  type QuietWindow,
} from './quiet-hours.js';
import { renderNotification } from './render.js';
import {
  classifyTelegramFailure,
  escapeMarkdownV2,
  formatTelegramMessage,
  sendTelegramMessage,
} from './telegram.adapter.js';
import {
  ackDelivery,
  clampAckTimestamp,
  DEFAULT_ESCALATION_POLICIES,
  emitIntent,
  ensureDefaultEscalationPolicies,
  ESCALATION_FALLBACK_ROLES,
  escalateIntent,
  isSubscriptionUnhealthy,
  runPushHealthCheck,
} from './notifications.service.js';

type RepositoryModule = typeof repo;

const db = {} as Db;

beforeAll(async () => {
  await installTemporal();
});

beforeEach(() => {
  vi.clearAllMocks();
});

/* ========================================================================== */
/* Quiet hours                                                                 */
/* ========================================================================== */

const MOSCOW = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

const nightly = (mode: 'defer' | 'silence' = 'defer'): QuietWindow[] => [
  { dayOfWeek: null, startsAt: '22:00', endsAt: '07:30', mode },
];

describe('quiet hours — windows that wrap past midnight', () => {
  it('is quiet on both sides of midnight and awake in between', () => {
    const windows = nightly();
    // Moscow is a permanent UTC+3, so local = UTC + 3.
    expect(isQuietNow(windows, MOSCOW, new Date('2026-08-19T19:30:00Z'))).toBe(true); // 22:30
    expect(isQuietNow(windows, MOSCOW, new Date('2026-08-20T00:00:00Z'))).toBe(true); // 03:00
    expect(isQuietNow(windows, MOSCOW, new Date('2026-08-20T04:29:00Z'))).toBe(true); // 07:29
    expect(isQuietNow(windows, MOSCOW, new Date('2026-08-20T04:30:00Z'))).toBe(false); // 07:30 exclusive
    expect(isQuietNow(windows, MOSCOW, new Date('2026-08-19T18:59:00Z'))).toBe(false); // 21:59
  });

  it('defers to the end of the window, as a UTC instant', () => {
    // 03:00 Moscow → release at 07:30 Moscow → 04:30 UTC the same day.
    const release = nextQuietEnd(nightly(), MOSCOW, new Date('2026-08-20T00:00:00Z'));
    expect(release?.toISOString()).toBe('2026-08-20T04:30:00.000Z');
  });

  it('returns null when nothing is quiet', () => {
    expect(nextQuietEnd(nightly(), MOSCOW, new Date('2026-08-19T09:00:00Z'))).toBeNull();
  });

  it('honours the weekday of the day the window STARTS', () => {
    // Friday night → Saturday morning. 2026-08-21 is a Friday.
    const friday: QuietWindow[] = [
      { dayOfWeek: 5, startsAt: '22:00', endsAt: '07:00', mode: 'defer' },
    ];
    expect(isQuietNow(friday, MOSCOW, new Date('2026-08-21T20:00:00Z'))).toBe(true); // Fri 23:00
    expect(isQuietNow(friday, MOSCOW, new Date('2026-08-22T01:00:00Z'))).toBe(true); // Sat 04:00
    expect(isQuietNow(friday, MOSCOW, new Date('2026-08-22T20:00:00Z'))).toBe(false); // Sat 23:00
  });

  it('chains adjacent windows so a release never lands inside the next silence', () => {
    const windows: QuietWindow[] = [
      { dayOfWeek: null, startsAt: '22:00', endsAt: '07:00', mode: 'defer' },
      { dayOfWeek: null, startsAt: '07:00', endsAt: '09:00', mode: 'defer' },
    ];
    // 03:00 Moscow — the first window ends at 07:00, which opens the second.
    const release = nextQuietEnd(windows, MOSCOW, new Date('2026-08-20T00:00:00Z'));
    expect(release?.toISOString()).toBe('2026-08-20T06:00:00.000Z'); // 09:00 Moscow
  });

  it('composes overlapping windows to the latest end', () => {
    const windows: QuietWindow[] = [
      { dayOfWeek: null, startsAt: '13:00', endsAt: '15:00', mode: 'defer' },
      { dayOfWeek: null, startsAt: '14:00', endsAt: '16:30', mode: 'defer' },
    ];
    const at = new Date('2026-08-19T11:30:00Z'); // 14:30 Moscow
    expect(activeQuietWindows(windows, MOSCOW, at)).toHaveLength(2);
    expect(nextQuietEnd(windows, MOSCOW, at)?.toISOString()).toBe('2026-08-19T13:30:00.000Z');
  });

  it('treats a malformed window as no window rather than permanent silence', () => {
    const broken: QuietWindow[] = [
      { dayOfWeek: null, startsAt: '25:99', endsAt: 'oops', mode: 'defer' },
    ];
    expect(isQuietNow(broken, MOSCOW, new Date('2026-08-20T00:00:00Z'))).toBe(false);
  });
});

describe('quiet hours — DST boundaries (D2 wall-clock rule)', () => {
  it('spring forward: the window is one wall-clock hour shorter, and the end is right', () => {
    // Europe/Berlin springs forward on 2026-03-29 at 02:00 → 03:00.
    // 22:00 on the 28th is +01:00 (21:00Z); 07:00 on the 29th is +02:00 (05:00Z).
    const windows: QuietWindow[] = [
      { dayOfWeek: null, startsAt: '22:00', endsAt: '07:00', mode: 'defer' },
    ];
    const at = new Date('2026-03-29T00:00:00Z'); // 01:00 Berlin, still winter time
    expect(isQuietNow(windows, BERLIN, at)).toBe(true);

    const release = nextQuietEnd(windows, BERLIN, at);
    expect(release?.toISOString()).toBe('2026-03-29T05:00:00.000Z');

    // The elapsed real time is 8 hours even though the wall clock says 9 —
    // which is the entire point of doing this with Temporal instead of
    // `start + 9 * 3600_000`.
    const [occurrence] = activeQuietWindows(windows, BERLIN, at);
    expect(occurrence).toBeDefined();
    const hours = (occurrence!.end.getTime() - occurrence!.start.getTime()) / 3_600_000;
    expect(hours).toBe(8);
  });

  it('fall back: the same wall-clock window is one hour longer', () => {
    // Europe/Berlin falls back on 2026-10-25 at 03:00 → 02:00.
    const windows: QuietWindow[] = [
      { dayOfWeek: null, startsAt: '22:00', endsAt: '07:00', mode: 'defer' },
    ];
    const at = new Date('2026-10-24T22:00:00Z'); // 00:00 Berlin (+02:00)
    const [occurrence] = activeQuietWindows(windows, BERLIN, at);
    expect(occurrence).toBeDefined();
    const hours = (occurrence!.end.getTime() - occurrence!.start.getTime()) / 3_600_000;
    expect(hours).toBe(10);
    expect(nextQuietEnd(windows, BERLIN, at)?.toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});

describe('quiet hours — the decision (D10: defer, never drop)', () => {
  const at = new Date('2026-08-20T00:00:00Z'); // 03:00 Moscow

  it('defers a normal notification to the end of the window', () => {
    const decision = resolveQuietDecision(nightly(), MOSCOW, at, 'normal');
    expect(decision.action).toBe('defer');
    expect(decision.scheduledFor?.toISOString()).toBe('2026-08-20T04:30:00.000Z');
  });

  it('critical is the ONLY bypass', () => {
    for (const priority of ['low', 'normal', 'high'] as const) {
      expect(resolveQuietDecision(nightly(), MOSCOW, at, priority).action).toBe('defer');
    }
    const critical = resolveQuietDecision(nightly(), MOSCOW, at, 'critical');
    expect(critical.action).toBe('send');
    expect(critical.scheduledFor).toBeNull();
  });

  it('silence suppresses the ping but is still not a drop — defer wins when mixed', () => {
    expect(resolveQuietDecision(nightly('silence'), MOSCOW, at, 'normal').action).toBe('silence');

    const mixed: QuietWindow[] = [
      { dayOfWeek: null, startsAt: '22:00', endsAt: '07:30', mode: 'silence' },
      { dayOfWeek: null, startsAt: '02:00', endsAt: '04:00', mode: 'defer' },
    ];
    // Deferring loses nothing, so it wins over silencing.
    expect(resolveQuietDecision(mixed, MOSCOW, at, 'normal').action).toBe('defer');
  });
});

/* ========================================================================== */
/* Web Push — the status table                                                 */
/* ========================================================================== */

describe('push adapter — HTTP status → prune/retry decision', () => {
  it('404 and 410 are the ONLY statuses that prune a subscription', () => {
    for (const status of [404, 410]) {
      const decision = classifyPushFailure(status);
      expect(decision.prune, `status ${status} must prune`).toBe(true);
      expect(decision.action).toBe('prune');
      expect(decision.retryable).toBe(false);
      expect(decision.reason).toBe('gone');
    }
  });

  it('429 backs off and NEVER prunes, honouring Retry-After', () => {
    const decision = classifyPushFailure(429, 120);
    expect(decision.prune).toBe(false);
    expect(decision.action).toBe('backoff');
    expect(decision.retryable).toBe(true);
    expect(decision.retryAfterSeconds).toBe(120);
    // A rate limit must not count toward the consecutive-failure expiry either.
    expect(decision.countsAsFailure).toBe(false);
  });

  it('413 is our payload bug: log, never prune, never retry', () => {
    const decision = classifyPushFailure(413);
    expect(decision.prune).toBe(false);
    expect(decision.retryable).toBe(false);
    expect(decision.reason).toBe('payload_too_large');
  });

  it('400/401/403 are VAPID misconfiguration — pruning here would wipe the family', () => {
    for (const status of [400, 401, 403]) {
      const decision = classifyPushFailure(status);
      expect(decision.prune, `status ${status} must NOT prune`).toBe(false);
      expect(decision.reason).toBe('vapid_misconfigured');
      expect(decision.retryable).toBe(false);
      expect(decision.countsAsFailure).toBe(false);
    }
  });

  it('5xx and network errors retry and count toward the ~10-failure expiry', () => {
    for (const status of [500, 502, 503, 504, null]) {
      const decision = classifyPushFailure(status);
      expect(decision.prune, `status ${String(status)} must NOT prune`).toBe(false);
      expect(decision.retryable).toBe(true);
      expect(decision.countsAsFailure).toBe(true);
      expect(decision.reason).toBe('transient');
    }
  });

  it('no other status prunes — exhaustive sweep of 400..599', () => {
    for (let status = 400; status < 600; status += 1) {
      const decision = classifyPushFailure(status);
      if (status === 404 || status === 410) continue;
      expect(decision.prune, `status ${status} must NOT prune`).toBe(false);
    }
  });

  it('reports a misconfiguration through the real send path without pruning', async () => {
    class FakeWebPushError extends Error {
      constructor(
        readonly statusCode: number,
        readonly headers: Record<string, string>,
        readonly body: string,
        readonly endpoint: string,
      ) {
        super('rejected');
      }
    }
    // `sendPush` narrows on the real class, so an unknown throwable is treated
    // as a network error — still never a prune, which is the property we care
    // about here.
    const deps: PushDeps = {
      sendNotification: () => Promise.reject(new FakeWebPushError(403, {}, 'BadJwtToken', 'x')),
    };
    const result = await sendPush(target(), message(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.prune).toBe(false);
  });

  it('a successful send reports ok and never touches the subscription', async () => {
    const deps: PushDeps = { sendNotification: () => Promise.resolve({ statusCode: 201 }) };
    const result = await sendPush(target(), message(), deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.statusCode).toBe(201);
  });
});

function target() {
  return { id: 'sub-1', endpoint: 'https://web.push.apple.com/abc', p256dh: 'p', auth: 'a' };
}

function message(overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    deliveryId: '11111111-1111-4111-8111-111111111111',
    intentId: '22222222-2222-4222-8222-222222222222',
    type: 'task_assigned',
    title: 'Новая задача',
    body: 'Вынести мусор · сегодня в 19:00',
    navigate: '/tasks/42',
    badge: 3,
    priority: 'normal',
    ...overrides,
  };
}

/* ========================================================================== */
/* Web Push — the payload budget                                               */
/* ========================================================================== */

describe('push adapter — hybrid payload and the size budget', () => {
  it('emits the hybrid Declarative Web Push shape', () => {
    const { json } = serializePushPayload(message());
    const parsed = JSON.parse(json) as {
      web_push: number;
      notification: Record<string, unknown>;
    };
    expect(parsed.web_push).toBe(8030);
    expect(parsed.notification.title).toBe('Новая задача');
    // `navigate` is REQUIRED for the declarative path and must be absolute.
    expect(String(parsed.notification.navigate)).toMatch(/^https?:\/\/.+\/tasks\/42$/);
    expect(parsed.notification.mutable).toBe(true);
    expect(parsed.notification.app_badge).toBe(3);
    // Ids only — never entity data.
    expect(parsed.notification.data).toMatchObject({
      deliveryId: '11111111-1111-4111-8111-111111111111',
      type: 'task_assigned',
    });
  });

  it('stays under the budget and degrades instead of throwing', () => {
    const huge = message({ body: 'Очень длинное описание задачи. '.repeat(400) });
    const result = serializePushPayload(huge);
    expect(result.bytes).toBeLessThanOrEqual(NOTIFICATION_LIMITS.pushPayloadBudgetBytes);
    expect(result.degraded).toBe(true);

    const parsed = JSON.parse(result.json) as { notification: Record<string, unknown> };
    // The two fields Safari needs must survive every level of degradation.
    expect(parsed.notification.title).toBe('Новая задача');
    expect(String(parsed.notification.navigate)).toContain('/tasks/42');
  });

  it('does not degrade an ordinary message', () => {
    const result = serializePushPayload(message());
    expect(result.degraded).toBe(false);
    expect(result.bytes).toBeLessThan(NOTIFICATION_LIMITS.pushPayloadBudgetBytes);
  });

  it('survives a pathological title without throwing', () => {
    expect(() =>
      serializePushPayload(message({ title: 'Ж'.repeat(5000), body: '' })),
    ).not.toThrow();
  });

  it('trims on codepoint boundaries, counting UTF-8 bytes not characters', () => {
    // Cyrillic is two bytes per character: 10 bytes = 5 characters.
    expect(trimToBytes('Задача', 10)).toBe('Задач');
    expect(Buffer.byteLength(trimToBytes('Задача', 7), 'utf8')).toBeLessThanOrEqual(7);
    expect(trimToBytes('abc', 0)).toBe('');
  });
});

/* ========================================================================== */
/* The Russian renderer                                                        */
/* ========================================================================== */

describe('render — every notification type', () => {
  it('renders a usable title and body for every enum member, from an empty payload', () => {
    for (const type of NOTIFICATION_TYPES) {
      const rendered = renderNotification(type, {});
      expect(rendered.title.length, `${type} title`).toBeGreaterThan(0);
      expect(rendered.body.length, `${type} body`).toBeGreaterThan(0);
      // On iOS every notification wears the app icon, so the title alone has to
      // say what kind of thing this is — and it must fit on a lock screen.
      expect(rendered.title.length, `${type} title too long`).toBeLessThanOrEqual(60);
      expect(rendered.title).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('gives each type a distinguishable title', () => {
    const titles = NOTIFICATION_TYPES.map((type) => renderNotification(type, {}).title);
    // A couple of pairs legitimately share a heading family, but the set must
    // not collapse to a handful of generic strings.
    expect(new Set(titles).size).toBeGreaterThanOrEqual(NOTIFICATION_TYPES.length - 1);
  });

  it('renders from the payload, deep-linking by id', () => {
    const rendered = renderNotification('task_assigned', {
      title: 'Вынести мусор',
      occurrenceId: 'abc',
      dueLabel: 'сегодня в 19:00',
    });
    expect(rendered.title).toBe('Новая задача');
    expect(rendered.body).toContain('Вынести мусор');
    expect(rendered.navigate).toBe('/tasks/abc');
  });

  it('formats money from integer minor units', () => {
    const rendered = renderNotification('goal_contribution', {
      actorName: 'Аня',
      goalTitle: 'Велосипед',
      amountMinor: 250000,
    });
    expect(rendered.body).toContain('Аня');
    expect(rendered.body).toContain('₽');
    expect(rendered.body).not.toContain('250000');
  });

  it('declines Russian plurals correctly', () => {
    expect(renderNotification('birthday_today', { personName: 'Лиза', age: 1 }).body).toContain(
      '1 год',
    );
    expect(renderNotification('birthday_today', { personName: 'Лиза', age: 3 }).body).toContain(
      '3 года',
    );
    expect(renderNotification('birthday_today', { personName: 'Лиза', age: 11 }).body).toContain(
      '11 лет',
    );
    expect(renderNotification('birthday_today', { personName: 'Лиза', age: 42 }).body).toContain(
      '42 года',
    );
  });
});

/* ========================================================================== */
/* Telegram                                                                    */
/* ========================================================================== */

describe('telegram adapter', () => {
  it('escapes every MarkdownV2 reserved character', () => {
    expect(escapeMarkdownV2('Задача просрочена — сделай!')).toBe('Задача просрочена — сделай\\!');
    expect(escapeMarkdownV2('a.b-c_d*e')).toBe('a\\.b\\-c\\_d\\*e');
  });

  it('does not over-escape a link destination', () => {
    const text = formatTelegramMessage({
      chatId: 1,
      title: 'Скоро событие',
      body: 'Ужин в 19:00',
      link: 'https://family.example.com/calendar/42?ref=push',
    });
    expect(text).toContain('(https://family.example.com/calendar/42?ref=push)');
    expect(text).toContain('*Скоро событие*');
  });

  it('403 sets can_dm=false instead of retrying forever', () => {
    expect(classifyTelegramFailure(403, 'Forbidden: bot was blocked by the user').action).toBe(
      'block',
    );
    expect(classifyTelegramFailure(400, 'Bad Request: chat not found').action).toBe('block');
    expect(classifyTelegramFailure(429, 'Too Many Requests', 30)).toMatchObject({
      action: 'retry',
      retryAfterSeconds: 30,
    });
    expect(classifyTelegramFailure(500, 'Internal').action).toBe('retry');
    expect(classifyTelegramFailure(400, "can't parse entities").action).toBe('abort');
  });

  it('treats a message_id as a real arrival receipt (D11)', async () => {
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 }),
      ),
    );
    const result = await sendTelegramMessage(
      { chatId: 42, title: 'Тест', body: 'Тело', link: null },
      fetchStub,
    );
    expect(result).toMatchObject({ ok: true, action: 'delivered', messageId: 77 });
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

/* ========================================================================== */
/* Dedupe                                                                      */
/* ========================================================================== */

describe('emitIntent — the dedupe key prevents a double intent', () => {
  it('returns deduped and enqueues nothing when the key already exists', async () => {
    vi.mocked(repo.insertIntent).mockResolvedValueOnce(intent({ id: 'intent-1' }));
    const first = await emitIntent(db, {
      type: 'task_due_soon',
      audience: { users: ['user-1'] },
      dedupeKey: 'task_due_soon:occ-1:2026-08-19',
    });
    await first.dispatch();
    expect(first.deduped).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    // The retried producer loses the ON CONFLICT race.
    vi.mocked(repo.insertIntent).mockResolvedValueOnce(null);
    vi.mocked(repo.findIntentByDedupeKey).mockResolvedValueOnce(intent({ id: 'intent-1' }));
    const second = await emitIntent(db, {
      type: 'task_due_soon',
      audience: { users: ['user-1'] },
      dedupeKey: 'task_due_soon:occ-1:2026-08-19',
    });
    await second.dispatch();

    expect(second.deduped).toBe(true);
    expect(second.intentId).toBe('intent-1');
    // Crucially: no second fan-out job. The family is not told twice.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('writes ON CONFLICT DO NOTHING against the partial unique index', async () => {
    const actual = await vi.importActual<RepositoryModule>('./notifications.repository.js');

    const calls: Record<string, unknown> = {};
    const executor = {
      insert: () => ({
        values: (values: unknown) => {
          calls.values = values;
          return {
            onConflictDoNothing: (config: unknown) => {
              calls.conflict = config;
              // Empty array = another producer already inserted this key.
              return { returning: () => Promise.resolve([]) };
            },
          };
        },
      }),
    } as unknown as Executor;

    const result = await actual.insertIntent(executor, {
      type: 'task_due_soon',
      dedupeKey: 'k',
      payload: {},
      audience: {},
    });

    expect(result).toBeNull();
    expect(calls.conflict).toHaveProperty('target');
    expect(calls.conflict).toHaveProperty('where');
  });
});

/* ========================================================================== */
/* D11 — receipts                                                              */
/* ========================================================================== */

describe('delivery status never regresses (D11)', () => {
  it('orders the lifecycle correctly', () => {
    expect(isForwardDeliveryStatus('pending', 'sent')).toBe(true);
    expect(isForwardDeliveryStatus('sent', 'delivered')).toBe(true);
    expect(isForwardDeliveryStatus('delivered', 'interacted')).toBe(true);
    expect(isForwardDeliveryStatus('interacted', 'acknowledged')).toBe(true);

    // The regressions that a replayed offline ack would otherwise cause.
    expect(isForwardDeliveryStatus('acknowledged', 'delivered')).toBe(false);
    expect(isForwardDeliveryStatus('interacted', 'delivered')).toBe(false);
    expect(isForwardDeliveryStatus('delivered', 'sent')).toBe(false);
    expect(isForwardDeliveryStatus('sent', 'sent')).toBe(false);

    // A push service 500 on a retry must not outrank a real arrival.
    expect(DELIVERY_STATUS_RANK.failed).toBeLessThan(DELIVERY_STATUS_RANK.delivered);
  });
});

describe('acks are idempotent and clamped', () => {
  it('clamps a client timestamp into [sentAt - skew, now]', () => {
    const now = new Date('2026-08-19T12:00:00Z');
    const sentAt = new Date('2026-08-19T11:00:00Z');

    // A clock a day fast cannot invent a receipt in the future.
    expect(clampAckTimestamp(new Date('2026-08-20T12:00:00Z'), sentAt, now)).toEqual(now);
    // A clock a day slow cannot claim the message arrived before we sent it.
    expect(clampAckTimestamp(new Date('2026-08-18T12:00:00Z'), sentAt, now).getTime()).toBe(
      sentAt.getTime() - NOTIFICATION_LIMITS.ackClockSkewToleranceMinutes * 60_000,
    );
    // A plausible offline replay is trusted.
    const plausible = new Date('2026-08-19T11:30:00Z');
    expect(clampAckTimestamp(plausible, sentAt, now)).toEqual(plausible);
    // No timestamp at all → server time.
    expect(clampAckTimestamp(undefined, sentAt, now)).toEqual(now);
  });

  it('a replayed ack changes nothing and keeps the first observation', async () => {
    const firstSeen = new Date('2026-08-19T11:30:00Z');
    const row = delivery({
      status: 'interacted',
      sentAt: new Date('2026-08-19T11:00:00Z'),
      deliveredAt: firstSeen,
      interactedAt: new Date('2026-08-19T11:31:00Z'),
    });

    vi.mocked(repo.getDelivery).mockResolvedValue(row);
    // `coalesce` in the repository keeps the original timestamp...
    vi.mocked(repo.stampDeliveryReceipt).mockResolvedValue(row);
    // ...and the forward-only predicate rejects the status write outright.
    vi.mocked(repo.advanceDeliveryStatus).mockResolvedValue(null);

    const result = await ackDelivery(
      db,
      'user-1',
      row.id,
      'delivered',
      new Date('2026-08-19T11:45:00Z'),
      new Date('2026-08-19T12:00:00Z'),
    );

    expect(result.status).toBe('interacted');
    expect(result.deliveredAt).toEqual(firstSeen);
  });

  it("another user's delivery is a 404, not a 403", async () => {
    vi.mocked(repo.getDelivery).mockResolvedValue(delivery({ userId: 'somebody-else' }));
    await expect(ackDelivery(db, 'user-1', 'd-1', 'delivered')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a real arrival resets the subscription health counters', async () => {
    const row = delivery({ subscriptionId: 'sub-1', status: 'sent' });
    vi.mocked(repo.getDelivery).mockResolvedValue(row);
    vi.mocked(repo.stampDeliveryReceipt).mockResolvedValue(row);
    vi.mocked(repo.advanceDeliveryStatus).mockResolvedValue({ ...row, status: 'delivered' });

    await ackDelivery(db, 'user-1', row.id, 'delivered');
    expect(repo.recordPushDelivered).toHaveBeenCalledWith(db, 'sub-1', expect.any(Date));
  });
});

/* ========================================================================== */
/* D11 — escalation                                                            */
/* ========================================================================== */

describe('escalation (D11)', () => {
  const now = new Date('2026-08-19T12:00:00Z'); // 15:00 Moscow — awake

  function arrangeAwake() {
    vi.mocked(repo.getFamilyDefaults).mockResolvedValue({
      timezone: MOSCOW,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:30',
    });
    vi.mocked(repo.listQuietHoursForUser).mockResolvedValue([]);
    vi.mocked(repo.listActiveUsersByIds).mockResolvedValue([
      {
        id: 'user-1',
        role: 'adult',
        displayName: 'Аня',
        timezone: MOSCOW,
        permissionGrants: [],
        permissionDenies: [],
      },
    ]);
  }

  it('fires exactly once for an unacknowledged critical delivery', async () => {
    arrangeAwake();
    const sent = delivery({
      id: 'del-1',
      status: 'sent',
      channel: 'push',
      sentAt: new Date('2026-08-19T11:40:00Z'), // 20 minutes ago > 10 min deadline
    });
    vi.mocked(repo.getIntent).mockResolvedValue(
      intent({ priority: 'critical', escalationState: 'none' }),
    );
    vi.mocked(repo.intentHasSignal).mockResolvedValue(false);
    vi.mocked(repo.listDeliveriesForIntent).mockResolvedValue([sent]);
    // First sweep claims the transition; the retried sweep loses the race.
    vi.mocked(repo.advanceEscalationState).mockResolvedValueOnce(true).mockResolvedValue(false);

    expect(await escalateIntent(db, 'intent-1', now)).toBe('redelivered');
    expect(repo.incrementRedeliveryCount).toHaveBeenCalledTimes(1);

    // A retried job / a concurrent sweep must not escalate the same event twice.
    expect(await escalateIntent(db, 'intent-1', now)).toBe('lost_race');
    expect(repo.incrementRedeliveryCount).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire inside quiet hours — an offline phone must not cause a 03:00 push', async () => {
    arrangeAwake();
    vi.mocked(repo.listQuietHoursForUser).mockResolvedValue([
      quietRow({ startsAt: '22:00', endsAt: '07:30' }),
    ]);
    vi.mocked(repo.getIntent).mockResolvedValue(
      intent({ priority: 'high', escalationState: 'none' }),
    );
    vi.mocked(repo.intentHasSignal).mockResolvedValue(false);
    vi.mocked(repo.listDeliveriesForIntent).mockResolvedValue([
      delivery({ status: 'sent', sentAt: new Date('2026-08-19T23:00:00Z') }),
    ]);

    const night = new Date('2026-08-20T00:00:00Z'); // 03:00 Moscow
    expect(await escalateIntent(db, 'intent-1', night)).toBe('quiet');
    expect(repo.advanceEscalationState).not.toHaveBeenCalled();

    // Held, not dropped: a job is scheduled for the end of the window.
    expect(enqueueMock).toHaveBeenCalledWith(
      'notification.escalate',
      { intentId: 'intent-1' },
      expect.objectContaining({ delay: expect.any(Number) }),
    );
  });

  it('never escalates normal or low priority', async () => {
    arrangeAwake();
    for (const priority of ['normal', 'low'] as const) {
      vi.mocked(repo.getIntent).mockResolvedValue(intent({ priority }));
      expect(await escalateIntent(db, 'intent-1', now)).toBe('not_applicable');
    }
    expect(repo.advanceEscalationState).not.toHaveBeenCalled();
    expect(ESCALATION_DEADLINE_MINUTES.normal).toBeNull();
    expect(ESCALATION_DEADLINE_MINUTES.low).toBeNull();
  });

  it('stops as soon as the required signal arrives', async () => {
    arrangeAwake();
    vi.mocked(repo.getIntent).mockResolvedValue(intent({ priority: 'critical' }));
    vi.mocked(repo.intentHasSignal).mockResolvedValue(true);
    expect(await escalateIntent(db, 'intent-1', now)).toBe('satisfied');
    expect(repo.advanceEscalationState).not.toHaveBeenCalled();

    // For `critical`, mere arrival is not enough — a human must acknowledge.
    expect(requiredAckSignal('critical')).toBe('acknowledged');
    expect(requiredAckSignal('high')).toBe('delivered');
  });

  it('waits until the per-priority deadline has actually elapsed', async () => {
    arrangeAwake();
    vi.mocked(repo.getIntent).mockResolvedValue(intent({ priority: 'high' }));
    vi.mocked(repo.intentHasSignal).mockResolvedValue(false);
    vi.mocked(repo.listDeliveriesForIntent).mockResolvedValue([
      delivery({ status: 'sent', sentAt: new Date('2026-08-19T11:50:00Z') }), // 10 min ago
    ]);
    // `high` waits 30 minutes.
    expect(await escalateIntent(db, 'intent-1', now)).toBe('too_early');
  });

  it('caps the chain — the ladder terminates', () => {
    expect(nextEscalationState('none')).toBe('redelivered');
    expect(nextEscalationState('redelivered')).toBe('channel_fallback');
    expect(nextEscalationState('channel_fallback')).toBe('person_escalated');
    expect(nextEscalationState('person_escalated')).toBe('exhausted');
    expect(nextEscalationState('exhausted')).toBeNull();
  });

  /**
   * The third rung reads `escalation_policies`. Nothing ever wrote to that
   * table — no INSERT, no seed, no route — so «escalate to another person» was
   * a permanent no-op for every type the product actually emits.
   */
  it('seeds the default policies on an empty table, and never again', async () => {
    vi.mocked(repo.countEscalationPolicies).mockResolvedValue(0);
    vi.mocked(repo.insertEscalationPolicies).mockImplementation((_x, values) =>
      Promise.resolve(
        values as unknown as Awaited<ReturnType<typeof repo.insertEscalationPolicies>>,
      ),
    );

    expect(await ensureDefaultEscalationPolicies(db)).toBe(DEFAULT_ESCALATION_POLICIES.length);
    expect(DEFAULT_ESCALATION_POLICIES.length).toBeGreaterThan(0);

    // A family that retargeted or disabled a policy must not have it undone by
    // the next restart, so a non-empty table is left completely alone.
    vi.mocked(repo.countEscalationPolicies).mockResolvedValue(1);
    vi.mocked(repo.insertEscalationPolicies).mockClear();
    expect(await ensureDefaultEscalationPolicies(db)).toBe(0);
    expect(repo.insertEscalationPolicies).not.toHaveBeenCalled();
  });

  it('only seeds types that can actually escalate, and only to adults', () => {
    for (const policy of DEFAULT_ESCALATION_POLICIES) {
      // `ESCALATION_DEADLINE_MINUTES` is null for normal/low, so a policy on a
      // quiet type could never fire — it would be configuration that lies.
      const priority = NOTIFICATION_TYPE_DEFAULT_PRIORITY[policy.type];
      expect(ESCALATION_DEADLINE_MINUTES[priority]).not.toBeNull();
      expect(policy.afterMinutes).toBeGreaterThan(0);
      // Escalating to a child is noise at best: the fan-out would drop them and
      // the escalation would silently reach nobody.
      expect(ESCALATION_FALLBACK_ROLES).toContain(policy.escalateToRole);
    }

    // Every default targets a role rather than a person, so a policy cannot be
    // orphaned by one member leaving the family.
    expect(DEFAULT_ESCALATION_POLICIES.every((p) => p.escalateToRole)).toBe(true);
  });

  it('escalates to the policy target, skipping whoever already ignored it', async () => {
    arrangeAwake();
    const sent = delivery({
      id: 'del-1',
      status: 'sent',
      channel: 'push',
      sentAt: new Date('2026-08-19T10:00:00Z'), // two hours ago
    });
    vi.mocked(repo.getIntent).mockResolvedValue(
      intent({ priority: 'critical', escalationState: 'channel_fallback' }),
    );
    vi.mocked(repo.intentHasSignal).mockResolvedValue(false);
    vi.mocked(repo.listDeliveriesForIntent).mockResolvedValue([sent]);
    vi.mocked(repo.advanceEscalationState).mockResolvedValue(true);
    vi.mocked(repo.listEnabledEscalationPolicies).mockResolvedValue([
      {
        id: 'pol-1',
        type: 'system_alert',
        afterMinutes: 15,
        escalateToRole: 'owner',
        escalateToUserId: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    vi.mocked(repo.insertIntent).mockResolvedValue(intent({ id: 'intent-2' }));

    expect(await escalateIntent(db, 'intent-1', now)).toBe('person_escalated');

    const [, values] = vi.mocked(repo.insertIntent).mock.calls[0] ?? [];
    expect(values?.audience).toEqual({ roles: ['owner'] });
    // A new intent, never a second delivery on the old one — and prefixed so it
    // can never escalate in turn.
    expect(values?.dedupeKey).toBe('escalation:intent-1:0');
    expect(values?.priority).toBe('critical');
  });

  it('waits for the policy\u2019s own patience budget before handing over', async () => {
    arrangeAwake();
    const sent = delivery({
      id: 'del-1',
      status: 'sent',
      channel: 'push',
      // 20 minutes ago: past the 10-minute critical deadline, but nowhere near
      // the policy's 240-minute budget.
      sentAt: new Date('2026-08-19T11:40:00Z'),
    });
    vi.mocked(repo.getIntent).mockResolvedValue(
      intent({ priority: 'critical', escalationState: 'channel_fallback' }),
    );
    vi.mocked(repo.intentHasSignal).mockResolvedValue(false);
    vi.mocked(repo.listDeliveriesForIntent).mockResolvedValue([sent]);
    vi.mocked(repo.advanceEscalationState).mockResolvedValue(true);
    vi.mocked(repo.listEnabledEscalationPolicies).mockResolvedValue([
      {
        id: 'pol-1',
        type: 'member_pending_approval',
        afterMinutes: 240,
        escalateToRole: 'owner',
        escalateToUserId: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    vi.mocked(repo.insertIntent).mockResolvedValue(intent({ id: 'intent-2' }));

    await escalateIntent(db, 'intent-1', now);

    // The policy is not due, so the hardcoded adult fallback carries it — the
    // point of the fallback is that a critical event still reaches somebody.
    const [, values] = vi.mocked(repo.insertIntent).mock.calls[0] ?? [];
    expect(values?.audience).toEqual({ roles: [...ESCALATION_FALLBACK_ROLES] });
  });
});

/* ========================================================================== */
/* D11 — subscription health                                                   */
/* ========================================================================== */

describe('subscription health (D11)', () => {
  it('marks a subscription unhealthy at exactly the threshold', () => {
    const base = { expiredAt: null, unhealthyAt: null };
    expect(isSubscriptionUnhealthy({ ...base, consecutiveNoAck: 0 })).toBe(false);
    expect(isSubscriptionUnhealthy({ ...base, consecutiveNoAck: 2 })).toBe(false);
    expect(isSubscriptionUnhealthy({ ...base, consecutiveNoAck: 3 })).toBe(true);
    expect(isSubscriptionUnhealthy({ ...base, consecutiveNoAck: 9 })).toBe(true);
    expect(NOTIFICATION_LIMITS.maxSendsWithoutAck).toBe(3);

    // Already flagged, or already dead — both count as unhealthy for the banner.
    expect(
      isSubscriptionUnhealthy({ consecutiveNoAck: 0, expiredAt: null, unhealthyAt: new Date() }),
    ).toBe(true);
    expect(
      isSubscriptionUnhealthy({ consecutiveNoAck: 0, expiredAt: new Date(), unhealthyAt: null }),
    ).toBe(true);
  });

  it('the health check uses the shared threshold and re-queues lost work', async () => {
    vi.mocked(repo.markUnhealthySubscriptions).mockResolvedValue([]);
    vi.mocked(repo.listStalePushSubscriptions).mockResolvedValue([]);
    vi.mocked(repo.deleteExpiredSubscriptions).mockResolvedValue(0);
    vi.mocked(repo.deleteOldDeliveries).mockResolvedValue(0);
    vi.mocked(repo.listDueDeliveries).mockResolvedValue([delivery({ id: 'due-1' })]);
    vi.mocked(repo.listUndispatchedIntents).mockResolvedValue([]);
    vi.mocked(repo.listUnconfirmedDeliveries).mockResolvedValue([]);

    const result = await runPushHealthCheck(db, new Date('2026-08-19T03:45:00Z'));

    expect(repo.markUnhealthySubscriptions).toHaveBeenCalledWith(
      db,
      NOTIFICATION_LIMITS.maxSendsWithoutAck,
      expect.any(Date),
    );
    expect(result.requeued).toBe(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      'notification.deliver',
      { deliveryId: 'due-1' },
      expect.objectContaining({ jobId: 'deliver:due-1:sweep' }),
    );
  });
});

/* Integration lives in `notifications.inbox.integration.test.ts`, because this
   file mocks the repository module-wide and a test that imports the mock while
   claiming to exercise Postgres is worse than no test. */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function intent(overrides: Partial<NotificationIntentRow> = {}): NotificationIntentRow {
  return {
    id: 'intent-1',
    type: 'task_overdue',
    actorId: null,
    entityType: 'task_occurrence',
    entityId: null,
    payload: {},
    audience: { users: ['user-1'] },
    dedupeKey: null,
    priority: 'high',
    escalationState: 'none',
    escalatedAt: null,
    createdAt: new Date('2026-08-19T11:00:00Z'),
    ...overrides,
  };
}

function delivery(overrides: Partial<NotificationDeliveryRow> = {}): NotificationDeliveryRow {
  return {
    id: 'del-1',
    intentId: 'intent-1',
    userId: 'user-1',
    channel: 'push',
    status: 'sent',
    scheduledFor: null,
    sentAt: new Date('2026-08-19T11:00:00Z'),
    readAt: null,
    deliveredAt: null,
    interactedAt: null,
    acknowledgedAt: null,
    redeliveryCount: 0,
    attempt: 0,
    lastError: null,
    subscriptionId: null,
    createdAt: new Date('2026-08-19T11:00:00Z'),
    ...overrides,
  };
}

function quietRow(overrides: { startsAt: string; endsAt: string }) {
  return {
    id: 'qh-1',
    userId: 'user-1',
    dayOfWeek: null,
    mode: 'defer' as const,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/*
 * The deep-link fixture: **one distinct id per payload key**, so a rendered
 * link's id segment can be traced back to the key it came from. That
 * traceability is the whole point -- see `wrongKindOfId` below.
 */
const LINK_IDS = {
  userId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  eventId: '00000000-0000-4000-8000-000000000003',
  goalId: '00000000-0000-4000-8000-000000000004',
  listId: '00000000-0000-4000-8000-000000000005',
  postId: '00000000-0000-4000-8000-000000000006',
  occurrenceId: '00000000-0000-4000-8000-000000000007',
  swapId: '00000000-0000-4000-8000-000000000008',
  entityId: '00000000-0000-4000-8000-000000000009',
} as const;

type LinkIdKey = keyof typeof LINK_IDS;

const LINK_ID_KEY_BY_VALUE = new Map<string, LinkIdKey>(
  (Object.keys(LINK_IDS) as LinkIdKey[]).map((key) => [LINK_IDS[key], key]),
);

const LINK_FIXTURE = {
  ...LINK_IDS,
  displayName: 'Тест',
  title: 'Тест',
};

/**
 * Which payload ids each detail route's `:param` is allowed to be.
 *
 * A route is not just a shape, it is a *lookup*: `/tasks/:taskId` loads a task
 * occurrence, `/goals/:goalId` loads a goal. Pointing a route at an id of the
 * wrong kind produces a link that resolves perfectly and then renders the
 * page's error state, because the record it asks for does not exist.
 *
 * `entityId` is accepted everywhere on purpose: it is the intent's generic
 * entity pointer, and its kind lives in the sibling `entityType` column rather
 * than in the value, so this table cannot judge it. Every other key is judged.
 */
const ROUTE_ACCEPTS_IDS: Record<string, readonly LinkIdKey[]> = {
  // Both of these load an *occurrence*; `taskId`/`eventId` are the older
  // payload spellings producers still emit for the same thing.
  [APP_ROUTES.tasks]: ['occurrenceId', 'taskId'],
  [APP_ROUTES.calendar]: ['occurrenceId', 'eventId'],
  [APP_ROUTES.goals]: ['goalId'],
  [APP_ROUTES.shopping]: ['listId'],
};

const ALWAYS_ACCEPTED_ID: LinkIdKey = 'entityId';

/**
 * `null` when `navigate` carries an id the destination route can actually load,
 * otherwise a human-readable reason.
 *
 * Only links of the form `<known detail route>/<segment>` are judged; a pinned
 * route such as `/tasks` or `/wall` has no id to get wrong.
 */
function wrongKindOfId(navigate: string): string | null {
  const [pathname = ''] = navigate.split(/[?#]/);
  const base = APP_ROUTES_WITH_DETAIL.find((route) => pathname.startsWith(`${route}/`));
  if (base === undefined) return null;

  const segment = pathname.slice(base.length + 1);
  if (segment.length === 0 || segment.includes('/')) return null; // `isKnownAppPath`'s job

  const accepted = ROUTE_ACCEPTS_IDS[base] ?? [];
  const key = LINK_ID_KEY_BY_VALUE.get(segment);

  if (key === undefined) {
    return `${base}/<id> carries "${segment}", which is not any id from the payload`;
  }
  if (key === ALWAYS_ACCEPTED_ID) return null;
  if (accepted.includes(key)) return null;

  return `${base}/<id> carries the ${key} -- it can only load ${accepted.join(' or ')}`;
}

describe('notification deep links', () => {
  it('every rendered link resolves to a real route', () => {
    // The regression this exists for: `member_pending_approval` pointed at
    // `/settings/members` and swap notifications at `/chores/swaps`. Neither is
    // a route, so tapping the notification landed on a 404 -- from a push, which
    // is the one place the user has no idea what they did wrong.
    const unknown: Array<{ type: string; navigate: string }> = [];

    for (const type of NOTIFICATION_TYPES) {
      const rendered = renderNotification(type, LINK_FIXTURE);
      if (rendered.navigate && !isKnownAppPath(rendered.navigate)) {
        unknown.push({ type, navigate: rendered.navigate });
      }
    }

    expect(unknown).toEqual([]);
  });

  it('every rendered link carries an id the destination can actually load', () => {
    /*
     * The third bug in this family, and the first one `isKnownAppPath` was
     * structurally incapable of seeing.
     *
     * Both swap notifications linked to `route(APP_ROUTES.tasks, swapId)`.
     * `/tasks/:taskId` is a real route, so the path resolved, the guard passed
     * and CI stayed green -- but `:taskId` is a task *occurrence* id and a swap
     * id is not one, so `TaskDetailPage` looked up a record that does not exist
     * and rendered its error state. Every swap notification the family ever
     * received went nowhere useful.
     *
     * The first two (`/admin/members/<uuid>`, `/wall/<postId>`) were caught by
     * tightening the *path* rules. No amount of path tightening reaches this
     * one, because the path was never wrong. So this check reads the id
     * instead: the fixture gives every payload key its own uuid, which makes
     * the id segment of any rendered link traceable back to the key that
     * produced it, and `ROUTE_ACCEPTS_IDS` says which keys each route can load.
     *
     * A future notification that points a route at the wrong kind of id fails
     * here, in CI, instead of in somebody's hand.
     */
    const mismatched: Array<{ type: string; navigate: string; problem: string }> = [];

    for (const type of NOTIFICATION_TYPES) {
      const rendered = renderNotification(type, LINK_FIXTURE);
      if (!rendered.navigate) continue;
      const problem = wrongKindOfId(rendered.navigate);
      if (problem) mismatched.push({ type, navigate: rendered.navigate, problem });
    }

    expect(mismatched).toEqual([]);
  });

  it('declares an accepted id kind for every route that has a detail page', () => {
    // Otherwise a new detail route silently opts out of the check above: an
    // undeclared route has an empty accept list, so `wrongKindOfId` would have
    // nothing to compare against and would wave every id through. Keeping the
    // two lists in step is what makes the guard hold for routes that do not
    // exist yet.
    expect(Object.keys(ROUTE_ACCEPTS_IDS).sort()).toEqual([...APP_ROUTES_WITH_DETAIL].sort());
    for (const [route, keys] of Object.entries(ROUTE_ACCEPTS_IDS)) {
      expect(keys.length, `${route} accepts no id at all`).toBeGreaterThan(0);
    }
  });

  it('sends a swap request to the queue that has the accept and decline buttons', () => {
    /*
     * `chore_swap_requested` asks for a decision, and the only place that
     * decision can be taken is `SwapInbox`, which `TasksPage` renders.
     * `TaskDetailPage` carries the *outgoing* half of a swap and no accept
     * button, so `/tasks/<occurrenceId>` -- while it loads a real record --
     * would show the reader a chore assigned to somebody else and no way to
     * answer the question the notification just asked.
     */
    const rendered = renderNotification('chore_swap_requested', {
      ...LINK_FIXTURE,
      actorName: 'Миша',
    });

    expect(rendered.navigate).toBe(APP_ROUTES.tasks);
  });

  it('sends a swap answer to the chore itself, not to the finished swap', () => {
    // The outcome is news about the chore -- who is carrying it now that the
    // answer landed. The occurrence id is what `/tasks/:taskId` can load; the
    // swap id is what it used to carry, and could not.
    const rendered = renderNotification('chore_swap_answered', {
      ...LINK_FIXTURE,
      accepted: true,
      actorName: 'Лиза',
    });

    expect(rendered.navigate).toBe(`${APP_ROUTES.tasks}/${LINK_IDS.occurrenceId}`);
    expect(rendered.navigate).not.toContain(LINK_IDS.swapId);
  });

  it('sends the join request to the approval queue, not to a member page that does not exist', () => {
    /*
     * `isKnownAppPath` above cannot catch this one, and that is the point.
     *
     * It accepts any child of a known route, because that is exactly how
     * `/tasks/<id>` and `/goals/<id>` are built — routes that *have* a detail
     * page. `/admin/members` does not: the approval queue is a single list, and
     * a member is approved from a card in it. So `/admin/members/<uuid>` passed
     * the guard, matched nothing in the router, and rendered the 404 screen.
     *
     * That left the owner's join-request notification with no working way
     * through to the queue at all — the body tap 404'd, and the only button on
     * the card was the D11 delivery receipt.
     */
    const rendered = renderNotification('member_pending_approval', {
      userId: '00000000-0000-4000-8000-000000000001',
      displayName: 'дарья кислякова',
      provider: 'google',
    });

    expect(rendered.navigate).toBe(APP_ROUTES.adminMembers);
  });
});
