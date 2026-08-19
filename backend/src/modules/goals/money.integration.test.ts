import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  expectStatus,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import { goalTransactions } from './goals.schema.js';

/**
 * Money, through the API, against the real ledger.
 *
 * The unit suite proves `sumLedger` adds up and that `withdrawalDelta` negates.
 * What it cannot prove is that the number the *route* returns is the number the
 * *table* holds: the balance travels through `bigint` → `::text` → JS, through
 * a Zod response schema, and back out as JSON. Every one of those steps is a
 * place a rouble can go missing, and only a round trip catches it.
 */
describe.skipIf(!hasTestDb)('money invariants (integration)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    adult = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });
  });

  async function createGoal(target = 1_000_00): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/goals',
      token: adult.accessToken,
      payload: {
        title: `Копилка ${randomUUID().slice(0, 8)}`,
        targetAmount: target,
        currency: 'RUB',
        visibility: 'household',
      },
    });
    expect([200, 201]).toContain(response.statusCode);
    return (response.json() as { id: string }).id;
  }

  /** `SUM(delta)` straight off the table — the number the API must agree with. */
  async function ledgerSum(goalId: string): Promise<number> {
    const rows = await h.db
      .select({ delta: goalTransactions.delta })
      .from(goalTransactions)
      .where(eq(goalTransactions.goalId, goalId));
    return rows.reduce((total, row) => total + Number(row.delta), 0);
  }

  async function ledgerRows(goalId: string) {
    return h.db.select().from(goalTransactions).where(eq(goalTransactions.goalId, goalId));
  }

  /**
   * The balance as the API reports it.
   *
   * Read from the **list** endpoint rather than `GET /goals/:id`, because
   * `GET /goals/:id` is a hard 500 for any goal that has at least one
   * transaction — see the `contributor rollup` block at the bottom of this
   * file, which pins that bug down on its own. Routing around it here keeps the
   * invariants below genuinely tested instead of hidden behind one failure.
   */
  async function readBalance(goalId: string): Promise<number> {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/goals?limit=100',
      token: adult.accessToken,
    });
    expectStatus(response, 200);
    const items = (response.json() as { items: { id: string; currentAmount: number }[] }).items;
    const found = items.find((g) => g.id === goalId);
    if (!found) throw new Error(`goal ${goalId} is not in the list`);
    return found.currentAmount;
  }

  /**
   * Post a ledger write and report the status without asserting on it.
   *
   * The ledger row commits before the response is serialised, so the invariant
   * tests below are about what the table holds. The status code is asserted on
   * its own in `contributor rollup`.
   */
  async function post(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number }> {
    const response = await request(h.app, {
      method: 'POST',
      url,
      token: adult.accessToken,
      payload,
    });
    return { statusCode: response.statusCode };
  }

  it('keeps the balance exactly equal to the ledger sum, with no float drift', async () => {
    const goalId = await createGoal();

    // Amounts chosen to be poisonous for a float: the 0.1 + 0.2 family, and a
    // set whose decimal sum is not representable in binary.
    const contributions = [10_10, 20_20, 33_33, 1, 99_99, 7, 250_01];
    for (const amount of contributions) {
      await post(`/api/goals/${goalId}/contributions`, {
        amount,
        kind: 'contribution',
        clientId: randomUUID(),
      });
    }
    await post(`/api/goals/${goalId}/withdrawals`, { amount: 100_00, clientId: randomUUID() });

    const expected = contributions.reduce((a, b) => a + b, 0) - 100_00;

    expect(await ledgerSum(goalId)).toBe(expected);
    expect(await readBalance(goalId)).toBe(expected);

    // The value is an exact integer of minor units, not a float that happens to
    // round to one.
    const balance = await readBalance(goalId);
    expect(Number.isInteger(balance)).toBe(true);
    expect(String(balance)).not.toContain('.');

    // And the API's own transaction list adds up to the same thing.
    const list = await request(h.app, {
      method: 'GET',
      url: `/api/goals/${goalId}/transactions?limit=100`,
      token: adult.accessToken,
    });
    expectStatus(list, 200);
    const items = (list.json() as { items: { delta: number }[] }).items;
    expect(items.reduce((a, t) => a + t.delta, 0)).toBe(expected);
  });

  it('creates exactly one row for a replayed clientId', async () => {
    const goalId = await createGoal();
    const clientId = randomUUID();
    const body = { amount: 500_00, kind: 'contribution', clientId };

    await post(`/api/goals/${goalId}/contributions`, body);
    // The offline queue flushes the same request twice.
    await post(`/api/goals/${goalId}/contributions`, body);

    expect(await ledgerRows(goalId)).toHaveLength(1);

    // The money was counted once, not twice.
    expect(await ledgerSum(goalId)).toBe(500_00);
    expect(await readBalance(goalId)).toBe(500_00);
  });

  it('counts a concurrent replay of the same clientId exactly once', async () => {
    const goalId = await createGoal();
    const body = { amount: 250_00, kind: 'contribution', clientId: randomUUID() };

    // Four tabs flushing the same queued write at the same instant. The unique
    // primary key on the client-supplied id is what saves this; a
    // check-then-insert would not.
    await Promise.all(
      Array.from({ length: 4 }, () => post(`/api/goals/${goalId}/contributions`, body)),
    );

    expect(await ledgerRows(goalId)).toHaveLength(1);
    expect(await readBalance(goalId)).toBe(250_00);
  });

  it('refuses a withdrawal that would take the box below zero', async () => {
    const goalId = await createGoal();
    await post(`/api/goals/${goalId}/contributions`, {
      amount: 100_00,
      kind: 'contribution',
      clientId: randomUUID(),
    });

    const tooMuch = await post(`/api/goals/${goalId}/withdrawals`, {
      amount: 150_00,
      clientId: randomUUID(),
    });
    expect(tooMuch.statusCode).toBeGreaterThanOrEqual(400);
    expect(tooMuch.statusCode).toBeLessThan(500);

    // Nothing was written: the refusal happens inside the transaction holding
    // the row lock, so a rejected withdrawal leaves no trace at all.
    expect(await ledgerRows(goalId)).toHaveLength(1);
    expect(await ledgerSum(goalId)).toBe(100_00);
    expect(await readBalance(goalId)).toBe(100_00);
  });

  it('serialises concurrent withdrawals so the balance can never go negative', async () => {
    const goalId = await createGoal();
    await post(`/api/goals/${goalId}/contributions`, {
      amount: 100_00,
      kind: 'contribution',
      clientId: randomUUID(),
    });

    // Three simultaneous 60₽ withdrawals against a 100₽ balance. The
    // `SELECT ... FOR UPDATE` on the goal is the only thing standing between
    // this and a negative moneybox; without it two callers would both read
    // 100₽ and both succeed.
    await Promise.all(
      Array.from({ length: 3 }, () =>
        post(`/api/goals/${goalId}/withdrawals`, { amount: 60_00, clientId: randomUUID() }),
      ),
    );

    const rows = await ledgerRows(goalId);
    expect(rows.filter((r) => Number(r.delta) < 0)).toHaveLength(1);

    const balance = await ledgerSum(goalId);
    expect(balance).toBe(40_00);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(await readBalance(goalId)).toBe(balance);
  });

  it('survives a large balance without losing precision', async () => {
    const goalId = await createGoal(90_000_000_00);

    // 900 000 ₽ in kopeks — comfortably past 2^31, so a column or a cast that
    // silently narrowed to int32 would show up here rather than in production.
    const big = 90_000_000_00;
    await post(`/api/goals/${goalId}/contributions`, {
      amount: big,
      kind: 'contribution',
      clientId: randomUUID(),
    });

    expect(await ledgerSum(goalId)).toBe(big);
    expect(await readBalance(goalId)).toBe(big);
  });

  /* ====================================================================== */
  /* contributor rollup — KNOWN FAILURES, do not relax                      */
  /* ====================================================================== */

  /**
   * `goals.repository.ts:513` declares
   *
   *   lastContributedAt: sql<Date | null>`max(${goalTransactions.occurredAt})`
   *
   * but a raw `sql` expression carries **no decoder**, and
   * `drizzle-orm/postgres-js/driver.js` replaces postgres.js's parsers for the
   * timestamp OIDs (1082/1083/1114/1184) with an identity function. The value
   * therefore arrives as a **string**, the `sql<Date>` annotation is a lie the
   * compiler cannot check, and `goals.routes.ts:161` calls `.toISOString()` on
   * it.
   *
   * Net effect: the moneybox is unusable. Every contribute, withdraw and
   * correction 500s the moment a goal has one transaction — *after* committing
   * the money — and `GET /goals/:id` 500s forever after.
   */
  describe('contributor rollup', () => {
    it('returns 2xx from a contribution rather than 500', async () => {
      const goalId = await createGoal();
      const response = await post(`/api/goals/${goalId}/contributions`, {
        amount: 100_00,
        kind: 'contribution',
        clientId: randomUUID(),
      });
      expect(response.statusCode).toBeLessThan(500);
    });

    it('serves GET /goals/:id for a goal that has transactions', async () => {
      const goalId = await createGoal();
      await post(`/api/goals/${goalId}/contributions`, {
        amount: 100_00,
        kind: 'contribution',
        clientId: randomUUID(),
      });

      const response = await request(h.app, {
        method: 'GET',
        url: `/api/goals/${goalId}`,
        token: adult.accessToken,
      });
      expectStatus(response, 200);

      const body = response.json() as {
        currentAmount: number;
        contributors?: { userId: string; amount: number; lastContributedAt: string | null }[];
      };
      expect(body.currentAmount).toBe(100_00);
      expect(body.contributors?.[0]?.userId).toBe(adult.id);
      // An ISO-8601 instant, which is what the response schema promises.
      expect(body.contributors?.[0]?.lastContributedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not commit money it then reports as a server error', async () => {
      const goalId = await createGoal();
      const response = await post(`/api/goals/${goalId}/contributions`, {
        amount: 42_00,
        kind: 'contribution',
        clientId: randomUUID(),
      });

      // Either the write is refused and nothing lands, or it succeeds and the
      // caller is told so. "5xx with the money moved" is the one outcome a
      // client cannot recover from: it will retry, and a retry without the same
      // `clientId` double-books.
      if (response.statusCode >= 500) {
        expect(await ledgerRows(goalId)).toHaveLength(0);
      }
    });
  });
});
