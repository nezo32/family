import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  createContributionSchema,
  createCorrectionSchema,
  createGoalSchema,
  createMilestoneSchema,
  createWithdrawalSchema,
  goalLedgerMutationResponseSchema,
  goalListResponseSchema,
  goalResponseSchema,
  goalTransactionListResponseSchema,
  idSchema,
  listGoalsQuerySchema,
  listGoalTransactionsQuerySchema,
  milestoneResponseSchema,
  minorUnitsSchema,
  okSchema,
  reorderGoalsSchema,
  updateGoalSchema,
  updateMilestoneSchema,
  type GoalResponse,
  type GoalTransactionResponse,
  type MilestoneResponse,
  type Permission,
} from '@family/shared';

import type { AuthContext } from '../../core/auth/context.js';
import { getDb } from '../../core/db.js';
import { unauthenticated } from '../../core/errors.js';
import type { GoalMilestoneRow, GoalTransactionRow } from './goals.schema.js';
import type { GoalWithMilestones } from './goals.service.js';
import * as service from './goals.service.js';

/**
 * Moneybox HTTP surface — the route table from `docs/architecture/household.md`
 * §1, mounted under `/api` by the module registry.
 *
 * The layer is deliberately thin (D8): parse, delegate, map. Every rule that
 * matters — signs, the below-zero refusal, read scope, milestone crossings —
 * lives in `goals.service.ts` and is unit-testable without a database.
 *
 * ## Access control
 *
 * Every route declares its permission in the `config` block. `core/plugins/auth`
 * asserts at boot that no registered route declares nothing, so a forgotten
 * guard fails the app rather than shipping an open endpoint (D4).
 *
 * There is no `config: { public: true }` anywhere in this domain, by design.
 *
 * ## 404, not 403
 *
 * A goal outside the caller's read scope — somebody else's `private` goal —
 * returns **404**. The service does this by filtering in SQL rather than by
 * fetching and then comparing, so the "does it exist" answer never leaks
 * through a timing or error-shape difference.
 */

/* -------------------------------------------------------------------------- */
/* Declared access, as data                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The permission each route declares. Exported so `goals.test.ts` can assert
 * that what is actually registered matches what is documented here — the check
 * that catches a guard quietly loosened during a refactor.
 */
export const GOAL_ROUTE_PERMISSIONS = {
  'GET /goals': 'goal:read',
  'GET /goals/summary': 'goal:read',
  'POST /goals': 'goal:create',
  'POST /goals/reorder': 'goal:update',
  'GET /goals/:id': 'goal:read',
  'PATCH /goals/:id': 'goal:update',
  'DELETE /goals/:id': 'goal:delete',
  'GET /goals/:id/transactions': 'goal:read',
  'POST /goals/:id/contributions': 'goal:contribute',
  'POST /goals/:id/withdrawals': 'goal:contribute',
  'POST /goals/:id/corrections': 'goal:update',
  'GET /goals/:id/milestones': 'goal:read',
  'POST /goals/:id/milestones': 'goal:update',
  'PATCH /goals/:id/milestones/:mid': 'goal:update',
  'DELETE /goals/:id/milestones/:mid': 'goal:update',
} as const satisfies Record<string, Permission>;

/* -------------------------------------------------------------------------- */
/* Local schemas                                                               */
/* -------------------------------------------------------------------------- */

const goalParamsSchema = z.object({ id: idSchema });
const milestoneParamsSchema = z.object({ id: idSchema, mid: idSchema });

const milestoneListResponseSchema = z.array(milestoneResponseSchema);

/**
 * Board totals for the dashboard tile.
 *
 * Composed from `@family/shared` primitives rather than invented here: there is
 * no `goalsSummarySchema` in the contracts package yet (it is lead-owned). If
 * the frontend needs this shape, promote it to `contracts/goals.ts` verbatim.
 */
const goalsSummaryResponseSchema = z.object({
  goalCount: z.number().int().min(0),
  activeCount: z.number().int().min(0),
  reachedCount: z.number().int().min(0),
  totalTarget: minorUnitsSchema,
  totalSaved: minorUnitsSchema,
  totalRemaining: minorUnitsSchema,
  progressPercent: z.number().int().min(0),
});

/** `DELETE /goals/:id` reports whether the goal was archived or removed. */
const deleteGoalResponseSchema = okSchema.extend({ archived: z.boolean() });

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

function toMilestoneResponse(row: GoalMilestoneRow): MilestoneResponse {
  return {
    id: row.id,
    goalId: row.goalId,
    title: row.title,
    targetAmount: row.targetAmount,
    reachedAt: row.reachedAt?.toISOString() ?? null,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

function toGoalResponse(goal: GoalWithMilestones): GoalResponse {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    targetAmount: goal.targetAmount,
    // Derived in SQL as SUM(delta); there is no column behind this number.
    currentAmount: goal.currentAmount,
    progressPercent: goal.progressPercent,
    remainingAmount: goal.remainingAmount,
    currency: goal.currency,
    deadline: goal.deadline,
    imageUrl: goal.imageUrl,
    color: goal.color,
    icon: goal.icon,
    status: goal.status,
    visibility: goal.visibility,
    ownerId: goal.ownerId,
    createdById: goal.createdById,
    reachedAt: goal.reachedAt?.toISOString() ?? null,
    sortOrder: goal.sortOrder,
    milestones: goal.milestones.map(toMilestoneResponse),
    ...(goal.contributors
      ? {
          contributors: goal.contributors.map((c) => ({
            userId: c.userId,
            amount: c.amount,
            transactionCount: c.transactionCount,
            lastContributedAt: c.lastContributedAt?.toISOString() ?? null,
          })),
        }
      : {}),
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

function toTransactionResponse(row: GoalTransactionRow): GoalTransactionResponse {
  return {
    id: row.id,
    goalId: row.goalId,
    userId: row.userId,
    delta: row.delta,
    kind: row.kind,
    note: row.note,
    occurredAt: row.occurredAt.toISOString(),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `req.auth` is `AuthContext | null` because public routes exist elsewhere in
 * the app. No goals route is public, so a null here means the auth plugin was
 * bypassed — fail loudly rather than defaulting to some anonymous actor.
 */
function actorOf(auth: AuthContext | null): AuthContext {
  if (!auth) throw unauthenticated();
  return auth;
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

const goalsRoutes: FastifyPluginAsync = async (instance: FastifyInstance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /* ------------------------------- goals -------------------------------- */

  app.get(
    '/goals',
    {
      config: { permission: 'goal:read' },
      schema: {
        tags: ['goals'],
        summary: 'Список целей копилки',
        querystring: listGoalsQuerySchema,
        response: { 200: goalListResponseSchema },
      },
    },
    async (request) => {
      const page = await service.listGoals(getDb(), actorOf(request.auth), request.query);
      return { items: page.items.map(toGoalResponse), nextCursor: page.nextCursor };
    },
  );

  // Registered as a static segment; find-my-way always prefers it over `/:id`.
  app.get(
    '/goals/summary',
    {
      config: { permission: 'goal:read' },
      schema: {
        tags: ['goals'],
        summary: 'Сводка по копилке',
        response: { 200: goalsSummaryResponseSchema },
      },
    },
    async (request) => service.getSummary(getDb(), actorOf(request.auth)),
  );

  app.post(
    '/goals',
    {
      config: { permission: 'goal:create' },
      schema: {
        tags: ['goals'],
        body: createGoalSchema,
        response: { 201: goalResponseSchema },
      },
    },
    async (request, reply) => {
      const goal = await service.createGoal(getDb(), actorOf(request.auth), request.body);
      return reply.code(201).send(toGoalResponse(goal));
    },
  );

  app.post(
    '/goals/reorder',
    {
      config: { permission: 'goal:update' },
      schema: {
        tags: ['goals'],
        body: reorderGoalsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.reorderGoals(getDb(), actorOf(request.auth), request.body.ids);
      return { ok: true as const };
    },
  );

  app.get(
    '/goals/:id',
    {
      config: { permission: 'goal:read' },
      schema: {
        tags: ['goals'],
        params: goalParamsSchema,
        response: { 200: goalResponseSchema },
      },
    },
    async (request) => {
      const goal = await service.getGoal(getDb(), actorOf(request.auth), request.params.id);
      return toGoalResponse(goal);
    },
  );

  app.patch(
    '/goals/:id',
    {
      config: { permission: 'goal:update' },
      schema: {
        tags: ['goals'],
        params: goalParamsSchema,
        body: updateGoalSchema,
        response: { 200: goalResponseSchema },
      },
    },
    async (request) => {
      const goal = await service.updateGoal(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      );
      return toGoalResponse(goal);
    },
  );

  app.delete(
    '/goals/:id',
    {
      config: { permission: 'goal:delete' },
      schema: {
        tags: ['goals'],
        summary: 'Удалить цель (с транзакциями — архивируется)',
        params: goalParamsSchema,
        response: { 200: deleteGoalResponseSchema },
      },
    },
    async (request) => {
      const result = await service.deleteGoal(getDb(), actorOf(request.auth), request.params.id);
      return { ok: true as const, archived: result.archived };
    },
  );

  /* ----------------------------- milestones ------------------------------ */

  app.get(
    '/goals/:id/milestones',
    {
      config: { permission: 'goal:read' },
      schema: {
        tags: ['goals'],
        params: goalParamsSchema,
        response: { 200: milestoneListResponseSchema },
      },
    },
    async (request) => {
      const rows = await service.listMilestones(getDb(), actorOf(request.auth), request.params.id);
      return rows.map(toMilestoneResponse);
    },
  );

  app.post(
    '/goals/:id/milestones',
    {
      config: { permission: 'goal:update' },
      schema: {
        tags: ['goals'],
        params: goalParamsSchema,
        body: createMilestoneSchema,
        response: { 201: milestoneResponseSchema },
      },
    },
    async (request, reply) => {
      const row = await service.createMilestone(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      );
      return reply.code(201).send(toMilestoneResponse(row));
    },
  );

  app.patch(
    '/goals/:id/milestones/:mid',
    {
      config: { permission: 'goal:update' },
      schema: {
        tags: ['goals'],
        params: milestoneParamsSchema,
        body: updateMilestoneSchema,
        response: { 200: milestoneResponseSchema },
      },
    },
    async (request) => {
      const row = await service.updateMilestone(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.params.mid,
        request.body,
      );
      return toMilestoneResponse(row);
    },
  );

  app.delete(
    '/goals/:id/milestones/:mid',
    {
      config: { permission: 'goal:update' },
      schema: {
        tags: ['goals'],
        summary: 'Удалить веху (без следа — вехи не история)',
        params: milestoneParamsSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await service.deleteMilestone(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.params.mid,
      );
      return { ok: true as const };
    },
  );

  /* ------------------------------- ledger -------------------------------- */

  app.get(
    '/goals/:id/transactions',
    {
      config: { permission: 'goal:read' },
      schema: {
        tags: ['goals'],
        params: goalParamsSchema,
        querystring: listGoalTransactionsQuerySchema,
        response: { 200: goalTransactionListResponseSchema },
      },
    },
    async (request) => {
      const page = await service.listTransactions(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.query,
      );
      return { items: page.items.map(toTransactionResponse), nextCursor: page.nextCursor };
    },
  );

  /** Positive amount only — the sign is the service's decision, not the client's. */
  app.post(
    '/goals/:id/contributions',
    {
      config: { permission: 'goal:contribute' },
      schema: {
        tags: ['goals'],
        summary: 'Пополнить цель',
        params: goalParamsSchema,
        body: createContributionSchema,
        response: {
          // 200 is the idempotent replay of a `clientId` already recorded.
          200: goalLedgerMutationResponseSchema,
          201: goalLedgerMutationResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.contribute(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      );
      // A replayed `clientId` returns 200 with the row that already existed, so
      // an offline queue can drain twice without double-crediting the goal.
      return reply.code(result.created ? 201 : 200).send({
        transaction: toTransactionResponse(result.transaction),
        goal: toGoalResponse(result.goal),
      });
    },
  );

  /** Positive amount; negated server-side. Refused if it would go below zero. */
  app.post(
    '/goals/:id/withdrawals',
    {
      config: { permission: 'goal:contribute' },
      schema: {
        tags: ['goals'],
        summary: 'Снять с цели',
        params: goalParamsSchema,
        body: createWithdrawalSchema,
        response: {
          // 200 is the idempotent replay of a `clientId` already recorded.
          200: goalLedgerMutationResponseSchema,
          201: goalLedgerMutationResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.withdraw(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      );
      return reply.code(result.created ? 201 : 200).send({
        transaction: toTransactionResponse(result.transaction),
        goal: toGoalResponse(result.goal),
      });
    },
  );

  /**
   * The only signed input, and the only one allowed to push a balance negative.
   * There is no `DELETE .../transactions/:txnId`: history is append-only (D6).
   */
  app.post(
    '/goals/:id/corrections',
    {
      config: { permission: 'goal:update' },
      schema: {
        tags: ['goals'],
        summary: 'Коррекция ленты операций',
        params: goalParamsSchema,
        body: createCorrectionSchema,
        response: {
          // 200 is the idempotent replay of a `clientId` already recorded.
          200: goalLedgerMutationResponseSchema,
          201: goalLedgerMutationResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.correct(
        getDb(),
        actorOf(request.auth),
        request.params.id,
        request.body,
      );
      return reply.code(result.created ? 201 : 200).send({
        transaction: toTransactionResponse(result.transaction),
        goal: toGoalResponse(result.goal),
      });
    },
  );
};

export default goalsRoutes;
