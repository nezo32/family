import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { effectivePermissions, type Role } from '@family/shared';

import { buildAuthContext, type AuthContext } from '../../core/auth/context.js';
import { createDbClient, type Db, type Executor } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import type { UserRow } from '../identity/users.schema.js';
import {
  ACTIVITY_VERBS,
  ACTIVITY_VERB_RENDERERS,
  formatAmountRu,
  inferGender,
  renderActivitySummary,
  type ActivityVerb,
  type ActivityVerbPayloads,
} from './activity.service.js';
import {
  addComment,
  assertCanReadEntity,
  assertEntityType,
  deleteComment,
  deleteCommentsFor,
  listCommentsFor,
} from './comments.service.js';
import {
  assertPollOpen,
  castVote,
  computePollResults,
  isPollClosed,
  resolveVoteWrite,
} from './polls.service.js';
import * as choresRepo from '../chores/chores.repository.js';
import * as repo from './wall.repository.js';
import type { PollOptionRow, PollRow } from './wall.schema.js';
import { hydratePosts, isUniqueViolation, mergeStreams, setPin } from './wall.service.js';

/**
 * The wall's business rules.
 *
 * Everything that can be decided without a database — permission checks, the
 * Russian renderer, poll result computation, cursor maths — is tested as pure
 * logic. The handful of rules that genuinely live in Postgres (`FOR UPDATE`,
 * the kudos unique index, soft-delete visibility) are behind
 * `TEST_DATABASE_URL` so `pnpm test` stays runnable without Docker.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

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

/** Permission checks run before any query, so these never touch the handle. */
const noDb = null as unknown as Db;

function pollRow(overrides: Partial<PollRow> = {}): PollRow {
  return {
    id: randomUUID(),
    question: 'Куда поедем на выходных?',
    closesAt: null,
    allowMultiple: false,
    createdById: randomUUID(),
    closedAt: null,
    createdAt: new Date('2026-08-19T10:00:00.000Z'),
    ...overrides,
  };
}

function optionRow(pollId: string, label: string, sortOrder: number): PollOptionRow {
  return { id: randomUUID(), pollId, label, sortOrder };
}

/* -------------------------------------------------------------------------- */
/* Polymorphic entity types                                                    */
/* -------------------------------------------------------------------------- */

describe('entityType validation', () => {
  it('accepts every type in the closed enum', () => {
    for (const type of ['post', 'task', 'event', 'goal', 'poll'] as const) {
      expect(assertEntityType(type)).toBe(type);
    }
  });

  it('rejects an unknown entityType with BAD_REQUEST rather than writing it', () => {
    expect(() => assertEntityType('recipe')).toThrowError(AppError);
    try {
      assertEntityType('recipe');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(AppError.isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe('BAD_REQUEST');
      expect((error as AppError).statusCode).toBe(400);
    }
  });

  it('rejects an unknown entityType in the delete hook too', async () => {
    await expect(deleteCommentsFor(noDb, 'recipe', randomUUID())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('refuses to comment on an unknown entityType before any permission check', async () => {
    await expect(
      addComment(noDb, authFor('adult'), { entityType: 'chore', entityId: randomUUID() }, { body: 'привет' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe('wall permissions (D4)', () => {
  it('lets a child vote and comment but not pin or author polls', () => {
    const child = effectivePermissions('child');
    expect(child).toContain('poll:vote');
    expect(child).toContain('comment:create');
    expect(child).toContain('kudos:give');
    expect(child).toContain('post:create');
    expect(child).not.toContain('post:pin');
    expect(child).not.toContain('poll:create');
    expect(child).not.toContain('poll:close');
    expect(child).not.toContain('comment:delete:any');
  });

  it('refuses a child pinning a post with 403 before touching the database', async () => {
    await expect(setPin(noDb, authFor('child'), randomUUID(), null)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('refuses a guest commenting', async () => {
    await expect(
      addComment(noDb, authFor('guest'), { entityType: 'post', entityId: randomUUID() }, { body: 'ой' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses deleting a comment without any comment:delete scope', async () => {
    await expect(deleteComment(noDb, authFor('guest'), randomUUID())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('gives teens authoring and closing rights, adults the moderator override', () => {
    const teen = effectivePermissions('teen');
    expect(teen).toContain('poll:create');
    expect(teen).toContain('poll:close');
    expect(teen).not.toContain('post:delete:any');
    expect(effectivePermissions('adult')).toContain('post:delete:any');
    expect(effectivePermissions('adult')).toContain('post:pin');
  });

  it('honours a per-user deny over the role matrix', () => {
    const mutedTeen = authFor('teen', { permissionDenies: ['comment:create'] });
    expect(mutedTeen.can('comment:create')).toBe(false);
    expect(mutedTeen.can('poll:vote')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Comments inherit the target's visibility                                    */
/* -------------------------------------------------------------------------- */

/**
 * A stub executor that answers one `select(...).from(...).where(...).limit(1)`
 * with the row it was given. `assertCanReadEntity` runs exactly that query and
 * then decides, so this is enough to test the decision without Postgres.
 */
const execReturning = (rows: readonly Record<string, unknown>[]): Executor =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  }) as unknown as Executor;

describe('a comment on a private goal is exactly as private as the goal', () => {
  const OWNER_ID = randomUUID();
  const goalRef = { entityType: 'goal', entityId: randomUUID() } as const;
  const privateGoal = { visibility: 'private', ownerId: OWNER_ID };
  const familyGoal = { visibility: 'household', ownerId: null };

  const canRead = async (
    auth: AuthContext,
    row: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await assertCanReadEntity(execReturning([row]), goalRef, auth);
      return true;
    } catch (error) {
      // 404, never 403: confirming that a private goal exists is itself the leak
      // (D4). Anything else is a real failure and should surface.
      expect((error as AppError).code).toBe('NOT_FOUND');
      return false;
    }
  };

  it('lets the goal owner read their own private goal', async () => {
    expect(await canRead(authFor('adult', { id: OWNER_ID }), privateGoal)).toBe(true);
  });

  it('hides it from another adult, who holds every goal permission but `:any`', async () => {
    expect(await canRead(authFor('adult'), privateGoal)).toBe(false);
    expect(await canRead(authFor('adult'), familyGoal)).toBe(true);
  });

  it('hides it from a child, who holds no goal permission at all', async () => {
    expect(await canRead(authFor('child'), privateGoal)).toBe(false);
    expect(await canRead(authFor('child'), familyGoal)).toBe(false);
  });

  it('shows it to an admin, who holds `goal:read:any`', async () => {
    expect(await canRead(authFor('admin'), privateGoal)).toBe(true);
  });

  /**
   * The regression this describe exists for.
   *
   * The resolver used to end in `auth.role === 'owner' || auth.role === 'admin'`,
   * which reads straight past `permission_denies`: an admin explicitly denied
   * `goal:read` could not open a single goal, and could still read every comment
   * on every private one. A role string is not a permission (D4).
   */
  it('respects a permission deny on an admin — the role is not the permission', async () => {
    const denied = authFor('admin', { permissionDenies: ['goal:read'] });
    expect(denied.role).toBe('admin');
    expect(denied.can('goal:read')).toBe(false);

    expect(await canRead(denied, privateGoal)).toBe(false);
    expect(await canRead(denied, familyGoal)).toBe(false);
  });

  it('respects a deny of `goal:read:any` alone', async () => {
    // Still holds `goal:read`, so household goals stay readable — only the
    // "administers the family" half is gone.
    const denied = authFor('owner', { permissionDenies: ['goal:read:any'] });
    expect(await canRead(denied, privateGoal)).toBe(false);
    expect(await canRead(denied, familyGoal)).toBe(true);
  });

  it('404s a goal that does not exist, for a caller who could have read it', async () => {
    await expect(
      assertCanReadEntity(execReturning([]), goalRef, authFor('owner')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/* -------------------------------------------------------------------------- */
/* Polls — pure rules                                                          */
/* -------------------------------------------------------------------------- */

describe('poll closure', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('treats a manually closed poll as closed', () => {
    expect(isPollClosed(pollRow({ closedAt: new Date('2026-08-18T00:00:00.000Z') }), now)).toBe(true);
  });

  it('treats a passed deadline as closed without waiting for the sweeper', () => {
    expect(isPollClosed(pollRow({ closesAt: new Date('2026-08-19T11:59:59.000Z') }), now)).toBe(true);
  });

  it('keeps a future deadline open', () => {
    expect(isPollClosed(pollRow({ closesAt: new Date('2026-08-19T12:00:01.000Z') }), now)).toBe(false);
  });

  it('refuses a vote on a closed poll with CONFLICT (409), not 403', () => {
    try {
      assertPollOpen(pollRow({ closedAt: new Date('2026-08-01T00:00:00.000Z') }), now);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('CONFLICT');
      expect((error as AppError).statusCode).toBe(409);
    }
  });

  it('refuses a vote after closesAt', () => {
    expect(() => assertPollOpen(pollRow({ closesAt: new Date('2026-08-19T09:00:00.000Z') }), now)).toThrowError(
      AppError,
    );
  });
});

describe('ballot validation', () => {
  const valid = new Set(['a', 'b', 'c']);

  it('rejects a second option on a single-choice poll', () => {
    try {
      resolveVoteWrite({ allowMultiple: false }, ['a', 'b'], valid);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('BAD_REQUEST');
    }
  });

  it('accepts several options on a multi-choice poll and de-duplicates them', () => {
    const write = resolveVoteWrite({ allowMultiple: true }, ['a', 'b', 'a'], valid);
    expect(write.optionIds).toEqual(['a', 'b']);
    expect(write.replacePrevious).toBe(true);
  });

  it('always replaces the previous selection rather than adding to it', () => {
    expect(resolveVoteWrite({ allowMultiple: false }, ['c'], valid).replacePrevious).toBe(true);
  });

  it('rejects an option belonging to another poll', () => {
    expect(() => resolveVoteWrite({ allowMultiple: false }, ['z'], valid)).toThrowError(AppError);
  });

  it('rejects an empty ballot', () => {
    expect(() => resolveVoteWrite({ allowMultiple: true }, [], valid)).toThrowError(AppError);
  });
});

describe('poll results are computed, never stored', () => {
  const poll = pollRow();
  const sea = optionRow(poll.id, 'Море', 0);
  const hills = optionRow(poll.id, 'Горы', 1);
  const me = randomUUID();
  const other = randomUUID();

  it('counts distinct voters, not votes', () => {
    const result = computePollResults(
      poll,
      [sea, hills],
      [
        { pollId: poll.id, optionId: sea.id, userId: me },
        { pollId: poll.id, optionId: hills.id, userId: me },
        { pollId: poll.id, optionId: sea.id, userId: other },
      ],
      me,
    );
    expect(result.totalVoters).toBe(2);
    expect(result.options[0]?.voteCount).toBe(2);
    expect(result.options[1]?.voteCount).toBe(1);
    expect(result.myOptionIds).toEqual([sea.id, hills.id]);
  });

  it('returns zeroed options for a poll nobody answered', () => {
    const result = computePollResults(poll, [sea, hills], [], me);
    expect(result.totalVoters).toBe(0);
    expect(result.options.map((o) => o.voteCount)).toEqual([0, 0]);
    expect(result.myOptionIds).toEqual([]);
  });

  it('ignores votes belonging to a different poll', () => {
    const result = computePollResults(
      poll,
      [sea, hills],
      [{ pollId: randomUUID(), optionId: sea.id, userId: other }],
      me,
    );
    expect(result.totalVoters).toBe(0);
  });

  it('keeps options in their declared order', () => {
    const result = computePollResults(poll, [hills, sea], [], me);
    expect(result.options.map((o) => o.label)).toEqual(['Море', 'Горы']);
  });
});

/* -------------------------------------------------------------------------- */
/* The Russian activity renderer                                               */
/* -------------------------------------------------------------------------- */

/** One representative payload per verb, so the catalogue is covered exhaustively. */
const SAMPLE_PAYLOADS: { [V in ActivityVerb]: ActivityVerbPayloads[V] } = {
  'task.completed': { title: 'Вынести мусор' },
  'task.created': { title: 'Помыть окна' },
  'task.assigned': { title: 'Пропылесосить', assigneeName: 'Маша' },
  'task.swapped': { title: 'Мыть посуду', toName: 'Маша' },
  'event.created': { title: 'День рождения бабушки' },
  'event.cancelled': { title: 'Поход в кино' },
  'goal.created': { title: 'Велосипед' },
  'goal.contributed': { title: 'Велосипед', amountMinor: 150000 },
  'goal.milestone.reached': { title: 'Велосипед', milestone: 'Половина пути' },
  'goal.reached': { title: 'Велосипед' },
  'shopping.bought': { item: 'Молоко', listTitle: 'Продукты' },
  'shopping.list.created': { title: 'Дача' },
  'post.created': { title: 'Субботник в воскресенье' },
  'post.pinned': { title: 'Субботник в воскресенье' },
  'comment.added': { entityType: 'task', entityTitle: 'Вынести мусор' },
  'poll.created': { question: 'Куда поедем?' },
  'poll.closed': { question: 'Куда поедем?' },
  'kudos.given': { toName: 'Маша', emoji: '👏' },
  'member.approved': { memberName: 'Маша' },
  'member.joined': {},
};

describe('Russian activity renderer', () => {
  it('covers every verb in the catalogue', () => {
    expect(Object.keys(SAMPLE_PAYLOADS).sort()).toEqual([...ACTIVITY_VERBS].sort());
    expect(ACTIVITY_VERBS.length).toBe(Object.keys(ACTIVITY_VERB_RENDERERS).length);
  });

  for (const verb of ACTIVITY_VERBS) {
    it(`renders a grammatical sentence for ${verb}`, () => {
      const payload = SAMPLE_PAYLOADS[verb];
      for (const actor of [
        { name: 'Паша' },
        { name: 'Маша' },
        { name: 'Саша' },
        { name: null },
      ]) {
        const summary = renderActivitySummary(verb, actor, payload);
        expect(summary.length).toBeGreaterThan(0);
        // A sentence, not a fragment: starts with a capital, no stray spacing,
        // no unresolved placeholder, no double punctuation.
        expect(summary).toBe(summary.trim());
        expect(summary).not.toMatch(/\s{2}/);
        expect(summary).not.toMatch(/undefined|null|\$\{/);
        expect(summary).not.toMatch(/,\s*,|—\s*—/);
        expect(summary.slice(0, 1)).toBe(summary.slice(0, 1).toLocaleUpperCase('ru-RU'));
      }
    });
  }

  it('agrees with a masculine name in the past tense', () => {
    expect(renderActivitySummary('task.completed', { name: 'Паша' }, { title: 'Вынести мусор' })).toBe(
      'Паша выполнил задачу „Вынести мусор“',
    );
  });

  it('agrees with a feminine name in the past tense', () => {
    expect(renderActivitySummary('task.completed', { name: 'Маша' }, { title: 'Вынести мусор' })).toBe(
      'Маша выполнила задачу „Вынести мусор“',
    );
  });

  it('falls back to a gender-free phrasing when the name is ambiguous', () => {
    expect(renderActivitySummary('task.completed', { name: 'Саша' }, { title: 'Вынести мусор' })).toBe(
      'Задача „Вынести мусор“ выполнена — Саша',
    );
  });

  it('drops the actor entirely for a system-generated event', () => {
    expect(renderActivitySummary('task.completed', { name: null }, { title: 'Вынести мусор' })).toBe(
      'Задача „Вынести мусор“ выполнена',
    );
  });

  it('honours an explicit gender over the heuristic', () => {
    expect(
      renderActivitySummary('member.joined', { name: 'Саша', gender: 'f' }, {}),
    ).toBe('Саша присоединилась к семье');
  });

  it('never inflects a second name — both stay in the nominative', () => {
    expect(renderActivitySummary('kudos.given', { name: 'Паша' }, { toName: 'Маша', emoji: '👏' })).toBe(
      'Благодарность 👏: Паша → Маша',
    );
    expect(
      renderActivitySummary('task.assigned', { name: 'Маша' }, { title: 'Мусор', assigneeName: 'Паша' }),
    ).toBe('Маша назначила задачу „Мусор“, исполнитель: Паша');
  });

  it('formats money as integer minor units in roubles (D6)', () => {
    // Digit grouping and the currency sign use a non-breaking space: the amount
    // must never wrap in the middle in the feed.
    expect(formatAmountRu(150000)).toBe('1 500,00 ₽');
    expect(formatAmountRu(5)).toBe('0,05 ₽');
    expect(formatAmountRu(123456789)).toBe('1 234 567,89 ₽');
    expect(
      renderActivitySummary('goal.contributed', { name: 'Паша' }, { title: 'Велосипед', amountMinor: 100000 }),
    ).toBe('Паша пополнил цель „Велосипед“ на 1 000,00 ₽');
  });

  describe('gender inference', () => {
    it('reads common feminine names', () => {
      for (const name of ['Маша', 'Оля', 'Настя', 'Мама', 'Бабушка']) {
        expect(inferGender(name)).toBe('f');
      }
    });

    it('reads masculine names, including diminutives ending in -а/-я', () => {
      for (const name of ['Паша', 'Миша', 'Никита', 'Илья', 'Папа', 'Игорь'.slice(0, 4), 'Иван']) {
        expect(inferGender(name)).not.toBe('f');
      }
      expect(inferGender('Паша')).toBe('m');
      expect(inferGender('Никита')).toBe('m');
      expect(inferGender('Иван')).toBe('m');
    });

    it('refuses to guess on genuinely ambiguous names', () => {
      for (const name of ['Саша', 'Женя', 'Валя']) {
        expect(inferGender(name)).toBe('unknown');
      }
      expect(inferGender(null)).toBe('unknown');
      expect(inferGender('')).toBe('unknown');
    });

    it('uses only the first token of a full name', () => {
      expect(inferGender('Маша Иванова')).toBe('f');
      expect(inferGender('Паша Иванов')).toBe('m');
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Repository pure helpers                                                     */
/* -------------------------------------------------------------------------- */

describe('cursor pagination', () => {
  const row = { id: randomUUID(), createdAt: new Date('2026-08-19T10:00:00.000Z') };

  it('round-trips a cursor', () => {
    const decoded = repo.decodeCursor(repo.encodeCursor(row));
    expect(decoded?.id).toBe(row.id);
    expect(decoded?.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  /**
   * The wall used to answer a stale cursor with `400 Malformed cursor` while
   * events, goals and notifications quietly restarted at page one — same
   * bookmarked page-2 link, three different outcomes. `core/pagination.ts` is
   * forgiving everywhere now: a cursor is a token we issued, and a redeploy
   * that changes the encoding is not the user doing something wrong.
   */
  it.each([
    ['junk', 'not-a-cursor'],
    ['the old `iso|id` encoding', Buffer.from('2026-08-19T10:00:00.000Z|abc').toString('base64url')],
    ['valid base64 that is not a cursor', Buffer.from('{"nope":1}').toString('base64url')],
    ['an empty string', ''],
  ])('restarts pagination on %s instead of throwing', (_label, raw) => {
    expect(repo.decodeCursor(raw)).toBeUndefined();
  });

  it('returns no cursor when the page is not full', () => {
    expect(repo.toPage([row], 10)).toEqual({ items: [row], nextCursor: null });
  });

  it('trims the over-fetched row and emits a cursor', () => {
    const second = { id: randomUUID(), createdAt: new Date('2026-08-19T09:00:00.000Z') };
    const page = repo.toPage([row, second], 1);
    expect(page.items).toEqual([row]);
    expect(page.nextCursor).not.toBeNull();
    expect(repo.decodeCursor(page.nextCursor as string)?.id).toBe(row.id);
  });

  /** Every module's codec is the same codec now — this is the proof. */
  it('is byte-for-byte the same encoding the chores ledger uses', () => {
    expect(repo.encodeCursor(row)).toBe(choresRepo.encodeCursor(row));
    expect(choresRepo.decodeCursor(repo.encodeCursor(row))?.id).toBe(row.id);
  });
});

describe('reaction summaries', () => {
  const entityId = randomUUID();
  const me = randomUUID();
  const other = randomUUID();

  it('groups by emoji, counts, and flags the viewer', () => {
    const summaries = repo.buildReactionSummaries(
      [
        { entityId, emoji: '👏', userId: me },
        { entityId, emoji: '👏', userId: other },
        { entityId, emoji: '❤️', userId: other },
      ],
      me,
    );
    const list = summaries.get(entityId) ?? [];
    expect(list[0]).toEqual({ emoji: '👏', count: 2, reacted: true });
    expect(list[1]).toEqual({ emoji: '❤️', count: 1, reacted: false });
  });

  it('yields nothing for an entity with no reactions', () => {
    expect(repo.buildReactionSummaries([], me).get(entityId)).toBeUndefined();
  });
});

describe('comment counts stay consistent with soft deletes', () => {
  it('reads zero for an entity whose comments are all deleted', () => {
    // The grouped query filters `deleted_at is null`, so a fully soft-deleted
    // thread returns no row at all — the counter must read 0, never NaN.
    const counts = new Map<string, number>();
    expect(repo.commentCountOf(counts, randomUUID())).toBe(0);
    const withRows = new Map([['a', 3]]);
    expect(repo.commentCountOf(withRows, 'a')).toBe(3);
  });
});

describe('feed merge', () => {
  it('interleaves posts and activity strictly by (createdAt, id) descending', () => {
    const merged = mergeStreams(
      [
        { id: 'p2', createdAt: new Date('2026-08-19T10:00:00.000Z'), kind: 'post' },
        { id: 'p1', createdAt: new Date('2026-08-19T08:00:00.000Z'), kind: 'post' },
      ],
      [
        { id: 'a2', createdAt: new Date('2026-08-19T09:00:00.000Z'), kind: 'activity' },
        { id: 'a1', createdAt: new Date('2026-08-19T07:00:00.000Z'), kind: 'activity' },
      ],
    );
    expect(merged.map((m) => m.id)).toEqual(['p2', 'a2', 'p1', 'a1']);
  });

  it('breaks a timestamp tie deterministically by id', () => {
    const at = new Date('2026-08-19T10:00:00.000Z');
    const merged = mergeStreams(
      [{ id: 'aaa', createdAt: at, kind: 'post' }],
      [{ id: 'bbb', createdAt: at, kind: 'activity' }],
    );
    expect(merged.map((m) => m.id)).toEqual(['bbb', 'aaa']);
  });
});

describe('kudos uniqueness mapping', () => {
  it('recognises a Postgres unique violation', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Route wiring                                                                */
/* -------------------------------------------------------------------------- */

describe('route registration', () => {
  it('registers every route with an access declaration and no path conflicts', async () => {
    const { buildApp } = await import('../../app.js');

    const app = await buildApp();
    // `onReady` in core/plugins/auth.ts throws if any route declares neither a
    // permission guard nor `public: true` (D4 deny-by-default), and find-my-way
    // throws on a duplicate path — so a clean `ready()` proves both.
    await app.ready();

    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/api/wall/feed');
    expect(routes).toContain('/api/activity');
    expect(routes).toContain('comments');
    await app.close();
  });

  it('answers 401 rather than 403 to an unauthenticated caller', async () => {
    const { buildApp } = await import('../../app.js');

    const app = await buildApp();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/wall/posts' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Database-backed rules                                                       */
/* -------------------------------------------------------------------------- */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('wall (database)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let adult: AuthContext;
  let child: AuthContext;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const { sql, db: handle } = createDbClient(TEST_DATABASE_URL);
    db = handle;
    close = async () => {
      await sql.end({ timeout: 5 });
    };

    const { users } = await import('../identity/users.schema.js');
    const rows = await db
      .insert(users)
      .values([
        { displayName: 'Паша', role: 'adult', status: 'active' },
        { displayName: 'Маша', role: 'child', status: 'active' },
      ])
      .returning();
    const [adultRow, childRow] = rows;
    if (!adultRow || !childRow) throw new Error('fixture users were not created');
    createdUserIds.push(adultRow.id, childRow.id);
    adult = buildAuthContext(adultRow);
    child = buildAuthContext(childRow);
  });

  afterAll(async () => {
    if (close) await close();
  });

  it('replaces the previous vote in a single-choice poll', async () => {
    const poll = await repo.insertPoll(db, {
      question: 'Куда поедем?',
      allowMultiple: false,
      createdById: adult.userId,
    });
    const [sea, hills] = await repo.insertPollOptions(db, poll.id, ['Море', 'Горы']);
    if (!sea || !hills) throw new Error('options were not created');

    await castVote(db, child, poll.id, { optionIds: [sea.id] });
    const second = await castVote(db, child, poll.id, { optionIds: [hills.id] });

    expect(second.totalVoters).toBe(1);
    expect(second.myOptionIds).toEqual([hills.id]);
    expect(second.options.find((o) => o.id === sea.id)?.voteCount).toBe(0);
    expect(second.options.find((o) => o.id === hills.id)?.voteCount).toBe(1);

    await expect(castVote(db, child, poll.id, { optionIds: [sea.id, hills.id] })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );

    await repo.deletePoll(db, poll.id);
  });

  it('refuses a vote on a closed poll', async () => {
    const poll = await repo.insertPoll(db, {
      question: 'Уже поздно?',
      allowMultiple: false,
      createdById: adult.userId,
      closesAt: new Date(Date.now() - 60_000),
    });
    const [only] = await repo.insertPollOptions(db, poll.id, ['Да', 'Нет']);
    if (!only) throw new Error('options were not created');

    await expect(castVote(db, child, poll.id, { optionIds: [only.id] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await repo.deletePoll(db, poll.id);
  });

  it('hides soft-deleted comments from the feed while keeping counts consistent', async () => {
    const post = await repo.insertPost(db, {
      authorId: adult.userId,
      type: 'announcement',
      body: 'Субботник в воскресенье',
      title: 'Субботник',
    });

    const first = await addComment(db, adult, { entityType: 'post', entityId: post.id }, { body: 'Иду' });
    await addComment(db, child, { entityType: 'post', entityId: post.id }, { body: 'И я' });

    let hydrated = await hydratePosts(db, [post], adult.userId);
    expect(hydrated[0]?.commentCount).toBe(2);

    await deleteComment(db, adult, first.id);

    const listed = await listCommentsFor(
      db,
      adult,
      { entityType: 'post', entityId: post.id },
      { limit: 50 },
    );
    expect(listed.items.map((c) => c.id)).not.toContain(first.id);
    expect(listed.items).toHaveLength(1);

    hydrated = await hydratePosts(db, [post], adult.userId);
    expect(hydrated[0]?.commentCount).toBe(1);

    // The delete hook takes the rest with it.
    const cleaned = await deleteCommentsFor(db, 'post', post.id);
    expect(cleaned.comments).toBe(1);
    hydrated = await hydratePosts(db, [post], adult.userId);
    expect(hydrated[0]?.commentCount).toBe(0);

    await repo.softDeletePost(db, post.id);
  });

  it('keeps kudos unique per (fromUser, occurrence, emoji)', async () => {
    const { sql } = await import('drizzle-orm');
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'kudos_from_occurrence_emoji_uq'`,
    );
    const definition = rows[0]?.indexdef ?? '';
    expect(definition).toContain('UNIQUE');
    expect(definition).toContain('from_user_id');
    expect(definition).toContain('occurrence_id');
    expect(definition).toContain('emoji');
  });
});
