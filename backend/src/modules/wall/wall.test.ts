import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COMMENTABLE_ENTITY_TYPES,
  REACTABLE_ENTITY_TYPES,
  effectivePermissions,
  type Role,
} from '@family/shared';

import { buildAuthContext, type AuthContext } from '../../core/auth/context.js';
import { createDbClient, type Db, type Executor } from '../../core/db.js';
import { domainsForRoute } from '../../core/plugins/revisions.js';
import { collectRouteAccess } from '../../test/access.js';
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
  assertReactableEntityType,
  deleteComment,
  deleteCommentsFor,
  getReactionSummary,
  listCommentsFor,
  toggleReaction,
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
import {
  clearWall,
  formatDayMonthRu,
  getWallFeed,
  giveKudos,
  listActivity,
  hydratePosts,
  isUniqueViolation,
  mergeStreams,
  restoreWall,
  setPin,
  wallClearedBody,
} from './wall.service.js';

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
    // Iterated from the contract rather than re-listed, so a new member —
    // `kudos` was the last one (§D7.6) — cannot be added without this and the
    // access resolver below noticing.
    for (const type of COMMENTABLE_ENTITY_TYPES) {
      expect(assertEntityType(type)).toBe(type);
    }
  });

  it('has an access resolver for every commentable type', async () => {
    // `assertCanReadEntity` throws BAD_REQUEST when a type has no resolver, so
    // a member added to the enum and nowhere else fails loudly here rather
    // than at runtime on somebody's phone.
    for (const type of COMMENTABLE_ENTITY_TYPES) {
      // The stub cannot satisfy every resolver's query shape (some join), so
      // the assertion is about the *lookup*, not the verdict: an unregistered
      // type is the only thing that produces this particular message.
      const outcome: unknown = await assertCanReadEntity(
        execReturning([]),
        { entityType: type, entityId: randomUUID() },
        authFor('owner'),
      ).catch((error: unknown) => error);
      expect(String((outcome as Error | undefined)?.message ?? '')).not.toContain(
        'No access resolver',
      );
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
      addComment(
        noDb,
        authFor('adult'),
        { entityType: 'chore', entityId: randomUUID() },
        { body: 'привет' },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/* -------------------------------------------------------------------------- */
/* Reactions on comments — and the thread-on-a-thread we refuse                */
/* -------------------------------------------------------------------------- */

describe('the reactable set is wider than the commentable one, deliberately', () => {
  it('is the commentable set plus `comment`, and nothing else', () => {
    for (const type of COMMENTABLE_ENTITY_TYPES) {
      expect(REACTABLE_ENTITY_TYPES as readonly string[]).toContain(type);
      expect(assertReactableEntityType(type)).toBe(type);
    }
    expect(assertReactableEntityType('comment')).toBe('comment');
    expect(REACTABLE_ENTITY_TYPES).toHaveLength(COMMENTABLE_ENTITY_TYPES.length + 1);
  });

  it('has an access resolver for `comment` as well', async () => {
    const outcome: unknown = await assertCanReadEntity(
      execReturning([]),
      { entityType: 'comment', entityId: randomUUID() },
      authFor('owner'),
    ).catch((error: unknown) => error);
    expect(String((outcome as Error | undefined)?.message ?? '')).not.toContain(
      'No access resolver',
    );
  });

  /**
   * The point of keeping two enums. A comment is a reaction target and is
   * **not** a comment target: Стена's discussion is a flat list under a card
   * (§D7), and nested threads are a different product with their own depth
   * limit, indentation and moderation rules. Widening one enum would have
   * enabled them silently.
   */
  it('still refuses a comment on a comment, at the entity-type boundary', () => {
    expect(() => assertEntityType('comment')).toThrowError(AppError);
    try {
      assertEntityType('comment');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('BAD_REQUEST');
    }
  });

  it('refuses to write a comment addressed to a comment', async () => {
    await expect(
      addComment(
        noDb,
        authFor('adult'),
        { entityType: 'comment', entityId: randomUUID() },
        { body: 'ответ на ответ' },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses to list comments addressed to a comment', async () => {
    await expect(
      listCommentsFor(
        noDb,
        authFor('adult'),
        { entityType: 'comment', entityId: randomUUID() },
        { limit: 20 },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a reaction on a type in neither set', async () => {
    await expect(
      toggleReaction(
        noDb,
        authFor('adult'),
        { entityType: 'recipe', entityId: randomUUID() },
        { emoji: '❤️' },
      ),
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
      addComment(
        noDb,
        authFor('guest'),
        { entityType: 'post', entityId: randomUUID() },
        { body: 'ой' },
      ),
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

  const canRead = async (auth: AuthContext, row: Record<string, unknown>): Promise<boolean> => {
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
    expect(isPollClosed(pollRow({ closedAt: new Date('2026-08-18T00:00:00.000Z') }), now)).toBe(
      true,
    );
  });

  it('treats a passed deadline as closed without waiting for the sweeper', () => {
    expect(isPollClosed(pollRow({ closesAt: new Date('2026-08-19T11:59:59.000Z') }), now)).toBe(
      true,
    );
  });

  it('keeps a future deadline open', () => {
    expect(isPollClosed(pollRow({ closesAt: new Date('2026-08-19T12:00:01.000Z') }), now)).toBe(
      false,
    );
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
    expect(() =>
      assertPollOpen(pollRow({ closesAt: new Date('2026-08-19T09:00:00.000Z') }), now),
    ).toThrowError(AppError);
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
      for (const actor of [{ name: 'Паша' }, { name: 'Маша' }, { name: 'Саша' }, { name: null }]) {
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
    expect(
      renderActivitySummary('task.completed', { name: 'Паша' }, { title: 'Вынести мусор' }),
    ).toBe('Паша выполнил задачу „Вынести мусор“');
  });

  it('agrees with a feminine name in the past tense', () => {
    expect(
      renderActivitySummary('task.completed', { name: 'Маша' }, { title: 'Вынести мусор' }),
    ).toBe('Маша выполнила задачу „Вынести мусор“');
  });

  it('falls back to a gender-free phrasing when the name is ambiguous', () => {
    expect(
      renderActivitySummary('task.completed', { name: 'Саша' }, { title: 'Вынести мусор' }),
    ).toBe('Задача „Вынести мусор“ выполнена — Саша');
  });

  it('drops the actor entirely for a system-generated event', () => {
    expect(
      renderActivitySummary('task.completed', { name: null }, { title: 'Вынести мусор' }),
    ).toBe('Задача „Вынести мусор“ выполнена');
  });

  it('honours an explicit gender over the heuristic', () => {
    expect(renderActivitySummary('member.joined', { name: 'Саша', gender: 'f' }, {})).toBe(
      'Саша присоединилась к семье',
    );
  });

  it('never inflects a second name — both stay in the nominative', () => {
    expect(
      renderActivitySummary('kudos.given', { name: 'Паша' }, { toName: 'Маша', emoji: '👏' }),
    ).toBe('Благодарность 👏: Паша → Маша');
    expect(
      renderActivitySummary(
        'task.assigned',
        { name: 'Маша' },
        { title: 'Мусор', assigneeName: 'Паша' },
      ),
    ).toBe('Маша назначила задачу „Мусор“, исполнитель: Паша');
  });

  it('formats money as integer minor units in roubles (D6)', () => {
    // Digit grouping and the currency sign use a non-breaking space: the amount
    // must never wrap in the middle in the feed.
    expect(formatAmountRu(150000)).toBe('1 500,00 ₽');
    expect(formatAmountRu(5)).toBe('0,05 ₽');
    expect(formatAmountRu(123456789)).toBe('1 234 567,89 ₽');
    expect(
      renderActivitySummary(
        'goal.contributed',
        { name: 'Паша' },
        { title: 'Велосипед', amountMinor: 100000 },
      ),
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
    [
      'the old `iso|id` encoding',
      Buffer.from('2026-08-19T10:00:00.000Z|abc').toString('base64url'),
    ],
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

  /**
   * The ids are the point (§D7.7): a reaction renders as its emoji plus the
   * **discs of the people who used it**, and no digit appears anywhere. They
   * come back in the order the rows did — `loadReactions` orders by
   * `created_at` — so the faces do not shuffle between refetches.
   */
  it('groups by emoji, keeps the reactors, and flags the viewer', () => {
    const summaries = repo.buildReactionSummaries(
      [
        { entityId, emoji: '👏', userId: me },
        { entityId, emoji: '👏', userId: other },
        { entityId, emoji: '❤️', userId: other },
      ],
      me,
    );
    const list = summaries.get(entityId) ?? [];
    expect(list[0]).toEqual({ emoji: '👏', count: 2, reacted: true, userIds: [me, other] });
    expect(list[1]).toEqual({ emoji: '❤️', count: 1, reacted: false, userIds: [other] });
  });

  it('never counts one person twice for the same emoji', () => {
    const summaries = repo.buildReactionSummaries(
      [
        { entityId, emoji: '👏', userId: me },
        { entityId, emoji: '👏', userId: me },
      ],
      me,
    );
    expect(summaries.get(entityId)?.[0]).toEqual({
      emoji: '👏',
      count: 1,
      reacted: true,
      userIds: [me],
    });
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
  /**
   * Four sources now (§D7.13 gaps 1 and 3): posts, activity, **closed** polls
   * and kudos. One sort over the union, not a fold of pairwise merges.
   */
  it('interleaves all four sources on one clock', () => {
    const at = (iso: string) => new Date(iso);
    const merged = mergeStreams(
      [{ id: 'p', createdAt: at('2026-08-19T10:00:00.000Z'), kind: 'post' }],
      [{ id: 'a', createdAt: at('2026-08-19T09:00:00.000Z'), kind: 'activity' }],
      [{ id: 'q', createdAt: at('2026-08-19T11:00:00.000Z'), kind: 'poll' }],
      [{ id: 'k', createdAt: at('2026-08-19T08:00:00.000Z'), kind: 'kudos' }],
    );
    expect(merged.map((m) => m.id)).toEqual(['q', 'p', 'a', 'k']);
  });

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

describe('«Очистить доску» copy', () => {
  it('names the day the wall was cleared, in Russian, in the family timezone', () => {
    // 00:30 Moscow on the 20th is 21:30 UTC on the 19th — the card must say
    // what the family's own calendar says, not what UTC says.
    const at = new Date('2026-08-19T21:30:00.000Z');
    expect(wallClearedBody(formatDayMonthRu(at, 'Europe/Moscow'))).toBe(
      'Доску очистили 20 августа',
    );
    expect(wallClearedBody(formatDayMonthRu(at, 'UTC'))).toBe('Доску очистили 19 августа');
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

  it('mounts reactions on a comment, and refuses to mount comments on one', async () => {
    const wallRoutes = (await import('./wall.routes.js')).default;
    const collected = await collectRouteAccess(wallRoutes);
    const keys = collected.map((route) => route.key);

    // The owner's request: «добавлять реакции на сообщения в обсуждениях».
    expect(keys).toContain('GET /comments/:id/reactions');
    expect(keys).toContain('POST /comments/:id/reactions');

    // …and the thing that would have come along for free had `comment` simply
    // been added to `COMMENT_MOUNTS`. A thread on a thread is refused on
    // purpose, and this is the assertion that keeps it refused.
    expect(keys).not.toContain('GET /comments/:id/comments');
    expect(keys).not.toContain('POST /comments/:id/comments');
  });

  it('classifies a reaction on a comment as a wall write, like the thread itself', async () => {
    // `(entity_type, entity_id)` is polymorphic, so the domain has to be
    // decided by hand — and it has been decided wrong once, which left an open
    // thread stale on every other phone.
    expect(domainsForRoute('/api/comments/:id/reactions')).toEqual(['wall']);
    expect(domainsForRoute('/api/comments/:id')).toEqual(['wall']);
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

  /** Counts the rows nothing can cascade, straight from the table. */
  async function countReactionsOn(entityType: string, entityId: string): Promise<number> {
    const { reactions } = await import('./wall.schema.js');
    const { and, count, eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ total: count() })
      .from(reactions)
      .where(and(eq(reactions.entityType, entityType), eq(reactions.entityId, entityId)));
    return row?.total ?? 0;
  }

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

    await expect(
      castVote(db, child, poll.id, { optionIds: [sea.id, hills.id] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

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

    const first = await addComment(
      db,
      adult,
      { entityType: 'post', entityId: post.id },
      { body: 'Иду' },
    );
    await addComment(db, child, { entityType: 'post', entityId: post.id }, { body: 'И я' });

    let hydrated = await hydratePosts(db, [post], adult);
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

    hydrated = await hydratePosts(db, [post], adult);
    expect(hydrated[0]?.commentCount).toBe(1);

    // The delete hook takes the rest with it.
    const cleaned = await deleteCommentsFor(db, 'post', post.id);
    expect(cleaned.comments).toBe(1);
    hydrated = await hydratePosts(db, [post], adult);
    expect(hydrated[0]?.commentCount).toBe(0);

    await repo.softDeletePost(db, post.id);
  });

  it('carries a heart on a reply, and takes it with the reply when it goes', async () => {
    const post = await repo.insertPost(db, {
      authorId: adult.userId,
      type: 'announcement',
      body: 'Кто едет на дачу?',
      title: null,
    });

    const reply = await addComment(
      db,
      adult,
      { entityType: 'post', entityId: post.id },
      { body: 'Я еду' },
    );

    // The owner's request, end to end: a heart on a message inside a thread.
    const after = await toggleReaction(
      db,
      child,
      { entityType: 'comment', entityId: reply.id },
      { emoji: '❤️' },
    );
    expect(after.entityType).toBe('comment');
    expect(after.reactions).toEqual([
      { emoji: '❤️', count: 1, reacted: true, userIds: [child.userId] },
    ]);

    // …and it reaches the thread the client actually renders, in the same
    // query the comments came from rather than one request per reply.
    const listed = await listCommentsFor(
      db,
      child,
      { entityType: 'post', entityId: post.id },
      { limit: 50 },
    );
    expect(listed.items.find((c) => c.id === reply.id)?.reactions).toEqual([
      { emoji: '❤️', count: 1, reacted: true, userIds: [child.userId] },
    ]);
    // `reacted` is per reader: the adult never pressed it.
    const forAdult = await getReactionSummary(db, adult, {
      entityType: 'comment',
      entityId: reply.id,
    });
    expect(forAdult.reactions[0]?.reacted).toBe(false);

    // Idempotent toggle, exactly as on every other target.
    const removed = await toggleReaction(
      db,
      child,
      { entityType: 'comment', entityId: reply.id },
      { emoji: '❤️' },
    );
    expect(removed.reactions).toEqual([]);

    // Now the cleanup that has no foreign key to do it: deleting the reply
    // must take its hearts with it, or they become rows nothing points at.
    await toggleReaction(db, child, { entityType: 'comment', entityId: reply.id }, { emoji: '❤️' });
    await deleteComment(db, adult, reply.id);
    expect(await countReactionsOn('comment', reply.id)).toBe(0);

    await repo.softDeletePost(db, post.id);
  });

  it('takes the hearts on a thread with the post the thread hangs under', async () => {
    const post = await repo.insertPost(db, {
      authorId: adult.userId,
      type: 'announcement',
      body: 'Субботник',
      title: null,
    });
    const first = await addComment(
      db,
      adult,
      { entityType: 'post', entityId: post.id },
      { body: 'Приду' },
    );
    const second = await addComment(
      db,
      child,
      { entityType: 'post', entityId: post.id },
      { body: 'И я' },
    );

    await toggleReaction(db, child, { entityType: 'comment', entityId: first.id }, { emoji: '❤️' });
    await toggleReaction(
      db,
      adult,
      { entityType: 'comment', entityId: second.id },
      { emoji: '👍' },
    );
    await toggleReaction(db, adult, { entityType: 'post', entityId: post.id }, { emoji: '❤️' });

    // The delete hook every module calls inside its own delete transaction.
    const cleaned = await deleteCommentsFor(db, 'post', post.id);
    expect(cleaned.comments).toBe(2);
    // One on the post itself plus one on each reply — the count is the whole
    // sweep, because a caller cannot cascade what it cannot see.
    expect(cleaned.reactions).toBe(3);
    expect(await countReactionsOn('comment', first.id)).toBe(0);
    expect(await countReactionsOn('comment', second.id)).toBe(0);
    expect(await countReactionsOn('post', post.id)).toBe(0);

    await repo.softDeletePost(db, post.id);
  });

  it('refuses a heart on a reply the reader cannot see the thread of', async () => {
    // Two hops: the comment resolves, and then its own target has to. A
    // deleted post is unreadable, so its replies are unreactable — 404, never
    // 403, because a 403 would confirm the reply exists (D4).
    const post = await repo.insertPost(db, {
      authorId: adult.userId,
      type: 'announcement',
      body: 'Скоро удалю',
      title: null,
    });
    const reply = await addComment(
      db,
      adult,
      { entityType: 'post', entityId: post.id },
      { body: 'ок' },
    );
    await repo.softDeletePost(db, post.id);

    await expect(
      toggleReaction(db, child, { entityType: 'comment', entityId: reply.id }, { emoji: '❤️' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  /**
   * §D7.11 / D13, the rule this whole feature turns on: clearing the wall is a
   * **horizon, not a delete**. The first time somebody clears a wall holding a
   * thank-you their mother wrote, `DELETE FROM posts` has no answer.
   */
  it('clears the wall as a horizon: the feed empties, every row survives, open polls stay', async () => {
    const { users } = await import('../identity/users.schema.js');
    const [adminRow] = await db
      .insert(users)
      .values({ displayName: 'Аня', role: 'admin', status: 'active' })
      .returning();
    if (!adminRow) throw new Error('fixture admin was not created');
    createdUserIds.push(adminRow.id);
    const admin = buildAuthContext(adminRow);

    const post = await repo.insertPost(db, {
      authorId: adult.userId,
      type: 'announcement',
      body: 'Завтра к бабушке',
      title: 'К бабушке',
    });
    const openPoll = await repo.insertPoll(db, {
      question: 'Куда едем?',
      allowMultiple: false,
      createdById: adult.userId,
    });
    await repo.insertPollOptions(db, openPoll.id, ['Дача', 'Город']);
    const thanks = await repo.insertKudos(db, {
      fromUserId: adult.userId,
      toUserId: child.userId,
      occurrenceId: null,
      emoji: '\u{1F64F}',
      message: 'спасибо, что полила цветы',
    });

    const before = await getWallFeed(db, admin, { limit: 15 });
    // Whatever the horizon is when this test starts — the settings row is
    // family-wide and another suite may have cleared it — is what the undo has
    // to put back. Asserting `null` here would be asserting global state this
    // test does not own.
    const horizonBefore = before.clearedAt;
    expect(before.items.some((item) => item.id === post.id)).toBe(true);
    expect(before.items.some((item) => item.id === thanks.id)).toBe(true);
    expect(before.openPolls.map((p) => p.id)).toContain(openPoll.id);

    // An adult may moderate one note; resetting what six people see is a
    // different thing and needs `settings:manage` (§D7.11).
    await expect(clearWall(db, adult)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const cleared = await clearWall(db, admin);
    const after = await getWallFeed(db, admin, { limit: 15 });

    expect(after.clearedAt).toBe(cleared.clearedAt);
    expect(after.items.some((item) => item.id === post.id)).toBe(false);
    expect(after.items.some((item) => item.id === thanks.id)).toBe(false);
    // …and the question nobody answered is still being asked.
    expect(after.openPolls.map((p) => p.id)).toContain(openPoll.id);
    // The marker post is stamped after the horizon, so it survives it and
    // becomes the feed's visible floor.
    expect(after.items.some((item) => item.id === cleared.systemPostId)).toBe(true);

    // Nothing was destroyed.
    expect(await repo.findPostById(db, post.id)).not.toBeNull();
    const kudosStill = await repo.listKudos(db, { limit: 50 });
    expect(kudosStill.some((row) => row.id === thanks.id)).toBe(true);

    await restoreWall(db, admin, {
      clearedAt: cleared.previousClearedAt,
      systemPostId: cleared.systemPostId,
    });
    const restored = await getWallFeed(db, admin, { limit: 15 });
    expect(restored.clearedAt).toBe(horizonBefore);
    expect(restored.items.some((item) => item.id === post.id)).toBe(true);
    expect(restored.items.some((item) => item.id === thanks.id)).toBe(true);
    // The undone clear leaves no trace of itself.
    expect(restored.items.some((item) => item.id === cleared.systemPostId)).toBe(false);

    await repo.softDeletePost(db, post.id);
    await repo.deletePoll(db, openPoll.id);
  });

  /**
   * A closed poll leaves the head and takes its chronological place; an open
   * one is in the head or nowhere. A card is never in two places (§D7.4).
   */
  it('serves open polls in the head and closed polls in the stream, never both', async () => {
    const closed = await repo.insertPoll(db, {
      question: 'Что смотрим?',
      allowMultiple: false,
      createdById: adult.userId,
      closedAt: new Date(),
    });
    await repo.insertPollOptions(db, closed.id, ['Мультик', 'Кино']);

    const feed = await getWallFeed(db, adult, { limit: 15 });
    expect(feed.openPolls.map((p) => p.id)).not.toContain(closed.id);
    const inStream = feed.items.filter((item) => item.id === closed.id);
    expect(inStream).toHaveLength(1);
    expect(inStream[0]?.kind).toBe('poll');

    await repo.deletePoll(db, closed.id);
  });

  /**
   * Found by driving the built app: the activity log writes a row for every
   * post, poll and kudos, and now that each of those is a **card**, the row
   * repeats the card 40px below it.
   */
  it('never draws an activity line for something that has its own card', async () => {
    const thanks = await giveKudos(db, adult, {
      toUserId: child.userId,
      emoji: '\u{1F44F}',
      message: 'спасибо',
      occurrenceId: null,
    });

    const feed = await getWallFeed(db, adult, { limit: 15 });
    const card = feed.items.find((item) => item.id === thanks.id);
    expect(card?.kind).toBe('kudos');

    // …and the log row that names the same thank-you is not in the stream.
    const echoed = feed.items.filter(
      (item) => item.kind === 'activity' && item.activity.verb === 'kudos.given',
    );
    expect(echoed).toHaveLength(0);

    // It is still in the family's own log, which other modules read.
    const log = await listActivity(db, adult, { limit: 50, verb: 'kudos.given' });
    expect(log.items.some((row) => row.entityId === thanks.id)).toBe(true);
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
