import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
import { closeHarness, startHarness } from '../../test/harness.js';

/**
 * The BullMQ job-id contract, against a real Redis.
 *
 * Every idempotent enqueue in this codebase leans on `jobId`: the dispatch
 * fan-out, the per-delivery send, the escalation ladder, the repeatable
 * schedulers. None of that is exercised by the unit suite, which mocks
 * `enqueue` wholesale — so the fact that BullMQ *rejects* most of the ids we
 * build has never been observed.
 *
 * `Job.addJob` (bullmq/dist/cjs/classes/job.js:1067-1077) throws
 * `Custom Id cannot contain :` whenever a jobId contains a colon **and** does
 * not split into exactly three parts. `a:b:c` is accepted; `a:b` and `a:b:c:d`
 * are not. Every producer here builds a two-part id.
 */
describe.skipIf(!hasTestDb)('queue job ids (integration)', () => {
  beforeAll(async () => {
    // Boots the app so `getConfig()` is parsed against the test environment and
    // the Redis URL carries the dev credentials.
    await startHarness();
  });

  afterAll(async () => {
    const { closeQueues } = await import('./queues.js');
    await closeQueues();
    await closeHarness();
  });

  async function tryEnqueue(jobId: string): Promise<Error | null> {
    const { enqueue } = await import('./queues.js');
    try {
      await enqueue('notification.dispatch', { intentId: crypto.randomUUID() }, { jobId });
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * KNOWN FAILURE — documents a real bug, do not relax.
   *
   * `notifications.service.ts:184` — `jobId: \`fanout:${intentId}\``.
   *
   * This is the *only* hand-off from `emitIntent().dispatch()` to the
   * notification worker, and every producer in the app goes through it: task
   * completion, task assignment, event creation, wall posts, kudos, swaps,
   * member approval. BullMQ refuses the id, `dispatch()` rejects, and — because
   * `tasks.service.ts:1148` awaits it outside any try/catch — the HTTP request
   * 500s *after* the domain write has already committed.
   *
   * Nothing is ever delivered, and the caller is told the action failed when it
   * did not.
   */
  it('accepts the fan-out job id the notification service builds', async () => {
    const error = await tryEnqueue(`fanout:${crypto.randomUUID()}`);
    expect(error?.message ?? null).toBeNull();
  });

  /**
   * KNOWN FAILURE — `notifications.service.ts:452`,
   * `jobId: \`deliver:${row.id}\``, for every `pending` (i.e. not deferred)
   * delivery. The deferred sibling on line 460 appends `:${timestamp}` and is
   * accepted, so the observable symptom is inverted from what anyone would
   * guess: a notification sent during quiet hours is queued, and one sent at
   * noon is not.
   */
  it('accepts the immediate-delivery job id', async () => {
    const error = await tryEnqueue(`deliver:${crypto.randomUUID()}`);
    expect(error?.message ?? null).toBeNull();
  });

  /**
   * KNOWN FAILURE — `core/queue/workers.ts:70`, `jobId: \`repeat:${name}\``.
   *
   * That is the registration of every repeatable job: the nightly
   * materialization, the reminder sweep, the overdue sweep, birthdays, the
   * weekly digest, refresh-token pruning, push health checks. With
   * `ENABLE_WORKERS=true` none of them is ever scheduled.
   */
  it('accepts the repeatable-job id the worker bootstrap builds', async () => {
    const error = await tryEnqueue('repeat:scheduler.materialize-all');
    expect(error?.message ?? null).toBeNull();
  });

  /**
   * KNOWN FAILURE — `goals.service.ts:366` passes the intent's dedupe key
   * straight through as the jobId, and `intentDedupeKey` builds
   * `<type>:<id>` — two parts.
   *
   * `flushIntents` catches and logs, so this one fails silently: the money
   * write succeeds and the family is simply never told.
   */
  it('accepts an intent dedupe key as a job id', async () => {
    const error = await tryEnqueue(`goal_contribution:${crypto.randomUUID()}`);
    expect(error?.message ?? null).toBeNull();
  });

  /**
   * KNOWN FAILURE — `notifications.service.ts:968`,
   * `jobId: \`escalate:${intentId}:${state}:${deferral.getTime()}\`` — four
   * parts, which BullMQ rejects for the same reason two parts are rejected.
   * The three-part sibling on line 890 is accepted, so the escalation ladder
   * advances one rung and then stops.
   */
  it('accepts the deferred-escalation job id', async () => {
    const error = await tryEnqueue(`escalate:${crypto.randomUUID()}:waiting:1757260800000`);
    expect(error?.message ?? null).toBeNull();
  });

  /** The shape that does work today, pinned so the contract is explicit. */
  it('accepts a three-part id', async () => {
    const error = await tryEnqueue(`deliver:${crypto.randomUUID()}:1757260800000`);
    expect(error?.message ?? null).toBeNull();
  });

  /**
   * KNOWN FAILURE — documents a real bug, do not relax.
   *
   * `core/redis.ts:createBullConnection` sets `maxRetriesPerRequest: null`,
   * which BullMQ requires for its blocking commands. The side effect is that a
   * command issued while the connection is down is **queued indefinitely**
   * rather than rejected.
   *
   * `goals.service.ts:352` is written as if that were not true:
   *
   *   > A queue outage must not fail a committed money write. … we log and move
   *   > on.
   *
   * The `try/catch` around `enqueue` is dead code — `queue.add()` never
   * rejects, it simply never settles. A Redis outage therefore hangs the HTTP
   * request forever *after* the money has committed, holding a connection open
   * until the client gives up. The same shape sits in `deliver()` and in the
   * escalation ladder.
   *
   * The fix is `enableOfflineQueue: false` on the queue's connection (or an
   * explicit timeout around `add`), so the catch block can do what its comment
   * says.
   */
  it('rejects rather than hangs when Redis is unreachable', async () => {
    // Exercises the real `enqueue()`, because that is where the guarantee is
    // made. A bare `queue.add()` against a dead Redis genuinely does hang
    // forever -- BullMQ manages its own connection and reinstates ioredis's
    // offline queue, so setting `enableOfflineQueue: false` on ours is not
    // enough. `enqueue()` bounds it with an explicit timeout instead.
    const { resetConfigForTests } = await import('../config.js');
    const { closeQueues, enqueue } = await import('./queues.js');
    const { closeRedis } = await import('../redis.js');

    const originalUrl = process.env.REDIS_URL;
    await closeQueues();
    await closeRedis();
    process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // nothing listens here
    resetConfigForTests();

    const started = Date.now();
    const settled = await Promise.race([
      enqueue('notification.dispatch', { intentId: 'x' })
        .then(() => 'resolved' as const)
        .catch(() => 'rejected' as const),
      new Promise<'hung'>((resolve) => {
        setTimeout(() => resolve('hung'), 15_000).unref?.();
      }),
    ]);
    const elapsed = Date.now() - started;

    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    if (originalUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalUrl;
    resetConfigForTests();

    // A committed domain write must never be followed by a request that hangs.
    expect(settled).toBe('rejected');
    expect(elapsed).toBeLessThan(12_000);
  }, 30_000);
});
