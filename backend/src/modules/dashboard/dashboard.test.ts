import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_DIGEST_SECTIONS,
  effectivePermissions,
  type DigestSection,
  type Permission,
  type Role,
} from '@family/shared';
import { todayResponseSchema } from '@family/shared/contracts/dashboard';

import dashboardRoutes, { DASHBOARD_ROUTE_ACCESS } from './dashboard.routes.js';
import { runWeeklyDigestSweep } from './dashboard.jobs.js';
import {
  addLocalDays,
  buildFairness,
  dayWindowFor,
  getToday,
  getWeek,
  isoWeekdayOf,
  localDateOf,
  overdueMinutes,
  pickNearestMilestone,
  resolveAccess,
  resolveTimezone,
  startOfLocalDay,
  startOfLocalWeek,
  type DashboardActor,
  type EventRow,
  type GoalRow,
  type LoadRow,
  type MemberRow,
  type ShoppingSnapshot,
  type TaskRow,
  type ViewerContext,
} from './dashboard.service.js';
import {
  birthdaysIn,
  composeDigest,
  countRu,
  digestDueDecision,
  formatMoneyRu,
  isoWeekKey,
  localSlotInstant,
  NBSP,
  pluralRu,
  relativeDayRu,
  renderDigestText,
  RU_PLURALS,
  sanitizeSections,
  type DigestData,
  type DigestPort,
  type DigestSubscriber,
  type NotificationIntentPort,
  type WallCounts,
} from './digest.service.js';

/**
 * Dashboard & digest tests.
 *
 * Everything that carries a real rule here is a pure function of its inputs —
 * permission gating, timezone bucketing, Russian composition, the send-once
 * decision — so the suite runs with no Postgres, no Redis and no clock of its
 * own. The DB-shaped half is gated on `TEST_DATABASE_URL` (see
 * `src/test/setup.ts`) so `pnpm test` stays runnable without Docker.
 *
 * The four properties this file exists to prove:
 *
 * 1. A child's «Сегодня» payload contains **no** goal or finance data, and the
 *    goal query is never even issued.
 * 2. "Today" is the *caller's* today. The test process runs with
 *    `TZ=Europe/Moscow`; a caller in Los Angeles must get Los Angeles' date.
 * 3. The digest cannot be sent twice for the same ISO week, however many times
 *    the hourly job runs.
 * 4. Russian numeric agreement is right, including the 11–14 exception, and an
 *    empty section says something friendly rather than emitting a bare heading.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ADULT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';
const PENDING_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const GOAL_ID = '66666666-6666-4666-8666-666666666666';
const MILESTONE_ID = '77777777-7777-4777-8777-777777777777';

const MOSCOW = 'Europe/Moscow';
/** UTC−7 in August. Deliberately on the other side of the date line from the
 *  server's `TZ=Europe/Moscow`, so a leaked server clock is impossible to miss. */
const LOS_ANGELES = 'America/Los_Angeles';

/** 2026-08-19 21:30 UTC — 00:30 on the 20th in Moscow, 14:30 on the 19th in LA. */
const NOW = new Date('2026-08-19T21:30:00.000Z');

function actorFor(role: Role, userId: string, timezone: string | null = null): DashboardActor {
  const permissions = new Set<Permission>(effectivePermissions(role));
  return {
    userId,
    displayName: role === 'child' ? 'Маша' : 'Аня',
    timezone,
    can: (permission) => permissions.has(permission),
  };
}

function member(overrides: Partial<MemberRow> & Pick<MemberRow, 'id' | 'displayName'>): MemberRow {
  return {
    email: null,
    role: 'adult',
    status: 'active',
    choreWeight: '1.00',
    birthDate: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function task(overrides: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'dueAt'>): TaskRow {
  return {
    seriesId: `series-${overrides.id}`,
    points: 5,
    category: null,
    assigneeId: ADULT_ID,
    graceMinutes: 0,
    status: 'scheduled',
    completedAt: null,
    ...overrides,
  };
}

function event(
  overrides: Partial<EventRow> & Pick<EventRow, 'id' | 'title' | 'startsAt'>,
): EventRow {
  return {
    seriesId: `series-${overrides.id}`,
    endsAt: new Date(overrides.startsAt.getTime() + 3_600_000),
    isAllDay: false,
    location: null,
    color: null,
    ...overrides,
  };
}

interface World {
  viewer: ViewerContext;
  members: MemberRow[];
  tasks: TaskRow[];
  familyTasks: TaskRow[];
  events: EventRow[];
  shopping: ShoppingSnapshot;
  goals: GoalRow[];
  unread: number;
  load: LoadRow[];
  wall: WallCounts;
  contributions: number;
  subscribers: DigestSubscriber[];
}

function world(overrides: Partial<World> = {}): World {
  return {
    viewer: {
      userId: ADULT_ID,
      displayName: 'Аня',
      role: 'adult',
      userTimezone: null,
      familyTimezone: MOSCOW,
      familyName: 'Семья',
      weekStartsOn: 1,
      currency: 'RUB',
    },
    members: [
      member({ id: ADULT_ID, displayName: 'Аня', role: 'adult' }),
      member({ id: CHILD_ID, displayName: 'Маша', role: 'child', birthDate: '2014-08-25' }),
      member({ id: TEEN_ID, displayName: 'Паша', role: 'teen' }),
    ],
    tasks: [],
    familyTasks: [],
    events: [],
    shopping: { items: [], neededCount: 0, urgentCount: 0 },
    goals: [],
    unread: 0,
    load: [],
    wall: { announcements: 0, kudos: 0 },
    contributions: 0,
    subscribers: [],
    ...overrides,
  };
}

/** Records which port methods were called — the "never even fetched" assertion. */
interface FakePort extends DigestPort {
  calls: string[];
}

function makePort(state: World): FakePort {
  const calls: string[] = [];
  const track = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(value);
  };

  return {
    calls,
    loadViewer: (userId) =>
      track(
        'loadViewer',
        userId === state.viewer.userId ? state.viewer : { ...state.viewer, userId },
      ),
    loadMembers: () => track('loadMembers', state.members),
    loadMyTasks: (userId, range) =>
      track(
        'loadMyTasks',
        state.tasks.filter(
          (t) =>
            t.assigneeId === userId &&
            t.dueAt >= range.sinceUtc &&
            t.dueAt < range.untilUtc &&
            (t.status === 'scheduled' ||
              (t.status === 'done' && !!t.completedAt && t.completedAt >= range.doneSinceUtc)),
        ),
      ),
    loadFamilyTasks: (range) =>
      track(
        'loadFamilyTasks',
        state.familyTasks.filter((t) => t.dueAt >= range.fromUtc && t.dueAt < range.toUtc),
      ),
    loadEvents: (_userId, range) =>
      track(
        'loadEvents',
        state.events.filter((e) => e.startsAt < range.toUtc && e.endsAt >= range.fromUtc),
      ),
    loadShopping: () => track('loadShopping', state.shopping),
    loadGoals: () => track('loadGoals', state.goals),
    loadUnreadCount: () => track('loadUnreadCount', state.unread),
    loadLoad: () => track('loadLoad', state.load),
    loadWallCounts: () => track('loadWallCounts', state.wall),
    loadGoalContributions: () => track('loadGoalContributions', state.contributions),
    loadSubscriber: (userId) =>
      track('loadSubscriber', state.subscribers.find((s) => s.userId === userId) ?? null),
    listSubscribers: () => track('listSubscribers', state.subscribers),
    markSent: (userId, sentAt, notSentSince) => {
      calls.push('markSent');
      const subscriber = state.subscribers.find((s) => s.userId === userId);
      if (!subscriber) return Promise.resolve(false);
      const last = subscriber.schedule.lastSentAt;
      // Mirrors the SQL predicate: `last_sent_at is null or last_sent_at < $slot`.
      if (last !== null && last.getTime() >= notSentSince.getTime()) return Promise.resolve(false);
      subscriber.schedule.lastSentAt = sentAt;
      return Promise.resolve(true);
    },
  };
}

/** Mirrors the partial unique index on `notification_intents.dedupe_key`. */
function makeIntents(): NotificationIntentPort & { emitted: string[] } {
  const seen = new Set<string>();
  const emitted: string[] = [];
  return {
    emitted,
    emit(intent) {
      if (seen.has(intent.dedupeKey)) return Promise.resolve({ intentId: '', created: false });
      seen.add(intent.dedupeKey);
      emitted.push(intent.dedupeKey);
      return Promise.resolve({ intentId: `intent-${emitted.length}`, created: true });
    },
  };
}

/* ========================================================================== */
/* Timezone: "today" belongs to the caller, never to the server               */
/* ========================================================================== */

describe('local day boundaries', () => {
  it('runs with a Moscow server clock — the premise of every test below', () => {
    expect(process.env.TZ).toBe('Europe/Moscow');
    // If this ever stopped being true the LA assertions would pass vacuously.
    expect(localDateOf(NOW, MOSCOW)).toBe('2026-08-20');
  });

  it('gives two callers two different todays for the same instant', () => {
    expect(localDateOf(NOW, MOSCOW)).toBe('2026-08-20');
    expect(localDateOf(NOW, LOS_ANGELES)).toBe('2026-08-19');
  });

  it('anchors the day window on the caller timezone', () => {
    const la = dayWindowFor(LOS_ANGELES, NOW);
    expect(la.today).toBe('2026-08-19');
    expect(la.tomorrow).toBe('2026-08-20');
    // Local midnight in LA on 19 Aug 2026 (PDT, UTC−7) is 07:00Z.
    expect(la.startOfToday.toISOString()).toBe('2026-08-19T07:00:00.000Z');
    expect(la.startOfTomorrow.toISOString()).toBe('2026-08-20T07:00:00.000Z');

    const msk = dayWindowFor(MOSCOW, NOW);
    expect(msk.today).toBe('2026-08-20');
    expect(msk.startOfToday.toISOString()).toBe('2026-08-19T21:00:00.000Z');
  });

  it('falls back user → family → Moscow, in that order', () => {
    expect(resolveTimezone('Asia/Tbilisi', MOSCOW)).toBe('Asia/Tbilisi');
    expect(resolveTimezone(null, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimezone('   ', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimezone(null, null)).toBe(MOSCOW);
  });

  it('crosses a DST boundary without drifting an hour', () => {
    // Europe/Berlin springs forward on 29 March 2026; local midnight exists on
    // both sides, but the UTC offset changes from +01:00 to +02:00.
    expect(startOfLocalDay('2026-03-28', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-27T23:00:00.000Z',
    );
    expect(startOfLocalDay('2026-03-30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
  });

  it('starts the week on the configured ISO weekday', () => {
    // 2026-08-20 is a Thursday.
    expect(isoWeekdayOf('2026-08-20')).toBe(4);
    expect(startOfLocalWeek('2026-08-20', 1)).toBe('2026-08-17');
    expect(startOfLocalWeek('2026-08-20', 7)).toBe('2026-08-16');
    expect(addLocalDays('2026-08-31', 1)).toBe('2026-09-01');
  });
});

describe('«Сегодня» in the caller timezone', () => {
  /**
   * One instant, one task, two readers. 2026-08-19T22:00Z is 15:00 on the 19th
   * in Los Angeles (today, still ahead) and 01:00 on the 20th in Moscow.
   */
  const dinner = task({
    id: 'task-dinner',
    title: 'Ужин',
    dueAt: new Date('2026-08-19T22:00:00.000Z'),
  });

  it('buckets a task by the caller local day, not the server one', async () => {
    const state = world({ tasks: [dinner] });
    const payload = await getToday(makePort(state), actorFor('adult', ADULT_ID, LOS_ANGELES), NOW);

    expect(payload.timezone).toBe(LOS_ANGELES);
    expect(payload.today).toBe('2026-08-19');
    expect(payload.tasks.dueToday.map((t) => t.id)).toEqual(['task-dinner']);
    expect(payload.tasks.dueToday[0]?.dueDate).toBe('2026-08-19');
    expect(payload.tasks.dueToday[0]?.dueTime).toBe('15:00');
    expect(payload.tasks.overdue).toHaveLength(0);
  });

  it('gives the same task a different local date to a Moscow reader', async () => {
    const state = world({ tasks: [dinner] });
    const payload = await getToday(makePort(state), actorFor('adult', ADULT_ID, MOSCOW), NOW);

    expect(payload.today).toBe('2026-08-20');
    // 01:00 on the 20th — inside the Moscow reader's today.
    expect(payload.tasks.dueToday[0]?.dueDate).toBe('2026-08-20');
    expect(payload.tasks.dueToday[0]?.dueTime).toBe('01:00');
  });

  it('inherits the family timezone when the user has none', async () => {
    const state = world({ viewer: { ...world().viewer, familyTimezone: LOS_ANGELES } });
    const payload = await getToday(makePort(state), actorFor('adult', ADULT_ID, null), NOW);
    expect(payload.timezone).toBe(LOS_ANGELES);
    expect(payload.today).toBe('2026-08-19');
  });

  it('splits events into today and tomorrow by the caller local date', async () => {
    const state = world({
      events: [
        // 09:00 on the 19th in LA.
        event({ id: 'e1', title: 'Стоматолог', startsAt: new Date('2026-08-19T16:00:00.000Z') }),
        // 09:00 on the 20th in LA.
        event({ id: 'e2', title: 'Техосмотр', startsAt: new Date('2026-08-20T16:00:00.000Z') }),
      ],
    });
    const payload = await getToday(makePort(state), actorFor('adult', ADULT_ID, LOS_ANGELES), NOW);
    expect(payload.events.today.map((e) => e.id)).toEqual(['e1']);
    expect(payload.events.tomorrow.map((e) => e.id)).toEqual(['e2']);
  });
});

/* ========================================================================== */
/* Permissions: a child never sees finance data                               */
/* ========================================================================== */

describe('permission gating of the aggregate', () => {
  const stateWithMoney = () =>
    world({
      goals: [
        {
          goalId: GOAL_ID,
          goalTitle: 'Велосипед',
          currency: 'RUB',
          goalTarget: 3_000_000,
          deadline: '2026-12-01',
          saved: 1_240_000,
          milestoneId: MILESTONE_ID,
          milestoneTitle: 'Половина пути',
          milestoneTarget: 1_500_000,
          milestoneSortOrder: 0,
        },
      ],
      load: [{ userId: ADULT_ID, doneCount: 3, points: 15 }],
      members: [
        member({ id: ADULT_ID, displayName: 'Аня', role: 'adult' }),
        member({ id: CHILD_ID, displayName: 'Маша', role: 'child' }),
        member({ id: PENDING_ID, displayName: 'Дядя Коля', status: 'pending_approval' }),
      ],
    });

  it('resolves sections from the permission catalog, not from the role name', () => {
    expect(resolveAccess(actorFor('child', CHILD_ID)).goals).toBe(false);
    expect(resolveAccess(actorFor('teen', TEEN_ID)).goals).toBe(true);
    expect(resolveAccess(actorFor('adult', ADULT_ID)).goals).toBe(true);
    // Seeing the family load means reading everybody's tasks.
    expect(resolveAccess(actorFor('child', CHILD_ID)).fairness).toBe(false);
    expect(resolveAccess(actorFor('adult', ADULT_ID)).fairness).toBe(true);
    expect(resolveAccess(actorFor('adult', ADULT_ID)).approvals).toBe(false);
    expect(resolveAccess(actorFor('admin', ADMIN_ID)).approvals).toBe(true);
  });

  it("carries no goal or finance data in a child's payload", async () => {
    const state = stateWithMoney();
    const port = makePort(state);
    const payload = await getToday(port, actorFor('child', CHILD_ID), NOW);

    expect(payload.goals).toBeNull();
    expect(payload.fairness).toBeNull();
    expect(payload.pendingApprovals).toBeNull();

    // The strongest form of the assertion: nothing about the money is anywhere
    // in the serialized body, under any key.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Велосипед');
    expect(serialized).not.toContain('Половина пути');
    expect(serialized).not.toContain('1240000');
    expect(serialized).not.toContain('3000000');
    expect(serialized).not.toContain('nearestMilestone');
    expect(serialized).not.toContain('targetAmount');
    expect(serialized).not.toContain('savedAmount');
    expect(serialized).not.toContain('remainingAmount');
    expect(serialized).not.toContain(GOAL_ID);
    expect(serialized).not.toContain(MILESTONE_ID);
    expect(serialized).not.toContain('Дядя Коля');

    // And it was never fetched — the gate is upstream of the payload, so there
    // is no filtered version of the data anywhere in the process.
    expect(port.calls).not.toContain('loadGoals');
    expect(port.calls).not.toContain('loadLoad');
  });

  it('still gives the child their own tasks, events and shopping list', async () => {
    const state = stateWithMoney();
    state.tasks = [
      task({
        id: 'homework',
        title: 'Уроки',
        dueAt: new Date('2026-08-19T21:45:00.000Z'),
        assigneeId: CHILD_ID,
      }),
    ];
    state.shopping = {
      items: [
        {
          id: 'i1',
          listId: 'l1',
          listName: 'Продукты',
          name: 'Молоко',
          quantity: null,
          unit: null,
          requestedById: CHILD_ID,
          isUrgent: true,
        },
      ],
      neededCount: 4,
      urgentCount: 1,
    };
    const payload = await getToday(makePort(state), actorFor('child', CHILD_ID, MOSCOW), NOW);

    expect(payload.tasks.dueToday.map((t) => t.title)).toEqual(['Уроки']);
    expect(payload.shopping?.urgent.map((i) => i.name)).toEqual(['Молоко']);
    expect(payload.shopping?.neededCount).toBe(4);
  });

  it('gives an adult the goal tile and an admin the pending approvals', async () => {
    const state = stateWithMoney();
    const adult = await getToday(makePort(state), actorFor('adult', ADULT_ID, MOSCOW), NOW);
    expect(adult.goals?.nearestMilestone?.goalTitle).toBe('Велосипед');
    expect(adult.goals?.nearestMilestone?.remainingAmount).toBe(260_000);
    expect(adult.fairness?.me.doneCount).toBe(3);
    // An adult holds no `member:approve`; the section is not theirs to see.
    expect(adult.pendingApprovals).toBeNull();

    const admin = await getToday(makePort(state), actorFor('admin', ADMIN_ID, MOSCOW), NOW);
    expect(admin.pendingApprovals?.map((m) => m.displayName)).toEqual(['Дядя Коля']);
  });

  it('produces a payload that satisfies the published contract', async () => {
    const state = stateWithMoney();
    for (const actor of [actorFor('child', CHILD_ID), actorFor('admin', ADMIN_ID)]) {
      const payload = await getToday(makePort(state), actor, NOW);
      expect(() => todayResponseSchema.parse(payload)).not.toThrow();
    }
  });
});

/* ========================================================================== */
/* Overdue, milestones, fairness                                              */
/* ========================================================================== */

describe('derived task state', () => {
  it('treats overdue as a function of the clock plus the grace window', () => {
    const row = task({
      id: 't',
      title: 'Мусор',
      dueAt: new Date('2026-08-19T20:00:00.000Z'),
      graceMinutes: 60,
    });
    // 21:30Z is 90 minutes past the deadline but only 30 past the grace end.
    expect(overdueMinutes(row, NOW)).toBe(30);
    expect(overdueMinutes({ ...row, graceMinutes: 240 }, NOW)).toBe(0);
    // A finished task is never overdue, however late it was.
    expect(overdueMinutes({ ...row, status: 'done' }, NOW)).toBe(0);
  });

  it('puts an overdue task in exactly one bucket', async () => {
    const state = world({
      tasks: [
        task({ id: 'late', title: 'Мусор', dueAt: new Date('2026-08-19T18:00:00.000Z') }),
        task({ id: 'soon', title: 'Ужин', dueAt: new Date('2026-08-19T22:00:00.000Z') }),
        task({
          id: 'done',
          title: 'Посуда',
          dueAt: new Date('2026-08-19T21:10:00.000Z'),
          status: 'done',
          completedAt: new Date('2026-08-19T21:20:00.000Z'),
        }),
      ],
    });
    const payload = await getToday(makePort(state), actorFor('adult', ADULT_ID, MOSCOW), NOW);
    expect(payload.tasks.overdue.map((t) => t.id)).toEqual(['late']);
    expect(payload.tasks.dueToday.map((t) => t.id)).toEqual(['soon']);
    expect(payload.tasks.doneTodayCount).toBe(1);
  });
});

describe('nearest milestone', () => {
  const goal = (over: Partial<GoalRow> & Pick<GoalRow, 'goalId'>): GoalRow => ({
    goalTitle: 'Цель',
    currency: 'RUB',
    goalTarget: 1_000_000,
    deadline: null,
    saved: 0,
    milestoneId: null,
    milestoneTitle: null,
    milestoneTarget: null,
    milestoneSortOrder: 0,
    ...over,
  });

  it('picks the smallest remaining amount across goals and milestones', () => {
    const nearest = pickNearestMilestone([
      goal({
        goalId: 'a',
        saved: 100_000,
        milestoneId: 'm1',
        milestoneTitle: 'Первый шаг',
        milestoneTarget: 900_000,
      }),
      goal({ goalId: 'b', goalTarget: 500_000, saved: 480_000 }),
    ]);
    expect(nearest?.goalId).toBe('b');
    expect(nearest?.remainingAmount).toBe(20_000);
    // No milestone left => the goal's own target is what "осталось" means.
    expect(nearest?.milestoneId).toBeNull();
    expect(nearest?.progressPercent).toBe(96);
  });

  it('skips a milestone the balance has already passed', () => {
    const nearest = pickNearestMilestone([
      goal({
        goalId: 'a',
        saved: 900_000,
        milestoneId: 'm',
        milestoneTitle: 'Половина',
        milestoneTarget: 500_000,
      }),
    ]);
    expect(nearest).toBeNull();
  });

  it('breaks ties deterministically so the home screen does not flicker', () => {
    const rows = [
      goal({ goalId: 'zeta', goalTarget: 200_000, saved: 100_000 }),
      goal({ goalId: 'alpha', goalTarget: 200_000, saved: 100_000 }),
    ];
    expect(pickNearestMilestone(rows)?.goalId).toBe('alpha');
    expect(pickNearestMilestone([...rows].reverse())?.goalId).toBe('alpha');
  });
});

describe('fairness is a load bar, never a leaderboard (D5)', () => {
  it('orders members by name and never by score', () => {
    const members = [
      member({ id: TEEN_ID, displayName: 'Паша' }),
      member({ id: ADULT_ID, displayName: 'Аня' }),
      member({ id: CHILD_ID, displayName: 'Маша' }),
    ];
    const load: LoadRow[] = [
      { userId: TEEN_ID, doneCount: 9, points: 40 },
      { userId: ADULT_ID, doneCount: 1, points: 5 },
    ];
    const fairness = buildFairness({ userId: ADULT_ID, displayName: 'Аня' }, members, load, {
      weekStart: '2026-08-17',
      weekEnd: '2026-08-24',
    });

    expect(fairness.members.map((m) => m.displayName)).toEqual(['Аня', 'Маша', 'Паша']);
    expect(fairness.me.doneCount).toBe(1);
    // A member with no rows is 0, not missing — "не участвует" is data too.
    expect(fairness.members.find((m) => m.userId === CHILD_ID)?.doneCount).toBe(0);
    expect(fairness.members.find((m) => m.userId === TEEN_ID)?.sharePercent).toBe(90);
    expect(fairness.note).not.toMatch(/лучш|больше всех|меньше всех|рейтинг участник/i);
  });

  it('says something kind when nobody has done anything yet', () => {
    const fairness = buildFairness(
      { userId: ADULT_ID, displayName: 'Аня' },
      [member({ id: ADULT_ID, displayName: 'Аня' })],
      [],
      { weekStart: '2026-08-17', weekEnd: '2026-08-24' },
    );
    expect(fairness.me.sharePercent).toBe(0);
    expect(fairness.note).toContain('неделя только начинается');
  });
});

/* ========================================================================== */
/* Russian numeric agreement                                                  */
/* ========================================================================== */

describe('Russian pluralisation', () => {
  it('agrees for 1 / 2 / 5', () => {
    expect(countRu(1, RU_PLURALS.task)).toBe('1 задача');
    expect(countRu(2, RU_PLURALS.task)).toBe('2 задачи');
    expect(countRu(5, RU_PLURALS.task)).toBe('5 задач');
  });

  it('applies the 11–14 exception', () => {
    // The trap: these end in 1–4 but take the `many` form regardless.
    expect(countRu(11, RU_PLURALS.task)).toBe('11 задач');
    expect(countRu(12, RU_PLURALS.task)).toBe('12 задач');
    expect(countRu(13, RU_PLURALS.task)).toBe('13 задач');
    expect(countRu(14, RU_PLURALS.task)).toBe('14 задач');
    expect(countRu(15, RU_PLURALS.task)).toBe('15 задач');
  });

  it('goes back to the singular form at 21', () => {
    expect(countRu(21, RU_PLURALS.task)).toBe('21 задача');
    expect(countRu(22, RU_PLURALS.task)).toBe('22 задачи');
    expect(countRu(25, RU_PLURALS.task)).toBe('25 задач');
  });

  it('keeps the exception inside every hundred, not only the first', () => {
    expect(countRu(101, RU_PLURALS.task)).toBe('101 задача');
    expect(countRu(111, RU_PLURALS.task)).toBe('111 задач');
    expect(countRu(112, RU_PLURALS.task)).toBe('112 задач');
    expect(countRu(114, RU_PLURALS.task)).toBe('114 задач');
    expect(countRu(121, RU_PLURALS.task)).toBe('121 задача');
  });

  it('groups the count the same way the screen does', () => {
    // `countRu` used to interpolate the number bare while the PWA ran it
    // through `Intl.NumberFormat('ru-RU')`, so the same figure read
    // «1 000 задач» on the weekly screen and «1000 задач» in the push about it.
    // One formatter now; the separator is U+00A0 so a wrap cannot leave «000»
    // alone on a line.
    expect(countRu(1_011, RU_PLURALS.task)).toBe('1 011 задач');
    expect(countRu(1_000, RU_PLURALS.task)).toBe('1 000 задач');
    expect(countRu(999, RU_PLURALS.task)).toBe('999 задач');
  });

  it('handles zero and negatives without inventing a fourth form', () => {
    expect(countRu(0, RU_PLURALS.task)).toBe('0 задач');
    expect(pluralRu(-1, RU_PLURALS.task)).toBe('задача');
    expect(pluralRu(-11, RU_PLURALS.task)).toBe('задач');
  });

  it('agrees for the words the digest actually uses', () => {
    expect(countRu(3, RU_PLURALS.birthday)).toBe('3 дня рождения');
    expect(countRu(1, RU_PLURALS.birthday)).toBe('1 день рождения');
    expect(countRu(5, RU_PLURALS.birthday)).toBe('5 дней рождения');
    expect(countRu(2, RU_PLURALS.event)).toBe('2 события');
    expect(countRu(11, RU_PLURALS.point)).toBe('11 баллов');
    expect(countRu(21, RU_PLURALS.point)).toBe('21 балл');
    expect(countRu(12, RU_PLURALS.year)).toBe('12 лет');
    expect(countRu(21, RU_PLURALS.year)).toBe('21 год');
    // Indeclinable — and that is the correct Russian, not a bug.
    expect(countRu(5, RU_PLURALS.thanks)).toBe('5 спасибо');
  });
});

describe('Russian formatting helpers', () => {
  it('uses «во» before вторник and the accusative endings', () => {
    // 2026-08-18 is a Tuesday, 2026-08-19 a Wednesday, 2026-08-21 a Friday.
    expect(relativeDayRu('2026-08-17', '2026-08-17')).toBe('сегодня');
    expect(relativeDayRu('2026-08-18', '2026-08-17')).toBe('во вторник');
    expect(relativeDayRu('2026-08-19', '2026-08-17')).toBe('в среду');
    expect(relativeDayRu('2026-08-21', '2026-08-17')).toBe('в пятницу');
    expect(relativeDayRu('2026-08-23', '2026-08-17')).toBe('в воскресенье');
    // Past a week a weekday is ambiguous, so it falls back to a date.
    expect(relativeDayRu('2026-09-01', '2026-08-17')).toBe('1 сентября');
  });

  it('never says «завтра» — a digest is read days after it is written', () => {
    expect(relativeDayRu('2026-08-25', '2026-08-24')).toBe('во вторник');
  });

  it('renders money as integer minor units, never as a float', () => {
    // Groups and the symbol are separated by U+00A0, spelled out so this test
    // cannot pass or fail on an invisible character.
    expect(formatMoneyRu(1_240_000, 'RUB')).toBe(`12${NBSP}400${NBSP}₽`);
    expect(formatMoneyRu(50, 'RUB')).toBe(`0,50${NBSP}₽`);
    expect(formatMoneyRu(0, 'RUB')).toBe(`0${NBSP}₽`);
    expect(formatMoneyRu(123_456_789, 'RUB')).toBe(`1${NBSP}234${NBSP}567,89${NBSP}₽`);
    expect(formatMoneyRu(10_000, 'EUR')).toBe(`100${NBSP}EUR`);
  });
});

/* ========================================================================== */
/* Digest composition                                                         */
/* ========================================================================== */

function digestData(overrides: Partial<DigestData> = {}): DigestData {
  return {
    viewer: { displayName: 'Аня', currency: 'RUB', familyName: 'Семья' },
    timezone: MOSCOW,
    periodStart: '2026-08-24',
    periodEnd: '2026-08-31',
    members: [],
    myTasks: [],
    familyTasks: [],
    events: [],
    goals: null,
    goalContributed: null,
    shopping: null,
    wall: null,
    load: null,
    actorId: ADULT_ID,
    ...overrides,
  };
}

const ALL_SECTIONS: DigestSection[] = [
  'birthdays',
  'events',
  'tasks',
  'goals',
  'shopping',
  'wall',
  'points',
];

describe('digest composition', () => {
  it('writes the headline sentence the product asked for', () => {
    const data = digestData({
      members: [
        member({ id: CHILD_ID, displayName: 'Маша', birthDate: '2014-08-25' }),
        member({ id: TEEN_ID, displayName: 'Паша' }),
        member({ id: ADULT_ID, displayName: 'Аня', birthDate: '1988-08-26' }),
        member({ id: PENDING_ID, displayName: 'Дед', birthDate: '1955-08-27' }),
      ],
      events: [
        event({ id: 'e1', title: 'Техосмотр', startsAt: new Date('2026-08-25T06:00:00.000Z') }),
        event({
          id: 'e2',
          title: 'У Маши стоматолог',
          startsAt: new Date('2026-08-25T07:00:00.000Z'),
        }),
      ],
      familyTasks: [
        task({
          id: 'duty',
          title: 'Дежурство по кухне',
          dueAt: new Date('2026-08-25T18:00:00.000Z'),
          assigneeId: TEEN_ID,
        }),
      ],
    });
    // `birthdaysIn` sees `member.status === 'active'`, which the helper defaults to.
    const digest = composeDigest(data, ['birthdays', 'events', 'tasks'], NOW);

    expect(digest.summary).toBe(
      'На неделе: 3 дня рождения, техосмотр во вторник, у Маши стоматолог во вторник, ' +
        'дежурство по кухне — Паша.',
    );
    expect(digest.title).toBe('Неделя 24–30 августа');
    expect(digest.weekKey).toBe(isoWeekKey('2026-08-24'));
  });

  it('finds birthdays by month and day inside the window', () => {
    const members = [
      member({ id: CHILD_ID, displayName: 'Маша', birthDate: '2014-08-25' }),
      member({ id: TEEN_ID, displayName: 'Паша', birthDate: '2010-09-30' }),
      member({ id: ADMIN_ID, displayName: 'Спящий', birthDate: '1980-08-26', status: 'suspended' }),
    ];
    const found = birthdaysIn(members, '2026-08-24', '2026-08-31');
    expect(found).toHaveLength(1);
    expect(found[0]?.displayName).toBe('Маша');
    expect(found[0]?.date).toBe('2026-08-25');
    expect(found[0]?.turning).toBe(12);
  });

  it('says something friendly instead of emitting an empty heading', () => {
    const digest = composeDigest(digestData(), ALL_SECTIONS, NOW);

    expect(digest.blocks).toHaveLength(ALL_SECTIONS.length);
    for (const block of digest.blocks) {
      expect(block.isEmpty).toBe(true);
      // Never an empty section: exactly one human sentence.
      expect(block.lines).toHaveLength(1);
      expect(block.lines[0]?.length ?? 0).toBeGreaterThan(10);
      expect(block.lines[0]).toMatch(/[.!]$/);
    }

    expect(digest.summary).toBe('Неделя спокойная — ничего срочного не запланировано.');

    // The rendered text must not contain a heading with nothing under it.
    const text = digest.text;
    for (const block of digest.blocks) {
      expect(text).not.toContain(block.heading);
      expect(text).toContain(block.lines[0]);
    }
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('keeps headings once a section has content', () => {
    const data = digestData({
      members: [member({ id: CHILD_ID, displayName: 'Маша', birthDate: '2014-08-25' })],
    });
    const digest = composeDigest(data, ['birthdays', 'wall'], NOW);

    const birthdays = digest.blocks.find((b) => b.section === 'birthdays');
    const wall = digest.blocks.find((b) => b.section === 'wall');
    expect(birthdays?.isEmpty).toBe(false);
    expect(digest.text).toContain(birthdays?.heading);
    expect(digest.text).toContain('• Маша — во вторник, исполняется 12 лет');
    // The empty one degrades, in the same digest, without a heading.
    expect(wall?.isEmpty).toBe(true);
    expect(digest.text).not.toContain(wall?.heading);
  });

  it('renders correct agreement in a real block', () => {
    const digest = composeDigest(
      digestData({
        load: [
          { userId: ADULT_ID, doneCount: 21, points: 11 },
          { userId: TEEN_ID, doneCount: 1, points: 2 },
        ],
      }),
      ['points'],
      NOW,
    );
    const points = digest.blocks[0];
    expect(points?.lines[0]).toBe('Вы закрыли 21 задачу и набрали 11 баллов.');
    expect(points?.lines[1]).toBe('Вся семья за неделю — 22 задачи.');
  });

  it('drops an unknown section rather than crashing on a stale text[] row', () => {
    expect(sanitizeSections(['tasks', 'meal_plan', 'events'])).toEqual(['tasks', 'events']);
    expect(sanitizeSections(['nothing_valid'])).toEqual([...DEFAULT_DIGEST_SECTIONS]);
  });

  it('renders the plain-text digest without leading or trailing noise', () => {
    const digest = composeDigest(
      digestData({ wall: { announcements: 2, kudos: 5 } }),
      ['wall'],
      NOW,
    );
    expect(digest.text.startsWith('Неделя ')).toBe(true);
    expect(digest.text.endsWith('\n')).toBe(false);
    expect(digest.text).toContain('• 2 объявления на стене.');
    expect(digest.text).toContain('• 5 спасибо друг другу за неделю.');
    expect(renderDigestText(digest)).toBe(digest.text);
  });
});

/* ========================================================================== */
/* The send-once guarantee                                                    */
/* ========================================================================== */

describe('ISO week identity', () => {
  it('numbers the week by its Thursday, so a year boundary is one week', () => {
    // 2026-12-31 (Thu) and 2027-01-01 (Fri) are the same ISO week, 2026-W53.
    expect(isoWeekKey('2026-12-31')).toBe('2026-W53');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2027-01-04')).toBe('2027-W01');
    expect(isoWeekKey('2026-08-19')).toBe('2026-W34');
    // Every day of one week shares a key — the property the dedupe relies on.
    const keys = new Set(
      ['17', '18', '19', '20', '21', '22', '23'].map((d) => isoWeekKey(`2026-08-${d}`)),
    );
    expect(keys.size).toBe(1);
  });
});

describe('the digest slot arrives in the subscriber timezone', () => {
  const schedule = { enabled: true, weekday: 0, timeOfDay: '19:00', lastSentAt: null };

  it('resolves the slot as local wall clock, not a UTC hour', () => {
    // Sunday 2026-08-23, 19:00 local.
    expect(localSlotInstant('2026-08-23', '19:00', MOSCOW).toISOString()).toBe(
      '2026-08-23T16:00:00.000Z',
    );
    expect(localSlotInstant('2026-08-23', '19:00', LOS_ANGELES).toISOString()).toBe(
      '2026-08-24T02:00:00.000Z',
    );
  });

  it('is due for Moscow but not yet for Los Angeles at the same instant', () => {
    // 2026-08-23T17:00Z — 20:00 Sunday in Moscow, 10:00 Sunday in LA.
    const now = new Date('2026-08-23T17:00:00.000Z');
    expect(digestDueDecision({ schedule, timezone: MOSCOW, now }).due).toBe(true);
    const la = digestDueDecision({ schedule, timezone: LOS_ANGELES, now });
    expect(la.due).toBe(false);
    expect(la.reason).toBe('not_yet');
  });

  it('puts a Sunday digest at the end of its ISO week, not the start', () => {
    const now = new Date('2026-08-23T17:00:00.000Z');
    const decision = digestDueDecision({ schedule, timezone: MOSCOW, now });
    // 2026-08-23 is the Sunday of the week that began Monday 2026-08-17.
    expect(decision.weekKey).toBe(isoWeekKey('2026-08-17'));
    expect(decision.slotUtc.toISOString()).toBe('2026-08-23T16:00:00.000Z');
  });

  it('still sends a slot the worker slept through, but only within the week', () => {
    // Monday 03:00 Moscow, two days after a Saturday 19:00 slot.
    const saturday = { ...schedule, weekday: 6 };
    const late = digestDueDecision({
      schedule: saturday,
      timezone: MOSCOW,
      now: new Date('2026-08-23T20:00:00.000Z'),
    });
    expect(late.due).toBe(true);
    expect(late.reason).toBe('due');
  });

  it('refuses a subscriber who already had this week, and one who is disabled', () => {
    const now = new Date('2026-08-23T17:00:00.000Z');
    const sent = digestDueDecision({
      schedule: { ...schedule, lastSentAt: new Date('2026-08-19T10:00:00.000Z') },
      timezone: MOSCOW,
      now,
    });
    expect(sent.due).toBe(false);
    expect(sent.reason).toBe('already_sent');

    const off = digestDueDecision({
      schedule: { ...schedule, enabled: false },
      timezone: MOSCOW,
      now,
    });
    expect(off.reason).toBe('disabled');
  });
});

describe('the weekly digest is sent at most once per (user, week)', () => {
  function subscriber(over: Partial<DigestSubscriber> = {}): DigestSubscriber {
    return {
      userId: ADULT_ID,
      displayName: 'Аня',
      role: 'adult',
      permissionGrants: [],
      permissionDenies: [],
      userTimezone: MOSCOW,
      schedule: { enabled: true, weekday: 0, timeOfDay: '19:00', lastSentAt: null },
      sections: [...DEFAULT_DIGEST_SECTIONS],
      ...over,
    };
  }

  it('emits once however many times the hourly job runs', async () => {
    const state = world({ subscribers: [subscriber()] });
    const port = makePort(state);
    const intents = makeIntents();

    const first = await runWeeklyDigestSweep(
      port,
      intents,
      MOSCOW,
      new Date('2026-08-23T17:00:00.000Z'),
    );
    expect(first[0]?.sent).toBe(true);
    expect(intents.emitted).toHaveLength(1);
    expect(intents.emitted[0]).toBe(`weekly_digest:${ADULT_ID}:2026-W34`);

    // The next four hourly ticks, still inside the same ISO week.
    for (const hour of ['18', '19', '20', '23']) {
      await runWeeklyDigestSweep(port, intents, MOSCOW, new Date(`2026-08-23T${hour}:00:00.000Z`));
    }
    expect(intents.emitted).toHaveLength(1);
  });

  it('survives a lost lastSentAt — the dedupe key is the real guard', async () => {
    const sub = subscriber();
    const state = world({ subscribers: [sub] });
    const port = makePort(state);
    const intents = makeIntents();
    const now = new Date('2026-08-23T17:00:00.000Z');

    await runWeeklyDigestSweep(port, intents, MOSCOW, now);
    // Simulate a crash between the emit and the stamp, or a restored backup.
    sub.schedule.lastSentAt = null;
    const second = await runWeeklyDigestSweep(port, intents, MOSCOW, now);

    expect(intents.emitted).toHaveLength(1);
    expect(second[0]?.sent).toBe(false);
    expect(second[0]?.reason).toBe('raced');
  });

  it('sends again the following week', async () => {
    const state = world({ subscribers: [subscriber()] });
    const port = makePort(state);
    const intents = makeIntents();

    await runWeeklyDigestSweep(port, intents, MOSCOW, new Date('2026-08-23T17:00:00.000Z'));
    await runWeeklyDigestSweep(port, intents, MOSCOW, new Date('2026-08-30T17:00:00.000Z'));

    expect(intents.emitted).toEqual([
      `weekly_digest:${ADULT_ID}:2026-W34`,
      `weekly_digest:${ADULT_ID}:2026-W35`,
    ]);
  });

  it('buckets each subscriber into their own timezone', async () => {
    const state = world({
      subscribers: [
        subscriber({ userId: ADULT_ID, userTimezone: MOSCOW }),
        subscriber({ userId: TEEN_ID, displayName: 'Паша', userTimezone: LOS_ANGELES }),
      ],
    });
    const port = makePort(state);
    const intents = makeIntents();

    // 20:00 Sunday in Moscow, 10:00 Sunday in LA.
    await runWeeklyDigestSweep(port, intents, MOSCOW, new Date('2026-08-23T17:00:00.000Z'));
    expect(intents.emitted).toEqual([`weekly_digest:${ADULT_ID}:2026-W34`]);

    // Nine hours later it is 19:00 Sunday in LA.
    await runWeeklyDigestSweep(port, intents, MOSCOW, new Date('2026-08-24T02:00:00.000Z'));
    expect(intents.emitted).toEqual([
      `weekly_digest:${ADULT_ID}:2026-W34`,
      `weekly_digest:${TEEN_ID}:2026-W34`,
    ]);
  });

  it("never puts goal data in a child's digest, even if the row asks for it", async () => {
    const state = world({
      subscribers: [
        subscriber({
          userId: CHILD_ID,
          displayName: 'Маша',
          role: 'child',
          sections: ['tasks', 'goals', 'points'],
        }),
      ],
      goals: [
        {
          goalId: 'g',
          goalTitle: 'Велосипед',
          currency: 'RUB',
          goalTarget: 3_000_000,
          deadline: null,
          saved: 1_000_000,
          milestoneId: null,
          milestoneTitle: null,
          milestoneTarget: null,
          milestoneSortOrder: 0,
        },
      ],
    });
    const port = makePort(state);
    const intents = makeIntents();

    await runWeeklyDigestSweep(port, intents, MOSCOW, new Date('2026-08-23T17:00:00.000Z'));

    expect(intents.emitted).toHaveLength(1);
    expect(port.calls).not.toContain('loadGoals');
    expect(port.calls).not.toContain('loadLoad');
  });
});

/* ========================================================================== */
/* Week view                                                                  */
/* ========================================================================== */

describe('GET /dashboard/week', () => {
  it('buckets by local day and counts totals', async () => {
    const state = world({
      tasks: [
        task({ id: 't1', title: 'Мусор', dueAt: new Date('2026-08-20T06:00:00.000Z') }),
        task({ id: 't2', title: 'Уроки', dueAt: new Date('2026-08-21T06:00:00.000Z') }),
      ],
      events: [event({ id: 'e1', title: 'Кино', startsAt: new Date('2026-08-21T15:00:00.000Z') })],
    });
    const payload = await getWeek(
      makePort(state),
      actorFor('adult', ADULT_ID, MOSCOW),
      { from: undefined, days: 7 },
      NOW,
    );

    expect(payload.weekStart).toBe('2026-08-20');
    expect(payload.weekEnd).toBe('2026-08-27');
    expect(payload.days).toHaveLength(7);
    expect(payload.days[0]?.isToday).toBe(true);
    expect(payload.days[0]?.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(payload.days[1]?.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(payload.days[1]?.events.map((e) => e.id)).toEqual(['e1']);
    expect(payload.totals).toEqual({ tasks: 2, events: 1, overdue: 0 });
  });

  it('honours an explicit anchor date', async () => {
    const payload = await getWeek(
      makePort(world()),
      actorFor('adult', ADULT_ID, MOSCOW),
      { from: '2026-09-01', days: 3 },
      NOW,
    );
    expect(payload.days.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(payload.days.every((d) => !d.isToday)).toBe(true);
  });
});

/* ========================================================================== */
/* Declared route access (D4)                                                 */
/* ========================================================================== */

describe('route access declarations', () => {
  interface CollectedRoute {
    method: string;
    url: string;
    config: Record<string, unknown>;
  }

  let routes: CollectedRoute[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('auth', null);
    app.decorateRequest('scope', null);

    const collected: CollectedRoute[] = [];
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD') continue;
        collected.push({
          method,
          url: route.url,
          config: (route.config ?? {}) as Record<string, unknown>,
        });
      }
    });

    await app.register(dashboardRoutes);
    await app.ready();
    routes = collected;
  });

  it('registers exactly the documented route table', () => {
    const registered = Object.fromEntries(
      routes.map((r) => {
        const { authenticated, permission } = r.config as {
          authenticated?: boolean;
          permission?: Permission;
        };
        return [
          `${r.method} ${r.url}`,
          permission ? { permission } : { authenticated: authenticated === true },
        ];
      }),
    );
    expect(registered).toEqual(DASHBOARD_ROUTE_ACCESS);
  });

  it('declares access on every route and makes none of them public', () => {
    expect(routes).toHaveLength(3);
    for (const route of routes) {
      const config = route.config as {
        public?: boolean;
        authenticated?: boolean;
        permission?: string;
      };
      expect(config.public).not.toBe(true);
      // The boot assertion in `core/plugins/auth` demands exactly this.
      expect(config.authenticated === true || typeof config.permission === 'string').toBe(true);
    }
  });
});

/* ========================================================================== */
/* Against a real database                                                    */
/* ========================================================================== */

describe.skipIf(!TEST_DATABASE_URL)('dashboard queries against Postgres', () => {
  it('is left for the integration suite', () => {
    // The Postgres-shaped claims worth proving here — that the window functions
    // in `loadShopping` really count the whole matching set before LIMIT, and
    // that `markSent` really is a one-winner conditional update under
    // concurrency — need the schema migrated, which is the lead's `db:migrate`
    // step. Everything above is a pure function and runs without Docker.
    expect(TEST_DATABASE_URL).toBeTruthy();
  });
});
