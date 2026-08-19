import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **Who gets told, and how loudly.**
 *
 * Every producer used to hand-roll its own `INSERT INTO notification_intents`,
 * and each copy got a different part of the row wrong. The bugs were invisible
 * because the tests that existed asserted on the *type* of the notification and
 * nothing else — a stub that records `intent.type` cannot tell a kudos sent to
 * one person from the same kudos broadcast to the whole household.
 *
 * So these tests assert on the two columns the copies got wrong, at the exact
 * place they are written: the `audience` and the `priority` arguments that reach
 * `repo.insertIntent` through the real `emitIntent`.
 *
 * | Column | Failure it prevents |
 * |---|---|
 * | `audience` unset ⇒ `{}` ⇒ `{ everyone: true }` | every «спасибо» told the whole family *they* had been thanked; «молоко срочно» pushed at everyone with `shopping:read` |
 * | `priority` hardcoded | `chore_swap_requested` is `high`; written as `normal` it has no D11 deadline at all, so an unanswered swap never escalates |
 *
 * No database and no Redis: the notifications repository is mocked module-wide,
 * so the producers run for real all the way down to the row they would write.
 */

/* -------------------------------------------------------------------------- */
/* Environment — hoisted above every import                                    */
/* -------------------------------------------------------------------------- */

const { enqueueMock } = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'fatal';
  process.env.VAPID_PUBLIC_KEY ??= 'test-vapid-public-key';
  process.env.VAPID_PRIVATE_KEY ??= 'test-vapid-private-key';
  process.env.VAPID_SUBJECT ??= 'mailto:admin@family.example.com';
  process.env.TELEGRAM_BOT_TOKEN ??= '123456:test-bot-token';
  return { enqueueMock: vi.fn(() => Promise.resolve()) };
});

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

/** Keep the real module's shape so a new repository function is never `undefined`. */
function mockModule(actual: Record<string, unknown>): Record<string, unknown> {
  const mocked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' ? vi.fn() : value;
  }
  return mocked;
}

vi.mock('./notifications.repository.js', async (importOriginal) =>
  mockModule(await importOriginal<Record<string, unknown>>()),
);
vi.mock('../wall/wall.repository.js', async (importOriginal) =>
  mockModule(await importOriginal<Record<string, unknown>>()),
);
vi.mock('../wall/activity.service.js', async (importOriginal) =>
  mockModule(await importOriginal<Record<string, unknown>>()),
);
vi.mock('../identity/identity.repository.js', async (importOriginal) =>
  mockModule(await importOriginal<Record<string, unknown>>()),
);
vi.mock('../events/events.repository.js', async (importOriginal) =>
  mockModule(await importOriginal<Record<string, unknown>>()),
);

import {
  NOTIFICATION_TYPE_DEFAULT_PRIORITY,
  ROLES,
  ROLE_PERMISSIONS,
  type Role,
} from '@family/shared';

import { installTemporal } from '../../core/temporal.js';
import { buildAuthContext, type AuthContext } from '../../core/auth/context.js';
import type { Db, Executor } from '../../core/db.js';
import type { KudosRow } from '../chores/chores.schema.js';
import { emitChoreIntent } from '../chores/swaps.service.js';
import { announceBirthdaysToday, birthdayFallsOn } from '../events/birthdays.service.js';
import * as eventsRepo from '../events/events.repository.js';
import * as identityRepo from '../identity/identity.repository.js';
import { register } from '../identity/identity.service.js';
import type { UserRow } from '../identity/users.schema.js';
import { emitUrgentItemIntent } from '../shopping/shopping.service.js';
import * as wallRepo from '../wall/wall.repository.js';
import { giveKudos } from '../wall/wall.service.js';
import * as repo from './notifications.repository.js';
import type { NotificationIntentRow } from './notifications.schema.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const GIVER = randomUUID();
const RECIPIENT = randomUUID();
const BYSTANDER = randomUUID();
const SHOPPER = randomUUID();

function userRow(role: Role, overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date();
  return {
    id: randomUUID(),
    email: null,
    emailVerified: false,
    displayName: 'Тест',
    avatarUrl: null,
    passwordHash: null,
    role,
    status: 'active',
    permissionGrants: [],
    permissionDenies: [],
    birthDate: null,
    timezone: null,
    locale: 'ru-RU',
    choreWeight: '1.00',
    sortOrder: 0,
    color: null,
    approvedAt: now,
    approvedById: null,
    rejectedReason: null,
    lastSeenAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const authFor = (role: Role, overrides: Partial<UserRow> = {}): AuthContext =>
  buildAuthContext(userRow(role, overrides));

/** Whatever `insertIntent` was asked to write. The row under test. */
type WrittenIntent = Parameters<typeof repo.insertIntent>[1];

function written(): WrittenIntent[] {
  return vi.mocked(repo.insertIntent).mock.calls.map(([, values]) => values);
}

function onlyIntent(): WrittenIntent {
  const rows = written();
  expect(rows).toHaveLength(1);
  return rows[0] as WrittenIntent;
}

/**
 * A `Db` that runs the callback and nothing else.
 *
 * Every repository the producers touch is mocked, so the handle is never
 * actually queried — except by `giveKudos`, whose recipient lookup is stubbed
 * per test.
 */
function fakeDb(overrides: Record<string, unknown> = {}): Db {
  const db = {
    transaction: <T>(fn: (tx: Executor) => Promise<T>): Promise<T> => fn(db as Executor),
    ...overrides,
  };
  return db as unknown as Db;
}

/** `db.select(...).from(...).where(...).limit(...)` resolving to `rows`. */
function selectReturning(rows: unknown[]): Record<string, unknown> {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every emit succeeds and produces a fresh intent id unless a test says
  // otherwise, so `dispatch()` is exercised rather than short-circuited.
  vi.mocked(repo.insertIntent).mockImplementation((_x, values) =>
    Promise.resolve({ id: randomUUID(), ...values } as unknown as NotificationIntentRow),
  );
});

/* ========================================================================== */
/* Kudos — one recipient, never the household                                 */
/* ========================================================================== */

describe('kudos notify exactly the person who was thanked', () => {
  const kudosRow = (): KudosRow => ({
    id: randomUUID(),
    fromUserId: GIVER,
    toUserId: RECIPIENT,
    occurrenceId: null,
    emoji: '👏',
    message: 'спасибо за посуду',
    createdAt: new Date('2026-08-19T10:00:00.000Z'),
  });

  function giver(): AuthContext {
    return authFor('adult', { id: GIVER, displayName: 'Павел' });
  }

  beforeEach(() => {
    vi.mocked(wallRepo.insertKudos).mockResolvedValue(kudosRow());
  });

  it('addresses the intent to the recipient alone', async () => {
    const db = fakeDb(
      selectReturning([{ id: RECIPIENT, displayName: 'Мария', status: 'active' }]),
    );

    await giveKudos(db, giver(), { toUserId: RECIPIENT, emoji: '👏' });

    const intent = onlyIntent();
    // The bug: no `audience` at all. The column defaults to `{}`, which
    // `parseAudience` reads as `{ everyone: true }`, and `kudos_received`
    // requires no permission — so nothing downstream narrowed it.
    expect(intent.audience).toEqual({ users: [RECIPIENT] });
    expect(intent.audience).not.toEqual({});
    expect(intent.audience).not.toHaveProperty('everyone');
    expect(intent.audience).not.toHaveProperty('roles');

    const recipients = (intent.audience as { users: string[] }).users;
    expect(recipients).not.toContain(GIVER);
    expect(recipients).not.toContain(BYSTANDER);
  });

  it('uses the catalog priority — a thank-you must never interrupt anybody', async () => {
    const db = fakeDb(
      selectReturning([{ id: RECIPIENT, displayName: 'Мария', status: 'active' }]),
    );

    await giveKudos(db, giver(), { toUserId: RECIPIENT, emoji: '👏' });

    // Was hardcoded `'normal'`; the catalog says `low`, which is what keeps it
    // out of the push channel and out of the D11 escalation ladder entirely.
    expect(onlyIntent().priority).toBe('low');
    expect(onlyIntent().priority).toBe(NOTIFICATION_TYPE_DEFAULT_PRIORITY.kudos_received);
  });

  it('enqueues the fan-out once, and only after the transaction returned', async () => {
    const order: string[] = [];
    const db = fakeDb({
      ...selectReturning([{ id: RECIPIENT, displayName: 'Мария', status: 'active' }]),
      transaction: async <T>(fn: (tx: Executor) => Promise<T>): Promise<T> => {
        const result = await fn(db);
        order.push('commit');
        return result;
      },
    });
    enqueueMock.mockImplementation(() => {
      order.push('enqueue');
      return Promise.resolve();
    });

    await giveKudos(db, giver(), { toUserId: RECIPIENT, emoji: '👏' });

    // A worker that reads the intent before the commit finds nothing, and
    // `dispatchIntent` treats that as "nothing to do" — the notification would
    // be lost for good.
    expect(order).toEqual(['commit', 'enqueue']);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});

/* ========================================================================== */
/* Shopping — only the person standing in the shop                            */
/* ========================================================================== */

describe('an urgent shopping item notifies only the intended shopper', () => {
  const urgent = {
    actorId: GIVER,
    actorName: 'Павел',
    shopperId: SHOPPER,
    listId: randomUUID(),
    listName: 'Пятёрочка',
    itemId: randomUUID(),
    itemName: 'молоко',
    quantity: 1,
    unit: 'шт',
  };

  it('names the shopper in the audience, not in an unread payload field', async () => {
    await emitUrgentItemIntent(fakeDb(), urgent);

    const intent = onlyIntent();
    expect(intent.audience).toEqual({ users: [SHOPPER] });

    // The bug: the recipient was recorded as `payload.recipientId`, a field no
    // consumer has ever read, while `audience` stayed `{}` — i.e. everyone.
    // The audience is the only thing the fan-out looks at.
    expect(intent.payload).not.toHaveProperty('recipientId');
  });

  it('stays `high` — the priority that gives it a D11 escalation ladder', async () => {
    await emitUrgentItemIntent(fakeDb(), urgent);

    expect(onlyIntent().priority).toBe('high');
    expect(onlyIntent().priority).toBe(
      NOTIFICATION_TYPE_DEFAULT_PRIORITY.shopping_urgent_item,
    );
  });

  it('is idempotent per item, so a flaky connection interrupts one person once', async () => {
    await emitUrgentItemIntent(fakeDb(), urgent);
    expect(onlyIntent().dedupeKey).toBe(`shopping_urgent_item:${urgent.itemId}`);
  });
});

/* ========================================================================== */
/* Swaps — the priority that makes escalation possible at all                  */
/* ========================================================================== */

describe('a swap request is high priority', () => {
  it('takes the priority from the catalog rather than a literal', async () => {
    await emitChoreIntent(fakeDb(), {
      type: 'chore_swap_requested',
      actorId: GIVER,
      entityType: 'task_occurrence',
      entityId: randomUUID(),
      dedupeKey: `chore_swap_requested:${randomUUID()}`,
      payload: {},
      audience: { users: [RECIPIENT] },
    });

    const intent = onlyIntent();
    // Was hardcoded `'normal'`. Per D11 only `high`/`critical` have an
    // escalation deadline, so as `normal` an unanswered «поменяемся?» sat there
    // forever and nobody was ever chased.
    expect(intent.priority).toBe('high');
    expect(intent.priority).toBe(NOTIFICATION_TYPE_DEFAULT_PRIORITY.chore_swap_requested);
  });

  it('keeps an answered swap at its own, quieter catalog priority', async () => {
    await emitChoreIntent(fakeDb(), {
      type: 'chore_swap_answered',
      actorId: GIVER,
      entityType: 'task_occurrence',
      entityId: randomUUID(),
      dedupeKey: `chore_swap_answered:${randomUUID()}:accepted`,
      payload: {},
      audience: { users: [RECIPIENT] },
    });

    // One hardcoded literal cannot be right for two types at once — which is
    // the whole reason the priority now comes from the catalog.
    expect(onlyIntent().priority).toBe('normal');
  });

  it('spells an open offer out as `everyone`, never as an empty audience', async () => {
    await emitChoreIntent(fakeDb(), {
      type: 'chore_swap_requested',
      actorId: GIVER,
      entityType: 'task_occurrence',
      entityId: randomUUID(),
      dedupeKey: `chore_swap_requested:${randomUUID()}`,
      payload: {},
      audience: { everyone: true },
    });

    // `{}` and `{ everyone: true }` behave identically at the fan-out, but only
    // one of them is a decision somebody made on purpose.
    expect(onlyIntent().audience).toEqual({ everyone: true });
  });
});

/* ========================================================================== */
/* Registration — the approval queue finally has a doorbell                    */
/* ========================================================================== */

describe('birthday greetings reach everyone except the birthday person', () => {
  const MASHA = randomUUID();
  const DASHA = randomUUID();
  const PAPA = randomUUID();

  beforeEach(async () => {
    await installTemporal();
    vi.mocked(eventsRepo.getFamilyTimezone).mockResolvedValue('Europe/Moscow');
  });

  it('addresses the family but never the celebrant', async () => {
    vi.mocked(eventsRepo.listBirthdayCandidates).mockResolvedValue([
      { id: MASHA, displayName: 'Маша', birthDate: '2010-08-19', status: 'active' },
      { id: PAPA, displayName: 'Павел', birthDate: '1988-04-12', status: 'active' },
    ]);

    const emitted = await announceBirthdaysToday(
      fakeDb(),
      new Date('2026-08-19T09:00:00.000Z'),
    );

    expect(emitted).toBe(1);
    const intent = onlyIntent();
    expect(intent.type).toBe('birthday_today');
    // `actorId` is null for a scheduler intent, so self-suppression cannot
    // fire — «Сегодня празднует Маша» has to be kept off Маша's own phone here.
    expect(intent.audience).toEqual({ users: [PAPA] });
    expect(intent.payload).toMatchObject({ personName: 'Маша', age: 16 });
  });

  it('greets once per person per year, whatever the job does', async () => {
    vi.mocked(eventsRepo.listBirthdayCandidates).mockResolvedValue([
      { id: MASHA, displayName: 'Маша', birthDate: '2010-08-19', status: 'active' },
      { id: PAPA, displayName: 'Павел', birthDate: '1988-04-12', status: 'active' },
    ]);

    await announceBirthdaysToday(fakeDb(), new Date('2026-08-19T09:00:00.000Z'));

    expect(onlyIntent().dedupeKey).toBe(`birthday_today:${MASHA}:2026-08-19`);
  });

  it('says nothing on a day nobody is celebrating', async () => {
    vi.mocked(eventsRepo.listBirthdayCandidates).mockResolvedValue([
      { id: PAPA, displayName: 'Павел', birthDate: '1988-04-12', status: 'active' },
    ]);

    await announceBirthdaysToday(fakeDb(), new Date('2026-08-19T09:00:00.000Z'));
    expect(written()).toHaveLength(0);
  });

  it('greets a leap-day person on the last day of February, exactly like the calendar', () => {
    // The same rule `planBirthday` compiles into `BYMONTHDAY=-1`: three years
    // out of four the app would otherwise forget Даша entirely.
    expect(birthdayFallsOn('2016-02-29', '2028-02-29')).toBe(true);
    expect(birthdayFallsOn('2016-02-29', '2026-02-28')).toBe(true);
    expect(birthdayFallsOn('2016-02-29', '2026-03-01')).toBe(false);
    // A common-year 28 February person is greeted on the 28th, always — and is
    // not dragged along by the leap-day rule in a leap year.
    expect(birthdayFallsOn('2015-02-28', '2028-02-28')).toBe(true);
    expect(birthdayFallsOn('2015-02-28', '2028-02-29')).toBe(false);
    expect(birthdayFallsOn(null, '2026-08-19')).toBe(false);
    expect(birthdayFallsOn('rubbish', '2026-08-19')).toBe(false);
    void DASHA;
  });
});

describe('registration tells the people who can approve, and nobody else', () => {
  const ctx = { ip: '127.0.0.1', userAgent: 'vitest', actorId: null };
  const applicant = userRow('child', {
    displayName: 'Бабушка Нина',
    status: 'pending_approval',
    approvedAt: null,
    email: 'nina@example.com',
  });

  beforeEach(() => {
    vi.mocked(identityRepo.lockBootstrap).mockResolvedValue(undefined);
    vi.mocked(identityRepo.getFamilySettings).mockResolvedValue({
      allowRegistration: true,
    } as Awaited<ReturnType<typeof identityRepo.getFamilySettings>>);
    // A family that already exists: this is not the bootstrap owner.
    vi.mocked(identityRepo.countUsers).mockResolvedValue(4);
    vi.mocked(identityRepo.countActiveOwners).mockResolvedValue(1);
    vi.mocked(identityRepo.findUserByEmail).mockResolvedValue(undefined);
    vi.mocked(identityRepo.insertUser).mockResolvedValue(applicant);
    vi.mocked(identityRepo.insertIdentity).mockResolvedValue(
      {} as Awaited<ReturnType<typeof identityRepo.insertIdentity>>,
    );
    vi.mocked(identityRepo.writeAudit).mockResolvedValue(undefined);
  });

  async function registerApplicant(): Promise<void> {
    await register(
      fakeDb(),
      {
        email: 'nina@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Бабушка Нина',
      },
      ctx,
    );
  }

  it('emits `member_pending_approval` at all — nobody used to be told', async () => {
    await registerApplicant();

    const intent = onlyIntent();
    expect(intent.type).toBe('member_pending_approval');
    expect(intent.entityId).toBe(applicant.id);
    expect(intent.dedupeKey).toBe(`member_pending_approval:${applicant.id}`);
  });

  it('addresses only the roles that hold `member:approve`', async () => {
    await registerApplicant();

    const roles = (onlyIntent().audience as { roles: Role[] }).roles;
    const holders = ROLES.filter((role) => ROLE_PERMISSIONS[role].includes('member:approve'));

    expect([...roles].sort()).toEqual([...holders].sort());
    expect(roles).toContain('owner');
    expect(roles).toContain('admin');
    // The people the applicant's own status is none of: an approval queue is
    // admin business, and a child seeing «Заявка в семью» is a leak.
    expect(roles).not.toContain('adult');
    expect(roles).not.toContain('teen');
    expect(roles).not.toContain('child');
    expect(roles).not.toContain('guest');
  });

  it('is `high` — an unapproved person cannot use the app at all', async () => {
    await registerApplicant();

    expect(onlyIntent().priority).toBe('high');
    expect(onlyIntent().priority).toBe(
      NOTIFICATION_TYPE_DEFAULT_PRIORITY.member_pending_approval,
    );
  });

  it('says nothing when the first signup auto-approves itself as owner', async () => {
    // Empty family: `isBootstrapSignup` makes this an active owner, so there is
    // no queue and nobody to notify — least of all the owner about themselves.
    vi.mocked(identityRepo.countUsers).mockResolvedValue(0);
    vi.mocked(identityRepo.countActiveOwners).mockResolvedValue(0);
    vi.mocked(identityRepo.insertUser).mockResolvedValue(
      userRow('owner', { status: 'active', email: 'nina@example.com' }),
    );
    vi.mocked(identityRepo.touchLastLogin).mockResolvedValue(undefined);
    vi.mocked(identityRepo.insertRefreshToken).mockResolvedValue(
      {} as Awaited<ReturnType<typeof identityRepo.insertRefreshToken>>,
    );

    await registerApplicant();

    expect(written()).toHaveLength(0);
  });
});
